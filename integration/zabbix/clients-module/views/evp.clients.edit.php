<?php declare(strict_types = 0);
/**
 * Add or edit a client.
 *
 * @var CView $this
 * @var array $data  ['form', 'roles', 'mode', 'adopting', 'existing', 'unassigned', 'errors', 'done']
 */

$f = $data['form'];
$editing = $data['mode'] === 'edit';
$list = function(array $items) {
	$l = new CList();
	foreach ($items as $i) {
		$l->addItem($i);
	}
	return $l;
};

$form = (new CForm('post', (new CUrl('zabbix.php'))->setArgument('action', 'evp.clients.save')->getUrl()))
	->addVar(CSRF_TOKEN_NAME, CCsrfTokenHelper::get('evp.clients.save'))
	->addVar('mode', $data['mode'])
	->setId('evp-client-form');

$top = [];
if ($data['errors']) {
	$top[] = (new CDiv([new CTag('b', true, _('Nothing was saved. Please correct:')), $list($data['errors'])]))->addClass('msg-bad')->addClass('evp-box');
}
if ($data['done']) {
	$top[] = (new CDiv([new CTag('b', true, _('Already done before Zabbix refused:')), $list($data['done'])]))->addClass('msg-warning')->addClass('evp-box');
}
if ($data['adopting']) {
	$top[] = (new CDiv(_('This client has hosts already. They are kept — history, passwords — renamed to the client\'s pattern, and only what is missing is added. The fields are filled from them.')))
		->addClass('msg-good')->addClass('evp-box');
}
if ($data['unassigned']) {
	$names = array_map(fn($u) => $u['name'].($u['ip'] ? ' ('.$u['ip'].')' : ''), $data['unassigned']);
	$top[] = (new CDiv([new CTag('b', true, _('Machines without a role:')), ' ', implode(', ', $names), '. ',
		_('Put each IP under its role below to take it on; left out, it stays as it is.')]))->addClass('msg-warning')->addClass('evp-box');
}

$text = fn(string $name, string $placeholder = '', bool $readonly = false) =>
	(new CTextBox($name, (string) ($f[$name] ?? ''), $readonly))->setId($name)->setAttribute('placeholder', $placeholder)->setWidth(ZBX_TEXTAREA_STANDARD_WIDTH);
$hint = fn(string $s) => (new CDiv($s))->addClass('evp-hint');
$section = fn(string $s) => [(new CTag('h4', true, $s))->addClass('evp-section'), new CFormField('')];

$type = (new CRadioButtonList('type', $f['type'] !== '' ? $f['type'] : 'On-Prem'))
	->addValue('DI', 'DI')->addValue('On-Prem', 'On-Prem')->setModern(true)->setId('type');

$grid = (new CFormGrid())
	->addItem($section(_('Client')))
	->addItem([(new CLabel(_('Client name'), 'name'))->setAsteriskMark(), new CFormField([$text('name', 'karthi', $editing),
		$hint(_('Names its host group and hosts: karthi-Master, karthi-ES-Cluster, karthi-ES-Data-Hot-1 …'))])])
	->addItem([(new CLabel(_('Type'), 'type'))->setAsteriskMark(), new CFormField([$type,
		$hint(_('DI: the log archive (S3 bucket, region, tag1 values) is required. On-Prem: optional.'))])])

	->addItem($section(_('Elasticsearch')))
	->addItem([new CLabel(_('ES URL'), 'es_url'), new CFormField([$text('es_url', 'https://es.karthi.local:9200'),
		$hint(_('Creates the cluster host. Leave empty for a client with only Linux machines (On-Prem).'))])])
	->addItem([new CLabel(_('ES user'), 'es_user'), new CFormField($text('es_user', 'elastic'))])
	->addItem([new CLabel(_('Password (Vault path:key)'), 'es_password_path'), new CFormField([$text('es_password_path', 'secret/elasticvue/karthi:password'),
		$hint(_('Empty: a new cluster host reads secret/elasticvue/<client>:password; an existing one keeps its password.'))])])
	->addItem([new CLabel(_('Jump host'), 'es_jumphost'), new CFormField($text('es_jumphost', _('only when reached through one')))])

	->addItem($section(_('Log archive (S3)')))
	->addItem([(new CLabel(_('tag1 values'), 'ulm_tags'))->addClass('evp-di-req'), new CFormField([$text('ulm_tags', 'karthi, karthi-dr'),
		$hint(_('This client\'s tag1 values in Elasticsearch — the archive check compares only these.'))])])
	->addItem([(new CLabel(_('S3 bucket'), 'ulm_bucket'))->addClass('evp-di-req'), new CFormField([$text('ulm_bucket', 'karthi-archive'),
		$hint(_('Creates the log archive host. Empty: none (On-Prem only).'))])])
	->addItem([(new CLabel(_('Region'), 'ulm_region'))->addClass('evp-di-req'), new CFormField($text('ulm_region', 'ap-south-1'))])
	->addItem([new CLabel(_('Access'), 'ulm_auth'), new CFormField(
		(new CSelect('ulm_auth'))->setId('ulm_auth')->setValue($f['ulm_auth'] !== '' ? $f['ulm_auth'] : 'role_base')->addOptions(CSelect::createOptionsFromArray([
			'role_base' => _('IAM role of the Zabbix server'), 'access_key' => _('Access key (secret from Vault)')
		])))])
	->addItem([new CLabel(_('Role ARN'), 'ulm_role_arn'), new CFormField([$text('ulm_role_arn', 'arn:aws:iam::111122223333:role/karthi-archive'),
		$hint(_('Optional, per bucket: assumed from the access above.'))])])
	->addItem([new CLabel(_('External ID'), 'ulm_external_id'), new CFormField($text('ulm_external_id'))])
	->addItem([new CLabel(_('Access key ID'), 'ulm_access_key_id'), new CFormField($text('ulm_access_key_id', _('access key only')))])
	->addItem([new CLabel(_('Secret (Vault path:key)'), 'ulm_secret_path'), new CFormField([$text('ulm_secret_path', 'secret/elasticvue/karthi-s3:secret_access_key'),
		$hint(_('Access key only. Empty: secret/elasticvue/<client>-s3:secret_access_key.'))])])
	->addItem([new CLabel(_('Raw / enriched folders'), 'ulm_raw_prefix'), new CFormField([
		$text('ulm_raw_prefix', 'rawlog')->setWidth(ZBX_TEXTAREA_SMALL_WIDTH), ' ', $text('ulm_enriched_prefix', 'enrichedlog')->setWidth(ZBX_TEXTAREA_SMALL_WIDTH)])]);

