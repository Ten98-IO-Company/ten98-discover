import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Documentation lives in the GitHub wiki. The repository keeps README, agent guidance, notices, agent profiles, test-harness
// READMEs and docs/ redirect stubs for paths that immutable migrations cite; every local link in them must resolve.
const markdownIn = dir => existsSync(resolve(root, dir)) ? readdirSync(resolve(root, dir)).filter(n => n.endsWith('.md')).map(n => `${dir}/${n}`) : [];
const harnessReadmes = readdirSync(resolve(root, 'tests'), { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(resolve(root, 'tests', d.name, 'README.md'))).map(d => `tests/${d.name}/README.md`);
const files = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'THIRD_PARTY_NOTICES.md', ...markdownIn('agents'), ...harnessReadmes, ...markdownIn('docs')];
const slug = title => title.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
assert.equal(slug('Proposed shared architecture — inference'), 'proposed-shared-architecture--inference');
const anchors = file => {
  const seen = new Set();
  for (const [, heading] of readFileSync(file, 'utf8').matchAll(/^#{1,6} (.+)$/gm)) {
    const base = slug(heading);
    let id = base;
    for (let n = 1; seen.has(id); n++) id = `${base}-${n}`;
    seen.add(id);
  }
  return seen;
};
for (const file of files) {
  const content = readFileSync(resolve(root, file), 'utf8');
  assert.equal((content.match(/^```/gm) ?? []).length % 2, 0, `${file}: unclosed code fence`);
  for (const [, target] of content.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [destination, fragment] = target.split('#').map(decodeURIComponent);
    const path = destination ? resolve(root, dirname(file), destination) : resolve(root, file);
    assert.ok(existsSync(path), `${file}: broken local link ${target}`);
    if (fragment) assert.ok(anchors(path).has(fragment), `${file}: broken heading link ${target}`);
  }
}
// Frozen V1 requirement identity/provenance, not a live Docmost content or implementation-status check.
const wiki = 'https://github.com/Ten98-IO-Company/ten98-discover/wiki';
const baseline = {
  url: 'https://wiki.ten98.io/s/ten98-docs/p/parity-1fPLxG5kX5',
  sourceCommit: 'dcd1b3de5f7e0600c6b459e6b20f08b072106097',
  sourceSha256: '5c46f2c52bea7cb2ab2f99e17727751864e157667a452dc6d0d1cb1b79f2197c',
  ids: 'P01 P02 P03 P04 P05 P06 P07 P08 P09 P10 P11 P12 P13 P14 P15 P16 P17 P18 P19 P20 P21 P22 P23 P24 P25 P26 P27 P28 P29 P30 P31 P32 P33 P34 P35 P36 P37 P38 P39 P40 P41 P42 P43 P44 P45 P46 P47 P48 P49 P50 P51 P52 P53 P54 P55 P56 P57 P58 P59 P60 P61 P62 P63 P64 P65 P66 P67 P68 P69 P70 P71 P72 P73 P74 P75 P76 P77 P78 P79 P80 P81'.split(' '),
};
assert.deepEqual(baseline.ids, Array.from({ length: 81 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`), 'Update the explicit frozen baseline when adding/removing requirements');
// Register map: every static implementation inventory entry belongs to at least one frozen requirement, and every mapped entry
// still exists. Inventories are the served OpenAPI document (bearer operations, public and browser cookie operations), the MCP
// tool catalog and the migration files; all three are import-safe without configuration, a database or a provider.
// ponytail: cookie routes that api.ts dispatches without an entry in openapi.ts's browser inventory are not guarded (the
// dispatcher has no route table); upgrade path is declaring every cookie route in x-ten98-browser-operations.
const { nativeOpenApi } = await import('../src/server/openapi.ts');
const { mcpTools } = await import('../src/server/mcp-tools.ts');
const inventory = {
  operations: new Set(Object.values(nativeOpenApi.paths).flatMap(item => Object.values(item).map(op => op.operationId))),
  routes: new Set(['x-ten98-public-operations', 'x-ten98-browser-operations'].flatMap(key => Object.entries(nativeOpenApi[key])
    .filter(([path]) => path.startsWith('/api/')).flatMap(([path, item]) => Object.keys(item).map(method => `${method.toUpperCase()} ${path}`)))),
  mcpTools: new Set(mcpTools.map(tool => tool.name)),
  migrations: new Set(readdirSync(resolve(root, 'migrations')).filter(name => name.endsWith('.sql')).map(name => name.slice(0, -4))),
};
const registerMap = JSON.parse(readFileSync(resolve(root, 'docs/register-map.json'), 'utf8'));
const mapped = Object.fromEntries(Object.keys(inventory).map(kind => [kind, new Set()]));
for (const [id, entry] of Object.entries(registerMap.requirements)) {
  assert.ok(baseline.ids.includes(id), `docs/register-map.json: unknown requirement ${id}`);
  for (const kind of Object.keys(inventory)) for (const key of entry[kind] ?? []) {
    assert.ok(inventory[kind].has(key), `docs/register-map.json: ${id} maps a ${kind} entry that no longer exists in source: ${key}`);
    mapped[kind].add(key);
  }
}
for (const kind of Object.keys(inventory)) for (const key of inventory[kind]) assert.ok(mapped[kind].has(key), `docs/register-map.json: unmapped ${kind} entry ${key}; add it to the requirement rows it implements`);
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
assert.ok(readme.includes(`${wiki})`), 'README must link the canonical GitHub wiki');
assert.match(readme, /development foundation; not a V1 release/);
assert.ok(!readme.includes('wiki.ten98.io'), 'README must not link Docmost; the GitHub wiki is canonical');
assert.ok(readFileSync(resolve(root, 'AGENTS.md'), 'utf8').includes(baseline.url), 'AGENTS.md must link the canonical requirement register');
// Moved docs: source, tests, scripts, configuration and migrations may cite a docs/*.md path only while it exists (a redirect
// stub keeps a path that an immutable migration cites). Everything else cites the wiki page.
const wikiPage = /https:\/\/github\.com\/Ten98-IO-Company\/ten98-discover\/wiki\/[A-Za-z0-9-]+/g;
const cited = new Map();
const scan = path => {
  for (const entry of readdirSync(resolve(root, path), { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) scan(child);
    else if (/\.(ts|tsx|mts|mjs|js|sql|sh|ya?ml)$/.test(entry.name) && !child.startsWith('public/')) cited.set(child, readFileSync(resolve(root, child), 'utf8'));
  }
};
for (const dir of ['src', 'tests', 'scripts', 'migrations']) scan(dir);
for (const file of readdirSync(root)) if (/^(\.env\.example|Dockerfile.*|compose.*\.ya?ml)$/.test(file)) cited.set(file, readFileSync(resolve(root, file), 'utf8'));
let wikiCitations = 0;
for (const [file, content] of cited) {
  for (const [path] of content.matchAll(/\bdocs\/[a-z0-9-]+\.md\b/g)) assert.ok(existsSync(resolve(root, path)), `${file}: cites deleted ${path}; cite the wiki page instead`);
  wikiCitations += (content.match(wikiPage) ?? []).length;
}
const profile = readFileSync(resolve(root, 'agents/kimi-text-only.md'), 'utf8');
assert.match(profile, /^tools: \[\]$/m);
assert.match(profile, /^subagents: \[\]$/m);
assert.ok(existsSync(resolve(root, 'LICENSE')));
console.log(`Plan checks passed: ${files.length} Markdown files, 81 frozen V1 requirement IDs / pinned Docmost reference, register map over ${inventory.operations.size} operations, ${inventory.routes.size} cookie routes, ${inventory.mcpTools.size} MCP tools and ${inventory.migrations.size} migrations, ${wikiCitations} wiki citations with no deleted docs/ path cited, local files/heading links, code fences, no-tool Kimi profile (wiki and Docmost content not checked).`);
