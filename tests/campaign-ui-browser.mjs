// Actual App/controller with synthetic API responses; no database, credentials or provider calls.
// Run: TEN98_CAMPAIGN_UI_BROWSER=1 PLAYWRIGHT_MODULE=<installed entry> node tests/campaign-ui-browser.mjs
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
assert.equal(process.env.TEN98_CAMPAIGN_UI_BROWSER,'1');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const root=process.cwd(),out=resolve('private/campaign-ui-evidence'),unexpected=[],errors=[],requests=[];
await mkdir(out,{recursive:true});
const server=await createServer({configFile:false,envDir:false,root,cacheDir:out+'/vite-cache',appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router','zod']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ten98 Discover UI check</title><div id="root"></div><script type="module" src="/tests/account-preferences-browser-fixture.tsx"></script></html>');});
let browser,context;
const ratio=(a,b)=>{const luminance=s=>s.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0),x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
try{
 await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
 await server.environments.client.transformRequest('/tests/account-preferences-browser-fixture.tsx');
 await server.environments.client.waitForRequestsIdle();
 const optimizer=server.environments.client.depsOptimizer;await optimizer.scanProcessing;await Promise.all(Object.values(optimizer.metadata.discovered).map(d=>d.processing));
 const{chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
 browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL??'msedge'});
 async function fresh(mode='signin',theme='light'){
  await context?.close();context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin){unexpected.push(url.href);return route.abort();}if(!url.pathname.startsWith('/api/'))return route.continue();
   const path=url.pathname;requests.push({method:req.method(),path});let body,status=200;
   if(path==='/api/status')body={configured:mode!=='setup',appUrl:origin};
   else if(path==='/api/me'){if(mode!=='app'){status=401;body={error:'Sign in'};}else body={user:{id:'ui-user',name:'UI example',email:'ui@example.com'},instanceOperator:false,workspaces:[]};}
   else if(path==='/api/account/preferences')body={version:'account-preferences-v1',user:{id:'ui-user',name:'UI example',email:'ui@example.com'},preferences:{revision:0,timeZone:'UTC',locale:'en-US',theme,updatedAt:null}};
   else if(path==='/api/auth/oidc/providers')body={providers:[{id:'ui-provider',name:'Example organization'}]};
   else if(path==='/api/auth/password-reset-status')body={configured:true};
   else if(path==='/api/auth/sign-in/email')body={twoFactorRedirect:true};
   else {unexpected.push(req.method()+' '+path);return route.abort();}
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);return page;
 }
 async function geometry(page,label){
  for(const dir of ['ltr','rtl'])for(const width of [1440,760,360,320]){
   await page.setViewportSize({width,height:1000});await page.evaluate(dir=>document.documentElement.dir=dir,dir);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+' '+dir+' '+width+' overflow');
   const boxes=await page.locator('.auth-story,.auth-form').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};}));
   if(width>760)assert.ok(Math.abs(boxes[0].y-boxes[1].y)<1&&Math.abs(boxes[0].x-boxes[1].x)>=width/2-1,label+' split layout');
   else assert.ok(boxes[1].y>=boxes[0].y+boxes[0].h-1,label+' stacked layout');
   for(const height of await page.locator('.auth input,.auth button').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height)))assert.ok(height>=44,label+' touch target');
  }
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.dir='ltr');
 }
 let page=await fresh('setup');await page.getByRole('heading',{name:'Secure this installation',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Setup token',{exact:true}).getAttribute('type'),'password');
 assert.equal(await page.getByLabel('Password',{exact:true}).getAttribute('minlength'),'12');
 await geometry(page,'owner setup');console.log('PASS actual owner setup: split/stacked, LTR/RTL and 44px controls.');
 page=await fresh();await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();await page.getByRole('button',{name:'Continue with Example organization',exact:true}).waitFor();
 for(const selector of ['.auth-story-copy','.auth-story-foot','.auth-story .brand-product']){
  const pair=await page.locator(selector).evaluate(e=>({text:getComputedStyle(e).color,surface:getComputedStyle(e.closest('.auth-story')).backgroundColor}));assert.ok(ratio(pair.text,pair.surface)>=4.5,selector+' story contrast');
 }
 await geometry(page,'sign in');await page.getByLabel('Email',{exact:true}).focus();assert.equal(await page.getByLabel('Email',{exact:true}).evaluate(e=>getComputedStyle(e).outlineWidth),'3px');
 await page.screenshot({path:out+'/signin-desktop.png'});await page.setViewportSize({width:360,height:1000});await page.screenshot({path:out+'/signin-mobile.png'});
 await page.getByLabel('Email',{exact:true}).fill('ui@example.com');await page.getByLabel('Password',{exact:true}).fill('Synthetic-password-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('heading',{name:'Verify your sign-in',exact:true}).waitFor();await geometry(page,'second factor');
 await page.getByRole('button',{name:'Use a recovery code',exact:true}).click();await page.getByLabel('Recovery code',{exact:true}).waitFor();assert.equal(await page.getByLabel('Recovery code',{exact:true}).getAttribute('inputmode'),'text');
 await page.getByRole('button',{name:'Back to sign in',exact:true}).click();await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
 await page.getByRole('button',{name:'Forgot password?',exact:true}).click();await page.getByRole('heading',{name:'Reset your password',exact:true}).waitFor();await page.getByLabel('Account email',{exact:true}).waitFor();await geometry(page,'password recovery');
 console.log('PASS actual sign-in/OIDC control, factor/recovery transitions, story contrast, focus and responsive layouts.');
 for(const theme of ['light','dark','system']){
  page=await fresh('app',theme);await page.locator('.shell').waitFor();await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
  await page.getByText('Discover',{exact:true}).waitFor();assert.equal(await page.locator('.side').evaluate(e=>getComputedStyle(e).backgroundColor),theme==='dark'?'rgb(23, 32, 44)':'rgb(255, 255, 255)');
  assert.equal(await page.locator('.app-bar').evaluate(e=>e.getBoundingClientRect().height),69);
  for(const width of [1440,360,320]){await page.setViewportSize({width,height:1000});if(width<400&&await page.getByRole('button',{name:'Menu',exact:true}).isVisible())await page.getByRole('button',{name:'Menu',exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,theme+' shell '+width);}
  if(theme==='light'){await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:out+'/workspace-desktop.png'});}
 }
 console.log('PASS actual empty workspace shell: Discover branding, white sidebar, 69px header, light/dark/system and mobile menu containment.');
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);assert.ok(requests.some(r=>r.path==='/api/auth/sign-in/email'&&r.method==='POST'));
 console.log('PASS zero unexpected API/external requests and browser errors. Synthetic API responses; no real authentication, saved preferences or provider validation claimed.');
}finally{await context?.close();await browser?.close();await server.close();}
