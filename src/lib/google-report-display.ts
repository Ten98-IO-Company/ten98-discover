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
