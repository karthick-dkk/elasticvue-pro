<?php declare(strict_types = 0);

namespace Modules\EvpCapacity\Actions;

foreach (['Store', 'ColumnSettings'] as $lib) {
	require_once __DIR__.'/../lib/'.$lib.'.php';
}

use API,
	CControllerDashboardWidgetView,
	CControllerResponseData,
	CCsrfTokenHelper;
use Modules\EvpCapacity\Lib\ColumnSettings;

/**
 * The capacity table: one row per client master host, the columns columns.json lists — the
 * master template's family-level items, which the Clients page writes (tests check the keys).
 *
 * Every figure is the master host's own item, so this reads, computes nothing that a
 * trigger or the host's dashboard does not also show, and needs no configuration beyond
 * which host groups to look in. Columns are renamed, hidden and reordered in the Columns dialog
 * (one setting for everyone, kept by ColumnSettings) and apply to the export too. A figure Zabbix does not have — an item unsupported, or
 * never measured — is shown as "—" and exported as an empty cell, never as 0.
 */
class WidgetView extends CControllerDashboardWidgetView {

	private const GB = 1073741824;

	protected function doAction(): void {
		$spec = json_decode((string) file_get_contents(__DIR__.'/../columns.json'), true);
		$all = array_map(fn($c) => $c + ['id' => $c['key'] ?? ('client.'.($c['source'] === 'host' ? 'name' : 'url')),
			'group' => ''], $spec['columns']);
		$settings = ColumnSettings::load('capacity');
		$columns = ColumnSettings::apply($all, $settings);
		$data = [
			'name' => $this->getInput('name', $this->widget->getDefaultName()),
			'columns' => $columns,
			'rows' => [],
			'export' => null,
			'error' => null,
			'meta' => [
				'title' => 'Client capacity',
				'report' => 'capacity',
				'action' => 'widget.evp_capacity.columns',
				'token' => CCsrfTokenHelper::get('widget.evp_capacity.columns'),
				'canEdit' => $this->getUserType() == USER_TYPE_SUPER_ADMIN,
				'columns' => array_map(fn($c) => ['id' => $c['id'], 'label' => $c['label'], 'default' => $c['default'], 'hidden' => $c['hidden'],
					'section' => ''], ColumnSettings::apply($all, $settings, true))
			],
			'user' => ['debug_mode' => $this->getDebugMode()]
		];

		$templates = API::Template()->get([
			'output' => ['templateid'],
			'filter' => ['host' => $spec['template']]
		]);
		if (!$templates) {
			$data['error'] = _s('Template "%1$s" is not imported, or you cannot read it.', $spec['template']);
			$this->setResponse(new CControllerResponseData($data));
			return;
		}

		$options = [
			'output' => ['hostid', 'host', 'name'],
			'templateids' => array_column($templates, 'templateid'),
			'monitored_hosts' => true,
			'preservekeys' => true
		];
		if ($this->fields_values['groupids']) {
			$options['groupids'] = getSubGroups($this->fields_values['groupids']);
		}
		$hosts = API::Host()->get($options);

		$keys = [];
		foreach ($all as $column) {
			foreach (['key', 'vs', 'usageKey'] as $field) {
				if (array_key_exists($field, $column)) {
					$keys[$column[$field]] = true;
				}
			}
		}

		$values = [];
		$units = [];
		if ($hosts) {
			$items = API::Item()->get([
				'output' => ['hostid', 'key_', 'lastvalue', 'lastclock', 'units', 'state'],
				'hostids' => array_keys($hosts),
				'filter' => ['key_' => array_keys($keys)]
			]);
			foreach ($items as $item) {
				$units[$item['key_']] = $item['units'];
				// Unsupported, or never measured: unknown, which is not zero.
				$known = $item['state'] == ITEM_STATE_NORMAL && $item['lastclock'] != 0 && $item['lastvalue'] !== '';
				$values[$item['hostid']][$item['key_']] = $known ? (float) $item['lastvalue'] : null;
			}

			$macros = API::UserMacro()->get([
				'output' => ['hostid', 'macro', 'value'],
				'hostids' => array_keys($hosts),
				'filter' => ['macro' => ['{$GRP.CLIENT}', '{$ES.URL}', '{$EVP.USAGE.WARN}', '{$EVP.USAGE.HIGH}', '{$EVP.CLIENT.TYPE}']]
			]) ?: [];
			$host_macros = [];
			foreach ($macros as $macro) {
				$host_macros[$macro['hostid']][$macro['macro']] = (string) ($macro['value'] ?? '');
			}
		}

		$export_headers = [];
		foreach ($columns as $column) {
			$export_headers[] = $column['label'].self::exportSuffix(isset($column['key']) ? ($units[$column['key']] ?? $column['units'] ?? '') : '');
		}

		$export_rows = [];
		foreach ($hosts as $hostid => $host) {
			$m = $host_macros[$hostid] ?? [];
			$warn = is_numeric($m['{$EVP.USAGE.WARN}'] ?? null) ? (float) $m['{$EVP.USAGE.WARN}'] : (float) $spec['warn'];
			$high = is_numeric($m['{$EVP.USAGE.HIGH}'] ?? null) ? (float) $m['{$EVP.USAGE.HIGH}'] : (float) $spec['high'];
			$client = ($m['{$GRP.CLIENT}'] ?? '') !== '' ? $m['{$GRP.CLIENT}'] : $host['name'];
			$type = ($m['{$EVP.CLIENT.TYPE}'] ?? '') !== '' ? $m['{$EVP.CLIENT.TYPE}'] : 'On-Prem';

			$cells = [];
			$export = [];
			foreach ($columns as $column) {
				$cell = ['text' => '—', 'class' => '', 'hint' => ''];

				if (($column['source'] ?? '') === 'host') {
					$cell['text'] = $client;
					$export[] = $client;
				}
				elseif (($column['source'] ?? '') === 'macro') {
					$text = $m[$column['macro']] ?? '';
					$cell['text'] = $text !== '' ? $text : '—';
					$export[] = $text;
				}
				else {
					$key = $column['key'];
					$value = $values[$hostid][$key] ?? null;
					$unit = $units[$key] ?? ($column['units'] ?? '');

					// A request or purchase of 0 is one nobody entered: "not set", not a figure.
					if (($column['kind'] ?? '') === 'requested' && $value !== null && $value == 0) {
						$cell = ['text' => _('not set'), 'class' => 'evp-unset', 'hint' => ''];
						$cells[] = $cell;
						$export[] = null;
						continue;
					}
					if ($value !== null) {
						$cell['text'] = convertUnits(['value' => $value, 'units' => $unit, 'decimals' => $unit === '' ? 0 : 2]);
					}
					$export[] = self::exportValue($value, $unit);

					// Usage colour: the usage figure itself, or the one it stands beside.
					$usage = !empty($column['usage'])
						? $value
						: (array_key_exists('usageKey', $column) ? ($values[$hostid][$column['usageKey']] ?? null) : null);
					if ($usage !== null) {
						if ($usage >= $high) {
							$cell['class'] = 'evp-high';
						}
						elseif ($usage >= $warn) {
							$cell['class'] = 'evp-warn';
						}
						if (array_key_exists('usageKey', $column)) {
							$cell['hint'] = _s('%1$s%% used', round($usage, 1));
						}
					}

					// Allocated below what was requested — only when a request was made.
					if (array_key_exists('vs', $column)) {
						$requested = $values[$hostid][$column['vs']] ?? null;
						if ($value !== null && $requested !== null && $requested > 0 && $value < $requested) {
							$cell['class'] = trim($cell['class'].' evp-short');
							$cell['hint'] = _s('Below requested: %1$s',
								convertUnits(['value' => $requested, 'units' => $units[$column['vs']] ?? $unit])
							);
						}
					}
				}
				$cells[] = $cell;
			}
			$data['rows'][] = ['client' => $client, 'type' => $type, 'cells' => $cells];
			$export_rows[] = $export;
		}

		// One order for the table and the export, whichever column comes first now.
		$order = array_keys($data['rows']);
		usort($order, fn($a, $b) => strnatcasecmp($data['rows'][$a]['client'], $data['rows'][$b]['client']));
		$data['rows'] = array_map(fn($i) => $data['rows'][$i], $order);
		$data['export'] = ['headers' => $export_headers, 'rows' => array_map(fn($i) => $export_rows[$i], $order),
			'types' => array_column($data['rows'], 'type')];

		$this->setResponse(new CControllerResponseData($data));
	}

	/** Bytes go to a spreadsheet as GB, so a column can be summed without reading the units. */
	private static function exportSuffix(string $units): string {
		return $units === 'B' ? ' (GB)' : ($units === '%' ? ' (%)' : '');
	}

	private static function exportValue(?float $value, string $units) {
		if ($value === null) {
			return null;
		}
		if ($units === 'B') {
			return round($value / self::GB, 2);
		}
		return round($value, $units === '%' ? 1 : 2);
	}
}
