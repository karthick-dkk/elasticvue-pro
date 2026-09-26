<?php declare(strict_types = 0);

namespace Modules\EvpClients\Lib;

/**
 * The "ElasticVue Pro client master" template, written from the roles.
 *
 * One master host per client carries it. Per role — ES Data Hot, S3 Parser, UEBA … — it works
 * out servers, CPU, memory and disk, each requested (the Clients page's figures, macros on the
 * master host), allocated and used (across that role's machines in the client's host group).
 * Per family — ES, Parser, Forwarder, Engine — the same figures, summed over its roles: a role
 * added later counts at once, because a family's figure adds up every role item tagged with
 * the family rather than a list of them. Plus ES storage and ElasticVue Pro's log delay, a
 * shortfall alert per role, graphs and a three-page dashboard.
 *
 * Built as the array Zabbix exports, and imported as JSON. Family item keys are the ones the
 * Client capacity report reads (evp.es.cpu.requested …); role items are evp.role.<what>[<role>].
 */
class MasterTemplate {

	public const NAME = 'ElasticVue Pro client master';
	private const GB = 1073741824;

	private const RES_LABEL = ['servers' => 'servers', 'cpu' => 'CPU', 'mem' => 'memory', 'disk' => 'disk'];

	/** @var array */
	private $roles;
	/** @var array[] every item, in order */
	private $items = [];

	public function __construct(array $roles) {
		$this->roles = $roles;
	}

	public static function uuid(string $what): string {
		$h = hash('sha256', 'espro-client-master/'.$what);
		return substr($h, 0, 12).'4'.substr($h, 13, 3).'89ab'[hexdec($h[16]) % 4].substr($h, 17, 15);
	}

	/** Role item key: evp.role.cpu.requested[es_data_hot]. */
	public static function roleKey(string $res, string $kind, string $role): string {
		return 'evp.role.'.$res.'.'.$kind.'['.$role.']';
	}

	/** Family item key: evp.es.cpu.requested. */
	public static function familyKey(string $family, string $res, string $kind): string {
		return 'evp.'.$family.'.'.$res.'.'.$kind;
	}

	/** Every master host macro and its default: base settings, then per role. */
	public function macros(): array {
		$m = [
			['{$GRP.CLIENT}', '', 'Client name, and the host group all its hosts are in. Set by the Clients page.'],
			['{$EVP.CLIENT.TYPE}', 'On-Prem', 'DI (log archive required) or On-Prem.'],
			['{$ES.URL}', '', 'Elasticsearch URL, shown in the reports.'],
			['{$ES.USERNAME}', 'elastic', 'Elasticsearch user for the cluster and log archive hosts.'],
			['{$ES.PASSWORD.PATH}', '', 'Vault path:key of the Elasticsearch password.'],
			['{$ES.JUMPHOST}', '', 'ElasticVue Pro jump host, when the cluster is reached through one.'],
			['{$ULM.TAGS}', '', 'This client\'s tag1 values, comma-separated.'],
			['{$ULM.S3.BUCKET}', '(not set)', 'This client\'s archive bucket.'],
			['{$ULM.S3.REGION}', 'us-east-1', 'The bucket\'s region.'],
			['{$ULM.AWS.AUTH}', 'role_base', 'role_base or access_key.'],
			['{$ULM.AWS.ROLE.ARN}', '', 'Role to assume for the bucket.'],
			['{$ULM.AWS.EXTERNAL.ID}', '', 'External ID for the role, if any.'],
			['{$ULM.AWS.ACCESS.KEY.ID}', '', 'access_key only.'],
			['{$ULM.AWS.SECRET.PATH}', '', 'access_key only: Vault path:key of the secret.'],
			['{$ULM.S3.RAW.PREFIX}', 'rawlog', 'Folder of the raw copy.'],
			['{$ULM.S3.ENRICHED.PREFIX}', 'enrichedlog', 'Folder of the enriched copy.'],
			['{$ULM.ES.INDEX}', 'logstash-*', 'Indices holding the logs.'],
			['{$ULM.ES.TAG.FIELD}', 'tag1.keyword', 'The field whose value is the tag folder.'],
			['{$ULM.ES.BRANCH.FIELD}', 'branch.keyword', 'The field whose value is the branch folder.'],
			['{$ULM.TIMEZONE}', 'UTC', 'Time zone of the date= folders.'],
			['{$AGENT.PORT}', '10050', 'Agent port of the Linux hosts the Clients page creates.'],
			['{$ES.VOLUME.CUS.PURCHASED}', '0', 'Storage the customer purchased, GB.'],
			['{$EVP.USAGE.WARN}', '80', 'Usage at or above this is yellow.'],
			['{$EVP.USAGE.HIGH}', '90', 'Usage at or above this is red.'],
			['{$EVP.ROLES.HASH}', Roles::hash($this->roles), 'Which roles this template was written for. Set by the Clients page.']
		];
		foreach (Roles::allRoles($this->roles) as $r) {
			$m[] = [Roles::macro($r['id'], 'SERVER.COUNT.REQUESTED'), '0', $r['label'].': servers requested.'];
			$m[] = [Roles::macro($r['id'], 'CPU.REQUESTED'), '0', $r['label'].': CPU requested, cores.'];
			$m[] = [Roles::macro($r['id'], 'MEMORY.REQUESTED'), '0', $r['label'].': memory requested, GB.'];
			$m[] = [Roles::macro($r['id'], 'ROOTDISK.REQUESTED'), '0', $r['label'].': disk requested, GB.'];
			$m[] = [Roles::macro($r['id'], 'ROOTDISK.FS'), '/', $r['label'].': the mount measured as its disk.'];
		}
		return $m;
	}

