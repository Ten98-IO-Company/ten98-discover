import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['README.md', 'AGENTS.md', 'THIRD_PARTY_NOTICES.md', ...readdirSync(resolve(root, 'docs')).filter(n => n.endsWith('.md')).map(n => `docs/${n}`)];
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
const parity = readFileSync(resolve(root, 'docs/parity.md'), 'utf8');
const rows = parity.split('\n').filter(line => /^\| P\d{2} \|/.test(line));
assert.equal(rows.length, 81, 'Update the explicit parity baseline when adding/removing requirements');
assert.ok(parity.includes(rows.join('\n')), 'Requirement rows must remain in one continuous Markdown table');
const ids = rows.map(row => row.split('|')[1].trim());
assert.equal(new Set(ids).size, 81, 'Duplicate parity IDs');
for (let i = 1; i <= 81; i++) assert.ok(ids.includes(`P${String(i).padStart(2, '0')}`), `Missing P${i}`);
for (const row of rows) assert.match(row, /\| V1 \| planned \|\s*$/, 'Planning baseline must not claim implementation');
assert.match(readFileSync(resolve(root, 'README.md'), 'utf8'), /There is no application/);
const profile = readFileSync(resolve(root, 'agents/kimi-text-only.md'), 'utf8');
assert.match(profile, /^tools: \[\]$/m);
assert.match(profile, /^subagents: \[\]$/m);
assert.ok(existsSync(resolve(root, 'LICENSE')));
console.log(`Plan checks passed: ${files.length} Markdown files, 81 V1 requirements, local files/heading links, code fences, no-tool Kimi profile.`);
