import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {handleApi} from '../src/server/api.ts';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {createWorkspace} from '../src/server/teams.ts';
import {googleScopes} from '../src/server/google-reports.ts';
import {googleConnectionContext,refreshGoogleConnection} from '../src/server/google.ts';
import {encryptCredentials,decryptCredentials} from '../src/server/credential-vault.ts';
import {withGoogleTransportForTests} from '../src/server/google-http.ts';
import {inspectGoogleUrls} from '../src/server/google-inspection.ts';
import {googleInspectionBatch} from '../src/server/google-inspection-input.ts';
import {createApiKey} from '../src/server/api-keys.ts';

/** Fresh owned fixture only. Real cookie/route/OAuth logic; Google transport is in-process synthetic data. */
export async function runGoogleInspectionChecks(capture?:(value:unknown)=>Promise<void>){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');const config=getConfig(),database=new URL(config.databaseUrl),ci=process.env.GITHUB_ACTIONS==='true',{pool}=getDatabase();
 if(ci){
  assert.equal(process.env.TEN98_ISOLATED_CI_DATABASE,'1');assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'5432');assert.equal(database.pathname,'/ten98_gsc_inspection_ci');assert.doesNotMatch(config.databaseUrl,/[?#]/);
 }else{
 assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'55501');assert.match(database.pathname,/^\/ten98_gsc_inspection_[a-f0-9]{12}$/);
 }
 assert.equal(new URL(config.appUrl).hostname,'127.0.0.1');
 await assertSchema();assert.equal((await pool.query('SELECT count(*)::int n FROM "user"')).rows[0].n,0);
 if(ci)assert.equal((await pool.query("UPDATE installation SET claimed=true WHERE id='instance' AND claimed=false")).rowCount,1);
 assert.equal((await pool.query("SELECT claimed FROM installation WHERE id='instance'")).rows[0].claimed,true,'Outer fixture must explicitly claim only its fresh installation.');
 const password=randomBytes(24).toString('base64url'),roles=['owner','admin','editor','viewer'] as const,actors:Record<string,{id:string;email:string;cookie:string}>={};
 for(const role of [...roles,'foreign']){const id=randomUUID(),email=`${id}@inspection.test`;await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,`Inspection ${role}`,email]);await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),id,await hashPassword(password)]);actors[role]={id,email,cookie:''};}
 const owner=actors.owner,{workspace}=await createWorkspace(owner.id,{name:'Inspection fixture'}),foreign=await createWorkspace(actors.foreign.id,{name:'Foreign inspection fixture'}),projectId=randomUUID(),otherProjectId=randomUUID(),foreignProject=randomUUID();
 for(const [id,ws] of [[projectId,workspace.id],[otherProjectId,workspace.id],[foreignProject,foreign.workspace.id]])await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)',[id,ws,'Inspection fixture',`https://${id}.test`,randomUUID()]);
 for(const role of roles.slice(1))await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace.id,actors[role].id,role]);
 await pool.query("INSERT INTO instance_operator(user_id,source) VALUES($1,'host')",[owner.id]);
 let http=0;
 async function call(path:string,body?:unknown,actor=owner,origin=config.appUrl,signal?:AbortSignal){
  http++;const headers=new Headers({cookie:actor.cookie});if(body!==undefined){headers.set('content-type','application/json');headers.set('origin',origin);}
  const response=await handleApi(new Request(config.appUrl+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal}));
  const cookies=response.headers.getSetCookie();if(cookies.length){const all=new Map(actor.cookie.split('; ').filter(Boolean).map(x=>{const at=x.indexOf('=');return [x.slice(0,at),x.slice(at+1)] as const;}));for(const value of cookies){const part=value.split(';')[0],at=part.indexOf('=');all.set(part.slice(0,at),part.slice(at+1));}actor.cookie=[...all].map(([k,v])=>`${k}=${v}`).join('; ');}
  assert.equal(response.headers.get('cache-control'),'no-store');const bytes=new Uint8Array(await response.arrayBuffer());assert.ok(bytes.length<=2_097_152);const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return {status:response.status,data};
 }
 for(const actor of Object.values(actors))assert.equal((await call('/api/auth/sign-in/email',{email:actor.email,password},actor)).status,200);
 const secret=randomBytes(24).toString('base64url'),access=randomBytes(24).toString('base64url');let refresh=randomBytes(24).toString('base64url'),mode='normal',calls=0,refreshes=0,inspections=0,streamAborts=0,bodyStarted=()=>{};
 const codes=new Map<string,{challenge:string;scope:string}>(),base=`/api/projects/${projectId}/google`;let connectionId='';
 const normal={inspectionResult:{inspectionResultLink:'https://search.google.com/search-console/inspect?resource_id=sc-domain%3Aexample.test',indexStatusResult:{verdict:'PASS',coverageState:'Indexed — عربي 😀',lastCrawlTime:'2026-10-01T01:02:03.123456789Z',googleCanonical:'https://example.test/canonical',sitemap:['https://example.test/sitemap.xml'],referringUrls:[]},ampResult:{verdict:'NEUTRAL',issues:[]},mobileUsabilityResult:{verdict:'VERDICT_UNSPECIFIED'},richResultsResult:{verdict:'FAIL',detectedItems:[{richResultType:'Product',items:[{name:'Native fixture',issues:[{severity:'ERROR',issueMessage:'Missing price'}]}]}]}}};
 const transport=async(url:string,init:RequestInit)=>{
  calls++;assert.equal(init.redirect,'error');assert.ok(init.signal);const parsed=new URL(url);
  if(parsed.hostname==='oauth2.googleapis.com'){
   assert.equal(parsed.pathname,'/token');const form=new URLSearchParams(String(init.body));assert.equal(form.get('client_secret'),secret);
   if(form.get('grant_type')==='authorization_code'){const code=codes.get(form.get('code')!);assert.ok(code);codes.delete(form.get('code')!);assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'),code.challenge);}
   else{refreshes++;assert.equal(form.get('refresh_token'),refresh);refresh=randomBytes(24).toString('base64url');}
   return Response.json({access_token:access,refresh_token:refresh,expires_in:3600,token_type:'Bearer',scope:googleScopes.gsc});
  }
  assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${access}`);
  if(parsed.hostname==='www.googleapis.com'){assert.equal(parsed.pathname,'/webmasters/v3/sites/sc-domain%3Aexample.test');return Response.json({siteUrl:'sc-domain:example.test',permissionLevel:'siteOwner'});}
  assert.equal(url,'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect');const body=JSON.parse(String(init.body));assert.deepEqual(Object.keys(body).sort(),['inspectionUrl','languageCode','siteUrl']);assert.equal(body.siteUrl,'sc-domain:example.test');inspections++;
  if(mode==='quota'&&body.inspectionUrl.endsWith('/quota'))return new Response('{}',{status:429});
  if(mode==='denied')return new Response('{}',{status:403});if(mode==='revoked')return new Response('{}',{status:401});if(mode==='down')return new Response('{}',{status:503});
   if(body.inspectionUrl.endsWith('/blocked')&&(mode==='denied-after-success'||mode==='revoked-after-success'))return new Response('{}',{status:mode==='denied-after-success'?403:401});
  if(mode==='malformed')return Response.json({inspectionResult:{indexStatusResult:{verdict:42}}});
  if(mode==='utf8')return new Response(new Uint8Array([123,34,120,34,58,34,255,34,125]));
  if(mode==='large')return Response.json({inspectionResult:{richResultsResult:{detectedItems:[{items:Array.from({length:300},()=>({name:'x'.repeat(4000)}))}]}}});
  if(mode==='empty')return Response.json({inspectionResult:{}});
  if(mode==='demote')await pool.query("UPDATE membership SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[workspace.id,owner.id]);
  if(mode==='session')await pool.query('DELETE FROM session WHERE "userId"=$1',[owner.id]);
  if(mode==='wait')return new Promise<Response>((_resolve,reject)=>{const abort=()=>reject(init.signal!.reason);if(init.signal!.aborted)abort();else init.signal!.addEventListener('abort',abort,{once:true});});
   // Match fetch's signal-bound body after headers, with a read stalled after a JSON prefix.
   if(mode==='stream')return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{"inspectionResult":'));init.signal!.addEventListener('abort',()=>{streamAborts++;controller.error(init.signal!.reason);},{once:true});},pull(){bodyStarted();}}));
  return Response.json(normal);
 };
 const snapshots:Record<string,unknown>={},groups:string[]=[];
 const pass=(name:string)=>{groups.push(name);console.log(`PASS ${name}`);};
 await withGoogleTransportForTests(transport,async()=>{
  assert.equal((await call('/api/google/app',{revision:0,clientId:'123-inspection.apps.googleusercontent.com',clientSecret:secret,enabled:true,testing:true})).status,200);
  const started=await call(`${base}/connect`,{provider:'gsc',name:'Inspection Search Console'});assert.equal(started.status,200);const auth=new URL(started.data.authorizationUrl),code=randomBytes(24).toString('base64url');codes.set(code,{challenge:auth.searchParams.get('code_challenge')!,scope:auth.searchParams.get('scope')!});
  const callback=await handleApi(new Request(config.appUrl+`/api/google/callback?state=${auth.searchParams.get('state')}&code=${code}`,{headers:{cookie:owner.cookie}}));assert.equal(callback.status,303);assert.match(callback.headers.get('location')!,/#google=connected/);
  connectionId=(await call(base)).data.connections[0].id;assert.equal((await call(`${base}/connections/${connectionId}/select`,{propertyId:'sc-domain:example.test'})).status,200);
  const path=`${base}/connections/${connectionId}/inspect`,input={urls:['https://example.test/a'],languageCode:'ar-AE'},before=calls;
  for(const role of roles.slice(1))assert.equal((await call(path,input,actors[role])).status,404);
  assert.equal((await call(path,input,actors.foreign)).status,404);assert.equal((await call(`/api/projects/${foreignProject}/google/connections/${connectionId}/inspect`,input)).status,404);
  assert.equal((await call(path,input,owner,'https://foreign.test')).status,403);
  for(const body of [{...input,siteUrl:'sc-domain:evil.test'},{urls:['https://example.test/a','https://evil.test/']}])assert.equal((await call(path,body)).status,400);
  assert.equal((await call(path+'?siteUrl=evil',input)).status,400);assert.equal(calls,before,'Every property/body/scope refusal precedes refresh and provider dispatch.');
  const key=await createApiKey(workspace.id,owner.id,{name:'Inspection denied bearer',scopes:['analytics:read'],expiresInDays:1});assert.equal((await handleApi(new Request(config.appUrl+path,{method:'POST',headers:{authorization:`Bearer ${key.token}`,'content-type':'application/json'},body:JSON.stringify(input)}))).status,403);await pool.query('UPDATE api_key SET revoked_at=now() WHERE id=$1',[key.key.id]);
  for(const [sql,status] of [["provider='ga4'",400],["status='select_property'",409],["scopes='[]'::jsonb",409]] as const){await pool.query(`UPDATE google_connection SET ${sql} WHERE id=$1`,[connectionId]);assert.equal((await call(path,input)).status,status);await pool.query("UPDATE google_connection SET provider='gsc',status='ready',scopes=$2 WHERE id=$1",[connectionId,JSON.stringify([googleScopes.gsc])]);}assert.equal(calls,before);
  await pool.query("UPDATE google_app SET enabled=false WHERE id='instance'");assert.equal((await call(path,input)).status,409);await pool.query("UPDATE google_app SET enabled=true WHERE id='instance'");
  await pool.query('UPDATE google_connection SET app_revision=app_revision+1 WHERE id=$1',[connectionId]);assert.equal((await call(path,input)).status,409);await pool.query('UPDATE google_connection SET app_revision=app_revision-1 WHERE id=$1',[connectionId]);assert.equal(calls,before);
  for(const role of roles)snapshots[`${role}Overview`]=(await call(base,undefined,actors[role])).data;
   snapshots.otherProjectOverview=(await call(`/api/projects/${otherProjectId}/google`)).data;assert.deepEqual((snapshots.otherProjectOverview as {connections:unknown[]}).connections,[]);
  snapshots.overview=(await call(base)).data;const first=await call(path,input);assert.equal(first.status,200);assert.deepEqual(googleInspectionBatch.parse(first.data).results[0].result,normal.inspectionResult);snapshots.complete=first.data;
  pass('real OAuth cookies, owner-only scope, complete indexed modules and no preflight dispatch on refusal');

  mode='quota';const partial=await call(path,{urls:['https://example.test/a','https://example.test/quota']});assert.equal(partial.status,200);assert.equal(partial.data.results[0].result.indexStatusResult.verdict,'PASS');assert.equal(partial.data.results[1].attempted,true);assert.equal(partial.data.results[1].result,null);snapshots.partial=partial.data;
  mode='empty';const empty=await call(path,input);assert.equal(empty.status,200);assert.deepEqual(empty.data.results[0].result,{});snapshots.empty=empty.data;
  for(mode of ['malformed','utf8']){const bad=await call(path,input);assert.equal(bad.status,200);assert.equal(bad.data.results[0].result,null);assert.equal(bad.data.results[0].attempted,true);}
  mode='large';const large=await call(path,{urls:['https://example.test/a','https://example.test/b']});assert.equal(large.status,503);assert.deepEqual(Object.keys(large.data),['error']);
  pass('partial quota, unavailable modules, malformed/UTF8 refusals and whole two-MiB capacity refusal');

  const row=()=>pool.query('SELECT * FROM google_connection WHERE id=$1',[connectionId]).then(r=>r.rows[0]);let saved=await row();
  await pool.query('UPDATE google_connection SET encrypted_tokens=$2 WHERE id=$1',[connectionId,encryptCredentials({accessToken:access,refreshToken:refresh,expiresAt:0},googleConnectionContext(saved))]);
  mode='down';const beforeRefresh=refreshes,rotated=await call(path,input);assert.equal(rotated.status,200);assert.equal(rotated.data.results[0].result,null);assert.equal(refreshes,beforeRefresh+1);assert.equal((decryptCredentials((await row()).encrypted_tokens,googleConnectionContext(saved)) as {refreshToken:string}).refreshToken,refresh);
  mode='normal';assert.equal((await call(path,input)).status,200);assert.equal(refreshes,beforeRefresh+1,'Downstream failure must not undo token rotation or cause an automatic refresh retry.');
  saved=await row();const priorCalls=calls;await assert.rejects(refreshGoogleConnection(projectId,owner.id,connectionId,undefined,{revision:saved.revision+1,appRevision:saved.app_revision,propertyId:saved.property_id}),e=>!!e&&typeof e==='object'&&'status'in e&&e.status===409);assert.equal(calls,priorCalls);
  await pool.query("UPDATE google_connection SET encrypted_tokens='{}'::jsonb WHERE id=$1",[connectionId]);assert.equal((await call(path,input)).status,503);assert.equal(calls,priorCalls);await pool.query('UPDATE google_connection SET encrypted_tokens=$2 WHERE id=$1',[connectionId,saved.encrypted_tokens]);
  mode='denied';const deniedBefore=inspections;assert.equal((await call(path,{urls:['https://example.test/a','https://example.test/b']})).status,409);assert.equal(inspections,deniedBefore+1);
  mode='revoked';const revokedBefore=inspections;assert.equal((await call(path,{urls:['https://example.test/a','https://example.test/b']})).status,409);assert.equal(inspections,revokedBefore+1);assert.equal((await row()).status,'reconnect');snapshots.reconnectOverview=(await call(base)).data;
  await pool.query("UPDATE google_connection SET status='ready' WHERE id=$1",[connectionId]);
   for(mode of ['denied-after-success','revoked-after-success']){const count=inspections,refused=await call(path,{urls:['https://example.test/a','https://example.test/blocked','https://example.test/b']});assert.equal(refused.status,409);assert.deepEqual(Object.keys(refused.data),['error'],'Authority loss must discard the earlier successful result.');assert.equal(inspections,count+2,'No URL after the denied URL may dispatch.');assert.equal((await row()).status,mode==='revoked-after-success'?'reconnect':'ready');if(mode==='revoked-after-success')await pool.query("UPDATE google_connection SET status='ready' WHERE id=$1",[connectionId]);}
  pass('separate refresh commit, expected binding, unavailable credentials and whole auth-loss refusal without later dispatch');

  mode='normal';const aborted=new AbortController();aborted.abort();let n=inspections;const unattempted=await inspectGoogleUrls(projectId,owner.id,connectionId,input,aborted.signal);assert.equal(inspections,n);assert.equal(unattempted.results[0].attempted,false);
  mode='wait';const cancel=new AbortController(),timer=setTimeout(()=>cancel.abort(),30);try{const interrupted=await inspectGoogleUrls(projectId,owner.id,connectionId,{urls:['https://example.test/a','https://example.test/b']},cancel.signal);assert.equal(interrupted.results[0].attempted,true);assert.equal(interrupted.results[1].attempted,false);assert.equal(inspections,n+1);snapshots.cancelled=interrupted;}finally{clearTimeout(timer);}
   mode='stream';n=inspections;const streamCancel=new AbortController(),opened=new Promise<void>(resolve=>{bodyStarted=()=>resolve();}),streamed=inspectGoogleUrls(projectId,owner.id,connectionId,{urls:['https://example.test/a','https://example.test/b']},streamCancel.signal);await Promise.race([opened,streamed.then(()=>assert.fail('The incomplete provider body must still be pending.'))]);streamCancel.abort();const interruptedBody=await streamed;assert.equal(streamAborts,1);assert.equal(inspections,n+1);assert.deepEqual(interruptedBody.results.map(x=>x.attempted),[true,false]);assert.ok(interruptedBody.results.every(x=>x.result===null));
   mode='wait';
  n=inspections;const began=Date.now(),deadline=await inspectGoogleUrls(projectId,owner.id,connectionId,{urls:['https://example.test/a','https://example.test/b','https://example.test/c']});assert.ok(Date.now()-began>=29_000&&Date.now()-began<33_000);assert.equal(inspections,n+2);assert.deepEqual(deadline.results.map(x=>x.attempted),[true,true,false]);snapshots.deadline=deadline;
  pass('real caller cancellation and unchanged15s/30s provider deadlines distinguish attempted from undispatched URLs');

  // Direct fixture SQL deliberately bypasses application workspace serialization; it tests the fresh publication gate, not a supported mutation race.
   mode='demote';n=inspections;assert.equal((await call(path,{urls:['https://example.test/a','https://example.test/b']})).status,404);assert.equal(inspections,n+1);snapshots.demotedOwnerOverview=(await call(base)).data;assert.equal((snapshots.demotedOwnerOverview as {role:string}).role,'admin');await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspace.id,owner.id]);
  mode='session';assert.equal((await call(path,input)).status,401);assert.equal((await call(path,input)).status,401);
  pass('current ownership between URLs and fresh cookie-session publication refuse discarded results');
 });
 assert.equal((await pool.query('SELECT count(*)::int n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int n FROM google_import')).rows[0].n,0);if((await pool.query("SELECT to_regclass('pgboss.job') AS relation")).rows[0].relation)assert.equal((await pool.query('SELECT count(*)::int n FROM pgboss.job')).rows[0].n,0);
 assert.ok((await pool.query("SELECT coalesce(max(count),0)::int n FROM request_limit WHERE key LIKE 'google:write:%'")).rows[0].n<=30);
 assert.equal((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND pid<>pg_backend_pid()")).rows[0].n,0);
 if(capture)await capture({scope:{projectId,otherProjectId,workspaceId:workspace.id,ownerId:owner.id,connectionId,users:Object.fromEntries(roles.map(role=>[role,actors[role].id]))},snapshots,groups,http,calls,inspections,refreshes,externalCalls:0});
 return {groups,http,calls,inspections,refreshes};
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/google-inspection-integration.ts')){
 try{await runGoogleInspectionChecks();}catch{console.error('Google inspection fixture failed; retain isolated evidence. No provider payload or credentials logged.');process.exitCode=1;}finally{await closeDatabase();}
}
