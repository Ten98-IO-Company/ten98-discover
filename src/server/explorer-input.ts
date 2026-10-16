import {analyticsFieldLimit} from '../lib/analytics-dimensions.ts';
import { toUSVString } from 'node:util';
import {z} from 'zod';
import { normalizeProperties } from './analytics-input.ts';
import { analyticsRange } from './analytics.ts';
import { InputError } from './validation.ts';
import {parseAdvancedPredicates,predicateFields,type AdvancedPredicates} from './advanced-predicate-input.ts';
import {environmentFields,isEnvironmentFilter} from '../lib/analytics-environment.ts';
import {geographyFields,geographyFiltersValid} from '../lib/analytics-geography.ts';

export const explorerGroups = ['event','path','origin','referrer','language','browser','os','device','country','region','city','campaignSource','campaignMedium','campaignName','campaignTerm','campaignContent','screenWidth','screenHeight','property'] as const;
export const explorerFilters = predicateFields;
const parameterNames = new Set(['from','to','timeZone','kind','groupBy','groupProperty','propertyKey','propertyType','propertyValue','cohortId','cohortRevision','predicates',...explorerFilters]);
function bad(message = 'Check the exploration filters and try again.'): never { throw new InputError(400, message); }
function text(value: string, maximum: number, empty = false) {
  if ((!empty && !value.length) || value.length > maximum || toUSVString(value) !== value || value.includes('\0')) bad();
  return value;
}

export function explorerQuery(params: URLSearchParams, now = new Date()) {
  if (params.toString().length > 20000) bad('The exploration query is too large.');
  for (const key of params.keys()) if (!parameterNames.has(key) || params.getAll(key).length !== 1) bad('Use each supported filter only once.');
  const zone = params.get('timeZone') ?? 'UTC';
  if (zone.length > 80 || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(zone)) bad('Choose a named IANA timezone, such as Asia/Dubai.');
  let timeZone: string, today: string;
  try {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    timeZone = format.resolvedOptions().timeZone;
    const parts = Object.fromEntries(format.formatToParts(now).map(part => [part.type,part.value]));
    today = `${parts.year}-${parts.month}-${parts.day}`;
  } catch { return bad('Choose a supported IANA timezone.'); }
  const dates = new URLSearchParams();
  for (const key of ['from','to']) if (params.has(key)) dates.set(key, params.get(key)!);
  const range = analyticsRange(dates, new Date(`${today}T12:00:00Z`));
  const kind = params.get('kind') ?? 'all', groupBy = params.get('groupBy') ?? 'event';
  if (!['all','pageviews','custom'].includes(kind) || !explorerGroups.includes(groupBy as typeof explorerGroups[number])) bad();
  if (params.has('groupProperty') !== (groupBy === 'property')) bad('Choose a property key only when grouping by a property.');
  const groupProperty = groupBy === 'property' ? text(params.get('groupProperty')!,320) : null;
  const filters: Record<string,string> = {};
  for (const key of explorerFilters) if (params.has(key)) filters[key] = text(params.get(key)!,analyticsFieldLimit(key),true);
  if(!geographyFiltersValid(Object.fromEntries(geographyFields.filter(field=>Object.hasOwn(filters,field)).map(field=>[field,filters[field]]))))bad('Choose compatible location filters.');
  for(const field of environmentFields)if(params.has(field)&&!isEnvironmentFilter(field,filters[field]))bad('Choose a supported browser, OS or device filter.');
  if (filters.origin !== undefined) {
    try { const url = new URL(filters.origin); if (!['https:','http:'].includes(url.protocol) || url.origin !== filters.origin) bad('Enter an exact origin, such as https://www.example.com, without a path.'); }
    catch { bad('Enter an exact origin, such as https://www.example.com, without a path.'); }
  }
  let property: {key:string;type:string;value:unknown} | null = null;
  if (['propertyKey','propertyType','propertyValue'].some(key => params.has(key))) {
    const key = text(params.get('propertyKey') ?? '',320), type = params.get('propertyType');
    if (!type || !['missing','string','number','boolean','null','date','array'].includes(type)) bad('Choose a property filter type.');
    if (type === 'missing') {
      if (params.has('propertyValue')) bad('A missing-property filter has no value.');
      property = {key,type,value:null};
    } else {
      if (!params.has('propertyValue')) bad('Enter a JSON value for the property filter.');
      let raw: unknown;
      try { raw = JSON.parse(text(params.get('propertyValue')!,8192)); }
      catch { return bad('Enter a valid JSON value for the property filter.'); }
      const normalized = normalizeProperties({value:raw}).value;
      if (normalized?.type !== type && !(type === 'string' && typeof raw === 'string')) bad('The property value does not match its selected type.');
      property = {key,type,value:type === 'string' ? raw : normalized.value};
    }
  }
  let cohort:{id:string;revision:number}|undefined;
  if(params.has('cohortId')||params.has('cohortRevision')){
    const id=params.get('cohortId'),revision=params.get('cohortRevision')??'';
    if(!z.uuid().safeParse(id).success||!/^[1-9][0-9]{0,9}(?![\s\S])/.test(revision)||Number(revision)>2147483647)bad('Choose a cohort and its current revision.');
    cohort={id:id!,revision:Number(revision)};
  }
  let predicates:AdvancedPredicates|undefined;
  if(params.has('predicates')){
    let raw:unknown;
    try{raw=JSON.parse(params.get('predicates')!);}catch{return bad('Enter valid JSON for the additional filters.');}
    predicates=parseAdvancedPredicates(raw);
    const normalized=new URLSearchParams(params);normalized.set('predicates',JSON.stringify(predicates));
    for(const [key,value]of Object.entries({from:range.from,to:range.to,timeZone,kind,groupBy}))normalized.set(key,value);
    if(property&&property.type!=='missing')normalized.set('propertyValue',JSON.stringify(property.value));
    if(normalized.toString().length>20000)bad('The exploration query is too large.');
  }
  return {from:range.from,to:range.to,timeZone,kind,groupBy,groupProperty,filters,property,...(cohort?{cohort}:{}),...(predicates?{predicates}:{})};
}

