import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {resolve} from 'node:path';
import {evaluateCrawlRobotsIsolated,type CrawlRobotsInput} from '../src/server/crawl-robots-isolated.ts';
import {ROBOTS_MAX_BYTES} from '../src/server/crawl-robots.ts';

const input:CrawlRobotsInput={robotsUrl:'https://example.com/robots.txt',body:Buffer.from('User-agent: *\nDisallow: /private\nAllow: /private/public\nSitemap: https://maps.example.com/map.xml'),productToken:'TenMonitorBot',targetUrls:['https://example.com/','https://example.com/private','https://example.com/private/public']};

test('fixed child evaluates a batch and preserves the policy digest without returning raw rules',async()=>{
  const result=await evaluateCrawlRobotsIsolated(input);assert.equal(result.status,'ok');if(result.status!=='ok')return;
  assert.equal(result.evaluation.digest,createHash('sha256').update(input.body).digest('hex'));
  assert.equal(result.evaluation.policyStatus,'ready');assert.equal(result.evaluation.origin,'https://example.com');
  assert.deepEqual(result.evaluation.sitemaps,['https://maps.example.com/map.xml']);
  assert.deepEqual(result.evaluation.decisions.map(d=>d.status),['allowed','disallowed','allowed']);
  assert.ok(!JSON.stringify(result).includes('Disallow:'));assert.ok(!('rules' in result.evaluation));
});

test('fatal UTF8 errors and original-origin/delay decisions remain unavailable without allow fallback',async()=>{
  const malformed=await evaluateCrawlRobotsIsolated({...input,body:Buffer.from([0xc3,0x28])});
  assert.equal(malformed.status,'ok');if(malformed.status!=='ok')return;
  assert.equal(malformed.evaluation.policyStatus,'unavailable');assert.equal(malformed.evaluation.reason,'invalid_utf8');
  assert.ok(malformed.evaluation.decisions.every(d=>d.status==='unavailable'));assert.equal(malformed.evaluation.origin,null);
  const body=Buffer.from('User-agent: *\nDisallow: /private\nCrawl-delay: 2');
  const pending=await evaluateCrawlRobotsIsolated({...input,body});assert.equal(pending.status,'ok');
  if(pending.status==='ok')assert.ok(pending.evaluation.decisions.every(d=>d.reason==='crawl_delay_not_supported'));
  const scoped=await evaluateCrawlRobotsIsolated({...input,body,maxCrawlDelaySeconds:2,targetUrls:['https://example.com/private','https://other.example.com/']});
  assert.equal(scoped.status,'ok');if(scoped.status==='ok')assert.deepEqual(scoped.evaluation.decisions.map(d=>d.status),['disallowed','unavailable']);
});

test('exact body and batch bounds preserve restrictive tails; oversized requests never spawn',async()=>{
  const prefix='User-agent: *\n#',suffix='\nDisallow: /private';
  const body=Buffer.from(prefix+'a'.repeat(ROBOTS_MAX_BYTES-prefix.length-suffix.length)+suffix);
  const result=await evaluateCrawlRobotsIsolated({...input,body,targetUrls:Array(100).fill('https://example.com/private')});
  assert.equal(result.status,'ok');if(result.status==='ok')assert.equal(result.evaluation.decisions.filter(d=>d.status==='disallowed').length,100);
  const spy=mock.method(childProcess,'spawn',()=>{throw new Error('Should not spawn');});let called=false;
  try{
    for(const bad of [{...input,body:Buffer.alloc(ROBOTS_MAX_BYTES+1)},{...input,body:'lossy string'},{...input,targetUrls:[]},
      {...input,targetUrls:Array(101).fill('https://example.com/')},{...input,targetUrls:['https://example.com/'+'x'.repeat(2048)]},
      {...input,maxCrawlDelaySeconds:Infinity},{...input,productToken:'x'.repeat(129)},
      {...input,toJSON(){called=true;return input;}}])assert.deepEqual(await evaluateCrawlRobotsIsolated(bad as CrawlRobotsInput),{status:'invalid_input'});
    assert.equal(called,false);assert.equal(spy.mock.callCount(),0);
  }finally{spy.mock.restore();}
});

test('adversarial matching yields explicit work exhaustion inside a responsive parent',async()=>{
  const body=Buffer.from('User-agent: *\nAllow: /\nDisallow: /'+'*'.repeat(500000)+'z$');
  let parentTick=false;const timer=setTimeout(()=>{parentTick=true;},0);
  try{
    const result=await evaluateCrawlRobotsIsolated({...input,body,targetUrls:['https://example.com/'+'a'.repeat(1000)]});
    assert.equal(result.status,'ok');if(result.status==='ok')assert.equal(result.evaluation.decisions[0].reason,'match_work_limit');
    assert.equal(parentTick,true);
  }finally{clearTimeout(timer);}
});

test('pre-abort and abort of a real batch do not return any decisions',async()=>{
  const before=new AbortController();before.abort();assert.deepEqual(await evaluateCrawlRobotsIsolated(input,before.signal),{status:'aborted'});
  const controller=new AbortController(),pending=evaluateCrawlRobotsIsolated({...input,targetUrls:Array(100).fill('https://example.com/')},controller.signal);
  controller.abort();assert.deepEqual(await pending,{status:'aborted'});
});

test('unsupported child envelopes cannot grant permission or mix batch ordering',async()=>{
  const real=await evaluateCrawlRobotsIsolated(input);assert.equal(real.status,'ok');if(real.status!=='ok')return;
  for(const output of [
    {status:'ok',evaluation:{...real.evaluation,decisions:[]}},
    {status:'ok',evaluation:{...real.evaluation,policyStatus:'unavailable',reason:'body_limit'}},
    {status:'ok',evaluation:{...real.evaluation,decisions:real.evaluation.decisions.map(d=>({...d,work:Infinity}))}},
    {status:'ok',analysis:{}},
  ]){
    const spy=mock.method(childProcess,'spawn',()=>{
      const child=new EventEmitter() as any;child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.stdin=new Writable({write(_chunk,_encoding,callback){callback();}});child.kill=()=>true;
      queueMicrotask(()=>{child.stdout.write(JSON.stringify(output));child.emit('close',0,null);});return child;
    });
    try{assert.deepEqual(await evaluateCrawlRobotsIsolated(input),{status:'child_error'});}finally{spy.mock.restore();}
  }
});

test('child independently rejects unsupported operations and invalid base64',()=>{
  const env:NodeJS.ProcessEnv={NODE_ENV:'production',TZ:'UTC'};if(process.platform==='win32'&&process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
  for(const value of [
    {operation:'execute',bodyBase64:''},
    {operation:'robots',robotsUrl:input.robotsUrl,bodyBase64:'%%%%',productToken:input.productToken,targetUrls:input.targetUrls,maxCrawlDelaySeconds:0},
  ]){
    const result=childProcess.spawnSync(process.execPath,['--max-old-space-size=64',resolve('src/server/crawl-analysis-child.ts')],{input:JSON.stringify(value),timeout:2000,maxBuffer:1024,encoding:'utf8',env,windowsHide:true,shell:false});
    assert.equal(result.status,0);assert.equal(result.stdout,'{"status":"invalid_input"}');assert.equal(result.stderr,'');
  }
});