	/** The whole export, ready for configuration.import. */
	public function export(): array {
		$this->items = [];
		$this->baseItems();
		foreach ($this->roles['families'] as $f) {
			foreach ($f['roles'] as $r) {
				$this->roleItems($f, $r);
			}
		}
		foreach ($this->roles['families'] as $f) {
			$this->familyItems($f);
		}

		$template = [
			'uuid' => self::uuid('template'),
			'template' => self::NAME,
			'name' => self::NAME,
			'description' => 'One master host per client, made and kept by the Clients page (ElasticVue Pro menu). Requested, allocated and used per role and per family, ES storage and ElasticVue Pro\'s log delay. Written by the Clients page from its roles — edit roles there, not here.',
			'vendor' => ['name' => 'ElasticVue Pro', 'version' => '7.0-3'],
			'groups' => [['name' => 'Templates/Applications']],
			'items' => array_values(array_map([$this, 'itemExport'], $this->items)),
			'macros' => array_map(fn($m) => ['macro' => $m[0], 'value' => $m[1], 'description' => $m[2]], $this->macros()),
			'dashboards' => [$this->dashboard()],
			'valuemaps' => [[
				'uuid' => self::uuid('valuemap/not-set'),
				'name' => 'ElasticVue Pro not set',
				'mappings' => [['value' => '0', 'newvalue' => 'not set']]
			]]
		];

		return ['zabbix_export' => [
			'version' => '7.0',
			'templates' => [$template],
			'triggers' => $this->triggers(),
			'graphs' => $this->graphs()
		]];
	}

	/* ------------------------------------ items ------------------------------------ */

	private function add(string $key, string $name, string $units, string $params, string $description, string $kind, array $tags = [], string $delay = '1m'): void {
		$this->items[$key] = compact('key', 'name', 'units', 'params', 'description', 'kind', 'tags', 'delay');
	}

	private function itemExport(array $it): array {
		$out = [
			'uuid' => self::uuid('item/'.$it['key']),
			'name' => $it['name'],
			'type' => 'CALCULATED',
			'key' => $it['key'],
			'delay' => $it['delay'],
			'value_type' => 'FLOAT',
			'params' => $it['params'],
			'description' => $it['description'],
			'tags' => array_merge([
				['tag' => 'component', 'value' => $it['kind'] === 'delay' ? 'log-delay' : 'capacity'],
				['tag' => 'kind', 'value' => $it['kind']]
			], $it['tags'])
		];
		if ($it['units'] !== '') {
			$out['units'] = $it['units'];
		}
		if ($it['kind'] === 'requested') {
			$out['valuemap'] = ['name' => 'ElasticVue Pro not set'];
		}
		return $out;
	}

