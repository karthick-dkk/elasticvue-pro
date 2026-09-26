<?php declare(strict_types = 0);

namespace Modules\EvpClients\Lib;

use API;

/**
 * Reads an uploaded file against Zabbix: what is new, what would change and how, what is
 * unchanged, what is wrong — and what overlaps something else.
 *
 * Errors stop the whole file: nothing is applied until every row is right. Overlaps are warnings
 * — an IP another client already uses, an ES URL or tag1 value two clients share — and a new
 * client with one waits for a tick instead of being added straight away.
 */
class Importer {

	/** @var ClientSpec */
	private $spec;
	/** @var ClientState */
	private $state;
	/** @var array */
	private $roles;

	public function __construct(ClientSpec $spec, ClientState $state) {
		$this->spec = $spec;
		$this->state = $state;
		$this->roles = $spec->roles();
	}

	/** The plan for a parsed file. */
	public function analyze(array $parsed): array {
		$plan = ['rows' => [], 'errors' => $parsed['errors'], 'ignored' => $parsed['ignored']];
		if ($parsed['errors']) {
			return $plan;
		}
		$existing = $this->state->clients();
		$names = [];
		$ipOwner = [];

		foreach ($parsed['rows'] as $row) {
			$name = trim((string) ($row['client'] ?? ''));
			$line = $row['_line'];
			$exists = $name !== '' && isset($existing[$name]);
			$before = $exists ? ClientState::plain($this->state->formFor($name)) : null;
			$base = $before ?? ($this->spec->defaults() + ['name' => $name]);
			$form = Csv::toForm($row, $base, $this->roles);
			['client' => $client, 'errors' => $errors] = $this->spec->fromForm($form);

			if ($name !== '' && isset($names[strtolower($name)])) {
				$errors[] = _s('Client "%1$s" is in the file twice (lines %2$s and %3$s).', $name, $names[strtolower($name)], $line);
			}
			$names[strtolower($name)] = $line;
			foreach ($client['hosts'] as $ips) {
				foreach ($ips as $ip) {
					if (isset($ipOwner[$ip]) && $ipOwner[$ip] !== $name) {
						$errors[] = _s('%1$s is listed for both %2$s and %3$s.', $ip, $ipOwner[$ip], $name);
					}
					$ipOwner[$ip] = $name;
				}
			}

			$diff = ($exists && !$errors) ? $this->diff($before, $client) : null;
			$plan['rows'][] = [
				'line' => $line,
				'name' => $name,
				'status' => $errors ? 'error' : (!$exists ? 'new' : ($diff['fields'] || $diff['hosts'] ? 'update' : 'same')),
				'errors' => $errors,
				'warnings' => [],
				'diff' => $diff,
				'form' => $form,
				'type' => $client['fields']['type'] ?? ''
			];
		}

		foreach ($plan['rows'] as $i => $row) {
			if ($row['errors']) {
				$plan['errors'][] = _s('Line %1$s (%2$s): %3$s', $row['line'], $row['name'] !== '' ? $row['name'] : '?', implode(' ', $row['errors']));
			}
		}
		if (!$plan['errors']) {
			$this->overlaps($plan, $existing);
		}
		return $plan;
	}

	/** What changes for an existing client: settings old → new, machines added and removed. */
	public function diff(array $before, array $client): array {
		['client' => $old] = $this->spec->fromForm($before);
		$labels = $this->labels();
		$fields = [];
		foreach ($client['fields'] as $k => $v) {
			if ((string) ($old['fields'][$k] ?? '') !== (string) $v) {
				$fields[] = ['field' => $labels[$k] ?? $k, 'old' => $old['fields'][$k] ?? '', 'new' => $v];
			}
		}
		$now = $this->state->formFor($client['name'])['_now'];
		$byIp = [];
		foreach ($now['machines'] as $h) {
			if ($h['_ip'] !== null) {
				$byIp[$h['_ip']] = $h;
			}
		}
		$hosts = [];
		$listed = [];
		foreach (Roles::allRoles($this->roles) as $r) {
			$was = $old['hosts'][$r['id']] ?? [];
			foreach ($client['hosts'][$r['id']] as $ip) {
				$listed[$ip] = true;
				if (!in_array($ip, $was, true)) {
					$hosts[] = ['change' => isset($byIp[$ip]) ? 'role' : 'add', 'role' => $r['label'], 'ip' => $ip,
						'host' => $byIp[$ip]['name'] ?? null];
				}
			}
		}
		foreach ($byIp as $ip => $h) {
			if (!isset($listed[$ip]) && $h['_role'] !== null) {
				$hosts[] = ['change' => Reconciler::isManaged($h) ? 'delete' : 'leave', 'role' => $h['_role']['label'], 'ip' => $ip, 'host' => $h['name']];
			}
		}
		return ['fields' => $fields, 'hosts' => $hosts];
	}

