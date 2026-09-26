<?php declare(strict_types = 0);

namespace Modules\EvpClients\Lib;

/**
 * A client, as the form or a CSV row describes it: checked, and turned into the macros each of
 * its hosts carries. Pure — no Zabbix API — so it is tested on its own (test/spec.test.php).
 *
 * Nothing is guessed. A machine that is not an IPv4 address, a URL that is not
 * scheme://host[:port], a Vault reference that is not path:key: each is named in the errors,
 * and nothing is saved until the form is right.
 */
class ClientSpec {

	public const UNSET_BUCKET = '(not set)';
	public const TYPES = ['DI', 'On-Prem'];

	/** Form field => master host macro, for the settings every client has. */
	public const FIELDS = [
		'es_url' => '{$ES.URL}',
		'es_user' => '{$ES.USERNAME}',
		'es_password_path' => '{$ES.PASSWORD.PATH}',
		'es_jumphost' => '{$ES.JUMPHOST}',
		'ulm_tags' => '{$ULM.TAGS}',
		'ulm_bucket' => '{$ULM.S3.BUCKET}',
		'ulm_region' => '{$ULM.S3.REGION}',
		'ulm_auth' => '{$ULM.AWS.AUTH}',
		'ulm_role_arn' => '{$ULM.AWS.ROLE.ARN}',
		'ulm_external_id' => '{$ULM.AWS.EXTERNAL.ID}',
		'ulm_access_key_id' => '{$ULM.AWS.ACCESS.KEY.ID}',
		'ulm_secret_path' => '{$ULM.AWS.SECRET.PATH}',
		'ulm_raw_prefix' => '{$ULM.S3.RAW.PREFIX}',
		'ulm_enriched_prefix' => '{$ULM.S3.ENRICHED.PREFIX}',
		'agent_port' => '{$AGENT.PORT}',
		'purchased' => '{$ES.VOLUME.CUS.PURCHASED}'
	];

	/** Per role: form field suffix => macro suffix. */
	public const ROLE_FIELDS = [
		'servers' => 'SERVER.COUNT.REQUESTED',
		'cpu' => 'CPU.REQUESTED',
		'mem' => 'MEMORY.REQUESTED',
		'disk' => 'ROOTDISK.REQUESTED',
		'disk_fs' => 'ROOTDISK.FS'
	];

	/** What the archive host receives from the master host's settings. */
	public const TO_ULM = ['{$ULM.S3.BUCKET}', '{$ULM.S3.REGION}', '{$ULM.AWS.AUTH}', '{$ULM.AWS.ROLE.ARN}', '{$ULM.AWS.EXTERNAL.ID}',
		'{$ULM.AWS.ACCESS.KEY.ID}', '{$ULM.S3.RAW.PREFIX}', '{$ULM.S3.ENRICHED.PREFIX}', '{$ULM.TAGS}', '{$ULM.ES.INDEX}',
		'{$ULM.ES.TAG.FIELD}', '{$ULM.ES.BRANCH.FIELD}', '{$ULM.TIMEZONE}'];

	/** @var array roles configuration */
	private $roles;
	/** @var array macro => default */
	private $defaults;

	public function __construct(array $roles) {
		$this->roles = $roles;
		$this->defaults = [];
		foreach ((new MasterTemplate($roles))->macros() as [$macro, $value]) {
			$this->defaults[$macro] = $value;
		}
	}

	public function roles(): array {
		return $this->roles;
	}

	/** Field name => master macro, for every field the master host keeps. */
	public function macroFields(): array {
		$out = ['type' => '{$EVP.CLIENT.TYPE}'] + self::FIELDS;
		foreach (Roles::allRoles($this->roles) as $r) {
			foreach (self::ROLE_FIELDS as $suffix => $what) {
				$out[$r['id'].'_'.$suffix] = Roles::macro($r['id'], $what);
			}
		}
		return $out;
	}

