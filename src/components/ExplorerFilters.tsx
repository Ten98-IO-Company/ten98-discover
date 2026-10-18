import {analyticsFieldLimit} from '../lib/analytics-dimensions';
import {useEffect,useState} from 'react';
import type {AdvancedPredicates} from '../server/advanced-predicate-input';
import {environmentCatalog,environmentFields,isEnvironmentFilter,type EnvironmentField} from '../lib/analytics-environment';
import {geographyFields,geographyFiltersValid,parseGeographyKey,serializeGeographyKey,type GeoField,type GeographyFilters} from '../lib/analytics-geography';
import {applyGeographyFilter,geographyNavigationNames,type AnalyticsNavigation} from '../lib/navigation';
import {geographyLabel} from './GeographyCard';
type SessionSelection={method:'current-retained-session-properties-v1';asOf:string;retainedFrom:string;evidence:{lost:boolean;lostAt:string|null;expiredValuesPresent:boolean};candidates:{identifiedEvents:number|null;unidentifiedEvents:number|null};selection:{status:'available'|'unavailable';countsAreLowerBounds:boolean;reason:'missing_evidence_lost'|'identity_unavailable'|'candidate_scope_unavailable'|null};limitation:string};
const KINDS=[['all','All events'],['pageviews','Page views'],['custom','Custom events']] as const;

const FILTERS=[['eventName','Event name'],['path','Path'],['origin','Origin'],['referrer','Referrer'],['language','Language'],['browser','Browser'],['os','OS'],['device','Device'],['country','Country'],['region','Region'],['city','City'],['campaignSource','Campaign source'],['campaignMedium','Campaign medium'],['campaignName','Campaign name'],['campaignTerm','Campaign term'],['campaignContent','Campaign content'],['hostname','Hostname'],['screen','Recorded screen'],['channel','Recorded channel']] as const;
const PROP_TYPES=['missing','string','number','boolean','null','date','array'] as const;
const TIMEZONES=['UTC','America/New_York','America/Chicago','America/Los_Angeles','Europe/London','Europe/Berlin','Asia/Dubai','Asia/Tokyo','Australia/Sydney'];

const utcDate=(d:Date)=>d.toISOString().slice(0,10);
const labelOf=(list:readonly (readonly [string,string])[],v:string)=>list.find(([k])=>k===v)?.[1]??v;
const num=(v:number|null)=>v==null?'Unavailable':String(v);
const decimal=(v:string|null)=>v===null?'Unavailable':v.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');

