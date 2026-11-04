import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {getAuth} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {getSiteAuditAccess,saveSiteAuditAccess,removeSiteAuditAccess,openSiteAuditAccess,assertSiteAuditAccessKeys,rotateSiteAuditAccessEncryption} from '../src/server/site-audit-access.ts';
import {withAuditLock,startSiteAudit,cancelSiteAudit,siteAuditQueue,getSiteAuditSetup} from '../src/server/site-audits.ts';
import {saveSiteAuditSchedule,pauseSiteAuditSchedule,getSiteAuditSchedule,claimDueSiteAuditOccurrence} from '../src/server/site-audit-recurring.ts';
import {closeAccount,type StepUpProof} from '../src/server/account-closure.ts';
import {siteAuditScheduleMutationResponse} from '../src/lib/site-audit-recurring.ts';
import {siteAuditAccessMutationResponse} from '../src/lib/site-audit-access.ts';

export async function runSiteAuditAccessChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_SITE_AUDIT_ACCESS_TEST,'1');
 const config=getConfig(),database=new URL(config.databaseUrl);assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'55501');assert.match(database.pathname,/^\/ten98_audit_access_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(database.hash,'');assert.equal(process.env.ANALYTICS_NETWORK_MODE,'off');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
 const owner=randomUUID(),admin=randomUUID(),viewer=randomUUID(),stranger=randomUUID(),origin='https://shop.example.com';
 for(const user of [owner,admin,viewer,stranger])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Access fixture\',$2)',[user,`${user}@access.integration.test`]);
 async function fixture(){const workspace=randomUUID(),project=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Access fixture')",[workspace]);for(const[user,role]of[[owner,'owner'],[admin,'admin'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Access fixture',$3,$4,'infinity')",[project,workspace,origin,randomUUID()]);return {workspace,project};}
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 const pair=generateKeyPairSync('ed25519'),jwk=pair.publicKey.export({format:'jwk'}),originalFetch=globalThis.fetch;let directoryCalls=0;
 const directory:typeof fetch=async(url,init)=>{directoryCalls++;assert.equal(url,'https://shopify.com/.well-known/http-message-signatures-directory');assert.equal(init?.body,undefined);assert.equal(new Headers(init?.headers).get('Signature'),null);return Response.json({kid:'fixture',x:jwk.x});};globalThis.fetch=directory;
 const input=(expectedRevision=0,host='shop.example.com')=>{const parameters=`("@authority" "signature-agent");keyid="fixture";expires=${Math.floor(Date.now()/1000)+3600}`;return {requestId:randomUUID(),expectedRevision,domainId:null,signatureInput:'sig1='+parameters,signature:`sig1=:${sign(null,Buffer.from(`"@authority": ${host}\n"signature-agent": "https://shopify.com"\n"@signature-params": ${parameters}`),pair.privateKey).toString('base64')}:`};};
 const save=async(f:Fixture,body=input(),user=owner)=>siteAuditAccessMutationResponse.parse(await saveSiteAuditAccess(f.project,user,body));
 const remove=async(f:Fixture,id:string,revision:number)=>siteAuditAccessMutationResponse.parse(await removeSiteAuditAccess(f.project,owner,{requestId:randomUUID(),credentialId:id,expectedRevision:revision}));
 const row=async(id:string)=>(await pool.query('SELECT * FROM site_audit_access WHERE id=$1',[id])).rows[0];
 const open=(f:Fixture,binding:{id:string;revision:number},at=new Date())=>withAuditLock({projectId:f.project,actor:{userId:owner,permission:'read'}},({client,project})=>openSiteAuditAccess(client,project,null,binding,at));
 const startBody=()=>({requestId:randomUUID(),domainId:null,startPath:'/',maxPages:2,mode:'static',retainBodyText:false});
 const calendar={interval:'daily' as const,timezone:'UTC',hour:12,minute:0,weekday:null};
 try{
  const f=await fixture(),foreign=await fixture();assert.equal((await getSiteAuditAccess(f.project,viewer)).credentials.length,0);assert.equal(directoryCalls,0);
  await assert.rejects(save(f,input(),viewer),{status:403});await assert.rejects(getSiteAuditAccess(f.project,stranger),{status:404});await assert.rejects(saveSiteAuditAccess(f.project,owner,{...input(),budget:1}),{status:400});assert.equal(directoryCalls,0);
  const body=input(),[created,repeat]=await Promise.all([save(f,body),save(f,body)]);assert.deepEqual(created.ack,repeat.ack);const id=created.ack.credentialId;assert.equal(created.credentials[0].verification,'verified');assert.equal(created.ack.revision,1);
  const serialized=JSON.stringify(created),stored=await row(id);assert.ok(!serialized.includes(body.signature)&&!serialized.includes(body.signatureInput));assert.ok(!JSON.stringify(stored.encrypted_credentials).includes(body.signature));assert.equal((await getSiteAuditSetup(f.project,owner)).crawlerAccess[0].id,id);
  await assert.rejects(save(f,{...body,signature:body.signature.replace('sig1','sig2')}),{status:409});await assert.rejects(save(f,body,admin),{status:409});assert.equal((await pool.query('SELECT count(*)::int AS n FROM site_audit_access WHERE project_id=$1',[f.project])).rows[0].n,1);
  console.log('PASS access uses native roles, tenant scope, encrypted storage, safe metadata and concurrent exact receipts');

  const before=directoryCalls;globalThis.fetch=async()=>{throw Error('Replay must not use directory');};assert.deepEqual((await save(f,body)).ack,created.ack);assert.equal(directoryCalls,before);globalThis.fetch=directory;
  await assert.rejects(save(f,input(1,'www.shop.example.com')),{status:400});assert.equal((await row(id)).revision,1);
  const changed=await fixture();globalThis.fetch=async(...args)=>{await pool.query("UPDATE project SET origin='https://changed.example.com' WHERE id=$1",[changed.project]);return directory(...args);};await assert.rejects(save(changed),{status:409});assert.equal((await getSiteAuditAccess(changed.project,owner)).credentials.length,0);globalThis.fetch=directory;
  console.log('PASS original receipts precede verification and fresh domain proof is rechecked after directory validation');

  const race=await fixture(),raceBody=input();let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(done=>{release=done;}),ready=new Promise<void>(done=>{entered=done;});let calls=0;const bad=generateKeyPairSync('ed25519').publicKey.export({format:'jwk'});
  globalThis.fetch=async(...args)=>{if(++calls===1){entered();await wait;return Response.json({kid:'fixture',x:bad.x});}return directory(...args);};const slow=save(race,raceBody);await ready;const fast=await save(race,raceBody);release();assert.deepEqual((await slow).ack,fast.ack);globalThis.fetch=directory;
  console.log('PASS overlapping save recovers the committed original receipt even when its delayed verification fails');

  assert.equal((await open(f,{id,revision:1}))!.signature,body.signature);await assert.rejects(open(foreign,{id,revision:1}),{reason:'crawler_access_changed'});await assert.rejects(open(f,{id,revision:2}),{reason:'crawler_access_changed'});await assert.rejects(open(f,{id,revision:1},new Date(created.credentials[0].expiresAt)),{reason:'crawler_access_expired'});
  const keys=process.env.CREDENTIAL_KEYS!,active=process.env.CREDENTIAL_ACTIVE_KEY!;process.env.CREDENTIAL_KEYS=JSON.stringify({missing:randomBytes(32).toString('base64')});process.env.CREDENTIAL_ACTIVE_KEY='missing';try{await assert.rejects(open(f,{id,revision:1}),{reason:'crawler_access_unavailable'});await assert.rejects(assertSiteAuditAccessKeys());}finally{process.env.CREDENTIAL_KEYS=keys;process.env.CREDENTIAL_ACTIVE_KEY=active;}
  const ciphertext=stored.encrypted_credentials;await pool.query('UPDATE site_audit_access SET encrypted_credentials=$2 WHERE id=$1',[fast.ack.credentialId,ciphertext]);await assert.rejects(open(race,{id:fast.ack.credentialId,revision:1}),{reason:'crawler_access_unavailable'});await remove(race,fast.ack.credentialId,1);
  console.log('PASS selected access refuses foreign projects, stale revisions, exact expiry, lost keys and transplanted ciphertext');

  const oldStamp=(await row(id)).updated_at;process.env.CREDENTIAL_KEYS=JSON.stringify({...JSON.parse(keys),v2:randomBytes(32).toString('base64')});process.env.CREDENTIAL_ACTIVE_KEY='v2';try{await assertSiteAuditAccessKeys();assert.equal(await rotateSiteAuditAccessEncryption(),1);const rotated=await row(id);assert.equal(rotated.revision,1);assert.equal(rotated.updated_at.getTime(),oldStamp.getTime());assert.equal(rotated.encrypted_credentials.keyId,'v2');assert.equal((await open(f,{id,revision:1}))!.signature,body.signature);process.env.CREDENTIAL_ACTIVE_KEY=active;await rotateSiteAuditAccessEncryption();}finally{process.env.CREDENTIAL_KEYS=keys;process.env.CREDENTIAL_ACTIVE_KEY=active;}
  console.log('PASS operator readability and key rotation preserve native credential identity, timestamps and request bindings');

  const boss=await getBoss();await boss.createQueue(siteAuditQueue);const plain=startBody(),unsigned=await startSiteAudit(f.project,owner,plain);assert.equal(unsigned.run.config.crawlerAccess,undefined);assert.equal((await startSiteAudit(f.project,owner,{...plain,crawlerAccess:null})).run.id,unsigned.run.id);await cancelSiteAudit(f.project,owner,unsigned.run.id,{});
  const protectedBody={...startBody(),crawlerAccess:{id,revision:1}},protectedRun=await startSiteAudit(f.project,owner,protectedBody);assert.deepEqual(protectedRun.run.config.crawlerAccess,{id,revision:1,expiresAt:created.credentials[0].expiresAt});assert.ok(!JSON.stringify(protectedRun).includes(body.signature));await cancelSiteAudit(f.project,owner,protectedRun.run.id,{});
  const revoked=await remove(f,id,1);assert.equal((await row(id)).encrypted_credentials,null);assert.equal(revoked.ack.revision,2);await assert.rejects(open(f,{id,revision:1}),{reason:'crawler_access_changed'});const restored=await save(f,input(2));assert.equal(restored.ack.credentialId,id);assert.equal(restored.ack.revision,3);assert.equal((await save(f,body)).ack.revision,1);assert.equal((await save(f,body)).credentials[0].revision,3);await assert.rejects(startSiteAudit(f.project,owner,{...startBody(),crawlerAccess:{id,revision:1}}),{reason:'crawler_access_changed'});
  console.log('PASS manual queue selection preserves unsigned identity and explicit revision without secret leakage or ABA reuse');

  const scheduleInput={requestId:randomUUID(),expectedRevision:0,definition:{mode:'static',domainId:null,startPath:'/',maxPages:2,retainBodyText:false,crawlerAccess:{id,revision:3}},calendar};const scheduled=siteAuditScheduleMutationResponse.parse(await saveSiteAuditSchedule(f.project,owner,scheduleInput));assert.deepEqual(scheduled.ack.crawlerAccess,{id,revision:3});await remove(f,id,3);await pool.query("UPDATE site_audit_schedule SET next_due_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",[f.project]);await claimDueSiteAuditOccurrence();const stopped=(await getSiteAuditSchedule(f.project,owner)).schedule!;assert.equal(stopped.enabled,false);assert.equal(stopped.occurrences[0].reason,'crawler_access_changed');assert.equal(stopped.occurrences[0].runId,null);await pauseSiteAuditSchedule(f.project,owner,{requestId:randomUUID(),expectedRevision:1});assert.deepEqual(siteAuditScheduleMutationResponse.parse(await saveSiteAuditSchedule(f.project,owner,scheduleInput)).ack,scheduled.ack);
  console.log('PASS scheduled access keeps original approval evidence and disables a changed credential occurrence without dispatch');

  const api=await fixture(),password=randomBytes(24).toString('hex'),hash=await hashPassword(password),cookies=new Map<string,string>();
  for(const user of [owner,viewer]){await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),user,hash]);const login=await getAuth().handler(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:config.appUrl},body:JSON.stringify({email:`${user}@access.integration.test`,password})}));assert.equal(login.status,200);cookies.set(user,login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '));}
  const base=config.appUrl+'/api/projects/'+api.project+'/audits/access';let apiRequests=0;const request=(suffix='',method='GET',body?:unknown,user=owner,from=config.appUrl)=>new Request(base+suffix,{method,headers:{cookie:cookies.get(user)!,origin:from,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const invoke=(r:Request)=>{assert.ok(++apiRequests<=100);return handleApi(r);};
  assert.equal((await invoke(new Request(base))).status,401);assert.equal((await invoke(request('','POST',input(),owner,'https://foreign.example.org'))).status,403);assert.equal((await invoke(request('?extra=1'))).status,400);assert.equal((await invoke(request('','PUT'))).status,405);assert.equal((await invoke(request('','POST',input(),viewer))).status,404);assert.equal((await invoke(request('','GET',undefined,viewer))).status,200);
  const apiBody=input(),apiResponse=await invoke(request('','POST',apiBody));assert.equal(apiResponse.status,200);const apiSaved=siteAuditAccessMutationResponse.parse(await apiResponse.json());assert.ok(!JSON.stringify(apiSaved).includes(apiBody.signature));assert.equal((await invoke(request('/remove','POST',{requestId:randomUUID(),credentialId:apiSaved.ack.credentialId,expectedRevision:1}))).status,200);
  console.log('PASS native access API enforces cookie and Origin authority, strict routes, safe responses and explicit mutations');

  const owned=await fixture(),byAdmin=await save(owned,input(),admin);const closure=await pool.connect();try{await closure.query('BEGIN');await closeAccount(closure,admin,{kind:'self',userId:admin},{userId:admin,method:'password'} as StepUpProof);await closure.query('COMMIT');}catch(error){await closure.query('ROLLBACK');throw error;}finally{closure.release();}
  assert.equal((await row(byAdmin.ack.credentialId)).created_by,admin);assert.ok((await open(owned,{id:byAdmin.ack.credentialId,revision:1}))!.signature);await assert.rejects(getSiteAuditAccess(owned.project,admin),{status:404});await pool.query('DELETE FROM project WHERE id=$1',[owned.project]);assert.equal(await row(byAdmin.ack.credentialId),undefined);await pool.query('DELETE FROM workspace WHERE id=$1',[foreign.workspace]);assert.equal((await pool.query('SELECT 1 FROM site_audit_access WHERE workspace_id=$1',[foreign.workspace])).rowCount,0);
  console.log('PASS account closure retains workspace-owned encrypted access while project and workspace deletion cascade');
 }finally{globalThis.fetch=originalFetch;await stopJobs();await closeDatabase();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runSiteAuditAccessChecks();
