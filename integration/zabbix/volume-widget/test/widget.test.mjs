/** The volume widget's wiring: it keeps no column list, so what is left to check is the frame. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.resolve(import.meta.dirname, '..');
const php = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');

test('the columns come from the client plan template, not from a list here', () => {
  const view = php('actions/WidgetView.php');
  assert.match(view, /private const TEMPLATE = 'ElasticVue Pro client plan';/);
  assert.match(view, /array_key_exists\('column', \$tags\)/, 'columns are the items tagged with their place');
  assert.ok(!fs.existsSync(path.join(HERE, 'columns.json')), 'no column list of its own');
});

test('it colours only what the template’s triggers alarm on, at their thresholds', () => {
  const view = php('actions/WidgetView.php');
  assert.match(view, /\{\$ESPRO\.PLAN\.LIVE_USED\.WARN\}/);
  assert.match(view, /\{\$ESPRO\.PLAN\.LIVE_DAYS\.MIN\}/);
});

test('the manifest names the widget and its controller', () => {
  const m = JSON.parse(php('manifest.json'));
  assert.equal(m.id, 'evp_volume');
  assert.equal(m.widget.js_class, 'WidgetEvpVolume');
  assert.ok(php('assets/js/class.widget.js').includes('class WidgetEvpVolume extends CWidget'));
  assert.ok(m.actions['widget.evp_volume.view']);
});

test('the Columns dialog and the Type filter: settings applied, client type from the master hosts', () => {
  const view = php('actions/WidgetView.php');
  assert.match(view, /ColumnSettings::load\('volume'\)/);
  assert.match(view, /'id' => \$item\['key_'\]/, 'a column is known by its item key');
  assert.match(view, /\{\$EVP\.CLIENT\.TYPE\}/);
  const tpl = php('views/widget.view.php');
  for (const hook of ['data-evp-type-filter', 'data-evp-columns', "setVar('evp_meta'", "'data-type'"]) assert.ok(tpl.includes(hook), hook);
  assert.ok(php('assets/js/class.widget.js').includes('EvpColumns.init'));
});
