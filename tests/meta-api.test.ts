import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FoundationError} from '../src/server/auth.ts';
import {handleMeta,readMetaDeletionForm} from '../src/server/meta-api.ts';

const type='application/x-www-form-urlencoded';
const request=(body:BodyInit|null,headers:Record<string,string>={},signal?:AbortSignal)=>new Request('https://monitor.example/api/meta/apps/00000000-0000-4000-8000-000000000001/delete-data',{method:'POST',body,headers:{'content-type':type,...headers},signal,...(body instanceof ReadableStream?{duplex:'half' as const}:{})});
const status=(n:number)=>(error:unknown)=>error instanceof FoundationError&&error.status===n&&!error.message.includes('private-value');

test('Meta callback form preserves exact signed text and admits one field only',async()=>{
 assert.equal(await readMetaDeletionForm(request('signed_request=abc_def.GHI-123')),'abc_def.GHI-123');
 assert.equal(await readMetaDeletionForm(request('%73igned_request=abc%2Edef',{'content-type':type+'; charset=UTF-8'})),'abc.def');
 for(const body of ['', 'signed_request=', 'signed_request=a&signed_request=b', 'signed_request=a&other=private-value', 'other=private-value'])await assert.rejects(readMetaDeletionForm(request(body)),status(400));
});
test('Meta callback media type, declared size and actual decoded field bounds fail closed',async()=>{
 for(const badType of ['application/json','multipart/form-data; boundary=a','text/plain',type+'; charset=latin1'])await assert.rejects(readMetaDeletionForm(request('signed_request=a',{'content-type':badType})),status(415));
 await assert.rejects(readMetaDeletionForm(request(null)),status(400));
 for(const length of ['-1','1.5','1,2','9007199254740992'])await assert.rejects(readMetaDeletionForm(request('signed_request=a',{'content-length':length})),status(400));
 await assert.rejects(readMetaDeletionForm(request('signed_request=a',{'content-length':'32769'})),status(413));
 assert.equal((await readMetaDeletionForm(request('signed_request='+'x'.repeat(24576)))).length,24576);
 await assert.rejects(readMetaDeletionForm(request('signed_request='+'x'.repeat(24577))),status(400));
});
test('Meta callback stream cap ignores a lying Content-Length and cancels upstream',async()=>{
 let cancelled=false;
 const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(32769));},cancel(){cancelled=true;}});
 await assert.rejects(readMetaDeletionForm(request(stream,{'content-length':'1'})),status(413));
 assert.equal(cancelled,true);
});
test('Meta callback abort bounds a hung body without waiting for its cancel promise',async()=>{
 const controller=new AbortController();let cancelled=false;
 const stream=new ReadableStream<Uint8Array>({cancel(){cancelled=true;return new Promise<void>(()=>{});}});
 const before=Date.now(),timer=setTimeout(()=>controller.abort(),20);
 try{await assert.rejects(readMetaDeletionForm(request(stream,{},controller.signal)),status(408));}finally{clearTimeout(timer);}
 assert.ok(Date.now()-before<1000);assert.equal(cancelled,true);
});
test('Public Meta callback/status methods are explicit; unrelated routes remain untouched',async()=>{
 assert.equal(await handleMeta(new Request('https://monitor.example/api/other')),null);
 assert.equal((await handleMeta(new Request('https://monitor.example/api/meta/callback',{method:'POST'})))?.status,405);
 assert.equal((await handleMeta(new Request('https://monitor.example/api/meta/apps/00000000-0000-4000-8000-000000000001/delete-data')))?.status,405);
 assert.equal((await handleMeta(new Request('https://monitor.example/api/meta/deletion-status/'+'a'.repeat(43),{method:'POST'})))?.status,405);
 assert.equal((await handleMeta(new Request('https://monitor.example/api/meta/deletion-status/invalid')))?.status,404);
});