	/** An empty form: the master template's own defaults. */
	public function defaults(): array {
		$out = ['name' => ''];
		foreach ($this->macroFields() as $field => $macro) {
			$out[$field] = $this->defaults[$macro] ?? '';
		}
		if ($out['ulm_bucket'] === self::UNSET_BUCKET) {
			$out['ulm_bucket'] = '';
		}
		foreach (Roles::allRoles($this->roles) as $r) {
			$out['ips_'.$r['id']] = '';
		}
		return $out;
	}

	/**
	 * The form, checked. Returns ['client' => [...], 'errors' => [...]]; `client` is usable only
	 * when `errors` is empty.
	 */
	public function fromForm(array $in): array {
		$errors = [];
		$v = fn(string $k): string => trim((string) ($in[$k] ?? ''));

		$name = $v('name');
		if ($name === '') {
			$errors[] = _('Client name is required: its host group and every host are named after it.');
		}
		elseif (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_\-]{0,47}$/', $name)) {
			$errors[] = _s('Client name "%1$s" may hold only letters, digits, - and _, starting with a letter or digit.', $name);
		}

		$client = ['name' => $name, 'fields' => [], 'hosts' => [], 'es' => null];
		foreach ($this->macroFields() as $field => $macro) {
			$client['fields'][$field] = $v($field);
		}
		$f = &$client['fields'];

		if (!in_array($f['type'], self::TYPES, true)) {
			$errors[] = _s('Type must be DI or On-Prem, not "%1$s".', $f['type']);
		}
		if ($f['es_url'] !== '') {
			$client['es'] = self::esEndpoint($f['es_url']);
			if ($client['es'] === null) {
				$errors[] = _s('ES URL "%1$s" is not scheme://host[:port], e.g. https://es.acme.local:9200.', $f['es_url']);
			}
		}
		foreach (['es_password_path' => _('ES password Vault path'), 'ulm_secret_path' => _('S3 secret Vault path')] as $field => $label) {
			if ($f[$field] !== '' && self::vaultRef($f[$field]) === null) {
				$errors[] = _s('%1$s "%2$s" is not a Vault path:key, e.g. secret/elasticvue/acme:password.', $label, $f[$field]);
			}
		}
		if ($f['ulm_auth'] === '') {
			$f['ulm_auth'] = 'role_base';
		}
		if (!in_array($f['ulm_auth'], ['role_base', 'access_key'], true)) {
			$errors[] = _('S3 access must be the instance role or an access key.');
		}
		if ($f['ulm_bucket'] === '') {
			$f['ulm_bucket'] = self::UNSET_BUCKET;
		}
		elseif ($f['ulm_bucket'] !== self::UNSET_BUCKET && !preg_match('/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/', $f['ulm_bucket'])) {
			$errors[] = _s('S3 bucket "%1$s" is not a valid bucket name.', $f['ulm_bucket']);
		}
		if ($f['type'] === 'DI') {
			// DI clients' logs are archived: the archive check cannot run without these.
			if ($f['ulm_bucket'] === self::UNSET_BUCKET) {
				$errors[] = _('A DI client needs its S3 bucket.');
			}
			if ($f['ulm_region'] === '') {
				$errors[] = _('A DI client needs its S3 region.');
			}
			if ($f['ulm_tags'] === '') {
				$errors[] = _('A DI client needs its tag1 values.');
			}
			if ($f['es_url'] === '') {
				$errors[] = _('A DI client needs its ES URL: the archive check reads Elasticsearch.');
			}
		}
		if ($f['ulm_auth'] === 'access_key' && $f['ulm_bucket'] !== self::UNSET_BUCKET && $f['ulm_access_key_id'] === '') {
			$errors[] = _('S3 access by access key needs the access key ID.');
		}
		if ($f['agent_port'] === '') {
			$f['agent_port'] = '10050';
		}
		elseif (!preg_match('/^\d{1,5}$/', $f['agent_port'])) {
			$errors[] = _('Agent port must be a number.');
		}

