// Actual App/router with a closed loopback API fixture; no backend/provider acceptance.
// TEN98_CONTEXT_TABS_BROWSER=1 PLAYWRIGHT_MODULE=<installed entry> node tests/context-tabs-browser.ts
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {launchChromium,setViewport} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_CONTEXT_TABS_BROWSER,'1');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const W='10000000-0000-4000-8000-000000000001',P='20000000-0000-4000-8000-000000000001',U='30000000-0000-4000-8000-000000000001',ID='40000000-0000-4000-8000-000000000001',stamp='2026-11-03T00:00:00Z';
const user={id:U,name:'Synthetic persona user',email:'personas@example.com'};
type Role='owner'|'viewer';
type Persona={id:string;name:string;description:string;updatedAt:string;updatedBy:string};
type ContextModel={project:{id:string;name:string;origin:string};role:Role;revision:number;profile:{name:string;aliases:string[]};sections:unknown[];missingSections:string[];customSections:{key:string;title:string;content:string;updatedAt:string;updatedBy:string}[];personas:Persona[];competitors:Competitor[];keyPages:KeyPage[];researchLog:{id:string;entryDate:string;summary:string;createdAt:string;createdBy:string}[];researchLogNextCursor:string|null;reportTemplates:{id:string;name:string;preview:string;truncated:boolean}[];reportTemplatesTruncated:boolean};
type Competitor={id:string;primaryDomain:string;name:string;domains:string[];aliases:string[];notes:string;updatedAt:string;updatedBy:string};
type KeyPage={id:string;url:string;role:'other'|'hub'|'spoke'|'money';topic:string;notes:string;updatedAt:string;updatedBy:string};
type SaveOperation={kind:'profile';name:string;aliases:string[]}|{kind:'competitor';primaryDomain:string;name:string;domains:string[];aliases:string[];notes:string}|{kind:'key-page';url:string;role:KeyPage['role'];topic:string;notes:string}|{kind:'remove-competitor'|'remove-key-page';id:string}|{kind:'persona';id:string;name:string;description:string}|{kind:'remove-persona';id:string};
type SaveAttempt={requestId:string;revision:number;updates:SaveOperation[]};
type Receipt={request:string;body:ContextModel};
const original=(role:Role='owner',personas:Persona[]=[]):ContextModel=>({project:{id:P,name:'Synthetic project',origin:'https://context.example'},role,revision:1,profile:{name:'Saved brand',aliases:[]},sections:[],missingSections:['business_overview','current_goal','positioning','writing_preferences'],customSections:[{key:'custom:audience',title:'Audience',content:'Saved audience',updatedAt:stamp,updatedBy:U}],personas,competitors:[],keyPages:[],researchLog:[{id:ID,entryDate:'2026-11-03',summary:'Saved research note',createdAt:stamp,createdBy:U}],researchLogNextCursor:'older',reportTemplates:[{id:ID,name:'Weekly report',preview:'Saved report preview',truncated:true}],reportTemplatesTruncated:false});
const persona=(id=ID,name='Research lead',description='Needs dependable research'):Persona=>({id,name,description,updatedAt:stamp,updatedBy:U});
const screenshots=resolve('private/swarm/context-tabs');mkdirSync(screenshots,{recursive:true});
const errors:string[]=[],unexpected:string[]=[],groups:string[]=[];
// Playwright comes from the caller's installed runtime, as in the other native browser suites.
let browser:any,context:any,page:any;
let origin='',model:ContextModel=original(),writeMode:'lost'|403|409|null=null,writes:string[]=[],receipts=new Map<string,Receipt>(),apiRequests=0,contexts=0;
const server=await createServer({configFile:false,envDir:false,root:process.cwd(),cacheDir:resolve('private/swarm/context-tabs-vite-cache'),appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{entries:['tests/context-exit-browser-fixture.tsx'],include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router','zod']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic context tabs</title><div id="root"></div><script type="module" src="/tests/context-exit-browser-fixture.tsx"></script></html>');});
const watchdog=setTimeout(()=>process.exit(124),120000);watchdog.unref();
const deadline=setTimeout(()=>{console.error('Context tabs check exceeded 110 seconds');void Promise.allSettled([context?.close(),browser?.close(),server.close()]).finally(()=>process.exit(1));},110000);deadline.unref();
const button=(name:string)=>page.getByRole('button',{name,exact:true}),panel=()=>page.getByRole('region',{name:'Project context',exact:true});
const frame=()=>page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
const pass=(label:string)=>{groups.push(label);console.log('PASS '+label);};
const json=(route:any,body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
async function fresh(role:Role='owner',personas:Persona[]=[]){
 await context?.close();model=original(role,personas);writeMode=null;writes=[];receipts=new Map();assert.ok(++contexts<=24,'24-context cap');
 context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});
 await context.route('**/*',async (route:any)=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  try{
   if(url.origin!==origin){unexpected.push(url.href);return route.abort();}if(!path.startsWith('/api/'))return req.method()==='GET'?route.continue():route.abort();
   assert.ok(++apiRequests<=100,'100-request cap');let body:unknown;
   if(path==='/api/session')body={setupRequired:false,appUrl:origin,user:null};
   else if(path==='/api/me')body={user,instanceOperator:false,workspaces:[{id:W,name:'Synthetic workspace',role}]};
   else if(path==='/api/account/preferences')body={version:'account-preferences-v1',user,preferences:{revision:1,timeZone:'UTC',locale:'en-US',theme:'light',updatedAt:stamp}};
   else if(path==='/api/auth/oidc/providers')body={providers:[]};
   else if(path===`/api/workspaces/${W}/projects`)body={projects:[{id:P,name:'Synthetic project',origin:'https://context.example',publicKey:'synthetic-key',eventCount:0,lastEventAt:null,retainedFrom:null}]};
   else if(path===`/api/projects/${P}/events`)body={events:[],total:0,retainedFrom:null};
   else if(path===`/api/projects/${P}/context`&&req.method()==='GET')body=structuredClone(model);
   else if(path===`/api/projects/${P}/context/research-log`){assert.equal(url.searchParams.get('cursor'),'older');body={entries:[{id:'older-note',entryDate:'2026-11-02',summary:'Older research note',createdAt:stamp,createdBy:U}],nextCursor:null};}
   else if(path===`/api/projects/${P}/context/update`&&req.method()==='POST'){
    writes.push(req.postData());const attempt:SaveAttempt=req.postDataJSON();assert.match(attempt.requestId,/^[0-9a-f-]{36}$/i);assert.equal(attempt.updates.length,1);
    if(writeMode===409||writeMode===403)return json(route,{error:'Synthetic persona save status '+writeMode},writeMode);
    if(receipts.has(attempt.requestId)){const receipt=receipts.get(attempt.requestId)!;assert.equal(req.postData(),receipt.request,'A repeated request ID keeps the exact body');return json(route,receipt.body);}
    assert.equal(attempt.revision,model.revision);assert.notEqual(role,'viewer');const op=attempt.updates[0];
    if(op.kind==='profile'){model.profile={name:op.name,aliases:op.aliases};}
    else if(op.kind==='competitor'){const record={...op,id:ID,updatedAt:stamp,updatedBy:U};delete (record as {kind?:string}).kind;model.competitors=[record];}
    else if(op.kind==='key-page'){const record={...op,id:ID,updatedAt:stamp,updatedBy:U};delete (record as {kind?:string}).kind;model.keyPages=[record];}
    else if(op.kind==='remove-competitor'){assert.equal(op.id,ID);model.competitors=[];}
    else if(op.kind==='remove-key-page'){assert.equal(op.id,ID);model.keyPages=[];}
    else if(op.kind==='persona'){
     assert.match(op.id,/^[0-9a-f-]{36}$/i);assert.ok(op.name.trim().length>=1&&op.name.length<=120);assert.ok(op.description.length<=4000);
     const index=model.personas.findIndex(row=>row.id===op.id),record=persona(op.id,op.name,op.description);
     if(index<0){assert.ok(model.personas.length<20);model.personas.push(record);}else model.personas[index]=record;
    }else if(op.kind==='remove-persona'){assert.ok(model.personas.some(row=>row.id===op.id));model.personas=model.personas.filter(row=>row.id!==op.id);}
    else assert.fail('Unexpected context operation '+(op as {kind:string}).kind);
    model.revision++;const savedContext=structuredClone(model);body=savedContext;receipts.set(attempt.requestId,{request:req.postData(),body:savedContext});
    if(writeMode==='lost')return route.abort('connectionreset');
   }else{unexpected.push(req.method()+' '+path);return route.abort();}
   return json(route,body);
  }catch(error){errors.push('Fixture: '+(error instanceof Error?error.message:String(error)));return route.abort();}
 });
 page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',(error:Error)=>errors.push(error.message));
 await page.goto(origin+'/?'+new URLSearchParams({workspace:W,project:P,view:'context'}));
 await panel().getByText('Saved brand',{exact:true}).waitFor();await page.waitForFunction(()=>![...document.querySelectorAll('[role=status]')].some(el=>el.textContent==='Loading context…'));await frame();
}
const tab=(label:string)=>panel().getByRole('tab',{name:label,exact:true});
const field=(label:string)=>page.getByRole('textbox',{name:label,exact:true});
async function choose(label:string){await tab(label).click();await frame();assert.equal(await tab(label).getAttribute('aria-selected'),'true');for(const other of ['Brand','Competitors','Pages','Personas','Notes']){const controlled=await tab(other).getAttribute('aria-controls');assert.ok(controlled);assert.equal(await page.locator('[id=\"'+controlled+'\"]').isVisible(),other===label,'Only the selected tab panel is visible');}}
async function details(label:string,expected:string[]){const table=page.getByRole('table',{name:label,exact:true}),toggle=table.getByRole('button',{name:'Details for row 1',exact:true});assert.equal(await toggle.getAttribute('aria-expanded'),'false');await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'true');for(const text of expected){const content=table.getByText(text,{exact:true});await content.waitFor();assert.equal(await content.textContent(),text,'Expanded detail preserves the complete saved text');}return toggle;}
async function saveForm(){await button('Save changes').click();await page.getByText('Changes saved. No provider work was started.',{exact:true}).waitFor();await frame();assert.equal(await page.getByRole('form',{name:'Edit project context'}).count(),0);}
async function deleteRow(label:string,title:string){await button(label).click();await page.getByRole('dialog',{name:title,exact:true}).getByRole('button',{name:'Delete',exact:true}).click();await page.getByText('Changes saved. No provider work was started.',{exact:true}).waitFor();await frame();}

