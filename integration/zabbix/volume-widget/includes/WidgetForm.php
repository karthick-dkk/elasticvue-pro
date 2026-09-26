<?php declare(strict_types = 0);

namespace Modules\EvpVolume\Includes;

use Zabbix\Widgets\CWidgetForm;
use Zabbix\Widgets\Fields\CWidgetFieldMultiSelectGroup;

/**
 * One setting: which host groups to read cluster hosts from. Empty: every host carrying the
 * "ElasticVue Pro client plan" template that this user can see.
 */
class WidgetForm extends CWidgetForm {

	public function addFields(): self {
		return $this->addField(new CWidgetFieldMultiSelectGroup('groupids', _('Host groups')));
	}
}
