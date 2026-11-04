// Actual Privacy component, closed synthetic transport; no native database/provider acceptance.
// TEN98_PRIVACY_BROWSER=1 PLAYWRIGHT_MODULE=<installed entry> node tests/privacy-settings-browser.ts
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {launchChromium,setViewport} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_PRIVACY_BROWSER,'1');
const out=resolve(process.env.PRIVACY_ARTIFACT_DIR??'private/swarm/privacy-ux-01/browser');await mkdir(out,{recursive:true});
const server=await createServer({configFile:false,envDir:false,root:process.cwd(),cacheDir:resolve(out,'cache'),appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router','zod']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy fixture</title><div id="root"></div><script type="module" src="/tests/privacy-settings-browser-fixture.tsx"></script></html>');});
let browser:any,context:any,page:any,requests=0,posts=0,totalPosts=0,revision=4,role='owner',status=200;
const errors:string[]=[],external:string[]=[],groups:string[]=[],geometry:unknown[]=[];
let settings={enabled:true,collectionMode:'consent-first',consentMode:'builtin',captureReferrer:false,captureCampaigns:true,captureScreen:false,captureGeography:false,captureTags:false,capturePerformance:false,excludeBots:true,linkIdentities:false,excludedPaths:['/private']};
const check=(name:string)=>page.getByRole('checkbox',{name,exact:true}),button=(name:string)=>page.getByRole('button',{name,exact:true});
try{
 await server.listen();const address=server.httpServer!.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
 await server.environments.client.transformRequest('/tests/privacy-settings-browser-fixture.tsx');await server.environments.client.waitForRequestsIdle();await server.environments.client.depsOptimizer?.scanProcessing;
 browser=await launchChromium();context=await browser.newContext({viewport:{width:360,height:740},hasTouch:true,serviceWorkers:'block',reducedMotion:'reduce'});
 await context.route('**/*',async(route:any)=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin){external.push(url.href);return route.abort();}if(!url.pathname.startsWith('/api/'))return route.continue();assert.ok(++requests<=100,'API request cap');assert.equal(url.pathname,'/api/projects/synthetic-project/analytics-settings');if(req.method()==='POST'){posts++;totalPosts++;if(status===200){assert.equal(req.postDataJSON().revision,revision);settings=req.postDataJSON().settings;revision++;}}return route.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?{settings,revision,role,networkMode:'direct'}:{error:'Synthetic refusal'})});});
 page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('dialog',async(dialog:any)=>{errors.push('Unexpected native dialog');await dialog.dismiss();});
 await page.goto(origin);await check('Capture tags').waitFor();
 for(const width of [320,360,1280]){
  await setViewport(page,{width,height:800});
  const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));geometry.push(dimensions);assert.ok(dimensions.scroll<=width+1,'No horizontal overflow at '+width);
  await page.screenshot({path:resolve(out,'privacy-'+width+'.png'),fullPage:true});
 }
 const help=page.locator('summary').filter({hasText:'What this metadata contains'});
 assert.equal(await help.count(),1,'Metadata explanation has a dedicated contextual disclosure');
 assert.equal(await page.getByText(/Stores the UTM parameters/).isVisible(),false,'Detailed metadata explanation starts collapsed');
 await help.focus();await page.keyboard.press('Enter');assert.equal(await page.getByText(/Stores the UTM parameters/).isVisible(),true);await page.keyboard.press('Space');assert.equal(await page.getByText(/Stores the UTM parameters/).isVisible(),false);groups.push('Contextual help opens and closes by keyboard');
 for(const name of ['Enable native analytics','Referring website','Campaign parameters','Screen dimensions','Page loading and interaction performance','Capture tags','Approximate country, region and city','Enable click and scroll heatmaps after analytics consent','Enable recordings after separate replay consent','Link future identified activity across devices and months','Exclude recognized bots']){
  assert.equal(await check(name).isVisible(),true);const shape=await check(name).evaluate((input:HTMLInputElement)=>{const label=input.closest('label')!,span=label.querySelector('span')!;return {input:input.getBoundingClientRect().width,target:label.getBoundingClientRect().height,text:span?.getBoundingClientRect().width??0};});assert.ok(shape.input<=16&&shape.target>=44&&shape.text>65,name+' has a compact control and usable label');
 }
 groups.push('All eleven settings remain visible with consistent shared controls');
 await setViewport(page,{width:360,height:800});await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await page.screenshot({path:resolve(out,'privacy-dark.png'),fullPage:true});
 await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:resolve(out,'privacy-200-percent.png'),fullPage:true});await page.evaluate(()=>{document.documentElement.style.fontSize='';delete document.documentElement.dataset.theme;});groups.push('320/360/desktop, dark and 200% text fit without horizontal scrolling');
 // Editing every optional checkbox then cancelling must restore its original value.
 const originalChoices=await page.getByRole('checkbox').evaluateAll((inputs:HTMLInputElement[])=>inputs.map(input=>input.checked));
 for(const input of await page.getByRole('checkbox').all())await input.click();
 await button('Cancel changes').click();assert.deepEqual(await page.getByRole('checkbox').evaluateAll((inputs:HTMLInputElement[])=>inputs.map(input=>input.checked)),originalChoices);
 await page.getByRole('radio',{name:'Cookieless basic analytics',exact:true}).check();
 await page.getByRole('radio',{name:'Existing consent platform',exact:true}).check();
 await check('Enable click and scroll heatmaps after analytics consent').check();await check('Enable recordings after separate replay consent').check();
 await page.getByRole('slider',{name:/^Sample/}).press('Home');await page.getByRole('slider',{name:/^Sample/}).press('ArrowRight');
 await page.getByRole('slider',{name:/^Record/}).press('Home');await page.getByRole('slider',{name:/^Record/}).press('ArrowRight');
 await page.getByRole('combobox',{name:'Maximum recording length',exact:true}).selectOption('600000');
 await page.getByRole('textbox',{name:'Block additional sections with a CSS selector',exact:true}).fill('.private');
 await button('Save changes').click();await page.getByText(/Basic analytics resumes when the website loads the current policy/).waitFor();assert.equal(posts,0);
 await button('Save changes').click();await page.getByText('Settings saved.',{exact:true}).waitFor();
 assert.equal(settings.collectionMode,'cookieless');assert.equal(settings.consentMode,'external');
 const extras=settings as typeof settings & {heatmap:{enabled:boolean;sampleRate:number};replay:{enabled:boolean;sampleRate:number;maxDurationMs:number;blockSelector:string}};
 assert.equal(extras.heatmap.enabled,true);assert.equal(extras.heatmap.sampleRate,.01);assert.equal(extras.replay.enabled,true);assert.equal(extras.replay.sampleRate,.01);assert.equal(extras.replay.maxDurationMs,600000);assert.equal(extras.replay.blockSelector,'.private');
 groups.push('Every checkbox cancels correctly; collection, consent, heatmap and replay settings save exact chosen values');
 posts=0;
 const paths=page.getByRole('textbox',{name:'Excluded path prefixes',exact:true});await paths.fill('invalid');assert.equal(await button('Save changes').isDisabled(),true);await button('Cancel changes').click();assert.equal(await paths.inputValue(),'/private');
 await check('Screen dimensions').check();await button('Save changes').click();await page.getByText(/Previous consent grants expire/).waitFor();assert.equal(posts,0,'First save only opens consequence confirmation');await button('Keep editing').click();assert.equal(posts,0);await button('Save changes').click();await button('Save changes').click();await page.getByText('Settings saved.',{exact:true}).waitFor();assert.equal(posts,1);assert.equal(settings.captureScreen,true);groups.push('Validation, cancel and explicit two-step save retain their contracts');
 await check('Referring website').check();status=409;await button('Save changes').click();await button('Save changes').click();await page.getByText(/These settings were changed elsewhere/).waitFor();assert.equal(await check('Referring website').isChecked(),true);status=200;await button('Reload saved settings').click();await page.waitForFunction(()=>!document.querySelector('fieldset')?.disabled);assert.equal(await check('Referring website').isChecked(),false);groups.push('Revision conflict preserves draft and explicit reload restores saved state');
 await page.getByRole('combobox',{name:'Masking',exact:true}).selectOption('moderate');await page.getByText(/Visible page text can contain personal information/).waitFor();await button('Cancel changes').click();
 role='viewer';await button('Reload settings').click();await page.getByText('You can view these settings; only owners and admins can change them.',{exact:true}).waitFor();assert.equal(await check('Enable native analytics').isDisabled(),true);assert.equal(await button('Save changes').isDisabled(),true);status=403;await button('Reload settings').click();await page.getByText('Analytics settings are not available for your current project access.',{exact:true}).waitFor();assert.equal(await check('Capture tags').count(),0);groups.push('Masking consequence stays visible; viewer and revoked access cannot edit');
 assert.deepEqual(external,[]);assert.deepEqual(errors,[]);await writeFile(resolve(out,'receipt.json'),JSON.stringify({groups,geometry,requests,posts:totalPosts,contexts:1,external,errors,scope:'Synthetic component transport; native acceptance remains separate'},null,2));console.log('PASS '+groups.length+' privacy browser groups; '+requests+' API requests');
}finally{await context?.close();await browser?.close();await server.close();}
