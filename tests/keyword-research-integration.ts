import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,stopJobs,startWorker} from '../src/server/jobs.ts';
import {saveProvider,saveProviderRequestControls,revokeProvider} from '../src/server/providers.ts';
import {keywordPayload,keywordEndpoints,keywordAccountEndpoint,keywordCatalogEndpoint,keywordReconcileEndpoint,type KeywordRequest} from '../src/server/keyword-research-input.ts';
import {refreshKeywordMarkets,prepareKeywordResearch,startKeywordResearch,executeKeywordResearch,getKeywordRun,getKeywordResearch,cancelKeywordResearch,recoverKeywordResearch,reconcileKeywordJobs} from '../src/server/keyword-research.ts';
import {runRetentionBatch} from '../src/server/retention.ts';
import {dataforseoRefusalMessage} from '../src/server/dataforseo-transport.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';

function assertNoApiMoney(value:unknown):void{
 if(!value||typeof value!=='object')return;
 const forbidden=new Set(['cost','price','balance','budget','actual_micros','estimate_micros','estimateUsd','actualUsd','estimateMicros','actualMicros','chargeStatus','spendingPaused','perTask','perItem','priceAsOf','priceSource','promptPrice','completionPrice','requestPrice','max_price','maxSpendUsd','fundedCredits']);
 for(const [key,item]of Object.entries(value)){assert.equal(forbidden.has(key),false,'Unexpected API financial field: '+key);assertNoApiMoney(item);}
}

