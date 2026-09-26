<?php declare(strict_types = 0);

namespace Modules\EvpClients\Lib;

/**
 * A copy of every client and of the roles, taken before any change — an import, a save, a
 * removal, a role change, a restore. The newest three are kept.
 *
 * A backup holds what the Clients page manages: each client's form (settings, requested
 * figures, machines per role) and the roles configuration. Restoring brings those back; it
 * cannot bring back the history of a host deleted since, and says so where it is offered.
 */
class Backups {

	public const KEEP = 3;
	public const DIR = 'backups';

	public static function take(string $before, string $by, ClientState $state, array $roles): string {
		$clients = [];
		foreach ($state->clients() as $name => $_) {
			$clients[$name] = ClientState::plain($state->formFor($name));
		}
		$hosts = 0;
		foreach ($clients as $form) {
			foreach (Roles::allRoles($roles) as $r) {
				$hosts += count(ClientSpec::splitIps($form['ips_'.$r['id']] ?? ''));
			}
		}
		$id = gmdate('Ymd-His').'-'.bin2hex(random_bytes(2));
		Store::write(self::DIR.'/'.$id.'.json', [
			'id' => $id,
			'taken' => time(),
			'by' => $by,
			'before' => $before,
			'roles' => $roles,
			'clients' => $clients,
			'machines' => $hosts
		]);
		foreach (array_slice(Store::listing(self::DIR), self::KEEP) as $old) {
			Store::delete($old);
		}
		return $id;
	}

	/** Two saved client forms mean the same client: every field alike, ignoring order and "_" keys. */
	public static function sameForm(array $a, array $b): bool {
		$norm = function (array $f): array {
			$out = [];
			foreach ($f as $k => $v) {
				if (is_string($k) && $k !== '' && $k[0] !== '_' && !is_array($v)) {
					$out[$k] = trim((string) $v);
				}
			}
			ksort($out);
			return array_filter($out, fn($v) => $v !== '');
		};
		return $norm($a) === $norm($b);
	}

	/** Newest first, without the client forms. */
	public static function list(): array {
		$out = [];
		foreach (Store::listing(self::DIR) as $file) {
			$b = Store::read($file);
			if ($b) {
				$out[] = ['id' => $b['id'], 'taken' => $b['taken'], 'by' => $b['by'], 'before' => $b['before'],
					'clients' => count($b['clients']), 'machines' => $b['machines'] ?? 0];
			}
		}
		return $out;
	}

	public static function get(string $id): ?array {
		if (!preg_match('/^\d{8}-\d{6}-[0-9a-f]{4}$/', $id)) {
			return null;
		}
		return Store::read(self::DIR.'/'.$id.'.json');
	}
}
