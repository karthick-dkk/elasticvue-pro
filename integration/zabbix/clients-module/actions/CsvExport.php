<?php declare(strict_types = 0);

namespace Modules\EvpClients\Actions;

use CControllerResponseData;
use Modules\EvpClients\Lib\{ClientState, Csv};

/** Every client as it is now, in the template's columns — edit it in Excel and import it back. */
class CsvExport extends Base {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return true;
	}

	protected function doAction(): void {
		$state = $this->state();
		$forms = [];
		foreach ($state->clients() as $name => $_) {
			$forms[] = ClientState::plain($state->formFor($name));
		}
		$response = new CControllerResponseData(['main_block' => Csv::export($this->roles(), $forms), 'mime_type' => 'text/csv']);
		$response->setFileName('clients-'.date('Y-m-d').'.csv');
		$this->setResponse($response);
	}
}
