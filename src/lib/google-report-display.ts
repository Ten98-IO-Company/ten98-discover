const currencies = new Set(Intl.supportedValuesOf('currency'));
const calendarDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
/** Subtract a calendar date, not 24 hours from the current instant across DST. */
export function googleLastCompletedDay(timeZone: string | null, now = new Date()): string | null {
  try {
    if (!timeZone || !Number.isFinite(now.valueOf())) return null;
    const parts = new Intl.DateTimeFormat('en', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now);
    const today = ['year','month','day'].map(key => parts.find(part => part.type === key)!.value).join('-');
    if (!calendarDay(today)) return null;
    const previous = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
    return calendarDay(previous) && previous >= '0001-01-01' ? previous : null;
  } catch { return null; }
}
/** Google weeks begin Sunday and restart at January 1, unlike ISO week-years. */
export function googleCalendarWeek(date: string): string {
  if (!calendarDay(date)) throw new RangeError('Invalid Google calendar date.');
  const year = date.slice(0,4), start = new Date(year + '-01-01T00:00:00Z');
  return year + String(Math.min(53, Math.floor(((Date.parse(date)-start.valueOf())/86400000+start.getUTCDay())/7)+1)).padStart(2,'0');
}
/** Include missing calendar buckets as gaps, never as invented zero observations. */
export function googleOrganicCalendar(from: string, to: string, weekly: boolean): Array<{key:string;from:string;to:string}> {
  if (!calendarDay(from) || !calendarDay(to) || to < from || Date.parse(to)-Date.parse(from) >= 366*86400000) throw new RangeError('Choose up to 366 valid calendar days.');
  const buckets: Array<{key:string;from:string;to:string}> = [];
  for (let at=Date.parse(from);at<=Date.parse(to);at+=86400000) {
    const date=new Date(at).toISOString().slice(0,10),key=weekly?googleCalendarWeek(date):date,last=buckets.at(-1);
    if(last?.key===key)last.to=date;else buckets.push({key,from:date,to:date});
  }
  return buckets;
}

// Fixed range reports share their exact field contract with the native importer.
// Google field meanings: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema
export const ga4CommerceReports = {
  ga4_ecommerce_items: { provider: 'ga4', label: 'Ecommerce items', description: 'All traffic, grouped by item name and ID over the selected range. Item counts are quantities, not events. Item revenue includes refunds and excludes tax and shipping. Ecommerce events and item parameters must be collected in GA4.', dimensions: ['itemName', 'itemId'], metrics: ['itemsViewed', 'itemsAddedToCart', 'itemsPurchased', 'itemRevenue'] },
  ga4_ecommerce_landing: { provider: 'ga4', label: 'Ecommerce landing pages', description: 'All traffic, grouped by hostname and landing path over the selected range. Sessions, transactions and purchase revenue are reported by GA4. Purchase revenue includes refunds; it is distinct from item revenue.', dimensions: ['hostName', 'landingPage'], metrics: ['sessions', 'transactions', 'purchaseRevenue'] },
  ga4_site_search: { provider: 'ga4', label: 'Site search terms', description: 'Site search events only: view_search_results with a reported search term other than (not set). Requires search_term collection, such as enabled GA4 enhanced measurement. Search events are not search-result clicks. The (not set) term is excluded; missing rows are not zero.', dimensions: ['searchTerm'], metrics: ['eventCount', 'activeUsers', 'sessions', 'engagedSessions', 'engagementRate'] },
  ga4_audience_device: { provider: 'ga4', label: 'Audience by device', description: 'All traffic, grouped by device category over the selected range. These are aggregate report rows, not a user list or saved GA4 audience membership. Users can appear in multiple rows; do not sum active users or average the rates.', dimensions: ['deviceCategory'], metrics: ['activeUsers', 'sessions', 'engagementRate', 'keyEvents'] },
  ga4_audience_country: { provider: 'ga4', label: 'Audience by country', description: 'All traffic, grouped by GA4-reported country over the selected range. These are aggregate report rows, not a user list or saved GA4 audience membership. Users can appear in multiple rows; do not sum active users or average the rates.', dimensions: ['country'], metrics: ['activeUsers', 'sessions', 'engagementRate', 'keyEvents'] },
  ga4_audience_returning: { provider: 'ga4', label: 'New and returning visitors', description: 'All traffic, grouped by whether a previous session was recorded: new or returning. A person can appear in both groups during the range; do not add active users to obtain a unique total. This is not a cohort or retention report.', dimensions: ['newVsReturning'], metrics: ['activeUsers', 'sessions', 'engagementRate', 'keyEvents'] },
} as const;
export type Ga4CommerceReport = keyof typeof ga4CommerceReports;
export const isGa4CommerceReport = (report: string): report is Ga4CommerceReport => Object.hasOwn(ga4CommerceReports, report);