	private function baseItems(): void {
		$client = 'group="{$GRP.CLIENT}"';
		$this->add('evp.es.storage.purchased', 'ES storage purchased by the customer', 'B', '{$ES.VOLUME.CUS.PURCHASED}*'.self::GB,
			'Static: {$ES.VOLUME.CUS.PURCHASED} GB.', 'requested');
		$this->add('evp.es.storage.allocated', 'ES storage allocated', 'B', 'max(last_foreach(/*/es.nodes.fs.total_in_bytes?['.$client.']))',
			'All file stores of the cluster, from its cluster host.', 'allocated');
		$this->add('evp.es.storage.used', 'ES storage used', 'B', 'max(last_foreach(/*/es.nodes.fs.used_in_bytes?['.$client.']))',
			'From the cluster host.', 'used');
		$this->add('evp.es.storage.usage', 'ES storage usage', '%', '100*last(//evp.es.storage.used)/last(//evp.es.storage.allocated)',
			'Used as a share of allocated.', 'usage');

		foreach ([['late', 'devices late', ''], ['devices', 'devices measured', ''], ['critical', 'devices critical', ''],
				['median', 'median delay', 's'], ['worst', 'worst delay', 's']] as [$k, $n, $u]) {
			$this->add('evp.delay.'.$k, 'Log delay: '.$n, $u, 'max(last_foreach(/*/espro.delay['.$k.']?['.$client.'],1h))',
				'From ElasticVue Pro, measured every 15 minutes. Empty without a measurement from the last hour.', 'delay');
		}
		foreach ([['avg', 'late', '1h', 'devices late, hourly average'], ['max', 'late', '1h', 'devices late, hourly peak'],
				['avg', 'late', '1d', 'devices late, daily average'], ['max', 'late', '1d', 'devices late, daily peak'],
				['avg', 'median', '1h', 'median delay, hourly average'], ['avg', 'median', '1d', 'median delay, daily average']] as [$fn, $k, $span, $label]) {
			$this->add('evp.delay.'.$k.'.'.$fn.'['.$span.']', 'Log delay: '.$label, $k === 'median' ? 's' : '', $fn.'(//evp.delay.'.$k.','.$span.')',
				($fn === 'avg' ? 'Average' : 'Highest').' over the last '.$span.'.', 'delay', [], '5m');
		}
		foreach ([['late', '1h', 'devices late, change on the previous hour'], ['late', '1d', 'devices late, change on the previous day'],
				['median', '1d', 'median delay, change on the previous day']] as [$k, $span, $label]) {
			$this->add('evp.delay.'.$k.'.change['.$span.']', 'Log delay: '.$label, $k === 'median' ? 's' : '',
				'avg(//evp.delay.'.$k.','.$span.')-avg(//evp.delay.'.$k.','.$span.':now-'.$span.')', 'This '.$span.' against the '.$span.' before it.', 'delay', [], '5m');
		}
	}

