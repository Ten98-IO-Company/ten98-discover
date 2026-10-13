import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {saveProvider,saveBudget,revokeProvider} from '../src/server/providers.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {keywordAccountEndpoint,keywordCatalogEndpoint,keywordEndpoints,keywordReconcileEndpoint,keywordPayload,type KeywordRow} from '../src/server/keyword-research-input.ts';
import {refreshKeywordMarkets,quoteKeywordResearch,startKeywordResearch,executeKeywordResearch,getKeywordRun} from '../src/server/keyword-research.ts';
import {listSavedKeywords,listSavedKeywordTags,saveSavedKeywords,changeSavedKeywordTags,removeSavedKeywords,updateSavedKeywordTag,deleteSavedKeywordTag,exportSavedKeywords} from '../src/server/saved-keywords.ts';
import {quoteSavedKeywordRefresh,startSavedKeywordRefresh,listSavedKeywordRefreshes,getSavedKeywordRefresh,cancelSavedKeywordRefresh,reconcileSavedKeywordRefresh} from '../src/server/saved-keyword-refresh.ts';
import {getRetention,previewRetention,runRetentionBatch} from '../src/server/retention.ts';

const failed=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
type Fixture={workspace:string;project:string;connectionId:string|null};
const metrics=(keyword:string,overrides:Partial<KeywordRow>={}):KeywordRow=>({keyword,searchVolume:null,cpcUsd:null,competition:null,competitionLevel:null,keywordDifficulty:null,intent:null,monthlySearches:[],metricsUpdatedAt:null,intentUpdatedAt:null,...overrides});
function csvRows(text:string){
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
  for(let index=0;index<text.length;index++){const char=text[index];if(char==='"'){if(quoted&&text[index+1]==='"'){cell+='"';index++;}else quoted=!quoted;}
    else if(char===','&&!quoted){row.push(cell);cell='';}else if(char==='\n'&&!quoted){row.push(cell);rows.push(row);row=[];cell='';}else cell+=char;}
  assert.equal(quoted,false);if(row.length||cell){row.push(cell);rows.push(row);}return rows;
}

