import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleImportInput, googleReportRequest, normalizeGoogleReport, safeGoogleString } from '../src/server/google-reports.ts';

test('Google dates, scope and request bounds preserve provider calendar semantics', () => {
  const input = { requestId: 'cd81b617-b38c-4b15-9d63-49332908d09a', report: 'gsc_daily', from: '2024-02-29', to: '2024-03-01' };
  assert.equal(googleImportInput.safeParse(input).success, true);
  for (const range of [{ from: '2023-02-29' }, { to: '2024-02-28' }, { to: '2025-03-01' }, { to: '9999-12-31' }]) assert.equal(googleImportInput.safeParse({ ...input, ...range }).success, false);
  for (const value of ['bad\0text', '\ud800']) assert.equal(safeGoogleString(50).safeParse(value).success, false);
  const gsc = googleReportRequest('gsc_daily', input.from, input.to, 1000);
  assert.equal(gsc.startDate, input.from); assert.equal(gsc.dataState, 'final'); assert.equal(gsc.startRow, 1000); assert.equal(gsc.rowLimit, 1000);
  const ga4 = googleReportRequest('ga4_events', input.from, input.to, 2000);
  assert.equal(ga4.offset, '2000'); assert.equal(ga4.limit, '1000'); assert.equal(ga4.returnPropertyQuota, true);
});

test('GSC keeps unknown position and absent rows distinct from zero', () => {
  const row = normalizeGoogleReport('gsc_daily', { rows: [{ keys: ['2024-03-01'], clicks: 0, impressions: 10, ctr: 0 }] }, '2024-03-01', '2024-03-01');
  assert.equal(row.rows[0].metrics.clicks, '0'); assert.equal(row.rows[0].metrics.position, null); assert.equal(row.quality.metadata.timeZone, 'America/Los_Angeles');
  assert.equal(normalizeGoogleReport('gsc_daily', {}, '2024-03-01', '2024-03-01').rows.length, 0);
  for (const invalid of [{ keys: ['2024-02-29'], clicks: 1, impressions: 10, ctr: .1 }, { keys: ['2024-03-01'], clicks: -1, impressions: 10, ctr: 0 }, { keys: [], clicks: 1, impressions: 10, ctr: 0 }]) assert.throws(() => normalizeGoogleReport('gsc_daily', { rows: [invalid] }, '2024-03-01', '2024-03-01'), { status: 502 });
});

test('GA4 preserves exact metric strings, restrictions and quality; rejects confused report schemas', () => {
  const input = { dimensionHeaders: [{ name: 'date' }, { name: 'eventName' }], metricHeaders: [{ name: 'eventCount' }, { name: 'keyEvents' }, { name: 'totalUsers' }],
    rows: [{ dimensionValues: [{ value: '20240301' }, { value: 'signup' }], metricValues: [{ value: '9007199254740993' }, { value: '0' }, { value: '4' }] }], rowCount: 1,
    metadata: { timeZone: 'Asia/Dubai', subjectToThresholding: true, dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }], schemaRestrictionResponse: { activeMetricRestrictions: [{ metricName: 'keyEvents', restrictedMetricTypes: ['REVENUE_DATA'] }] } } };
  const page = normalizeGoogleReport('ga4_events', input, '2024-03-01', '2024-03-01');
  assert.equal(page.rows[0].dimensions.date, '2024-03-01'); assert.equal(page.rows[0].metrics.eventCount, '9007199254740993'); assert.equal(page.rows[0].metrics.keyEvents, null); assert.equal(page.quality.warnings.length, 4);
  assert.throws(() => normalizeGoogleReport('ga4_traffic', input, '2024-03-01', '2024-03-01'), { status: 502 });
  assert.throws(() => normalizeGoogleReport('ga4_events', { ...input, rows: [...input.rows, ...input.rows] }, '2024-03-01', '2024-03-01'), { status: 502 });
  assert.throws(() => normalizeGoogleReport('ga4_events', { ...input, rows: [{ ...input.rows[0], metricValues: [{ value: '' }, { value: '0' }, { value: '1' }] }] }, '2024-03-01', '2024-03-01'), { status: 502 });
  assert.throws(() => normalizeGoogleReport('ga4_events', { ...input, rows: [{ ...input.rows[0], metricValues: [{ value: '1\n' }, { value: '0' }, { value: '1' }] }] }, '2024-03-01', '2024-03-01'), { status: 502 });
  assert.deepEqual(normalizeGoogleReport('ga4_events', {}, '2024-03-01', '2024-03-01').rows, []);
});
