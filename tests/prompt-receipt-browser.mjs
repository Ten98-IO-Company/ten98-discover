// TEN98_PROMPT_RECEIPT_BROWSER=1; synthetic API and RouterProvider, no DB/provider calls.
// PLAYWRIGHT_MODULE is an optional installed ESM path; PLAYWRIGHT_CHANNEL selects the browser.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
assert.equal(process.env.TEN98_PROMPT_RECEIPT_BROWSER,'1');
const id=n=>`${n}0000000-0000-4000-8000-000000000001`,pid=id(3),cid=id(4),prompt=id(5),version=id(6),run=id(7),quote=id(8),connection=id(9),at='2026-10-13T12:00:00.000Z';
const input={connectionId:connection,promptId:prompt,versionId:version,systemText:'Private copied system',models:['openai/gpt-4o-mini'],maxCompletionTokens:1024,fundedCredits:true};
const original={id:cid,quoteId:quote,createdAt:at,cancelRequested:false,prompt:{id:prompt,versionId:version,textPreview:'Authored fixture prompt'},canCancel:false,input,messages:[{role:'system',content:input.systemText},{role:'user',content:'Authored fixture prompt'}],inputExpired:false,cache:{reused:false,available:false},runs:[{id:run,model:'openai/gpt-4o-mini',provider:'OpenAI',status:'completed',chargeStatus:'settled',estimateUsd:'0.010000',actualUsd:'0.000001',dispatchedAt:at,completedAt:at,diagnostic:null,resultExpired:false,result:{text:'Retained fixture answer',resolvedModel:'openai/gpt-4o-mini',provider:'OpenAI',finishReason:'stop',citations:[],promptTokens:10,completionTokens:5,receivedAt:at},reportedCost:'0.000001',upstreamReportedCost:null,isByok:false,generationId:'synthetic-generation'}]};
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'private/prompt-receipt-vite-cache',appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt acceptance</title><div id="root"></div><script type="module" src="/tests/prompt-receipt-browser-fixture.tsx"></script></html>');});
let browser,page,held=null,metaMode=null,detailMode=null,role='viewer',value,includeSummary=false;const calls=[],errors=[],outbound=[];
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
const until=async test=>{const end=Date.now()+10000;while(!await test()){if(Date.now()>end)assert.fail('Controlled receipt timed out.');await new Promise(r=>setTimeout(r,10));}};
try{
 await server.listen();const address=server.httpServer.address();assert.equal(address.address,'127.0.0.1');const origin='http://127.0.0.1:'+address.port;
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{}),headless:true});const context=await browser.newContext({viewport:{width:1100,height:850},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;if(url.origin!==origin){outbound.push(path);return route.abort();}if(!path.startsWith('/api/'))return route.continue();calls.push({method:req.method(),path});
  const base='/api/projects/'+pid+'/prompt-executions';if(path==='/api/projects/'+pid.replace(/1$/,'2')+'/prompt-executions')return json(route,{error:'New project access denied'},404);if(!path.startsWith(base)){outbound.push(path);return route.abort();}
  let mode,data;if(path===base&&req.method()==='GET'){mode=metaMode;metaMode=null;data={role,models:['openai/gpt-4o-mini','openai/gpt-4o'],vaultConfigured:false,spendingPaused:true,connections:[],comparisons:includeSummary?[structuredClone(value)]:[],cache:{available:false},scheduling:{available:false}};}
  else if(path===base+'/comparisons/'+cid&&req.method()==='GET'){mode=detailMode;detailMode=null;data={role,comparison:structuredClone(value)};}
  else if(path===base+'/comparisons/'+cid+'/cancel'&&req.method()==='POST'){mode=detailMode;detailMode=null;value={...value,canCancel:false};data={role,comparison:structuredClone(value)};}
  else{outbound.push(req.method()+' '+path);return route.abort();}
  if(mode==='expired-summary')data.comparisons=[{...structuredClone(value),runs:value.runs.map(r=>({...r,resultExpired:true}))}];
  if(mode==='malformed')data={role,comparison:{...value,runs:[{}]}};
  if(mode==='wrong-prompt')data.comparison.prompt.id=id(1);
  if(mode==='wrong-comparison')data.comparison.id=id(1);
  if(mode==='hold'||mode==='hold401'){assert.equal(held,null);held={route,data,status:mode==='hold401'?401:200};return;}
  if(typeof mode==='number')return json(route,{error:'Access denied'},mode);return json(route,data);
 });
 const button=name=>page.getByRole('button',{name,exact:true}),answer=()=>page.getByText('Retained fixture answer',{exact:true});
 const release=async()=>{const h=held;assert.ok(h);held=null;await json(h.route,h.data,h.status).catch(()=>{});};
 const ready=async()=>{await answer().waitFor();await until(()=>button('Refresh status').isEnabled());};
 const fresh=async({meta=null,detail=null,as='viewer',initial=original}={})=>{if(held)await release();await page?.close();role=as;value=structuredClone(initial);metaMode=meta;detailMode=detail;includeSummary=false;calls.length=0;page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);};

 await fresh();await ready();assert.deepEqual(calls.map(c=>c.path),['/api/projects/'+pid+'/prompt-executions','/api/projects/'+pid+'/prompt-executions/comparisons/'+cid]);assert.equal(await button('Get quote').count(),0);assert.equal(await button('Stop remaining requests').count(),0);await until(()=>page.getByRole('heading',{name:'Prompt run',exact:true}).evaluate(e=>e===document.activeElement));await button('Back to AI insights').click();await page.getByRole('heading',{name:'Returned to insights'}).waitFor();
 console.log('PASS an existing receipt outside recent20 opens after readiness with current viewer role, exact scope, focus and custom Back; no quote.');

 for(const code of [403,404]){await fresh();await ready();detailMode=code;await button('Refresh status').click();await button('Reload access').waitFor();assert.equal(await answer().count(),0);const before=calls.length;await button('Reload access').click();await ready();assert.equal(calls.length-before,2);assert.ok(calls.at(-1).path.endsWith(cid));}
 await fresh({detail:401});await page.getByRole('heading',{name:'Fixture signed out'}).waitFor();assert.equal(await answer().count(),0);
 console.log('PASS403/404 purge protected data and Reload access restores the intended receipt after a new role read;401 signs out.');

 for(const mode of ['malformed','wrong-prompt','wrong-comparison']){await fresh();await ready();detailMode=mode;await button('Refresh status').click();await button('Reload access').waitFor();assert.equal(await answer().count(),0);assert.equal(await page.getByText('Authored fixture prompt',{exact:true}).count(),0);await button('Reload access').click();await ready();}
 await fresh({meta:'malformed'});await button('Reload access').waitFor();assert.equal(calls.length,1);assert.equal(await answer().count(),0);
 console.log('PASS malformed nested data, wrong comparison/prompt identity and malformed readiness purge before display.');

 await fresh({detail:'hold401'});await until(()=>held!==null);await page.evaluate(workspaceId=>window.receiptFixture.scope({workspaceId}),id(2).replace(/1$/,'2'));await ready();await release();await ready();assert.equal(await page.getByRole('heading',{name:'Fixture signed out'}).count(),0);assert.equal(calls.filter(c=>c.path.endsWith('/prompt-executions')).length,2);
 await fresh({detail:'hold'});await until(()=>held!==null);await page.evaluate(projectId=>window.receiptFixture.scope({projectId}),id(3).replace(/1$/,'2'));await button('Reload access').waitFor();await release();assert.equal(await answer().count(),0);
 console.log('PASS workspace/project remount invalidates held receipt data and old401 cannot purge the newer scope.');

 await fresh();await ready();value={...value,inputExpired:true,input:null,messages:null,runs:value.runs.map(r=>({...r,resultExpired:true,result:null}))};await button('Refresh status').click();await page.getByText('Answer and citations expired under workspace retention.',{exact:true}).waitFor();value=structuredClone(original);await button('Refresh status').click();await until(()=>button('Refresh status').isEnabled());assert.equal(await answer().count(),0);await page.getByText(/Copied execution input expired/).waitFor();includeSummary=true;await button('Recent runs').click();await button('Open run').click();await page.getByText('Answer and citations expired under workspace retention.',{exact:true}).waitFor();assert.equal(await answer().count(),0);
 console.log('PASS learned input/result expiry survives later readable responses and history switches within the mounted scope.');

 await fresh({meta:'expired-summary'});await page.getByText('Answer and citations expired under workspace retention.',{exact:true}).waitFor();assert.equal(await answer().count(),0);assert.equal(calls.length,2);await page.getByText('Copied prompt and system input',{exact:true}).click();await page.getByText(input.systemText,{exact:true}).waitFor();
 detailMode=403;await button('Refresh status').click();await button('Reload access').waitFor();await button('Reload access').click();await page.getByText('Answer and citations expired under workspace retention.',{exact:true}).waitFor();assert.equal(await answer().count(),0);
 console.log('PASS readiness-summary expiry masks a later readable detail and survives access reload, without inventing copied-input expiry.');

 await fresh({meta:'hold'});await until(()=>held!==null);await button('Back to AI insights').click();await page.getByRole('heading',{name:'Returned to insights'}).waitFor();await release();assert.equal(await answer().count(),0);
 await fresh({as:'owner',initial:{...original,canCancel:true}});await ready();detailMode='hold';await button('Stop remaining requests').click();await until(()=>held!==null);assert.equal(await button('Back to AI insights').isDisabled(),true);await release();await until(()=>button('Back to AI insights').isEnabled());assert.equal(calls.filter(c=>c.method==='POST').length,1);
 console.log('PASS Back interrupts held reads but cannot cancel an in-flight explicit write.');

 await fresh();await ready();await page.evaluate(()=>window.receiptFixture.entry({kind:'history'}));await page.getByRole('heading',{name:'Recent runs',exact:true}).waitFor();assert.equal(await answer().count(),0);await page.evaluate(({prompt,version})=>window.receiptFixture.entry({kind:'configure',promptId:prompt,versionId:version,authoredText:'Configured authored prompt'}),{prompt,version});await page.getByRole('heading',{name:'Recent runs',exact:true}).waitFor();assert.equal(calls.filter(c=>c.method==='POST').length,0);
 await fresh({as:'owner'});await ready();await page.evaluate(({prompt,version})=>window.receiptFixture.entry({kind:'configure',promptId:prompt,versionId:version,authoredText:'Configured authored prompt'}),{prompt,version});await page.getByRole('heading',{name:'Review a prompt run',exact:true}).waitFor();await page.getByText('Configured authored prompt',{exact:true}).waitFor();assert.equal(calls.filter(c=>c.method==='POST').length,0);
 await page.setViewportSize({width:360,height:850});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(outbound,[]);assert.deepEqual(errors,[]);
 console.log('PASS existing history/configure role behavior remains intact, mobile fits and every provider/unexpected route stays blocked.');
}finally{if(held){await held.route.abort().catch(()=>{});held=null;}await browser?.close();await server.close();}
