<?php declare(strict_types = 0);
/**
 * @var CView $this
 * @var array $data
 */

$url = fn(string $action, array $args = []) => array_reduce(array_keys($args), fn($u, $k) => $u->setArgument($k, $args[$k]),
	(new CUrl('zabbix.php'))->setArgument('action', $action))->getUrl();
$post = function(string $action, string $label, array $vars, string $confirm = '', string $class = 'btn-link') use ($url) {
	$form = (new CForm('post', $url($action)))->addVar(CSRF_TOKEN_NAME, CCsrfTokenHelper::get($action))->addClass('evp-inline');
	foreach ($vars as $k => $v) {
		$form->addVar($k, $v);
	}
	$button = (new CSubmit('go', $label))->addClass($class);
	if ($confirm !== '') {
		$button->onClick('return confirm('.json_encode($confirm).');');
	}
	return $form->addItem($button);
};

$controls = (new CList())
	->addItem(new CRedirectButton(_('Download CSV template'), $url('evp.clients.csv.template')))
	->addItem(new CRedirectButton(_('Export clients (CSV)'), $url('evp.clients.csv.export')))
	->addItem((new CRedirectButton(_('Import CSV…'), $url('evp.clients.import'))))
	->addItem(new CRedirectButton(_s('Backups (%1$s)', $data['backups']), $url('evp.clients.backups')))
	->addItem(new CRedirectButton(_('Roles'), $url('evp.clients.roles')))
	->addItem(new CRedirectButton(_('Add client'), $url('evp.clients.edit')));

$page = (new CHtmlPage())->setTitle(_('Clients'))->setControls((new CTag('nav', true, $controls))->setAttribute('aria-label', _('Content controls')));

if (!$data['store_ok']) {
	$page->addItem((new CDiv(_s('Backups cannot be kept: %1$s is missing or not writable, so every change is refused until it is there. See the Clients module README.', $data['store_dir'])))
		->addClass('msg-bad')->addClass('evp-box'));
}
if ($data['template'] !== 'current') {
	$page->addItem((new CDiv([
		$data['template'] === 'missing'
			? _('The master template is not in Zabbix yet. Write it before adding clients.')
			: _('The master template was written for other roles. Write it again so every client\'s figures follow the current roles.'),
		' ', $post('evp.clients.template.install', _('Write master template'), [], '', 'btn-alt')
	]))->addClass('msg-warning')->addClass('evp-box'));
}

$filter = (new CDiv([
	(new CSpan(_n('%1$s client', '%1$s clients', count($data['clients']))))->addClass('evp-grow'),
	new CLabel(_('Type'), 'evp-type'), ' ',
	(new CSelect('evp-type'))->setId('evp-type')->addOptions(CSelect::createOptionsFromArray(['' => _('All'), 'DI' => 'DI', 'On-Prem' => 'On-Prem'])),
	' ', (new CTextBox('evp-search', ''))->setId('evp-search')->setAttribute('placeholder', _('Filter by client'))->setWidth(ZBX_TEXTAREA_SMALL_WIDTH)
]))->addClass('evp-filter');

$table = (new CTableInfo())
	->setId('evp-clients')
	->setHeader([_('Client'), _('Type'), _('ES URL'), _('Log archive'), _('Machines'), _('Changed'), _('Actions')])
	->setNoDataMessage(_('No clients yet. Add one, import a CSV, or set up an existing cluster below.'));

foreach ($data['clients'] as $c) {
	$change = $c['change'] ? date('d M H:i', $c['change']['at']).' · '.$c['change']['how'].' · '.$c['change']['by'] : '—';
	$machines = [$c['machines']];
	if ($c['unassigned']) {
		$machines[] = (new CSpan(' '._n('(%1$s without a role)', '(%1$s without a role)', $c['unassigned'])))->addClass('evp-warn-text');
	}
	$table->addRow((new CRow([
		(new CLink($c['name'], $url('evp.clients.edit', ['client' => $c['name']])))->addClass('evp-strong'),
		(new CSpan($c['type']))->addClass($c['type'] === 'DI' ? 'evp-pill evp-di' : 'evp-pill evp-op'),
		$c['es_url'] !== '' ? $c['es_url'] : '—',
		$c['archive'] !== '' ? $c['archive'] : '—',
		$machines,
		(new CSpan($change))->addClass('evp-soft'),
		[new CLink(_('Edit'), $url('evp.clients.edit', ['client' => $c['name']])), ' · ',
			new CLink(_('Dashboard'), $url('host.dashboard.view', ['hostid' => $c['masterid']])), ' · ',
			$post('evp.clients.remove', _('Remove'), ['client' => $c['name']],
				_s('Remove client "%1$s"? A backup is taken first. The hosts this page made for it are deleted, with their history; hosts made by hand and the host group stay.', $c['name']))]
	]))->setAttribute('data-type', $c['type'])->setAttribute('data-name', strtolower($c['name'])));
}

$page->addItem($filter)->addItem($table);

if ($data['candidates']) {
	$candidates = (new CTableInfo())->setHeader([_('Cluster host'), _('Client'), _('ES URL'), '']);
	foreach ($data['candidates'] as $c) {
		$candidates->addRow([$c['host'], $c['name'], $c['es_url'] !== '' ? $c['es_url'] : '—',
			new CLink(_('Set up as client'), $url('evp.clients.edit', ['client' => $c['name']]))]);
	}
	$page->addItem((new CTag('h4', true, _('Elasticsearch clusters that are not a client yet')))->addClass('evp-h'))
		->addItem((new CDiv(_('Setting one up keeps it and every host in its group — history, passwords — renames them to the client\'s pattern and adds what is missing.')))->addClass('evp-soft'))
		->addItem($candidates);
}

$page->show();
?>
<script>
	(function () {
		const type = document.getElementById('evp-type'), search = document.getElementById('evp-search');
		const apply = () => {
			const t = type ? type.value : '', q = (search ? search.value : '').trim().toLowerCase();
			for (const row of document.querySelectorAll('#evp-clients tbody tr[data-name]')) {
				row.hidden = (t !== '' && row.dataset.type !== t) || (q !== '' && !row.dataset.name.includes(q));
			}
		};
		if (type) type.addEventListener('change', apply);
		if (search) search.addEventListener('input', apply);
	})();
</script>
<style>
	.evp-inline { display: inline; }
	.evp-inline .btn-link { padding: 0; }
	.evp-strong { font-weight: bold; }
	.evp-h { margin: 24px 0 6px; }
	.evp-soft { opacity: .8; }
	.evp-box { margin: 0 0 10px; padding: 10px 12px; }
	.evp-filter { display: flex; gap: 8px; align-items: center; margin: 0 0 8px; }
	.evp-grow { margin-right: auto; }
	.evp-pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: bold; }
	.evp-di { background: #e3f2fd; color: #0d47a1; }
	.evp-op { background: #ede7f6; color: #4527a0; }
	.evp-warn-text { color: #b26a00; }
</style>
