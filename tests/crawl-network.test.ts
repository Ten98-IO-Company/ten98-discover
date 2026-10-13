import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {EventEmitter,getEventListeners} from 'node:events';
import {Resolver} from 'node:dns/promises';
import {Readable} from 'node:stream';
import {gzipSync} from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fetchCrawlDocument,type CrawlDocumentKind} from '../src/server/crawl-network.ts';

type Fixture={body?:Buffer;headers?:string[];status?:number;complete?:boolean;peer?:string;v4?:string[];v6?:string[];dnsError?:boolean;stall?:'dns'|'headers'|'body';onRequest?:(options:any)=>void;onBody?:()=>void};
async function fixture<T>(spec:Fixture,run:(state:{requests:number;reads:number;response:Readable|null;requestDestroyed:boolean})=>Promise<T>):Promise<T> {
  const state={requests:0,reads:0,response:null as Readable|null,requestDestroyed:false};
  let rejectDns:((error:Error)=>void)|undefined;
  const mocks=[
    mock.method(Resolver.prototype,'resolve4',async()=>{
      if(spec.stall==='dns')return new Promise<string[]>((_resolve,reject)=>{rejectDns=reject;});
      if(spec.dnsError)throw new Error('private DNS diagnostic');return spec.v4??['1.1.1.1'];
    }),
    mock.method(Resolver.prototype,'resolve6',async()=>spec.v6??[]),
    mock.method(Resolver.prototype,'cancel',()=>{rejectDns?.(new Error('Cancelled synthetic DNS'));}),
  ];
  const request=((url:URL,options:any,callback:(response:any)=>void)=>{
    state.requests++;spec.onRequest?.(options);
    const req=new EventEmitter() as any;
    req.destroy=()=>{state.requestDestroyed=true;};
    req.end=()=>queueMicrotask(()=>{
      if(state.requestDestroyed)return;
      const socket=new EventEmitter() as any;socket.remoteAddress=spec.peer??'1.1.1.1';
      req.emit('socket',socket);socket.emit(url.protocol==='https:'?'secureConnect':'connect');
      if(state.requestDestroyed||spec.stall==='headers')return;
      let supplied=false;
      const response=new Readable({read(){
        state.reads++;if(supplied)return;supplied=true;
        if(spec.body)this.push(spec.body);spec.onBody?.();
        if(spec.stall!=='body')this.push(null);
      }}) as Readable&{statusCode:number;rawHeaders:string[];complete:boolean};
      response.statusCode=spec.status??200;response.rawHeaders=spec.headers??['Content-Type','text/html'];response.complete=spec.complete??true;
      state.response=response;callback(response);
    });return req;
  }) as typeof http.request;
  const h=mock.method(http,'request',request),s=mock.method(https,'request',request as typeof https.request);
  try{return await run(state);}finally{h.mock.restore();s.mock.restore();for(const item of mocks)item.mock.restore();state.response?.destroy();}
}
const fetch=(kind:CrawlDocumentKind='html',signal?:AbortSignal)=>fetchCrawlDocument('https://crawl.example.com/path?transient=value#fragment',kind,signal);
const invalid=(value:Awaited<ReturnType<typeof fetch>>,reason:string)=>{assert.equal(value.complete,false);assert.equal(value.body,null);assert.equal(value.reason,reason);};

