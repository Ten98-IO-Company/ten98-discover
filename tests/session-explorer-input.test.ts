import assert from 'node:assert/strict';
import test from 'node:test';
import {canonicalHash} from '../src/server/context-input.ts';
import {explorerQuery} from '../src/server/explorer-input.ts';
import {parseSegmentDefinition} from '../src/server/segment-input.ts';
import {parseCohortDefinition} from '../src/server/cohort-input.ts';
import {sessionListQuery,sessionActivityQuery,linkedActivityQuery,linkedActivityScope,canonicalSessionListQuery,sessionCursorScope,parseSessionCursor,encodeSessionCursor,type SessionCursor} from '../src/server/session-explorer-input.ts';

const now=new Date('2026-10-14T12:00:00Z'),project='11111111-1111-4111-8111-111111111111',event='22222222-2222-4222-8222-222222222222';
const key='a'.repeat(64),otherKey='b'.repeat(64),calendar={from:'2024-02-29',to:'2024-03-01',timeZone:'Asia/Dubai'};
const params=(extra:Record<string,string>={})=>new URLSearchParams({...calendar,...extra});
const list=(extra:Record<string,string>={})=>sessionListQuery(params(extra),now);
const encoded=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const cursor=(route:'list'|'activity'='list'):SessionCursor=>({version:1,projectId:project,scope:sessionCursorScope(project,route==='list'?list():sessionActivityQuery(key,params(),now)),
  pageSize:route==='list'?25:50,eventBefore:'2026-10-14T12:00:00.000001Z',retention:{policyHash:'c'.repeat(64),initialEvidenceHash:'d'.repeat(64)},
  ...(route==='list'?{route,last:{at:'2024-03-01T10:00:00.123456Z',visitorKey:key}}:{route,visitorKey:key,last:{at:'2024-03-01T10:00:00.123456Z',id:event}})});

test('list defaults and canonical exact filters preserve empty, literals and Unicode without grouping',()=>{
  const input=list({campaignSource:'',path:'/A,b%_\\ 🐎',visitorKey:key,timeZone:'Etc/UTC'});
  assert.equal(input.pageSize,25);assert.equal(input.cursor,null);assert.equal(input.query.kind,'all');assert.equal(input.query.timeZone,'UTC');
  assert.deepEqual(input.query.filters,{path:'/A,b%_\\ 🐎',campaignSource:''});
  assert.equal(Object.hasOwn(input.query,'groupBy'),false);assert.equal(Object.hasOwn(input.query.filters,'campaignMedium'),false);
  const canonical=canonicalSessionListQuery(input.query);
  assert.match(canonical,/^from=2024-02-29&to=2024-03-01&timeZone=UTC&kind=all&path=/);
  assert.deepEqual(sessionListQuery(new URLSearchParams(canonical),now),input);
  assert.equal(list({kind:'custom',pageSize:'100'}).pageSize,100);
  assert.equal(list({kind:'pageviews',path:''}).query.filters.path,'');
});

test('both routes require explicit valid bounded calendar context and strict page sizes',()=>{
  for(const read of [(p:URLSearchParams)=>sessionListQuery(p,now),(p:URLSearchParams)=>sessionActivityQuery(key,p,now)]){
    for(const name of ['from','to','timeZone']){const p=params();p.delete(name);assert.throws(()=>read(p),{status:400});}
    const invalid:Record<string,string>[]=[{from:'2024-02-30'},{from:'2024-03-02'},{timeZone:''},{timeZone:'No/Such_Zone'},{from:'2024-01-01',to:'2025-01-01'}];
    for(const extra of invalid)assert.throws(()=>read(params(extra)),{status:400});
    assert.doesNotThrow(()=>read(params({from:'2024-01-01',to:'2024-12-31'})));
    for(const pageSize of ['','0','101','1.5','01','+1',' 1','1\n','1e2','Infinity','NaN'])assert.throws(()=>read(params({pageSize})),{status:400});
    assert.equal(read(params({pageSize:'1'})).pageSize,1);
  }
});

