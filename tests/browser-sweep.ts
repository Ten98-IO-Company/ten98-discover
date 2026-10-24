// Browser sweep: runs every routed browser suite (tests/helpers/browser-sweep-routes.ts) and prints PASS / FAIL / SKIPPED per suite.
// Intended for the Linux Playwright container, from the repository root:
//   PLAYWRIGHT_MODULE=/opt/pw/node_modules/playwright/index.mjs PLAYWRIGHT_CHANNEL=chromium node tests/browser-sweep.ts [--jobs 2]
//   node tests/browser-sweep.ts --list                  routing table only; runs nothing
//   node tests/browser-sweep.ts --only rank,journeys    suites whose path contains any of these substrings
//   node tests/browser-sweep.ts --class component       one class: component | native | evidence-gated
//   node tests/browser-sweep.ts --require-run           exit 1 when every selected suite was skipped
// Prerequisites stay with the suites and harnesses; the sweep never loosens a guard, seeds, migrates or fabricates evidence:
// - native-browser suites need a built .output (pnpm build) and a local throwaway PostgreSQL (NATIVE_BROWSER_POSTGRES, default
//   postgres://ten98@127.0.0.1:5432); tests/helpers/native-browser.mjs creates and drops one database per suite. They run one at a time
//   because they share app ports (3197, 3099, 3094) and the 55501 database port.
// - research-ui / conversions-ui suites run only when TEN98_SWEEP_RESEARCH_UI_ENV / TEN98_SWEEP_CONVERSIONS_UI_ENV name the operator's
//   env file and that harness's seeded fixture and preload web process are already running (see each harness README).
// - evidence-gated suites run only when every evidence variable names an existing file.
// Any FAIL exits 1; SIGINT/SIGTERM stops running suites (native runners still drop their databases) and exits 130/143. Full output per suite is kept under private/browser-sweep/<run>/.
import {spawn, type ChildProcess} from 'node:child_process';
import {createWriteStream, existsSync, mkdirSync} from 'node:fs';
import {connect} from 'node:net';
import {resolve} from 'node:path';
import {browserSuiteRoutes, discoverBrowserSuites, signalExitCode, stopSequence, type SuiteClass, type SuiteRoute} from './helpers/browser-sweep-routes.ts';

type Result = 'PASS' | 'FAIL' | 'SKIPPED';
interface Outcome { result: Result; detail: string; seconds: number }
type Plan = {skip: string} | {skip?: undefined; argv: string[]; env: Record<string, string>; group?: string};

const usage = 'Usage: node tests/browser-sweep.ts [--list] [--jobs 1|2] [--only a,b] [--class component|native|evidence-gated] [--require-run]';
const classes: SuiteClass[] = ['component', 'native', 'evidence-gated'];
const args = process.argv.slice(2), options = {list: false, jobs: 2, only: [] as string[], class: null as SuiteClass | null, requireRun: false};
while (args.length) {
  const arg = args.shift(), value = () => { const next = args.shift(); if (next === undefined) throw new Error(usage); return next; };
  if (arg === '--list') options.list = true;
  else if (arg === '--jobs') options.jobs = Number(value());
  else if (arg === '--only') options.only = value().split(',').filter(Boolean);
  else if (arg === '--class') { const name = value(); if (!classes.includes(name as SuiteClass)) throw new Error(usage); options.class = name as SuiteClass; }
  else if (arg === '--require-run') options.requireRun = true;
  else throw new Error(usage);
}
// The shared Docker lease allows at most two concurrent browser suites.
if (!Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 2) throw new Error('--jobs must be 1 or 2.');

const root = resolve(import.meta.dirname, '..');
if (resolve(process.cwd()) !== root) throw new Error('Run from the repository root.');
const routed = new Set(browserSuiteRoutes.map(route => route.suite)), unrouted = discoverBrowserSuites(root).filter(suite => !routed.has(suite));
if (unrouted.length) throw new Error('Unrouted browser suites: ' + unrouted.join(', '));
const routes = browserSuiteRoutes.filter(route => (!options.class || route.class === options.class) && (!options.only.length || options.only.some(part => route.suite.includes(part))));