// Machines and requested figures: one line per role, grouped by family.
$machines = (new CTable())->addClass('evp-roles')->setHeader([
	_('Family'), _('Role'), _('IPs (one per line)'), _('Named'), _('Servers'), _('CPU (cores)'), _('Memory (GB)'), _('Disk (GB)'), _('Disk mount')
]);
foreach ($data['roles']['families'] as $fam) {
	foreach ($fam['roles'] as $i => $r) {
		$box = fn(string $suffix, string $ph = '0') => (new CTextBox($r['id'].'_'.$suffix, (string) ($f[$r['id'].'_'.$suffix] ?? '')))
			->setWidth(ZBX_TEXTAREA_TINY_WIDTH)->setAttribute('placeholder', $ph);
		$ips = (new CTextArea('ips_'.$r['id'], (string) ($f['ips_'.$r['id']] ?? '')))->setRows(2)->setWidth(ZBX_TEXTAREA_SMALL_WIDTH)
			->setAttribute('placeholder', '10.0.0.11');
		$machines->addRow([
			$i === 0 ? (new CCol(new CTag('b', true, $fam['label'])))->setAttribute('rowspan', count($fam['roles'])) : null,
			$r['label'],
			$ips,
			(new CSpan('<client>-'.$r['short'].'-1, -2 …'))->addClass('evp-hint')->setAttribute('data-short', $r['short']),
			$box('servers'), $box('cpu'), $box('mem'), $box('disk'), $box('disk_fs', '/')
		]);
	}
}
$grid
	->addItem($section(_('Machines and requested figures')))
	->addItem([new CLabel(''), new CFormField([
		$hint(_('A machine already in this client with that IP is kept and renamed to its role\'s pattern; a new one is created. Numbers are kept: removing -2 does not rename -3. Removing a line deletes the host only if this page made it. Requested: 0 or empty means not set; each family\'s total is the sum of its roles.')),
		(new CDiv($machines))->addClass('evp-scroll')
	])])
	->addItem([new CLabel(_('Agent port'), 'agent_port'), new CFormField($text('agent_port', '10050')->setWidth(ZBX_TEXTAREA_SMALL_WIDTH))])
	->addItem([new CLabel(_('Purchased storage (GB)'), 'purchased'), new CFormField($text('purchased', '0')->setWidth(ZBX_TEXTAREA_SMALL_WIDTH))]);

if ($data['existing']) {
	$items = [];
	foreach ($data['existing'] as $h) {
		$items[] = [$h['name'], $h['ip'] ? ' · '.$h['ip'] : '', $h['role'] ? ' · '.$h['role'] : '', ' ',
			(new CSpan($h['managed'] ? _('(made here)') : _('(made by hand — kept)')))->addClass('evp-hint-inline')];
	}
	$grid->addItem([(new CTag('h4', true, _('Hosts now')))->addClass('evp-section'), new CFormField($list($items))]);
}

$grid->addItem([new CLabel(''), new CFormField([
	new CSubmit('save', $editing ? _('Save') : _('Add')), ' ',
	new CRedirectButton(_('Cancel'), (new CUrl('zabbix.php'))->setArgument('action', 'evp.clients.list')->getUrl()),
	(new CSpan(_('A backup of every client is taken before saving.')))->addClass('evp-hint-inline')
])]);

$form->addItem($top)->addItem($grid);

(new CHtmlPage())->setTitle($editing ? _s('Client %1$s', $f['name']) : _('Add client'))->addItem($form)->show();
?>
<script>
	(function () {
		const name = document.getElementById('name');
		const paint = () => {
			const c = (name && name.value.trim()) || '<client>';
			for (const s of document.querySelectorAll('#evp-client-form [data-short]')) s.textContent = c + '-' + s.dataset.short + '-1, -2 …';
			const di = (document.querySelector('#evp-client-form input[name="type"]:checked') || {}).value === 'DI';
			for (const l of document.querySelectorAll('#evp-client-form .evp-di-req')) l.classList.toggle('form-label-asterisk', di);
		};
		if (name) name.addEventListener('input', paint);
		for (const r of document.querySelectorAll('#evp-client-form input[name="type"]')) r.addEventListener('change', paint);
		paint();
	})();
</script>
<style>
	#evp-client-form .evp-section { margin: 18px 0 2px; }
	#evp-client-form .evp-hint { opacity: .75; margin-top: 3px; max-width: 80ch; }
	#evp-client-form .evp-hint-inline { opacity: .7; margin-left: 8px; }
	#evp-client-form .evp-box { margin: 0 0 14px; padding: 10px 12px; }
	#evp-client-form .evp-box ul { margin: 6px 0 0 18px; list-style: disc; }
	#evp-client-form .evp-scroll { overflow-x: auto; }
	#evp-client-form .evp-roles th, #evp-client-form .evp-roles td { padding: 3px 8px 3px 0; text-align: left; vertical-align: top; }
</style>
