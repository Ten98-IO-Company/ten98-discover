import { z } from 'zod';
import { toUSVString } from 'node:util';
import { FoundationError } from './auth.ts';

export const googleScopes = { gsc: 'https://www.googleapis.com/auth/webmasters.readonly', ga4: 'https://www.googleapis.com/auth/analytics.readonly' } as const;
export const googleReports = {
  gsc_daily: { provider: 'gsc', dimensions: ['date'], metrics: ['clicks', 'impressions', 'ctr', 'position'] },
  gsc_queries: { provider: 'gsc', dimensions: ['date', 'query'], metrics: ['clicks', 'impressions', 'ctr', 'position'] },
  gsc_pages: { provider: 'gsc', dimensions: ['date', 'page'], metrics: ['clicks', 'impressions', 'ctr', 'position'] },
  ga4_traffic: { provider: 'ga4', dimensions: ['date', 'sessionDefaultChannelGroup'], metrics: ['sessions', 'totalUsers', 'screenPageViews', 'engagedSessions'] },
  ga4_events: { provider: 'ga4', dimensions: ['date', 'eventName'], metrics: ['eventCount', 'keyEvents', 'totalUsers'] },
} as const;
export type GoogleReport = keyof typeof googleReports;
export type GoogleProvider = keyof typeof googleScopes;
export type ReportRow = { dimensions: Record<string, string>; metrics: Record<string, string | null> };
export type ReportPage = { rows: ReportRow[]; rowCount: number | null; quality: { warnings: string[]; metadata: Record<string, unknown> } };
export const safeGoogleString = (max: number) => z.string().max(max).refine(value => !value.includes('\0') && toUSVString(value) === value);
export const googleDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
export const googleImportInput = z.object({ requestId: z.uuid(), report: z.enum(Object.keys(googleReports) as [GoogleReport, ...GoogleReport[]]), from: googleDate, to: googleDate }).strict().refine(value => {
  const difference = Date.parse(value.to) - Date.parse(value.from);
  return difference >= 0 && difference < 366 * 86_400_000 && value.to <= new Date().toISOString().slice(0, 10);
});
export function googleInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new FoundationError(400, 'Check the Google reporting fields and try again.');
  return parsed.data;
}

