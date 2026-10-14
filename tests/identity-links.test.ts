import test from 'node:test';
import assert from 'node:assert/strict';
import {explicitIdentityReference} from '../src/server/identity-links.ts';
import {analyticsIdentity,publicAnalyticsSettings} from '../src/server/native-analytics.ts';

const project='11111111-1111-4111-8111-111111111111',secret='synthetic-identity-secret'.repeat(3);
test('explicit references join exact caller assertions across device/month keys while isolating project and secret generation',()=>{
  const reference=explicitIdentityReference(project,'Customer 42',secret);
  assert.equal(reference.identityVersion,1);assert.match(reference.keyGeneration,/^[a-f0-9]{64}$/);assert.match(reference.identityToken,/^[a-f0-9]{64}$/);
  assert.notEqual(reference.identityToken,reference.keyGeneration);
  const base={projectId:project,ip:'192.0.2.1',userAgent:'Browser A',distinctId:'Customer 42',secret};
  const first=analyticsIdentity({...base,now:new Date('2026-10-01T00:00:00Z')})!;
  const next=analyticsIdentity({...base,ip:'192.0.2.2',userAgent:'Browser B',now:new Date('2026-11-01T00:00:00Z'),context:first.context})!;
  assert.notEqual(first.visitor,next.visitor);assert.deepEqual(explicitIdentityReference(project,base.distinctId,secret),reference);
  const another=explicitIdentityReference('22222222-2222-4222-8222-222222222222',base.distinctId,secret);
  assert.notEqual(another.identityToken,reference.identityToken);assert.notEqual(another.keyGeneration,reference.keyGeneration);
  const rotated=explicitIdentityReference(project,base.distinctId,secret+'rotation');assert.notEqual(rotated.identityToken,reference.identityToken);assert.notEqual(rotated.keyGeneration,reference.keyGeneration);
});
test('exact identity input preserves case, spaces and Unicode; invalid native IDs cannot produce references',()=>{
  const values=['Customer 42','customer 42',' Customer 42','Customer 42 ','é','e\u0301'];
  assert.equal(new Set(values.map(value=>explicitIdentityReference(project,value,secret).identityToken)).size,values.length);
  for(const value of ['', 'x'.repeat(257),'bad\0id','bad\nid','\ud800'])assert.throws(()=>explicitIdentityReference(project,value,secret));
  assert.match(explicitIdentityReference(project,'😀'.repeat(128),secret).identityToken,/^[a-f0-9]{64}$/);
});
test('anonymous, switched-ID and reset contexts never select an identified assignment key',()=>{
  const base={projectId:project,ip:'192.0.2.1',userAgent:'Browser',secret,now:new Date('2026-10-01T00:00:00Z')};
  const anonymous=analyticsIdentity(base)!,a=analyticsIdentity({...base,distinctId:'A',context:anonymous.context})!;
  const b=analyticsIdentity({...base,distinctId:'B',context:a.context})!,reset=analyticsIdentity({...base,context:a.context})!;
  assert.notEqual(anonymous.visitor,a.visitor);assert.notEqual(a.visitor,b.visitor);assert.equal(reset.visitor,anonymous.visitor);
  assert.equal(analyticsIdentity({...base,ip:null,distinctId:'A',context:a.context}),null);
});
test('identity linking stays optional off and legacy settings normalize consent-first without mutating input',()=>{
  const legacy={enabled:true,consentMode:'builtin',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:[]};
  const original=JSON.stringify(legacy),{collectionMode,...unchanged}=publicAnalyticsSettings(legacy);
  assert.equal(collectionMode,'consent-first');assert.equal(JSON.stringify(unchanged),original);assert.equal(JSON.stringify(legacy),original);
  assert.equal(Object.hasOwn(publicAnalyticsSettings(legacy),'linkIdentities'),false);
  assert.equal(publicAnalyticsSettings({...legacy,linkIdentities:true}).linkIdentities,true);assert.equal(publicAnalyticsSettings({...legacy,linkIdentities:false}).linkIdentities,false);
  for(const value of ['true',null,0,{}])assert.throws(()=>publicAnalyticsSettings({...legacy,linkIdentities:value}));
  assert.throws(()=>publicAnalyticsSettings({...legacy,linkIdentity:true}));
});
