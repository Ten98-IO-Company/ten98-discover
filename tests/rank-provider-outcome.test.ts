import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseRankDispatchOutcome,parseRankReconciliation,matchesRankPayload,type RankExpectedTask,type RankProviderPhase} from '../src/server/rank-provider-outcome.ts';
import {rankSerpPayload} from '../src/server/rank-serp-input.ts';
import {dataforseoRefusalMessage} from '../src/server/dataforseo-transport.ts';

const now=new Date('2026-10-13T09:00:00Z');
const expected:RankExpectedTask={id:randomUUID(),request:{keyword:'C++ %20',domain:'example.com',locationCode:2840,languageCode:'en',device:'desktop',depth:100,maxCrawlPages:3}};
function task(entry=expected,phase:RankProviderPhase='live',status=20000,cost=0.006):any{
  const id=entry.providerTaskId??randomUUID();
  return {id,status_code:status,cost,result_count:status===20100?0:1,
    path:phase==='live'?['v3','serp','google','organic','live','advanced']:phase==='post'?['v3','serp','google','organic','task_post']:['v3','serp','google','organic','task_get','advanced',id],
    data:{...rankSerpPayload(entry.request,entry.id,phase==='live'?'live':'queued'),api:'serp',se:'google',se_type:'organic',function:phase==='live'?'live':phase==='post'?'task_post':'task_get'},
    result:status===20100?null:[{keyword:entry.request.keyword,type:'organic',location_code:2840,language_code:'en',datetime:'2026-10-13 08:59:00 +00:00',pages_count:1,items_count:1,item_types:['organic'],items:[{type:'organic',rank_group:2,rank_absolute:4,page:1,url:'https://example.com/a',domain:'example.com'}]}]};
}
const response=(tasks:any[],cost=0.006)=>({httpStatus:200,body:{status_code:20000,cost,tasks_count:tasks.length,tasks}});
test('verified live and pending task identities ignore absent or nonsensical billing metadata',()=>{
  for(const phase of ['live','post'] as const){
    const raw=task(expected,phase,phase==='post'?20100:20000);delete raw.cost;
    const reply:any=response([raw]);delete reply.body.cost;
    const parsed=parseRankDispatchOutcome(reply,phase,[expected],now);
    assert.equal(parsed.known,true);assert.equal(parsed.tasks[0].known,true);assert.equal(parsed.tasks[0].state,phase==='post'?'pending':'completed');
    assert.equal(/cost|micros|price/i.test(JSON.stringify(parsed)),false);
    reply.body.cost='unsupported';raw.cost={invalid:true};assert.equal(parseRankDispatchOutcome(reply,phase,[expected],now).known,true);
    raw.data.tag='foreign';assert.equal(parseRankDispatchOutcome(reply,phase,[expected],now).known,false);
  }
});
test('live results preserve known outcomes, literal identity and organic observations including documented legacy path',()=>{
  const raw=task(),parsed=parseRankDispatchOutcome(response([raw]),'live',[expected],now);
  assert.equal(parsed.known,true);assert.equal(parsed.tasks[0].observation?.position,2);assert.equal(parsed.tasks[0].state,'completed');
  raw.path=['v3','serp','google','organic','advanced','live'];assert.equal(parseRankDispatchOutcome(response([raw]),'live',[expected],now).known,true);
});
test('queued acknowledgements and matched GET outcomes preserve each original task',()=>{
  const other={...expected,id:randomUUID(),request:{...expected.request,device:'mobile' as const}};
  const first=task(expected,'post',20100),second=task(other,'post',20100);
  const posted=parseRankDispatchOutcome(response([second,first],0.012),'post',[expected,other],now);
  assert.equal(posted.known,true);assert.equal(posted.known,true);assert.deepEqual(posted.tasks.map(t=>t.id),[expected.id,other.id]);
  assert.equal(posted.tasks[0].known,true);assert.equal(posted.tasks[0].state,'pending');
  const known={...expected,providerTaskId:first.id};const retrieved=parseRankDispatchOutcome(response([task(known,'get',20000,0.002)],0.002),'get',[known],now);
  assert.equal(retrieved.known,true);assert.equal(retrieved.known,true);assert.equal(retrieved.tasks[0].known,true);
});
test('verified provider outcomes remain separate from usable observation data',()=>{
  const partial=parseRankDispatchOutcome(response([task(expected,'live',40106)]),'live',[expected],now);assert.equal(partial.known,true);assert.equal(partial.tasks[0].state,'completed');assert.match(partial.tasks[0].diagnostic!,/partial/);
  const invalid=task();invalid.result[0].location_code=2826;
  const parsed=parseRankDispatchOutcome(response([invalid]),'live',[expected],now);assert.equal(parsed.known,true);assert.equal(parsed.tasks[0].state,'failed');assert.equal(parsed.tasks[0].observation,null);
  const none=task(expected,'live',40102,0);none.result=null;none.result_count=0;
  const noResults=parseRankDispatchOutcome(response([none],0),'live',[expected],now);assert.equal(noResults.known,true);assert.equal(noResults.tasks[0].observation,null); // No invented observation timestamp.
});
test('unknown live statuses stay unresolved while matched pending GET statuses stay known',()=>{
  for(const status of [20100,40105,40401,40403,40601,40602,50000,50303,50401,59999]){
    const parsed=parseRankDispatchOutcome(response([task(expected,'live',status,0)],0),'live',[expected],now);
    assert.equal(parsed.known,false,String(status));assert.equal(parsed.tasks[0].known,false,String(status));
  }
  const known={...expected,providerTaskId:randomUUID()};
  for(const status of [20100,40601,40602]){
    const parsed=parseRankDispatchOutcome(response([task(known,'get',status,0)],0),'get',[known],now);assert.equal(parsed.tasks[0].state,'pending');assert.equal(parsed.known,true);
  }
});
test('wrong tags, scope, device, path, ID or extra request options leave the whole dispatch unresolved',()=>{
  for(const change of [(r:any)=>r.data.tag='other',(r:any)=>r.data.location_code=2826,(r:any)=>r.data.keyword='C  %20',(r:any)=>r.data.device='mobile',(r:any)=>r.data.max_crawl_pages=4,(r:any)=>r.data.people_also_ask_click_depth=1,(r:any)=>r.data.url='https://evil.org/',(r:any)=>r.path.push('unexpected'),(r:any)=>r.id='../secret',(r:any)=>r.data.load_async_ai_overview=true]){
    const raw=task();change(raw);const parsed=parseRankDispatchOutcome(response([raw]),'live',[expected],now);assert.equal(parsed.known,false);assert.equal(parsed.tasks[0].observation,null);
  }
  const known={...expected,providerTaskId:randomUUID()},wrong=task(known,'get');wrong.id=randomUUID();wrong.path[6]=wrong.id;
  assert.equal(parseRankDispatchOutcome(response([wrong]),'get',[known],now).known,false);
  const raw=task();raw.data.stop_crawl_on_match=[{match_value:'evil.org',match_type:'with_subdomains'}];assert.equal(matchesRankPayload(raw.data,expected,'live'),false);
});
test('complete one-to-one batch mapping is required before a request outcome is known',()=>{
  const other={...expected,id:randomUUID()};const first=task(expected,'post',20100),second=task(other,'post',20100);
  for(const tasks of [[first,first],[first],[first,{...second,id:first.id}]])assert.equal(parseRankDispatchOutcome(response(tasks,0.012),'post',[expected,other],now).known,false);
  assert.equal(parseRankDispatchOutcome({...response([task()]),httpStatus:503},'live',[expected],now).known,false);
  assert.throws(()=>parseRankDispatchOutcome(response([task()]),'live',[expected,other],now));
  assert.throws(()=>parseRankDispatchOutcome(response([task()]),'get',[expected],now));
  assert.throws(()=>parseRankDispatchOutcome(response([task()]),'post',[expected,expected],now));
});

