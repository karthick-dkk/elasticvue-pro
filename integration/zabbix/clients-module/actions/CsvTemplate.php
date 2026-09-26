<?php declare(strict_types = 0);

namespace Modules\EvpClients\Actions;

use CControllerResponseData;
use Modules\EvpClients\Lib\Csv;

/** The empty CSV template: the header row, with a column set per role. */
class CsvTemplate extends Base {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return true;
	}

	protected function doAction(): void {
		$response = new CControllerResponseData(['main_block' => Csv::export($this->roles(), []), 'mime_type' => 'text/csv']);
		$response->setFileName('clients-template.csv');
		$this->setResponse($response);
	}
}