export type ExplorerTupleField=Exclude<typeof explorerGroups[number],'property'>;
export type ExplorerTupleAtom={type:string;value:unknown};
export type CompoundExplorerQuery=Omit<ReturnType<typeof explorerQuery>,'groupBy'|'groupProperty'>&{fields:ExplorerTupleField[];groupBy?:undefined;groupProperty?:undefined};

// Grouping belongs only to Explore, never to saved predicates or other reports.
export function explorerGroupingQuery(params:URLSearchParams,now=new Date()){
  if(params.has('propertyView')||params.has('propertyCursor')){
    if(params.toString().length>20000)bad('The exploration query is too large.');
    if(params.getAll('propertyView').length!==1||params.get('propertyView')!=='details'||params.getAll('propertyCursor').length>1||params.has('fields'))bad('Choose a property details view.');
    const remaining=new URLSearchParams(params);remaining.delete('propertyView');remaining.delete('propertyCursor');
    const scope=explorerQuery(remaining,now);if(scope.groupBy!=='property')bad('Choose a property key for property details.');
    let cursor:PropertyReportCursor|null=null;
    if(params.has('propertyCursor')){
      const raw=params.get('propertyCursor')!;if(raw.length>4096||!/^[A-Za-z0-9_-]+$/.test(raw))bad('Reload property events before continuing.');
      try{const bytes=Buffer.from(raw,'base64url');if(bytes.toString('base64url')!==raw)bad();cursor=propertyReportCursorSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch{return bad('Reload property events before continuing.');}
    }
    return {scope,fields:null,propertyReport:{cursor}};
  }
  if(!params.has('fields'))return {scope:explorerQuery(params,now),fields:null};
  if(params.toString().length>20000||params.getAll('fields').length!==1||params.has('groupBy')||params.has('groupProperty'))bad('Choose either one field or a combination of two or three fields.');
  let raw:unknown;try{raw=JSON.parse(params.get('fields')!);}catch{return bad('Choose two or three supported fields.');}
  if(!Array.isArray(raw)||raw.length<2||raw.length>3||new Set(raw).size!==raw.length||!raw.every(field=>typeof field==='string'&&field!=='property'&&(explorerGroups as readonly string[]).includes(field)))bad('Choose two or three different supported fields.');
  const fields=raw as ExplorerTupleField[],remaining=new URLSearchParams(params);remaining.delete('fields');
  const scope=explorerQuery(remaining,now),normalized=new URLSearchParams(remaining);
  normalized.set('fields',JSON.stringify(fields));
  for(const [key,value]of Object.entries({from:scope.from,to:scope.to,timeZone:scope.timeZone,kind:scope.kind}))normalized.set(key,value);
  if(scope.predicates)normalized.set('predicates',JSON.stringify(scope.predicates));
  if(scope.property&&scope.property.type!=='missing')normalized.set('propertyValue',JSON.stringify(scope.property.value));
  if(normalized.toString().length>20000)bad('The exploration query is too large.');
  return {scope,fields};
}

const propertyStamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value.slice(0,23)+'Z');
const propertyReportCursorSchema=z.object({version:z.literal(1),scope:z.string().regex(/^[a-f0-9]{64}$/),policy:z.string().regex(/^[a-f0-9]{64}$/),before:propertyStamp,last:z.object({at:propertyStamp,id:z.uuid()}).strict()}).strict();
export type PropertyReportCursor=z.infer<typeof propertyReportCursorSchema>;

// Quoting alone does not stop spreadsheets from executing a leading formula.
export function csvCell(value: unknown): string {
  let cell = value === null || value === undefined ? 'Unavailable' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[\s\uFEFF]*[=+@-]/u.test(cell) || /^[\t\r\n]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"','""')}"`;
}
