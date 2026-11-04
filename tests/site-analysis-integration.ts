import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {getAuth} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {saveProvider,saveProviderRequestControls} from '../src/server/providers.ts';
import {getProjectContext,updateProjectContext} from '../src/server/project-context.ts';
import {startSiteAnalysis,advanceSiteAnalysis,getSiteAnalysis,getSiteAnalyses,acceptSiteAnalysis,cancelSiteAnalysis,recoverSiteAnalysis} from '../src/server/site-analysis.ts';
import {prepareAiSuggestions,startAiSuggestions,getAiSuggestion,getAiSuggestions} from '../src/server/ai-suggestions.ts';
import {executeAiSuggestion,recoverAiSuggestion} from '../src/server/ai-suggestion-worker.ts';
import {runRetentionBatch} from '../src/server/retention.ts';

function assertNoApiMoney(value:unknown):void{
 if(!value||typeof value!=='object')return;
 const forbidden=new Set(['cost','price','actual_micros','estimate_micros','estimateUsd','actualUsd','estimateMicros','actualMicros','chargeStatus','spendingPaused','maximumUsd','perTask','perItem','priceAsOf','priceSource','promptPrice','completionPrice','requestPrice','max_price','maxSpendUsd','fundedCredits']);
 for(const[key,item]of Object.entries(value)){assert.equal(forbidden.has(key),false,'Unexpected API financial field: '+key);assertNoApiMoney(item);}
}

