import {randomUUID,webcrypto} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {parseShopifyCrawlerAccess,providerFetchJson,verifyShopifyCrawlerAccess,type ShopifyCrawlerAccess} from '@ten98/runtime';
import {siteAuditAccessAck,siteAuditAccessBinding,siteAuditAccessMutationResponse,siteAuditAccessRemove,siteAuditAccessResponse,siteAuditAccessSave,type SiteAuditAccessBinding,type SiteAuditAccessMetadata} from '../lib/site-audit-access.ts';
import {FoundationError} from './auth.ts';
import {credentialKeys,decryptCredentials,encryptCredentials,type Keyring} from './credential-vault.ts';
import {getDatabase} from './db.ts';
import {contentReceipt} from './project-context.ts';
import {listSiteAuditOrigins,selectSiteAuditOrigin,withAuditLock,type AuditLock,type AuditProject} from './site-audits.ts';

type AccessRow={id:string;project_id:string;workspace_id:string;domain_id:string|null;origin:string;revision:number;encrypted_credentials:unknown;expires_at:Date;verification:'verified'|'unverified';created_at:Date;updated_at:Date;revoked_at:Date|null};
type AccessReason='crawler_access_changed'|'crawler_access_expired'|'crawler_access_unavailable';
const provider='site-audit.shopify';
const maximumRevision=2147483646;
const payloadInput=z.object({projectId:z.uuid(),origin:z.string().max(512),signatureInput:z.string().min(1).max(4096),signature:z.string().min(1).max(4096)}).strict();
const directoryKey=z.object({kid:z.string().min(1).max(4096),x:z.string().length(43).regex(/^[A-Za-z0-9_-]+$/)});

export class SiteAuditAccessUnavailable extends FoundationError {
 readonly reason:AccessReason;
 constructor(reason:AccessReason){
  super(reason==='crawler_access_unavailable'?503:409,reason==='crawler_access_expired'?'Saved crawler access has expired. Save new access before running.':reason==='crawler_access_changed'?'Saved crawler access changed. Review and select its current revision.':'Saved crawler access is unavailable. Ask the operator to check its encryption keys.');
  this.reason=reason;
 }
}
function parse<T extends z.ZodType>(schema:T,raw:unknown):z.output<T>{const result=schema.safeParse(raw);if(!result.success)throw new FoundationError(400,'Check the crawler access fields and try again.');return result.data;}
function context(row:Pick<AccessRow,'id'|'workspace_id'|'revision'>){return {id:row.id,workspaceId:row.workspace_id,provider,revision:row.revision};}
function configuredKeys(){try{return credentialKeys();}catch{throw new FoundationError(503,'The crawler access encryption keyring is unavailable.');}}
function vaultConfigured(){try{return credentialKeys()!==null;}catch{return false;}}
function metadata(row:Omit<AccessRow,'encrypted_credentials'|'project_id'|'workspace_id'>):SiteAuditAccessMetadata{
 return {id:row.id,domainId:row.domain_id,origin:row.origin,revision:row.revision,expiresAt:row.expires_at.toISOString(),verification:row.verification,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),revokedAt:row.revoked_at?.toISOString()??null};
}
/** Caller holds the project's native audit lock; ciphertext is never selected for metadata. */
export async function listSiteAuditAccessMetadata(client:PoolClient,projectId:string):Promise<SiteAuditAccessMetadata[]>{
 const rows=await client.query<Omit<AccessRow,'encrypted_credentials'|'project_id'|'workspace_id'>>('SELECT id,domain_id,origin,revision,expires_at,verification,created_at,updated_at,revoked_at FROM site_audit_access WHERE project_id=$1 ORDER BY created_at,id LIMIT 52',[projectId]);
 if(rows.rows.length>51)throw new FoundationError(503,'Saved crawler access metadata is unavailable.');
 return rows.rows.map(metadata);
}
async function response({client,project,role}:AuditLock){
 const origins=(await listSiteAuditOrigins(client,project)).map(({domainId,origin})=>({domainId,origin}));
 return siteAuditAccessResponse.parse({projectId:project.id,role,vaultConfigured:vaultConfigured(),origins,credentials:await listSiteAuditAccessMetadata(client,project.id)});
}
async function mutationResponse(locked:AuditLock,ack:unknown){return siteAuditAccessMutationResponse.parse({...await response(locked),ack:siteAuditAccessAck.parse(ack)});}
export async function getSiteAuditAccess(projectId:string,userId:string){return withAuditLock({projectId,actor:{userId,permission:'read'}},response);}

