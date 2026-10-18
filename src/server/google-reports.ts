import { z } from 'zod';
import { toUSVString } from 'node:util';
import { FoundationError } from './auth.ts';
import { ga4CommerceReports, isGa4CommerceReport, googleCalendarWeek, googleGa4MetricInRange, googleLastCompletedDay } from '../lib/google-report-display.ts';

export const googleScopes = { gsc: 'https://www.googleapis.com/auth/webmasters.readonly', ga4: 'https://www.googleapis.com/auth/analytics.readonly' } as const;
const organicMetrics = ['sessions', 'activeUsers', 'engagedSessions', 'engagementRate', 'keyEvents', 'transactions', 'purchaseRevenue'] as const;
export const googleReports = {
  gsc_daily: { provider: 'gsc', dimensions: ['date'], metrics: ['clicks', 'impressions', 'ctr', 'position'] },
  gsc_queries: { provider: 'gsc', dimensions: ['date', 'query'], metrics: ['clicks', 'impressions', 'ctr', 'position'] },
  gsc_pages: { provider: 'gsc', dimensions: ['date', 'page'], metrics: ['clicks', 'impressions', 'ctr', 'position'] },
  ga4_traffic: { provider: 'ga4', dimensions: ['date', 'sessionDefaultChannelGroup'], metrics: ['sessions', 'totalUsers', 'screenPageViews', 'engagedSessions'] },
  ga4_events: { provider: 'ga4', dimensions: ['date', 'eventName'], metrics: ['eventCount', 'keyEvents', 'totalUsers'] },
  ga4_pages: { provider: 'ga4', dimensions: ['date', 'unifiedPagePathScreen'], metrics: ['screenPageViews', 'activeUsers', 'userEngagementDuration', 'eventCount', 'keyEvents', 'totalRevenue'] },
  ga4_acquisition: { provider: 'ga4', dimensions: ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName'], metrics: ['sessions', 'engagedSessions', 'totalUsers', 'eventCount', 'keyEvents', 'totalRevenue'] },
  ga4_key_events: { provider: 'ga4', dimensions: ['date', 'eventName', 'isKeyEvent'], metrics: ['eventCount', 'keyEvents', 'totalUsers', 'totalRevenue'] },
  ga4_organic_landing: { provider: 'ga4', dimensions: ['hostName', 'landingPage'], metrics: [...organicMetrics.slice(0, 5), 'sessionKeyEventRate', 'transactions', 'purchaseRevenue'] },
  ga4_organic_daily: { provider: 'ga4', dimensions: ['date'], metrics: organicMetrics },
  ga4_organic_weekly: { provider: 'ga4', dimensions: ['yearWeek'], metrics: organicMetrics },
  ...ga4CommerceReports,
} as const;
export type GoogleReport = keyof typeof googleReports;
export const ga4InventoryReports: readonly GoogleReport[] = ['ga4_pages', 'ga4_acquisition', 'ga4_key_events'];
export const ga4OrganicReports: readonly GoogleReport[] = ['ga4_organic_landing', 'ga4_organic_daily', 'ga4_organic_weekly'];
export const isDetailedGa4Report = (report: GoogleReport) => ga4InventoryReports.includes(report) || ga4OrganicReports.includes(report) || isGa4CommerceReport(report);
export const isOrganicOverview = (report: string) => report === 'ga4_organic_daily' || report === 'ga4_organic_weekly';
export type OrganicStage = 'current' | 'previous' | 'trend';
export type GoogleProvider = keyof typeof googleScopes;
export type ReportRow = { dimensions: Record<string, string>; metrics: Record<string, string | null> };
export type ReportPage = { rows: ReportRow[]; rowCount: number | null; quality: { warnings: string[]; metadata: Record<string, unknown> } };
export const safeGoogleString = (max: number) => z.string().max(max).refine(value => !value.includes('\0') && toUSVString(value) === value);
const googleDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
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

export function organicPreviousRange(from: string, to: string) {
  googleInput(googleDate, from); googleInput(googleDate, to);
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  const previousFrom = new Date(Date.parse(from) - days * 86400000).toISOString().slice(0, 10), previousTo = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10);
  if (days < 1 || days > 366 || previousFrom < '0001-01-01' || !googleDate.safeParse(previousFrom).success) throw new FoundationError(400, 'Choose up to 366 days with a representable previous period.');
  return { from: previousFrom, to: previousTo };
}
export function validateOrganicDates(from: string, to: string, timeZone: string | null, now = new Date()) {
  organicPreviousRange(from, to);
  const lastDay=googleLastCompletedDay(timeZone,now);
  if (!lastDay) throw new FoundationError(409, 'The property timezone is unavailable. Reconnect the source.');
  if (to > lastDay) throw new FoundationError(400, 'Organic reports require completed days in the property timezone. Choose an earlier end date.');
}

