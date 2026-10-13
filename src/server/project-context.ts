import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {canonicalHash,contextPatch,parse,sectionKeys} from './context-input.ts';

export type ContentProject={id:string;name:string;origin:string;role:'owner'|'admin'|'editor'|'viewer'};
export async function withContentProject<T>(projectId:unknown,userId:unknown,write:boolean,work:(client:PoolClient,project:ContentProject)=>Promise<T>):Promise<T> {
  const pid=parse(z.uuid(),projectId),uid=parse(z.uuid(),userId),client=await getDatabase().pool.connect();
  try {
    await client.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if(write) {
      await client.query('SELECT w.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.id=$1 FOR UPDATE OF w',[pid]);
    }
    const found=await client.query<ContentProject>(`SELECT p.id,p.name,p.origin,m.role FROM project p JOIN membership m ON m.workspace_id=p.workspace_id
      WHERE p.id=$1 AND m.user_id=$2 ${write?'FOR UPDATE OF p':''}`,[pid,uid]);
    const project=found.rows[0];
    if(!project||(write&&!['owner','admin','editor'].includes(project.role))) throw new FoundationError(404,'Project not found or unavailable.');
    const result=await work(client,project);await client.query('COMMIT');return result;
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;} finally {client.release();}
}

// Receipts contain only result identifiers, not copies of authored text or credentials.
// Retained with the project so a late retry cannot silently become a new write.
export async function contentReceipt(client:PoolClient,projectId:string,requestId:string,operation:string,input:unknown) {
  const hash=canonicalHash(input);
  const prior=await client.query('SELECT operation,input_hash,result FROM project_content_request WHERE project_id=$1 AND request_id=$2',[projectId,requestId]);
  if(prior.rowCount&&(prior.rows[0].operation!==operation||prior.rows[0].input_hash!==hash)) throw new FoundationError(409,'This request ID was already used for different changes. Start a new save.');
  return {replayed:!!prior.rowCount,result:prior.rows[0]?.result,
    save:async(result:unknown)=>{await client.query('INSERT INTO project_content_request(project_id,request_id,operation,input_hash,result) VALUES($1,$2,$3,$4,$5)',[projectId,requestId,operation,hash,JSON.stringify(result)]);}};
}