interface FilterRow{on:boolean;value:string}
export const isGeo=(field:string):field is GeoField=>geographyFields.includes(field as GeoField);
export const fieldValueLabel=(field:string,value:string)=>isGeo(field)?(parseGeographyKey(field,value)?geographyLabel(parseGeographyKey(field,value)!):'Incomplete location'):JSON.stringify(value);
export function patchLocationFilters(filters:Record<string,FilterRow>,field:string,patch:Partial<FilterRow>){
  const next={...filters,[field]:{...filters[field],...patch}};if(!isGeo(field)||!next[field].on)return next;
  const key=parseGeographyKey(field,next[field].value);if(!key)return next;
  const intent:AnalyticsNavigation={};for(const geo of geographyFields)if(next[geo].on)intent[geographyNavigationNames[geo]]=next[geo].value;
  const applied=applyGeographyFilter(intent,field,key);for(const geo of geographyFields){const value=applied[geographyNavigationNames[geo]];next[geo]=value===undefined?{...next[geo],on:false}:{on:true,value};}return next;
}
const countryNames=new Intl.DisplayNames('en-US',{type:'region'});
const countryChoices=Array.from({length:676},(_,i)=>String.fromCharCode(65+Math.floor(i/26),65+i%26)).map(code=>({code,name:countryNames.of(code)??code})).filter(row=>row.name!==row.code&&row.name!=='Unknown Region').sort((a,b)=>a.name.localeCompare(b.name));
export function GeographyValueControl({id,field,value,disabled,onChange}:{id:string;field:GeoField;value:string;disabled?:boolean;onChange:(value:string)=>void}){
  let parsed:Record<string,unknown>={};try{const raw=JSON.parse(value);if(raw&&typeof raw==='object'&&!Array.isArray(raw))parsed=raw;}catch{}
  const state=['known','unknown','not-recorded'].includes(String(parsed.state))?String(parsed.state):'known',country=typeof parsed.country==='string'?parsed.country:'',region=parsed.region&&typeof parsed.region==='object'?parsed.region as Record<string,unknown>:null,regionKind=region?.kind==='name'?'name':'code',regionValue=typeof region?.value==='string'?region.value:'',city=typeof parsed.city==='string'?parsed.city:'';
  const change=(patch:Record<string,unknown>)=>{const next={state,country,...field!=='country'?{region:region===null?null:{kind:regionKind,value:regionValue}}:{},...field==='city'?{city}:{},...patch};onChange(serializeGeographyKey(field,next)??JSON.stringify(next));};
  return <div className="geography-value"><div><label htmlFor={id}>Location value</label><select id={id} value={state} disabled={disabled} onChange={e=>e.target.value==='known'?change({state:'known'}):onChange(JSON.stringify({state:e.target.value}))}><option value="known">Choose a known location</option><option value="unknown">Unknown after lookup</option><option value="not-recorded">Not recorded</option></select></div>{state==='known'&&<><div><label htmlFor={`${id}-country`}>Country</label><select id={`${id}-country`} value={country} disabled={disabled} onChange={e=>change({country:e.target.value,...field!=='country'?{region:field==='city'?null:{kind:'code',value:''}}:{},...field==='city'?{city:''}:{}})}><option value="">Choose a country</option>{country&&!countryChoices.some(row=>row.code===country)&&<option value={country}>{country} (recorded code)</option>}{countryChoices.map(row=><option key={row.code} value={row.code}>{row.name} ({row.code})</option>)}</select></div>{field!=='country'&&<><div><label htmlFor={`${id}-region-kind`}>Region identifier</label><select id={`${id}-region-kind`} disabled={disabled} value={region===null&&field==='city'?'unknown':regionKind} onChange={e=>change({region:e.target.value==='unknown'?null:{kind:e.target.value,value:''}})}><option value="code">ISO region code</option><option value="name">Recorded region name</option>{field==='city'&&<option value="unknown">Unknown region</option>}</select></div>{!(field==='city'&&region===null)&&<div><label htmlFor={`${id}-region`}>{regionKind==='code'?'Region code':'Region name'}</label><input id={`${id}-region`} disabled={disabled} maxLength={regionKind==='code'?32:256} placeholder={regionKind==='code'?`${country||'US'}-IL`:'Recorded name'} value={regionValue} onChange={e=>change({region:{kind:regionKind,value:e.target.value}})}/></div>}</>}{field==='city'&&<div><label htmlFor={`${id}-city`}>City name</label><input id={`${id}-city`} disabled={disabled} maxLength={256} value={city} onChange={e=>change({city:e.target.value})}/></div>}</>}<p className="hint">Unknown means a completed lookup lacked this value. Not recorded means no location lookup evidence. Use the exact recorded name or region code; location is approximate.</p></div>;
}
type AdvancedRow={id:string;field:string;operator:string;type:string;value:string};
type AdvancedDraft={match:'all'|'any';fields:AdvancedRow[];properties:AdvancedRow[];sessionProperties:AdvancedRow[]};
type AdvancedIssue={error:string;row?:string;part?:'field'|'operator'|'type'|'value'};
function emptyAdvanced():AdvancedDraft{return {match:'all',fields:[],properties:[],sessionProperties:[]};}
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
  for(const [k,label] of FILTERS){const f=d.filters[k];if(f.on){if(environmentFields.includes(k as EnvironmentField)&&!isEnvironmentFilter(k as EnvironmentField,f.value))return {error:`Choose a supported ${label} category.`};if(isGeo(k)&&!parseGeographyKey(k,f.value))return{error:`Complete the ${label} location. Choose a country and enter a valid recorded region or city, or select Unknown or Not recorded.`};p.set(k,f.value);}}
  if(!geographyFiltersValid(Object.fromEntries(geographyFields.filter(field=>p.has(field)).map(field=>[field,p.get(field)!]))))return{error:'Choose compatible country, region and city filters.'};
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


type Definition={schemaVersion:1;name:string;query:string};
type SavedFilter={id:string;projectId:string;revision:number;definition:Definition;createdAt:string;updatedAt:string};

