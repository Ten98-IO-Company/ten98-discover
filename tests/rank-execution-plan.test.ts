import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonicalHash} from '../src/server/context-input.ts';
import {rankRequestDiagnostic} from '../src/server/rank-serp-input.ts';
import {compileRankPlan,readRankPlan,rankTaskRequest,rankGroupTasks,rankGroupPayload,type RankPlan} from '../src/server/rank-execution-plan.ts';

const target:RankPlan['target']={domain:'example.com',locationCode:2840,languageCode:'en',depth:100,maxCrawlPages:3};
const keyword=(text='C++ %20',matchCase=true)=>({id:randomUUID(),keyword:text,matchCase});
const compile=(extra:Partial<Parameters<typeof compileRankPlan>[0]>={})=>compileRankPlan({method:'queued',target:{...target},devices:'both',keywords:[keyword()],...extra});
const read=(plan:RankPlan)=>readRankPlan(plan,canonicalHash(plan));
function corrupt(source:RankPlan,mutate:(plan:RankPlan)=>void){const changed=structuredClone(source);mutate(changed);return changed;}

test('literal keyword and captured identity remain independent from later caller mutations',()=>{
  const input={method:'queued' as const,target:{...target},devices:'both' as const,keywords:[keyword()]};
  const id=input.keywords[0].id,plan=compileRankPlan(input),captured=structuredClone(plan),hash=canonicalHash(plan);
  input.keywords[0].keyword='changed';input.keywords[0].matchCase=false;input.keywords[0].id=randomUUID();input.target.domain='other.com';
  assert.deepEqual(plan,captured);assert.deepEqual(plan.tasks.map(t=>[t.keywordId,t.keyword,t.matchCase,t.device]),[[id,'C++ %20',true,'desktop'],[id,'C++ %20',true,'mobile']]);
  const payload=rankGroupPayload(plan,plan.groups[0]);
  for(const item of payload){assert.equal(item.keyword,'C%2B%2B %2520');assert.equal(decodeURIComponent(item.keyword.replace(/\+/g,' ')),'C++ %20');assert.deepEqual(item.stop_crawl_on_match,[{match_value:'example.com',match_type:'with_subdomains'}]);}
  assert.deepEqual(payload.map(p=>p.os),['windows','android']);assert.deepEqual(rankGroupTasks(plan,plan.groups[0]).map(t=>t.id),plan.tasks.map(t=>t.id));
  const decoded=readRankPlan(plan,hash);decoded.tasks[0].keyword='different copy';decoded.groups[0].taskIds.pop();assert.deepEqual(plan,captured);
  const request=rankTaskRequest(plan,plan.tasks[0]);request.domain='other.com';assert.equal(plan.target.domain,'example.com');
  const original=keyword(),upper={...original,id:original.id.toUpperCase()};
  const normalized=compile({target:{...target,domain:'BÜCHER.de.'},keywords:[upper]});
  assert.equal(normalized.target.domain,'xn--bcher-kva.de');assert.equal(normalized.tasks[0].keywordId,upper.id.toLowerCase());assert.deepEqual(read(normalized),normalized);
});

test('request-only plans preserve operators and page scope without financial factors',()=>{
 for(const method of ['live','queued'] as const){
  const plan=compile({method,keywords:[keyword('plain'),keyword('site:example.com filetype:pdf')]});
  assert.equal(plan.version,2);assert.equal(plan.tasks.length,4);assert.equal(plan.groups.length,method==='live'?4:1);
  assert.doesNotMatch(JSON.stringify(plan),/price|cost|micros|maximumUsd/i);assert.deepEqual(read(plan),plan);
 }
});

test('1,000 keywords on both devices produce exactly2,000 identities with no dropped or duplicate dispatch tasks',()=>{
  const keywords=Array.from({length:1000},(_,i)=>keyword('term '+i,false));
  for(const method of ['queued','live'] as const){
    const plan=compile({method,keywords,target:{...target,maxCrawlPages:1}});
    assert.equal(plan.tasks.length,2000);assert.equal(plan.groups.length,method==='queued'?20:2000);
    assert.equal(new Set(plan.tasks.map(t=>t.id)).size,2000);assert.equal(new Set(plan.groups.map(g=>g.requestKey)).size,plan.groups.length);
    assert.deepEqual(plan.groups.flatMap(g=>g.taskIds),plan.tasks.map(t=>t.id));assert.equal(new Set(plan.tasks.map(t=>t.keywordId+':'+t.device)).size,2000);
    for(const group of plan.groups){assert.ok(group.taskIds.length<=(method==='queued'?100:1));}
    assert.deepEqual(read(plan),plan);
  }
});