	private function roleItems(array $f, array $r): void {
		$in = 'group="{$GRP.CLIENT}" and group="'.$r['group'].'"';
		$fs = Roles::macro($r['id'], 'ROOTDISK.FS');
		$tags = [['tag' => 'family', 'value' => $f['id']], ['tag' => 'role', 'value' => $r['id']]];
		$k = fn($res, $kind) => self::roleKey($res, $kind, $r['id']);
		$L = $r['label'];

		$this->add($k('servers', 'requested'), "$L servers requested", '', Roles::macro($r['id'], 'SERVER.COUNT.REQUESTED'), 'Static, from the Clients page. 0 = not set.', 'requested', $tags);
		$this->add($k('servers', 'allocated'), "$L servers allocated", '', 'count(last_foreach(/*/system.cpu.num?['.$in.']))', "Machines in the $L group of this client.", 'allocated', $tags);
		$this->add($k('cpu', 'requested'), "$L CPU requested", '', Roles::macro($r['id'], 'CPU.REQUESTED'), 'Static, cores. 0 = not set.', 'requested', $tags);
		$this->add($k('cpu', 'allocated'), "$L CPU allocated", '', 'sum(last_foreach(/*/system.cpu.num?['.$in.']))', 'Cores across its machines.', 'allocated', $tags);
		$this->add($k('cpu', 'usage'), "$L CPU usage", '%', 'avg(last_foreach(/*/system.cpu.util?['.$in.']))', 'Average across its machines.', 'usage', $tags);
		$this->add($k('mem', 'requested'), "$L memory requested", 'B', Roles::macro($r['id'], 'MEMORY.REQUESTED').'*'.self::GB, 'Static, GB. 0 = not set.', 'requested', $tags);
		$this->add($k('mem', 'allocated'), "$L memory allocated", 'B', 'sum(last_foreach(/*/vm.memory.size[total]?['.$in.']))', 'Across its machines.', 'allocated', $tags);
		$this->add($k('mem', 'usage'), "$L memory usage", '%', 'avg(last_foreach(/*/vm.memory.utilization?['.$in.']))', 'Average across its machines.', 'usage', $tags);
		// The mount is a macro; Zabbix substitutes none inside an aggregate's key, so the key is a
		// wildcard and the Linux template's `filesystem` tag picks the mount.
		$this->add($k('disk', 'requested'), "$L disk requested", 'B', Roles::macro($r['id'], 'ROOTDISK.REQUESTED').'*'.self::GB, 'Static, GB. 0 = not set.', 'requested', $tags);
		$this->add($k('disk', 'allocated'), "$L disk allocated", 'B', 'sum(last_foreach(/*/vfs.fs.dependent.size[*,total]?['.$in.' and tag="filesystem:'.$fs.'"]))', 'The role\'s mount, across its machines.', 'allocated', $tags);
		$this->add($k('disk', 'used'), "$L disk used", 'B', 'sum(last_foreach(/*/vfs.fs.dependent.size[*,used]?['.$in.' and tag="filesystem:'.$fs.'"]))', 'The role\'s mount, across its machines.', 'used', $tags);
		$this->add($k('disk', 'usage'), "$L disk usage", '%', '100*last(//'.$k('disk', 'used').')/last(//'.$k('disk', 'allocated').')', 'Used as a share of allocated.', 'usage', $tags);
	}

	private function familyItems(array $f): void {
		$client = 'group="{$GRP.CLIENT}"';
		$in = $client.' and group="'.$f['group'].'"';
		$sum = fn($res, $kind) => 'sum(last_foreach(/*/evp.role.'.$res.'.'.$kind.'[*]?['.$client.' and tag="family:'.$f['id'].'"]))';
		$k = fn($res, $kind) => self::familyKey($f['id'], $res, $kind);
		$L = $f['label'];
		$by = 'Summed over its roles.';

		$this->add($k('servers', 'requested'), "$L servers requested", '', $sum('servers', 'requested'), $by, 'requested');
		$this->add($k('servers', 'allocated'), "$L servers allocated", '', 'count(last_foreach(/*/system.cpu.num?['.$in.']))', "Machines in the {$f['group']} group of this client.", 'allocated');
		$this->add($k('cpu', 'requested'), "$L CPU requested", '', $sum('cpu', 'requested'), $by, 'requested');
		$this->add($k('cpu', 'allocated'), "$L CPU allocated", '', 'sum(last_foreach(/*/system.cpu.num?['.$in.']))', 'Cores across its machines.', 'allocated');
		$this->add($k('cpu', 'usage'), "$L CPU usage", '%', 'avg(last_foreach(/*/system.cpu.util?['.$in.']))', 'Average across its machines.', 'usage');
		$this->add($k('mem', 'requested'), "$L memory requested", 'B', $sum('mem', 'requested'), $by, 'requested');
		$this->add($k('mem', 'allocated'), "$L memory allocated", 'B', 'sum(last_foreach(/*/vm.memory.size[total]?['.$in.']))', 'Across its machines.', 'allocated');
		$this->add($k('mem', 'usage'), "$L memory usage", '%', 'avg(last_foreach(/*/vm.memory.utilization?['.$in.']))', 'Average across its machines.', 'usage');
		// Each role measures its own mount, so the family's disk is the sum of its roles'.
		$this->add($k('disk', 'requested'), "$L disk requested", 'B', $sum('disk', 'requested'), $by, 'requested');
		$this->add($k('disk', 'allocated'), "$L disk allocated", 'B', $sum('disk', 'allocated'), $by, 'allocated');
		$this->add($k('disk', 'used'), "$L disk used", 'B', $sum('disk', 'used'), $by, 'used');
		$this->add($k('disk', 'usage'), "$L disk usage", '%', '100*last(//'.$k('disk', 'used').')/last(//'.$k('disk', 'allocated').')', 'Used as a share of allocated.', 'usage');
	}

