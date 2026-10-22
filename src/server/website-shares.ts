import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {parse} from './context-input.ts';
import {contentCursor,contentReceipt,readContentCursor} from './project-context.ts';
import {projectAnalytics} from './analytics.ts';
import {websiteShareCreate,websiteShareRevoke,websiteShareRead,websiteShareLimits,projectWebsiteShare,type WebsiteShareItem,type WebsiteShareSection,type WebsiteShareWrite} from '../lib/website-shares.ts';

// Website public share grants (P45; P02 under D6), https://github.com/Ten98-IO-Company/ten98-discover/wiki/Website-Shares. Owner/admin cookie management plus one capability read.
const missing=()=>new FoundationError(404,'Website share not found or unavailable.');
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
export const canonicalShareToken=(token:unknown):token is string=>typeof token==='string'&&/^[A-Za-z0-9_-]{43}$(?![\s\S])/.test(token)&&Buffer.from(token,'base64url').toString('base64url')===token;
type Role='owner'|'admin';
type Row={id:string;label:string;sections:WebsiteShareSection[];created_at:Date;expires_at:Date;revoked_at:Date|null;state:WebsiteShareItem['state'];creator_name:string|null;creator_email:string|null;creator_member:boolean|null};
// Creator identity is shown to current owners/admins only (D6); a removed creator keeps the row but loses management.
// A closed creator shows as the "Closed account" tombstone name with no address (https://github.com/Ten98-IO-Company/ten98-discover/wiki/Account-Closure).
const itemSql=`SELECT s.id,s.label,s.sections,s.created_at,s.expires_at,s.revoked_at,
 CASE WHEN s.revoked_at IS NOT NULL THEN 'revoked' WHEN s.expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END AS state,
 u.name AS creator_name,CASE WHEN u.closed_at IS NULL THEN u.email END AS creator_email,CASE WHEN u.id IS NULL THEN NULL ELSE m.user_id IS NOT NULL END AS creator_member
 FROM project_share s JOIN project p ON p.id=s.project_id LEFT JOIN "user" u ON u.id=s.created_by LEFT JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=s.created_by`;