test('single request pins all connection settings and returns complete bounded HTML bytes',async()=>{
  for(const scheme of ['http','https'])await fixture({body:Buffer.from('<h1>Observed</h1>'),headers:['Content-Type','text/html; charset=utf-8','Link','</a>; rel="canonical"','Link','</preload>; rel="preload"','X-Robots-Tag','noindex','Set-Cookie','private=secret'],onRequest(options){
    assert.equal(options.method,'GET');assert.equal(options.maxHeaderSize,16384);assert.equal(options.insecureHTTPParser,false);assert.equal(options.family,4);assert.deepEqual(options.agent.options.proxyEnv,{});assert.equal(options.agent.keepAlive,false);
    assert.deepEqual(options.headers,{accept:'text/html,application/xhtml+xml','accept-encoding':'gzip, identity','user-agent':'TenMonitorBot/1.0',connection:'close'});
    if(scheme==='https'){assert.equal(options.servername,'crawl.example.com');assert.equal(options.rejectUnauthorized,true);}
    options.lookup('crawl.example.com',{all:false},(e:any,a:any,f:any)=>{assert.equal(e,null);assert.equal(a,'1.1.1.1');assert.equal(f,4);});
    options.lookup('crawl.example.com',{all:true},(e:any,a:any)=>{assert.equal(e,null);assert.deepEqual(a,[{address:'1.1.1.1',family:4}]);});
    options.lookup('elsewhere.example.com',{all:false},(e:any)=>assert.ok(e));
  }},async state=>{
    const result=await fetchCrawlDocument(`${scheme}://crawl.example.com/path?transient=value#fragment`,'html');
    assert.equal(result.complete,true);assert.equal(result.body?.toString(),'<h1>Observed</h1>');assert.equal(result.reason,null);assert.equal(result.status,200);
    assert.equal(result.wireBytes,17);assert.equal(result.httpDecodedBytes,17);assert.equal(result.decodedBytes,17);assert.equal(result.headers.link.length,2);assert.deepEqual(result.headers.xRobotsTag,['noindex']);
    assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('transient'));assert.equal(state.requests,1);assert.equal(state.requestDestroyed,true);assert.ok(result.durationMs>=0);assert.ok(result.dnsMs!==null&&result.headersMs!==null);
  });
});

test('URL and all-answer DNS boundaries block mixed/private/special addresses before any request',async()=>{
  await fixture({},async state=>{
    for(const raw of ['https://127.0.0.1/','https://user:pass@example.com/','https://example.com:8443/','http://169.254.169.254/','https://127.1/','file:///private','https://example.com/'+ 'a'.repeat(2048)])invalid(await fetchCrawlDocument(raw,'html'),'blocked');
    invalid(await fetchCrawlDocument('https://example.com/','other' as CrawlDocumentKind),'blocked');assert.equal(state.requests,0);
  });
  for(const spec of [{v4:['1.1.1.1','10.0.0.1']},{v4:[],v6:[]},{v4:Array(33).fill('1.1.1.1')},{v4:['1.1.1.1'],v6:['::ffff:1.1.1.1']},{v4:['1.1.1.1'],v6:['2001:db8::1']},{v4:['invalid']}])await fixture(spec,async state=>{invalid(await fetch(),'blocked');assert.equal(state.requests,0);});
  await fixture({dnsError:true},async state=>{const result=await fetch();invalid(result,'dns_error');assert.ok(!JSON.stringify(result).includes('private'));assert.equal(state.requests,0);});
  await fixture({peer:'8.8.8.8'},async state=>{invalid(await fetch(),'peer_mismatch');assert.equal(state.reads,0);assert.equal(state.requestDestroyed,true);});
  await fixture({peer:'::ffff:1.1.1.1',body:Buffer.from('ok')},async()=>assert.equal((await fetch()).complete,true));
});

test('redirects, Retry-After, bodyless/error/partial responses and unsupported MIME keep headers without reading bodies',async()=>{
  for(const [status,reason] of [[301,'redirect'],[302,'redirect'],[307,'redirect'],[304,'bodyless'],[429,'http_status'],[500,'http_status'],[204,'bodyless'],[205,'bodyless'],[206,'partial_response']] as const)await fixture({status,headers:['Content-Type','text/html','Location','http://169.254.169.254/private?secret=value','Retry-After','120'],body:Buffer.alloc(2*1024*1024)},async state=>{
    const result=await fetch();invalid(result,reason);assert.equal(result.status,status);assert.equal(result.headers.retryAfter,'120');assert.equal(result.headers.location,'http://169.254.169.254/private?secret=value');assert.equal(state.requests,1);assert.equal(state.reads,0);assert.equal(result.wireBytes,0);
  });
  for(const mime of [null,'application/pdf','image/png'])await fixture({headers:mime?['Content-Type',mime]:[],body:Buffer.from('arbitrary')},async state=>{invalid(await fetch(),'unsupported_mime');assert.equal(state.reads,0);});
  await fixture({headers:['Content-Type','application/xhtml+xml'],body:Buffer.from('<html/>')},async()=>assert.equal((await fetch()).complete,true));
});

