<?php declare(strict_types = 0);

namespace Modules\EvpClients\Lib;

use API;
use Exception;

/**
 * Makes Zabbix match a client: its host group, master host, cluster host, log archive host and
 * one Linux host per machine, named <client>-<Role>-<n>.
 *
 * Hosts already in the client's group are taken on as they are — the cluster host by its
 * Elasticsearch template, a machine by its IP — keeping their history and passwords, and are
 * renamed to the client's pattern. A machine joins its role's group and its family's group (the
 * groups the SISA templates count); moving it to another role moves it between those groups,
 * and no group the roles do not name is ever touched. Only hosts this page made carry the tag
 * managed-by: elasticvue-clients, and only those are ever deleted. Groups are never deleted.
 *
 * Macros are written one at a time: a host's other macros, and secret values, stay as they were.
 */
class Reconciler {

	public const MANAGED = ['tag' => 'managed-by', 'value' => 'elasticvue-clients'];
	public const MASTERS_GROUP = 'ElasticVue clients';
	public const CLUSTER_GROUP = 'Elasticsearch clusters';
	public const ULM_GROUP = 'Log archive';
	public const CLUSTER_TEMPLATES = ['Elasticsearch Cluster by HTTP SISA', 'ElasticVue Pro client plan', 'ElasticVue Pro alerts', 'ElasticVue Pro log delay'];
	public const ULM_TEMPLATE = 'ElasticVue Pro log archive S3';
	public const AGENT_TEMPLATE = 'Linux by Zabbix agent -SISA';

	/** @var ClientSpec */
	private $spec;
	/** @var array */
	private $roles;
	/** @var string[] */
	private $done = [];
	/** @var array group name => id */
	private $groupIds = [];

	public function __construct(ClientSpec $spec) {
		$this->spec = $spec;
		$this->roles = $spec->roles();
	}

	public function done(): array {
		return $this->done;
	}

	public function note(string $line): void {
		$this->done[] = $line;
	}

	/* ------------------------------------ reading ------------------------------------ */

	public function templateIds(): array {
		$names = array_merge([MasterTemplate::NAME], self::CLUSTER_TEMPLATES, [self::ULM_TEMPLATE, self::AGENT_TEMPLATE]);
		$found = array_column(API::Template()->get(['output' => ['templateid', 'host'], 'filter' => ['host' => $names]]), 'templateid', 'host');
		$missing = array_diff($names, array_keys($found));
		if ($missing) {
			throw new Exception(_s('Import these templates first: %1$s.', implode(', ', $missing)));
		}
		return $found;
	}

	public function groupId(string $name, bool $create): ?string {
		if (isset($this->groupIds[$name])) {
			return $this->groupIds[$name];
		}
		$groups = API::HostGroup()->get(['output' => ['groupid'], 'filter' => ['name' => $name]]);
		if ($groups) {
			return $this->groupIds[$name] = $groups[0]['groupid'];
		}
		if (!$create) {
			return null;
		}
		$r = $this->api(API::HostGroup()->create(['name' => $name]), _s('create host group "%1$s"', $name));
		$this->done[] = _s('Created host group "%1$s".', $name);
		return $this->groupIds[$name] = $r['groupids'][0];
	}

	public function hostsIn(?string $groupid): array {
		if ($groupid === null) {
			return [];
		}
		return API::Host()->get([
			'output' => ['hostid', 'host', 'name', 'active_available'],
			'groupids' => [$groupid],
			'selectHostGroups' => ['groupid', 'name'],
			'selectParentTemplates' => ['templateid', 'host'],
			'selectInterfaces' => ['interfaceid', 'ip', 'dns', 'type', 'main', 'available'],
			'selectTags' => ['tag', 'value'],
			'preservekeys' => true
		]);
	}

	public static function isManaged(array $host): bool {
		foreach ($host['tags'] ?? [] as $tag) {
			if ($tag['tag'] === self::MANAGED['tag'] && $tag['value'] === self::MANAGED['value']) {
				return true;
			}
		}
		return false;
	}

	public static function hasTemplate(array $host, string $template): bool {
		return in_array($template, array_column($host['parentTemplates'] ?? [], 'host'), true);
	}

	public static function groupNames(array $host): array {
		return array_column($host['hostgroups'] ?? [], 'name');
	}

	public static function agentIp(array $host): ?string {
		foreach ($host['interfaces'] ?? [] as $if) {
			if ($if['type'] == INTERFACE_TYPE_AGENT && $if['main'] == INTERFACE_PRIMARY && $if['ip'] !== '') {
				return $if['ip'];
			}
		}
		return null;
	}

