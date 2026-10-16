import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildUtmParams,utmFields,validUtmResult,type UtmField} from '../src/lib/utm-report.ts';
import type {ExploreResult} from '../src/components/ExplorerPanel';

const scope=()=>new URLSearchParams({from:'2026-10-01',to:'2026-10-01',timeZone:'UTC',kind:'pageviews',groupBy:'campaignSource',path:'/offer'});
// Synthetic native-shaped report: this does not establish reader, SQL or browser acceptance.
function fixture(field:UtmField='campaignSource'):ExploreResult{
  const params=buildUtmParams(scope(),field);
  return {range:{from:'2026-10-01',to:'2026-10-01',timeZone:'UTC',start:'2026-10-01T00:00:00.000Z',end:'2026-10-02T00:00:00.000Z'},query:{from:'2026-10-01',to:'2026-10-01',timeZone:'UTC',kind:'pageviews',groupBy:field,groupProperty:null,filters:{path:'/offer'},property:null,predicates:JSON.parse(params.get('predicates')!)},coverage:{status:'complete',retainedFrom:null},totals:{events:5,pageViews:5,customEvents:0,identifiedEvents:3,unidentifiedEvents:2,visitors:2,visits:2},daily:[{date:'2026-10-01',start:'2026-10-01T00:00:00.000Z',end:'2026-10-02T00:00:00.000Z',skipped:false,coverage:'complete',events:5,pageViews:5,customEvents:0}],breakdown:{groups:[{type:'string',value:'newsletter',events:3,identifiedEvents:2,visitors:1},{type:'string',value:'null',events:2,identifiedEvents:1,visitors:1}],totalGroups:2,returnedGroupEvents:5,truncated:false},properties:{keys:[],truncated:false},numeric:null,csv:'Metric,Value\nPage views,5\n'};
}

test('five UTM scopes preserve exact AND filters and add only their own nonempty-tag predicate',()=>{
  for(const [field]of utmFields){
    const input=scope(),before=input.toString(),params=buildUtmParams(input,field);
    assert.equal(input.toString(),before);assert.equal(params.get('path'),'/offer');assert.equal(params.get('groupBy'),field);assert.equal(params.get('kind'),'pageviews');
    assert.deepEqual(JSON.parse(params.get('predicates')!),{version:1,match:'all',fields:[{field,operator:'neq',value:''}],properties:[]});
    assert.equal(validUtmResult(fixture(field),params),true);
  }
  for(const extra of Array.of<Record<string,string>>({predicates:JSON.stringify({version:1,match:'any',fields:[],properties:[]})},{cohortId:'x'},{propertyKey:'plan'},{sessionProperties:'x'},{kind:'custom'},{groupBy:'property'})){
    const params=scope();for(const [key,value]of Object.entries(extra))params.set(key,value);assert.throws(()=>buildUtmParams(params,'campaignSource'));
  }
  for(const origin of ['','https://example.com/','https://example.com/path','javascript:alert(1)','https://user:pass@example.com','https://EXAMPLE.com']){const input=scope();input.set('origin',origin);assert.throws(()=>buildUtmParams(input,'campaignSource'),/Origin must be an exact HTTP/);}
  for(const origin of ['https://example.com','http://localhost:3012']){const input=scope();input.set('origin',origin);assert.equal(buildUtmParams(input,'campaignSource').get('origin'),origin);}
  const duplicate=scope();duplicate.append('path','/other');assert.throws(()=>buildUtmParams(duplicate,'campaignSource'));
  const oversized=scope();oversized.set('campaignName','x'.repeat(20000));assert.throws(()=>buildUtmParams(oversized,'campaignSource'));
});

