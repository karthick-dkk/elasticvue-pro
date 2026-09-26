<?php declare(strict_types = 0);

namespace Modules\EvpClients\Actions;

use Exception;

/** Remove a client: the hosts this page made for it, after a backup. Hosts made by hand and the group stay. */
class ClientRemove extends Base {

	protected function checkInput(): bool {
		return $this->validateInput(['client' => 'required|string']);
	}

	protected function doAction(): void {
		$client = trim((string) $this->getInput('client'));
		$rec = $this->rec();
		try {
			$this->backup('Remove '.$client);
			$rec->remove($client);
			$this->noteChange($client, 'removed');
			$this->toList(_s('Client "%1$s" removed', $client), $rec->done());
		}
		catch (Exception $e) {
			$this->toList(_s('Client "%1$s" was not removed', $client), $rec->done(), true, $e->getMessage());
		}
	}
}
