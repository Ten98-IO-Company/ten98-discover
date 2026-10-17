// TEN98_BACKLINK_RESEARCH_BROWSER=1 PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node tests/backlink-research-browser.mjs
// Real Panel, isolated Vite/Edge, explicitly synthetic success JSON/CSV and negative faults.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'vite';

assert.equal(process.env.TEN98_BACKLINK_RESEARCH_BROWSER,'1');
const output=resolve('private/backlink-research-ui/browser/run-'+randomUUID().replaceAll('-','').slice(0,12));
const ids={connection:'40000000-0000-4000-8000-000000000001',run:'50000000-0000-4000-8000-000000000001',next:'50000000-0000-4000-8000-000000000002',quote:'60000000-0000-4000-8000-000000000001'};
const at='2026-10-16T05:00:00.000Z',base='/api/projects/20000000-0000-4000-8000-000000000001/domain-research';
const copy=v=>JSON.parse(JSON.stringify(v));
const request=(patch={})=>({connectionId:ids.connection,target:'example.com',scope:'subdomains',status:'live',report:'backlinks_profile_v1',limit:25,offset:0,follow:'all',order:'rank_desc',...patch});
const groupRequest=(report,patch={})=>request({report,order:'backlinks_desc',...patch});
const overviewRequest=(patch={})=>({connectionId:ids.connection,target:'example.com',scope:'subdomains',status:'live',report:'backlinks_overview_v1',limit:1,...patch});
const receipt=(r,patch={})=>({id:ids.run,quoteId:ids.quote,request:r,status:'completed',createdAt:at,completedAt:at,estimateUsd:r.limit===1?'0.010200':'0.015000',actualUsd:'0.012120',chargeStatus:'settled',canCancel:false,diagnostic:null,resultExpired:false,...patch});
function result(r){
 const target=r.scope==='exact_url'?r.target:r.scope==='subfolder'?r.target+'/item?variant=1':'https://'+r.target+'/guide';
 const group={backlinks:0,referringDomains:2,referringMainDomains:1,referringPages:null,referringPagesNofollow:0,referringIps:null,referringSubnets:0,brokenBacklinks:0,brokenPages:null,spamScore:null,rank:0,firstSeen:at,lostAt:null};
 const rows=r.report==='backlinks_referring_domains_v1'?[{...group,domain:'publisher.example.org'}]:r.report==='backlinks_anchors_v1'?[{...group,anchor:'<script>synthetic grouped anchor</script>'},{...group,anchor:''}]:r.report==='backlinks_overview_v1'?[{backlinks:0,referringDomains:null,referringMainDomains:0,referringPages:1,referringIps:null,referringSubnets:0,brokenBacklinks:0,spamScore:0,rank:r.scope==='subfolder'?null:0,firstSeen:at,lostAt:null}]:[{sourceUrl:'https://publisher.example.org/article',targetUrl:target,sourceDomain:'publisher.example.org',targetDomain:new URL(target).hostname,rank:0,pageRank:null,domainRank:50,spamScore:0,dofollow:r.follow!=='nofollow',isLost:r.status==='lost',isBroken:false,anchor:'<script>synthetic anchor</script>',firstSeen:at,lastSeen:null,linksCount:3}];
 return {source:'DataForSEO Backlinks',retrievedAt:at,target:r.target,scope:r.scope,status:r.status,rankScale:'one_hundred',report:r.report,rows,returnedCount:rows.length,totalCount:r.report==='backlinks_overview_v1'?1:51,limited:r.report!=='backlinks_overview_v1',...r.report!=='backlinks_overview_v1'?{offset:r.offset,limit:r.limit,follow:r.follow,sourceHost:r.sourceHost??null,order:r.order}:{}};
}
const state=(role,runs)=>({role,vaultConfigured:true,spendingPaused:false,connections:[{id:ids.connection,name:'Synthetic saved connection',checkStatus:'ok'}],catalog:{updatedAt:null,markets:[]},runs});
const checks=[],contexts=[],errors=[],external=[];
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'private/backlink-research-ui/vite-cache',appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Backlink synthetic checks</title><div id="root"></div><script type="module" src="/tests/backlink-research-browser-fixture.tsx"></script></html>');});
let browser,origin;
const button=(p,name)=>p.getByRole('button',{name,exact:true});
const select=(p,name)=>p.getByRole('combobox',{name,exact:true});
const idle=p=>p.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Refresh receipts'&&!b.disabled));
async function open({r=request(),role='owner',patchResult,detailFault,exportFault,startFault,ackFault,holdDetail=false,previous}={}){
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,serviceWorkers:'block'});contexts.push(context);
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const current=receipt(r),model={role,run:current,runs:previous?[current,previous]:[current],results:new Map([[current.id,result(r)]]),calls:[],posts:[],details:0,detailFault,exportFault,startFault,ackFault,holdDetail,held:null,csv:'Source,DataForSEO Backlinks\r\nSynthetic fixture,not native CSV proof\r\n'};
 if(previous)model.results.set(previous.id,result(previous.request));patchResult?.(model.results.get(current.id));
 model.holdEntered=new Promise(yes=>{model.markHeld=yes;});
 const reply=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});
 await context.route('**/*',async route=>{
  const q=route.request(),url=new URL(q.url());if(url.origin!==origin){external.push(url.href);return route.abort();}if(!url.pathname.startsWith('/api/'))return q.method()==='GET'?route.continue():route.abort();
  model.calls.push({path:url.pathname,method:q.method()});assert.equal(url.search,'');assert.ok(url.pathname===base||url.pathname.startsWith(base+'/')||url.pathname.startsWith('/api/projects/20000000-0000-4000-8000-000000000002/domain-research'));
  if(url.pathname.includes('20000000-0000-4000-8000-000000000002'))return reply(route,state(model.role,[]));
  if(url.pathname===base)return reply(route,state(model.role,model.runs));
  if(q.method()==='POST'){
   const body=q.postDataJSON();model.posts.push({path:url.pathname,body});
   if(url.pathname.endsWith('/quote')){const stamp=new Date().toISOString(),micros=10000n+200n*BigInt(body.limit),str=micros.toString().padStart(7,'0');return reply(route,{role:model.role,quote:{id:ids.quote,request:body,connectionName:'Synthetic saved connection',priceAsOf:stamp,expiresAt:new Date(Date.parse(stamp)+300000).toISOString(),perTaskUsd:'0.010000',perItemUsd:'0.000200',estimateUsd:str.slice(0,-6)+'.'+str.slice(-6),upperItems:body.limit}});}
   if(url.pathname.endsWith('/runs')){
    if(model.startFault==='lost'&&model.posts.filter(p=>p.path.endsWith('/runs')).length===1)return route.abort('failed');
    const quoted=model.posts.findLast(p=>p.path.endsWith('/quote')).body;model.run=receipt(quoted,{id:ids.next,status:'queued',completedAt:null,actualUsd:null,chargeStatus:'reserved',canCancel:true});model.runs=[model.run,...model.runs];if(model.startFault==='viewer')model.role='viewer';
    const value={role:model.role,run:copy(model.run)};model.ackFault?.(value);return reply(route,value,202);
   }
   throw Error('Unexpected synthetic write '+url.pathname);
  }
  const runId=url.pathname.split('/runs/')[1]?.split('/')[0],saved=model.runs.find(v=>v.id===runId);assert.ok(saved,'Only synthetic owned receipt IDs may be read.');
  if(url.pathname.endsWith('/export')){if(typeof model.exportFault==='number')return reply(route,{error:'Synthetic export refusal'},model.exportFault);const value={role:model.role,run:copy(saved),csv:model.csv,rowCount:model.results.get(saved.id)?.returnedCount??0};model.exportFault?.(value);return reply(route,value);}
  model.details++;if(model.holdDetail){await new Promise(yes=>{model.held=yes;model.markHeld();});model.holdDetail=false;}
  if(typeof model.detailFault==='number')return reply(route,{error:'Synthetic free read failure'},model.detailFault);
  const value={role:model.role,run:{...saved,result:saved.resultExpired||saved.status==='queued'?null:model.results.get(saved.id)}};model.detailFault?.(value);return reply(route,value);
 });
 await page.goto(origin);await button(page,'Refresh receipts').waitFor();await select(page,'Research report').waitFor();
 const view=async()=>{await page.getByRole('region',{name:'Recent domain research'}).getByRole('button').first().click();await idle(page);};
 return {page,context,model,view};
}
const done=(name,count)=>{checks.push({name,contexts:count});console.log('PASS '+name);};
async function draft(page,report='backlinks_profile_v1',target='example.com'){
 await select(page,'Research report').selectOption(report);await page.getByLabel('Domain or URL',{exact:true}).fill(target);
}
try{
 await mkdir(output,{recursive:true});await server.listen();assert.equal(server.httpServer.address().address,'127.0.0.1');origin='http://127.0.0.1:'+server.httpServer.address().port;
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'msedge',headless:true});

 for(const report of ['backlinks_overview_v1','backlinks_profile_v1'])for(const scope of ['domain','subdomains','subfolder','exact_url']){
  const {page,context,model}=await open();const target=scope==='subfolder'?'http://www.example.com/Guide/':scope==='exact_url'?'http://www.example.com/Guide/':'https://www.example.com/';
  await draft(page,report,target);await select(page,'Scope').selectOption(scope);if(report==='backlinks_profile_v1')await select(page,'Maximum results').selectOption('25');
  assert.equal(await select(page,'Market and language').count(),0);assert.equal(await button(page,'Load supported markets').count(),0);assert.equal(model.posts.length,0);
  await button(page,'Prepare quote').click();await page.getByRole('region',{name:'Paid research quote'}).waitFor();assert.equal(model.posts.length,1);
  const expected=report==='backlinks_overview_v1'?overviewRequest({scope,target:scope==='domain'||scope==='subdomains'?'example.com':scope==='subfolder'?'http://www.example.com/Guide':'http://www.example.com/Guide/'}):request({scope,target:scope==='domain'||scope==='subdomains'?'example.com':scope==='subfolder'?'http://www.example.com/Guide':'http://www.example.com/Guide/'});
  assert.deepEqual(model.posts[0].body,expected);assert.equal(model.posts.some(v=>v.path.endsWith('/runs')),false);await context.close();
 }
 done('two explicit backlink reports and four truthful scopes without Google fields or automatic Start',8);

 {
  const {page,context,model}=await open();await draft(page);
  for(const value of ['https://example.com/path','https://example.com/?ignored=1','https://example.com/#fragment']){await page.getByLabel('Domain or URL',{exact:true}).fill(value);assert.equal(await button(page,'Prepare quote').isDisabled(),true);}
  await page.getByLabel('Domain or URL',{exact:true}).fill('example.com');await select(page,'Link status').selectOption('lost');await select(page,'Follow filter').selectOption('nofollow');assert.deepEqual(await select(page,'Sort backlinks').locator('option').allTextContents(),['Highest DataForSEO rank','Newest first seen','Newest last seen']);await select(page,'Sort backlinks').selectOption('last_seen_desc');await page.getByLabel('Source host (optional)',{exact:true}).fill('https://publisher.example.org');assert.equal(await button(page,'Prepare quote').isDisabled(),true);
  await page.getByLabel('Source host (optional)',{exact:true}).fill('publisher.example.org');await select(page,'Maximum results').selectOption('25');assert.equal(model.posts.length,0);await button(page,'Prepare quote').click();await page.getByRole('region',{name:'Paid research quote'}).waitFor();assert.deepEqual(model.posts[0].body,request({status:'lost',follow:'nofollow',sourceHost:'publisher.example.org',order:'last_seen_desc'}));await context.close();
 }
 done('scope and exact source-host refusals plus staged status follow and ordering',1);

 for(const kind of ['overview','folder','empty']){
  const r=kind==='overview'?overviewRequest():kind==='folder'?overviewRequest({target:'http://www.example.com/Guide',scope:'subfolder'}):request({offset:75});
  const {page,context,view}=await open({r,patchResult:v=>{if(kind==='empty'){v.rows=[];v.returnedCount=0;v.totalCount=51;v.limited=true;}}});await view();
  if(kind==='empty'){await page.getByText('No backlink records were returned at this offset. Earlier pages are not reconstructed.',{exact:true}).waitFor();await page.getByText(/Partial report/).waitFor();}
  else{const section=page.getByRole('region',{name:'Backlink overview',exact:true});assert.equal(await section.locator('dt').filter({hasText:/^Backlinks$/}).locator('..').locator('dd').textContent(),'0');assert.equal(await section.locator('dt').filter({hasText:/^Referring domains$/}).locator('..').locator('dd').textContent(),'Unavailable');assert.equal(await section.locator('dt').filter({hasText:/^DataForSEO rank/}).locator('..').locator('dd').textContent(),kind==='folder'?'Unavailable':'0');assert.equal(await page.getByText(/A folder-specific DataForSEO rank is not available\./).count(),kind==='folder'?1:0);await page.getByText(/One summary record is not one backlink/).waitFor();}
  await context.close();
 }
 done('overview null versus zero and folder rank plus empty nonzero-offset partial page',3);

 {
  const r=request({offset:25}),previous=receipt(request(),{id:ids.next});const {page,context,model,view}=await open({r,previous});await view();await button(page,'Use next page in new draft').click();await page.getByText(/New draft offset 50/).waitFor();assert.equal(model.posts.length,0);assert.equal(await page.getByRole('region',{name:'Backlink profile table'}).getByRole('row').count(),2);
  const profile=page.getByRole('region',{name:'Backlink profile table'});assert.deepEqual(await profile.locator('thead th').allTextContents(),['Source page','Anchor and target','Status','DataForSEO rank (0–100)','First / last seen','Details']);assert.deepEqual((await profile.locator('tbody dt').allTextContents()).slice(0,2),['DataForSEO source page rank (0–100)','DataForSEO source domain rank (0–100)']);assert.equal(await page.getByText(/^Highest DataForSEO-ranked backlink per referring page\..* · order DataForSEO rank desc\.$/).count(),1);
  await button(page,'View saved previous page').click();await idle(page);assert.equal(model.calls.at(-1).path,base+'/runs/'+ids.next);assert.equal(model.posts.length,0);await page.getByRole('region',{name:'Domain research receipt'}).getByText(/Offset 0 · maximum 25/).waitFor();await context.close();
 }
 for(const role of ['owner','admin','editor','viewer']){
  const {page,context,model,view}=await open({role});await view();const pending=page.waitForEvent('download');await button(page,'Download report CSV').click();const download=await pending;const path=await download.path();assert.equal(await readFile(path,'utf8'),model.csv);assert.equal(model.posts.length,0);if(role==='viewer')assert.equal(await button(page,'Prepare quote').isDisabled(),true);await context.close();
 }
 done('paid page drafts never fetch and saved prior pages plus all-role CSV remain free',5);

 for(const mutate of [v=>{v.report='backlinks_overview_v1';},v=>{v.rows[0].rank=101;},v=>{v.rows[0].targetUrl='https://unrelated.example.org/path';v.rows[0].targetDomain='unrelated.example.org';},v=>{v.rankScale='one_thousand';},v=>{v.offset=25;},v=>{v.limited=false;},v=>{v.rows[0].sourceDomain='other.example.org';}]){
  const {page,context,view}=await open({patchResult:mutate});await view();await page.getByRole('alert').filter({hasText:'could not be verified'}).waitFor();assert.equal(await page.getByRole('region',{name:'Backlink profile table'}).count(),0);assert.equal(await page.evaluate(()=>window.backlinkFixture.unauthorized),0);await context.close();
 }
 done('copied-negative report rank scope scale page completeness and source identities purge component only',7);

 for(const kind of ['viewer','lost','estimate']){
  const {page,context,model}=await open({startFault:kind==='estimate'?undefined:kind,detailFault:500,ackFault:kind==='estimate'?v=>{v.run.estimateUsd='0.150000';}:undefined});await draft(page);await select(page,'Maximum results').selectOption('25');await button(page,'Prepare quote').click();await button(page,'Start paid research').waitFor();await button(page,'Start paid research').click();if(kind==='viewer')await idle(page);
  if(kind==='viewer'){await page.getByRole('region',{name:'Domain research receipt'}).waitFor();await page.getByRole('status').filter({hasText:'Run receipt saved.'}).waitFor();assert.equal(await button(page,'Prepare quote').isDisabled(),true);}
  else{await button(page,'Retry same start').waitFor();assert.equal(model.posts.filter(v=>v.path.endsWith('/runs')).length,1);if(kind==='lost'){await button(page,'Retry same start').click();await idle(page);const starts=model.posts.filter(v=>v.path.endsWith('/runs'));assert.equal(starts.length,2);assert.deepEqual(starts[1].body,starts[0].body);}}
  assert.equal(await page.evaluate(()=>window.backlinkFixture.unauthorized),0);await context.close();
 }
 done('verified viewer ACK survives failed free GET and unknown or copied-estimate Start keeps one saved identity',3);

 {
  const {page,context,model,view}=await open();await view();model.run.resultExpired=true;await button(page,'Reload result').click();await idle(page);assert.equal(await page.getByRole('region',{name:'Backlink profile table'}).count(),0);model.run.resultExpired=false;await button(page,'Reload result').click();await idle(page);assert.equal(await page.getByRole('region',{name:'Backlink profile table'}).count(),0);assert.equal(await button(page,'Download report CSV').count(),0);await context.close();
 }
 {
  const {page,context,model}=await open({holdDetail:true});await page.getByRole('region',{name:'Recent domain research'}).getByRole('button').first().click();await model.holdEntered;await page.evaluate(()=>window.backlinkFixture.scope({projectId:'20000000-0000-4000-8000-000000000002'}));await idle(page);model.held();await page.getByText('No research receipts yet.',{exact:true}).waitFor();assert.equal(await page.getByRole('region',{name:'Backlink profile table'}).count(),0);await context.close();
 }
 for(const status of [401,403,404]){
  const {page,context,view}=await open({detailFault:status});await view();await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('region',{name:'Backlink profile table'}).count(),0);assert.equal(await page.evaluate(()=>window.backlinkFixture.unauthorized),status===401?1:0);await context.close();
 }
 done('observed expiry and stale project responses cannot restore content with distinct session and project refusals',5);

 {
  const {page,context,model,view}=await open();await view();assert.equal(await page.getByRole('cell').filter({hasText:'<script>synthetic anchor</script>'}).count(),1);assert.equal(await page.locator('script').filter({hasText:'synthetic anchor'}).count(),0);
  for(const width of [320,1440])for(const direction of ['ltr','rtl']){await page.setViewportSize({width,height:1000});await page.evaluate(dir=>{document.documentElement.dir=dir;document.body.style.zoom='2';},direction);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);if(width===320)assert.ok(await page.getByRole('region',{name:'Backlink profile table'}).evaluate(el=>el.scrollWidth>el.clientWidth));await page.screenshot({path:output+'/'+width+'-'+direction+'-body-css-zoom2.png',fullPage:true});}
  await page.evaluate(()=>{document.body.style.zoom='';document.documentElement.dir='ltr';});await select(page,'Research report').focus();await page.keyboard.press('Tab');assert.equal(await page.getByLabel('Domain or URL',{exact:true}).evaluate(el=>el===document.activeElement),true);const table=page.getByRole('region',{name:'Backlink profile table'});await table.focus();await page.keyboard.press('Tab');assert.equal(await table.locator('a').first().evaluate(el=>el===document.activeElement),true);assert.equal(model.posts.length,0);await context.close();
 }
 done('320 and 1440 LTR RTL body CSS zoom2 with contained readable table real keyboard and escaped anchor',1);

 for(const report of ['backlinks_referring_domains_v1','backlinks_anchors_v1'])for(const scope of ['domain','subdomains','subfolder','exact_url']){
  const target=scope==='subfolder'?'http://www.example.com/Guide':scope==='exact_url'?'http://www.example.com/Guide/':'example.com',r=groupRequest(report,{scope,target,status:'lost',follow:'nofollow',sourceHost:'publisher.example.org',order:'first_seen_desc'}),{page,context,model,view}=await open({r});await view();
  const table=page.getByRole('region',{name:report==='backlinks_referring_domains_v1'?'Referring domain table':'Anchor text table',exact:true});await table.waitFor();assert.equal(await table.getByRole('row').count(),report==='backlinks_referring_domains_v1'?2:3);assert.deepEqual(await table.locator('thead th').allTextContents(),[report==='backlinks_referring_domains_v1'?'Referring main domain':'Anchor text','Backlinks','Referring pages','DataForSEO rank (0–100)','First / last lost','Details']);assert.equal(await table.locator('tbody tr').first().locator('td').first().textContent(),'0');assert.equal(await table.locator('tbody tr').first().locator('td').nth(1).textContent(),'Unavailable');await page.getByText(/not alias-deduplicated unique links/).waitFor();assert.equal(await select(page,'Market and language').count(),1,'The unrelated organic draft remains unchanged until a grouped draft is selected.');
  await button(page,'Use next page in new draft').click();await page.getByText(/New draft offset 25/).waitFor();assert.deepEqual(await select(page,'Sort groups').locator('option').allTextContents(),['Most backlinks','Highest DataForSEO rank','Newest first seen']);assert.equal(await select(page,'Market and language').count(),0);assert.equal(model.posts.length,0);assert.equal(await select(page,'Research report').inputValue(),report);await button(page,'Prepare quote').click();await page.getByRole('region',{name:'Paid research quote'}).waitFor();assert.deepEqual(model.posts[0].body,{...r,offset:25});assert.equal(model.posts.length,1);assert.equal(model.posts.some(v=>v.path.endsWith('/runs')),false);await context.close();
 }
 done('native-shaped main-domain and exact-anchor grouped datasets retain four scopes and initial-population filters without automatic paid pages',8);

 for(const report of ['backlinks_referring_domains_v1','backlinks_anchors_v1']){
  const r=groupRequest(report,{offset:25}),previous=receipt(groupRequest(report),{id:ids.next}),{page,context,model,view}=await open({r,previous});await view();const pending=page.waitForEvent('download');await button(page,'Download report CSV').click();assert.equal(await readFile(await(await pending).path(),'utf8'),model.csv);assert.equal(model.posts.length,0);await button(page,'View saved previous page').click();await idle(page);assert.equal(model.calls.at(-1).path,base+'/runs/'+ids.next);assert.equal(model.posts.length,0);await button(page,'Use next page in new draft').click();await button(page,'Prepare quote').click();await page.getByRole('region',{name:'Paid research quote'}).waitFor();assert.deepEqual(model.posts[0].body,groupRequest(report,{offset:25}));assert.equal(model.posts.length,1);await button(page,'Start paid research').click();await idle(page);assert.equal(model.posts.length,2);assert.deepEqual(Object.keys(model.posts[1].body).sort(),['quoteId','requestKey']);assert.equal(model.posts[1].body.quoteId,ids.quote);assert.match(model.posts[1].body.requestKey,/^[a-f0-9-]{36}$/i);await context.close();
  const viewer=await open({r:groupRequest(report),role:'viewer'});await viewer.view();assert.equal(await button(viewer.page,'Prepare quote').isDisabled(),true);assert.equal(await button(viewer.page,'Use next page in new draft').isDisabled(),true);assert.equal(viewer.model.posts.length,0);await viewer.context.close();
  const lost=await open({r:groupRequest(report),startFault:'lost'});await lost.view();lost.model.detailFault=500;await button(lost.page,'Use next page in new draft').click();await button(lost.page,'Prepare quote').click();await button(lost.page,'Start paid research').click();await button(lost.page,'Retry same start').waitFor();await button(lost.page,'Retry same start').click();await idle(lost.page);const starts=lost.model.posts.filter(v=>v.path.endsWith('/runs'));assert.equal(starts.length,2);assert.deepEqual(starts[0].body,starts[1].body);assert.equal(lost.model.posts.filter(v=>v.path.endsWith('/quote')).length,1);assert.equal(await lost.page.evaluate(()=>window.backlinkFixture.unauthorized),0);await lost.context.close();
 }
 done('grouped saved-page CSV and explicit Start, viewer controls and lost acknowledgement recovery preserve the exact paid identity',6);

 for(const report of ['backlinks_referring_domains_v1','backlinks_anchors_v1'])for(const mutate of [v=>{v.report='backlinks_profile_v1';},v=>{v.offset=25;},v=>{v.follow='nofollow';},v=>{v.totalCount=0;},v=>{v.rows[0].rank=101;},v=>{if(report==='backlinks_referring_domains_v1')v.rows[0].domain='127.0.0.1';else v.rows[0].anchor='bad\u0000anchor';}]){
  const {page,context,view}=await open({r:groupRequest(report),patchResult:mutate});await view();await page.getByRole('alert').filter({hasText:'could not be verified'}).waitFor();assert.equal(await page.getByRole('region',{name:report==='backlinks_referring_domains_v1'?'Referring domain table':'Anchor text table',exact:true}).count(),0);assert.equal(await page.evaluate(()=>window.backlinkFixture.unauthorized),0);await context.close();
 }
 done('copied-negative grouped report page population count rank and row identity are rejected without publishing content',12);

 for(const report of ['backlinks_referring_domains_v1','backlinks_anchors_v1']){
  const {page,context,model,view}=await open({r:groupRequest(report)});await view();const table=page.getByRole('region',{name:report==='backlinks_referring_domains_v1'?'Referring domain table':'Anchor text table',exact:true});if(report==='backlinks_anchors_v1'){await table.getByRole('rowheader',{name:'Empty anchor',exact:true}).waitFor();assert.equal(await table.getByRole('rowheader',{name:'<script>synthetic grouped anchor</script>',exact:true}).count(),1);assert.equal(await page.locator('script').filter({hasText:'synthetic grouped anchor'}).count(),0);}
  for(const width of [320,1440])for(const direction of ['ltr','rtl']){await page.setViewportSize({width,height:1000});await page.evaluate(dir=>{document.documentElement.dir=dir;document.body.style.zoom='2';},direction);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);if(width===320)assert.ok(await table.evaluate(el=>el.scrollWidth>el.clientWidth));await page.screenshot({path:output+'/'+report+'-'+width+'-'+direction+'-body-css-zoom2.png',fullPage:true});}
  await page.evaluate(()=>{document.body.style.zoom='';document.documentElement.dir='ltr';});await table.focus();await page.keyboard.press('Tab');assert.equal(await table.locator('summary').first().evaluate(el=>el===document.activeElement),true);assert.equal(model.posts.length,0);model.run.resultExpired=true;await button(page,'Reload result').click();await idle(page);assert.equal(await table.count(),0);assert.equal(await button(page,'Download report CSV').count(),0);model.run.resultExpired=false;await button(page,'Reload result').click();await idle(page);assert.equal(await table.count(),0);await context.close();
 }
 done('both grouped tables retain 320/1440 LTR/RTL zoom2, native keyboard, escaped/empty anchors and irreversible observed expiry',2);

 assert.equal(checks.length,12);assert.equal(contexts.length,61);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 await writeFile(output+'/evidence.json',JSON.stringify({scope:'synthetic source component UI; not native/provider/compiled proof',checks,contexts:contexts.length,errors,external,screenshots:12,source:{panel:createHash('sha256').update(await readFile('src/components/DomainResearchPanel.tsx')).digest('hex')}},null,2));console.log('Evidence: '+output+'/evidence.json');
}catch(error){await writeFile(output+'/failure.json',JSON.stringify({scope:'synthetic component checks',checks,error:String(error),stack:error?.stack,errors,external},null,2));throw error;}
finally{for(const context of contexts)await context.close().catch(()=>{});if(browser)await browser.close();await server.close();}