	/* ------------------------------------ alerts ------------------------------------ */

	private function triggers(): array {
		$T = self::NAME;
		$out = [];
		$short = function(string $id, string $what, string $req, string $alloc, string $word = 'requested') use ($T): array {
			return [
				'uuid' => self::uuid('trigger/shortfall/'.$id),
				'expression' => "last(/$T/$req)>0 and last(/$T/$alloc)<last(/$T/$req)",
				'name' => '{$GRP.CLIENT}: '.$what.' allocated below '.$word,
				'event_name' => '{$GRP.CLIENT}: '.$what.' allocated {ITEM.LASTVALUE2} is below '.$word.' {ITEM.LASTVALUE1}',
				'priority' => 'AVERAGE',
				'description' => 'What the client was given is less than what was '.$word.'. Raised only when a '.$word.' figure is set.',
				'tags' => [['tag' => 'scope', 'value' => 'capacity']]
			];
		};
		foreach (Roles::allRoles($this->roles) as $r) {
			foreach (Roles::RESOURCES as $res) {
				$out[] = $short($r['id'].'.'.$res, $r['label'].' '.self::RES_LABEL[$res],
					self::roleKey($res, 'requested', $r['id']), self::roleKey($res, 'allocated', $r['id']));
			}
		}
		$out[] = $short('es.storage', 'ES storage', 'evp.es.storage.purchased', 'evp.es.storage.allocated', 'purchased');
		return $out;
	}

	private function graphs(): array {
		$colors = ['F63100', '2774A4', '1A7C11', 'A54F10', '7E57C2', '00897B', 'C2185B', '5D4037'];
		$fam = $this->roles['families'];
		$defs = [
			['Log delay: devices late', ['evp.delay.late', 'evp.delay.late.avg[1h]', 'evp.delay.late.avg[1d]']],
			['Log delay: median delay', ['evp.delay.median', 'evp.delay.median.avg[1h]', 'evp.delay.median.avg[1d]']],
			['CPU usage by family', array_map(fn($f) => self::familyKey($f['id'], 'cpu', 'usage'), $fam)],
			['Memory usage by family', array_map(fn($f) => self::familyKey($f['id'], 'mem', 'usage'), $fam)],
			['Storage usage', array_merge(['evp.es.storage.usage'], array_map(fn($f) => self::familyKey($f['id'], 'disk', 'usage'), $fam))]
		];
		$out = [];
		foreach ($defs as [$name, $keys]) {
			$items = [];
			foreach ($keys as $i => $key) {
				$items[] = ['sortorder' => (string) $i, 'color' => $colors[$i % count($colors)], 'item' => ['host' => self::NAME, 'key' => $key]];
			}
			$out[] = ['uuid' => self::uuid('graph/'.$name), 'name' => $name, 'graph_items' => $items];
		}
		return $out;
	}

	/* ------------------------------------ dashboard ------------------------------------ */

	private function tile(string $key, int $x, int $y, int $w, string $label, bool $usage = false, int $decimals = 0): array {
		$fields = [
			['type' => 'ITEM', 'name' => 'itemid.0', 'value' => ['host' => self::NAME, 'key' => $key]],
			['type' => 'INTEGER', 'name' => 'decimal_places', 'value' => (string) $decimals],
			['type' => 'INTEGER', 'name' => 'show.0', 'value' => '1'],
			['type' => 'INTEGER', 'name' => 'show.1', 'value' => '2'],
			['type' => 'STRING', 'name' => 'description', 'value' => $label],
			['type' => 'INTEGER', 'name' => 'desc_v_pos', 'value' => '0'],
			['type' => 'INTEGER', 'name' => 'desc_size', 'value' => '9'],
			['type' => 'INTEGER', 'name' => 'value_size', 'value' => '24']
		];
		if ($usage) {
			// Yellow at 80 %, red at 90 % — the reports' {$EVP.USAGE.*} defaults.
			foreach ([['FFD54F', '80'], ['E53935', '90']] as $i => [$color, $at]) {
				$fields[] = ['type' => 'STRING', 'name' => "thresholds.$i.color", 'value' => $color];
				$fields[] = ['type' => 'STRING', 'name' => "thresholds.$i.threshold", 'value' => $at];
			}
		}
		return ['type' => 'item', 'name' => $label, 'x' => (string) $x, 'y' => (string) $y, 'width' => (string) $w, 'height' => '3',
			'hide_header' => 'YES', 'fields' => $fields];
	}

