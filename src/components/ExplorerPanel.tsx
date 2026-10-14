import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {api,ApiError,errMsg} from '../lib/api';
import {useAnnotations} from './AnnotationsPanel';
import type {AdvancedPredicates} from '../server/advanced-predicate-input';
import type {advancedPredicateMethod} from '../server/advanced-predicates';

type Coverage='complete'|'partial'|'unavailable';

interface ExploreResult{
  range:{from:string;to:string;timeZone:string;start:string;end:string};
  query:{from:string;to:string;timeZone:string;kind:string;groupBy:string;groupProperty:string|null;filters:Record<string,string>;property:{key:string;type:string;value:unknown}|null;cohort?:CohortRef;predicates?:AdvancedPredicates};
  predicateMethod?:ReturnType<typeof advancedPredicateMethod>;
  coverage:{status:Coverage;retainedFrom:string|null};
  totals:{events:number|null;pageViews:number|null;customEvents:number|null;identifiedEvents:number|null;unidentifiedEvents:number|null;visitors:number|null;visits:number|null};
  daily:Array<{date:string;start:string;end:string;skipped:boolean;coverage:Coverage;events:number|null;pageViews:number|null;customEvents:number|null}>;
  breakdown:{groups:Array<{type:string;value:unknown;events:number;identifiedEvents:number;visitors:number|null}>;totalGroups:number|null;returnedGroupEvents:number|null;truncated:boolean};
  properties:{keys:string[];truncated:boolean};
  numeric:{samples:number;sum:string|null;average:string|null;min:string|null;max:string|null}|null;
  csv:string;
  cohort?:{item:SavedFilter;range:{from:string;to:string;timeZone:string;start:string;end:string};coverage:{status:Coverage;retainedFrom:string|null};identity:{status:Coverage;identifiedEvents:number|null;unidentifiedEvents:number|null;observedMemberKeys:number|null};membership:{status:'available'|'unavailable';countsAreLowerBounds:boolean};limitation:string;predicateMethod?:ReturnType<typeof advancedPredicateMethod>};
}

const KINDS=[['all','All events'],['pageviews','Page views'],['custom','Custom events']] as const;
const GROUPS=[['event','Event name'],['path','Path'],['origin','Origin'],['referrer','Referrer'],['language','Language'],['campaignSource','Campaign source'],['campaignMedium','Campaign medium'],['campaignName','Campaign name'],['campaignTerm','Campaign term'],['campaignContent','Campaign content'],['screenWidth','Screen width'],['screenHeight','Screen height'],['property','Property']] as const;
const FILTERS=[['eventName','Event name'],['path','Path'],['origin','Origin'],['referrer','Referrer'],['language','Language'],['campaignSource','Campaign source'],['campaignMedium','Campaign medium'],['campaignName','Campaign name'],['campaignTerm','Campaign term'],['campaignContent','Campaign content']] as const;
const PROP_TYPES=['missing','string','number','boolean','null','date','array'] as const;
const TIMEZONES=['UTC','America/New_York','America/Chicago','America/Los_Angeles','Europe/London','Europe/Berlin','Asia/Dubai','Asia/Tokyo','Australia/Sydney'];

const utcDate=(d:Date)=>d.toISOString().slice(0,10);
const labelOf=(list:readonly (readonly [string,string])[],v:string)=>list.find(([k])=>k===v)?.[1]??v;
const num=(v:number|null)=>v==null?'Unavailable':String(v);
const decimal=(v:string|null)=>v===null?'Unavailable':v.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');

interface FilterRow{on:boolean;value:string}
type AdvancedRow={id:string;field:string;operator:string;type:string;value:string};
type AdvancedDraft={match:'all'|'any';fields:AdvancedRow[];properties:AdvancedRow[]};
type AdvancedIssue={error:string;row?:string;part?:'field'|'operator'|'type'|'value'};
function emptyAdvanced():AdvancedDraft{return {match:'all',fields:[],properties:[]};}
interface Draft{
  from:string;to:string;timeZone:string;kind:string;groupBy:string;groupProperty:string;
  filters:Record<string,FilterRow>;
  prop:{on:boolean;key:string;type:string;value:string};
  advanced:AdvancedDraft;
}

function initialDraft():Draft{
  const now=Date.now();
  const filters:Record<string,FilterRow>={};
  for(const [k] of FILTERS)filters[k]={on:false,value:''};
  return{from:utcDate(new Date(now-6*864e5)),to:utcDate(new Date(now)),timeZone:'UTC',kind:'all',groupBy:'event',groupProperty:'',filters,prop:{on:false,key:'',type:'missing',value:''},advanced:emptyAdvanced()};
}

function buildParams(d:Draft):{qs:string}|{error:string;advanced?:AdvancedIssue}{
  const from=Date.parse(d.from),to=Date.parse(d.to);
  const days=(to-from)/864e5+1;
  if(!d.from||!d.to||Number.isNaN(from)||Number.isNaN(to)||to<from||days>366)
    return{error:'Enter a valid range of 1 to 366 days.'};
  if(!d.timeZone.trim())return{error:'Enter an IANA time zone, e.g. UTC or America/New_York.'};
  if(d.groupBy==='property'&&!d.groupProperty.length)return{error:'Enter a property key to group by.'};
  const p=new URLSearchParams();
  p.set('from',d.from);p.set('to',d.to);p.set('timeZone',d.timeZone.trim());
  p.set('kind',d.kind);p.set('groupBy',d.groupBy);
  if(d.groupBy==='property')p.set('groupProperty',d.groupProperty);
  for(const [k] of FILTERS){const f=d.filters[k];if(f.on)p.set(k,f.value);}
  if(d.prop.on){
    const key=d.prop.key;
    if(!key)return{error:'Enter a property key for the property filter, or turn it off.'};
    p.set('propertyKey',key);p.set('propertyType',d.prop.type);
    if(d.prop.type!=='missing'){
      const raw=d.prop.value.trim();
      if(!raw)return{error:'Enter the property value as a JSON literal, e.g. "starter", 42, true, null.'};
      try{JSON.parse(raw);}catch{return{error:'The property value is not valid JSON. Use a literal like "starter", 42, true, null or ["a",1].'};}
      p.set('propertyValue',raw);
    }
  }
  const advanced=buildAdvanced(d.advanced);if('error'in advanced)return {error:advanced.error,advanced};
  if(advanced.predicates)p.set('predicates',JSON.stringify(advanced.predicates));
  if(p.toString().length>20000)return {error:'These filters are too large. Shorten values or remove conditions.'};
  return{qs:p.toString()};
}

type Role='owner'|'admin'|'editor'|'viewer';
type Definition={schemaVersion:1;name:string;query:string};
type SavedFilter={id:string;projectId:string;revision:number;definition:Definition;createdAt:string;updatedAt:string};
type SaveAttempt={kind:'create'|'update'|'delete';id?:string;body:{requestId:string;revision?:number;definition?:Definition}};
type CohortRef={id:string;revision:number};
type CohortEditor={item:SavedFilter|null;name:string;draft:Draft};
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const clean=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max&&!value.includes('\0')&&new TextDecoder().decode(new TextEncoder().encode(value))===value;
const roleValue=(value:unknown):value is Role=>['owner','admin','editor','viewer'].includes(value as string);
const canSave=(role:Role|null)=>role==='owner'||role==='admin'||role==='editor';
// Reuse Explorer's serializer; saved predicates deliberately have no report context.
function draftFilterQuery(draft:Draft){
  const built=buildParams({...draft,from:'2000-01-01',to:'2000-01-01',timeZone:'UTC',groupBy:'event',groupProperty:''});
  if('error'in built)return built;
  const query=new URLSearchParams(built.qs);for(const key of ['from','to','timeZone','groupBy','groupProperty'])query.delete(key);
  return {qs:query.toString()};
}
function savedPredicates(query:unknown):Pick<Draft,'kind'|'filters'|'prop'|'advanced'>|null{
  if(!clean(query,20000))return null;
  const p=new URLSearchParams(query),allowed=new Set<string>(['kind',...FILTERS.map(([key])=>key),'propertyKey','propertyType','propertyValue','predicates']);
  for(const [key,value] of p)if(!allowed.has(key)||p.getAll(key).length!==1||!clean(value,key==='predicates'?20000:['path','origin'].includes(key)?2048:key==='propertyValue'?8192:320))return null;
  const kind=p.get('kind');if(!KINDS.some(([key])=>key===kind))return null;
  const filters=Object.fromEntries(FILTERS.map(([key])=>[key,{on:p.has(key),value:p.get(key)??''}]));
  let prop=initialDraft().prop;
  if(['propertyKey','propertyType','propertyValue'].some(key=>p.has(key))){
    const key=p.get('propertyKey'),type=p.get('propertyType'),value=p.get('propertyValue');
    if(!key||!PROP_TYPES.some(t=>t===type)||type==='missing'&&value!==null||type!=='missing'&&value===null)return null;
    if(type!=='missing'){
      let parsed:unknown;try{parsed=JSON.parse(value!);}catch{return null;}
      if(type==='null'?parsed!==null:type==='array'?!Array.isArray(parsed):type==='date'?typeof parsed!=='string'||!Number.isFinite(Date.parse(parsed)):typeof parsed!==type)return null;
    }
    prop={on:true,key,type:type!,value:value??''};
  }
  let advanced=emptyAdvanced();if(p.has('predicates')){try{const parsed=readAdvanced(JSON.parse(p.get('predicates')!));if(!parsed)return null;advanced=parsed;}catch{return null;}}
  return {kind:kind!,filters,prop,advanced};
}
function validSaved(value:unknown,projectId:string):value is SavedFilter{
  if(!record(value)||!uuid(value.id)||value.projectId!==projectId||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||Number(value.revision)>2147483647||!record(value.definition))return false;
  const d=value.definition;return d.schemaVersion===1&&clean(d.name,200)&&d.name.trim().length>0&&savedPredicates(d.query)!==null&&['createdAt','updatedAt'].every(key=>typeof value[key]==='string'&&Number.isFinite(Date.parse(value[key] as string)));
}
function sameDefinition(expected:Definition,actual:Definition){
  const normalize=(query:string)=>{const value=savedPredicates(query);if(!value)return null;let literal:unknown=value.prop.type==='missing'?null: value.prop.on?JSON.parse(value.prop.value):null;
    if(value.prop.on&&value.prop.type==='date')literal=preciseDate(literal);
    const advanced=buildAdvanced(value.advanced);return {...value,prop:{...value.prop,value:literal},advanced:'predicates'in advanced?advanced.predicates:null};};
  return expected.name.trim()===actual.name&&JSON.stringify(normalize(expected.query))===JSON.stringify(normalize(actual.query));
}

