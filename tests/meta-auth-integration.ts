import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getAuth} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {withMetaTransportForTests} from '../src/server/meta-http.ts';
import {assertMetaCredentialsReadable,disableMetaApp,disconnectMeta,expireMetaFlows,getMetaApp,getMetaConnection,inspectMetaAccount,listMetaAccounts,listMetaConnections,metaCallback,metaDeletionContext,metaSubjectHash,quarantineMetaConnections,rotateMetaCredentials,saveMetaApp,selectMetaAccount,startMetaConnect,withMetaRegistration} from '../src/server/meta-auth.ts';

const fails=(status:number)=>(error:unknown)=>(error as {status?:number})?.status===status;
function latch(){let signal!:()=>void,release!:()=>void;return {entered:new Promise<void>(r=>signal=r),release:()=>release(),hold:async()=>{signal();await new Promise<void>(r=>release=r);}};}
const reached=(p:Promise<void>)=>Promise.race([p,new Promise<never>((_,reject)=>{setTimeout(()=>reject(new Error('Expected contained Meta operation was not reached.')),5000).unref();})]);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');

export async function runMetaAuthChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_META_AUTH_TEST,'1');
 const config=getConfig(),dbUrl=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&dbUrl.pathname==='/ten98_meta_auth_ci';
 assert.ok(local.includes(dbUrl.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(dbUrl.port,ci?'5432':'55501');assert.match(dbUrl.pathname,/^\/ten98_meta_auth_[a-z0-9_]+$/);assert.equal(dbUrl.search,'');assert.equal(dbUrl.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined,'No PostgreSQL environment override is allowed.');
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use an empty owned migrated fixture.');
 const originalFetch=globalThis.fetch;let unexpected=0;globalThis.fetch=async()=>{unexpected++;throw new Error('Uncontained Meta traffic is forbidden.');};
 const operator=randomUUID(),owner=randomUUID(),viewer=randomUUID(),workspace=randomUUID(),project=randomUUID(),foreignWorkspace=randomUUID(),foreignProject=randomUUID(),password=randomBytes(24).toString('base64url');
 const browser=new Map<string,string>(),appSecret=randomBytes(24).toString('base64url'),accessToken=randomBytes(24).toString('base64url');let activeSecret=appSecret,appId='10001',subject='20001';
 let mode='normal',calls=0,inspectCalls=0,revokeCalls=0,accountCalls=0,gate:null|{route:string;latch:ReturnType<typeof latch>}=null;
 const account=(id='30001')=>({id:'act_'+id,account_id:id,name:'Synthetic ads account',currency:'AED',timezone_name:'Asia/Dubai',account_status:1});
 const send=async(address:string,init:RequestInit)=>{
  calls++;const url=new URL(address);assert.equal(url.origin,'https://graph.facebook.com');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
  if(gate&&url.pathname.endsWith(gate.route)){const hold=gate;gate=null;await hold.latch.hold();}
  if(url.pathname.endsWith('/oauth/access_token')){assert.equal(url.searchParams.get('client_secret'),activeSecret);return Response.json({access_token:accessToken,token_type:'Bearer',expires_in:mode==='zero_access'?0:3600});}
  if(url.pathname.endsWith('/debug_token')){inspectCalls++;assert.equal(url.searchParams.get('access_token'),appId+'|'+activeSecret);return Response.json({data:{app_id:mode==='wrong_app'?'99999':appId,user_id:subject,type:mode==='system'?'SYSTEM_USER':'USER',is_valid:true,scopes:mode==='scope'?[]:['ads_read'],expires_at:Math.floor(Date.now()/1000)+(mode==='short_inspection'?10:3600),data_access_expires_at:mode==='known_expiry'?Math.floor(Date.now()/1000)+7200:0}});}
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+accessToken);
  if(url.pathname.endsWith('/me/permissions')){if(init.method==='DELETE'){revokeCalls++;return Response.json({success:true});}return Response.json({data:[{permission:'ads_read',status:'granted'}]});}
  if(url.pathname.endsWith('/me/adaccounts')){accountCalls++;return Response.json({data:[account(url.searchParams.has('after')?'30002':'30001')],...(url.searchParams.has('after')?{}:{paging:{next:'https://untrusted.invalid/?access_token=must-not-follow',cursors:{after:mode==='huge_cursor'?'\u{1f642}'.repeat(2000):'opaque-provider-page'}}})});}
  if(/\/act_[0-9]+$/.test(url.pathname)){accountCalls++;return Response.json(account(mode==='wrong_account'?'39999':url.pathname.split('_').at(-1)));}
  assert.fail('Unexpected fixed Meta operation.');
 };
 const cookies=()=>[...browser].map(([k,v])=>k+'='+v).join('; ');
 const saveCookies=(response:Response)=>{for(const item of response.headers.getSetCookie()){const [key,...value]=item.split(';')[0].split('=');browser.set(key,value.join('='));}};
 async function role(value:string){const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='2s'");await c.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);await c.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[workspace,owner,value]);await c.query('COMMIT');}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}}
 let session:{user:{id:string};session:{id:string}};
 async function begin(connectionId?:string,revision?:number){const input={requestId:randomUUID(),name:'Meta source',...(connectionId?{connectionId,revision}:{})},result=await startMetaConnect(project,session,input);const [key,...value]=result.cookie.split(';')[0].split('=');browser.set(key,value.join('='));return {input,result,state:new URL(result.authorizationUrl).searchParams.get('state')!};}
 async function finish(start:Awaited<ReturnType<typeof begin>>,cookie=cookies()){return metaCallback(new Request(config.appUrl+'/api/meta/callback?'+new URLSearchParams({state:start.state,code:'synthetic-one-use-code'}),{headers:{cookie}}));}
 async function connect(){const response=await finish(await begin());assert.match(response.headers.get('location')??'',/#meta=connected/);return(await listMetaConnections(project,owner)).connections[0];}
 try{
  for(const uid of [operator,owner,viewer]){await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Meta fixture actor\',$2)',[uid,uid+'@integration.test']);await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),uid,await hashPassword(password)]);}
  await pool.query("INSERT INTO instance_operator(user_id,source) VALUES($1,'host')",[operator]);
  for(const [wid,pid]of [[workspace,project],[foreignWorkspace,foreignProject]]){await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Meta fixture')",[wid]);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')",[wid,owner,viewer]);await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Meta fixture','https://example.test',$3)",[pid,wid,randomUUID()]);}
  const login=await getAuth().handler(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:owner+'@integration.test',password})}));assert.equal(login.status,200);saveCookies(login);const signed=await getAuth().api.getSession({headers:new Headers({cookie:cookies()})});assert.ok(signed);session=signed;
  await withMetaTransportForTests(send,async()=>{
   const input={activeRegistrationId:null,revision:0,appId,configId:'10002',appSecret,activate:true,enabled:true,declaredMode:'development' as const};
   await assert.rejects(saveMetaApp(owner,input),fails(403));let state=await saveMetaApp(operator,input);assert.ok(state.registration);const reg=state.registration.id;
   assert.equal((await getMetaApp(viewer)).registration,null);assert.equal((await getMetaApp(viewer)).registrations.length,0);assert.ok(!JSON.stringify(state).includes(appSecret));
   assert.equal((await getMetaApp(operator,new URLSearchParams({appId}))).registration!.id,reg);assert.equal((await getMetaApp(operator,new URLSearchParams({appId:'99999'}))).registration,null);
   await assert.rejects(getMetaApp(viewer,new URLSearchParams({appId})),fails(403));await assert.rejects(getMetaApp(operator,new URLSearchParams({appId,registrationId:reg})),fails(400));
   await assert.rejects(saveMetaApp(operator,{...input,appSecret:'bad\nsecret'}),fails(400));
   const stable=await withMetaRegistration(reg,async(_c,a,s)=>({hash:metaSubjectHash(s,subject),cipher:a.encrypted_config,credential:a.credential_revision}));
   await disableMetaApp(operator,reg,{revision:state.registration.revision});const disabled=await withMetaRegistration(reg,async(_c,a,s)=>({hash:metaSubjectHash(s,subject),cipher:a.encrypted_config,credential:a.credential_revision}));assert.deepEqual(disabled,stable,'Disabling must not invalidate verifier AAD.');
   state=await getMetaApp(operator);state=await saveMetaApp(operator,{...input,activeRegistrationId:reg,revision:state.registration!.revision,appSecret:undefined});assert.equal(calls,0);
   console.log('PASS Meta operator separation, secret-free overview and verifier revision independence');

   const first=await begin();await assert.rejects(startMetaConnect(project,session,first.input),fails(409));await assert.rejects(startMetaConnect(project,{...session,user:{id:viewer}},{requestId:randomUUID(),name:'Denied'}),fails(404));
   assert.match((await finish(first,'' )).headers.get('location')??'',/#meta=failed/);assert.equal(calls,0);
   const badBrowser=cookies().replace(/ten98\.meta\.[^=;]+=[^;]+/,'ten98.meta.wrong=wrong');assert.match((await finish(first,badBrowser)).headers.get('location')??'',/#meta=failed/);assert.equal(calls,0);
   const block=latch();gate={route:'/oauth/access_token',latch:block};const pending=finish(first);await reached(block.entered);assert.match((await finish(first)).headers.get('location')??'',/#meta=failed/);block.release();assert.match((await pending).headers.get('location')??'',/#meta=connected/);
   const previousCalls=calls;assert.match((await finish(first)).headers.get('location')??'',/#meta=failed/);assert.equal(calls,previousCalls);
   const f=(await pool.query('SELECT * FROM meta_oauth_flow WHERE state_hash IS NULL AND phase=\'completed\'')).rows[0];assert.equal(f.subject_hash,stable.hash);assert.equal(f.session_id,null);assert.equal(f.browser_hash,null);assert.equal(f.name,null);assert.notEqual(f.subject_hash,subject);
   for(const bad of ['wrong_app','system','scope','zero_access']){mode=bad;const attempt=await begin();assert.match((await finish(attempt)).headers.get('location')??'',/#meta=failed/);}mode='normal';
   console.log('PASS Meta browser/session/state binding, single-use exchange and rejected grant claims');

   let current=(await getMetaConnection(project,owner,f.connection_id)).connection;const revisionBefore=current.revision,inspections=inspectCalls;
   const page=await listMetaAccounts(project,owner,current.id,{revision:current.revision});assert.equal(page.accounts[0].id,'30001');assert.ok(page.nextCursor);assert.ok(!page.nextCursor.includes('opaque-provider-page'));
   const next=await listMetaAccounts(project,owner,current.id,{revision:current.revision,cursor:page.nextCursor});assert.equal(next.accounts[0].id,'30002');assert.equal(next.complete,true);
   await assert.rejects(listMetaAccounts(project,viewer,current.id,{revision:current.revision}),fails(404));await assert.rejects(listMetaAccounts(foreignProject,owner,current.id,{revision:current.revision}),fails(404));
   const preview=await inspectMetaAccount(project,owner,current.id,{revision:current.revision,accountId:'30001'});assert.equal(preview.account.id,'30001');assert.equal((await getMetaConnection(project,owner,current.id)).connection.revision,revisionBefore);assert.equal(inspectCalls-inspections,3,'Unknown data-access expiry is inspected for each account operation.');
   mode='huge_cursor';await assert.rejects(listMetaAccounts(project,owner,current.id,{revision:current.revision}),fails(502));mode='normal';
   const selectedInput={requestId:randomUUID(),revision:current.revision,accountId:'30001'},selected=await selectMetaAccount(project,owner,current.id,selectedInput);current=selected.connection;assert.equal(current.status,'ready');assert.equal(selected.acknowledgement.selectedAccountId,'30001');
   const receipt=(await pool.query('SELECT result FROM project_content_request WHERE request_id=$1',[selectedInput.requestId])).rows[0].result;assert.deepEqual(receipt,{connectionId:current.id,revision:current.revision});
   const beforeReplay=calls;assert.deepEqual((await selectMetaAccount(project,owner,current.id,selectedInput)).acknowledgement,selected.acknowledgement);assert.equal(calls,beforeReplay);await assert.rejects(selectMetaAccount(project,owner,current.id,{...selectedInput,accountId:'30002'}),fails(409));await assert.rejects(inspectMetaAccount(project,owner,current.id,{revision:current.revision,accountId:'30002'}),fails(409));
   await assert.rejects(listMetaAccounts(project,owner,current.id,{revision:current.revision,cursor:page.nextCursor}),fails(400));
   const reconnect=await begin(current.id,current.revision);assert.match((await finish(reconnect)).headers.get('location')??'',/#meta=connected/);current=(await getMetaConnection(project,owner,current.id)).connection;assert.equal(current.account?.id,'30001');assert.equal((await selectMetaAccount(project,owner,current.id,selectedInput)).connection.revision,current.revision);
   console.log('PASS Meta paged/direct account reads, immutable selection acknowledgement and same-account reconnect');

   const expiryGate=latch(),realNow=Date.now;mode='short_inspection';gate={route:'/act_30001',latch:expiryGate};const expiredRead=assert.rejects(inspectMetaAccount(project,owner,current.id,{revision:current.revision,accountId:'30001'}),fails(409));
   try{await reached(expiryGate.entered);const advanced=realNow()+20000;Date.now=()=>advanced;expiryGate.release();await expiredRead;}finally{Date.now=realNow;mode='normal';}
   const hold=latch();gate={route:'/act_30001',latch:hold};const denied=assert.rejects(inspectMetaAccount(project,owner,current.id,{revision:current.revision,accountId:'30001'}),fails(404));await reached(hold.entered);await role('viewer');hold.release();await denied;await role('owner');
   const rotate=latch();gate={route:'/me/permissions',latch:rotate};const changedCallback=finish(await begin());await reached(rotate.entered);state=await getMetaApp(operator);activeSecret=randomBytes(24).toString('base64url');await saveMetaApp(operator,{...input,activeRegistrationId:reg,revision:state.registration!.revision,appSecret:activeSecret});rotate.release();assert.match((await changedCallback).headers.get('location')??'',/#meta=failed/);assert.equal(await withMetaRegistration(reg,async(_c,_a,s)=>metaSubjectHash(s,subject)),stable.hash);
   assert.equal((await getMetaConnection(project,owner,current.id)).connection.status,'reconnect');assert.match((await finish(await begin(current.id,current.revision))).headers.get('location')??'',/#meta=connected/);current=(await getMetaConnection(project,owner,current.id)).connection;
   console.log('PASS Meta no-lock provider waits with fresh role and app-revision publication fences');

   const revoke=latch();gate={route:'/me/permissions',latch:revoke};const disconnectInput={requestId:randomUUID(),revision:current.revision,revokeAtMeta:true},lostRole=assert.rejects(disconnectMeta(project,owner,current.id,disconnectInput),fails(404));await reached(revoke.entered);assert.equal((await pool.query('SELECT encrypted_token FROM meta_connection WHERE id=$1',[current.id])).rows[0].encrypted_token,null);await role('viewer');revoke.release();await lostRole;await role('owner');const revocations=revokeCalls;assert.equal((await disconnectMeta(project,owner,current.id,disconnectInput)).remoteRevocation,'unconfirmed');assert.equal(revokeCalls,revocations);
   assert.equal((await selectMetaAccount(project,owner,current.id,selectedInput)).connection.status,'disconnected');current=(await getMetaConnection(project,owner,current.id)).connection;assert.match((await finish(await begin(current.id,current.revision))).headers.get('location')??'',/#meta=connected/);current=(await getMetaConnection(project,owner,current.id)).connection;
   await pool.query("UPDATE meta_connection SET encrypted_token='{}' WHERE id=$1",[current.id]);assert.equal((await disconnectMeta(project,owner,current.id,{requestId:randomUUID(),revision:current.revision,revokeAtMeta:true})).remoteRevocation,'unconfirmed');assert.equal(revokeCalls,revocations);
   console.log('PASS Meta local erasure survives unreadable credentials and remote-ack role loss without retry');

   const waiting=await begin(),fence=latch();gate={route:'/oauth/access_token',latch:fence};const covered=finish(waiting);await reached(fence.entered);const deletionId=randomUUID(),code=randomBytes(32).toString('base64url');
   await withMetaRegistration(reg,async(client,app,secrets)=>{const epoch=(await client.query('UPDATE meta_app_registration SET lifecycle_epoch=lifecycle_epoch+1 WHERE id=$1 RETURNING lifecycle_epoch',[app.id])).rows[0].lifecycle_epoch;await client.query(`INSERT INTO meta_deletion_request(id,registration_id,payload_digest,subject_hash,fence_epoch,confirmation_hash,encrypted_confirmation) VALUES($1,$2,$3,$4,$5,$6,$7)`,[deletionId,app.id,hash('synthetic-deletion'),metaSubjectHash(secrets,subject),epoch,hash(code),encryptCredentials({code},metaDeletionContext({id:deletionId,registration_id:app.id}))]);});
   fence.release();assert.match((await covered).headers.get('location')??'',/#meta=failed/);assert.equal((await getMetaConnection(project,owner,current.id)).connection.status,'deleted');
   await pool.query("UPDATE meta_deletion_request SET status='local_deleted',local_deleted_at=clock_timestamp() WHERE id=$1",[deletionId]);const newGrant=await connect();assert.equal(newGrant.status,'select_account');assert.equal((await getMetaConnection(project,owner,current.id)).connection.account,null);assert.equal((await getMetaConnection(project,owner,newGrant.id)).connection.status,'select_account');
   await rotateMetaCredentials();await assertMetaCredentialsReadable();assert.equal(await withMetaRegistration(reg,async(_c,_a,s)=>metaSubjectHash(s,subject)),stable.hash);
   const oldGrant=(await pool.query("SELECT count(*)::int AS n FROM meta_oauth_flow WHERE phase='completed'")).rows[0].n;await pool.query("UPDATE meta_oauth_flow SET expires_at=clock_timestamp()-interval '1 day'");await expireMetaFlows();assert.equal((await pool.query("SELECT count(*)::int AS n FROM meta_oauth_flow WHERE phase='completed'")).rows[0].n,oldGrant);
   console.log('PASS Meta deletion epoch fences in-flight/old grants and preserves later consent plus historical provenance');

   const original=(await pool.query('SELECT * FROM meta_connection WHERE id=$1',[newGrant.id])).rows[0],grant=(await pool.query('SELECT * FROM meta_oauth_flow WHERE id=$1',[original.current_grant_id])).rows[0];
   for(let index=0;index<51;index++){const cid=randomUUID(),gid=randomUUID();await pool.query(`INSERT INTO meta_connection(id,workspace_id,project_id,name,status,revision,encrypted_token,created_at) VALUES($1,$2,$3,'Pagination fixture','disconnected',1,NULL,'2020-01-01T00:00:00Z'::timestamptz+$4::int*interval '1 microsecond')`,[cid,workspace,project,index]);await pool.query(`INSERT INTO meta_oauth_flow(id,registration_id,app_revision,start_epoch,workspace_id,project_id,connection_id,phase,subject_hash,granted_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8,clock_timestamp(),clock_timestamp())`,[gid,reg,grant.app_revision,grant.start_epoch,workspace,project,cid,grant.subject_hash]);await pool.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[cid,gid]);}
   let cursor:string|null=null;const seen=new Set<string>();do{const page=await listMetaConnections(project,viewer,new URLSearchParams(cursor?{cursor}:{}));for(const c of page.connections){assert.ok(!seen.has(c.id));seen.add(c.id);}cursor=page.nextCursor;}while(cursor);assert.equal(seen.size,(await pool.query('SELECT count(*)::int AS n FROM meta_connection WHERE project_id=$1',[project])).rows[0].n);
   const firstPage=await listMetaConnections(project,owner);assert.ok(firstPage.nextCursor);await assert.rejects(listMetaConnections(foreignProject,owner,new URLSearchParams({cursor:firstPage.nextCursor})),fails(400));
   const api=(path:string,method='GET',body?:unknown,origin=config.appUrl)=>handleApi(new Request(config.appUrl+path,{method,headers:{cookie:cookies(),origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
   const base=`/api/projects/${project}/meta`,apiList=await api(base);assert.equal(apiList.status,200);assert.equal(apiList.headers.get('cache-control'),'no-store');assert.equal((await api(base+'?unknown=1')).status,400);
   assert.equal((await api(base+'/connections/'+newGrant.id+'/inspect','GET')).status,405);assert.equal((await api(base+'/connections/'+newGrant.id+'/inspect','POST',{revision:newGrant.revision,accountId:'30001'},'https://foreign.invalid')).status,403);
   assert.equal((await api('/api/meta/app','POST',input)).status,403);await role('viewer');assert.equal((await api(base+'/connections/'+newGrant.id+'/inspect','POST',{revision:newGrant.revision,accountId:'30001'})).status,404);assert.equal((await api(base)).status,200);await role('owner');
   assert.ok(!JSON.stringify(await(await api(base)).json()).includes(accessToken));assert.equal((await api('/api/meta/callback','POST',{})).status,405);
   state=await getMetaApp(operator);const originalAppRevision=state.registration!.revision;
   const other=await saveMetaApp(operator,{...input,activeRegistrationId:reg,appId:'11001',appSecret:'synthetic-other-app-secret',activate:false});assert.equal(other.activeRegistrationId,reg);assert.equal(other.registration!.active,false);const otherId=other.registration!.id;
   const otherSwitched=await saveMetaApp(operator,{...input,activeRegistrationId:reg,appId:'11001',revision:other.registration!.revision,appSecret:undefined,activate:true});assert.equal(otherSwitched.activeRegistrationId,otherId);
   const retired=await getMetaApp(operator,new URLSearchParams({registrationId:reg}));assert.equal(retired.registration!.revision,originalAppRevision+1);
   const rotatedInactive=await saveMetaApp(operator,{...input,activeRegistrationId:otherId,revision:retired.registration!.revision,appSecret:'synthetic-rotated-retired-secret',activate:false});assert.equal(rotatedInactive.activeRegistrationId,otherId);assert.equal(rotatedInactive.registration!.active,false);assert.equal(await withMetaRegistration(reg,async(_c,_a,s)=>metaSubjectHash(s,subject)),stable.hash);
   await saveMetaApp(operator,{...input,activeRegistrationId:otherId,revision:rotatedInactive.registration!.revision,appSecret:activeSecret,activate:true});
   const disconnectAck=await disconnectMeta(project,owner,newGrant.id,{requestId:randomUUID(),revision:newGrant.revision,revokeAtMeta:false});assert.equal(disconnectAck.acknowledgement.connectionId,newGrant.id);assert.equal(disconnectAck.acknowledgement.revision,newGrant.revision);assert.equal(disconnectAck.acknowledgement.revokeAtMeta,false);
   const disconnected=(await getMetaConnection(project,owner,newGrant.id)).connection;assert.match((await finish(await begin(disconnected.id,disconnected.revision))).headers.get('location')??'',/#meta=connected/);
   await quarantineMetaConnections();assert.equal((await getMetaApp(operator)).enabled,false);assert.equal((await getMetaConnection(project,owner,newGrant.id)).connection.status,'reconnect');assert.equal(unexpected,0);
   console.log('PASS Meta exact microsecond pagination, tenant cursor, real API guards and offline restore quarantine');
   await pool.query('UPDATE meta_app_registration SET revision=2147483647,enabled=true WHERE id=$1',[reg]);await pool.query('UPDATE meta_connection SET revision=2147483647 WHERE id=$1',[newGrant.id]);
   assert.equal((await disconnectMeta(project,owner,newGrant.id,{requestId:randomUUID(),revision:2147483647,revokeAtMeta:true})).remoteRevocation,'unconfirmed');assert.equal((await pool.query('SELECT revision,encrypted_token FROM meta_connection WHERE id=$1',[newGrant.id])).rows[0].encrypted_token,null);
   await disableMetaApp(operator,reg,{revision:2147483647});await quarantineMetaConnections();assert.equal((await pool.query('SELECT revision,enabled FROM meta_app_registration WHERE id=$1',[reg])).rows[0].revision,2147483647);
   console.log('PASS Meta revocation and restore remain available at the revision cap');
  });
 }finally{globalThis.fetch=originalFetch;}
}
if(process.env.TEN98_META_AUTH_TEST==='1')runMetaAuthChecks().then(()=>closeDatabase()).catch(async error=>{console.error(error instanceof Error?error.message:'Meta auth acceptance failed.');await closeDatabase();process.exitCode=1;});
