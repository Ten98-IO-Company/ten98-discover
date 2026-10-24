// Browser sweep: runs every routed browser suite (tests/helpers/browser-sweep-routes.ts) and prints PASS / FAIL / SKIPPED per suite.
// Intended for the Linux Playwright container, from the repository root:
//   PLAYWRIGHT_MODULE=/opt/pw/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chromium node tests/browser-sweep.mjs [--jobs 2]
//   node tests/browser-sweep.mjs --list                  routing table only; runs nothing
//   node tests/browser-sweep.mjs --only rank,journeys    suites whose path contains any of these substrings
//   node tests/browser-sweep.mjs --class component       one class: component | native | evidence-gated
// Prerequisites stay with the suites and harnesses; the sweep never loosens a guard, seeds, migrates or fabricates evidence:
// - native-browser suites need a built .output (pnpm build) and a local throwaway PostgreSQL (NATIVE_BROWSER_POSTGRES, default
//   postgres://ten98@127.0.0.1:5432); tests/helpers/native-browser.mjs creates and drops one database per suite. They run one at a time
//   because they share app ports (3197, 3099, 3094) and the 55501 database port.
// - research-ui / conversions-ui suites run only when TEN98_SWEEP_RESEARCH_UI_ENV / TEN98_SWEEP_CONVERSIONS_UI_ENV name the operator's
//   env file and that harness's seeded fixture and preload web process are already running (see each harness README).
// - evidence-gated suites run only when every evidence variable names an existing file.
// Any FAIL exits 1. Full output per suite is kept under private/browser-sweep/<run>/.
import {spawn} from 'node:child_process';
import {createWriteStream, existsSync, mkdirSync, readFileSync} from 'node:fs';
import {connect} from 'node:net';
import {resolve} from 'node:path';
import {browserSuiteRoutes, discoverBrowserSuites} from './helpers/browser-sweep-routes.ts';

const usage = 'Usage: node tests/browser-sweep.mjs [--list] [--jobs 1|2] [--only a,b] [--class component|native|evidence-gated]';
const args = process.argv.slice(2), options = {list: false, jobs: 2, only: [], class: null};
while (args.length) {
  const arg = args.shift(), value = () => { const next = args.shift(); if (next === undefined) throw new Error(usage); return next; };
  if (arg === '--list') options.list = true;
  else if (arg === '--jobs') options.jobs = Number(value());
  else if (arg === '--only') options.only = value().split(',').filter(Boolean);
  else if (arg === '--class') options.class = value();
  else throw new Error(usage);
}
// The shared Docker lease allows at most two concurrent browser suites.
if (!Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 2) throw new Error('--jobs must be 1 or 2.');
if (options.class && !['component', 'native', 'evidence-gated'].includes(options.class)) throw new Error(usage);

const root = resolve(import.meta.dirname, '..');
if (resolve(process.cwd()) !== root) throw new Error('Run from the repository root.');
const routed = new Set(browserSuiteRoutes.map(route => route.suite)), unrouted = discoverBrowserSuites(root).filter(suite => !routed.has(suite));
if (unrouted.length) throw new Error('Unrouted browser suites: ' + unrouted.join(', '));
const routes = browserSuiteRoutes.filter(route => (!options.class || route.class === options.class) && (!options.only.length || options.only.some(part => route.suite.includes(part))));

const minutes = n => n * 60_000;
const timeoutOf = route => route.timeoutMs ?? (route.class === 'native' ? minutes(15) : minutes(5));
const fixtureEnv = {'research-ui': 'TEN98_SWEEP_RESEARCH_UI_ENV', 'conversions-ui': 'TEN98_SWEEP_CONVERSIONS_UI_ENV'};
const how = route => {
  if (route.class === 'native' && route.harness === 'native-browser') return ['native-browser', ...(route.port ? ['port=' + route.port] : []), ...route.runner, ...route.flags].join(' ');
  if (route.class === 'native') return `${route.harness} fixture via $${fixtureEnv[route.harness]}`;
  return [...route.flags ?? [], ...(route.evidence ?? []).map(name => '$' + name)].join(' ') || '(no opt-in flag)';
};
const table = (headers, rows) => {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index].length)));
  const line = row => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index])).join(' | ');
  return [line(headers), widths.map(width => '-'.repeat(width)).join('-|-'), ...rows.map(line)].join('\n');
};
const counts = list => Object.entries(Object.groupBy(list, item => item)).map(([key, value]) => `${key} ${value.length}`).join(', ');