test('list excludes report state and every route rejects unknown and repeated parameters',()=>{
  for(const name of ['groupBy','groupProperty','orderBy','segmentId','scope','format','version','visitId','policyHash','asOf'])assert.throws(()=>list({[name]:'event'}),{status:400});
  for(const name of ['from','to','timeZone','kind','path','predicates','pageSize','cursor','visitorKey','cohortId','propertyKey']){
    const p=params();p.append(name,'x');p.append(name,'y');assert.throws(()=>sessionListQuery(p,now),{status:400});
  }
  for(const name of ['kind','path','visitorKey','predicates','cohortId','cohortRevision','propertyKey','groupBy'])assert.throws(()=>sessionActivityQuery(key,params({[name]:'x'}),now),{status:400});
  for(const value of ['',key.toUpperCase(),key+'\n','a'.repeat(63),'g'.repeat(64)]){
    assert.throws(()=>list({visitorKey:value}),{status:400});assert.throws(()=>sessionActivityQuery(value,params(),now),{status:400});
  }
});

test('native typed exact properties round trip with microsecond dates, missing, null and empty distinct',()=>{
  for(const [type,value,expected]of [['missing',undefined,null],['null',null,null],['string','',''],['string','2024-02-29T00:00:00Z','2024-02-29T00:00:00Z'],
    ['date','2024-02-29T12:00:00.123456789+04:00','2024-02-29T08:00:00.123456789Z'],['number',12.5,12.5],['boolean',false,false],['array',['1',1,null,false],['1',1,null,false]]]as const){
    const p=params({propertyKey:'a\\.b 🐎',propertyType:type});if(value!==undefined)p.set('propertyValue',JSON.stringify(value));
    const input=sessionListQuery(p,now);assert.deepEqual(input.query.property,{key:'a\\.b 🐎',type,value:expected});
    assert.deepEqual(sessionListQuery(new URLSearchParams(canonicalSessionListQuery(input.query)),now),input);
  }
  for(const extra of [{propertyKey:'x',propertyType:'missing',propertyValue:'null'},{propertyKey:'x',propertyType:'number',propertyValue:'"1"'},{propertyKey:'x',propertyType:'date',propertyValue:'"2024-02-30T00:00:00Z"'}])assert.throws(()=>list(extra),{status:400});
});

test('advanced event/session predicates and cohort references reuse canonical native semantics',()=>{
  const predicates={version:1,match:'any',fields:[{field:'path',operator:'contains',value:'A%_'}],properties:[{key:'plan',operator:'eq',type:'string',value:'event'}],
    sessionProperties:[{key:'plan',operator:'eq',type:'string',value:'session'},{key:'date',operator:'eq',type:'date',value:'2024-02-29T12:00:00.123456+04:00'}]};
  const p=params({predicates:JSON.stringify(predicates),path:'/required',cohortId:event.toUpperCase(),cohortRevision:'2'}),input=sessionListQuery(p,now);
  assert.deepEqual(input.query.predicates,explorerQuery(p,now).predicates);assert.equal(input.query.cohort!.id,event);assert.equal(input.query.cohort!.revision,2);
  assert.deepEqual(sessionListQuery(new URLSearchParams(canonicalSessionListQuery(input.query)),now),input);
  const saved=parseSegmentDefinition({schemaVersion:1,name:'Saved',query:new URLSearchParams({path:'/required',predicates:JSON.stringify(predicates)}).toString()});
  assert.deepEqual(list(Object.fromEntries(new URLSearchParams(saved.query))).query.predicates,input.query.predicates);
  const cohort=parseCohortDefinition({schemaVersion:1,name:'Cohort',query:params({path:'/required',predicates:JSON.stringify(predicates)}).toString()},now);
  assert.deepEqual(sessionListQuery(new URLSearchParams(cohort.query),now).query.predicates,input.query.predicates);
  const invalid:Record<string,string>[]=[{cohortId:event},{cohortRevision:'2'},{cohortId:event,cohortRevision:'02'},{cohortId:event,cohortRevision:'2147483648'}];
  for(const extra of invalid)assert.throws(()=>list(extra),{status:400});
});

