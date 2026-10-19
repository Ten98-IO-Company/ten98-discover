import {z} from 'zod';
import {journeyStepSchema,type JourneyStep} from './journeys.ts';

const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),time=z.string().refine(value=>Number.isFinite(Date.parse(value)));
const schema=z.object({
 query:z.object({from:z.string(),to:z.string(),timeZone:z.string(),kind:z.enum(['pageviews','custom']),groupBy:z.enum(['path','event']),groupProperty:z.null(),filters:z.record(z.string(),z.string()),property:z.object({key:z.string(),type:z.string(),value:z.unknown()}).strict().nullable(),predicates:z.unknown().optional(),cohort:z.object({id:z.uuid(),revision:count.min(1)}).strict().optional()}).strict(),
 range:z.object({from:z.string(),to:z.string(),timeZone:z.string(),start:time,end:time}).strict(),
 coverage:z.object({status:z.enum(['complete','partial','unavailable']),retainedFrom:time.nullable()}).strict(),
 breakdown:z.object({groups:z.array(z.object({type:z.string().max(32),value:z.unknown(),events:count.min(1),identifiedEvents:count,visitors:count.nullable()}).strict()).max(100),totalGroups:count.nullable(),returnedGroupEvents:count.nullable(),truncated:z.boolean()}).strict(),
 cohort:z.unknown().optional(),sessionProperties:z.unknown().optional(),predicateMethod:z.unknown().optional(),
});
const same=(a:unknown,b:unknown):boolean=>a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)&&Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([key,value])=>Object.hasOwn(b,key)&&same(value,(b as Record<string,unknown>)[key]));

// The Explorer query is already built by its existing draft serializer.
export function journeyStepOptionsQuery(query:string,kind:JourneyStep['kind']):{qs:string}|{error:string}{
 const p=new URLSearchParams(query),activity=kind==='pageview'?'pageviews':'custom';
 if(p.get('kind')!=='all'&&p.get('kind')!==activity)return{error:'Activity type and step type do not overlap. No suggestions in this draft scope.'};
 p.set('kind',activity);p.set('groupBy',kind==='pageview'?'path':'event');p.delete('groupProperty');return{qs:p.toString()};
}
export function readJourneyStepOptions(value:unknown,query:string,kind:JourneyStep['kind']){
 const fail=():never=>{throw Error('The step suggestions could not be verified. Load suggestions again.');},parsed=schema.safeParse(value);if(!parsed.success)return fail();
 const data=parsed.data,p=new URLSearchParams(query),filters:Record<string,string>={};
 const reserved=new Set(['from','to','timeZone','kind','groupBy','groupProperty','propertyKey','propertyType','propertyValue','predicates','cohortId','cohortRevision']);for(const[key,v]of p)if(!reserved.has(key))filters[key]=v;
 let property:unknown=null,predicates:unknown;try{if(p.has('propertyKey')){const type=p.get('propertyType');let v=type==='missing'?null:JSON.parse(p.get('propertyValue')!);property={key:p.get('propertyKey'),type,value:v};}if(p.has('predicates'))predicates=JSON.parse(p.get('predicates')!);}catch{return fail();}
 const q=data.query,expected={from:p.get('from'),to:p.get('to'),timeZone:new Intl.DateTimeFormat('en-US',{timeZone:p.get('timeZone')!}).resolvedOptions().timeZone,kind:kind==='pageview'?'pageviews':'custom',groupBy:kind==='pageview'?'path':'event',groupProperty:null,filters,property,...(predicates?{predicates}:{}),...(p.has('cohortId')?{cohort:{id:p.get('cohortId'),revision:Number(p.get('cohortRevision'))}}:{})};
 if(!same(q,expected)||data.range.from!==q.from||data.range.to!==q.to||data.range.timeZone!==q.timeZone||Date.parse(data.range.start)>Date.parse(data.range.end))return fail();
 const b=data.breakdown,seen=new Set<string>();let events=0,prior=Number.MAX_SAFE_INTEGER;
 for(const group of b.groups){const key=JSON.stringify([group.type,group.value]);if(seen.has(key)||group.events>prior||group.identifiedEvents>group.events||group.visitors!==null&&group.visitors>group.identifiedEvents||group.identifiedEvents===0&&group.visitors!==null||group.identifiedEvents>0&&group.visitors===null)return fail();seen.add(key);events+=group.events;prior=group.events;}
 if(b.totalGroups===null){if(b.groups.length||b.returnedGroupEvents!==null||b.truncated)return fail();}else if(b.groups.length!==Math.min(100,b.totalGroups)||b.truncated!==(b.totalGroups>100)||b.returnedGroupEvents!==events)return fail();
 const unavailable=data.coverage.status==='unavailable'||b.totalGroups===null;
 const options=unavailable?[]:b.groups.flatMap(group=>group.type==='string'&&journeyStepSchema.safeParse({kind,value:group.value}).success?[group.value as string]:[]);
 return{options,totalGroups:b.totalGroups,truncated:b.truncated,unavailable,partial:data.coverage.status==='partial',source:data};
}
