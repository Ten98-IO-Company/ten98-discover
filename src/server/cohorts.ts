import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {parse} from './context-input.ts';
import {contentCursor,contentReceipt,readContentCursor,withContentProject} from './project-context.ts';
import {parseCohortDefinition,type CohortDefinition} from './cohort-input.ts';
import {explorerQuery} from './explorer-input.ts';
import {validateAdvancedRegex} from './advanced-predicates.ts';

export type CohortItem={id:string;projectId:string;revision:number;definition:CohortDefinition;createdAt:string;updatedAt:string};
type Row={id:string;project_id:string;name:string;schema_version:1;query:string;revision:number;created_at:Date;updated_at:Date};
const columns='id,project_id,name,schema_version,query,revision,created_at,updated_at';
const revision=z.number().int().positive().max(2147483647);
const request=z.object({requestId:z.uuid()}).strict();
const unavailable=()=>new FoundationError(404,'Cohort not found or unavailable.');
function handleError(error:unknown):never{
  if((error as {code?:string})?.code==='57014')throw new FoundationError(503,'Cohorts took too long to load or save. Retry the same request.');
  throw error;
}
function dto(row:Row):CohortItem{return {id:row.id,projectId:row.project_id,revision:row.revision,definition:{schemaVersion:row.schema_version,name:row.name,query:row.query},createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};}
async function find(client:PoolClient,projectId:string,id:string){return (await client.query<Row>(`SELECT ${columns} FROM analytics_cohort WHERE project_id=$1 AND id=$2`,[projectId,id])).rows[0];}

// Caller supplies the report's repeatable-read transaction and deadline.
export async function resolveCohort(client:PoolClient,projectId:string,userId:string,id:string,expectedRevision:number):Promise<CohortItem>{
  const row=(await client.query<Row>(`SELECT c.* FROM analytics_cohort c JOIN project p ON p.id=c.project_id
    JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE c.project_id=$1 AND c.id=$3`,[projectId,userId,id])).rows[0];
  if(!row)throw unavailable();
  if(row.revision!==expectedRevision)throw new FoundationError(409,'This cohort changed. Reload its current definition before applying it.');
  return dto(row);
}

export async function listCohorts(projectId:unknown,userId:unknown,params:URLSearchParams){
  if([...params.keys()].some(key=>key!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one cohort list cursor.');
  return withContentProject(projectId,userId,false,async(client,project)=>{
    await client.query("SET LOCAL statement_timeout='5s'");
    const scope={projectId:project.id,list:'cohorts'},after=readContentCursor(params.get('cursor'),scope);
    const {rows}=await client.query<Row>(`SELECT ${columns} FROM analytics_cohort WHERE project_id=$1
      AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 51`,[project.id,after?.at??null,after?.id??null]);
    return {role:project.role,items:rows.slice(0,50).map(dto),nextCursor:rows.length>50?contentCursor({id:rows[49].id,createdAt:rows[49].created_at},scope):null};
  }).catch(handleError);
}
export async function getCohort(projectId:unknown,userId:unknown,cohortId:unknown){
  const id=parse(z.uuid(),cohortId);
  return withContentProject(projectId,userId,false,async(client,project)=>{
    await client.query("SET LOCAL statement_timeout='5s'");
    const row=await find(client,project.id,id);if(!row)throw unavailable();return {role:project.role,item:dto(row)};
  }).catch(handleError);
}
export async function saveCohort(projectId:unknown,userId:unknown,raw:unknown,cohortId?:unknown){
  const id=cohortId===undefined?null:parse(z.uuid(),cohortId),uid=parse(z.uuid(),userId);
  const input=parse(id?request.extend({revision,definition:z.unknown()}):request.extend({definition:z.unknown()}),raw);
  const definition=parseCohortDefinition(input.definition);
  return withContentProject(projectId,uid,true,async(client,project)=>{
    await client.query("SET LOCAL statement_timeout='5s'");
    const receipt=await contentReceipt(client,project.id,input.requestId,`cohort.${id?'update:'+id:'create'}`,{userId:uid,...input,definition});
    if(receipt.replayed){const row=await find(client,project.id,receipt.result.id);return {role:project.role,item:row?dto(row):null,deleted:!row,replayed:true};}
    await validateAdvancedRegex(client,explorerQuery(new URLSearchParams(definition.query)).predicates);
    let row:Row;
    if(id){
      const old=await find(client,project.id,id);if(!old)throw unavailable();
      if(old.revision!==('revision' in input?input.revision:null))throw new FoundationError(409,'This cohort changed. Reload it before saving again.');
      if(old.revision===2147483647)throw new FoundationError(409,'This cohort reached its revision limit. Save a new cohort instead.');
      row=(await client.query<Row>(`UPDATE analytics_cohort SET name=$3,schema_version=$4,query=$5,revision=revision+1,updated_at=clock_timestamp()
        WHERE project_id=$1 AND id=$2 RETURNING ${columns}`,[project.id,id,definition.name,definition.schemaVersion,definition.query])).rows[0];
    }else{
      row=(await client.query<Row>(`INSERT INTO analytics_cohort(id,project_id,name,schema_version,query) VALUES($1,$2,$3,$4,$5) RETURNING ${columns}`,
        [randomUUID(),project.id,definition.name,definition.schemaVersion,definition.query])).rows[0];
    }
    await receipt.save({id:row.id});return {role:project.role,item:dto(row),deleted:false,replayed:false};
  }).catch(handleError);
}
export async function deleteCohort(projectId:unknown,userId:unknown,cohortId:unknown,raw:unknown){
  const id=parse(z.uuid(),cohortId),uid=parse(z.uuid(),userId),input=parse(request.extend({revision}),raw);
  return withContentProject(projectId,uid,true,async(client,project)=>{
    await client.query("SET LOCAL statement_timeout='5s'");
    const receipt=await contentReceipt(client,project.id,input.requestId,`cohort.delete:${id}`,{userId:uid,...input});
    if(receipt.replayed)return {role:project.role,id,deleted:true as const,replayed:true};
    const old=await find(client,project.id,id);if(!old)throw unavailable();
    if(old.revision!==input.revision)throw new FoundationError(409,'This cohort changed. Reload it before deleting it.');
    await client.query('DELETE FROM analytics_cohort WHERE project_id=$1 AND id=$2',[project.id,id]);
    await receipt.save({id});return {role:project.role,id,deleted:true as const,replayed:false};
  }).catch(handleError);
}