test('ambiguous/oversized headers and unsupported encodings fail closed without downloading',async()=>{
  for(const headers of [
    ['Content-Type','text/html','content-type','text/html'],['Content-Type','text/html','Content-Encoding','gzip','Content-Encoding','gzip'],
    ['Location','/a','location','/b'],['Retry-After','1','retry-after','2'],['Cf-Mitigated','challenge','cf-mitigated','challenge'],['Link','a'.repeat(16384)],['Location','a'.repeat(2049)],
    ['Content-Type','text/html','Content-Length','1','Content-Length','1'],['Content-Type','text/html','Content-Length','1','Transfer-Encoding','chunked'],
    ['Content-Type','text/html','X-Ignore','bad\nvalue'],['Content-Type','text/html','Transfer-Encoding','chunked','Transfer-Encoding','chunked'],
  ])await fixture({headers},async state=>{invalid(await fetch(),'invalid_response');assert.equal(state.reads,0);});
  for(const transfer of ['gzip, chunked','deflate','identity'])await fixture({headers:['Content-Type','text/html','Transfer-Encoding',transfer]},async state=>{invalid(await fetch(),'unsupported_encoding');assert.equal(state.reads,0);});
  for(const encoding of ['br','deflate','gzip, gzip',''])await fixture({headers:['Content-Type','text/html','Content-Encoding',encoding]},async state=>{invalid(await fetch(),'unsupported_encoding');assert.equal(state.reads,0);});
});

test('challenge response header is an exact bounded observation, independent of HTTP status',async()=>{
  for(const status of [200,403,429])for(const value of ['challenge',' challenge ','Challenge','other']){
    await fixture({status,headers:['Content-Type','text/html','Cf-Mitigated',value],body:Buffer.from('<title>Page</title>')},async()=>{
      const result=await fetch();assert.equal(result.status,status);assert.equal(result.headers.challenge,value.trim()==='challenge');
      if(status!==200){assert.equal(result.complete,false);assert.equal(result.body,null);}
      assert.ok(!JSON.stringify(result.headers).includes('Cf-Mitigated'));
    });
  }
});

test('wire and each expanded capacity use actual bytes and never expose a partial document',async()=>{
  for(const [kind,limit] of [['html',1024*1024],['robots',512*1024],['sitemap',5*1024*1024]] as const){
    await fixture({body:Buffer.alloc(limit,32)},async()=>{const result=await fetch(kind);assert.equal(result.complete,true);assert.equal(result.body?.length,limit);});
    await fixture({body:Buffer.alloc(limit+1,32),headers:['Content-Type','text/html','Content-Length','1']},async state=>{const result=await fetch(kind);invalid(result,'wire_limit');assert.equal(result.wireBytes,limit+1);assert.ok(state.response?.destroyed);});
    await fixture({body:gzipSync(Buffer.alloc(limit+1,32)),headers:['Content-Type','text/html','Content-Encoding','gzip']},async state=>{const result=await fetch(kind);invalid(result,'expanded_limit');assert.ok(result.wireBytes<limit);assert.ok(result.httpDecodedBytes>limit);assert.ok(state.response?.destroyed);});
  }
  const oversized=gzipSync(Buffer.alloc(5*1024*1024+1,32));
  await fixture({body:oversized},async()=>{const result=await fetch('sitemap');invalid(result,'expanded_limit');assert.equal(result.httpDecodedBytes,oversized.length);assert.ok(result.decodedBytes>5*1024*1024);});
  for(const complete of [false,true])await fixture({body:Buffer.from('short'),complete,headers:['Content-Type','text/html','Content-Length','10']},async()=>invalid(await fetch(),'incomplete_body'));
});

