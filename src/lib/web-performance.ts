import {z} from 'zod';
import {analyticsDay} from './navigation.ts';
import {isEnvironmentFilter} from './analytics-environment.ts';

export const performanceMetrics=['lcp','inp','cls','fcp','ttfb'] as const;
export type PerformanceMetric=typeof performanceMetrics[number];
export const performanceBreakdowns=['path','browser','os','device'] as const;
export const performanceLabels={lcp:'Largest contentful paint',inp:'Interaction to next paint',cls:'Cumulative layout shift',fcp:'First contentful paint',ttfb:'Time to first byte'} as const;
// Google web-vitals thresholds; CLS is unitless, the other measurements are milliseconds.
export const performanceThresholds={lcp:[2500,4000],inp:[200,500],cls:[0.1,0.25],fcp:[1800,3000],ttfb:[800,1800]} as const;
export function performanceRating(metric:PerformanceMetric,value:number|null){
  if(value===null)return 'unavailable' as const;
  const [good,poor]=performanceThresholds[metric];
  return value<=good?'good' as const:value<=poor?'needs-improvement' as const:'poor' as const;
}
export function performanceValue(metric:PerformanceMetric,value:number|null){
  if(value===null)return 'Unavailable';
  return metric==='cls'?new Intl.NumberFormat(undefined,{maximumFractionDigits:3}).format(value):new Intl.NumberFormat(undefined,{maximumFractionDigits:0}).format(value)+' ms';
}

const clean=(value:string)=>!/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
const filterSchema=z.object({browser:z.string().max(160).optional(),os:z.string().max(160).optional(),device:z.string().max(160).optional()}).strict();
export const performanceObservation=z.object({
  type:z.literal('performance'),siteKey:z.uuid(),navigationId:z.uuid(),metric:z.enum(performanceMetrics),
  value:z.number().finite().nonnegative(),revision:z.number().int().min(1).max(1000000),
  url:z.string().max(4096).url().refine(value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/[?#]/.test(value)&&clean(value);}catch{return false;}}),
  dimensions:z.object({screen:z.object({width:z.number().int().min(1).max(20000),height:z.number().int().min(1).max(20000)}).strict().optional()}).strict().optional(),
  consent:z.object({analytics:z.literal(true),epoch:z.uuid()}).strict().optional(),
  collection:z.object({mode:z.literal('cookieless'),epoch:z.uuid()}).strict().optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.value>(value.metric==='cls'?1000:3600000))ctx.addIssue({code:'custom',message:'Performance value is outside the supported range.',path:['value']});
  if(Boolean(value.consent)===Boolean(value.collection))ctx.addIssue({code:'custom',message:'Use exactly one current collection proof.'});
});
export type PerformanceObservation=z.infer<typeof performanceObservation>;

export type PerformanceIntent={from:string;to:string;metric:PerformanceMetric;percentile:50|75|95;breakdown:typeof performanceBreakdowns[number];filters:z.infer<typeof filterSchema>;path?:string};
export function readPerformanceQuery(raw:URLSearchParams|string,now=new Date()):PerformanceIntent{
  let params:URLSearchParams;
  if(typeof raw==='string'){
    if(raw.length>6144)throw new Error('The performance link is too long.');
    try{decodeURIComponent(raw.replace(/\+/g,' '));}catch{throw new Error('The performance link has invalid encoding.');}
    params=new URLSearchParams(raw);
  }else params=raw;
  const allowed=['from','to','metric','percentile','breakdown','browser','os','device','path'];
  if(params.toString().length>6144||[...params.keys()].some(key=>!allowed.includes(key)||params.getAll(key).length!==1))throw new Error('Use each supported performance filter once.');
  if(params.has('from')!==params.has('to'))throw new Error('Choose both dates.');
  const to=params.get('to')??now.toISOString().slice(0,10),from=params.get('from')??new Date((analyticsDay(to)??NaN)-6*86400000).toISOString().slice(0,10);
  const start=analyticsDay(from),end=analyticsDay(to);
  if(start===null||end===null||start>end||(end-start)/86400000>=366)throw new Error('Choose valid dates covering 1 to 366 days.');
  const metric=z.enum(performanceMetrics).parse(params.get('metric')??'lcp'),percentile=z.enum(['50','75','95']).parse(params.get('percentile')??'75'),breakdown=z.enum(performanceBreakdowns).parse(params.get('breakdown')??'path');
  const filters:z.infer<typeof filterSchema>={};
  for(const field of ['browser','os','device'] as const){const value=params.get(field);if(value!==null){if(!isEnvironmentFilter(field,value))throw new Error('Choose a supported browser or device filter.');filters[field]=value;}}
  const path=params.get('path');
  if(path!==null&&(!path.startsWith('/')||path.length>2048||/[?#]/.test(path)||!clean(path)))throw new Error('Choose a page path without a query or fragment.');
  return{from,to,metric,percentile:Number(percentile) as 50|75|95,breakdown,filters,...path===null?{}:{path}};
}
export function performanceQuery(intent:PerformanceIntent){
  const p=new URLSearchParams({from:intent.from,to:intent.to,metric:intent.metric,percentile:String(intent.percentile),breakdown:intent.breakdown,...intent.filters});
  if(intent.path!==undefined)p.set('path',intent.path);
  return p.toString();
}

const percentile=z.number().finite().nonnegative().nullable();
export const performanceStats=z.object({count:z.number().int().nonnegative(),p50:percentile,p75:percentile,p95:percentile}).strict().superRefine((v,c)=>{
  if(v.count===0?[v.p50,v.p75,v.p95].some(n=>n!==null):[v.p50,v.p75,v.p95].some(n=>n===null))c.addIssue({code:'custom',message:'Missing measurements must stay unavailable.'});
  if(v.p50!==null&&v.p75!==null&&v.p95!==null&&(v.p50>v.p75||v.p75>v.p95))c.addIssue({code:'custom',message:'Percentiles must be ordered.'});
});
export type PerformanceStats=z.infer<typeof performanceStats>;
export const performanceReport=z.object({
  version:z.literal(1),projectId:z.uuid(),role:z.enum(['owner','admin','editor','viewer']),enabled:z.boolean(),
  query:z.object({from:z.string(),to:z.string(),metric:z.enum(performanceMetrics),percentile:z.union([z.literal(50),z.literal(75),z.literal(95)]),breakdown:z.enum(performanceBreakdowns),filters:filterSchema,path:z.string().optional()}).strict(),
  asOf:z.string().datetime(),retainedFrom:z.string().datetime().nullable(),
  summary:z.record(z.enum(performanceMetrics),performanceStats),
  daily:z.array(z.object({day:z.string(),stats:performanceStats}).strict()).max(366),
  breakdown:z.object({items:z.array(z.object({value:z.string().nullable(),stats:performanceStats}).strict()).max(50),limited:z.boolean()}).strict(),
}).strict();
export type PerformanceReport=z.infer<typeof performanceReport>;
