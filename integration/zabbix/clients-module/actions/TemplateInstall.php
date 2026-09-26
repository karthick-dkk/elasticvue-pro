<?php declare(strict_types = 0);

namespace Modules\EvpClients\Actions;

use Exception;
use Modules\EvpClients\Lib\TemplateInstaller;

/** Write the master template for the current roles. */
class TemplateInstall extends Base {

	protected function checkInput(): bool {
		return true;
	}

	protected function doAction(): void {
		try {
			TemplateInstaller::install($this->roles());
			$this->toList(_('Master template written for the current roles'), [_('New items show their first values within about ten minutes.')]);
		}
		catch (Exception $e) {
			$this->toList(_('Master template not written'), [], true, $e->getMessage());
		}
	}
}