const OPERATORS=[['eq','Equals'],['neq','Does not equal'],['contains','Contains'],['not_contains','Does not contain'],['prefix','Starts with'],['suffix','Ends with'],['regex','Matches pattern'],['not_regex','Does not match pattern'],['gt','Greater than'],['gte','At least'],['lt','Less than'],['lte','At most'],['before','Before day'],['after','After day'],['includes','Includes element'],['not_includes','Does not include element'],['exists','Is present'],['missing','Is missing']] as const;
const presence=(operator:string)=>operator==='exists'||operator==='missing';
const dayOperator=(operator:string)=>operator==='before'||operator==='after';
function rowOperators(property:boolean,type:string):string[]{return [...(!property||type==='string'?['eq','neq','contains','not_contains','prefix','suffix','regex','not_regex']:type==='number'?['eq','neq','gt','gte','lt','lte']:type==='date'?['eq','neq','before','after']:type==='array'?['eq','neq','includes','not_includes']:['eq','neq']), 'exists','missing'];}
// Keep the original fraction separately: Date only converts whole seconds/offsets.
function preciseDate(value:unknown):string|null{
  if(!clean(value,1000))return null;const m=/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);if(!m||m[0]!==value)return null;
  const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number),offset=m[8],oh=/^[Zz]$/.test(offset)?0:Number(offset.slice(1,3)),om=/^[Zz]$/.test(offset)?0:Number(offset.slice(4,6));
  if(hour>23||minute>59||second>59||oh>23||om>59||offset==='-00:00')return null;
  const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,second,0);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
  date.setUTCMinutes(date.getUTCMinutes()-(oh*60+om)*(offset.startsWith('-')?-1:1));if(date.getUTCFullYear()<0||date.getUTCFullYear()>9999)return null;
  return date.toISOString().slice(0,19)+'.'+(m[7]??'000').padEnd(3,'0')+'Z';
}
function buildAdvanced(draft:AdvancedDraft):{predicates?:AdvancedPredicates}|AdvancedIssue{
  const count=draft.fields.length+draft.properties.length;if(!count)return {};
  if(count>20||draft.properties.length>10||!['all','any'].includes(draft.match)||draft.match==='any'&&!draft.fields.length)return {error:'Use at most 20 additional conditions, including 10 property conditions. Any requires a field condition.'};
  const fields:AdvancedPredicates['fields']=[],properties:AdvancedPredicates['properties']=[];
  const scalar=(value:unknown)=>value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e15||clean(value,1000);
  for(const [property,rows]of [[false,draft.fields],[true,draft.properties]] as const)for(const [index,row]of rows.entries()){
    const issue=(part:AdvancedIssue['part'],message:string):AdvancedIssue=>({error:`${property?'Property':'Field'} condition ${index+1}: ${message}`,row:row.id,part});
    if(property?!clean(row.field,320)||!row.field.length:!FILTERS.some(([key])=>key===row.field))return issue('field',property?'enter a property key.':'choose a field.');
    if(!rowOperators(property,row.type).includes(row.operator))return issue('operator','choose a supported operator for this type.');
    if(presence(row.operator)){(property?properties:fields).push((property?{key:row.field,operator:row.operator}:{field:row.field,operator:row.operator}) as never);continue;}
    if(property&&!PROP_TYPES.filter(type=>type!=='missing').includes(row.type as never))return issue('type','choose a property type.');
    let value:unknown=row.value;
    if(property&&!dayOperator(row.operator)){try{value=JSON.parse(row.value);}catch{return issue('value','enter a valid JSON value of the selected type.');}}
    if(!property||row.type==='string'){
      if(!clean(value,property?1000:['path','origin'].includes(row.field)?2048:320)||!['eq','neq'].includes(row.operator)&&!value.length)return issue('value','enter supported text within the limit; search and pattern values cannot be empty.');
      if(!property&&row.field==='origin'&&['eq','neq'].includes(row.operator)){try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.origin!==value)return issue('value','enter an exact HTTP(S) origin without a path.');}catch{return issue('value','enter an exact HTTP(S) origin without a path.');}}
    }else if(row.type==='date'){
      if(dayOperator(row.operator)){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1970-01-01'||value>'9998-12-31'||!preciseDate(value+'T00:00:00Z'))return issue('value','choose a real comparison day from 1970 to 9998.');}
      else{value=preciseDate(value);if(value===null)return issue('value','enter a valid ISO date string with an explicit offset.');}
    }else if(row.type==='array'){
      if(['includes','not_includes'].includes(row.operator)){if(!scalar(value))return issue('value','enter one JSON string, number, boolean or null.');}
      else if(!Array.isArray(value)||value.length>50||!value.every(scalar)||new TextEncoder().encode(JSON.stringify(value)).length>4096)return issue('value','enter an array of at most 50 scalar values and 4096 bytes.');
    }else if(row.type==='null'?value!==null:typeof value!==row.type||!scalar(value))return issue('value',`enter a JSON value that matches ${row.type}.`);
    if(property)properties.push({key:row.field,operator:row.operator,type:row.type,value} as AdvancedPredicates['properties'][number]);
    else fields.push({field:row.field,operator:row.operator,value} as AdvancedPredicates['fields'][number]);
  }
  const predicates:AdvancedPredicates={version:1,match:draft.match,fields,properties};
  if(new URLSearchParams({predicates:JSON.stringify(predicates)}).toString().length>20000)return {error:'These filters are too large. Shorten values or remove conditions.'};
  return {predicates};
}
function readAdvanced(value:unknown):AdvancedDraft|null{
  if(!record(value)||Object.keys(value).some(key=>!['version','match','fields','properties'].includes(key))||value.version!==1||!['all','any'].includes(value.match as string)||!Array.isArray(value.fields)||!Array.isArray(value.properties)||!value.fields.length&&!value.properties.length)return null;
  const draft=emptyAdvanced();draft.match=value.match as 'all'|'any';
  for(const [property,rows]of [[false,value.fields],[true,value.properties]] as const)for(const [index,row]of rows.entries()){
    if(!record(row)||typeof row.operator!=='string')return null;const keys=presence(row.operator)?[property?'key':'field','operator']:property?['key','operator','type','value']:['field','operator','value'];
    if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key))||Object.keys(row).some(key=>!keys.includes(key))||!presence(row.operator)&&(property?typeof row.type!=='string':typeof row.value!=='string')||typeof row[property?'key':'field']!=='string')return null;
    (property?draft.properties:draft.fields).push({id:(property?'p':'f')+index,field:row[property?'key':'field'] as string,operator:row.operator,type:property&&!presence(row.operator)?row.type as string:'',value:presence(row.operator)?'':property&&!dayOperator(row.operator)?JSON.stringify(row.value):row.value as string});
  }
  return 'error'in buildAdvanced(draft)?null:draft;
}
function focusAdvanced(id:string,issue?:AdvancedIssue){const root=document.getElementById(id) as HTMLDetailsElement|null;if(!root)return;root.open=true;const input=issue?.row?document.getElementById(`${id}-${issue.row}-${issue.part}`):root.querySelector<HTMLElement>('[data-pattern]');input?.focus();}
function validAdvancedResult(value:unknown,method:unknown,expected?:AdvancedPredicates){
  if(!expected)return value===undefined&&method===undefined;const draft=readAdvanced(value);if(!draft||!record(method))return false;const parsed=buildAdvanced(draft);
  return 'predicates'in parsed&&JSON.stringify(parsed.predicates)===JSON.stringify(expected)&&method.version==='native-flat-predicates-v1'&&method.requiredFilters==='all'&&method.fieldMatch===expected.match&&method.propertyMatch==='all'&&method.textSearch==='postgresql-lower-literal'&&method.regex==='postgresql-case-insensitive'&&method.dateComparison==='calendar-day-in-scope-timezone';
}

function qualificationDraft(query:unknown):Draft|null{
  if(!clean(query,20000))return null;const p=new URLSearchParams(query),dates=['from','to','timeZone'];
  if(dates.some(key=>p.getAll(key).length!==1)||p.has('path')===p.has('eventName'))return null;
  const from=p.get('from')!,to=p.get('to')!,zone=p.get('timeZone')!;
  if([from,to].some(day=>!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)||from>to||(Date.parse(to)-Date.parse(from))/864e5>=366||!clean(zone,80))return null;
  let timeZone:string;try{timeZone=new Intl.DateTimeFormat('en-US',{timeZone:zone}).resolvedOptions().timeZone;}catch{return null;}
  dates.forEach(key=>p.delete(key));const predicates=savedPredicates(p.toString());return predicates?{...initialDraft(),...predicates,from,to,timeZone}:null;
}
function validCohort(value:unknown,projectId:string):value is SavedFilter{
  if(!record(value)||!record(value.definition)||!qualificationDraft(value.definition.query))return false;
  const p=new URLSearchParams(value.definition.query as string);for(const key of ['from','to','timeZone'])p.delete(key);
  return validSaved({...value,definition:{...value.definition,query:p.toString()}},projectId);
}
function sameCohortDefinition(expected:Definition,actual:Definition){
  const a=qualificationDraft(expected.query),b=qualificationDraft(actual.query);if(!a||!b||a.from!==b.from||a.to!==b.to||a.timeZone!==b.timeZone)return false;
  const x=draftFilterQuery(a),y=draftFilterQuery(b);return 'qs'in x&&'qs'in y&&sameDefinition({...expected,query:x.qs},{...actual,query:y.qs});
}
function reportParams(draft:Draft,cohort:CohortRef|null){const result=buildParams(draft);if('error'in result||!cohort)return result;const p=new URLSearchParams(result.qs);p.set('cohortId',cohort.id);p.set('cohortRevision',String(cohort.revision));return {qs:p.toString()};}
function validCohortResult(result:ExploreResult,params:URLSearchParams,projectId:string){
  const expected=params.has('predicates')?JSON.parse(params.get('predicates')!) as AdvancedPredicates:undefined;
  if(!validAdvancedResult(result.query.predicates,result.predicateMethod,expected))return false;
  const c=result.cohort;if(!params.has('cohortId'))return !c&&!result.query.cohort;
  if(!c||!validCohort(c.item,projectId)||c.item.id!==params.get('cohortId')||c.item.revision!==Number(params.get('cohortRevision'))||result.query.cohort?.id!==c.item.id||result.query.cohort.revision!==c.item.revision)return false;
  const d=qualificationDraft(c.item.definition.query)!;
  const qualified=buildAdvanced(d.advanced);if('error'in qualified||!validAdvancedResult(qualified.predicates,c.predicateMethod,qualified.predicates))return false;
  if(!c.range||c.range.from!==d.from||c.range.to!==d.to||c.range.timeZone!==d.timeZone||![c.range.start,c.range.end].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v)))||!c.coverage||!['complete','partial','unavailable'].includes(c.coverage.status)||!c.identity||!['complete','partial','unavailable'].includes(c.identity.status)||!c.membership||!['available','unavailable'].includes(c.membership.status)||typeof c.membership.countsAreLowerBounds!=='boolean'||!clean(c.limitation,2000))return false;
  if(![c.identity.identifiedEvents,c.identity.unidentifiedEvents,c.identity.observedMemberKeys].every(n=>n===null||Number.isSafeInteger(n)&&n>=0))return false;
  if(c.coverage.retainedFrom!==null&&(typeof c.coverage.retainedFrom!=='string'||!Number.isFinite(Date.parse(c.coverage.retainedFrom))))return false;
  return c.membership.status!=='unavailable'||Object.values(result.totals).every(n=>n===null)&&result.daily.every(day=>day.events===null&&day.pageViews===null&&day.customEvents===null)&&result.numeric===null&&result.breakdown.groups.length===0&&result.breakdown.totalGroups===null&&result.breakdown.returnedGroupEvents===null&&result.properties.keys.length===0;
}

