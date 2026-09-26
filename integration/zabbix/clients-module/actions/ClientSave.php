<?php declare(strict_types = 0);

namespace Modules\EvpClients\Actions;

use Exception;
use Modules\EvpClients\Lib\{ClientState};

/**
 * Add or edit a client. A form with mistakes comes back with them and nothing saved; a backup is
 * taken before anything changes; after saving, the client is read back and compared.
 */
class ClientSave extends Base {

	protected function checkInput(): bool {
		$fields = ['name' => 'required|string', 'mode' => 'required|in add,edit'];
		foreach (array_keys($this->spec()->defaults()) as $field) {
			$fields[$field] = $fields[$field] ?? 'string';
		}
		return $this->validateInput($fields);
	}

	protected function doAction(): void {
		$spec = $this->spec();
		$input = [];
		foreach (array_keys($spec->defaults()) as $field) {
			$input[$field] = (string) $this->getInput($field, '');
		}
		$mode = $this->getInput('mode');
		['client' => $client, 'errors' => $errors] = $spec->fromForm($input);
		$rec = $this->rec();
		if (!$errors && $mode === 'add' && $this->state($rec)->formFor($client['name'])['_now']['master'] !== null) {
			$errors[] = _s('Client "%1$s" exists already — edit it from the list.', $client['name']);
		}
		if (!$errors) {
			try {
				$this->backup(($mode === 'add' ? 'Add ' : 'Edit ').$client['name']);
				$rec->apply($client);
				$this->noteChange($client['name'], $mode === 'add' ? 'added' : 'edited');
				$problems = $this->importer()->verify($client);
				$this->toList($mode === 'add' ? _s('Client "%1$s" added', $client['name']) : _s('Client "%1$s" saved', $client['name']),
					array_merge($rec->done(), $problems ? [_('Read back from Zabbix, these differ: ').implode(' ', $problems)] : [_('Read back from Zabbix: everything matches.')]));
				return;
			}
			catch (Exception $e) {
				$errors[] = $e->getMessage();
			}
		}
		$input['_now'] = $this->state()->formFor($input['name'] ?: '_')['_now'] ?? null;
		$this->setResponse(ClientEdit::page($this, $input, $mode, $errors, false, $rec->done()));
	}
}
