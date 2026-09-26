<?php declare(strict_types = 0);

namespace Modules\EvpClients\Actions;

use CControllerResponseData;
use Exception;
use Modules\EvpClients\Lib\{Csv, Store};

/**
 * Import a CSV. Every row is checked first; one error and nothing is applied. With a clean file:
 * a backup, then new clients added straight away (unless something overlaps), then the changes
 * to existing clients shown for a tick. Each client added is read back and compared.
 */
class ImportUpload extends Base {

	protected function init(): void {
		// The upload is a multipart POST; the token travels in the form and is checked here.
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return $this->validateInput([CSRF_TOKEN_NAME => 'string']);
	}

	protected function doAction(): void {
		$data = ['stage' => 'upload', 'file' => '', 'plan' => null, 'added' => [], 'backup' => null, 'pending' => [], 'error' => null,
			'store_ok' => Store::writable(), 'store_dir' => Store::dir()];

		if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
			if (!\CCsrfTokenHelper::check((string) $this->getInput(CSRF_TOKEN_NAME, ''), 'evp.clients.import')) {
				$data['error'] = _('The form expired. Choose the file again.');
			}
			elseif (!isset($_FILES['csv']) || $_FILES['csv']['error'] !== UPLOAD_ERR_OK) {
				$data['error'] = _('No file was received. Choose a .csv file and press Check file.');
			}
			else {
				$data['file'] = basename((string) $_FILES['csv']['name']);
				$data = $this->process((string) file_get_contents($_FILES['csv']['tmp_name']), $data);
			}
		}
		$response = new CControllerResponseData($data);
		$response->setTitle(_('Import clients'));
		$this->setResponse($response);
	}

	private function process(string $text, array $data): array {
		$roles = $this->roles();
		$importer = $this->importer();
		$plan = $importer->analyze(Csv::parse($text, $roles));
		$data['plan'] = $plan;
		if ($plan['errors']) {
			$data['stage'] = 'errors';
			return $data;
		}
		if (!Store::writable()) {
			$data['stage'] = 'errors';
			$data['plan']['errors'][] = _s('Backups cannot be kept: %1$s is missing or not writable. Nothing was changed.', Store::dir());
			return $data;
		}
		// A backup before what is added now; what waits for a tick gets its own when it is applied.
		// Checking a file changes nothing, so it does not use up one of the three.
		$work = array_filter($plan['rows'], fn($r) => $r['status'] === 'new' && !$r['warnings']);
		if ($work) {
			$data['backup'] = $this->backup('Import '.$data['file']);
		}

		$spec = $this->spec();
		foreach ($plan['rows'] as $row) {
			if ($row['status'] !== 'new' || $row['warnings']) {
				continue;
			}
			$rec = $this->rec();
			['client' => $client] = $spec->fromForm($row['form']);
			try {
				$rec->apply($client);
				$this->noteChange($client['name'], 'imported');
				$data['added'][] = ['name' => $client['name'], 'done' => $rec->done(), 'problems' => $importer->verify($client)];
			}
			catch (Exception $e) {
				$data['added'][] = ['name' => $client['name'], 'done' => $rec->done(), 'problems' => [$e->getMessage()]];
			}
		}

		// What waits for a tick: changes, and new clients that overlap something.
		$pending = array_values(array_filter($plan['rows'], fn($r) => $r['status'] === 'update' || ($r['status'] === 'new' && $r['warnings'])));
		if ($pending) {
			$token = bin2hex(random_bytes(8));
			Store::write('pending-import.json', ['token' => $token, 'file' => $data['file'], 'at' => time(), 'rows' => $pending]);
			$data['token'] = $token;
		}
		$data['pending'] = $pending;
		$data['stage'] = 'done';
		return $data;
	}
}
