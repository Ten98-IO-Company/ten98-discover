import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {parse} from './context-input.ts';
import {contentCursor,contentReceipt,readContentCursor,withContentProject} from './project-context.ts';
import {parseSegmentDefinition,type SegmentDefinition} from './segment-input.ts';

export type SegmentItem={id:string;projectId:string;revision:number;definition:SegmentDefinition;createdAt:string;updatedAt:string};
type Row={id:string;project_id:string;name:string;schema_version:1;query:string;revision:number;created_at:Date;updated_at:Date};
const columns='id,project_id,name,schema_version,query,revision,created_at,updated_at';
const revision=z.number().int().positive().max(2147483647);
const request=z.object({requestId:z.uuid()}).strict();
const unavailable=()=>new FoundationError(404,'Saved filter not found or unavailable.');
function dto(row:Row):SegmentItem{return {id:row.id,projectId:row.project_id,revision:row.revision,definition:{schemaVersion:row.schema_version,name:row.name,query:row.query},createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};}
async function find(client:PoolClient,projectId:string,id:string){return (await client.query<Row>(`SELECT ${columns} FROM analytics_segment WHERE project_id=$1 AND id=$2`,[projectId,id])).rows[0];}

export async function listSegments(projectId:unknown,userId:unknown,params:URLSearchParams){
  if([...params.keys()].some(key=>key!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one saved-filter list cursor.');
  return withContentProject(projectId,userId,false,async(client,project)=>{
    const scope={projectId:project.id,list:'segments'},after=readContentCursor(params.get('cursor'),scope);
    const {rows}=await client.query<Row>(`SELECT ${columns} FROM analytics_segment WHERE project_id=$1
      AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 51`,[project.id,after?.at??null,after?.id??null]);
    return {role:project.role,items:rows.slice(0,50).map(dto),nextCursor:rows.length>50?contentCursor({id:rows[49].id,createdAt:rows[49].created_at},scope):null};
  });
}
export async function getSegment(projectId:unknown,userId:unknown,segmentId:unknown){
  const id=parse(z.uuid(),segmentId);
  return withContentProject(projectId,userId,false,async(client,project)=>{
    const row=await find(client,project.id,id);if(!row)throw unavailable();return {role:project.role,item:dto(row)};
  });
}
export async function saveSegment(projectId:unknown,userId:unknown,raw:unknown,segmentId?:unknown){
  const id=segmentId===undefined?null:parse(z.uuid(),segmentId),uid=parse(z.uuid(),userId);
  const input=parse(id?request.extend({revision,definition:z.unknown()}):request.extend({definition:z.unknown()}),raw);
  const definition=parseSegmentDefinition(input.definition);
  return withContentProject(projectId,uid,true,async(client,project)=>{
    const receipt=await contentReceipt(client,project.id,input.requestId,`segment.${id?'update:'+id:'create'}`,{userId:uid,...input,definition});
    if(receipt.replayed){const row=await find(client,project.id,receipt.result.id);return {role:project.role,item:row?dto(row):null,deleted:!row,replayed:true};}
    let row:Row;
    if(id){
      const old=await find(client,project.id,id);if(!old)throw unavailable();
      if(old.revision!==('revision' in input?input.revision:null))throw new FoundationError(409,'This saved filter changed. Reload it before saving again.');
      if(old.revision===2147483647)throw new FoundationError(409,'This filter reached its revision limit. Save a new filter instead.');
      row=(await client.query<Row>(`UPDATE analytics_segment SET name=$3,schema_version=$4,query=$5,revision=revision+1,updated_at=clock_timestamp()
        WHERE project_id=$1 AND id=$2 RETURNING ${columns}`,[project.id,id,definition.name,definition.schemaVersion,definition.query])).rows[0];
    }else{
      row=(await client.query<Row>(`INSERT INTO analytics_segment(id,project_id,name,schema_version,query) VALUES($1,$2,$3,$4,$5) RETURNING ${columns}`,
        [randomUUID(),project.id,definition.name,definition.schemaVersion,definition.query])).rows[0];
    }
    await receipt.save({id:row.id});return {role:project.role,item:dto(row),deleted:false,replayed:false};
  });
}
export async function deleteSegment(projectId:unknown,userId:unknown,segmentId:unknown,raw:unknown){
  const id=parse(z.uuid(),segmentId),uid=parse(z.uuid(),userId),input=parse(request.extend({revision}),raw);
  return withContentProject(projectId,uid,true,async(client,project)=>{
    const receipt=await contentReceipt(client,project.id,input.requestId,`segment.delete:${id}`,{userId:uid,...input});
    if(receipt.replayed)return {role:project.role,id,deleted:true as const,replayed:true};
    const old=await find(client,project.id,id);if(!old)throw unavailable();
    if(old.revision!==input.revision)throw new FoundationError(409,'This saved filter changed. Reload it before deleting it.');
    await client.query('DELETE FROM analytics_segment WHERE project_id=$1 AND id=$2',[project.id,id]);
    await receipt.save({id});return {role:project.role,id,deleted:true as const,replayed:false};
  });
}
