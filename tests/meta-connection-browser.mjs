// Opt in: TEN98_META_PANEL_BROWSER=1 node tests/meta-connection-browser.mjs
// PLAYWRIGHT_MODULE may point to an existing Playwright ESM entry; PLAYWRIGHT_CHANNEL is optional.
// Production controller + RouterProvider, synthetic same-origin API only. No DB, credentials or provider calls.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';

assert.equal(process.env.TEN98_META_PANEL_BROWSER,'1');
const pid='20000000-0000-4000-8000-000000000001',otherPid='20000000-0000-4000-8000-000000000002';
const cid='40000000-0000-4000-8000-000000000001',otherCid='40000000-0000-4000-8000-000000000002';
const base='/api/projects/'+pid+'/meta',at='2026-10-13T12:00:00.000Z';
const accountA={id:'9'.repeat(39)+'1',name:'Same synthetic account',currency:'USD',timeZone:'America/New_York',status:1};
const accountB={...accountA,id:'9'.repeat(39)+'2',currency:'AED',timeZone:'Asia/Dubai'};
const accountC={...accountA,id:'9'.repeat(39)+'3',name:'Plain <img src=x onerror=alert(1)> account'};
const initial={id:cid,name:'Synthetic Meta source',revision:1,status:'select_account',account:null,scopes:['ads_read'],accessExpiresAt:null,dataAccessExpiresAt:null,validatedAt:at,updatedAt:at};
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'private/meta-panel-vite-cache',appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url!=='/'&&req.url!=='/elsewhere')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meta connection controller acceptance</title><div id="root"></div><script type="module" src="/tests/meta-connection-browser-fixture.tsx"></script></html>');});
let browser,page;
try{
 await server.listen();const address=server.httpServer.address();assert.equal(address.address,'127.0.0.1');const origin='http://127.0.0.1:'+address.port;
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({...process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{},headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 const errors=[],unexpected=[],calls=[],writes=[],receipts=new Map();
 let currentRole='owner',connection=structuredClone(initial),settings,readMode=null,writeMode=null,held=null,connectionPages=false,oauthUrl='https://attacker.invalid/steal';
 const app=()=>({operator:true,configured:true,enabled:true,vaultConfigured:true,httpsReady:true,redirectUri:origin+'/api/meta/callback',...settings});
 const detail=()=>({role:currentRole,connection:structuredClone(connection)});
 const list=url=>({role:currentRole,connections:[url.searchParams.has('cursor')?{...structuredClone(initial),id:otherCid,name:'Second connection page'}:structuredClone(connection)],nextCursor:connectionPages&&!url.searchParams.has('cursor')?'opaque-connection-page-2':null});
 const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});
 const release=async()=>{const value=held;assert.ok(value,'A controlled response must be held');held=null;await json(value.route,value.reply);};
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push(method+' '+url.origin);return route.abort();}
  if(!path.startsWith('/api/')){if(method==='GET')return route.continue();unexpected.push(method+' '+path);return route.abort();}
  const body=request.postData()?request.postDataJSON():null;calls.push({path,method,query:url.search,body});
  if(path==='/api/meta/app')return json(route,app());
  if(path==='/api/projects/'+otherPid+'/meta')return json(route,{role:'viewer',connections:[],nextCursor:null});
  if(!path.startsWith(base)){unexpected.push(path);return json(route,{error:'Unexpected fixture route'},404);}
  const mutation=method==='POST'&&/\/(connect|select|disconnect)$/.test(path);
  if(!mutation){
   let reply;
   if(method==='GET'&&path===base)reply=list(url);
   else if(method==='GET'&&path===base+'/connections/'+cid)reply=detail();
   else if(method==='POST'&&path.endsWith('/accounts')){assert.equal(body.revision,connection.revision);reply={role:currentRole,connectionId:cid,revision:connection.revision,accounts:body.cursor?[accountC]:[accountA,accountB],complete:!!body.cursor,nextCursor:body.cursor?null:'opaque-account-page-2'};}
   else if(method==='POST'&&path.endsWith('/inspect')){assert.equal(body.revision,connection.revision);assert.equal(body.accountId,accountC.id);reply={role:currentRole,connectionId:cid,revision:connection.revision,account:accountC};}
   else{unexpected.push(method+' '+path);return json(route,{error:'Unexpected fixture route'},404);}
   const mode=readMode;readMode=null;
   if(mode==='hold'){assert.equal(held,null);held={route,reply:structuredClone(reply)};return;}
   if(typeof mode==='number')return json(route,{error:'Synthetic scope or revision denial'},mode);
   return json(route,reply);
  }
  writes.push({path,body:structuredClone(body)});const mode=writeMode;writeMode=null;
  // These replies reject only this delivery; an earlier request may already have committed.
  if([401,403,404,408,409,429,503].includes(mode))return json(route,{error:'Synthetic write response'},mode);
  if(path.endsWith('/connect')){
   if(mode==='drop')return route.abort('failed');
   return json(route,{authorizationUrl:oauthUrl});
  }
  const previous=receipts.get(body.requestId);let reply;
  if(previous){assert.deepEqual(previous.request,{path,body},'Replay must retain the exact path/body/request ID');reply=structuredClone(previous.reply);if('replayed' in reply)reply.replayed=true;}
  else{
   assert.equal(body.revision,connection.revision,'First mutation uses current connection revision');
   if(path.endsWith('/select')){
    assert.ok([accountA.id,accountB.id,accountC.id].includes(body.accountId));connection={...connection,revision:connection.revision+1,status:'ready',account:structuredClone([accountA,accountB,accountC].find(a=>a.id===body.accountId))};
    reply={...detail(),replayed:false,acknowledgement:{requestId:body.requestId,connectionId:cid,selectedAccountId:body.accountId,revision:body.revision+1}};
   }else{assert.equal(typeof body.revokeAtMeta,'boolean');connection={...connection,status:'disconnected',revision:connection.revision+1};reply={disconnected:true,remoteRevocation:body.revokeAtMeta?'unconfirmed':'not_requested',acknowledgement:{requestId:body.requestId,connectionId:cid,revision:body.revision,revokeAtMeta:body.revokeAtMeta}};}
   receipts.set(body.requestId,{request:{path,body:structuredClone(body)},reply:structuredClone(reply)});
  }
  if(mode==='drop')return route.abort('failed');
  if(mode==='malformed')return json(route,{...reply,acknowledgement:{...reply.acknowledgement,requestId:body.requestId+'\n'}});
  if(mode==='malformed-nested')return json(route,{...reply,connection:{...reply.connection,account:{}}});
  if(mode==='hold'){assert.equal(held,null);held={route,reply};return;}
  return json(route,reply);
 });
 const button=name=>page.getByRole('button',{name,exact:true});
 const until=async predicate=>{const deadline=Date.now()+7000;while(!predicate()){if(Date.now()>deadline)assert.fail('Timed out waiting for controlled request');await new Promise(r=>setTimeout(r,10));}};
 const ready=async()=>{await page.getByRole('heading',{name:'Synthetic Meta source',exact:true}).waitFor();await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Reload connections'&&!b.disabled));};
 const fresh=async({role='owner',setup={},status='select_account',pages=false}={})=>{
  await page?.close();assert.equal(held,null);currentRole=role;settings=setup;connection={...structuredClone(initial),status,account:status==='ready'?structuredClone(accountA):null};connectionPages=pages;readMode=null;writeMode=null;calls.length=0;writes.length=0;receipts.clear();
  page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await ready();
 };
 const choose=async()=>{await button('Choose account').click();await button('Reload accounts').waitFor();};
 const pick=async()=>{await choose();await button('Reload accounts').click();await page.getByRole('radio').first().waitFor();await page.getByRole('radio').first().check();};
 const unknown=async()=>{await button('Retry same request').waitFor();await until(()=>!writeMode);};
 const navigationBlocked=async()=>{await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/');assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false,'Native beforeunload event must be prevented for an unresolved write');};

 await fresh({pages:true});assert.equal(calls.filter(c=>c.method==='POST').length,0,'Initial read must not discover or mutate');
 await button('Next connections').click();await page.getByRole('heading',{name:'Second connection page',exact:true}).waitFor();await button('Previous connections').click();await ready();
 await choose();assert.equal(await page.getByRole('radio').count(),0);assert.equal(await button('Confirm account').isDisabled(),true);
 await button('Reload accounts').click();await page.getByRole('radio').first().waitFor();assert.equal(await page.getByRole('radio').count(),2);assert.equal(await page.getByRole('radio').first().isChecked(),false);assert.equal(await page.getByRole('radio').last().isChecked(),false);
 assert.ok((await page.getByRole('radio').first().getAttribute('id')).endsWith(accountA.id));assert.ok((await page.getByRole('radio').last().getAttribute('id')).endsWith(accountB.id));
 await button('Next accounts').click();await page.getByRole('radio',{name:new RegExp(accountC.id)}).waitFor();assert.equal(await page.locator('main img').count(),0);await button('Previous accounts').click();await page.getByRole('radio',{name:new RegExp(accountA.id)}).waitFor();
 assert.deepEqual(calls.filter(c=>c.path.endsWith('/accounts')).map(c=>c.body.cursor),[undefined,'opaque-account-page-2',undefined]);
 await page.getByText('Use an account ID',{exact:true}).click();await page.getByLabel('Ad account ID',{exact:true}).fill(accountC.id);await button('Check account').click();await page.getByText(/Account checked\. Review it/).waitFor();assert.equal(writes.length,0,'Inspection selects only a draft, never saves');
 assert.equal(await button('Confirm account').isEnabled(),true);assert.equal(await page.locator('main img').count(),0);
 console.log('PASS exact long account IDs, same-name choices, opaque discovery/connection pages, no auto-select, and direct-ID inspection without save.');

 await fresh();await pick();writeMode='drop';await button('Confirm account').click();await unknown();const selection=structuredClone(writes.at(-1));await navigationBlocked();assert.equal(await button('Back to connections').isDisabled(),true);
 for(const mode of [408,429,503,'malformed','malformed-nested']){writeMode=mode;await button('Retry same request').click();await unknown();assert.deepEqual(writes.at(-1),selection);await navigationBlocked();}
 await button('Retry same request').click();await page.getByText('Account selected. Report imports are a separate action.',{exact:true}).waitFor();assert.deepEqual(writes.at(-1),selection);assert.equal(receipts.size,1);assert.equal(connection.revision,2);assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true);
 await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();await page.getByRole('heading',{name:'Fixture elsewhere page',exact:true}).waitFor();
 console.log('PASS committed selection lost-ack,408,429,503 and malformed2xx preserve one exact request; router/unload stay blocked until verified receipt.');

 await fresh({status:'ready'});await button('Disconnect').click();await button('Disconnect locally').waitFor();writeMode='drop';await button('Disconnect locally').click();await unknown();const disconnect=structuredClone(writes.at(-1));assert.equal(disconnect.body.revokeAtMeta,false);
 for(const mode of [408,429,503,'malformed']){writeMode=mode;await button('Retry same request').click();await unknown();assert.deepEqual(writes.at(-1),disconnect);await navigationBlocked();assert.equal(await button('Keep connection').isDisabled(),true);}
 await button('Retry same request').click();await page.getByText('Disconnected locally. Meta access was not revoked.',{exact:true}).waitFor();assert.deepEqual(writes.at(-1),disconnect);assert.equal(receipts.size,1);
 console.log('PASS disconnect unknown outcomes retain the original revision and local-only choice through retries and explicit acknowledgement.');

 await fresh();await pick();writeMode='hold';await button('Confirm account').click();await until(()=>held!==null);await navigationBlocked();assert.equal(await button('Back to connections').isDisabled(),true);await release();await page.getByText('Account selected. Report imports are a separate action.',{exact:true}).waitFor();
 console.log('PASS a held active write cannot be cancelled by panel Back, router links or native unload.');

 await fresh();await choose();readMode='hold';await button('Reload accounts').click();await until(()=>held!==null);await button('Back to connections').click();await ready();await release();assert.equal(await page.getByRole('radio').count(),0);
 await choose();readMode='hold';await button('Reload accounts').click();await until(()=>held!==null);readMode=403;await button('Back to connections').click();await button('Reload connections').click();await page.getByRole('alert').waitFor();await release();assert.equal(await page.getByRole('radio').count(),0);assert.equal(await page.getByRole('heading',{name:'Synthetic Meta source',exact:true}).count(),0);assert.equal(await button('Choose account').count(),0);
 await button('Reload connections').click();await ready();
 console.log('PASS Back interrupts held account reads; later403 scope denial purges protected content and defeats an older successful response.');

 await choose();currentRole='viewer';await button('Reload accounts').click();await page.getByRole('alert').waitFor();assert.equal(await button('Confirm account').count(),0);assert.equal(await page.getByRole('radio').count(),0);await button('Reload connections').click();await page.getByText(/A workspace owner can connect or change sources/).waitFor();
 await fresh();await pick();writeMode='drop';await button('Confirm account').click();await unknown();writeMode=404;await button('Retry same request').click();await page.getByRole('alert').waitFor();assert.equal(await button('Retry same request').count(),0);assert.equal(await page.getByRole('radio').count(),0);await page.getByRole('link',{name:'Fixture elsewhere',exact:true}).click();await page.getByRole('heading',{name:'Fixture elsewhere page',exact:true}).waitFor();
 console.log('PASS fresh role downgrade and404 write scope denial clear protected choices and release stale pending authority.');

 await fresh();await pick();writeMode=409;await button('Confirm account').click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/Reload connections/);assert.equal(await button('Retry same request').count(),0);assert.equal(await page.getByRole('radio').count(),0);assert.equal(await button('Confirm account').count(),0);await button('Reload connections').click();await ready();await choose();assert.equal(await page.getByRole('radio').count(),0);
 readMode=409;await button('Reload accounts').click();await page.getByRole('alert').waitFor();assert.equal(await button('Check account').count(),0);await button('Reload connections').click();await ready();
 console.log('PASS selection and discovery revision409 invalidate choices and require an explicit fresh read.');

 await fresh({status:'ready',setup:{enabled:false,vaultConfigured:false}});assert.equal(await button('Reconnect').count(),0);await button('Disconnect').click();await button('Disconnect locally').waitFor();await button('Disconnect locally').click();await page.getByText('Disconnected locally. Meta access was not revoked.',{exact:true}).waitFor();assert.equal(writes.length,1);assert.equal(writes[0].body.revokeAtMeta,false);assert.equal(calls.some(c=>/\/(connect|accounts|inspect)$/.test(c.path)),false);
 console.log('PASS disabled app and unavailable vault still permit explicit local disconnect without authorization or discovery requests.');

 await fresh();await page.getByText('Add a connection',{exact:true}).click();await page.getByLabel('Connection name',{exact:true}).fill('New synthetic grant');writeMode='drop';await button('Connect Meta').click();await button('Start authorization again').waitFor();assert.equal(await button('Retry same request').count(),0);await navigationBlocked();const first=structuredClone(writes.at(-1));
 const valid=new URL('https://www.facebook.com/v26.0/dialog/oauth');for(const [k,v] of Object.entries({client_id:'123',config_id:'456',response_type:'code',redirect_uri:origin+'/api/meta/callback',state:'s'.repeat(43)}))valid.searchParams.set(k,v);
 const hostile=[valid.href.replace('www.facebook.com','www.facebook.com.attacker.invalid'),valid.href+'&next=https://attacker.invalid',valid.href+'&state='+('t'.repeat(43)),valid.href.replace(encodeURIComponent(origin+'/api/meta/callback'),encodeURIComponent('https://attacker.invalid/callback'))];
 for(const target of hostile){oauthUrl=target;await button('Start authorization again').click();await button('Start authorization again').waitFor();await until(()=>writes.at(-1).body.requestId!==first.body.requestId);assert.equal(new URL(page.url()).origin,origin);assert.equal(await button('Retry same request').count(),0);}
 const ids=writes.map(w=>w.body.requestId);assert.equal(new Set(ids).size,ids.length);assert.ok(writes.every(w=>w.body.name===first.body.name));assert.deepEqual(unexpected,[]);assert.equal(await button('Open app setup').isDisabled(),true);
 await page.evaluate(id=>window.metaPanelFixture.scope({projectId:id}),otherPid);await page.getByText(/A workspace owner can connect or change sources/).waitFor();assert.equal(await button('Start authorization again').count(),0);assert.equal(await page.getByLabel('Connection name',{exact:true}).count(),0);assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true);
 console.log('PASS OAuth restart is explicit with a new UUID; hostile authorization URLs never navigate; account/project remount clears abandoned local intent.');

 await fresh();readMode='hold';await button('Reload connections').click();await until(()=>held!==null);await page.evaluate(id=>window.metaPanelFixture.scope({projectId:id}),otherPid);await page.getByText(/A workspace owner can connect or change sources/).waitFor();await release();assert.equal(await page.getByRole('heading',{name:'Synthetic Meta source',exact:true}).count(),0);assert.equal(await button('Choose account').count(),0);
 await fresh({role:'admin'});assert.equal(await button('Choose account').count(),0);assert.equal(await button('Reconnect').count(),0);assert.equal(await button('Disconnect').count(),0);assert.equal(writes.length,0);
 await fresh();readMode=401;await button('Reload connections').click();await page.getByRole('heading',{name:'Fixture signed out',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Synthetic Meta source',exact:true}).count(),0);
 console.log('PASS cross-project held-response suppression, non-owner read-only access and401 parent signout purge.');

 await fresh();await choose();await button('Reload accounts').click();await page.getByRole('radio').first().waitFor();await mkdir(resolve('private/meta-panel-evidence'),{recursive:true});
 for(const width of [1440,360]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No document overflow at '+width);await page.screenshot({path:resolve('private/meta-panel-evidence/meta-accounts-'+width+'.png'),fullPage:true});}
 await page.getByRole('radio').first().focus();await page.keyboard.press('Space');assert.equal(await button('Confirm account').isEnabled(),true);assert.ok((await button('Confirm account').boundingBox()).height>=44);await button('Back to connections').focus();await page.keyboard.press('Enter');await ready();assert.equal(await page.evaluate(()=>document.activeElement?.id.endsWith('heading')),true);
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 console.log('PASS real keyboard selection/Back focus,1440/360px layout,44px action and no external traffic or page errors.');

 // Distinct from an account-list read: opening a card holds current-role validation.
 await fresh();readMode='hold';await button('Choose account').click();await until(()=>held!==null);await button('Back to connections').click();await ready();await release();assert.equal(await button('Reload accounts').count(),0);
 console.log('PASS held detail authorization read can be interrupted without restoring the old detail.');

 await fresh({status:'ready'});connection.account.name='N'.repeat(512);await button('Reload connections').click();await ready();assert.ok((await page.locator('main').textContent()).includes('N'.repeat(512)),'Valid server name limit must not reject the list.');
 currentRole='viewer';connection={...connection,status:'deleted',account:null,scopes:[],validatedAt:null};readMode='hold';await button('Disconnect').click();await until(()=>held!==null);assert.equal((await page.locator('main').textContent()).includes(accountA.id),false);await release();await page.getByText(/A workspace owner can connect or change sources/).waitFor();assert.equal((await page.locator('main').textContent()).includes(accountA.id),false,'A fresh deleted/viewer detail must replace the cached account.');assert.equal(await button('Disconnect').count(),0);
 await fresh({status:'ready'});connection={...connection,status:'deleted',account:null,scopes:[],validatedAt:null};await button('Disconnect').click();await page.getByText('Deleted locally',{exact:true}).waitFor();assert.equal(await button('Disconnect locally').count(),0,'A now-deleted source must not open a dead confirmation.');
 console.log('PASS valid512-character account names and fresh deleted detail replace stale owner metadata for both viewer and owner returns.');
 await fresh({setup:{enabled:false}});const add=page.locator('main summary').filter({hasText:/^Add a connection$/});assert.equal(await add.evaluate(node=>node.parentElement.open),false);assert.equal(await button('Open app setup').isVisible(),true);assert.equal(await button('Open app setup').evaluate(node=>node.closest('details')===null),true);assert.equal(await page.getByText('Meta connections are not enabled on this installation. Ask the instance operator to finish Meta app setup.',{exact:true}).isVisible(),true);
 assert.equal(await page.locator('main article').evaluate((node,summary)=>Boolean(node.compareDocumentPosition(summary)&Node.DOCUMENT_POSITION_FOLLOWING),await add.elementHandle()),true);const beforeDraft=calls.length;await button('Open app setup').click();assert.equal(await page.evaluate(()=>window.metaPanelFixture.read().appSetup),1);await add.focus();await page.keyboard.press('Enter');await page.getByLabel('Connection name',{exact:true}).fill('A local draft');await add.focus();await page.keyboard.press('Space');assert.equal(await page.getByLabel('Connection name',{exact:true}).inputValue(),'A local draft');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(calls.length,beforeDraft,'Setup navigation, disclosure toggles and local draft issue no request');assert.equal(writes.length,0);
 await fresh({setup:{enabled:false,operator:false}});assert.equal(await button('Open app setup').count(),0);assert.equal(await page.getByText('Meta connections are not enabled on this installation. Ask the instance operator to finish Meta app setup.',{exact:true}).isVisible(),true);await fresh({role:'viewer'});assert.equal(await button('Open app setup').count(),0);assert.equal(await page.getByLabel('Connection name',{exact:true}).count(),0);
 await fresh();await pick();assert.equal(await page.getByText('Connection: Synthetic Meta source',{exact:true}).isVisible(),true);await button('Next accounts').click();await page.getByRole('radio',{name:new RegExp(accountC.id)}).waitFor();const selected=page.getByText('Selected account: '+accountA.name+' · ID '+accountA.id+' · '+accountA.currency+' · '+accountA.timeZone,{exact:true});assert.equal(await selected.isVisible(),true);assert.equal(await button('Confirm account').isEnabled(),true);assert.equal(await button('Confirm account').count(),1);assert.equal(await button('Confirm account').evaluate((node,summary)=>Boolean(node.compareDocumentPosition(summary)&Node.DOCUMENT_POSITION_FOLLOWING),await page.locator('main summary').filter({hasText:/^Use an account ID$/}).elementHandle()),true);const beforeReview=calls.length;await page.locator('main summary').filter({hasText:/^Use an account ID$/}).click();await page.getByLabel('Ad account ID',{exact:true}).fill(accountC.id);await page.locator('main summary').filter({hasText:/^Use an account ID$/}).click();assert.equal(await selected.isVisible(),true);assert.equal(writes.length,0);assert.equal(calls.length,beforeReview);
 await button('Confirm account').click();await page.getByText('Account selected. Report imports are a separate action.',{exact:true}).waitFor();assert.equal(writes.length,1);assert.equal(writes[0].body.accountId,accountA.id,'Manual-ID draft cannot silently replace the reviewed selection');
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS saved-source order, operator-only visible setup, request-free native draft disclosure and off-page reviewed account confirmed without manual-ID coercion.');
}catch(error){
 // Only this self-contained synthetic DOM is printed, never application/operator state.
 if(page&&!page.isClosed())console.error((await page.locator('main').innerText().catch(()=>'' )).slice(0,4000));
 throw error;
}finally{await browser?.close();await server.close();}
