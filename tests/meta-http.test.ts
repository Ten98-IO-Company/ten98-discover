import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, test } from 'node:test';
import { metaRequest, MetaRequestError, withMetaTransportForTests, type MetaRequest, type MetaTransport } from '../src/server/meta-http.ts';

const names = ['TEN98_INTEGRATION_TEST','APP_URL','DATABASE_URL','DATABASE_URL_FILE','AUTH_SECRET','AUTH_SECRET_FILE','BOOTSTRAP_TOKEN','BOOTSTRAP_TOKEN_FILE','ANALYTICS_NETWORK_MODE'] as const;
const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
Object.assign(process.env, { TEN98_INTEGRATION_TEST:'1', APP_URL:'http://127.0.0.1:3081', DATABASE_URL:'postgres://synthetic@127.0.0.1:55501/ten98_meta_http_synthetic', AUTH_SECRET:'a'.repeat(64), BOOTSTRAP_TOKEN:'b'.repeat(64), ANALYTICS_NETWORK_MODE:'off' });
for (const name of ['DATABASE_URL_FILE','AUTH_SECRET_FILE','BOOTSTRAP_TOKEN_FILE']) delete process.env[name];
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('No live requests are allowed in Meta HTTP tests.'); };
after(() => { globalThis.fetch = originalFetch; for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; } });
const credentials = { appId:'123456789012345', appSecret:'synthetic-meta-app-secret' };
const token = 'synthetic-meta-user-token';
const request: MetaRequest = { ...credentials, operation:'accounts', token };
const clean = (reason?: MetaRequestError['reason']) => (error: unknown) => {
  assert.ok(error instanceof MetaRequestError); if (reason) assert.equal(error.reason,reason);
  const visible=JSON.stringify(error)+error.message+error.stack;
  for (const secret of [credentials.appSecret,token,'sensitive-provider-message','https://evil.test','graph.facebook.com']) assert.ok(!visible.includes(secret));
  assert.equal(error.cause,undefined); return true;
};
const run = <T>(transport:MetaTransport, action:()=>Promise<T>) => withMetaTransportForTests(transport,action);
const json = (text:string, status=200, headers:Record<string,string>={}) => new Response(text,{status,headers:{'content-type':'application/json; charset=UTF-8',...headers}});

test('fixed typed operations build exact methods, authority and proof without cookies or redirects', async()=>{
  const captured:{url:URL;init:RequestInit}[]=[];
  await run(async(raw,init)=>{captured.push({url:new URL(raw),init});return Response.json({data:[]});},async()=>{
    for(const operation of [
      {...credentials,operation:'exchangeCode',code:'synthetic-code'},
      {...credentials,operation:'extendUserToken',token},
      {...credentials,operation:'inspectToken',token},
      {...credentials,operation:'permissions',token},
      {...credentials,operation:'accounts',token,after:'opaque%cursor+value'},
      {...credentials,operation:'account',token,accountId:'9007199254740993'},
      {...credentials,operation:'revoke',token},
    ] as MetaRequest[]) await metaRequest(operation);
  });
  assert.equal(captured.length,7);
  assert.deepEqual(captured.map(x=>x.url.pathname),['/v26.0/oauth/access_token','/v26.0/oauth/access_token','/v26.0/debug_token','/v26.0/me/permissions','/v26.0/me/adaccounts','/v26.0/act_9007199254740993','/v26.0/me/permissions']);
  for(const {url,init} of captured){assert.equal(url.origin,'https://graph.facebook.com');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.equal(init.body,undefined);assert.ok(init.signal);}
  assert.equal(captured[0].url.searchParams.get('redirect_uri'),'http://127.0.0.1:3081/api/meta/callback');
  assert.equal(captured[1].url.searchParams.get('grant_type'),'fb_exchange_token');
  assert.deepEqual([...captured[2].url.searchParams.keys()],['input_token','access_token']);
  assert.equal(captured[2].url.searchParams.get('access_token'),credentials.appId+'|'+credentials.appSecret);
  for(const item of captured.slice(0,3)){assert.equal(new Headers(item.init.headers).get('authorization'),null);assert.equal(item.url.searchParams.has('appsecret_proof'),false);}
  for(const item of captured.slice(3)){assert.equal(new Headers(item.init.headers).get('authorization'),'Bearer '+token);assert.equal(item.url.searchParams.get('appsecret_proof'),createHmac('sha256',credentials.appSecret).update(token).digest('hex'));assert.equal(item.url.searchParams.has('access_token'),false);}
  assert.equal(captured[4].url.searchParams.get('limit'),'100');assert.equal(captured[4].url.searchParams.get('after'),'opaque%cursor+value');
  assert.equal(captured[5].url.searchParams.has('limit'),false);assert.equal(captured[6].init.method,'DELETE');
});

