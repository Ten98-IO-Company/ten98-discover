import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';

// Heatmap collection and classic replay measure raw pointer geometry, so they keep a fine pointer at every width.
const finePointerSuites = new Set(['tests/heatmap-collector-browser.mjs', 'tests/heatmap-geometry-browser.mjs', 'tests/replay-heatmaps-classic-browser.mjs']);

function suites(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) return path === 'tests/helpers' ? [] : suites(path);
    return /\.(mjs|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test('Browser suites resize through setViewport, so phone widths get a touch pointer', () => {
  const direct = suites('tests').filter(file => !finePointerSuites.has(file) && file !== 'tests/viewport-touch.test.ts' && /\.setViewportSize\(/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(direct, [], 'Use setViewport from tests/helpers/playwright.mjs instead of page.setViewportSize.');
});

test('Phone-width browser contexts are created with touch', () => {
  const offenders = suites('tests').filter(file => !finePointerSuites.has(file)).flatMap(file => [...readFileSync(file, 'utf8').matchAll(/newContext\(\{[^;]*?viewport:\s*\{\s*width:\s*(\d+)[^;]*?\}\)/g)].filter(match => Number(match[1]) <= 760 && !/hasTouch:\s*true/.test(match[0])).map(match => file + ': ' + match[0].slice(0, 80)));
  assert.deepEqual(offenders, []);
});
