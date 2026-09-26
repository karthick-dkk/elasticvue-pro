<?php
/**
 * The Clients module's pure parts: roles, the client form's rules and macros, CSV, report column
 * settings, and the master template it writes.
 *   docker run --rm -v "$PWD":/m -w /m php:8.4-cli-alpine php test/spec.test.php
 * Exit 0 when every check holds; each failure is printed. A PHP warning is a failure.
 */
namespace {
	define('ZBX_MACRO_TYPE_TEXT', 0); define('ZBX_MACRO_TYPE_SECRET', 1); define('ZBX_MACRO_TYPE_VAULT', 2);
	set_error_handler(function ($no, $msg, $file, $line) { throw new \ErrorException($msg, 0, $no, $file, $line); });
	function _($s) { return $s; }
	function _s($s, ...$a) { foreach ($a as $i => $v) { $s = str_replace('%'.($i + 1).'$s', (string) $v, $s); } return $s; }
	function _n($a, $b, $n) { return str_replace('%1$s', (string) $n, $n == 1 ? $a : $b); }
}
namespace Modules\EvpClients\Test {
	foreach (['Store', 'Roles', 'ColumnSettings', 'MasterTemplate', 'ClientSpec', 'Csv'] as $lib) {
		require __DIR__.'/../lib/'.$lib.'.php';
	}
	use Modules\EvpClients\Lib\{ClientSpec, ColumnSettings, Csv, MasterTemplate, Roles, Store};

	$failed = 0; $passed = 0;
	function check(string $what, bool $ok, $detail = null): void {
		global $failed, $passed;
		if ($ok) { $passed++; return; }
		$failed++; echo "FAIL: $what", $detail !== null ? ' — '.json_encode($detail, JSON_UNESCAPED_SLASHES) : '', PHP_EOL;
	}
	$dir = sys_get_temp_dir().'/evp-test-'.getmypid();
	mkdir($dir);
	putenv('EVP_DATA_DIR='.$dir);

	/* ---------------- data folder ---------------- */
	putenv('EVP_DATA_DIR='.$dir.'/fresh');
	check('a missing data folder is made on first use', Store::writable() && is_dir($dir.'/fresh'));
	rmdir($dir.'/fresh');
	putenv('EVP_DATA_DIR='.$dir);

	/* ---------------- backups ---------------- */
	require_once __DIR__.'/../lib/Backups.php';
	check('a form is the same whatever its order, blanks and "_" keys', \Modules\EvpClients\Lib\Backups::sameForm(
		['name' => 'k', 'purchased' => '10', 'ips_parser' => '', '_now' => 'x'], ['purchased' => '10 ', 'name' => 'k']));
	check('a changed field is a different form', !\Modules\EvpClients\Lib\Backups::sameForm(['name' => 'k', 'purchased' => '10'], ['name' => 'k', 'purchased' => '20']));

	/* ---------------- roles ---------------- */
	$roles = Roles::defaults();
	check('the default roles are valid', Roles::validate($roles) === [], Roles::validate($roles));
	check('families: ES, Parser, Forwarder, Engine', array_column($roles['families'], 'label') === ['ES', 'Parser', 'Forwarder', 'Engine']);
	check('ES roles: data hot, warm, coordination, master', array_column($roles['families'][0]['roles'], 'short') === ['ES-Data-Hot', 'ES-Data-Warm', 'ES-Coord', 'ES-Master']);
	check('Engine roles: UEBA, AIML', array_column($roles['families'][3]['roles'], 'short') === ['UEBA', 'AIML']);
	$bad = $roles; $bad['families'][0]['roles'][] = ['id' => 'aiml', 'label' => 'X', 'short' => 'X', 'group' => 'X'];
	check('an id used twice is refused', (bool) preg_grep('/used twice/', Roles::validate($bad)));
	$bad = $roles; $bad['families'][1]['roles'][0]['short'] = 'ES-Master';
	check('two roles with the same host-name part are refused', (bool) preg_grep('/called "ES-Master"/', Roles::validate($bad)));
	$bad = $roles; $bad['families'][0]['id'] = 'delay';
	check('a reserved id is refused', (bool) preg_grep('/reserved/', Roles::validate($bad)));
	Roles::save($roles);
	check('roles are kept in the data folder', Roles::load() === $roles && is_file($dir.'/roles.json'));
	check('every configured group is known', in_array('ES Data Hot', Roles::groups($roles), true) && in_array('ESNodes', Roles::groups($roles), true));

