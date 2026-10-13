// TEN98_META_VIEW_BROWSER=1 node tests/meta-connection-view-browser.mjs
// Pure production presentation + controlled synthetic props. No API/controller/DB/provider acceptance claim.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
assert.equal(process.env.TEN98_META_VIEW_BROWSER,'1');
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'private/meta-view-vite-cache',appType:'custom',optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meta connection view acceptance</title><div id="root"></div><script type="module" src="/tests/meta-connection-view-browser-fixture.tsx"></script></html>');});
let browser;
try{
 await server.listen();const address=server.httpServer.address();assert.equal(address.address,'127.0.0.1');const origin='http://127.0.0.1:'+address.port;
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({...process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{},headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(7000);
 const errors=[],external=[];page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin||url.pathname.startsWith('/api/')||request.method()!=='GET'){external.push(request.method()+' '+url.pathname);return route.abort();}return route.continue();});
 const button=name=>page.getByRole('button',{name,exact:true});
 const patch=async value=>{await page.evaluate(value=>window.metaViewFixture.patch(value),value);await page.waitForTimeout(0);};
 const calls=()=>page.evaluate(()=>window.metaViewFixture.calls());
 const clear=()=>page.evaluate(()=>window.metaViewFixture.clear());
 await page.goto(origin);await page.getByRole('heading',{name:'Meta ads',exact:true}).waitFor();
 assert.equal(await button('Connect Meta').isDisabled(),true);await page.getByLabel('Connection name',{exact:true}).fill('Synthetic source');await button('Connect Meta').click();assert.deepEqual((await calls()).filter(c=>c.action==='connect'),[{action:'connect',value:'Synthetic source'}]);assert.match(await page.locator('main').innerText(),/does not install a pixel/i);
 console.log('PASS controlled name and explicit connect callback; no automatic API/provider request.');

 await patch({mode:'account',selectedAccount:null});await page.getByRole('group',{name:'Ad account',exact:true}).waitFor();assert.equal(await page.getByRole('radio').count(),2);assert.equal(await page.getByRole('radio').nth(0).isChecked(),false);assert.equal(await page.getByRole('radio').nth(1).isDisabled(),true);assert.equal(await button('Confirm account').isDisabled(),true);
 await clear();await page.getByRole('radio').nth(0).focus();await page.keyboard.press('Space');assert.deepEqual(await calls(),[{action:'pick',value:'9007199254740993'}]);assert.equal(await page.locator('main img').count(),0);await button('Confirm account').focus();await page.keyboard.press('Enter');assert.deepEqual((await calls()).at(-1),{action:'confirm',value:'9007199254740993'});
 await page.getByText('Use an account ID',{exact:true}).click();await page.getByLabel('Ad account ID',{exact:true}).fill('9007199254740993');await clear();await button('Check account').click();assert.deepEqual(await calls(),[{action:'checkAccount',value:'9007199254740993'}]);
 await page.getByRole('radio').nth(0).focus();assert.equal(await page.getByRole('radio').nth(0).evaluate(e=>e===document.activeElement),true);
 console.log('PASS exact large account IDs, no automatic selection/save, disabled inaccessible option and hostile names rendered as text.');

 await patch({accounts:[],selectedAccount:null,discoveryState:'empty',discoveryLabel:'No accounts were returned for this grant.',canNextAccounts:false});await page.getByText('No accounts were returned for this grant.',{exact:true}).waitFor();assert.equal(await page.getByRole('radio').count(),0);
 await patch({discoveryState:'partial',discoveryLabel:'Account discovery is incomplete.',canNextAccounts:true});await button('Next accounts').click();assert.equal((await calls()).at(-1).action,'next');
 await patch({discoveryState:'failed',discoveryLabel:'Account discovery could not be completed.',error:'Meta account access could not be checked.'});await page.getByText('Meta account access could not be checked.',{exact:true}).waitFor();assert.equal(await button('Confirm account').isDisabled(),true);await patch({error:''});
 console.log('PASS distinct empty, partial and failed discovery without fabricated completeness or saved source.');

 await patch({writeState:'unknown',canRetrySame:true,canRestartConnect:false,pendingActionLabel:'Account selection is not confirmed.'});await button('Retry same request').click();assert.equal((await calls()).at(-1).action,'retrySame');assert.equal(await button('Back to connections').isDisabled(),true);assert.equal(await button('Confirm account').isDisabled(),true);
 await patch({canRetrySame:false,canRestartConnect:true,pendingActionLabel:'Meta authorization is not confirmed.'});assert.equal(await button('Retry same request').count(),0);await button('Start authorization again').click();assert.equal((await calls()).at(-1).action,'restartConnect');
 await patch({writeState:'submitting'});assert.equal(await button('Start authorization again').count(),0);assert.equal(await page.getByLabel('Ad account ID',{exact:true}).isDisabled(),true);
 await patch({writeState:'idle',reading:true});assert.equal(await button('Back to connections').isDisabled(),false);assert.equal(await button('Check account').isDisabled(),true);
 console.log('PASS unknown selection retry and OAuth restart remain distinct; pending writes lock other actions.');

 await patch({writeState:'idle',canRetrySame:false,canRestartConnect:false,mode:'connections',reading:false});await page.evaluate(()=>window.metaViewFixture.patch({connections:window.metaViewFixture.cards}));
 for(const role of ['admin','editor','viewer']){await patch({role,mode:'connections'});assert.equal(await button('Connect Meta').count(),0);assert.equal(await button('Choose account').count(),0);assert.equal(await button('Reconnect').count(),0);assert.equal(await button('Disconnect').count(),0);assert.match(await page.locator('main').innerText(),/Synthetic Meta source/);await button('Reload connections').click();assert.equal((await calls()).at(-1).action,'reload');await patch({mode:'account'});assert.equal(await page.getByRole('radio').count(),0);assert.equal(await button('Confirm account').count(),0);assert.equal(await button('Check account').count(),0);}
 await patch({role:'viewer',mode:'disconnect'});assert.equal(await button('Disconnect locally').count(),0);assert.equal(await button('Revoke Meta access and disconnect').count(),0);
 await patch({role:null,error:'Access was lost.'});await page.getByRole('alert').waitFor();assert.equal(await page.getByText('Synthetic Meta source',{exact:true}).count(),0);assert.equal(await button('Reload connections').count(),1);
 await patch({role:'owner',mode:'connections',error:'',canConnect:false,canOpenAppSetup:false,setupMessage:'Ask the instance operator to finish Meta app setup.'});assert.equal(await button('Open app setup').count(),0);if(await button('Connect Meta').count())assert.equal(await button('Connect Meta').isDisabled(),true);await patch({canOpenAppSetup:true});await page.getByText('Add a connection',{exact:true}).click();await button('Open app setup').click();assert.equal((await calls()).at(-1).action,'appSetup');
 console.log('PASS nonowner roles cannot mutate/discover despite capability flags; unknown role purges metadata and setup remains separate.');

 await patch({mode:'disconnect',canOpenAppSetup:false,setupMessage:'',canRemoteRevoke:true});await clear();await button('Disconnect locally').click();assert.deepEqual(await calls(),[{action:'disconnect',value:false}]);assert.equal(await button('Revoke Meta access and disconnect').isVisible(),false);await page.getByText('Revoke access at Meta',{exact:true}).click();assert.match(await page.locator('main').innerText(),/including ones you cannot view/);await button('Revoke Meta access and disconnect').click();assert.deepEqual((await calls()).at(-1),{action:'disconnect',value:true});await patch({canRemoteRevoke:false});assert.equal(await button('Revoke Meta access and disconnect').count(),0);
 console.log('PASS local disconnect and explicit wider Meta revocation are separate, capability-gated callbacks.');

 await page.evaluate(()=>window.metaViewFixture.patch({mode:'account',accounts:window.metaViewFixture.accounts,selectedAccount:window.metaViewFixture.accounts[0],discoveryState:'loaded',discoveryLabel:'Accounts returned for this grant; the list may be incomplete.',canConnect:true,reading:false}));
 await mkdir(resolve('private/meta-view-evidence'),{recursive:true});await page.screenshot({path:resolve('private/meta-view-evidence/accounts-1440.png'),fullPage:true});await page.setViewportSize({width:360,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.ok((await button('Confirm account').boundingBox()).height>=44);await button('Confirm account').focus();assert.equal(await button('Confirm account').evaluate(e=>e===document.activeElement),true);
 assert.deepEqual(await page.locator('[aria-describedby]').evaluateAll(nodes=>nodes.flatMap(e=>(e.getAttribute('aria-describedby')??'').split(/\s+/).filter(id=>id&&!document.getElementById(id)))),[]);
 await page.screenshot({path:resolve('private/meta-view-evidence/accounts-360.png'),fullPage:true});await patch({mode:'disconnect',canRemoteRevoke:true});await page.screenshot({path:resolve('private/meta-view-evidence/disconnect-360.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS1440/360 keyboard,44px action, helper associations and no external/provider/API traffic.');
}finally{await browser?.close();await server.close();}
