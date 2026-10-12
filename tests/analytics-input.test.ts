import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDimensions, normalizeProperties } from '../src/server/analytics-input.ts';
import { InputError } from '../src/server/validation.ts';

function rejects(run: () => unknown) {
  assert.throws(run, (error: unknown) => error instanceof InputError && error.status === 400 && !error.message.includes('secret-sentinel'));
}

test('properties preserve primitive types, empty values and distinct escaped paths', () => {
  const result = normalizeProperties({
    label: '', amount: 12.3456789, enabled: false, empty: null, nested: { count: 2 },
    'nested.count': 3, 'nested\\count': 4, nothing: {},
  });
  assert.deepEqual(result, {
    label: { type: 'string', value: '' }, amount: { type: 'number', value: 12.3456789 },
    enabled: { type: 'boolean', value: false }, empty: { type: 'null', value: null },
    'nested.count': { type: 'number', value: 2 }, 'nested\\.count': { type: 'number', value: 3 },
    'nested\\\\count': { type: 'number', value: 4 },
  });
  assert.deepEqual(normalizeProperties({}), {});
  assert.deepEqual(normalizeProperties({ a: { b: {} } }), {});
});

test('RFC3339 dates normalize offsets without calendar rollover or fractional precision loss', () => {
  const valid = {
    offset: '2024-02-29T23:10:20.123456+04:00', leap: '2000-02-29t00:00:00z',
    young: '0099-01-01T00:00:00Z', short: '2024-01-01T01:00:00.1+01:00',
    midnight: '2024-03-01T00:20:00+01:00', zero: '0000-02-29T00:00:00Z',
  };
  assert.deepEqual(normalizeProperties(valid), {
    offset: { type: 'date', value: '2024-02-29T19:10:20.123456Z' },
    leap: { type: 'date', value: '2000-02-29T00:00:00.000Z' },
    young: { type: 'date', value: '0099-01-01T00:00:00.000Z' },
    short: { type: 'date', value: '2024-01-01T00:00:00.100Z' },
    midnight: { type: 'date', value: '2024-02-29T23:20:00.000Z' },
    zero: { type: 'date', value: '0000-02-29T00:00:00.000Z' },
  });
  for (const value of [
    '2023-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2024-04-31T00:00:00Z',
    '2024-01-01T24:00:00Z', '2024-01-01T00:00:60Z', '2024-01-01T00:00:00+24:00',
    '2024-01-01T00:00:00+00:60', '2024-01-01T00:00:00', '2024-01-01',
    '2024-01-01T00:00:00-00:00', '9999-12-31T23:59:59-01:00', '0000-01-01T00:00:00+01:00',
    '2024-01-01T00:00:00Z\n', '2024-01-01T00:00:00Z\r',
  ]) assert.deepEqual(normalizeProperties({ when: value }), { when: { type: 'string', value } });
});

test('arrays remain cloned primitive arrays and reject nested or sparse values', () => {
  const values = [null, true, 0, '2024-01-01T00:00:00Z'];
  const result = normalizeProperties({ values });
  assert.deepEqual(result.values, { type: 'array', value: values });
  assert.notEqual(result.values.value, values);
  values.push('later');
  assert.equal((result.values.value as unknown[]).length, 4);
  assert.equal((normalizeProperties({ values: Array(50).fill(null) }).values.value as unknown[]).length, 50);
  for (const value of [[{}], [[]], [undefined], [Infinity], Array(1), Array(51).fill(null)]) {
    rejects(() => normalizeProperties({ value }));
  }
});

