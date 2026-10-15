import {z} from 'zod';
import type {explorerQuery} from '../server/explorer-input.ts';
import type {CohortReport,SessionPropertyScope} from '../server/analytics-population.ts';
import type {advancedPredicateMethod} from '../server/advanced-predicates.ts';
import type {GeographyProvenance} from './analytics-geography.ts';

export const journeysLimits=Object.freeze({steps:7,paths:100,queryCharacters:65536,responseBytes:12*1024*1024});
const clean=(value:string)=>!/[\u0000\ud800-\udfff]/u.test(value);
export const journeyStepSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('pageview'),value:z.string().min(1).max(2048).refine(value=>clean(value)&&value.startsWith('/')&&!/[?#]/.test(value))}).strict(),
 z.object({kind:z.literal('custom'),value:z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$(?![\s\S])/).refine(value=>value!=='page_view')}).strict(),
]);
export type JourneyStep=z.infer<typeof journeyStepSchema>;
export type JourneysQuery=Omit<ReturnType<typeof explorerQuery>,'groupBy'|'groupProperty'>&{steps:number;start:JourneyStep|null;end:JourneyStep|null};
export const journeysMethod=Object.freeze({unit:'observed-native-visit-key-pair',ordering:'server-receipt-time-then-event-id',
 stepRule:'adjacent-equal-typed-matching-observations-collapsed-before-cap',edgeMeaning:'next-matching-retained-observation',historyComplete:false,captureCoverage:'unknown'} as const);
export type JourneyPath={items:JourneyStep[];observedVisits:number;rawObservationCounts:number[];additionalObservedStepsVisits:number};
export type JourneysResult={
 version:'native-journeys-v1';projectId:string;asOf:string;
 range:{from:string;to:string;timeZone:string;start:string;end:string};query:JourneysQuery;method:typeof journeysMethod;
 coverage:{status:'complete'|'partial'|'unavailable';retainedFrom:string|null};
 selection:{status:'available'|'unavailable';reason:null|'event_history_unavailable'|'cohort_membership_unavailable'|'session_property_selection_unavailable'|'identity_unavailable';evidenceIncomplete:boolean};
 measurement:{matchingEvents:number|null;sequencedEvents:number|null;unsequencedEvents:number|null;observedVisits:number|null;orderingTieVisits:number|null;
  collection:{cookieless:number|null;consent:number|null;unknown:number|null}};
 paths:JourneyPath[]|null;
 ranking:{mode:'top100';limit:100;totalPrefixes:number|null;matchingObservedVisits:number|null;displayedObservedVisits:number|null;omittedObservedVisits:number|null;truncated:boolean};
 cohort?:CohortReport;sessionProperties?:SessionPropertyScope;predicateMethod?:ReturnType<typeof advancedPredicateMethod>;
 geographyProvenance?:(GeographyProvenance&{scope:'matching-report-events'});
};
