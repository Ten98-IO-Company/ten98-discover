import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import https from 'node:https';
import http from 'node:http';
import {addressKey,publicNetworkAddress} from '../src/server/public-network.ts';
import {permittedOidcAddress} from '../src/server/oidc.ts';
import {observeDomainRedirect,redirectUrl,requestRedirectHeaders,type RedirectTransport} from '../src/server/domain-redirect-network.ts';

const publicAddress={address:'1.1.1.1',family:4 as const};
const resolve:RedirectTransport['resolve']=async()=>[publicAddress];
test('strict public network addresses exclude special ranges and mapped/zone forms without changing OIDC explicit approval',()=>{
  for(const address of ['0.0.0.0','10.1.2.3','127.0.0.1','100.64.0.1','169.254.169.254','172.16.0.1','192.0.0.9','192.0.2.1','192.88.99.2','192.168.1.1','198.19.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::','::1','::ffff:1.1.1.1','64:ff9b::101:101','2001:1::1','2001:2::1','2001:20::1','2001:db8::1','2002:101:101::1','2620:4f:8000::1','3fff::1','5f00::1','fc00::1','fe80::1','ff02::1','fe80::1%eth0','not-address','0127.0.0.1'])assert.equal(publicNetworkAddress(address),false,address);
  for(const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(publicNetworkAddress(address),true,address);
  assert.equal(addressKey('fe80::1%eth0'),'');assert.equal(permittedOidcAddress('127.0.0.1',['127.0.0.1']),true);assert.equal(permittedOidcAddress('3fff::1',[]),false);
});
test('redirect URL boundary rejects credentials, shorthand, alternate ports, reserved hosts and parser ambiguity',()=>{
  for(const raw of ['file:///etc/passwd','ftp://example.com','https://user:secret@example.com','https://example.com:444/','http://example.com:443/','https://127.1/','https://2130706433/','https://0x7f000001/','https://0177.0.0.1/','http://[::ffff:1.1.1.1]/','https://%65xample.com/','https:example.com','https:\\example.com','https://example.com/\nprivate','https://example.com/'+ 'x'.repeat(2048),'https://localhost/','https://a.internal/','http://[fe80::1%25eth0]/'])assert.throws(()=>redirectUrl(raw),raw);
  assert.equal(redirectUrl('https://EXAMPLE.com:443/path?q=secret#fragment').href,'https://example.com/path?q=secret');
  assert.equal(redirectUrl('http://example.com:80/').origin,'http://example.com');
  assert.equal(redirectUrl('https://bücher.de/').hostname,'xn--bcher-kva.de');
  assert.equal(redirectUrl('/path?token=secret#fragment',new URL('https://example.com/')).href,'https://example.com/path?token=secret');
});
test('all DNS answers are vetted before any connection; each hop resolves again and rebinding fails closed',async()=>{
  let requests=0;
  const request:RedirectTransport['request']=async()=>{requests++;return {status:302,location:'/next'};};
  for(const answers of [[publicAddress,{address:'127.0.0.1',family:4 as const}],[{address:'::ffff:1.1.1.1',family:6 as const}],[],[{address:'1.1.1.1',family:6 as const}]]){
    assert.equal((await observeDomainRedirect('alias.example.com','target.example.com',{resolve:async()=>answers,request})).outcome,'blocked');
  }
  assert.equal(requests,0);
  let lookups=0;
  const result=await observeDomainRedirect('alias.example.com','target.example.com',{resolve:async()=>++lookups===1?[publicAddress]:[{address:'10.0.0.1',family:4}],request});
  assert.equal(result.outcome,'blocked');assert.equal(lookups,2);assert.equal(requests,1);
  const blocked=await observeDomainRedirect('alias.example.com','target.example.com',{resolve,request:async()=>({status:302,location:'http://169.254.169.254/latest?secret=value'})});
  assert.equal(blocked.outcome,'blocked');assert.equal(blocked.hops.length,1);assert.equal(blocked.hops[0].location,null);
});
test('redirect observations strip queries/fragments while following transient paths and distinguish target mismatch/status',async()=>{
  const requested:string[]=[];
  const result=await observeDomainRedirect('alias.example.com','target.example.com',{resolve,request:async(url,address)=>{
    assert.deepEqual(address,publicAddress);requested.push(url.href);
    return requested.length===1?{status:301,location:'https://target.example.com/final?token=secret#private'}:{status:404,location:null};
  }});
  assert.equal(result.outcome,'response');assert.equal(result.targetMatches,true);assert.equal(result.finalUrl,'https://target.example.com/final');assert.equal(result.hops[1].status,404);
  assert.equal(requested[1],'https://target.example.com/final?token=secret');assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('private'));
  const mismatch=await observeDomainRedirect('alias.example.com','target.example.com',{resolve,request:async()=>({status:200,location:null})});assert.equal(mismatch.targetMatches,false);
});

