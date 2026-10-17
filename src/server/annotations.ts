import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {parse} from './context-input.ts';
import {contentCursor,contentReceipt,readContentCursor,withContentProject} from './project-context.ts';
import {analyticsCalendarSql} from './analytics-scope.ts';
import {annotationQuery,parseAnnotationDefinition,type AnnotationDefinition} from './annotation-input.ts';

export type AnnotationItem={id:string;projectId:string;revision:number;definition:AnnotationDefinition;createdAt:string;updatedAt:string};
type Row={id:string;project_id:string;date:Date;all_day:boolean;note:string;revision:number;created_at:Date;updated_at:Date};
const columns='id,project_id,date,all_day,note,revision,created_at,updated_at';
const revision=z.number().int().positive().max(2147483647),request=z.object({requestId:z.uuid()}).strict();
const unavailable=()=>new FoundationError(404,'Annotation not found or unavailable.');
function dto(row:Row):AnnotationItem{return {id:row.id,projectId:row.project_id,revision:row.revision,definition:{date:row.date.toISOString(),allDay:row.all_day,note:row.note},createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};}
async function find(client:PoolClient,projectId:string,id:string){return (await client.query<Row>(`SELECT ${columns} FROM analytics_annotation WHERE project_id=$1 AND id=$2`,[projectId,id])).rows[0];}
// Admission already has the pool's10s statement bound; scoped note queries use5s.
async function prepare(client:PoolClient,timeZone?:string){
  await client.query("SET LOCAL statement_timeout='5s'");
  if(timeZone&&!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[timeZone])).rowCount)throw new FoundationError(400,'Choose a timezone supported by this installation.');
}
function handleError(error:unknown):never{
  if((error as {code?:string})?.code==='57014')throw new FoundationError(503,'Annotations took too long to load or save. Retry the same request.');
  throw error;
}
const calendarPrefix=`WITH RECURSIVE target AS (SELECT $1::text AS id,$2::text AS actor), ${analyticsCalendarSql}`;
const population=`selected AS MATERIALIZED (SELECT a.* FROM analytics_annotation a CROSS JOIN target t CROSS JOIN bounds b
  WHERE a.project_id=t.id AND ($3::date IS NULL OR (a.date>=b.start AND a.date<b.finish AND (a.date AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date)))`;