	/** IPs, ES URLs and tag1 values shared with other clients — in Zabbix or elsewhere in the file. */
	private function overlaps(array &$plan, array $existing): void {
		$ips = [];
		foreach ($plan['rows'] as $row) {
			['client' => $c] = $this->spec->fromForm($row['form']);
			foreach ($c['hosts'] as $list) {
				foreach ($list as $ip) {
					$ips[$ip] = $row['name'];
				}
			}
		}
		if ($ips) {
			$ifs = API::HostInterface()->get(['output' => ['hostid', 'ip'], 'filter' => ['ip' => array_keys($ips)]]);
			$hostids = array_unique(array_column($ifs, 'hostid'));
			$hosts = $hostids ? API::Host()->get(['output' => ['hostid', 'name'], 'hostids' => $hostids,
				'selectHostGroups' => ['name'], 'preservekeys' => true]) : [];
			foreach ($ifs as $if) {
				$h = $hosts[$if['hostid']] ?? null;
				if ($h === null) {
					continue;
				}
				$owner = $ips[$if['ip']];
				$groups = array_column($h['hostgroups'], 'name');
				if (in_array($owner, $groups, true)) {
					continue;
				}
				$other = array_values(array_intersect($groups, array_keys($existing)));
				$this->warn($plan, $owner, $other
					? _s('%1$s is already "%2$s" of client %3$s.', $if['ip'], $h['name'], $other[0])
					: _s('%1$s is already used by "%2$s", which belongs to no client.', $if['ip'], $h['name']));
			}
		}

		// ES URLs and tag1 values: the file's rows and the clients not in the file.
		$urls = [];
		$tags = [];
		$inFile = array_column($plan['rows'], 'name');
		foreach ($existing as $name => $c) {
			if (!in_array($name, $inFile, true)) {
				$urls[$name] = $c['macros']['{$ES.URL}'] ?? '';
				$tags[$name] = $c['macros']['{$ULM.TAGS}'] ?? '';
			}
		}
		foreach ($plan['rows'] as $row) {
			$urls[$row['name']] = $row['form']['es_url'] ?? '';
			$tags[$row['name']] = $row['form']['ulm_tags'] ?? '';
		}
		$seenUrl = [];
		foreach ($urls as $name => $url) {
			$key = rtrim(strtolower($url), '/');
			if ($key === '') {
				continue;
			}
			if (isset($seenUrl[$key])) {
				foreach ([$name, $seenUrl[$key]] as $who) {
					$this->warn($plan, $who, _s('%1$s and %2$s have the same ES URL (%3$s).', $seenUrl[$key], $name, $url));
				}
			}
			$seenUrl[$key] = $name;
		}
		$seenTag = [];
		foreach ($tags as $name => $list) {
			foreach (array_filter(array_map('trim', preg_split('/[;,]/', (string) $list))) as $t) {
				if (isset($seenTag[$t]) && $seenTag[$t] !== $name) {
					$this->warn($plan, $name, _s('tag1 value "%1$s" is also a tag of %2$s — the archive check would compare it for both.', $t, $seenTag[$t]));
				}
				$seenTag[$t] = $name;
			}
		}
	}

	private function warn(array &$plan, string $name, string $text): void {
		foreach ($plan['rows'] as &$row) {
			if ($row['name'] === $name && !in_array($text, $row['warnings'], true)) {
				$row['warnings'][] = $text;
			}
		}
	}

	/** After applying: the client read back from Zabbix, compared with what was asked. Empty when they match. */
	public function verify(array $client): array {
		$form = ClientState::plain($this->state->formFor($client['name']));
		['client' => $now] = $this->spec->fromForm($form);
		$labels = $this->labels();
		$out = [];
		foreach ($client['fields'] as $k => $v) {
			if ((string) ($now['fields'][$k] ?? '') !== (string) $v) {
				$out[] = _s('%1$s: asked "%2$s", Zabbix has "%3$s".', $labels[$k] ?? $k, $v, $now['fields'][$k] ?? '');
			}
		}
		foreach (Roles::allRoles($this->roles) as $r) {
			$want = $client['hosts'][$r['id']];
			$have = $now['hosts'][$r['id']] ?? [];
			sort($want);
			sort($have);
			if ($want !== $have) {
				$out[] = _s('%1$s: asked %2$s, Zabbix has %3$s.', $r['label'], implode(', ', $want) ?: '—', implode(', ', $have) ?: '—');
			}
		}
		return $out;
	}

	/** Field => words, for changes and checks. */
	public function labels(): array {
		$out = ['type' => _('Type'), 'es_url' => _('ES URL'), 'es_user' => _('ES user'), 'es_password_path' => _('ES password Vault path'),
			'es_jumphost' => _('Jump host'), 'ulm_tags' => _('tag1 values'), 'ulm_bucket' => _('S3 bucket'), 'ulm_region' => _('S3 region'),
			'ulm_auth' => _('S3 access'), 'ulm_role_arn' => _('Role ARN'), 'ulm_external_id' => _('External ID'),
			'ulm_access_key_id' => _('Access key ID'), 'ulm_secret_path' => _('S3 secret Vault path'), 'ulm_raw_prefix' => _('Raw folder'),
			'ulm_enriched_prefix' => _('Enriched folder'), 'agent_port' => _('Agent port'), 'purchased' => _('Purchased storage (GB)')];
		foreach (Roles::allRoles($this->roles) as $r) {
			$out[$r['id'].'_servers'] = $r['label'].' '._('servers requested');
			$out[$r['id'].'_cpu'] = $r['label'].' '._('CPU requested');
			$out[$r['id'].'_mem'] = $r['label'].' '._('memory requested (GB)');
			$out[$r['id'].'_disk'] = $r['label'].' '._('disk requested (GB)');
			$out[$r['id'].'_disk_fs'] = $r['label'].' '._('disk mount');
		}
		return $out;
	}
}
