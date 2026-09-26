<?php declare(strict_types = 0);

namespace Modules\EvpClients\Actions;

use CControllerResponseData;
use Modules\EvpClients\Lib\{Backups, Csv};

/** A backup's clients as a CSV — the same columns as the template, as they were then. */
class BackupDownload extends Base {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return $this->validateInput(['id' => 'required|string']);
	}

	protected function doAction(): void {
		$b = Backups::get((string) $this->getInput('id'));
		$csv = $b ? Csv::export($b['roles'], array_values($b['clients'])) : '';
		$response = new CControllerResponseData(['main_block' => $csv, 'mime_type' => 'text/csv']);
		$response->setFileName('clients-backup-'.($b['id'] ?? 'missing').'.csv');
		$this->setResponse($response);
	}
}
