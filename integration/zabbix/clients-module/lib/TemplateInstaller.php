<?php declare(strict_types = 0);

namespace Modules\EvpClients\Lib;

use API;
use Exception;

/**
 * Writes the master template into Zabbix from the roles, and says whether the one there is
 * current. Items, alerts, graphs and the dashboard page of a removed role go with it; a new
 * role's appear. Its item keys stay the same across installs, so history is kept.
 */
class TemplateInstaller {

	public static function install(array $roles): void {
		$rules = [
			'templates' => ['createMissing' => true, 'updateExisting' => true],
			'items' => ['createMissing' => true, 'updateExisting' => true, 'deleteMissing' => true],
			'triggers' => ['createMissing' => true, 'updateExisting' => true, 'deleteMissing' => true],
			'graphs' => ['createMissing' => true, 'updateExisting' => true, 'deleteMissing' => true],
			'discoveryRules' => ['createMissing' => true, 'updateExisting' => true, 'deleteMissing' => true],
			'templateDashboards' => ['createMissing' => true, 'updateExisting' => true, 'deleteMissing' => true],
			'valueMaps' => ['createMissing' => true, 'updateExisting' => true]
		];
		$ok = API::Configuration()->import([
			'format' => 'json',
			'source' => json_encode((new MasterTemplate($roles))->export(), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
			'rules' => $rules
		]);
		if ($ok === false) {
			$said = array_column(get_and_clear_messages(), 'message');
			throw new Exception(_s('Zabbix would not import the master template: %1$s', implode(' ', $said) ?: _('no reason given')));
		}
	}

	/** 'missing', 'outdated' or 'current'. */
	public static function status(array $roles): string {
		$tpl = API::Template()->get(['output' => ['templateid'], 'filter' => ['host' => MasterTemplate::NAME],
			'selectMacros' => ['macro', 'value']]);
		if (!$tpl) {
			return 'missing';
		}
		$hash = array_column($tpl[0]['macros'], 'value', 'macro')['{$EVP.ROLES.HASH}'] ?? '';
		return $hash === Roles::hash($roles) ? 'current' : 'outdated';
	}
}
