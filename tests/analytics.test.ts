import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsRange } from '../src/server/analytics.ts';

test('analytics defaults and inclusive end are UTC regardless of DST', () => {
  assert.deepEqual(analyticsRange(new URLSearchParams(), new Date('2026-03-29T23:59:59Z')), {
    from: '2026-03-23', to: '2026-03-29', timeZone: 'UTC', start: '2026-03-23T00:00:00.000Z', end: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(analyticsRange(new URLSearchParams('from=2024-02-29&to=2024-02-29')).end, '2024-03-01T00:00:00.000Z');
  assert.equal(analyticsRange(new URLSearchParams('from=2024-01-01&to=2024-12-31')).to, '2024-12-31');
});

test('analytics rejects invalid, reversed, unbounded or ambiguous ranges', () => {
  for (const query of ['from=2026-01-01', 'from=2026-02-29&to=2026-03-01', 'from=2026-04-31&to=2026-05-01',
    'from=2026-1-01&to=2026-01-01', 'from=2026-01-02&to=2026-01-01', 'from=2024-01-01&to=2025-01-01',
    'from=0000-01-01&to=0000-01-02', 'from=9999-01-01&to=9999-01-02',
    'from=2026-01-01&from=2026-01-02&to=2026-01-02', 'range=all']) {
    assert.throws(() => analyticsRange(new URLSearchParams(query)), { status: 400 });
  }
});