if (options.list) {
  console.log(table(['Suite', 'Class', 'Runs with', 'Prerequisite / note'], routes.map(route => [route.suite.replace(/^tests\//, ''), route.class, how(route),
    route.blocked ? 'SKIPPED always: ' + route.blocked : route.note ?? (route.harness === 'native-browser' ? 'built .output + local PostgreSQL' : route.class === 'native' ? 'seeded harness fixture + preload web process (README)' : '')])));
  console.log(`\n${routes.length} routed suites: ${counts(routes.map(route => route.class))}.`);
  process.exit(0);
}

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to the installed Playwright entry (and PLAYWRIGHT_CHANNEL, e.g. chromium).');

// Native prerequisites are probed once; a missing one skips those suites with the reason instead of failing them.
const nativeBlocker = await (async () => {
  if (!existsSync('.output/server/index.mjs')) return 'no built .output/server/index.mjs (run pnpm build)';
  const postgres = new URL(process.env.NATIVE_BROWSER_POSTGRES ?? 'postgres://ten98@127.0.0.1:5432');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(postgres.hostname)) return 'NATIVE_BROWSER_POSTGRES must be a local throwaway server';
  const reachable = await new Promise(done => {
    const socket = connect(Number(postgres.port || 5432), postgres.hostname.replace(/^\[|\]$/g, ''));
    const finish = ok => { socket.destroy(); done(ok); };
    socket.setTimeout(2000, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
  return reachable ? null : `no PostgreSQL at ${postgres.host} (NATIVE_BROWSER_POSTGRES)`;
})();

function plan(route) {
  const flagEnv = Object.fromEntries((route.flags ?? []).map(flag => [flag, '1']));
  if (route.class === 'evidence-gated') {
    if (route.blocked) return {skip: route.blocked};
    const missing = route.evidence.filter(name => !process.env[name] || !existsSync(process.env[name]));
    if (missing.length) return {skip: `${route.note}; missing ${missing.join(', ')}`};
    return {argv: [route.suite], env: flagEnv};
  }
  if (route.class === 'component') return {argv: [route.suite], env: flagEnv};
  if (route.harness === 'native-browser') {
    if (nativeBlocker) return {skip: nativeBlocker};
    return {argv: ['tests/helpers/native-browser.mjs', ...route.runner, route.suite, ...route.flags], env: route.port ? {NATIVE_BROWSER_PORT: String(route.port)} : {}, group: 'native'};
  }
  const file = process.env[fixtureEnv[route.harness]];
  if (!file || !existsSync(file)) return {skip: `set ${fixtureEnv[route.harness]} to the seeded ${route.harness} env file with its preload web process running`};
  const preload = route.harness === 'conversions-ui' ? ['--import=./tests/conversions-ui/preload.mjs'] : [];
  return {argv: ['--env-file=' + file, ...preload, route.suite], env: {}, group: route.harness};
}

const run = new Date().toISOString().replace(/[:.]/g, '-'), logDir = resolve('private/browser-sweep', run);
mkdirSync(logDir, {recursive: true});
const firstError = text => {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean), own = lines.filter(line => !/^\[(server|worker)\]/.test(line));
  const hit = own.find(line => /^(\w*Error\b|Error \[)/.test(line)) ?? own.find(line => /\b\w*Error\b|ERR_|✖|not ok|\bfailed\b/i.test(line)) ?? own.at(-1) ?? lines.at(-1) ?? 'no output';
  return hit.length > 200 ? hit.slice(0, 197) + '...' : hit;
};
// /proc lookup so a timed-out native suite is stopped on its own and native-browser.mjs still drops its throwaway database.
const childrenOf = pid => { try { return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } };
const commandOf = pid => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { return []; } };
const killGroup = (child, signal) => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch {} };

function execute(route, {argv, env}) {
  return new Promise(done => {
    const started = Date.now(), log = createWriteStream(resolve(logDir, route.suite.replace(/^tests\//, '').replaceAll('/', '__') + '.log'));
    let output = '', timedOut = false;
    const child = spawn(process.execPath, argv, {cwd: root, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'});
    const collect = chunk => { log.write(chunk); if (output.length < 4_000_000) output += chunk; };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      const suite = argv[0] === 'tests/helpers/native-browser.mjs' ? childrenOf(child.pid).find(pid => commandOf(pid).includes(route.suite)) : undefined;
      if (suite) { try { process.kill(suite, 'SIGKILL'); } catch {} setTimeout(() => killGroup(child, 'SIGKILL'), 60_000).unref(); }
      else killGroup(child, 'SIGKILL');
    }, timeoutOf(route));
    child.on('close', code => {
      clearTimeout(timer); log.end();
      const seconds = Math.round((Date.now() - started) / 1000);
      if (timedOut) return done({result: 'FAIL', detail: `timed out after ${timeoutOf(route) / 1000}s: ${firstError(output)}`, seconds});
      done(code === 0 ? {result: 'PASS', detail: '', seconds} : {result: 'FAIL', detail: `exit ${code}: ${firstError(output)}`, seconds});
    });
  });
}

const results = new Map(), queue = routes.map(route => ({route, plan: plan(route)})), busy = new Set();
for (const {route, plan: {skip}} of queue) if (skip) results.set(route.suite, {result: 'SKIPPED', detail: skip, seconds: 0});
const pending = queue.filter(item => !item.plan.skip);
console.log(`Browser sweep ${run}: ${routes.length} suites, ${pending.length} to run, --jobs ${options.jobs}. Logs: ${logDir}`);
await new Promise(finish => {
  let running = 0;
  const next = () => {
    if (!pending.length && !running) return finish();
    while (running < options.jobs) {
      const index = pending.findIndex(item => !item.plan.group || !busy.has(item.plan.group));
      if (index < 0) return;
      const [{route, plan: work}] = pending.splice(index, 1);
      running++; if (work.group) busy.add(work.group);
      execute(route, work).then(outcome => {
        results.set(route.suite, outcome); running--; if (work.group) busy.delete(work.group);
        console.log(`${outcome.result.padEnd(4)} ${route.suite} (${outcome.seconds}s)`);
        next();
      });
    }
  };
  next();
});

const rows = routes.map(route => { const {result, detail, seconds} = results.get(route.suite); return [route.suite.replace(/^tests\//, ''), route.class, result, result === 'SKIPPED' ? '' : seconds + 's', detail]; });
console.log('\n' + table(['Suite', 'Class', 'Result', 'Time', 'Detail'], rows));
console.log(`\n${counts(rows.map(row => row[2]))}.`);
process.exitCode = rows.some(row => row[2] === 'FAIL') ? 1 : 0;