	/* ---------------- the form ---------------- */
	$spec = new ClientSpec($roles);
	$form = fn(array $over = []) => array_merge($spec->defaults(), ['name' => 'karthi', 'type' => 'DI', 'es_url' => 'https://es.karthi.local:9243',
		'ips_es_data_hot' => "10.0.0.21\n10.0.0.22", 'ips_es_master' => '10.0.0.11;10.0.0.12', 'ips_parser' => '10.0.1.5',
		'es_data_hot_cpu' => '32', 'es_master_cpu' => '12', 'es_data_hot_mem' => '128', 'es_master_mem' => '48',
		'ulm_bucket' => 'karthi-archive', 'ulm_region' => 'ap-south-1', 'ulm_tags' => 'karthi'], $over);
	['client' => $c, 'errors' => $e] = $spec->fromForm($form());
	check('a full DI client has no errors', $e === [], $e);
	check('IPs are read per role, one per line or ;-separated', $c['hosts']['es_data_hot'] === ['10.0.0.21', '10.0.0.22'] && $c['hosts']['es_master'] === ['10.0.0.11', '10.0.0.12']);
	check('a DI client needs its archive', count($spec->fromForm($form(['ulm_bucket' => '', 'ulm_tags' => '', 'ulm_region' => '']))['errors']) === 3);
	check('an On-Prem client does not', $spec->fromForm($form(['type' => 'On-Prem', 'ulm_bucket' => '', 'ulm_tags' => '']))['errors'] === []);
	check('a type that is neither is refused', (bool) preg_grep('/Type must be DI or On-Prem/', $spec->fromForm($form(['type' => 'Cloud']))['errors']));
	check('an IP in two roles is refused', (bool) preg_grep('/listed twice/', $spec->fromForm($form(['ips_parser' => '10.0.0.21']))['errors']));
	check('a hostname is not an IP', (bool) preg_grep('/"parser01" is not an IPv4/', $spec->fromForm($form(['ips_parser' => 'parser01']))['errors']));
	check('a space in the client name is refused (it names hosts)', (bool) preg_grep('/may hold only/', $spec->fromForm($form(['name' => 'kar thi']))['errors']));
	check('a negative request is refused', (bool) preg_grep('/0 or more/', $spec->fromForm($form(['es_master_cpu' => '-1']))['errors']));

	/* ---------------- names ---------------- */
	$hot = Roles::allRoles($roles)[0];
	check('machines are <client>-<Role>-<n>', ClientSpec::machineName('karthi', $hot, 2) === 'karthi-ES-Data-Hot-2');
	check('and the client hosts', ClientSpec::masterName('karthi') === 'karthi-Master' && ClientSpec::clusterName('karthi') === 'karthi-ES-Cluster' && ClientSpec::ulmName('karthi') === 'karthi-ULM');
	check('a name that follows the pattern keeps its number', ClientSpec::slotOf('karthi-ES-Data-Hot-7', 'karthi', $hot) === 7);
	check('one that does not has none', ClientSpec::slotOf('vm-1 es-node', 'karthi', $hot) === null && ClientSpec::slotOf('karthi-ES-Data-Warm-1', 'karthi', $hot) === null);

	/* ---------------- macros ---------------- */
	$m = $spec->masterMacros($c);
	check('the master keeps type and per-role requests', $m['{$EVP.CLIENT.TYPE}'] === ['DI', 0] && $m['{$EVP.ES_DATA_HOT.CPU.REQUESTED}'] === ['32', 0]);
	$cl = $spec->clusterMacros($c, true);
	check('the cluster host gets family totals under the SISA names', $cl['{$ES.CPU.REQUESTED}'] === ['44', 0] && $cl['{$ES.MEMORY.REQUESTED}'] === ['176', 0], [$cl['{$ES.CPU.REQUESTED}'] ?? null]);
	check('memory also under the spelling the SISA items read', $cl['{$ES.MEM.REQUESTED}'] === ['176', 0] && $cl['{$FORWARDER.MEM.REQUESTED}'] === ['0', 0]);
	check('a new cluster host reads its password from Vault', $cl['{$ELASTICSEARCH.PASSWORD}'] === ['secret/elasticvue/karthi:password', ZBX_MACRO_TYPE_VAULT]);
	check('an existing one keeps its own', !isset($spec->clusterMacros($c, false)['{$ELASTICSEARCH.PASSWORD}']));
	$u = $spec->ulmMacros($c, true);
	check('the archive host gets bucket, tags and the template defaults it needs', $u['{$ULM.S3.BUCKET}'] === ['karthi-archive', 0] && $u['{$ULM.ES.TAG.FIELD}'] === ['tag1.keyword', 0]);
	check('a role-based bucket carries no Vault secret', !isset($u['{$ULM.AWS.SECRET.ACCESS.KEY}']));

