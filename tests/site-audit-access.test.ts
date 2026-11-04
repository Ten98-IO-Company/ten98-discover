import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import test from 'node:test';
import type {PoolClient} from 'pg';
import {parseShopifyCrawlerAccess,type ShopifyCrawlerAccess} from '@ten98/runtime';
import {FoundationError} from '../src/server/auth.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {listSiteAuditAccessMetadata,openSiteAuditAccess,SiteAuditAccessUnavailable,verifySiteAuditAccess} from '../src/server/site-audit-access.ts';

const origin='https://shop.example.com',directory='https://shopify.com/.well-known/http-message-signatures-directory';
const pair=generateKeyPairSync('ed25519'),jwk=pair.publicKey.export({format:'jwk'}),kid='test-shopify-key';
const parameters=`("@authority" "signature-agent");created=1767225600;expires=4102444800;keyid="${kid}";alg="ed25519"`;
function signedAccess(host='shop.example.com'):ShopifyCrawlerAccess{
 const bytes=Buffer.from(`"@authority": ${host}\n"signature-agent": "https://shopify.com"\n"@signature-params": ${parameters}`);
 const access=parseShopifyCrawlerAccess({origin,signatureInput:`sig1=${parameters}`,signature:`sig1=:${sign(null,bytes,pair.privateKey).toString('base64')}:`});
 assert.ok(access);return access;
}
async function withFetch(fetcher:typeof fetch,run:()=>Promise<void>){const saved=globalThis.fetch;globalThis.fetch=fetcher;try{await run();}finally{globalThis.fetch=saved;}}
function safeValidation(error:unknown){assert.ok(error instanceof FoundationError);assert.equal(error.status,400);assert.ok(!JSON.stringify(error).includes(parameters));return true;}

test('fixed public-key lookup verifies generated Ed25519 access without sending secret fields',async()=>{
 const access=signedAccess();let calls=0;
 await withFetch(async(url,init)=>{
  calls++;assert.equal(String(url),directory);assert.equal(init?.redirect,'error');assert.ok(init?.signal instanceof AbortSignal);
  assert.equal(init?.body,undefined);assert.equal(init?.method,undefined);
  const headers=new Headers(init?.headers);assert.equal(headers.has('Signature-Input'),false);assert.equal(headers.has('Signature'),false);assert.equal(headers.has('Authorization'),false);
  assert.ok(!JSON.stringify({url:String(url),init}).includes(access.signature));
  return Response.json({kid,x:jwk.x});
 },async()=>assert.equal(await verifySiteAuditAccess(access),'verified'));
 assert.equal(calls,1);
});

test('known key rejects invalid signatures and the alternate www domain with safe errors',async()=>{
 await withFetch(async()=>Response.json({kid,x:jwk.x}),async()=>{
  await assert.rejects(verifySiteAuditAccess(signedAccess('www.shop.example.com')),error=>{safeValidation(error);assert.match((error as Error).message,/www domain/);return true;});
  const access=signedAccess(),bad={...access,signature:`sig1=:${Buffer.alloc(64,1).toString('base64')}:`};
  await assert.rejects(verifySiteAuditAccess(bad),safeValidation);
 });
});

test('unknown, rotated, malformed and noncanonical directory keys remain unverified',async()=>{
 const access=signedAccess();
 for(const body of [{kid:'rotated',x:jwk.x},{keys:[{kid,x:jwk.x}]},{kid,x:'A'.repeat(42)},{kid,x:'!'.repeat(43)},{kid,x:'A'.repeat(42)+'B'},{kid:'x'.repeat(4097),x:jwk.x},null]){
  await withFetch(async()=>Response.json(body),async()=>assert.equal(await verifySiteAuditAccess(access),'unverified'));
 }
});

test('directory failures and oversized bodies are unverified, redacted and never retried',async()=>{
 const access=signedAccess();
 const responses:typeof fetch[]=[
  async()=>{throw new Error(`remote failure ${access.signatureInput} ${access.signature}`);},
  async()=>new Response(access.signature,{status:503}),
  async()=>new Response('',{status:302,headers:{location:'https://evil.example/'}}),
  async()=>new Response('{'),
  async()=>new Response(' '.repeat(32769)),
  async()=>Response.json({kid,x:jwk.x},{headers:{'content-length':'32769'}}),
 ];
 for(const fetcher of responses){let calls=0;await withFetch(async(...args)=>{calls++;return fetcher(...args);},async()=>assert.equal(await verifySiteAuditAccess(access),'unverified'));assert.equal(calls,1);}
});

test('directory request is aborted at the five-second boundary', {timeout:10000},async()=>{
 let aborted=false,calls=0;
 await withFetch(async(_url,init)=>{
  calls++;return new Promise<Response>((_resolve,reject)=>{
   assert.ok(init?.signal);init.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('synthetic secret-bearing timeout'));},{once:true});
  });
 },async()=>assert.equal(await verifySiteAuditAccess(signedAccess()),'unverified'));
 assert.equal(aborted,true);assert.equal(calls,1);
});