test('UTM rows reject wrong field, missing/empty/duplicate values, unsupported selection and inconsistent totals',()=>{
  const params=buildUtmParams(scope(),'campaignSource');
  const corruptions:Array<(r:ExploreResult)=>void>=[
    r=>{r.query.groupBy='campaignMedium';},r=>{delete r.query.groupBy;},r=>{r.query.filters.path='/other';},
    r=>{r.query.predicates!.match='any';},r=>{r.query.property={key:'plan',type:'string',value:'pro'};},r=>{r.query.fields=['campaignSource','campaignMedium'];},
    r=>{Object.assign(r,{sessionProperties:{selection:{status:'available'}}});},r=>{Object.assign(r,{cohort:{}});},r=>{Object.assign(r,{propertyReport:{}});},
    r=>{r.breakdown.groups[0].type='missing';r.breakdown.groups[0].value=null;},r=>{r.breakdown.groups[0].value='';},r=>{r.breakdown.groups[0].value='x'.repeat(321);},r=>{r.breakdown.groups[0].value='\ud800';},r=>{r.breakdown.groups[1].value='newsletter';},
    r=>{r.breakdown.groups.reverse();},r=>{r.breakdown.groups[0].events=3.5;},r=>{r.breakdown.groups[0].identifiedEvents=4;},r=>{r.breakdown.groups[0].visitors=null;},
    r=>{r.breakdown.returnedGroupEvents=4;},r=>{r.breakdown.totalGroups=3;},r=>{r.breakdown.truncated=true;},r=>{r.totals.pageViews=6;},r=>{r.totals.events=6;r.totals.pageViews=6;r.totals.unidentifiedEvents=3;},r=>{r.coverage.status='unavailable';},r=>{r.totals.pageViews=null;},
  ];
  for(const change of corruptions){const result=fixture();change(result);assert.equal(validUtmResult(result,params),false);}
});

test('full tagged denominator retains all100 rows and distinguishes partial, genuine zero and unavailable history',()=>{
  const params=buildUtmParams(scope(),'campaignSource'),partial=fixture();partial.coverage={status:'partial',retainedFrom:'2026-10-01T12:00:00.000Z'};partial.daily[0].coverage='partial';
  assert.equal(validUtmResult(partial,params),true);
  const full=fixture();full.breakdown={groups:Array.from({length:100},(_,i)=>({type:'string',value:`tag-${i}`,events:2,identifiedEvents:0,visitors:null})),totalGroups:102,returnedGroupEvents:200,truncated:true};full.totals={events:203,pageViews:203,customEvents:0,identifiedEvents:0,unidentifiedEvents:203,visitors:null,visits:null};Object.assign(full.daily[0],{events:203,pageViews:203});
  assert.equal(validUtmResult(full,params),true);assert.equal(full.breakdown.groups.length,100);assert.equal(full.totals.pageViews!-full.breakdown.returnedGroupEvents!,3);
  const impossible=structuredClone(full);impossible.totals.events=201;impossible.totals.pageViews=201;impossible.totals.unidentifiedEvents=201;assert.equal(validUtmResult(impossible,params),false);
  const zero=fixture();zero.totals={events:0,pageViews:0,customEvents:0,identifiedEvents:0,unidentifiedEvents:0,visitors:null,visits:null};zero.breakdown={groups:[],totalGroups:0,returnedGroupEvents:0,truncated:false};Object.assign(zero.daily[0],{events:0,pageViews:0});assert.equal(validUtmResult(zero,params),true);
  const unavailable=structuredClone(zero);unavailable.coverage={status:'unavailable',retainedFrom:'2026-10-02T00:00:00.000Z'};unavailable.totals={events:null,pageViews:null,customEvents:null,identifiedEvents:null,unidentifiedEvents:null,visitors:null,visits:null};Object.assign(unavailable.daily[0],{coverage:'unavailable',events:null,pageViews:null,customEvents:null});assert.equal(validUtmResult(unavailable,params),true);
  unavailable.breakdown.totalGroups=null;unavailable.breakdown.returnedGroupEvents=null;assert.equal(validUtmResult(unavailable,params),false,'legacy single-field unavailable grouping is0/0, not the tuple/property null contract');
});
