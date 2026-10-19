// Actual App navigation with closed synthetic HTTP responses; no real auth, DB or providers.
// Node24: TEN98_WORKSPACE_NAV_BROWSER=1 PLAYWRIGHT_MODULE=<installed entry> node tests/workspace-navigation-browser.mjs
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
assert.equal(process.env.TEN98_WORKSPACE_NAV_BROWSER,'1');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const W=id(1),W2=id(2),EMPTY=id(3),P1=id(11),P2=id(12),P3=id(13),BOARD=id(21),LINK=id(31),PIXEL=id(32);
const user={id:'navigation-user',name:'Synthetic navigation user',email:'navigation@example.com'},stamp='2026-10-18T00:00:00.000Z';
const projects={ [W]:[{id:P1,name:'First synthetic website'},{id:P2,name:'Second synthetic website'}], [W2]:[{id:P3,name:'Other workspace website'}], [EMPTY]:[] };
const requests=[],unexpected=[],errors=[],passed=[];
// Opt-in oracle restores only the original project-clearing branch in Vite memory.
const oracle=process.env.TEN98_WORKSPACE_NAV_ORACLE==='1';
const plugins=oracle?[{name:'original-project-clearing-oracle',enforce:'pre',transform(code,id){if(!id.replaceAll(String.fromCharCode(92),'/').endsWith('/src/routes/index.tsx'))return;const fixed="activateProject(selectedProject?.id ?? '')";assert.equal(code.split(fixed).length,2,'Oracle matches exactly one reviewed branch');return code.replace(fixed,"activateProject(project?.id ?? '')");}}]:[];
const server=await createServer({plugins,configFile:false,envDir:false,root:process.cwd(),cacheDir:resolve('private/workspace-navigation-evidence/vite-cache'),appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router','zod']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic workspace navigation</title><div id="root"></div><script type="module" src="/tests/account-preferences-browser-fixture.tsx"></script></html>');});
let browser,context,page,origin;
const pass=text=>{passed.push(text);console.log('PASS '+text);};
const query=(view,workspace=W,project)=>new URLSearchParams({workspace,view,...project?{project}:{}}).toString();
function asset(kind,wid){return {id:kind==='link'?LINK:PIXEL,workspaceId:wid,kind,name:'Synthetic '+kind,active:true,collection:{enabled:false,captureReferrer:false,captureGeography:false,excludeBots:true},...kind==='link'?{destination:'https://destination.example.com/'}:{},publicUrl:origin+'/api/track/'+kind+'/'+(kind==='link'?LINK:PIXEL),revision:1,createdAt:stamp,updatedAt:stamp};}
function report(item,p){
 const from=p.get('from'),to=p.get('to'),zone=p.get('timeZone'),asOf=new Date().toISOString(),start=new Date(from+'T00:00:00Z'),end=new Date(Date.parse(to+'T00:00:00Z')+864e5),counts={requests:null,identifiedRequests:null,unidentifiedRequests:null,estimatedVisitors:null,estimatedVisits:null},daily=[];
 for(let day=start.getTime();day<end.getTime();day+=864e5){const a=new Date(day).toISOString(),b=new Date(day+864e5).toISOString();daily.push({date:a.slice(0,10),start:a,end:b,skipped:false,provisional:b>asOf,coverage:'unavailable',...counts});}
 return {version:'native-tracked-assets-v1',asset:{id:item.id,kind:item.kind,name:item.name,revision:1},scope:p.toString(),asOf,range:{from,to,timeZone:zone,start:start.toISOString(),end:end.toISOString()},coverage:{status:'unavailable',retainedFrom:null},retention:{policyRevision:1,watermark:null},method:{measurement:'accepted-http-requests',identity:'monthly-asset-key-hour-visits',channel:'recorded-channel-tags-v1',visitorCountsAdditive:false,captureCoverage:'unknown',delivery:'not-measured',limitation:'Explicit synthetic unavailable report; no measured requests supplied.'},summary:counts,daily,breakdown:{dimension:p.get('dimension'),metric:'requests',rows:[],totalGroups:null,limit:Number(p.get('limit')),returnedRequests:null,omittedRequests:null,truncated:false}};
}
function board(wid){const to=new Date().toISOString().slice(0,10),scope=new URLSearchParams({from:to,to,timeZone:'UTC'}).toString();return{id:BOARD,workspaceId:wid,revision:1,createdAt:stamp,updatedAt:stamp,definition:{schemaVersion:1,name:'Synthetic navigation board',description:'Synthetic text-only fixture',defaultEntity:null,scope,rows:[{id:id(22),minHeight:150,cards:[{id:id(23),type:'TextBlock',text:'Synthetic board text; no measured metrics.'}]}]}};}
async function fresh(search,{single=false,role='owner'}={}){
 await context?.close();context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  try{
   if(url.origin!==origin){unexpected.push(req.method()+' '+url.href);return route.abort();}
   if(req.method()!=='GET'){unexpected.push(req.method()+' '+path);return route.abort();}
   if(!path.startsWith('/api/'))return route.continue();
   requests.push({path,search:url.search});if(/\/api\/workspaces\/[^/]+\/(boards|tracked-assets)/.test(path))assert.equal(url.searchParams.has('project'),false,'Workspace API has no project scope');let body,status=200;
   const workspaces=[{id:W,name:'Synthetic primary workspace',role},{id:W2,name:'Synthetic other workspace',role},{id:EMPTY,name:'Synthetic empty workspace',role}];
   if(path==='/api/status')body={configured:true,appUrl:origin};
   else if(path==='/api/me')body={user,instanceOperator:false,workspaces};
   else if(path==='/api/account/preferences')body={version:'account-preferences-v1',user,preferences:{revision:1,timeZone:'UTC',locale:'en-US',theme:'light',updatedAt:stamp}};
   else if(path==='/api/auth/oidc/providers')body={providers:[]};
   else if(/^\/api\/workspaces\/[^/]+\/projects$/.test(path)){const wid=path.split('/')[3];assert.ok(Object.hasOwn(projects,wid));body={projects:(single&&wid===W?projects[wid].slice(0,1):projects[wid]).map(p=>({...p,origin:'https://site.example.com',publicKey:'synthetic-key',eventCount:0,lastEventAt:null,retainedFrom:null}))};}
   else if(/^\/api\/projects\/[^/]+\/events$/.test(path))body={events:[],total:0,retainedFrom:null};
   else if(/^\/api\/projects\/[^/]+\/jobs$/.test(path))body={jobs:[]};
   else if(/^\/api\/workspaces\/[^/]+\/boards(?:\/[^/]+)?$/.test(path)){const wid=path.split('/')[3],item=board(wid);assert.ok(Object.hasOwn(projects,wid));body=path.endsWith('/boards')?{workspaceId:wid,role,items:[{id:BOARD,revision:1,name:item.definition.name,description:item.definition.description,createdAt:stamp,updatedAt:stamp}],nextCursor:null}:{workspaceId:wid,role,item};}
   else if(/^\/api\/workspaces\/[^/]+\/tracked-assets(?:\/[^/]+(?:\/report)?)?$/.test(path)){
    const wid=path.split('/')[3],aid=path.split('/')[5],kind=aid?(aid===LINK?'link':aid===PIXEL?'pixel':null):url.searchParams.get('kind');assert.ok(Object.hasOwn(projects,wid));assert.ok(['link','pixel'].includes(kind));const item=asset(kind,wid);
    body=!aid?{workspaceId:wid,role,kind,items:[item],nextCursor:null}:path.endsWith('/report')?{workspaceId:wid,role,report:report(item,url.searchParams)}:{workspaceId:wid,role,item};
   }
   else if(/^\/api\/projects\/[^/]+\/(analytics|annotations|annotations\/timeline|ai-search|ai-search\/analysis)$/.test(path)){status=503;body={error:'Explicit synthetic unavailable report.'};}
   else{unexpected.push(req.method()+' '+path);return route.abort();}
   return route.fulfill({status,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify(body)});
  }catch(error){errors.push('Fixture boundary: '+error.message);return route.abort();}
 });
 page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/?'+search);await page.locator('.shell').waitFor();return page;
}
async function at(view){await page.waitForFunction(view=>new URL(location.href).searchParams.get('view')===view,view);}
async function shell(expected){await page.waitForFunction(expected=>document.querySelector('#active-project')?.value===expected,expected);assert.equal(await page.getByLabel('Project',{exact:true}).inputValue(),expected);assert.equal(await page.locator('.sidebar').getByRole('link',{name:'Analytics',exact:true}).isVisible(),true,'Project navigation remains available');}
async function settledFrame(){await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}
async function confirmAction(accept,action,settled,label){
 let count=0,seenResolve,timer;const seen=new Promise((done,reject)=>{seenResolve=done;timer=setTimeout(()=>reject(new Error(label+': no native confirmation appeared')),5000);});
 const handler=async dialog=>{count++;assert.equal(dialog.type(),'confirm',label+' native confirmation type');try{if(accept)await dialog.accept();else await dialog.dismiss();}finally{seenResolve();}};
 page.on('dialog',handler);try{await action();await seen;clearTimeout(timer);await settled();await settledFrame();assert.equal(count,1,label+' exactly one confirmation');}finally{clearTimeout(timer);page.off('dialog',handler);}
}
async function cleanAction(action,settled,label){let count=0;const handler=async dialog=>{count++;await dialog.dismiss();};page.on('dialog',handler);try{await action();await settled();await settledFrame();assert.equal(count,0,label+' clean navigation needs no confirmation');}finally{page.off('dialog',handler);}}
function workspaceUrl(){const p=new URL(page.url()).searchParams;assert.equal(p.has('project'),false,'Workspace route has no project query parameter');}
async function click(name,view){await page.locator('.sidebar').getByRole('link',{name,exact:true}).click();await at(view);}
async function analytics(expected){await click('Analytics','project');await shell(expected);assert.equal(new URL(page.url()).searchParams.get('project'),expected);}
try{
 await server.listen();origin='http://127.0.0.1:'+server.httpServer.address().port;
 await server.environments.client.transformRequest('/tests/account-preferences-browser-fixture.tsx');await server.environments.client.waitForRequestsIdle();const optimizer=server.environments.client.depsOptimizer;await optimizer.scanProcessing;await Promise.all(Object.values(optimizer.metadata.discovered).map(d=>d.processing));
 const{chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL??'msedge'});
 await fresh(query('project',W,P2));await shell(P2);
 await settledFrame();const workerReads=()=>requests.filter(r=>r.path.endsWith('/jobs')).length;assert.equal(workerReads(),0,'Analytics does not reconcile worker checks in the background');
 const workerRead=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/jobs'));await click('Install tracker','installation');await workerRead;await page.locator('details.diagnostics > summary').click();await page.getByText('No checks yet.',{exact:true}).waitFor();assert.equal(workerReads(),1,'Install tracker loads its own worker history');
 await analytics(P2);await settledFrame();assert.equal(workerReads(),1,'Returning to analytics does not reload worker history');pass('Worker history is loaded only where its diagnostics are available.');
 for(const [name,view]of [['Boards','boards'],['Links','links'],['Tracking images','pixels']]){await click(name,view);await shell(P2);workspaceUrl();await analytics(P2);}
 await page.getByRole('link',{name:'Create project',exact:true}).click();await at('new-project');await page.getByRole('heading',{name:'Create a new project',exact:true}).waitFor();await shell(P2);await analytics(P2);
 await click('Settings','preferences');await page.getByRole('heading',{name:'Your account',exact:true}).waitFor();await shell(P2);await analytics(P2);pass('Second project survives all workspace pages, setup and settings; Analytics remains a working return.');
 await click('Boards','boards');await page.getByRole('button',{name:'Synthetic navigation board',exact:true}).click();await page.getByText('Synthetic board text; no measured metrics.',{exact:true}).waitFor();await shell(P2);workspaceUrl();await page.getByRole('button',{name:'All boards',exact:true}).click();await shell(P2);workspaceUrl();await analytics(P2);
 for(const [name,view,kind]of [['Links','links','link'],['Tracking images','pixels','pixel']]){await click(name,view);await page.getByRole('button',{name:'View Synthetic '+kind,exact:true}).click();await page.getByRole('navigation',{name:'Tracked asset views',exact:true}).waitFor();workspaceUrl();await shell(P2);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();await shell(P2);workspaceUrl();await page.getByRole('button',{name:'Back to '+(kind==='link'?'links':'tracking images'),exact:true}).click();await shell(P2);workspaceUrl();await analytics(P2);}pass('Nested Boards and tracked asset detail/settings/list preserve shell context and project-free wire URLs.');
 await click('Boards','boards');await click('Links','links');await page.goBack();await at('boards');await shell(P2);await page.goForward();await at('links');await shell(P2);workspaceUrl();
 await page.getByLabel('Workspace',{exact:true}).selectOption(W2);await at('project');await shell(P3);assert.equal(new URL(page.url()).searchParams.get('workspace'),W2);assert.equal(await page.getByLabel('Project',{exact:true}).locator('option[value="'+P2+'"]').count(),0);pass('Back/Forward preserve context; workspace switch exposes only its own project.');
 for(const view of ['boards','links','pixels']){await fresh(query(view));await shell(P1);workspaceUrl();await page.reload();await page.locator('.shell').waitFor();await shell(P1);workspaceUrl();await analytics(P1);}pass('Fresh workspace deep links and reload retain an explicit project return.');
 await fresh(query('project',W,P1),{single:true});await shell(P1);await click('Boards','boards');await shell(P1);workspaceUrl();await analytics(P1);pass('One-project workspace has a working escape from workspace pages.');
 for(const role of ['owner','viewer'])for(const view of ['keywords','ai-search']){await fresh(query(view,EMPTY),{role});await page.waitForFunction(()=>{const text=document.querySelector('#main-content')?.textContent??'';return /first website|No project|Create project|view-only|Ask a workspace|Choose a project/.test(text);});const text=await page.locator('#main-content').innerText();assert.match(text,role==='viewer'?/No project|view-only|Ask a workspace|Choose a project/:/first website|Create project|Connect.*website/i);if(role==='viewer')assert.equal(await page.getByRole('button',{name:'Create project',exact:true}).count(),0);}pass('Empty project deep links show setup or viewer guidance instead of a blank main area.');
 await fresh(query('project',W,P2));await shell(P2);const search=page.getByRole('searchbox',{name:'Find a tool',exact:true});
 for(const [term,name,view]of [['  Backlinks  ','Domain SEO','domain-seo'],['pixels','Tracking images','pixels'],['Search Console','Google reports','google'],['GA4','Google reports','google']]){
  await search.fill(term);const tool=page.locator('.sidebar').getByRole('link',{name,exact:true});assert.equal(await tool.isVisible(),true,'Search finds '+term.trim());
  const target=new URL(await tool.getAttribute('href'),origin).searchParams;assert.equal(target.get('view'),view);assert.equal(target.get('workspace'),W);assert.equal(target.get('project'),view==='pixels'?null:P2);assert.equal(await page.locator('.sidebar').getByRole('link',{name:'Boards',exact:true}).isVisible(),false);
 }pass('Tool aliases reveal their scoped destination without navigating or starting work.');
 await search.fill('no-such-tool-8361');const clear=page.getByRole('button',{name:/Clear.*search|Clear.*filter|Show all tools/i});if(await clear.count())await clear.first().click();else await search.fill('');await shell(P2);await search.fill('boards');await page.setViewportSize({width:760,height:1000});await page.getByRole('button',{name:'Menu',exact:true}).click();assert.equal(await page.locator('.sidebar').getByRole('link',{name:'Analytics',exact:true}).isVisible(),true);await page.keyboard.press('Escape');pass('Search can be cleared and resizing cannot strand filtered mobile navigation.');
 // Native unsaved-draft guards: no save, mutation or paid/provider request is allowed.
 await fresh(query('project',W,P2));await shell(P2);await click('Boards','boards');await page.getByRole('button',{name:'New board',exact:true}).click();await page.getByLabel('Board name',{exact:true}).waitFor();
 await cleanAction(()=>page.locator('.sidebar').getByRole('link',{name:'Links',exact:true}).click(),()=>at('links'),'Clean new board');
 await click('Boards','boards');await page.getByRole('button',{name:'New board',exact:true}).click();const boardName=page.getByLabel('Board name',{exact:true});await boardName.fill('Unsaved board draft');const boardUrl=page.url();
 const boardRetained=async()=>{await settledFrame();assert.equal(page.url(),boardUrl);assert.equal(await boardName.inputValue(),'Unsaved board draft');assert.equal(await page.getByLabel('Workspace',{exact:true}).inputValue(),W);await shell(P2);};
 await confirmAction(false,()=>page.locator('.sidebar').getByRole('link',{name:'Links',exact:true}).click(),boardRetained,'Dismiss board sidebar navigation');
 await confirmAction(false,()=>page.getByLabel('Workspace',{exact:true}).selectOption(W2),boardRetained,'Dismiss board workspace change');
 await page.getByLabel('Description',{exact:true}).fill('Editing continues after the rejected workspace change');assert.equal(await page.getByRole('button',{name:'Save board',exact:true}).isEnabled(),true);
 await confirmAction(false,()=>page.getByRole('button',{name:'All boards',exact:true}).click(),boardRetained,'Dismiss local board navigation');
 await confirmAction(true,()=>page.getByRole('button',{name:'All boards',exact:true}).click(),async()=>{await page.getByRole('button',{name:'New board',exact:true}).waitFor();await shell(P2);assert.equal(new URL(page.url()).searchParams.get('workspace'),W);},'Accept local board navigation after cancelled workspace change');
 await page.getByRole('button',{name:'New board',exact:true}).click();await boardName.fill('Unsaved board draft');const backBoardUrl=page.url();
 await confirmAction(false,()=>page.evaluate(()=>history.back()),async()=>{await settledFrame();assert.equal(page.url(),backBoardUrl);assert.equal(await boardName.inputValue(),'Unsaved board draft');},'Dismiss board browser Back');
 await confirmAction(true,()=>page.evaluate(()=>history.back()),async()=>{await page.getByRole('button',{name:'New board',exact:true}).waitFor();await shell(P2);},'Accept board browser Back');
 await page.getByRole('button',{name:'New board',exact:true}).click();await boardName.fill('Board sidebar acceptance');await confirmAction(true,()=>page.locator('.sidebar').getByRole('link',{name:'Links',exact:true}).click(),async()=>{await at('links');await page.getByRole('button',{name:'Create link',exact:true}).waitFor();await shell(P2);},'Accept board sidebar navigation');pass('Native board draft cancellation retains text/context; local/sidebar/Back acceptance confirms once; clean drafts navigate freely.');
 for(const [name,view,noun]of [['Links','links','link'],['Tracking images','pixels','tracking image']]){
  if(new URL(page.url()).searchParams.get('view')!==view)await click(name,view);await page.getByRole('button',{name:'Create '+noun,exact:true}).click();const field=page.getByLabel('Name',{exact:true});await field.waitFor();
  await cleanAction(()=>page.locator('.sidebar').getByRole('link',{name:'Boards',exact:true}).click(),()=>at('boards'),'Clean new '+noun);
  await click(name,view);await page.getByRole('button',{name:'Create '+noun,exact:true}).click();await field.fill('Unsaved '+noun);const assetUrl=page.url();
  const assetRetained=async()=>{await settledFrame();assert.equal(page.url(),assetUrl);assert.equal(await field.inputValue(),'Unsaved '+noun);assert.equal(await page.getByLabel('Workspace',{exact:true}).inputValue(),W);await shell(P2);};
  await confirmAction(false,()=>page.locator('.sidebar').getByRole('link',{name:'Boards',exact:true}).click(),assetRetained,'Dismiss '+noun+' sidebar navigation');
  await confirmAction(false,()=>page.getByLabel('Workspace',{exact:true}).selectOption(W2),assetRetained,'Dismiss '+noun+' workspace change');
  await field.fill('Unsaved '+noun+' continued');await field.fill('Unsaved '+noun);
  const back=page.getByRole('button',{name:'Back to '+(view==='links'?'links':'tracking images'),exact:true});await confirmAction(false,()=>back.click(),assetRetained,'Dismiss local '+noun+' navigation');
  await confirmAction(true,()=>back.click(),async()=>{await page.getByRole('button',{name:'Create '+noun,exact:true}).waitFor();await shell(P2);assert.equal(new URL(page.url()).searchParams.get('workspace'),W);},'Accept local '+noun+' navigation after cancelled workspace change');
  await page.getByRole('button',{name:'Create '+noun,exact:true}).click();await field.fill('Unsaved '+noun);const backAssetUrl=page.url();
  await confirmAction(false,()=>page.evaluate(()=>history.back()),async()=>{await settledFrame();assert.equal(page.url(),backAssetUrl);assert.equal(await field.inputValue(),'Unsaved '+noun);},'Dismiss '+noun+' browser Back');
  await confirmAction(true,()=>page.evaluate(()=>history.back()),async()=>{await page.getByRole('button',{name:'Create '+noun,exact:true}).waitFor();await shell(P2);},'Accept '+noun+' browser Back');
  await page.getByRole('button',{name:'Create '+noun,exact:true}).click();await field.fill('Unsaved '+noun);await confirmAction(true,()=>page.locator('.sidebar').getByRole('link',{name:'Boards',exact:true}).click(),async()=>{await at('boards');await page.getByRole('button',{name:'New board',exact:true}).waitFor();await shell(P2);},'Accept '+noun+' sidebar navigation');
 }pass('Native new link/image drafts survive dismissals and confirm once across local, sidebar and browser Back routes; no saves or POSTs.');
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);assert.ok(requests.length>0);console.log('PASS closed synthetic GET-only boundary; '+passed.length+' navigation groups. No real authentication, server authorization, persistence, measured metrics or provider acceptance claimed.');
}catch(error){console.error('FAILED after '+passed.length+' completed groups.');console.error(JSON.stringify({unexpected,errors}));throw error;}
finally{await context?.close();await browser?.close();await server.close();}