export async function runSiteAnalysisChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_SITE_ANALYSIS_TEST,'1');
 const config=getConfig(),database=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 assert.ok(local.includes(database.hostname));assert.equal(database.port,'55501');assert.match(database.pathname,/^\/ten98_site_analysis_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(database.hash,'');
 assert.ok(local.includes(new URL(config.appUrl).hostname));assert.equal(process.env.ANALYTICS_NETWORK_MODE,'off');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh empty owned fixture.');
 const originalFetch=globalThis.fetch;let outbound=0,requests=0,completions=0;
 globalThis.fetch=async()=>{outbound++;throw new Error('External requests forbidden in website analysis fixture.');};
 const owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),foreign=randomUUID();
 for(const user of [owner,editor,viewer,foreign])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Analysis fixture\',$2)',[user,`${user}@analysis.integration.test`]);
 const model='openai/gpt-4o-mini',origin='https://coffee.example.org';
 let mode:'ok'|'invalid'|'foreign-evidence'|'lost'|'unknown'='ok';
 const receipts=new Map<string,Record<string,unknown>>();
 const send:typeof fetch=async(address,init)=>{
  requests++;assert.ok(requests<=100,'Synthetic provider request cap exceeded.');
  const url=String(address);assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);
  if(url==='https://openrouter.ai/api/v1/models?output_modalities=text&offset=0&limit=500')return Response.json({data:[{id:model,canonical_slug:model,name:model,architecture:{input_modalities:['text'],output_modalities:['text']},context_length:128000,top_provider:{max_completion_tokens:16384},supported_parameters:['max_tokens','response_format','structured_outputs'],pricing:{prompt:'0',completion:'0',request:'0'}}],total_count:1,links:{next:null}});
  if(url==='https://openrouter.ai/api/v1/key')return Response.json({data:{is_free_tier:false,is_management_key:false}});
  if(url===`https://openrouter.ai/api/v1/models/${model}/endpoints`)return Response.json({data:{id:model,architecture:{input_modalities:['text'],output_modalities:['text']},endpoints:[{tag:'openai',provider_name:'OpenAI',model_id:model,status:0,context_length:128000,max_prompt_tokens:null,max_completion_tokens:16384,supported_parameters:['max_tokens','response_format','structured_outputs']}]}});
  if(url.startsWith('https://openrouter.ai/api/v1/generation?id=')){const receipt=receipts.get(new URL(url).searchParams.get('id')!);assert.ok(receipt);return Response.json({data:receipt});}
  assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init?.method,'POST');completions++;
  const body=JSON.parse(String(init?.body));assert.equal(body.response_format.json_schema.strict,true);assert.deepEqual(body.provider.only,['openai']);assert.equal(body.provider.allow_fallbacks,false);assert.equal(body.tools,undefined);assert.deepEqual(body.plugins,[{id:'context-compression',enabled:false}]);
  if(mode==='unknown')throw new Error('Synthetic unknown outcome');
  const id='gen-'+randomUUID(),created=Math.floor(Date.now()/1000);
  receipts.set(id,{id,model:body.model,provider_name:'OpenAI',session_id:body.session_id,external_user:body.user,created_at:new Date(created*1000).toISOString(),finish_reason:'stop',tokens_prompt:12,tokens_completion:20});
  if(mode==='lost')return new Response('{broken',{headers:{'x-generation-id':id}});
  const snapshot=JSON.parse(body.messages.findLast((message:{role:string})=>message.role==='user').content);
  const evidenceIds=[mode==='foreign-evidence'?randomUUID():snapshot.pages[0].id],rationale='Observed in the retained website text.';
  const proposal={version:1,limitation:'none',brand:{name:'Coffee brand',aliases:['Coffee alias'],overview:'Coffee equipment for home kitchens.',evidenceIds,rationale},competitors:[],pages:[{url:snapshot.pages[0].url,role:'hub',topic:'Coffee',notes:'Observed home page.',evidenceIds,rationale}],personas:[{name:'Home brewer',description:'People choosing equipment for a home kitchen.',evidenceIds,rationale}]};
  return Response.json({id,created,model:body.model,provider:'OpenAI',usage:{prompt_tokens:12,completion_tokens:20},choices:[{finish_reason:'stop',message:{content:mode==='invalid'?'not JSON':JSON.stringify(proposal)}}]},{headers:{'x-generation-id':id}});
 };
 async function fixture(){
  const workspace=randomUUID(),project=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Analysis fixture')",[workspace]);
  for(const [user,role]of [[owner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Coffee',$3,$4,'infinity')",[project,workspace,origin,randomUUID()]);
  const connection=(await saveProvider(workspace,owner,{provider:'openrouter',name:'Synthetic analysis',credentials:{apiKey:'synthetic-only-'+project}})).connection;
  await pool.query("UPDATE provider_connection SET check_status='ok' WHERE id=$1",[connection.id]);await saveProviderRequestControls(workspace,owner,{paused:false});
  return {workspace,project,connectionId:connection.id,input:{requestId:randomUUID(),connectionId:connection.id,contextRevision:1,model}};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 const start=async(f:Fixture)=>(await startSiteAnalysis(f.project,owner,f.input)).run;
 const detail=async(f:Fixture,id:string)=>(await getSiteAnalysis(f.project,owner,id)).run;
 const child=async(id:string)=>(await pool.query<{ai_run_id:string|null}>('SELECT ai_run_id FROM site_analysis_run WHERE id=$1',[id])).rows[0].ai_run_id;
 const coverage={reasons:[],discoveryComplete:true,linksComplete:true,scopeExclusions:0,rawEvidenceRecorded:true};
 // Populate only observed terminal crawl evidence; all orchestration and request rows are created by native controllers.
 async function terminal(f:Fixture,run:Awaited<ReturnType<typeof start>>,options:{partial?:boolean;text?:string;secondText?:string}={}){
  assert.ok(run.auditId);const text=options.text??'SYNTHETIC_RETAINED_BODY Coffee equipment for home kitchens.',hash=createHash('sha256').update(text).digest('hex');
  await pool.query("UPDATE site_audit_run SET status=$2,completed_at=clock_timestamp(),coverage=$3 WHERE id=$1",[run.auditId,options.partial?'partial':'completed',JSON.stringify(options.partial?{...coverage,reasons:['unavailable_page'],discoveryComplete:false}:coverage)]);
  const page=(await pool.query<{id:string}>("UPDATE site_audit_page SET state='done',fetch_state='ok',analysis_coverage='analyzed',observed_at=clock_timestamp(),http_status=200,facts=$2,body_capture_state=$3,body_extraction_version='static-dom-body-v1',body_text=$4 WHERE run_id=$1 AND resource_kind='html' RETURNING id",[run.auditId,JSON.stringify({contentHash:text?hash:null}),text?'available':'empty',text])).rows[0];assert.ok(page);
  if(options.secondText){const secondHash=createHash('sha256').update(options.secondText).digest('hex');await pool.query("INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url,state,fetch_state,analysis_coverage,observed_at,facts,body_capture_state,body_extraction_version,body_text) VALUES($1,$2,$3,'html',$4,'done','ok','analyzed',clock_timestamp(),$5,'available','static-dom-body-v1',$6)",[randomUUID(),run.auditId,f.project,origin+'/second',JSON.stringify({contentHash:secondHash}),options.secondText]);}
  return page.id;
 }
 async function queued(f:Fixture){const run=await start(f);await terminal(f,run);await advanceSiteAnalysis(run.id,send);const id=await child(run.id);assert.ok(id);return {run,id};}
 async function completed(f:Fixture){const queuedRun=await queued(f);await executeAiSuggestion(queuedRun.id,send);const run=await detail(f,queuedRun.run.id);assert.equal(run.status,'completed');assert.ok(run.proposal?.brand);return run;}
 const acceptedState=async(f:Fixture,id:string)=>(await pool.query(`SELECT s.accepted_candidate_ids,s.proposal_revision,c.brand_name,c.brand_aliases,c.revision,
  (SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'description',description) ORDER BY id) FROM context_persona WHERE project_id=$2) AS personas,
  (SELECT jsonb_agg(jsonb_build_object('key',key,'content',content) ORDER BY key) FROM context_section WHERE project_id=$2) AS sections,
  (SELECT count(*)::int FROM project_content_request WHERE project_id=$2) AS receipts
  FROM site_analysis_run s JOIN project_context c ON c.project_id=s.project_id WHERE s.id=$1`,[id,f.project])).rows[0];
 const acceptance=(run:Awaited<ReturnType<typeof detail>>)=>({requestId:randomUUID(),expectedContextRevision:run.acceptance!.contextRevision,expectedProposalRevision:run.proposalRevision,selections:[{candidateId:run.proposal!.brand!.id,updates:[{kind:'profile',name:'Edited coffee brand',aliases:['Edited alias']},{kind:'section',key:'business_overview',content:'Edited business overview.'}]},{candidateId:run.proposal!.personas[0].id,updates:[{kind:'persona',id:run.proposal!.personas[0].id,name:'Edited home brewer',description:'Edited persona description.'}]}]});
 try{
  const f=await fixture();for(const user of [editor,viewer,foreign])await assert.rejects(startSiteAnalysis(f.project,user,f.input));assert.equal(requests,0);
  const [a,b]=await Promise.all([startSiteAnalysis(f.project,owner,f.input),startSiteAnalysis(f.project,owner,f.input)]);assert.equal(a.run.id,b.run.id);assert.equal(a.run.auditId,b.run.auditId);assertNoApiMoney(a);
  await assert.rejects(startSiteAnalysis(f.project,owner,{...f.input,model:'openai/gpt-4.1-mini'}),{status:409});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM site_analysis_run WHERE project_id=$1',[f.project])).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM site_audit_run WHERE project_id=$1',[f.project])).rows[0].n,1);
  await assert.rejects(getSiteAnalysis((await fixture()).project,owner,a.run.id),{status:404});await assert.rejects(getSiteAnalysis(f.project,foreign,a.run.id),{status:404});
  const rollback=await fixture(),boss=await getBoss(),originalSend=boss.send.bind(boss);let queuedId:string|null|undefined;
  boss.send=(async(...args:any[])=>{queuedId=await (originalSend as any)(...args);throw new Error('Synthetic enqueue rollback');}) as typeof boss.send;
  try{await assert.rejects(start(rollback));}finally{boss.send=originalSend;}
  assert.ok(queuedId);for(const table of ['site_analysis_run','site_audit_run','site_audit_page','project_content_request'])assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE project_id=$1`,[rollback.project])).rows[0].n,0,table);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgboss.job WHERE id=$1',[queuedId])).rows[0].n,0);
  console.log('PASS owner authority, project isolation, concurrent Run replay and atomic crawl enqueue rollback');

  const page=await terminal(f,a.run,{partial:true});const before=completions;
  const pendingState=async()=>(await pool.query(`SELECT
   (SELECT count(*)::int FROM site_analysis_run WHERE project_id=$1) AS parents,
   (SELECT count(*)::int FROM site_audit_run WHERE project_id=$1) AS audits,
   (SELECT count(*)::int FROM pgboss.job j JOIN site_audit_run a ON a.queue_job_id=j.id WHERE a.project_id=$1) AS jobs`,[f.project])).rows[0];
  const pending=await pendingState();assert.deepEqual(pending,{parents:1,audits:1,jobs:1});
  await assert.rejects(startSiteAnalysis(f.project,owner,{...f.input,requestId:randomUUID()}),{status:409},'A completed crawl with a pending analysis parent still owns the original Run.');
  assert.deepEqual(await pendingState(),pending,'Refusing a fresh Run must not create another parent, audit or queue job.');
  await Promise.all([advanceSiteAnalysis(a.run.id,send),advanceSiteAnalysis(a.run.id,send)]);await advanceSiteAnalysis(a.run.id,send);const id=await child(a.run.id);assert.ok(id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_suggestion_run WHERE project_id=$1 AND purpose='site-analysis'",[f.project])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request WHERE id=$1',[id])).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgboss.job WHERE id=$1',[id])).rows[0].n,1);
  await Promise.all([executeAiSuggestion(id,send),executeAiSuggestion(id,send)]);const done=await detail(f,a.run.id);assert.equal(done.status,'completed');assert.equal(completions,before+1);assert.ok(done.proposal?.brand);assert.equal(done.evidence!.pages[0].id,page);assert.equal(done.evidence!.coverage.discoveryComplete,false);
  const stable=await detail(f,a.run.id);assert.deepEqual(stable.proposal,done.proposal);assert.ok(!JSON.stringify(done).includes('SYNTHETIC_RETAINED_BODY'));assert.ok(!JSON.stringify(done).includes('synthetic-only-'));assertNoApiMoney(done);
  assert.deepEqual((await getAiSuggestions(f.project,viewer)).runs,[]);assert.equal((await getSiteAnalyses(f.project,viewer)).runs[0].id,done.id);
  console.log('PASS terminal partial evidence, one child reservation, fenced completion, stable candidates and safe retrieval');

  for(const kind of ['empty','invalid-hash','oversized','expired','deleted','failed'] as const){
   const test=await fixture(),run=await start(test);await terminal(test,run,kind==='empty'?{text:''}:kind==='oversized'?{text:'a'.repeat(40000),secondText:'b'.repeat(40000)}:{});
   if(kind==='invalid-hash')await pool.query("UPDATE site_audit_page SET facts='{}' WHERE run_id=$1 AND resource_kind='html'",[run.auditId]);
   if(kind==='expired')await pool.query('UPDATE site_audit_run SET raw_expired_at=clock_timestamp() WHERE id=$1',[run.auditId]);
   if(kind==='deleted')await pool.query('UPDATE site_audit_run SET deleted_at=clock_timestamp() WHERE id=$1',[run.auditId]);
   if(kind==='failed')await pool.query("UPDATE site_audit_run SET status='failed' WHERE id=$1",[run.auditId]);
   const prior:number=requests;await advanceSiteAnalysis(run.id,send);assert.equal((await detail(test,run.id)).status,'failed',kind);assert.equal(await child(run.id),null,kind);assert.equal(requests,prior,kind);
  }
  console.log('PASS empty, invalid, oversized, expired, deleted and failed crawl evidence refuses before provider metadata');

  async function drift(test:Fixture,kind:'credential'|'role'|'origin'){
   if(kind==='credential')await pool.query('UPDATE provider_connection SET revision=revision+1 WHERE id=$1',[test.connectionId]);
   if(kind==='role')await pool.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2",[test.workspace,owner]);
   if(kind==='origin')await pool.query("UPDATE project SET origin='https://changed.example.org' WHERE id=$1",[test.project]);
  }
  for(const phase of ['crawl','prepare','dispatch'] as const)for(const kind of ['credential','role','origin'] as const){
   const test=await fixture(),run=await start(test);await terminal(test,run);const prior=completions;
   if(phase==='crawl'){await drift(test,kind);await advanceSiteAnalysis(run.id,send);}
   if(phase==='prepare'){let changed=false;await advanceSiteAnalysis(run.id,async(...args)=>{if(String(args[0]).endsWith('/endpoints')&&!changed){changed=true;await drift(test,kind);}return send(...args);});assert.equal(changed,true);}
   if(phase==='dispatch'){await advanceSiteAnalysis(run.id,send);const childId=await child(run.id);assert.ok(childId);let changed=false;await executeAiSuggestion(childId,async(...args)=>{if(String(args[0]).endsWith('/endpoints')&&!changed){changed=true;await drift(test,kind);}return send(...args);});assert.equal(changed,true);}
   assert.equal(completions,prior,`${phase}/${kind}`);const current=await detail(test,run.id);assert.ok(['failed','cancelled'].includes(current.status),`${phase}/${kind}: ${current.status}`);
  }
  console.log('PASS bound credential, owner membership and origin rechecks at crawl, preparation and dispatch');

  const crawling=await fixture(),crawlRun=await start(crawling);await cancelSiteAnalysis(crawling.project,owner,crawlRun.id,{requestId:randomUUID()});await advanceSiteAnalysis(crawlRun.id,send);assert.equal((await detail(crawling,crawlRun.id)).status,'cancelled');assert.equal(await child(crawlRun.id),null);
  const cancelling=await fixture(),cancelled=await queued(cancelling),cancelBody={requestId:randomUUID()},cancelBefore=completions;await cancelSiteAnalysis(cancelling.project,owner,cancelled.run.id,cancelBody);await cancelSiteAnalysis(cancelling.project,owner,cancelled.run.id,cancelBody);await executeAiSuggestion(cancelled.id,send);assert.equal(completions,cancelBefore);assert.equal((await detail(cancelling,cancelled.run.id)).status,'cancelled');
  console.log('PASS cancellation before crawl completion or AI dispatch preserves the original operation without POST');

  await updateProjectContext(f.project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'section',key:'business_overview',content:'Existing authored overview must survive rejected acceptance.'}]});
  const save=acceptance(await detail(f,done.id));await assert.rejects(acceptSiteAnalysis(f.project,viewer,done.id,save));
  const untouched=await acceptedState(f,done.id);
  await assert.rejects(acceptSiteAnalysis(f.project,editor,done.id,{...save,selections:[{candidateId:done.proposal!.brand!.id,updates:[{kind:'profile',name:'Must not be saved'},{kind:'section',key:'business_overview',content:''}]}]}),{status:400},'An empty overview is a native delete operation and must not be accepted as a proposal edit.');
  assert.deepEqual(await acceptedState(f,done.id),untouched,'Empty overview rejection preserves authored content, revisions, candidates and receipts.');
  for(const invalid of [
   {...save,expectedProposalRevision:save.expectedProposalRevision+1},
   {...save,expectedContextRevision:save.expectedContextRevision+1},
   {...save,selections:[save.selections[0],{...save.selections[1],candidateId:randomUUID()}]},
   {...save,selections:[save.selections[0],save.selections[0]]},
  ]){await assert.rejects(acceptSiteAnalysis(f.project,editor,done.id,invalid));assert.deepEqual(await acceptedState(f,done.id),untouched);}
  const saved=await acceptSiteAnalysis(f.project,editor,done.id,save);assert.equal(saved.run.acceptedCandidateIds.length,2);assert.equal(saved.run.proposalRevision,2);
  const authored=await getProjectContext(f.project,owner);assert.equal(authored.profile.name,'Edited coffee brand');assert.deepEqual(authored.profile.aliases,['Edited alias']);
  const persona=(await pool.query('SELECT id,name,description FROM context_persona WHERE project_id=$1',[f.project])).rows[0];assert.deepEqual(persona,{id:done.proposal!.personas[0].id,name:'Edited home brewer',description:'Edited persona description.'});
  const after=await acceptedState(f,done.id);assert.equal((await acceptSiteAnalysis(f.project,editor,done.id,save)).replayed,true);assert.deepEqual(await acceptedState(f,done.id),after);
  await assert.rejects(acceptSiteAnalysis(f.project,editor,done.id,{...save,requestId:randomUUID(),expectedContextRevision:authored.revision,expectedProposalRevision:2}));assert.deepEqual(await acceptedState(f,done.id),after);assertNoApiMoney(saved);
  console.log('PASS editor acceptance edits brand and stable persona IDs, rejects stale or foreign selections atomically and replays exactly');

  const changed=await fixture(),changedQueued=await queued(changed);await updateProjectContext(changed.project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Author changed context'},{kind:'section',key:'business_overview',content:'Preserve this authored overview during profile-only acceptance.'}]});await executeAiSuggestion(changedQueued.id,send);const changedDone=await detail(changed,changedQueued.run.id);assert.equal(changedDone.status,'completed');assert.equal(changedDone.contextRevision,1);assert.equal(changedDone.acceptance!.contextRevision,2);
  await assert.rejects(acceptSiteAnalysis(changed.project,owner,changedDone.id,{...acceptance(changedDone),expectedContextRevision:1}),{status:409});
  const profileOnly={...acceptance(changedDone),selections:[{candidateId:changedDone.proposal!.brand!.id,updates:[{kind:'profile',name:'Profile-only brand',aliases:['Profile-only alias']}]}]};
  const profileAccepted=await acceptSiteAnalysis(changed.project,owner,changedDone.id,profileOnly);assert.deepEqual(profileAccepted.run.acceptedCandidateIds,[changedDone.proposal!.brand!.id]);
  const profileContext=await getProjectContext(changed.project,owner);assert.equal(profileContext.revision,3);assert.equal(profileContext.profile.name,'Profile-only brand');assert.deepEqual(profileContext.profile.aliases,['Profile-only alias']);
  assert.equal((await pool.query("SELECT content FROM context_section WHERE project_id=$1 AND key='business_overview'",[changed.project])).rows[0].content,'Preserve this authored overview during profile-only acceptance.');
  console.log('PASS authored context changes preserve website analysis and acceptance uses the current native context revision');

  const lost=await fixture(),lostQueued=await queued(lost),lostBefore=completions;mode='lost';try{await executeAiSuggestion(lostQueued.id,send);}finally{mode='ok';}
  const uncertain=await detail(lost,lostQueued.run.id);assert.equal(uncertain.requestStatus,'uncertain');assert.equal(uncertain.canRecover,true);
  await assert.rejects(getAiSuggestion(lost.project,owner,lostQueued.id),{status:404});await assert.rejects(recoverAiSuggestion(lost.project,owner,lostQueued.id,{requestId:randomUUID()},send),{status:404});
  const quote=(await pool.query('SELECT quote_id FROM ai_suggestion_run WHERE id=$1',[lostQueued.id])).rows[0].quote_id;
  await assert.rejects(startAiSuggestions(lost.project,owner,{requestId:randomUUID(),preparationId:quote}),{status:404});
  const prompt=(await prepareAiSuggestions(lost.project,owner,{requestId:randomUUID(),connectionId:lost.connectionId,contextRevision:1,profileId:'benchmark-mini-v1',benchmark:true,topic:'Coffee',country:'Global',language:'English',sectionKeys:[],competitorIds:[],excludedPrompts:[]},send)).preparation;
  const promptRun=(await startAiSuggestions(lost.project,owner,{requestId:randomUUID(),preparationId:prompt.id})).run;assert.equal(promptRun.status,'queued');
  await executeAiSuggestion(lostQueued.id,send);await advanceSiteAnalysis(lostQueued.run.id,send);const recovery={requestId:randomUUID()},recovered=await recoverSiteAnalysis(lost.project,owner,lostQueued.run.id,recovery,send);assert.equal(recovered.run.requestStatus,'settled');assert.equal(recovered.run.proposal,null);
  await recoverSiteAnalysis(lost.project,owner,lostQueued.run.id,recovery,send);await executeAiSuggestion(lostQueued.id,send);assert.equal(completions,lostBefore+1);assertNoApiMoney(recovered);
  console.log('PASS uncertain analysis coexists with prompt work, purpose boundaries hide children and recovery never reposts');

  const unknown=await fixture(),unknownQueued=await queued(unknown),unknownBefore=completions;mode='unknown';try{await executeAiSuggestion(unknownQueued.id,send);}finally{mode='ok';}
  assert.equal((await detail(unknown,unknownQueued.run.id)).requestStatus,'uncertain');assert.equal((await detail(unknown,unknownQueued.run.id)).canRecover,false);await executeAiSuggestion(unknownQueued.id,send);assert.equal(completions,unknownBefore+1);
  await pool.query('UPDATE site_analysis_run SET ai_run_id=NULL WHERE id=$1',[unknownQueued.run.id]);const beforeMissing=requests;await advanceSiteAnalysis(unknownQueued.run.id,send);assert.equal((await detail(unknown,unknownQueued.run.id)).status,'unavailable');assert.equal(requests,beforeMissing);assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_suggestion_run WHERE project_id=$1 AND purpose='site-analysis'",[unknown.project])).rows[0].n,1);
  console.log('PASS missing generation or child linkage cannot recreate or automatically replay the original AI request');

  for(const invalid of ['invalid','foreign-evidence'] as const){const test=await fixture(),run=await queued(test);mode=invalid;try{await executeAiSuggestion(run.id,send);}finally{mode='ok';}const result=await detail(test,run.run.id);assert.equal(result.status,'failed');assert.equal(result.requestStatus,'settled');assert.equal(result.proposal,null);assert.equal((await getProjectContext(test.project,owner)).revision,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM context_persona WHERE project_id=$1',[test.project])).rows[0].n,0);}
  console.log('PASS invalid structured output or foreign evidence settles the original request without saving context');

  const retained=await fixture(),retainedDone=await completed(retained),retainedChild=await child(retainedDone.id),retainedSave=acceptance(retainedDone);assert.ok(retainedChild);
  await pool.query("UPDATE ai_suggestion_quote SET created_at=clock_timestamp()-interval '91 days' WHERE id=(SELECT quote_id FROM ai_suggestion_run WHERE id=$1)",[retainedChild]);
  const hidden=await detail(retained,retainedDone.id);assert.equal(hidden.proposal,null);assert.equal(hidden.evidence,null);assert.equal(hidden.resultExpired,true);await assert.rejects(acceptSiteAnalysis(retained.project,owner,retainedDone.id,retainedSave),{status:409});
  await runRetentionBatch(retained.project);await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650 WHERE id=$1',[retained.workspace]);assert.equal((await detail(retained,retainedDone.id)).proposal,null);await assert.rejects(acceptSiteAnalysis(retained.project,owner,retainedDone.id,retainedSave),{status:409});
  assertNoApiMoney(await getSiteAnalyses(retained.project,viewer));assert.equal(outbound,0);assert.ok(requests<=100);
  console.log('PASS retention hides input and proposals immediately, refuses acceptance and cannot resurrect expired evidence');

  const api=await fixture(),password=randomBytes(24).toString('hex'),passwordHash=await hashPassword(password);
  const cookies=new Map<string,string>();
  for(const user of [owner,viewer]){
   await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),user,passwordHash]);
   const login=await getAuth().handler(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:config.appUrl},body:JSON.stringify({email:`${user}@analysis.integration.test`,password})}));
   assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');assert.ok(cookie);cookies.set(user,cookie);
  }
  const apiBase=`${config.appUrl}/api/projects/${api.project}/site-analysis`;
  const apiRequest=(path='',method='GET',body?:unknown,user=owner,requestOrigin=config.appUrl,base=apiBase)=>new Request(base+path,{method,headers:{cookie:cookies.get(user)!,origin:requestOrigin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const providerBeforeApi=requests,completionsBeforeApi=completions;let apiRequests=0;
  const invoke=(request:Request)=>{apiRequests++;assert.ok(apiRequests<=100);return handleApi(request);};
  assert.equal((await invoke(new Request(apiBase))).status,401);
  assert.equal((await invoke(apiRequest('/runs','POST',api.input,owner,'https://foreign.example.org'))).status,403);
  assert.equal((await invoke(apiRequest('?unknown=x'))).status,400);
  assert.equal((await invoke(apiRequest('','PUT'))).status,405);
  // The API project gate masks non-writer access before the analysis owner's role check.
  assert.equal((await invoke(apiRequest('/runs','POST',api.input,viewer))).status,404);
  const createdResponse=await invoke(apiRequest('/runs','POST',api.input));assert.equal(createdResponse.status,202);const created=await createdResponse.json();assertNoApiMoney(created);
  assert.deepEqual(created.acknowledgement,{requestId:api.input.requestId,runId:created.run.id,operation:'start'});assert.equal(created.run.status,'crawling');assert.equal(created.replayed,false);
  const replayResponse=await invoke(apiRequest('/runs','POST',api.input));assert.equal(replayResponse.status,202);const replay=await replayResponse.json();assert.equal(replay.run.id,created.run.id);assert.equal(replay.replayed,true);assert.deepEqual(replay.acknowledgement,created.acknowledgement);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM site_analysis_run WHERE project_id=$1',[api.project])).rows[0].n,1);
  const apiList=await invoke(apiRequest());assert.equal(apiList.status,200);const listed=await apiList.json();assert.deepEqual(listed.runs.map((run:{id:string})=>run.id),[created.run.id]);assertNoApiMoney(listed);
  const apiDetail=await invoke(apiRequest('/runs/'+created.run.id));assert.equal(apiDetail.status,200);assert.equal((await apiDetail.json()).run.id,created.run.id);
  const viewerDetail=await invoke(apiRequest('/runs/'+created.run.id,'GET',undefined,viewer));assert.equal(viewerDetail.status,200);const viewerResult=await viewerDetail.json();assert.equal(viewerResult.role,'viewer');assert.equal(viewerResult.run.id,created.run.id);assert.equal(viewerResult.run.canCancel,false);
  const foreignBase=`${config.appUrl}/api/projects/${f.project}/site-analysis`;assert.equal((await invoke(apiRequest('/runs/'+created.run.id,'GET',undefined,owner,config.appUrl,foreignBase))).status,404);
  assert.equal((await invoke(apiRequest('/runs/'+created.run.id+'/accept','POST',acceptance(done),viewer))).status,404);
  const cancelRequest={requestId:randomUUID()},cancelResponse=await invoke(apiRequest('/runs/'+created.run.id+'/cancel','POST',cancelRequest));assert.equal(cancelResponse.status,200);const cancelledApi=await cancelResponse.json();assert.equal(cancelledApi.run.status,'cancelled');assert.deepEqual(cancelledApi.acknowledgement,{requestId:cancelRequest.requestId,runId:created.run.id,operation:'cancel'});assertNoApiMoney(cancelledApi);
  assert.equal((await pool.query('SELECT status FROM site_audit_run WHERE id=$1',[created.run.auditId])).rows[0].status,'cancelled');
  assert.equal(requests,providerBeforeApi);assert.equal(completions,completionsBeforeApi);assert.equal(outbound,0);
  console.log('PASS native site analysis API cookie and Origin auth, route validation, Run replay, viewer isolation and cancellation');
 }finally{globalThis.fetch=originalFetch;await stopJobs();await closeDatabase();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runSiteAnalysisChecks();