function groupValue(type:string,value:unknown):string{
  if(type==='missing')return 'Missing / uncollected';
  if(value===null)return 'null';
  if(typeof value==='string'&&value==='')return '(empty string)';
  if(Array.isArray(value))return JSON.stringify(value);
  return String(value);
}
const groupType=(type:string)=>type?type.charAt(0).toUpperCase()+type.slice(1):'Unknown';

function AdvancedSummary({draft,zone}:{draft:AdvancedDraft;zone:string}){
  const result=buildAdvanced(draft);if('error'in result)return <p className="hint">Additional conditions are incomplete: {result.error}</p>;
  if(!result.predicates)return null;
  return <div className="stack advanced-summary"><p><strong>Additional fields — {draft.match}</strong></p>{draft.fields.length?result.predicates.fields.map((row,index)=><p className="hint" key={index}>{labelOf(FILTERS,row.field)} · {labelOf(OPERATORS,row.operator)}{'value'in row?` ${JSON.stringify(row.value)}`:''}</p>):<p className="hint">No additional field group.</p>}<p><strong>Property conditions — all</strong></p>{result.predicates.properties.map((row,index)=><p className="hint" key={index}>{JSON.stringify(row.key)}{'type'in row?` · ${row.type}`:''} · {labelOf(OPERATORS,row.operator)}{'value'in row?` ${JSON.stringify(row.value)}`:''}{dayOperator(row.operator)?` (${zone}; selected day excluded)`:''}</p>)}<p className="hint">Required filters and all property conditions still apply. Literal text search ignores case; patterns use PostgreSQL case-insensitive matching.</p></div>;
}
function AdvancedControls({id,label,draft,zone,error,onChange}:{id:string;label:string;draft:AdvancedDraft;zone:string;error:string;onChange:(value:AdvancedDraft)=>void}){
  const [focus,setFocus]=useState<string|null>(null),[notice,setNotice]=useState('');const built=buildAdvanced(draft),issue=error&&'error'in built?built:null,count=draft.fields.length+draft.properties.length;
  useEffect(()=>{if(focus){document.getElementById(focus)?.focus();setFocus(null);}},[focus,draft]);
  function change(property:boolean,row:AdvancedRow,patch:Partial<AdvancedRow>){const key=property?'properties':'fields';onChange({...draft,[key]:draft[key].map(value=>value.id===row.id?{...value,...patch}:value)});}
  function add(property:boolean){const key=property?'properties':'fields',row={id:crypto.randomUUID(),field:'',type:'',operator:'eq',value:''};onChange({...draft,[key]:[...draft[key],row]});setFocus(`${id}-${row.id}-field`);setNotice(`${property?'Property':'Field'} condition added.`);}
  function remove(property:boolean,row:AdvancedRow){const key=property?'properties':'fields',index=draft[key].findIndex(value=>value.id===row.id),rows=draft[key].filter(value=>value.id!==row.id);onChange({...draft,[key]:rows,match:!property&&!rows.length?'all':draft.match});const next=rows[index]??rows[index-1];setFocus(next?`${id}-${next.id}-field`:`${id}-add-${key}`);setNotice(`${property?'Property':'Field'} condition removed.${!property&&!rows.length?' No additional field group. Every property condition is still required.':''}`);}
  return <details id={id} className="advanced-controls"><summary>{label} ({count} conditions)</summary><div className="stack"><p className="hint">Required filters and every property condition must match. Choose whether all or any additional field conditions must also match. Changes wait for {label==='Advanced filters'?'Apply filters':'Save cohort'}.{label!=='Advanced filters'?' All conditions apply to the same qualifying event. The qualifying action is always required.':''}</p>{!count&&<p className="hint">No additional conditions. Required filters still apply.</p>}{notice&&<p className="hint" role="status">{notice}</p>}
    {([false,true] as const).map(property=><fieldset key={String(property)} className="stack"><legend>{property?'Property conditions — all':'Additional fields'}</legend>{!property&&draft.fields.length>0&&<div><label htmlFor={`${id}-match`}>Match additional fields</label><select id={`${id}-match`} value={draft.match} onChange={e=>onChange({...draft,match:e.target.value as 'all'|'any'})}><option value="all">All conditions</option><option value="any">Any condition</option></select></div>}
      {(property?draft.properties:draft.fields).map((row,index)=>{const base=`${id}-${row.id}`,isPresence=presence(row.operator),isDay=dayOperator(row.operator),isPattern=['regex','not_regex'].includes(row.operator),rowIssue=issue?.row===row.id?issue:null;const invalid=(part:string)=>rowIssue?.part===part;
        return <fieldset className="stack advanced-row" key={row.id}><legend>{property?'Property':'Field'} condition {index+1}</legend><div className="row">
          <div className="advanced-field"><label htmlFor={`${base}-field`}>{property?'Property key':'Field'}</label>{property?<input id={`${base}-field`} maxLength={320} value={row.field} aria-invalid={invalid('field')} aria-describedby={`${base}-help${rowIssue?` ${base}-error`:''}`} onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();}} onChange={e=>change(property,row,{field:e.target.value})}/>:<select id={`${base}-field`} value={row.field} aria-invalid={invalid('field')} aria-describedby={rowIssue?`${base}-error`:undefined} onChange={e=>change(property,row,{field:e.target.value})}><option value="">Choose a field</option>{FILTERS.map(([key,name])=><option key={key} value={key}>{name}</option>)}</select>}</div>
          {property&&!isPresence&&<div className="advanced-field"><label htmlFor={`${base}-type`}>Property type</label><select id={`${base}-type`} value={row.type} aria-invalid={invalid('type')} aria-describedby={rowIssue?`${base}-error`:undefined} onChange={e=>{const type=e.target.value;change(property,row,{type,operator:rowOperators(property,type).includes(row.operator)?row.operator:'',...(isDay?{value:''}:{})});}}><option value="">Choose a type</option>{PROP_TYPES.filter(type=>type!=='missing').map(type=><option key={type} value={type}>{type}</option>)}</select></div>}
          <div className="advanced-field"><label htmlFor={`${base}-operator`}>Operator</label><select id={`${base}-operator`} value={row.operator} aria-invalid={invalid('operator')} aria-describedby={rowIssue?`${base}-error`:undefined} onChange={e=>{const operator=e.target.value;change(property,row,{operator,...(presence(operator)?{type:'',value:''}:dayOperator(operator)!==isDay?{value:''}:{})});}}><option value="">Choose an operator</option>{OPERATORS.filter(([operator])=>rowOperators(property,row.type).includes(operator)).map(([operator,name])=><option key={operator} value={operator}>{name}</option>)}</select></div>
          {!isPresence&&<div className="advanced-field"><label htmlFor={`${base}-value`}>{isDay?'Comparison day':property?row.type==='array'&&['includes','not_includes'].includes(row.operator)?'Element (JSON scalar)':'Value (JSON literal)':'Value'}</label><input id={`${base}-value`} type={isDay?'date':'text'} min={isDay?'1970-01-01':undefined} max={isDay?'9998-12-31':undefined} dir={property||isPattern?'ltr':undefined} value={row.value} data-pattern={isPattern?'true':undefined} aria-invalid={invalid('value')} aria-describedby={`${base}-help${rowIssue?` ${base}-error`:''}`} onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();}} onChange={e=>change(property,row,{value:e.target.value})}/></div>}
        </div><p className="hint" id={`${base}-help`}>{isPresence?'Presence includes collected null, empty strings and arrays. Missing means the field or key was not collected.':isDay?`Compares calendar days in ${zone}; the selected day is excluded.`:isPattern?'Case-insensitive PostgreSQL pattern. The server checks it when you apply or save.':row.type==='array'?'Whole-array equality is order-sensitive. An element keeps its JSON type: 1 and "1" are different.':row.type==='date'?'Use an ISO date string with an explicit offset; exact equality preserves fractional seconds.':!property||row.type==='string'?['eq','neq'].includes(row.operator)?!property&&row.field==='origin'?'Enter an exact HTTP(S) origin without a path. Equals is case-sensitive.':'Equals is case-sensitive. Spaces and commas are literal. Empty exact strings are valid; a property string uses JSON quotes.':'Text search ignores case. %, _ and backslash are literal. Enter a nonempty value.':'Use a JSON value of the selected type. Zero, false and null are distinct from missing.'}{['neq','not_contains','not_regex','not_includes'].includes(row.operator)?' Requires a collected value; properties must have the selected type. Use Is missing for absence.':''}</p>{rowIssue&&<p className="alert" id={`${base}-error`} role="alert">{rowIssue.error}</p>}<button className="btn" type="button" aria-label={`Remove ${property?'property':'field'} condition ${index+1}`} onClick={()=>remove(property,row)}>Remove</button></fieldset>;
      })}
      <button id={`${id}-add-${property?'properties':'fields'}`} className="btn" type="button" disabled={count>=20||property&&draft.properties.length>=10} onClick={()=>add(property)}>Add {property?'property':'field'} condition</button>{property&&draft.properties.length>=10&&<p className="hint">10-property-condition limit reached.</p>}
    </fieldset>)}<p className="hint">{count} of 20 additional conditions · {draft.properties.length} of 10 property conditions.{count>=20?' 20-condition limit reached.':''}</p></div></details>;
}

