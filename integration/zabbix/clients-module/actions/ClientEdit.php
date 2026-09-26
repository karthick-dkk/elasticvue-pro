<?php declare(strict_types = 0);

namespace Modules\EvpClients\Actions;

use CControllerResponseData;
use Modules\EvpClients\Lib\Reconciler;

/** The form: empty for a new client, filled for one that exists or a cluster host being taken on. */
class ClientEdit extends Base {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return $this->validateInput(['client' => 'string']);
	}

	protected function doAction(): void {
		$name = trim((string) $this->getInput('client', ''));
		$form = $name === '' ? $this->spec()->defaults() : $this->state()->formFor($name);
		$now = $form['_now'] ?? null;
		$this->setResponse(self::page($this, $form, $now === null || $now['master'] === null ? 'add' : 'edit', [], $now !== null && $now['master'] === null && ($now['cluster'] !== null || $now['machines'])));
	}

	public static function page(Base $c, array $form, string $mode, array $errors, bool $adopting = false, array $done = []): CControllerResponseData {
		$now = $form['_now'] ?? null;
		$existing = [];
		if ($now !== null) {
			foreach (array_merge(array_filter([$now['master'], $now['cluster'], $now['ulm']]), array_values($now['machines'])) as $h) {
				$existing[] = ['name' => $h['name'], 'managed' => Reconciler::isManaged($h), 'ip' => $h['_ip'] ?? null,
					'role' => isset($h['_role']) ? ($h['_role']['label'] ?? null) : null];
			}
		}
		$response = new CControllerResponseData([
			'form' => array_filter($form, fn($k) => $k[0] !== '_', ARRAY_FILTER_USE_KEY),
			'roles' => $c->rolesFor(),
			'mode' => $mode,
			'adopting' => $adopting,
			'existing' => $existing,
			'unassigned' => $form['_unassigned'] ?? [],
			'errors' => $errors,
			'done' => $done
		]);
		$response->setTitle($mode === 'add' ? _('Add client') : _s('Client %1$s', $form['name']));
		return $response;
	}
}