// Google calendar weeks start Sunday; Jan 1 belongs to week01, not the ISO week-year.
export function organicWeek(date: string) {
  googleInput(googleDate, date); return googleCalendarWeek(date);
}

// A closed filter, not a user-defined query. Search terms need the matching event.
// https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/FilterExpression
const siteSearchFilter = { andGroup: { expressions: [
  { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'view_search_results', caseSensitive: true } } },
  { notExpression: { filter: { fieldName: 'searchTerm', stringFilter: { matchType: 'EXACT', value: '(not set)', caseSensitive: true } } } },
] } } as const;

type GoogleReportRequest =
  | {
    startDate: string; endDate: string; dimensions: readonly string[]; type: 'web'; dataState: 'final'; aggregationType: 'auto'; rowLimit: 1000; startRow: number;
    dateRanges?: never; metrics?: never; orderBys?: never; offset?: never; limit?: never; returnPropertyQuota?: never; keepEmptyRows?: never; dimensionFilter?: never;
  }
  | {
    dateRanges: Array<{ startDate: string; endDate: string }>; dimensions: Array<{ name: string }>; metrics: Array<{ name: string }>;
    orderBys: Array<{ dimension: { dimensionName: string; orderType?: 'ALPHANUMERIC' } }>; offset: string; limit: '1000'; returnPropertyQuota: true; keepEmptyRows: true;
    dimensionFilter?: { filter: { fieldName: 'isKeyEvent' | 'sessionDefaultChannelGroup'; stringFilter: { matchType: 'EXACT'; value: 'true' | 'Organic Search'; caseSensitive: true } } } | typeof siteSearchFilter;
    startDate?: never; endDate?: never; type?: never; dataState?: never; aggregationType?: never; rowLimit?: never; startRow?: never;
  };

export function googleReportRequest(report: GoogleReport, from: string, to: string, offset: number, stage: OrganicStage = 'trend'): GoogleReportRequest {
  const definition = googleReports[report], aggregate = isOrganicOverview(report) && stage !== 'trend';
  if (stage !== 'trend' && !isOrganicOverview(report)) throw new FoundationError(400, 'Select an organic overview.');
  if (stage === 'previous') { const previous = organicPreviousRange(from, to); from = previous.from; to = previous.to; }
  if (definition.provider === 'gsc') return { startDate: from, endDate: to, dimensions: definition.dimensions, type: 'web', dataState: 'final', aggregationType: 'auto', rowLimit: 1000, startRow: offset };
  const keyEventFilter: { dimensionFilter?: { filter: { fieldName: 'isKeyEvent'; stringFilter: { matchType: 'EXACT'; value: 'true'; caseSensitive: true } } } } = {};
  if (report === 'ga4_key_events') keyEventFilter.dimensionFilter = { filter: { fieldName: 'isKeyEvent', stringFilter: { matchType: 'EXACT', value: 'true', caseSensitive: true } } };
  const dimensions = aggregate ? [] : definition.dimensions;
  return { dateRanges: [{ startDate: from, endDate: to }], dimensions: dimensions.map(name => ({ name })), metrics: definition.metrics.map(name => ({ name })),
    orderBys: dimensions.map(dimensionName => ({ dimension: { dimensionName, ...(isDetailedGa4Report(report) ? { orderType: 'ALPHANUMERIC' } : {}) } })), offset: String(offset), limit: '1000', returnPropertyQuota: true, keepEmptyRows: true,
    ...keyEventFilter, ...(ga4OrganicReports.includes(report) ? { dimensionFilter: { filter: { fieldName: 'sessionDefaultChannelGroup' as const, stringFilter: { matchType: 'EXACT' as const, value: 'Organic Search' as const, caseSensitive: true as const } } } } : {}),
    ...(report === 'ga4_site_search' ? { dimensionFilter: siteSearchFilter } : {}) };
}

