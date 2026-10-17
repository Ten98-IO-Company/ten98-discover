import assert from 'node:assert/strict';
import test from 'node:test';
import { retentionCoverage, retentionSettingsInput } from '../src/server/retention.ts';

test('retention distinguishes complete, partial and unavailable windows at exact boundaries', () => {
  const cutoff = '2024-03-31T01:30:00.000Z';
  assert.deepEqual(retentionCoverage('2024-03-31T01:30:00.000Z', '2024-04-01T00:00:00.000Z', cutoff), { status: 'complete', retainedFrom: cutoff });
  assert.equal(retentionCoverage('2024-03-30T00:00:00.000Z', cutoff, cutoff).status, 'unavailable');
  assert.equal(retentionCoverage('2024-03-31T00:00:00.000Z', '2024-04-01T00:00:00.000Z', new Date(cutoff)).status, 'partial');
  assert.deepEqual(retentionCoverage('2024-02-29T00:00:00.000Z', '2024-03-01T00:00:00.000Z', null), { status: 'complete', retainedFrom: null });
});

test('retention validates complete bounded integer policies without coercion or unknown fields', () => {
  const valid = { rawAnalyticsDays: 90, replayDays: 7, rawProviderEvidenceDays: 90, derivedHistoryDays: 365 };
  assert.deepEqual(retentionSettingsInput.parse(valid), valid);
  for (const value of [0, -1, 3651, 1.5, '90', null, Infinity, NaN]) {
    assert.equal(retentionSettingsInput.safeParse({ ...valid, rawAnalyticsDays: value }).success, false);
  }
  assert.equal(retentionSettingsInput.safeParse({ ...valid, deleteReports: true }).success, false);
  assert.equal(retentionSettingsInput.safeParse({ rawAnalyticsDays: 90 }).success, false);
  for (const edge of [1, 3650]) assert.equal(retentionSettingsInput.safeParse({ ...valid, rawAnalyticsDays: edge }).success, true);
});

test('retention keeps microsecond cutoffs across UTC day and equal boundaries',()=>{
 const cutoff='2026-01-01T00:00:00.000900Z',before='2026-01-01T00:00:00.000899Z',after='2026-01-01T00:00:00.000901Z',end='2026-01-02T00:00:00.000Z';
 assert.deepEqual(retentionCoverage('2026-01-01T00:00:00.000Z',end,cutoff),{status:'partial',retainedFrom:cutoff});
 assert.equal(retentionCoverage(before,end,cutoff).status,'partial');
 assert.equal(retentionCoverage(cutoff,end,cutoff).status,'complete');
 assert.equal(retentionCoverage(after,end,cutoff).status,'complete');
 assert.equal(retentionCoverage('2025-12-31T00:00:00.000Z',before,cutoff).status,'unavailable');
 assert.equal(retentionCoverage('2025-12-31T00:00:00.000Z',cutoff,cutoff).status,'unavailable');
 assert.equal(retentionCoverage('2025-12-31T00:00:00.000Z',after,cutoff).status,'partial');
 assert.deepEqual(retentionCoverage('2026-01-01T00:00:00.000Z',end,'2026-01-01T04:00:00.000900+04:00'),{status:'partial',retainedFrom:cutoff});
 assert.equal(retentionCoverage('2026-01-01T00:00:00.000Z',end,new Date(cutoff)).status,'complete','A Date cannot recover a discarded fractional component.');
 assert.equal(retentionCoverage('2026-01-01T00:00:00.000Z',end,'2026-01-01T00:00:00.000000Z').retainedFrom,'2026-01-01T00:00:00.000Z','Exact millisecond wire values retain their original format.');
 assert.equal(retentionCoverage('1969-12-31T23:59:59.999899Z','1970-01-01T00:00:00.000Z','1969-12-31T23:59:59.999900Z').status,'partial');
});
