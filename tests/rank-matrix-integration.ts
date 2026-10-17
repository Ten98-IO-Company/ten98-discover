import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {FoundationError} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {canonicalHash} from '../src/server/context-input.ts';
import {saveProvider} from '../src/server/providers.ts';
import {compileRankPlan,rankGroupPayload,rankPlanTotal} from '../src/server/rank-execution-plan.ts';
import {getRankMatrix,exportRankMatrix} from '../src/server/rank-matrix.ts';

export async function runRankMatrixChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_RANK_MATRIX_TEST,'1');
  const config=getConfig(),url=new URL(config.databaseUrl),loopback=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_rank_matrix_ci';
  assert.ok(loopback.includes(url.hostname)&&loopback.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.equal(url.search,'');assert.equal(url.hash,'');assert.match(url.pathname,/^\/ten98_rank_matrix_[a-z0-9_]+$/);
  await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh owned migrated fixture.');
  const owner=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),now=Date.now(),at=(days:number)=>new Date(now-days*86400000).toISOString();
  for(const id of [owner,viewer,outsider])await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[id,'Synthetic matrix reader',id+'@integration.test']);
  const originalFetch=globalThis.fetch;let external=0;globalThis.fetch=async()=>{external++;throw new Error('Reporting must not contact providers.');};
  const fail=(status:number)=>(error:unknown)=>error instanceof FoundationError&&error.status===status;
  type Keyword={id:string;keyword:string;matchCase:boolean};
  async function fixture(terms=['Example term','Later keyword']){
    const f={workspace:randomUUID(),project:randomUUID(),tracker:randomUUID(),connection:'',keywords:terms.map(keyword=>({id:randomUUID(),keyword,matchCase:true}))};
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Synthetic rank matrix')",[f.workspace]);
    for(const [id,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[f.workspace,id,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Matrix','https://example.com',$3,'infinity')",[f.project,f.workspace,randomUUID()]);
    f.connection=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic matrix provider',credentials:{login:'matrix@integration.test',password:'synthetic-only'},monthlyLimitUsd:'100'})).connection.id;
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
      VALUES($1,$2,$3,'Matrix','example.com',2840,'United States','Country',2840,'US','en','English',now(),'both',100,1)`,[f.tracker,f.workspace,f.project]);
    await pool.query(`INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,match_case) SELECT k.id,$2,$3,$4,k.keyword,k."matchCase" FROM jsonb_to_recordset($1::jsonb) AS k(id uuid,keyword text,"matchCase" boolean)`,[JSON.stringify(f.keywords),f.workspace,f.project,f.tracker]);return f;
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  async function run(f:Fixture,opt:{days?:number;position?:number;basis?:'organic'|'absolute';status?:'ranked'|'not_found'|'failed'|'pending';runStatus?:'completed'|'partial'|'failed'|'waiting';subset?:boolean;quote?:boolean;target?:Record<string,unknown>;keywords?:Keyword[];device?:'desktop'|'mobile';observed?:string}={}){
    const id=randomUUID(),when=at(opt.days??0),state=opt.status??'ranked',ranked=state==='ranked',measured=ranked||state==='not_found',status=opt.quote?'quoted':opt.runStatus??(state==='failed'?'failed':'completed');
    const plan=compileRankPlan({method:'queued',target:{domain:'example.com',locationCode:2840,languageCode:'en',depth:100,maxCrawlPages:1,...opt.target},devices:opt.device??'desktop',keywords:opt.keywords??[f.keywords[0]],baseMicros:1000n});
    await pool.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,expires_at,request_key,is_subset,created_at,started_at,completed_at)
      VALUES($1,$2,$3,$4,$5,'manual','queued',$6,1,1,$7,1,$8,'Synthetic',$9,$10,$11,$12,$13,$13::timestamptz+interval '5 minutes',$14,$15,$13,$16,$17)`,[id,f.workspace,f.project,f.tracker,owner,status,f.connection,'a'.repeat(64),JSON.stringify(plan),canonicalHash(plan),plan.tasks.length,rankPlanTotal(plan).toString(),when,opt.quote?null:randomUUID(),opt.subset??false,opt.quote?null:when,opt.quote||status==='waiting'?null:when]);
    if(opt.quote)return {id,plan};
    for(const [ordinal,group]of plan.groups.entries()){
      const dispatch=randomUUID(),payload=rankGroupPayload(plan,group);
      await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,connection_revision,status,budget_month)
        VALUES($1,$2,$3,$4,$5,'rank.queued',$6,$7,$7,1,'settled',date_trunc('month',now())::date)`,[dispatch,f.workspace,f.connection,owner,randomUUID(),'b'.repeat(64),group.maximumMicros]);
      await pool.query(`INSERT INTO rank_dispatch(id,workspace_id,project_id,run_id,ordinal,method,task_count,request,request_hash,phase,dispatched_at,completed_at) VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8,'finished',$9,$9)`,[dispatch,f.workspace,f.project,id,ordinal,group.taskIds.length,JSON.stringify(payload),canonicalHash(payload),when]);
      await pool.query(`INSERT INTO rank_task(id,workspace_id,project_id,run_id,dispatch_id,keyword_id,keyword,match_case,device,result_status,position,rank_basis,absolute_position,ranking_url,checked_depth,returned_item_count,observed_at,retrieved_at,raw_evidence)
        SELECT t.id,$2,$3,$4,$5,t."keywordId",t.keyword,t."matchCase",t.device,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14
        FROM jsonb_to_recordset($1::jsonb) AS t(id uuid,"keywordId" uuid,keyword text,"matchCase" boolean,device text)`,[JSON.stringify(plan.tasks.filter(t=>group.taskIds.includes(t.id))),f.workspace,f.project,id,dispatch,state,ranked?opt.position??8:null,ranked?opt.basis??'organic':null,ranked?opt.position??8:null,ranked?'https://example.com/result':null,measured?0:null,measured?0:null,measured?opt.observed??when:null,measured?'{}':null]);
    }return {id,plan};
  }
  const read=(f:Fixture,params=new URLSearchParams({device:'desktop'}))=>getRankMatrix(f.project,viewer,f.tracker,params);
  const cell=(data:Awaited<ReturnType<typeof read>>,keyword:string,id:string)=>{const value=data.rows.find(r=>r.keywordId===keyword)?.cells.find(c=>c.runId===id);assert.ok(value);return value;};
  try{
    const f=await fixture(),older=await run(f,{days:3,position:9}),newer=await run(f,{days:2,position:3}),failed=await run(f,{days:1,status:'failed'}),pending=await run(f,{days:.5,status:'pending',runStatus:'waiting'});
    await run(f,{days:.1,subset:true});await run(f,{days:.01,quote:true});const first=await read(f);
    assert.deepEqual(first.columns.map(r=>r.runId),[pending.id,failed.id,newer.id,older.id]);assert.equal(first.role,'viewer');assert.equal(cell(first,f.keywords[0].id,pending.id).state,'pending');assert.equal(cell(first,f.keywords[0].id,failed.id).state,'failed');assert.equal(cell(first,f.keywords[0].id,newer.id).change,6);assert.equal(cell(first,f.keywords[0].id,newer.id).checkedDepth,0);assert.equal(cell(first,f.keywords[1].id,newer.id).state,'not_in_run');
    const notFound=await run(f,{days:.25,status:'not_found'}),nf=cell(await read(f),f.keywords[0].id,notFound.id);assert.equal(nf.state,'not_found');assert.equal(nf.position,null);assert.equal(nf.checkedDepth,0);assert.equal(nf.change,null);
    console.log('PASS full started runs preserve pending/failed/not-found/absent states, exclude quotes/subsets and compare adjacent compatible observed ranks only.');

    const e=await fixture(['Run expiry','Task expiry','Raw only','Missing task','Case changed']);
    const er=await run(e,{keywords:[e.keywords[0]]}),et=await run(e,{keywords:[e.keywords[1]]}),raw=await run(e,{keywords:[e.keywords[2]]}),missing=await run(e,{keywords:[e.keywords[3]]}),changed=await run(e,{keywords:[e.keywords[4]]});
    await pool.query('UPDATE rank_run SET data_expired_at=now(),raw_expired_at=now() WHERE id=$1',[er.id]);
    await pool.query('UPDATE rank_task SET data_expired_at=now(),raw_expired_at=now(),position=NULL,rank_basis=NULL,absolute_position=NULL,ranking_url=NULL,raw_evidence=NULL WHERE run_id=$1',[et.id]);
    await pool.query('UPDATE rank_run SET raw_expired_at=now() WHERE id=$1',[raw.id]);await pool.query('DELETE FROM rank_task WHERE run_id=$1',[missing.id]);await pool.query('UPDATE rank_keyword SET match_case=false WHERE id=$1',[e.keywords[4].id]);
    const ed=await read(e);for(const [index,id]of [[0,er.id],[1,et.id]]as const){const c=cell(ed,e.keywords[index].id,id);assert.equal(c.state,'expired');assert.equal(c.position,null);assert.equal(c.checkedDepth,null);assert.equal(c.rankingUrl,null);}
    assert.equal(cell(ed,e.keywords[2].id,raw.id).position,8);assert.ok(cell(ed,e.keywords[2].id,raw.id).rawExpiredAt);assert.equal(cell(ed,e.keywords[3].id,missing.id).state,'unavailable');assert.equal(cell(ed,e.keywords[4].id,changed.id).state,'incompatible');
    await pool.query('DELETE FROM rank_keyword WHERE id=$1',[e.keywords[2].id]);const replacement=randomUUID();await pool.query('INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,match_case) VALUES($1,$2,$3,$4,$5,true)',[replacement,e.workspace,e.project,e.tracker,'Raw only']);assert.equal(cell(await read(e),replacement,raw.id).state,'not_in_run');
    console.log('PASS run/task tombstones mask residual payload, raw-only expiry preserves ranks, missing captured tasks stay unavailable and recreated UUIDs never inherit history.');

    const b=await fixture(['Basis']);await run(b,{days:4,position:12});await run(b,{days:3,position:10,basis:'absolute'});await run(b,{days:2,position:5,observed:at(2)});await run(b,{days:1,position:2,observed:at(2)});const incompatible=await run(b,{days:.1,target:{depth:50}}),br=await read(b);assert.ok(br.rows[0].cells.every(c=>c.change===null));assert.equal(cell(br,b.keywords[0].id,incompatible.id).state,'incompatible');assert.equal(br.columns[0].target.depth,50);assert.equal(br.columns[0].compatible,false);
    await pool.query("UPDATE rank_config SET devices='mobile' WHERE id=$1",[b.tracker]);await assert.rejects(read(b),fail(400));await assert.rejects(getRankMatrix(f.project,outsider,f.tracker,new URLSearchParams({device:'desktop'})),fail(404));await assert.rejects(getRankMatrix(e.project,viewer,f.tracker,new URLSearchParams({device:'desktop'})),fail(404));
    for(const params of ['device=desktop&device=mobile','device=desktop&runLimit=27','device=desktop&runLimit=1%0A','device=desktop&unknown=1','device=both'])await assert.rejects(read(f,new URLSearchParams(params)),fail(400));
    console.log('PASS target/basis/equal-time comparison boundaries, explicit enabled device, current member authorization and strict query scope.');

    const p=await fixture(Array.from({length:55},(_,i)=>'Literal %_\\ '+i));await pool.query("UPDATE rank_keyword SET created_at='2026-01-01T00:00:00.123456Z' WHERE config_id=$1",[p.tracker]);
    const page=await read(p);assert.equal(page.rows.length,50);assert.ok(page.nextCursor);assert.ok(Buffer.from(page.nextCursor,'base64url').toString().includes('.123456Z'));const more=await read(p,new URLSearchParams({device:'desktop',cursor:page.nextCursor}));assert.equal(more.rows.length,5);assert.equal(new Set([...page.rows,...more.rows].map(r=>r.keywordId)).size,55);
    await assert.rejects(read(p,new URLSearchParams({device:'desktop',search:'Literal',cursor:page.nextCursor})),fail(400));await assert.rejects(read(f,new URLSearchParams({device:'desktop',cursor:page.nextCursor})),fail(400));await pool.query('UPDATE rank_config SET authored_revision=authored_revision+1 WHERE id=$1',[p.tracker]);await assert.rejects(read(p,new URLSearchParams({device:'desktop',cursor:page.nextCursor})),fail(400));assert.equal((await read(p,new URLSearchParams({device:'desktop',search:'%_\\'}))).keywordCount,55);
    console.log('PASS exact microsecond keyset paging, literal search and cursor binding to tracker/filter/authored revisions.');

    const cap=await fixture(['Bounded columns']);for(let i=0;i<27;i++)await run(cap,{days:40-i});assert.equal((await read(cap)).columns.length,12);assert.equal((await read(cap,new URLSearchParams({device:'desktop',runLimit:'26'}))).columns.length,26);
    const csv=await fixture(['=HYPERLINK("https://invalid.example")','+SUM(1)','@formula','-1','=x','"quoted", term']);await run(csv,{days:2,keywords:csv.keywords});await run(csv,{days:1,keywords:csv.keywords});
    const exported=await exportRankMatrix(csv.project,viewer,csv.tracker,{device:'desktop'});assert.equal(exported.rowCount,12);assert.equal(exported.filename,'rank-matrix.csv');assert.ok(exported.body.includes('"\'=HYPERLINK(""https://invalid.example"")"'));for(const value of ["'+SUM(1)","'@formula","'-1","'=x"])assert.ok(exported.body.includes(value));assert.ok(exported.body.includes('"""quoted"", term"'));assert.ok(exported.body.includes('"0","0"'));
    const expiredExport=await exportRankMatrix(e.project,viewer,e.tracker,{device:'desktop'});assert.ok(expiredExport.body.includes('"expired"'));assert.ok(!expiredExport.body.includes('synthetic-only'));assert.ok(!expiredExport.body.includes('raw_evidence'));
    const aborted=new AbortController();aborted.abort();await assert.rejects(exportRankMatrix(csv.project,viewer,csv.tracker,{device:'desktop'},aborted.signal),fail(499));await assert.rejects(exportRankMatrix(csv.project,viewer,csv.tracker,{device:'desktop',rows:[]}),fail(400));
    console.log('PASS12/default26/max bounded columns, server-owned long-form CSV, formula/quote protection, retained zero coverage and abort/unknown-body rejection.');

    const password=randomBytes(24).toString('base64url');await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),viewer,await hashPassword(password)]);
    const login=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:viewer+'@integration.test',password})}));assert.equal(login.status,200);
    const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),path='/api/projects/'+csv.project+'/rank-trackers/'+csv.tracker;
    const request=(suffix:string,method='GET',body:unknown={device:'desktop'})=>handleApi(new Request(config.appUrl+path+suffix,{method,headers:{cookie,origin:config.appUrl,'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})}));
    for(const suffix of ['/matrix?device=desktop','/distribution?device=desktop','/DISTRIBUTION?device=desktop']){const response=await request(suffix);assert.equal(response.status,200);const body=await response.json();assert.equal(body.role,'viewer');assert.equal(Object.hasOwn(body,'totals'),suffix.toLowerCase().startsWith('/distribution'));}
    const download=await request('/matrix/export','POST');assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'text/csv; charset=utf-8');assert.equal(download.headers.get('cache-control'),'no-store');assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.equal(download.headers.get('content-disposition'),'attachment; filename="rank-matrix.csv"');assert.equal(download.headers.get('x-export-row-count'),'12');const downloaded=await download.text();assert.ok(downloaded.includes("'@formula"));assert.equal(downloaded.split('\r\n').length,14);
    // Compare safe payload properties, not as-of timestamps from separate snapshots.
    assert.equal((await request('/matrix?device=desktop&device=mobile')).status,400);assert.equal((await request('/matrix?device=desktop&unknown=1')).status,400);assert.equal((await request('/matrix/export?cursor=no','POST')).status,400);assert.equal((await request('/matrix/export','POST',{device:'desktop',rows:[]})).status,400);assert.equal((await request('/matrix/export','GET')).status,405);assert.equal((await request('/distribution','POST')).status,405);
    const oversized=await handleApi(new Request(config.appUrl+path+'/matrix/export',{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:'x'.repeat(8193)}));assert.equal(oversized.status,413);
    assert.equal((await handleApi(new Request(config.appUrl+path+'/matrix?device=desktop'))).status,401);assert.equal((await handleApi(new Request(config.appUrl+path+'/matrix/export',{method:'POST',headers:{cookie,origin:'https://foreign.invalid','content-type':'application/json'},body:'{"device":"desktop"}'}))).status,403);
    assert.equal((await handleApi(new Request(config.appUrl+'/api/projects/'+f.project+'/rank-trackers/'+csv.tracker+'/matrix?device=desktop',{headers:{cookie}}))).status,404);
    const apiKey=(await createApiKey(csv.workspace,owner,{name:'No rank export capability',scopes:['projects:read']})).token;assert.equal((await handleApi(new Request(config.appUrl+path+'/matrix?device=desktop',{headers:{authorization:'Bearer '+apiKey}}))).status,403);
    const rankReader=(await createApiKey(csv.workspace,owner,{name:'Rank reader',scopes:['rank:read']})).token,bearerMatrix=await handleApi(new Request(config.appUrl+path+'/matrix?device=desktop',{headers:{authorization:'Bearer '+rankReader}}));assert.equal(bearerMatrix.status,200);
    const comparable=(value:any)=>({...value,asOf:null,role:null});assert.deepEqual(comparable(await bearerMatrix.json()),comparable(await(await request('/matrix?device=desktop')).json()),'The bearer matrix equals the cookie matrix apart from the per-call clock and the caller role.');
    assert.equal((await handleApi(new Request(config.appUrl+path+'/matrix/export',{method:'POST',headers:{authorization:'Bearer '+rankReader,'content-type':'application/json'},body:'{"device":"desktop"}'}))).status,403,'The CSV export stays cookie-only.');
    const rateClient=await pool.connect(),originalQuery=pool.query,reportKey='rank-report:'+viewer,exportKey='rank-report-export:'+viewer;
    try{
      // PostgreSQL now() stays fixed throughout this synthetic rate-check transaction.
      await rateClient.query('BEGIN');pool.query=rateClient.query.bind(rateClient);
      await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])',[[reportKey,exportKey]]);
      for(let i=0;i<6;i++)assert.equal((await request('/matrix/export','POST')).status,200);
      assert.equal((await request('/matrix/export','POST')).status,429);
      await pool.query('DELETE FROM request_limit WHERE key=$1',[reportKey]);
      for(let i=0;i<30;i++)assert.equal((await request('/matrix?device=desktop')).status,200);
      assert.equal((await request('/matrix?device=desktop')).status,429);
    }finally{
      pool.query=originalQuery;
      try{await rateClient.query('ROLLBACK');}finally{rateClient.release();}
    }
    console.log('PASS actual viewer reporting/export API,CSV headers, tenant/cookie/Origin/API-key boundaries, strict request size/query/method and report/export rate limits.');

    const full=await fixture(Array.from({length:1000},(_,i)=>'Export term '+i));for(let i=0;i<26;i++)await run(full,{days:26-i,keywords:full.keywords});const begin=performance.now(),all=await exportRankMatrix(full.project,viewer,full.tracker,{device:'desktop',runLimit:26});assert.equal(all.keywordCount,1000);assert.equal(all.rowCount,26000);assert.equal(all.runCount,26);assert.equal(all.body.split('\r\n').length,26002);assert.equal(external,0);
    const elapsed=performance.now()-begin;await pool.query('UPDATE rank_task SET ranking_url=$2 WHERE project_id=$1',[full.project,'https://example.com/'+('x'.repeat(700))]);await assert.rejects(exportRankMatrix(full.project,viewer,full.tracker,{device:'desktop',runLimit:26}),fail(413));
    await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[full.workspace,viewer]);await assert.rejects(exportRankMatrix(full.project,viewer,full.tracker,{device:'desktop'}),fail(404));
    console.log('PASS1,000×26 cells exported,16MiB cap rejects oversized source URLs without partial success, current access loss blocks export; ms='+elapsed.toFixed(1));
  }finally{globalThis.fetch=originalFetch;}
}
if(import.meta.main){try{await runRankMatrixChecks();}finally{await closeDatabase();}}