export function googleCompatibilityRequest(report: GoogleReport, from: string, to: string, stage: OrganicStage = 'trend') {
  if (!isDetailedGa4Report(report)) throw new FoundationError(400, 'Select a detailed GA4 report.');
  const request = googleReportRequest(report, from, to, 0, stage);
  return { dimensions: request.dimensions, metrics: request.metrics, ...(request.dimensionFilter ? { dimensionFilter: request.dimensionFilter } : {}) };
}

export function normalizeGoogleCompatibility(report: GoogleReport, value: unknown, stage: OrganicStage = 'trend'): void {
  if (!isDetailedGa4Report(report)) throw new FoundationError(400, 'Select a detailed GA4 report.');
  try {
    const metadata = z.object({ apiName: safeGoogleString(120) });
    // Google returns an inventory, not just requested fields. The transport caps
    // the complete body at 2 MiB; inspect requested names once without selecting extras.
    const dimensions = z.array(z.object({ dimensionMetadata: metadata, compatibility: z.unknown().optional() }));
    const data = z.object({ dimensionCompatibilities: isOrganicOverview(report) && stage !== 'trend' ? dimensions.default([]) : dimensions, metricCompatibilities: z.array(z.object({ metricMetadata: metadata, compatibility: z.unknown().optional() })) }).parse(value);
    for (const [kind, expected] of [['dimension', isOrganicOverview(report) && stage !== 'trend' ? [] : googleReports[report].dimensions], ['metric', googleReports[report].metrics]] as const) {
      const entries = kind === 'dimension' ? data.dimensionCompatibilities.map(entry => ({ name: entry.dimensionMetadata.apiName, compatibility: entry.compatibility })) : data.metricCompatibilities.map(entry => ({ name: entry.metricMetadata.apiName, compatibility: entry.compatibility }));
      const requested = new Set<string>(expected), seen = new Set<string>();
      for (const entry of entries) if (requested.has(entry.name)) { if (seen.has(entry.name) || entry.compatibility !== 'COMPATIBLE') throw new Error(); seen.add(entry.name); }
      if (seen.size !== requested.size) throw new Error();
    }
  } catch { throw new FoundationError(502, 'Google could not confirm compatibility for this report. No dimensions or metrics were substituted.'); }
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = safeGoogleString(4096);
const numeric = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/).max(100).refine(value => Number.isFinite(Number(value)));
function malformed(): never { throw new FoundationError(502, 'Google returned a report that could not be safely interpreted.'); }
// Provider dimensions/metrics are explicitly selected above. No arbitrary query,
// source payload or user-level export is persisted or exposed through this adapter.
export function normalizeGoogleReport(report: GoogleReport, value: unknown, from: string, to: string, stage: OrganicStage = 'trend'): ReportPage {
  try {
    const organic = ga4OrganicReports.includes(report), overview = isOrganicOverview(report), aggregate = overview && stage !== 'trend';
    if (stage !== 'trend' && !overview) malformed();
    const definition = aggregate ? { ...googleReports[report], dimensions: [] as readonly string[] } : googleReports[report];
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
        rows: z.array(z.object({ dimensionValues: aggregate ? z.array(z.object({ value: text })).default([]) : z.array(z.object({ value: text })), metricValues: z.array(z.object({ value: numeric })) })).max(1000).default([]), rowCount: count.optional(),
        metadata: z.object({ timeZone: safeGoogleString(120).optional(), currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(), emptyReason: safeGoogleString(1000).optional(),
          dataLossFromOtherRow: z.boolean().optional(), subjectToThresholding: z.boolean().optional(), samplingMetadatas: z.array(z.object({ samplesReadCount: z.string().regex(/^\d+$/).max(30), samplingSpaceSize: z.string().regex(/^\d+$/).max(30) })).max(5).optional(),
          schemaRestrictionResponse: z.object({ activeMetricRestrictions: z.array(restriction).max(30).optional() }).optional(),
          dataTruncationReasons: z.array(z.object({ dataTruncationType: safeGoogleString(120).optional(), dataTruncationMessage: safeGoogleString(2048).optional(), dataTruncationDate: googleDate.optional(),
            dataTruncationDateRanges: z.array(z.object({ startDate: googleDate, endDate: googleDate })).max(10).optional() })).max(20).optional(),
        }).optional(),
        propertyQuota: z.record(safeGoogleString(100), z.object({ consumed: count.optional(), remaining: count.optional() })).optional(),
      }).parse(value);
      const headerlessEmpty = data.dimensionHeaders === undefined && data.metricHeaders === undefined && !data.rows.length && !data.rowCount;
      if (!headerlessEmpty && (JSON.stringify(aggregate ? data.dimensionHeaders?.map(h => h.name) ?? [] : data.dimensionHeaders?.map(h => h.name)) !== JSON.stringify(definition.dimensions) || JSON.stringify(data.metricHeaders?.map(h => h.name)) !== JSON.stringify(definition.metrics))) malformed();
      if (data.rows.length && (data.rowCount === undefined || data.rowCount < data.rows.length)) malformed();
      const restricted = new Set(data.metadata?.schemaRestrictionResponse?.activeMetricRestrictions?.map(item => item.metricName));
      rows = data.rows.map(row => {
        if (row.dimensionValues.length !== definition.dimensions.length || row.metricValues.length !== definition.metrics.length) malformed();
        return { dimensions: Object.fromEntries(definition.dimensions.map((name, i) => [name, name === 'date' ? row.dimensionValues[i].value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : row.dimensionValues[i].value])),
          metrics: Object.fromEntries(definition.metrics.map((name, i) => [name, restricted.has(name) ? null : row.metricValues[i].value])) };
      });
      rowCount = data.rowCount ?? rows.length;
      if (organic) {
        for (const row of rows) for (const [name, value] of Object.entries(row.metrics)) if (!googleGa4MetricInRange(name, value)) malformed();
        if (rows.length && (!data.metadata?.timeZone || rows.some(row => row.metrics.purchaseRevenue !== null) && !data.metadata.currencyCode)) malformed();
        if (overview && (rowCount !== rows.length || rows.length > (aggregate ? 1 : report === 'ga4_organic_daily' ? 366 : 54))) malformed();
        if (aggregate && !rows.length && !headerlessEmpty && rowCount !== 0) malformed();
        if (report === 'ga4_organic_weekly' && !aggregate && rows.some(row => !/^\d{4}(?:0[1-9]|[1-4]\d|5[0-3])$/.test(row.dimensions.yearWeek) || row.dimensions.yearWeek < organicWeek(from) || row.dimensions.yearWeek > organicWeek(to))) malformed();
      }
      if (report === 'ga4_key_events' && rows.some(row => row.dimensions.isKeyEvent !== 'true')) malformed();
      if (ga4InventoryReports.includes(report) && rows.length && (!data.metadata?.timeZone || rows.some(row => row.metrics.totalRevenue !== null) && !data.metadata.currencyCode)) malformed();
      if (isGa4CommerceReport(report)) {
        for (const row of rows) for (const [name, value] of Object.entries(row.metrics)) if (!googleGa4MetricInRange(name, value)) malformed();
        if (rows.length && (!data.metadata?.timeZone || rows.some(row => ['itemRevenue', 'purchaseRevenue'].some(name => Object.hasOwn(row.metrics, name) && row.metrics[name] !== null)) && !data.metadata.currencyCode)) malformed();
        if (report === 'ga4_site_search' && rows.some(row => row.dimensions.searchTerm === '(not set)')) malformed();
      }
      Object.assign(metadata, data.metadata ?? {}, { quota: data.propertyQuota ?? null });
      if (data.metadata?.subjectToThresholding) warnings.push('Google may suppress rows below its privacy thresholds.');
      if (data.metadata?.dataLossFromOtherRow) warnings.push('Google groups some high-cardinality data into an other row.');
      if (data.metadata?.samplingMetadatas?.length) warnings.push('Google sampled this report; values are estimates.');
      if (restricted.size) warnings.push('Some metrics are restricted and shown as unavailable.');
      if (data.metadata?.dataTruncationReasons?.length) warnings.push('Google reports data truncation.');
      if (data.metadata?.emptyReason) warnings.push('Google supplied an empty-report reason; see report metadata.');
    }
    if (definition.dimensions.some(name => name === 'date')) for (const row of rows) if (!googleDate.safeParse(row.dimensions.date).success || row.dimensions.date < from || row.dimensions.date > to) malformed();
    const keys = rows.map(row => JSON.stringify(row.dimensions));
    if (new Set(keys).size !== keys.length) malformed();
    return { rows, rowCount, quality: { warnings, metadata } };
  } catch { return malformed(); }
}