test('recovery requires a unique complete exact task, captured time window and known account-bound request',()=>{
  const original=task(),dispatched=new Date('2026-10-13T08:58:00Z');
  const row={id:original.id,url:'v3/serp/google/organic/live/advanced',metadata:original.data,status:'20000',cost:0.006,datetime_posted:'2026-10-13 08:59:00 +00:00'};
  const page=(rows:any[])=>recoveryPage(rows);
  const recoveredFinal=parseRankReconciliation(page([row]),'live',[expected],dispatched,now);
  assert.equal(recoveredFinal.known,true);assert.equal(recoveredFinal.tasks[0].state,'unavailable');
  assert.equal(recoveredFinal.tasks[0].providerTaskId,original.id);assert.equal(recoveredFinal.tasks[0].observation,null);
  assert.equal(parseRankReconciliation(page([{...row,status:20000}]),'live',[expected],dispatched,now).known,true);
  for(const rows of [[],[row,row],Array(1000).fill(row),[{...row,datetime_posted:'2026-10-13 08:55:00 +00:00'}],[{...row,datetime_posted:'2026-10-13 09:05:00 +00:00'}],[{...row,status:'40403',cost:0}],[{...row,metadata:{...row.metadata,depth:10}}],[{...row,url:'v3/serp/google/organic/task_post'}],[{...row,id:row.id+'\n'}]]){
    assert.equal(parseRankReconciliation(page(rows),'live',[expected],dispatched,now).known,false);
  }
  assert.throws(()=>parseRankReconciliation(page([row]),'live',[expected],new Date('2026-09-01T00:00:00Z'),now));
  const queued=task(expected,'post',20100),pending={...row,id:queued.id,url:'v3/serp/google/organic/task_post',metadata:queued.data,status:'40602'};
  const recovered=parseRankReconciliation(page([pending]),'queued',[expected],dispatched,now);assert.equal(recovered.tasks[0].state,'pending');assert.equal(recovered.tasks[0].providerTaskId,queued.id);assert.equal(recovered.known,true);
});

