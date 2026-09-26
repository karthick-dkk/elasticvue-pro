<?php
/**
 * The Client resources controller against a fake Zabbix API: columns from the roles, the Columns
 * settings (rename, hide, split a family into roles), colours, "not set", unknown as "—", the
 * servers each client expands into, and the export.
 *   docker run --rm -v "$PWD":/m -w /m php:8.4-cli-alpine php test/view.test.php
 */
namespace {
	define('ITEM_STATE_NORMAL', 0); define('USER_TYPE_SUPER_ADMIN', 3); define('INTERFACE_TYPE_AGENT', 1); define('INTERFACE_PRIMARY', 1);
	set_error_handler(function ($no, $msg, $file, $line) { throw new \ErrorException($msg, 0, $no, $file, $line); });
	function _($s) { return $s; }
	function _s($s, ...$a) { foreach ($a as $i => $v) { $s = str_replace('%'.($i + 1).'$s', (string) $v, $s); } return $s; }
	function getSubGroups($ids) { return $ids; }
	function convertUnits(array $o) { return round($o['value'], $o['decimals'] ?? 2).($o['units'] !== '' ? ' '.$o['units'] : ''); }

	class CControllerDashboardWidgetView {
		public $fields_values = ['groupids' => []];
		public $widget;
		public $response;
		public function __construct() { $this->widget = new class { public function getDefaultName() { return 'Client resources'; } }; }
		public function getInput($k, $d = null) { return $d; }
		public function getDebugMode() { return 0; }
		public function getUserType() { return USER_TYPE_SUPER_ADMIN; }
		public function setResponse($r) { $this->response = $r; }
	}
	class CControllerResponseData { public $data; public function __construct($d) { $this->data = $d; } }
	class CCsrfTokenHelper { public static function get($a) { return 'token:'.$a; } }

	/** The fake Zabbix: two client master hosts, karthi (DI) with two machines and acme (On-Prem) with none measured. */
	class FakeApi {
		public static $template = true;
		private $what;
		public function __construct($what) { $this->what = $what; }
		public function get(array $o) {
			switch ($this->what) {
				case 'Template':
					return self::$template ? [['templateid' => 9]] : [];
				case 'Host':
					if (isset($o['templateids'])) {
						return [101 => ['hostid' => 101, 'name' => 'karthi-Master'], 102 => ['hostid' => 102, 'name' => 'acme-Master']];
					}
					$if = fn($ip, $a) => [['ip' => $ip, 'type' => 1, 'main' => 1, 'available' => $a]];
					$g = fn(...$n) => array_map(fn($x) => ['name' => $x], $n);
					return [
						201 => ['hostid' => 201, 'name' => 'karthi-ES-Data-Hot-1', 'hostgroups' => $g('karthi', 'ESNodes', 'ES Data Hot'), 'interfaces' => $if('10.0.0.1', 1)],
						202 => ['hostid' => 202, 'name' => 'karthi-Parser-1', 'hostgroups' => $g('karthi', 'Parsers', 'Parser'), 'interfaces' => $if('10.0.0.2', 2)],
						203 => ['hostid' => 203, 'name' => 'karthi-ULM', 'hostgroups' => $g('karthi', 'Log archive'), 'interfaces' => []],
						204 => ['hostid' => 204, 'name' => 'karthi-Forwarder-1', 'hostgroups' => $g('karthi', 'Forwarders'), 'interfaces' => $if('10.0.0.4', 0)]
					];
				case 'HostGroup':
					return array_values(array_filter([['groupid' => 1, 'name' => 'karthi'], ['groupid' => 2, 'name' => 'acme']],
						fn($g) => in_array($g['name'], $o['filter']['name'], true)));
				case 'UserMacro':
					return [
						['hostid' => 101, 'macro' => '{$GRP.CLIENT}', 'value' => 'karthi'],
						['hostid' => 101, 'macro' => '{$EVP.CLIENT.TYPE}', 'value' => 'DI'],
						['hostid' => 101, 'macro' => '{$ES.URL}', 'value' => 'https://es.karthi:9200'],
						['hostid' => 101, 'macro' => '{$EVP.ES_DATA_HOT.ROOTDISK.FS}', 'value' => '/data'],
						['hostid' => 102, 'macro' => '{$GRP.CLIENT}', 'value' => 'acme']
					];
				case 'Item':
					$all = [
						[101, 'evp.es.cpu.requested', 16, ''], [101, 'evp.es.cpu.allocated', 8, ''], [101, 'evp.es.cpu.usage', 95, '%'],
						[101, 'evp.parser.cpu.requested', 0, ''], [101, 'evp.role.cpu.requested[es_data_hot]', 8, ''],
						[101, 'evp.es.storage.used', 2 * 1073741824, 'B'],
						[201, 'system.cpu.num', 4, ''], [201, 'system.cpu.util', 85, '%'], [201, 'vfs.fs.dependent.size[/data,pused]', 50, '%'],
						[201, 'vfs.fs.dependent.size[/,pused]', 99, '%'], [202, 'vfs.fs.dependent.size[/,pused]', 91, '%'],
						[202, 'vm.memory.size[total]', 8 * 1073741824, 'B']
					];
					$out = [];
					foreach ($all as [$h, $k, $v, $u]) {
						if (in_array($h, $o['hostids']) && in_array($k, $o['filter']['key_'], true)) {
							$out[] = ['hostid' => $h, 'key_' => $k, 'lastvalue' => (string) $v, 'lastclock' => 1, 'units' => $u, 'state' => 0];
						}
					}
					return $out;
			}
		}
	}
	class API {
		public static function __callStatic($name, $args) { return new FakeApi($name); }
	}
}
namespace Modules\EvpResources\Test {
	require __DIR__.'/../actions/WidgetView.php';
	use Modules\EvpResources\Actions\WidgetView;
	use Modules\EvpResources\Lib\{ColumnSettings, Roles};

