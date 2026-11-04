// Actual App/router with a closed loopback API fixture; no backend/provider acceptance.
// TEN98_PERSONA_CONTEXT_BROWSER=1 PLAYWRIGHT_MODULE=<installed entry> node tests/persona-context-browser.ts
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {launchChromium,setViewport} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_PERSONA_CONTEXT_BROWSER,'1');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const W='10000000-0000-4000-8000-000000000001',P='20000000-0000-4000-8000-000000000001',U='30000000-0000-4000-8000-000000000001',ID='40000000-0000-4000-8000-000000000001',stamp='2026-11-03T00:00:00Z';
const user={id:U,name:'Synthetic persona user',email:'personas@example.com'};
type Role='owner'|'viewer';
type Persona={id:string;name:string;description:string;updatedAt:string;updatedBy:string};
type ContextModel={project:{id:string;name:string;origin:string};role:Role;revision:number;profile:{name:string;aliases:string[]};sections:unknown[];missingSections:string[];customSections:unknown[];personas:Persona[];competitors:unknown[];keyPages:unknown[];researchLog:unknown[];researchLogNextCursor:null;reportTemplates:unknown[];reportTemplatesTruncated:boolean};
type SaveOperation={kind:'persona';id:string;name:string;description:string}|{kind:'remove-persona';id:string};
type SaveAttempt={requestId:string;revision:number;updates:SaveOperation[]};
type Receipt={request:string;body:ContextModel};
const original=(role:Role='owner',personas:Persona[]=[]):ContextModel=>({project:{id:P,name:'Synthetic project',origin:'https://context.example'},role,revision:1,profile:{name:'Saved brand',aliases:[]},sections:[],missingSections:['business_overview','current_goal','positioning','writing_preferences'],customSections:[],personas,competitors:[],keyPages:[],researchLog:[],researchLogNextCursor:null,reportTemplates:[],reportTemplatesTruncated:false});
const persona=(id=ID,name='Research lead',description='Needs dependable research'):Persona=>({id,name,description,updatedAt:stamp,updatedBy:U});
const screenshots=resolve('private/swarm/persona-context');mkdirSync(screenshots,{recursive:true});
const errors:string[]=[],unexpected:string[]=[],groups:string[]=[];
// Playwright comes from the caller's installed runtime, as in the other native browser suites.
let browser:any,context:any,page:any;
let origin='',model:ContextModel=original(),writeMode:'lost'|403|409|null=null,writes:string[]=[],receipts=new Map<string,Receipt>(),apiRequests=0,contexts=0;
const server=await createServer({configFile:false,envDir:false,root:process.cwd(),cacheDir:resolve('private/swarm/persona-context-vite-cache'),appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{entries:['tests/context-exit-browser-fixture.tsx'],include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router','zod']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic persona context</title><div id="root"></div><script type="module" src="/tests/context-exit-browser-fixture.tsx"></script></html>');});
const watchdog=setTimeout(()=>process.exit(124),120000);watchdog.unref();
const deadline=setTimeout(()=>{console.error('Persona context check exceeded 110 seconds');void Promise.allSettled([context?.close(),browser?.close(),server.close()]).finally(()=>process.exit(1));},110000);deadline.unref();
const button=(name:string)=>page.getByRole('button',{name,exact:true}),name=()=>page.getByRole('textbox',{name:'Persona name',exact:true}),description=()=>page.getByRole('textbox',{name:'Persona description',exact:true}),panel=()=>page.getByRole('region',{name:'Project context',exact:true});
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
   else if(path===`/api/projects/${P}/context/update`&&req.method()==='POST'){
    writes.push(req.postData());const attempt:SaveAttempt=req.postDataJSON();assert.match(attempt.requestId,/^[0-9a-f-]{36}$/i);assert.equal(attempt.updates.length,1);
    if(writeMode===409||writeMode===403)return json(route,{error:'Synthetic persona save status '+writeMode},writeMode);
    if(receipts.has(attempt.requestId)){const receipt=receipts.get(attempt.requestId)!;assert.equal(req.postData(),receipt.request,'A repeated request ID keeps the exact body');return json(route,receipt.body);}
    assert.equal(attempt.revision,model.revision);assert.notEqual(role,'viewer');const op=attempt.updates[0];
    if(op.kind==='persona'){
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
 await panel().getByText('Saved brand',{exact:true}).waitFor();await page.waitForFunction(()=>![...document.querySelectorAll('[role=status]')].some(el=>el.textContent==='Loading context…'));await frame();await page.getByRole('tab',{name:'Personas',exact:true}).click();await frame();
}
async function editPersona(personaName='Research lead',text='Needs dependable research'){
 await button('Add persona').click();assert.equal(await name().evaluate((node:HTMLElement)=>document.activeElement===node),true);await name().fill(personaName);await description().fill(text);
}
async function saved(){await page.getByText('Changes saved. No provider work was started.',{exact:true}).waitFor();await frame();assert.equal(await name().count(),0);}
async function confirmDelete(accept=true){
 await button('Delete persona Research lead').click();const dialog=page.getByRole('dialog',{name:'Delete this persona?',exact:true});await dialog.getByRole('button',{name:accept?'Delete':'Cancel',exact:true}).click();await dialog.waitFor({state:'hidden'});await frame();
}
async function cancelledExit(){
 let count=0;const listener=async (dialog:any)=>{count++;assert.equal(dialog.type(),'confirm');await dialog.dismiss();};page.on('dialog',listener);
 try{await page.locator('.t98-shell-sidebar').getByRole('link',{name:'Settings',exact:true}).click();await frame();assert.equal(count,1);assert.equal(new URL(page.url()).searchParams.get('view'),'context');}finally{page.off('dialog',listener);}
}
async function geometry(label:string){
 await frame();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Document has no horizontal overflow: '+label);
 assert.ok(await panel().evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth+1),'Project context has no horizontal overflow: '+label);
 for(const control of [name(),description()]){const box=await control.boundingBox();assert.ok(box&&box.x>=-1&&box.x+box.width<=await page.evaluate(()=>innerWidth)+1,'Labelled persona control fits viewport: '+label);}
 await page.screenshot({path:resolve(screenshots,label+'.png'),fullPage:true});
 await name().scrollIntoViewIfNeeded();await page.screenshot({path:resolve(screenshots,label+'-viewport.png'),fullPage:false});
}
try{
 await server.listen();const address=server.httpServer?.address();assert.ok(address&&typeof address==='object');assert.equal(address.address,'127.0.0.1');origin='http://127.0.0.1:'+address.port;
 await server.environments.client.transformRequest('/tests/context-exit-browser-fixture.tsx');await server.environments.client.waitForRequestsIdle();const optimizer=server.environments.client.depsOptimizer;assert.ok(optimizer);await optimizer.scanProcessing;await Promise.all(Object.values(optimizer.metadata.discovered).map(item=>item.processing));browser=await launchChromium();
 await fresh();await button('Add persona').waitFor();await editPersona();await button('Save changes').click();await saved();
 const created=(JSON.parse(writes[0]) as SaveAttempt).updates[0];assert.deepEqual(created,{kind:'persona',id:model.personas[0].id,name:'Research lead',description:'Needs dependable research'});
 await button('Edit persona Research lead').click();assert.equal(await name().inputValue(),'Research lead');assert.equal(await description().inputValue(),'Needs dependable research');await description().fill('Prefers clear evidence');await button('Save changes').click();await saved();assert.equal(JSON.parse(writes[1]).updates[0].id,created.id);assert.equal(model.personas[0].description,'Prefers clear evidence');
 await confirmDelete(false);assert.equal(writes.length,2);await confirmDelete();await saved();assert.deepEqual(JSON.parse(writes[2]).updates,[{kind:'remove-persona',id:created.id}]);assert.equal(model.personas.length,0);pass('Create, edit and confirmed delete use the actual context UI, stable persona ID and native context operations');
 await fresh();await editPersona('Retry persona','Keep this exact description');writeMode='lost';await button('Save changes').click();await button('Retry same save').waitFor();await cancelledExit();await page.getByRole('tab',{name:'Notes',exact:true}).click();await page.getByRole('tab',{name:'Personas',exact:true}).click();assert.equal(await name().inputValue(),'Retry persona');assert.equal(await name().isDisabled(),true);assert.equal(writes.length,1);assert.equal(model.personas.length,1);writeMode=null;await button('Retry same save').click();await saved();assert.equal(writes.length,2);assert.equal(writes[0],writes[1]);assert.equal(model.personas.length,1);pass('Lost acknowledgement preserves draft, persona ID and exact save body until explicit retry without duplicate personas');
 await fresh();await editPersona('Conflict persona','Draft stays here');writeMode=409;await button('Save changes').click();await button('Reload saved data (discard draft)').waitFor();assert.equal(await name().inputValue(),'Conflict persona');assert.equal(await description().inputValue(),'Draft stays here');await cancelledExit();await page.getByRole('tab',{name:'Brand',exact:true}).click();await page.getByRole('tab',{name:'Personas',exact:true}).click();assert.equal(await name().inputValue(),'Conflict persona');assert.equal(writes.length,1);assert.equal(model.personas.length,0);pass('409 keeps persona draft and the actual router exit guard');
 await fresh();await editPersona('Forbidden persona','Protected draft');writeMode=403;await button('Save changes').click();await page.getByText('Synthetic persona save status 403',{exact:true}).waitFor();assert.equal(await name().count(),0);assert.equal(await button('Add persona').count(),0);assert.equal(await button('Retry same save').count(),0);assert.equal(await panel().getByText('Saved brand',{exact:true}).count(),0);pass('403 purges the persona draft and protected context without offering a retry');
 await fresh('viewer',[persona()]);await panel().getByText('Needs dependable research',{exact:true}).waitFor();assert.equal(await button('Add persona').count(),0);assert.equal(await button('Edit persona Research lead').count(),0);assert.equal(await button('Delete persona Research lead').count(),0);assert.equal(writes.length,0);pass('Viewer can read persona context and receives no mutation controls');
 await fresh('owner',Array.from({length:20},(_,index)=>persona(`40000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,'Persona '+index,'')));assert.equal(await button('Add persona').isDisabled(),true);assert.equal(await button('Edit persona Persona 0').isEnabled(),true);await button('Edit persona Persona 0').click();assert.equal(await description().inputValue(),'');await name().fill(' ');await button('Save changes').click();await page.getByText('Enter a persona name.',{exact:true}).waitFor();assert.equal(writes.length,0);pass('Twenty-persona limit prevents adding while edit remains available; whitespace name cannot save');
 await name().fill('Long persona name '.repeat(8).slice(0,120));await description().fill('Persona needs and goals '.repeat(175).slice(0,4000));
 await geometry('persona-wide-light');await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});await geometry('persona-wide-dark');
 await setViewport(page,{width:320,height:900});await page.evaluate(()=>{document.documentElement.dir='rtl';document.documentElement.style.fontSize='200%';});await geometry('persona-320-rtl-200-dark');
 await page.evaluate(()=>{document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';});await geometry('persona-320-rtl-200-light');
 assert.equal(await name().getAttribute('maxLength'),'120');assert.equal(await description().getAttribute('maxLength'),'4000');pass('Labelled shared controls fit wide/light/dark and 320px RTL at 200% font size with maximum-length content');
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS '+groups.length+' persona-context groups / '+apiRequests+' API requests / '+contexts+' contexts; synthetic client behavior only; zero external requests or page errors');
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:resolve(screenshots,'failure.png'),fullPage:false,timeout:1500}).catch(()=>{});console.error('FAILURE_AX '+await page.locator('body').ariaSnapshot({timeout:1500}).catch(()=>'<unavailable>'));}throw error;}finally{clearTimeout(deadline);await context?.close();await browser?.close();await server.close();assert.equal(browser?.isConnected()??false,false);assert.equal(server.httpServer?.listening??false,false);console.log('CLEANUP owned browser and loopback Vite stopped');clearTimeout(watchdog);}