try{
 await server.listen();const address=server.httpServer?.address();assert.ok(address&&typeof address==='object');assert.equal(address.address,'127.0.0.1');origin='http://127.0.0.1:'+address.port;
 await server.environments.client.transformRequest('/tests/context-exit-browser-fixture.tsx');await server.environments.client.waitForRequestsIdle();const optimizer=server.environments.client.depsOptimizer;assert.ok(optimizer);await optimizer.scanProcessing;await Promise.all(Object.values(optimizer.metadata.discovered).map(item=>item.processing));browser=await launchChromium();
 await fresh();
 assert.deepEqual(await panel().getByRole('tab').allTextContents(),['Brand','Competitors','Pages','Personas','Notes'],'The actual context UI exposes the five accepted tabs');
 const location=page.url(),requests=apiRequests;
 await tab('Brand').focus();await page.keyboard.press('ArrowRight');await frame();assert.equal(await tab('Competitors').evaluate((node:HTMLElement)=>document.activeElement===node),true);await page.keyboard.press('Enter');await frame();
 await choose('Brand');await panel().getByText('Saved audience',{exact:true}).waitFor();await button('Edit business context').click();await field('Brand name').fill('Cross-tab brand draft');
 for(const label of ['Competitors','Pages','Personas','Notes','Brand']){await choose(label);assert.equal(await field('Brand name').inputValue(),'Cross-tab brand draft');assert.equal(page.url(),location);}
 assert.equal(apiRequests,requests,'Tab switches dispatch no API work');assert.equal(writes.length,0);await saveForm();assert.deepEqual(JSON.parse(writes[0]).updates,[{kind:'profile',name:'Cross-tab brand draft',aliases:[]}]);pass('Five canonical tabs and keyboard navigation preserve the top editor draft and query without requests');
 await choose('Competitors');await button('Add competitor').click();await field('Primary domain').fill('rival.example');await field('Competitor name').fill('Rival');await field('Additional domains, one per line').fill('other.example');await field('Competitor aliases, one per line').fill('Rival alias');await field('Competitor notes').fill('Full competitor notes');await saveForm();
 assert.deepEqual(JSON.parse(writes[1]).updates,[{kind:'competitor',primaryDomain:'rival.example',name:'Rival',domains:['rival.example','other.example'],aliases:['Rival alias'],notes:'Full competitor notes'}]);
 await page.getByRole('table',{name:'Competitors',exact:true}).waitFor();await (await details('Competitors',['other.example','Rival alias','Full competitor notes'])).click();await button('Edit rival.example').click();assert.equal(await field('Primary domain').getAttribute('readonly'),'');await field('Competitor notes').fill('Edited competitor notes');await saveForm();await deleteRow('Delete rival.example','Delete this competitor?');assert.deepEqual(JSON.parse(writes[3]).updates,[{kind:'remove-competitor',id:ID}]);pass('Competitor table add/edit/delete uses exact native operations and immutable primary domain');
 await choose('Pages');await button('Add key page').click();await field('Page URL').fill('https://context.example/guide?version=1');await page.getByRole('combobox',{name:'Page role',exact:true}).selectOption('hub');await field('Page topic').fill('Guide');await field('Page notes').fill('Full page notes');await saveForm();
 assert.deepEqual(JSON.parse(writes[4]).updates,[{kind:'key-page',url:'https://context.example/guide?version=1',role:'hub',topic:'Guide',notes:'Full page notes'}]);await page.getByRole('table',{name:'Pages',exact:true}).waitFor();await (await details('Pages',['https://context.example/guide?version=1','Full page notes'])).click();await button('Edit page Guide').click();assert.equal(await field('Page URL').getAttribute('readonly'),'');await field('Page notes').fill('Edited page notes');await saveForm();await deleteRow('Delete page Guide','Delete this key page?');assert.deepEqual(JSON.parse(writes[6]).updates,[{kind:'remove-key-page',id:ID}]);
 await choose('Notes');await panel().getByText('Saved research note',{exact:true}).waitFor();await panel().getByText('Saved report preview',{exact:true}).waitFor();await panel().getByText('Preview shortened to 200 characters.',{exact:true}).waitFor();await button('Load older entries').click();await panel().getByText('Older research note',{exact:true}).waitFor();assert.equal(await button('Load older entries').count(),0);pass('Page table operations preserve saved URLs and roles; Notes retains pagination and report previews');
 await fresh('viewer',[persona()]);model.competitors=[{id:ID,primaryDomain:'rival.example',name:'Rival',domains:['rival.example','other.example'],aliases:['Rival alias'],notes:'Long competitor notes '.repeat(20),updatedAt:stamp,updatedBy:U}];model.keyPages=[{id:ID,url:'https://context.example/'+('long-path/'.repeat(20)),role:'hub',topic:'Guide',notes:'Long page notes '.repeat(20),updatedAt:stamp,updatedBy:U}];await button('Refresh').click();await panel().getByText('Saved brand',{exact:true}).waitFor();await frame();
 for(const label of ['Brand','Competitors','Pages','Personas','Notes']){await choose(label);assert.equal(await panel().getByRole('button',{name:/^(Add |Edit |Delete )/}).count(),0);}
 await choose('Personas');await panel().getByText('Needs dependable research',{exact:true}).waitFor();assert.equal(writes.length,0);pass('Viewer reads all five views and receives no mutation controls');
 for(const width of [1440,320]){await setViewport(page,{width,height:900});await page.evaluate((n:number)=>{document.documentElement.dir=n===320?'rtl':'ltr';document.documentElement.style.fontSize=n===320?'200%':'100%';},width);for(const theme of ['light','dark']){await page.evaluate((value:string)=>{document.documentElement.dataset.theme=value;document.documentElement.style.colorScheme=value;},theme);for(const label of ['Competitors','Pages']){await choose(label);await page.getByRole('table',{name:label,exact:true}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No document overflow '+label+width+theme);assert.ok(await panel().evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth+1),'No context overflow '+label+width+theme);if(width===1440&&label==='Competitors'){const domain=page.getByRole('table',{name:label,exact:true}).getByText('rival.example',{exact:true});assert.ok(await domain.evaluate((node:HTMLElement)=>node.getBoundingClientRect().height<=parseFloat(getComputedStyle(node).lineHeight)*1.5),'Primary domain remains one line at desktop width');}await page.screenshot({path:resolve(screenshots,label+'-'+width+'-'+theme+'.png'),fullPage:true});const before=apiRequests;const fullText=label==='Competitors'?['other.example','Rival alias',model.competitors[0].notes]:[model.keyPages[0].url,model.keyPages[0].notes];const toggle=await details(label,fullText);assert.equal(await panel().getByRole('button',{name:/^(Add |Edit |Delete )/}).count(),0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Expanded details do not overflow');await page.screenshot({path:resolve(screenshots,label+'-'+width+'-'+theme+'-expanded.png'),fullPage:true});await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(apiRequests,before,'Viewer expansion makes no API request');assert.equal(writes.length,0);}}}pass('Shared tables retain full content at wide and 320px RTL/200% light and dark layouts');
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS '+groups.length+' context-tabs groups / '+apiRequests+' API requests / '+contexts+' contexts; synthetic client behavior only; zero external requests or page errors');
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:resolve(screenshots,'failure.png'),fullPage:false,timeout:1500}).catch(()=>{});console.error('FAILURE_AX '+await page.locator('body').ariaSnapshot({timeout:1500}).catch(()=>'<unavailable>'));}throw error;}finally{clearTimeout(deadline);await context?.close();await browser?.close();await server.close();assert.equal(browser?.isConnected()??false,false);assert.equal(server.httpServer?.listening??false,false);console.log('CLEANUP owned browser and loopback Vite stopped');clearTimeout(watchdog);}