function fixture(){
 const project={id:randomUUID(),workspaceId:randomUUID(),origin},id=randomUUID(),at=new Date('2026-11-03T00:00:00Z'),access=signedAccess();
 const ring={active:'test',keys:new Map([['test',randomBytes(32)]])};
 const payload={projectId:project.id,origin,signatureInput:access.signatureInput,signature:access.signature};
 const aad={workspaceId:project.workspaceId,id,provider:'site-audit.shopify',revision:1};
 const row={id,project_id:project.id,workspace_id:project.workspaceId,domain_id:null,origin,revision:1,encrypted_credentials:encryptCredentials(payload,aad,ring),expires_at:new Date(access.expiresAt),verification:'verified',created_at:at,updated_at:at,revoked_at:null};
 let queries=0;
 const client={query:async(_sql:string,args:unknown[])=>{queries++;assert.deepEqual(args,[id,project.id,project.workspaceId]);return {rows:[row],rowCount:1};}} as unknown as PoolClient;
 return {project,id,at,access,ring,payload,aad,row,client,queries:()=>queries};
}
async function withKeys(f:ReturnType<typeof fixture>,run:()=>Promise<void>){
 const names=['CREDENTIAL_KEYS','CREDENTIAL_ACTIVE_KEY','CREDENTIAL_KEYS_FILE'] as const,old=names.map(name=>process.env[name]);
 process.env.CREDENTIAL_KEYS=JSON.stringify({test:f.ring.keys.get('test')!.toString('base64')});process.env.CREDENTIAL_ACTIVE_KEY='test';delete process.env.CREDENTIAL_KEYS_FILE;
 try{await run();}finally{names.forEach((name,index)=>{if(old[index]===undefined)delete process.env[name];else process.env[name]=old[index];});}
}
function unavailable(reason:string){return (error:unknown)=>{assert.ok(error instanceof SiteAuditAccessUnavailable);assert.equal(error.reason,reason);assert.ok(!error.message.includes(parameters));assert.equal(Object.hasOwn(error,'cause'),false);return true;};}

test('selected access decrypts only exact native AAD and matching payload; null selection never queries',async()=>{
 const f=fixture();
 await withKeys(f,async()=>{
  assert.equal(await openSiteAuditAccess(f.client,f.project,null,null,f.at),null);assert.equal(f.queries(),0);
  assert.deepEqual(await openSiteAuditAccess(f.client,f.project,null,{id:f.id,revision:1},f.at),f.access);assert.equal(f.queries(),1);
 });
});

test('strict binding, project/workspace/domain/revision/revocation/origin changes never fall back unsigned',async()=>{
 const changes=[{project_id:randomUUID()},{workspace_id:randomUUID()},{domain_id:randomUUID()},{revision:2},{revoked_at:new Date()},{origin:'https://other.example.com'}];
 for(const change of changes){const f=fixture();Object.assign(f.row,change);await assert.rejects(openSiteAuditAccess(f.client,f.project,null,{id:f.id,revision:1},f.at),unavailable('crawler_access_changed'));}
 const f=fixture();await assert.rejects(openSiteAuditAccess(f.client,f.project,null,{id:f.id,revision:1,extra:true} as {id:string;revision:number},f.at),unavailable('crawler_access_changed'));assert.equal(f.queries(),0);
});

test('exact expiry and invalid timestamps produce explicit safe refusal',async()=>{
 const f=fixture();await assert.rejects(openSiteAuditAccess(f.client,f.project,null,{id:f.id,revision:1},new Date(f.access.expiresAt)),unavailable('crawler_access_expired'));
 await assert.rejects(openSiteAuditAccess(f.client,f.project,null,{id:f.id,revision:1},new Date(NaN)),unavailable('crawler_access_unavailable'));
 f.row.expires_at=new Date(NaN);await assert.rejects(openSiteAuditAccess(f.client,f.project,null,{id:f.id,revision:1},f.at),unavailable('crawler_access_unavailable'));
});

test('payload binding, strict secret shape, expiry metadata and missing keys are validated after native decryption',async()=>{
 const changes=[{projectId:randomUUID()},{origin:'https://other.example.com'},{extra:'never return this'}, {signature:'sig1=:invalid:'}];
 for(const change of changes){const f=fixture();f.row.encrypted_credentials=encryptCredentials({...f.payload,...change},f.aad,f.ring);await withKeys(f,async()=>{await assert.rejects(openSiteAuditAccess(f.client,f.project,null,{id:f.id,revision:1},f.at),unavailable('crawler_access_unavailable'));});}
 const f=fixture();await withKeys(f,async()=>{
  f.row.expires_at=new Date(f.row.expires_at.getTime()+1000);await assert.rejects(openSiteAuditAccess(f.client,f.project,null,{id:f.id,revision:1},f.at),unavailable('crawler_access_unavailable'));
  f.row.expires_at=new Date(f.access.expiresAt);delete process.env.CREDENTIAL_KEYS;delete process.env.CREDENTIAL_ACTIVE_KEY;
  await assert.rejects(openSiteAuditAccess(f.client,f.project,null,{id:f.id,revision:1},f.at),unavailable('crawler_access_unavailable'));
 });
});

test('metadata projection excludes ciphertext and secret fields even if a row contains them',async()=>{
 const f=fixture();let sql='';
 const client={query:async(statement:string)=>{sql=statement;return {rows:[{...f.row,...f.payload}],rowCount:1};}} as unknown as PoolClient;
 const rows=await listSiteAuditAccessMetadata(client,f.project.id);
 assert.equal(sql.includes('encrypted_credentials'),false);assert.equal(rows.length,1);assert.equal(rows[0].id,f.id);
 assert.equal(JSON.stringify(rows).includes(f.access.signature),false);assert.deepEqual(Object.keys(rows[0]),['id','domainId','origin','revision','expiresAt','verification','createdAt','updatedAt','revokedAt']);
});