/** Public keys come only from Shopify's fixed directory; no submitted credential leaves this process. */
export async function verifySiteAuditAccess(access:ShopifyCrawlerAccess):Promise<'verified'|'unverified'>{
 let key:webcrypto.CryptoKey;
 try{
  const result=await providerFetchJson('https://shopify.com/.well-known/http-message-signatures-directory',{hosts:['shopify.com'],timeoutMs:5000,maxBytes:32768});
  if(!result.ok)return 'unverified';
  const parsed=directoryKey.safeParse(result.body);if(!parsed.success||parsed.data.kid!==access.keyId)return 'unverified';
  const bytes=Buffer.from(parsed.data.x,'base64url');if(bytes.length!==32||bytes.toString('base64url')!==parsed.data.x)return 'unverified';
  key=await webcrypto.subtle.importKey('raw',bytes,'Ed25519',false,['verify']);
 }catch{return 'unverified';}
 const verified=await verifyShopifyCrawlerAccess(access,key);
 if(verified!=='valid')throw new FoundationError(400,verified==='wrong_domain'?'This crawler access belongs to the other www domain. Select the matching authorized origin.':'The crawler access signature is invalid. Copy both fields from Shopify again.');
 return 'verified';
}
async function existingAccess(client:PoolClient,projectId:string,domainId:string|null){return (await client.query<AccessRow>('SELECT * FROM site_audit_access WHERE project_id=$1 AND domain_id IS NOT DISTINCT FROM $2::uuid',[projectId,domainId])).rows[0];}
function checkRevision(row:AccessRow|undefined,expected:number){if((row?.revision??0)!==expected||expected>=maximumRevision)throw new FoundationError(409,'Saved crawler access changed. Reload before saving or removing it.');}
function freshAccess(origin:string,input:z.infer<typeof siteAuditAccessSave>){
 const access=parseShopifyCrawlerAccess({origin,signatureInput:input.signatureInput,signature:input.signature});
 if(!access)throw new FoundationError(400,'Copy a complete matching Signature-Input and Signature from Shopify.');
 if(Date.parse(access.expiresAt)<=Date.now())throw new FoundationError(400,'This crawler access has expired. Copy new access from Shopify.');
 return access;
}
export async function saveSiteAuditAccess(projectId:string,userId:string,raw:unknown){
 const input=parse(siteAuditAccessSave,raw),target={projectId,actor:{userId,permission:'manage' as const}};
 const prepared=await withAuditLock(target,async locked=>{
  const {client,project}=locked,receipt=await contentReceipt(client,project.id,input.requestId,'audit.access.save',{userId,...input});
  if(receipt.replayed)return {replay:await mutationResponse(locked,receipt.result)};
  const previous=await existingAccess(client,project.id,input.domainId);checkRevision(previous,input.expectedRevision);
  if(!previous&&(await listSiteAuditAccessMetadata(client,project.id)).length>=51)throw new FoundationError(409,'Remove an unused serving domain before adding more crawler access.');
  if(!configuredKeys())throw new FoundationError(503,'Ask the operator to configure the credential encryption keyring.');
  const selected=await selectSiteAuditOrigin(client,project,input.domainId),access=freshAccess(selected.origin,input);
  return {selected,access,previousId:previous?.id??null};
 });
 if('replay' in prepared)return prepared.replay;
 const validation=await verifySiteAuditAccess(prepared.access).then(verification=>({verification,error:null}), (error:unknown)=>({verification:'unverified' as const,error}));
 return withAuditLock(target,async locked=>{
  const {client,project}=locked,receipt=await contentReceipt(client,project.id,input.requestId,'audit.access.save',{userId,...input});
  if(receipt.replayed)return mutationResponse(locked,receipt.result);
  // Another identical save may have committed while its directory check was in flight.
  if(validation.error)throw validation.error;
  const verification=validation.verification;
  const previous=await existingAccess(client,project.id,input.domainId);checkRevision(previous,input.expectedRevision);
  if((previous?.id??null)!==prepared.previousId)throw new SiteAuditAccessUnavailable('crawler_access_changed');
  const selected=await selectSiteAuditOrigin(client,project,input.domainId);
  if(selected.origin!==prepared.selected.origin||selected.hostname!==prepared.selected.hostname||selected.verified!==prepared.selected.verified||selected.revision!==prepared.selected.revision)throw new SiteAuditAccessUnavailable('crawler_access_changed');
  if(!previous&&(await listSiteAuditAccessMetadata(client,project.id)).length>=51)throw new FoundationError(409,'Remove an unused serving domain before adding more crawler access.');
  const access=freshAccess(selected.origin,input),id=previous?.id??randomUUID(),revision=(previous?.revision??0)+1;
  const sealed=encryptCredentials({projectId:project.id,origin:access.origin,signatureInput:access.signatureInput,signature:access.signature},{workspaceId:project.workspaceId,id,provider,revision},configuredKeys());
  if(previous)await client.query('UPDATE site_audit_access SET origin=$3,revision=$4,encrypted_credentials=$5,expires_at=$6,verification=$7,updated_at=clock_timestamp(),revoked_at=NULL WHERE id=$1 AND project_id=$2',[id,project.id,access.origin,revision,sealed,access.expiresAt,verification]);
  else await client.query('INSERT INTO site_audit_access(id,project_id,workspace_id,domain_id,origin,revision,encrypted_credentials,expires_at,verification,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,project.id,project.workspaceId,input.domainId,access.origin,revision,sealed,access.expiresAt,verification,userId]);
  const ack={requestId:input.requestId,operation:'save' as const,credentialId:id,revision};await receipt.save(ack);return mutationResponse(locked,ack);
 });
}
export async function removeSiteAuditAccess(projectId:string,userId:string,raw:unknown){
 const input=parse(siteAuditAccessRemove,raw);
 return withAuditLock({projectId,actor:{userId,permission:'manage'}},async locked=>{
  const {client,project}=locked,receipt=await contentReceipt(client,project.id,input.requestId,'audit.access.remove',{userId,...input});
  if(receipt.replayed)return mutationResponse(locked,receipt.result);
  const row=(await client.query<AccessRow>('SELECT * FROM site_audit_access WHERE id=$1 AND project_id=$2',[input.credentialId,project.id])).rows[0];
  if(!row)throw new FoundationError(404,'Saved crawler access not found or unavailable.');checkRevision(row,input.expectedRevision);
  if(row.revoked_at)throw new FoundationError(409,'This crawler access was already removed. Reload its current revision.');
  const revision=row.revision+1;await client.query('UPDATE site_audit_access SET encrypted_credentials=NULL,revision=$3,revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND project_id=$2',[row.id,project.id,revision]);
  const ack={requestId:input.requestId,operation:'remove' as const,credentialId:row.id,revision};await receipt.save(ack);return mutationResponse(locked,ack);
 });
}
function openedAccess(row:AccessRow,ring:Keyring|null){
 try{
  const payload=payloadInput.safeParse(decryptCredentials(row.encrypted_credentials,context(row),ring));
  if(!payload.success||payload.data.projectId!==row.project_id||payload.data.origin!==row.origin)throw new Error();
  const access=parseShopifyCrawlerAccess(payload.data);
  if(!access||!Number.isFinite(row.expires_at.getTime())||Date.parse(access.expiresAt)!==row.expires_at.getTime())throw new Error();
  return access;
 }catch{throw new SiteAuditAccessUnavailable('crawler_access_unavailable');}
}
/** Caller holds the native W/P lock; a selected credential always fails closed. */
export async function openSiteAuditAccess(client:PoolClient,project:AuditProject,domainId:string|null,binding:SiteAuditAccessBinding|null|undefined,at:Date):Promise<ShopifyCrawlerAccess|null>{
 if(binding===null||binding===undefined)return null;
 const selectedBinding=siteAuditAccessBinding.safeParse(binding);if(!selectedBinding.success)throw new SiteAuditAccessUnavailable('crawler_access_changed');
 const row=(await client.query<AccessRow>('SELECT * FROM site_audit_access WHERE id=$1 AND project_id=$2 AND workspace_id=$3',[selectedBinding.data.id,project.id,project.workspaceId])).rows[0];
 if(!row||row.project_id!==project.id||row.workspace_id!==project.workspaceId||row.domain_id!==domainId||row.revision!==selectedBinding.data.revision||row.revoked_at)throw new SiteAuditAccessUnavailable('crawler_access_changed');
 let selected:Awaited<ReturnType<typeof selectSiteAuditOrigin>>;
 try{selected=await selectSiteAuditOrigin(client,project,domainId);}catch{throw new SiteAuditAccessUnavailable('crawler_access_changed');}
 if(row.origin!==selected.origin)throw new SiteAuditAccessUnavailable('crawler_access_changed');
 if(!Number.isFinite(at.getTime())||!Number.isFinite(row.expires_at.getTime()))throw new SiteAuditAccessUnavailable('crawler_access_unavailable');
 if(row.expires_at.getTime()<=at.getTime())throw new SiteAuditAccessUnavailable('crawler_access_expired');
 try{return openedAccess(row,credentialKeys());}catch{throw new SiteAuditAccessUnavailable('crawler_access_unavailable');}
}
async function visitAccessEncryption(rotate:boolean):Promise<number>{
 const ring=configuredKeys();if(rotate&&!ring)throw new FoundationError(503,'Configure a credential keyring first.');
 const client=await getDatabase().pool.connect();let count=0;
 try{
  await client.query('BEGIN');
  const lock=rotate?'UPDATE':'SHARE';
  await client.query(`SELECT id FROM workspace ORDER BY id FOR ${lock}`);
  await client.query(`SELECT id FROM project ORDER BY workspace_id,id FOR ${lock}`);
  const rows=await client.query<AccessRow>(`SELECT * FROM site_audit_access WHERE encrypted_credentials IS NOT NULL ORDER BY workspace_id,project_id,id FOR ${lock}`);
  for(const row of rows.rows){
   const access=openedAccess(row,ring);
   if(rotate){const sealed=encryptCredentials({projectId:row.project_id,origin:access.origin,signatureInput:access.signatureInput,signature:access.signature},context(row),ring);await client.query('UPDATE site_audit_access SET encrypted_credentials=$2 WHERE id=$1',[row.id,sealed]);count++;}
  }
  await client.query('COMMIT');return count;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
export async function assertSiteAuditAccessKeys():Promise<void>{await visitAccessEncryption(false);}
export async function rotateSiteAuditAccessEncryption():Promise<number>{return visitAccessEncryption(true);}