test('properties enforce leaf, depth, key and escaped-path limits', () => {
  assert.equal(Object.keys(normalizeProperties(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, i])))).length, 50);
  rejects(() => normalizeProperties(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`p${i}`, i]))));
  assert.deepEqual(normalizeProperties({ a: { b: { c: { d: 1 } } } }), { 'a.b.c.d': { type: 'number', value: 1 } });
  rejects(() => normalizeProperties({ a: { b: { c: { d: {} } } } }));
  assert.ok(normalizeProperties({ ['x'.repeat(80)]: 1 }));
  rejects(() => normalizeProperties({ ['x'.repeat(81)]: 1 }));
  rejects(() => normalizeProperties({ '': 1 }));
  rejects(() => normalizeProperties({ ['.'.repeat(80)]: { ['.'.repeat(80)]: 1 } }));
});

test('UTF-8 budgets apply to arrays and entire properties, with inclusive boundaries', () => {
  const small = { a: 'x'.repeat(1000) };
  assert.ok(normalizeProperties(small));
  rejects(() => normalizeProperties({ a: 'x'.repeat(1001) }));
  const exactArray = ['x'.repeat(1000), 'x'.repeat(1000), 'x'.repeat(1000), 'x'.repeat(1000), 'x'.repeat(80)];
  assert.equal(Buffer.byteLength(JSON.stringify(exactArray)), 4096);
  assert.ok(normalizeProperties({ values: exactArray }));
  rejects(() => normalizeProperties({ values: [...exactArray.slice(0, 4), 'x'.repeat(81)] }));
  rejects(() => normalizeProperties({ values: Array(3).fill('é'.repeat(700)) }));
  const exact = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, 'x'.repeat(1000)]));
  exact.tail = 'x'.repeat(6144 - Buffer.byteLength(JSON.stringify({ ...exact, tail: '' })));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 6144);
  assert.ok(normalizeProperties(exact));
  rejects(() => normalizeProperties({ ...exact, tail: exact.tail + 'x' }));
  rejects(() => normalizeProperties({ a: 'é'.repeat(1000), b: 'é'.repeat(1000), c: 'é'.repeat(1000), d: 'é'.repeat(1000) }));
});

test('properties reject invalid numbers, non-JSON roots and prototype keys', () => {
  assert.equal(normalizeProperties({ a: 1e15, b: -1e15 }).a.value, 1e15);
  for (const value of [NaN, Infinity, -Infinity, 1e15 + 1, undefined, 1n, Symbol('secret-sentinel'), () => 1]) {
    rejects(() => normalizeProperties({ value }));
  }
  for (const value of [null, undefined, [], 1, 'secret-sentinel', new Date(), new Map()]) rejects(() => normalizeProperties(value));
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    rejects(() => normalizeProperties(JSON.parse(`{"nested":{"${key}":"secret-sentinel"}}`)));
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  rejects(() => normalizeProperties(cycle));
  assert.deepEqual(normalizeProperties(Object.assign(Object.create(null), { fine: 1 })), { fine: { type: 'number', value: 1 } });
});

test('normalization never invokes accessor or serialization callbacks', () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, 'secret-sentinel', { enumerable: true, get() { calls++; return 'secret-sentinel'; } });
  rejects(() => normalizeProperties(accessor));
  rejects(() => normalizeProperties({ nested: accessor }));
  rejects(() => normalizeProperties({ toJSON() { calls++; return {}; } }));
  rejects(() => normalizeProperties(Object.defineProperty({}, 'hidden', { get() { calls++; return 'secret-sentinel'; } })));
  const arrayAccessor = Object.defineProperty(['value'], '0', { get() { calls++; return 'secret-sentinel'; } });
  rejects(() => normalizeProperties({ values: arrayAccessor }));
  for (const value of [[], {}]) {
    Object.defineProperty(value, 'toJSON', { value() { calls++; return 'secret-sentinel'; } });
    rejects(() => normalizeProperties({ value }));
  }
  const proxy = new Proxy({}, { getPrototypeOf() { calls++; return Object.prototype; } });
  rejects(() => normalizeProperties(proxy));
  rejects(() => normalizeDimensions(proxy));
  rejects(() => normalizeDimensions(accessor));
  rejects(() => normalizeDimensions({ screen: Object.defineProperty({ height: 2 }, 'width', { enumerable: true, get() { calls++; return 1; } }) }));
  assert.equal(calls, 0);
});

