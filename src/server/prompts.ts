import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {classificationTerms,classifyPrompt,parse,promptAction,promptBatch,promptPatch,text} from './context-input.ts';
import {contentCursor,contentProfile,contentReceipt,readContentCursor,withContentProject,type ContentProject} from './project-context.ts';

type PromptRow={id:string;revision:number;current_version_id:string;topic:string;enabled:boolean;user_tags:string[];archived_at:Date|null;created_at:Date;updated_at:Date;text:string};
type Profile={name:string;aliases:string[]};
const columns='p.id,p.revision,p.current_version_id,p.topic,p.enabled,p.user_tags,p.archived_at,p.created_at,p.updated_at,v.text';
const joined='project_prompt p JOIN prompt_text_version v ON v.id=p.current_version_id AND v.project_id=p.project_id AND v.prompt_id=p.id';
function dto(row:PromptRow,project:ContentProject,profile:Profile) {
  const classification=classifyPrompt(row.text,profile.name,project.origin,profile.aliases,row.user_tags);
  return {id:row.id,revision:row.revision,currentVersionId:row.current_version_id,text:row.text,topic:row.topic,enabled:row.enabled,archivedAt:row.archived_at,
    userTags:row.user_tags,systemTags:[classification.systemIsBranded?'branded':'unbranded'],classification,createdAt:row.created_at,updatedAt:row.updated_at};
}
async function promptRow(client:PoolClient,projectId:string,id:string) {
  const result=await client.query<PromptRow>(`SELECT ${columns} FROM ${joined} WHERE p.project_id=$1 AND p.id=$2`,[projectId,id]);
  if(!result.rowCount) throw new FoundationError(404,'Prompt not found or unavailable.');
  return result.rows[0];
}
async function assertUniqueText(client:PoolClient,projectId:string,value:string,exceptId:string|null=null) {
  const found=await client.query(`SELECT p.id FROM ${joined} WHERE p.project_id=$1 AND v.text=$2 AND p.archived_at IS NULL AND ($3::uuid IS NULL OR p.id<>$3) LIMIT 1`,[projectId,value,exceptId]);
  if(found.rowCount) throw new FoundationError(409,'An active prompt already has this exact text. Edit the existing prompt or change the text.');
}
function filters(params:URLSearchParams) {
  const allowed=['status','q','tag','classification','cursor'];
  for(const key of params.keys()) if(!allowed.includes(key)||params.getAll(key).length!==1) throw new FoundationError(400,'Use each supported prompt filter once.');
  return {status:parse(z.enum(['active','archived','all']),params.get('status')??'active'),q:parse(text(200),params.get('q')??''),tag:parse(text(80),params.get('tag')??'').toLowerCase(),
    classification:parse(z.enum(['branded','unbranded','']),params.get('classification')??'')};
}
export async function listPrompts(projectId:unknown,userId:unknown,params:URLSearchParams) {
  const input=filters(params);
  return withContentProject(projectId,userId,false,async(client,project)=>{
    const profile=await contentProfile(client,project),scope={projectId:project.id,list:'prompts',...input},cursor=readContentCursor(params.get('cursor'),scope);
    const terms=classificationTerms(profile.name,project.origin,profile.aliases);
    const {rows}=await client.query<PromptRow>(`WITH matches AS (
      SELECT ${columns},CASE
        WHEN (p.user_tags ? 'branded') <> (p.user_tags ? 'unbranded') THEN p.user_tags ? 'branded'
        ELSE EXISTS(SELECT 1 FROM unnest($8::text[]) term WHERE strpos(v.lower_text,term)>0) END AS branded
      FROM ${joined} WHERE p.project_id=$1 AND ($2='all' OR ($2='active' AND p.archived_at IS NULL) OR ($2='archived' AND p.archived_at IS NOT NULL))
      AND ($3='' OR strpos(v.lower_text,$3)>0) AND ($4='' OR p.user_tags ? $4)
      AND ($5::timestamptz IS NULL OR (p.created_at,p.id)<($5::timestamptz,$6::uuid)))
      SELECT * FROM matches WHERE ($7='' OR branded=($7='branded')) ORDER BY created_at DESC,id DESC LIMIT 51`,
      [project.id,input.status,input.q.toLowerCase(),input.tag,cursor?.at??null,cursor?.id??null,input.classification,terms]);
    const items=rows.slice(0,50).map(row=>dto(row,project,profile));
    return {role:project.role,items,nextCursor:rows.length>50?contentCursor({id:rows[49].id,createdAt:rows[49].created_at},scope):null,execution:{available:false,nextRunAt:null}};
  });
}
export async function getPrompt(projectId:unknown,userId:unknown,promptId:unknown) {
  const id=parse(z.uuid(),promptId);
  return withContentProject(projectId,userId,false,async(client,project)=>({prompt:dto(await promptRow(client,project.id,id),project,await contentProfile(client,project))}));
}
export async function createPrompts(projectId:unknown,userId:unknown,raw:unknown) {
  const input=parse(promptBatch,raw),uid=parse(z.uuid(),userId);
  if(new Set(input.prompts.map(row=>row.text)).size!==input.prompts.length) throw new FoundationError(400,'The batch repeats exact prompt text. Remove duplicate lines before saving.');
  return withContentProject(projectId,uid,true,async(client,project)=>{
    const receipt=await contentReceipt(client,project.id,input.requestId,'prompts.bulk',input),profile=await contentProfile(client,project);
    if(receipt.replayed) {
      const items=[];for(const id of receipt.result.ids as string[]) items.push(dto(await promptRow(client,project.id,id),project,profile));
      return {items,replayed:true};
    }
    const ids:string[]=[];
    for(const entry of input.prompts) {
      await assertUniqueText(client,project.id,entry.text);
      const id=randomUUID(),versionId=randomUUID();
      await client.query(`INSERT INTO project_prompt(id,project_id,current_version_id,topic,enabled,user_tags) VALUES($1,$2,$3,$4,$5,$6)`,[id,project.id,versionId,entry.topic??'General',entry.enabled??false,JSON.stringify(entry.tags??[])]);
      await client.query('INSERT INTO prompt_text_version(id,project_id,prompt_id,number,text,lower_text,created_by) VALUES($1,$2,$3,1,$4,$5,$6)',[versionId,project.id,id,entry.text,entry.text.toLowerCase(),uid]);ids.push(id);
    }
    await receipt.save({ids});
    const items=[];for(const id of ids) items.push(dto(await promptRow(client,project.id,id),project,profile));
    return {items,replayed:false};
  });
}
export async function updatePrompt(projectId:unknown,userId:unknown,promptId:unknown,raw:unknown) {
  const input=parse(promptPatch,raw),uid=parse(z.uuid(),userId),id=parse(z.uuid(),promptId);
  return withContentProject(projectId,uid,true,async(client,project)=>{
    const receipt=await contentReceipt(client,project.id,input.requestId,`prompt.update:${id}`,input),profile=await contentProfile(client,project);
    let row=await promptRow(client,project.id,id);
    if(receipt.replayed) return {prompt:dto(row,project,profile),replayed:true};
    if(row.revision!==input.revision) throw new FoundationError(409,'The prompt changed. Review the latest version before saving again.');
    if(row.archived_at) throw new FoundationError(409,'Restore this prompt before editing it.');
    let versionId=row.current_version_id;
    if(input.text!==undefined&&input.text!==row.text) {
      await assertUniqueText(client,project.id,input.text,id);versionId=randomUUID();
      await client.query(`INSERT INTO prompt_text_version(id,project_id,prompt_id,number,text,lower_text,created_by)
        SELECT $1,$2,$3,COALESCE(MAX(number),0)+1,$4,$5,$6 FROM prompt_text_version WHERE project_id=$2 AND prompt_id=$3`,[versionId,project.id,id,input.text,input.text.toLowerCase(),uid]);
    }
    await client.query(`UPDATE project_prompt SET current_version_id=$3,topic=COALESCE($4,topic),enabled=COALESCE($5,enabled),user_tags=COALESCE($6,user_tags),revision=revision+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2`,
      [project.id,id,versionId,input.topic??null,input.enabled??null,input.tags===undefined?null:JSON.stringify(input.tags)]);
    await receipt.save({id});row=await promptRow(client,project.id,id);return {prompt:dto(row,project,profile),replayed:false};
  });
}
export async function setPromptArchived(projectId:unknown,userId:unknown,promptId:unknown,archive:boolean,raw:unknown) {
  const input=parse(promptAction,raw),uid=parse(z.uuid(),userId),id=parse(z.uuid(),promptId);
  return withContentProject(projectId,uid,true,async(client,project)=>{
    const receipt=await contentReceipt(client,project.id,input.requestId,`prompt.${archive?'archive':'restore'}:${id}`,input),profile=await contentProfile(client,project);
    let row=await promptRow(client,project.id,id);
    if(receipt.replayed) return {prompt:dto(row,project,profile),replayed:true};
    if(row.revision!==input.revision) throw new FoundationError(409,'The prompt changed. Reload before changing its archive status.');
    if(!archive) await assertUniqueText(client,project.id,row.text,id);
    await client.query(`UPDATE project_prompt SET archived_at=${archive?'COALESCE(archived_at,clock_timestamp())':'NULL'},revision=revision+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2`,[project.id,id]);
    await receipt.save({id});row=await promptRow(client,project.id,id);return {prompt:dto(row,project,profile),replayed:false};
  });
}
export async function promptVersions(projectId:unknown,userId:unknown,promptId:unknown,params:URLSearchParams) {
  const id=parse(z.uuid(),promptId);
  if([...params.keys()].some(key=>key!=='cursor')||params.getAll('cursor').length>1) throw new FoundationError(400,'Use one version page cursor.');
  return withContentProject(projectId,userId,false,async(client,project)=>{
    await promptRow(client,project.id,id);
    const scope={projectId:project.id,list:'versions',promptId:id},cursor=readContentCursor(params.get('cursor'),scope);
    let beforeNumber:number|null=null;
    if(cursor) {
      const before=await client.query<{number:number}>('SELECT number FROM prompt_text_version WHERE project_id=$1 AND prompt_id=$2 AND id=$3',[project.id,id,cursor.id]);
      if(!before.rowCount) throw new FoundationError(400,'The version cursor no longer matches this prompt.');
      beforeNumber=before.rows[0].number;
    }
    const {rows}=await client.query(`SELECT id,number,text,created_at AS "createdAt",created_by AS "createdBy" FROM prompt_text_version
      WHERE project_id=$1 AND prompt_id=$2 AND ($3::integer IS NULL OR number<$3) ORDER BY number DESC LIMIT 51`,[project.id,id,beforeNumber]);
    return {versions:rows.slice(0,50),nextCursor:rows.length>50?contentCursor(rows[49],scope):null};
  });
}