	private function graphWidget(string $graph, int $x, int $y, int $w): array {
		return ['type' => 'graph', 'name' => $graph, 'x' => (string) $x, 'y' => (string) $y, 'width' => (string) $w, 'height' => '5',
			'fields' => [['type' => 'GRAPH', 'name' => 'graphid.0', 'value' => ['host' => self::NAME, 'name' => $graph]]]];
	}

	private function dashboard(): array {
		$cap = [];
		$cells = [['servers', 'allocated', 'servers'], ['cpu', 'requested', 'CPU req.'], ['cpu', 'allocated', 'CPU alloc.'], ['cpu', 'usage', 'CPU usage'],
			['mem', 'requested', 'mem req.'], ['mem', 'allocated', 'mem alloc.'], ['mem', 'usage', 'mem usage'], ['disk', 'usage', 'disk usage']];
		$y = 0;
		foreach ($this->roles['families'] as $f) {
			foreach ($cells as $i => [$res, $kind, $label]) {
				$cap[] = $this->tile(self::familyKey($f['id'], $res, $kind), $i * 9, $y, 9, $f['label'].' '.$label, $kind === 'usage', $kind === 'usage' ? 1 : 0);
			}
			$y += 3;
		}
		$cap[] = $this->graphWidget('CPU usage by family', 0, $y, 36);
		$cap[] = $this->graphWidget('Memory usage by family', 36, $y, 36);

		$storage = [];
		foreach ([['evp.es.storage.purchased', 'ES purchased'], ['evp.es.storage.allocated', 'ES alloc.'], ['evp.es.storage.used', 'ES used'],
				['evp.es.storage.usage', 'ES usage']] as $i => [$key, $label]) {
			$storage[] = $this->tile($key, $i * 9, 0, 9, $label, $key === 'evp.es.storage.usage', $key === 'evp.es.storage.usage' ? 1 : 0);
		}
		foreach (array_values($this->roles['families']) as $i => $f) {
			if ($i < 4) {
				$storage[] = $this->tile(self::familyKey($f['id'], 'disk', 'usage'), (4 + $i) * 9, 0, 9, $f['label'].' disk usage', true, 1);
			}
		}
		$storage[] = $this->graphWidget('Storage usage', 0, 3, 72);

		$delay = [];
		foreach ([['evp.delay.late', 'Late devices'], ['evp.delay.late.avg[1h]', 'Late, 1h avg'], ['evp.delay.late.avg[1d]', 'Late, 1d avg'],
				['evp.delay.late.change[1h]', 'Late vs prev. hour'], ['evp.delay.late.change[1d]', 'Late vs prev. day'], ['evp.delay.median', 'Median delay'],
				['evp.delay.median.change[1d]', 'Median vs prev. day'], ['evp.delay.worst', 'Worst delay']] as $i => [$key, $label]) {
			$delay[] = $this->tile($key, $i * 9, 0, 9, $label);
		}
		$delay[] = $this->graphWidget('Log delay: devices late', 0, 3, 36);
		$delay[] = $this->graphWidget('Log delay: median delay', 36, 3, 36);

		return ['uuid' => self::uuid('dashboard'), 'name' => 'Client capacity and log delay', 'pages' => [
			['name' => 'Capacity', 'widgets' => $cap],
			['name' => 'Storage', 'widgets' => $storage],
			['name' => 'Log delay', 'widgets' => $delay]
		]];
	}
}
