import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {resolve} from 'node:path';
import {parseSitemap} from '../src/server/crawl-sitemap.ts';
import {parseCrawlSitemapIsolated,crawlSitemapCapacityBytes,type CrawlSitemapInput} from '../src/server/crawl-sitemap-isolated.ts';

const begin='<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',end='</urlset>';
const input:CrawlSitemapInput={documentUrl:'https://example.test/sitemap.xml',body:Buffer.from(begin+'<url><loc>https://example.test/a?x=1&amp;y=2</loc></url>'+end)};
const pure=(value:CrawlSitemapInput)=>parseSitemap({documentUrl:value.documentUrl,chunks:[value.body]});

test('real sitemap child preserves complete and partial evidence without granting scope',async()=>{
  for(const value of [input,{...input,body:Buffer.from(begin+'<url/><url><loc>http://127.0.0.1/private</loc></url>'+end)}]){
    assert.deepEqual(await parseCrawlSitemapIsolated(value),{status:'ok',analysis:pure(value)});
  }
});

test('malformed tail, UTF8 and DTD discard all earlier sitemap observations',async()=>{
  for(const body of [Buffer.concat([input.body,Buffer.from('<broken>')]),Buffer.from([0xc3,0x28]),Buffer.from('<!DOCTYPE urlset SYSTEM "file:///private">'+begin+end)]){
    const result=await parseCrawlSitemapIsolated({...input,body});assert.equal(result.status,'ok');if(result.status!=='ok')continue;
    assert.equal(result.analysis.status,'unavailable');assert.deepEqual(result.analysis.entries,[]);assert.equal(result.analysis.counts.seen,0);
  }
});

test('exact 5MiB live capacity fits the fixed protocol; oversize and unsupported inputs never spawn',async()=>{
  const opening=begin+'<!--',closing='-->'+end;
  const body=Buffer.from(opening+'x'.repeat(crawlSitemapCapacityBytes-Buffer.byteLength(opening+closing))+closing);
  const result=await parseCrawlSitemapIsolated({...input,body});assert.equal(result.status,'ok');
  if(result.status==='ok'){assert.equal(result.analysis.status,'complete');assert.equal(result.analysis.bytesRead,crawlSitemapCapacityBytes);}
  let serialized=false;const spy=mock.method(childProcess,'spawn',()=>{throw new Error('Must not spawn');});
  try{
    for(const value of [{...input,body:Buffer.alloc(crawlSitemapCapacityBytes+1)},{...input,body:'string'},
      {...input,documentUrl:'https://example.test/'+'x'.repeat(2048)},{...input,extra:true},
      {...input,toJSON(){serialized=true;return input;}}])assert.deepEqual(await parseCrawlSitemapIsolated(value as CrawlSitemapInput),{status:'invalid_input'});
    assert.equal(serialized,false);assert.equal(spy.mock.callCount(),0);
  }finally{spy.mock.restore();}
});

test('unfinished hostile tokens remain isolated with no partial discovery and a responsive parent',async()=>{
  let tick=false;const timer=setTimeout(()=>{tick=true;},0),started=performance.now();
  try{
    const prefix=begin+'<url><loc>https://example.test/first</loc></url><x a="';
    const result=await parseCrawlSitemapIsolated({...input,body:Buffer.from(prefix+'x'.repeat(crawlSitemapCapacityBytes-prefix.length))});
    assert.equal(tick,true);assert.ok(performance.now()-started<6000);
    if(result.status==='ok'){assert.equal(result.analysis.status,'unavailable');assert.deepEqual(result.analysis.entries,[]);}
    else assert.ok(['timeout','child_error'].includes(result.status));
  }finally{clearTimeout(timer);}
});

test('pre-abort and cancellation return no sitemap entries',async()=>{
  const before=new AbortController();before.abort();assert.deepEqual(await parseCrawlSitemapIsolated(input,before.signal),{status:'aborted'});
  const controller=new AbortController(),pending=parseCrawlSitemapIsolated(input,controller.signal);controller.abort();
  assert.deepEqual(await pending,{status:'aborted'});
});

test('invalid child counts, URL, status and coverage envelopes fail closed',async()=>{
  const analysis=pure(input);
  for(const output of [
    {status:'ok',analysis:{...analysis,bytesRead:input.body.byteLength+1}},
    {status:'ok',analysis:{...analysis,counts:{...analysis.counts,accepted:2}}},
    {status:'ok',analysis:{...analysis,entries:[{url:'file:///private'}]}},
    {status:'ok',analysis:{...analysis,entries:[{url:'https://user:password@example.test/'}]}},
    {status:'ok',analysis:{...analysis,status:'unavailable',reasons:['invalid_xml']}},
    {status:'ok',analysis:{...analysis,entriesComplete:false}},
    {status:'ok',analysis:{...analysis,reasons:['private raw diagnostic']}},
    {status:'ok',analysis:{...analysis,status:'partial'}},
  ]){
    const spy=mock.method(childProcess,'spawn',()=>{
      const child=new EventEmitter() as any;child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.stdin=new Writable({write(_chunk,_encoding,callback){callback();}});child.kill=()=>true;
      queueMicrotask(()=>{child.stdout.write(JSON.stringify(output));child.emit('close',0,null);});return child;
    });
    try{assert.deepEqual(await parseCrawlSitemapIsolated(input),{status:'child_error'});}finally{spy.mock.restore();}
  }
});

test('child independently rejects noncanonical base64 and bodies above the live capacity',()=>{
  const env:NodeJS.ProcessEnv={NODE_ENV:'production',TZ:'UTC'};if(process.platform==='win32'&&process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
  for(const bodyBase64 of ['%%%%',Buffer.alloc(crawlSitemapCapacityBytes+1).toString('base64')]){
    const result=childProcess.spawnSync(process.execPath,['--max-old-space-size=64',resolve('src/server/crawl-analysis-child.ts')],{
      input:JSON.stringify({operation:'sitemap',documentUrl:input.documentUrl,bodyBase64}),timeout:4000,maxBuffer:1024,encoding:'utf8',env,windowsHide:true,shell:false,
    });
    assert.equal(result.status,0);assert.equal(result.stdout,'{"status":"invalid_input"}');assert.equal(result.stderr,'');
  }
});
