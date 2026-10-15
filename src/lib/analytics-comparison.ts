import {analyticsDay} from './navigation.ts';
import type {AnalyticsEnvironment} from './analytics-environment.ts';

export type AnalyticsComparisonMode='prev'|'yoy';
export type AnalyticsCoverage={status:'complete'|'partial'|'unavailable';retainedFrom:string|null};
export type AnalyticsPeriodReport={range:{from:string;to:string;timeZone:'UTC'};totals:{pageViews:number|null;customEvents:number|null};coverage:AnalyticsCoverage;
 collection:{mode:'cookieless'|'consent-first';captureCoverage:'unknown';pageViews:{cookieless:number|null;consent:number|null;unknown:number|null}};
 measurement:{version:string;identifiedPageViews:number|null;unidentifiedPageViews:number|null;visitors:number|null;visits:number|null;bounceRate:number|null;averageVisitSeconds:number|null};
 daily:{date:string;pageViews:number|null;customEvents:number|null;coverage:AnalyticsCoverage['status']}[];pages:{path:string;pageViews:number}[];events:{name:string;count:number}[];
 lastReceivedAt:string|null;environment:AnalyticsEnvironment};
export type AnalyticsComparison={version:'analytics-comparison-v1';mode:AnalyticsComparisonMode;asOf:string;report:AnalyticsPeriodReport;
 change:{pageViews:{absolute:number|null;percent:number|null};customEvents:{absolute:number|null;percent:number|null};visitors:{absolute:number|null;percent:number|null};visits:{absolute:number|null;percent:number|null};averageVisitSeconds:{absolute:number|null;percent:number|null};bounceRate:{percentagePoints:number|null}};
 alignment:{method:'ordinal-calendar-day';currentDays:number;comparisonDays:number;slots:number;overlapDays:number};calendar:{current:'complete'|'partial'|'future';comparison:'complete'|'partial'|'future'}};
const dayMs=86400000,minimum=Date.UTC(1970,0,1);

/** Shift inclusive calendar endpoints, then rebuild half-open bounds; public current ranges still cap at366. */
export function deriveAnalyticsComparison(current:{from:string;to:string},mode:AnalyticsComparisonMode){
 const start=analyticsDay(current.from),last=analyticsDay(current.to);if(start===null||last===null||last<start||last-start>=366*dayMs||!['prev','yoy'].includes(mode))return null;
 const end=last+dayMs,currentDays=(end-start)/dayMs;
 const previousYear=(time:number)=>{const date=new Date(time),year=date.getUTCFullYear()-1,month=date.getUTCMonth(),day=Math.min(date.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate());return Date.UTC(year,month,day);};
 const comparisonStart=mode==='prev'?start-currentDays*dayMs:previousYear(start),comparisonEnd=mode==='prev'?start:previousYear(last)+dayMs;
 if(comparisonStart<minimum||comparisonEnd<=comparisonStart||comparisonEnd-comparisonStart>367*dayMs)return null;
 const comparisonDays=(comparisonEnd-comparisonStart)/dayMs;
 return {range:{from:new Date(comparisonStart).toISOString().slice(0,10),to:new Date(comparisonEnd-dayMs).toISOString().slice(0,10),timeZone:'UTC' as const,start:new Date(comparisonStart).toISOString(),end:new Date(comparisonEnd).toISOString()},
  alignment:{method:'ordinal-calendar-day' as const,currentDays,comparisonDays,slots:Math.max(currentDays,comparisonDays),overlapDays:Math.max(0,Math.min(end,comparisonEnd)-Math.max(start,comparisonStart))/dayMs}};
}
