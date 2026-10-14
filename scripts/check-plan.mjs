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
// Frozen V1 requirement identity/provenance, not a live Docmost content or implementation-status check.
const baseline = {
  url: 'https://wiki.ten98.io/s/ten98-docs/p/parity-1fPLxG5kX5',
  sourceCommit: 'dcd1b3de5f7e0600c6b459e6b20f08b072106097',
  sourceSha256: '5c46f2c52bea7cb2ab2f99e17727751864e157667a452dc6d0d1cb1b79f2197c',
  ids: 'P01 P02 P03 P04 P05 P06 P07 P08 P09 P10 P11 P12 P13 P14 P15 P16 P17 P18 P19 P20 P21 P22 P23 P24 P25 P26 P27 P28 P29 P30 P31 P32 P33 P34 P35 P36 P37 P38 P39 P40 P41 P42 P43 P44 P45 P46 P47 P48 P49 P50 P51 P52 P53 P54 P55 P56 P57 P58 P59 P60 P61 P62 P63 P64 P65 P66 P67 P68 P69 P70 P71 P72 P73 P74 P75 P76 P77 P78 P79 P80 P81'.split(' '),
};
assert.deepEqual(baseline.ids, Array.from({ length: 81 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`), 'Update the explicit frozen baseline when adding/removing requirements');
assert.ok(readFileSync(resolve(root, 'README.md'), 'utf8').includes(baseline.url), 'README must link the canonical requirement register');
assert.match(readFileSync(resolve(root, 'README.md'), 'utf8'), /development foundation; not a V1 release/);
const profile = readFileSync(resolve(root, 'agents/kimi-text-only.md'), 'utf8');
assert.match(profile, /^tools: \[\]$/m);
assert.match(profile, /^subagents: \[\]$/m);
assert.ok(existsSync(resolve(root, 'LICENSE')));
console.log(`Plan checks passed: ${files.length} Markdown files, 81 frozen V1 requirement IDs / pinned Docmost reference, local files/heading links, code fences, no-tool Kimi profile (Docmost content not checked).`);
