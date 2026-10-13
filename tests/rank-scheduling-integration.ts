import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {stopJobs} from '../src/server/jobs.ts';
import {saveProvider,revokeProvider} from '../src/server/providers.ts';
import {getRankTracker,changeRankKeywords,updateRankTracker,archiveRankTracker} from '../src/server/rank-tracking.ts';
import {quoteRankCheck} from '../src/server/rank-execution.ts';
import {compileRankPlan} from '../src/server/rank-execution-plan.ts';
import {getRankSchedule,previewRankSchedule,approveRankSchedule,disableRankSchedule,rankApprovalRequestHash} from '../src/server/rank-scheduling.ts';
import {keywordAccountEndpoint} from '../src/server/keyword-research-input.ts';
import {hashPassword} from 'better-auth/crypto';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';

const fails=(status:number)=>(error:unknown)=>(error as {status?:number})?.status===status;
export async function runRankSchedulingChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_RANK_SCHEDULING_TEST,'1');
  const config=getConfig(),url=new URL(config.databaseUrl),loopback=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_rank_scheduling_ci';
  assert.ok(loopback.includes(url.hostname)&&loopback.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.equal(url.search,'');assert.equal(url.hash,'');assert.match(url.pathname,/^\/ten98_rank_scheduling_[a-z0-9_]+$/);
  await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::integer AS n FROM workspace')).rows[0].n,0,'Use a newly created migrated owned fixture.');
  const owner=randomUUID(),secondOwner=randomUUID(),admin=randomUUID(),editor=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),oldFetch=globalThis.fetch;let unexpected=0,accountCalls=0;
  globalThis.fetch=async()=>{unexpected++;throw new Error('No network belongs to schedule approval.');};
  const send:typeof fetch=async(address,options)=>{assert.equal(address,keywordAccountEndpoint);assert.equal(options?.method,'GET');accountCalls++;const price=[{cost_type:'per_request',cost:.001}];return Response.json({status_code:20000,cost:0,tasks_count:1,tasks_error:0,tasks:[{status_code:20000,cost:0,path:['v3','appendix','user_data'],result_count:1,result:[{login:'schedule@integration.test',price:{serp:{live:{advanced:{priority_normal:price}},task_post:{priority_normal:price},task_get:{advanced:{priority_normal:[{cost_type:'per_request',cost:0}]}}}}}]}]});};
  async function fixture(){
    const f={workspace:randomUUID(),project:randomUUID(),tracker:randomUUID(),connection:''};
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Approval acceptance')",[f.workspace]);
    for(const [uid,role]of [[owner,'owner'],[secondOwner,'owner'],[admin,'admin'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[f.workspace,uid,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Approval acceptance','https://example.com',$3,'infinity')",[f.project,f.workspace,randomUUID()]);
    f.connection=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic schedule account',credentials:{login:'schedule@integration.test',password:'never-live'},monthlyLimitUsd:'0'})).connection.id;
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages) VALUES($1,$2,$3,'Approval acceptance','example.com',2840,'US','Country',2840,'US','en','English',clock_timestamp(),'both',100,1)`,[f.tracker,f.workspace,f.project]);
    await changeRankKeywords(f.project,owner,f.tracker,'add',{requestId:randomUUID(),revision:1,keywords:['C++ %20','Apple'],matchCase:true});return f;
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  const current=(f:Fixture,uid=owner)=>getRankSchedule(f.project,uid,f.tracker);
  const raw=(f:Fixture)=>(pool.query('SELECT * FROM rank_config WHERE id=$1',[f.tracker])).then(r=>r.rows[0]);
  async function quote(f:Fixture,uid=owner,extra:Record<string,unknown>={}){const t=(await getRankTracker(f.project,owner,f.tracker)).tracker;const q=await quoteRankCheck(f.project,uid,f.tracker,{requestId:randomUUID(),connectionId:f.connection,revision:t.revision,keywordsRevision:t.keywordsRevision,method:'queued',...extra},send);assert.ok(q);return q.run;}
  async function body(f:Fixture,quoteId:string,extra:Record<string,unknown>={}){return {requestId:randomUUID(),revision:(await current(f)).authoredRevision,quoteId,maximumUsd:'0.010000',interval:'daily',timezone:'UTC',hour:9,minute:0,...extra};}
  const approve=(f:Fixture,input:unknown,uid=owner)=>approveRankSchedule(f.project,uid,f.tracker,input);
  const schedule={interval:'daily',timezone:'America/New_York',hour:1,minute:30};
  async function noPaidWork(){assert.equal((await pool.query('SELECT count(*)::integer AS n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::integer AS n FROM rank_dispatch')).rows[0].n,0);if((await pool.query("SELECT to_regclass('pgboss.job') AS name")).rows[0].name)assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pgboss.job')).rows[0].n,0);assert.equal(unexpected,0);}
  async function blockedApproval(f:Fixture,input:unknown,mutation:(client:any)=>Promise<unknown>,status:number){
    const gate=await pool.connect();await gate.query('BEGIN');await gate.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[f.workspace]);
    const action=approve(f,input),rejection=assert.rejects(action,fails(status));
    try{let waiting=false;const until=Date.now()+3000;while(!waiting&&Date.now()<until){waiting=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%workspace%' LIMIT 1")).rowCount;if(!waiting)await new Promise(r=>setTimeout(r,10));}assert.ok(waiting,'Approval reached the live workspace gate.');await mutation(gate);await gate.query('COMMIT');}finally{await gate.query('ROLLBACK').catch(()=>{});gate.release();}await rejection;
  }
  try{
    for(const uid of [owner,secondOwner,admin,editor,viewer,outsider])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Schedule fixture\',$2)',[uid,uid+'@integration.test']);
    const f=await fixture(),foreign=await fixture(),q=await quote(f),input=await body(f,q.id),calls=accountCalls;
    for(const uid of [admin,editor,viewer,outsider])await assert.rejects(approve(f,input,uid),fails(404));
    await assert.rejects(getRankSchedule(foreign.project,owner,f.tracker),fails(404));await assert.rejects(current(f,outsider),fails(404));
    assert.equal((await current(f,viewer)).canManage,false);assert.equal((await current(f)).schedule.approval,null);
    const keyring=process.env.CREDENTIAL_KEYS;delete process.env.CREDENTIAL_KEYS;try{const visible=await current(f,viewer);assert.equal(visible.schedule.enabled,false);}finally{process.env.CREDENTIAL_KEYS=keyring;}
    for(const uid of [admin,editor,viewer])await assert.rejects(previewRankSchedule(f.project,uid,f.tracker,schedule),fails(404));
    const preview=await previewRankSchedule(f.project,owner,f.tracker,schedule);assert.equal(preview.occurrences.length,5);let prior=preview.capturedAt;
    for(const item of preview.occurrences){assert.ok(item.utc>prior);assert.match(item.local,/^\d{4}-\d\d-\d\dT01:30:00$/);assert.ok([-14400,-18000].includes(item.offsetSeconds));assert.equal(Date.parse(item.utc)+item.offsetSeconds*1000,Date.parse(item.local+'Z'));prior=item.utc;}
    for(const bad of [{...schedule,timezone:'not/a-zone'},{...schedule,weekday:0},{...schedule,interval:'weekly'},{...schedule,hour:24},{...schedule,minute:60},{...schedule,timezone:'UTC\n'},{...schedule,after:'2026-01-01'}])await assert.rejects(previewRankSchedule(f.project,owner,f.tracker,bad),fails(400));
    const monthly=await previewRankSchedule(f.project,owner,f.tracker,{interval:'monthly',timezone:'UTC',hour:9,minute:0});for(const item of monthly.occurrences){const date=new Date(item.utc),next=new Date(date.getTime()+86400000);assert.equal(next.getUTCDate(),1);}
    assert.equal(accountCalls,calls);await noPaidWork();console.log('PASS reader-safe metadata, owner-only approval/preview, exact five calendar occurrences and zero provider work');

    const pair=await Promise.all([approve(f,input),approve(f,input)]);assert.equal(pair.filter(r=>r.replayed).length,1);assert.equal(pair[0].schedule.approval!.id,pair[1].schedule.approval!.id);assert.equal(pair[0].schedule.approvalStale,false);
    const approved=await raw(f);assert.equal(approved.authored_revision,input.revision+1);assert.equal(approved.revision,1);assert.equal(approved.keywords_revision,2,'Adding keywords changes keyword revision only.');
    assert.equal(approved.approval_max_micros,'10000');assert.equal(approved.approval_account_fingerprint_version,2);assert.equal(approved.approval_user_id,owner);assert.ok(approved.next_due_at>approved.approved_at);assert.equal((await pool.query('SELECT status FROM rank_run WHERE id=$1',[q.id])).rows[0].status,'quoted');
    const publicText=JSON.stringify(await current(f));for(const secret of ['fingerprint','request_hash','encrypted_credentials','never-live'])assert.ok(!publicText.includes(secret));
    await assert.rejects(approve(f,{...input,maximumUsd:'0.020000'}),fails(409));await assert.rejects(approve(f,input,secondOwner),fails(409));
    assert.equal((await approve(f,{...input,maximumUsd:'0.01'})).replayed,true);await noPaidWork();console.log('PASS atomic actor-bound approval receipts, exact microUSD ceiling and no quote consumption or paid work');

    const disabled=await disableRankSchedule(f.project,owner,f.tracker,{requestId:randomUUID(),revision:(await current(f)).authoredRevision});assert.equal(disabled.schedule.enabled,false);assert.equal(disabled.schedule.nextDueAt,null);assert.ok(disabled.schedule.staleReasons.includes('disabled'));assert.equal(disabled.schedule.approval!.id,approved.approval_id);
    const replay=await approve(f,input);assert.equal(replay.replayed,true);assert.equal(replay.schedule.enabled,false,'A delayed approval retry cannot re-enable a disabled grant.');
    const reenabled=await approve(f,await body(f,q.id));assert.notEqual(reenabled.schedule.approval!.id,approved.approval_id);assert.equal(reenabled.schedule.enabled,true);
    const beforeRename=await getRankTracker(f.project,owner,f.tracker),t=beforeRename.tracker;
    await updateRankTracker(f.project,owner,f.tracker,{requestId:randomUUID(),revision:t.authoredRevision,name:'Renamed',devices:t.devices,depth:t.depth,maxCrawlPages:t.maxCrawlPages});
    await changeRankKeywords(f.project,owner,f.tracker,'pin',{requestId:randomUUID(),revision:(await current(f)).authoredRevision,keywordIds:[beforeRename.keywords[0].id],pinned:true});assert.equal((await current(f)).schedule.approvalStale,false);
    const oldConfig=await getRankTracker(f.project,owner,f.tracker);await updateRankTracker(f.project,owner,f.tracker,{requestId:randomUUID(),revision:oldConfig.tracker.authoredRevision,name:'Renamed',devices:'desktop',depth:100,maxCrawlPages:1});assert.equal((await current(f)).schedule.enabled,false);await assert.rejects(approve(f,await body(f,q.id)),fails(409));
    console.log('PASS disable/re-enable requires a fresh grant, stale retries stay disabled, names/pins preserve scope and paid changes invalidate it');

    const bad=await fixture(),badQuote=await quote(bad),badInput=await body(bad,badQuote.id);
    for(const maximumUsd of ['0','0.003999','-1','1e2','1\n','1000000.000001','1.0000001'])await assert.rejects(approve(bad,{...badInput,requestId:randomUUID(),maximumUsd}),fails(400));
    await assert.rejects(approve(bad,{...badInput,revision:1}),fails(409));await assert.rejects(approve(bad,badInput,secondOwner),fails(403));await assert.rejects(approve(foreign,await body(foreign,badQuote.id)),fails(404));
    const keywords=(await getRankTracker(bad.project,owner,bad.tracker)).keywords;
    for(const extra of [{method:'live'},{keywordIds:keywords.map(k=>k.id)}]){const unsuitable=await quote(bad,owner,extra);await assert.rejects(approve(bad,await body(bad,unsuitable.id)),fails(409));}
    const removed=await changeRankKeywords(bad.project,owner,bad.tracker,'remove',{requestId:randomUUID(),revision:(await current(bad)).authoredRevision,keywordIds:[keywords[0].id]});await changeRankKeywords(bad.project,owner,bad.tracker,'add',{requestId:randomUUID(),revision:removed.tracker.authoredRevision,keywords:[keywords[0].keyword],matchCase:true});await assert.rejects(approve(bad,await body(bad,badQuote.id)),fails(409));
    const fresh=await quote(bad);await archiveRankTracker(bad.project,owner,bad.tracker,{requestId:randomUUID(),revision:(await current(bad)).authoredRevision,archived:true});await assert.rejects(approve(bad,await body(bad,fresh.id)),fails(409));await noPaidWork();
    console.log('PASS full-quote, actor, revision, exact ceiling, live/subset rejection, remove/recreate and archive boundaries');

    const stale=await fixture(),staleQuote=await quote(stale);await approve(stale,await body(stale,staleQuote.id));
    await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[stale.workspace,owner]);assert.ok((await current(stale,viewer)).schedule.staleReasons.includes('approver_no_longer_owner'));
    await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[stale.workspace,owner]);
    await saveProvider(stale.workspace,owner,{name:'Rotated',credentials:{login:'schedule@integration.test',password:'changed-never-live'},monthlyLimitUsd:'0'},stale.connection);assert.ok((await current(stale,viewer)).schedule.staleReasons.includes('connection_changed'));await assert.rejects(approve(stale,await body(stale,staleQuote.id)),fails(409));
    await revokeProvider(stale.workspace,owner,stale.connection);assert.ok((await current(stale)).schedule.approvalStale);
    console.log('PASS demoted approver and rotated/revoked credentials mark retained grants stale without decrypting');

    const capped=await fixture();await pool.query('UPDATE rank_config SET authored_revision=2147483646 WHERE id=$1',[capped.tracker]);
    const capInput={requestId:randomUUID(),revision:2147483646},capBefore=await raw(capped);
    assert.equal((await disableRankSchedule(capped.project,owner,capped.tracker,capInput)).authoredRevision,2147483646);assert.deepEqual(await raw(capped),capBefore);assert.equal((await disableRankSchedule(capped.project,owner,capped.tracker,capInput)).replayed,true);
    const enabledCap=await fixture(),enabledQuote=await quote(enabledCap);await approve(enabledCap,await body(enabledCap,enabledQuote.id));await pool.query('UPDATE rank_config SET authored_revision=2147483646 WHERE id=$1',[enabledCap.tracker]);
    const revokeCap={requestId:randomUUID(),revision:2147483646},revokedCap=await disableRankSchedule(enabledCap.project,owner,enabledCap.tracker,revokeCap);assert.equal(revokedCap.authoredRevision,2147483646);assert.equal(revokedCap.schedule.enabled,false);assert.equal(revokedCap.schedule.nextDueAt,null);assert.equal((await disableRankSchedule(enabledCap.project,owner,enabledCap.tracker,revokeCap)).replayed,true);await assert.rejects(approve(enabledCap,await body(enabledCap,enabledQuote.id)),fails(409));
    const rotated=await fixture(),beforeRotation=await quote(rotated),authSecret=process.env.AUTH_SECRET;
    process.env.AUTH_SECRET=randomUUID()+randomUUID();try{const afterRotation=await quote(rotated);const fingerprints=(await pool.query('SELECT account_fingerprint,account_fingerprint_version FROM rank_run WHERE id=ANY($1::uuid[])',[[beforeRotation.id,afterRotation.id]])).rows;assert.equal(fingerprints.length,2);assert.equal(fingerprints[0].account_fingerprint,fingerprints[1].account_fingerprint);assert.ok(fingerprints.every(r=>r.account_fingerprint_version===2));assert.equal((await approve(rotated,await body(rotated,beforeRotation.id))).schedule.approvalStale,false);}finally{if(authSecret===undefined)delete process.env.AUTH_SECRET;else process.env.AUTH_SECRET=authSecret;}
    await noPaidWork();console.log('PASS disabled revision-limit no-op receipts and persisted v2 account identity across auth-secret rotation');

    for(const scenario of ['role','expiry'] as const){const race=await fixture(),rq=await quote(race),ri=await body(race,rq.id);await blockedApproval(race,ri,c=>scenario==='role'?c.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[race.workspace,owner]):c.query("UPDATE rank_run SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[rq.id]),scenario==='role'?404:409);assert.equal((await raw(race)).approval_id,null);assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE project_id=$1 AND request_id=$2',[race.project,ri.requestId])).rowCount,0);}
    const atomic=await fixture(),aq=await quote(atomic),ai=await body(atomic,aq.id),before=await raw(atomic);
    await pool.query(`CREATE FUNCTION approval_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation LIKE 'rank.schedule.%' THEN RAISE EXCEPTION 'Synthetic receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER approval_receipt_failure BEFORE INSERT ON project_content_request FOR EACH ROW EXECUTE FUNCTION approval_receipt_failure()`);
    try{await assert.rejects(approve(atomic,ai));}finally{await pool.query('DROP TRIGGER approval_receipt_failure ON project_content_request; DROP FUNCTION approval_receipt_failure()');}assert.deepEqual(await raw(atomic),before);
    const competing=await Promise.allSettled([approve(atomic,ai),approve(atomic,{...ai,requestId:randomUUID(),minute:1})]);assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);assert.equal(competing.filter(r=>r.status==='rejected'&&fails(409)(r.reason)).length,1);await noPaidWork();console.log('PASS live-role/expiry recheck after lock waits and rollback/serialization of grant plus authored revision plus receipt');

    const terms=[{id:randomUUID(),keyword:'C++ %20',matchCase:true},{id:randomUUID(),keyword:'apple',matchCase:false}],base={method:'queued' as const,target:{domain:'example.com',locationCode:2840,languageCode:'en',depth:100,maxCrawlPages:1},devices:'both' as const,keywords:terms};
    const first=compileRankPlan({...base,baseMicros:1000n}),repriced=compileRankPlan({...base,keywords:[...terms].reverse(),baseMicros:2000n});assert.equal(rankApprovalRequestHash(first),rankApprovalRequestHash(repriced));
    for(const changed of [compileRankPlan({...base,devices:'mobile',baseMicros:1000n}),compileRankPlan({...base,target:{...base.target,depth:90},baseMicros:1000n}),compileRankPlan({...base,keywords:[{...terms[0],id:randomUUID()},terms[1]],baseMicros:1000n}),compileRankPlan({...base,keywords:[{...terms[0],keyword:'C %20'},terms[1]],baseMicros:1000n}),compileRankPlan({...base,keywords:[{...terms[0],matchCase:false},terms[1]],baseMicros:1000n})])assert.notEqual(rankApprovalRequestHash(first),rankApprovalRequestHash(changed));
    assert.throws(()=>rankApprovalRequestHash({...first,tasks:[first.tasks[0],first.tasks[0]]}));await noPaidWork();console.log('PASS stable paid-definition hash excludes random identities/prices and binds literal text, case, UUID, device and coverage');

    const http=await fixture(),hq=await quote(http),hi=await body(http,hq.id),cookies=new Map<string,string>(),password=randomUUID()+randomUUID(),passwordHash=await hashPassword(password);
    for(const uid of [owner,admin,editor,viewer,outsider]){await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),uid,passwordHash]);const login=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:uid+'@integration.test',password})}));assert.equal(login.status,200);cookies.set(uid,login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '));}
    const route='/api/projects/'+http.project+'/rank-trackers/'+http.tracker+'/schedule';
    const request=(path=route,method='GET',body?:unknown,uid=owner,headers:Record<string,string>={})=>handleApi(new Request(config.appUrl+path,{method,headers:{cookie:cookies.get(uid)??'',origin:config.appUrl,'content-type':'application/json',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}));
    assert.equal((await handleApi(new Request(config.appUrl+route))).status,401);
    const token=(await createApiKey(http.workspace,owner,{name:'Schedule scope denied',scopes:['projects:read','projects:write']})).token;
    assert.equal((await handleApi(new Request(config.appUrl+route,{headers:{authorization:'Bearer '+token}}))).status,403);assert.equal((await request(route,'GET',undefined,owner,{authorization:'Bearer '+token})).status,400);
    for(const uid of [owner,admin,editor,viewer]){const read=await request(route,'GET',undefined,uid);assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');assert.equal((await read.json()).canManage,uid===owner);}
    assert.equal((await request(route,'GET',undefined,outsider)).status,404);assert.equal((await request(route.replace(http.project,foreign.project))).status,404);
    assert.equal((await request(route+'/preview','POST',schedule,owner,{origin:'https://outside.example.com'})).status,403);
    for(const action of ['preview','approve','disable'])for(const uid of [admin,editor,viewer])assert.equal((await request(route+'/'+action,'POST',action==='preview'?schedule:action==='approve'?hi:{requestId:randomUUID(),revision:hi.revision},uid)).status,404);
    for(const [path,method]of [[route,'POST'],[route+'/preview','GET'],[route+'/approve','PUT'],[route+'/disable','DELETE']])assert.equal((await request(path,method,method==='GET'?undefined:{})).status,405);
    assert.equal((await request(route+'?other=1')).status,400);assert.equal((await request(route+'/approve?other=1','POST',hi)).status,400);assert.equal((await request(route+'/approve','POST','{')).status,400);
    assert.equal((await request(route+'/approve','POST',{...hi,padding:'x'.repeat(8192)})).status,413);
    const httpPreview=await request(route+'/preview','POST',schedule);assert.equal(httpPreview.status,200);assert.equal((await httpPreview.json()).occurrences.length,5);
    const save=await request(route+'/approve','POST',hi);assert.equal(save.status,200);const saved=await save.json();assert.equal(saved.replayed,false);assert.equal(saved.schedule.enabled,true);assert.equal((await (await request(route+'/approve','POST',hi)).json()).replayed,true);
    const disable={requestId:randomUUID(),revision:saved.authoredRevision},disabledHttp=await request(route+'/disable','POST',disable);assert.equal(disabledHttp.status,200);assert.equal((await disabledHttp.json()).schedule.enabled,false);assert.equal((await (await request(route+'/disable','POST',disable)).json()).replayed,true);
    await pool.query("DELETE FROM request_limit WHERE key=$1",['rank-schedule-write:'+owner]);
    for(let n=0;n<10;n++)assert.equal((await request(route+'/preview','POST',schedule)).status,200);assert.equal((await request(route+'/preview','POST',schedule)).status,429);
    await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[http.workspace,viewer]);assert.equal((await request(route,'GET',undefined,viewer)).status,404);await noPaidWork();
    console.log('PASS real schedule HTTP routes: cookie/Origin/roles/scoping, strict methods/query/body caps, receipts, revoke and per-user write rate limit');
  }finally{try{await stopJobs();}finally{globalThis.fetch=oldFetch;}}
}
if(import.meta.main){try{await runRankSchedulingChecks();}finally{await closeDatabase();}}
