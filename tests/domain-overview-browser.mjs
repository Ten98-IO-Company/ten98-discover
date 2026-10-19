// TEN98_DOMAIN_OVERVIEW_BROWSER=1 PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node tests/domain-overview-browser.mjs
// Real component + owned loopback Vite, synthetic API positives and negative faults.
// This is not native auth, provider, charge, CSV-service or compiled acceptance.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'vite';

assert.equal(process.env.TEN98_DOMAIN_OVERVIEW_BROWSER,'1');
const output=resolve('private/domain-overview-ui/browser/run-'+randomUUID().replaceAll('-','').slice(0,12));
const ids={connection:'40000000-0000-4000-8000-000000000001',run:'50000000-0000-4000-8000-000000000001',quote:'60000000-0000-4000-8000-000000000001'};
const at='2026-10-16T05:00:00.000Z',base='/api/projects/20000000-0000-4000-8000-000000000001/domain-research';
const metrics=(patch={})=>({rankedKeywords:10,estimatedTraffic:25.125,estimatedAdsValueUsd:1234567.123456789,rankDistribution:[0,null,2,1,0,0,0,0,0,0,0,0],...patch});
function request(report){return {connectionId:ids.connection,target:'example.com',scope:'subdomains',locationCode:2840,languageCode:'en',limit:report==='overview_v1'?1:25,...report?{report}:{}};}
function receipt(report,patch={}){return {id:ids.run,quoteId:ids.quote,request:request(report),status:'completed',createdAt:at,completedAt:at,estimateUsd:report==='overview_v1'?'0.010200':'0.015000',actualUsd:report==='overview_v1'?'0.010100':'0.012120',chargeStatus:'settled',canCancel:false,diagnostic:null,resultExpired:false,...patch};}
function result(report){const rows=report==='overview_v1'?[metrics()]:report==='pages_v1'?[{url:'https://example.com/guide',organic:metrics()}]:report==='competitors_v1'?[{domain:'competitor.example.org',sharedKeywords:0,averagePosition:null,fullDomain:metrics({estimatedTraffic:900}),targetOverlap:metrics({estimatedTraffic:3,estimatedAdsValueUsd:0})}]:[{keyword:'Synthetic keyword',position:1,searchVolume:null,estimatedTraffic:0,cpcUsd:null,keywordDifficulty:null,url:'https://example.com/guide',metricsUpdatedAt:null}];return {source:'DataForSEO Labs / Google',retrievedAt:at,target:'example.com',scope:'subdomains',locationCode:2840,languageCode:'en',...report?{report}:{},rows,returnedCount:rows.length,totalCount:report==='overview_v1'?1:101,limited:report!=='overview_v1'};}
function overview(role,run){return {role,vaultConfigured:true,spendingPaused:false,connections:[{id:ids.connection,name:'Synthetic saved connection',checkStatus:'ok'}],catalog:{updatedAt:at,markets:[{locationCode:2840,locationName:'United States',languageCode:'en',languageName:'English'}]},runs:run?[run]:[]};}
const checks=[],contexts=[],errors=[],external=[];
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'private/domain-overview-ui/vite-cache',appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Domain overview synthetic checks</title><div id="root"></div><script type="module" src="/tests/domain-overview-browser-fixture.tsx"></script></html>');});
let browser,origin;
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const idle=page=>page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Refresh receipts'&&!b.disabled));
async function open({report='overview_v1',role='owner',patchResult,detailFault,exportFault,startFault,holdDetail=false}={}){
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,serviceWorkers:'block'});contexts.push(context);
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const model={role,run:receipt(report),result:result(report),calls:[],details:0,detailFault,exportFault,startFault,holdDetail,held:null,csv:'Source,DataForSEO Labs / Google\r\nSynthetic fixture,not native CSV proof\r\n',posts:[]};
 model.holdEntered=new Promise(yes=>{model.markHeld=yes;});
 patchResult?.(model.result);
 const reply=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});
 await context.route('**/*',async route=>{
  const q=route.request(),url=new URL(q.url());if(url.origin!==origin){external.push(url.href);return route.abort();}if(!url.pathname.startsWith('/api/'))return q.method()==='GET'?route.continue():route.abort();
  model.calls.push({path:url.pathname,method:q.method()});assert.equal(url.search,'');assert.ok(url.pathname===base||url.pathname.startsWith(base+'/')||url.pathname.startsWith('/api/projects/20000000-0000-4000-8000-000000000002/domain-research'),'Only the two synthetic owned project routes are allowed.');
  const currentBase=url.pathname.replace(/\/domain-research.*$/,'/domain-research');
  if(url.pathname===currentBase)return reply(route,overview(model.role,model.run));
  if(q.method()==='POST'){
   const body=q.postDataJSON();model.posts.push({path:url.pathname,body});
   if(url.pathname.endsWith('/quote')){const stamp=new Date().toISOString(),estimate=(10000n+200n*BigInt(body.limit)).toString().padStart(7,'0');return reply(route,{role:model.role,quote:{id:ids.quote,request:body,connectionName:'Synthetic saved connection',priceAsOf:stamp,expiresAt:new Date(Date.parse(stamp)+300000).toISOString(),perTaskUsd:'0.010000',perItemUsd:'0.000200',estimateUsd:estimate.slice(0,-6)+'.'+estimate.slice(-6),upperItems:body.limit}});}
   if(url.pathname.endsWith('/runs')){if(model.startFault==='lost'&&model.posts.filter(p=>p.path.endsWith('/runs')).length===1)return route.abort('failed');const quoted=model.posts.findLast(p=>p.path.endsWith('/quote')).body;model.run=receipt(quoted.report,{request:quoted,status:'queued',completedAt:null,actualUsd:null,chargeStatus:'reserved',canCancel:true});if(model.startFault==='viewer')model.role='viewer';return reply(route,{role:model.role,run:model.run},202);}
   throw Error('Unexpected synthetic write: '+url.pathname);
  }
  if(url.pathname.endsWith('/export')){if(typeof model.exportFault==='number')return reply(route,{error:'Synthetic export refusal'},model.exportFault);const value={role:model.role,run:{...model.run},csv:model.csv,rowCount:model.result.returnedCount};if(typeof model.exportFault==='function')model.exportFault(value);return reply(route,value);}
  if(url.pathname.endsWith('/runs/'+ids.run)){
   model.details++;if(model.holdDetail){await new Promise(yes=>{model.held=yes;model.markHeld();});model.holdDetail=false;}
   if(typeof model.detailFault==='number')return reply(route,{error:'Synthetic detail read failure'},model.detailFault);
   const value={role:model.role,run:{...model.run,result:model.run.resultExpired||model.run.status==='queued'?null:model.result}};if(typeof model.detailFault==='function')model.detailFault(value);return reply(route,value);
  }
  throw Error('Unexpected synthetic read: '+url.pathname);
 });
 await page.goto(origin);await button(page,'Refresh receipts').waitFor();await page.getByRole('combobox',{name:'Research report',exact:true}).waitFor();
 const view=async()=>{await page.getByRole('region',{name:'Recent domain research'}).getByRole('button').first().click();await idle(page);};
 return {page,context,model,view};
}
const done=async(name,items)=>{checks.push({name,contexts:items});console.log('PASS '+name);};
try{
 await mkdir(output,{recursive:true});await server.listen();assert.equal(server.httpServer.address().address,'127.0.0.1');origin='http://127.0.0.1:'+server.httpServer.address().port;
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'msedge',headless:true});

 for(const report of [undefined,'overview_v1','pages_v1','competitors_v1']){
  const {page,context,model}=await open({report});await page.getByRole('combobox',{name:'Research report',exact:true}).selectOption(report??'ranked_keywords');await page.getByLabel('Domain or URL',{exact:true}).fill('https://www.example.com/guide?ignored=1');await page.getByLabel('Market and language',{exact:true}).selectOption('2840:en');
  if(report==='overview_v1'||report==='competitors_v1'){await page.getByLabel('Scope',{exact:true}).selectOption('exact_url');assert.equal(await button(page,'Prepare quote').isDisabled(),true);await page.getByRole('alert').filter({hasText:'Choose that scope explicitly'}).waitFor();assert.equal(await page.getByLabel('Scope',{exact:true}).inputValue(),'exact_url');await page.getByLabel('Scope',{exact:true}).selectOption('subdomains');}
  if(report!=='overview_v1')await page.getByLabel('Maximum results',{exact:true}).selectOption('25');else assert.equal(await page.getByLabel('Maximum results',{exact:true}).count(),0);
  assert.equal(model.posts.length,0);await button(page,'Prepare quote').click();await page.getByRole('region',{name:'Paid research quote'}).waitFor();assert.equal(model.posts.length,1);assert.equal(Object.hasOwn(model.posts[0].body,'report'),report!==undefined);assert.equal(model.posts[0].body.report,report);assert.equal(model.posts[0].body.limit,report==='overview_v1'?1:25);assert.equal(model.posts[0].body.target,'example.com');assert.equal(model.posts.some(p=>p.path.endsWith('/runs')),false);assert.equal(await button(page,'Start paid research').isEnabled(),true);await context.close();
 }
 await done('four explicit report drafts, exact quote identity, overview limit1 and no silent scope widening or paid Start',4);

 {
  const {page,context,model,view}=await open();await view();const section=page.getByRole('region',{name:'Domain organic estimates',exact:true});await section.waitFor();assert.ok((await section.innerText()).includes('1,234,567.123456789'));assert.equal(await section.locator('details').getAttribute('open'),null,'Rank buckets are closed until requested.');await section.locator('details > summary').click();assert.deepEqual(await section.locator('tbody th').allTextContents(),['1','2–3','4–10','11–20','21–30','31–40','41–50','51–60','61–70','71–80','81–90','91–100']);assert.equal(await section.locator('tbody td').nth(0).innerText(),'0');assert.equal(await section.locator('tbody td').nth(1).innerText(),'Unavailable');assert.ok((await page.getByRole('region',{name:'Domain research receipt'}).innerText()).includes('not proof of a fresh provider index update'));
  await button(page,'Use domain in pages draft').click();assert.equal(await page.getByRole('combobox',{name:'Research report',exact:true}).inputValue(),'pages_v1');assert.equal(await page.getByRole('region',{name:'Domain organic estimates',exact:true}).isVisible(),true);assert.equal(model.posts.length,0);await context.close();
  for(const empty of [false,true]){const item=await open({patchResult:r=>{r.rows=empty?[]:[metrics({rankedKeywords:null,estimatedTraffic:null,estimatedAdsValueUsd:null,rankDistribution:Array(12).fill(null)})];r.returnedCount=r.rows.length;r.totalCount=r.rows.length;}});await item.view();await item.page.getByText(empty?'No provider overview data was returned for this market.':'Unavailable',{exact:empty}).first().waitFor();assert.equal(item.model.posts.length,0);await item.context.close();}
 }
 await done('overview exact provider estimates, twelve rank buckets, unknown versus zero, empty data and draft-only drilldown',3);

 for(const report of [null,'overview_v1','pages_v1','competitors_v1']){
  const {page,context,model,view}=await open({report,patchResult:r=>Object.assign(r,{rows:[],returnedCount:0,totalCount:null,limited:null})});await view();
  const receipt=page.getByRole('region',{name:'Domain research receipt'});await receipt.getByText('0 returned; provider total unavailable. Completeness is unknown.',{exact:true}).waitFor();assert.equal((await receipt.innerText()).includes('All matching provider rows returned.'),false);assert.equal((await receipt.innerText()).includes('Partial report;'),false);assert.equal(await button(page,'Download report CSV').isEnabled(),true);assert.equal(model.posts.length,0);await context.close();
 }
 await done('zero returned rows preserve unavailable provider totals and unknown completeness across all four observed Labs reports',4);

 for(const patch of [{totalCount:null},{rows:[],returnedCount:0,totalCount:null,limited:false},{rows:[],returnedCount:0,totalCount:0,limited:null},{rows:[],returnedCount:1,totalCount:null,limited:null}]){
  const {page,context,view}=await open({patchResult:r=>Object.assign(r,patch)});await view();await page.getByRole('alert').filter({hasText:'could not be verified'}).waitFor();assert.equal(await page.getByRole('region',{name:'Domain research receipt'}).count(),0);await context.close();
 }
 await done('unknown totals cannot excuse populated rows, false completeness or contradictory returned counts',4);

 for(const report of ['pages_v1','competitors_v1']){
  const {page,context,model,view}=await open({report});await view();const region=page.getByRole('region',{name:report==='pages_v1'?'Ranked page table':'Organic competitor table',exact:true});await region.waitFor();assert.equal(await region.locator('tbody tr').first().isVisible(),true);
  if(report==='pages_v1'){assert.equal(await region.getByRole('link').getAttribute('href'),'https://example.com/guide');await region.locator('details > summary').first().click();await button(page,'Use page in keyword draft (exact URL)').click();assert.equal(await page.getByLabel('Domain or URL',{exact:true}).inputValue(),'https://example.com/guide');assert.equal(await page.getByLabel('Scope',{exact:true}).inputValue(),'exact_url');assert.equal(await page.getByRole('combobox',{name:'Research report',exact:true}).inputValue(),'ranked_keywords');}
  else{const cells=await region.locator('tbody tr').first().locator(':scope > th,:scope > td').allTextContents();assert.equal(cells[1],'0');assert.equal(cells[2],'Unavailable');assert.equal(cells[3],'900');assert.equal(cells[4],'3');await region.locator('details > summary').first().click();await page.getByRole('region',{name:'Competitor full domain: competitor.example.org',exact:true}).waitFor();await page.getByRole('region',{name:'Target on shared keywords: example.com',exact:true}).waitFor();await button(page,'Use competitor in overview draft (domain and subdomains)').click();assert.equal(await page.getByLabel('Domain or URL',{exact:true}).inputValue(),'competitor.example.org');assert.equal(await page.getByLabel('Scope',{exact:true}).inputValue(),'subdomains');assert.equal(await page.getByRole('combobox',{name:'Research report',exact:true}).inputValue(),'overview_v1');}
  assert.equal(model.posts.length,0);assert.equal(await region.isVisible(),true,'Draft edits do not relabel the retained report.');await context.close();
 }
 await done('ranked page and competitor tables preserve selected result, independent metric populations and explicit new drafts',2);

 for(const role of ['owner','admin','editor','viewer']){
  const {page,context,model,view}=await open({role});await view();assert.equal(await page.getByRole('combobox',{name:'Research report',exact:true}).isDisabled(),role==='viewer');const download=page.waitForEvent('download');await button(page,'Download report CSV').click();const file=await download;assert.equal((await readFile(await file.path())).toString('utf8'),model.csv);assert.equal(model.calls.filter(c=>c.path.endsWith('/export')).length,1);assert.equal(model.posts.length,0);await context.close();
 }
 for(const status of [409,413]){const {page,context,model,view}=await open({exportFault:status});await view();await button(page,'Download report CSV').click();await page.getByRole('alert').first().waitFor();assert.equal(await page.getByRole('region',{name:'Domain research receipt'}).isVisible(),true);assert.equal(await page.getByText('Report rows expired under current retention. The quote and charge receipt remain.',{exact:true}).count(),0,'A refusal is not invented expiry.');if(status===409)assert.equal(await page.getByRole('region',{name:'Domain organic estimates',exact:true}).count(),0);assert.equal(model.posts.length,0);await context.close();}
 {const {page,context,model,view}=await open({exportFault:d=>{d.run.estimateUsd='0.150000';}});let downloads=0;page.on('download',()=>downloads++);await view();await button(page,'Download report CSV').click();await page.getByRole('alert').filter({hasText:'could not be verified'}).waitFor();assert.equal(downloads,0);assert.equal(await page.getByRole('region',{name:'Domain research receipt'}).count(),0);assert.equal(await page.evaluate(()=>window.domainOverviewFixture.unauthorized),0);assert.equal(model.posts.length,0);await context.close();}
 await done('all four roles explicitly export exact supplied CSV; refusal retains receipts without invented expiry and copied identity never downloads',7);

 for(const fault of ['report','estimate','metrics','url']){
  const report=fault==='url'?'pages_v1':'overview_v1',{page,context,view}=await open({report,detailFault:d=>{if(fault==='report')d.run.request.report='pages_v1';if(fault==='estimate')d.run.estimateUsd='0.150000';if(fault==='metrics')d.run.result.rows[0].rankDistribution=[0];if(fault==='url')d.run.result.rows[0].url='https://outside.example.org/';}});await view();await page.getByRole('alert').filter({hasText:'could not be verified'}).waitFor();assert.equal(await page.getByRole('region',{name:'Domain research receipt'}).count(),0);assert.equal(await page.evaluate(()=>window.domainOverviewFixture.unauthorized),0);await context.close();
 }
 await done('copied-negative immutable report/estimate, incomplete metrics and out-of-scope page are refused without global signout',4);

 for(const mode of ['viewer','lost']){
  const {page,context,model}=await open({startFault:mode,detailFault:mode==='viewer'?500:undefined});await page.getByRole('combobox',{name:'Research report',exact:true}).selectOption('overview_v1');await page.getByLabel('Domain or URL',{exact:true}).fill('example.com');await page.getByLabel('Market and language',{exact:true}).selectOption('2840:en');await button(page,'Prepare quote').click();await page.getByRole('region',{name:'Paid research quote'}).waitFor();await button(page,'Start paid research').click();
  if(mode==='lost'){await button(page,'Retry same start').waitFor();assert.equal(await button(page,'Prepare quote').isDisabled(),true);await button(page,'Retry same start').click();const writes=model.posts.filter(p=>p.path.endsWith('/runs'));assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);assert.equal(Object.keys(writes[0].body).sort().join(','),'quoteId,requestKey');}
  await page.getByText('Run receipt saved.',{exact:true}).waitFor();await page.getByRole('region',{name:'Domain research receipt'}).waitFor();if(mode==='viewer'){await page.getByRole('alert').filter({hasText:'Synthetic detail read failure'}).waitFor();assert.equal(await button(page,'Prepare quote').isDisabled(),true);assert.equal(model.posts.filter(p=>p.path.endsWith('/runs')).length,1);assert.equal(await page.evaluate(()=>window.domainOverviewFixture.unauthorized),0);}await context.close();
 }
 await done('summary-only ACK survives failed free read, current viewer authority disables writes, unknown Start reuses its exact saved UUID',2);

 {
  const {page,context,model,view}=await open();await view();model.run.resultExpired=true;await button(page,'Reload result').click();await page.getByText('Report rows expired under current retention. The quote and charge receipt remain.',{exact:true}).waitFor();model.run.resultExpired=false;await button(page,'Reload result').click();await idle(page);assert.equal(await page.getByRole('region',{name:'Domain organic estimates',exact:true}).count(),0);assert.equal(await button(page,'Download report CSV').count(),0);await context.close();
  const held=await open({holdDetail:true});await held.page.getByRole('region',{name:'Recent domain research'}).getByRole('button').first().click();await held.model.holdEntered;
  await held.page.evaluate(()=>window.domainOverviewFixture.scope({projectId:'20000000-0000-4000-8000-000000000002'}));await held.page.getByRole('combobox',{name:'Research report',exact:true}).waitFor();held.model.held();await held.page.getByRole('region',{name:'Recent domain research'}).waitFor();assert.equal(await held.page.getByRole('region',{name:'Domain research receipt'}).count(),0);assert.equal(await held.page.getByRole('region',{name:'Domain organic estimates',exact:true}).count(),0);await held.context.close();
 }
 await done('observed expiry stays hidden in the UI and held old-project read cannot restore a selected result',2);

 {
  const {page,context,model,view}=await open({report:'competitors_v1'});await view();for(const width of [320,1440])for(const direction of ['ltr','rtl']){await page.setViewportSize({width,height:1000});await page.evaluate(dir=>{document.documentElement.dir=dir;document.body.style.zoom='2';},direction);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);if(width===320)assert.ok(await page.getByRole('region',{name:'Organic competitor table',exact:true}).evaluate(el=>el.scrollWidth>el.clientWidth),'Narrow competitor tables must scroll internally instead of crushing columns');await page.screenshot({path:output+'/'+width+'-'+direction+'-body-css-zoom2.png',fullPage:true});}
  await page.evaluate(()=>{document.body.style.zoom='';document.documentElement.dir='ltr';});await page.getByRole('combobox',{name:'Research report',exact:true}).focus();await page.keyboard.press('Tab');assert.equal(await page.getByLabel('Domain or URL',{exact:true}).evaluate(el=>el===document.activeElement),true);const table=page.getByRole('region',{name:'Organic competitor table',exact:true});await table.focus();await page.keyboard.press('Tab');assert.equal(await table.getByText('Separate metric populations',{exact:true}).evaluate(el=>el===document.activeElement),true);
  model.detailFault=403;await button(page,'Reload result').click();await page.getByRole('alert').first().waitFor();assert.equal(await page.evaluate(()=>window.domainOverviewFixture.unauthorized),0);await button(page,'Refresh receipts').click();await page.getByRole('combobox',{name:'Research report',exact:true}).waitFor();model.detailFault=401;await page.getByRole('region',{name:'Recent domain research'}).getByRole('button').first().click();await page.getByText('Your session expired.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.domainOverviewFixture.unauthorized),1);assert.equal(await page.getByRole('region',{name:'Domain research receipt'}).count(),0);assert.equal(model.posts.length,0);await context.close();
 }
 await done('320/1440 LTR/RTL body CSS zoom2, real Tab controls/table and distinct project refusal versus session expiry',1);
 assert.equal(checks.length,10);assert.equal(checks.reduce((n,c)=>n+c.contexts,0),33);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(output+'/evidence.json',JSON.stringify({scope:'synthetic source component UI; not native/provider/compiled proof',checks,contexts:33,errors,external,screenshots:4,source:{panel:createHash('sha256').update(await readFile('src/components/DomainResearchPanel.tsx')).digest('hex')}},null,2));console.log('Evidence: '+output+'/evidence.json');
}catch(error){await writeFile(output+'/failure.json',JSON.stringify({scope:'synthetic component checks',checks,error:String(error),stack:error?.stack,errors,external},null,2));throw error;}
finally{for(const context of contexts)await context.close().catch(()=>{});await browser?.close();await server.close();}