const ga4Labels: Record<string, string> = {
  date: 'Date', unifiedPagePathScreen: 'Page path and screen class', sessionSource: 'Session source', sessionMedium: 'Session medium',
  sessionCampaignName: 'Session campaign', sessionDefaultChannelGroup: 'Session default channel group', eventName: 'Event name', isKeyEvent: 'Is key event',
  screenPageViews: 'Views', activeUsers: 'Active users', totalUsers: 'Total users', userEngagementDuration: 'Engagement time (seconds)',
  sessions: 'Sessions', engagedSessions: 'Engaged sessions', eventCount: 'Event count', keyEvents: 'Key events', totalRevenue: 'Total revenue',
  hostName: 'Hostname', landingPage: 'Landing page', yearWeek: 'Google calendar week', engagementRate: 'Engagement rate (fraction)', sessionKeyEventRate: 'Session key-event rate (fraction)', transactions: 'Transactions', purchaseRevenue: 'Purchase revenue',
  itemName: 'Item name', itemId: 'Item ID', itemsViewed: 'Item units viewed', itemsAddedToCart: 'Item units added to cart', itemsPurchased: 'Item units purchased', itemRevenue: 'Item revenue',
  searchTerm: 'Search term', deviceCategory: 'Device category', country: 'Country', newVsReturning: 'New or returning',
};
export const googleGa4ColumnLabel = (field: string) => Object.hasOwn(ga4Labels, field) ? ga4Labels[field] : field;
/** GA4 decimals stay exactly as reported, including fractional key-event credit. */
export function googleGa4MetricValue(field: string, value: unknown, currency: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$(?![\s\S])/.test(value)) return 'Unavailable';
  return !['totalRevenue', 'purchaseRevenue', 'itemRevenue'].includes(field) ? value : typeof currency === 'string' && currencies.has(currency) ? `${currency} ${value}` : `${value} (currency unavailable)`;
}

export const organicOverviewMetrics = ['sessions','activeUsers','engagedSessions','engagementRate','keyEvents','transactions','purchaseRevenue'] as const;
export function googleDecimalPlain(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$(?![\s\S])/.test(value) || !Number.isFinite(Number(value))) return null;
  const [mantissa, exponent = '0'] = value.toLowerCase().split('e'), shift = Number(exponent);
  if (!Number.isInteger(shift) || Math.abs(shift) > 400) return null;
  const negative = mantissa.startsWith('-'), unsigned = negative ? mantissa.slice(1) : mantissa, [whole, fraction = ''] = unsigned.split('.'), digits = whole + fraction, point = whole.length + shift;
  const plain = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
  return (negative ? '-' : '') + plain.replace(/^0+(?=\d)/, '');
}
/** Compare exact expanded decimals; Number can round above-one rates or underflow negatives. */
export function googleGa4MetricInRange(field: string, value: unknown): boolean {
  if (value === null) return true;
  const plain = googleDecimalPlain(value); if (plain === null) return false;
  if (field === 'purchaseRevenue' || field === 'itemRevenue') return true;
  if (plain.startsWith('-') && /[1-9]/.test(plain)) return false;
  return !['engagementRate','sessionKeyEventRate'].includes(field) || /^(?:-?0(?:\.\d+)?|1(?:\.0+)?)$/.test(plain);
}
export function googleOrganicChange(current: unknown, previous: unknown) {
  const a = googleDecimalPlain(current), b = googleDecimalPlain(previous); if (a === null || b === null) return { absolute: null, percent: null };
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0), units = (s: string) => BigInt(s.replace('.', '')) * 10n ** BigInt(scale - (s.split('.')[1]?.length ?? 0));
  const left = units(a), right = units(b), delta = left - right;
  const format = (n: bigint, places: number) => { const raw = (n < 0n ? -n : n).toString().padStart(places + 1, '0'); return (n < 0n ? '-' : '') + (places ? raw.slice(0, -places) + '.' + raw.slice(-places) : raw); };
  return { absolute: format(delta, scale), percent: right === 0n ? null : format(delta * 10000n / (right < 0n ? -right : right), 2) };
}
// Expanded differences can be longer than the100-character provider literal.
export function googleOrganicChangeValue(value: string | null, currency?: string | null) {
  if (value === null || value.length > 1024 || !/^-?\d+(?:\.\d+)?$/.test(value)) return 'Unavailable';
  return currency === undefined ? value : currency !== null && currencies.has(currency) ? `${currency} ${value}` : `${value} (currency unavailable)`;
}

