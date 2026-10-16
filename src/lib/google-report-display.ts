const adsLabels: Record<string, string> = {
  date: 'Date', customerId: 'Account ID', campaignId: 'Campaign ID', campaignName: 'Campaign', campaignStatus: 'Campaign status',
  adGroupId: 'Ad group ID', adGroupName: 'Ad group', adGroupStatus: 'Ad group status', impressions: 'Impressions', clicks: 'Clicks',
  costMicros: 'Cost', conversions: 'Conversions', conversionsValue: 'Conversion value',
};
export const googleAdsColumnLabel = (field: string) => Object.hasOwn(adsLabels, field) ? adsLabels[field] : field;
const currencies = new Set(Intl.supportedValuesOf('currency'));
/** Keep provider int64 micros exact; never pass money through Number. */
export function googleAdsCost(micros: unknown, currency: unknown): string {
  if (typeof micros !== 'string' || !/^(?:0|[1-9]\d{0,29})$(?![\s\S])/.test(micros)) return 'Unavailable';
  const value = BigInt(micros), amount = (value / 1000000n).toLocaleString('en-US') + '.' + (value % 1000000n).toString().padStart(6, '0');
  return typeof currency === 'string' && currencies.has(currency) ? `${currency} ${amount}` : `${amount} (currency unavailable)`;
}

const ga4Labels: Record<string, string> = {
  date: 'Date', unifiedPagePathScreen: 'Page path and screen class', sessionSource: 'Session source', sessionMedium: 'Session medium',
  sessionCampaignName: 'Session campaign', sessionDefaultChannelGroup: 'Session default channel group', eventName: 'Event name', isKeyEvent: 'Is key event',
  screenPageViews: 'Views', activeUsers: 'Active users', totalUsers: 'Total users', userEngagementDuration: 'Engagement time (seconds)',
  sessions: 'Sessions', engagedSessions: 'Engaged sessions', eventCount: 'Event count', keyEvents: 'Key events', totalRevenue: 'Total revenue',
};
export const googleGa4ColumnLabel = (field: string) => Object.hasOwn(ga4Labels, field) ? ga4Labels[field] : field;
/** GA4 decimals stay exactly as reported, including fractional key-event credit. */
export function googleGa4MetricValue(field: string, value: unknown, currency: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$(?![\s\S])/.test(value)) return 'Unavailable';
  return field !== 'totalRevenue' ? value : typeof currency === 'string' && currencies.has(currency) ? `${currency} ${value}` : `${value} (currency unavailable)`;
}
