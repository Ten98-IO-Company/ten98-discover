import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {FoundationError,getAuth} from '../src/server/auth.ts';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {acceptMetaDeletion} from '../src/server/meta-callbacks.ts';
import {withMetaTransportForTests} from '../src/server/meta-http.ts';
import {disableMetaApp,disconnectMeta,getMetaApp,getMetaConnection,inspectMetaReportSource,metaCallback,prepareMetaReportSource,saveMetaApp,selectMetaAccount,startMetaConnect,withMetaReportSource,type MetaReportSource,type MetaSession} from '../src/server/meta-auth.ts';

// No worker starts. Every grant is created through actual consent/account services;
// every provider request is contained, including assertion-failure cleanup.
const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
function latch(){let enter!:()=>void,release=()=>{};return {entered:new Promise<void>(r=>enter=r),release:()=>release(),hold:async()=>{enter();await new Promise<void>(r=>release=r);}};}
const reached=(wait:Promise<void>)=>Promise.race([wait,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Expected synthetic inspection was not reached.')),5000).unref())]);

export async function runMetaReportAuthChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_META_AUTH_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_meta_auth_reports_ci';
 assert.ok(local.includes(url.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_meta_auth_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh empty owned fixture.');
 const originalFetch=globalThis.fetch;let unexpected=0;globalThis.fetch=async()=>{unexpected++;throw new Error('Live traffic is forbidden in report source acceptance.');};
 const owner=randomUUID(),viewer=randomUUID(),operator=randomUUID(),workspace=randomUUID(),project=randomUUID(),foreignProject=randomUUID();
 const password=randomBytes(24).toString('base64url'),appSecret=randomBytes(24).toString('base64url'),token=randomBytes(24).toString('base64url');
 const appId='100001',subject='200001';let nextAccount=300001,known=false,debugPatch:Record<string,unknown>={},permission='granted';
 const requests:string[]=[],jar=new Map<string,string>();let held:null|{path:string;gate:ReturnType<typeof latch>}=null,session:MetaSession,registrationId:string;
 const account=(id:string)=>({id:'act_'+id,account_id:id,name:'Synthetic source',currency:'AED',timezone_name:'Asia/Dubai',account_status:1});
 const send=async(raw:string,init:RequestInit)=>{
  const url=new URL(raw);assert.equal(url.origin,'https://graph.facebook.com');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');requests.push(url.pathname);
  let data:unknown;
  if(url.pathname.endsWith('/oauth/access_token')){assert.equal(url.searchParams.get('client_secret'),appSecret);data={access_token:token,token_type:'Bearer',expires_in:3600};}
  else if(url.pathname.endsWith('/debug_token')){assert.equal(url.searchParams.get('access_token'),appId+'|'+appSecret);data={data:{app_id:appId,user_id:subject,type:'USER',is_valid:true,scopes:['ads_read'],expires_at:Math.floor(Date.now()/1000)+3600,data_access_expires_at:known?Math.floor(Date.now()/1000)+7200:0,...debugPatch}};}
  else{
   assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+token);
   assert.equal(url.searchParams.get('appsecret_proof'),createHmac('sha256',appSecret).update(token).digest('hex'));
   if(url.pathname.endsWith('/me/permissions')){assert.equal(init.method,'GET');data={data:[{permission:'ads_read',status:permission}]};}
   else if(/\/act_[1-9][0-9]*$/.test(url.pathname))data=account(url.pathname.split('_').at(-1)!);
   else assert.fail('Unexpected provider endpoint in source-gate acceptance.');
  }
  // Capture the provider answer before pausing, so elapsed-time tests cannot renew it.
  if(held&&url.pathname.endsWith(held.path)){const current=held;held=null;await current.gate.hold();}
  return Response.json(data);
 };
 const cookie=()=>[...jar].map(([k,v])=>k+'='+v).join('; ');
 function saveCookie(value:string){const [key,...parts]=value.split(';')[0].split('=');jar.set(key,parts.join('='));}
 async function begin(connectionId?:string,revision?:number){
  const value=await startMetaConnect(project,session,{requestId:randomUUID(),name:'Report fixture source',...(connectionId?{connectionId,revision}:{})});saveCookie(value.cookie);
  const state=new URL(value.authorizationUrl).searchParams.get('state')!;
  const flowId=(await pool.query('SELECT id FROM meta_oauth_flow WHERE state_hash=$1',[createHash('sha256').update(state).digest('hex')])).rows[0].id as string;
  return {state,flowId};
 }
 async function finish(start:Awaited<ReturnType<typeof begin>>){
  const response=await metaCallback(new Request(config.appUrl+'/api/meta/callback?'+new URLSearchParams({state:start.state,code:'synthetic-code'}),{headers:{cookie:cookie()}}));
  assert.match(response.headers.get('location')??'',/#meta=connected/);
  const id=(await pool.query('SELECT connection_id FROM meta_oauth_flow WHERE id=$1',[start.flowId])).rows[0].connection_id;
  return(await getMetaConnection(project,owner,id)).connection;
 }
 async function connect(select=true,dataExpiryKnown=false){
  known=dataExpiryKnown;debugPatch={};permission='granted';const row=await finish(await begin());
  return select?(await selectMetaAccount(project,owner,row.id,{requestId:randomUUID(),revision:row.revision,accountId:String(nextAccount++)})).connection:row;
 }
 async function prepare(row:{id:string;revision:number}){return prepareMetaReportSource(project,owner,row.id,row.revision);}
 async function role(value:'owner'|'viewer'){
  const client=await pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='500ms'");await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);await client.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[workspace,owner,value]);await client.query('COMMIT');}finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
 }
 async function proveUnlocked(source:MetaReportSource){
  const client=await pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='500ms'");
   for(const [table,id]of [['meta_app_registration',source.app.id],['workspace',workspace],['project',project],['meta_connection',source.row.id]])await client.query('SELECT id FROM '+table+' WHERE id=$1 FOR UPDATE',[id]);
   await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
 }
 async function staleRace(source:MetaReportSource,path:string,change:()=>Promise<unknown>,status:number){
  const gate=latch();held={path,gate};let committed=false;
  const pending=assert.rejects(inspectMetaReportSource(source,owner),fail(status));
  try{await reached(gate.entered);await proveUnlocked(source);await change();}
  finally{gate.release();await pending;}
  await assert.rejects(withMetaReportSource(source,owner,async()=>{committed=true;}),fail(status));assert.equal(committed,false);
 }
 const appInput={activeRegistrationId:null as string|null,revision:0,appId,configId:'100002',appSecret,activate:true,enabled:true,declaredMode:'development' as const};
 try{
  for(const uid of [owner,viewer,operator])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Report source fixture\',$2)',[uid,uid+'@integration.test']);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
  await pool.query("INSERT INTO instance_operator(user_id,source) VALUES($1,'host')",[operator]);
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Report auth fixture')",[workspace]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')",[workspace,owner,viewer]);
  for(const id of [project,foreignProject])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Report auth fixture',$3,$4,'infinity')",[id,workspace,'https://'+id+'.example.test',randomUUID()]);
  const login=await getAuth().handler(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:owner+'@integration.test',password})}));assert.equal(login.status,200);for(const value of login.headers.getSetCookie())saveCookie(value);
  const signed=await getAuth().api.getSession({headers:new Headers({cookie:cookie()})});assert.ok(signed);session=signed;
  await withMetaTransportForTests(send,async()=>{
   const app=await saveMetaApp(operator,appInput);assert.ok(app.registration);registrationId=app.registration.id;
   const unselected=await connect(false),row=await connect(),source=await prepare(row),before=requests.length;
   await assert.rejects(prepare(unselected),fail(409));await assert.rejects(prepareMetaReportSource(project,viewer,row.id,row.revision),fail(404));
   await assert.rejects(prepareMetaReportSource(foreignProject,owner,row.id,row.revision),fail(404));await assert.rejects(prepareMetaReportSource(project,owner,row.id,row.revision+1),fail(409));
   await assert.rejects(prepareMetaReportSource(project,owner,row.id,0),fail(400));assert.equal(requests.length,before);
   let invoked=false;await assert.rejects(withMetaReportSource(source,viewer,async()=>{invoked=true;}),fail(404));assert.equal(invoked,false);
   assert.deepEqual(source.account,{id:row.account!.id,name:'Synthetic source',currency:'AED',timeZone:'Asia/Dubai',status:1});
   console.log('PASS report gate requires selected source, exact revision and current project owner before sending');

   const knownSource=await prepare(await connect(true,true));let at=requests.length;await inspectMetaReportSource(knownSource,owner);assert.equal(requests.length,at);
   const unknown=await prepare(await connect());at=requests.length;await inspectMetaReportSource(unknown,owner);assert.deepEqual(requests.slice(at),['/v26.0/debug_token','/v26.0/me/permissions']);
   assert.ok(unknown.operationExpiresAt!<=unknown.flow.access_expires_at!.getTime());
   const prior=(await pool.query('SELECT name FROM project WHERE id=$1',[project])).rows[0].name;
   await assert.rejects(withMetaReportSource(unknown,owner,async(client)=>{await client.query("UPDATE project SET name='Must roll back' WHERE id=$1",[project]);throw new Error('synthetic rollback');}),/synthetic rollback/);
   assert.equal((await pool.query('SELECT name FROM project WHERE id=$1',[project])).rows[0].name,prior);
   assert.equal(await withMetaReportSource(unknown,owner,async(_client,current)=>current.id),unknown.row.id);
   await pool.query("UPDATE meta_connection SET currency='USD' WHERE id=$1",[unknown.row.id]);await assert.rejects(withMetaReportSource(unknown,owner,async()=>{}),fail(409));await pool.query("UPDATE meta_connection SET currency='AED' WHERE id=$1",[unknown.row.id]);
   console.log('PASS known and unknown expiry paths, captured account metadata and transaction rollback');

   for(const patch of [{expires_at:'bad'},{expires_at:-1},{expires_at:Math.floor(Date.now()/1000)-1},{data_access_expires_at:Math.floor(Date.now()/1000)-1},{app_id:'999'},{user_id:'999'},{scopes:[]}]){
    debugPatch=patch;const snapshot=await prepare(row);await assert.rejects(inspectMetaReportSource(snapshot,owner),error=>fail(409)(error)||fail(502)(error));
   }
   debugPatch={};permission='declined';await assert.rejects(inspectMetaReportSource(await prepare(row),owner),fail(409));permission='granted';
   const snapshot=await prepare(row),originalDeadline=snapshot.flow.access_expires_at!.getTime();debugPatch={expires_at:Math.floor(Date.now()/1000)+7200};await inspectMetaReportSource(snapshot,owner);assert.ok(snapshot.operationExpiresAt!<=originalDeadline);
   debugPatch={expires_at:Math.floor(Date.now()/1000)+10};const short=await prepare(row);await inspectMetaReportSource(short,owner);assert.ok(short.operationExpiresAt!<originalDeadline);
   const now=Date.now;try{Date.now=()=>short.operationExpiresAt!+1;const count=requests.length;await assert.rejects(withMetaReportSource(short,owner,async()=>{}),fail(409));await assert.rejects(inspectMetaReportSource(short,owner),fail(409));assert.equal(requests.length,count);}finally{Date.now=now;debugPatch={};}
   console.log('PASS malformed/expired inspections fail and learned deadlines never extend the captured token');

   const guarded=await prepare(row),importGate=latch();held={path:'/debug_token',gate:importGate};at=requests.length;
   const importCancelled=assert.rejects(inspectMetaReportSource(guarded,owner,async client=>{
    const row=(await client.query('SELECT name FROM project WHERE id=$1',[project])).rows[0];
    if(row.name!=='Report auth fixture')throw new FoundationError(409,'Synthetic import fence changed.');
   }),fail(409));
   try{await reached(importGate.entered);await pool.query("UPDATE project SET name='Synthetic cancelled import fence' WHERE id=$1",[project]);importGate.release();await importCancelled;assert.deepEqual(requests.slice(at),['/v26.0/debug_token']);}
   finally{importGate.release();await pool.query("UPDATE project SET name='Report auth fixture' WHERE id=$1",[project]);}
   at=requests.length;await assert.rejects(inspectMetaReportSource(await prepare(row),owner,async()=>{throw new FoundationError(409,'Synthetic already-cancelled import.');}),fail(409));assert.equal(requests.length,at);
   console.log('PASS caller import fence is checked in SQL before inspection and between provider requests');

   const heldExpiry=await prepare(row),gate=latch(),clock=Date.now;debugPatch={expires_at:Math.floor(Date.now()/1000)+10};held={path:'/debug_token',gate};at=requests.length;
   const expiresBeforePermissions=assert.rejects(inspectMetaReportSource(heldExpiry,owner),fail(409));
   try{await reached(gate.entered);await proveUnlocked(heldExpiry);const advanced=clock()+20_000;Date.now=()=>advanced;gate.release();await expiresBeforePermissions;assert.deepEqual(requests.slice(at),['/v26.0/debug_token']);}finally{Date.now=clock;debugPatch={};gate.release();}
   const demoted=await prepare(row);at=requests.length;await staleRace(demoted,'/debug_token',()=>role('viewer'),404);assert.deepEqual(requests.slice(at),['/v26.0/debug_token']);await role('owner');
   const disconnected=await prepare(await connect());await staleRace(disconnected,'/me/permissions',()=>disconnectMeta(project,owner,disconnected.row.id,{requestId:randomUUID(),revision:disconnected.row.revision,revokeAtMeta:false}),409);
   console.log('PASS no network-spanning SQL locks; expiry/demotion stop the next request and disconnect fences publication');

   const disabled=await prepare(await connect());at=requests.length;await staleRace(disabled,'/debug_token',()=>disableMetaApp(operator,registrationId,{revision:disabled.app.revision}),409);assert.deepEqual(requests.slice(at),['/v26.0/debug_token']);
   const disabledApp=await getMetaApp(operator);await saveMetaApp(operator,{...appInput,activeRegistrationId:registrationId,revision:disabledApp.registration!.revision,appSecret:undefined});
   const reconnected=await prepare(await connect());await staleRace(reconnected,'/me/permissions',async()=>finish(await begin(reconnected.row.id,reconnected.row.revision)),409);
   const current=(await getMetaConnection(project,owner,reconnected.row.id)).connection;assert.ok(current.revision>reconnected.row.revision);await inspectMetaReportSource(await prepare(current),owner);
   console.log('PASS app disable and same-account reconnect invalidate old report grant snapshots');

   const deleted=await prepare(await connect());const payload=Buffer.from(JSON.stringify({algorithm:'HMAC-SHA256',user_id:subject})).toString('base64url');const signed=createHmac('sha256',appSecret).update(payload).digest('base64url')+'.'+payload;
   at=requests.length;await staleRace(deleted,'/debug_token',()=>acceptMetaDeletion(registrationId,signed),409);assert.deepEqual(requests.slice(at),['/v26.0/debug_token']);
   await assert.rejects(prepare({id:deleted.row.id,revision:deleted.row.revision}),fail(409));assert.equal(unexpected,0);
   console.log('PASS signed deletion immediately fences retained and in-flight report source authority');
  });
 }finally{await closeDatabase();globalThis.fetch=originalFetch;}
}

if(process.env.TEN98_META_AUTH_TEST==='1')runMetaReportAuthChecks().catch(async error=>{console.error(error instanceof Error?error.message:'Meta report auth acceptance failed.');await closeDatabase();process.exitCode=1;});
