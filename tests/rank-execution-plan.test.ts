import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonicalHash} from '../src/server/context-input.ts';
import {compileRankPlan,readRankPlan,rankPlanTotal,rankTaskRequest,rankGroupTasks,rankGroupPayload,type RankPlan} from '../src/server/rank-execution-plan.ts';
import {parseRankBasePrices} from '../src/server/rank-serp-input.ts';

const target:RankPlan['target']={domain:'example.com',locationCode:2840,languageCode:'en',depth:100,maxCrawlPages:3};
const keyword=(text='C++ %20',matchCase=true)=>({id:randomUUID(),keyword:text,matchCase});
const compile=(extra:Partial<Parameters<typeof compileRankPlan>[0]>={})=>compileRankPlan({method:'queued',target:{...target},devices:'both',keywords:[keyword()],baseMicros:600n,...extra});
const read=(plan:RankPlan)=>readRankPlan(plan,canonicalHash(plan));
function corrupt(source:RankPlan,mutate:(plan:RankPlan)=>void){const changed=structuredClone(source);mutate(changed);return changed;}

test('literal keyword and captured identity remain independent from later caller mutations',()=>{
  const input={method:'queued' as const,target:{...target},devices:'both' as const,keywords:[keyword()],baseMicros:600n};
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

test('real account prices and operator/page ceilings sum exactly once per task and dispatch',()=>{
  const cost=(amount:number)=>[{cost_type:'per_request',cost:amount}];
  const prices=parseRankBasePrices({price:{serp:{live:{advanced:{priority_normal:cost(.002)}},task_post:{priority_normal:cost(.0006)},task_get:{advanced:{priority_normal:cost(0)}}}}});
  for(const method of ['live','queued'] as const){
    const plan=compile({method,keywords:[keyword('plain'),keyword('site:example.com filetype:pdf')],baseMicros:method==='live'?prices.liveMicros:prices.queuedMicros});
    const expected=method==='live'?['6000','6000','150000','150000']:['1800','1800','45000','45000'];
    assert.deepEqual(plan.tasks.map(t=>t.maximumMicros),expected);assert.equal(rankPlanTotal(plan),method==='live'?312000n:93600n);
    assert.equal(plan.groups.length,method==='live'?4:1);assert.equal(read(plan).baseMicros,method==='live'?'2000':'600');
    for(const group of plan.groups){const payload=rankGroupPayload(plan,group);assert.ok(payload.every(p=>method==='queued'?p.priority===1:!Object.hasOwn(p,'priority')));}
  }
});

test('1,000 keywords on both devices produce exactly2,000 identities with no dropped or duplicate dispatch tasks',()=>{
  const keywords=Array.from({length:1000},(_,i)=>keyword('term '+i,false));
  for(const method of ['queued','live'] as const){
    const plan=compile({method,keywords,target:{...target,maxCrawlPages:1},baseMicros:1n});
    assert.equal(plan.tasks.length,2000);assert.equal(plan.groups.length,method==='queued'?20:2000);assert.equal(rankPlanTotal(plan),2000n);
    assert.equal(new Set(plan.tasks.map(t=>t.id)).size,2000);assert.equal(new Set(plan.groups.map(g=>g.requestKey)).size,plan.groups.length);
    assert.deepEqual(plan.groups.flatMap(g=>g.taskIds),plan.tasks.map(t=>t.id));assert.equal(new Set(plan.tasks.map(t=>t.keywordId+':'+t.device)).size,2000);
    for(const group of plan.groups){assert.ok(group.taskIds.length<=(method==='queued'?100:1));assert.equal(group.maximumMicros,String(group.taskIds.length));}
    assert.deepEqual(read(plan),plan);
  }
});

test('worst-case valid UTF-8 payloads respect both batch bytes and persisted plan bytes without truncation',()=>{
  const domain=['a'.repeat(63),'b'.repeat(63),'c'.repeat(63),'d'.repeat(57),'com'].join('.');assert.equal(domain.length,253);
  const plan=compile({target:{domain,locationCode:2147483647,languageCode:'abc-XY',depth:100,maxCrawlPages:10},keywords:Array.from({length:1000},()=>keyword('界'.repeat(200))),baseMicros:1n});
  assert.equal(plan.tasks.length,2000);assert.equal(plan.groups.length,20);assert.equal(rankPlanTotal(plan),20000n);
  let count=0;for(const group of plan.groups){const payload=rankGroupPayload(plan,group),text=JSON.stringify(payload);assert.ok(Buffer.byteLength(text)>text.length);assert.ok(Buffer.byteLength(text)<=131072);count+=payload.length;assert.ok(payload.every(p=>p.keyword==='界'.repeat(200)));}
  assert.equal(count,2000);assert.ok(Buffer.byteLength(JSON.stringify(plan))<=1_800_000);assert.deepEqual(read(plan),plan);
  // Current per-field limits keep even100 worst-case tasks below128KiB. The byte
  // guard is defense in depth; this fixture does not claim an unreachable split.
});

test('the monetary ceiling is inclusive and never truncated across tasks or batches',()=>{
  const accepted=compile({target:{...target,maxCrawlPages:1},baseMicros:500_000_000_000n});assert.equal(rankPlanTotal(accepted),1_000_000_000_000n);assert.deepEqual(read(accepted),accepted);
  assert.throws(()=>compile({target:{...target,maxCrawlPages:1},baseMicros:500_000_000_001n}));
  for(const baseMicros of [0n,-1n,1_000_000_000_001n])assert.throws(()=>compile({baseMicros}));
  assert.throws(()=>compile({keywords:[keyword('site:'.repeat(35))]}));
  assert.throws(()=>compile({keywords:[]}));assert.throws(()=>compile({keywords:Array.from({length:1001},()=>keyword())}));
  assert.throws(()=>compile({devices:'tablet' as any}));assert.throws(()=>compile({method:'unknown' as any}));
});

test('stored plans reject inconsistent hashes, amounts, duplicate groups and omitted or foreign assignments',()=>{
  const base=compile({keywords:[keyword('one'),keyword('two')]});
  assert.throws(()=>readRankPlan(base,'0'.repeat(64)));assert.throws(()=>readRankPlan({...base,extra:true},canonicalHash({...base,extra:true})));
  const mutations:((p:RankPlan)=>void)[]=[
    p=>{p.baseMicros='0';},p=>{p.baseMicros='0600';},p=>{p.tasks[0].maximumMicros='1801';},p=>{p.groups[0].maximumMicros='7201';},
    p=>{p.tasks[0].maximumMicros='1e3';},p=>{p.groups[0].maximumMicros+='\n';},
    p=>{p.tasks[1].id=p.tasks[0].id;},p=>{p.tasks[1].device=p.tasks[0].device;},
    p=>{p.groups[0].taskIds.pop();p.groups[0].maximumMicros='5400';},
    p=>{p.groups[0].taskIds[1]=p.groups[0].taskIds[0];},p=>{p.groups[0].taskIds[0]=randomUUID();},
    p=>{p.groups.push(structuredClone(p.groups[0]));},p=>{p.method='live';},
    p=>{p.target.maxCrawlPages=0;},p=>{p.target.domain='EXAMPLE.COM';},p=>{p.tasks[0].keyword='bad\u0000query';},p=>{p.tasks[0].keyword='bad\ud800';},
  ];
  for(const mutate of mutations)assert.throws(()=>read(corrupt(base,mutate)));
  assert.throws(()=>rankGroupTasks(base,{...base.groups[0],taskIds:[randomUUID()]}));
  const live=compile({method:'live'});assert.throws(()=>read(corrupt(live,p=>{p.groups[1].requestKey=p.groups[0].requestKey;})));
  const queued=compile({keywords:Array.from({length:51},()=>keyword())});
  assert.throws(()=>read(corrupt(queued,p=>{p.groups[0].taskIds.push(...p.groups[1].taskIds);p.groups[0].maximumMicros=rankPlanTotal(p).toString();p.groups.pop();})));
  const overCap=compile({target:{...target,maxCrawlPages:1},baseMicros:500_000_000_000n});
  assert.throws(()=>read(corrupt(overCap,p=>{p.tasks.push({...p.tasks[0],id:randomUUID(),keywordId:randomUUID()});p.groups.push({requestKey:randomUUID(),taskIds:[p.tasks[2].id],maximumMicros:'500000000000'});})));
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