	/**
	 * What exists for a client now: master, cluster and archive hosts, and its machines — each
	 * with its role (null for a machine in a family's group but in no role's), and per role.
	 */
	public function current(string $client): array {
		$gid = $this->groupId($client, false);
		$hosts = $this->hostsIn($gid);
		$out = ['groupid' => $gid, 'master' => null, 'cluster' => null, 'ulm' => null, 'machines' => [], 'roles' => [], 'unassigned' => []];
		foreach ($hosts as $host) {
			if (self::hasTemplate($host, MasterTemplate::NAME)) {
				$out['master'] = $host;
			}
			elseif ($out['cluster'] === null && self::hasTemplate($host, self::CLUSTER_TEMPLATES[0])) {
				$out['cluster'] = $host;
			}
		}
		foreach ($hosts as $host) {
			if (in_array($host['hostid'], [$out['master']['hostid'] ?? null, $out['cluster']['hostid'] ?? null], true)) {
				continue;
			}
			if ($out['ulm'] === null && self::hasTemplate($host, self::ULM_TEMPLATE)) {
				$out['ulm'] = $host;
			}
		}
		foreach (Roles::allRoles($this->roles) as $r) {
			$out['roles'][$r['id']] = [];
		}
		$special = array_filter([$out['master']['hostid'] ?? null, $out['cluster']['hostid'] ?? null, $out['ulm']['hostid'] ?? null]);
		foreach ($hosts as $host) {
			if (in_array($host['hostid'], $special, true)) {
				continue;
			}
			$groups = self::groupNames($host);
			$role = null;
			$family = null;
			foreach ($this->roles['families'] as $f) {
				if (in_array($f['group'], $groups, true)) {
					$family = $f;
				}
				foreach ($f['roles'] as $r) {
					// A role whose group is its family's (Forwarder) is only chosen when the family is.
					if (in_array($r['group'], $groups, true) && ($r['group'] !== $f['group'] || count($f['roles']) === 1)) {
						$role = $r + ['family' => $f['id'], 'familyGroup' => $f['group']];
						$family = $f;
						break 2;
					}
				}
			}
			if ($family === null) {
				continue;
			}
			$host['_role'] = $role;
			$host['_ip'] = self::agentIp($host);
			$out['machines'][$host['hostid']] = $host;
			if ($role !== null) {
				$out['roles'][$role['id']][] = $host;
			}
			else {
				$out['unassigned'][] = $host;
			}
		}
		// A master host outside the client's group, from before the group existed.
		if ($out['master'] === null) {
			foreach ([ClientSpec::masterName($client), $client.' master'] as $name) {
				$found = API::Host()->get(['output' => ['hostid', 'host', 'name'], 'filter' => ['host' => $name],
					'selectTags' => ['tag', 'value'], 'selectHostGroups' => ['groupid', 'name'], 'selectParentTemplates' => ['templateid', 'host']]);
				if ($found) {
					$out['master'] = $found[0];
					break;
				}
			}
		}
		return $out;
	}

	public function macros(string $hostid): array {
		return array_column(API::UserMacro()->get(['output' => ['macro', 'value'], 'hostids' => [$hostid]]), 'value', 'macro');
	}

	/* ------------------------------------ writing ------------------------------------ */

