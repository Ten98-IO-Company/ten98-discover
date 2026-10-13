// Opt-in, contained UI acceptance: TEN98_RANK_PANEL_BROWSER=1 node tests/rank-tracking-browser.mjs
// Optional PLAYWRIGHT_MODULE points to installed Playwright; PLAYWRIGHT_CHANNEL selects an installed browser.
// All API/external requests are intercepted; no database, provider, browser download or preview is used.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';

assert.equal(process.env.TEN98_RANK_PANEL_BROWSER,'1');
// Use installed Playwright, or an explicitly supplied module path; never install/download here.
const pid='20000000-0000-4000-8000-000000000001',cid='40000000-0000-4000-8000-000000000001',tid='50000000-0000-4000-8000-000000000001';
const at='2026-10-13T09:00:00.000Z',base='/api/projects/'+pid+'/rank-trackers',alternatePid='20000000-0000-4000-8000-000000000002';
const initial={id:tid,name:'Synthetic main tracker',domain:'example.com',countryCode:2840,countryIso:'US',locationCode:2840,locationName:'United States',locationType:'Country',languageCode:'en',languageName:'English',devices:'mobile',depth:10,maxCrawlPages:1,revision:1,keywordsRevision:1,authoredRevision:1,keywordCount:2,archivedAt:null,createdAt:at,updatedAt:at,schedule:{interval:'manual',enabled:false,nextDueAt:null}};
const initialKeywords=[{id:'60000000-0000-4000-8000-000000000001',keyword:'literal C++ %20',matchCase:true,pinnedAt:null,createdAt:at},{id:'60000000-0000-4000-8000-000000000002',keyword:'ordinary term',matchCase:false,pinnedAt:null,createdAt:at}];
const countries=[{code:2840,name:'United States',parentCode:null,countryIso:'US',type:'Country',countryCode:2840},{code:2250,name:'France',parentCode:null,countryIso:'FR',type:'Country',countryCode:2250}];
const languages=[{code:'en',name:'English'},{code:'fr',name:'Français'}];
const local=(country,code,name)=>({code,name,parentCode:country,countryIso:country===2840?'US':'FR',type:'City',countryCode:country});
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'private/rank-panel-vite-cache',appType:'custom',server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url!=='/'&&req.url!=='/elsewhere')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rank parent synthetic acceptance</title><div id="root"></div><script type="module" src="/tests/rank-tracking-browser-fixture.tsx"></script></html>');});
let browser;
try{
 await server.listen();const addr=server.httpServer.address();assert.equal(addr.address,'127.0.0.1');const origin='http://127.0.0.1:'+addr.port;
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');browser=await chromium.launch({...process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{},headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 const errors=[],unexpected=[],calls=[],mutations=[],receipts=new Map();let role='owner',vault=true,trackers=[structuredClone(initial)],keywords=new Map([[tid,structuredClone(initialKeywords)]]),nextWrite=null,nextGet=null,held=null;
 const envelope=id=>({role,tracker:structuredClone(trackers.find(t=>t.id===id)),keywords:structuredClone(keywords.get(id)??[])});
 const locations=url=>{const country=Number(url.searchParams.get('countryCode'));return {role,rows:[local(country,country===2840?100:200,country===2840?'New York synthetic':'Paris synthetic')],total:1,nextOffset:null,verifiedAt:at};};
 const fulfill=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(url.origin!==origin){unexpected.push('external');return route.abort();}
  if(!path.startsWith('/api/'))return req.method()==='GET'?route.continue():route.abort();
  calls.push({method:req.method(),path,query:url.search,body:req.postDataJSON()});
  if(path==='/api/projects/'+alternatePid+'/rank-trackers')return fulfill(route,{role:'viewer',vaultConfigured:false,connections:[],trackers:[],nextCursor:null});
  if(!path.startsWith(base)){unexpected.push(path);return fulfill(route,{error:'Unknown fixture route'},404);}
  if(req.method()==='GET'&&nextGet){const mode=nextGet;nextGet=null;if(mode==='hold'){held={route,reply:path===base?{role,vaultConfigured:vault,connections:[{id:cid,name:'Synthetic\tDataForSEO\nconnection',checkStatus:'ok'}],trackers:structuredClone(trackers),nextCursor:null}:path===base+'/locations'?locations(url):envelope(path.slice(base.length+1))};return;}return fulfill(route,{error:'Synthetic access lost'},mode);}
  if(path===base&&req.method()==='GET'){
   const filter=url.searchParams.get('archived')??'active';return fulfill(route,{role,vaultConfigured:vault,connections:vault?[{id:cid,name:'Synthetic\tDataForSEO\nconnection',checkStatus:'ok'}]:[],trackers:trackers.filter(t=>filter==='all'||filter==='active'&&!t.archivedAt||filter==='archived'&&t.archivedAt),nextCursor:null});
  }
  if(path===base+'/catalog')return fulfill(route,{role,catalog:{countries,languages,verifiedAt:at}});
  if(path===base+'/locations'){
   return fulfill(route,locations(url));
  }
  if(req.method()==='GET')return fulfill(route,envelope(path.slice(base.length+1)));
  assert.equal(req.method(),'POST');const body=req.postDataJSON();mutations.push({path,body:structuredClone(body)});
  const mode=nextWrite;nextWrite=null;if(mode===409||mode===403||mode===429)return fulfill(route,{error:mode===409?'This tracker changed. Reload it before saving.':mode===429?'Wait before retrying.':'Synthetic access lost'},mode);
  let id=receipts.get(body.requestId);
  if(!id){
   id=path===base?randomUUID():path.slice(base.length+1).split('/')[0];
   if(path===base){const country=countries.find(c=>c.code===body.countryCode);trackers.unshift({...structuredClone(initial),...body,id,keywordCount:0,countryIso:country.countryIso,locationName:body.locationCode===body.countryCode?country.name:'Synthetic local',locationType:body.locationCode===body.countryCode?'Country':'City',languageName:languages.find(l=>l.code===body.languageCode).name});keywords.set(id,[]);}
   else{
    const tracker=trackers.find(t=>t.id===id);assert.ok(tracker);assert.equal(body.revision,tracker.authoredRevision,'Current authored revision');
    if(path.endsWith('/update')){for(const k of ['name','devices','depth','maxCrawlPages'])tracker[k]=body[k];}
    else if(path.endsWith('/archive'))tracker.archivedAt=body.archived?at:null;
    else if(path.endsWith('/keywords/add')){for(const raw of body.keywords){const word=body.matchCase?raw.trim():raw.trim().toLowerCase();if(!keywords.get(id).some(k=>k.keyword===word))keywords.get(id).push({id:randomUUID(),keyword:word,matchCase:body.matchCase,pinnedAt:null,createdAt:at});}}
    else if(path.endsWith('/keywords/remove'))keywords.set(id,keywords.get(id).filter(k=>!body.keywordIds.includes(k.id)));
    else if(path.endsWith('/keywords/pin'))keywords.get(id).forEach(k=>{if(body.keywordIds.includes(k.id))k.pinnedAt=body.pinned?at:null;});
    else throw new Error('Unknown mutation '+path);
    tracker.authoredRevision++;tracker.keywordCount=keywords.get(id).length;
   }
   receipts.set(body.requestId,id);
  }
  const reply={...envelope(id),replayed:mutations.filter(m=>m.body.requestId===body.requestId).length>1};
  if(mode==='drop')return route.abort('failed');
  if(mode==='malformed')return fulfill(route,{...reply,keywords:[{}]});
  if(mode==='malformed-uuid')return fulfill(route,{...reply,tracker:{...reply.tracker,id:reply.tracker.id+'\n'}});
  if(mode==='missing-ack'){const {replayed,...missing}=reply;return fulfill(route,missing);}
  if(mode==='hold'){held={route,reply};return;}
  return fulfill(route,reply);
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const openMain=async()=>{await page.getByRole('button',{name:/Synthetic main tracker/}).click();await page.getByText('literal C++ %20',{exact:true}).waitFor();};
 const settings=()=>page.locator('main summary').filter({hasText:/^Tracker settings$/}),openSettings=async()=>{if(!await settings().evaluate(node=>node.parentElement.open))await settings().click();};
 const findings=[],check=async(name,run)=>{try{await run();}catch(error){findings.push(name+': '+error.message);console.error('FAIL '+name+': '+error.message);}};
 const before=async(first,second)=>assert.equal(await first.evaluate((node,other)=>Boolean(node.compareDocumentPosition(other)&Node.DOCUMENT_POSITION_FOLLOWING),await second.elementHandle()),true,'Context and actions precede keyword results');
 const targets=async()=>{const short=[];for(const control of await page.locator('.rank-tracking button,.rank-tracking input:not([type=checkbox]),.rank-tracking select,.rank-tracking textarea,.rank-tracking summary').all()){if(!await control.isVisible())continue;const box=await control.boundingBox();if(!box||box.height<44)short.push({control:await control.getAttribute('id')||await control.innerText(),height:box?.height??null});}assert.deepEqual(short,[],'44px targets at every viewport');};
 await page.goto(origin);await page.getByRole('button',{name:'New tracker',exact:true}).waitFor();await openMain();
 assert.equal(calls.some(c=>c.path.endsWith('/catalog')||c.path.endsWith('/locations')),false,'Reading saved setup makes no catalog call');
 console.log('PASS authored details load without provider catalog calls.');
 await check('detail hierarchy',async()=>{
  const heading=page.getByRole('heading',{name:'Synthetic main tracker',exact:true}),header=heading.locator('xpath=ancestor::*[.//button[normalize-space()="Back to trackers"] and .//button[normalize-space()="Refresh tracker"]][1]'),table=page.getByRole('region',{name:'Keywords',exact:true});
  for(const name of ['Back to trackers','Refresh tracker'])assert.equal(await header.getByRole('button',{name,exact:true}).count(),1);assert.equal(await header.getByRole('region').count(),0);assert.equal(await settings().evaluate(node=>node.parentElement.open),false);assert.equal(await page.getByRole('button',{name:'Edit settings',exact:true,includeHidden:true}).count(),1);
  for(const text of ['example.com (including subdomains) · United States, US · English','Devices: Mobile · Requested results: 10 · Maximum billable pages: 1']){const item=page.getByText(text,{exact:true});assert.equal(await item.isVisible(),true);assert.equal(await item.evaluate(node=>node.closest('details')===null),true);}
  for(const name of ['Latest observations','Reporting','Check history','Schedule','Prepare a rank check','Pin selected','Unpin selected','Remove selected','Check selected keywords']){const action=page.getByRole('button',{name,exact:true});assert.equal(await action.evaluate(node=>node.closest('details')===null),true);await before(action,table);}
  assert.equal(await table.evaluate(node=>node.closest('details')===null),true);const keywordHeader=page.getByRole('heading',{name:'Keywords',exact:true}).locator('xpath=ancestor::*[.//button[normalize-space()="Add keywords"] and .//*[normalize-space()="2 of 1,000 keywords"]][1]');assert.equal(await keywordHeader.getByRole('button',{name:'Add keywords',exact:true}).count(),1);assert.equal(await keywordHeader.getByText('2 of 1,000 keywords',{exact:true}).count(),1);assert.equal(await keywordHeader.getByRole('region').count(),0);
  for(const name of ['Pin selected','Unpin selected','Remove selected','Check selected keywords'])assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);
  const count=calls.length;await settings().focus();await page.keyboard.press('Enter');await page.keyboard.press('Space');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(calls.length,count);assert.equal(mutations.length,0);assert.equal(await settings().evaluate(node=>node.parentElement.open),false);
 });
 await page.getByRole('button',{name:'Back to trackers',exact:true}).click();
 await page.getByRole('button',{name:'New tracker',exact:true}).click();
 await page.getByLabel(/connection/i).selectOption(cid);
 await page.getByRole('button',{name:'Load search options',exact:true}).click();
 await page.getByLabel('Country',{exact:true}).selectOption('2840');
 await page.getByLabel('Language',{exact:true}).selectOption('en');
 assert.equal(await page.getByLabel('Requested results',{exact:true}).inputValue(),'10');
 assert.equal(await page.getByLabel('Maximum billable pages',{exact:true}).inputValue(),'1');
 await page.getByLabel('Search targeting',{exact:true}).selectOption('local');
 await page.getByLabel('Find a city or region',{exact:true}).fill('New');
 nextGet='hold';await page.getByLabel('Find a city or region',{exact:true}).press('Enter');
 await page.waitForTimeout(50);assert.ok(held);assert.equal(mutations.length,0,'Local Enter must never submit create');
 await page.getByLabel('Country',{exact:true}).selectOption('2250');
 assert.equal(await page.getByLabel('Language',{exact:true}).inputValue(),'en');
 await fulfill(held.route,held.reply);held=null;
 assert.equal(await page.getByRole('option',{name:'New York synthetic',exact:true}).count(),0,'Old-country response is obsolete');
 await page.getByLabel('Find a city or region',{exact:true}).fill('Paris');
 await page.getByLabel('Find a city or region',{exact:true}).press('Enter');
 await page.getByRole('option',{name:'Paris synthetic',exact:true}).waitFor({state:'attached'});
 await page.getByLabel('City or region',{exact:true}).selectOption('200');
 assert.equal(mutations.length,0);
 console.log('PASS explicit local Enter search, unchanged language and late old-country response rejection.');
 await page.getByLabel(/^(Tracker name|Name)$/).fill('Created after lost acknowledgement');
 nextWrite='drop';await page.getByRole('button',{name:'Create tracker',exact:true}).click();
 await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();
 const createdAttempt=structuredClone(mutations.at(-1));
 await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();
 assert.equal(new URL(page.url()).pathname,'/','Unknown mutation must block actual router navigation');
 nextWrite=429;await page.getByRole('button',{name:'Retry same request',exact:true}).click();await page.getByText(/The retry was rate limited/).waitFor();assert.deepEqual(mutations.at(-1),createdAttempt);
 await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/','Rate-limited retry cannot discard the original possibly committed intent');
 nextWrite='malformed-uuid';await page.getByRole('button',{name:'Retry same request',exact:true}).click();
 await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();
 assert.deepEqual(mutations.at(-1),createdAttempt);
 nextWrite='missing-ack';await page.getByRole('button',{name:'Retry same request',exact:true}).click();
 await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();
 assert.deepEqual(mutations.at(-1),createdAttempt);
 await page.getByRole('button',{name:'Retry same request',exact:true}).click();
 await page.getByRole('heading',{name:'Created after lost acknowledgement',exact:true}).waitFor();
 assert.deepEqual(mutations.at(-1),createdAttempt,'Lost-ack retry preserves exact request ID, path and body');
 assert.equal(trackers.filter(t=>t.name==='Created after lost acknowledgement').length,1);
 assert.equal(receipts.size,1);
 console.log('PASS committed lost acknowledgement retains one request and blocks RouterProvider navigation until exact replay.');

 await openSettings();await page.getByRole('button',{name:'Edit settings',exact:true}).click();
 await check('edit opens and focuses its heading',async()=>{await page.waitForFunction(()=>document.activeElement?.id.endsWith('edit-heading'));assert.equal(await settings().evaluate(node=>node.parentElement.open),true);});
 await page.getByLabel(/^(Tracker name|Name)$/).fill('Edited after malformed acknowledgement');
 await check('native edit draft retention',async()=>{assert.equal(await settings().evaluate(node=>node.parentElement.open),true);for(const name of ['Devices','Requested results','Maximum billable pages'])assert.equal(await page.getByLabel(name,{exact:true}).isVisible(),true);const count=calls.length;await settings().click();assert.equal(await page.getByLabel('Tracker name',{exact:true}).inputValue(),'Edited after malformed acknowledgement');assert.equal(await page.getByLabel('Tracker name',{exact:true}).isVisible(),false);await openSettings();assert.equal(await page.getByLabel('Tracker name',{exact:true}).inputValue(),'Edited after malformed acknowledgement');assert.equal(calls.length,count);});
 await mkdir(resolve('private/rank-panel-evidence'),{recursive:true});await page.screenshot({path:resolve('private/rank-panel-evidence/r01-edit-draft.png'),fullPage:true});
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();
 assert.equal(new URL(page.url()).pathname,'/');
 nextWrite='malformed';await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();
 const editedAttempt=structuredClone(mutations.at(-1));
 await page.getByRole('button',{name:'Retry same request',exact:true}).click();
 await page.getByRole('heading',{name:'Edited after malformed acknowledgement',exact:true}).waitFor();
 assert.deepEqual(mutations.at(-1),editedAttempt,'Malformed nested2xx keeps original revision and request ID');
 assert.equal(trackers.find(t=>t.name==='Edited after malformed acknowledgement').authoredRevision,2);
 assert.equal(receipts.size,2);
 console.log('PASS dirty router navigation confirmation and nested malformed2xx recovery without duplicate authored change.');

 // A user can interrupt a held GET; its late response cannot navigate back.
 nextGet='hold';await page.getByRole('button',{name:'Refresh tracker',exact:true}).click();
 await page.waitForTimeout(50);assert.ok(held);
 await page.getByRole('button',{name:'Back to trackers',exact:true}).click();
 await page.getByRole('button',{name:'New tracker',exact:true}).waitFor();
 await fulfill(held.route,held.reply);held=null;
 await page.getByRole('button',{name:/Synthetic main tracker/}).waitFor();
 console.log('PASS held detail read can be interrupted and late response cannot restore old detail.');

 await openMain();
 await openSettings();await page.getByRole('button',{name:'Edit settings',exact:true}).click();
 await page.getByLabel('Tracker name',{exact:true}).fill('Conflicting edit');
 nextWrite=409;await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('button',{name:'Reload tracker',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Retry same request',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Save changes',exact:true}).isDisabled(),true);
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Reload tracker',exact:true}).click();
 await page.getByRole('heading',{name:'Synthetic main tracker',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Tracker name',{exact:true}).count(),0);
 console.log('PASS known revision conflict clears retry lock, retains draft, and requires explicit reload.');

 // A current denial must purge the view even when an older detail response arrives later.
 nextGet='hold';await page.getByRole('button',{name:'Refresh tracker',exact:true}).click();
 await page.waitForTimeout(50);assert.ok(held);
 assert.equal(await page.getByRole('button',{name:'Edit settings',exact:true}).count(),0,'Pending detail revalidation must not expose cached writer controls');
 nextGet=403;await page.getByRole('button',{name:'Back to trackers',exact:true}).click();
 await page.getByRole('button',{name:'Reload access',exact:true}).waitFor();
 await fulfill(held.route,held.reply);held=null;
 assert.equal(await page.getByText('literal C++ %20',{exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Edit settings',exact:true}).count(),0);
 await page.getByRole('button',{name:'Reload access',exact:true}).click();await openMain();
 console.log('PASS current403 purges protected state and supersedes held older reads; access reload recovers.');

 await openSettings();await page.getByRole('button',{name:'Edit settings',exact:true}).click();
 await page.getByLabel('Tracker name',{exact:true}).fill('Synthetic main tracker held write');
 nextWrite='hold';await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.waitForTimeout(50);assert.ok(held);
 assert.equal(await page.getByRole('button',{name:'Back to trackers',exact:true}).isDisabled(),true);
 await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/');
 await fulfill(held.route,held.reply);held=null;
 await page.getByRole('heading',{name:'Synthetic main tracker held write',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement?.id.endsWith('detail-heading')),true);
 await page.getByLabel('Select literal C++ %20',{exact:true}).check();
 await check('native settings retain keyword selection',async()=>{const count=calls.length;await openSettings();await settings().click();assert.equal(await page.getByLabel('Select literal C++ %20',{exact:true}).isChecked(),true);assert.equal(await page.getByText('1 selected',{exact:true}).isVisible(),true);assert.equal(calls.length,count);await before(page.getByRole('button',{name:'Pin selected',exact:true}),page.getByRole('region',{name:'Keywords',exact:true}));});
 await page.getByRole('button',{name:'Pin selected',exact:true}).click();
 await page.getByText('Pinned',{exact:true}).waitFor();
 await openSettings();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Archive tracker',exact:true}).click();
 await page.getByRole('button',{name:'Reactivate tracker',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Add keywords',exact:true}).count(),0);
 await page.screenshot({path:resolve('private/rank-panel-evidence/r01-archived-settings.png'),fullPage:true});
 await openSettings();await page.getByRole('button',{name:'Edit settings',exact:true}).click();
 assert.equal(await page.getByLabel('Devices',{exact:true}).isDisabled(),true);
 assert.equal(await page.getByLabel('Tracker name',{exact:true}).isDisabled(),false);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await openSettings();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Reactivate tracker',exact:true}).click();
 await page.getByRole('button',{name:'Archive tracker',exact:true}).waitFor();
 console.log('PASS active writes cannot be interrupted; explicit saves restore focus; pin/archive/reactivate preserve authored controls.');

 role='viewer';vault=false;await page.reload();await page.getByRole('button',{name:/Synthetic main tracker/}).waitFor();
 assert.equal(await page.getByRole('button',{name:'New tracker',exact:true}).count(),0);
 const viewerCalls=calls.length;await openMain();
 assert.equal(await settings().count(),0,'Viewers have no empty settings disclosure');
 assert.equal(await page.getByRole('button',{name:'Edit settings',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:/Archive tracker|Add keywords|Pin selected|Remove selected/}).count(),0);
 assert.equal(calls.slice(viewerCalls).some(c=>c.path.endsWith('/catalog')||c.path.endsWith('/locations')),false);
 console.log('PASS read-only viewer sees authored rows without vault and has no catalog or mutation actions.');
 await mkdir(resolve('private/rank-panel-evidence'),{recursive:true});
 for(const width of [1440,360]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:resolve('private/rank-panel-evidence/rank-detail-'+width+'.png'),fullPage:true});}
 role='owner';vault=true;await page.reload();await page.getByRole('button',{name:/Synthetic main tracker/}).waitFor();
 await page.screenshot({path:resolve('private/rank-panel-evidence/rank-list-360.png'),fullPage:true});
 await page.getByRole('button',{name:'New tracker',exact:true}).click();
 await page.getByLabel('DataForSEO connection',{exact:true}).selectOption(cid);await page.getByRole('button',{name:'Load search options',exact:true}).click();
 await page.getByLabel('Country',{exact:true}).selectOption('2840');await page.getByLabel('Language',{exact:true}).selectOption('en');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:resolve('private/rank-panel-evidence/rank-create-360.png'),fullPage:true});
 const primary=await page.getByRole('button',{name:'Create tracker',exact:true}).boundingBox();assert.ok(primary.height>=44);
 for(const width of [320,360,768,1440])await check('creation root '+width,async()=>{await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await targets();});
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Cancel',exact:true}).focus();await page.keyboard.press('Enter');
 await page.getByRole('button',{name:'New tracker',exact:true}).waitFor();
 nextGet='hold';await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForTimeout(50);assert.ok(held);
 await page.evaluate(id=>window.rankHarness.scope({projectId:id}),alternatePid);
 await page.getByText('No active trackers',{exact:true}).waitFor();await fulfill(held.route,held.reply);held=null;
 assert.equal(await page.getByRole('button',{name:/Synthetic main tracker/}).count(),0);
 assert.equal(await page.getByRole('button',{name:'New tracker',exact:true}).count(),0);
 await page.evaluate(id=>window.rankHarness.scope({projectId:id}),pid);await page.getByRole('button',{name:'New tracker',exact:true}).waitFor();
 console.log('PASS360px creation/list,44px action, keyboard cancel and project-remount rejection of old-scope data.');
 vault=false;await page.reload();await page.getByRole('button',{name:'New tracker',exact:true}).click();
 await page.getByRole('button',{name:'Open providers',exact:true}).click();assert.equal(await page.evaluate(()=>window.rankHarness.read().providers),1);
 role='admin';await page.reload();await page.getByRole('button',{name:'New tracker',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Open providers',exact:true}).count(),0);await page.getByText('Ask a workspace owner to configure DataForSEO.',{exact:true}).waitFor();
 role='owner';vault=true;await page.reload();await page.getByRole('button',{name:'New tracker',exact:true}).waitFor();
 console.log('PASS provider repair is owner-only; admin receives an actionable owner request without a dead link.');
 nextGet=401;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('heading',{name:'Fixture signed out',exact:true}).waitFor();
 assert.equal(await page.getByText('literal C++ %20',{exact:true}).count(),0);
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 console.log('PASS401 clears scope, read-only1440/360px layout has no page overflow, and no external/provider traffic.');
 // Further UI checks use this same contained controller and existing synthetic route handler.
 const longName='T'.repeat(120),longKeyword='K'.repeat(195)+' C++%';Object.assign(trackers.find(t=>t.id===tid),{name:longName,domain:'a'.repeat(241)+'.example.com',locationName:'L'.repeat(512)});keywords.get(tid)[0].keyword=longKeyword;
 await page.reload();await page.getByRole('button',{name:longName,exact:true}).waitFor();
 for(const width of [320,360,768,1440])await check('list root '+width,async()=>{await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await targets();});
 nextGet='hold';await page.getByRole('button',{name:longName,exact:true}).click();await page.waitForFunction(()=>document.querySelector('.rank-tracking')?.textContent.includes('Loading tracker access'));await page.waitForTimeout(50);assert.ok(held);await check('loading root targets',targets);await fulfill(held.route,held.reply);held=null;await page.getByRole('heading',{name:longName,exact:true}).waitFor();
 const region=page.getByRole('region',{name:'Keywords',exact:true});for(const direction of ['ltr','rtl'])for(const width of [320,360,768,1440])await check('detail '+direction+' '+width,async()=>{
  await page.evaluate(value=>{document.documentElement.dir=value;},direction);await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await targets();assert.equal(await page.getByText(longKeyword,{exact:true}).isVisible(),true);assert.equal(await settings().evaluate(node=>node.parentElement.open),false);
  for(const checkbox of await region.getByRole('checkbox').all()){const label=checkbox.locator('..');assert.equal(await label.evaluate(node=>node.tagName),'LABEL');const box=await label.boundingBox();assert.ok(box&&box.width>=44&&box.height>=44,'Native keyword labels provide44px targets');}
  if(width<=360){await region.evaluate(node=>{node.scrollLeft=0;});await region.focus();await page.keyboard.press(direction==='rtl'?'ArrowLeft':'ArrowRight');await page.waitForFunction(()=>Math.abs(document.querySelector('[role=region][aria-label=Keywords]').scrollLeft)>0);}
  await page.screenshot({path:resolve('private/rank-panel-evidence/r01-detail-'+width+'-'+direction+'.png'),fullPage:true});
 });
 await page.evaluate(()=>{document.documentElement.dir='ltr';document.documentElement.style.zoom='2';});await page.setViewportSize({width:1440,height:1000});await check('200% CSS layout zoom',async()=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await region.isVisible(),true);await page.screenshot({path:resolve('private/rank-panel-evidence/r01-layout-zoom.png'),fullPage:true});});await page.evaluate(()=>{document.documentElement.style.zoom='';});
 await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});await settings().focus();await check('forced colors and native focus',async()=>{assert.notEqual(await settings().evaluate(node=>getComputedStyle(node).outlineStyle),'none');assert.equal(await settings().evaluate(node=>getComputedStyle(node).display),'list-item');await page.screenshot({path:resolve('private/rank-panel-evidence/r01-forced-colors.png'),fullPage:true});});await page.emulateMedia({forcedColors:'none'});
 await page.getByRole('button',{name:'Add keywords',exact:true}).click();await page.getByLabel('Keywords, one per line',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.activeElement?.id.endsWith('add-heading')),true);await targets();await page.getByLabel('Keywords, one per line',{exact:true}).fill('  C++ %20\n\nMiXeD\nMiXeD');await page.getByLabel('Preserve keyword case',{exact:true}).check();
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.getByLabel('Keywords, one per line',{exact:true}).inputValue(),'  C++ %20\n\nMiXeD\nMiXeD');await page.screenshot({path:resolve('private/rank-panel-evidence/r01-add-draft.png'),fullPage:true});
 const added=mutations.length;await page.getByRole('button',{name:'Add keywords',exact:true}).click();await page.getByText('C++ %20',{exact:true}).waitFor();assert.equal(mutations.length,added+1);assert.deepEqual(mutations.at(-1).body.keywords,['  C++ %20','MiXeD','MiXeD']);assert.equal(mutations.at(-1).body.matchCase,true);assert.equal(await page.getByText('MiXeD',{exact:true}).count(),1);assert.equal(await region.locator('tbody tr').count(),4);
 await page.getByLabel('Select all keywords',{exact:true}).check();assert.equal(await page.getByText('4 selected',{exact:true}).isVisible(),true);await page.getByRole('button',{name:'Unpin selected',exact:true}).click();await page.getByText('0 selected',{exact:true}).waitFor();assert.equal(mutations.at(-1).body.pinned,false);assert.equal(mutations.at(-1).body.keywordIds.length,4);
 await page.getByLabel('Select all keywords',{exact:true}).check();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Remove selected',exact:true}).click();await page.getByText('No keywords yet',{exact:true}).waitFor();assert.equal(await region.count(),0);assert.equal(await page.getByRole('button',{name:'Prepare a rank check',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Check selected keywords',exact:true}).isDisabled(),true);
 nextGet=403;await page.getByRole('button',{name:'Refresh tracker',exact:true}).click();await page.getByRole('button',{name:'Reload access',exact:true}).waitFor();for(const width of [320,360,768,1440])await check('denied root '+width,async()=>{await page.setViewportSize({width,height:1000});await targets();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);});
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);assert.deepEqual(findings,[],'Every R01 hierarchy, draft and target requirement must pass');console.log('PASS native settings/order/draft retention, all-mode44px targets, long-text LTR/RTL/zoom/forced colors and explicit case-preserving add/unpin/remove without paid work.');
}finally{await browser?.close();await server.close();}