	/* ---------------- CSV ---------------- */
	$csv = Csv::export($roles, [$spec->defaults() + ['name' => 'x']]);
	$cols = array_keys(Csv::columns($roles));
	check('the template starts with client and type', array_slice($cols, 0, 2) === ['client', 'type']);
	check('every role has its columns', in_array('es_data_hot_ips', $cols, true) && in_array('aiml_memory_gb', $cols, true) && in_array('s3_parser_disk_mount', $cols, true));
	$f = $form(); $f['ips_es_data_hot'] = "10.0.0.21\n10.0.0.22";
	$parsed = Csv::parse(Csv::export($roles, [$f]), $roles);
	check('export then parse is the same client', $parsed['errors'] === [] && Csv::toForm($parsed['rows'][0], $spec->defaults(), $roles)['ips_es_data_hot'] === "10.0.0.21\n10.0.0.22"
		&& Csv::toForm($parsed['rows'][0], $spec->defaults(), $roles)['es_data_hot_cpu'] === '32');
	$semi = "client;type;es_node_x\r\nacme;on-prem;1\r\n";
	$p = Csv::parse($semi, $roles);
	check('a ;-separated file from Excel is read', $p['rows'][0]['client'] === 'acme' && $p['ignored'] === ['es_node_x']);
	check('On-Prem is understood however it is written', Csv::toForm($p['rows'][0], $spec->defaults(), $roles)['type'] === 'On-Prem');
	$base = $form(); $base['es_url'] = 'https://old:9200';
	$row = Csv::parse("client,es_master_cpu_cores\nkarthi,16\n", $roles)['rows'][0];
	$over = Csv::toForm($row, $base, $roles);
	check('a column left out keeps its value', $over['es_url'] === 'https://old:9200' && $over['es_master_cpu'] === '16');
	$row = Csv::parse("client,jump_host\nkarthi,\n", $roles)['rows'][0];
	check('an empty cell clears it', Csv::toForm($row, $base + ['es_jumphost' => 'j1'], $roles)['es_jumphost'] === '');
	check('no client column is an error', (bool) preg_grep('/no "client" column/', Csv::parse("name,type\nx,DI\n", $roles)['errors']));
	check('a formula in a cell is written as text', strpos(Csv::export($roles, [array_merge($spec->defaults(), ['name' => '=cmd'])]), "'=cmd") !== false);

	/* ---------------- column settings ---------------- */
	$colsIn = [['id' => 'a', 'label' => 'A'], ['id' => 'b', 'label' => 'B'], ['id' => 'c', 'label' => 'C'], ['id' => 'new', 'label' => 'N']];
	$s = ColumnSettings::save('test', ['labels' => ['a' => 'Customer', 'zz' => 'x'], 'hidden' => ['b'], 'order' => ['c', 'a']], ['a', 'b', 'c', 'new']);
	check('unknown ids are dropped', !isset($s['labels']['zz']));
	$out = ColumnSettings::apply($colsIn, ColumnSettings::load('test'));
	check('renamed, hidden and reordered — a new column lands after the one it followed', array_column($out, 'label') === ['C', 'N', 'Customer'], array_column($out, 'label'));
	ColumnSettings::reset('test');
	check('reset brings the defaults back', array_column(ColumnSettings::apply($colsIn, ColumnSettings::load('test')), 'label') === ['A', 'B', 'C', 'N']);

