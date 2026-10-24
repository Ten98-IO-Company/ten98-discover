// Opt in: TEN98_QUICK_SHARE_BROWSER=1 PLAYWRIGHT_MODULE=<absolute index.mjs> node tests/website-quick-share-browser.ts
// Actual App/router and dashboard header Share (IA journey J5); synthetic transport only. No server/grant/provider acceptance.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {launchChromium} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_QUICK_SHARE_BROWSER,'1');assert.ok(process.env.PLAYWRIGHT_MODULE);
const root=process.cwd(),out=resolve('private/swarm/quick-share-'+randomBytes(5).toString('hex'));mkdirSync(out,{recursive:true});
const id=(n:number)=>'49100000-0000-4000-8000-'+String(n).padStart(12,'0'),workspace=id(1),project=id(2),user=id(3),share=id(4),base='/api/projects/'+project+'/website-shares';
const evidence:Record<string,any>={qualification:'Actual App/router/WebsiteQuickShare, synthetic native-shaped transport. No database, grants or built-app proof.',groups:[],failures:[],external:[],errors:[]};
const save=():void=>writeFileSync(out+'/evidence.json',JSON.stringify(evidence,null,2)+'\n'),pass=(name:string)=>{evidence.groups.push(name);save();console.log('PASS '+name);};
let server:any,browser:any,context:any,page:any,origin='',state:{mode:string}={mode:'ok'},calls:{path:string;method:string;raw:string|null;body:any}[]=[];
const reply=(route:any,body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify(body)});
const writes=()=>calls.filter(call=>call.method==='POST'&&call.path.startsWith(base));
async function fresh({role='owner',width=1440}={}){
 await context?.close();state={mode:'ok'};calls=[];
 context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});context.setDefaultTimeout(7000);
 await context.route('**/*',async (route:any)=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin){evidence.external.push(url.origin);return route.abort();}if(!url.pathname.startsWith('/api/'))return route.continue();
  const path=url.pathname,method=request.method(),raw=request.postData(),body=raw?request.postDataJSON():null;calls.push({path,method,raw,body});
  if(path==='/api/status')return reply(route,{configured:true,appUrl:origin});
  if(path==='/api/me')return reply(route,{user:{id:user,name:'Synthetic owner',email:'synthetic@example.org'},instanceOperator:false,workspaces:[{id:workspace,name:'Synthetic workspace',role}]});
  if(path==='/api/account/preferences')return reply(route,{version:'account-preferences-v1',user:{id:user,name:'Synthetic owner',email:'synthetic@example.org'},preferences:{revision:1,timeZone:'UTC',locale:'en-US',theme:'light',updatedAt:'2026-10-01T00:00:00.000Z'}});
  if(path==='/api/workspaces/'+workspace+'/projects')return reply(route,{projects:[{id:project,name:'Synthetic website',origin:'https://example.org',publicKey:'synthetic-public-key',eventCount:0,lastEventAt:null,retainedFrom:null}]});
  if(path===base&&method==='POST'||path.startsWith(base+'/')&&method==='POST'){
   if(state.mode==='unknown')return reply(route,{error:'Synthetic uncertain outcome'},503);
   const operation=path.endsWith('/revoke')?'revoke':'create',now=new Date().toISOString();
   // inactive: a replayed create of a link revoked since; mismatch: an item that is not the acknowledged share.
   const item={id:state.mode==='mismatch'?id(5):share,label:body.label??'Dashboard link',sections:body.sections??['overview','events'],expiresAt:body.expiresAt??now,createdAt:now,revokedAt:operation==='revoke'?now:null,state:operation==='revoke'||state.mode==='inactive'?'revoked':'active',creator:{name:'Synthetic owner',email:'synthetic@example.org',member:true}};
   return reply(route,{projectId:project,ack:{requestId:body.requestId,operation,shareId:share},item,replayed:false});
  }
  // The dashboard's own reads are outside this check: answer them as unavailable rather than inventing data.
  return reply(route,{error:'Synthetic data unavailable'},503);});
 page=await context.newPage();page.on('pageerror',(error:Error)=>evidence.errors.push(error.message));
 await page.goto(origin+'/?'+new URLSearchParams({workspace,project,view:'project'}),{waitUntil:'domcontentloaded'});
 await page.getByRole('heading',{name:'Overview',exact:true,level:1}).waitFor();
}
const btn=(name:string)=>page.getByRole('button',{name,exact:true}),dialog=()=>page.getByRole('dialog',{name:'Share this dashboard',exact:true}),act=(name:string)=>dialog().getByRole('button',{name,exact:true});
const ask=(title:string)=>page.getByRole('dialog',{name:title,exact:true}),answer=(title:string,name:string)=>ask(title).getByRole('button',{name,exact:true});
const shown=()=>dialog().getByRole('region',{name:'Share link'}).or(dialog().locator('pre')).first();
const unconfirmed='The shared-link request is unconfirmed. Retry the same request; its exact payload is kept in this tab.';
// Every group runs from a fresh context, so one failure does not hide the others; the run still fails if any group does.
async function group(name:string,body:()=>Promise<void>){try{await body();pass(name);}catch(error:any){evidence.failures.push({name,message:error.message});save();console.error('FAIL '+name+': '+error.message);}}
async function createLink(){await btn('Share').click();await act('Create and copy link').click();await shown().waitFor();}
async function run(){
 server=await createServer({configFile:false,envDir:false,root,cacheDir:out+'/vite-cache',appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{entries:['tests/website-share-exit-browser-fixture.tsx'],include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router','zod']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false},logLevel:'error'});
 server.middlewares.use((request:any,response:any,next:()=>void)=>{if(request.url?.split('?')[0]!=='/')return next();response.setHeader('content-type','text/html');response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Quick share fixture</title><div id="root"></div><script type="module" src="/tests/website-share-exit-browser-fixture.tsx"></script></html>');});
 await server.listen();origin='http://127.0.0.1:'+server.httpServer.address().port;await server.environments.client.warmupRequest('/tests/website-share-exit-browser-fixture.tsx');await server.environments.client.waitForRequestsIdle();await server.environments.client.depsOptimizer?.scanProcessing;await Promise.all(Object.values(server.environments.client.depsOptimizer?.metadata.discovered??{}).map((value:any)=>value.processing));
 browser=await launchChromium();

 await group('Share → Create and copy link makes one 30-day overview/events link and copies it; Copy and Revoke sit beside it',async()=>{
  await fresh();await btn('Share').click();await dialog().waitFor();
  await dialog().getByText(/Anyone with this link can view this report/).waitFor();
  assert.equal(writes().length,0,'Opening Share creates nothing: the link needs an informed second click.');
  await act('Create and copy link').click();const link=shown();await link.waitFor();
  const created=writes()[0].body;assert.deepEqual([...created.sections].sort(),['events','overview']);
  const days=(Date.parse(created.expiresAt)-Date.now())/864e5;assert.ok(days>29.9&&days<=30,'Links expire in 30 days.');
  const url=new URL((await link.innerText()).trim());assert.equal(url.pathname,'/share/websites/'+share);assert.equal(url.hash.slice(1),created.token);
  await dialog().getByText('Link created and copied. It is shown only once.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),url.href,'The creating click also copies the link.');
  await act('Copy link').waitFor();await act('Revoke link').click();await answer('Revoke this public link now?','Revoke link').click();
  await dialog().getByText('Link revoked. It stops working on its next read.',{exact:true}).waitFor();
  assert.equal(writes().length,2);assert.ok(writes()[1].path.endsWith('/'+share+'/revoke'));
 });

 await group('Item 1: the dialog states the panel exposure caveat and never claims visits stay hidden',async()=>{
  await fresh();await btn('Share').click();await dialog().waitFor();
  const description=await dialog().getAttribute('aria-describedby').then((ref:string|null)=>page.locator('[id="'+ref+'"]').innerText());
  assert.match(description,/Page paths, referrer hosts and event names are shown exactly as recorded\. Counts are exact and recipients can choose a single day, so on a low-traffic website any section can single out individual visits\./);
  assert.doesNotMatch(await dialog().innerText(),/never shown/i,'No over-strong privacy claim.');
 });

 await group('An unconfirmed create retries the identical request and never mints a second link',async()=>{
  await fresh();await btn('Share').click();state.mode='unknown';await act('Create and copy link').click();await act('Retry').waitFor();
  state.mode='ok';await act('Retry').click();await act('Revoke link').waitFor();
  assert.equal(writes().length,2);assert.equal(writes()[1].raw,writes()[0].raw,'Retry sends exactly the same request.');
 });

 await group('Item 2: an unconfirmed revoke retries the identical revoke request with revoke wording',async()=>{
  await fresh();await createLink();state.mode='unknown';await act('Revoke link').click();
  // Item 5 owns the confirmation assertion; answer it here only when it is asked.
  await answer('Revoke this public link now?','Revoke link').click({timeout:1500}).catch(()=>{});
  await dialog().getByRole('alert').waitFor();assert.equal((await dialog().getByRole('alert').innerText()).trim(),unconfirmed);
  assert.doesNotMatch(await dialog().innerText(),/second link/,'Revoke errors do not talk about creating links.');
  assert.equal(await act('Revoke link').count(),0,'A pending revoke offers only its exact retry.');
  state.mode='ok';await act('Retry').click();await dialog().getByText('Link revoked. It stops working on its next read.',{exact:true}).waitFor();
  assert.equal(writes().length,3);assert.ok(writes()[2].path.endsWith('/'+share+'/revoke'));assert.equal(writes()[2].raw,writes()[1].raw,'Retry resends the original revoke request ID.');
 });

 await group('Item 3: closing asks before dropping the shown-once URL or a pending retry',async()=>{
  await fresh();await createLink();
  await act('Done').click();await ask('Continue?').getByText('This public URL is shown once. Dismiss it only after copying it.',{exact:true}).waitFor();
  await answer('Continue?','Cancel').click();await ask('Continue?').waitFor({state:'detached'});assert.equal(await shown().isVisible(),true,'Cancelling keeps the URL.');
  await page.keyboard.press('Escape');await ask('Continue?').waitFor();await answer('Continue?','Cancel').click();await ask('Continue?').waitFor({state:'detached'});
  assert.equal(await shown().isVisible(),true,'Escape asks too.');
  await act('Done').click();await answer('Continue?','Continue').click();await dialog().waitFor({state:'hidden'});
  await btn('Share').click();await act('Create and copy link').waitFor();assert.equal(await shown().count(),0);
  state.mode='unknown';await act('Create and copy link').click();await act('Retry').waitFor();
  await act('Cancel').click();await ask('Continue?').getByText('The shared-link request may already be saved. Leaving loses its exact retry.',{exact:true}).waitFor();
  await answer('Continue?','Cancel').click();await ask('Continue?').waitFor({state:'detached'});await act('Retry').waitFor();
  assert.equal(writes().length,2,'Asking sends nothing.');
 });

 await group('Item 4: create shows the URL only for an active share whose ID matches the acknowledgement',async()=>{
  await fresh();await btn('Share').click();state.mode='inactive';await act('Create and copy link').click();
  await dialog().getByText('This link is no longer active, so it is not shown. Create a new link if you still need one.',{exact:true}).waitFor();
  assert.equal(await shown().count(),0);assert.equal(await act('Revoke link').count(),0);
  await fresh();await btn('Share').click();state.mode='mismatch';await act('Create and copy link').click();await act('Retry').waitFor();
  assert.equal((await dialog().getByRole('alert').innerText()).trim(),unconfirmed);assert.equal(await shown().count(),0,'A mismatched item is not acknowledged.');
 });

 await group('Item 5: revoke asks first with the panel wording; cancelling sends nothing',async()=>{
  await fresh();await createLink();await act('Revoke link').click();
  await ask('Revoke this public link now?').getByText('New reads are refused immediately and the link cannot be restored. Pages already open keep what they loaded until their next refresh (up to 5 minutes).',{exact:true}).waitFor();
  await answer('Revoke this public link now?','Cancel').click();await ask('Revoke this public link now?').waitFor({state:'detached'});
  assert.equal(writes().length,1,'Cancelling the confirmation revokes nothing.');assert.equal(await shown().isVisible(),true);
 });

 await group('Viewers do not get Share',async()=>{await fresh({role:'viewer'});assert.equal(await btn('Share').count(),0);});

 await group('Share dialog fits 320px',async()=>{
  await fresh({width:320});await btn('Share').click();await dialog().waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),320,'The share dialog fits a 320px screen.');
 });

 assert.deepEqual(evidence.failures,[]);assert.deepEqual(evidence.external,[]);assert.deepEqual(evidence.errors,[]);evidence.phase='passed';
}
const watchdog=setTimeout(()=>{console.error('Quick share browser exceeded 120 seconds including cleanup');process.exit(1);},120000);
let timer:ReturnType<typeof setTimeout>|undefined;
try{await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Quick share check exceeded its 100 second work gate')),100000);})]);}
catch(error:any){evidence.phase='failed';evidence.failure={message:error.message,stack:error.stack};process.exitCode=1;console.error(error);}
finally{clearTimeout(timer);for(const close of [()=>context?.close(),()=>browser?.close(),()=>server?.close()]){try{await close();}catch{process.exitCode=1;}}save();clearTimeout(watchdog);}