test('253-byte redirect hops and targets remain valid while every DNS answer is still vetted',async()=>{
  const middle=['a'.repeat(63),'b'.repeat(63),'c'.repeat(63),'d'.repeat(57),'com'].join('.');
  const target='z'+middle.slice(1),lookups:string[]=[],requests:string[]=[];
  assert.equal(middle.length,253);assert.equal(redirectUrl(`https://${middle}/step`).hostname,middle);
  for(const invalid of ['x'+middle,'a'.repeat(64)+'.com'])assert.throws(()=>redirectUrl(`https://${invalid}/`));
  const result=await observeDomainRedirect('alias.example.com',target,{
    resolve:async host=>{lookups.push(host);return [publicAddress];},
    request:async(url,address)=>{
      assert.deepEqual(address,publicAddress);requests.push(url.href);
      return requests.length===1?{status:301,location:`https://${middle}/step?transient=1#fragment`}
        :requests.length===2?{status:302,location:`https://${target}/final`}:{status:200,location:null};
    },
  });
  assert.equal(result.outcome,'response');assert.equal(result.targetMatches,true);assert.equal(result.finalUrl,`https://${target}/final`);
  assert.deepEqual(lookups,['alias.example.com',middle,target]);assert.equal(requests.length,3);
  assert.equal(result.hops[1].url,`https://${middle}/step`);assert.ok(!JSON.stringify(result).includes('transient'));
  let connected=0;
  const blocked=await observeDomainRedirect('alias.example.com',target,{
    resolve:async host=>host===middle?[publicAddress,{address:'127.0.0.1',family:4}]:[publicAddress],
    request:async()=>{connected++;return {status:302,location:`https://${middle}/`};},
  });
  assert.equal(blocked.outcome,'blocked');assert.equal(blocked.hops.length,1);assert.equal(connected,1);
});
test('loop and eight redirect boundary never make an extra request or execute a body/meta refresh',async()=>{
  const loop=await observeDomainRedirect('alias.example.com','target.example.com',{resolve,request:async()=>({status:302,location:'#ignored'})});assert.equal(loop.outcome,'loop');assert.equal(loop.hops.length,1);
  let requests=0;
  const maximum=await observeDomainRedirect('alias.example.com','target.example.com',{resolve,request:async()=>({status:302,location:'/hop'+(++requests)})});
  assert.equal(maximum.outcome,'hop_limit');assert.equal(requests,9);assert.equal(maximum.hops.length,9);
  requests=0;
  const allowed=await observeDomainRedirect('alias.example.com','target.example.com',{resolve,request:async()=>++requests===9?{status:200,location:null}:{status:302,location:'/hop'+requests}});assert.equal(allowed.outcome,'response');assert.equal(requests,9);
  const unavailable=await observeDomainRedirect('alias.example.com','target.example.com',{resolve,request:async()=>({status:302,location:null})});assert.equal(unavailable.outcome,'unavailable');assert.equal(unavailable.targetMatches,null);
});
test('transport failures and timeouts expose fixed outcomes without private URL/error text',async()=>{
  for(const error of [new Error('secret query and credentials'),new DOMException('private','TimeoutError')]){
    const result=await observeDomainRedirect('alias.example.com','target.example.com',{resolve,request:async()=>{throw error;}});assert.equal(result.outcome,error.name==='TimeoutError'?'timeout':'unavailable');assert.equal(result.targetMatches,null);assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('secret'));
  }
});
test('native HTTP(S) request pins host/TLS/lookup and rejects duplicate Location without reading response bodies',async()=>{
  for(const scheme of ['https:','http:']){
    const client=scheme==='https:'?https:http;
    let calls=0,destroyed=0,options:any;
    const intercept=mock.method(client,'request',((url:URL,value:any,callback:(response:any)=>void)=>{
      calls++;options=value;assert.equal(url.hostname,'alias.example.com');assert.equal(value.family,4);assert.equal(value.method,'GET');assert.equal(value.maxHeaderSize,16384);assert.equal(value.insecureHTTPParser,false);assert.deepEqual(value.headers,{accept:'*/*','user-agent':'ten98-monitor/redirect-check',connection:'close'});
      assert.deepEqual(value.agent.options.proxyEnv,{});assert.ok(value.signal);assert.equal(value.agent.keepAlive,false);
      if(scheme==='https:'){assert.equal(value.servername,'alias.example.com');assert.equal(value.rejectUnauthorized,true);}
      value.lookup('alias.example.com',{all:true},(err:any,addresses:any)=>{assert.equal(err,null);assert.deepEqual(addresses,[publicAddress]);});
      const request=new EventEmitter() as EventEmitter&{end:()=>void};
      request.end=()=>queueMicrotask(()=>callback({statusCode:302,rawHeaders:calls===1?['Location','https://target.example.com/']:['Location','https://target.example.com/','location','https://other.example.com/'],destroy:()=>{destroyed++;},on:()=>{throw new Error('Body must not be consumed');}}));
      return request;
    }) as typeof client.request);
    try{
      const signal=new AbortController().signal,url=new URL(`${scheme}//alias.example.com/`);
      assert.deepEqual(await requestRedirectHeaders(url,publicAddress,signal),{status:302,location:'https://target.example.com/'});
      await assert.rejects(requestRedirectHeaders(url,publicAddress,signal));assert.equal(destroyed,2);
      await assert.rejects(requestRedirectHeaders(url,{address:'127.0.0.1',family:4},signal));assert.equal(calls,2);
      assert.ok(!('authorization' in options.headers));assert.ok(!('cookie' in options.headers));
    }finally{intercept.mock.restore();}
  }
});
test('real native agents ignore inherited proxies and abort a stalled header request before any external connection',async()=>{
  const child=spawn(process.execPath,['--use-env-proxy',fileURLToPath(new URL('./domain-redirect-proxy-fixture.ts',import.meta.url))],{
    env:{SystemRoot:process.env.SystemRoot,TEN98_PROXY_FIXTURE:'1',NODE_USE_ENV_PROXY:'1',HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1'},stdio:['ignore','pipe','pipe'],windowsHide:true,
  });
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  const timer=setTimeout(()=>child.kill(),10000);
  try{const code=await new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});assert.equal(code,0,stderr);assert.match(stdout,/PASS contained native/);}
  finally{clearTimeout(timer);}
});
