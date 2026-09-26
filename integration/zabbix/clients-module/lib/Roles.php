<?php declare(strict_types = 0);

namespace Modules\EvpClients\Lib;

/**
 * Families and roles — the kinds of machine a client has.
 *
 * A family (ES, Parser, Forwarder, Engine) has a host group every one of its machines joins —
 * the groups the SISA templates count — and holds roles (ES Data Hot, S3 Parser, UEBA …), each
 * with its own host group and its own name part in host names: karthi-ES-Data-Hot-1.
 *
 * Kept in the data folder as roles.json; the defaults below are what a first start writes.
 * Everything that knows about machines reads this: the Clients page and its CSV, the master
 * template it generates, and the Client resources report.
 *
 * Copied from ../../shared/php by ../../sync-assets.mjs — edit it there.
 */
class Roles {

	public const FILE = 'roles.json';

	/** Ids that would collide with the master template's other item keys. */
	public const RESERVED = ['delay', 'role', 'storage', 'master', 'client', 'cluster', 'ulm'];

	public const RESOURCES = ['servers', 'cpu', 'mem', 'disk'];

	public static function defaults(): array {
		return ['version' => 1, 'families' => [
			['id' => 'es', 'label' => 'ES', 'group' => 'ESNodes', 'sisa' => 'ES', 'memAlias' => 'ES.MEM.REQUESTED',
				'order' => ['servers', 'cpu', 'mem', 'disk'], 'roles' => [
				['id' => 'es_data_hot', 'label' => 'ES Data Hot', 'short' => 'ES-Data-Hot', 'group' => 'ES Data Hot'],
				['id' => 'es_data_warm', 'label' => 'ES Data Warm', 'short' => 'ES-Data-Warm', 'group' => 'ES Data Warm'],
				['id' => 'es_coord', 'label' => 'ES Coordination', 'short' => 'ES-Coord', 'group' => 'ES Coordination'],
				['id' => 'es_master', 'label' => 'ES Master', 'short' => 'ES-Master', 'group' => 'ES Master']
			]],
			['id' => 'parser', 'label' => 'Parser', 'group' => 'Parsers', 'sisa' => 'PARSER', 'memAlias' => 'PARSER.MEM.REQUESTED',
				'order' => ['servers', 'cpu', 'mem', 'disk'], 'roles' => [
				['id' => 'parser', 'label' => 'Parser', 'short' => 'Parser', 'group' => 'Parser'],
				['id' => 's3_parser', 'label' => 'S3 Parser', 'short' => 'S3-Parser', 'group' => 'S3 Parser']
			]],
			// Memory before CPU, as the original capacity list had it.
			['id' => 'fwd', 'label' => 'Forwarder', 'group' => 'Forwarders', 'sisa' => 'FWD', 'memAlias' => 'FORWARDER.MEM.REQUESTED',
				'order' => ['servers', 'mem', 'cpu', 'disk'], 'roles' => [
				['id' => 'forwarder', 'label' => 'Forwarder', 'short' => 'Forwarder', 'group' => 'Forwarders']
			]],
			['id' => 'engine', 'label' => 'Engine', 'group' => 'Engines', 'sisa' => 'ENGINE', 'memAlias' => 'ENGINE.MEM.REQUESTED',
				'order' => ['servers', 'cpu', 'mem', 'disk'], 'roles' => [
				['id' => 'ueba', 'label' => 'UEBA', 'short' => 'UEBA', 'group' => 'UEBA'],
				['id' => 'aiml', 'label' => 'AIML', 'short' => 'AIML', 'group' => 'AIML']
			]]
		]];
	}

	public static function load(): array {
		$config = Store::read(self::FILE);
		return is_array($config) && !empty($config['families']) ? $config : self::defaults();
	}

	public static function save(array $config): void {
		$errors = self::validate($config);
		if ($errors) {
			throw new \InvalidArgumentException(implode(' ', $errors));
		}
		Store::write(self::FILE, $config);
	}