type CohortRef={id:string;revision:number};

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const clean=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max&&!value.includes('\0')&&new TextDecoder().decode(new TextEncoder().encode(value))===value;

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
  for(const [key,value] of p)if(!allowed.has(key)||p.getAll(key).length!==1||!clean(value,key==='predicates'?20000:key==='propertyValue'?8192:analyticsFieldLimit(key)))return null;
  const kind=p.get('kind');if(!KINDS.some(([key])=>key===kind))return null;
  const filters=Object.fromEntries(FILTERS.map(([key])=>[key,{on:p.has(key),value:p.get(key)??''}]));
  for(const field of environmentFields)if(p.has(field)&&!isEnvironmentFilter(field,p.get(field)))return null;
  const geography:GeographyFilters={};for(const field of geographyFields)if(p.has(field)){const value=p.get(field)!;if(!parseGeographyKey(field,value))return null;geography[field]=value;}if(!geographyFiltersValid(geography))return null;
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
function rowOperators(property:boolean,type:string,field=''):string[]{return !property&&isGeo(field)?['eq','neq','exists','missing']:[...(!property||type==='string'?['eq','neq','contains','not_contains','prefix','suffix','regex','not_regex']:type==='number'?['eq','neq','gt','gte','lt','lte']:type==='date'?['eq','neq','before','after']:type==='array'?['eq','neq','includes','not_includes']:['eq','neq']), 'exists','missing'];}
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
  const count=draft.fields.length+draft.properties.length+draft.sessionProperties.length;if(!count)return {};
  if(count>20||draft.properties.length+draft.sessionProperties.length>10||!['all','any'].includes(draft.match)||draft.match==='any'&&!draft.fields.length)return {error:'Use at most 20 additional conditions, including 10 event and session property conditions combined. Any requires a field condition.'};
  const fields:AdvancedPredicates['fields']=[],properties:AdvancedPredicates['properties']=[],sessionProperties:AdvancedPredicates['properties']=[];
  const scalar=(value:unknown)=>value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e15||clean(value,1000);
  for(const key of ['fields','properties','sessionProperties'] as const)for(const [index,row]of draft[key].entries()){
    const property=key!=='fields',target=key==='sessionProperties'?sessionProperties:properties;
    const issue=(part:AdvancedIssue['part'],message:string):AdvancedIssue=>({error:`${key==='sessionProperties'?'Session property':property?'Property':'Field'} condition ${index+1}: ${message}`,row:row.id,part});
    if(property?!clean(row.field,320)||!row.field.length:!FILTERS.some(([key])=>key===row.field))return issue('field',property?'enter a property key.':'choose a field.');
    if(!rowOperators(property,row.type,row.field).includes(row.operator))return issue('operator','choose a supported operator for this type.');
    if(presence(row.operator)){(property?target:fields).push((property?{key:row.field,operator:row.operator}:{field:row.field,operator:row.operator}) as never);continue;}
    if(!property&&isGeo(row.field)){if(!parseGeographyKey(row.field,row.value))return issue('value','complete this location, or choose Unknown or Not recorded.');fields.push({field:row.field,operator:row.operator,value:row.value} as AdvancedPredicates['fields'][number]);continue;}
    if(property&&!PROP_TYPES.filter(type=>type!=='missing').includes(row.type as never))return issue('type','choose a property type.');
    let value:unknown=row.value;
    if(property&&!dayOperator(row.operator)){try{value=JSON.parse(row.value);}catch{return issue('value','enter a valid JSON value of the selected type.');}}
    if(!property||row.type==='string'){
      if(!clean(value,property?1000:analyticsFieldLimit(row.field))||!['eq','neq'].includes(row.operator)&&!value.length)return issue('value','enter supported text within the limit; search and pattern values cannot be empty.');
      if(!property&&row.field==='origin'&&['eq','neq'].includes(row.operator)){try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.origin!==value)return issue('value','enter an exact HTTP(S) origin without a path.');}catch{return issue('value','enter an exact HTTP(S) origin without a path.');}}
    }else if(row.type==='date'){
      if(dayOperator(row.operator)){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1970-01-01'||value>'9998-12-31'||!preciseDate(value+'T00:00:00Z'))return issue('value','choose a real comparison day from 1970 to 9998.');}
      else{value=preciseDate(value);if(value===null)return issue('value','enter a valid ISO date string with an explicit offset.');}
    }else if(row.type==='array'){
      if(['includes','not_includes'].includes(row.operator)){if(!scalar(value))return issue('value','enter one JSON string, number, boolean or null.');}
      else if(!Array.isArray(value)||value.length>50||!value.every(scalar)||new TextEncoder().encode(JSON.stringify(value)).length>4096)return issue('value','enter an array of at most 50 scalar values and 4096 bytes.');
    }else if(row.type==='null'?value!==null:typeof value!==row.type||!scalar(value))return issue('value',`enter a JSON value that matches ${row.type}.`);
    if(property)target.push({key:row.field,operator:row.operator,type:row.type,value} as AdvancedPredicates['properties'][number]);
    else fields.push({field:row.field,operator:row.operator,value} as AdvancedPredicates['fields'][number]);
  }
  const predicates:AdvancedPredicates={version:1,match:draft.match,fields,properties,...(sessionProperties.length?{sessionProperties}:{})};
  if(new URLSearchParams({predicates:JSON.stringify(predicates)}).toString().length>20000)return {error:'These filters are too large. Shorten values or remove conditions.'};
  return {predicates};
}
function readAdvanced(value:unknown):AdvancedDraft|null{
  if(!record(value)||Object.keys(value).some(key=>!['version','match','fields','properties','sessionProperties'].includes(key))||value.version!==1||!['all','any'].includes(value.match as string)||!Array.isArray(value.fields)||!Array.isArray(value.properties)||Object.hasOwn(value,'sessionProperties')&&!Array.isArray(value.sessionProperties)||!value.fields.length&&!value.properties.length&&!(value.sessionProperties as unknown[]|undefined)?.length)return null;
  const draft=emptyAdvanced();draft.match=value.match as 'all'|'any';
  for(const key of ['fields','properties','sessionProperties'] as const)for(const [index,row]of ((value[key]??[]) as unknown[]).entries()){
    const property=key!=='fields';
    if(!record(row)||typeof row.operator!=='string')return null;const keys=presence(row.operator)?[property?'key':'field','operator']:property?['key','operator','type','value']:['field','operator','value'];
    if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key))||Object.keys(row).some(key=>!keys.includes(key))||!presence(row.operator)&&(property?typeof row.type!=='string':typeof row.value!=='string')||typeof row[property?'key':'field']!=='string')return null;
    draft[key].push({id:key+index,field:row[property?'key':'field'] as string,operator:row.operator,type:property&&!presence(row.operator)?row.type as string:'',value:presence(row.operator)?'':property&&!dayOperator(row.operator)?JSON.stringify(row.value):row.value as string});
  }
  return 'error'in buildAdvanced(draft)?null:draft;
}
function focusAdvanced(id:string,issue?:AdvancedIssue){const root=document.getElementById(id) as HTMLDetailsElement|null;if(!root)return;root.open=true;const input=issue?.row?document.getElementById(`${id}-${issue.row}-${issue.part}`):root.querySelector<HTMLElement>('[data-pattern]');input?.focus();}
function validAdvancedResult(value:unknown,method:unknown,expected?:AdvancedPredicates){
  if(!expected)return value===undefined&&method===undefined;const draft=readAdvanced(value);if(!draft||!record(method))return false;const parsed=buildAdvanced(draft);
  return 'predicates'in parsed&&JSON.stringify(parsed.predicates)===JSON.stringify(expected)&&method.version==='native-flat-predicates-v1'&&method.requiredFilters==='all'&&method.fieldMatch===expected.match&&method.propertyMatch==='all'&&method.textSearch==='postgresql-lower-literal'&&method.regex==='postgresql-case-insensitive'&&method.dateComparison==='calendar-day-in-scope-timezone'&&(expected.sessionProperties?.length?method.sessionPropertyMatch==='all'&&method.sessionPropertyValues==='current-retained-at-report-snapshot':method.sessionPropertyMatch===undefined&&method.sessionPropertyValues===undefined);
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
function validSessionSelection(value:unknown,expected?:AdvancedPredicates){
  if(!expected?.sessionProperties?.length)return value===undefined;
  const keys=(v:unknown,names:string[]):v is Record<string,unknown>=>record(v)&&Object.keys(v).length===names.length&&names.every(key=>Object.hasOwn(v,key));
  const time=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
  const count=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0;
  if(!keys(value,['method','asOf','retainedFrom','evidence','candidates','selection','limitation'])||value.method!=='current-retained-session-properties-v1'||!time(value.asOf)||!time(value.retainedFrom)||!clean(value.limitation,2000)||!keys(value.evidence,['lost','lostAt','expiredValuesPresent'])||!keys(value.candidates,['identifiedEvents','unidentifiedEvents'])||!keys(value.selection,['status','countsAreLowerBounds','reason']))return false;
  const {evidence:e,candidates:c,selection:s}=value;
  if(typeof e.lost!=='boolean'||typeof e.expiredValuesPresent!=='boolean'||e.lostAt!==null&&!time(e.lostAt)||e.lost!==(e.lostAt!==null||e.expiredValuesPresent)||typeof s.countsAreLowerBounds!=='boolean')return false;
  if(s.status==='available')return s.reason===null&&count(c.identifiedEvents)&&count(c.unidentifiedEvents)&&!(c.identifiedEvents===0&&(c.unidentifiedEvents as number)>0)&&(!(e.lost||(c.unidentifiedEvents as number)>0)||s.countsAreLowerBounds)&&!(e.lost&&expected.sessionProperties.some(row=>row.operator==='missing'));
  if(s.status!=='unavailable'||s.countsAreLowerBounds!==false)return false;
  if(s.reason==='candidate_scope_unavailable')return c.identifiedEvents===null&&c.unidentifiedEvents===null;
  if(!count(c.identifiedEvents)||!count(c.unidentifiedEvents))return false;
  return s.reason==='missing_evidence_lost'?e.lost&&expected.sessionProperties.some(row=>row.operator==='missing'):s.reason==='identity_unavailable'&&c.identifiedEvents===0&&(c.unidentifiedEvents as number)>0;
}

function AdvancedSummary({draft,zone}:{draft:AdvancedDraft;zone:string}){
  const result=buildAdvanced(draft);if('error'in result)return <p className="hint">Additional conditions are incomplete: {result.error}</p>;
  if(!result.predicates)return null;
  return <div className="stack advanced-summary"><p><strong>Additional fields — {draft.match}</strong></p>{draft.fields.length?result.predicates.fields.map((row,index)=><p className="hint" key={index}>{labelOf(FILTERS,row.field)} · {!isGeo(row.field)?labelOf(OPERATORS,row.operator):row.operator==='exists'?'Is recorded':row.operator==='missing'?'Is not recorded':labelOf(OPERATORS,row.operator)}{'value'in row?` ${fieldValueLabel(row.field,row.value)}`:''}</p>):<p className="hint">No additional field group.</p>}{(['properties','sessionProperties'] as const).map(key=><div key={key}><p><strong>{key==='properties'?'Event property conditions — all':'Current session properties — all'}</strong></p>{(result.predicates![key]??[]).map((row,index)=><p className="hint" key={index}>{JSON.stringify(row.key)}{'type'in row?` · ${row.type}`:''} · {labelOf(OPERATORS,row.operator)}{'value'in row?` ${JSON.stringify(row.value)}`:''}{dayOperator(row.operator)?` (${zone}; selected day excluded)`:''}</p>)}{key==='sessionProperties'&&draft.sessionProperties.length>0&&<p className="hint">Uses current retained values at the report snapshot. Later updates can change older reports.</p>}</div>)}<p className="hint">Required filters and all property conditions still apply. Literal text search ignores case; patterns use PostgreSQL case-insensitive matching.</p></div>;
}
function sessionReason(scope:SessionSelection){return scope.selection.reason==='missing_evidence_lost'?'Retention removed property evidence, so absence cannot be established.':scope.selection.reason==='identity_unavailable'?'The candidate activity has no usable visitor identifiers.':'The event or cohort population needed for these conditions is unavailable.';}
function SessionStatus({scope,label}:{scope:SessionSelection;label:string}){return <section className="card stack" aria-label={label}><h3>{label}</h3><p role="status" className={scope.selection.status==='unavailable'?'alert':scope.selection.countsAreLowerBounds?'banner':'hint'}>{scope.selection.status==='unavailable'?<>Session filter unavailable. {sessionReason(scope)}</>:scope.selection.countsAreLowerBounds?'Observed count lower bounds. Some property, event or identifier evidence is unavailable. Numeric summaries and rates are not bounds.':'Current retained session properties applied.'}</p><p className="hint">Snapshot: {scope.asOf}. Property updates retained from: {scope.retainedFrom}.</p><details><summary>Session property evidence</summary><p>Candidate events before session conditions: {num(scope.candidates.identifiedEvents)} identified · {num(scope.candidates.unidentifiedEvents)} unidentified.</p><p className="hint">Property evidence lost: {scope.evidence.lost?'Yes':'No known loss'}. Recorded loss: {scope.evidence.lostAt??'None'}. Expired values awaiting cleanup: {scope.evidence.expiredValuesPresent?'Yes':'No'}.</p><p className="hint">{scope.limitation}</p><p className="hint">Refresh evaluates these same rules against a new snapshot. Later property updates can change older reports without changing a saved definition.</p></details></section>;}
function AdvancedControls({id,label,draft,zone,error,onChange}:{id:string;label:string;draft:AdvancedDraft;zone:string;error:string;onChange:(value:AdvancedDraft)=>void}){
  type Group='fields'|'properties'|'sessionProperties';const groupLabel=(key:Group)=>key==='sessionProperties'?'Session property':key==='properties'?'Property':'Field';
  const [focus,setFocus]=useState<string|null>(null),[notice,setNotice]=useState('');const built=buildAdvanced(draft),issue=error&&'error'in built?built:null,count=draft.fields.length+draft.properties.length+draft.sessionProperties.length;
  useEffect(()=>{if(focus){document.getElementById(focus)?.focus();setFocus(null);}},[focus,draft]);
  function change(key:Group,row:AdvancedRow,patch:Partial<AdvancedRow>){onChange({...draft,[key]:draft[key].map(value=>value.id===row.id?{...value,...patch}:value)});}
  function add(key:Group){const row={id:crypto.randomUUID(),field:'',type:'',operator:'eq',value:''};onChange({...draft,[key]:[...draft[key],row]});setFocus(`${id}-${row.id}-field`);setNotice(`${groupLabel(key)} condition added.`);}
  function remove(key:Group,row:AdvancedRow){const index=draft[key].findIndex(value=>value.id===row.id),rows=draft[key].filter(value=>value.id!==row.id);onChange({...draft,[key]:rows,match:key==='fields'&&!rows.length?'all':draft.match});const next=rows[index]??rows[index-1];setFocus(next?`${id}-${next.id}-field`:`${id}-add-${key}`);setNotice(`${groupLabel(key)} condition removed.${key==='fields'&&!rows.length?' No additional field group. Every property condition is still required.':''}`);}
  return <details id={id} className="advanced-controls"><summary>{label} ({count} conditions)</summary><div className="stack"><p className="hint">Required filters and every property condition must match. Choose whether all or any additional field conditions must also match. Changes wait for {label==='Advanced filters'?'Apply filters':'Save cohort'}.{label!=='Advanced filters'?' The qualifying action and event conditions must match the same event. Session conditions use that event\'s visitor key and latest retained values.':''}</p>{!count&&<p className="hint">No additional conditions. Required filters still apply.</p>}{notice&&<p className="hint" role="status">{notice}</p>}
    {(['fields','properties','sessionProperties'] as const).map(key=>{const property=key!=='fields',session=key==='sessionProperties';return <fieldset key={key} className="stack"><legend>{session?'Current session properties — all':property?'Event property conditions — all':'Additional fields'}</legend>{session&&<p className="hint">Latest retained values for the event's visitor key. Later updates can change older reports. These values are separate from event properties.{label!=='Advanced filters'?' Qualification dates select events, not historical property values.':''}</p>}{session&&!draft.sessionProperties.length&&<p className="hint">No session property conditions.</p>}{!property&&draft.fields.length>0&&<div><label htmlFor={`${id}-match`}>Match additional fields</label><select id={`${id}-match`} value={draft.match} onChange={e=>onChange({...draft,match:e.target.value as 'all'|'any'})}><option value="all">All conditions</option><option value="any">Any condition</option></select></div>}
      {draft[key].map((row,index)=>{const base=`${id}-${row.id}`,isPresence=presence(row.operator),isDay=dayOperator(row.operator),isPattern=['regex','not_regex'].includes(row.operator),rowIssue=issue?.row===row.id?issue:null;const invalid=(part:string)=>rowIssue?.part===part;
        return <fieldset className="stack advanced-row" key={row.id}><legend>{groupLabel(key)} condition {index+1}</legend><div className="row">
          <div className="advanced-field"><label htmlFor={`${base}-field`}>{property?'Property key':'Field'}</label>{property?<input id={`${base}-field`} maxLength={320} value={row.field} aria-invalid={invalid('field')} aria-describedby={`${base}-help${rowIssue?` ${base}-error`:''}`} onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();}} onChange={e=>change(key,row,{field:e.target.value})}/>:<select id={`${base}-field`} value={row.field} aria-invalid={invalid('field')} aria-describedby={rowIssue?`${base}-error`:undefined} onChange={e=>{const field=e.target.value;change(key,row,{field,...(!rowOperators(property,row.type,field).includes(row.operator)?{operator:'eq'}:{}),...(isGeo(field)||isGeo(row.field)?{value:''}:{})});}}><option value="">Choose a field</option>{FILTERS.map(([key,name])=><option key={key} value={key}>{name}</option>)}</select>}</div>
          {property&&!isPresence&&<div className="advanced-field"><label htmlFor={`${base}-type`}>Property type</label><select id={`${base}-type`} value={row.type} aria-invalid={invalid('type')} aria-describedby={rowIssue?`${base}-error`:undefined} onChange={e=>{const type=e.target.value;change(key,row,{type,operator:rowOperators(property,type,row.field).includes(row.operator)?row.operator:'',...(isDay?{value:''}:{})});}}><option value="">Choose a type</option>{PROP_TYPES.filter(type=>type!=='missing').map(type=><option key={type} value={type}>{type}</option>)}</select></div>}
          <div className="advanced-field"><label htmlFor={`${base}-operator`}>Operator</label><select id={`${base}-operator`} value={row.operator} aria-invalid={invalid('operator')} aria-describedby={rowIssue?`${base}-error`:undefined} onChange={e=>{const operator=e.target.value;change(key,row,{operator,...(presence(operator)?{type:'',value:''}:dayOperator(operator)!==isDay?{value:''}:{})});}}><option value="">Choose an operator</option>{OPERATORS.filter(([operator])=>rowOperators(property,row.type,row.field).includes(operator)).map(([operator,name])=><option key={operator} value={operator}>{!property&&isGeo(row.field)&&operator==='exists'?'Is recorded':!property&&isGeo(row.field)&&operator==='missing'?'Is not recorded':name}</option>)}</select></div>
          {!isPresence&&<div className="advanced-field"><label htmlFor={`${base}-value`}>{!property&&isGeo(row.field)?'Location':isDay?'Comparison day':property?row.type==='array'&&['includes','not_includes'].includes(row.operator)?'Element (JSON scalar)':'Value (JSON literal)':'Value'}</label><>{!property&&isGeo(row.field)?<GeographyValueControl id={`${base}-value`} field={row.field} value={row.value} onChange={value=>change(key,row,{value})}/>:<input id={`${base}-value`} type={isDay?'date':'text'} min={isDay?'1970-01-01':undefined} max={isDay?'9998-12-31':undefined} dir={property||isPattern?'ltr':undefined} value={row.value} data-pattern={isPattern?'true':undefined} aria-invalid={invalid('value')} aria-describedby={`${base}-help${rowIssue?` ${base}-error`:''}`} onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();}} onChange={e=>change(key,row,{value:e.target.value})}/>}</></div>}
        </div><p className="hint" id={`${base}-help`}>{!property&&isGeo(row.field)?isPresence?'Recorded includes completed Unknown lookups. Not recorded means no lookup evidence.':'Matches one exact qualified location. Does not equal includes other location states; names are case-sensitive.':isPresence?session?'Presence includes retained null, empty strings and arrays. Missing is different from null. Results are unavailable when retained evidence cannot establish absence.':'Presence includes collected null, empty strings and arrays. Missing means the field or key was not collected.':isDay?`Compares calendar days in ${zone}; the selected day is excluded.`:isPattern?'Case-insensitive PostgreSQL pattern. The server checks it when you apply or save.':row.type==='array'?'Whole-array equality is order-sensitive. An element keeps its JSON type: 1 and "1" are different.':row.type==='date'?'Use an ISO date string with an explicit offset; exact equality preserves fractional seconds.':!property||row.type==='string'?['eq','neq'].includes(row.operator)?!property&&row.field==='origin'?'Enter an exact HTTP(S) origin without a path. Equals is case-sensitive.':'Equals is case-sensitive. Spaces and commas are literal. Empty exact strings are valid; a property string uses JSON quotes.':'Text search ignores case. %, _ and backslash are literal. Enter a nonempty value.':'Use a JSON value of the selected type. Zero, false and null are distinct from missing.'}{!(!property&&isGeo(row.field))&&['neq','not_contains','not_regex','not_includes'].includes(row.operator)?' Requires a collected value; properties must have the selected type. Use Is missing for absence.':''}</p>{rowIssue&&<p className="alert" id={`${base}-error`} role="alert">{rowIssue.error}</p>}<button className="btn" type="button" aria-label={`Remove ${session?'session property':property?'property':'field'} condition ${index+1}`} onClick={()=>remove(key,row)}>Remove</button></fieldset>;
      })}
      <button id={`${id}-add-${key}`} className="btn" type="button" disabled={count>=20||property&&draft.properties.length+draft.sessionProperties.length>=10} onClick={()=>add(key)}>Add {session?'session property':property?'property':'field'} condition</button>{property&&draft.properties.length+draft.sessionProperties.length>=10&&<p className="hint">10-property-condition limit reached across event and session properties.</p>}
    </fieldset>;})}<p className="hint">{count} of 20 additional conditions · {draft.properties.length+draft.sessionProperties.length} of 10 event and session property conditions.{count>=20?' 20-condition limit reached.':''}</p></div></details>;
}


