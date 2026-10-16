import { z } from 'zod';
import { toUSVString } from 'node:util';
import { FoundationError } from './auth.ts';

export const googleScopes = { gsc: 'https://www.googleapis.com/auth/webmasters.readonly', ga4: 'https://www.googleapis.com/auth/analytics.readonly', ads: 'https://www.googleapis.com/auth/adwords' } as const;
export const googleAdsVersion = 'v26';
export const googleAdsCustomerId = z.string().regex(/^[1-9]\d{9}$(?![\s\S])/);
export const googleReports = {
  gsc_daily: { provider: 'gsc', dimensions: ['date'], metrics: ['clicks', 'impressions', 'ctr', 'position'] },
  gsc_queries: { provider: 'gsc', dimensions: ['date', 'query'], metrics: ['clicks', 'impressions', 'ctr', 'position'] },
  gsc_pages: { provider: 'gsc', dimensions: ['date', 'page'], metrics: ['clicks', 'impressions', 'ctr', 'position'] },
  ga4_traffic: { provider: 'ga4', dimensions: ['date', 'sessionDefaultChannelGroup'], metrics: ['sessions', 'totalUsers', 'screenPageViews', 'engagedSessions'] },
  ga4_events: { provider: 'ga4', dimensions: ['date', 'eventName'], metrics: ['eventCount', 'keyEvents', 'totalUsers'] },
  ga4_pages: { provider: 'ga4', dimensions: ['date', 'unifiedPagePathScreen'], metrics: ['screenPageViews', 'activeUsers', 'userEngagementDuration', 'eventCount', 'keyEvents', 'totalRevenue'] },
  ga4_acquisition: { provider: 'ga4', dimensions: ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName'], metrics: ['sessions', 'engagedSessions', 'totalUsers', 'eventCount', 'keyEvents', 'totalRevenue'] },
  ga4_key_events: { provider: 'ga4', dimensions: ['date', 'eventName', 'isKeyEvent'], metrics: ['eventCount', 'keyEvents', 'totalUsers', 'totalRevenue'] },
  ads_daily: { provider: 'ads', dimensions: ['date', 'customerId'], metrics: ['impressions', 'clicks', 'costMicros', 'conversions', 'conversionsValue'] },
  ads_campaigns: { provider: 'ads', dimensions: ['date', 'customerId', 'campaignId', 'campaignName', 'campaignStatus'], metrics: ['impressions', 'clicks', 'costMicros', 'conversions', 'conversionsValue'] },
  ads_ad_groups: { provider: 'ads', dimensions: ['date', 'customerId', 'campaignId', 'campaignName', 'adGroupId', 'adGroupName', 'adGroupStatus'], metrics: ['impressions', 'clicks', 'costMicros', 'conversions', 'conversionsValue'] },
} as const;
export type GoogleReport = keyof typeof googleReports;
export const ga4InventoryReports: readonly GoogleReport[] = ['ga4_pages', 'ga4_acquisition', 'ga4_key_events'];
export type GoogleProvider = keyof typeof googleScopes;
export type ReportRow = { dimensions: Record<string, string>; metrics: Record<string, string | null> };
export type ReportPage = { rows: ReportRow[]; rowCount: number | null; complete?: boolean; quality: { warnings: string[]; metadata: Record<string, unknown> } };
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
  if (definition.provider === 'ads') {
    googleInput(googleDate, from); googleInput(googleDate, to);
    if (offset !== 0) throw new FoundationError(400, 'Google Ads imports fetch one bounded provider page. Choose a smaller range for a partial snapshot.');
    const resource = report === 'ads_daily' ? 'customer' : report === 'ads_campaigns' ? 'campaign' : 'ad_group';
    const fields = ['segments.date', 'customer.id', ...(resource === 'customer' ? [] : ['campaign.id', 'campaign.name']), ...(resource === 'campaign' ? ['campaign.status'] : resource === 'ad_group' ? ['ad_group.id', 'ad_group.name', 'ad_group.status'] : []), 'metrics.impressions', 'metrics.clicks', 'metrics.cost_micros', 'metrics.conversions', 'metrics.conversions_value'];
    return { query: `SELECT ${fields.join(', ')} FROM ${resource} WHERE segments.date BETWEEN '${from}' AND '${to}' ORDER BY segments.date${resource === 'customer' ? '' : ', campaign.id'}${resource === 'ad_group' ? ', ad_group.id' : ''}`, searchSettings: { returnTotalResultsCount: true } };
  }
  if (definition.provider === 'gsc') return { startDate: from, endDate: to, dimensions: definition.dimensions, type: 'web', dataState: 'final', aggregationType: 'auto', rowLimit: 1000, startRow: offset };
  return { dateRanges: [{ startDate: from, endDate: to }], dimensions: definition.dimensions.map(name => ({ name })), metrics: definition.metrics.map(name => ({ name })),
    orderBys: definition.dimensions.map(dimensionName => ({ dimension: { dimensionName, ...(ga4InventoryReports.includes(report) ? { orderType: 'ALPHANUMERIC' } : {}) } })), offset: String(offset), limit: '1000', returnPropertyQuota: true, keepEmptyRows: true,
    ...(report === 'ga4_key_events' ? { dimensionFilter: { filter: { fieldName: 'isKeyEvent', stringFilter: { matchType: 'EXACT', value: 'true', caseSensitive: true } } } } : {}) };
}