test('invalid operation, credential, ID and extra URL authority never issue a request',async()=>{
  let calls=0;
  await run(async()=>{calls++;return Response.json({});},async()=>{
    for(const value of [null,{...request,operation:'report'},{...request,url:'https://evil.test'},{...request,fields:['access_token']},{...request,method:'POST'},{...request,appId:'123\n'},{...request,appId:'0'},{...request,appId:'1e3'},{...request,appId:123},{...request,appSecret:'a\r\nb'},{...request,appSecret:'x'.repeat(513)},{...request,token:'x'.repeat(4097)},{...request,token:'\ud800'},{...request,after:'\0'},{...request,after:'é'.repeat(2049)},{...credentials,operation:'account',token,accountId:'act_123'},{...credentials,operation:'exchangeCode',code:'x',redirectUri:'https://evil.test'}]) await assert.rejects(metaRequest(value as MetaRequest),clean('invalid_request'));
    await assert.rejects(metaRequest(request, {} as AbortSignal),clean('invalid_request'));
  });assert.equal(calls,0);
  await assert.rejects(metaRequest(request),clean('configuration'));
  const app=process.env.APP_URL;process.env.APP_URL='https://nonlocal.example';
  try{assert.throws(()=>withMetaTransportForTests(async()=>Response.json({}),async()=>undefined),/isolated local/);}finally{process.env.APP_URL=app;}
});

test('numeric Meta IDs preserve exact Node24 JSON lexemes rather than rounded numbers',async()=>{
  const raw='{"report_run_id":900719925474099312345678901234567890,"id":123,"account_id":9007199254740993,"app_id":1234,"user_id":5678,"value":42}';
  const result=await run(async()=>json(raw),()=>metaRequest(request));
  assert.deepEqual(result.data,{report_run_id:'900719925474099312345678901234567890',id:'123',account_id:'9007199254740993',app_id:'1234',user_id:'5678',value:42});
  for(const value of ['1e3','1.0','-1','0','12345678901234567890123456789012345678901']) await run(async()=>json('{"id":'+value+'}'),()=>assert.rejects(metaRequest(request),clean('invalid_response')));
  await run(async()=>json('{"id":"9007199254740993"}'),async()=>assert.deepEqual((await metaRequest(request)).data,{id:'9007199254740993'}));
});

test('redirects, malformed JSON, strict UTF8 and pathological JSON never leak provider content',async()=>{
  for(const response of [json('{"error":'),new Response(Uint8Array.of(0xc3,0x28)),json('{"text":"\\ud800"}'),json('{"text":"\\u0000"}'),json('{"__proto__":{"token":"x"}}'),json('{"x":1e999}'),json('[]'),json('null'),new Response('',{status:302,headers:{location:'https://evil.test/?token='+token}})]) await run(async()=>response,()=>assert.rejects(metaRequest(request),clean('invalid_response')));
  const redirected=Response.json({access_token:token});Object.defineProperty(redirected,'redirected',{value:true});await run(async()=>redirected,()=>assert.rejects(metaRequest(request),clean('invalid_response')));
  await run(async()=>{throw new Error('https://evil.test/'+token);},()=>assert.rejects(metaRequest(request),clean('unavailable')));
});

test('decoded body cap counts actual bytes and cancels oversized or misdeclared streams',async()=>{
  for(const declared of [undefined,'1','4194305','1, 2']){
    let cancelled=false;
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(4_194_305));},cancel(){cancelled=true;}});
    await run(async()=>new Response(body,{headers:declared?{'content-length':declared}:{}}),()=>assert.rejects(metaRequest(request),clean('invalid_response')));assert.equal(cancelled,true);
  }
  const encoded=new TextEncoder().encode('{"value":"'+'x'.repeat(50_000)+'"}');let offset=0;
  const tiny=new ReadableStream<Uint8Array>({pull(controller){if(offset===encoded.length)controller.close();else controller.enqueue(encoded.subarray(offset,++offset));}});
  const result=await run(async()=>new Response(tiny),()=>metaRequest(request));assert.equal((result.data as {value:string}).value.length,50_000);
});