export function ExactFilterControls({uid,draft,patchFilter,patchProp,keysTruncated=false}:{uid:string;draft:Draft;patchFilter:(key:string,value:Partial<FilterRow>)=>void;patchProp:(value:Partial<Draft["prop"]>)=>void;keysTruncated?:boolean}){
return (<details>
          <summary>More filters</summary>
            <div className="stack">
            <p><strong>Required filters — all</strong></p>
            {FILTERS.map(([k,l])=>(
              <div className="row" key={k}>
                <input id={`${uid}-${k}-on`} type="checkbox" checked={draft.filters[k].on} onChange={e=>patchFilter(k,{on:e.target.checked})}/>
                <label htmlFor={`${uid}-${k}-on`}>Enable {l}</label>
                <label htmlFor={`${uid}-${k}-v`}>{l} equals</label>
                {isGeo(k)?<GeographyValueControl id={`${uid}-${k}-v`} field={k} value={draft.filters[k].value} disabled={!draft.filters[k].on} onChange={value=>patchFilter(k,{value})}/>:environmentFields.includes(k as EnvironmentField)?<select id={`${uid}-${k}-v`} disabled={!draft.filters[k].on} value={draft.filters[k].value} onChange={e=>patchFilter(k,{value:e.target.value})}><option value="">Choose a category</option>{environmentCatalog[k as EnvironmentField].map(value=><option key={value} value={value}>{value==='unknown'?'Unknown':value}</option>)}<option value="not-recorded">Not recorded</option></select>:<input id={`${uid}-${k}-v`} type="text" disabled={!draft.filters[k].on} value={draft.filters[k].value} onChange={e=>patchFilter(k,{value:e.target.value})}/>}
              </div>
            ))}
            <p className="hint">For Browser, OS and Device, Unknown means classification was attempted; Not recorded means the event lacks environment evidence.</p>
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
        </details>);
}
export {KINDS,FILTERS,PROP_TYPES,TIMEZONES,utcDate,labelOf,num,decimal,emptyAdvanced,initialDraft,buildParams,record,uuid,clean,draftFilterQuery,savedPredicates,validSaved,sameDefinition,preciseDate,buildAdvanced,readAdvanced,focusAdvanced,validAdvancedResult,qualificationDraft,validCohort,sameCohortDefinition,reportParams,validSessionSelection,sessionReason,AdvancedSummary,SessionStatus,AdvancedControls};
export type {SessionSelection,FilterRow,Draft,Definition,SavedFilter,CohortRef};
