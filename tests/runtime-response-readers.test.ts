import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {z} from 'zod';

// Regression coverage for the panel readers moved onto @ten98/runtime readResponseText (#226). Each reader is
// sliced verbatim from its component source and compiled with the installed transform, so a changed reader mode
// or error mapping fails here. Only in-memory Response objects are used; no app, listener or provider is started.
const src=(path:string)=>new URL('../src/'+path,import.meta.url);
const runtime=JSON.stringify(import.meta.resolve('@ten98/runtime')),api=JSON.stringify(src('lib/api.ts').href);
async function load(file:string,starts:string[],exports:string[],prelude=''){
 const source=(await readFile(src(file),'utf8')).replace(/\r\n/g,'\n');
 const parts=starts.map(start=>{const at=source.indexOf(start);assert.ok(at>=0,file+' no longer contains '+start);const end=start.startsWith('async function')||start.startsWith('export async function')?source.indexOf('\n}\n',at)+2:source.indexOf('\n',at);return source.slice(at,end).replace(/^export /,'');});
 const module=`import {readResponseText} from ${runtime};\nimport {ApiError} from ${api};\n${prelude}\n${parts.join('\n')}\nexport {${exports.join(',')}};`;
 const {code}=await transformWithOxc(module,file);
 return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
}
const origin='http://127.0.0.1:3111';
const json=(body:BodyInit,headers:Record<string,string>={},url='')=>{const r=new Response(body,{headers:{'content-type':'application/json',...headers}});if(url)Object.defineProperty(r,'url',{value:url});return r;};
// Chunks: before+[0x22,0xe2], then [0x82], then the tail. 0xe2 0x82 opens a three-byte sequence across the chunk boundary.
const split=(before:string,tail:number[])=>new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([...new TextEncoder().encode(before),0x22,0xe2]));c.enqueue(new Uint8Array([0x82]));if(tail.length)c.enqueue(new Uint8Array(tail));c.close();}});
const bytes=(value:string)=>[...new TextEncoder().encode(value)];
// A two-byte body declared as three, a seven-byte body declared as two, and a declaration above the 2 MiB cap.
const exactCases=[{name:'shorter',body:'{}',length:'3'},{name:'longer',body:'{"a":1}',length:'2'},{name:'oversized',body:'{}',length:String(2*1024*1024+1)}] as const;
async function withFetch<T>(response:()=>Response,run:()=>Promise<T>):Promise<T>{
 const fetch0=globalThis.fetch,window0=Object.getOwnPropertyDescriptor(globalThis,'window');
 globalThis.fetch=async()=>response();Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{origin}}});
 try{return await run();}finally{globalThis.fetch=fetch0;if(window0)Object.defineProperty(globalThis,'window',window0);else Reflect.deleteProperty(globalThis,'window');}
}

test('exact-length readers map short, long and oversized declarations to each panel message',async()=>{
 // verified() is the report validator; identity keeps a lenient reader observable as a resolved read.
 const performance=await load('components/WebPerformancePanel.tsx',['async function readReport('],['readReport'],'const verified=(value:unknown)=>value;');
 const replay=await load('components/SessionReplayPanel.tsx',['export class InvalidReplay','const invalid=','export async function readReplayResponse'],['readReplayResponse','InvalidReplay']);
 const tracked=await load('components/TrackedAssetsPanel.tsx',['const invalid=','async function request('],['request']);
 const performanceMessage={shorter:'This performance response was incomplete. Reload the report.',longer:'This performance response was incomplete. Reload the report.',oversized:'This performance report is too large. Choose a shorter date range.'};
 for(const item of exactCases){
  const response=()=>json(item.body,{'content-length':item.length});
  await withFetch(response,()=>assert.rejects(performance.readReport('/r',new AbortController().signal,'p',{}),{message:performanceMessage[item.name]},'performance '+item.name));
  await withFetch(response,()=>assert.rejects(replay.readReplayResponse('/r',z.unknown(),new AbortController().signal),(e:Error)=>e instanceof replay.InvalidReplay&&e.message==='This replay response could not be verified. Reload the recording or list.','replay '+item.name));
  await withFetch(response,()=>assert.rejects(tracked.request('/r',new AbortController().signal),{message:'This response could not be verified. Refresh before continuing.'},'tracked '+item.name));
 }
 // The same bodies with a matching declaration are accepted, so the rejections above come from the length check.
 await withFetch(()=>json('{"a":1}',{'content-length':'7'}),async()=>{
  assert.deepEqual(await performance.readReport('/r',new AbortController().signal,'p',{}),{a:1});
  assert.deepEqual(await replay.readReplayResponse('/r',z.unknown(),new AbortController().signal),{a:1});
  assert.deepEqual(await tracked.request('/r',new AbortController().signal),{a:1});
 });
});