test('unrequested search domain and organic grouping overrides cannot bind to the quoted request',()=>{
  // These documented options change the search or what counts as an organic item.
  // https://docs.dataforseo.com/v3/serp/google/organic/task_post/
  for(const [key,value] of [['se_domain','google.co.uk'],['group_organic_results',false],['remove_from_url',['q']],['ignore_targets_in',['organic']]] as const){
    const raw=task();raw.data[key]=value;
    assert.equal(matchesRankPayload(raw.data,expected,'live'),false,key);
    const parsed=parseRankDispatchOutcome(response([raw]),'live',[expected],now);
    assert.equal(parsed.known,false,key);assert.equal(parsed.tasks[0].observation,null,key);
  }
});

const dispatched=new Date('2026-10-13T08:58:00Z');
function recoveryRow(entry=expected,status='20000',cost=0.006):any{
  const original=task(entry);
  return {id:original.id,url:'v3/serp/google/organic/live/advanced',metadata:original.data,status,cost,datetime_posted:'2026-10-13 08:59:00 +00:00'};
}
function recoveryPage(rows:any[],data:Record<string,unknown>={}):any{
  return response([{status_code:20000,cost:0,path:['v3','serp','id_list'],
    data:{api:'serp',function:'id_list',datetime_from:'2026-10-13 08:57:00 +00:00',datetime_to:'2026-10-13 09:00:00 +00:00',limit:1000,offset:0,sort:'asc',include_metadata:true,...data},
    result_count:rows.length,result:rows}],0);
}
test('a short later metadata page cannot prove unique complete reconciliation evidence',()=>{
  const row=recoveryRow();
  assert.equal(parseRankReconciliation(recoveryPage([row]),'live',[expected],dispatched,now).known,true);
  // An earlier page could contain a second task with this same tag. A one-row
  // final page, or a response to a smaller requested limit, is not a full window.
  for(const data of [{offset:1000},{offset:9000},{limit:1},{offset:'0'},{limit:'1000'},{sort:'desc'},{include_metadata:false},
    {datetime_from:'2026-10-13 08:58:00 +00:00'},{datetime_to:'2026-10-13 08:59:00 +00:00'},
    {datetime_from:'2026-10-13 08:56:59 +00:00'},{datetime_to:'2026-10-13 09:00:01 +00:00'}]){
    assert.equal(parseRankReconciliation(recoveryPage([row],data),'live',[expected],dispatched,now).known,false,JSON.stringify(data));
  }
  assert.throws(()=>parseRankReconciliation(recoveryPage([row]),'live',[expected],dispatched,new Date(now.getTime()-1)),/Unsupported/);
  assert.equal(parseRankReconciliation(recoveryPage([row]),'live',[expected],dispatched,new Date(now.getTime()+86_400_000)).known,true);
});

test('only explicitly harmless echoed defaults are admitted alongside the exact authored payload',()=>{
  const raw=task();Object.assign(raw.data,{group_organic_results:true,target_search_mode:'any',ignore_targets_in:[],remove_from_url:[],postback_data:'advanced',priority:1});
  assert.equal(matchesRankPayload(raw.data,expected,'live'),true);
  assert.equal(parseRankDispatchOutcome(response([raw]),'live',[expected],now).known,true);
  for(const [key,value] of [['se_domain','google.com'],['unknown_default',false],['target_search_mode','all'],['postback_data','html'],['priority',2],['group_organic_results','true']]){
    assert.equal(matchesRankPayload({...raw.data,[key as string]:value},expected,'live'),false,String(key));
  }
});

test('control characters and unsupported status shapes cannot become request evidence',()=>{
  const row=recoveryRow();
  for(const change of [
    (r:any)=>r.status='20000\n',(r:any)=>r.status=['20000'],(r:any)=>r.status=20000.1,
    (r:any)=>r.status=true,(r:any)=>r.status=null,(r:any)=>r.status=NaN,(r:any)=>r.status=Infinity,(r:any)=>r.status=' 20000',(r:any)=>r.status='2e4',
    (r:any)=>r.datetime_posted+='\n',(r:any)=>r.datetime_posted+='\r',
    (r:any)=>r.id+='\n',(r:any)=>r.metadata.tag+='\0',
  ]){
    const changed=structuredClone(row);change(changed);
    assert.equal(parseRankReconciliation(recoveryPage([changed]),'live',[expected],dispatched,now).known,false,JSON.stringify(changed));
  }
});