export function googleReportRequest(report: GoogleReport, from: string, to: string, offset: number) {
  const definition = googleReports[report];
  if (definition.provider === 'gsc') return { startDate: from, endDate: to, dimensions: definition.dimensions, type: 'web', dataState: 'final', aggregationType: 'auto', rowLimit: 1000, startRow: offset };
  return { dateRanges: [{ startDate: from, endDate: to }], dimensions: definition.dimensions.map(name => ({ name })), metrics: definition.metrics.map(name => ({ name })),
    orderBys: definition.dimensions.map(dimensionName => ({ dimension: { dimensionName } })), offset: String(offset), limit: '1000', returnPropertyQuota: true, keepEmptyRows: true };
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = safeGoogleString(4096);
const numeric = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$(?![\s\S])/).max(100).refine(value => Number.isFinite(Number(value)));
function malformed(): never { throw new FoundationError(502, 'Google returned a report that could not be safely interpreted.'); }
// Provider dimensions/metrics are explicitly selected above. No arbitrary query,
// source payload or user-level export is persisted or exposed through this adapter.
export function normalizeGoogleReport(report: GoogleReport, value: unknown, from: string, to: string): ReportPage {
  try {
    const definition = googleReports[report];
    let rows: ReportRow[], rowCount: number | null;
    const warnings: string[] = [], metadata: Record<string, unknown> = {};
    if (definition.provider === 'gsc') {
      const data = z.object({ rows: z.array(z.object({ keys: z.array(text), clicks: count, impressions: count, ctr: z.number().finite().min(0).max(1), position: z.number().finite().nonnegative().optional() })).max(1000).default([]), responseAggregationType: safeGoogleString(80).optional() }).parse(value);
      rows = data.rows.map(row => {
        if (row.keys.length !== definition.dimensions.length) malformed();
        return { dimensions: Object.fromEntries(definition.dimensions.map((name, i) => [name, row.keys[i]])), metrics: { clicks: String(row.clicks), impressions: String(row.impressions), ctr: String(row.ctr), position: row.position === undefined ? null : String(row.position) } };
      });
      rowCount = null;
      metadata.aggregationType = data.responseAggregationType ?? null;
      metadata.timeZone = 'America/Los_Angeles'; metadata.searchType = 'web'; metadata.dataState = 'final';
      warnings.push('Search Console returns top rows and may omit anonymized queries; missing rows are not zero.');
    } else {
      const restriction = z.object({ metricName: safeGoogleString(120), restrictedMetricTypes: z.array(safeGoogleString(80)).max(10).default([]) });
      const data = z.object({
        dimensionHeaders: z.array(z.object({ name: safeGoogleString(120) })).optional(), metricHeaders: z.array(z.object({ name: safeGoogleString(120) })).optional(),
        rows: z.array(z.object({ dimensionValues: z.array(z.object({ value: text })), metricValues: z.array(z.object({ value: numeric })) })).max(1000).default([]), rowCount: count.optional(),
        metadata: z.object({ timeZone: safeGoogleString(120).optional(), currencyCode: z.string().regex(/^[A-Z]{3}$(?![\s\S])/).optional(), emptyReason: safeGoogleString(1000).optional(),
          dataLossFromOtherRow: z.boolean().optional(), subjectToThresholding: z.boolean().optional(), samplingMetadatas: z.array(z.object({ samplesReadCount: z.string().regex(/^\d+$(?![\s\S])/).max(30), samplingSpaceSize: z.string().regex(/^\d+$(?![\s\S])/).max(30) })).max(5).optional(),
          schemaRestrictionResponse: z.object({ activeMetricRestrictions: z.array(restriction).max(30).optional() }).optional(),
          dataTruncationReasons: z.array(z.object({ dataTruncationType: safeGoogleString(120).optional(), dataTruncationMessage: safeGoogleString(2048).optional(), dataTruncationDate: googleDate.optional(),
            dataTruncationDateRanges: z.array(z.object({ startDate: googleDate, endDate: googleDate })).max(10).optional() })).max(20).optional(),
        }).optional(),
        propertyQuota: z.record(safeGoogleString(100), z.object({ consumed: count.optional(), remaining: count.optional() })).optional(),
      }).parse(value);
      const headerlessEmpty = data.dimensionHeaders === undefined && data.metricHeaders === undefined && !data.rows.length && !data.rowCount;
      if (!headerlessEmpty && (JSON.stringify(data.dimensionHeaders?.map(h => h.name)) !== JSON.stringify(definition.dimensions) || JSON.stringify(data.metricHeaders?.map(h => h.name)) !== JSON.stringify(definition.metrics))) malformed();
      const restricted = new Set(data.metadata?.schemaRestrictionResponse?.activeMetricRestrictions?.map(item => item.metricName));
      rows = data.rows.map(row => {
        if (row.dimensionValues.length !== definition.dimensions.length || row.metricValues.length !== definition.metrics.length) malformed();
        return { dimensions: Object.fromEntries(definition.dimensions.map((name, i) => [name, name === 'date' ? row.dimensionValues[i].value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : row.dimensionValues[i].value])),
          metrics: Object.fromEntries(definition.metrics.map((name, i) => [name, restricted.has(name) ? null : row.metricValues[i].value])) };
      });
      rowCount = data.rowCount ?? rows.length;
      Object.assign(metadata, data.metadata ?? {}, { quota: data.propertyQuota ?? null });
      if (data.metadata?.subjectToThresholding) warnings.push('Google may suppress rows below its privacy thresholds.');
      if (data.metadata?.dataLossFromOtherRow) warnings.push('Google groups some high-cardinality data into an other row.');
      if (data.metadata?.samplingMetadatas?.length) warnings.push('Google sampled this report; values are estimates.');
      if (restricted.size) warnings.push('Some metrics are restricted and shown as unavailable.');
      if (data.metadata?.dataTruncationReasons?.length) warnings.push('Google reports data truncation.');
      if (data.metadata?.emptyReason) warnings.push('Google supplied an empty-report reason; see report metadata.');
    }
    for (const row of rows) if (!googleDate.safeParse(row.dimensions.date).success || row.dimensions.date < from || row.dimensions.date > to) malformed();
    const keys = rows.map(row => JSON.stringify(row.dimensions));
    if (new Set(keys).size !== keys.length) malformed();
    return { rows, rowCount, quality: { warnings, metadata } };
  } catch { return malformed(); }
}
