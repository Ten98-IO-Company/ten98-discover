import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {FoundationError} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {canonicalHash} from '../src/server/context-input.ts';
import {saveProvider} from '../src/server/providers.ts';
import {dataforseoRefusalMessage} from '../src/server/dataforseo-transport.ts';
import {compileRankPlan,rankGroupPayload,rankPlanTotal} from '../src/server/rank-execution-plan.ts';
import {listRankRuns,getLatestRankResults,getRankKeywordHistory} from '../src/server/rank-history.ts';

export async function runRankHistoryChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_RANK_HISTORY_TEST,'1');
  const config=getConfig(),url=new URL(config.databaseUrl),loopback=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_rank_history_ci';
  assert.ok(loopback.includes(url.hostname)&&loopback.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.equal(url.search,'');assert.equal(url.hash,'');assert.match(url.pathname,/^\/ten98_rank_history_[a-z0-9_]+$/);
  await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh owned migrated fixture.');
  const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('History must never request a provider.');};
  const owner=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),now=Date.now();
  const at=(days:number)=>new Date(now-days*86400000).toISOString();
  const fails=(status:number)=>(e:unknown)=>e instanceof FoundationError&&e.status===status;
  for(const id of [owner,viewer,outsider])await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[id,'Synthetic history reader',id+'@integration.test']);
  type Keyword={id:string;keyword:string;matchCase:boolean};
  async function fixture(terms=['C++ %20','Never checked']){
    const f={workspace:randomUUID(),project:randomUUID(),tracker:randomUUID(),connection:'',keywords:terms.map(keyword=>({id:randomUUID(),keyword,matchCase:true}))};
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Rank history fixture')",[f.workspace]);
    for(const [uid,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[f.workspace,uid,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'History','https://example.com',$3,'infinity')",[f.project,f.workspace,randomUUID()]);
    f.connection=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic history account',credentials:{login:'history@integration.test',password:'synthetic-only'}})).connection.id;
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
      VALUES($1,$2,$3,'History tracker','example.com',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),'both',100,1)`,[f.tracker,f.workspace,f.project]);
    for(const k of f.keywords)await pool.query('INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,match_case) VALUES($1,$2,$3,$4,$5,$6)',[k.id,f.workspace,f.project,f.tracker,k.keyword,k.matchCase]);return f;
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  type Options={device?:'desktop'|'mobile'|'both';status?:'ranked'|'not_found'|'failed'|'pending';position?:number;basis?:'organic'|'absolute';observed?:string;created?:string;started?:string;subset?:boolean;runStatus?:'completed'|'partial'|'failed'|'waiting';target?:Record<string,unknown>;quote?:boolean;keywords?:Keyword[]};
  async function run(f:Fixture,opt:Options={}){
    const id=randomUUID(),dispatch=randomUUID(),created=opt.created??at(0),device=opt.device??'desktop',state=opt.status??'ranked',keywords=opt.keywords??[f.keywords[0]];
    const plan=compileRankPlan({method:'queued',target:{domain:'example.com',locationCode:2840,languageCode:'en',depth:100,maxCrawlPages:1,...opt.target},devices:device,keywords,baseMicros:1000n});
    const estimate=rankPlanTotal(plan).toString(),status=opt.quote?'quoted':opt.runStatus??(state==='failed'?'failed':'completed');
    await pool.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,expires_at,request_key,is_subset,created_at,started_at,completed_at)
      VALUES($1,$2,$3,$4,$5,'manual','queued',$6,1,1,$7,1,$8,'Synthetic',$9,$10,$11,$12,$13::timestamptz,$13::timestamptz+interval '5 minutes',$14,$15,$13,$16,$17)`,
      [id,f.workspace,f.project,f.tracker,owner,status,f.connection,'a'.repeat(64),JSON.stringify(plan),canonicalHash(plan),plan.tasks.length,estimate,created,opt.quote?null:randomUUID(),opt.subset??false,opt.quote?null:opt.started??created,opt.quote||status==='waiting'?null:created]);
    if(opt.quote)return {id,dispatch,tasks:[] as string[]};
    await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,connection_revision,status,budget_month)
      VALUES($1,$2,$3,$4,$5,'rank.queued',$6,$7,$7,1,'settled',date_trunc('month',now())::date)`,[dispatch,f.workspace,f.connection,owner,randomUUID(),'b'.repeat(64),estimate]);
    const payload=rankGroupPayload(plan,plan.groups[0]);await pool.query(`INSERT INTO rank_dispatch(id,workspace_id,project_id,run_id,ordinal,method,task_count,request,request_hash,phase,dispatched_at,completed_at)
      VALUES($1,$2,$3,$4,0,'queued',$5,$6,$7,'finished',$8,$8)`,[dispatch,f.workspace,f.project,id,plan.tasks.length,JSON.stringify(payload),canonicalHash(payload),created]);
    const measured=state==='ranked'||state==='not_found',ranked=state==='ranked',position=opt.position??8;
    await pool.query(`INSERT INTO rank_task(id,workspace_id,project_id,run_id,dispatch_id,keyword_id,keyword,match_case,device,result_status,position,rank_basis,absolute_position,ranking_url,serp_features,checked_depth,returned_item_count,observed_at,retrieved_at,raw_evidence)
      SELECT t.id,$2,$3,$4,$5,t."keywordId",t.keyword,t."matchCase",t.device,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15
      FROM jsonb_to_recordset($1::jsonb) AS t(id uuid,"keywordId" uuid,keyword text,"matchCase" boolean,device text)`,
      [JSON.stringify(plan.tasks),f.workspace,f.project,id,dispatch,state,ranked?position:null,ranked?opt.basis??'organic':null,ranked?position:null,ranked?'https://example.com/result':null,measured?'["organic"]':null,measured?10:null,measured?10:null,measured?opt.observed??created:null,measured?'{}':null]);
    return {id,dispatch,tasks:plan.tasks.map(t=>t.id)};
  }
  const latest=(f:Fixture,params=new URLSearchParams())=>getLatestRankResults(f.project,viewer,f.tracker,params);
  const chosen=(value:Awaited<ReturnType<typeof latest>>,id:string,device='desktop')=>{const row=value.rows.find(r=>r.keywordId===id&&r.device===device);assert.ok(row);return row;};
  try{
    const f=await fixture();await run(f,{created:at(2),position:20});const good=await run(f,{created:at(.5),position:3,subset:true,runStatus:'partial'}),failed=await run(f,{created:at(.1),status:'failed'}),mobile=await run(f,{created:at(.2),device:'mobile',status:'not_found'});
    const l=await latest(f),desktop=chosen(l,f.keywords[0].id),m=chosen(l,f.keywords[0].id,'mobile'),missing=chosen(l,f.keywords[1].id);
    assert.equal(l.role,'viewer');assert.equal(desktop.latestObservation?.runId,good.id);assert.equal(desktop.latestObservation?.isSubset,true);assert.equal(desktop.latestObservation?.runStatus,'partial');assert.equal(desktop.latestAttempt?.runId,failed.id);assert.equal(desktop.latestAttempt?.status,'failed');assert.equal(desktop.observationStatus,'available');assert.equal(m.latestObservation?.runId,mobile.id);assert.equal(m.latestObservation?.status,'not_found');assert.equal(m.latestObservation?.position,null);assert.equal(m.latestObservation?.checkedDepth,10);assert.equal(missing.latestObservation,null);assert.equal(missing.latestAttempt,null);assert.equal(missing.observationStatus,'not_checked');assert.ok(m.baselines.every(b=>b.change===null));
    const order=await fixture(['Quote and start order']);
    const earlierQuote=await run(order,{created:at(.05),started:at(.047),observed:at(.047),status:'failed'});
    await run(order,{created:at(.049),started:at(.048),observed:at(.048),position:2});
    assert.equal(chosen(await latest(order),order.keywords[0].id).latestAttempt?.runId,earlierQuote.id);
    assert.equal((await getRankKeywordHistory(order.project,viewer,order.tracker,order.keywords[0].id)).observations[0].runId,earlierQuote.id);
    console.log('PASS latest successful partial/subset observation is separate from failed attempt, missing checks and observed not-found; start order beats quote order');

    const b=await fixture(['Baselines','Earliest fallback','Mixed basis','Prior not found','Current not found']),expected=[];
    for(const [days,position]of [[100,40],[40,30],[10,20],[2,10],[.5,5]])expected.push(await run(b,{created:at(days),position}));
    const fallback=await run(b,{created:at(.2),keywords:[b.keywords[1]],position:11});
    await run(b,{created:at(2),keywords:[b.keywords[2]],basis:'absolute',position:18});await run(b,{created:at(.1),keywords:[b.keywords[2]],basis:'organic',position:6});
    await run(b,{created:at(2),keywords:[b.keywords[3]],status:'not_found'});await run(b,{created:at(.1),keywords:[b.keywords[3]],position:6});
    await run(b,{created:at(2),keywords:[b.keywords[4]],position:6});await run(b,{created:at(.1),keywords:[b.keywords[4]],status:'not_found'});
    const bl=await latest(b),row=chosen(bl,b.keywords[0].id);assert.equal(row.latestObservation?.runId,expected[4].id);
    assert.deepEqual(row.baselines.map(x=>x.days),[1,7,30,90]);assert.deepEqual(row.baselines.map(x=>x.observation?.runId),[expected[3].id,expected[2].id,expected[1].id,expected[0].id]);assert.deepEqual(row.baselines.map(x=>x.change),[5,15,25,35]);assert.ok(row.baselines.every(x=>x.source==='at_or_before'&&Date.parse(x.observation!.observedAt!)<=Date.parse(x.targetAt)));
    const fb=chosen(bl,b.keywords[1].id);assert.ok(fb.baselines.every(x=>x.source==='earliest_available'&&x.observation?.runId===fallback.id&&x.change===null));assert.equal(chosen(bl,b.keywords[2].id).baselines[0].change,null);assert.equal(chosen(bl,b.keywords[3].id).baselines[0].change,null);assert.equal(chosen(bl,b.keywords[4].id).baselines[0].change,null);
    const tied=await fixture(['Tied timestamp']);
    const tieA=await run(tied,{created:at(2),observed:at(2),position:3}),tieB=await run(tied,{created:at(1.9),observed:at(2),position:9});
    const high=[tieA.tasks[0],tieB.tasks[0]].sort().at(-1)!;
    const tieLatest=chosen(await latest(tied),tied.keywords[0].id);assert.equal(tieLatest.latestObservation?.taskId,high);assert.equal(tieLatest.baselines[0].observation?.taskId,high);assert.equal(tieLatest.baselines[0].change,null);
    console.log('PASS dated 1/7/30/90 baselines, explicit earliest fallback, deterministic timestamp ties and no invented delta across missing/same/basis-incompatible observations');

    const c=await fixture(['Compatibility']);const compatible=await run(c,{created:at(2),position:9});
    for(const [i,target]of [{domain:'other.example.com'},{locationCode:2826},{languageCode:'fr'},{depth:50},{maxCrawlPages:2}].entries())await run(c,{created:at(.2-i*.01),target,position:1});
    assert.equal(chosen(await latest(c),c.keywords[0].id).latestObservation?.runId,compatible.id);assert.equal(chosen(await latest(c),c.keywords[0].id).latestAttempt?.compatible,false);
    const history=await getRankKeywordHistory(c.project,viewer,c.tracker,c.keywords[0].id);assert.equal(history.observations.length,6);assert.equal(history.observations.filter(x=>x.compatible).length,1);assert.equal(history.observations[0].target.maxCrawlPages,2);
    await pool.query('UPDATE rank_config SET serp_depth=20 WHERE id=$1',[c.tracker]);assert.equal(chosen(await latest(c),c.keywords[0].id).observationStatus,'incompatible');
    const removedId=f.keywords[0].id;await pool.query('DELETE FROM rank_keyword WHERE id=$1',[removedId]);const newId=randomUUID();await pool.query('INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,match_case) VALUES($1,$2,$3,$4,$5,true)',[newId,f.workspace,f.project,f.tracker,f.keywords[0].keyword]);
    assert.equal(chosen(await latest(f),newId).observationStatus,'not_checked');const removed=await getRankKeywordHistory(f.project,viewer,f.tracker,removedId);assert.equal(removed.keyword.removed,true);assert.equal(removed.observations.length,4);
    console.log('PASS exact immutable target compatibility, device isolation and removed UUID history without spelling-based rebinding');

    const e=await fixture(['Run expiry','Task expiry','Raw only']),er=await run(e,{keywords:[e.keywords[0]]}),et=await run(e,{keywords:[e.keywords[1]]}),raw=await run(e,{keywords:[e.keywords[2]]});
    await pool.query('UPDATE rank_run SET raw_expired_at=now(),data_expired_at=now() WHERE id=$1',[er.id]);
    await pool.query('UPDATE rank_task SET raw_expired_at=now(),data_expired_at=now(),position=NULL,rank_basis=NULL,absolute_position=NULL,ranking_url=NULL,serp_features=NULL,raw_evidence=NULL WHERE run_id=$1',[et.id]);
    await pool.query('UPDATE rank_run SET raw_expired_at=now() WHERE id=$1',[raw.id]);
    const expired=await latest(e);for(const keyword of e.keywords.slice(0,2)){const result=chosen(expired,keyword.id);assert.equal(result.latestObservation,null);assert.equal(result.observationStatus,'expired');assert.ok(result.latestAttempt?.dataExpiredAt);for(const key of ['position','rankBasis','absolutePosition','rankingUrl','serpFeatures','checkedDepth','returnedItemCount']as const)assert.equal(result.latestAttempt?.[key],null);assert.ok(result.baselines.every(x=>!x.observation));}
    assert.equal(chosen(expired,e.keywords[2].id).latestObservation?.position,8);assert.ok(chosen(expired,e.keywords[2].id).latestObservation?.rawExpiredAt);
    const eh=await getRankKeywordHistory(e.project,viewer,e.tracker,e.keywords[0].id);assert.equal(eh.observations[0].position,null);assert.ok(eh.observations[0].dataExpiredAt);await pool.query('UPDATE workspace SET derived_history_days=3650 WHERE id=$1',[e.workspace]);assert.equal(chosen(await latest(e),e.keywords[0].id).observationStatus,'expired');
    console.log('PASS run/task tombstones mask residual children and baselines; raw-only expiry preserves derived observations');

    const p=await fixture(['Page keyword']);const ids=[];for(let i=0;i<53;i++)ids.push((await run(p,{created:'2026-01-01T00:00:00.'+String(i+1).padStart(6,'0')+'Z',status:'failed'})).id);
    const first=await listRankRuns(p.project,viewer,p.tracker);assert.equal(first.runs.length,50);assert.ok(first.nextCursor);const second=await listRankRuns(p.project,viewer,p.tracker,new URLSearchParams({cursor:first.nextCursor}));assert.equal(second.runs.length,3);assert.equal(new Set([...first.runs,...second.runs].map(x=>x.id)).size,53);assert.deepEqual([...first.runs,...second.runs].map(x=>x.id),ids.toReversed());
    const h1=await getRankKeywordHistory(p.project,viewer,p.tracker,p.keywords[0].id);assert.equal(h1.observations.length,50);assert.ok(h1.nextCursor);const h2=await getRankKeywordHistory(p.project,viewer,p.tracker,p.keywords[0].id,new URLSearchParams({cursor:h1.nextCursor}));assert.equal(h2.observations.length,3);assert.equal(new Set([...h1.observations,...h2.observations].map(x=>x.taskId)).size,53);
    const kw=await fixture(Array.from({length:53},(_,i)=>'Literal_% '+i));for(let i=0;i<kw.keywords.length;i++)await pool.query('UPDATE rank_keyword SET created_at=$2 WHERE id=$1',[kw.keywords[i].id,'2026-01-01T00:00:00.'+String(i+1).padStart(6,'0')+'Z']);
    const k1=await latest(kw,new URLSearchParams({device:'desktop',search:'_%'}));assert.equal(k1.rows.length,50);assert.ok(k1.nextCursor);const k2=await latest(kw,new URLSearchParams({device:'desktop',search:'_%',cursor:k1.nextCursor}));assert.equal(k2.rows.length,3);assert.equal(new Set([...k1.rows,...k2.rows].map(x=>x.keywordId)).size,53);
    await assert.rejects(latest(kw,new URLSearchParams({device:'mobile',search:'_%',cursor:k1.nextCursor})),fails(400));await assert.rejects(listRankRuns(f.project,viewer,f.tracker,new URLSearchParams({cursor:first.nextCursor})),fails(400));await assert.rejects(getRankKeywordHistory(p.project,viewer,p.tracker,p.keywords[0].id,new URLSearchParams({device:'mobile',cursor:h1.nextCursor})),fails(400));
    await pool.query('UPDATE rank_keyword SET pinned_at=now() WHERE id=$1',[kw.keywords[0].id]);assert.equal((await latest(kw,new URLSearchParams({pinned:'true'}))).rows.length,2);
    console.log('PASS microsecond keyset pages for runs/keywords/history, literal search, pins and filter/project-bound cursors');

    const ledger=await fixture(['Costs']),charge=await run(ledger),quote=await run(ledger,{quote:true,created:at(1)});await pool.query("UPDATE rank_dispatch SET phase='uncertain' WHERE id=$1",[charge.dispatch]);
    const list=await listRankRuns(ledger.project,viewer,ledger.tracker),summary=list.runs.find(r=>r.id===charge.id)!;assert.equal(summary.costStatus,'uncertain');assert.equal(summary.knownChargeUsd,'0.001000');assert.equal(list.runs.find(r=>r.id===quote.id)?.costStatus,'not_started');assert.equal(list.runs.find(r=>r.id===quote.id)?.quoteExpired,true);assert.ok(!JSON.stringify(list).includes('account_fingerprint'));assert.ok(!JSON.stringify(list).includes('tasks'));assert.equal(list.runs.length,2);
    for(const action of [()=>listRankRuns(f.project,outsider,f.tracker),()=>latest({...f,tracker:ledger.tracker}),()=>getRankKeywordHistory(f.project,viewer,f.tracker,ledger.keywords[0].id)])await assert.rejects(action(),fails(404));
    for(const params of [new URLSearchParams('device=desktop&device=mobile'),new URLSearchParams('search=%00'),new URLSearchParams('pinned=1'),new URLSearchParams('limit=2000')])await assert.rejects(latest(f,params),fails(400));
    const lock=await pool.connect();try{await lock.query('BEGIN');await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[ledger.workspace]);let done=false;const pending=listRankRuns(ledger.project,viewer,ledger.tracker).then(()=>{done=true;throw new Error('Removed membership was reused.');},error=>{done=true;assert.ok(fails(404)(error));});await delay(50);assert.equal(done,false);await lock.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[ledger.workspace,viewer]);await lock.query('COMMIT');await pending;}finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();}
    assert.equal(calls,0);console.log('PASS exact financial summaries, current viewer/tenant authority and role removal while waiting for workspace gate; zero provider calls');

    const password=randomBytes(24).toString('base64url');
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),viewer,await hashPassword(password)]);
    const login=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:viewer+'@integration.test',password})}));assert.equal(login.status,200);
    const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),path='/api/projects/'+b.project+'/rank-trackers/'+b.tracker;
    const api=(suffix:string,method='GET')=>handleApi(new Request(config.appUrl+path+suffix,{method,headers:{cookie,origin:config.appUrl,'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})}));
    for(const suffix of ['/runs','/results?device=desktop&search=Baselines','/keywords/'+b.keywords[0].id+'/history']){
      const reply=await api(suffix);assert.equal(reply.status,200);const text=await reply.text(),body=JSON.parse(text);assert.equal(body.role,'viewer');for(const secret of ['encrypted_credentials','account_fingerprint','synthetic-only','raw_evidence'])assert.ok(!text.includes(secret));
      assert.equal((await api(suffix,'POST')).status,405);
    }
    assert.equal((await api('/results?device=desktop&search=Baselines').then(r=>r.json())).rows.length,1);
    for(const suffix of ['/runs?unknown=1','/results?device=desktop&device=mobile','/keywords/'+b.keywords[0].id+'/history?limit=999'])assert.equal((await api(suffix)).status,400);
    assert.equal((await handleApi(new Request(config.appUrl+path+'/runs'))).status,401);
    const token=(await createApiKey(b.workspace,owner,{name:'No rank capability',scopes:['projects:read']})).token;
    assert.equal((await handleApi(new Request(config.appUrl+path+'/runs',{headers:{authorization:'Bearer '+token}}))).status,403);
    assert.equal((await handleApi(new Request(config.appUrl+'/api/projects/'+f.project+'/rank-trackers/'+b.tracker+'/runs',{headers:{cookie}}))).status,404);
    console.log('PASS actual cookie-only rank history API: viewer reads, literal filters, wrong methods, unknown parameters, tenant boundary and secret-free responses');

    // rank:read bearer family: the same three readers under the shared bounded gate; provider-ledger amounts never reach a key.
    const rankKey=await createApiKey(b.workspace,owner,{name:'Rank history reader',scopes:['rank:read']});
    const bearer=(suffix:string,method='GET',headers:Record<string,string>={},token=rankKey.token)=>handleApi(new Request(config.appUrl+path+suffix,{method,headers:{authorization:'Bearer '+token,...headers},...(method==='POST'?{body:'{}'}:{})}));
    // Latest-results baselines date their targets from the per-call report time: checked against it, then dropped with it.
    const undated=(value:unknown)=>{const copy=JSON.parse(JSON.stringify(value));if(copy.asOf){for(const row of copy.rows)for(const x of row.baselines){assert.equal(Date.parse(x.targetAt),Date.parse(copy.asOf)-x.days*86400000);delete x.targetAt;}delete copy.asOf;}return copy;};
    const direct=[['/runs',()=>listRankRuns(b.project,owner,b.tracker,new URLSearchParams(),rankKey.token)],
      ['/results?device=desktop',()=>getLatestRankResults(b.project,owner,b.tracker,new URLSearchParams({device:'desktop'}),rankKey.token)],
      ['/keywords/'+b.keywords[0].id+'/history',()=>getRankKeywordHistory(b.project,owner,b.tracker,b.keywords[0].id,new URLSearchParams(),rankKey.token)]] as const;
    // Diagnostics restate cost and approval state: the worker's uncertain-charge text and a schedule skip on runs, a provider wallet refusal on a task.
    const uncertainText='The provider charge or result could not be confirmed. An owner must reconcile this check; it will not be sent again.',skipText='Skipped: paid work is paused or an earlier charge is uncertain. No paid request was sent.';
    await pool.query('UPDATE rank_run SET diagnostic=$2 WHERE id=$1',[expected[4].id,uncertainText]);await pool.query('UPDATE rank_run SET diagnostic=$2 WHERE id=$1',[expected[3].id,skipText]);
    await pool.query('UPDATE rank_task SET diagnostic=$2 WHERE id=$1',[expected[4].tasks[0],dataforseoRefusalMessage.payment]);
    for(const [suffix,read] of direct){
      const reply=await bearer(suffix);assert.equal(reply.status,200,suffix);const text=await reply.text(),body=JSON.parse(text);assert.equal(body.role,'owner');assert.deepEqual(undated(body),undated(await read()));
      for(const secret of ['encrypted_credentials','account_fingerprint','synthetic-only','raw_evidence','estimateUsd','knownChargeUsd','costStatus','"diagnostic"',uncertainText,skipText,dataforseoRefusalMessage.payment])assert.ok(!text.includes(secret),suffix+' '+secret);
      assert.equal((await bearer(suffix,'POST')).status,403,suffix);
    }
    const keyRuns=await bearer('/runs').then(r=>r.json()),cookieRuns=await api('/runs').then(r=>r.json());assert.equal(keyRuns.runs.length,12);
    assert.ok(cookieRuns.runs.every((r:any)=>/^\d+\.\d{6}$/.test(r.estimateUsd)&&/^\d+\.\d{6}$/.test(r.knownChargeUsd)&&r.costStatus==='final'));
    assert.deepEqual(cookieRuns.runs.filter((r:any)=>r.diagnostic!==null).map((r:any)=>[r.id,r.diagnostic]),[[expected[4].id,uncertainText],[expected[3].id,skipText]]);
    assert.deepEqual(cookieRuns.runs.map(({estimateUsd:_e,knownChargeUsd:_k,costStatus:_c,diagnostic:_d,...run}:any)=>run),keyRuns.runs);
    // The cookie results and history keep the task diagnostic on every observation the key answer returns without it.
    const desktopRow=(value:any)=>value.rows.find((r:any)=>r.keywordId===b.keywords[0].id&&r.device==='desktop');
    const cookieLatest=desktopRow(await api('/results?device=desktop').then(r=>r.json())),keyLatest=desktopRow(await bearer('/results?device=desktop').then(r=>r.json()));
    const cookieHistory=await api('/keywords/'+b.keywords[0].id+'/history').then(r=>r.json()),keyHistory=await bearer('/keywords/'+b.keywords[0].id+'/history').then(r=>r.json());
    for(const [cookieObservation,keyObservation] of [[cookieLatest.latestAttempt,keyLatest.latestAttempt],[cookieLatest.latestObservation,keyLatest.latestObservation],[cookieHistory.observations[0],keyHistory.observations[0]]]){
      assert.equal(cookieObservation.taskId,expected[4].tasks[0]);assert.equal(cookieObservation.diagnostic,dataforseoRefusalMessage.payment);
      const {diagnostic:_d,...rest}=cookieObservation;assert.deepEqual(keyObservation,rest);assert.equal(Object.hasOwn(keyObservation,'diagnostic'),false);
    }
    assert.equal((await bearer('/runs?unknown=1')).status,400);assert.equal((await bearer('/runs','GET',{cookie})).status,400);
    for(const target of ['/api/projects/'+b.project+'/rank-checks/'+expected[0].id,'/api/projects/'+b.project+'/rank-trackers/'+b.tracker+'/schedule'])assert.equal((await handleApi(new Request(config.appUrl+target,{headers:{authorization:'Bearer '+rankKey.token}}))).status,403,target);
    const other=await fixture(['Other workspace']),foreign=await createApiKey(other.workspace,owner,{name:'Other workspace reader',scopes:['rank:read']});
    assert.equal((await bearer('/runs','GET',{},foreign.token)).status,404);
    // Both callers wait on the workspace gate behind a writer and fail at the 5 s lock bound, well before the pool's 10 s statement bound.
    const block=await pool.connect();try{await block.query('BEGIN');await block.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[b.workspace]);const start=Date.now();
      const [keyBusy,cookieBusy]=await Promise.all([bearer('/runs'),api('/runs')]),elapsed=Date.now()-start;
      assert.equal(keyBusy.status,503);assert.equal(cookieBusy.status,503);assert.ok(elapsed>=4500&&elapsed<10000,String(elapsed));
    }finally{await block.query('ROLLBACK');block.release();}
    await pool.query('UPDATE api_key SET revoked_at=clock_timestamp() WHERE id=$1',[rankKey.key.id]);assert.equal((await bearer('/runs')).status,401);
    assert.equal(calls,0);console.log('PASS rank:read bearer runs/results/history equal the direct reads without ledger amounts; POST, unknown parameter, cookie plus bearer, checks/schedule, foreign workspace and revoked key refused; the shared workspace gate answers 503 to key and cookie at its 5 s bound');

    const perf=await fixture(Array.from({length:50},(_,i)=>'History load '+i));
    for(let i=0;i<365;i++)await run(perf,{keywords:perf.keywords,device:'both',created:at(i+.01),position:(i%30)+1});
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM rank_task WHERE project_id=$1',[perf.project])).rows[0].n,36500);
    const timings:number[]=[];for(let i=0;i<3;i++){const start=performance.now(),result=await latest(perf);timings.push(performance.now()-start);assert.equal(result.rows.length,100);assert.ok(result.rows.every(r=>r.latestObservation?.position===1&&r.baselines.length===4&&r.baselines.every(b=>b.source==='at_or_before')));}
    assert.equal(calls,0);console.log('PASS bounded full100-pair history page over36,500 observations; timings ms='+timings.map(n=>n.toFixed(1)).join(','));
    await pool.query('UPDATE rank_run SET data_expired_at=now(),raw_expired_at=now() WHERE project_id=$1',[perf.project]);const expiredStart=performance.now(),expiredPage=await latest(perf);assert.equal(expiredPage.rows.length,100);assert.ok(expiredPage.rows.every(r=>r.observationStatus==='expired'&&r.latestObservation===null&&r.latestAttempt?.position===null&&r.baselines.every(b=>b.observation===null)));console.log('PASS same36,500 residual payloads remain masked after run tombstones; ms='+(performance.now()-expiredStart).toFixed(1));

  }finally{globalThis.fetch=originalFetch;}
}
if(import.meta.main){try{await runRankHistoryChecks();}finally{await closeDatabase();}}