type Props={projectId:string;userId:string;onUnauthorized:()=>void};
export function ExplorerPanel(props:Props){
  return <ExplorerInner key={`${props.userId}:${props.projectId}`} {...props}/>;
}
function ExplorerInner({projectId,userId,onUnauthorized}:Props){
  const uid=useId();
  const unauthRef=useRef(onUnauthorized);
  unauthRef.current=onUnauthorized;

  const [draft,setDraft]=useState<Draft>(initialDraft);
  const [applied,setApplied]=useState<string>(()=>{const r=buildParams(initialDraft());return 'qs'in r?r.qs:'';});
  const [attempt,setAttempt]=useState(0);
  const [result,setResult]=useState<ExploreResult|null>(null);
  const [phase,setPhase]=useState<'loading'|'ok'|'error'|'unavailable'|'denied'>('loading');
  const [message,setMessage]=useState('');
  const [formError,setFormError]=useState('');
  const base=`/api/projects/${encodeURIComponent(projectId)}/segments`;
  const [savedItems,setSavedItems]=useState<SavedFilter[]>([]),[savedCursor,setSavedCursor]=useState<string|null>(null),[savedLoaded,setSavedLoaded]=useState(false);
  const [savedRole,setSavedRole]=useState<Role|null>(null),[selected,setSelected]=useState<SavedFilter|null>(null),[selectedId,setSelectedId]=useState(''),[savedName,setSavedName]=useState('');
  const [savedBusy,setSavedBusy]=useState(false),[savedError,setSavedError]=useState(''),[savedNotice,setSavedNotice]=useState(''),[pending,setPending]=useState<SaveAttempt|null>(null);
  const alive=useRef(false),accessEpoch=useRef(0),accessDenied=useRef(false),analyticsRead=useRef<AbortController|null>(null);
  const savedOp=useRef<AbortController|null>(null),savedRoleRef=useRef<Role|null>(null),pendingRef=useRef<SaveAttempt|null>(null),deletedIds=useRef(new Set<string>());
  const cohortBase=`/api/projects/${encodeURIComponent(projectId)}/cohorts`;
  const [cohortItems,setCohortItems]=useState<SavedFilter[]>([]),[cohortCursor,setCohortCursor]=useState<string|null>(null),[cohortSelected,setCohortSelected]=useState<SavedFilter|null>(null),[cohortSelectedId,setCohortSelectedId]=useState('');
  const [cohortDraft,setCohortDraft]=useState<(CohortRef&{definition?:Definition})|null>(null),[cohortEditor,setCohortEditor]=useState<CohortEditor|null>(null),[cohortRole,setCohortRole]=useState<Role|null>(null);
  const [cohortBusy,setCohortBusy]=useState(false),[cohortError,setCohortError]=useState(''),[cohortNotice,setCohortNotice]=useState(''),[cohortPending,setCohortPending]=useState<SaveAttempt|null>(null);
  const cohortOp=useRef<AbortController|null>(null),cohortRoleRef=useRef<Role|null>(null),cohortPendingRef=useRef<SaveAttempt|null>(null),cohortDeleted=useRef(new Set<string>()),cohortInvalid=useRef(new Set<string>()),cohortManager=useRef<HTMLDetailsElement>(null);
  function clearCohortData(){cohortOp.current?.abort();cohortOp.current=null;setCohortBusy(false);setCohortItems([]);setCohortCursor(null);setCohortSelected(null);setCohortSelectedId('');setCohortEditor(null);setCohortRole(null);cohortRoleRef.current=null;setCohortNotice('');setCohortDraft(old=>old?{id:old.id,revision:old.revision}:null);}
  function purgeAccess(status:number,notice?:string,keepAttempt:SaveAttempt|null=pendingRef.current){
    accessEpoch.current++;accessDenied.current=true;analyticsRead.current?.abort();savedOp.current?.abort();savedOp.current=null;
    clearCohortData();
    setResult(null);setDraft(initialDraft());setFormError('');setSavedItems([]);setSavedCursor(null);setSavedLoaded(false);setSelected(null);setSelectedId('');setSavedName('');setSavedRole(null);savedRoleRef.current=null;setSavedBusy(false);setSavedError('');setSavedNotice('');pendingRef.current=keepAttempt;setPending(keepAttempt);
    const initial=buildParams(initialDraft());if('qs'in initial)setApplied(old=>{const previous=new URLSearchParams(old),next=new URLSearchParams(initial.qs);for(const key of ['cohortId','cohortRevision'])if(previous.has(key))next.set(key,previous.get(key)!);return next.toString();});
    setPhase(status===401?'denied':'unavailable');setMessage(notice??(status===401?'Your session has ended. Sign in again to continue.':'This project is unavailable. It may have been removed or you may not have access.'));
    if(status===401)unauthRef.current();
  }
  function acceptCohortRole(value:unknown){if(!roleValue(value)){purgeAccess(403,'Cohort access could not be verified. Reload cohort access before continuing.',pendingRef.current);throw new Error('Cohort access could not be verified.');}cohortRoleRef.current=value;setCohortRole(value);return value;}
  async function readCohorts(id?:string,mode:'inspect'|'load'|'edit'='inspect',cursor?:string,recover=false){
    if(accessDenied.current&&!recover||cohortPendingRef.current&&(cohortOp.current||mode!=='inspect'))return;
    cohortOp.current?.abort();const op=new AbortController(),generation=accessEpoch.current;cohortOp.current=op;setCohortBusy(true);setCohortError('');cohortRoleRef.current=null;
    try{
      const data=await api<unknown>(id?`${cohortBase}/${encodeURIComponent(id)}`:cohortBase+(cursor?'?'+new URLSearchParams({cursor}):''),{signal:AbortSignal.any([op.signal,AbortSignal.timeout(20000)])});
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(!record(data))throw new Error('Cohorts could not be verified. Refresh cohorts.');const role=acceptCohortRole(data.role);
      if(id){
        if(!validCohort(data.item,projectId)||data.item.id!==id||cohortDeleted.current.has(id))throw new Error('This cohort could not be verified. Refresh cohorts.');
        const item=data.item;setCohortSelected(item);setCohortSelectedId(id);setCohortItems(old=>[...new Map([...old,item].map(v=>[v.id,v])).values()]);
        if(mode==='load'){setCohortDraft({id:item.id,revision:item.revision,definition:item.definition});cohortInvalid.current.delete(`${item.id}:${item.revision}`);setCohortNotice('Cohort loaded into your draft. Apply filters to update results and CSV.');}
        if(mode==='edit'&&canSave(role)){setCohortEditor({item,name:item.definition.name,draft:qualificationDraft(item.definition.query)!});if(cohortManager.current)cohortManager.current.open=true;}
      }else{
        if(!Array.isArray(data.items)||data.items.length>50||!data.items.every(v=>validCohort(v,projectId))||new Set(data.items.map(v=>v.id)).size!==data.items.length||data.nextCursor!==null&&(!clean(data.nextCursor,4096)||!data.nextCursor))throw new Error('Cohorts could not be verified. Refresh cohorts.');
        const items=(data.items as SavedFilter[]).filter(v=>!cohortDeleted.current.has(v.id));setCohortItems(old=>[...new Map([...(cursor?old:[]),...items].map(v=>[v.id,v])).values()]);setCohortCursor(data.nextCursor as string|null);
      }
      if(!canSave(role))setCohortEditor(null);
      if(recover){accessDenied.current=false;setPhase('error');setMessage('Access rechecked. Clear or load a cohort, then Apply filters to load results.');void readSaved();}
      return true;
    }catch(e){
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(e instanceof ApiError&&[401,403,404].includes(e.status))purgeAccess(e.status,'This cohort or project is unavailable. Reload cohort access, then clear or load a cohort.',pendingRef.current);
      else{clearCohortData();setCohortError(errMsg(e));}
    }finally{if(cohortOp.current===op){cohortOp.current=null;if(alive.current)setCohortBusy(false);}}
  }
  async function saveCohort(value:SaveAttempt){
    if(cohortOp.current||!canSave(cohortRoleRef.current)||accessDenied.current)return;const confirming=cohortPendingRef.current===value;
    cohortPendingRef.current=value;setCohortPending(value);const op=new AbortController(),generation=accessEpoch.current;cohortOp.current=op;setCohortBusy(true);setCohortError('');setCohortNotice('');let conflict=false,reload=false;
    try{
      const data=await api<unknown>(value.kind==='create'?cohortBase:`${cohortBase}/${encodeURIComponent(value.id!)}/${value.kind}`,{method:'POST',body:value.body,signal:AbortSignal.any([op.signal,AbortSignal.timeout(20000)])});
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(!record(data))throw new Error('The cohort acknowledgement could not be verified.');acceptCohortRole(data.role);
      if(!canSave(data.role as Role)||typeof data.replayed!=='boolean'||typeof data.deleted!=='boolean')throw new Error('The cohort acknowledgement could not be verified.');
      if(value.kind==='delete'||data.deleted){
        if(value.kind==='delete'?data.id!==value.id||data.deleted!==true:data.item!==null||data.replayed!==true)throw new Error('The cohort acknowledgement could not be matched.');
        if(value.id)cohortDeleted.current.add(value.id);setCohortSelected(null);setCohortSelectedId('');setCohortItems(old=>value.id?old.filter(item=>item.id!==value.id):[]);setCohortCursor(null);reload=true;
        setCohortNotice(value.kind==='delete'?'Cohort deleted. Clear its report draft reference or load another cohort before applying. Existing results remain a snapshot.':'Original save confirmed, but this cohort was since deleted. It was not recreated.');
      }else{
        if(!validCohort(data.item,projectId)||value.id&&data.item.id!==value.id||cohortDeleted.current.has(data.item.id)||value.body.revision!==undefined&&data.item.revision<=value.body.revision||!data.replayed&&(data.item.revision!==(value.body.revision??0)+1||!sameCohortDefinition(value.body.definition!,data.item.definition)))throw new Error('The cohort acknowledgement could not be matched.');
        const item=data.item;setCohortItems(old=>[item,...old.filter(v=>v.id!==item.id)]);setCohortSelected(item);setCohortSelectedId(item.id);setCohortNotice(data.replayed?'Original save confirmed. The current cohort definition is shown; report results are unchanged.':'Cohort saved. Load this version into your draft, then Apply filters to update the report.');
      }
      cohortPendingRef.current=null;setCohortPending(null);setCohortEditor(null);
    }catch(e){
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;const status=e instanceof ApiError?e.status:0;
      if(status===0||status===408||status===429||status>=500)setCohortError('The outcome is unknown. Retry the same request to confirm it; the original name, qualification and revision are kept.');
      else{
        if(!confirming||![401,403,404].includes(status)){cohortPendingRef.current=null;setCohortPending(null);}
        if([401,403,404].includes(status))purgeAccess(status,'This cohort or project is unavailable. Reload cohort access before continuing.',pendingRef.current);
        else if(status===409){setCohortEditor(null);setCohortError('This cohort changed. Reloading its current definition for review.');conflict=true;}
        else{setCohortError(errMsg(e));if(status===400&&errMsg(e).includes('regular expression'))focusAdvanced(`${uid}-qualification-advanced`);}
      }
    }finally{if(cohortOp.current===op){cohortOp.current=null;if(alive.current)setCohortBusy(false);}}
    if(conflict&&alive.current&&generation===accessEpoch.current&&await readCohorts(value.id,'edit'))setCohortError('This cohort changed. Review its reloaded definition before saving again. Report results are unchanged.');
    if(reload&&alive.current&&generation===accessEpoch.current)void readCohorts();
  }
  function submitCohort(){
    if(!cohortEditor||cohortPendingRef.current||cohortOp.current||!canSave(cohortRoleRef.current)||accessDenied.current)return;
    const name=cohortEditor.name.trim(),d=cohortEditor.draft;if(!clean(name,200)||!name){setCohortError('Enter a cohort name of 1 to 200 characters.');return;}
    const built=buildParams(d);if('error'in built){setCohortError(built.error);if(built.advanced)focusAdvanced(`${uid}-qualification-advanced`,built.advanced);return;}const p=new URLSearchParams(built.qs);p.delete('groupBy');p.delete('groupProperty');
    if(!qualificationDraft(p.toString())){setCohortError('Choose valid qualification dates, a timezone, exactly one action and supported filters.');return;}
    const todayParts=new Intl.DateTimeFormat('en-US',{timeZone:d.timeZone.trim(),year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()),today=['year','month','day'].map(key=>todayParts.find(part=>part.type===key)!.value).join('-');
    if(d.to>today){setCohortError('Qualification cannot end after today in its selected time zone.');return;}
    const item=cohortEditor.item;void saveCohort({kind:item?'update':'create',...(item?{id:item.id}:{}),body:{requestId:crypto.randomUUID(),...(item?{revision:item.revision}:{}),definition:{schemaVersion:1,name,query:p.toString()}}});
  }
  useBlocker({shouldBlockFn:()=>cohortPendingRef.current!==null&&!window.confirm('A cohort request may still complete. Leave without confirming its outcome?'),enableBeforeUnload:()=>cohortPendingRef.current!==null});
  useEffect(()=>{void readCohorts();return()=>cohortOp.current?.abort();},[]);
  function acceptRole(value:unknown){if(!roleValue(value)){purgeAccess(403,'Project access could not be verified. Reload access before confirming any pending save.',pendingRef.current);throw new Error('Project access could not be verified.');}savedRoleRef.current=value;setSavedRole(value);return value;}
  async function readSaved(id?:string,loadDraft=false,cursor?:string,recover=false){
    if(accessDenied.current&&!recover||pendingRef.current&&loadDraft)return;
    savedOp.current?.abort();const op=new AbortController(),generation=accessEpoch.current;savedOp.current=op;setSavedBusy(true);setSavedError('');savedRoleRef.current=null;
    try{
      const data=await api<unknown>(id?`${base}/${encodeURIComponent(id)}`:base+(cursor?'?'+new URLSearchParams({cursor}):''),{signal:AbortSignal.any([op.signal,AbortSignal.timeout(20000)])});
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current||savedOp.current!==op)return;
      if(!record(data))throw new Error('Saved filters could not be verified. Refresh the saved list.');acceptRole(data.role);
      if(id){
        if(!validSaved(data.item,projectId)||data.item.id!==id||deletedIds.current.has(id))throw new Error('This saved filter is no longer available. Refresh the saved list.');
        const item=data.item;setSelected(item);setSelectedId(id);setSavedName(item.definition.name);setSavedItems(old=>old.map(value=>value.id===id?item:value));
        if(loadDraft){const predicates=savedPredicates(item.definition.query)!;setDraft(old=>({...old,...predicates}));setFormError('');setSavedNotice('Saved filters loaded into your draft. Apply filters to update results and CSV.');}
      }else{
        if(!Array.isArray(data.items)||data.items.length>50||!data.items.every(value=>validSaved(value,projectId))||new Set(data.items.map(value=>value.id)).size!==data.items.length||data.nextCursor!==null&&!clean(data.nextCursor,4096))throw new Error('Saved filters could not be verified. Refresh the saved list.');
        const items=(data.items as SavedFilter[]).filter(value=>!deletedIds.current.has(value.id));
        setSavedItems(old=>[...new Map([...(cursor?old:[]),...items].map(value=>[value.id,value])).values()]);setSavedCursor(data.nextCursor as string|null);setSavedLoaded(true);
      }
      if(recover){accessDenied.current=false;setPhase('error');setMessage('Access rechecked. Apply filters to load report results.');}
      return true;
    }catch(e){
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(e instanceof ApiError&&[401,403,404].includes(e.status)){
        if(id&&e.status===404){deletedIds.current.add(id);purgeAccess(404,'This saved filter or project is unavailable. Retry to reload access.');}
        else purgeAccess(e.status);
      }else{setSavedRole(null);savedRoleRef.current=null;setSelected(null);setSavedError(errMsg(e));}
    }finally{if(savedOp.current===op){savedOp.current=null;if(alive.current)setSavedBusy(false);}}
  }
  async function saveAttempt(value:SaveAttempt){
    if(savedOp.current||!canSave(savedRoleRef.current)||accessDenied.current)return;
    const confirming=pendingRef.current===value;
    pendingRef.current=value;setPending(value);const op=new AbortController(),generation=accessEpoch.current;savedOp.current=op;setSavedBusy(true);setSavedError('');setSavedNotice('');
    let conflict=false,reloadList=false;
    try{
      const data=await api<unknown>(value.kind==='create'?base:`${base}/${encodeURIComponent(value.id!)}/${value.kind}`,{method:'POST',body:value.body,signal:AbortSignal.any([op.signal,AbortSignal.timeout(20000)])});
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(!record(data))throw new Error('The save acknowledgement could not be verified.');acceptRole(data.role);
      if(!canSave(data.role as Role)||typeof data.replayed!=='boolean'||typeof data.deleted!=='boolean')throw new Error('The save acknowledgement could not be verified.');
      if(value.kind==='delete'){
        if(data.deleted!==true||data.id!==value.id)throw new Error('The deletion acknowledgement could not be matched.');
        deletedIds.current.add(value.id!);setSavedItems(old=>old.filter(item=>item.id!==value.id));setSelected(null);setSelectedId('');setSavedName('');setSavedNotice('Saved filter deleted. Your draft and applied results are unchanged.');
      }else if(data.deleted){
        if(data.item!==null||data.replayed!==true)throw new Error('The saved filter receipt could not be verified.');
        if(value.id){deletedIds.current.add(value.id);setSavedItems(old=>old.filter(item=>item.id!==value.id));}else{setSavedItems([]);setSavedCursor(null);setSavedLoaded(false);reloadList=true;}
        setSelected(null);setSelectedId('');setSavedName('');setSavedNotice('The original save was confirmed, but that saved filter was since deleted. It was not recreated.');
      }else{
        if(!validSaved(data.item,projectId)||value.id&&data.item.id!==value.id||value.body.revision!==undefined&&data.item.revision<=value.body.revision||deletedIds.current.has(data.item.id)||!data.replayed&&(data.item.revision!==(value.body.revision??0)+1||!sameDefinition(value.body.definition!,data.item.definition)))throw new Error('The save acknowledgement could not be matched.');
        const item=data.item;setSavedItems(old=>[item,...old.filter(row=>row.id!==item.id)]);setSelected(item);setSelectedId(item.id);setSavedName(item.definition.name);setSavedNotice(data.replayed?'Original save confirmed. The current saved definition is shown; your draft is unchanged.':'Saved. Results and CSV still use the applied filters.');
      }
      pendingRef.current=null;setPending(null);
    }catch(e){
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      const status=e instanceof ApiError?e.status:0;
      if(status===0||status===408||status===429||status>=500)setSavedError('The outcome is unknown. Retry the same request to confirm it; the original settings are kept.');
      else{
        if(!confirming||![401,403,404].includes(status)){pendingRef.current=null;setPending(null);}
        if([401,403,404].includes(status))purgeAccess(status,status===404?'This saved filter or project is unavailable. Retry to reload access.':undefined);
        else if(status===409){setSelected(null);setSavedError('This saved filter changed. Reloading its current definition; review it before saving again. Your report draft is unchanged.');conflict=true;}
        else{setSavedError(errMsg(e));if(status===400&&errMsg(e).includes('regular expression'))focusAdvanced(`${uid}-report-advanced`);}
      }
    }finally{if(savedOp.current===op){savedOp.current=null;if(alive.current)setSavedBusy(false);}}
    if(conflict&&alive.current&&generation===accessEpoch.current&&await readSaved(value.id))setSavedError('This saved filter changed. Its current definition was reloaded. Review it before saving again; your report draft is unchanged.');
    if(reloadList&&alive.current&&generation===accessEpoch.current)void readSaved();
  }
  function saveFilters(kind:'create'|'update'|'rename'|'delete'){
    if(savedOp.current||pendingRef.current||!canSave(savedRoleRef.current)||accessDenied.current)return;
    if(kind!=='create'&&!selected)return;
    if(kind==='delete'){
      if(window.confirm('Delete this saved filter? Your report draft and results will stay unchanged.'))void saveAttempt({kind,id:selected!.id,body:{requestId:crypto.randomUUID(),revision:selected!.revision}});return;
    }
    const name=savedName.trim();if(!clean(name,200)||!name){setSavedError('Enter a name of 1 to 200 characters.');return;}
    const query=kind==='rename'?{qs:selected!.definition.query}:draftFilterQuery(draft);if('error'in query){setSavedError(query.error);if(query.advanced)focusAdvanced(`${uid}-report-advanced`,query.advanced);return;}
    void saveAttempt({kind:kind==='create'?'create':'update',...(kind!=='create'?{id:selected!.id}:{}),body:{requestId:crypto.randomUUID(),...(kind!=='create'?{revision:selected!.revision}:{}),definition:{schemaVersion:1,name,query:query.qs}}});
  }
  useBlocker({shouldBlockFn:()=>pendingRef.current!==null&&!window.confirm('A saved-filter request may still complete. Leave without confirming its outcome?'),enableBeforeUnload:()=>pendingRef.current!==null});
  useEffect(()=>{alive.current=true;void readSaved();return()=>{alive.current=false;accessEpoch.current++;savedOp.current?.abort();pendingRef.current=null;};},[]);

  useEffect(()=>{
    if(accessDenied.current)return;
    const ctrl=new AbortController();
    const generation=accessEpoch.current;analyticsRead.current=ctrl;
    setResult(null);setPhase('loading');setMessage('');
    api<ExploreResult>(`/api/projects/${encodeURIComponent(projectId)}/explore?${applied}`,{signal:ctrl.signal})
      .then(r=>{if(!ctrl.signal.aborted&&generation===accessEpoch.current){if(!validCohortResult(r,new URLSearchParams(applied),projectId))throw new Error('The applied report filters could not be verified. Reload before applying again.');setResult(r);setPhase('ok');}})
      .catch(e=>{
        if(ctrl.signal.aborted||generation!==accessEpoch.current)return;
        setResult(null);
        const params=new URLSearchParams(applied),cohortId=params.get('cohortId');
        if(cohortId&&e instanceof ApiError&&[404,409].includes(e.status))cohortInvalid.current.add(`${cohortId}:${params.get('cohortRevision')}`);
        if(cohortId&&e instanceof ApiError&&e.status===409){
          setPhase('error');setMessage('This cohort changed. Review its current definition, load it, then Apply filters.');void readCohorts(cohortId);
        }else if(e instanceof ApiError&&e.status===401){
          purgeAccess(401);
        }else if(e instanceof ApiError&&(e.status===403||e.status===404)){
          purgeAccess(e.status);
        }else if(e instanceof ApiError&&e.status===400&&e.message.includes('regular expression')){
          setPhase('error');setMessage('One or more patterns are invalid. Check the pattern conditions and try again.');focusAdvanced(`${uid}-report-advanced`);
        }else if(e instanceof ApiError&&e.status===503&&(params.has('predicates')||cohortId)){
          setPhase('error');setMessage('The report took too long. Simplify the patterns or shorten the date range, then Apply filters.');
        }else{
          setPhase('error');setMessage(`Couldn't load explore data. ${errMsg(e)}`);
        }
      });
    return()=>ctrl.abort();
  },[applied,attempt,projectId]);

  const refresh=()=>{if(accessDenied.current){accessDenied.current=false;void readSaved();void readCohorts();}setResult(null);setPhase('loading');setMessage('');setAttempt(a=>a+1);};

  const apply=(e:FormEvent)=>{
    e.preventDefault();
    if(accessDenied.current)return;
    if(cohortDraft&&(cohortDeleted.current.has(cohortDraft.id)||cohortInvalid.current.has(`${cohortDraft.id}:${cohortDraft.revision}`))){setFormError('Clear the unavailable cohort or load its current definition before applying.');return;}
    const r=reportParams(draft,cohortDraft);
    if('error'in r){setFormError(r.error);if(r.advanced)focusAdvanced(`${uid}-report-advanced`,r.advanced);return;}
    setFormError('');setApplied(r.qs);refresh();
  };

  const download=()=>{
    if(phase!=='ok'||!result)return;
    const url=URL.createObjectURL(new Blob([result.csv],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');
    a.href=url;a.download='ten98-explore.csv';
    document.body.appendChild(a);a.click();a.remove();
    URL.revokeObjectURL(url);
  };

  const patch=(p:Partial<Draft>)=>setDraft(d=>({...d,...p}));
  const patchFilter=(k:string,p:Partial<FilterRow>)=>setDraft(d=>({...d,filters:{...d.filters,[k]:{...d.filters[k],...p}}}));
  const patchProp=(p:Partial<Draft['prop']>)=>setDraft(d=>({...d,prop:{...d.prop,...p}}));

  const keyList=phase==='ok'&&result?result.properties.keys:[];
  const keysTruncated=phase==='ok'&&result?result.properties.truncated:false;
  const t=result?.totals;
  const currentParams=reportParams(draft,cohortDraft);
  const unapplied='error'in currentParams||currentParams.qs!==applied;
  const appliedDates=new URLSearchParams(applied);
  const cohortLocked=cohortBusy||!!cohortPending,qualification=cohortEditor?.draft,cohortMembershipUnavailable=result?.cohort?.membership.status==='unavailable';
  function patchQualification(patch:Partial<Draft>){setCohortEditor(old=>old?{...old,draft:{...old.draft,...patch}}:old);}
  const annotations=useAnnotations({projectId,userId,range:accessDenied.current?null:{from:appliedDates.get('from')!,to:appliedDates.get('to')!,timeZone:result?.range.timeZone??appliedDates.get('timeZone')!},onUnauthorized,onAccessLost:status=>purgeAccess(status)});

  return(
    <section className="explorer stack" aria-labelledby={`${uid}-h`} style={{'--control-md':'var(--control-touch)'} as import('react').CSSProperties}>
      <h2 id={`${uid}-h`}>Explore</h2>

      <form className="card stack" onSubmit={apply}>
        <fieldset className="stack" disabled={phase==='denied'||phase==='unavailable'} style={{border:0,padding:0,margin:0,minWidth:0}}>
        <section className="stack" aria-label="Saved filters" style={{minWidth:0,overflowWrap:'anywhere'}}>
          <div className="row" style={{alignItems:'end'}}>
            <div style={{flex:'1 1 240px',minWidth:0}}><label htmlFor={`${uid}-saved`}>Saved filters</label><select id={`${uid}-saved`} style={{width:'100%',minWidth:0}} disabled={savedBusy||!!pending||!savedRole} value={selectedId} onChange={e=>{const id=e.target.value;setSelectedId(id);setSelected(null);setSavedName('');setSavedNotice('');if(id)void readSaved(id);}}><option value="">Choose a saved filter</option>{savedItems.map(item=><option key={item.id} value={item.id}>{item.definition.name}</option>)}</select></div>
            <button className="btn" type="button" disabled={savedBusy||!!pending||!selected||!savedRole} onClick={()=>void readSaved(selectedId,true)}>Load</button>
            <button className="btn" type="button" disabled={savedBusy} onClick={()=>void readSaved()}>Refresh saved filters</button>
            {savedCursor&&<button className="btn" type="button" disabled={savedBusy} onClick={()=>void readSaved(undefined,false,savedCursor)}>Load more saved filters</button>}
          </div>
          <p className="hint">Load replaces draft filters only. Dates, time zone and grouping stay as you set them. Apply filters to update results and CSV.</p>
          {savedBusy&&<p role="status">{pending?'Saving filters…':'Loading saved filters…'}</p>}
          {savedLoaded&&!savedItems.length&&!savedBusy&&<p className="hint">No saved filters yet.</p>}
          {savedNotice&&<p className="notice" role="status">{savedNotice}</p>}
          {savedError&&<p className="alert" role="alert">{savedError}</p>}
          {pending&&<div className="row"><p className="hint">This request keeps its original name, filters and revision.</p><button className="btn" type="button" disabled={savedBusy||!canSave(savedRole)} onClick={()=>void saveAttempt(pending)}>Retry same request</button></div>}
          {canSave(savedRole)&&<details><summary>Save or manage filters</summary><div className="stack">
            <p className="hint">Save the current draft's event kind, exact filters and typed property filter. Dates, time zone and grouping are excluded.</p>
            <details><summary>Draft filters to save</summary><p><strong>Required filters — all</strong></p><p>{labelOf(KINDS,draft.kind)}</p>{FILTERS.filter(([key])=>draft.filters[key].on).map(([key,label])=><p key={key}>{label} equals {JSON.stringify(draft.filters[key].value)}</p>)}{draft.prop.on&&<p>Property {JSON.stringify(draft.prop.key)}: {draft.prop.type}{draft.prop.type!=='missing'?` equals ${draft.prop.value}`:''}</p>}{!FILTERS.some(([key])=>draft.filters[key].on)&&!draft.prop.on&&<p>No additional required filters.</p>}<AdvancedSummary draft={draft.advanced} zone={draft.timeZone}/></details>
            <div><label htmlFor={`${uid}-saved-name`}>Saved filter name</label><input id={`${uid}-saved-name`} style={{width:'100%',minWidth:0}} maxLength={200} value={savedName} disabled={savedBusy||!!pending} onChange={e=>setSavedName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();saveFilters(selected?'rename':'create');}}}/></div>
            {selected&&<p className="hint">Selected: {selected.definition.name} · Revision {selected.revision}. Rename keeps its saved predicates; Update saved filter replaces them with your current draft.</p>}
            <div className="row"><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('create')}>{selected?'Save as new':'Save filters'}</button>{selected&&<><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('update')}>Update saved filter</button><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('rename')}>Rename</button><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('delete')}>Delete saved filter</button></>}</div>
          </div></details>}
          {savedRole==='viewer'&&<p className="hint">You can load saved filters. An owner, admin or editor can save changes.</p>}
        </section>
        <section className="stack cohort-controls" aria-label="Report cohort">
          <div className="row" style={{alignItems:'end'}}>
            <div style={{flex:'1 1 240px',minWidth:0}}><label htmlFor={`${uid}-cohort`}>Saved cohort</label><select id={`${uid}-cohort`} disabled={cohortLocked||!cohortRole} value={cohortSelectedId} onChange={e=>{const id=e.target.value;setCohortSelectedId(id);setCohortSelected(null);if(id)void readCohorts(id);}}><option value="">Choose a cohort</option>{cohortItems.map(item=><option key={item.id} value={item.id}>{item.definition.name}</option>)}</select></div>
            <button className="btn" type="button" disabled={cohortLocked||!cohortSelected||!cohortRole} onClick={()=>void readCohorts(cohortSelected!.id,'load')}>Load cohort</button>
            <button className="btn" type="button" disabled={cohortBusy} onClick={()=>void readCohorts()}>Refresh cohorts</button>
            {cohortCursor&&<button className="btn" type="button" disabled={cohortBusy} onClick={()=>void readCohorts(undefined,'inspect',cohortCursor)}>Load more cohorts</button>}
          </div>
          <p className="hint">Load stages a saved qualification for this report. Apply filters to update results and CSV; report dates and filters stay as you set them.</p>
          <p className="hint">Report cohort: {cohortDraft?`${cohortDraft.definition?.name??'Saved cohort reference'} · Revision ${cohortDraft.revision}`:'None'}</p>
          {cohortDraft?.definition&&<p className="hint">Qualification dates: {new URLSearchParams(cohortDraft.definition.query).get('from')} to {new URLSearchParams(cohortDraft.definition.query).get('to')} ({new URLSearchParams(cohortDraft.definition.query).get('timeZone')})</p>}
          {cohortSelected&&<details><summary>Selected qualification</summary><p>{cohortSelected.definition.name} · Revision {cohortSelected.revision}</p><p><strong>Required filters — all</strong></p>{[...new URLSearchParams(cohortSelected.definition.query)].filter(([key])=>key!=='predicates').map(([key,value])=><p className="hint" key={key}>{labelOf([...FILTERS,['from','Qualification from'],['to','Qualification to'],['timeZone','Qualification time zone'],['kind','Qualifying event kind'],['propertyKey','Property key'],['propertyType','Property type'],['propertyValue','Property value']],key)}: {key==='kind'?labelOf(KINDS,value):JSON.stringify(value)}</p>)}<AdvancedSummary draft={qualificationDraft(cohortSelected.definition.query)!.advanced} zone={qualificationDraft(cohortSelected.definition.query)!.timeZone}/></details>}
        </section>
        <div className="explorer-toolbar">
          <div>
          <label htmlFor={`${uid}-from`}>From</label>
          <input id={`${uid}-from`} type="date" required max={draft.to} value={draft.from} onChange={e=>patch({from:e.target.value})}/>
          </div><div>
          <label htmlFor={`${uid}-to`}>To</label>
          <input id={`${uid}-to`} type="date" required min={draft.from} value={draft.to} onChange={e=>patch({to:e.target.value})}/>
          </div><div>
          <label htmlFor={`${uid}-tz`}>Time zone</label>
          <input id={`${uid}-tz`} type="text" required list={`${uid}-tzl`} value={draft.timeZone} onChange={e=>patch({timeZone:e.target.value})}/>
          </div>
          <datalist id={`${uid}-tzl`}>{TIMEZONES.map(z=><option key={z} value={z}/>)}</datalist>
        </div>
        <p className="hint dim">Dates include the whole calendar day in your selected time zone.</p>
        <div className="explorer-toolbar">
          <div>
          <label htmlFor={`${uid}-kind`}>Show</label>
          <select id={`${uid}-kind`} value={draft.kind} onChange={e=>patch({kind:e.target.value})}>
            {KINDS.map(([k,l])=><option key={k} value={k}>{l}</option>)}
          </select>
          </div><div>
          <label htmlFor={`${uid}-gb`}>Group by</label>
          <select id={`${uid}-gb`} value={draft.groupBy} onChange={e=>patch({groupBy:e.target.value})}>
            {GROUPS.map(([k,l])=><option key={k} value={k}>{l}</option>)}
          </select>
          </div>
          {draft.groupBy==='property'&&(<div>
            <label htmlFor={`${uid}-gp`}>Property key</label>
            <input id={`${uid}-gp`} type="text" required maxLength={320} list={`${uid}-keys`} placeholder="nested.count or a\.b" value={draft.groupProperty} onChange={e=>patch({groupProperty:e.target.value})}/>
          </div>)}
          <datalist id={`${uid}-keys`}>{keyList.map(k=><option key={k} value={k}/>)}</datalist>
        </div>
        {draft.groupBy==='property'&&keysTruncated&&(
          <p className="hint dim">Key suggestions show the top 100 keys only; exact keys not listed still work.</p>
        )}

        <details>
          <summary>More filters</summary>
            <div className="stack">
            <p><strong>Required filters — all</strong></p>
            {FILTERS.map(([k,l])=>(
              <div className="row" key={k}>
                <input id={`${uid}-${k}-on`} type="checkbox" checked={draft.filters[k].on} onChange={e=>patchFilter(k,{on:e.target.checked})}/>
                <label htmlFor={`${uid}-${k}-on`}>Enable {l}</label>
                <label htmlFor={`${uid}-${k}-v`}>{l} equals</label>
                <input id={`${uid}-${k}-v`} type="text" disabled={!draft.filters[k].on} value={draft.filters[k].value} onChange={e=>patchFilter(k,{value:e.target.value})}/>
              </div>
            ))}
            <div className="row">
              <input id={`${uid}-pf-on`} type="checkbox" checked={draft.prop.on} onChange={e=>patchProp({on:e.target.checked})}/>
              <label htmlFor={`${uid}-pf-on`}>Enable property filter</label>
            </div>
            {draft.prop.on&&(<>
              <div className="row">
                <label htmlFor={`${uid}-pf-key`}>Property key</label>
                <input id={`${uid}-pf-key`} type="text" required maxLength={320} list={`${uid}-keys`} value={draft.prop.key} onChange={e=>patchProp({key:e.target.value})}/>
                <label htmlFor={`${uid}-pf-type`}>Type</label>
                <select id={`${uid}-pf-type`} value={draft.prop.type} onChange={e=>patchProp({type:e.target.value})}>
                  {PROP_TYPES.map(p=><option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              {draft.prop.type!=='missing'&&(
                <div className="row">
                  <label htmlFor={`${uid}-pf-val`}>Value (JSON literal)</label>
                  <input id={`${uid}-pf-val`} type="text" required placeholder='"starter", 42, true, null' value={draft.prop.value} onChange={e=>patchProp({value:e.target.value})}/>
                </div>
              )}
              <p className="hint dim">Valid date strings are normalized; arrays compare the whole array.{keysTruncated?' Key suggestions show the top 100 keys only; exact keys not listed still work.':''}</p>
            </>)}
          </div>
        </details>

        <AdvancedControls id={`${uid}-report-advanced`} label="Advanced filters" draft={draft.advanced} zone={draft.timeZone} error={formError||savedError} onChange={advanced=>patch({advanced})}/>
        <div className="row">
          <button className="btn primary" type="submit">Apply filters</button>
          <button className="btn" type="button" disabled={phase==='loading'} onClick={refresh}>Refresh</button>
          {phase==='ok'&&result&&<button className="btn" type="button" onClick={download}>Download CSV</button>}
        </div>
        {unapplied&&<p className="hint" role="status">You have unapplied changes. Apply filters to update the results and CSV.</p>}
        {formError&&<p className="alert" role="alert">{formError}</p>}
        {phase==='ok'&&result&&<p className="hint dim">CSV downloads the current bounded table, daily data and scope — it is not a complete data export.</p>}
        </fieldset>
      </form>

      <section className="card stack cohort-controls" aria-label="Cohorts">
        <div className="row between"><h3>Cohorts</h3>{cohortDraft&&<button className="btn" type="button" onClick={()=>{setCohortDraft(null);setFormError('');setCohortNotice('Cohort cleared from your draft. Apply filters to update results and CSV.');}}>Clear cohort</button>}{accessDenied.current&&<button className="btn" type="button" disabled={cohortBusy} onClick={()=>void readCohorts(undefined,'inspect',undefined,true)}>Reload cohort access</button>}</div>
        <p className="hint">Choose visitors observed performing an action in a fixed qualification period. Report dates decide which activity you view.</p>
        {cohortBusy&&<p role="status">{cohortPending?'Saving cohort…':'Loading cohorts…'}</p>}{cohortNotice&&<p className="notice" role="status">{cohortNotice}</p>}{cohortError&&<p className="alert" role="alert">{cohortError}</p>}
        {cohortPending&&<div className="row"><p className="hint">Only the original request can be retried until its outcome is confirmed.</p><button className="btn" type="button" disabled={cohortBusy||!canSave(cohortRole)||accessDenied.current} onClick={()=>void saveCohort(cohortPending)}>Retry same cohort request</button></div>}
        {cohortDraft&&(cohortDeleted.current.has(cohortDraft.id)||cohortInvalid.current.has(`${cohortDraft.id}:${cohortDraft.revision}`))&&<p className="alert" role="alert">The report draft references an unavailable cohort version. Clear cohort or load its current definition before applying.</p>}
        {cohortRole&&cohortItems.length===0&&!cohortBusy&&<p className="hint">No saved cohorts yet.</p>}
        {cohortRole==='viewer'&&<p className="hint">You can load cohorts. An owner, admin or editor can save changes.</p>}
        <details ref={cohortManager}><summary>Manage cohorts</summary><div className="stack">
          {canSave(cohortRole)&&<div className="row"><button className="btn" type="button" disabled={cohortLocked} onClick={()=>{setCohortEditor({item:null,name:'',draft:{...initialDraft(),from:appliedDates.get('from')!,to:appliedDates.get('to')!,timeZone:appliedDates.get('timeZone')!}});setCohortError('');}}>New cohort</button>{cohortSelected&&<><button className="btn" type="button" disabled={cohortLocked} onClick={()=>void readCohorts(cohortSelected.id,'edit')}>Edit cohort</button><button className="btn" type="button" disabled={cohortLocked} onClick={()=>{if(!cohortPendingRef.current&&window.confirm(`Delete ${cohortSelected.definition.name}? Existing report results remain a snapshot. Future reports cannot use this cohort.`))void saveCohort({kind:'delete',id:cohortSelected.id,body:{requestId:crypto.randomUUID(),revision:cohortSelected.revision}});}}>Delete cohort</button></>}</div>}
          {cohortEditor&&qualification&&canSave(cohortRole)&&<form className="card stack" aria-label="Cohort qualification" onSubmit={e=>{e.preventDefault();submitCohort();}}><fieldset className="stack" disabled={cohortLocked} style={{border:0,padding:0,margin:0,minWidth:0}}>
            <div><label htmlFor={`${uid}-cohort-name`}>Cohort name</label><input id={`${uid}-cohort-name`} autoFocus maxLength={200} value={cohortEditor.name} onChange={e=>setCohortEditor({...cohortEditor,name:e.target.value})}/><p className="hint">{cohortEditor.name.length}/200 characters</p></div>
            <div className="explorer-toolbar"><div><label htmlFor={`${uid}-qfrom`}>Qualification from</label><input id={`${uid}-qfrom`} type="date" required max={qualification.to} value={qualification.from} onChange={e=>patchQualification({from:e.target.value})}/></div><div><label htmlFor={`${uid}-qto`}>Qualification to</label><input id={`${uid}-qto`} type="date" required min={qualification.from} value={qualification.to} onChange={e=>patchQualification({to:e.target.value})}/></div><div><label htmlFor={`${uid}-qtz`}>Qualification time zone</label><input id={`${uid}-qtz`} required list={`${uid}-tzl`} value={qualification.timeZone} onChange={e=>patchQualification({timeZone:e.target.value})}/></div></div>
            <p className="hint">These fixed dates decide who qualifies, independently of report dates. Choose 1 to 366 days ending today or earlier in this time zone.</p>
            <div className="row"><div className="cohort-field"><label htmlFor={`${uid}-qaction`}>Qualifying action</label><select id={`${uid}-qaction`} required value={qualification.filters.path.on?'path':qualification.filters.eventName.on?'eventName':''} onChange={e=>patchQualification({filters:{...qualification.filters,path:{...qualification.filters.path,on:e.target.value==='path'},eventName:{...qualification.filters.eventName,on:e.target.value==='eventName'}}})}><option value="">Choose an action</option><option value="path">Path</option><option value="eventName">Event name</option></select></div>{(['path','eventName'] as const).filter(key=>qualification.filters[key].on).map(key=><div key={key} className="cohort-field"><label htmlFor={`${uid}-qaction-value`}>{key==='path'?'Qualification path equals':'Qualification event name equals'}</label><input id={`${uid}-qaction-value`} maxLength={key==='path'?2048:320} value={qualification.filters[key].value} onChange={e=>patchQualification({filters:{...qualification.filters,[key]:{on:true,value:e.target.value}}})}/><p className="hint">Blank matches an empty stored value.</p></div>)}</div>
            <div><label htmlFor={`${uid}-qkind`}>Qualifying event kind</label><select id={`${uid}-qkind`} value={qualification.kind} onChange={e=>patchQualification({kind:e.target.value})}>{KINDS.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div>
            <details><summary>More qualification filters</summary><div className="stack">
              <p><strong>Required filters — all</strong></p><p className="hint">All conditions apply to the same qualifying event. The qualifying action is always required.</p>
              {FILTERS.filter(([key])=>!['path','eventName'].includes(key)).map(([key,label])=><div className="row" key={key}><label className="row cohort-check"><input type="checkbox" checked={qualification.filters[key].on} onChange={e=>patchQualification({filters:{...qualification.filters,[key]:{...qualification.filters[key],on:e.target.checked}}})}/>Enable qualification {label}</label><div className="cohort-field"><label htmlFor={`${uid}-q-${key}`}>Qualification {label} equals</label><input id={`${uid}-q-${key}`} maxLength={key==='origin'?2048:320} disabled={!qualification.filters[key].on} value={qualification.filters[key].value} onChange={e=>patchQualification({filters:{...qualification.filters,[key]:{on:true,value:e.target.value}}})}/></div></div>)}
              <label className="row cohort-check"><input type="checkbox" checked={qualification.prop.on} onChange={e=>patchQualification({prop:{...qualification.prop,on:e.target.checked}})}/>Enable qualification property filter</label>
              {qualification.prop.on&&<><div className="row"><div className="cohort-field"><label htmlFor={`${uid}-qkey`}>Qualification property key</label><input id={`${uid}-qkey`} required maxLength={320} value={qualification.prop.key} onChange={e=>patchQualification({prop:{...qualification.prop,key:e.target.value}})}/></div><div className="cohort-field"><label htmlFor={`${uid}-qtype`}>Qualification property type</label><select id={`${uid}-qtype`} value={qualification.prop.type} onChange={e=>patchQualification({prop:{...qualification.prop,type:e.target.value}})}>{PROP_TYPES.map(type=><option key={type} value={type}>{type}</option>)}</select></div></div>{qualification.prop.type!=='missing'&&<div><label htmlFor={`${uid}-qvalue`}>Qualification value (JSON literal)</label><input id={`${uid}-qvalue`} required maxLength={8192} value={qualification.prop.value} onChange={e=>patchQualification({prop:{...qualification.prop,value:e.target.value}})}/></div>}<p className="hint">Valid date strings are normalized; arrays compare the whole array. Missing is distinct from null.</p></>}
            </div></details>
            <AdvancedControls id={`${uid}-qualification-advanced`} label="Advanced qualification filters" draft={qualification.advanced} zone={qualification.timeZone} error={cohortError} onChange={advanced=>patchQualification({advanced})}/>
            <div className="row"><button className="btn" type="submit">{cohortEditor.item?'Save cohort changes':'Save cohort'}</button><button className="btn" type="button" onClick={()=>setCohortEditor(null)}>Cancel cohort edit</button></div>
          </fieldset></form>}
        </div></details>
      </section>

      <p role="status" aria-live="polite" className={phase==='loading'||phase==='ok'?'hint dim':'alert'}>
        {phase==='loading'?'Loading explore data…':message}
      </p>
      {(phase==='error'||phase==='unavailable')&&(accessDenied.current&&pending?<button className="btn" type="button" disabled={savedBusy} onClick={()=>void readSaved(undefined,false,undefined,true)}>Reload saved-filter access</button>:<button className="btn" type="button" onClick={refresh}>Retry</button>)}

      {phase==='ok'&&result&&t&&(<>
        <p className="hint dim">
          {result.range.from} to {result.range.to} ({result.range.timeZone}) · {labelOf(KINDS,result.query.kind)} · grouped by {labelOf(GROUPS,result.query.groupBy)}{result.query.groupProperty?`: ${result.query.groupProperty}`:''}
        </p>
        <details className="explorer-scope"><summary>Applied filters and boundaries</summary>
          <p className="hint">UTC bounds: {result.range.start} (inclusive) to {result.range.end} (exclusive). Only instants within the selected local dates are included.</p>
          <p><strong>Required filters — all</strong></p>
          {Object.entries(result.query.filters).map(([key,value])=><p key={key}>{labelOf(FILTERS,key)} equals {JSON.stringify(value)}</p>)}
          {result.query.property&&<p>Property {JSON.stringify(result.query.property.key)}: {result.query.property.type}{result.query.property.type!=='missing'?` equals ${JSON.stringify(result.query.property.value)}`:''}</p>}
          {!Object.keys(result.query.filters).length&&!result.query.property&&<p className="hint">No additional filters.</p>}
          {result.query.predicates&&<AdvancedSummary draft={readAdvanced(result.query.predicates)!} zone={result.range.timeZone}/>}
        </details>
        {result.cohort&&<section className="card stack cohort-controls" aria-label="Applied cohort">
          <h3>Applied cohort: {result.cohort.item.definition.name} · Revision {result.cohort.item.revision}</h3>
          {[...new URLSearchParams(result.cohort.item.definition.query)].filter(([key])=>key==='path'||key==='eventName').map(([key,value])=><p className="hint" key={key}>Qualifying action: {labelOf(FILTERS,key)} equals {JSON.stringify(value)}.</p>)}
          {cohortDeleted.current.has(result.cohort.item.id)&&<p className="alert">This cohort was deleted. These results remain a snapshot; clear the draft reference or load another cohort before applying.</p>}
          <div className="row"><p className="cohort-field">Report dates: {result.range.from} to {result.range.to} ({result.range.timeZone})<br/><span className="hint">Report coverage: {result.coverage.status}</span></p><p className="cohort-field">Qualification dates: {result.cohort.range.from} to {result.cohort.range.to} ({result.cohort.range.timeZone})<br/><span className="hint">Qualification coverage: {result.cohort.coverage.status}</span></p></div>
          <p className={cohortMembershipUnavailable?'alert':result.cohort.membership.countsAreLowerBounds?'banner':'hint'} role="status">{cohortMembershipUnavailable?<><strong>Membership unavailable.</strong> {result.cohort.coverage.status==='unavailable'?'The qualification period is no longer retained.':'Qualifying events have no visitor identifiers.'} Cohort report counts are unavailable.</>:result.cohort.membership.countsAreLowerBounds?<><strong>Observed lower bounds.</strong> Some qualifying history or visitor identifiers are missing. Counts include only the membership we can observe.</>:result.cohort.coverage.status==='complete'&&result.cohort.identity.identifiedEvents===0&&result.cohort.identity.unidentifiedEvents===0?<><strong>No qualifying events.</strong> No events matched this qualification in the fully retained period.</>:<strong>Observed membership available.</strong>}</p>
          <p className="hint">Membership uses observed visitor identifiers. They reset each UTC month and can change when identity settings or the signing secret change. Activity cannot be linked across those changes.</p>
          <details><summary>Qualification details</summary><div className="stack"><p className="hint">Qualification retained from: {result.cohort.coverage.retainedFrom??'No retention boundary'}. Identifier coverage: {result.cohort.identity.status}.</p><p className="hint">Qualifying events with identifiers: {num(result.cohort.identity.identifiedEvents)} · without identifiers: {num(result.cohort.identity.unidentifiedEvents)} · observed member keys: {num(result.cohort.identity.observedMemberKeys)}.</p><p className="hint">Qualification UTC bounds: {result.cohort.range.start} (inclusive) to {result.cohort.range.end} (exclusive).</p>{[...new URLSearchParams(result.cohort.item.definition.query)].filter(([key])=>!['from','to','timeZone','predicates'].includes(key)).map(([key,value])=><p className="hint" key={key}>{key==='kind'?'Qualifying event kind':key==='propertyKey'?'Property key':key==='propertyType'?'Property type':key==='propertyValue'?'Property value':labelOf(FILTERS,key)}: {JSON.stringify(value)}</p>)}<AdvancedSummary draft={qualificationDraft(result.cohort.item.definition.query)!.advanced} zone={result.cohort.range.timeZone}/><p className="hint">{result.cohort.limitation}</p></div></details>
        </section>}
        {result.coverage.status!=='complete'&&(
          <p className="hint">Coverage is {result.coverage.status}: results include retained observations only{result.coverage.retainedFrom?` from ${result.coverage.retainedFrom}`:''}.</p>
        )}

        <div className="metric-grid">
          <div className="card">
            <div className={`metric-value${t.events===null?' is-unavailable':''}`}>{num(t.events)}</div>
            <div className="metric-label">Events</div>
            <div className="hint dim">{num(t.identifiedEvents)} identified · {num(t.unidentifiedEvents)} unidentified</div>
          </div>
          <div className="card">
            <div className={`metric-value${t.pageViews===null?' is-unavailable':''}`}>{num(t.pageViews)}</div>
            <div className="metric-label">Page views</div>
          </div>
          <div className="card">
            <div className={`metric-value${t.customEvents===null?' is-unavailable':''}`}>{num(t.customEvents)}</div>
            <div className="metric-label">Custom events</div>
          </div>
          <div className="card">
            <div className={`metric-value${t.visitors===null?' is-unavailable':''}`}>{num(t.visitors)}</div>
            <div className="metric-label">Visitors</div>
            <div className="hint dim">{t.visitors==null?'Visitor estimate unavailable':`${num(t.visits)} visits`}</div>
          </div>
        </div>

        <div className="card stack">
          <h3>Breakdown</h3>
          <p className="hint dim">
            {cohortMembershipUnavailable?'Breakdown unavailable because cohort membership is unavailable.':result.coverage.status==='unavailable'?'Breakdown unavailable after retention.':<>
            Returned {num(result.breakdown.returnedGroupEvents)} of {num(t.events)} events across {num(result.breakdown.totalGroups)} groups.
            {result.breakdown.truncated?' Breakdown truncated — apply filters to narrow the results.':''}
            </>}
          </p>
          {result.breakdown.groups.length===0?(
            <p className="hint dim">{cohortMembershipUnavailable?'Qualification data cannot establish membership. Review the qualification period and identifier coverage.':result.coverage.status==='unavailable'?'This history is no longer available. Choose a more recent range.':'No retained events match these filters. Change the dates or remove filters.'}</p>
          ):(
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Breakdown data, scroll horizontally for all columns">
              <table>
                <thead><tr><th>Value</th><th>Type</th><th>Events</th><th>Visitors</th></tr></thead>
                <tbody>
                  {result.breakdown.groups.slice(0,100).map((g,i)=>(
                    <tr key={i}>
                      <td>{groupValue(g.type,g.value)}</td>
                      <td>{groupType(g.type)}</td>
                      <td>{g.events}</td>
                      <td>{g.visitors==null?'Unavailable':g.visitors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <details className="card">
          <summary>Daily data ({result.daily.length} {result.daily.length===1?'day':'days'})</summary>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Daily data, scroll horizontally for all columns">
            <table>
              <thead><tr><th>Date</th><th>Events</th><th>Page views</th><th>Custom events</th><th>Coverage</th><th>Notes</th></tr></thead>
              <tbody>
                {result.daily.map(d=>(
                  <tr key={d.date}>
                    <td>
                      {d.date}
                      {d.skipped?(
                        <div className="hint dim">This calendar date did not occur in {result.range.timeZone}.</div>
                      ):(
                        <details>
                          <summary className="hint dim">UTC boundaries</summary>
                          <div className="hint dim">{d.start} – {d.end}</div>
                        </details>
                      )}
                    </td>
                    <td>{d.skipped?'—':num(d.events)}</td>
                    <td>{d.skipped?'—':num(d.pageViews)}</td>
                    <td>{d.skipped?'—':num(d.customEvents)}</td>
                    <td>{d.coverage}</td>
                    <td>{annotations.dayButton(d.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </>)}
      <div className="card">{annotations.panel}</div>
      {phase==='ok'&&result&&(<>

        {result.numeric&&(
          <div className="card stack">
            <h3>Property values</h3>
            <p className="hint dim">{result.numeric.samples} numeric {result.numeric.samples===1?'sample':'samples'} · exact decimal values</p>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Numeric property data, scroll horizontally for all columns">
              <table>
                <thead><tr><th>Sum</th><th>Average</th><th>Min</th><th>Max</th></tr></thead>
                <tbody><tr>
                  <td>{decimal(result.numeric.sum)}</td>
                  <td>{decimal(result.numeric.average)}</td>
                  <td>{decimal(result.numeric.min)}</td>
                  <td>{decimal(result.numeric.max)}</td>
                </tr></tbody>
              </table>
            </div>
          </div>
        )}
      </>)}
    </section>
  );
}