function item(row:Row):WebsiteShareItem{
 return{id:row.id,label:row.label,sections:row.sections,createdAt:row.created_at.toISOString(),expiresAt:row.expires_at.toISOString(),revokedAt:row.revoked_at?.toISOString()??null,state:row.state,
  creator:row.creator_name===null?null:{name:row.creator_name,email:row.creator_email??'',member:row.creator_member===true}};
}
async function manage<T>(projectId:unknown,userId:unknown,work:(client:PoolClient,projectId:string,role:Role,userId:string)=>Promise<T>):Promise<T>{
 const pid=z.uuid().safeParse(projectId),uid=z.uuid().safeParse(userId);if(!pid.success||!uid.success)throw missing();
 const project=pid.data.toLowerCase(),client=await getDatabase().pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");
  const target=(await client.query<{workspace_id:string}>('SELECT workspace_id FROM project WHERE id=$1',[project])).rows[0];if(!target)throw missing();
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[target.workspace_id]);
  if(!(await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR SHARE',[project,target.workspace_id])).rowCount)throw missing();
  // Authority is fresh after every possible gate wait, including receipt replay. Editors, viewers and removed members find no row.
  const role=(await client.query<{role:Role}>("SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role IN('owner','admin')",[target.workspace_id,uid.data])).rows[0]?.role;if(!role)throw missing();
  const result=await work(client,project,role,uid.data);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03','25P04'].includes((error as {code?:string})?.code??''))throw new FoundationError(503,'Website sharing is busy. Retry the same request.');throw error;}
 finally{client.release();}
}
async function writeResult(client:PoolClient,projectId:string,ack:WebsiteShareWrite['ack'],replayed:boolean):Promise<WebsiteShareWrite>{
 const row=(await client.query<Row>(itemSql+' WHERE s.project_id=$1 AND s.id=$2',[projectId,ack.shareId])).rows[0];
 return{projectId,ack:{requestId:ack.requestId,operation:ack.operation,shareId:ack.shareId},item:row?item(row):null,replayed};
}
export async function listWebsiteShares(projectId:unknown,userId:unknown,query:string){
 const params=new URLSearchParams(query);
 return manage(projectId,userId,async(client,project,role)=>{
  if([...params.keys()].some(key=>key!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one page cursor.');
  const scope={projectId:project,list:'website-shares'},after=readContentCursor(params.get('cursor'),scope);
  const rows=(await client.query<Row>(itemSql+' WHERE s.project_id=$1 AND($2::timestamptz IS NULL OR(s.created_at,s.id)<($2::timestamptz,$3::uuid)) ORDER BY s.created_at DESC,s.id DESC LIMIT 21',[project,after?.at??null,after?.id??null])).rows;
  return{projectId:project,role,items:rows.slice(0,websiteShareLimits.pageSize).map(item),nextCursor:rows.length>websiteShareLimits.pageSize?contentCursor({id:rows[19].id,createdAt:rows[19].created_at},scope):null};
 });
}
export async function createWebsiteShare(projectId:unknown,userId:unknown,raw:unknown){
 const input=parse(websiteShareCreate,raw);if(!canonicalShareToken(input.token))throw new FoundationError(400,'Generate a fresh share token.');const tokenHash=digest(input.token);
 return manage(projectId,userId,async(client,project,_role,actor)=>{
  const receipt=await contentReceipt(client,project,input.requestId,'website.share.create.v1',{actor,label:input.label,sections:input.sections,expiresAt:input.expiresAt,tokenHash});
  if(receipt.replayed)return writeResult(client,project,receipt.result,true);
  const now=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now,lifetime=Date.parse(input.expiresAt)-now.getTime();
  if(lifetime<websiteShareLimits.minLifetimeMs||lifetime>websiteShareLimits.maxLifetimeMs)throw new FoundationError(400,'Choose an expiry between one hour and 365 days from now.');
  const shareId=randomUUID();
  try{await client.query('INSERT INTO project_share(id,project_id,label,token_hash,sections,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[shareId,project,input.label,tokenHash,input.sections,actor,input.expiresAt]);}
  catch(error){if((error as {code?:string}).code==='23505')throw new FoundationError(409,'Use a new token for a different share.');throw error;}
  const ack={requestId:input.requestId,operation:'create' as const,shareId};await receipt.save(ack);return writeResult(client,project,ack,false);
 });
}
export async function revokeWebsiteShare(projectId:unknown,userId:unknown,shareId:unknown,raw:unknown){
 const sid=z.uuid().safeParse(shareId);if(!sid.success)throw missing();const input=parse(websiteShareRevoke,raw),share=sid.data.toLowerCase();
 return manage(projectId,userId,async(client,project,_role,actor)=>{
  const receipt=await contentReceipt(client,project,input.requestId,'website.share.revoke.v1',{actor,shareId:share});
  if(receipt.replayed)return writeResult(client,project,receipt.result,true);
  // Public readers never lock the grant row, so revocation never waits behind them; it is irreversible and idempotent.
  if(!(await client.query('SELECT 1 FROM project_share WHERE id=$1 AND project_id=$2 FOR UPDATE',[share,project])).rowCount)throw missing();
  await client.query('UPDATE project_share SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1',[share]);
  const ack={requestId:input.requestId,operation:'revoke' as const,shareId:share};await receipt.save(ack);return writeResult(client,project,ack,false);
 });
}
/** Public capability read: no session, key or membership. The grant is rechecked inside the aggregate statement and before COMMIT. */
export async function readWebsiteShare(shareId:unknown,token:unknown,raw:unknown){
 const sid=z.uuid().safeParse(shareId);if(!sid.success||!canonicalShareToken(token))throw missing();
 const input=websiteShareRead.safeParse(raw);if(!input.success)throw new FoundationError(400,'Choose a start and an end date in YYYY-MM-DD format.');
 const id=sid.data.toLowerCase(),tokenHash=digest(token);
 const grant=(await getDatabase().pool.query<{project_id:string;label:string;sections:WebsiteShareSection[];expires_at:Date}>('SELECT project_id,label,sections,expires_at FROM project_share WHERE id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[id,tokenHash])).rows[0];
 if(!grant)throw missing();
 let report:Awaited<ReturnType<typeof projectAnalytics>>;
 try{report=await projectAnalytics(grant.project_id,'',new URLSearchParams({from:input.data.from,to:input.data.to}),undefined,{shareId:id,tokenHash});}
 catch(error){if(error instanceof FoundationError&&error.status===404)throw missing();throw error;}
 const value=projectWebsiteShare({id,label:grant.label,sections:grant.sections,expiresAt:grant.expires_at.toISOString()},report);
 if(!value)throw new FoundationError(503,'The shared website report could not be verified.');
 return value;
}
