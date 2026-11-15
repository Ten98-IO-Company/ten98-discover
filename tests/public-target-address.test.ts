import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publicTargetAddress} from '../src/server/public-target-address.ts';
import {observeDomainRedirect,redirectUrl,requestRedirectHeaders} from '../src/server/domain-redirect-network.ts';
import {permittedOidcAddress} from '../src/server/oidc.ts';

const refused=(addresses:string[])=>{for(const address of addresses)assert.equal(publicTargetAddress(address),false,address);};
const admitted=(addresses:string[])=>{for(const address of addresses)assert.equal(publicTargetAddress(address),true,address);};
// Last address of the range whose leading hextets are given, e.g. last('2001:db8') is 2001:db8:ffff:…:ffff.
const last=(prefix:string)=>prefix+':ffff'.repeat(8-prefix.split(':').length);

test('ordinary public addresses stay admitted in every spelling',()=>{
  admitted(['1.1.1.1','8.8.8.8','2606:4700:4700::1111','2606:4700:4700:0:0:0:0:1111','2001:4860:4860::8888','2A00:1450::1']);
});

test('the Azure platform host is refused while its neighbours remain public',()=>{
  refused(['168.63.129.16','::ffff:168.63.129.16','::ffff:a83f:8110']);
  admitted(['168.63.129.15','168.63.129.17']);
});

test('only 2000::/3 counts as global unicast, bitwise rather than by its first character',()=>{
  admitted(['2000::',last('3fff')]);
  refused([last('1fff'),'4000::','5f00::1','fc00::1','fe80::1','ff02::1','::','::1']);
  // The previous first-character test admitted these 0000::/8 and 0200::/7 forms.
  refused(['2::1','20::1','2f::1','3ff::1','3ff:ffff::1','200::1']);
});

test('reserved ranges inside 2000::/3 are refused at both edges and admitted just outside',()=>{
  // 2001::/23 IETF protocol assignments: no exception is admitted (PCP/TURN anycast, AMT, AS112 and ORCHIDv2 included).
  refused(['2001::','2001:1::1','2001:3::1','2001:4:112::1','2001:20::1',last('2001:1ff')]);
  admitted([last('2000'),'2001:200::']);
  refused(['2001:db8::','2001:DB8:0000::1',last('2001:db8')]);
  admitted([last('2001:db7'),'2001:db9::']);
  refused(['2002::',last('2002')]);
  admitted([last('2001'),'2003::']);
  refused(['3fff::',last('3fff:fff')]);
  admitted([last('3ffe'),'3fff:1000::']);
  refused(['2620:4f:8000::',last('2620:4f:8000')]);
  admitted([last('2620:4f:7fff'),'2620:4f:8001::']);
});

test('6to4 is refused whatever IPv4 address it embeds',()=>{
  refused(['2002:a00:1::1','2002:7f00:1::','2002:a9fe:a9fe::1','2002:c0a8:101::1','2002:a83f:8110::1','2002:808:808::1']);
});

test('IPv4-mapped, IPv4-compatible and NAT64 forms are refused, private or public embedded address alike',()=>{
  refused(['::ffff:0.0.0.0','::ffff:127.0.0.1','::ffff:10.0.0.1','::ffff:169.254.169.254','::ffff:8.8.8.8','::ffff:255.255.255.255',
    '::ffff:7f00:1','0:0:0:0:0:ffff:808:808','::FFFF:1.1.1.1','::ffff:0:808:808']);
  refused(['::0.0.0.1','::127.0.0.1','::10.0.0.1','::8.8.8.8','::808:808','::255.255.255.255']);
  refused(['64:ff9b::','64:ff9b::a00:1','64:ff9b::808:808','64:ff9b::ffff:ffff','64:ff9b:1::',last('64:ff9b:1'),last('64:ff9a'),'64:ff9c::']);
});

test('crawl, redirect and OIDC admission all use the stricter test',async()=>{
  for(const raw of ['https://168.63.129.16/','http://[2::1]/','https://[2002:a00:1::1]/'])assert.throws(()=>redirectUrl(raw),raw);
  let requests=0;
  const request=async()=>{requests++;return {status:200,location:null};};
  for(const answers of [[{address:'168.63.129.16',family:4 as const}],[{address:'2::1',family:6 as const}]])
    assert.equal((await observeDomainRedirect('alias.example.com','target.example.com',{resolve:async()=>answers,request})).outcome,'blocked');
  assert.equal(requests,0);
  await assert.rejects(requestRedirectHeaders(new URL('https://example.com/'),{address:'168.63.129.16',family:4},AbortSignal.timeout(1000)));
  assert.equal(permittedOidcAddress('168.63.129.16',[]),false);assert.equal(permittedOidcAddress('20::1',[]),false);
  assert.equal(permittedOidcAddress('1.1.1.1',[]),true);
});
