import assert from 'node:assert/strict';
import {test} from 'node:test';
import {collectNative,nativeCollectionPolicy,publicAnalyticsSettings,trackingConsentEpoch} from '../src/server/native-analytics.ts';
import {eventInput,InputError} from '../src/server/validation.ts';
import type {PoolClient} from 'pg';

test('privacy settings reject control suffixes and malformed path encodings', () => {
  const settings={enabled:true,consentMode:'builtin',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:[]};
  for(const path of ['/private\n','/private\r','/private\0','/private\u007f','/%ff','/%','/\ud800']) {
    assert.throws(()=>publicAnalyticsSettings({...settings,excludedPaths:[path]}));
  }
  assert.deepEqual(publicAnalyticsSettings({...settings,excludedPaths:['/café','/caf%C3%A9','/private area']}).excludedPaths,
    ['/café','/caf%C3%A9','/private area']);
});

test('missing collection mode preserves legacy consent-first while explicit modes stay independent of the preference interface',()=>{
  const settings={enabled:true,consentMode:'external',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:[]};
  assert.equal(publicAnalyticsSettings(settings).collectionMode,'consent-first');
  for(const collectionMode of ['consent-first','cookieless'])assert.equal(publicAnalyticsSettings({...settings,collectionMode}).collectionMode,collectionMode);
  for(const collectionMode of [null,'anonymous',true])assert.throws(()=>publicAnalyticsSettings({...settings,collectionMode}));
});

test('basic envelope stays strict and conflicting consent/identifiers fail before database access',async()=>{
  const id='00000000-0000-4000-8000-000000000001',base={siteKey:id,eventId:id,name:'page_view',url:'https://site.example/'},collection={mode:'cookieless' as const,epoch:id};
  assert.deepEqual(eventInput.parse({...base,collection}).collection,collection);
  for(const collection of [null,{}, {mode:'consent-first',epoch:id},{mode:'cookieless',epoch:'bad'},{mode:'cookieless',epoch:id,extra:true}])assert.throws(()=>eventInput.parse({...base,collection}));
  for(const extra of [{consent:{analytics:true as const,epoch:id}},{dimensions:{distinctId:'private-id'}}])await assert.rejects(collectNative(new Request(base.url),id,{...base,collection,...extra}),InputError);
});

test('one current policy authorizes basic events only; identify and privacy remain independent',async()=>{
  const id='00000000-0000-4000-8000-000000000001',epoch=trackingConsentEpoch(id,null),origin='https://site.example';
  const settings={enabled:true,consentMode:'builtin',collectionMode:'cookieless',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:[]};
  const project={id,origin,analytics_settings:settings,analytics_epoch:id,destination_epoch:null};
  const client={async query(){return {rowCount:1,rows:[project]};}} as unknown as PoolClient;
  const request=(extra:Record<string,string>={})=>new Request(origin,{headers:{origin,'user-agent':'Fixture browser',...extra}});
  const basic={url:origin+'/',collection:{mode:'cookieless' as const,epoch}};
  assert.equal((await nativeCollectionPolicy(client,request(),id,basic,'event')).basis,'cookieless');
  assert.equal((await nativeCollectionPolicy(client,request(),id,basic,'identify')).reason,'consent_required');
  for(const operation of ['event','identify'] as const)assert.equal((await nativeCollectionPolicy(client,request(),id,{url:origin+'/',consent:{analytics:true,epoch}},operation)).basis,'consent');
  for(const extra of [{dnt:'1'},{'sec-gpc':'1'},{'user-agent':'Example crawler'}] as Record<string,string>[])assert.equal((await nativeCollectionPolicy(client,request(extra),id,basic,'event')).reason,'collection_disabled');
  for(const collection of [undefined,{mode:'cookieless' as const,epoch:id}])assert.equal((await nativeCollectionPolicy(client,request(),id,{url:origin+'/',collection},'event')).reason,'consent_required');
  project.analytics_settings={...settings,collectionMode:'consent-first'};assert.equal((await nativeCollectionPolicy(client,request(),id,basic,'event')).reason,'consent_required');
  project.analytics_settings={...settings,enabled:false};assert.equal((await nativeCollectionPolicy(client,request(),id,basic,'event')).reason,'collection_disabled');
});

test('an installation-excluded network address disables every browser operation even with a full current grant',async()=>{
  const id='00000000-0000-4000-8000-000000000001',epoch=trackingConsentEpoch(id,null),origin='https://site.example';
  const settings={enabled:true,consentMode:'builtin',collectionMode:'cookieless',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:[]};
  const project={id,origin,analytics_settings:settings,analytics_epoch:id,destination_epoch:null};
  const client={async query(){return {rowCount:1,rows:[project]};}} as unknown as PoolClient;
  const request=()=>new Request(origin,{headers:{origin,'user-agent':'Fixture browser'}});
  const names=['ANALYTICS_NETWORK_MODE','ANALYTICS_EXCLUDED_IPS'] as const,saved=names.map(name=>process.env[name]);
  try{
    process.env.ANALYTICS_NETWORK_MODE='direct';process.env.ANALYTICS_EXCLUDED_IPS='203.0.113.0/24';
    for(const operation of ['event','identify','replay','heatmap'] as const)assert.equal((await nativeCollectionPolicy(client,request(),id,{url:origin+'/',consent:{analytics:true,epoch,replay:true}},operation,'203.0.113.9')).reason,'collection_disabled',operation);
    const basic={url:origin+'/',collection:{mode:'cookieless' as const,epoch}};
    assert.equal((await nativeCollectionPolicy(client,request(),id,basic,'event','203.0.113.9')).reason,'collection_disabled');
    for(const peer of ['198.51.100.7',undefined])assert.equal((await nativeCollectionPolicy(client,request(),id,basic,'event',peer)).basis,'cookieless',String(peer));
  }finally{names.forEach((name,index)=>{if(saved[index]===undefined)delete process.env[name];else process.env[name]=saved[index];});}
});
