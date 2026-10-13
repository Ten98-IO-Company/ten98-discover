import assert from 'node:assert/strict';
import test,{mock} from 'node:test';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {copyFile,mkdir,mkdtemp,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {analyzeCrawlPage,type CrawlPageInput} from '../src/server/crawl-analysis.ts';
import {analyzeCrawlPageIsolated,crawlParserLimits} from '../src/server/crawl-analysis-isolated.ts';

const input:CrawlPageInput={url:'https://example.com/',status:200,fetchState:'ok',contentType:'text/html',html:'<title>A useful page</title><h1>Hello</h1><a href="/next">Next</a>',bodyComplete:true,responseTimeMs:50,crawlDepth:0};

test('real fixed child matches the pure analyzer and only returns complete output',async()=>{
  assert.deepEqual(await analyzeCrawlPageIsolated(input),{status:'ok',analysis:analyzeCrawlPage(input)});
});

test('validation rejects unsupported and oversized input before spawning or calling toJSON',async()=>{
  const mocked=mock.method(childProcess,'spawn',()=>{throw new Error('Must not spawn');});let called=false;
  try{
    for(const bad of [{...input,html:'x'.repeat(1048577)},{...input,unknown:'ignored?'},{...input,responseTimeMs:NaN},{...input,status:undefined},
      {...input,linkHeaders:['x'.repeat(16385)]},{...input,xRobotsTags:Array(101).fill('noindex')},{...input,html:{}},
      {...input,toJSON(){called=true;return input;}}])assert.deepEqual(await analyzeCrawlPageIsolated(bad as CrawlPageInput),{status:'invalid_input'});
    assert.equal(called,false);assert.equal(mocked.mock.callCount(),0);
  }finally{mocked.mock.restore();}
});

test('real hostile nesting is killed at the deadline with no partial result',async()=>{
  const started=performance.now();
  const result=await analyzeCrawlPageIsolated({...input,html:'<div>'.repeat(190000)});
  assert.deepEqual(result,{status:'timeout'});assert.ok(performance.now()-started<6000);
});

test('abort before and during parsing closes only the owned child and leaves its pipes closed',async()=>{
  const before=new AbortController();before.abort();assert.deepEqual(await analyzeCrawlPageIsolated(input,before.signal),{status:'aborted'});
  const actualSpawn=childProcess.spawn;let child:ReturnType<typeof childProcess.spawn>|undefined;
  const mocked=mock.method(childProcess,'spawn',(...args:Parameters<typeof childProcess.spawn>)=>{child=actualSpawn(...args);return child;});
  const controller=new AbortController();
  try{
    const pending=analyzeCrawlPageIsolated({...input,html:'<div>'.repeat(190000)},controller.signal);
    const timer=setTimeout(()=>controller.abort(),50);
    try{assert.deepEqual(await pending,{status:'aborted'});}finally{clearTimeout(timer);}
    assert.ok(child);assert.ok(child.exitCode!==null||child.signalCode!==null);assert.equal(child.stdin?.destroyed,true);assert.equal(child.stdout?.destroyed,true);assert.equal(child.stderr?.destroyed,true);
  }finally{mocked.mock.restore();}
});

function fakeChild(run:(child:any)=>void){
  const child=new EventEmitter() as any;child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new Writable({write(_chunk,_encoding,callback){callback();}});child.kills=0;
  child.kill=(signal:string)=>{assert.equal(signal,'SIGKILL');child.kills++;queueMicrotask(()=>child.emit('close',null,'SIGKILL'));return true;};
  queueMicrotask(()=>run(child));return child;
}

test('fixed spawn arguments and environment exclude secrets, preload hooks, PATH and alternate entries',async()=>{
  let command:unknown,args:unknown,options:any;
  const mocked=mock.method(childProcess,'spawn',(...values:any[])=>{[command,args,options]=values;return fakeChild(child=>{child.stdout.write(JSON.stringify({status:'ok',analysis:analyzeCrawlPage(input)}));child.emit('close',0,null);});});
  try{
    assert.equal((await analyzeCrawlPageIsolated(input)).status,'ok');assert.equal(command,process.execPath);
    assert.deepEqual(args,['--max-old-space-size=64',resolve('src/server/crawl-analysis-child.ts')]);
    assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.deepEqual(options.stdio,['pipe','pipe','pipe']);
    assert.equal(options.cwd,process.cwd());assert.deepEqual(Object.keys(options.env).sort(),(process.platform==='win32'&&process.env.SystemRoot?['NODE_ENV','SystemRoot','TZ']:['NODE_ENV','TZ']).sort());
    for(const key of ['AUTH_SECRET','DATABASE_URL','CREDENTIAL_KEYS','NODE_OPTIONS','NODE_PATH','HOME','USERPROFILE','PATH','HTTP_PROXY'])assert.equal(options.env[key],undefined);
  }finally{mocked.mock.restore();}
});

test('malformed, nonzero, overflowing and incomplete child responses are failures without raw diagnostics',async()=>{
  for(const scenario of ['json','shape','partial_shape','trailing','nonzero','stdout','stderr','spawn','pipe','invalid_input'] as const){
    let child:any;
    const mocked=mock.method(childProcess,'spawn',()=>{
      if(scenario==='spawn')throw new Error('synthetic private diagnostics');
      child=fakeChild(c=>{
        if(scenario==='stdout'){c.stdout.write(Buffer.alloc(crawlParserLimits.outputBytes+1));return;}
        if(scenario==='stderr'){c.stderr.write(Buffer.alloc(crawlParserLimits.stderrBytes+1));return;}
        if(scenario==='pipe'){c.stdin.emit('error',new Error('private input'));return;}
        c.stderr.write('synthetic private diagnostics');
        c.stdout.write(scenario==='json'?'{':scenario==='shape'?'{"status":"ok","analysis":{}}':scenario==='partial_shape'?JSON.stringify({status:'ok',analysis:{...analyzeCrawlPage(input),facts:{},evidence:{}}}):scenario==='trailing'?JSON.stringify({status:'ok',analysis:analyzeCrawlPage(input)})+'junk':scenario==='invalid_input'?'{"status":"invalid_input"}':JSON.stringify({status:'ok',analysis:analyzeCrawlPage(input)}));
        c.emit('close',scenario==='nonzero'?1:0,null);
      });return child;
    });
    try{assert.deepEqual(await analyzeCrawlPageIsolated(input),{status:scenario==='invalid_input'?'invalid_input':'child_error'});if(['stdout','stderr','pipe'].includes(scenario))assert.equal(child.kills,1);}
    finally{mocked.mock.restore();}
  }
});

test('Node24 source entry works in the copied Docker-style server layout; wrong cwd fails closed',async()=>{
  const original=process.cwd(),prefix=join(tmpdir(),'ten98-parser-layout-'),directory=await mkdtemp(prefix);
  try{
    await mkdir(join(directory,'src/server'),{recursive:true});
    for(const file of ['crawl-analysis.ts','crawl-analysis-child.ts'])await copyFile(join(original,'src/server',file),join(directory,'src/server',file));
    await writeFile(join(directory,'package.json'),'{"type":"module"}');
    await symlink(await realpath(join(original,'node_modules')),join(directory,'node_modules'),process.platform==='win32'?'junction':'dir');
    process.chdir(directory);assert.deepEqual(await analyzeCrawlPageIsolated(input),{status:'ok',analysis:analyzeCrawlPage(input)});
    process.chdir(join(directory,'src'));assert.deepEqual(await analyzeCrawlPageIsolated(input),{status:'child_error'});
  }finally{
    process.chdir(original);assert.ok(resolve(directory).startsWith(resolve(prefix)));await rm(directory,{recursive:true,force:true});
  }
});


test('child independently bounds stdin and rejects malformed input without echoing it',()=>{
  for(const payload of [Buffer.from('{"synthetic":"incomplete'),Buffer.alloc(crawlParserLimits.inputBytes+1,32)]){
    const env:NodeJS.ProcessEnv={NODE_ENV:'production',TZ:'UTC'};
    if(process.platform==='win32'&&process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
    const child=childProcess.spawnSync(process.execPath,['--max-old-space-size=64',resolve('src/server/crawl-analysis-child.ts')],{
      input:payload,timeout:2000,maxBuffer:1024,encoding:'utf8',shell:false,windowsHide:true,env,
    });
    assert.equal(child.stdout,'{"status":"invalid_input"}');assert.equal(child.stderr,'');assert.equal(child.status,0);
  }
});