		$numbers = ['purchased' => _('Purchased storage')];
		foreach (Roles::allRoles($this->roles) as $r) {
			foreach (['servers' => _('servers'), 'cpu' => _('CPU'), 'mem' => _('memory'), 'disk' => _('disk')] as $suffix => $what) {
				$numbers[$r['id'].'_'.$suffix] = $r['label'].' '.$what.' '._('requested');
			}
		}
		foreach ($numbers as $field => $label) {
			if ($f[$field] === '') {
				$f[$field] = '0';
			}
			elseif (!is_numeric($f[$field]) || (float) $f[$field] < 0) {
				$errors[] = _s('%1$s must be a number of 0 or more (0 means not set), not "%2$s".', $label, $f[$field]);
			}
		}

		$seen = [];
		foreach (Roles::allRoles($this->roles) as $r) {
			if ($f[$r['id'].'_disk_fs'] === '') {
				$f[$r['id'].'_disk_fs'] = '/';
			}
			$client['hosts'][$r['id']] = [];
			foreach (self::splitIps($v('ips_'.$r['id'])) as $ip) {
				if (!self::isIPv4($ip)) {
					$errors[] = _s('%1$s: "%2$s" is not an IPv4 address.', $r['label'], $ip);
					continue;
				}
				if (isset($seen[$ip])) {
					$errors[] = _s('%1$s is listed twice (%2$s and %3$s).', $ip, $seen[$ip], $r['label']);
					continue;
				}
				$seen[$ip] = $r['label'];
				$client['hosts'][$r['id']][] = $ip;
			}
		}
		unset($f);