export function googleCompatibilityRequest(report: GoogleReport, from: string, to: string) {
  if (!ga4InventoryReports.includes(report)) throw new FoundationError(400, 'Select a detailed GA4 report.');
  const request = googleReportRequest(report, from, to, 0);
  return { dimensions: request.dimensions, metrics: request.metrics, ...(request.dimensionFilter ? { dimensionFilter: request.dimensionFilter } : {}) };
}

export function normalizeGoogleCompatibility(report: GoogleReport, value: unknown): void {
  if (!ga4InventoryReports.includes(report)) throw new FoundationError(400, 'Select a detailed GA4 report.');
  try {
    const metadata = z.object({ apiName: safeGoogleString(120) });
    // Google returns an inventory, not just requested fields. The transport caps
    // the complete body at 2 MiB; inspect requested names once without selecting extras.
    const data = z.object({ dimensionCompatibilities: z.array(z.object({ dimensionMetadata: metadata, compatibility: z.unknown().optional() })), metricCompatibilities: z.array(z.object({ metricMetadata: metadata, compatibility: z.unknown().optional() })) }).parse(value);
    for (const [kind, expected] of [['dimension', googleReports[report].dimensions], ['metric', googleReports[report].metrics]] as const) {
      const entries = kind === 'dimension' ? data.dimensionCompatibilities.map(entry => ({ name: entry.dimensionMetadata.apiName, compatibility: entry.compatibility })) : data.metricCompatibilities.map(entry => ({ name: entry.metricMetadata.apiName, compatibility: entry.compatibility }));
      const requested = new Set<string>(expected), seen = new Set<string>();
      for (const entry of entries) if (requested.has(entry.name)) { if (seen.has(entry.name) || entry.compatibility !== 'COMPATIBLE') throw new Error(); seen.add(entry.name); }
      if (seen.size !== requested.size) throw new Error();
    }
  } catch { throw new FoundationError(502, 'Google could not confirm compatibility for this report. No dimensions or metrics were substituted.'); }
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = safeGoogleString(4096);
const numeric = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$(?![\s\S])/).max(100).refine(value => Number.isFinite(Number(value)));
function malformed(): never { throw new FoundationError(502, 'Google returned a report that could not be safely interpreted.'); }
// Provider dimensions/metrics are explicitly selected above. No arbitrary query,
// source payload or user-level export is persisted or exposed through this adapter.
export function normalizeGoogleReport(report: GoogleReport, value: unknown, from: string, to: string, customerId?: string): ReportPage {
  try {
    const definition = googleReports[report];
    let rows: ReportRow[], rowCount: number | null;
    const warnings: string[] = [], metadata: Record<string, unknown> = {};
    let complete: boolean | undefined;
    if (definition.provider === 'ads') {
      if (!googleAdsCustomerId.safeParse(customerId).success) malformed();
      const integer = z.string().regex(/^(?:0|[1-9]\d*)$(?![\s\S])/).max(30);
      const entity = z.object({ id: integer, name: text, status: safeGoogleString(80).optional() });
      const data = z.object({ results: z.array(z.object({ segments: z.object({ date: googleDate }), customer: z.object({ id: googleAdsCustomerId }), campaign: entity.optional(), adGroup: entity.optional(), metrics: z.object({ impressions: integer.optional(), clicks: integer.optional(), costMicros: integer.optional(), conversions: z.number().finite().nonnegative().optional(), conversionsValue: z.number().finite().optional() }).optional() })).max(10000).default([]), nextPageToken: safeGoogleString(4096).optional(), totalResultsCount: integer.optional() }).parse(value);
      complete = !data.nextPageToken;
      if (!complete && !data.results.length || data.totalResultsCount !== undefined && (BigInt(data.totalResultsCount) < BigInt(data.results.length) || complete && BigInt(data.totalResultsCount) !== BigInt(data.results.length) || !complete && BigInt(data.totalResultsCount) <= BigInt(data.results.length))) malformed();
      rowCount = data.totalResultsCount !== undefined && BigInt(data.totalResultsCount) <= 2147483647n ? Number(data.totalResultsCount) : null;
      rows = data.results.map(row => {
        if (row.customer.id !== customerId || report !== 'ads_daily' && !row.campaign || report === 'ads_ad_groups' && !row.adGroup) malformed();
        const dimensions: Record<string, string> = { date: row.segments.date, customerId: row.customer.id };
        if (report !== 'ads_daily') Object.assign(dimensions, { campaignId: row.campaign!.id, campaignName: row.campaign!.name });
        if (report === 'ads_campaigns') dimensions.campaignStatus = row.campaign!.status ?? 'UNKNOWN';
        if (report === 'ads_ad_groups') Object.assign(dimensions, { adGroupId: row.adGroup!.id, adGroupName: row.adGroup!.name, adGroupStatus: row.adGroup!.status ?? 'UNKNOWN' });
        return { dimensions, metrics: Object.fromEntries(definition.metrics.map(name => [name, row.metrics?.[name] === undefined ? null : String(row.metrics[name])])) };
      });
      Object.assign(metadata, { apiVersion: googleAdsVersion, providerPages: 1, returnedRows: rows.length, totalResultsCount: data.totalResultsCount ?? null, nextPageAvailable: !complete, costUnit: 'one million costMicros per account currency unit', attribution: 'Google Ads reported conversions; not native conversions' });
      warnings.push('Google Ads omits some all-zero date segments. Missing rows are not filled with zero; absent metric fields are unavailable.', 'Google Ads conversions use the account conversion settings and can be restated. Do not add these snapshots or blend them with native conversions.');
      if (!complete) warnings.push('Google returned a continuation token after this bounded provider page. This snapshot is partial; choose a smaller date range.');
    } else if (definition.provider === 'gsc') {
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
      if (data.rows.length && (data.rowCount === undefined || data.rowCount < data.rows.length)) malformed();
      const restricted = new Set(data.metadata?.schemaRestrictionResponse?.activeMetricRestrictions?.map(item => item.metricName));
      rows = data.rows.map(row => {
        if (row.dimensionValues.length !== definition.dimensions.length || row.metricValues.length !== definition.metrics.length) malformed();
        return { dimensions: Object.fromEntries(definition.dimensions.map((name, i) => [name, name === 'date' ? row.dimensionValues[i].value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : row.dimensionValues[i].value])),
          metrics: Object.fromEntries(definition.metrics.map((name, i) => [name, restricted.has(name) ? null : row.metricValues[i].value])) };
      });
      rowCount = data.rowCount ?? rows.length;
      if (report === 'ga4_key_events' && rows.some(row => row.dimensions.isKeyEvent !== 'true')) malformed();
      if (ga4InventoryReports.includes(report) && rows.length && (!data.metadata?.timeZone || rows.some(row => row.metrics.totalRevenue !== null) && !data.metadata.currencyCode)) malformed();
      Object.assign(metadata, data.metadata ?? {}, { quota: data.propertyQuota ?? null });
      if (data.metadata?.subjectToThresholding) warnings.push('Google may suppress rows below its privacy thresholds.');
      if (data.metadata?.dataLossFromOtherRow) warnings.push('Google groups some high-cardinality data into an other row.');
      if (data.metadata?.samplingMetadatas?.length) warnings.push('Google sampled this report; values are estimates.');
      if (restricted.size) warnings.push('Some metrics are restricted and shown as unavailable.');
      if (data.metadata?.dataTruncationReasons?.length) warnings.push('Google reports data truncation.');
      if (data.metadata?.emptyReason) warnings.push('Google supplied an empty-report reason; see report metadata.');
    }
    for (const row of rows) if (!googleDate.safeParse(row.dimensions.date).success || row.dimensions.date < from || row.dimensions.date > to) malformed();
    const keys = rows.map(row => JSON.stringify(definition.provider === 'ads'
      ? ['date', 'customerId', ...(report === 'ads_daily' ? [] : ['campaignId']), ...(report === 'ads_ad_groups' ? ['adGroupId'] : [])].map(field => row.dimensions[field])
      : row.dimensions));
    if (new Set(keys).size !== keys.length) malformed();
    return { rows, rowCount, ...(complete === undefined ? {} : { complete }), quality: { warnings, metadata } };
  } catch { return malformed(); }
}
