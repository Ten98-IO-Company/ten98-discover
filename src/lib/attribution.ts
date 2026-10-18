import type {explorerQuery} from '../server/explorer-input.ts';
import type {CohortReport,SessionPropertyScope} from '../server/analytics-population.ts';
import type {advancedPredicateMethod} from '../server/advanced-predicates.ts';
import type {GeographyProvenance} from './analytics-geography.ts';
import type {JourneyStep} from './journeys.ts';

export const attributionFields=['referrer','paidAds','campaignSource','campaignMedium','campaignName','campaignContent','campaignTerm'] as const;
// Owner decision D1: pinned Umami 3.4.0 getAttribution.ts paidAds order; the first non-empty identifier on the selected touch names it.
export const paidAdsClickIds=[['gclid','Google Ads'],['fbclid','Facebook / Meta'],['msclkid','Microsoft Ads'],['ttclid','TikTok Ads'],['li_fat_id','LinkedIn Ads'],['twclid','Twitter Ads (X)']] as const;
export const attributionLimits=Object.freeze({values:20,queryCharacters:65536,responseBytes:2*1024*1024});
export type AttributionModel='first-click'|'last-click';
export type AttributionQuery=Omit<ReturnType<typeof explorerQuery>,'groupBy'|'groupProperty'>&{model:AttributionModel;conversion:JourneyStep};
export const attributionMethod=Object.freeze({unit:'converted-observed-native-key',credit:'one-selected-touch-per-key',
 touchScope:'unfiltered-native-keyed-events-in-selected-project-dates',first:'earliest-retained-window-observation-up-to-first-matching-conversion-including-it',
 last:'latest-timestamp-strictly-before-latest-matching-conversion',ordering:'other-touches-before-internal-navigation-then-server-receipt-time-then-event-id',
 referrers:'recorded-hosts-excluding-self-referrals',paidAds:'first-non-empty-gclid-fbclid-msclkid-ttclid-li_fat_id-twclid',historyComplete:false,captureCoverage:'unknown'} as const);
export type AttributionDimension={rows:{value:string;creditedKeys:number;shareOfConvertedKeys:number|null}[]|null;
 recordedKeys:number|null;emptyKeys:number|null;notRecordedKeys:number|null;totalValues:number|null;
 displayedKeys:number|null;omittedKeys:number|null;truncated:boolean;limit:20};
export type AttributionResult={version:'native-attribution-v2';projectId:string;asOf:string;
 range:{from:string;to:string;timeZone:string;start:string;end:string};query:AttributionQuery;method:typeof attributionMethod;
 coverage:{status:'complete'|'partial'|'unavailable';retainedFrom:string|null};
 selection:{status:'available'|'unavailable';evidenceIncomplete:boolean;
  reason:null|'event_history_unavailable'|'cohort_membership_unavailable'|'session_property_selection_unavailable'|'identity_unavailable'};
 measurement:{conversionEvents:number|null;keyedConversionEvents:number|null;unkeyedConversionEvents:number|null;
  convertedObservedKeys:number|null;convertingObservedVisits:number|null;attributedKeys:number|null;noEarlierTouchKeys:number|null;touchTimestampTieKeys:number|null;
  collection:{cookieless:number|null;consent:number|null;unknown:number|null}};
 dimensions:Record<typeof attributionFields[number],AttributionDimension>;
 cohort?:CohortReport;sessionProperties?:SessionPropertyScope;predicateMethod?:ReturnType<typeof advancedPredicateMethod>;
 geographyProvenance?:GeographyProvenance&{scope:'matching-conversion-events'};
};
