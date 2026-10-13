// TEN98_META_APP_BROWSER=1 node tests/meta-app-browser.mjs
// PLAYWRIGHT_MODULE is an optional installed ESM entry; PLAYWRIGHT_CHANNEL is optional.
// Real controller/router; only intercepted synthetic local APIs. No DB or Meta calls.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';

assert.equal(process.env.TEN98_META_APP_BROWSER,'1');
const aid='10000000-0000-4000-8000-000000000001',bid='10000000-0000-4000-8000-000000000002',nid='10000000-0000-4000-8000-000000000003';
const longId='9'.repeat(40),secret='synthetic-once-only-secret';
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'private/meta-app-controller-vite-cache',appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url!=='/'&&req.url!=='/elsewhere')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meta operator controller acceptance</title><div id="root"></div><script type="module" src="/tests/meta-app-browser-fixture.tsx"></script></html>');});
let browser,page,stage='initialization';
const evidence=resolve('private/meta-app-controller-evidence');
try{
 await server.listen();const address=server.httpServer.address();assert.equal(address.address,'127.0.0.1');const origin='http://127.0.0.1:'+address.port;
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({headless:true,...process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{}});
 const context=await browser.newContext({viewport:{width:1440,height:1100},serviceWorkers:'block'});
 const errors=[],unexpected=[],calls=[],writes=[];
 let registrations,activeId,operator=true,settings={},readMode=null,writeMode=null,held=null,pages=true,afterWriteRead=null;
 const reg=(id,appId,active)=>({id,appId,configId:'456',revision:1,active,enabled:true,declaredMode:'development',boundOrigin:origin,deleteDataUrl:origin+`/api/meta/apps/${id}/delete-data`});
 const envelope=(url=new URL(origin+'/api/meta/app'))=>{
  const selected=url.searchParams.has('registrationId')?registrations.get(url.searchParams.get('registrationId')):url.searchParams.has('appId')?[...registrations.values()].find(r=>r.appId===url.searchParams.get('appId')):registrations.get(activeId);
  return {operator,configured:activeId!==null,enabled:!!registrations.get(activeId)?.enabled,vaultConfigured:true,httpsReady:true,redirectUri:origin+'/api/meta/callback',activeRegistrationId:activeId,registration:structuredClone(selected??null),registrations:structuredClone(pages?[registrations.get(url.searchParams.has('cursor')?bid:aid)].filter(Boolean):[...registrations.values()]),nextCursor:pages&&!url.searchParams.has('cursor')?'opaque-page-2':null,...settings};
 };
 const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
 const release=async()=>{const prior=held;assert.ok(prior);held=null;await json(prior.route,prior.body,prior.status??200);};
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method(),path=url.pathname;
  if(url.origin!==origin){unexpected.push(method+' '+url.origin);return route.abort();}
  if(!path.startsWith('/api/'))return method==='GET'?route.continue():route.abort();
  const body=request.postData()?request.postDataJSON():null;calls.push({method,path,query:url.search,body});
  if(method==='GET'&&path==='/api/meta/app'){
   const mode=readMode;readMode=null;
   if(mode==='hold'||mode==='hold401'){assert.equal(held,null);held={route,body:mode==='hold401'?{error:'Synthetic session denied'}:envelope(url),status:mode==='hold401'?401:200};return;}
   if(typeof mode==='number')return json(route,{error:'Synthetic metadata failure'},mode);
   const reply=envelope(url);if(mode==='foreign-callback')reply.redirectUri='https://attacker.invalid/api/meta/callback';if(mode==='wrong-selection')reply.registration=structuredClone(registrations.get(bid));if(mode==='foreign-deletion')reply.registration.deleteDataUrl='https://attacker.invalid/delete';
   return json(route,reply);
  }
  if(method!=='POST'||path!=='/api/meta/app'&&!/^\/api\/meta\/apps\/[0-9a-f-]+\/disable$/.test(path)){unexpected.push(method+' '+path);return json(route,{error:'Unexpected synthetic route'},404);}
  writes.push({path,body:structuredClone(body)});const mode=writeMode;writeMode=null;
  if(typeof mode==='number')return json(route,{error:'Synthetic mutation rejected'},mode);
  let reply;
  if(path==='/api/meta/app'){
   assert.equal(body.activeRegistrationId,activeId);const existing=[...registrations.values()].find(r=>r.appId===body.appId);assert.equal(body.revision,existing?.revision??0);
   if(!existing)assert.equal(body.appSecret,secret);
   const id=existing?.id??nid,updated={...reg(id,body.appId,false),revision:body.revision+1,configId:body.configId,enabled:body.enabled,declaredMode:body.declaredMode,active:body.activate||existing?.active===true};
   if(body.activate){for(const r of registrations.values())r.active=false;activeId=id;}
   registrations.set(id,updated);reply=envelope(new URL(origin+'/api/meta/app?registrationId='+id));
  }else{
   const id=path.split('/')[4],row=registrations.get(id);assert.equal(body.revision,row.revision);row.enabled=false;row.revision=Math.min(row.revision+1,2147483647);reply=envelope();
  }
  if(afterWriteRead!==null){readMode=afterWriteRead;afterWriteRead=null;}
  if(mode==='drop')return route.abort('failed');
  if(mode==='malformed')return json(route,{...reply,registration:{...reply.registration,configId:'456\n'}});
  if(mode==='hold'){assert.equal(held,null);held={route,body:reply};return;}
  return json(route,reply);
 });
 const button=name=>page.getByRole('button',{name,exact:true,includeHidden:true}),field=name=>page.getByLabel(name,{exact:true});
 const until=async check=>{const deadline=Date.now()+7000;while(!check()){if(Date.now()>deadline)assert.fail('Controlled request did not arrive');await new Promise(r=>setTimeout(r,10));}};
 const ready=async()=>{await page.getByRole('heading',{name:'Meta app setup',exact:true}).waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Reload app setup'&&!b.disabled)&&!document.querySelector('[role="status"]')?.textContent?.includes('Loading'));};
 const selected=async id=>{await field('App ID').waitFor({state:'attached'});await page.waitForFunction(value=>[...document.querySelectorAll('input')].some(e=>e.readOnly&&e.value===value),id);await ready();};
 const focused=async()=>{await page.waitForFunction(()=>document.activeElement?.tagName==='H2'&&document.activeElement?.textContent==='Meta app setup');};
 const settingsDisclosure=()=>page.locator('summary').filter({hasText:/^App settings$/}).locator('..');
 const openSettings=async()=>{if(!await settingsDisclosure().evaluate(node=>node.open))await settingsDisclosure().locator('summary').click();};
 const fresh=async({setup={},hasPages=true,role=true,cap=false}={})=>{
  await page?.close();assert.equal(held,null);registrations=new Map([[aid,reg(aid,'123',true)],[bid,reg(bid,'789',false)]]);if(cap)registrations.get(bid).revision=2147483647;activeId=aid;operator=role;settings=setup;pages=hasPages;readMode=null;writeMode=null;afterWriteRead=null;calls.length=0;writes.length=0;
  page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await ready();
 };
 const chooseB=async()=>{await button('Next registrations').click();await ready();await field('Registration').selectOption(bid);await selected('789');};
 const unknown=async()=>{await page.getByRole('alert').filter({hasText:'The result is not confirmed.'}).first().waitFor();assert.equal(await field('App secret').inputValue(),'');assert.equal(await button('Save app settings').isDisabled(),true);assert.equal(await button('Back to connections').isDisabled(),true);assert.equal(await page.getByRole('button',{name:/Retry/}).count(),0);};
 const blocked=async()=>{await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/');assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false);};
 const fillNew=async(id=longId)=>{await button('New registration').click();await ready();await field('App ID').fill(id);await openSettings();await field('Facebook Login configuration ID').fill('8'.repeat(40));await openSettings();await field('App secret').fill(secret);};

 stage='registration paging and new setup';await fresh();await selected('123');await focused();assert.equal(await field('App ID').getAttribute('readonly'),'');assert.equal(writes.length,0);
 await chooseB();await focused();await button('Next registrations').click();await ready();await button('Previous registrations').click();await selected('789');assert.equal(await field('Registration').inputValue(),bid,'Off-page selected record remains selected');
 await button('New registration').click();await ready();await button('Next registrations').click();await ready();assert.equal(await field('App ID').inputValue(),'');assert.equal(await field('App ID').getAttribute('readonly'),null,'Paging preserves new mode');
 await field('App ID').fill(longId);await openSettings();await field('Facebook Login configuration ID').fill('8'.repeat(40));await openSettings();await field('App secret').fill(secret);assert.equal(await field('Use this registration for new connections').isChecked(),false);await field('Use this registration for new connections').check();await field('Enable this registration').check();await button('Save app settings').click();await page.getByRole('status').filter({hasText:'App settings saved locally.'}).waitFor();await selected(longId);await focused();assert.equal(writes.length,1);assert.equal(writes[0].body.appSecret,secret);assert.equal(writes[0].body.activate,true);assert.equal(await field('App secret').inputValue(),'');
 console.log('PASS exact IDs, explicit activation, off-page selection, new-mode pagination, secret clearing, and explicit-load focus.');

 stage='secret submission and metadata verification';await fresh();await openSettings();await field('Facebook Login configuration ID').fill('457');writeMode='hold';await button('Save app settings').click();await until(()=>held!==null);assert.equal(Object.hasOwn(writes[0].body,'appSecret'),false);assert.equal(await field('App secret').inputValue(),'');await blocked();await release();await page.getByRole('status').filter({hasText:'App settings saved locally.'}).waitFor();
 await openSettings();await field('App secret').fill(secret);writeMode='hold';afterWriteRead=400;await button('Save app settings').click();await until(()=>held!==null);assert.equal(await field('App secret').inputValue(),'');await release();await unknown();await blocked();await button('Reload app setup').click();await page.getByRole('status').filter({hasText:'Current metadata reloaded.'}).waitFor();assert.equal(writes.length,2);assert.equal(await field('App secret').inputValue(),'');
 console.log('PASS blank existing secret is omitted, submission clears once, active writes block navigation, and failed confirmation stays unknown.');

 stage='lost acknowledgement exact target recovery';await fresh();await fillNew();writeMode='drop';await button('Save app settings').click();await unknown();await blocked();await button('Reload app setup').click();await selected(longId);assert.ok(calls.some(c=>c.method==='GET'&&new URLSearchParams(c.query).get('appId')===longId));assert.equal(writes.length,1);assert.equal(registrations.get(nid).active,false,'Unknown inactive registration never switches active app');assert.equal(activeId,aid);assert.equal(await field('App secret').inputValue(),'');
 for(const mode of ['malformed',409,408,429,503]){await fresh();await openSettings();await field('App secret').fill(secret);writeMode=mode;await button('Save app settings').click();await unknown();await blocked();await button('Reload app setup').click();await selected('123');assert.equal(writes.length,1);assert.equal(await field('App secret').inputValue(),'');}
 await fresh();await fillNew();writeMode=503;await button('Save app settings').click();await unknown();await button('Reload app setup').click();await ready();assert.equal(await field('App ID').inputValue(),longId);assert.equal(await field('App ID').getAttribute('readonly'),null);assert.equal(await button('Save app settings').isDisabled(),true,'Missing exact lookup does not restore submitted secret');
 console.log('PASS lost/malformed/conflict/rate/timeout/server acknowledgements require explicit target lookup, never secret replay; missing new target stays unconfirmed.');

 stage='keyless inactive disable';await fresh({setup:{vaultConfigured:false,httpsReady:false},cap:true});await chooseB();assert.equal(await button('Save app settings').isDisabled(),true);await button('Disable registration').click();await button('Keep enabled').waitFor();await button('Disable registration').click();await page.getByRole('status').filter({hasText:'Registration disabled locally.'}).waitFor();assert.equal(await field('App ID').inputValue(),'789');assert.equal(registrations.get(bid).enabled,false);assert.equal(registrations.get(aid).enabled,true);assert.equal(writes[0].body.revision,2147483647);assert.ok(calls.some(c=>c.method==='GET'&&new URLSearchParams(c.query).get('registrationId')===bid));
 await fresh();await chooseB();await button('Disable registration').click();writeMode='drop';await button('Disable registration').click();await unknown();await button('Reload app setup').click();await selected('789');assert.equal(await button('Disable registration').isDisabled(),true);assert.equal(writes.length,1);
 console.log('PASS keyless capped inactive disable verifies its own target; unknown disable recovery never repeats the mutation.');

 stage='fresh authority and stale responses';await fresh();readMode='hold';await button('Reload app setup').click();await until(()=>held!==null);operator=false;await page.evaluate(()=>window.metaAppFixture.user('10000000-0000-4000-8000-000000000002'));await page.getByText('Only an instance operator can view or change Meta app setup.',{exact:true}).first().waitFor();await release();assert.equal(await field('App ID').count(),0);assert.equal(await field('App secret').count(),0);assert.equal(await page.getByText('Callback addresses',{exact:true}).count(),0);
 await fresh();readMode='hold401';await button('Reload app setup').click();await until(()=>held!==null);await page.evaluate(()=>window.metaAppFixture.user('10000000-0000-4000-8000-000000000002'));await selected('123');await release();assert.equal(await page.getByRole('heading',{name:'Fixture signed out'}).count(),0);
 for(const status of [401,403,404]){await fresh();await openSettings();await field('App secret').fill(secret);writeMode=status;await button('Save app settings').click();if(status===401)await page.getByRole('heading',{name:'Fixture signed out'}).waitFor();else await page.getByRole('alert').waitFor();assert.equal(await field('App secret').count(),0);assert.equal(await field('Registration').count(),0);}
 await fresh();readMode='hold';await button('Reload app setup').click();await until(()=>held!==null);await button('Back to connections').click();await page.getByRole('heading',{name:'Fixture returned'}).waitFor();await release();assert.equal(await field('App ID').count(),0);
 console.log('PASS current denial/nonoperator purges protected state, user remount defeats stale success/401, and Back interrupts reads.');

 stage='dirty guards and callback integrity';await fresh();await openSettings();await field('App secret').fill(secret);page.once('dialog',dialog=>dialog.dismiss());await button('New registration').click();assert.equal(await field('App ID').inputValue(),'123');assert.equal(await field('App secret').inputValue(),secret);page.once('dialog',dialog=>dialog.accept());await button('New registration').click();await ready();assert.equal(await field('App secret').inputValue(),'');
 await openSettings();await field('App secret').fill(secret);page.once('dialog',dialog=>dialog.dismiss());await button('Back to connections').click();assert.equal(await page.getByRole('heading',{name:'Fixture returned'}).count(),0);page.once('dialog',dialog=>dialog.accept());await button('Reload app setup').click();await ready();assert.equal(await field('App secret').inputValue(),'');
 for(const mode of ['foreign-callback','foreign-deletion','wrong-selection']){await fresh();readMode=mode;await button('Reload app setup').click();await page.getByRole('alert').waitFor();assert.equal(await field('Registration').count(),0);assert.equal(await page.getByText('Callback addresses',{exact:true}).count(),0);}
 await fresh();await page.getByText('Callback addresses',{exact:true}).click();await field('OAuth callback').waitFor();assert.equal(await field('OAuth callback').inputValue(),origin+'/api/meta/callback');assert.equal(await field('Data-deletion callback').inputValue(),origin+`/api/meta/apps/${aid}/delete-data`);await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Synthetic unavailable clipboard');}}}));await page.getByRole('button',{name:'Copy address: OAuth callback',exact:true}).click();await page.getByRole('status').filter({hasText:'Copy is unavailable.'}).waitFor();assert.equal(await field('OAuth callback').getAttribute('readonly'),'');
 console.log('PASS dirty discard, exact callback/selection validation, and selectable clipboard fallback.');

 stage='desktop and mobile layout';await openSettings();await mkdir(evidence,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:resolve(evidence,'desktop.png'),fullPage:true});await page.setViewportSize({width:360,height:900});await page.evaluate(()=>window.scrollTo(0,0));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await field('Facebook Login configuration ID').focus();assert.equal(await field('Facebook Login configuration ID').evaluate(e=>document.activeElement===e),true);for(const name of ['Save app settings','Reload app setup','Back to connections']){const box=await button(name).boundingBox();assert.ok(box&&box.height>=44&&box.width>0);}
 await page.screenshot({path:resolve(evidence,'mobile.png'),fullPage:true});assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 console.log('PASS desktop/360px bounds, labeled keyboard controls,44px actions, and no external traffic/page errors.');

 stage='native settings preserve real draft and recovery';await fresh();await chooseB();await focused();assert.equal(await settingsDisclosure().evaluate(node=>node.open),false);assert.equal(await field('App secret').count(),1);assert.equal(await field('App secret').isVisible(),false);assert.equal(await button('Disable registration').isVisible(),true);await page.setViewportSize({width:360,height:900});await page.screenshot({path:resolve(evidence,'default-closed-mobile.png'),fullPage:true});const readsBeforeDisclosure=calls.length;
 await openSettings();await field('Facebook Login configuration ID').fill('456x');await field('App secret').fill(secret);await field('Use this registration for new connections').check();assert.equal(await button('Save app settings').isDisabled(),true);assert.equal(await settingsDisclosure().evaluate(node=>node.open),true);const mountedSecret=await field('App secret').elementHandle();await settingsDisclosure().locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await field('App secret').isVisible(),false);assert.equal(await mountedSecret.evaluate(node=>node.isConnected),true);assert.equal(await field('App secret').inputValue(),secret);page.once('dialog',dialog=>dialog.dismiss());await button('Back to connections').click();assert.equal(await page.getByRole('heading',{name:'Fixture returned'}).count(),0);await settingsDisclosure().locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await field('Facebook Login configuration ID').inputValue(),'456x');assert.equal(await field('Use this registration for new connections').isChecked(),true);assert.equal(calls.length,readsBeforeDisclosure,'Disclosure and editing never issue reads or writes.');assert.equal(writes.length,0);
 await field('Facebook Login configuration ID').fill('456');writeMode='drop';await button('Save app settings').click();await unknown();await settingsDisclosure().locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await settingsDisclosure().evaluate(node=>node.open),false);assert.equal(await button('Reload app setup').isVisible(),true);assert.equal(await button('Reload app setup').isEnabled(),true);assert.equal(await button('Back to connections').isDisabled(),true);await page.screenshot({path:resolve(evidence,'unknown-closed-mobile.png'),fullPage:true});await button('Reload app setup').click();await selected('789');await focused();assert.equal(writes.length,1);assert.equal(await field('App secret').inputValue(),'');await button('New registration').click();await ready();assert.equal(await settingsDisclosure().evaluate(node=>node.open),true);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 console.log('PASS closed existing/new-open settings, mounted real invalid draft and secret, no disclosure requests, dirty guard and unknown-write recovery without replay.');
}catch(error){await mkdir(evidence,{recursive:true});await writeFile(resolve(evidence,'failure.txt'),stage+'\n'+String(error?.stack??error));if(page){await writeFile(resolve(evidence,'failure.html'),await page.content().catch(()=>''));await page.screenshot({path:resolve(evidence,'failure.png'),fullPage:true}).catch(()=>{});}console.error('FAIL Meta app controller stage: '+stage);process.exitCode=1;}finally{await browser?.close();await server.close();}
