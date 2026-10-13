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