export async function runKeywordResearchChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
 const config=getConfig();assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.databaseUrl).hostname));
 const pool=getDatabase().pool,owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),foreign=randomUUID();
 const password=randomBytes(32).toString('base64url');
 for(const user of [owner,editor,viewer,foreign])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Keyword fixture\',$2)',[user,`${user}@keywords.integration.test`]);
 await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
 const free=(result:unknown[])=>Response.json({status_code:20000,tasks_count:1,tasks:[{status_code:20000,result}]});
 const accountLogin='synthetic-provider@keywords.integration.test';
 let account=accountLogin,paidCalls=0,freeCalls=0,mode:'ok'|'unknown'|'over'|'invalid'|'error'|'pending'|'conflict'|'wallet_task'|'wallet_http'|'wallet_charged'='ok';
 const sentTags:string[]=[];
 const sentPayloads:Record<string,unknown>[]=[];
 // Region rows from the public Labs CSV dated 2026-09-01:
 // https://cdn.dataforseo.com/v3/locations/locations_and_languages_dataforseo_labs_2026_09_01.csv
 const catalogRows=[{location_code:2840,location_name:'United States',location_type:'Country',available_languages:[{language_code:'en',language_name:'English',available_sources:['google']}]},
  {location_code:2158,location_name:'Taiwan',location_type:'Region',available_languages:[{language_code:'zh-TW',language_name:'Chinese (Traditional)',available_sources:['google']}]},
  {location_code:2344,location_name:'Hong Kong',location_type:'Region',available_languages:[{language_code:'en',language_name:'English',available_sources:['google']},{language_code:'zh-TW',language_name:'Chinese (Traditional)',available_sources:['google']}]}];
 let reconcileItems:unknown[]=[];
 const send:typeof fetch=async(url,init)=>{
   assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);
   if(url===keywordAccountEndpoint){freeCalls++;return free([{login:account}]);}
   if(url===keywordCatalogEndpoint){freeCalls++;return free(catalogRows);}
   if(url===keywordReconcileEndpoint){freeCalls++;return free(reconcileItems);}
   assert.ok(Object.values(keywordEndpoints).includes(String(url) as any),'No non-allowlisted provider traffic.');paidCalls++;
   const data=JSON.parse(init?.body as string)[0];sentTags.push(data.tag);sentPayloads.push(data);
   if(mode==='unknown')throw new Error('Synthetic interrupted provider response.');
   // Provider refusals: task-level40210, HTTP402 and the same refusal carrying irrelevant billing metadata.
   if(mode==='wallet_task')return Response.json({status_code:20000,status_message:'Ok.',cost:0,tasks_count:1,tasks_error:1,tasks:[{id:'fixture-'+randomUUID(),status_code:40210,status_message:'Insufficient funds.',cost:0,path:new URL(String(url)).pathname.slice(1).split('/'),data,result_count:0,result:null}]});
   if(mode==='wallet_http')return Response.json({status_code:40200,status_message:'Payment Required.',cost:0,tasks_count:0,tasks_error:0,tasks:null},{status:402});
   if(mode==='wallet_charged')return Response.json({status_code:40210,status_message:'Insufficient funds.',cost:0.01,tasks_count:0,tasks_error:0,tasks:null});
   const cost=mode==='over'?'ignored-malformed-billing':undefined;
   return Response.json({status_code:20000,cost:mode==='conflict'?0:cost,tasks_count:1,tasks:[{id:'fixture-'+randomUUID(),status_code:mode==='error'?40501:mode==='pending'?40602:mode==='conflict'?29999:20000,cost,path:new URL(String(url)).pathname.slice(1).split('/'),data,result:[{se_type:'google',location_code:data.location_code,language_code:data.language_code,items_count:1,items:[{keyword:data.keywords[0],keyword_info:{search_volume:mode==='invalid'?-1:0,cpc:null,competition:null,monthly_searches:[]}}]}]}]});
 };
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Live provider traffic is forbidden in keyword tests.');};
 type Fixture={workspace:string;project:string;connectionId:string;request:KeywordRequest};
 async function fixture():Promise<Fixture>{
  const workspace=randomUUID(),project=randomUUID();await pool.query('INSERT INTO workspace(id,name) VALUES($1,\'Keyword integration\')',[workspace]);
  for(const [uid,role] of [[owner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,uid,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Keywords','https://'||$1||'.integration.test',$3,'infinity')",[project,workspace,randomUUID()]);
  const connection=(await saveProvider(workspace,owner,{provider:'dataforseo',name:'Synthetic only',credentials:{login:accountLogin,password:'synthetic-never-live'}})).connection;
  await saveProviderRequestControls(workspace,owner,{paused:false});
  await refreshKeywordMarkets(project,owner,{connectionId:connection.id},send);
  return {workspace,project,connectionId:connection.id,request:{connectionId:connection.id,mode:'overview',keywords:['example'],locationCode:2840,languageCode:'en',limit:100}};
 }
 const preparation=async(f:Fixture,user=owner)=>(await prepareKeywordResearch(f.project,user,f.request,send)).preparation;
 const start=async(f:Fixture,user=owner)=>startKeywordResearch(f.project,user,{preparationId:(await preparation(f,user)).id,requestKey:randomUUID()});
 async function requestReceipt(id:string){const row=(await pool.query('SELECT status,actual_micros,estimate_micros FROM provider_request WHERE id=$1',[id])).rows[0];assert.equal(row.actual_micros,null);assert.equal(row.estimate_micros,null);return row;}
 try{
  const f=await fixture();const calls=freeCalls;const state=await getKeywordResearch(f.project,viewer);assert.equal(state.role,'viewer');assert.equal(freeCalls,calls);assert.equal(paidCalls,0);
  await assert.rejects(prepareKeywordResearch(f.project,viewer,f.request,send),{status:404});await assert.rejects(getKeywordResearch(f.project,foreign),{status:404});
  const q=await preparation(f),key=randomUUID();assertNoApiMoney(q);assert.equal(paidCalls,0);
  assert.equal(q.upperItems,1);assert.equal((await pool.query('SELECT request_version FROM keyword_quote WHERE id=$1',[q.id])).rows[0].request_version,1);
  const legacyPreparation=await preparation(f);await pool.query('UPDATE keyword_quote SET request_version=0 WHERE id=$1',[legacyPreparation.id]);
  await assert.rejects(startKeywordResearch(f.project,owner,{preparationId:legacyPreparation.id,requestKey:randomUUID()}),{status:409});assert.equal((await pool.query('SELECT count(*)::int AS n FROM keyword_research_run WHERE quote_id=$1',[legacyPreparation.id])).rows[0].n,0);

  const [first,retry]=await Promise.all([startKeywordResearch(f.project,owner,{preparationId:q.id,requestKey:key}),startKeywordResearch(f.project,owner,{preparationId:q.id,requestKey:key})]);assert.equal(first.run.id,retry.run.id);
  const changed=await preparation(f);await assert.rejects(startKeywordResearch(f.project,owner,{preparationId:changed.id,requestKey:key}),{status:409});
  const otherActor=await preparation(f,editor);await assert.rejects(startKeywordResearch(f.project,editor,{preparationId:otherActor.id,requestKey:key}),{status:409});
  await assert.rejects(startKeywordResearch(f.project,owner,{preparationId:q.id,requestKey:randomUUID()}),{status:409});
  await Promise.all([executeKeywordResearch(first.run.id,send),executeKeywordResearch(first.run.id,send)]);assert.equal(paidCalls,1,'A run must dispatch once under concurrency.');
  const done=(await getKeywordRun(f.project,viewer,first.run.id)).run;assert.equal(done.status,'completed');assert.equal(done.result.rows[0].searchVolume,0);assertNoApiMoney(done);assert.equal((await requestReceipt(first.run.id)).status,'settled');
  await executeKeywordResearch(first.run.id,send);assert.equal(paidCalls,1);assert.equal((await startKeywordResearch(f.project,owner,{preparationId:q.id,requestKey:key})).run.id,first.run.id);
  const unknownProject=await fixture();await assert.rejects(getKeywordRun(unknownProject.project,owner,first.run.id),{status:404});
  console.log('PASS keyword preparation/actor/project ownership, idempotent queued start and single provider dispatch');

  // Owner decision D3 (slice C1): saved-refresh children are exempt from the dispatch-time preparation age, but a single keyword run keeps
  // the five-minute rule. Own fixture, so no later ledger total in this lane changes.
  const lone=await fixture(),loneQuote=await preparation(lone),loneRun=(await startKeywordResearch(lone.project,owner,{preparationId:loneQuote.id,requestKey:randomUUID()})).run,callsBeforeLone=paidCalls;
  await pool.query("UPDATE keyword_quote SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[loneQuote.id]);
  await reconcileKeywordJobs();
  assert.equal((await getKeywordRun(lone.project,owner,loneRun.id)).run.status,'cancelled','An expired single run is cancelled by the sweeper.');
  assert.equal((await requestReceipt(loneRun.id)).status,'cancelled','Its reservation is released.');
  assert.equal(paidCalls,callsBeforeLone,'An expired single run never dispatches.');
  console.log('PASS single keyword run keeps the five-minute preparation rule after Start: sweeper cancels, reservation released, no provider call');

  const expired=await preparation(f);await pool.query("UPDATE keyword_quote SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.id]);await assert.rejects(startKeywordResearch(f.project,owner,{preparationId:expired.id,requestKey:randomUUID()}),{status:409});
  const revision=await preparation(f);await saveProvider(f.workspace,owner,{name:'Rotated synthetic',credentials:{login:accountLogin,password:'synthetic-rotation'}},f.connectionId);await assert.rejects(startKeywordResearch(f.project,owner,{preparationId:revision.id,requestKey:randomUUID()}),{status:409});
  const queue=(await getBoss()),originalSend=queue.send.bind(queue);const rollbackQuote=await preparation(f);let queueCalls=0;
  queue.send=(async()=>{queueCalls++;throw new Error('Synthetic enqueue failure.');}) as typeof queue.send;
  const rollbackKey=randomUUID();try{await assert.rejects(startKeywordResearch(f.project,owner,{preparationId:rollbackQuote.id,requestKey:rollbackKey}));}finally{queue.send=originalSend;}
  assert.equal(queueCalls,1);assert.equal((await pool.query('SELECT id FROM provider_request WHERE workspace_id=$1 AND request_key=$2',[f.workspace,rollbackKey])).rowCount,0);
  // Independent preparations can start concurrently; each preparation still authorizes one run.
  const budget=await fixture(),bq1=await preparation(budget),bq2=await preparation(budget);
  const concurrent=await Promise.all([startKeywordResearch(budget.project,owner,{preparationId:bq1.id,requestKey:randomUUID()}),startKeywordResearch(budget.project,owner,{preparationId:bq2.id,requestKey:randomUUID()})]);
  for(const {run} of concurrent){assert.equal((await pool.query('SELECT id FROM provider_request WHERE id=$1',[run.id])).rowCount,1);assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id=$1',[run.id])).rowCount,1);}
  const bq3=await preparation(budget),same=await Promise.allSettled([startKeywordResearch(budget.project,owner,{preparationId:bq3.id,requestKey:randomUUID()}),startKeywordResearch(budget.project,owner,{preparationId:bq3.id,requestKey:randomUUID()})]);
  assert.equal(same.filter(r=>r.status==='fulfilled').length,1);assert.ok(same.some(r=>r.status==='rejected'&&r.reason.status===409&&/This prepared request already started a run\./.test(r.reason.message)));
  assert.equal((await pool.query('SELECT id FROM keyword_research_run WHERE quote_id=$1',[bq3.id])).rowCount,1);assert.equal((await pool.query('SELECT id FROM provider_request WHERE workspace_id=$1',[budget.workspace])).rowCount,3);
  console.log('PASS keyword expired/revised preparation rejection, enqueue rollback, concurrent reservations without an app cap (D3) and one run per preparation');

  const removed=await fixture();const removedRun=await start(removed,editor);await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[removed.workspace,editor]);let before=paidCalls;await executeKeywordResearch(removedRun.run.id,send);assert.equal(paidCalls,before);assert.equal((await requestReceipt(removedRun.run.id)).status,'cancelled');
  const revoked=await fixture(),revokedRun=await start(revoked);await revokeProvider(revoked.workspace,owner,revoked.connectionId);await executeKeywordResearch(revokedRun.run.id,send);assert.equal((await getKeywordRun(revoked.project,owner,revokedRun.run.id)).run.status,'cancelled');assert.equal(paidCalls,before);
  const cancelled=await start(f);await cancelKeywordResearch(f.project,owner,cancelled.run.id,{});await executeKeywordResearch(cancelled.run.id,send);assert.equal(paidCalls,before);
  const over=await fixture(),overRun=await start(over);mode='over';await executeKeywordResearch(overRun.run.id,send);assertNoApiMoney((await getKeywordRun(over.project,owner,overRun.run.id)).run);
  // Owner decision D3: a malformed billing metadata is ignored and pauses nothing.
  assert.equal((await getKeywordResearch(over.project,owner)).requestsPaused,false);assert.equal((await start(over)).run.status,'queued');
  const malformed=await fixture(),badRun=await start(malformed);mode='invalid';await executeKeywordResearch(badRun.run.id,send);assert.equal((await getKeywordRun(malformed.project,owner,badRun.run.id)).run.status,'failed');assert.equal((await requestReceipt(badRun.run.id)).status,'settled');
  console.log('PASS keyword revoked/cancelled dispatch prevention, irrelevant billing metadata accepted without pausing and known malformed results');

  const uncertain=await fixture(),uncertainRun=await start(uncertain);mode='unknown';await executeKeywordResearch(uncertainRun.run.id,send);before=paidCalls;assert.equal((await requestReceipt(uncertainRun.run.id)).status,'uncertain');
  // Unknown request outcomes remain recoverable on the original run while independent requests can start.
  assert.equal((await getKeywordResearch(uncertain.project,owner)).requestsPaused,false);const independent=await start(uncertain);assert.equal(independent.run.status,'queued');await cancelKeywordResearch(uncertain.project,owner,independent.run.id,{});await executeKeywordResearch(uncertainRun.run.id,send);assert.equal(paidCalls,before);assert.equal((await requestReceipt(uncertainRun.run.id)).status,'uncertain');
  await assert.rejects(recoverKeywordResearch(uncertain.project,editor,uncertainRun.run.id,{connectionId:uncertain.connectionId},send),{status:404});
  const matching={id:'matched-provider-task',url:'v3/dataforseo_labs/google/keyword_overview/live',metadata:keywordPayload(uncertain.request,uncertainRun.run.id),status:'20000',cost:0.01212};
  for(const items of [[{...matching,status:'20100',cost:0}],[{...matching,status:'40601',cost:0}],[{...matching,status:'40602',cost:0}],[{...matching,status:'29999',cost:0}],[],[{...matching,metadata:{...matching.metadata,tag:'foreign'}}],[matching,matching],Array(1000).fill(matching)]){reconcileItems=items;assert.equal((await recoverKeywordResearch(uncertain.project,owner,uncertainRun.run.id,{connectionId:uncertain.connectionId},send)).recovery.status,'inconclusive');assert.equal((await requestReceipt(uncertainRun.run.id)).status,'uncertain');}
  reconcileItems=[matching];account='different-account@keywords.integration.test';assert.equal((await recoverKeywordResearch(uncertain.project,owner,uncertainRun.run.id,{connectionId:uncertain.connectionId},send)).recovery.status,'inconclusive');account=accountLogin;
  await saveProvider(uncertain.workspace,owner,{name:'Same-account rotation',credentials:{login:accountLogin,password:'synthetic-rotation'}},uncertain.connectionId);
  assert.equal((await recoverKeywordResearch(uncertain.project,owner,uncertainRun.run.id,{connectionId:uncertain.connectionId},send)).recovery.status,'matched');assert.equal((await requestReceipt(uncertainRun.run.id)).status,'settled');assert.equal((await getKeywordRun(uncertain.project,owner,uncertainRun.run.id)).run.status,'failed');assert.equal(paidCalls,before);
  assert.equal((await getKeywordResearch(uncertain.project,owner)).requestsPaused,false);assert.equal((await start(uncertain)).run.status,'queued');assert.equal(paidCalls,before);
  console.log('PASS keyword independent starts during unknown request outcome, no original replay and exact owner-only reconciliation including rotated credentials');

  mode='ok';const crashed=await fixture(),crashRun=await start(crashed);await pool.query("UPDATE provider_request SET status='dispatched' WHERE id=$1",[crashRun.run.id]);await pool.query("UPDATE keyword_research_run SET status='running',dispatched_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[crashRun.run.id]);await reconcileKeywordJobs();assert.equal((await requestReceipt(crashRun.run.id)).status,'uncertain');assert.equal(paidCalls,before);
  await pool.query("UPDATE keyword_research_run SET completed_at=clock_timestamp()-interval '366 days' WHERE id=$1",[first.run.id]);
  const policy=await pool.connect();try{await policy.query('BEGIN');await policy.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[f.workspace]);await policy.query('UPDATE workspace SET derived_history_days=400 WHERE id=$1',[f.workspace]);await runRetentionBatch(f.project);assert.notEqual((await getDatabase().pool.query('SELECT result FROM keyword_research_run WHERE id=$1',[first.run.id])).rows[0].result,null);await policy.query('COMMIT');}finally{await policy.query('ROLLBACK').catch(()=>{});policy.release();}
  await runRetentionBatch(f.project);assert.notEqual((await getKeywordRun(f.project,owner,first.run.id)).run.result,null);
  await pool.query('UPDATE workspace SET derived_history_days=365 WHERE id=$1',[f.workspace]);await runRetentionBatch(f.project);const purged=(await getKeywordRun(f.project,owner,first.run.id)).run;assert.equal(purged.result,null);assert.equal(purged.resultExpired,true);assertNoApiMoney(purged);assert.equal((await requestReceipt(first.run.id)).status,'settled');
  console.log('PASS keyword stale dispatch becomes uncertain and retention extension race preserves results and request evidence');

  for(const outcome of ['ok','conflict'] as const){
    mode=outcome;const race=await fixture(),raceRun=await start(race);
    let networkReady!:()=>void,releaseNetwork!:()=>void;const ready=new Promise<void>(resolve=>networkReady=resolve),networkGate=new Promise<void>(resolve=>releaseNetwork=resolve);
    const executing=executeKeywordResearch(raceRun.run.id,async(...args)=>{networkReady();await networkGate;return send(...args);});await ready;
    await pool.query("UPDATE keyword_research_run SET dispatched_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[raceRun.run.id]);
    let sweepReady!:()=>void,releaseSweep!:()=>void;const snapshot=new Promise<void>(resolve=>sweepReady=resolve),sweepGate=new Promise<void>(resolve=>releaseSweep=resolve),originalQuery=pool.query;
    pool.query=(async(...args:any[])=>{const result=await (originalQuery as any).apply(pool,args);if(typeof args[0]==='string'&&args[0].startsWith('SELECT r.id,r.status FROM keyword_research_run')){sweepReady();await sweepGate;}return result;}) as typeof pool.query;
    try{const sweeping=reconcileKeywordJobs();await snapshot;releaseNetwork();await executing;const evidence=(await (originalQuery as any).call(pool,'SELECT result,reconciliation_evidence,status FROM keyword_research_run WHERE id=$1',[raceRun.run.id])).rows[0];releaseSweep();await sweeping;const after=(await (originalQuery as any).call(pool,'SELECT result,reconciliation_evidence,status FROM keyword_research_run WHERE id=$1',[raceRun.run.id])).rows[0];assert.deepEqual(after,evidence);assert.equal(after.status,outcome==='ok'?'completed':'uncertain');assert.equal(sentTags.filter(tag=>tag.endsWith(raceRun.run.id)).length,1);}finally{releaseNetwork();releaseSweep();pool.query=originalQuery;}
  }
  mode='conflict';const bound=await fixture(),boundRun=await start(bound);await executeKeywordResearch(boundRun.run.id,send);
  const knownReference=(await pool.query('SELECT provider_reference FROM provider_request WHERE id=$1',[boundRun.run.id])).rows[0].provider_reference;assert.ok(knownReference);
  const recorded=(await pool.query('SELECT reconciliation_evidence FROM keyword_research_run WHERE id=$1',[boundRun.run.id])).rows[0];
  reconcileItems=[{...matching,id:'different-task-id',metadata:keywordPayload(bound.request,boundRun.run.id)}];assert.equal((await recoverKeywordResearch(bound.project,owner,boundRun.run.id,{connectionId:bound.connectionId},send)).recovery.status,'inconclusive');assert.equal((await requestReceipt(boundRun.run.id)).status,'uncertain');assert.deepEqual((await pool.query('SELECT reconciliation_evidence FROM keyword_research_run WHERE id=$1',[boundRun.run.id])).rows[0],recorded);
  reconcileItems=[{...matching,id:knownReference,metadata:keywordPayload(bound.request,boundRun.run.id)}];assert.equal((await recoverKeywordResearch(bound.project,owner,boundRun.run.id,{connectionId:bound.connectionId},send)).recovery.status,'matched');
  mode='pending';const pending=await fixture(),pendingRun=await start(pending);await executeKeywordResearch(pendingRun.run.id,send);assert.equal((await requestReceipt(pendingRun.run.id)).status,'uncertain');const pendingSent=paidCalls;
  // A pending request keeps its original receipt without blocking an independent request.
  assert.equal((await getKeywordResearch(pending.project,owner)).requestsPaused,false);const pendingIndependent=await start(pending);assert.equal(pendingIndependent.run.status,'queued');await cancelKeywordResearch(pending.project,owner,pendingIndependent.run.id,{});await executeKeywordResearch(pendingRun.run.id,send);assert.equal((await requestReceipt(pendingRun.run.id)).status,'uncertain');assert.equal(paidCalls,pendingSent);
  const pendingReference=(await pool.query('SELECT provider_reference FROM provider_request WHERE id=$1',[pendingRun.run.id])).rows[0].provider_reference;
  reconcileItems=[{...matching,id:pendingReference??'pending-provider-task',metadata:keywordPayload(pending.request,pendingRun.run.id)}];assert.equal((await recoverKeywordResearch(pending.project,owner,pendingRun.run.id,{connectionId:pending.connectionId},send)).recovery.status,'matched');
  assert.equal((await requestReceipt(pendingRun.run.id)).status,'settled');assert.equal((await getKeywordResearch(pending.project,owner)).requestsPaused,false);assert.equal((await start(pending)).run.status,'queued');
  console.log('PASS stale crash snapshots cannot overwrite settled or uncertain provider evidence; unsupported provider statuses remain unresolved');

  // Owner decision D3: a provider refusal ends the request with a known outcome and leaves new provider work unblocked.
  for(const kind of ['wallet_task','wallet_http'] as const){
   mode='ok';const g=await fixture(),run=await start(g),sent:number=paidCalls;mode=kind;await executeKeywordResearch(run.run.id,send);const refused=(await getKeywordRun(g.project,owner,run.run.id)).run;
   assert.equal(paidCalls,sent+1,kind);assert.equal(refused.status,'failed',kind);assert.equal(refused.requestStatus,'settled',kind);assertNoApiMoney(refused);assert.equal(refused.diagnostic,dataforseoRefusalMessage.provider,kind);assert.equal(refused.result,null,kind);
   assert.deepEqual(await requestReceipt(run.run.id),{status:'settled',actual_micros:null,estimate_micros:null},kind);assert.equal((await getKeywordResearch(g.project,owner)).requestsPaused,false,kind);
   await executeKeywordResearch(run.run.id,send);assert.equal(paidCalls,sent+1,kind);
   mode='ok';const next=await start(g);await executeKeywordResearch(next.run.id,send);assert.equal((await getKeywordRun(g.project,owner,next.run.id)).run.status,'completed',kind);assert.equal(paidCalls,sent+2,kind);
  }
  const charged=await fixture(),chargedRun=await start(charged),chargedSent=paidCalls;mode='wallet_charged';await executeKeywordResearch(chargedRun.run.id,send);assert.equal(paidCalls,chargedSent+1);
  assert.equal((await requestReceipt(chargedRun.run.id)).status,'settled');assert.equal((await getKeywordRun(charged.project,owner,chargedRun.run.id)).run.status,'failed');mode='ok';const chargedIndependent=await start(charged);assert.equal(chargedIndependent.run.status,'queued');await cancelKeywordResearch(charged.project,owner,chargedIndependent.run.id,{});await executeKeywordResearch(chargedRun.run.id,send);assert.equal(paidCalls,chargedSent+1);assert.equal((await requestReceipt(chargedRun.run.id)).status,'settled');
  console.log('PASS keyword provider refusals (task 40210, HTTP 402 40200) fail with a known outcome and leave new work unblocked; irrelevant billing metadata does not change a known refusal (D3)');

  mode='ok';const worker=await fixture(),workerRun=await start(worker);const job=(await pool.query('SELECT retry_limit FROM pgboss.job WHERE id=$1',[workerRun.run.id])).rows[0];assert.equal(job.retry_limit,0);await pool.query('UPDATE pgboss.job SET priority=100 WHERE id=$1',[workerRun.run.id]);
  globalThis.fetch=send;await startWorker();const deadline=Date.now()+15_000;while((await getKeywordRun(worker.project,owner,workerRun.run.id)).run.status==='queued'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));await stopJobs();globalThis.fetch=async()=>{throw new Error('Live provider traffic is forbidden in keyword tests.');};assert.equal((await getKeywordRun(worker.project,owner,workerRun.run.id)).run.status,'completed');assert.equal(sentTags.filter(tag=>tag.endsWith(workerRun.run.id)).length,1);
  console.log('PASS actual pg-boss worker dispatches one synthetic request with retries disabled');

  const login=await handleApi(new Request(`${config.appUrl}/api/auth/sign-in/email`,{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:`${owner}@keywords.integration.test`,password})}));assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  const endpoint=`${config.appUrl}/api/projects/${f.project}/keyword-research`;
  assert.equal((await handleApi(new Request(endpoint))).status,401);const read=await handleApi(new Request(endpoint,{headers:{cookie}}));assert.equal(read.status,200);const text=await read.text();assert.ok(!text.includes('synthetic-rotation')&&!text.includes('account_fingerprint')&&!text.includes('encrypted_credentials'));
  assert.equal((await handleApi(new Request(endpoint+'/runs',{method:'POST',headers:{cookie,origin:'https://foreign.integration.test','content-type':'application/json'},body:'{}'}))).status,403);
  const keyToken=await createApiKey(f.workspace,owner,{name:'No implicit keyword scope',scopes:['analytics:read']});assert.equal((await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+keyToken.token}}))).status,403);
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[f.workspace,owner]);assert.equal((await handleApi(new Request(endpoint,{headers:{cookie}}))).status,404);
  console.log('PASS keyword cookie/Origin/API-key/live-membership boundaries and secret-free metadata');

  mode='ok';const regions=await fixture(),regionPaidBefore=paidCalls;
  await saveProviderRequestControls(regions.workspace,owner,{paused:true});
  const refreshed=await refreshKeywordMarkets(regions.project,owner,{connectionId:regions.connectionId},send);
  assert.deepEqual(refreshed.catalog.markets.map((m:any)=>[m.locationCode,m.languageCode]).sort(),[[2158,'zh-TW'],[2344,'en'],[2344,'zh-TW'],[2840,'en']].sort());
  assert.equal(paidCalls,regionPaidBefore);assert.equal((await getKeywordResearch(regions.project,viewer)).requestsPaused,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request WHERE workspace_id=$1',[regions.workspace])).rows[0].n,0);
  const freeBeforeDenial=freeCalls;await assert.rejects(refreshKeywordMarkets(regions.project,viewer,{connectionId:regions.connectionId},send),{status:404});assert.equal(freeCalls,freeBeforeDenial);
  const regionRequest={...regions.request,locationCode:2158,languageCode:'zh-TW'};
  const pausedQuote=(await prepareKeywordResearch(regions.project,owner,regionRequest,send)).preparation;
  await assert.rejects(startKeywordResearch(regions.project,owner,{preparationId:pausedQuote.id,requestKey:randomUUID()}),{status:409});assert.equal(paidCalls,regionPaidBefore);
  await saveProviderRequestControls(regions.workspace,owner,{paused:false});
  for(const [locationCode,languageCode] of [[2158,'zh-TW'],[2344,'en'],[2344,'zh-TW']] as const){
   const exact={...regions.request,locationCode,languageCode};const quoted=(await prepareKeywordResearch(regions.project,owner,exact,send)).preparation;assert.deepEqual(quoted.request,exact);assertNoApiMoney(quoted);
   const run=(await startKeywordResearch(regions.project,owner,{preparationId:quoted.id,requestKey:randomUUID()})).run;await executeKeywordResearch(run.id,send);
   assert.deepEqual(sentPayloads.at(-1),keywordPayload(exact,run.id));
   const saved=(await getKeywordRun(regions.project,viewer,run.id)).run;assert.equal(saved.status,'completed');assert.deepEqual(saved.request,exact);assert.equal(saved.result.rows[0].keyword,'example');assert.equal(saved.result.rows[0].searchVolume,0);assertNoApiMoney(saved);
  }
  assert.equal(paidCalls-regionPaidBefore,3);
  const callsBeforeUnsupported=freeCalls;await assert.rejects(prepareKeywordResearch(regions.project,owner,{...regionRequest,languageCode:'en'},send),{status:409});assert.equal(freeCalls,callsBeforeUnsupported);
  await pool.query("UPDATE keyword_market_catalog SET updated_at=clock_timestamp()-interval '8 days' WHERE workspace_id=$1",[regions.workspace]);await assert.rejects(prepareKeywordResearch(regions.project,owner,regionRequest,send),{status:409});
  await refreshKeywordMarkets(regions.project,owner,{connectionId:regions.connectionId},send);
  const catalogBeforeRotation=(await getKeywordResearch(regions.project,owner)).catalog;
  await assert.rejects(refreshKeywordMarkets(regions.project,owner,{connectionId:regions.connectionId},async(...args)=>{await saveProvider(regions.workspace,owner,{name:'Region rotation',credentials:{login:accountLogin,password:'synthetic-region-rotation'}},regions.connectionId);return send(...args);}),{status:409});
  assert.deepEqual((await getKeywordResearch(regions.project,owner)).catalog,catalogBeforeRotation);assert.equal(paidCalls-regionPaidBefore,3);
  console.log('PASS public Region markets preserve exact preparation/payload/result pairs, free paused refresh, viewer denial, stale-catalog and credential-revision guards');

  const fixtureUsers=[owner,editor],activityRows=(await pool.query('SELECT status,estimate_micros,actual_micros FROM provider_request WHERE user_id=ANY($1::text[])',[fixtureUsers])).rows;
  for(const row of activityRows){assert.equal(row.estimate_micros,null);assert.equal(row.actual_micros,null);}
  for(const table of ['keyword_quote','domain_research_quote','saved_keyword_refresh_plan']){
   const rows=(await pool.query('SELECT to_jsonb(q) AS data FROM '+table+' q WHERE request_version=1 AND user_id=ANY($1::text[])',[fixtureUsers])).rows;
   for(const {data}of rows)for(const key of ['estimate_micros','per_task_micros','per_item_micros','price_as_of'])if(Object.hasOwn(data,key))assert.equal(data[key],null,key);
  }
 }finally{try{await stopJobs();}finally{globalThis.fetch=originalFetch;}}
}
if(import.meta.main){try{await runKeywordResearchChecks();}finally{await closeDatabase();}}