test('worst-case valid UTF-8 payloads respect both batch bytes and persisted plan bytes without truncation',()=>{
  const domain=['a'.repeat(63),'b'.repeat(63),'c'.repeat(63),'d'.repeat(57),'com'].join('.');assert.equal(domain.length,253);
  const plan=compile({target:{domain,locationCode:2147483647,languageCode:'abc-XY',depth:100,maxCrawlPages:10},keywords:Array.from({length:1000},()=>keyword('界'.repeat(200)))});
  assert.equal(plan.tasks.length,2000);assert.equal(plan.groups.length,20);
  let count=0;for(const group of plan.groups){const payload=rankGroupPayload(plan,group),text=JSON.stringify(payload);assert.ok(Buffer.byteLength(text)>text.length);assert.ok(Buffer.byteLength(text)<=131072);count+=payload.length;assert.ok(payload.every(p=>p.keyword==='界'.repeat(200)));}
  assert.equal(count,2000);assert.ok(Buffer.byteLength(JSON.stringify(plan))<=1_800_000);assert.deepEqual(read(plan),plan);
  // Current per-field limits keep even100 worst-case tasks below128KiB. The byte
  // guard is defense in depth; this fixture does not claim an unreachable split.
});

test('technical limits reject empty or excessive task sets without restricting valid operator queries',()=>{
 assert.deepEqual(read(compile({keywords:[keyword('site:'.repeat(35))]})).tasks.map(t=>t.keyword),Array(2).fill('site:'.repeat(35)));
 assert.throws(()=>compile({keywords:[]}));assert.throws(()=>compile({keywords:Array.from({length:1001},()=>keyword())}));
 assert.throws(()=>compile({devices:'tablet' as any}));assert.throws(()=>compile({method:'unknown' as any}));
});

test('stored plans reject inconsistent hashes, duplicate groups and omitted or foreign assignments',()=>{
  const base=compile({keywords:[keyword('one'),keyword('two')]});
  assert.throws(()=>readRankPlan(base,'0'.repeat(64)));assert.throws(()=>readRankPlan({...base,extra:true},canonicalHash({...base,extra:true})));
  const mutations:((p:RankPlan)=>void)[]=[
    p=>{p.tasks[1].id=p.tasks[0].id;},p=>{p.tasks[1].device=p.tasks[0].device;},
    p=>{p.groups[0].taskIds.pop();},
    p=>{p.groups[0].taskIds[1]=p.groups[0].taskIds[0];},p=>{p.groups[0].taskIds[0]=randomUUID();},
    p=>{p.groups.push(structuredClone(p.groups[0]));},p=>{p.method='live';},
    p=>{p.target.maxCrawlPages=0;},p=>{p.target.domain='EXAMPLE.COM';},p=>{p.tasks[0].keyword='bad\u0000query';},p=>{p.tasks[0].keyword='bad\ud800';},
  ];
  for(const mutate of mutations)assert.throws(()=>read(corrupt(base,mutate)));
  assert.throws(()=>rankGroupTasks(base,{...base.groups[0],taskIds:[randomUUID()]}));
  const live=compile({method:'live'});assert.throws(()=>read(corrupt(live,p=>{p.groups[1].requestKey=p.groups[0].requestKey;})));
  const queued=compile({keywords:Array.from({length:51},()=>keyword())});
  assert.throws(()=>read(corrupt(queued,p=>{p.groups[0].taskIds.push(...p.groups[1].taskIds);p.groups.pop();})));

});