		return ['client' => $client, 'errors' => $errors];
	}

	/** IPs from a text box or a CSV cell: one per line, or separated by ; , or spaces. */
	public static function splitIps(string $text): array {
		return array_values(array_filter(array_map('trim', preg_split('/[\s;,]+/', $text)), fn($s) => $s !== ''));
	}

	public static function isIPv4(string $s): bool {
		return filter_var($s, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false;
	}

	/** "https://es.acme:9200" → scheme, host, port (9200 when none is given); null when not that shape. */
	public static function esEndpoint(string $url): ?array {
		if (!preg_match('~^(https?)://([A-Za-z0-9.\-]+)(?::(\d{1,5}))?/?$~', $url, $m)) {
			return null;
		}
		return ['scheme' => $m[1], 'host' => $m[2], 'port' => ($m[3] ?? '') !== '' ? $m[3] : '9200'];
	}

	/** "secret/x:key" → [path, key]; null when not that shape. */
	public static function vaultRef(string $ref): ?array {
		$at = strrpos($ref, ':');
		if ($at === false || $at === 0 || $at === strlen($ref) - 1) {
			return null;
		}
		return [substr($ref, 0, $at), substr($ref, $at + 1)];
	}

	/* ------------------------------------ names ------------------------------------ */

	public static function masterName(string $client): string {
		return $client.'-Master';
	}

	public static function clusterName(string $client): string {
		return $client.'-ES-Cluster';
	}

	public static function ulmName(string $client): string {
		return $client.'-ULM';
	}

	public static function machineName(string $client, array $role, int $n): string {
		return $client.'-'.$role['short'].'-'.$n;
	}

	/** The number in a machine's name, when it follows the pattern for this role; null otherwise. */
	public static function slotOf(string $host, string $client, array $role): ?int {
		$prefix = $client.'-'.$role['short'].'-';
		if (strpos($host, $prefix) !== 0) {
			return null;
		}
		$n = substr($host, strlen($prefix));
		return ctype_digit($n) && (int) $n > 0 ? (int) $n : null;
	}

	/* ------------------------------------ macros ------------------------------------ */

	/** The master host's macros: macro => [value, type]. */
	public function masterMacros(array $client): array {
		$out = ['{$GRP.CLIENT}' => [$client['name'], 0]];
		foreach ($this->macroFields() as $field => $macro) {
			$out[$macro] = [$client['fields'][$field], 0];
		}
		return $out;
	}

	/** A family's requested figure: the sum over its roles. */
	public function familySum(array $client, array $family, string $suffix): string {
		$sum = 0.0;
		foreach ($family['roles'] as $r) {
			$sum += (float) $client['fields'][$r['id'].'_'.$suffix];
		}
		return (string) (floor($sum) == $sum ? (int) $sum : $sum);
	}

	/**
	 * The cluster host's macros. The password is set only when the host is new or the form names
	 * a Vault path: an existing host keeps the password it has. Requested figures go per family
	 * under the SISA template's names — memory under both spellings it uses.
	 */
	public function clusterMacros(array $client, bool $new): array {
		$es = $client['es'];
		$out = [
			'{$GRP.CLIENT}' => [$client['name'], 0],
			'{$ELASTICSEARCH.SCHEME}' => [$es['scheme'], 0],
			'{$ELASTICSEARCH.HOST}' => [$es['host'], 0],
			'{$ELASTICSEARCH.PORT}' => [$es['port'], 0],
			'{$ELASTICSEARCH.USERNAME}' => [$client['fields']['es_user'] !== '' ? $client['fields']['es_user'] : 'elastic', 0],
			'{$ELASTICSEARCH.JUMPHOST}' => [$client['fields']['es_jumphost'], 0],
			'{$ES.VOLUME.CUS.PURCHASED}' => [$client['fields']['purchased'], 0]
		];
		$password = $this->passwordRef($client, $new);
		if ($password !== null) {
			$out['{$ELASTICSEARCH.PASSWORD}'] = [$password, ZBX_MACRO_TYPE_VAULT];
		}
		foreach ($this->roles['families'] as $fam) {
			$p = '{$'.$fam['sisa'].'.';
			$out[$p.'SERVER.COUNT.REQUESTED}'] = [$this->familySum($client, $fam, 'servers'), 0];
			$out[$p.'CPU.REQUESTED}'] = [$this->familySum($client, $fam, 'cpu'), 0];
			$out[$p.'MEMORY.REQUESTED}'] = [$this->familySum($client, $fam, 'mem'), 0];
			$out[$p.'ROOTDISK.REQUESTED}'] = [$this->familySum($client, $fam, 'disk'), 0];
			if (!empty($fam['memAlias'])) {
				$out['{$'.$fam['memAlias'].'}'] = [$this->familySum($client, $fam, 'mem'), 0];
			}
		}
		return $out;
	}

	/** The log archive host's macros; the S3 secret only for an access key, from Vault. */
	public function ulmMacros(array $client, bool $new): array {
		$all = $this->clusterMacros($client, $new);
		$out = array_intersect_key($all, array_flip(['{$GRP.CLIENT}', '{$ELASTICSEARCH.SCHEME}', '{$ELASTICSEARCH.HOST}',
			'{$ELASTICSEARCH.PORT}', '{$ELASTICSEARCH.USERNAME}', '{$ELASTICSEARCH.PASSWORD}']));
		foreach (self::TO_ULM as $macro) {
			$out[$macro] = [$this->masterValue($client, $macro), 0];
		}
		if ($client['fields']['ulm_auth'] === 'access_key') {
			$ref = $client['fields']['ulm_secret_path'] !== ''
				? $client['fields']['ulm_secret_path']
				: 'secret/elasticvue/'.$client['name'].'-s3:secret_access_key';
			$out['{$ULM.AWS.SECRET.ACCESS.KEY}'] = [$ref, ZBX_MACRO_TYPE_VAULT];
		}
		return $out;
	}

	/** A master macro's value for this client: the form's, or the template default for settings the form does not show. */
	public function masterValue(array $client, string $macro): string {
		$field = array_search($macro, $this->macroFields(), true);
		if ($field !== false) {
			return (string) $client['fields'][$field];
		}
		if (!array_key_exists($macro, $this->defaults)) {
			throw new \LogicException("$macro is handed on but the master template does not define it");
		}
		return (string) $this->defaults[$macro];
	}

	public function wantsUlm(array $client): bool {
		return $client['es'] !== null && $client['fields']['ulm_bucket'] !== self::UNSET_BUCKET;
	}

	private function passwordRef(array $client, bool $new): ?string {
		if ($client['fields']['es_password_path'] !== '') {
			return $client['fields']['es_password_path'];
		}
		return $new ? 'secret/elasticvue/'.$client['name'].':password' : null;
	}
}