	/** Every problem with a configuration, in words. Empty when it is usable. */
	public static function validate(array $config): array {
		$errors = [];
		// Families and roles have their own ids: a family's figures are evp.<id>.*, a role's
		// evp.role.*[<id>], so a family and a role may share a name (Parser, Parser).
		$familyIds = [];
		$roleIds = [];
		$shorts = [];
		foreach ($config['families'] ?? [] as $f) {
			foreach (['id', 'label', 'group', 'sisa'] as $k) {
				if (trim((string) ($f[$k] ?? '')) === '') {
					$errors[] = sprintf('A family has no %s.', $k);
				}
			}
			self::checkId((string) ($f['id'] ?? ''), $familyIds, $errors);
			if (!preg_match('/^[A-Z0-9_]{1,32}$/', (string) ($f['sisa'] ?? ''))) {
				$errors[] = sprintf('Family "%s": the macro prefix may hold only A-Z, 0-9 and _.', $f['label'] ?? '?');
			}
			if (empty($f['roles'])) {
				$errors[] = sprintf('Family "%s" needs at least one role.', $f['label'] ?? '?');
			}
			foreach ($f['roles'] ?? [] as $r) {
				foreach (['id', 'label', 'short', 'group'] as $k) {
					if (trim((string) ($r[$k] ?? '')) === '') {
						$errors[] = sprintf('A role of "%s" has no %s.', $f['label'] ?? '?', $k);
					}
				}
				self::checkId((string) ($r['id'] ?? ''), $roleIds, $errors);
				$short = (string) ($r['short'] ?? '');
				if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9\-]{0,31}$/', $short)) {
					$errors[] = sprintf('Role "%s": the name in host names may hold only letters, digits and dashes.', $r['label'] ?? '?');
				}
				if (isset($shorts[strtolower($short)])) {
					$errors[] = sprintf('Two roles are called "%s" in host names.', $short);
				}
				$shorts[strtolower($short)] = true;
			}
		}
		if (empty($config['families'])) {
			$errors[] = 'There must be at least one family.';
		}
		return $errors;
	}

	private static function checkId(string $id, array &$ids, array &$errors): void {
		if (!preg_match('/^[a-z][a-z0-9_]{0,31}$/', $id)) {
			$errors[] = sprintf('"%s" is not a usable id: lower-case letters, digits and _, starting with a letter.', $id);
		}
		elseif (in_array($id, self::RESERVED, true)) {
			$errors[] = sprintf('"%s" is reserved; choose another id.', $id);
		}
		elseif (isset($ids[$id])) {
			$errors[] = sprintf('The id "%s" is used twice.', $id);
		}
		$ids[$id] = true;
	}

	/** Every role, in order, each with its family's id, label and group attached. */
	public static function allRoles(array $config): array {
		$out = [];
		foreach ($config['families'] as $f) {
			foreach ($f['roles'] as $r) {
				$out[] = $r + ['family' => $f['id'], 'familyLabel' => $f['label'], 'familyGroup' => $f['group']];
			}
		}
		return $out;
	}

	public static function family(array $config, string $id): ?array {
		foreach ($config['families'] as $f) {
			if ($f['id'] === $id) {
				return $f;
			}
		}
		return null;
	}

	/** The master host macro a role's figure lives in: {$EVP.ES_DATA_HOT.CPU.REQUESTED}. */
	public static function macro(string $roleId, string $what): string {
		return '{$EVP.'.strtoupper($roleId).'.'.$what.'}';
	}

	/** Every host group the configuration names — the ones reconciling may add a host to or take it out of. */
	public static function groups(array $config): array {
		$out = [];
		foreach ($config['families'] as $f) {
			$out[$f['group']] = true;
			foreach ($f['roles'] as $r) {
				$out[$r['group']] = true;
			}
		}
		return array_keys($out);
	}

	/** A short fingerprint, so the Clients page can tell when the master template is behind. */
	public static function hash(array $config): string {
		return substr(sha1(json_encode($config['families'])), 0, 12);
	}
}