const pageInput=z.object({scope:z.string().regex(/^[a-f0-9]{64}$/),at:z.iso.datetime(),id:z.uuid()}).strict();
export function readContentCursor(value:string|null,scope:unknown) {
  if(!value) return null;
  if(value.length>512||!/^[A-Za-z0-9_-]+$/.test(value)) throw new FoundationError(400,'Reload this list before loading another page.');
  let decoded:unknown;try {decoded=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));} catch {throw new FoundationError(400,'Reload this list before loading another page.');}
  const cursor=parse(pageInput,decoded);
  if(cursor.scope!==canonicalHash(scope)) throw new FoundationError(400,'This page belongs to different filters. Reload the list.');
  return cursor;
}
export function contentCursor(row:{id:string;createdAt:Date|string}|undefined,scope:unknown) {
  return row?Buffer.from(JSON.stringify({scope:canonicalHash(scope),at:new Date(row.createdAt).toISOString(),id:row.id})).toString('base64url'):null;
}
function onlyCursor(params:URLSearchParams) {
  if([...params.keys()].some(key=>key!=='cursor')||params.getAll('cursor').length>1) throw new FoundationError(400,'Use one page cursor.');
  return params.get('cursor');
}
export async function contentProfile(client:PoolClient,project:ContentProject) {
  const result=await client.query('SELECT revision,brand_name AS name,brand_aliases AS aliases FROM project_context WHERE project_id=$1',[project.id]);
  return result.rows[0]??{revision:1,name:project.name,aliases:[]};
}
async function researchPage(client:PoolClient,projectId:string,cursorValue:string|null=null) {
  const scope={projectId,list:'research'},cursor=readContentCursor(cursorValue,scope);
  const {rows}=await client.query(`SELECT id,entry_date::text AS "entryDate",summary,created_at AS "createdAt",created_by AS "createdBy"
    FROM context_research WHERE project_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
    ORDER BY created_at DESC,id DESC LIMIT 21`,[projectId,cursor?.at??null,cursor?.id??null]);
  return {entries:rows.slice(0,20),nextCursor:rows.length>20?contentCursor(rows[19],scope):null};
}
export async function getContextResearch(projectId:unknown,userId:unknown,params:URLSearchParams) {
  const cursor=onlyCursor(params);return withContentProject(projectId,userId,false,(client,p)=>researchPage(client,p.id,cursor));
}
async function contextDto(client:PoolClient,project:ContentProject) {
  const profile=await contentProfile(client,project);
  const sections=(await client.query(`SELECT key,title,content,updated_at AS "updatedAt",updated_by AS "updatedBy" FROM context_section WHERE project_id=$1 ORDER BY key`,[project.id])).rows;
  const competitors=(await client.query(`SELECT id,primary_domain AS "primaryDomain",domains,name,aliases,notes,updated_at AS "updatedAt",updated_by AS "updatedBy"
    FROM context_competitor WHERE project_id=$1 ORDER BY primary_domain`,[project.id])).rows;
  const keyPages=(await client.query(`SELECT id,url,role,topic,notes,updated_at AS "updatedAt",updated_by AS "updatedBy" FROM context_key_page WHERE project_id=$1 ORDER BY url`,[project.id])).rows;
  const research=await researchPage(client,project.id);
  const templates=(await client.query(`SELECT id,name,left(brief,200) AS preview,length(brief)>200 AS truncated FROM report_template WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 21`,[project.id])).rows;
  return {project:{id:project.id,name:project.name,origin:project.origin},role:project.role,revision:profile.revision,profile:{name:profile.name,aliases:profile.aliases},
    sections:sectionKeys.flatMap(key=>sections.filter(row=>row.key===key)),missingSections:sectionKeys.filter(key=>!sections.some(row=>row.key===key)),
    customSections:sections.filter(row=>row.key.startsWith('custom:')),competitors,keyPages,researchLog:research.entries,researchLogNextCursor:research.nextCursor,
    reportTemplates:templates.slice(0,20),reportTemplatesTruncated:templates.length>20};
}
export async function getProjectContext(projectId:unknown,userId:unknown) {return withContentProject(projectId,userId,false,contextDto);}

