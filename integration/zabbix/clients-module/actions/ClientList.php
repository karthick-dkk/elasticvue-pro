<?php declare(strict_types = 0);

namespace Modules\EvpClients\Actions;

use CControllerResponseData;
use Modules\EvpClients\Lib\{ClientSpec, Roles, Store, TemplateInstaller};

/**
 * The clients: each with its type, ES URL, archive, machines per family and last change. Beneath,
 * cluster hosts made by hand that are not a client yet. Above, whether the master template is
 * written for the current roles, and whether backups can be kept.
 */
class ClientList extends Base {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return true;
	}

	protected function doAction(): void {
		$roles = $this->roles();
		$rec = $this->rec();
		$state = $this->state($rec);
		$clients = [];
		$changes = Store::read('changes.json', []);
		foreach ($state->clients() as $name => $c) {
			$now = $rec->current($name);
			$counts = [];
			foreach ($roles['families'] as $f) {
				$n = 0;
				foreach ($f['roles'] as $r) {
					$n += count($now['roles'][$r['id']]);
				}
				if ($n) {
					$counts[] = $n.' '.$f['label'];
				}
			}
			$bucket = $c['macros']['{$ULM.S3.BUCKET}'] ?? '';
			$clients[] = [
				'name' => $name,
				'masterid' => $c['masterid'],
				'type' => $c['macros']['{$EVP.CLIENT.TYPE}'] ?? 'On-Prem',
				'es_url' => $c['macros']['{$ES.URL}'] ?? '',
				'archive' => $bucket !== '' && $bucket !== ClientSpec::UNSET_BUCKET
					? $bucket.(($c['macros']['{$ULM.TAGS}'] ?? '') !== '' ? ' · tag1: '.$c['macros']['{$ULM.TAGS}'] : '') : '',
				'machines' => $counts ? implode(' · ', $counts) : '—',
				'unassigned' => count($now['unassigned']),
				'change' => $changes[$name] ?? null
			];
		}
		$response = new CControllerResponseData([
			'clients' => $clients,
			'candidates' => $state->candidates($state->clients()),
			'template' => TemplateInstaller::status($roles),
			'store_ok' => Store::writable(),
			'store_dir' => Store::dir(),
			'backups' => count(Store::listing('backups'))
		]);
		$response->setTitle(_('ElasticVue Pro — Clients'));
		$this->setResponse($response);
	}
}
