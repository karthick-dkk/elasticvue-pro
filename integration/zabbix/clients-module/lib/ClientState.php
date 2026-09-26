<?php declare(strict_types = 0);

namespace Modules\EvpClients\Lib;

use API;

/**
 * Clients as they are in Zabbix now, in the form's own terms — what the edit form shows, what an
 * export writes, what a backup keeps and what an import is compared with.
 */
class ClientState {

	/** @var ClientSpec */
	private $spec;
	/** @var Reconciler */
	private $rec;

	public function __construct(ClientSpec $spec, Reconciler $rec) {
		$this->spec = $spec;
		$this->rec = $rec;
	}

	/** Every client (a master host carrying the template), by name. */
	public function clients(): array {
		$tpl = API::Template()->get(['output' => ['templateid'], 'filter' => ['host' => MasterTemplate::NAME]]);
		if (!$tpl) {
			return [];
		}
		$out = [];
		foreach (API::Host()->get(['output' => ['hostid', 'host'], 'templateids' => [$tpl[0]['templateid']]]) as $master) {
			$m = $this->rec->macros($master['hostid']);
			$name = ($m['{$GRP.CLIENT}'] ?? '') !== '' ? $m['{$GRP.CLIENT}'] : preg_replace('/(-Master| master)$/', '', $master['host']);
			$out[$name] = ['name' => $name, 'masterid' => $master['hostid'], 'macros' => $m];
		}
		ksort($out, SORT_NATURAL | SORT_FLAG_CASE);
		return $out;
	}

	/** Elasticsearch cluster hosts that belong to no client yet, each with the client name it suggests. */
	public function candidates(array $clients): array {
		$tpl = API::Template()->get(['output' => ['templateid'], 'filter' => ['host' => Reconciler::CLUSTER_TEMPLATES[0]]]);
		if (!$tpl) {
			return [];
		}
		$out = [];
		foreach (API::Host()->get(['output' => ['hostid', 'host'], 'templateids' => [$tpl[0]['templateid']]]) as $host) {
			$m = $this->rec->macros($host['hostid']);
			$name = ($m['{$GRP.CLIENT}'] ?? '') !== '' ? $m['{$GRP.CLIENT}'] : preg_replace('/(-ES-Cluster| cluster)$/', '', $host['host']);
			if (!isset($clients[$name])) {
				$out[] = ['name' => $name, 'host' => $host['host'], 'es_url' => self::urlFrom($m)];
			}
		}
		return $out;
	}

	public static function urlFrom(array $m): string {
		return ($m['{$ELASTICSEARCH.HOST}'] ?? '') !== ''
			? ($m['{$ELASTICSEARCH.SCHEME}'] ?? 'http').'://'.$m['{$ELASTICSEARCH.HOST}'].':'.($m['{$ELASTICSEARCH.PORT}'] ?? '9200')
			: '';
	}

	/**
	 * The form as it stands for a client: the master host's macros when there is one, else what
	 * its cluster host says; the machines as they are, per role. `_now` carries what was read,
	 * `_unassigned` the machines in a family's group that have no role yet.
	 */
	public function formFor(string $client): array {
		$form = $this->spec->defaults();
		$form['name'] = $client;
		$now = $this->rec->current($client);

		if ($now['master'] !== null) {
			$m = $this->rec->macros($now['master']['hostid']);
			foreach ($this->spec->macroFields() as $field => $macro) {
				if (array_key_exists($macro, $m)) {
					$form[$field] = $m[$macro];
				}
			}
		}
		elseif ($now['cluster'] !== null) {
			$m = $this->rec->macros($now['cluster']['hostid']);
			$form['es_url'] = self::urlFrom($m);
			$form['es_user'] = $m['{$ELASTICSEARCH.USERNAME}'] ?? $form['es_user'];
			$form['es_jumphost'] = $m['{$ELASTICSEARCH.JUMPHOST}'] ?? '';
			$form['purchased'] = $m['{$ES.VOLUME.CUS.PURCHASED}'] ?? $form['purchased'];
		}
		if ($form['ulm_bucket'] === ClientSpec::UNSET_BUCKET) {
			$form['ulm_bucket'] = '';
		}
		foreach (Roles::allRoles($this->spec->roles()) as $r) {
			$ips = array_filter(array_map(fn($h) => $h['_ip'], $now['roles'][$r['id']]));
			$form['ips_'.$r['id']] = implode("\n", $ips);
		}
		$form['_now'] = $now;
		$form['_unassigned'] = array_map(fn($h) => ['name' => $h['name'], 'ip' => $h['_ip']], $now['unassigned']);
		return $form;
	}

	/** Only the form's own fields — what a backup keeps and a comparison looks at. */
	public static function plain(array $form): array {
		return array_filter($form, fn($k) => $k[0] !== '_', ARRAY_FILTER_USE_KEY);
	}
}