test('retention reader bounds Content-Length without comparing it to decoded bytes',async()=>{
 const {retentionLimits}=await import('../src/lib/retention-report.ts');
 const retention=await load('components/RetentionReportPanel.tsx',['async function readReport('],['readReport'],
  `const retentionLimits=${JSON.stringify(retentionLimits)};const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);const clean=(v:unknown,n:number)=>typeof v==='string'&&v.length<=n;`);
 const body='{"cohorts":[]}',read=()=>retention.readReport('/api/retention',new AbortController().signal);
 // Content-Length carries the compressed size while fetch exposes the decoded body.
 await withFetch(()=>json(body,{'content-length':'9','content-encoding':'gzip'},origin+'/api/retention'),async()=>assert.deepEqual(await read(),{cohorts:[]}));
 // An intermediary may decode the body without exposing Content-Encoding; only the limit applies, so an 'exact' reader fails here.
 await withFetch(()=>json(body,{'content-length':'9'},origin+'/api/retention'),async()=>assert.deepEqual(await read(),{cohorts:[]}));
 await withFetch(()=>json(body,{'content-length':'01'},origin+'/api/retention'),()=>assert.rejects(read(),(e:Error)=>e.constructor===Error&&e.message==='The retention response type or size could not be verified.'));
 await withFetch(()=>json(body,{'content-length':String(retentionLimits.json+1)},origin+'/api/retention'),()=>assert.rejects(read(),{message:'The retention response exceeded its safe size. Narrow the entry filters.'}));
});

test('UTF-8 split across chunks maps to each reader decode message',async()=>{
 const inspection=await load('components/GoogleInspectionPanel.tsx',['async function inspect('],['inspect']);
 const account=await (async()=>{
  let compiled=(await transformWithOxc(await readFile(src('lib/account-presentation.tsx'),'utf8'),'account-presentation.tsx',{jsx:{runtime:'automatic'}})).code;
  for(const [specifier,target]of [['react',import.meta.resolve('react')],['react/jsx-runtime',import.meta.resolve('react/jsx-runtime')],['@ten98/runtime',import.meta.resolve('@ten98/runtime')],['./api',src('lib/api.ts').href],['./account-preferences',src('lib/account-preferences.ts').href]])compiled=compiled.replaceAll(JSON.stringify(specifier),JSON.stringify(target));
  return import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
 })();
 // The split sequence is truncated at close, or by a '"' tail. A lossy decoder would turn the '"' tail into valid JSON
 // (a U+FFFD string, or a valid account DTO whose name is U+FFFD), so only the fatal decoder produces these messages.
 const user='{"version":"account-preferences-v1","user":{"id":"member-id","name":',rest='","email":"member@example.test"},"preferences":{"revision":1,"timeZone":"UTC","locale":"en-US","theme":"light","updatedAt":"2026-10-16T00:00:00.000Z"}}';
 for(const tail of [[],bytes('"')]){
  await withFetch(()=>json(split('',tail),{},origin+'/api/inspect'),()=>assert.rejects(inspection.inspect('/api/inspect',{},new AbortController().signal),(e:Error)=>e.constructor===Error&&e.message==='The inspection response could not be decoded.','inspection tail '+tail.length));
  await withFetch(()=>json(split(user,tail.length?bytes(rest):[])),()=>assert.rejects(account.requestAccountPreferences(new AbortController().signal),(e:Error)=>e.constructor===Error&&e.message==='The account response could not be verified. Reload saved preferences.','account tail '+tail.length));
 }
 // Completing the sequence (0xac) decodes the same bodies, so the rejections above come from the fatal decoder.
 await withFetch(()=>json(split('',[0xac,...bytes('"')]),{},origin+'/api/inspect'),async()=>assert.equal(await inspection.inspect('/api/inspect',{},new AbortController().signal),'€'));
 await withFetch(()=>json(split(user,[0xac,...bytes(rest)])),async()=>assert.equal((await account.requestAccountPreferences(new AbortController().signal)).user.name,'€'));
});