export async function runSavedKeywordChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');const config=getConfig(),db=new URL(config.databaseUrl),app=new URL(config.appUrl);
  const hostedCi=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_saved_keywords_ci';
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(db.hostname));assert.equal(db.port,hostedCi?'5432':'55501','Use the independent test server or explicitly opted-in isolated CI database.');
  assert.equal(db.search,'');assert.equal(db.hash,'');assert.match(db.pathname,/^\/ten98_saved_keywords_[a-z0-9_]+$/);assert.ok(['localhost','127.0.0.1','[::1]'].includes(app.hostname));
  await assertSchema();const pool=getDatabase().pool,owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),password=randomBytes(24).toString('base64url');
  const originalFetch=globalThis.fetch;let accidentalRequests=0;
  globalThis.fetch=async()=>{accidentalRequests++;throw new Error('Real provider traffic is forbidden in saved keyword acceptance.');};
  let paidCalls=0,freeCalls=0,mode:'ok'|'missing'|'unknown'='ok',volume=0;const paidBodies:any[]=[];let reconcileItems:unknown[]=[];
  const account='synthetic-saved-keywords@integration.test';
  const free=(result:unknown[])=>Response.json({status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result}]});
  const send:typeof fetch=async(url,init)=>{
    assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);
    if(url===keywordAccountEndpoint){freeCalls++;const prices={priority_normal:[{cost_type:'per_request',cost:0.012},{cost_type:'per_result',cost:0.00012}]};return free([{login:account,price:{dataforseo_labs:{keyword_overview:{live:prices},keyword_ideas:{live:prices}}}}]);}
    if(url===keywordCatalogEndpoint){freeCalls++;return free([2840,2826].map(location_code=>({location_code,location_name:location_code===2840?'United States':'United Kingdom',location_type:'Country',available_languages:[{language_code:'en',language_name:'English',available_sources:['google']}]})));}
    if(url===keywordReconcileEndpoint){freeCalls++;return free(reconcileItems);}
    assert.equal(url,keywordEndpoints.overview,'No fallback paid endpoint is allowed in this fixture.');paidCalls++;
    const data=JSON.parse(init?.body as string)[0];paidBodies.push(data);
    if(mode==='unknown')throw new Error('Synthetic lost provider response.');
    const keywords=mode==='missing'?[]:data.keywords,cost=0.012+data.keywords.length*0.00012;
    // Fixed-point formatting avoids introducing binary-addition noise into the synthetic JSON charge.
    const exactCost=Number(cost.toFixed(6));
    return Response.json({status_code:20000,cost:exactCost,tasks_count:1,tasks:[{id:'synthetic-'+randomUUID(),status_code:20000,cost:exactCost,path:['v3','dataforseo_labs','google','keyword_overview','live'],data,result:[{se_type:'google',location_code:data.location_code,language_code:data.language_code,items_count:keywords.length,items:keywords.map((keyword:string)=>({keyword,keyword_info:{search_volume:volume,cpc:0.000001,competition:0,monthly_searches:[]},keyword_properties:{keyword_difficulty:0}}))}]}]});
  };
  async function fixture(withProvider=false):Promise<Fixture>{
    const workspace=randomUUID(),project=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Synthetic saved keywords')",[workspace]);
    for(const [uid,role]of [[owner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,uid,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Saved keywords','https://'||$1||'.integration.test',$3,'infinity')",[project,workspace,randomUUID()]);
    const value:Fixture={workspace,project,connectionId:null};if(withProvider)await provider(value);return value;
  }
  async function provider(f:Fixture){if(!f.connectionId){f.connectionId=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic provider',credentials:{login:account,password:'synthetic-never-live'},monthlyLimitUsd:'10'})).connection.id;await saveBudget(f.workspace,owner,{monthlyLimitUsd:'10',paused:false});await refreshKeywordMarkets(f.project,owner,{connectionId:f.connectionId},send);}return f.connectionId;}
  const list=(f:Fixture,raw:unknown={},user=owner)=>listSavedKeywords(f.project,user,raw);
  const selection=(ids:string[])=>({type:'ids',keywordIds:ids});
  async function manual(f:Fixture,keywords:string[],extra:Record<string,unknown>={}){return saveSavedKeywords(f.project,owner,{requestId:randomUUID(),revision:(await list(f)).revision,source:{type:'manual',keywords,locationCode:2840,languageCode:'en'},...extra});}
  async function retained(f:Fixture,keywords:string[],rows?:KeywordRow[]){
    const request={connectionId:await provider(f),mode:'overview',keywords,locationCode:2840,languageCode:'en',limit:100};
    const q=(await quoteKeywordResearch(f.project,owner,request,send)).quote;const result=await startKeywordResearch(f.project,owner,{quoteId:q.id,requestKey:randomUUID()});await executeKeywordResearch(result.run.id,send);
    const run=(await getKeywordRun(f.project,owner,result.run.id)).run;assert.equal(run.status,'completed');
    if(rows)await pool.query('UPDATE keyword_research_run SET result=$2 WHERE id=$1',[run.id,JSON.stringify({...run.result,rows})]);
    return run.id;
  }
  async function observed(f:Fixture,runId:string,rowIndexes:number[],extra:Record<string,unknown>={}){return saveSavedKeywords(f.project,owner,{requestId:randomUUID(),revision:(await list(f)).revision,source:{type:'run',runId,rowIndexes},...extra});}
  try{
    for(const id of [owner,editor,viewer,outsider])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Saved keyword fixture\',$2)',[id,id+'@saved-keywords.integration.test']);
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
    const f=await fixture(),foreign=await fixture();const initial=await list(f,{},viewer);assert.equal(initial.role,'viewer');assert.equal(initial.revision,1);assert.equal(initial.metricRevision,'1');assert.equal(initial.total,0);
    const request={requestId:randomUUID(),revision:initial.revision,source:{type:'manual',keywords:[' Blue  Shoes ','blue shoes','C++','%20'],locationCode:2840,languageCode:'en'},tags:[' Intent  High ','intent high']};
    const [first,replay]=await Promise.all([saveSavedKeywords(f.project,owner,request),saveSavedKeywords(f.project,owner,request)]);assert.deepEqual(first.ids,replay.ids);assert.equal(first.ids.length,3);assert.equal(first.inserted,3);
    assert.equal((await list(f)).total,3);assert.ok((await list(f)).rows.every(row=>row.metrics.status==='unavailable'&&row.metrics.row===null));
    await assert.rejects(saveSavedKeywords(f.project,owner,{...request,tags:['Changed']}),failed(409));await assert.rejects(saveSavedKeywords(f.project,editor,request),failed(409));
    await assert.rejects(saveSavedKeywords(f.project,viewer,{...request,requestId:randomUUID(),revision:(await list(f)).revision}),failed(404));await assert.rejects(list(f,{},outsider),failed(404));
    const current=(await list(f)).revision;const races=await Promise.allSettled(['one','two'].map(keyword=>saveSavedKeywords(f.project,owner,{...request,requestId:randomUUID(),revision:current,source:{...request.source,keywords:[keyword]}})));assert.equal(races.filter(item=>item.status==='fulfilled').length,1);
    const same=await manual(f,['blue shoes']);assert.equal(same.inserted,0);assert.equal(same.existing,1);
    const market=await manual(f,['blue shoes'],{source:{type:'manual',keywords:['blue shoes'],locationCode:2826,languageCode:'en'}});assert.equal(market.inserted,1);
    const foreignSaved=await manual(foreign,['blue shoes']);assert.notEqual(foreignSaved.ids[0],first.ids[0]);
    const beforeAtomic=await list(f);await assert.rejects(removeSavedKeywords(f.project,owner,{requestId:randomUUID(),revision:beforeAtomic.revision,keywordIds:[first.ids[0],foreignSaved.ids[0]]}),failed(404));assert.deepEqual(await list(f),beforeAtomic);
    assert.equal(paidCalls,0);assert.equal(freeCalls,0);
    console.log('PASS saved identity, market/project isolation, live roles, actor receipts and atomic revision conflict');

    const tags=(await list(f)).tags,tag=tags.find(row=>row.name==='Intent High')!;assert.ok(tag);
    await assert.rejects(deleteSavedKeywordTag(f.project,owner,tag.id,{requestId:randomUUID(),revision:(await list(f)).revision}),failed(409));
    await changeSavedKeywordTags(f.project,owner,{requestId:randomUUID(),revision:(await list(f)).revision,keywordIds:first.ids,operation:'add',tags:['Second','=SUM(A1)']});
    const second=(await list(f)).tags.find(row=>row.name==='Second')!;await assert.rejects(updateSavedKeywordTag(f.project,owner,second.id,{requestId:randomUUID(),revision:(await list(f)).revision,name:' intent high '}),failed(409));
    await updateSavedKeywordTag(f.project,owner,tag.id,{requestId:randomUUID(),revision:(await list(f)).revision,name:'Authored intent',color:'violet'});
    await updateSavedKeywordTag(f.project,owner,tag.id,{requestId:randomUUID(),revision:(await list(f)).revision,color:null});assert.equal((await list(f)).tags.find(row=>row.id===tag.id)?.color,null);
    await changeSavedKeywordTags(f.project,owner,{requestId:randomUUID(),revision:(await list(f)).revision,keywordIds:first.ids,operation:'remove',tagIds:[second.id]});
    await deleteSavedKeywordTag(f.project,owner,second.id,{requestId:randomUUID(),revision:(await list(f)).revision});
    const literals=await manual(f,['literal%_\\tail','literalXYtail','=SUM(1)']);
    const literal=await list(f,{filters:{search:'%_\\'}});assert.equal(literal.total,1);assert.equal(literal.rows[0].keyword,'literal%_\\tail');
    assert.equal((await list(f,{filters:{includeTerms:['literal','tail'],excludeTerms:['%_\\']}})).total,1);
    assert.equal((await list(f,{filters:{tagIds:[tag.id]}})).total,4,'The three original rows and the one winning tagged revision race match.');
    const csv=await exportSavedKeywords(f.project,viewer,{selection:{type:'filtered',filters:{}},format:'csv'}),tsv=await exportSavedKeywords(f.project,viewer,{selection:selection(literals.ids),format:'tsv'});
    assert.equal(csv.rowCount,(await list(f)).total);assert.match(csv.body,/'=sum\(1\)/i);assert.match(csv.body,/SUM\(A1\)/i);assert.match(tsv.body,/'=sum\(1\)/i);assert.ok(!csv.body.includes('Unavailable'));
    for(const cell of csvRows(csv.body).flat())assert.ok(!/^[\s\uFEFF]*[=+@-]/u.test(cell),'No CSV cell may begin an executable spreadsheet formula.');
    await changeSavedKeywordTags(f.project,owner,{requestId:randomUUID(),revision:(await list(f)).revision,keywordIds:first.ids,operation:'replace',tags:['Replacement']});
    assert.ok((await list(f)).rows.filter(row=>first.ids.includes(row.id)).every(row=>row.tags.length===1&&row.tags[0].name==='Replacement'));
    await changeSavedKeywordTags(f.project,owner,{requestId:randomUUID(),revision:(await list(f)).revision,keywordIds:first.ids,operation:'clear'});assert.ok((await list(f)).rows.filter(row=>first.ids.includes(row.id)).every(row=>row.tags.length===0));
    const oldBlue=(await list(f)).rows.find(row=>row.keyword==='blue shoes'&&row.locationCode===2840)!.id;
    const removal={requestId:randomUUID(),revision:(await list(f)).revision,keywordIds:[oldBlue]};await removeSavedKeywords(f.project,owner,removal);
    const late=await saveSavedKeywords(f.project,owner,request);assert.ok(late.missingIds.includes(oldBlue));
    const recreate=await manual(f,[request.source.keywords[0]]);assert.notEqual(recreate.ids[0],oldBlue);await removeSavedKeywords(f.project,owner,removal);assert.ok((await list(f)).rows.some(row=>row.id===recreate.ids[0]));
    assert.equal(paidCalls,0);console.log('PASS explicit tag lifecycle, literal filtering, safe exports and delete/recreate receipt replay');

    const provenance=await fixture(true),run=await retained(provenance,['zero','unknown'],[metrics('Zero',{searchVolume:0,cpcUsd:'0.000000',competition:0,keywordDifficulty:0}),metrics('Unknown')]);
    const saved=await observed(provenance,run,[0,1]);assert.equal(saved.metricsUpdated,2);const rows=(await list(provenance,{filters:{sort:'keyword',order:'asc'}})).rows;
    const zero=rows.find(row=>row.keyword==='zero')!,unknown=rows.find(row=>row.keyword==='unknown')!;assert.equal(zero.metrics.row?.cpcUsd,'0.000000');assert.equal(unknown.metrics.row?.cpcUsd,null);assert.equal(zero.metrics.sourceRunId,run);assert.equal(zero.metrics.sourceRowIndex,0);
    assert.equal((await list(provenance,{filters:{minVolume:0,maxVolume:0,minCpcUsd:'0',maxCpcUsd:'0',minDifficulty:0,maxDifficulty:0}})).total,1);
    await assert.rejects(observed(f,run,[0]),failed(404));await assert.rejects(observed(provenance,run,[2]),failed(400));
    const forged={requestId:randomUUID(),revision:(await list(provenance)).revision,source:{type:'run',runId:run,rowIndexes:[0],metrics:{searchVolume:999}}};await assert.rejects(saveSavedKeywords(provenance.project,owner,forged),failed(400));
    const precise=await retained(provenance,['micros'],[metrics('micros',{searchVolume:1,cpcUsd:'0.000001'})]);await observed(provenance,precise,[0]);assert.equal((await list(provenance,{filters:{minCpcUsd:'0.000001',maxCpcUsd:'0.000001'}})).rows[0].keyword,'micros');
    const literalRun=await retained(provenance,['c++','%20'],[metrics('C++',{searchVolume:1}),metrics('%20',{searchVolume:2})]);await observed(provenance,literalRun,[0,1]);assert.equal((await list(provenance,{filters:{search:'c++'}})).rows[0].metrics.row?.keyword,'C++');
    const long=await retained(provenance,['seed'],[metrics('x'.repeat(500))]);await observed(provenance,long,[0]);assert.equal((await list(provenance,{filters:{search:'x'.repeat(100)}})).rows[0].refresh.eligible,false);
    const ambiguous=await retained(provenance,['same'],[metrics('Same',{searchVolume:1}),metrics(' same ',{searchVolume:2})]);const beforeConflict=await list(provenance);await assert.rejects(observed(provenance,ambiguous,[0,1]),failed(409));assert.deepEqual(await list(provenance),beforeConflict);
    const expired=await retained(provenance,['expired']);await pool.query("UPDATE keyword_research_run SET completed_at=clock_timestamp()-interval '366 days' WHERE id=$1",[expired]);await assert.rejects(observed(provenance,expired,[0]),failed(409));
    const older=await retained(provenance,['zero'],[metrics('zero',{searchVolume:999,cpcUsd:'0.900000'})]);await pool.query("UPDATE keyword_research_run SET completed_at=clock_timestamp()-interval '1 day' WHERE id=$1",[older]);const skipped=await observed(provenance,older,[0]);assert.equal(skipped.skippedOlder,1);assert.equal((await list(provenance,{filters:{search:'zero'}})).rows[0].metrics.row?.searchVolume,0);
    const exportObserved=await exportSavedKeywords(provenance.project,viewer,{selection:selection([zero.id,unknown.id]),format:'csv'});assert.match(exportObserved.body,/0\.000000/);assert.ok(!exportObserved.body.includes('Unavailable'));
    const exportedRows=csvRows(exportObserved.body),volumeColumn=exportedRows[0].indexOf('Search volume'),cpcColumn=exportedRows[0].indexOf('CPC USD');assert.equal(exportedRows.find(row=>row[0]==='zero')![volumeColumn],'0');assert.equal(exportedRows.find(row=>row[0]==='unknown')![volumeColumn],'');assert.equal(exportedRows.find(row=>row[0]==='unknown')![cpcColumn],'');
    console.log('PASS retained source provenance, forged/foreign/expired/conflicting evidence, exact CPC and unknown versus zero');

    const pages=await fixture();await manual(pages,Array.from({length:51},(_,i)=>'page '+String(i).padStart(3,'0')));
    const page1=await list(pages,{filters:{sort:'keyword',order:'asc'},pageSize:50});assert.equal(page1.rows.length,50);assert.ok(page1.nextCursor);
    const page2=await list(pages,{filters:{sort:'keyword',order:'asc'},pageSize:50,cursor:page1.nextCursor});assert.equal(page2.rows.length,1);assert.equal(new Set([...page1.rows,...page2.rows].map(row=>row.id)).size,51);
    await assert.rejects(list(pages,{filters:{sort:'keyword',order:'desc'},cursor:page1.nextCursor}),failed(400));
    await manual(pages,['page new']);await assert.rejects(list(pages,{filters:{sort:'keyword',order:'asc'},cursor:page1.nextCursor}),failed(409));
    const all=await exportSavedKeywords(pages.project,viewer,{selection:{type:'filtered',filters:{}},format:'tsv'});assert.equal(all.rowCount,52,'Filtered export must not silently equal the first on-screen page.');
    console.log('PASS stable scoped pagination, revision invalidation and complete filtered export beyond one page');

    const tagged=await fixture(),taggedIds=(await manual(tagged,['tagged'])).ids;
    for(let offset=0;offset<251;offset+=20)await changeSavedKeywordTags(tagged.project,owner,{requestId:randomUUID(),revision:(await list(tagged)).revision,keywordIds:taggedIds,operation:'add',tags:Array.from({length:Math.min(20,251-offset)},(_,i)=>'Tag '+String(offset+i).padStart(3,'0'))});
    const tags1=await listSavedKeywordTags(tagged.project,viewer,{});assert.equal(tags1.tags.length,250);assert.ok(tags1.nextCursor);
    const tags2=await listSavedKeywordTags(tagged.project,viewer,{cursor:tags1.nextCursor});assert.equal(tags2.tags.length,1);assert.equal(new Set([...tags1.tags,...tags2.tags].map(row=>row.id)).size,251);
    assert.ok((await list(tagged)).tagsNextCursor);await updateSavedKeywordTag(tagged.project,owner,tags1.tags[0].id,{requestId:randomUUID(),revision:tags1.revision,color:'sky'});await assert.rejects(listSavedKeywordTags(tagged.project,viewer,{cursor:tags1.nextCursor}),failed(409));
    console.log('PASS tag management remains paginated beyond bounded keyword filter options');

    const quote=(f:Fixture,ids:string[],user=owner)=>quoteSavedKeywordRefresh(f.project,user,{connectionId:f.connectionId,selection:selection(ids)},send);
    const start=(f:Fixture,quoteId:string,user=owner,key=randomUUID())=>startSavedKeywordRefresh(f.project,user,{quoteId,requestKey:key});
    async function childRuns(planId:string){return(await pool.query('SELECT r.id FROM keyword_research_run r JOIN keyword_quote q ON q.id=r.quote_id WHERE q.saved_refresh_plan_id=$1 ORDER BY r.id',[planId])).rows.map(row=>row.id as string);}
    async function charge(id:string){return(await pool.query('SELECT status,actual_micros,estimate_micros,provider_reference FROM provider_request WHERE id=$1',[id])).rows[0];}
    const refresh=await fixture(true),us=await manual(refresh,Array.from({length:101},(_,i)=>'refresh '+String(i).padStart(3,'0'))),uk=await manual(refresh,['uk one','uk two'],{source:{type:'manual',keywords:['uk one','uk two'],locationCode:2826,languageCode:'en'}});
    const beforeFree=freeCalls,beforePaid=paidCalls,q=(await quote(refresh,[...us.ids,...uk.ids])).quote;
    assert.equal(freeCalls-beforeFree,1);assert.equal(paidCalls,beforePaid);assert.equal(q.targetCount,103);assert.equal(q.estimateUsd,'0.048360');
    assert.deepEqual(q.children.map(child=>[child.request.locationCode,child.request.languageCode,child.request.keywords.length]),[[2826,'en',2],[2840,'en',100],[2840,'en',1]]);
    assert.equal(new Set(q.children.flatMap(child=>child.targetIds)).size,103);assert.ok(q.children.every(child=>child.request.mode==='overview'&&child.request.limit===100));
    await assert.rejects(startKeywordResearch(refresh.project,owner,{quoteId:q.children[0].quoteId,requestKey:randomUUID()}),failed(409));
    const later=(await manual(refresh,['added after quote'])).ids[0],requestKey=randomUUID();
    const starts=await Promise.all([start(refresh,q.id,owner,requestKey),start(refresh,q.id,owner,requestKey)]);assert.deepEqual(starts[0].plan.children.map(child=>child.runId),starts[1].plan.children.map(child=>child.runId));
    assert.equal((await childRuns(q.id)).length,3);
    for(const child of starts[0].plan.children){assert.ok(child.runId);await executeKeywordResearch(child.runId,send);}
    assert.equal(paidCalls-beforePaid,3);assert.equal((await getSavedKeywordRefresh(refresh.project,viewer,q.id)).plan.status,'completed');
    assert.equal((await list(refresh,{filters:{metrics:'available'},pageSize:250})).total,103);assert.equal((await list(refresh,{filters:{search:'added after quote'}})).rows[0].id,later);assert.equal((await list(refresh,{filters:{search:'added after quote'}})).rows[0].metrics.status,'unavailable');
    await pool.query("UPDATE saved_keyword_refresh_plan SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[q.id]);
    const retried=await start(refresh,q.id,owner,requestKey);assert.deepEqual(retried.plan.children.map(child=>child.runId),starts[0].plan.children.map(child=>child.runId));assert.equal(paidCalls-beforePaid,3);
    await assert.rejects(start(refresh,q.id,editor,requestKey),failed(409));await assert.rejects(start(refresh,q.id),failed(409));
    const fresh=(await quote(refresh,[later])).quote;await assert.rejects(start(refresh,fresh.id,owner,requestKey),failed(409));
    const readCalls=[freeCalls,paidCalls];await listSavedKeywordRefreshes(refresh.project,viewer);await getSavedKeywordRefresh(refresh.project,viewer,q.id);await exportSavedKeywords(refresh.project,viewer,{selection:{type:'filtered',filters:{}},format:'csv'});assert.deepEqual([freeCalls,paidCalls],readCalls);
    await assert.rejects(quoteSavedKeywordRefresh(refresh.project,viewer,{connectionId:refresh.connectionId,selection:selection([later])},send),failed(404));await assert.rejects(getSavedKeywordRefresh(foreign.project,owner,q.id),failed(404));
    console.log('PASS captured market/chunk grouping, exact estimates, ordinary-child guard, atomic replay and no calls from reads');

    const limits=await fixture(true);await pool.query(`INSERT INTO saved_keyword(id,project_id,keyword,location_code,language_code)
      SELECT gen_random_uuid(),$1,CASE WHEN n<=2000 THEN 'capacity ' ELSE 'extra ' END||lpad(n::text,5,'0'),2840,'en' FROM generate_series(1,10001) n`,[limits.project]);
    assert.equal((await list(limits)).total,10001,'The list itself has no operation-sized lifetime cap.');
    const boundCalls=[freeCalls,paidCalls];await assert.rejects(quoteSavedKeywordRefresh(limits.project,owner,{connectionId:limits.connectionId,selection:{type:'filtered',filters:{}}},send),failed(413));
    await assert.rejects(exportSavedKeywords(limits.project,owner,{selection:{type:'filtered',filters:{}},format:'csv'}),failed(413));assert.deepEqual([freeCalls,paidCalls],boundCalls);
    const capacity=(await quoteSavedKeywordRefresh(limits.project,owner,{connectionId:limits.connectionId,selection:{type:'filtered',filters:{search:'capacity '}}},send)).quote;assert.equal(capacity.targetCount,2000);assert.equal(capacity.children.length,20);assert.ok(capacity.children.every(child=>child.request.keywords.length===100));
    const markets=await fixture(true);await pool.query("INSERT INTO saved_keyword(id,project_id,keyword,location_code,language_code) SELECT gen_random_uuid(),$1,'market'||n,3000+n,'en' FROM generate_series(1,21) n",[markets.project]);
    const marketCalls=[freeCalls,paidCalls];await assert.rejects(quoteSavedKeywordRefresh(markets.project,owner,{connectionId:markets.connectionId,selection:{type:'filtered',filters:{}}},send),failed(413));assert.deepEqual([freeCalls,paidCalls],marketCalls);
    const aborted=new AbortController();aborted.abort();await assert.rejects(exportSavedKeywords(pages.project,owner,{selection:{type:'filtered',filters:{}},format:'csv'},aborted.signal),failed(499));
    console.log('PASS 2,000-target/20-child boundaries, lifetime rows above operation limits and non-truncating export rejection');

    const rollback=await fixture(true),rollbackIds=(await manual(rollback,Array.from({length:101},(_,i)=>'rollback '+i))).ids,rollbackQuote=(await quote(rollback,rollbackIds)).quote;
    const boss=await getBoss(),originalSend=boss.send.bind(boss),queuedIds:string[]=[];
    boss.send=(async(...args:any[])=>{const result=await(originalSend as any)(...args);queuedIds.push(args[2].id);if(queuedIds.length===2)throw new Error('Synthetic failure after a real second queue insert.');return result;})as typeof boss.send;
    const rollbackKey=randomUUID();try{await assert.rejects(start(rollback,rollbackQuote.id,owner,rollbackKey));}finally{boss.send=originalSend;}
    assert.equal(queuedIds.length,2);assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id=ANY($1::uuid[])',[queuedIds])).rowCount,0);assert.equal((await childRuns(rollbackQuote.id)).length,0);
    assert.equal((await pool.query('SELECT id FROM provider_request WHERE workspace_id=$1',[rollback.workspace])).rowCount,0);assert.equal((await getSavedKeywordRefresh(rollback.project,owner,rollbackQuote.id)).plan.startedAt,null);
    await saveBudget(rollback.workspace,owner,{monthlyLimitUsd:'0.025',paused:false});await assert.rejects(start(rollback,rollbackQuote.id),failed(409));assert.equal((await childRuns(rollbackQuote.id)).length,0);assert.equal((await pool.query('SELECT id FROM provider_request WHERE workspace_id=$1',[rollback.workspace])).rowCount,0);
    await saveBudget(rollback.workspace,owner,{monthlyLimitUsd:'10',paused:false});const cancel=(await start(rollback,rollbackQuote.id)).plan;const noDispatch=paidCalls;await cancelSavedKeywordRefresh(rollback.project,owner,cancel.id,{});for(const child of cancel.children)await executeKeywordResearch(child.runId!,send);assert.equal(paidCalls,noDispatch);assert.equal((await getSavedKeywordRefresh(rollback.project,owner,cancel.id)).plan.status,'cancelled');
    console.log('PASS actual queue insert rollback, all-child budget atomicity and undispatched cancellation');

    const invalid=await fixture(true),invalidIds=(await manual(invalid,['allowed','x'.repeat(81)])).ids;
    await assert.rejects(quote(invalid,invalidIds),failed(409));const allowed=(await list(invalid)).rows.find(row=>row.keyword==='allowed')!.id;
    const expiredQuote=(await quote(invalid,[allowed])).quote;await pool.query("UPDATE saved_keyword_refresh_plan SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expiredQuote.id]);await assert.rejects(start(invalid,expiredQuote.id),failed(409));
    const changed=(await quote(invalid,[allowed])).quote;await saveProvider(invalid.workspace,owner,{name:'Rotated synthetic',credentials:{login:account,password:'synthetic-rotated'},monthlyLimitUsd:'10'},invalid.connectionId!);await assert.rejects(start(invalid,changed.id),failed(409));
    const queuedExpiry=(await start(invalid,(await quote(invalid,[allowed])).quote.id)).plan;await pool.query("UPDATE keyword_quote SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE saved_refresh_plan_id=$1",[queuedExpiry.id]);const expiryPaid=paidCalls;await executeKeywordResearch(queuedExpiry.children[0].runId!,send);assert.equal(paidCalls,expiryPaid);assert.equal((await charge(queuedExpiry.children[0].runId!)).status,'cancelled');
    const removed=(await start(invalid,(await quote(invalid,[allowed])).quote.id)).plan;await removeSavedKeywords(invalid.project,owner,{requestId:randomUUID(),revision:(await list(invalid)).revision,keywordIds:[allowed]});const replacement=(await manual(invalid,['allowed'])).ids[0];await executeKeywordResearch(removed.children[0].runId!,send);assert.equal(paidCalls,expiryPaid);assert.equal((await charge(removed.children[0].runId!)).status,'cancelled');assert.equal((await list(invalid)).rows.find(row=>row.id===replacement)!.metrics.status,'unavailable');
    console.log('PASS unsupported refresh, expired/rotated quote and exact target deletion before paid dispatch');

    function barrier(){let release!:()=>void,ready!:()=>void;return{wait:new Promise<void>(resolve=>release=resolve),entered:new Promise<void>(resolve=>ready=resolve),release:()=>release(),ready:()=>ready()};}
    async function bounded<T>(promise:Promise<T>){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>timer=setTimeout(()=>reject(new Error('Synthetic race timed out.')),10_000))]);}finally{clearTimeout(timer!);}}
    const afterDispatch=await fixture(true),oldId=(await manual(afterDispatch,['after dispatch'])).ids[0],oldPlan=(await start(afterDispatch,(await quote(afterDispatch,[oldId])).quote.id)).plan,gate=barrier();
    const executing=executeKeywordResearch(oldPlan.children[0].runId!,async(...args)=>{const response=await send(...args);if(args[0]===keywordEndpoints.overview){gate.ready();await gate.wait;}return response;});
    try{await bounded(gate.entered);await removeSavedKeywords(afterDispatch.project,owner,{requestId:randomUUID(),revision:(await list(afterDispatch)).revision,keywordIds:[oldId]});await manual(afterDispatch,['after dispatch']);}finally{gate.release();await executing;}
    assert.equal((await charge(oldPlan.children[0].runId!)).status,'settled');const recreated=(await list(afterDispatch)).rows[0];assert.notEqual(recreated.id,oldId);assert.equal(recreated.metrics.status,'unavailable');
    const ordering=await fixture(true),orderedId=(await manual(ordering,['ordering'])).ids[0],firstPlan=(await start(ordering,(await quote(ordering,[orderedId])).quote.id)).plan,oldResponse=barrier();volume=11;
    const olderExecution=executeKeywordResearch(firstPlan.children[0].runId!,async(...args)=>{const response=await send(...args);if(args[0]===keywordEndpoints.overview){oldResponse.ready();await oldResponse.wait;}return response;});
    try{await bounded(oldResponse.entered);const newPlan=(await start(ordering,(await quote(ordering,[orderedId])).quote.id)).plan;volume=22;await executeKeywordResearch(newPlan.children[0].runId!,send);assert.equal((await list(ordering)).rows[0].metrics.row?.searchVolume,22);}finally{oldResponse.release();await olderExecution;}
    assert.equal((await list(ordering)).rows[0].metrics.row?.searchVolume,22);volume=0;
    const priorMetrics=(await list(ordering)).rows[0].metrics,missing=(await start(ordering,(await quote(ordering,[orderedId])).quote.id)).plan;mode='missing';await executeKeywordResearch(missing.children[0].runId!,send);mode='ok';const missingRow=(await list(ordering)).rows[0];assert.deepEqual(missingRow.metrics,priorMetrics);assert.equal(missingRow.refresh.lastAttemptStatus,'missing');
    console.log('PASS post-dispatch deletion preserves charge without resurrection, reverse completions and omitted-row evidence');

    const access=await fixture(true),accessId=(await manual(access,['permission'])).ids[0];
    const beforeRevocation=(await start(access,(await quote(access,[accessId],editor)).quote.id,editor)).plan;await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[access.workspace,editor]);const preRolePaid=paidCalls;await executeKeywordResearch(beforeRevocation.children[0].runId!,send);assert.equal(paidCalls,preRolePaid);assert.equal((await charge(beforeRevocation.children[0].runId!)).status,'cancelled');
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'editor')",[access.workspace,editor]);const during=(await start(access,(await quote(access,[accessId],editor)).quote.id,editor)).plan,permissionGate=barrier();
    const permissionExecution=executeKeywordResearch(during.children[0].runId!,async(...args)=>{const response=await send(...args);if(args[0]===keywordEndpoints.overview){permissionGate.ready();await permissionGate.wait;}return response;});
    try{await bounded(permissionGate.entered);await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[access.workspace,editor]);}finally{permissionGate.release();await permissionExecution;}
    assert.equal((await charge(during.children[0].runId!)).status,'settled');assert.equal((await list(access)).rows[0].metrics.status,'unavailable');
    const uncertain=await fixture(true),uncertainId=(await manual(uncertain,['lost result'])).ids[0],uncertainPlan=(await start(uncertain,(await quote(uncertain,[uncertainId])).quote.id)).plan,uncertainRun=uncertainPlan.children[0].runId!;
    mode='unknown';await executeKeywordResearch(uncertainRun,send);mode='ok';const uncertainPaid=paidCalls;assert.equal((await charge(uncertainRun)).status,'uncertain');await executeKeywordResearch(uncertainRun,send);assert.equal(paidCalls,uncertainPaid);
    await saveBudget(uncertain.workspace,owner,{monthlyLimitUsd:'10',paused:false});await assert.rejects(start(uncertain,(await quote(uncertain,[uncertainId])).quote.id),failed(409));
    await pool.query("UPDATE keyword_research_run SET completed_at=clock_timestamp()-interval '366 days' WHERE id=$1",[uncertainRun]);
    const originalCompletedAt=(await pool.query('SELECT completed_at::text AS at FROM keyword_research_run WHERE id=$1',[uncertainRun])).rows[0].at;
    const originalRequest=(await getKeywordRun(uncertain.project,owner,uncertainRun)).run.request;
    reconcileItems=[{id:'saved-keyword-receipt',url:'v3/dataforseo_labs/google/keyword_overview/live',metadata:keywordPayload(originalRequest,uncertainRun),status:'20000',cost:0.01212}];
    await assert.rejects(reconcileSavedKeywordRefresh(uncertain.project,editor,uncertainPlan.id,{runId:uncertainRun,connectionId:uncertain.connectionId},send),failed(404));
    assert.equal((await reconcileSavedKeywordRefresh(uncertain.project,owner,uncertainPlan.id,{runId:uncertainRun,connectionId:uncertain.connectionId},send)).reconciliation.status,'matched');assert.equal((await charge(uncertainRun)).status,'settled');assert.equal((await list(uncertain)).rows[0].metrics.status,'unavailable');assert.equal(paidCalls,uncertainPaid);
    assert.equal((await pool.query('SELECT completed_at::text AS at FROM keyword_research_run WHERE id=$1',[uncertainRun])).rows[0].at,originalCompletedAt,'Charge recovery cannot restart the provider evidence retention clock.');
    console.log('PASS live permission rechecks, settlement after revocation, uncertain block and charge-only reconciliation');

    const retention=await fixture(true),retainedRun=await retained(retention,['retained'],[metrics('retained',{searchVolume:0,cpcUsd:'0.000000'})]);const authored=await observed(retention,retainedRun,[0],{tags:['Authored tag']});
    await pool.query("UPDATE keyword_research_run SET completed_at=clock_timestamp()-interval '366 days' WHERE id=$1",[retainedRun]);await pool.query("UPDATE saved_keyword SET metric_observed_at=clock_timestamp()-interval '366 days' WHERE project_id=$1",[retention.project]);
    const ledgerBefore=await charge(retainedRun),receiptBefore=(await pool.query('SELECT * FROM project_content_request WHERE project_id=$1',[retention.project])).rows;
    const policy=await pool.connect();try{await policy.query('BEGIN');await policy.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[retention.workspace]);await policy.query('UPDATE workspace SET derived_history_days=400 WHERE id=$1',[retention.workspace]);await runRetentionBatch(retention.project);await policy.query('COMMIT');}finally{await policy.query('ROLLBACK').catch(()=>{});policy.release();}
    await runRetentionBatch(retention.project);assert.equal((await list(retention)).rows[0].metrics.status,'available');
    const retentionSettings=await getRetention(retention.workspace,owner);
    const retentionPreview=await previewRetention(retention.workspace,owner,{revision:retentionSettings.revision,settings:{...retentionSettings.settings,derivedHistoryDays:365}});
    assert.deepEqual(retentionPreview.savedKeywordEstimate,{status:'available',metrics:1,atLeast:false},'Preview counts only the selected workspace saved metric copy.');
    await pool.query('UPDATE workspace SET derived_history_days=365 WHERE id=$1',[retention.workspace]);const cleanup=await runRetentionBatch(retention.project);assert.equal(cleanup?.expiredSavedKeywordMetrics,1);const expiredRow=(await list(retention)).rows[0];
    assert.equal(expiredRow.id,authored.ids[0]);assert.equal(expiredRow.metrics.status,'expired');assert.equal(expiredRow.metrics.row,null);assert.equal(expiredRow.tags[0].name,'Authored tag');assert.deepEqual(await charge(retainedRun),ledgerBefore);assert.deepEqual((await pool.query('SELECT * FROM project_content_request WHERE project_id=$1',[retention.project])).rows,receiptBefore);
    await pool.query('UPDATE workspace SET derived_history_days=400 WHERE id=$1',[retention.workspace]);await runRetentionBatch(retention.project);assert.equal((await list(retention)).rows[0].metrics.status,'expired');
    const expiredExport=await exportSavedKeywords(retention.project,viewer,{selection:selection(authored.ids),format:'csv'});assert.match(expiredExport.body,/expired/);assert.ok(!expiredExport.body.includes('0.000000'));
    // A bounded cleanup may clear the saved copy before the source run's batch.
    const partial=await fixture(true),partialRun=await retained(partial,['partial cleanup']);await observed(partial,partialRun,[0]);
    await pool.query("UPDATE keyword_research_run SET completed_at=clock_timestamp()-interval '366 days' WHERE id=$1",[partialRun]);
    await pool.query('UPDATE saved_keyword SET metric_observed_at=(SELECT completed_at FROM keyword_research_run WHERE id=$2),metric_data=NULL,metric_expired_at=clock_timestamp() WHERE project_id=$1',[partial.project,partialRun]);
    await pool.query('UPDATE workspace SET derived_history_days=400 WHERE id=$1',[partial.workspace]);
    assert.notEqual((await getKeywordRun(partial.project,owner,partialRun)).run.result,null);
    assert.equal((await observed(partial,partialRun,[0])).skippedOlder,1);assert.equal((await list(partial)).rows[0].metrics.status,'expired','Extending policy cannot resurrect an already erased copy from the same observation.');
    const newerRun=await retained(partial,['partial cleanup'],[metrics('partial cleanup',{searchVolume:2})]);await observed(partial,newerRun,[0]);assert.equal((await list(partial)).rows[0].metrics.row?.searchVolume,2,'A genuinely newer explicit observation may replace expired evidence.');
    console.log('PASS original observation retention, extension serialization, authored preservation and irreversible expiry');

    const login=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:owner+'@saved-keywords.integration.test',password})}));assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    const endpoint=config.appUrl+'/api/projects/'+f.project+'/saved-keywords';assert.equal((await handleApi(new Request(endpoint))).status,401);
    const read=await handleApi(new Request(endpoint,{headers:{cookie}}));assert.equal(read.status,200);const text=await read.text();assert.ok(!text.includes('synthetic-rotated')&&!text.includes('account_fingerprint')&&!text.includes('encrypted_credentials'));
    const token=(await createApiKey(f.workspace,owner,{name:'No implicit keyword grant',scopes:['analytics:read']})).token;assert.equal((await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+token}}))).status,403);
    assert.equal((await handleApi(new Request(endpoint+'/save',{method:'POST',headers:{cookie,origin:'https://foreign.integration.test','content-type':'application/json'},body:'{}'}))).status,403);
    console.log('PASS cookie-only saved-keyword API, Origin enforcement and secret-free metadata');
    assert.equal(accidentalRequests,0);
  }finally{try{await stopJobs();}finally{globalThis.fetch=originalFetch;}}
}
if(import.meta.main){try{await runSavedKeywordChecks();}finally{await closeDatabase();}}
