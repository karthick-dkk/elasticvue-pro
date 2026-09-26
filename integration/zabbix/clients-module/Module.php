<?php declare(strict_types = 0);

namespace Modules\EvpClients;

use APP;
use CController;
use CMenuItem;
use CWebUser;
use Zabbix\Core\CModule as CoreModule;

/**
 * Puts "Clients" in the ElasticVue Pro menu, for Super admins.
 *
 * Added before each page is drawn rather than at start-up: the ElasticVue Pro menu belongs to
 * another module, which may start after this one. Without that menu, "Clients" goes under
 * Data collection instead of disappearing.
 */
class Module extends CoreModule {

	private $added = false;

	public function onBeforeAction(CController $action): void {
		if ($this->added || CWebUser::getType() != USER_TYPE_SUPER_ADMIN) {
			return;
		}
		$this->added = true;
		$menu = APP::Component()->get('menu.main');
		$item = (new CMenuItem(_('Clients')))->setAction('evp.clients.list')
			->setAliases(['evp.clients.edit', 'evp.clients.save', 'evp.clients.import', 'evp.clients.backups', 'evp.clients.roles']);
		$home = $menu->find(_('ElasticVue Pro')) ?? $menu->find(_('Data collection'));
		if ($home !== null && $home->hasSubMenu()) {
			$home->getSubMenu()->add($item);
		}
	}
}
