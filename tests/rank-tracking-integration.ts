import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {stopJobs} from '../src/server/jobs.ts';
import {saveProvider,revokeProvider} from '../src/server/providers.ts';
import {listRankTrackers,getRankTracker,getRankCatalog,searchRankLocations,createRankTracker,updateRankTracker,archiveRankTracker,changeRankKeywords} from '../src/server/rank-tracking.ts';
import {rankSerpEndpoints} from '../src/server/rank-serp-input.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';

const failed=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
type Fixture={workspace:string;project:string;connection:string};
const locations=[
  {location_code:2840,location_name:'United States',location_code_parent:null,country_iso_code:'US',location_type:'Country'},
  {location_code:2826,location_name:'United Kingdom',location_code_parent:null,country_iso_code:'GB',location_type:'Country'},
  {location_code:1023191,location_name:'New York, United States',location_code_parent:2840,country_iso_code:'US',location_type:'City'},
  {location_code:1006886,location_name:'London, United Kingdom',location_code_parent:2826,country_iso_code:'GB',location_type:'City'},
  {location_code:2060,location_name:'Bermuda',location_code_parent:null,country_iso_code:'BM',location_type:'Region'},
  {location_code:3001,location_name:'Bermuda local region',location_code_parent:3999,country_iso_code:'BM',location_type:'Region'},
  {location_code:20498,location_name:'Iran province',location_code_parent:2364,country_iso_code:'IR',location_type:'Province'},
  {location_code:3002,location_name:'Belarus residual',location_code_parent:2112,country_iso_code:'BY',location_type:'City'},
];