	/* ---------------- the master template ---------------- */
	$x = (new MasterTemplate($roles))->export()['zabbix_export'];
	$t = $x['templates'][0];
	$keys = array_column($t['items'], 'key');
	// Zabbix's import wants every repeated tag as a list: a PHP array keyed by anything else
	// becomes a JSON object, which it refuses ("unexpected tag").
	$notList = [];
	$walk = function ($v, $path) use (&$walk, &$notList) {
		if (!is_array($v)) return;
		if (preg_match('/(s|_rules|mappings|fields|pages|widgets|dependencies)$/', (string) basename($path)) && !array_is_list($v)) $notList[] = $path;
		foreach ($v as $k => $w) $walk($w, $path.'/'.$k);
	};
	foreach (['templates', 'triggers', 'graphs'] as $part) $walk($x[$part], $part);
	check('every list in the export is a JSON list', $notList === [], array_slice($notList, 0, 5));
	check('role items for every role', in_array('evp.role.cpu.requested[es_data_hot]', $keys, true) && in_array('evp.role.disk.usage[aiml]', $keys, true));
	check('family items keep the keys the capacity report reads', in_array('evp.es.cpu.requested', $keys, true) && in_array('evp.fwd.disk.used', $keys, true));
	$famReq = array_values(array_filter($t['items'], fn($i) => $i['key'] === 'evp.es.cpu.requested'))[0];
	check('a family figure adds up every role tagged with it', strpos($famReq['params'], 'evp.role.cpu.requested[*]') !== false && strpos($famReq['params'], 'tag="family:es"') !== false);
	check('role items carry their family tag', in_array(['tag' => 'family', 'value' => 'es'], array_values(array_filter($t['items'], fn($i) => $i['key'] === 'evp.role.cpu.requested[es_master]'))[0]['tags'], true));
	check('no aggregate hides a macro in its key', !array_filter($t['items'], fn($i) => preg_match('/last_foreach\(\/\*\/[^?]*\{\$/', $i['params'])));
	check('a shortfall alert per role and resource, plus storage', count($x['triggers']) === count(Roles::allRoles($roles)) * 4 + 1);
	foreach ($x['triggers'] as $tr) {
		preg_match_all('/last\(\/'.preg_quote(MasterTemplate::NAME, '/').'\/([^)]+)\)/', $tr['expression'], $mm);
		foreach ($mm[1] as $k) { check("trigger item exists: $k", in_array($k, $keys, true)); }
	}
	foreach ($x['graphs'] as $g) { foreach ($g['graph_items'] as $gi) { check("graph item exists: {$gi['item']['key']}", in_array($gi['item']['key'], $keys, true)); } }
	foreach ($t['dashboards'][0]['pages'] as $pg) { foreach ($pg['widgets'] as $w) { foreach ($w['fields'] as $fld) {
		if ($fld['type'] === 'ITEM') { check("dashboard item exists: {$fld['value']['key']}", in_array($fld['value']['key'], $keys, true)); }
	} } }
	$macros = array_column($t['macros'], 'macro');
	foreach (array_values((new ClientSpec($roles))->macroFields()) as $mf) { check("the template defines $mf", in_array($mf, $macros, true)); }
	check('log-delay windows keep their keys', in_array('evp.delay.late.avg[1h]', $keys, true) && in_array('evp.delay.median.change[1d]', $keys, true));
	check('the roles fingerprint is on the template', in_array(['macro' => '{$EVP.ROLES.HASH}', 'value' => Roles::hash($roles), 'description' => 'Which roles this template was written for. Set by the Clients page.'], $t['macros'], true));
	check('uuids are v4-shaped and stable', preg_match('/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/', MasterTemplate::uuid('x')) === 1 && MasterTemplate::uuid('x') === MasterTemplate::uuid('x'));
	$more = $roles; $more['families'][3]['roles'][] = ['id' => 'soar', 'label' => 'SOAR', 'short' => 'SOAR', 'group' => 'SOAR'];
	$k2 = array_column((new MasterTemplate($more))->export()['zabbix_export']['templates'][0]['items'], 'key');
	check('a role added appears as its own items, family formulas unchanged', in_array('evp.role.cpu.usage[soar]', $k2, true) && count($k2) === count($keys) + 12);

	array_map('unlink', glob($dir.'/*.json') ?: []); @unlink($dir.'/.lock'); @rmdir($dir);
	echo "$passed passed, $failed failed", PHP_EOL;
	exit($failed ? 1 : 0);
}
