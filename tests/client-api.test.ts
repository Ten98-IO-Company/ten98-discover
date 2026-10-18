import test from 'node:test';
import assert from 'node:assert/strict';
import {api,ApiError} from '../src/lib/api.ts';

test('malformed successful bodies stay uncertain instead of confirming a write',async t=>{
  for(const body of ['<html>Sign in</html>','{"saved":','   ']){
    t.mock.method(globalThis,'fetch',async()=>new Response(body,{status:200}));
    await assert.rejects(api('/api/synthetic',{method:'POST',body:{requestId:'unchanged'}}),e=>e instanceof ApiError&&e.status===0);
    t.mock.restoreAll();
  }
});
test('legitimate JSON, null and empty responses remain supported',async t=>{
  for(const [response,expected] of [[new Response('{"saved":true}'),{saved:true}],[new Response('null'),null],[new Response(null,{status:204}),null]] as const){
    t.mock.method(globalThis,'fetch',async()=>response);
    assert.deepEqual(await api('/api/synthetic'),expected);
    t.mock.restoreAll();
  }
});
test('error responses retain their HTTP authority status and safe message fallback',async t=>{
  for(const [status,body,message]of [[401,'<html>Expired</html>','Your session has expired. Sign in again.'],[403,'{','Request failed with status 403.'],[409,'{"error":"Changed elsewhere"}','Changed elsewhere']]as const){
    t.mock.method(globalThis,'fetch',async()=>new Response(body,{status}));
    await assert.rejects(api('/api/synthetic'),e=>e instanceof ApiError&&e.status===status&&e.message===message);
    t.mock.restoreAll();
  }
});
test('caller cancellation stays an AbortError and never becomes a retryable status',async t=>{
  const abort=new DOMException('Cancelled','AbortError');
  t.mock.method(globalThis,'fetch',async()=>{throw abort;});
  await assert.rejects(api('/api/synthetic'),e=>e===abort);
});