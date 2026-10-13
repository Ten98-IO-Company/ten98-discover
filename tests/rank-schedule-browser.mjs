// TEN98_RANK_SCHEDULE_BROWSER=1 node tests/rank-schedule-browser.mjs
// Optional PLAYWRIGHT_MODULE/PLAYWRIGHT_CHANNEL selects installed tooling; no downloads.
// Real component/router, synthetic intercepted HTTP only. No DB/provider/user preview.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
assert.equal(process.env.TEN98_RANK_SCHEDULE_BROWSER,'1');
const pid='20000000-0000-4000-8000-000000000001',otherPid='20000000-0000-4000-8000-000000000002',uid='30000000-0000-4000-8000-000000000001',tid='50000000-0000-4000-8000-000000000001',qid='80000000-0000-4000-8000-000000000001';
const path='/api/projects/'+pid+'/rank-trackers/'+tid+'/schedule',at='2026-10-13T00:00:00.000Z';
const blank=()=>({enabled:false,approvalStale:true,interval:'manual',timezone:null,hour:null,minute:null,weekday:null,nextDueAt:null,approval:null,staleReasons:['disabled']});
let schedule=blank(),revision=2,role='owner',quoteStart=true,expires=new Date(Date.now()+300000).toISOString(),nextWrite=null,nextRead=null,held=null,approvals=0,disables=0;
const receipts=new Map(),posts=[],errors=[],external=[];
const data=()=>({role,trackerId:tid,authoredRevision:revision,canManage:role==='owner',schedule:structuredClone(schedule)});
const quote=()=>({role,run:{id:qid,trackerId:tid,status:'quoted',method:'queued',trigger:'manual',isSubset:false,startedAt:null,canStart:quoteStart,expiresAt:expires,estimateUsd:'0.004000',taskCount:2,target:{domain:'example.com',locationCode:2840,languageCode:'en',depth:10,maxCrawlPages:1},quotedTasks:[1,2].map(n=>({keywordId:'60000000-0000-4000-8000-'+String(n).padStart(12,'0'),keyword:'literal C++ %20 '+n,device:'mobile',maximumUsd:'0.002000'}))}});
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'private/rank-schedule-vite-cache',appType:'custom',server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url!=='/'&&req.url!=='/elsewhere')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Schedule synthetic acceptance</title><div id="root"></div><script type="module" src="/tests/rank-schedule-browser-fixture.tsx"></script></html>');});
let browser;
try{
 await server.listen();const address=server.httpServer.address();assert.equal(address.address,'127.0.0.1');const origin='http://127.0.0.1:'+address.port;
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({...process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{},headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const reply=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin){external.push(url.origin);return route.abort();}if(!url.pathname.startsWith('/api/'))return req.method()==='GET'?route.continue():route.abort();
  if(req.method()==='GET'){
   let body;if(url.pathname===path)body=data();else if(url.pathname==='/api/projects/'+pid+'/rank-checks/'+qid)body=quote();else if(url.pathname==='/api/projects/'+otherPid+'/rank-trackers/'+tid+'/schedule')body={...data(),role:'viewer',canManage:false,schedule:blank()};else{external.push(url.pathname);return reply(route,{error:'Unknown route'},404);}
   const mode=nextRead;nextRead=null;if(mode==='hold'){held={route,body};return;}if(typeof mode==='number')return reply(route,{error:'Synthetic schedule access lost'},mode);return reply(route,body);
  }
  assert.equal(req.method(),'POST');const body=req.postDataJSON();posts.push({path:url.pathname,body:structuredClone(body)});
  if(url.pathname===path+'/preview'){
   const now=Math.floor(Date.now()/1000)*1000,offset=body.timezone==='Asia/Kolkata'?19800:0,local=new Date(now+offset*1000);
   // Only the two fixed-offset zones used by this fixture; actual calendar/DST
   // correctness is tested against PostgreSQL in the schedule integration suite.
   assert.ok(['UTC','Asia/Kolkata'].includes(body.timezone));
   const candidates=Array.from({length:body.interval==='monthly'?6:40},(_,n)=>Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+(body.interval==='monthly'?n+1:0),body.interval==='monthly'?0:local.getUTCDate()+n,body.hour,body.minute)-offset*1000);
   const occurrences=candidates.filter(time=>time>now&&(body.interval!=='weekly'||new Date(time+offset*1000).getUTCDay()===body.weekday)).slice(0,5).map(time=>({utc:new Date(time).toISOString(),local:new Date(time+offset*1000).toISOString().slice(0,19),offsetSeconds:offset}));assert.equal(occurrences.length,5);
   return reply(route,{capturedAt:new Date(now).toISOString(),timezone:body.timezone,occurrences});
  }
  assert.ok([path+'/approve',path+'/disable'].includes(url.pathname));const mode=nextWrite;nextWrite=null;if([403,409,429,408].includes(mode))return reply(route,{error:'Synthetic request rejection'},mode);
  const prior=receipts.get(body.requestId);if(prior)assert.deepEqual(prior,{path:url.pathname,body});else{assert.equal(body.revision,revision);if(url.pathname.endsWith('/approve')){approvals++;assert.equal(body.quoteId,qid);const approvedAt=new Date().toISOString();schedule={enabled:true,approvalStale:false,interval:body.interval,timezone:body.timezone,hour:body.hour,minute:body.minute,weekday:body.weekday,nextDueAt:new Date(Date.now()+86400000).toISOString(),approval:{id:randomUUID(),approvedAt,approvedByUserId:uid,maximumUsd:body.maximumUsd,connectionId:'40000000-0000-4000-8000-000000000001',connectionName:'Synthetic <script>connection</script>'},staleReasons:[]};}else{disables++;schedule={...schedule,enabled:false,nextDueAt:null,approvalStale:true,staleReasons:['disabled']};}revision++;receipts.set(body.requestId,{path:url.pathname,body:structuredClone(body)});}
  const output={...data(),replayed:!!prior};if(mode==='drop')return route.abort('failed');if(mode===503)return reply(route,{error:'Synthetic lost acknowledgement'},503);if(mode==='hold'){held={route,body:output};return;}if(mode==='malformed')output.schedule.approval.maximumUsd='broken';if(mode==='missing-ack')delete output.replayed;return reply(route,output);
 });
 const preview=()=>page.getByRole('button',{name:'Preview occurrences',exact:true}),approve=()=>page.getByRole('button',{name:'Approve recurring spend',exact:true}),retry=()=>page.getByRole('button',{name:'Retry same request',exact:true});
 const consent=()=>page.getByLabel('I approve recurring provider charges up to this ceiling per occurrence.',{exact:true});
 const ready=async()=>{await page.getByLabel('Timezone',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('fieldset')?.disabled);};
 await page.goto(origin);await ready();assert.equal(posts.length,0);assert.equal(await approve().isDisabled(),true);await page.getByLabel('Hour',{exact:true}).fill('10');await page.getByLabel('Timezone',{exact:true}).fill('Asia/Kolkata');
 await preview().click();await page.getByRole('heading',{name:'Next five occurrences',exact:true}).waitFor();assert.equal(approvals,0);await page.getByText('+05:30',{exact:true}).first().waitFor();await consent().check();assert.equal(await approve().isEnabled(),true);await page.getByLabel('Minute',{exact:true}).fill('15');assert.equal(await consent().isChecked(),false);assert.equal(await page.getByRole('heading',{name:'Next five occurrences',exact:true}).count(),0);
 await preview().click();await page.getByRole('heading',{name:'Next five occurrences',exact:true}).waitFor();await consent().check();await page.getByLabel('Per-occurrence ceiling (USD)',{exact:true}).fill('0.010000');assert.equal(await consent().isChecked(),false);await consent().check();assert.equal(await approve().isEnabled(),true);
 console.log('PASS explicit free preview, exact target/ceiling, local offset and consent invalidation without automatic approval.');
 nextWrite=503;await approve().click();await retry().waitFor();const frozen=structuredClone(posts.at(-1));expires=new Date(Date.now()-1000).toISOString();assert.equal(await page.getByRole('button',{name:'Back to quote',exact:true}).isDisabled(),true);await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/');
 for(const mode of [408,429,'malformed','missing-ack']){nextWrite=mode;await retry().click();await retry().waitFor();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Retry same request')?.disabled);assert.deepEqual(posts.at(-1),frozen);}
 await retry().click();await page.getByText(/original request receipt was recovered/).waitFor();assert.deepEqual(posts.at(-1),frozen);assert.equal(approvals,1);assert.equal(await page.getByRole('heading',{name:'Rank schedule',exact:true}).evaluate(e=>e===document.activeElement),true);
 console.log('PASS503/408/429/malformed nested2xx/missing acknowledgement retain identical approval after expiry; navigation stays blocked.');
 page.once('dialog',d=>d.accept());nextWrite='drop';await page.getByRole('button',{name:'Disable schedule',exact:true}).click();await retry().waitFor();const revoke=structuredClone(posts.at(-1));await retry().click();await page.getByText('Schedule disabled',{exact:true}).waitFor();assert.deepEqual(posts.at(-1),revoke);assert.equal(disables,1);
 console.log('PASS disabling has explicit confirmation and immutable lost-ack recovery with no new approval.');
 expires=new Date(Date.now()+300000).toISOString();quoteStart=false;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Prepare full queued quote',exact:true}).waitFor();assert.equal(await page.getByText(/This quote expired/).count(),0);
 quoteStart=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await ready();await preview().click();await page.getByRole('heading',{name:'Next five occurrences',exact:true}).waitFor();await consent().check();nextWrite=409;await approve().click();await page.getByText(/tracker changed/i).waitFor();assert.equal(await approve().isDisabled(),true);assert.equal(await retry().count(),0);page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Refresh',exact:true}).click();await ready();
 console.log('PASS another owner’s quote is unavailable rather than expired; authored conflict requires explicit reload.');
 role='viewer';await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText(/Only workspace owners/).waitFor();assert.equal(await consent().count(),0);assert.equal(await page.getByRole('button',{name:'Disable schedule',exact:true}).count(),0);
 role='owner';await page.getByRole('button',{name:'Refresh',exact:true}).click();await ready();nextRead=403;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Synthetic schedule access lost',{exact:true}).waitFor();assert.equal(await page.getByLabel('Timezone',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await ready();nextRead='hold';await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForTimeout(40);assert.ok(held);const stale=held;held=null;await page.evaluate(id=>window.rankScheduleHarness.scope({projectId:id}),otherPid);await page.getByText(/Only workspace owners/).waitFor();await reply(stale.route,{error:'Stale expired session'},401);assert.equal(await page.getByRole('heading',{name:'Fixture signed out',exact:true}).count(),0);assert.equal(await consent().count(),0);
 console.log('PASS live viewer/access-loss purge and cross-project stale401 cannot restore owner forms or sign out the new scope.');
 await page.evaluate(id=>window.rankScheduleHarness.scope({projectId:id}),pid);await ready();await page.getByLabel('Interval',{exact:true}).selectOption('monthly');await preview().click();await page.getByRole('heading',{name:'Next five occurrences',exact:true}).waitFor();await mkdir(resolve('private/rank-schedule-evidence'),{recursive:true});await page.screenshot({path:resolve('private/rank-schedule-evidence/schedule-1440.png'),fullPage:true});
 await page.setViewportSize({width:360,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.ok((await approve().boundingBox()).height>=44);assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[aria-describedby]')].every(e=>e.getAttribute('aria-describedby').split(/\s+/).every(id=>document.getElementById(id)))),true);await page.screenshot({path:resolve('private/rank-schedule-evidence/schedule-360.png'),fullPage:true});
 page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Back to quote',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Rank schedule',exact:true}).waitFor();page.once('dialog',d=>d.accept());await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Fixture quote',exact:true}).waitFor();
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS1440/360px layout, labelled hints, month-end setup and keyboard dirty-back confirmation; no external requests.');
}finally{await browser?.close();await server.close();}