test('canonical UUID identity cannot be duplicated through case variants in compiler or saved plans',()=>{
  const k={...keyword(),id:'09e9a1d9-c77e-4e33-a610-5927b2c3f24a'};
  assert.throws(()=>compile({keywords:[k,{...k,id:k.id.toUpperCase()}]}));
  const base=compile({devices:'desktop',keywords:[keyword('one'),keyword('two')]});
  assert.throws(()=>read(corrupt(base,p=>{p.tasks[1].keywordId=p.tasks[0].keywordId.toUpperCase();})));
  assert.throws(()=>read(corrupt(base,p=>{p.tasks[1].id=p.tasks[0].id.toUpperCase();p.groups[0].taskIds[1]=p.tasks[1].id;})));
  const live=compile({method:'live'});assert.throws(()=>read(corrupt(live,p=>{p.groups[1].requestKey=p.groups[0].requestKey.toUpperCase();})));
});

test('every device task for one captured keyword ID must preserve identical text and match-case evidence',()=>{
  const base=compile();
  assert.throws(()=>read(corrupt(base,p=>{p.tasks[1].keyword='another query';})));
  assert.throws(()=>read(corrupt(base,p=>{p.tasks[1].matchCase=false;})));
  const extra=compile({keywords:[keyword('one'),keyword('two')]});
  // Equal literal text with different saved IDs is not a duplicate identity.
  extra.tasks[2].keyword=extra.tasks[3].keyword='one';assert.deepEqual(read(extra),extra);
});

test('historical plans retain their exact hash while projecting request scope only',()=>{
 const plan=compile(),legacy={...plan,version:1,baseMicros:'600',tasks:plan.tasks.map(task=>({...task,maximumMicros:'1800'})),groups:plan.groups.map(group=>({...group,maximumMicros:'3600'}))};
 const original=structuredClone(legacy);assert.deepEqual(readRankPlan(legacy,canonicalHash(legacy)),plan);assert.deepEqual(legacy,original);
 assert.throws(()=>readRankPlan(legacy,'0'.repeat(64)));
});

test('stored request scope cannot exceed one thousand captured keyword identities',()=>{
 const plan=compile({devices:'desktop',keywords:Array.from({length:1000},(_,i)=>keyword('term '+i))});
 const task={...plan.tasks[0],id:randomUUID(),keywordId:randomUUID()};plan.tasks.push(task);plan.groups.push({requestKey:randomUUID(),taskIds:[task.id]});
 assert.throws(()=>read(plan));
});

test('legacy run, dispatch and task diagnostics expose request outcomes without rewriting stored evidence',()=>{
 const saved=Object.freeze({
  run:Object.freeze({id:'saved-run',status:'uncertain',diagnostic:'The provider charge or result could not be confirmed. An owner must reconcile this check; it will not be sent again.'}),
  dispatch:Object.freeze({id:'saved-dispatch',status:'settled',diagnostic:'The final charge is recorded, but remaining result evidence could not be collected.'}),
  task:Object.freeze({id:'saved-task',status:'failed',diagnostic:'The provider reported conflicting final charge evidence. An owner must review the saved charge.'})
 });
 const original=JSON.stringify(saved);
 const projected=Object.values(saved).map(row=>({...row,diagnostic:rankRequestDiagnostic(row.diagnostic,row.status)}));
 assert.equal(JSON.stringify(saved),original);assert.deepEqual(projected.map(row=>row.id),['saved-run','saved-dispatch','saved-task']);
 assert.match(projected[0].diagnostic!,/outcome is unknown/);
 for(const row of projected)assert.doesNotMatch(row.diagnostic!,/charg|cost|price|fund|balance|wallet|credit|billing|invoice|paid|\$/i);
 for(const message of ['Skipped: current provider account or prices could not be verified. No paid request was sent.','Account balance is too low.','USD 0.000013','$0.010000','Invoice already recorded.']){
  assert.equal(rankRequestDiagnostic(message,'settled'),'Inspect the original provider request for its outcome and available results.');
 }
 const observation='Some search-result pages were not returned. Coverage reflects the partial result.';
 assert.equal(rankRequestDiagnostic(observation,'settled'),observation);
 assert.equal(rankRequestDiagnostic(null,'settled'),null);assert.equal(rankRequestDiagnostic(null,'uncertain'),projected[0].diagnostic);
});