test('the canonical population cap includes defaults and preserves the caller params',()=>{
  const p=params({path:'中'.repeat(2048),language:'中'.repeat(160)});while(p.toString().length<19994)p.set('language',p.get('language')!+'a');
  assert.ok(p.toString().length<=20000);assert.ok(p.get('language')!.length<=320);
  const before=p.toString();assert.throws(()=>sessionListQuery(p,now),{status:400});assert.equal(p.toString(),before);
  p.set('language',p.get('language')!.slice(0,-20));const input=sessionListQuery(p,now);assert.ok(canonicalSessionListQuery(input.query).length<=20000);
  const small=params({cursor:encodeSessionCursor(cursor())});sessionListQuery(small,now);assert.equal(small.get('cursor'),encodeSessionCursor(cursor()));
});

test('activity remains an explicit range-only query with its independent default page size',()=>{
  const input=sessionActivityQuery(key,params(),now);assert.deepEqual(input,{visitorKey:key,...calendar,pageSize:50,cursor:null});
  assert.deepEqual(sessionActivityQuery(key,new URLSearchParams({...calendar,pageSize:'100',cursor:encodeSessionCursor(cursor('activity'))}),now).cursor,cursor('activity'));
  assert.throws(()=>list({cursor:encodeSessionCursor(cursor('activity'))}),{status:400});
  assert.throws(()=>sessionActivityQuery(key,params({cursor:encodeSessionCursor(cursor())}),now),{status:400});
});

test('cursor codec preserves lossless microseconds and both closed route shapes',()=>{
  for(const route of ['list','activity']as const){const value=cursor(route),wire=encodeSessionCursor(value);assert.deepEqual(parseSessionCursor(wire),value);assert.equal(encodeSessionCursor(parseSessionCursor(wire)),wire);}
  const earlier={...cursor(),eventBefore:'2024-03-01T10:00:00.123457Z'};assert.equal(parseSessionCursor(encodeSessionCursor(earlier)).last.at,'2024-03-01T10:00:00.123456Z');
  assert.doesNotThrow(()=>encodeSessionCursor({...cursor(),eventBefore:'2099-01-01T00:00:00.000000Z'})); // Current asOf is service-owned.
  for(const stamp of ['2024-02-30T00:00:00.000000Z','2023-02-29T00:00:00.000000Z','0000-01-01T00:00:00.000000Z','2024-01-01T24:00:00.000000Z','2024-01-01T00:00:60.000000Z',
    '2024-01-01T00:00:00.123Z','2024-01-01T00:00:00.1234567Z','2024-01-01T00:00:00.123456+00:00','2024-01-01T00:00:00.123456z','2024-01-01T00:00:00.123456Z\n']){
    assert.throws(()=>parseSessionCursor(encoded({...cursor(),last:{at:stamp,visitorKey:key}})),{status:400});
  }
  for(const at of [cursor().eventBefore,'2027-01-01T00:00:00.000000Z'])assert.throws(()=>parseSessionCursor(encoded({...cursor(),last:{at,visitorKey:key}})),{status:400});
});

test('cursor wire rejects noncanonical base64url, UTF8 and JSON before trusting any fields',()=>{
  const good=encodeSessionCursor(cursor());
  for(const wire of ['',good+'=',good+'\n','a'.repeat(2049),Buffer.from([0xc0,0xaf]).toString('base64url'),
    Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify(cursor()))]).toString('base64url'),
    Buffer.from(' '+JSON.stringify(cursor())).toString('base64url'),Buffer.from(JSON.stringify(cursor()).replace('"version":1','"version":1,"version":1')).toString('base64url'),
    encoded({...cursor(),version:2}),encoded({...cursor(),propertyValue:'secret'}),encoded({...cursor(),retention:{...cursor().retention,cutoff:'2020-01-01'}}),
    encoded({...cursor(),pageSize:'25'}),encoded({...cursor(),projectId:'foreign'}),encoded({...cursor(),scope:'x'}),encoded({...cursor(),last:{at:'2024-01-01T00:00:00.000000Z',id:event}})])assert.throws(()=>parseSessionCursor(wire),{status:400});
  const reordered=Object.fromEntries(Object.entries(cursor()).reverse());assert.throws(()=>parseSessionCursor(encoded(reordered)),{status:400});
  const raw=Buffer.from(good,'base64url');if(raw.length%3){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',index=alphabet.indexOf(good.at(-1)!);assert.throws(()=>parseSessionCursor(good.slice(0,-1)+alphabet[index+1]),{status:400});}
});