	/** Make Zabbix match the client. Throws, with what Zabbix said, at the first refusal. */
	public function apply(array $client): void {
		$tpl = $this->templateIds();
		$name = $client['name'];
		$now = $this->current($name);
		$gid = $now['groupid'] ?? $this->groupId($name, true);

		// Master host: the client's figures, alerts and dashboard.
		$masters_gid = $this->groupId(self::MASTERS_GROUP, true);
		if ($now['master'] === null) {
			$hostid = $this->create(['host' => ClientSpec::masterName($name), 'groups' => $this->g([$masters_gid, $gid]),
				'templates' => $this->t([$tpl[MasterTemplate::NAME]]), 'tags' => $this->tags($name, 'master')]);
			$this->done[] = _s('Created "%1$s".', ClientSpec::masterName($name));
		}
		else {
			$hostid = $now['master']['hostid'];
			$this->rename($now['master'], ClientSpec::masterName($name));
			$this->link($hostid, [$tpl[MasterTemplate::NAME]], [$masters_gid, $gid]);
		}
		$this->setMacros($hostid, $this->spec->masterMacros($client));

		// Cluster host (Elasticsearch HTTP), when there is an ES URL.
		if ($client['es'] !== null) {
			$templates = array_map(fn($x) => $tpl[$x], self::CLUSTER_TEMPLATES);
			$groups = [$gid, $this->groupId(self::CLUSTER_GROUP, true)];
			if ($now['cluster'] === null) {
				$hostid = $this->create(['host' => ClientSpec::clusterName($name), 'groups' => $this->g($groups), 'templates' => $this->t($templates),
					// The Elasticsearch template's port checks need an interface to exist.
					'interfaces' => [['type' => INTERFACE_TYPE_AGENT, 'main' => INTERFACE_PRIMARY, 'useip' => INTERFACE_USE_DNS,
						'ip' => '', 'dns' => $client['es']['host'], 'port' => '10050']],
					'tags' => $this->tags($name, 'cluster')]);
				$this->setMacros($hostid, $this->spec->clusterMacros($client, true));
				$this->done[] = _s('Created "%1$s".', ClientSpec::clusterName($name));
			}
			else {
				$this->rename($now['cluster'], ClientSpec::clusterName($name));
				$this->link($now['cluster']['hostid'], $templates, $groups);
				$this->setMacros($now['cluster']['hostid'], $this->spec->clusterMacros($client, false));
			}
		}

		// Log archive host, when there is a bucket; removed when there no longer is one.
		if ($this->spec->wantsUlm($client)) {
			$groups = [$gid, $this->groupId(self::ULM_GROUP, true)];
			if ($now['ulm'] === null) {
				$hostid = $this->create(['host' => ClientSpec::ulmName($name), 'groups' => $this->g($groups),
					'templates' => $this->t([$tpl[self::ULM_TEMPLATE]]), 'tags' => $this->tags($name, 'log-archive')]);
				$this->setMacros($hostid, $this->spec->ulmMacros($client, true));
				$this->done[] = _s('Created "%1$s".', ClientSpec::ulmName($name));
			}
			else {
				$this->rename($now['ulm'], ClientSpec::ulmName($name));
				$this->link($now['ulm']['hostid'], [$tpl[self::ULM_TEMPLATE]], $groups);
				$this->setMacros($now['ulm']['hostid'], $this->spec->ulmMacros($client, false));
			}
		}
		elseif ($now['ulm'] !== null && self::isManaged($now['ulm'])) {
			$this->delete([$now['ulm']]);
		}

		$this->machines($client, $now, $gid, $tpl[self::AGENT_TEMPLATE]);
	}

	/** The machines, role by role, matched by IP across the whole client. */
	private function machines(array $client, array $now, string $gid, string $agent_tpl): void {
		$name = $client['name'];
		$config_groups = Roles::groups($this->roles);
		$byIp = [];
		foreach ($now['machines'] as $host) {
			if ($host['_ip'] !== null) {
				$byIp[$host['_ip']] = $host;
			}
		}
		// Numbers already in use per role — names that follow the pattern keep theirs.
		$taken = [];
		foreach (Roles::allRoles($this->roles) as $r) {
			$taken[$r['id']] = [];
			foreach ($now['machines'] as $host) {
				$n = ClientSpec::slotOf($host['host'], $name, $r);
				if ($n !== null) {
					$taken[$r['id']][$n] = true;
				}
			}
		}
		$next = function(string $role) use (&$taken): int {
			$n = $taken[$role] ? max(array_keys($taken[$role])) + 1 : 1;
			$taken[$role][$n] = true;
			return $n;
		};
		$port = $client['fields']['agent_port'] !== '' ? $client['fields']['agent_port'] : '10050';

		$kept = [];
		foreach (Roles::allRoles($this->roles) as $r) {
			$want_groups = [$gid, $this->groupId($r['familyGroup'], true), $this->groupId($r['group'], true)];
			foreach ($client['hosts'][$r['id']] as $ip) {
				if (isset($byIp[$ip])) {
					$host = $byIp[$ip];
					$kept[$host['hostid']] = true;
					$slot = ClientSpec::slotOf($host['host'], $name, $r);
					if ($slot === null) {
						$this->rename($host, ClientSpec::machineName($name, $r, $next($r['id'])));
					}
					// Out of the groups of any other role or family; into this one's.
					$drop = [];
					foreach ($host['hostgroups'] as $g) {
						if (in_array($g['name'], $config_groups, true) && !in_array($g['name'], [$r['group'], $r['familyGroup']], true)) {
							$drop[] = $g['groupid'];
						}
					}
					if ($drop) {
						$this->api(API::Host()->massRemove(['hostids' => [$host['hostid']], 'groupids' => $drop]), _('move between role groups'));
					}
					$this->link($host['hostid'], [$agent_tpl], $want_groups);
					$this->setMacros($host['hostid'], ['{$GRP.CLIENT}' => [$name, 0]]);
					if (self::isManaged($host)) {
						$this->api(API::Host()->update(['hostid' => $host['hostid'], 'tags' => $this->tags($name, $r['id'])]), _('update tags'));
					}
					continue;
				}
				$host_name = ClientSpec::machineName($name, $r, $next($r['id']));
				$hostid = $this->create([
					'host' => $host_name, 'groups' => $this->g($want_groups), 'templates' => $this->t([$agent_tpl]),
					'interfaces' => [['type' => INTERFACE_TYPE_AGENT, 'main' => INTERFACE_PRIMARY, 'useip' => INTERFACE_USE_IP,
						'ip' => $ip, 'dns' => '', 'port' => $port]],
					'tags' => $this->tags($name, $r['id'])
				]);
				$this->setMacros($hostid, ['{$GRP.CLIENT}' => [$name, 0]]);
				$kept[$hostid] = true;
				$this->done[] = _s('Created "%1$s" (%2$s).', $host_name, $ip);
			}
		}
		// No longer listed: deleted if this page made it, left alone if somebody else did.
		$gone = array_filter($now['machines'], fn($h) => !isset($kept[$h['hostid']]));
		$this->delete(array_filter($gone, [self::class, 'isManaged']));
		foreach (array_filter($gone, fn($h) => !self::isManaged($h)) as $host) {
			$this->done[] = _s('"%1$s" was made by hand and is left as it is — give its IP a role to take it on, or remove it in Data collection → Hosts.', $host['name']);
		}
	}