const minutes = (n: number) => n * 60_000;
const timeoutOf = (route: SuiteRoute) => route.timeoutMs ?? (route.class === 'native' ? minutes(15) : minutes(5));
const fixtureEnv: Record<string, string> = {'research-ui': 'TEN98_SWEEP_RESEARCH_UI_ENV', 'conversions-ui': 'TEN98_SWEEP_CONVERSIONS_UI_ENV'};
const how = (route: SuiteRoute) => {
  if (route.class === 'native' && route.harness === 'native-browser') return ['native-browser', ...(route.port ? ['port=' + route.port] : []), ...route.runner ?? [], ...route.flags ?? []].join(' ');
  if (route.class === 'native') return `${route.harness} fixture via $${fixtureEnv[route.harness ?? '']}`;
  return [...route.flags ?? [], ...(route.evidence ?? []).map(name => '$' + name)].join(' ') || '(no opt-in flag)';
};
const table = (headers: string[], rows: string[][]) => {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index].length)));
  const line = (row: string[]) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index])).join(' | ');
  return [line(headers), widths.map(width => '-'.repeat(width)).join('-|-'), ...rows.map(line)].join('\n');
};
const counts = (list: string[]) => [...list.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map<string, number>())].map(([key, n]) => `${key} ${n}`).join(', ');

