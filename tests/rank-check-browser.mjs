// TEN98_RANK_CHECK_BROWSER=1 node tests/rank-check-browser.mjs
// Optional PLAYWRIGHT_MODULE / PLAYWRIGHT_CHANNEL selects installed tooling; no downloads.
// Actual RouterProvider + production components, synthetic intercepted API only. No database/provider calls.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
assert.equal(process.env.TEN98_RANK_CHECK_BROWSER,'1');
const pid='20000000-0000-4000-8000-000000000001',cid='40000000-0000-4000-8000-000000000001',tid='50000000-0000-4000-8000-000000000001';
const base='/api/projects/'+pid,trackerPath=base+'/rank-trackers/'+tid,at='2026-10-13T09:00:00.000Z';
const tracker={id:tid,name:'Synthetic paid-check tracker',domain:'example.com',countryCode:2840,countryIso:'US',locationCode:2840,locationName:'United States',locationType:'Country',languageCode:'en',languageName:'English',devices:'mobile',depth:10,maxCrawlPages:1,revision:2,keywordsRevision:3,authoredRevision:7,keywordCount:2,archivedAt:null,createdAt:at,updatedAt:at,schedule:{interval:'manual',enabled:false,nextDueAt:null}};
const keywords=[{id:'60000000-0000-4000-8000-000000000001',keyword:'literal C++ %20',matchCase:true,pinnedAt:null,createdAt:at},{id:'60000000-0000-4000-8000-000000000002',keyword:'ordinary term',matchCase:false,pinnedAt:null,createdAt:at}];
const connection={id:cid,name:'Synthetic DataForSEO',checkStatus:'ok'},target={domain:'example.com',locationCode:2840,languageCode:'en',depth:10,maxCrawlPages:1};
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'private/rank-check-vite-cache',appType:'custom',server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url!=='/'&&req.url!=='/elsewhere')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rank check synthetic acceptance</title><div id="root"></div><script type="module" src="/tests/rank-tracking-browser-fixture.tsx"></script></html>');});
let browser;
try{
 await server.listen();const address=server.httpServer.address();assert.equal(address.address,'127.0.0.1');const origin='http://127.0.0.1:'+address.port;
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({...process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{},headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(10000);
 const errors=[],external=[],calls=[],posts=[],runs=new Map(),receipts=new Map();let role='owner',vault=true,nextWrite=null,nextRead=null,held=null,starts=0;
 const scheduleReceipts=new Set();let scheduleRevision=tracker.authoredRevision,schedule={enabled:false,approvalStale:false,interval:'manual',timezone:null,hour:null,minute:null,weekday:null,nextDueAt:null,approval:null,staleReasons:[]};
 const scheduleEnvelope=(replayed)=>({role,trackerId:tid,authoredRevision:scheduleRevision,canManage:role==='owner',schedule:structuredClone(schedule),...(replayed===undefined?{}:{replayed})});
 const reply=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
 const detail=()=>({role,tracker,keywords}),envelope=(id,replayed)=>({role,run:structuredClone(runs.get(id)),...(replayed===undefined?{}:{replayed})});
 const summary=r=>{const {id,status,trigger,scheduledFor,method,isSubset,taskCount,createdAt,startedAt,completedAt,quoteExpired,rawExpiredAt,dataExpiredAt,costStatus,estimateUsd,knownChargeUsd,diagnostic}=r;return {id,status,trigger,scheduledFor,method,isSubset,taskCount,createdAt,startedAt,completedAt,quoteExpired,rawExpiredAt,dataExpiredAt,costStatus,estimateUsd,knownChargeUsd,diagnostic};};
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(url.origin!==origin){external.push(url.origin);return route.abort();}
  if(!path.startsWith('/api/'))return req.method()==='GET'?route.continue():route.abort();
  calls.push({path,method:req.method()});
  if(req.method()==='GET'){
   let data;if(path===base+'/rank-trackers')data={role,vaultConfigured:vault,connections:vault?[connection]:[],trackers:[tracker],nextCursor:null};
   else if(path===trackerPath)data=detail();
   else if(path===trackerPath+'/schedule')data=scheduleEnvelope();
   else if(path===trackerPath+'/runs')data={role,trackerId:tid,runs:[...runs.values()].map(summary).reverse(),nextCursor:null};
   else if(path===trackerPath+'/results'){
    data={role,trackerId:tid,target,enabledDevices:'mobile',asOf:at,rows:[{keywordId:keywords[0].id,keyword:keywords[0].keyword,matchCase:true,pinnedAt:null,device:'mobile',latestAttempt:null,latestObservation:null,observationStatus:'not_checked',baselines:[1,7,30,90].map(days=>({days,targetAt:at,source:'unavailable',observation:null,change:null}))}],nextCursor:null};
   }else if(path===trackerPath+'/keywords/'+keywords[0].id+'/history'){
    const r=[...runs.values()][0];data={role,trackerId:tid,target,enabledDevices:'mobile',keyword:{id:keywords[0].id,keyword:keywords[0].keyword,matchCase:true,removed:false},observations:[{...r.tasks[0],taskId:r.tasks[0].id,runId:r.id,runStatus:r.status,isSubset:r.isSubset,compatible:true,target,attemptedAt:r.startedAt}],nextCursor:null};
   }
   else if(path.startsWith(base+'/rank-checks/'))data=envelope(path.split('/').at(-1));
   else{external.push(path);return reply(route,{error:'Unknown synthetic route'},404);}
   if(nextRead){const mode=nextRead;nextRead=null;if(mode==='hold'){held={route,data:structuredClone(data)};return;}return reply(route,{error:'Synthetic access lost'},mode);}
   return reply(route,data);
  }
  assert.equal(req.method(),'POST');const body=req.postDataJSON();posts.push({path,body:structuredClone(body)});const mode=nextWrite;nextWrite=null;
  if([403,409,429].includes(mode))return reply(route,{error:'Synthetic request rejection'},mode);
  if(path===trackerPath+'/schedule/preview'){
   assert.equal(body.timezone,'UTC');const capturedAt=new Date().toISOString();return reply(route,{capturedAt,timezone:'UTC',occurrences:[1,2,3,4,5].map(days=>{const utc=new Date(Date.parse(capturedAt)+days*86400000);utc.setUTCMilliseconds(0);return {utc:utc.toISOString(),local:utc.toISOString().slice(0,19),offsetSeconds:0};})});
  }
  if(path===trackerPath+'/schedule/approve'||path===trackerPath+'/schedule/disable'){
   const replayed=scheduleReceipts.has(body.requestId);if(!replayed){assert.equal(role,'owner');assert.equal(body.revision,scheduleRevision);scheduleRevision++;
    if(path.endsWith('/approve')){const q=runs.get(body.quoteId);assert.equal(q.status,'quoted');assert.equal(q.method,'queued');assert.equal(q.isSubset,false);const approvedAt=new Date().toISOString();schedule={enabled:true,approvalStale:false,interval:body.interval,timezone:body.timezone,hour:body.hour,minute:body.minute,weekday:body.weekday,nextDueAt:new Date(Date.parse(approvedAt)+86400000).toISOString(),approval:{id:randomUUID(),approvedAt,approvedByUserId:'30000000-0000-4000-8000-000000000001',maximumUsd:body.maximumUsd,connectionId:cid,connectionName:connection.name},staleReasons:[]};}
    else schedule={...schedule,enabled:false,nextDueAt:null};scheduleReceipts.add(body.requestId);
   }
   const data=scheduleEnvelope(replayed);if(mode==='drop')return route.abort('failed');if(mode==='hold'){held={route,data};return;}return reply(route,data);
  }
  const prior=receipts.get(body.requestId);let id=prior??path.split('/').at(-2),reconciliation;
  if(!prior){
   if(path===trackerPath+'/quote'){
    assert.equal(body.revision,tracker.revision);assert.equal(body.keywordsRevision,tracker.keywordsRevision);assert.equal(body.connectionId,cid);
    const captured=keywords.filter(k=>!body.keywordIds||body.keywordIds.includes(k.id));id=randomUUID();
    runs.set(id,{id,trackerId:tid,status:'quoted',trigger:'manual',scheduledFor:null,method:body.method,isSubset:!!body.keywordIds,target,connectionName:connection.name,taskCount:captured.length,dispatchCount:1,estimateUsd:captured.length===2?'0.004000':'0.002000',knownChargeUsd:'0.000000',costStatus:'not_started',createdAt:new Date(Date.now()+runs.size).toISOString(),startedAt:null,completedAt:null,priceAsOf:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),quoteExpired:false,canStart:role!=='viewer',canCancel:false,diagnostic:null,rawExpiredAt:null,dataExpiredAt:null,quotedTasks:captured.map(k=>({keywordId:k.id,keyword:k.keyword,device:'mobile',maximumUsd:'0.002000'})),dispatches:[],tasks:[]});
   }else{
    const run=runs.get(id);assert.ok(run,'Mutation targets a real captured run');
    if(path.endsWith('/start')){starts++;run.status='queued';run.costStatus='pending';run.startedAt=new Date().toISOString();run.canStart=false;run.canCancel=true;run.tasks=run.quotedTasks.map(t=>({...t,id:randomUUID(),matchCase:false,status:'pending',position:null,rankBasis:null,absolutePosition:null,rankingUrl:null,serpFeatures:null,checkedDepth:null,returnedItemCount:null,observedAt:null,retrievedAt:null,diagnostic:null,rawExpiredAt:null,dataExpiredAt:null}));run.quotedTasks=[];run.dispatches=[{id:randomUUID(),ordinal:0,phase:'reserved',taskCount:run.taskCount,dispatchedAt:null,completedAt:null,diagnostic:null,costStatus:'reserved',estimateUsd:run.estimateUsd,actualUsd:null,canReconcile:false}];}
    else if(path.endsWith('/cancel')){run.status='cancelled';run.costStatus='final';run.canCancel=false;run.completedAt=new Date().toISOString();run.tasks.forEach(t=>{t.status='cancelled';});run.dispatches.forEach(d=>{d.phase='cancelled';d.costStatus='cancelled';});}
    else if(path.endsWith('/reconcile')){assert.equal(role,'owner');assert.equal(body.connectionId,cid);assert.ok(run.dispatches.some(d=>d.id===body.dispatchId&&d.canReconcile));run.status='completed';run.costStatus='final';run.knownChargeUsd='0.002000';run.completedAt=new Date().toISOString();run.dispatches.forEach(d=>{d.phase='finished';d.costStatus='settled';d.actualUsd='0.002000';d.canReconcile=false;});run.tasks.forEach((t,i)=>{Object.assign(t,{status:i===0?'ranked':'not_found',position:i===0?3:null,rankBasis:i===0?'organic':null,rankingUrl:i===0?'https://example.com/<script>alert(1)</script>':null,checkedDepth:10,returnedItemCount:12,serpFeatures:[],observedAt:at,retrievedAt:at});});}
    else throw new Error('Unexpected mutation '+path);
   }
   receipts.set(body.requestId,id);
  }
  if(path.endsWith('/reconcile'))reconciliation={status:'matched',message:'Matched the saved provider evidence. Spending remains paused.',replayed:!!prior};
  let data=envelope(id,path.endsWith('/cancel')?undefined:!!prior);if(reconciliation)data.reconciliation=reconciliation;
  if(mode==='drop')return route.abort('failed');
  if(mode==='hold'){held={route,data};return;}
  if(mode==='malformed')data.run.tasks=[{}];
  if(mode==='wrong-pair')data.run.quotedTasks[0].keywordId=keywords[1].id;
  if(mode==='missing-ack')delete data.replayed;
  return reply(route,data,path.endsWith('/start')?202:200);
 });
 page.on('pageerror',e=>errors.push(e.message));
 const openTracker=async()=>{await page.getByRole('button',{name:tracker.name,exact:true}).click();await page.getByRole('heading',{name:tracker.name,exact:true}).waitFor();};
 const prepare=async()=>{await page.getByRole('button',{name:'Prepare a rank check',exact:true}).click();await page.getByLabel('DataForSEO connection',{exact:true}).selectOption(cid);};
 await page.goto(origin);await openTracker();await prepare();assert.equal(posts.length,0);
 await page.getByRole('button',{name:'Prepare quote',exact:true}).click();await page.getByRole('heading',{name:'Review the maximum charge',exact:true}).waitFor();
 assert.equal(posts.length,1);assert.equal(starts,0);assert.equal(await page.getByText('$0.004000',{exact:true}).count(),1);const runId=[...runs.keys()][0];
 assert.equal(await page.getByRole('region',{name:'Quoted keyword and device costs'}).getByText('literal C++ %20',{exact:true}).count(),1);
 console.log('PASS explicit free quote, paid revision binding, immutable literal inputs and exact maximum review.');
 nextWrite='drop';await page.getByRole('button',{name:'Start paid rank check',exact:true}).click();await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();const start=structuredClone(posts.at(-1));
 runs.get(runId).expiresAt=new Date(Date.now()-1000).toISOString();
 await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/');
 nextWrite=429;await page.getByRole('button',{name:'Retry same request',exact:true}).click();await page.getByText(/The retry was rate limited/).waitFor();assert.deepEqual(posts.at(-1),start);
 nextWrite='malformed';await page.getByRole('button',{name:'Retry same request',exact:true}).click();await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();assert.deepEqual(posts.at(-1),start);
 nextWrite='missing-ack';await page.getByRole('button',{name:'Retry same request',exact:true}).click();await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();assert.deepEqual(posts.at(-1),start);
 await page.getByRole('button',{name:'Retry same request',exact:true}).click();await page.getByRole('heading',{name:'Rank check result',exact:true}).waitFor();assert.deepEqual(posts.at(-1),start);assert.equal(starts,1);assert.equal(await page.getByRole('heading',{name:'Rank check result',exact:true}).evaluate(e=>e===document.activeElement),true);
 console.log('PASS paid lost-ack,429,malformed nested2xx and absent acknowledgement retry identical body after quote expiry; one dispatch.');
 nextRead='hold';await page.getByRole('button',{name:'Refresh check',exact:true}).click();await page.waitForTimeout(40);assert.ok(held);const oldRead=held;held=null;
 page.once('dialog',d=>d.accept());nextWrite='hold';await page.getByRole('button',{name:'Cancel undispatched work',exact:true}).click();await page.waitForTimeout(40);assert.ok(held);
 await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/');assert.equal(await page.getByRole('button',{name:'Back to tracker',exact:true}).isDisabled(),true);
 await reply(held.route,held.data);held=null;await page.getByText('cancelled',{exact:true}).first().waitFor();await reply(oldRead.route,oldRead.data);assert.equal(await page.getByRole('button',{name:'Cancel undispatched work',exact:true}).count(),0);
 console.log('PASS cancel interrupts held read, never active write; stale GET cannot restore cancelled work.');
 const current=runs.get(runId);current.status='partial';current.costStatus='uncertain';current.tasks.forEach(t=>t.status='uncertain');current.dispatches.forEach(d=>{d.phase='uncertain';d.costStatus='uncertain';d.canReconcile=true;d.dispatchedAt=at;});
 await page.getByRole('button',{name:'Refresh check',exact:true}).click();await page.getByText(/Some charges are unresolved/).waitFor();await page.getByText('Known charges $0.000000',{exact:true}).waitFor();assert.equal(await page.getByText('Unconfirmed',{exact:true}).count(),1);
 await page.getByLabel('Recovery DataForSEO connection',{exact:true}).selectOption(cid);nextWrite='drop';await page.getByRole('button',{name:'Recover Request 1',exact:true}).click();await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();const recovery=structuredClone(posts.at(-1));
 await page.getByRole('button',{name:'Retry same request',exact:true}).click();await page.getByText(/Spending remains paused/).waitFor();assert.deepEqual(posts.at(-1),recovery);assert.equal(starts,1);await page.getByText('Organic rank 3',{exact:true}).waitFor();await page.getByText('Not found in observed coverage',{exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:/example.com/}).count(),0);
 console.log('PASS owner-only explicit free recovery, unknown≠zero cost and plain result URL; no paid resend or unpause.');
 const observed=structuredClone(current.tasks[0]);Object.assign(current.tasks[0],{dataExpiredAt:at,position:null,rankBasis:null,absolutePosition:null,rankingUrl:null,serpFeatures:null,checkedDepth:null,returnedItemCount:null});
 await page.getByRole('button',{name:'Refresh check',exact:true}).click();await page.getByRole('region',{name:'Rank observations'}).getByText('Expired',{exact:true}).first().waitFor();current.tasks[0]=observed;
 await page.getByRole('button',{name:'Refresh check',exact:true}).click();await page.getByRole('button',{name:'Refresh check',exact:true}).waitFor();await page.waitForTimeout(60);assert.equal(await page.getByText('Organic rank 3',{exact:true}).count(),0);
 current.dataExpiredAt=at;current.tasks.forEach(t=>Object.assign(t,{dataExpiredAt:at,position:null,rankBasis:null,absolutePosition:null,rankingUrl:null,serpFeatures:null,checkedDepth:null,returnedItemCount:null}));
 await page.getByRole('button',{name:'Refresh check',exact:true}).click();await page.getByText(/Rank observations expired under workspace retention/).waitFor();await page.getByText('Known charges $0.002000',{exact:true}).waitFor();
 console.log('PASS individual and run expiry remain unavailable while original financial receipt remains.');
 await page.getByRole('button',{name:'Back to tracker',exact:true}).click();await page.getByRole('heading',{name:tracker.name,exact:true}).waitFor();await page.getByLabel('Select literal C++ %20',{exact:true}).check();await page.getByRole('button',{name:'Check selected keywords',exact:true}).click();await page.getByLabel('DataForSEO connection',{exact:true}).selectOption(cid);
 nextWrite='wrong-pair';await page.getByRole('button',{name:'Prepare quote',exact:true}).click();await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();const subset=structuredClone(posts.at(-1));assert.deepEqual(subset.body.keywordIds,[keywords[0].id]);
 await page.getByRole('button',{name:'Retry same request',exact:true}).click();await page.getByRole('heading',{name:'Review the maximum charge',exact:true}).waitFor();assert.deepEqual(posts.at(-1),subset);assert.equal(await page.getByRole('region',{name:'Quoted keyword and device costs'}).getByText('ordinary term',{exact:true}).count(),0);
 const subsetRun=[...runs.values()].at(-1);subsetRun.expiresAt=new Date(Date.now()-1).toISOString();subsetRun.quoteExpired=true;subsetRun.canStart=false;await page.getByRole('button',{name:'Refresh quote',exact:true}).click();await page.getByText(/This quote expired/).waitFor();assert.equal(await page.getByRole('button',{name:'Start paid rank check',exact:true}).isDisabled(),true);
 console.log('PASS subset keyword/device binding rejects a malformed quote acknowledgement; expired new start remains disabled.');
 await page.getByRole('button',{name:'Back to tracker',exact:true}).click();await page.getByRole('button',{name:'Check history',exact:true}).click();await page.getByRole('heading',{name:'Rank check history',exact:true}).waitFor();
 role='viewer';await page.getByRole('button',{name:'Refresh checks',exact:true}).click();await page.waitForTimeout(50);assert.equal(await page.getByRole('button',{name:'Prepare a rank check',exact:true}).count(),0);
 await page.getByRole('region',{name:'Rank check history',exact:true}).getByRole('button').last().click();await page.getByText('Known charges $0.002000',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:/Recover Request|Cancel undispatched/}).count(),0);
 nextRead='hold';await page.getByRole('button',{name:'Refresh check',exact:true}).click();await page.waitForTimeout(30);const stale=held;held=null;nextRead=403;await page.getByRole('button',{name:'Refresh check',exact:true}).click();await page.getByText('Synthetic access lost',{exact:true}).waitFor();await reply(stale.route,stale.data);assert.equal(await page.getByRole('region',{name:'Rank observations'}).count(),0);
 console.log('PASS history reopening, live viewer authority and403 purge defeat stale simultaneous reads.');
 role='owner';await page.reload();await openTracker();await prepare();await page.getByRole('button',{name:'Prepare quote',exact:true}).click();await page.getByRole('heading',{name:'Review the maximum charge',exact:true}).waitFor();
 await mkdir(resolve('private/rank-check-evidence'),{recursive:true});await page.setViewportSize({width:360,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);const box=await page.getByRole('button',{name:'Start paid rank check',exact:true}).boundingBox();assert.ok(box.height>=44);
 await page.screenshot({path:resolve('private/rank-check-evidence/quote-360.png'),fullPage:true});await page.getByRole('button',{name:'Back to tracker',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:tracker.name,exact:true}).waitFor();
 await page.getByRole('button',{name:'Check history',exact:true}).click();await page.getByRole('region',{name:'Rank check history',exact:true}).getByRole('button').last().waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.getByRole('region',{name:'Rank check history',exact:true}).getByRole('button').last().click();await page.getByText('Known charges $0.002000',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:resolve('private/rank-check-evidence/result-360.png'),fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(starts,1);assert.equal(calls.some(c=>c.path.endsWith('/catalog')),false);
 console.log('PASS360px quote/history/result layouts,44px paid action, keyboard Back and zero external/provider traffic.');
 await page.getByRole('button',{name:'Back to tracker',exact:true}).click();await page.getByRole('button',{name:'Latest observations',exact:true}).click();await page.getByRole('button',{name:'literal C++ %20',exact:true}).waitFor();
 await page.getByLabel('Keyword contains',{exact:true}).fill('literal');await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.getByRole('button',{name:'literal C++ %20',exact:true}).click();await page.getByRole('region',{name:'Keyword rank history',exact:true}).getByRole('button').first().waitFor();
 await page.getByRole('region',{name:'Keyword rank history',exact:true}).getByRole('button').first().click();await page.getByText('Known charges $0.002000',{exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Keyword rank history',exact:true}).count(),0,'Inactive history hidden during run drilldown');
 await page.getByRole('button',{name:'Back to observations',exact:true}).click();await page.getByText('Observations expired',{exact:true}).waitFor();await page.waitForFunction(()=>document.activeElement?.id.endsWith('history-heading'));assert.equal(await page.getByRole('heading',{name:'Keyword rank history',exact:true}).evaluate(e=>e===document.activeElement),true);
 await page.getByRole('button',{name:'Latest observations',exact:true}).click();await page.getByRole('button',{name:'literal C++ %20',exact:true}).waitFor();assert.equal(await page.getByLabel('Keyword contains',{exact:true}).inputValue(),'literal');
 console.log('PASS integrated latest→keyword→scoped run→Back preserves history context, applied filters, expiry and focus.');
 await page.getByRole('button',{name:'Back to tracker',exact:true}).click();await page.getByRole('heading',{name:tracker.name,exact:true}).waitFor();
 const skippedId=randomUUID();runs.set(skippedId,{...structuredClone(current),id:skippedId,status:'skipped',trigger:'scheduled',scheduledFor:'2026-10-13T11:00:00.000Z',createdAt:'2026-10-13T11:00:01.000Z',startedAt:null,completedAt:'2026-10-13T11:00:01.000Z',taskCount:0,dispatchCount:0,estimateUsd:'0.000000',knownChargeUsd:'0.000000',costStatus:'not_started',priceAsOf:null,expiresAt:null,quoteExpired:false,canStart:false,canCancel:false,diagnostic:'The scheduled check was skipped because provider prices were unavailable.',rawExpiredAt:null,dataExpiredAt:null,quotedTasks:[],dispatches:[],tasks:[]});
 await page.getByRole('button',{name:'Check history',exact:true}).click();await page.getByRole('region',{name:'Rank check history',exact:true}).getByText('No quote applied · Known charges $0.000000',{exact:true}).waitFor();await page.getByRole('region',{name:'Rank check history',exact:true}).getByRole('button').first().click();await page.getByText('No paid check started.',{exact:true}).waitFor();await page.getByText('No quote applied',{exact:true}).waitFor();await page.getByText(/Scheduled for/).waitFor();assert.equal(await page.getByText('Quoted maximum $0.000000',{exact:true}).count(),0);await page.getByText(/skipped because provider prices were unavailable/).waitFor();assert.equal(starts,1);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS skipped scheduled receipt shows due date and reason without inventing a zero-dollar quote or price evidence.');
 await page.getByRole('button',{name:'Back to tracker',exact:true}).click();await page.getByRole('heading',{name:tracker.name,exact:true}).waitFor();const beforeSchedule=posts.length;
 await page.getByRole('button',{name:'Schedule',exact:true}).click();await page.getByRole('button',{name:'Prepare full queued quote',exact:true}).waitFor();assert.equal(posts.length,beforeSchedule);assert.equal(starts,1);
 await page.getByRole('button',{name:'Prepare full queued quote',exact:true}).click();await page.getByLabel('DataForSEO connection',{exact:true}).selectOption(cid);assert.equal(await page.getByLabel('Retrieval method',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Prepare quote',exact:true}).click();await page.getByRole('button',{name:'Configure schedule',exact:true}).waitFor();const scheduleQuote=[...runs.values()].at(-1);assert.equal(posts.at(-1).body.method,'queued');assert.equal('keywordIds' in posts.at(-1).body,false);assert.equal(scheduleQuote.taskCount,2);assert.equal(await page.getByRole('button',{name:'Start paid rank check',exact:true}).count(),0);
 await page.getByRole('button',{name:'Configure schedule',exact:true}).click();await page.getByLabel('Timezone',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('fieldset')?.disabled);await page.getByRole('button',{name:'Preview occurrences',exact:true}).click();await page.getByRole('heading',{name:'Next five occurrences',exact:true}).waitFor();
 await page.getByLabel('I approve recurring provider charges up to this ceiling per occurrence.',{exact:true}).check();nextWrite='drop';await page.getByRole('button',{name:'Approve recurring spend',exact:true}).click();await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();const approval=structuredClone(posts.at(-1));assert.equal(approval.body.quoteId,scheduleQuote.id);
 assert.equal(await page.getByRole('button',{name:'Back to quote',exact:true}).isDisabled(),true);await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/');
 nextWrite=429;await page.getByRole('button',{name:'Retry same request',exact:true}).click();await page.getByText(/retry was rate limited/).waitFor();assert.deepEqual(posts.at(-1),approval);
 await page.getByRole('button',{name:'Retry same request',exact:true}).click();await page.getByText(/original request receipt was recovered/).waitFor();assert.deepEqual(posts.at(-1),approval);assert.equal(scheduleReceipts.size,1);assert.equal(starts,1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:resolve('private/rank-check-evidence/schedule-360.png'),fullPage:true});
 const beforeReturn=calls.filter(c=>c.path===base+'/rank-checks/'+scheduleQuote.id).length;await page.getByRole('button',{name:'Back to quote',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Review the maximum charge',exact:true}).waitFor();assert.ok(calls.filter(c=>c.path===base+'/rank-checks/'+scheduleQuote.id).length>beforeReturn);assert.equal(await page.getByRole('button',{name:'Start paid rank check',exact:true}).count(),0);await page.waitForFunction(()=>document.activeElement?.id.endsWith('quote-heading'));
 await page.getByRole('button',{name:'Back to schedule',exact:true}).click();await page.getByRole('heading',{name:'Rank schedule',exact:true}).waitFor();await page.getByRole('button',{name:'Back to tracker',exact:true}).click();await page.getByRole('heading',{name:tracker.name,exact:true}).waitFor();
 console.log('PASS integrated schedule path forces a full queued quote, blocks immediate paid start, recovers identical approval through429 and returns to a freshly read quote with focus.');
 await prepare();await page.getByRole('button',{name:'Prepare quote',exact:true}).click();await page.getByRole('button',{name:'Set up recurring checks',exact:true}).waitFor();const manualQuote=[...runs.values()].at(-1),originalExpiry=manualQuote.expiresAt;
 await page.getByRole('button',{name:'Set up recurring checks',exact:true}).click();await page.getByLabel('Timezone',{exact:true}).waitFor();manualQuote.expiresAt=new Date(Date.now()+86400000).toISOString();await page.getByRole('button',{name:'Back to quote',exact:true}).click();await page.getByRole('button',{name:'Set up recurring checks',exact:true}).waitFor();
 const expiryCopy=await page.evaluate(value=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)),originalExpiry);assert.ok((await page.getByText(/Prices checked/).innerText()).includes(expiryCopy),'A fresh response must not extend the known quote expiry');
 await page.getByRole('button',{name:'Back to tracker',exact:true}).click();await prepare();await page.getByLabel('Retrieval method',{exact:true}).selectOption('live');await page.getByRole('button',{name:'Prepare quote',exact:true}).click();await page.getByRole('heading',{name:'Review the maximum charge',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Set up recurring checks',exact:true}).count(),0);
 await page.getByRole('button',{name:'Back to tracker',exact:true}).click();await page.getByLabel('Select literal C++ %20',{exact:true}).check();await page.getByRole('button',{name:'Check selected keywords',exact:true}).click();await page.getByLabel('DataForSEO connection',{exact:true}).selectOption(cid);await page.getByRole('button',{name:'Prepare quote',exact:true}).click();await page.getByRole('heading',{name:'Review the maximum charge',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Set up recurring checks',exact:true}).count(),0);
 await page.getByRole('button',{name:'Back to tracker',exact:true}).click();role='viewer';await page.getByRole('button',{name:'Schedule',exact:true}).click();await page.getByText(/Only workspace owners/).waitFor();assert.equal(await page.getByRole('button',{name:'Prepare full queued quote',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Approve recurring spend',exact:true}).count(),0);assert.equal(starts,1);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS manual full queued shortcut, immutable expiry across remounts, live/subset exclusion and current viewer read-only schedule.');
}finally{await browser?.close();await server.close();}