	/** Remove a client: every host this page made for it. Hosts made by hand and the host group stay. */
	public function remove(string $client): void {
		$now = $this->current($client);
		$all = [];
		foreach (array_merge(array_filter([$now['master'], $now['cluster'], $now['ulm']]), array_values($now['machines'])) as $h) {
			$all[$h['hostid']] = $h;
		}
		$this->delete(array_filter($all, [self::class, 'isManaged']));
		foreach (array_filter($all, fn($h) => !self::isManaged($h)) as $host) {
			$this->done[] = _s('"%1$s" was made by hand and is kept.', $host['name']);
		}
	}

	/* ------------------------------------ helpers ------------------------------------ */

	private function g(array $ids): array {
		return array_map(fn($id) => ['groupid' => $id], array_values(array_unique($ids)));
	}

	private function t(array $ids): array {
		return array_map(fn($id) => ['templateid' => $id], array_values(array_unique($ids)));
	}

	private function tags(string $client, string $role): array {
		return [self::MANAGED, ['tag' => 'client', 'value' => $client], ['tag' => 'role', 'value' => $role]];
	}

	private function create(array $host): string {
		$host['name'] = $host['host'];
		return $this->api(API::Host()->create($host), _s('create host "%1$s"', $host['host']))['hostids'][0];
	}

	/** Give a host the client's name for it. History, items and links stay with the host. */
	private function rename(array $host, string $to): void {
		if ($host['host'] === $to && ($host['name'] ?? $to) === $to) {
			return;
		}
		$this->api(API::Host()->update(['hostid' => $host['hostid'], 'host' => $to, 'name' => $to]), _s('rename "%1$s"', $host['host']));
		$this->done[] = _s('Renamed "%1$s" to "%2$s".', $host['host'], $to);
	}

	/** Add templates and groups a host lacks. Nothing it has is taken away. */
	private function link(string $hostid, array $templateids, array $groupids): void {
		$this->api(API::Host()->massAdd(['hosts' => [['hostid' => $hostid]], 'templates' => $this->t($templateids), 'groups' => $this->g($groupids)]),
			_('link templates and groups'));
	}

	/** Write these macros, one by one; every other macro on the host stays as it is. */
	private function setMacros(string $hostid, array $want): void {
		$have = [];
		foreach (API::UserMacro()->get(['output' => ['hostmacroid', 'macro', 'value', 'type'], 'hostids' => [$hostid]]) as $m) {
			$have[$m['macro']] = $m;
		}
		$create = [];
		foreach ($want as $macro => [$value, $type]) {
			if (!array_key_exists($macro, $have)) {
				$create[] = ['hostid' => $hostid, 'macro' => $macro, 'value' => (string) $value, 'type' => $type];
			}
			elseif ($have[$macro]['type'] != $type || ($type != ZBX_MACRO_TYPE_SECRET && $have[$macro]['value'] !== (string) $value)) {
				$this->api(API::UserMacro()->update(['hostmacroid' => $have[$macro]['hostmacroid'], 'value' => (string) $value, 'type' => $type]),
					_s('update macro %1$s', $macro));
			}
		}
		if ($create) {
			$this->api(API::UserMacro()->create($create), _('create macros'));
		}
	}

	private function delete(array $hosts): void {
		if (!$hosts) {
			return;
		}
		$this->api(API::Host()->delete(array_values(array_column($hosts, 'hostid'))), _('delete hosts'));
		foreach ($hosts as $host) {
			$this->done[] = _s('Deleted "%1$s".', $host['name']);
		}
	}

	private function api($result, string $what) {
		if ($result === false) {
			$said = array_column(get_and_clear_messages(), 'message');
			throw new Exception(_s('Zabbix would not %1$s: %2$s', $what, implode(' ', $said) ?: _('no reason given')));
		}
		return $result;
	}
}
