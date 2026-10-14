import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as React from 'react';
import type { RankTrackingFieldsProps } from '../src/components/RankTrackingFields.tsx';

// Node's native TS runtime does not parse JSX. Use the already-installed JSX transform
// for this stateless leaf, then inspect its actual React elements and handlers.
const source = await readFile(new URL('../src/components/RankTrackingFields.tsx', import.meta.url), 'utf8');
const compiled = (await transformWithOxc(source, 'RankTrackingFields.tsx', { jsx: { runtime: 'automatic' } })).code;
const moduleText = compiled.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')));
const { RankTrackingFields } = await import('data:text/javascript;base64,' + Buffer.from(moduleText).toString('base64')) as {
  RankTrackingFields: (props: RankTrackingFieldsProps) => React.JSX.Element;
};
type Element = React.ReactElement<Record<string, any>>;
function nodes(node: any): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object' || !node.props) return [];
  return [node, ...nodes(node.props.children)];
}
function fixture(overrides: Partial<RankTrackingFieldsProps> = {}) {
  const changes: RankTrackingFieldsProps['value'][] = [], queries: string[] = [];
  const calls = { search: 0, more: 0 };
  const props: RankTrackingFieldsProps = {
    value: { domain: 'ExAmple.COM ', countryLocationCode: '2840', targeting: 'local', localLocationCode: '100', languageCode: 'fr', devices: 'both', depth: 30, maxCrawlPages: 7 },
    countries: [{ code: '2840', label: 'United States' }, { code: '250', label: 'France' }],
    localLocations: { query: 'New', options: [{ code: '100', label: 'New York' }], loading: false, error: null, hasMore: true },
    languages: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }],
    errors: {}, disabled: false, prefix: 'fixture-', onChange: value => changes.push(value), onLocalQueryChange: query => queries.push(query),
    onSearchLocalLocations: () => { calls.search++; }, onLoadMoreLocalLocations: () => { calls.more++; }, ...overrides,
  };
  Object.freeze(props.value);
  const tree = RankTrackingFields(props), all = nodes(tree);
  const field = (name: string) => { const found = all.find(node => node.props.id === props.prefix + name); assert.ok(found, name); return found; };
  return { props, tree, all, field, changes, queries, calls };
}

test('rank fields preserve controlled raw values, complete catalogs and independent depth/page cap', () => {
  const f = fixture(); assert.equal(f.changes.length, 0); assert.equal(f.calls.search, 0);
  assert.equal(f.field('domain').props.value, 'ExAmple.COM ');
  assert.equal(f.field('domain').props.maxLength, 253);
  assert.deepEqual(nodes(f.field('countryLocationCode')).filter(node => node.type === 'option').map(node => node.props.value), ['', '2840', '250']);
  for (const [name, value] of [['domain', ' Raw.EXAMPLE '], ['languageCode', 'en'], ['devices', 'mobile'], ['depth', '100'], ['maxCrawlPages', '1']] as const) {
    f.field(name).props.onChange({ currentTarget: { value } });
    const actual = f.changes.at(-1)!;
    assert.notEqual(actual, f.props.value);
    assert.deepEqual(actual, { ...f.props.value, [name]: name === 'depth' || name === 'maxCrawlPages' ? Number(value) : value });
  }
  f.field('localLocationQuery').props.onChange({ currentTarget: { value: '  raw query  ' } });
  assert.deepEqual(f.queries, ['  raw query  ']); assert.equal(f.changes.length, 5);
});

test('country and targeting transitions clear local selection in exactly one immutable update', () => {
  for (const code of ['250', '']) {
    const f = fixture(); f.field('countryLocationCode').props.onChange({ currentTarget: { value: code } });
    assert.deepEqual(f.changes, [{ ...f.props.value, countryLocationCode: code, localLocationCode: '' }]);
  }
  for (const targeting of ['national', 'local']) {
    const f = fixture(); f.field('targeting').props.onChange({ currentTarget: { value: targeting } });
    assert.deepEqual(f.changes, [{ ...f.props.value, targeting, localLocationCode: '' }]);
  }
});

test('no-country and national states suppress obsolete local errors and validation', () => {
  for (const targeting of ['national', 'local'] as const) {
    const base = fixture(); const f = fixture({ value: { ...base.props.value, countryLocationCode: '', targeting }, errors: { localLocationCode: 'stale validation' }, localLocations: { ...base.props.localLocations, error: 'stale search failure' } });
    const html = renderToStaticMarkup(f.tree);
    assert.ok(!html.includes('stale validation') && !html.includes('stale search failure'));
    if (targeting === 'local') {
      assert.equal(f.field('localLocationCode').props.disabled, true);
      assert.equal(f.field('localLocationCode').props['aria-invalid'], undefined);
      assert.match(html, /Choose a country or territory first\./);
    } else assert.ok(!html.includes('Find a city or region'));
  }
});

test('local Enter prevents implicit submit and searches once only when enabled and not composing', () => {
  for (const disabled of [false, true]) for (const country of ['', '2840']) for (const loading of [false, true]) for (const composing of [false, true]) {
    const base = fixture(), f = fixture({ disabled, value: { ...base.props.value, countryLocationCode: country }, localLocations: { ...base.props.localLocations, loading } });
    let prevented = 0;
    f.field('localLocationQuery').props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: composing }, preventDefault: () => { prevented++; } });
    assert.equal(prevented, 1); assert.equal(f.calls.search, !disabled && !!country && !loading && !composing ? 1 : 0);
    assert.equal(f.field('localLocationQuery').props.disabled, !country, 'Typing stays available during loading unless the fieldset disables it.');
    assert.equal(f.tree.props.disabled, disabled);
    const buttons = f.all.filter(node => node.type === 'button');
    assert.ok(buttons.every(node => node.props.type === 'button' && node.props.disabled === (disabled || !country || loading)));
  }
});

test('status distinguishes loading, failure and empty searches; supplied strings stay inert', () => {
  const base = fixture();
  for (const [query, loading, error, expected] of [['', false, null, 'Search for a city or region.'], ['none', false, null, 'No locations match this search. Try another name.'], ['', true, null, 'Loading locations…'], ['', false, '<img src=x onerror=alert(1)>', '&lt;img']] as const) {
    const f = fixture({ localLocations: { query, options: [], loading, error, hasMore: false } });
    assert.ok(renderToStaticMarkup(f.tree).includes(expected));
    assert.ok(!renderToStaticMarkup(f.tree).includes('<img'));
  }
  const f = fixture({ localLocations: { ...base.props.localLocations, error: 'Try again' } });
  f.all.find(node => node.type === 'button' && node.props.children === 'Search locations')!.props.onClick();
  f.all.find(node => node.type === 'button' && node.props.children === 'Load more locations')!.props.onClick();
  assert.deepEqual(f.calls, { search: 1, more: 1 });
});

test('all hints and descriptions have unique scoped IDs; fieldset can shrink on mobile', () => {
  const first = fixture({ errors: { domain: 'Check this domain', depth: 'Choose depth' } }), second = fixture({ prefix: 'other-' });
  const all = [...first.all, ...second.all], ids = all.map(node => node.props.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  for (const node of all) {
    if (String(node.props.className).split(' ').includes('hint')) assert.ok(node.props.id, 'Every hint needs its deterministic ID.');
    for (const id of String(node.props['aria-describedby'] ?? '').split(' ').filter(Boolean)) assert.ok(ids.includes(id), id);
  }
  assert.equal(first.field('domain').props['aria-invalid'], true);
  assert.equal(first.tree.props.style?.minWidth, 0);
});