export async function runRankTrackingChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_RANK_TRACKING_TEST,'1');
  const config=getConfig(),db=new URL(config.databaseUrl),loopback=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_rank_tracking_ci';
  assert.ok(loopback.includes(db.hostname));assert.equal(db.port,ci?'5432':'55501');assert.equal(db.search,'');assert.equal(db.hash,'');
  assert.match(db.pathname,/^\/ten98_rank_tracking_[a-z0-9_]+$/);assert.ok(loopback.includes(new URL(config.appUrl).hostname));
  await assertSchema();const pool=getDatabase().pool;
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM workspace')).rows[0].count,0,'Use a fresh migrated owned fixture.');
  const owner=randomUUID(),admin=randomUUID(),editor=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),password=randomBytes(24).toString('base64url');
  const originalFetch=globalThis.fetch;let unexpected=0,freeCalls=0;
  globalThis.fetch=async()=>{unexpected++;throw new Error('External provider traffic is forbidden in rank management acceptance.');};
  const send:typeof fetch=async(address,options)=>{
    assert.equal(options?.method,'GET','Management may only request the free catalog.');assert.equal(options?.redirect,'error');assert.equal(options?.credentials,'omit');assert.ok(options?.signal);
    assert.ok(address===rankSerpEndpoints.locations||address===rankSerpEndpoints.languages,'No account or paid endpoint belongs to management.');freeCalls++;
    const result=address===rankSerpEndpoints.locations?locations:[{language_code:'en',language_name:'English'},{language_code:'es-419',language_name:'Spanish (Latin America)'},{language_code:'sr-Latn',language_name:'Serbian (Latin)'}];
    return Response.json({status_code:20000,cost:0,tasks_count:1,tasks_error:0,tasks:[{status_code:20000,cost:0,path:new URL(String(address)).pathname.slice(1).split('/'),result_count:result.length,result}]});
  };
  async function fixture():Promise<Fixture>{
    const workspace=randomUUID(),project=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Rank management fixture')",[workspace]);
    for(const [uid,role]of [[owner,'owner'],[admin,'admin'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,uid,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Rank management','https://example.com',$3,'infinity')",[project,workspace,randomUUID()]);
    const connection=(await saveProvider(workspace,owner,{provider:'dataforseo',name:'Synthetic catalog',credentials:{login:'rank@example.com',password:'synthetic-never-live'},monthlyLimitUsd:'0'})).connection.id;
    return {workspace,project,connection};
  }
  const creation=(f:Fixture,extra:Record<string,unknown>={})=>({requestId:randomUUID(),connectionId:f.connection,name:'Example tracking',domain:'Example.COM.',countryCode:2840,locationCode:2840,languageCode:'en',devices:'both',depth:100,maxCrawlPages:1,...extra});
  const current=(f:Fixture,id:string,user=owner)=>getRankTracker(f.project,user,id);
  const settings=(t:Awaited<ReturnType<typeof getRankTracker>>['tracker'],extra:Record<string,unknown>={})=>({requestId:randomUUID(),revision:t.authoredRevision,name:t.name,devices:t.devices,depth:t.depth,maxCrawlPages:t.maxCrawlPages,...extra});
  async function role(f:Fixture,uid:string,next:string){const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[f.workspace]);await client.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[f.workspace,uid,next]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
  async function heldCatalog(f:Fixture,work:()=>Promise<unknown>,status:number){
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);let first=true;
    const held:typeof fetch=async(...args)=>{if(first){first=false;entered();await gate;}return send(...args);};
    const attempt=getRankCatalog(f.project,editor,{connectionId:f.connection},held),rejected=assert.rejects(attempt,failed(status));
    try{await Promise.race([started,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Held free catalog did not start.')),3000);timer.unref();})]);await assert.rejects(getRankCatalog(f.project,owner,{connectionId:f.connection},send),failed(409));await work();}finally{release();}
    await rejected;assert.equal((await pool.query('SELECT count(*)::int AS count FROM rank_config WHERE project_id=$1',[f.project])).rows[0].count,0);
  }
  async function approve(f:Fixture,id:string){
    await pool.query(`UPDATE rank_config SET schedule_interval='daily',schedule_timezone='UTC',schedule_hour=9,schedule_minute=0,schedule_enabled=true,next_due_at=clock_timestamp()+interval '1 day',approval_id=$2,approval_user_id=$3,approval_config_revision=revision,approval_keywords_revision=keywords_revision,approval_request_hash=$4,approval_connection_id=$5,approval_connection_revision=1,approval_account_fingerprint=$4,approval_account_fingerprint_version=2,approval_max_micros=10000,approved_at=clock_timestamp() WHERE id=$1`,[id,randomUUID(),owner,'a'.repeat(64),f.connection]);
  }
  try{
    for(const id of [owner,admin,editor,viewer,outsider])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Rank fixture\',$2)',[id,id+'@rank.integration.test']);
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
    const f=await fixture(),revoked=await fixture(),foreign=await fixture();
    // Run before a successful catalog is cached: the free fetch must not carry stale authorization across its await.
    await heldCatalog(f,()=>role(f,editor,'viewer'),404);await role(f,editor,'editor');
    await heldCatalog(revoked,()=>revokeProvider(revoked.workspace,owner,revoked.connection),404);
    await heldCatalog(f,()=>saveProvider(f.workspace,owner,{name:'Rotated synthetic catalog',credentials:{login:'rank@example.com',password:'replacement-never-live'},monthlyLimitUsd:'0'},f.connection),409);
    await assert.rejects(getRankCatalog(f.project,viewer,{connectionId:f.connection},send),failed(404));
    await assert.rejects(getRankCatalog(f.project,owner,{connectionId:foreign.connection},send),failed(404));
    console.log('PASS free catalog awaits recheck live role, connection revocation and workspace binding');

    await getRankCatalog(f.project,owner,{connectionId:f.connection},send);
    const input=creation(f),created=await Promise.all([createRankTracker(f.project,owner,input,send),createRankTracker(f.project,owner,input,send)]);
    assert.ok(created[0]);assert.ok(created[1]);const id=created[0].tracker.id;assert.equal(created[1].tracker.id,id);assert.equal(created.filter(r=>r?.replayed).length,1);
    assert.equal(created[0].tracker.domain,'example.com');assert.equal(created[0].tracker.schedule.enabled,false);assert.equal(created[0].tracker.schedule.interval,'manual');
    const calls=freeCalls;
    await assert.rejects(createRankTracker(f.project,admin,input,send),failed(409));
    await assert.rejects(createRankTracker(f.project,owner,{...input,name:'Changed'},send),failed(409));
    await assert.rejects(createRankTracker(f.project,owner,creation(f),send),failed(409));
    await assert.rejects(createRankTracker(f.project,owner,creation(f,{domain:'other.com',locationCode:1006886}),send),failed(400));
    await assert.rejects(createRankTracker(f.project,owner,creation(f,{domain:'other.com',languageCode:'xx'}),send),failed(400));
    assert.equal(freeCalls,calls,'A complete cached public catalog is reused without another provider request.');
    const local=await createRankTracker(f.project,editor,creation(f,{locationCode:1023191}),send);assert.ok(local);assert.equal(local.tracker.locationType,'City');
    const different=await createRankTracker(foreign.project,owner,creation(foreign),send);assert.ok(different);assert.notEqual(different.tracker.id,id);
    assert.equal((await current(f,id,viewer)).role,'viewer');await assert.rejects(current(f,id,outsider),failed(404));await assert.rejects(current(foreign,id),failed(404));
    await assert.rejects(updateRankTracker(f.project,viewer,id,settings((await current(f,id)).tracker,{name:'Forbidden'})),failed(404));
    const listed=await listRankTrackers(f.project,viewer);assert.equal(listed.trackers.length,2);assert.ok(listed.vaultConfigured);assert.equal(listed.connections.length,1);
    const catalog=await getRankCatalog(f.project,editor,{connectionId:f.connection},send);catalog.catalog.countries[0].name='Mutated caller copy';
    assert.ok(!(await getRankCatalog(f.project,editor,{connectionId:f.connection},send)).catalog.countries.some(c=>c.name==='Mutated caller copy'));
    const locals=await searchRankLocations(f.project,editor,new URLSearchParams({connectionId:f.connection,countryCode:'2840',query:'new'}),send);assert.deepEqual(locals.rows.map(r=>r.code),[1023191]);
    assert.equal((await searchRankLocations(f.project,editor,new URLSearchParams({connectionId:f.connection,countryCode:'2840',query:'%_'}),send)).rows.length,0);
    console.log('PASS exact create receipts, immutable market identity, complete catalog cache and project/role boundaries');

    const add={requestId:randomUUID(),revision:(await current(f,id)).tracker.authoredRevision,keywords:[' Apple ','apple','C++','%20'],matchCase:false};
    const added=await changeRankKeywords(f.project,editor,id,'add',add);assert.equal(added.keywords.length,3);assert.deepEqual(new Set(added.keywords.map(k=>k.keyword)),new Set(['apple','c++','%20']));
    await assert.rejects(changeRankKeywords(f.project,owner,id,'add',add),failed(409));
    const caseAdded=await changeRankKeywords(f.project,owner,id,'add',{requestId:randomUUID(),revision:added.tracker.authoredRevision,keywords:['Apple'],matchCase:true});assert.equal(caseAdded.keywords.length,4);
    const beforeRevision=caseAdded.tracker.authoredRevision;await pool.query('UPDATE rank_config SET metrics_revision=metrics_revision+1 WHERE id=$1',[id]);
    await approve(f,id);const renamed=await updateRankTracker(f.project,admin,id,settings(caseAdded.tracker,{name:'Renamed tracker'}));
    assert.equal(renamed.tracker.authoredRevision,beforeRevision+1);assert.equal(renamed.tracker.revision,caseAdded.tracker.revision);assert.equal(renamed.tracker.keywordsRevision,caseAdded.tracker.keywordsRevision);assert.equal(renamed.tracker.schedule.enabled,true);
    const keywordId=renamed.keywords[0].id,pinned=await changeRankKeywords(f.project,owner,id,'pin',{requestId:randomUUID(),revision:renamed.tracker.authoredRevision,keywordIds:[keywordId],pinned:true});
    assert.equal(pinned.tracker.schedule.enabled,true);assert.equal(pinned.tracker.revision,renamed.tracker.revision);assert.equal(pinned.tracker.keywordsRevision,renamed.tracker.keywordsRevision);assert.equal(pinned.keywords[0].id,keywordId);
    await assert.rejects(updateRankTracker(f.project,owner,id,settings(renamed.tracker,{name:'Stale overwrite'})),failed(409));
    const noOp=await changeRankKeywords(f.project,owner,id,'pin',{requestId:randomUUID(),revision:pinned.tracker.authoredRevision,keywordIds:[keywordId],pinned:true});assert.equal(noOp.tracker.authoredRevision,pinned.tracker.authoredRevision);
    const changed=await updateRankTracker(f.project,owner,id,settings(noOp.tracker,{depth:90}));assert.equal(changed.tracker.schedule.enabled,false);assert.equal(changed.tracker.schedule.nextDueAt,null);assert.equal(changed.tracker.revision,noOp.tracker.revision+1);
    for(const field of ['domain','countryCode','locationCode','languageCode','connectionId'])await assert.rejects(updateRankTracker(f.project,owner,id,{...settings(changed.tracker),[field]:'mutated'}),failed(400));
    const replay=await changeRankKeywords(f.project,editor,id,'add',add);assert.equal(replay.replayed,true);assert.equal(replay.tracker.authoredRevision,changed.tracker.authoredRevision);assert.equal(replay.keywords.length,4);
    console.log('PASS authored CAS is separate from financial/metric revisions; names/pins preserve approvals and check changes disable them');

    const deleteTarget=(await current(f,id)).keywords.find(k=>k.keyword==='apple')!,removal={requestId:randomUUID(),revision:(await current(f,id)).tracker.authoredRevision,keywordIds:[deleteTarget.id]};
    const removed=await changeRankKeywords(f.project,owner,id,'remove',removal),readded=await changeRankKeywords(f.project,owner,id,'add',{requestId:randomUUID(),revision:removed.tracker.authoredRevision,keywords:['apple']});
    const newId=readded.keywords.find(k=>k.keyword==='apple')!.id;assert.notEqual(newId,deleteTarget.id);
    const late=await changeRankKeywords(f.project,owner,id,'remove',removal);assert.equal(late.replayed,true);assert.ok(late.keywords.some(k=>k.id===newId));
    await assert.rejects(changeRankKeywords(f.project,owner,id,'pin',{...removal,pinned:true}),failed(409));
    await assert.rejects(changeRankKeywords(f.project,owner,local.tracker.id,'remove',removal),failed(409));
    const foreignKeyword=await changeRankKeywords(foreign.project,owner,different.tracker.id,'add',{requestId:randomUUID(),revision:1,keywords:['foreign']});
    const beforeAtomic=await current(f,id);await assert.rejects(changeRankKeywords(f.project,owner,id,'remove',{requestId:randomUUID(),revision:beforeAtomic.tracker.authoredRevision,keywordIds:[newId,foreignKeyword.keywords[0].id]}),failed(404));assert.deepEqual(await current(f,id),beforeAtomic);
    await role(f,editor,'viewer');await assert.rejects(changeRankKeywords(f.project,editor,id,'add',add),failed(404));await role(f,editor,'editor');
    await approve(f,id);const archived=await archiveRankTracker(f.project,owner,id,{requestId:randomUUID(),revision:beforeAtomic.tracker.authoredRevision,archived:true});assert.ok(archived.tracker.archivedAt);assert.equal(archived.tracker.schedule.enabled,false);
    await assert.rejects(changeRankKeywords(f.project,owner,id,'add',{requestId:randomUUID(),revision:archived.tracker.authoredRevision,keywords:['blocked']}),failed(409));
    await assert.rejects(createRankTracker(f.project,owner,creation(f),send),failed(409));
    assert.ok(!(await listRankTrackers(f.project,owner)).trackers.some(t=>t.id===id));assert.deepEqual((await listRankTrackers(f.project,owner,new URLSearchParams({archived:'archived'}))).trackers.map(t=>t.id),[id]);
    const restored=await archiveRankTracker(f.project,owner,id,{requestId:randomUUID(),revision:archived.tracker.authoredRevision,archived:false});assert.equal(restored.tracker.schedule.enabled,false);assert.equal(restored.tracker.schedule.nextDueAt,null);
    console.log('PASS deletion/recreation IDs, receipt operation/actor binding, mixed-scope atomic rejection and non-resuming archive lifecycle');

    const cap=await createRankTracker(f.project,owner,creation(f,{domain:'capacity.example.com'}),send);assert.ok(cap);
    const almost=await changeRankKeywords(f.project,owner,cap.tracker.id,'add',{requestId:randomUUID(),revision:1,keywords:Array.from({length:999},(_,i)=>'term '+i)});
    const races=await Promise.allSettled(['final a','final b'].map(keyword=>changeRankKeywords(f.project,owner,cap.tracker.id,'add',{requestId:randomUUID(),revision:almost.tracker.authoredRevision,keywords:[keyword]})));
    assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.equal(races.filter(r=>r.status==='rejected'&&failed(409)(r.reason)).length,1);
    const full=await current(f,cap.tracker.id);assert.equal(full.keywords.length,1000);await assert.rejects(changeRankKeywords(f.project,owner,cap.tracker.id,'add',{requestId:randomUUID(),revision:full.tracker.authoredRevision,keywords:['term 0','overflow']}),failed(400));assert.deepEqual(await current(f,cap.tracker.id),full);
    const noMore=await changeRankKeywords(f.project,owner,cap.tracker.id,'add',{requestId:randomUUID(),revision:full.tracker.authoredRevision,keywords:['term 0']});assert.equal(noMore.tracker.authoredRevision,full.tracker.authoredRevision);
    const atomicBody={requestId:randomUUID(),revision:restored.tracker.authoredRevision,keywords:['atomic insert']};
    await pool.query(`CREATE FUNCTION rank_test_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic atomicity check'; END $$; CREATE TRIGGER rank_test_insert_failure BEFORE INSERT ON rank_keyword FOR EACH ROW EXECUTE FUNCTION rank_test_insert_failure()`);
    try{await assert.rejects(changeRankKeywords(f.project,owner,id,'add',atomicBody));}finally{await pool.query('DROP TRIGGER rank_test_insert_failure ON rank_keyword; DROP FUNCTION rank_test_insert_failure()');}
    assert.equal((await current(f,id)).tracker.authoredRevision,restored.tracker.authoredRevision);assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE project_id=$1 AND request_id=$2',[f.project,atomicBody.requestId])).rowCount,0);
    await changeRankKeywords(f.project,owner,id,'add',atomicBody);assert.equal((await pool.query('SELECT count(*)::int AS count FROM provider_request')).rows[0].count,0);
    console.log('PASS serialized 1,000-keyword cap, duplicate no-op and rollback of revision plus receipt on persistence failure');

    const paging=await fixture(),seed=await createRankTracker(paging.project,owner,creation(paging),send);assert.ok(seed);
    // Closely spaced microsecond timestamps catch lossy JS Date cursor anchors.
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages,created_at)
      SELECT gen_random_uuid(),workspace_id,project_id,'Page '||g,'page'||g||'.example.com',location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages,'2026-01-01T00:00:00Z'::timestamptz+g*interval '1 microsecond' FROM rank_config CROSS JOIN generate_series(1,55) g WHERE id=$1`,[seed.tracker.id]);
    const first=await listRankTrackers(paging.project,viewer);assert.equal(first.trackers.length,50);assert.ok(first.nextCursor);
    const second=await listRankTrackers(paging.project,viewer,new URLSearchParams({cursor:first.nextCursor!}));assert.equal(second.trackers.length,6);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.trackers,...second.trackers].map(t=>t.id)).size,56);
    await assert.rejects(listRankTrackers(f.project,owner,new URLSearchParams({cursor:first.nextCursor!})),failed(400));await assert.rejects(listRankTrackers(paging.project,owner,new URLSearchParams({cursor:first.nextCursor!,archived:'all'})),failed(400));
    await assert.rejects(listRankTrackers(f.project,owner,new URLSearchParams('archived=active&archived=all')),failed(400));
    console.log('PASS microsecond-safe pagination with project/filter-bound cursors and no duplicate or omitted trackers');

    const login=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:owner+'@rank.integration.test',password})}));assert.equal(login.status,200);
    const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),endpoint=config.appUrl+'/api/projects/'+f.project+'/rank-trackers';
    assert.equal((await handleApi(new Request(endpoint))).status,401);
    const read=await handleApi(new Request(endpoint,{headers:{cookie}}));assert.equal(read.status,200);const body=await read.text();for(const forbidden of ['synthetic-never-live','encrypted_credentials','account_fingerprint'])assert.ok(!body.includes(forbidden));
    const token=(await createApiKey(f.workspace,owner,{name:'No rank scope',scopes:['projects:read']})).token;assert.equal((await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+token}}))).status,403);
    assert.equal((await handleApi(new Request(endpoint+'/'+id+'/update',{method:'POST',headers:{cookie,origin:'https://foreign.example.com','content-type':'application/json'},body:'{}'}))).status,403);
    const apiCurrent=await current(f,id),apiBody=settings(apiCurrent.tracker,{name:'Actual API mutation'});
    const write=await handleApi(new Request(endpoint+'/'+id+'/update',{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify(apiBody)}));assert.equal(write.status,200);assert.equal((await write.json()).tracker.name,apiBody.name);
    const bulkBody=JSON.stringify({requestId:randomUUID(),revision:(await current(f,local.tracker.id)).tracker.authoredRevision,keywords:Array.from({length:100},(_,i)=>'literal '+i+' '+('x'.repeat(95)))});assert.ok(Buffer.byteLength(bulkBody)>8192);
    const bulk=await handleApi(new Request(endpoint+'/'+local.tracker.id+'/keywords/add',{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:bulkBody}));assert.equal(bulk.status,200);assert.equal((await bulk.json()).keywords.length,100);
    const compatible=await fixture(),metadata=await getRankCatalog(compatible.project,editor,{connectionId:compatible.connection},send);
    assert.equal(metadata.catalog.countries.find(c=>c.code===2060)?.type,'Region');
    assert.deepEqual(metadata.catalog.coverage,{grouping:'country_iso_code',receivedRows:8,selectableRows:6,missingParentRows:3,unavailableGroups:[{countryIso:'BY',rows:1,reason:'provider_unsupported'},{countryIso:'IR',rows:1,reason:'missing_root'}]});
    const regionPage=await searchRankLocations(compatible.project,editor,new URLSearchParams({connectionId:compatible.connection,countryCode:'2060'}),send);
    assert.deepEqual(regionPage.rows.map(row=>row.code),[3001]);assert.deepEqual(regionPage.coverage,metadata.catalog.coverage);
    for(const [locationCode,languageCode]of [[2060,'es-419'],[3001,'sr-Latn']] as const){
      const saved=await createRankTracker(compatible.project,editor,creation(compatible,{countryCode:2060,locationCode,languageCode}),send);assert.ok(saved);
      assert.equal(saved.tracker.countryCode,2060);assert.equal(saved.tracker.countryIso,'BM');assert.equal(saved.tracker.locationCode,locationCode);assert.equal(saved.tracker.locationType,'Region');assert.equal(saved.tracker.languageCode,languageCode);
    }
    for(const countryCode of [2364,2112])await assert.rejects(createRankTracker(compatible.project,editor,creation(compatible,{countryCode,locationCode:countryCode===2364?20498:3002}),send),failed(400));
    console.log('PASS Region roots and descendants retain exact types, ISO groups, language subtags and unavailable coverage across catalog/search/create');
    assert.equal(unexpected,0);assert.equal((await pool.query('SELECT count(*)::int AS count FROM provider_request')).rows[0].count,0);
    console.log('PASS cookie-only API, Origin enforcement, secret-free DTOs and real mutation route without paid/provider traffic');
  }finally{try{await stopJobs();}finally{globalThis.fetch=originalFetch;}}
}
if(import.meta.main){try{await runRankTrackingChecks();}finally{await closeDatabase();}}
