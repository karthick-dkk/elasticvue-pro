<?php declare(strict_types = 0);

namespace Modules\EvpClients\Actions;

foreach (['Store', 'Roles', 'ColumnSettings', 'MasterTemplate', 'ClientSpec', 'Reconciler', 'ClientState', 'Csv', 'Backups', 'TemplateInstaller', 'Importer'] as $lib) {
	require_once __DIR__.'/../lib/'.$lib.'.php';
}

use CController;
use CControllerResponseRedirect;
use CMessageHelper;
use CUrl;
use CWebUser;
use Modules\EvpClients\Lib\{Backups, ClientSpec, ClientState, Importer, Reconciler, Roles, Store};

/** What every Clients page shares: Super admins only; roles, rules and Zabbix state; backups. */
abstract class Base extends CController {

	private $roles_cache;

	protected function checkPermissions(): bool {
		return $this->getUserType() == USER_TYPE_SUPER_ADMIN;
	}

	protected function roles(): array {
		return $this->roles_cache ?? ($this->roles_cache = Roles::load());
	}

	/** The roles, for a view. */
	public function rolesFor(): array {
		return $this->roles();
	}

	protected function spec(): ClientSpec {
		return new ClientSpec($this->roles());
	}

	protected function rec(): Reconciler {
		return new Reconciler($this->spec());
	}

	protected function state(?Reconciler $rec = null): ClientState {
		return new ClientState($this->spec(), $rec ?? $this->rec());
	}

	protected function importer(): Importer {
		return new Importer($this->spec(), $this->state());
	}

	protected function user(): string {
		return (string) (CWebUser::$data['username'] ?? '?');
	}

	/** A copy of everything, before a change. Refuses the change when it cannot be taken. */
	protected function backup(string $before): string {
		return Backups::take($before, $this->user(), $this->state(), $this->roles());
	}

	/** Who last changed a client, and how — shown on the list. */
	protected function noteChange(string $client, string $how): void {
		$log = Store::read('changes.json', []);
		$log[$client] = ['at' => time(), 'how' => $how, 'by' => $this->user()];
		Store::write('changes.json', $log);
	}

	protected function toList(string $title, array $lines = [], bool $error = false, ?string $detail = null): void {
		$error ? CMessageHelper::setErrorTitle($title) : CMessageHelper::setSuccessTitle($title);
		if ($detail !== null) {
			$error ? CMessageHelper::addError($detail) : CMessageHelper::addSuccess($detail);
		}
		foreach ($lines as $line) {
			CMessageHelper::addSuccess($line);
		}
		$this->setResponse(new CControllerResponseRedirect((new CUrl('zabbix.php'))->setArgument('action', 'evp.clients.list')));
	}
}
