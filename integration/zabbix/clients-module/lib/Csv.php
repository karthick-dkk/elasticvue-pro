<?php declare(strict_types = 0);

namespace Modules\EvpClients\Lib;

/**
 * Clients as a CSV file: one row per client, a machine list per role in one cell (IPs separated
 * by ;), requested figures per role. Pure — tested on its own (test/csv.test.php).
 *
 * On import a column left out of the file means "no change" to that setting, and an empty cell
 * means "clear it" — so a file carrying only client,type,es_node… changes just those.
 */
class Csv {

	/** CSV column => form field, for the settings every client has. */
	public const BASE = [
		'client' => 'name',
		'type' => 'type',
		'es_url' => 'es_url',
		'es_user' => 'es_user',
		'es_password_vault' => 'es_password_path',
		'jump_host' => 'es_jumphost',
		'tag1_values' => 'ulm_tags',
		's3_bucket' => 'ulm_bucket',
		's3_region' => 'ulm_region',
		's3_access' => 'ulm_auth',
		's3_role_arn' => 'ulm_role_arn',
		's3_external_id' => 'ulm_external_id',
		's3_access_key_id' => 'ulm_access_key_id',
		's3_secret_vault' => 'ulm_secret_path',
		'raw_folder' => 'ulm_raw_prefix',
		'enriched_folder' => 'ulm_enriched_prefix',
		'agent_port' => 'agent_port',
		'purchased_storage_gb' => 'purchased'
	];

	/** Per role: column suffix => form field suffix. */
	public const PER_ROLE = [
		'ips' => 'ips',
		'servers' => 'servers',
		'cpu_cores' => 'cpu',
		'memory_gb' => 'mem',
		'disk_gb' => 'disk',
		'disk_mount' => 'disk_fs'
	];

	/** Every column, in file order: CSV name => form field. */
	public static function columns(array $roles): array {
		$out = self::BASE;
		foreach (Roles::allRoles($roles) as $r) {
			foreach (self::PER_ROLE as $col => $suffix) {
				$out[$r['id'].'_'.$col] = $suffix === 'ips' ? 'ips_'.$r['id'] : $r['id'].'_'.$suffix;
			}
		}
		return $out;
	}

	/** The file for these clients' forms. Header only when there are none — the empty template. */
	public static function export(array $roles, array $forms): string {
		$cols = self::columns($roles);
		$rows = [array_keys($cols)];
		foreach ($forms as $form) {
			$row = [];
			foreach ($cols as $col => $field) {
				$v = (string) ($form[$field] ?? '');
				if ($field === 'ulm_auth') {
					$v = $v === 'access_key' ? 'key' : 'role';
				}
				elseif ($field === 'ulm_bucket' && $v === ClientSpec::UNSET_BUCKET) {
					$v = '';
				}
				elseif (strpos($field, 'ips_') === 0) {
					$v = implode(';', ClientSpec::splitIps($v));
				}
				$row[] = $v;
			}
			$rows[] = $row;
		}
		$fh = fopen('php://temp', 'r+');
		foreach ($rows as $row) {
			// A cell a spreadsheet would run as a formula is written as text.
			fputcsv($fh, array_map(fn($v) => preg_match('/^[=+\-@\t\r]/', $v) && !is_numeric($v) ? "'".$v : $v, $row), ',', '"', '');
		}
		rewind($fh);
		return "\xEF\xBB\xBF".stream_get_contents($fh);
	}

	/**
	 * A file as rows keyed by column. Returns ['columns' => [...], 'rows' => [[col => value]],
	 * 'errors' => [...], 'ignored' => [unknown columns]]. Excel's "CSV UTF-8", or ;-separated.
	 */
	public static function parse(string $text, array $roles): array {
		$text = preg_replace('/^\xEF\xBB\xBF/', '', $text);
		$first = strtok($text, "\r\n");
		$sep = $first !== false && substr_count($first, ';') > substr_count($first, ',') ? ';' : ',';
		$fh = fopen('php://temp', 'r+');
		fwrite($fh, $text);
		rewind($fh);
		$header = fgetcsv($fh, 0, $sep, '"', '');
		$out = ['columns' => [], 'rows' => [], 'errors' => [], 'ignored' => []];
		if (!$header || $header === [null]) {
			$out['errors'][] = _('The file is empty.');
			return $out;
		}
		$known = self::columns($roles);
		$header = array_map(fn($h) => strtolower(trim((string) $h)), $header);
		foreach ($header as $h) {
			if ($h !== '' && !array_key_exists($h, $known)) {
				$out['ignored'][] = $h;
			}
		}
		if (!in_array('client', $header, true)) {
			$out['errors'][] = _('The file has no "client" column. Download the CSV template for the columns it expects.');
			return $out;
		}
		$counts = array_count_values(array_filter($header));
		foreach ($counts as $h => $n) {
			if ($n > 1) {
				$out['errors'][] = _s('Column "%1$s" appears %2$s times.', $h, $n);
			}
		}
		$out['columns'] = array_values(array_filter($header, fn($h) => array_key_exists($h, $known)));
		$line = 1;
		while (($cells = fgetcsv($fh, 0, $sep, '"', '')) !== false) {
			$line++;
			if ($cells === [null] || implode('', array_map('trim', $cells)) === '') {
				continue;
			}
			$row = ['_line' => $line];
			foreach ($header as $i => $h) {
				if (array_key_exists($h, $known)) {
					$v = trim((string) ($cells[$i] ?? ''));
					// Undo the formula guard export adds.
					$row[$h] = strpos($v, "'") === 0 && preg_match('/^\'[=+\-@]/', $v) ? substr($v, 1) : $v;
				}
			}
			$out['rows'][] = $row;
		}
		return $out;
	}

	/** A row laid over a client's current form: columns in the file replace, columns not in it keep. */
	public static function toForm(array $row, array $base, array $roles): array {
		$form = $base;
		foreach (self::columns($roles) as $col => $field) {
			if (!array_key_exists($col, $row)) {
				continue;
			}
			$v = $row[$col];
			if ($field === 'ulm_auth') {
				$v = in_array(strtolower($v), ['', 'role', 'role_base', 'iam'], true) ? 'role_base'
					: (in_array(strtolower($v), ['key', 'access_key'], true) ? 'access_key' : $v);
			}
			elseif ($field === 'type') {
				$v = strcasecmp($v, 'di') === 0 ? 'DI' : (in_array(strtolower(str_replace([' ', '_'], '-', $v)), ['on-prem', 'onprem', 'on-premise'], true) ? 'On-Prem' : $v);
			}
			elseif (strpos($field, 'ips_') === 0) {
				$v = implode("\n", ClientSpec::splitIps($v));
			}
			$form[$field] = $v;
		}
		return $form;
	}
}
