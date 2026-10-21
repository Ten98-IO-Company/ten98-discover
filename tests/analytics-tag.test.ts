import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {PoolClient} from 'pg';
import {analyticsDimensions,analyticsFieldLimit} from '../src/lib/analytics-dimensions.ts';
import {analyticsTag,analyticsTagLimit} from '../src/lib/analytics-tag.ts';
import {normalizeDimensions} from '../src/server/analytics-input.ts';
import {analyticsDimensionValueSql} from '../src/server/analytics-dimensions.ts';
import {insertApiObservation,nativeCollectionPolicy,publicTrackingSettings,trackingConsentEpoch} from '../src/server/native-analytics.ts';

test('tag validator accepts labels and rejects identifier-like values', () => {
  const accepted:[string,string][]=[['spring-sale','spring-sale'],['  Beta Group_2  ','Beta Group_2'],['team:growth/ab.v2','team:growth/ab.v2'],['release 2026-10-21','release 2026-10-21'],['z'.repeat(50),'z'.repeat(50)],['1234567','1234567']];
  for(const [input,expected] of accepted)assert.equal(analyticsTag(input),expected,input);
  const rejected:[string,unknown][]=[['empty',''],['blank','   '],['at sign','sales@example.com'],['email-like','jane.doe at example.com 1234567890'],
    ['uuid','id 123e4567-e89b-12d3-a456-426614174000'],['long digits','order 12345678'],['phone-like','555-123-4567'],['long hex','deadbeefdeadbeef'],['query url','https://example.com/p?email=a'],
    ['fragment','page#section'],['too long','z'.repeat(51)],['disallowed chars','tag!'],['unicode','café'],['control','a\u0000b'],['newline','a\nb'],['number',5],['null',null],['object',{}]];
  for(const [label,input] of rejected)assert.equal(analyticsTag(input),null,label);
  assert.equal(analyticsTagLimit,100);
  assert.equal(analyticsFieldLimit('tag'),50);
});

test('a rejected tag drops the tag and keeps the rest of the dimensions', () => {
  assert.deepEqual(normalizeDimensions({language:'en',tag:'sales@example.com'}),{language:'en'});
  assert.deepEqual(normalizeDimensions({tag:' promo '}),{tag:'promo'});
  assert.deepEqual(normalizeDimensions({tag:42}),{});
});

test('tag is a comparison dimension grouped on the stored label, with unlabelled events missing', () => {
  assert.ok(analyticsDimensions.includes('tag'));
  const sql=analyticsDimensionValueSql('$1','e');
  assert.match(sql,/WHEN 'tag' THEN e\.dimensions->'tag'/);
});

test('public tracking settings never expose captureTags', () => {
  const base={enabled:true,consentMode:'builtin',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:false,excludedPaths:[]};
  assert.equal('captureTags' in publicTrackingSettings({...base,captureTags:true}),false);
});

const origin='https://example.com';
function project(captureTags:boolean|undefined){
  return {id:'project-1',origin,analytics_epoch:'epoch-1',analytics_revision:1,destination_epoch:null,
    analytics_settings:{enabled:true,consentMode:'builtin',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:false,excludedPaths:[],...captureTags===undefined?{}:{captureTags}}};
}
/** Records the stored dimensions; `known` and `distinct` stand in for the project's retained tagged events. */
function fakeClient(row:ReturnType<typeof project>,known:boolean,distinct:number){
  const stored:Record<string,unknown>[]=[];
  const client={async query(sql:string,params:unknown[]=[]){
    if(sql.startsWith('SELECT * FROM project')||sql.includes('LEFT JOIN tracking_state'))return {rows:[row],rowCount:1};
    if(sql.includes('clock_timestamp'))return {rows:[{at:'2026-10-21T00:00:00.000000Z'}],rowCount:1};
    if(sql.includes("e.dimensions->>'tag'=$2"))return {rows:[],rowCount:known?1:0};
    if(sql.includes('count(DISTINCT'))return {rows:[{count:String(distinct)}],rowCount:1};
    if(sql.startsWith('INSERT INTO event')){stored.push(JSON.parse(params[8] as string));return {rows:[{id:'e'}],rowCount:1};}
    return {rows:[],rowCount:0};
  }};
  return {client:client as unknown as PoolClient,stored};
}
const observation=(tag:unknown)=>({eventId:'11111111-1111-4111-8111-111111111111',name:'signup',url:`${origin}/pricing`,dimensions:{tag}});

test('tag is not stored while the owner setting is off or absent', async () => {
  for(const setting of [false,undefined]){
    const {client,stored}=fakeClient(project(setting),true,0);
    await insertApiObservation(client,'project-1',observation('promo'));
    assert.equal('tag' in stored[0]!,false);
  }
});

test('tag is stored when the setting is on, and refused for a new value at the cap', async () => {
  let run=fakeClient(project(true),false,analyticsTagLimit-1);
  await insertApiObservation(run.client,'project-1',observation('promo'));
  assert.equal(run.stored[0]!.tag,'promo');
  run=fakeClient(project(true),false,analyticsTagLimit);
  await insertApiObservation(run.client,'project-1',observation('promo'));
  assert.equal('tag' in run.stored[0]!,false);
  assert.ok(run.stored[0]!.origin);
  run=fakeClient(project(true),true,analyticsTagLimit); // an existing value keeps its slot
  await insertApiObservation(run.client,'project-1',observation('promo'));
  assert.equal(run.stored[0]!.tag,'promo');
  run=fakeClient(project(true),false,0);
  await insertApiObservation(run.client,'project-1',observation('a@b.c'));
  assert.equal('tag' in run.stored[0]!,false);
});

test('a tagged browser event without current analytics consent is not collected', async () => {
  const row=project(true);
  const request=new Request(`${origin}/api/collect`,{method:'POST',headers:{origin}});
  const input={...observation('promo'),url:`${origin}/pricing`};
  const withoutConsent=await nativeCollectionPolicy(fakeClient(row,false,0).client,request,'key',input,'event');
  assert.equal(withoutConsent.reason,'consent_required');
  assert.equal(withoutConsent.basis,null);
  const epoch=trackingConsentEpoch(row.analytics_epoch,null);
  const stale=await nativeCollectionPolicy(fakeClient(row,false,0).client,request,'key',{...input,consent:{analytics:true,epoch:'old'}},'event');
  assert.equal(stale.reason,'consent_required');
  const granted=await nativeCollectionPolicy(fakeClient(row,false,0).client,request,'key',{...input,consent:{analytics:true,epoch}},'event');
  assert.equal(granted.reason,null);
});
