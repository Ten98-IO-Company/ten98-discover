import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {parse,text} from './context-input.ts';
import {explorerQuery} from './explorer-input.ts';

export type AnnotationDefinition={date:string;allDay:boolean;note:string};
export type AnnotationDayDefinition={day:string;timeZone:string;allDay:true;note:string};
const bad=()=>new FoundationError(400,'Check the annotation date, timezone and note.');
const timestamp=z.iso.datetime({offset:true}).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
export {timestamp as boundedTimestampInput};
const note=text(500,1).refine(value=>value.length<=500);
const definition=z.union([
  z.object({date:timestamp,allDay:z.boolean(),note}).strict(),
  z.object({day:z.string(),timeZone:z.string(),allDay:z.literal(true),note}).strict(),
]);
export function parseAnnotationDefinition(raw:unknown):AnnotationDefinition|AnnotationDayDefinition{
  const input=parse(definition,raw);
  if('date'in input){
    const date=new Date(input.date),year=date.getUTCFullYear();
    if(input.date.endsWith('-00:00')||!Number.isFinite(date.getTime())||year<1970||year>9998)throw bad();
    return {...input,date:date.toISOString()};
  }
  const range=explorerQuery(new URLSearchParams({from:input.day,to:input.day,timeZone:input.timeZone}));
  return {...input,timeZone:range.timeZone};
}
export function annotationQuery(params:URLSearchParams,timeline=false){
  const allowed=timeline?['from','to','timeZone']:['from','to','timeZone','search','cursor'];
  if(params.toString().length>4096)throw bad();
  for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)throw bad();
  const hasRange=params.has('from')||params.has('to');
  if((timeline&&!hasRange)||(hasRange&&(!params.has('from')||!params.has('to')))||(!hasRange&&params.has('timeZone')))throw bad();
  const range=hasRange?explorerQuery(new URLSearchParams([...params].filter(([key])=>['from','to','timeZone'].includes(key)))):null;
  return {range:range?{from:range.from,to:range.to,timeZone:range.timeZone}:null,
    search:params.has('search')?parse(text(200,1).refine(v=>v.length<=200),params.get('search')):null,cursor:params.get('cursor')};
}