test('gzip requires complete streams; sitemap file decoding follows magic bytes rather than suffix',async()=>{
  const xml=Buffer.from('<urlset/>'),compressed=gzipSync(xml);
  for(const [bytes,encoding,url] of [[compressed,'gzip','https://crawl.example.com/sitemap.xml.gz'],[compressed,'identity','https://crawl.example.com/sitemap.xml'],[gzipSync(compressed),'gzip','https://crawl.example.com/sitemap.xml.gz'],[xml,'identity','https://crawl.example.com/not-really.gz']] as const)await fixture({body:bytes,headers:['Content-Encoding',encoding]},async()=>{const result=await fetchCrawlDocument(url,'sitemap');assert.equal(result.complete,true);assert.deepEqual(result.body,xml);assert.equal(result.decodedBytes,xml.length);});
  const concatenated=Buffer.concat([gzipSync('<urlset>'),gzipSync('</urlset>')]);
  await fixture({body:concatenated,headers:['Content-Type','text/html','Content-Encoding','gzip']},async()=>assert.equal((await fetch()).body?.toString(),'<urlset></urlset>'));
  for(const body of [compressed.subarray(0,-1),Buffer.concat([compressed,Buffer.from('junk')]),Buffer.concat([compressed,Buffer.alloc(4)]),Buffer.from('not gzip')])await fixture({body,headers:['Content-Type','text/html','Content-Encoding','gzip']},async()=>invalid(await fetch(),'invalid_compression'));
  const badCrc=Buffer.from(compressed);badCrc[badCrc.length-8]^=1;
  await fixture({body:badCrc},async()=>invalid(await fetch('sitemap'),'invalid_compression'));
  await fixture({body:compressed},async()=>invalid(await fetch(),'unsupported_encoding'));
  await fixture({body:gzipSync(compressed)},async()=>invalid(await fetch('sitemap'),'unsupported_encoding'));
  await fixture({body:gzipSync(gzipSync(compressed)),headers:['Content-Encoding','gzip']},async()=>invalid(await fetch('sitemap'),'unsupported_encoding'));
});

test('abort at DNS, headers, and body cancels owned work and removes caller listeners; deadline is total',async()=>{
  for(const stall of ['dns','headers','body'] as const){
    const controller=new AbortController();let resultPromise:ReturnType<typeof fetch>|undefined;
    await fixture({stall,complete:false,body:Buffer.from('partial')},async state=>{
      resultPromise=fetch('html',controller.signal);await new Promise(resolve=>setImmediate(resolve));controller.abort();
      invalid(await resultPromise,'aborted');assert.equal(getEventListeners(controller.signal,'abort').length,0);if(stall!=='dns')assert.equal(state.requestDestroyed,true);assert.ok(!state.response||state.response.destroyed);
    });
  }
  for(const kind of ['html','sitemap'] as const){
    const controller=new AbortController();
    await fixture({body:gzipSync(Buffer.alloc(kind==='html'?1024*1024:5*1024*1024,32)),headers:kind==='html'?['Content-Type','text/html','Content-Encoding','gzip']:[],onBody(){setImmediate(()=>controller.abort());}},async state=>{
      invalid(await fetch(kind,controller.signal),'aborted');assert.equal(getEventListeners(controller.signal,'abort').length,0);assert.ok(state.response?.destroyed);
    });
  }
  const controller=new AbortController();controller.abort();await fixture({},async state=>{invalid(await fetch('html',controller.signal),'aborted');assert.equal(state.requests,0);assert.equal(getEventListeners(controller.signal,'abort').length,0);});
  for(const stall of ['dns','headers','body'] as const){
    mock.timers.enable({apis:['setTimeout']});
    try{await fixture({stall,complete:false},async()=>{const pending=fetch();await new Promise(resolve=>setImmediate(resolve));mock.timers.tick(15000);invalid(await pending,'timeout');});}
    finally{mock.timers.reset();}
  }
});

test('native contained HTTP verifies framing, proxy isolation, exact peers, header limits and cancellation',async()=>{
  const child=spawn(process.execPath,['--use-env-proxy',fileURLToPath(new URL('./crawl-network-fixture.ts',import.meta.url))],{env:{SystemRoot:process.env.SystemRoot,TEN98_CRAWL_FIXTURE:'1',NODE_USE_ENV_PROXY:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  const timer=setTimeout(()=>child.kill(),10000);
  try{const code=await new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});assert.equal(code,0,stderr);assert.match(stdout,/PASS contained native/);}
  finally{clearTimeout(timer);}
});

test('fragmented one-byte HTTP chunks stay within a bounded child heap',async()=>{
  const child=spawn(process.execPath,['--max-old-space-size=192',fileURLToPath(new URL('./crawl-network-fixture.ts',import.meta.url)),'fragmented'],{env:{SystemRoot:process.env.SystemRoot,TEN98_CRAWL_FIXTURE:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderrBytes=0;child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>16384)child.kill();});child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>16384)child.kill();});
  const timer=setTimeout(()=>child.kill(),20000);
  try{const code=await new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});assert.equal(code,0);assert.equal(stderrBytes,0);assert.match(stdout,/PASS contained fragmented/);}
  finally{clearTimeout(timer);}
});