test('caller abort bounds hung fetch and hung body even when injected transport ignores cancellation',async()=>{
  const originalTimeout=AbortSignal.timeout,deadlines:number[]=[];
  AbortSignal.timeout=ms=>{deadlines.push(ms);return originalTimeout(ms);};
  try{
    for(const body of [false,true]){
      let cancelled=false;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15);
      const response=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;return new Promise<void>(()=>{});}}));
      const before=Date.now();
      try{await run(async()=>body?response:new Promise<Response>(()=>{}),()=>assert.rejects(metaRequest(request,controller.signal),clean('aborted')));}finally{clearTimeout(timer);}
      assert.ok(Date.now()-before<1000);if(body)assert.equal(cancelled,true);
    }
    assert.deepEqual(deadlines,[30_000,30_000]);
  }finally{AbortSignal.timeout=originalTimeout;}
  const controller=new AbortController();controller.abort();let calls=0;
  await run(async()=>{calls++;return Response.json({});},()=>assert.rejects(metaRequest(request,controller.signal),clean('aborted')));assert.equal(calls,0);
});

test('deadline expiry is separate from caller abort and eventual late responses are discarded',async()=>{
  const original=AbortSignal.timeout;AbortSignal.timeout=()=>original(10);
  const keepAlive=setTimeout(()=>{},500);
  try{await run(async()=>new Promise<Response>(()=>{}),()=>assert.rejects(metaRequest(request),error=>{assert.ok(error instanceof MetaRequestError);return clean('timeout')(error)&&error.retryable;}));}finally{AbortSignal.timeout=original;clearTimeout(keepAlive);}
  const controller=new AbortController();let cancelled=false,resolve!: (r:Response)=>void;
  const pending=run(async()=>new Promise<Response>(done=>{resolve=done;}),()=>metaRequest(request,controller.signal));controller.abort();await assert.rejects(pending,clean('aborted'));
  resolve(new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}})));await new Promise(done=>setTimeout(done,0));assert.equal(cancelled,true);
});

test('closed errors and rate hints expose no arbitrary provider text and never retry automatically',async()=>{
  for(const http of [200,400])for(const subcode of [458,460,463])await run(async()=>json(JSON.stringify({error:{code:190,error_subcode:subcode,message:token}}),http),()=>assert.rejects(metaRequest(request),error=>{assert.ok(error instanceof MetaRequestError);assert.equal(error.reauthorize,true);assert.equal(error.retryable,false);assert.equal(error.providerCode,190);assert.equal(error.providerSubcode,subcode);return clean('unauthorized')(error);}));
  for(const [http,code,reason,retry,reauth]of [[400,4,'throttled',true,false],[400,613,'throttled',true,false],[400,200,'access_denied',false,true],[401,999,'unauthorized',false,true],[403,999,'access_denied',false,true],[429,999,'throttled',true,false],[503,999,'unavailable',true,false],[200,999,'unavailable',false,false]]as const){
    let calls=0;await run(async()=>{calls++;return json(JSON.stringify({error:{code,error_subcode:1504022,message:'sensitive-provider-message '+token,is_transient:true}}),http,{'retry-after':'12','x-fb-ads-insights-throttle':JSON.stringify({app_id_util_pct:91.5,acc_id_util_pct:100,ads_api_access_tier:'secret-tier',other:token})});},async()=>{
      await assert.rejects(metaRequest(request),error=>{assert.ok(error instanceof MetaRequestError);assert.ok(clean(reason)(error));assert.equal(error.retryable,retry);assert.equal(error.reauthorize,reauth);assert.equal(error.providerCode,code);assert.equal(error.providerSubcode,1504022);assert.deepEqual(error.rate,{retryAfterSeconds:12,appUtilizationPercent:91.5,accountUtilizationPercent:100});return true;});
    });assert.equal(calls,1);
  }
  await run(async()=>json('{"error":{"code":1.5,"error_subcode":999999999999,"message":"'+token+'"}}',400),()=>assert.rejects(metaRequest(request),error=>{assert.ok(error instanceof MetaRequestError);assert.equal(error.providerCode,null);assert.equal(error.providerSubcode,null);return clean('unavailable')(error);}));
  await run(async()=>json('{}',200,{'retry-after':'99999999999999999','x-fb-ads-insights-throttle':'{"app_id_util_pct":"99","acc_id_util_pct":-1}'}),async()=>assert.deepEqual((await metaRequest(request)).rate,{retryAfterSeconds:null,appUtilizationPercent:null,accountUtilizationPercent:null}));
});