export async function updateProjectContext(projectId:unknown,userId:unknown,raw:unknown) {
  const input=parse(contextPatch,raw),uid=parse(z.uuid(),userId);
  return withContentProject(projectId,uid,true,async(client,project)=>{
    const receipt=await contentReceipt(client,project.id,input.requestId,'context.update',input);
    if(receipt.replayed) return contextDto(client,project);
    await client.query('INSERT INTO project_context(project_id,brand_name) VALUES($1,$2) ON CONFLICT(project_id) DO NOTHING',[project.id,project.name]);
    const profile=await contentProfile(client,project);
    if(profile.revision!==input.revision) throw new FoundationError(409,'Project context changed. Review the latest saved data before saving again.');
    for(const op of input.updates) {
      switch(op.kind) {
        case 'profile':
          if(op.name===undefined&&op.aliases===undefined) throw new FoundationError(400,'Choose a brand field to update.');
          await client.query('UPDATE project_context SET brand_name=COALESCE($2,brand_name),brand_aliases=COALESCE($3,brand_aliases) WHERE project_id=$1',[project.id,op.name??null,op.aliases===undefined?null:JSON.stringify(op.aliases)]);break;
        case 'section':
          if(!op.content) {await client.query('DELETE FROM context_section WHERE project_id=$1 AND key=$2',[project.id,op.key]);break;}
          if(!op.key.startsWith('custom:')&&op.title!==undefined) throw new FoundationError(400,'Standard section titles cannot be changed.');
          await client.query(`INSERT INTO context_section(project_id,key,title,content,updated_by) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(project_id,key) DO UPDATE SET title=COALESCE(excluded.title,context_section.title),content=excluded.content,updated_by=excluded.updated_by,updated_at=clock_timestamp()`,[project.id,op.key,op.title??null,op.content,uid]);
          if((await client.query("SELECT count(*)::int AS count FROM context_section WHERE project_id=$1 AND key LIKE 'custom:%'",[project.id])).rows[0].count>20) throw new FoundationError(400,'A project can hold at most 20 custom sections.');break;
        case 'remove-section':await client.query('DELETE FROM context_section WHERE project_id=$1 AND key=$2',[project.id,op.key]);break;
        case 'competitor': {
          const old=(await client.query('SELECT * FROM context_competitor WHERE project_id=$1 AND primary_domain=$2',[project.id,op.primaryDomain])).rows[0];
          const domains=op.domains===undefined?(old?.domains??[op.primaryDomain]):[...new Set([op.primaryDomain,...op.domains])];
          if(domains.length>20) throw new FoundationError(400,'A competitor can have at most 20 domains including its primary domain.');
          const conflict=await client.query('SELECT id FROM context_competitor WHERE project_id=$1 AND primary_domain<>$2 AND domains ?| $3::text[] LIMIT 1',[project.id,op.primaryDomain,domains]);
          if(conflict.rowCount) throw new FoundationError(409,'A hostname already belongs to another competitor in this project.');
          await client.query(`INSERT INTO context_competitor(id,project_id,primary_domain,domains,name,aliases,notes,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT(project_id,primary_domain) DO UPDATE SET domains=excluded.domains,name=excluded.name,aliases=excluded.aliases,notes=excluded.notes,updated_by=excluded.updated_by,updated_at=clock_timestamp()`,
            [old?.id??randomUUID(),project.id,op.primaryDomain,JSON.stringify(domains),op.name??old?.name??null,JSON.stringify(op.aliases??old?.aliases??[]),op.notes??old?.notes??null,uid]);
          if((await client.query('SELECT count(*)::int AS count FROM context_competitor WHERE project_id=$1',[project.id])).rows[0].count>100) throw new FoundationError(400,'A project can hold at most 100 competitors.');break;
        }
        case 'remove-competitor':await client.query('DELETE FROM context_competitor WHERE project_id=$1 AND id=$2',[project.id,op.id]);break;
        case 'key-page':
          await client.query(`INSERT INTO context_key_page(id,project_id,url,role,topic,notes,updated_by) VALUES($1,$2,$3,COALESCE($4,'other'),$5,$6,$7)
            ON CONFLICT(project_id,url) DO UPDATE SET role=COALESCE($4,context_key_page.role),topic=COALESCE($5,context_key_page.topic),notes=COALESCE($6,context_key_page.notes),updated_by=$7,updated_at=clock_timestamp()`,
            [randomUUID(),project.id,op.url,op.role??null,op.topic??null,op.notes??null,uid]);
          if((await client.query('SELECT count(*)::int AS count FROM context_key_page WHERE project_id=$1',[project.id])).rows[0].count>100) throw new FoundationError(400,'A project can hold at most 100 key pages.');break;
        case 'remove-key-page':await client.query('DELETE FROM context_key_page WHERE project_id=$1 AND id=$2',[project.id,op.id]);break;
        case 'research':await client.query('INSERT INTO context_research(id,project_id,summary,created_by) VALUES($1,$2,$3,$4)',[randomUUID(),project.id,op.summary,uid]);break;
        case 'remove-research':await client.query('DELETE FROM context_research WHERE project_id=$1 AND id=$2',[project.id,op.id]);break;
      }
    }
    await client.query('UPDATE project_context SET revision=revision+1 WHERE project_id=$1',[project.id]);
    await receipt.save({});return contextDto(client,project);
  });
}
