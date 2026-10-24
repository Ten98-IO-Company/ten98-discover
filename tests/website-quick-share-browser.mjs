// Opt in: TEN98_QUICK_SHARE_BROWSER=1 PLAYWRIGHT_MODULE=<absolute index.mjs> node tests/website-quick-share-browser.mjs
// Actual App/router and dashboard header Share (IA journey J5); synthetic transport only. No server/grant/provider acceptance.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {launchChromium} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_QUICK_SHARE_BROWSER,'1');assert.ok(process.env.PLAYWRIGHT_MODULE);
const root=process.cwd(),out=resolve('private/swarm/quick-share-'+randomBytes(5).toString('hex'));mkdirSync(out,{recursive:true});
const id=n=>'49100000-0000-4000-8000-'+String(n).padStart(12,'0'),workspace=id(1),project=id(2),user=id(3),share=id(4),base='/api/projects/'+project+'/website-shares';
const evidence={qualification:'Actual App/router/WebsiteQuickShare, synthetic native-shaped transport. No database, grants or built-app proof.',groups:[],external:[],errors:[]};
const save=()=>writeFileSync(out+'/evidence.json',JSON.stringify(evidence,null,2)+'\n'),pass=name=>{evidence.groups.push(name);save();console.log('PASS '+name);};
let server,browser,context,page,origin,state,calls=[];
const reply=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify(body)});
const wait=async fn=>{const deadline=Date.now()+7000;while(!await fn()){assert.ok(Date.now()<deadline,'Bounded browser condition failed');await new Promise(done=>setTimeout(done,20));}};
const writes=()=>calls.filter(call=>call.method==='POST'&&call.path.startsWith(base));
async function fresh({role='owner',width=1440}={}){
 await context?.close();state={mode:'ok'};calls=[];
 context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});context.setDefaultTimeout(7000);
 await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin){evidence.external.push(url.origin);return route.abort();}if(!url.pathname.startsWith('/api/'))return route.continue();
  const path=url.pathname,method=request.method(),raw=request.postData(),body=raw?request.postDataJSON():null;calls.push({path,method,raw,body});
  if(path==='/api/status')return reply(route,{configured:true,appUrl:origin});
  if(path==='/api/me')return reply(route,{user:{id:user,name:'Synthetic owner',email:'synthetic@example.org'},instanceOperator:false,workspaces:[{id:workspace,name:'Synthetic workspace',role}]});
  if(path==='/api/account/preferences')return reply(route,{version:'account-preferences-v1',user:{id:user,name:'Synthetic owner',email:'synthetic@example.org'},preferences:{revision:1,timeZone:'UTC',locale:'en-US',theme:'light',updatedAt:'2026-10-01T00:00:00.000Z'}});
  if(path==='/api/workspaces/'+workspace+'/projects')return reply(route,{projects:[{id:project,name:'Synthetic website',origin:'https://example.org',publicKey:'synthetic-public-key',eventCount:0,lastEventAt:null,retainedFrom:null}]});
  if(path===base&&method==='POST'||path.startsWith(base+'/')&&method==='POST'){
   if(state.mode==='unknown')return reply(route,{error:'Synthetic uncertain outcome'},503);
   const operation=path.endsWith('/revoke')?'revoke':'create',now=new Date().toISOString();
   const item={id:share,label:body.label??'Dashboard link',sections:body.sections??['overview','events'],expiresAt:body.expiresAt??now,createdAt:now,revokedAt:operation==='revoke'?now:null,state:operation==='revoke'?'revoked':'active',creator:{name:'Synthetic owner',email:'synthetic@example.org',member:true}};
   return reply(route,{projectId:project,ack:{requestId:body.requestId,operation,shareId:share},item,replayed:false});
  }
  // The dashboard's own reads are outside this check: answer them as unavailable rather than inventing data.
  return reply(route,{error:'Synthetic data unavailable'},503);});
 page=await context.newPage();page.on('pageerror',error=>evidence.errors.push(error.message));
 await page.goto(origin+'/?'+new URLSearchParams({workspace,project,view:'project'}),{waitUntil:'domcontentloaded'});
 await page.getByRole('heading',{name:'Overview',exact:true,level:1}).waitFor();
}
const btn=name=>page.getByRole('button',{name,exact:true}),dialog=()=>page.getByRole('dialog',{name:'Share this dashboard',exact:true});
async function run(){
 server=await createServer({configFile:false,envDir:false,root,cacheDir:out+'/vite-cache',appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{entries:['tests/website-share-exit-browser-fixture.tsx'],include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router','zod']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false},logLevel:'error'});
 server.middlewares.use((request,response,next)=>{if(request.url?.split('?')[0]!=='/')return next();response.setHeader('content-type','text/html');response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Quick share fixture</title><div id="root"></div><script type="module" src="/tests/website-share-exit-browser-fixture.tsx"></script></html>');});
 await server.listen();origin='http://127.0.0.1:'+server.httpServer.address().port;await server.environments.client.warmupRequest('/tests/website-share-exit-browser-fixture.tsx');await server.environments.client.waitForRequestsIdle();await server.environments.client.depsOptimizer?.scanProcessing;await Promise.all(Object.values(server.environments.client.depsOptimizer?.metadata.discovered??{}).map(value=>value.processing));
 browser=await launchChromium();

 await fresh();await btn('Share').click();await dialog().waitFor();
 await dialog().getByText(/Anyone with this link can view this report/).waitFor();
 assert.equal(writes().length,0,'Opening Share creates nothing: the link needs an informed second click.');
 await btn('Create link').click();const link=dialog().getByRole('region',{name:'Share link'}).or(dialog().locator('pre')).first();await link.waitFor();
 const created=writes()[0].body;assert.deepEqual(created.sections,['overview','events']);
 const days=(Date.parse(created.expiresAt)-Date.now())/864e5;assert.ok(days>29.9&&days<=30,'Links expire in 30 days.');
 const url=new URL((await link.innerText()).trim());assert.equal(url.pathname,'/share/websites/'+share);assert.equal(url.hash.slice(1),created.token);
 await btn('Copy link').waitFor();await btn('Revoke link').click();await dialog().getByText('Link revoked. It stops working on its next read.',{exact:true}).waitFor();
 assert.equal(writes().length,2);assert.ok(writes()[1].path.endsWith('/'+share+'/revoke'));
 pass('Share → Create link makes one 30-day overview/events link; Copy and Revoke sit beside it');

 await fresh();await btn('Share').click();state.mode='unknown';await btn('Create link').click();await btn('Retry').waitFor();
 state.mode='ok';await btn('Retry').click();await btn('Revoke link').waitFor();
 assert.equal(writes().length,2);assert.equal(writes()[1].raw,writes()[0].raw,'Retry sends exactly the same request.');
 pass('An unconfirmed create retries the identical request and never mints a second link');

 await fresh({role:'viewer'});assert.equal(await btn('Share').count(),0);pass('Viewers do not get Share');

 await fresh({width:320});await btn('Share').click();await dialog().waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),320,'The share dialog fits a 320px screen.');pass('Share dialog fits 320px');

 assert.deepEqual(evidence.external,[]);assert.deepEqual(evidence.errors,[]);evidence.phase='passed';
}
const watchdog=setTimeout(()=>{console.error('Quick share browser exceeded 120 seconds including cleanup');process.exit(1);},120000);
let timer;
try{await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Quick share check exceeded its 100 second work gate')),100000);})]);}
catch(error){evidence.phase='failed';evidence.failure={message:error.message,stack:error.stack};process.exitCode=1;console.error(error);}
finally{clearTimeout(timer);for(const close of [()=>context?.close(),()=>browser?.close(),()=>server?.close()]){try{await close();}catch{process.exitCode=1;}}save();clearTimeout(watchdog);}
