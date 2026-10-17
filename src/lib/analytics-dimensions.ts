import type {AnalyticsCoverage,AnalyticsPeriodReport} from './analytics-comparison.ts';

export const analyticsDimensions=['path','referrer','browser','os','device','country','region','city','language','event','campaignSource','campaignMedium','campaignName','campaignContent','campaignTerm','hostname','screen','channel'] as const;
export type AnalyticsDimension=typeof analyticsDimensions[number];
export const analyticsSelectionFields=['path','eventName','referrer','language','campaignSource','campaignMedium','campaignName','campaignContent','campaignTerm','origin','hostname','screen','channel'] as const;
/** Match the existing normalized referrer and geography wire bounds. */
export function analyticsFieldLimit(field:string){return ['path','origin','hostname','referrer','country','region','city'].includes(field)?2048:field==='screen'?11:field==='channel'?32:320;}
export type AnalyticsDimensionKey={type:'missing';value:null}|{type:'string';value:string};
export type AnalyticsDimensionMetrics={pageViews:number;customEvents:number;identifiedPageViews:number;visitors:number|null;visits:number|null;bounceRate:number|null;averageVisitSeconds:number|null};
export type AnalyticsDimensionRow=AnalyticsDimensionMetrics&{key:AnalyticsDimensionKey;counterpart:{[K in keyof AnalyticsDimensionMetrics]:AnalyticsDimensionMetrics[K]|null}&{present:boolean|null};change:{absolute:number|null;percent:number|null}};
export type AnalyticsDimensionPeriod={range:AnalyticsPeriodReport['range'];coverage:AnalyticsCoverage;identityCoverage:{identifiedPageViews:number|null;unidentifiedPageViews:number|null};totalGroups:number|null;returnedGroups:number;returnedPageViews:number|null;truncated:boolean;rows:AnalyticsDimensionRow[]};
export type AnalyticsDimensionComparison={version:'native-dimension-comparison-v1';field:AnalyticsDimension;metric:'estimated-visitors'|'custom-events';selection:string|null;current:AnalyticsDimensionPeriod;previous:AnalyticsDimensionPeriod;method:{population:'matching-retained-events';ranking:'visitors-pageviews-key-or-custom-events-key';missing:'explorer-typed-key';identity:'project-month-observed-key';changes:'complete-retention-current-minus-previous-previous-denominator'}};