test('scope hashes canonical inputs and changes for every population/navigation boundary',()=>{
  const input=list({path:'/x',timeZone:'Etc/UTC'}),scope=sessionCursorScope(project,input);
  assert.equal(scope,sessionCursorScope(project,sessionListQuery(new URLSearchParams(canonicalSessionListQuery(input.query)),now)));
  assert.equal(scope,canonicalHash(['session-explorer-scope-v1','list',project,canonicalSessionListQuery(input.query),null,25]));
  const changes=[list({path:'/y',timeZone:'UTC'}),list({path:'/x',timeZone:'UTC',visitorKey:key}),list({path:'/x',timeZone:'UTC',pageSize:'50'}),list({path:'/x',timeZone:'Asia/Dubai'}),list({path:'/x',timeZone:'UTC',to:'2024-03-02'})];
  for(const changed of changes)assert.notEqual(scope,sessionCursorScope(project,changed));
  assert.notEqual(scope,sessionCursorScope(event,input));
  const activity=sessionActivityQuery(key,params(),now);assert.notEqual(sessionCursorScope(project,activity),sessionCursorScope(project,{...activity,visitorKey:otherKey}));
  assert.notEqual(sessionCursorScope(project,activity),sessionCursorScope(project,list()));
});

test('identified activity rejects raw lookup, list predicates, wrong route cursors and noncanonical scope',()=>{
  const input=linkedActivityQuery(key,params({timeZone:'Etc/UTC'}),now),anchor='f'.repeat(64);
  assert.equal(input.timeZone,'UTC');assert.equal(input.pageSize,50);
  for(const name of ['distinctId','identityToken','generation','email','predicates','path','cohortId','eventBefore','returnTo'])assert.throws(()=>linkedActivityQuery(key,params({[name]:'x'}),now),{status:400});
  for(const name of ['from','to','timeZone','pageSize','cursor']){const p=params();p.append(name,'x');assert.throws(()=>linkedActivityQuery(key,p,now),{status:400});}
  for(const route of ['list','activity'] as const)assert.throws(()=>linkedActivityQuery(key,params({cursor:encodeSessionCursor(cursor(route))}),now),{status:400});
  const scope=linkedActivityScope(project,input,anchor);
  const activity=cursor('activity');if(activity.route!=='activity')throw Error('Expected the activity control cursor.');
  const value:SessionCursor={...activity,route:'linked-activity',scope,anchor};
  const wire=encodeSessionCursor(value);assert.deepEqual(parseSessionCursor(wire),value);
  assert.equal(linkedActivityQuery(key,params({timeZone:'UTC',cursor:wire}),now).cursor?.last.at,'2024-03-01T10:00:00.123456Z');
  assert.throws(()=>sessionActivityQuery(key,params({cursor:wire}),now),{status:400});
  assert.throws(()=>parseSessionCursor(encoded({...value,identityToken:key})),{status:400});
  assert.throws(()=>parseSessionCursor(encoded({...value,anchor:'raw-customer-id'})),{status:400});
  for(const changed of [{...input,visitorKey:otherKey},{...input,pageSize:1},{...input,timeZone:'Asia/Dubai'},{...input,to:'2024-03-02'}])assert.notEqual(linkedActivityScope(project,changed,anchor),scope);
  assert.notEqual(linkedActivityScope(event,input,anchor),scope);assert.notEqual(linkedActivityScope(project,input,key),scope);
  assert.equal(Buffer.from(wire,'base64url').toString().includes('identityToken'),false);
});