test('path arrays must match the actual endpoint segments rather than a flattened lookalike',()=>{
  const raw=task();raw.path=['v3/serp','google','organic','live','advanced'];
  assert.equal(parseRankDispatchOutcome(response([raw]),'live',[expected],now).known,false);
});

test('mixed task states remain independent of malformed billing metadata and invalid recovery evidence',()=>{
  const other={...expected,id:randomUUID(),request:{...expected.request,device:'mobile' as const}};
  const pending=task(expected,'post',20100,0.004),final=task(other,'post',40501,0);final.result_count=0;final.result=null;
  const mixed=parseRankDispatchOutcome(response([final,pending],0.004),'post',[expected,other],now);
  assert.equal(mixed.known,true);assert.equal(mixed.known,true);
  assert.equal(mixed.tasks[0].known,true);assert.equal(mixed.tasks[1].known,true);
  for(const cost of [-1,NaN,Infinity,'0.006',null,0.0000001]){
    const raw=task();raw.cost=cost;
    assert.equal(parseRankDispatchOutcome(response([raw],cost as any),'live',[expected],now).known,true,String(cost));
  }
  const known={...expected,providerTaskId:randomUUID()};
  for(const status of ['20100','40601','40602','40105','40401','40403','29999','50000']){
    assert.equal(parseRankReconciliation(recoveryPage([recoveryRow(known,status,0)]),'live',[known],dispatched,now).known,false,status);
  }
  const wrong=recoveryRow(known);wrong.id=randomUUID();
  assert.equal(parseRankReconciliation(recoveryPage([wrong]),'live',[known],dispatched,now).known,false);
  const earlier=recoveryRow();earlier.datetime_posted='2026-02-30 08:59:00 +00:00';
  assert.equal(parseRankReconciliation(recoveryPage([earlier]),'live',[expected],dispatched,now).known,false);
});

// Provider refusals are terminal request failures; billing metadata is irrelevant.
test('whole-response provider refusals are known failures without billing evidence',()=>{
 const other={...expected,id:randomUUID(),request:{...expected.request,device:'mobile' as const}};
 for(const [phase,list,httpStatus,body] of [
  ['live',[expected],200,{status_code:40210,tasks_count:0,tasks:null}],
  ['post',[expected,other],402,{status_code:40200,tasks:null}],
  ['post',[expected,other],200,{status_code:20000,tasks_count:2,tasks:[{status_code:40203},{status_code:40203}]}]
 ] as [RankProviderPhase,RankExpectedTask[],number,unknown][]){
  const out=parseRankDispatchOutcome({httpStatus,body},phase,list,now);
  assert.equal(out.known,true);assert.deepEqual(out.tasks.map(t=>[t.id,t.state,t.known,t.providerTaskId,t.observation]),list.map(t=>[t.id,'failed',true,null,null]));assert.equal(out.diagnostic,dataforseoRefusalMessage.provider);
  assert.doesNotMatch(JSON.stringify(out),/price|cost|micros/i);
 }
});

test('a matched task refusal leaves its sibling pending and billing metadata cannot change either outcome',()=>{
 const other={...expected,id:randomUUID(),request:{...expected.request,device:'mobile' as const}};
 const pending=task(expected,'post',20100),refused=task(other,'post',40210);refused.result=null;refused.result_count=0;
 for(const reported of [0,0.0006,-1,'invalid']){
  const out=parseRankDispatchOutcome(response([pending,{...refused,cost:reported}],reported as any),'post',[expected,other],now);
  assert.equal(out.known,true);assert.deepEqual(out.tasks.map(t=>[t.state,t.known,t.providerTaskId,t.statusCode]),[['pending',true,pending.id,20100],['failed',true,refused.id,40210]]);
 }
 const foreign={...refused,data:{...refused.data,tag:'foreign'}};assert.equal(parseRankDispatchOutcome(response([pending,foreign]),'post',[expected,other],now).known,false);
 const known={...expected,providerTaskId:randomUUID()},polled={...task(known,'get',40210),result:null,result_count:0};
 for(const body of [{status_code:40210,tasks_count:0,tasks:null},{status_code:20000,tasks_count:1,tasks:[polled]}]){
  const out=parseRankDispatchOutcome({httpStatus:200,body},'get',[known],now);assert.equal(out.known,false);assert.equal(out.tasks[0].state,'uncertain');
 }
});