	$failed = 0; $passed = 0;
	function check(string $what, bool $ok, $detail = null): void {
		global $failed, $passed;
		if ($ok) { $passed++; return; }
		$failed++; echo "FAIL: $what", $detail !== null ? ' — '.json_encode($detail, JSON_UNESCAPED_SLASHES) : '', PHP_EOL;
	}
	$dir = sys_get_temp_dir().'/evp-res-test-'.getmypid();
	mkdir($dir);
	putenv('EVP_DATA_DIR='.$dir);

	function run(): array {
		$v = new WidgetView();
		$m = new \ReflectionMethod($v, 'doAction');
		$m->invoke($v);
		return $v->response->data;
	}
	function col(array $d, string $id): ?int {
		foreach ($d['columns'] as $i => $c) { if ($c['id'] === $id) return $i; }
		return null;
	}

	$d = run();
	check('no error', $d['error'] === null, $d['error']);
	check('clients sorted by name, acme first', array_column($d['rows'], 'client') === ['acme', 'karthi']);
	check('types from the master hosts; unset is On-Prem', array_column($d['rows'], 'type') === ['On-Prem', 'DI']);
	check('a family column per resource and kind', col($d, 'f.es.cpu.requested') !== null && col($d, 'f.engine.servers.allocated') !== null);
	check('roles are not their own columns until split', col($d, 'r.es_data_hot.cpu.requested') === null);
	check('Engine is a family of its own', in_array('Engine CPU (cores)', array_column($d['columns'], 'group'), true));
	[$acme, $karthi] = $d['rows'];
	$cell = fn($row, $id) => $row['cells'][col($d, $id)];
	check('allocated below requested is marked', strpos($cell($karthi, 'f.es.cpu.allocated')['class'], 'evp-short') !== false, $cell($karthi, 'f.es.cpu.allocated'));
	check('usage 95 % is red', $cell($karthi, 'f.es.cpu.usage')['class'] === 'evp-high');
	check('a request of 0 is "not set"', $cell($karthi, 'f.parser.cpu.requested')['text'] === 'not set');
	check('unknown is "—", not 0', $cell($acme, 'f.es.cpu.usage')['text'] === '—');
	$e = $d['export'];
	check('export: unknown is an empty cell', $e['rows'][0][col($d, 'f.es.cpu.usage')] === null);
	check('export: bytes as GB, header says so', $e['rows'][1][col($d, 'storage.used')] === 2.0 && $e['headers'][col($d, 'storage.used')] === 'ES storage Used (GB)', $e['headers'][col($d, 'storage.used')]);
	check('export: types beside the rows', $e['types'] === ['On-Prem', 'DI']);

