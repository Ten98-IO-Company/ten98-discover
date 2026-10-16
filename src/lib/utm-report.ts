import type {ExploreResult} from '../components/ExplorerPanel';

export const utmFields=[['campaignSource','Source'],['campaignMedium','Medium'],['campaignName','Campaign'],['campaignContent','Content'],['campaignTerm','Term']] as const;
export type UtmField=typeof utmFields[number][0];
export const utmFilterFields=['path','origin','referrer','language',...utmFields.map(([field])=>field)] as const;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const predicates=(field:UtmField)=>({version:1,match:'all',fields:[{field,operator:'neq',value:''}],properties:[]});

/** Exact filters remain ANDed with this field's nonempty-tag condition. Never flatten an arbitrary predicate. */
export function buildUtmParams(scope:URLSearchParams,field:UtmField):URLSearchParams{
  if(!utmFields.some(([key])=>key===field))throw new Error('Choose a supported campaign field.');
  const allowed=new Set<string>(['from','to','timeZone','kind','groupBy',...utmFilterFields]);
  for(const key of scope.keys())if(!allowed.has(key)||scope.getAll(key).length!==1)throw new Error('Use only the shared dates, time zone and exact UTM filters.');
  if(['from','to','timeZone'].some(key=>!scope.get(key))||scope.has('kind')&&scope.get('kind')!=='pageviews'||scope.has('groupBy')&&!utmFields.some(([key])=>key===scope.get('groupBy')))throw new Error('Choose a pageview campaign scope.');
  if(scope.has('origin')){try{const url=new URL(scope.get('origin')!);if(!['http:','https:'].includes(url.protocol)||url.origin!==scope.get('origin'))throw new Error();}catch{throw new Error('Origin must be an exact HTTP(S) origin, such as https://www.example.com, without a path.');}}
  const params=new URLSearchParams(scope);params.set('kind','pageviews');params.set('groupBy',field);params.set('predicates',JSON.stringify(predicates(field)));
  if(params.toString().length>20000)throw new Error('These filters are too large. Shorten the exact values.');return params;
}

/** UTM-specific checks; callers also compose the shared range/daily/retention and cohort validators. */
export function validUtmResult(value:unknown,params:URLSearchParams):value is ExploreResult{
  if(!record(value)||!record(value.query)||!record(value.totals)||!record(value.breakdown)||!record(value.coverage))return false;
  const field=params.get('groupBy') as UtmField,query=value.query,totals=value.totals,breakdown=value.breakdown;
  if(!utmFields.some(([key])=>key===field)||params.get('kind')!=='pageviews'||params.get('predicates')!==JSON.stringify(predicates(field)))return false;
  const scope=new URLSearchParams(params);scope.delete('predicates');
  try{buildUtmParams(scope,field);}catch{return false;}
  if(query.kind!=='pageviews'||query.groupBy!==field||query.groupProperty!==null||query.property!==null||['fields','cohort'].some(key=>Object.hasOwn(query,key))||['cohort','sessionProperties','propertyReport','geographyProvenance'].some(key=>Object.hasOwn(value,key))||value.numeric!==null)return false;
  if(JSON.stringify(query.predicates)!==JSON.stringify(predicates(field))||!record(query.filters))return false;
  const filters=Object.fromEntries(utmFilterFields.filter(key=>params.has(key)).map(key=>[key,params.get(key)]));
  if(Object.keys(query.filters).length!==Object.keys(filters).length||Object.entries(filters).some(([key,expected])=>(query.filters as Record<string,unknown>)[key]!==expected))return false;
  if(!Array.isArray(breakdown.groups)||typeof breakdown.truncated!=='boolean')return false;
  if(value.coverage.status==='unavailable')return Object.values(totals).length===7&&Object.values(totals).every(n=>n===null)&&breakdown.groups.length===0&&breakdown.totalGroups===0&&breakdown.returnedGroupEvents===0&&!breakdown.truncated;
  if(!['complete','partial'].includes(String(value.coverage.status))||!count(totals.events)||!count(totals.pageViews)||totals.events!==totals.pageViews||totals.customEvents!==0||!count(totals.identifiedEvents)||totals.identifiedEvents>totals.events||!count(totals.unidentifiedEvents)||totals.identifiedEvents+totals.unidentifiedEvents!==totals.events)return false;
  if(!count(breakdown.totalGroups)||breakdown.totalGroups>totals.events||breakdown.groups.length!==Math.min(100,breakdown.totalGroups)||breakdown.truncated!==(breakdown.totalGroups>100)||!count(breakdown.returnedGroupEvents))return false;
  let events=0,identified=0,previous=Infinity;const seen=new Set<string>();
  for(const row of breakdown.groups){
    if(!record(row)||Object.keys(row).sort().join(',')!=='events,identifiedEvents,type,value,visitors'||row.type!=='string'||typeof row.value!=='string'||row.value.length===0||row.value.length>320||row.value.includes('\0')||new TextDecoder().decode(new TextEncoder().encode(row.value))!==row.value||seen.has(row.value))return false;
    if(!count(row.events)||row.events<1||row.events>previous||row.events>totals.events||!count(row.identifiedEvents)||row.identifiedEvents>row.events||row.identifiedEvents>totals.identifiedEvents)return false;
    if(row.identifiedEvents===0?row.visitors!==null:!count(row.visitors)||row.visitors<1||row.visitors>row.identifiedEvents||!count(totals.visitors)||row.visitors>totals.visitors)return false;
    previous=row.events;seen.add(row.value);events+=row.events;identified+=row.identifiedEvents;
  }
  return Number.isSafeInteger(events)&&Number.isSafeInteger(identified)&&events===breakdown.returnedGroupEvents&&events<=totals.events&&identified<=totals.identifiedEvents&&(breakdown.truncated?totals.events-events>=breakdown.totalGroups-breakdown.groups.length:events===totals.events&&identified===totals.identifiedEvents);
}
