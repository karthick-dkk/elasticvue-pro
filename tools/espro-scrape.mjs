#!/usr/bin/env node
/**
 * Evaluate the automation rules with no browser and print a document Zabbix can poll.
 *
 * The rules only ever ran when someone had the Automation page open, which makes a
 * notification close to useless: it arrives when you have already found the problem
 * yourself. This runs the same rules on a schedule and leaves the answer somewhere a
 * monitoring system can fetch it.
 *
 * It imports ui/js/core/automation.js rather than restating any of the rules, so there is
 * one definition of "safe to delete" and the scrape cannot drift away from the page. The
 * core modules touch no DOM, so this needs no jsdom — only a base URL for the relative
 * /bridge path the UI's transport posts to.
 *
 *   node tools/espro-scrape.mjs --config clusters.yaml
 *   node tools/espro-scrape.mjs --config clusters.yaml --out /var/lib/espro/state.json
 *   node tools/espro-scrape.mjs --config clusters.yaml --format sender | zabbix_sender -z zbx -i -
 *
 * Options:
 *   --config PATH     the same clusters.yaml the app loads          (required)
 *   --bridge URL      espro-bridge base URL       (default http://127.0.0.1:8765)
 *   --out PATH        write here instead of stdout, atomically
 *   --format json     one JSON document, shaped for a Zabbix HTTP agent item  (default)
 *   --format sender   "<host> <key> <value>" lines for zabbix_sender
 *   --host NAME       host name used by --format sender   (default elasticvue-pro)
 *   --auth-user NAME  sent as X-Auth-User, which the hosted bridge requires
 *
 * Exit status is 0 whenever the scrape produced a document, even if clusters were
 * unreachable — an unreachable cluster is a fact to report, not a reason to report
 * nothing. Only a failure to produce a document at all exits non-zero.
 *
 * This reads. It never writes to Elasticsearch: rules return descriptions of work, and
 * running that work still needs a person in the app, behind the same two-gate write guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui', 'js');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const bridgeUrl = arg('--bridge', 'http://127.0.0.1:8765').replace(/\/+$/, '');
const configPath = arg('--config', '');
const outPath = arg('--out', '');
const format = arg('--format', 'json');
const zbxHost = arg('--host', 'elasticvue-pro');
const authUser = arg('--auth-user', '');

if (!configPath) {
  console.error('espro-scrape: --config <clusters.yaml> is required');
  console.error('  see the header of this file for the full option list');
  process.exit(2);
}
if (format !== 'json' && format !== 'sender') {
  console.error(`espro-scrape: --format must be json or sender, not ${format}`);
  process.exit(2);
}

/*
 * The whole of the browser shim.
 *
 * transport.js posts to the relative path /bridge, which is meaningless without a document
 * base, so relative URLs are resolved against the bridge. The hosted bridge also demands
 * X-Auth-User. Nothing else is needed: no jsdom, no DOM, no localStorage.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  if (typeof input === 'string' && input.startsWith('/')) input = bridgeUrl + input;
  if (authUser) init = { ...init, headers: { ...(init.headers || {}), 'X-Auth-User': authUser } };
  return realFetch(input, init);
};

const { parseConfigText } = await import(path.join(UI, 'core/config.js'));
const { state, setConfig, fetchOverview, fetchIndices, activeClusters } =
  await import(path.join(UI, 'core/state.js'));
const { runAutomation, resultsFor, activeRules } = await import(path.join(UI, 'core/automation.js'));

/* ---------------------------------- gather ---------------------------------- */

const started = Date.now();
const problems = [];

let config;
try {
  config = parseConfigText(fs.readFileSync(configPath, 'utf8'), path.basename(configPath));
} catch (e) {
  console.error(`espro-scrape: cannot read ${configPath}: ${e.message || e}`);
  process.exit(2);
}

// A sealed secret needs a master password only a person can type. Saying so beats scraping
// every cluster as unreachable and letting the monitoring system infer an outage.
if (config.sealed) {
  problems.push('config holds sealed (enc:v1:) credentials, which a headless run cannot '
              + 'unlock — give this run a config whose secrets are readable to it');
}

await setConfig(config, null);

for (const c of activeClusters()) {
  try { await fetchOverview(c.id); }
  catch (e) { problems.push(`${c.name}: overview failed — ${e.message || e}`); }
  try { await fetchIndices(c.id, '*'); }
  catch (e) { problems.push(`${c.name}: index list failed — ${e.message || e}`); }
}

await runAutomation();

/* ----------------------------------- shape ----------------------------------- */

const clusters = [];
const ruleRows = [];