type OrganicObservation = { from: string; to: string; values: Record<string, string | null> | null; rowCount: number; quality: {warnings: string[]; metadata: Record<string, unknown>}; reportRequests: number; compatibilityRequests: number };
export type OrganicOverview = { complete: true; interval: 'daily' | 'weekly'; current: OrganicObservation; previous: OrganicObservation; trend: OrganicObservation };
export function readOrganicOverview(value: unknown, from: string, to: string, weekly: boolean): OrganicOverview | null {
  const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, expected: readonly string[]) => Object.keys(v).sort().join(',') === [...expected].sort().join(',');
  const day = calendarDay;
  if (!record(value) || !keys(value, ['complete','interval','current','previous','trend']) || value.complete !== true || value.interval !== (weekly ? 'weekly' : 'daily') || !day(from) || !day(to) || JSON.stringify(value).length > 131072) return null;
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1; if (days < 1 || days > 366) return null;
  const previousFrom = new Date(Date.parse(from) - days * 86400000).toISOString().slice(0, 10), previousTo = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10);
  if (previousFrom < '0001-01-01' || !day(previousFrom) || !day(previousTo)) return null;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && !v.includes('\0') && new TextDecoder().decode(new TextEncoder().encode(v)) === v;
  const optionalKeys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(key=>allowed.includes(key));
  const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  for (const stage of ['current','previous','trend'] as const) {
    const part = value[stage]; if (!record(part) || !keys(part, ['from','to','values','rowCount','quality','reportRequests','compatibilityRequests']) || part.from !== (stage === 'previous' ? previousFrom : from) || part.to !== (stage === 'previous' ? previousTo : to) || part.reportRequests !== 1 || part.compatibilityRequests !== (stage === 'previous' ? 0 : 1) || !Number.isInteger(part.rowCount) || part.rowCount < 0 || part.rowCount > (stage === 'trend' ? weekly ? 54 : days : 1)) return null;
    if (stage === 'trend' ? part.values !== null : part.rowCount === 0 ? part.values !== null : !record(part.values) || !keys(part.values, organicOverviewMetrics) || !Object.entries(part.values).every(([key,v]) => googleGa4MetricInRange(key,v))) return null;
    if (!record(part.quality) || !keys(part.quality, ['warnings','metadata']) || !Array.isArray(part.quality.warnings) || part.quality.warnings.length > 30 || !part.quality.warnings.every((v: unknown) => typeof v === 'string' && v.length <= 2048) || !record(part.quality.metadata)) return null;
    if (Object.keys(part.quality.metadata).some(key => !['timeZone','currencyCode','emptyReason','dataLossFromOtherRow','subjectToThresholding','samplingMetadatas','schemaRestrictionResponse','dataTruncationReasons','quota'].includes(key))) return null;
    const m = part.quality.metadata;
    if ('timeZone' in m && !text(m.timeZone,120) || 'currencyCode' in m && (typeof m.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(m.currencyCode)) || 'emptyReason' in m && !text(m.emptyReason,1000) || ['dataLossFromOtherRow','subjectToThresholding'].some(key=>key in m && typeof m[key] !== 'boolean')) return null;
    if ('samplingMetadatas' in m && (!Array.isArray(m.samplingMetadatas) || m.samplingMetadatas.length > 5 || !m.samplingMetadatas.every((v:unknown)=>record(v) && keys(v,['samplesReadCount','samplingSpaceSize']) && [v.samplesReadCount,v.samplingSpaceSize].every(n=>typeof n==='string' && /^\d{1,30}$/.test(n))))) return null;
    if ('schemaRestrictionResponse' in m && (!record(m.schemaRestrictionResponse) || !optionalKeys(m.schemaRestrictionResponse,['activeMetricRestrictions']) || 'activeMetricRestrictions' in m.schemaRestrictionResponse && (!Array.isArray(m.schemaRestrictionResponse.activeMetricRestrictions) || m.schemaRestrictionResponse.activeMetricRestrictions.length > 30 || !m.schemaRestrictionResponse.activeMetricRestrictions.every((v:unknown)=>record(v) && keys(v,['metricName','restrictedMetricTypes']) && text(v.metricName,120) && Array.isArray(v.restrictedMetricTypes) && v.restrictedMetricTypes.length <= 10 && v.restrictedMetricTypes.every((t:unknown)=>text(t,80)))))) return null;
    if ('dataTruncationReasons' in m && (!Array.isArray(m.dataTruncationReasons) || m.dataTruncationReasons.length > 20 || !m.dataTruncationReasons.every((v:unknown)=>record(v) && optionalKeys(v,['dataTruncationType','dataTruncationMessage','dataTruncationDate','dataTruncationDateRanges']) && (!('dataTruncationType' in v)||text(v.dataTruncationType,120)) && (!('dataTruncationMessage' in v)||text(v.dataTruncationMessage,2048)) && (!('dataTruncationDate' in v)||day(v.dataTruncationDate)) && (!('dataTruncationDateRanges' in v)||Array.isArray(v.dataTruncationDateRanges) && v.dataTruncationDateRanges.length <= 10 && v.dataTruncationDateRanges.every((r:unknown)=>record(r)&&keys(r,['startDate','endDate'])&&day(r.startDate)&&day(r.endDate)))))) return null;
    if ('quota' in m && m.quota !== null && (!record(m.quota) || Object.keys(m.quota).length > 30 || !Object.entries(m.quota).every(([key,v])=>text(key,100) && record(v) && optionalKeys(v,['consumed','remaining']) && Object.values(v).every(count)))) return null;
  }
  return value as OrganicOverview;
}
