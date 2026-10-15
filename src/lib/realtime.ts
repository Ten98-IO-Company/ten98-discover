import type {environmentVersion} from './analytics-environment.ts';
import type {GeographyObservation,RealtimeGeography} from './analytics-geography.ts';

export const realtimeLimits=Object.freeze({windowSeconds:1800,activeSeconds:300,refreshMs:10000,activity:100,rankings:15});
export type RealtimeCoverage={status:'complete'|'partial'|'unavailable';retainedFrom:string|null};
export type RealtimeActivity={id:string;receivedAt:string;kind:'pageview'|'custom';eventName:string;path:string;origin:string;
 visitorKey:string|null;browser:string|null;os:string|null;device:string|null;environmentVersion:typeof environmentVersion|null;
 referrerHost:string|null;source:'browser'|'api'|'legacy';collectionBasis:'cookieless'|'consent'|null;geography:GeographyObservation|null};
export type RealtimeSnapshot={
 version:'native-realtime-v1';projectId:string;asOf:string;
 range:{start:string;end:string;timeZone:'UTC';seconds:1800};activeWindow:{start:string;end:string;seconds:300};
 coverage:RealtimeCoverage;
 collection:{mode:'cookieless'|'consent-first';captureCoverage:'unknown';pageViews:{cookieless:number|null;consent:number|null;unknown:number|null}};
 totals:{pageViews:number|null;customEvents:number|null;estimatedVisitors:number|null};
 measurement:{method:'rotating-project-key';identifiedPageViews:number|null;unidentifiedPageViews:number|null;limitation:string};
 active:{estimatedVisitors:number|null;identifiedEvents:number|null;unidentifiedEvents:number|null;coverage:RealtimeCoverage};
 minutes:{start:string;end:string;partial:boolean;pageViews:number|null;customEvents:number|null;estimatedVisitors:number|null;
  identifiedPageViews:number|null;unidentifiedPageViews:number|null;coverage:RealtimeCoverage['status']}[];
 pages:{path:string;pageViews:number}[];referrers:{host:string|null;pageViews:number}[];
 referrerCoverage:{recordedPageViews:number|null;notRecordedPageViews:number|null};
 activity:{limit:100;totalEvents:number|null;sampled:boolean;rows:RealtimeActivity[]};
 geography:RealtimeGeography;
};