if (options.list) {
  console.log(table(['Suite', 'Class', 'Runs with', 'Prerequisite / note'], routes.map(route => [route.suite.replace(/^tests\//, ''), route.class, how(route),
    route.blocked ? 'SKIPPED always: ' + route.blocked : route.note ?? (route.harness === 'native-browser' ? 'built .output + local PostgreSQL' : route.class === 'native' ? 'seeded harness fixture + preload web process (README)' : '')])));
  console.log(`\n${routes.length} routed suites: ${counts(routes.map(route => route.class))}.`);
  process.exit(0);
}

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to the installed Playwright entry (and PLAYWRIGHT_CHANNEL, e.g. chromium).');

// Native prerequisites are probed once; a missing one skips those suites with the reason instead of failing them.
const nativeBlocker = await (async (): Promise<string | null> => {
  if (!existsSync('.output/server/index.mjs')) return 'no built .output/server/index.mjs (run pnpm build)';
  const postgres = new URL(process.env.NATIVE_BROWSER_POSTGRES ?? 'postgres://ten98@127.0.0.1:5432');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(postgres.hostname)) return 'NATIVE_BROWSER_POSTGRES must be a local throwaway server';
  const reachable = await new Promise<boolean>(done => {
    const socket = connect(Number(postgres.port || 5432), postgres.hostname.replace(/^\[|\]$/g, ''));
    const finish = (ok: boolean) => { socket.destroy(); done(ok); };
    socket.setTimeout(2000, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
  return reachable ? null : `no PostgreSQL at ${postgres.host} (NATIVE_BROWSER_POSTGRES)`;
})();

function plan(route: SuiteRoute): Plan {
  const flagEnv = Object.fromEntries((route.flags ?? []).map(flag => [flag, '1']));
  if (route.class === 'evidence-gated') {
    if (route.blocked) return {skip: route.blocked};
    const missing = (route.evidence ?? []).filter(name => !process.env[name] || !existsSync(process.env[name]));
    if (missing.length) return {skip: `${route.note}; missing ${missing.join(', ')}`};
    return {argv: [route.suite], env: flagEnv};
  }
  if (route.class === 'component') return {argv: [route.suite], env: flagEnv};
  if (route.harness === 'native-browser') {
    if (nativeBlocker) return {skip: nativeBlocker};
    return {argv: ['tests/helpers/native-browser.mjs', ...route.runner ?? [], route.suite, ...route.flags ?? []], env: route.port ? {NATIVE_BROWSER_PORT: String(route.port)} : {}, group: 'native'};
  }
  const harness = route.harness ?? '', file = process.env[fixtureEnv[harness]];
  if (!file || !existsSync(file)) return {skip: `set ${fixtureEnv[harness]} to the seeded ${harness} env file with its preload web process running`};
  const preload = harness === 'conversions-ui' ? ['--import=./tests/conversions-ui/preload.mjs'] : [];
  return {argv: ['--env-file=' + file, ...preload, route.suite], env: {}, group: harness};
}

const run = new Date().toISOString().replace(/[:.]/g, '-'), logDir = resolve('private/browser-sweep', run);
mkdirSync(logDir, {recursive: true});
const firstError = (text: string) => {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean), own = lines.filter(line => !/^\[(server|worker)\]/.test(line));
  const hit = own.find(line => /^(\w*Error\b|Error \[)/.test(line)) ?? own.find(line => /\b\w*Error\b|ERR_|✖|not ok|\bfailed\b/i.test(line)) ?? own.at(-1) ?? lines.at(-1) ?? 'no output';
  return hit.length > 200 ? hit.slice(0, 197) + '...' : hit;
};
const killGroup = (child: ChildProcess, signal: NodeJS.Signals) => { try { if (process.platform === 'win32' || child.pid === undefined) child.kill(signal); else process.kill(-child.pid, signal); } catch {} };
const live = new Map<ChildProcess, {route: SuiteRoute; timers: NodeJS.Timeout[]}>();
// SIGTERM first so native-browser.mjs reaches its `finally` and drops its database, then SIGKILL whatever is left of the group.
const stop = (child: ChildProcess, route: SuiteRoute) => { for (const {signal, afterMs} of stopSequence(route)) live.get(child)?.timers.push(setTimeout(() => killGroup(child, signal), afterMs)); };
let stopping: 'SIGINT' | 'SIGTERM' | null = null;

function execute(route: SuiteRoute, {argv, env}: {argv: string[]; env: Record<string, string>}) {
  return new Promise<Outcome>(done => {
    const started = Date.now(), log = createWriteStream(resolve(logDir, route.suite.replace(/^tests\//, '').replaceAll('/', '__') + '.log'));
    let output = '', timedOut = false;
    const child = spawn(process.execPath, argv, {cwd: root, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'});
    live.set(child, {route, timers: []});
    // Both pipes stay drained until the child closes, so a full or broken pipe never stops the runner before its cleanup.
    const collect = (chunk: Buffer) => { log.write(chunk); if (output.length < 4_000_000) output += chunk; };
    child.stdout?.on('data', collect); child.stderr?.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; stop(child, route); }, timeoutOf(route));
    child.on('close', code => {
      clearTimeout(timer); for (const pending of live.get(child)?.timers ?? []) clearTimeout(pending); live.delete(child); log.end();
      const seconds = Math.round((Date.now() - started) / 1000);
      if (stopping) return done({result: 'FAIL', detail: `stopped by ${stopping}: ${firstError(output)}`, seconds});
      if (timedOut) return done({result: 'FAIL', detail: `timed out after ${timeoutOf(route) / 1000}s: ${firstError(output)}`, seconds});
      done(code === 0 ? {result: 'PASS', detail: '', seconds} : {result: 'FAIL', detail: `exit ${code}: ${firstError(output)}`, seconds});
    });
  });
}

const results = new Map<string, Outcome>(), queue = routes.map(route => ({route, plan: plan(route)})), busy = new Set<string>();
for (const {route, plan: work} of queue) if (work.skip !== undefined) results.set(route.suite, {result: 'SKIPPED', detail: work.skip, seconds: 0});
const pending = queue.flatMap(({route, plan: work}) => work.skip === undefined ? [{route, work}] : []), ran = pending.length;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = signal; console.error(`\n${signal}: stopping ${live.size} running suite(s); native runners get time to drop their databases.`);
  for (const {route} of pending.splice(0)) results.set(route.suite, {result: 'SKIPPED', detail: `not run: sweep stopped by ${signal}`, seconds: 0});
  for (const [child, {route}] of live) stop(child, route);
});
console.log(`Browser sweep ${run}: ${routes.length} suites, ${ran} to run, --jobs ${options.jobs}. Logs: ${logDir}`);
if (!ran) console.warn('WARNING: every selected suite was skipped; nothing ran.');
await new Promise<void>(finish => {
  let running = 0;
  const next = () => {
    if (!pending.length && !running) return finish();
    while (running < options.jobs) {
      const index = pending.findIndex(item => !item.work.group || !busy.has(item.work.group));
      if (index < 0) return;
      const [{route, work}] = pending.splice(index, 1);
      running++; if (work.group) busy.add(work.group);
      void execute(route, work).then(outcome => {
        results.set(route.suite, outcome); running--; if (work.group) busy.delete(work.group);
        console.log(`${outcome.result.padEnd(4)} ${route.suite} (${outcome.seconds}s)`);
        next();
      });
    }
  };
  next();
});

const rows = routes.map(route => { const {result, detail, seconds} = results.get(route.suite)!; return [route.suite.replace(/^tests\//, ''), route.class, result, result === 'SKIPPED' ? '' : seconds + 's', detail]; });
console.log('\n' + table(['Suite', 'Class', 'Result', 'Time', 'Detail'], rows));
console.log(`\n${counts(rows.map(row => row[2]))}.`);
process.exitCode = stopping ? signalExitCode(stopping) : rows.some(row => row[2] === 'FAIL') || options.requireRun && !ran ? 1 : 0;