for (const c of activeClusters()) {
  const data = state.data.get(c.id) || {};
  const r = resultsFor(c.id);
  const rules = [];

  for (const item of (r && r.results) || []) {
    const p = item.proposal;
    const proposed = (p && p.targets && p.targets.length) || 0;
    const held = (p && p.blocked && p.blocked.length) || 0;
    const row = {
      id: item.rule.id,
      title: item.rule.title,
      action: item.rule.action,
      user: !!item.rule.user,
      state: item.error ? 'error' : item.skipped ? 'skipped' : proposed ? 'proposed' : 'clean',
      proposed,
      held,
      freedBytes: (p && p.freed) || 0,
      detail: item.error || item.skipped || (p && (p.evidence || p.note)) || '',
      targets: p ? (p.targets || []).map((t) => t.name) : [],
      // What the rule refused to propose is the point of the feature, not a footnote: an
      // index past retention with no good snapshot is the one you most need to hear about.
      heldBack: p ? (p.blocked || []).map((b) => ({ name: b.name, reason: b.reason })) : [],
    };
    rules.push(row);
    ruleRows.push({ clusterId: c.id, clusterName: c.name, ...row });
  }

  clusters.push({
    id: c.id,
    name: c.name,
    reachable: !!data.reachable,
    health: (data.health && data.health.status) || 'unknown',
    proposed: rules.reduce((s, x) => s + x.proposed, 0),
    held: rules.reduce((s, x) => s + x.held, 0),
    freedBytes: rules.reduce((s, x) => s + x.freedBytes, 0),
    errors: rules.filter((x) => x.state === 'error').length,
    rules,
  });
}

const totals = {
  clusters: clusters.length,
  unreachable: clusters.filter((c) => !c.reachable).length,
  proposed: clusters.reduce((s, c) => s + c.proposed, 0),
  held: clusters.reduce((s, c) => s + c.held, 0),
  freedBytes: clusters.reduce((s, c) => s + c.freedBytes, 0),
  errors: clusters.reduce((s, c) => s + c.errors, 0),
  rulesEvaluated: activeRules().length,
};

const doc = {
  ok: problems.length === 0 && totals.unreachable === 0 && totals.errors === 0,
  generated: new Date(started).toISOString(),
  // Epoch seconds so a trigger can fuzzytime() this and alert when the scrape itself stops
  // running. A scraper that has died looks exactly like a healthy fleet otherwise.
  generatedEpoch: Math.floor(started / 1000),
  durationMs: Date.now() - started,
  source: path.basename(configPath),
  problems,
  totals,
  clusters,
  discovery: {
    clusters: clusters.map((c) => ({ '{#CLUSTER.ID}': c.id, '{#CLUSTER.NAME}': c.name })),
    rules: ruleRows.map((x) => ({
      '{#CLUSTER.ID}': x.clusterId,
      '{#CLUSTER.NAME}': x.clusterName,
      '{#RULE.ID}': x.id,
      '{#RULE.TITLE}': x.title,
      '{#RULE.ACTION}': x.action,
    })),
  },
};

/* ------------------------------------ emit ----------------------------------- */

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
let text;

if (format === 'sender') {
  const lines = [
    `${zbxHost} espro.scrape.ok ${doc.ok ? 1 : 0}`,
    `${zbxHost} espro.scrape.epoch ${doc.generatedEpoch}`,
    `${zbxHost} espro.proposed ${totals.proposed}`,
    `${zbxHost} espro.held ${totals.held}`,
    `${zbxHost} espro.freed.bytes ${totals.freedBytes}`,
    `${zbxHost} espro.errors ${totals.errors}`,
    `${zbxHost} espro.unreachable ${totals.unreachable}`,
  ];
  for (const c of clusters) {
    lines.push(`${zbxHost} espro.cluster.reachable[${c.id}] ${c.reachable ? 1 : 0}`);
    lines.push(`${zbxHost} espro.cluster.proposed[${c.id}] ${c.proposed}`);
    lines.push(`${zbxHost} espro.cluster.held[${c.id}] ${c.held}`);
    lines.push(`${zbxHost} espro.cluster.freed.bytes[${c.id}] ${c.freedBytes}`);
  }
  for (const x of ruleRows) {
    lines.push(`${zbxHost} espro.rule.proposed[${x.clusterId},${x.id}] ${x.proposed}`);
    lines.push(`${zbxHost} espro.rule.held[${x.clusterId},${x.id}] ${x.held}`);
    lines.push(`${zbxHost} espro.rule.detail[${x.clusterId},${x.id}] ${q(x.detail)}`);
  }
  lines.push(`${zbxHost} espro.discovery.clusters ${q(JSON.stringify(doc.discovery.clusters))}`);
  lines.push(`${zbxHost} espro.discovery.rules ${q(JSON.stringify(doc.discovery.rules))}`);
  text = `${lines.join('\n')}\n`;
} else {
  text = `${JSON.stringify(doc, null, 2)}\n`;
}

if (outPath) {
  // Written to a temporary file beside the target and renamed, because a web server or an
  // agent reading this path must never catch a half-written document.
  const tmp = `${outPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, outPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* it may never have been created */ }
    console.error(`espro-scrape: cannot write ${outPath}: ${e.message || e}`);
    process.exit(2);
  }
  console.error(`espro-scrape: wrote ${outPath} — ${totals.proposed} proposed, `
    + `${totals.held} held, ${totals.unreachable}/${totals.clusters} unreachable`);
} else {
  process.stdout.write(text);
}

for (const p of problems) console.error(`espro-scrape: ${p}`);