	$srv = $karthi['servers'];
	check('karthi expands into its three machines with a role (ULM has none)', array_column($srv, 'host') === ['karthi-ES-Data-Hot-1', 'karthi-Forwarder-1', 'karthi-Parser-1'], array_column($srv, 'host'));
	check('the ES data node is measured on its role\'s disk mount', $srv[0]['mount'] === '/data' && $srv[0]['disk_used'] === 50.0);
	check('other roles default to /', $srv[2]['mount'] === '/' && $srv[2]['disk_used'] === 91.0);
	check('status from the agent interface', array_column($srv, 'status') === ['up', 'unknown', 'down']);
	check('server colours: 85 % CPU yellow, 91 % disk red', $srv[0]['classes']['cpu'] === 'evp-warn' && $srv[2]['classes']['disk'] === 'evp-high');
	check('unmeasured server figures stay unknown', $srv[1]['cpu_used'] === null && $srv[1]['mem_total'] === null);
	check('acme has no servers', $acme['servers'] === []);
	check('servers export in the table\'s client order', array_column($e['servers']['rows'], 3) === ['karthi-ES-Data-Hot-1', 'karthi-Forwarder-1', 'karthi-Parser-1']);
	check('servers export: one row per machine, GB', count($e['servers']['rows']) === 3 && $e['servers']['rows'][2][8] === 8.0 && $e['servers']['types'] === ['DI', 'DI', 'DI']);
	check('the dialog gets a token for its own action', $d['meta']['token'] === 'token:widget.evp_resources.columns' && $d['meta']['canEdit'] === true);

	// The Columns dialog: split ES into its roles, hide the URL, rename a column, move Type first.
	// The dialog always sends the whole order, as the columns stand in it.
	$order = array_column($d['meta']['columns'], 'id');
	[$order[0], $order[1]] = [$order[1], $order[0]];
	ColumnSettings::save('resources', ['labels' => ['client.name' => 'Client'], 'hidden' => ['client.url'], 'order' => $order, 'split' => ['es']], null);
	$d = run();
	check('split: ES roles are sections', col($d, 'r.es_data_hot.cpu.requested') !== null && col($d, 'f.es.cpu.requested') === null);
	check('split: the role figure is the role\'s item', $d['rows'][1]['cells'][col($d, 'r.es_data_hot.cpu.requested')]['text'] === '8');
	check('split: Parser stays one family', col($d, 'f.parser.cpu.requested') !== null);
	check('hidden: not in the table nor the export', col($d, 'client.url') === null && !in_array('ES URL', $d['export']['headers'], true));
	check('hidden: still offered in the dialog', in_array('client.url', array_column($d['meta']['columns'], 'id'), true));
	check('renamed and reordered', $d['columns'][0]['id'] === 'client.type' && $d['columns'][1]['label'] === 'Client' && $d['export']['headers'][1] === 'Client', array_slice(array_column($d['columns'], 'id'), 0, 4));
	check('the dialog knows ES is split', array_column($d['meta']['families'], 'split', 'id')['es'] === true);

	// A family added on the Roles page is in the report, with no change here.
	$roles = Roles::load();
	$roles['families'][] = ['id' => 'soar', 'label' => 'SOAR', 'group' => 'SOAR', 'sisa' => 'SOAR', 'roles' => [['id' => 'soar_node', 'label' => 'SOAR', 'short' => 'SOAR', 'group' => 'SOAR nodes']]];
	check('the new family is valid', Roles::validate($roles) === [], Roles::validate($roles));
	Roles::save($roles);
	$d = run();
	check('a new family appears as its own columns', col($d, 'f.soar.cpu.requested') !== null && in_array('SOAR memory', array_column($d['columns'], 'group'), true));

	\FakeApi::$template = false;
	$d = run();
	check('no template: says where to write it', strpos((string) $d['error'], 'ElasticVue Pro → Clients') !== false);

	foreach (array_diff(scandir($dir), ['.', '..']) as $f) {
		unlink($dir.'/'.$f);
	}
	rmdir($dir);
	echo "$passed passed, $failed failed", PHP_EOL;
	exit($failed ? 1 : 0);
}