export async function listAnnotations(projectId:unknown,userId:unknown,params:URLSearchParams,apiToken?:string){
  const input=annotationQuery(params);
  return withContentProject(projectId,userId,false,async(client,p)=>{
    await prepare(client,input.range?.timeZone);const scope={projectId:p.id,list:'annotations',range:input.range,search:input.search},after=readContentCursor(input.cursor,scope);
    const {rows}=await client.query<Row>(`${calendarPrefix}, ${population} SELECT ${columns} FROM selected
      WHERE ($6::text IS NULL OR strpos(lower(note),lower($6))>0) AND ($7::timestamptz IS NULL OR (date,id)<($7::timestamptz,$8::uuid))
      ORDER BY date DESC,id DESC LIMIT 51`,[p.id,userId,input.range?.from??null,input.range?.to??null,input.range?.timeZone??'UTC',input.search,after?.at??null,after?.id??null]);
    return {role:p.role,items:rows.slice(0,50).map(dto),nextCursor:rows.length>50?contentCursor({id:rows[49].id,createdAt:rows[49].date},scope):null};
  },apiToken,false,'annotations:read').catch(handleError);
}
export async function annotationTimeline(projectId:unknown,userId:unknown,params:URLSearchParams,apiToken?:string){
  const {range}=annotationQuery(params,true);
  return withContentProject(projectId,userId,false,async(client,p)=>{
    await prepare(client,range!.timeZone);
    const {rows}=await client.query<{day:string;count:string;previews:Row[]}>(`${calendarPrefix}, ${population}, ranked AS (
      SELECT *,to_char(date AT TIME ZONE $5,'YYYY-MM-DD') AS day,row_number() OVER(PARTITION BY (date AT TIME ZONE $5)::date ORDER BY date DESC,id DESC) AS n FROM selected)
      SELECT day,count(*)::text AS count,json_agg(r ORDER BY date DESC,id DESC) FILTER(WHERE n<=3) AS previews FROM ranked r GROUP BY day ORDER BY day`,[p.id,userId,range!.from,range!.to,range!.timeZone]);
    const days=rows.map(r=>{const count=Number(r.count);if(!Number.isSafeInteger(count))throw new FoundationError(413,'Too many annotations for this timeline.');return {date:r.day,count,previews:r.previews.map(v=>dto({...v,date:new Date(v.date),created_at:new Date(v.created_at),updated_at:new Date(v.updated_at)}))};});
    const totalCount=days.reduce((n,d)=>n+d.count,0);if(!Number.isSafeInteger(totalCount))throw new FoundationError(413,'Too many annotations for this timeline.');
    return {role:p.role,range:range!,days,totalCount};
  },apiToken,false,'annotations:read').catch(handleError);
}
export async function getAnnotation(projectId:unknown,userId:unknown,annotationId:unknown,apiToken?:string){
  const id=parse(z.uuid(),annotationId);
  return withContentProject(projectId,userId,false,async(client,p)=>{await prepare(client);const row=await find(client,p.id,id);if(!row)throw unavailable();return {role:p.role,item:dto(row)};},apiToken,false,'annotations:read').catch(handleError);
}
export async function saveAnnotation(projectId:unknown,userId:unknown,raw:unknown,annotationId?:unknown){
  const id=annotationId===undefined?null:parse(z.uuid(),annotationId),uid=parse(z.uuid(),userId);
  const input=parse(id?request.extend({revision,definition:z.unknown()}):request.extend({definition:z.unknown()}),raw),definition=parseAnnotationDefinition(input.definition);
  return withContentProject(projectId,uid,true,async(client,p)=>{
    await prepare(client);
    const receipt=await contentReceipt(client,p.id,input.requestId,`annotation.${id?'update:'+id:'create'}`,{userId:uid,...input,definition});
    if(receipt.replayed){const row=await find(client,p.id,receipt.result.id);return {role:p.role,item:row?dto(row):null,deleted:!row,replayed:true};}
    let date:string;
    if('date'in definition)date=definition.date;
    else{
      await prepare(client,definition.timeZone);
      const day=(await client.query<{start:Date;finish:Date;day:string}>(`${calendarPrefix} SELECT start,finish,to_char(start AT TIME ZONE $5,'YYYY-MM-DD') AS day FROM calendar WHERE finish IS NOT NULL`,[p.id,uid,definition.day,definition.day,definition.timeZone])).rows[0];
      if(!day||day.start>=day.finish||day.day!==definition.day)throw new FoundationError(400,'This calendar date did not occur in the selected timezone.');
      date=day.start.toISOString();
      if(day.start.getUTCFullYear()<1970||day.start.getUTCFullYear()>9998)throw new FoundationError(400,'The annotation instant must be within1970–9998.');
    }
    let row:Row;
    if(id){
      const old=await find(client,p.id,id);if(!old)throw unavailable();
      if(old.revision!==('revision'in input?input.revision:null))throw new FoundationError(409,'This annotation changed. Reload it before saving again.');
      if(old.revision===2147483647)throw new FoundationError(409,'This annotation reached its revision limit. Create a new note instead.');
      row=(await client.query<Row>(`UPDATE analytics_annotation SET date=$3,all_day=$4,note=$5,revision=revision+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2 RETURNING ${columns}`,[p.id,id,date,definition.allDay,definition.note])).rows[0];
    }else row=(await client.query<Row>(`INSERT INTO analytics_annotation(id,project_id,user_id,date,all_day,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`,[randomUUID(),p.id,uid,date,definition.allDay,definition.note])).rows[0];
    await receipt.save({id:row.id});return {role:p.role,item:dto(row),deleted:false,replayed:false};
  }).catch(handleError);
}
export async function deleteAnnotation(projectId:unknown,userId:unknown,annotationId:unknown,raw:unknown){
  const id=parse(z.uuid(),annotationId),uid=parse(z.uuid(),userId),input=parse(request.extend({revision}),raw);
  return withContentProject(projectId,uid,true,async(client,p)=>{
    await prepare(client);const receipt=await contentReceipt(client,p.id,input.requestId,`annotation.delete:${id}`,{userId:uid,...input});
    if(receipt.replayed)return {role:p.role,id,deleted:true as const,replayed:true};
    const old=await find(client,p.id,id);if(!old)throw unavailable();
    if(old.revision!==input.revision)throw new FoundationError(409,'This annotation changed. Reload it before deleting it.');
    await client.query('DELETE FROM analytics_annotation WHERE project_id=$1 AND id=$2',[p.id,id]);await receipt.save({id});return {role:p.role,id,deleted:true as const,replayed:false};
  }).catch(handleError);
}
