// Fixed labels from detect-browser 5.3.0 and ua-parser-js 1.0.41; no separate parsed
// browser/OS version fields, device vendors/models or raw User-Agent are retained.
export const environmentVersion = 'server-ua-environment-v1' as const;
export const environmentFields = ['browser', 'os', 'device'] as const;
export type EnvironmentField = typeof environmentFields[number];
export const environmentCatalog = {
  browser: ['aol','edge','edge-ios','yandexbrowser','kakaotalk','samsung','silk','miui','beaker','edge-chromium','chrome','chromium-webview','phantomjs','crios','firefox','fxios','opera-mini','opera','pie','netfront','ie','bb10','android','ios','safari','facebook','instagram','ios-webview','curl','searchbot','bot','unknown'],
  os: ['iOS','Android OS','BlackBerry OS','Windows Mobile','Amazon OS','Windows 3.11','Windows 95','Windows 98','Windows 2000','Windows XP','Windows Server 2003','Windows Vista','Windows 7','Windows 8','Windows 8.1','Windows 10','Windows ME','Windows CE','Open BSD','Sun OS','Linux','Mac OS','QNX','BeOS','OS/2','Chrome OS','unknown'],
  device: ['mobile','tablet','console','smarttv','wearable','embedded','desktop','laptop','unknown'],
} as const;
export type EnvironmentFilters = Partial<Record<EnvironmentField, string>>;
export function isEnvironmentFilter(field: EnvironmentField, value: unknown): value is string {
  return typeof value === 'string' && (value === 'not-recorded' || (environmentCatalog[field] as readonly string[]).includes(value));
}
export type EnvironmentRow = { value: string|null; pageViews: number; identifiedPageViews: number;
  visitors: number|null; visits: number|null; bounceRate: number|null; averageVisitSeconds: number|null };
export type AnalyticsEnvironment = { version: typeof environmentVersion; filters: EnvironmentFilters;
  browsers: EnvironmentRow[]; operatingSystems: EnvironmentRow[]; devices: EnvironmentRow[];
  coverage: { pageViews: number|null; recordedPageViews: number|null; notRecordedPageViews: number|null; firstRecordedAt: string|null };
  method: { source: 'bounded-request-user-agent'; device: 'ua-parser-v1-screen-if-enabled'; rawUserAgentStored: false } };