test('properties and dimensions reject strings PostgreSQL cannot store as JSONB', () => {
  for (const value of ['bad\u0000value', 'bad\ud800value', 'bad\udc00value']) {
    rejects(() => normalizeProperties({ value }));
    rejects(() => normalizeProperties({ values: [value] }));
    rejects(() => normalizeProperties({ [value]: 1 }));
    rejects(() => normalizeDimensions({ campaign: { source: value } }));
    rejects(() => normalizeDimensions({ distinctId: value }));
    rejects(() => normalizeDimensions({ referrer: `https://example.test/${value}` }));
  }
  assert.equal(normalizeProperties({ emoji: '\ud83d\ude00' }).emoji.value, '😀');
});

test('dimensions retain only configured public metadata and normalized referrer hostname', () => {
  const input = {
    referrer: 'https://BÜCHER.example:8443/private?secret-sentinel=1#secret-sentinel', language: 'en-us',
    screen: { width: 1920, height: 1080 }, campaign: { source: 'newsletter', term: '' }, distinctId: ' customer-1 ',
  };
  assert.deepEqual(normalizeDimensions(input), {
    referrerHost: 'xn--bcher-kva.example', language: 'en-US', screenWidth: 1920, screenHeight: 1080,
    campaign: { source: 'newsletter', term: '' }, distinctId: ' customer-1 ',
  });
  assert.deepEqual(normalizeDimensions({}), {});
  assert.deepEqual(normalizeDimensions({ campaign: {} }), { campaign: {} });
  assert.equal(input.referrer.includes('/private?'), true);
});

test('dimension fields are strict at every nesting level', () => {
  for (const input of [
    { ip: 'secret-sentinel' }, { userAgent: 'secret-sentinel' }, { referrerHost: 'example.test' },
    { screen: { width: 100, height: 100, extra: true } }, { campaign: { unexpected: 'secret-sentinel' } },
    { referrer: undefined }, { language: null }, { screen: [] }, { campaign: null }, null, [],
    JSON.parse('{"__proto__":{"secret-sentinel":true}}'),
  ]) rejects(() => normalizeDimensions(input));
});

test('referrer validation cannot retain userinfo or normalize malformed/control-filled URLs', () => {
  for (const referrer of [
    'javascript:secret-sentinel', 'ftp://example.test/', '/relative', 'https://user:secret-sentinel@example.test',
    ' https://example.test', 'https://example.test\n/private', 'https://example.test/' + 'x'.repeat(2048), '',
  ]) rejects(() => normalizeDimensions({ referrer }));
  assert.deepEqual(normalizeDimensions({ referrer: 'http://localhost:3000/path' }), { referrerHost: 'localhost' });
});

test('locale, screen, campaign and identity limits preserve valid boundary values', () => {
  assert.equal(normalizeDimensions({ language: 'zh-hant-tw' }).language, 'zh-Hant-TW');
  assert.equal(normalizeDimensions({ screen: { width: 1, height: 10000 } }).screenHeight, 10000);
  assert.equal(normalizeDimensions({ campaign: { source: 'x'.repeat(200) } }).campaign?.source?.length, 200);
  assert.equal(normalizeDimensions({ distinctId: 'x'.repeat(256) }).distinctId?.length, 256);
  for (const input of [
    { language: 'en_US' }, { language: ' en-US' }, { language: 'x'.repeat(101) },
    { screen: { width: 0, height: 1 } }, { screen: { width: 1, height: 10001 } },
    { screen: { width: 1.5, height: 1 } }, { screen: { width: 1 } },
    { campaign: { source: 1 } }, { campaign: { source: 'x'.repeat(201) } },
    { distinctId: '' }, { distinctId: 'x'.repeat(257) }, { distinctId: 'secret-sentinel\n' },
  ]) rejects(() => normalizeDimensions(input));
});
