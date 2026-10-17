// TEN98_PROJECT_DELETE_COMPILED=1 BASE_URL=http://127.0.0.1:3111 BOOTSTRAP_TOKEN=<that server's token> OUT_DIR=<new private dir> PLAYWRIGHT_MODULE=<owned playwright> node tests/project-delete-compiled-browser.mjs
// Drives the real built server (node .output/server/index.mjs) on a FRESH, UNCLAIMED, migrated local database with headless Edge.
// Claims the owner, creates two synthetic websites, deletes one from Collection and privacy, then checks router, selector, reload, 404 and stale deep link.
import assert from 'node:assert/strict';assert.equal(process.env.TEN98_PROJECT_DELETE_COMPILED,'1');assert.match(process.env.BASE_URL??'',/^http:\/\/127\.0\.0\.1:\d+$/,'Point BASE_URL at a local throwaway server; never a saved installation.');
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const base=process.env.BASE_URL,out=process.env.OUT_DIR,token=process.env.BOOTSTRAP_TOKEN;
const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const browser=await chromium.launch({channel:'msedge',headless:true});const evidence={steps:[],errors:[],api:[],csp:null};
const context=await browser.newContext({viewport:{width:1440,height:1000}});
// Every frame reports Content-Security-Policy violations as console errors, so a blocked script, style, image or frame fails the harness.
await context.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>console.error('csp '+e.effectiveDirective+' '+e.blockedURI)));
const page=await context.newPage();page.setDefaultTimeout(10000);
page.on('pageerror',e=>evidence.errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource:'))evidence.errors.push(m.text());});page.on('response',r=>{if(r.url().includes('/api/'))evidence.api.push(r.request().method()+' '+r.status()+' '+new URL(r.url()).pathname);});
const step=(name)=>{evidence.steps.push(name);console.log('STEP '+name);};
try{
 const landing=await page.goto(base+'/',{waitUntil:'domcontentloaded'});
 evidence.csp=landing.headers()['content-security-policy']??null;const headerNonce=evidence.csp?.match(/'nonce-([^']+)'/)?.[1];assert.ok(headerNonce,'The compiled document must carry a nonce policy.');
 assert.equal(await page.evaluate(()=>document.querySelector('script[type="module"]').nonce),headerNonce,'The module entry script must carry the header nonce.');step('document policy nonce matches the module entry script');
 await page.getByRole('heading',{name:'Secure this installation'}).waitFor();
 await page.fill('#su-token',token);await page.fill('#su-name','Compiled owner');await page.fill('#su-email','owner@compiled-delete.test');await page.fill('#su-pw','synthetic-password-12345');await page.fill('#su-ws','Compiled workspace');
 await page.getByRole('button',{name:'Create owner account'}).click();
 await page.getByRole('navigation',{name:'Projects'}).waitFor();step('owner claimed and signed in');
 // Mirrors the ReplayPreview player document in src/components/SessionReplayPanel.tsx: a data: frame inherits the page policy, mints its own
 // nonce and must still execute /replay.js (which injects its <style>); a template change there must be mirrored here.
 await page.evaluate(()=>new Promise((done,fail)=>{const nonce=crypto.randomUUID().replaceAll('-',''),asset=new URL('/replay.js',window.location.href);
  const html=`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; worker-src 'none'; frame-src about:; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><div id="replay-root"></div><script nonce="${nonce}" data-ten98-replay="player" referrerpolicy="no-referrer" src="${asset.href}"></script>`;
  const frame=document.createElement('iframe');frame.title='csp replay probe';frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.referrerPolicy='no-referrer';frame.src='data:text/html;charset=utf-8,'+encodeURIComponent(html);frame.onload=()=>done();frame.onerror=()=>fail(new Error('replay probe frame failed to load'));document.body.appendChild(frame);}));
 const replayFrame=page.frames().find(f=>f.url().startsWith('data:'));assert.ok(replayFrame,'The replay probe frame must exist.');
 await replayFrame.waitForFunction(()=>document.head.querySelector('style')!==null,null,{timeout:10000});
 await page.evaluate(()=>document.querySelector('iframe[title="csp replay probe"]').remove());step('replay data: frame executed /replay.js under the inherited document policy');
 const workspaceId=await page.locator('#ws').inputValue();assert.match(workspaceId,/^[0-9a-f-]{36}$/);
 async function create(name,origin){await page.goto(base+'/?workspace='+workspaceId+'&view=new-project',{waitUntil:'domcontentloaded'});await page.fill('#pn',name);await page.fill('#po',origin);await page.getByRole('button',{name:'Create project'}).click();await page.getByRole('navigation',{name:'Projects'}).getByRole('link',{name,exact:true}).waitFor();}
 await create('Doomed website','https://doomed.compiled-delete.test');await create('Surviving website','https://surviving.compiled-delete.test');step('two projects created');
 const doomedHref=await page.getByRole('navigation',{name:'Projects'}).getByRole('link',{name:'Doomed website',exact:true}).getAttribute('href');const doomedId=new URLSearchParams(doomedHref.split('?')[1]).get('project');assert.match(doomedId,/^[0-9a-f-]{36}$/);
 await page.goto(base+'/?workspace='+workspaceId+'&project='+doomedId+'&view=collection',{waitUntil:'domcontentloaded'});
 await page.getByRole('heading',{name:'Collection and privacy',level:2}).waitFor();
 await page.getByRole('button',{name:'Delete website',exact:true}).click();await page.getByText('Doomed website',{exact:true}).first().waitFor();
 await page.getByRole('textbox',{name:'Type DELETE to confirm',exact:true}).fill('DELETE');await page.getByRole('button',{name:'Permanently delete website'}).click();step('deletion confirmed in the compiled settings view');
 await page.waitForURL(url=>{const p=new URL(url).searchParams;return p.get('workspace')===workspaceId&&p.get('view')==='project'&&p.get('project')===null;});step('router navigated to the workspace project view without a project parameter');
 const projects=page.getByRole('navigation',{name:'Projects'});await projects.getByRole('link',{name:'Surviving website',exact:true}).waitFor();
 await page.waitForFunction(()=>![...document.querySelectorAll('nav[aria-label="Projects"] a')].some(a=>a.textContent==='Doomed website'));step('selector entry removed while the surviving project remains');
 const settings=await page.evaluate(async id=>{const r=await fetch('/api/projects/'+id+'/analytics-settings',{credentials:'same-origin'});return r.status;},doomedId);assert.equal(settings,404);step('deleted project settings answer 404 for the signed-in owner');
 await page.reload({waitUntil:'domcontentloaded'});await projects.getByRole('link',{name:'Surviving website',exact:true}).waitFor();assert.equal(await projects.getByRole('link',{name:'Doomed website',exact:true}).count(),0);step('reloaded catalog omits the deleted project');
 await page.goto(base+'/?workspace='+workspaceId+'&project='+doomedId+'&view=project',{waitUntil:'domcontentloaded'});await page.getByText('That project is no longer available in this workspace. Choose a current project.',{exact:true}).waitFor();step('stale deep link reports the project as no longer available');
 await page.screenshot({path:resolve(out,'after-delete.png'),fullPage:true});
 assert.deepEqual(evidence.errors,[],'The compiled app must run without console errors or policy violations.');step('zero console errors and zero policy violations');evidence.phase='passed';
}catch(error){evidence.phase='failed';evidence.failure=String(error.stack||error);await page.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await writeFile(resolve(out,'evidence.json'),JSON.stringify(evidence,null,1));await browser.close();}
console.log(JSON.stringify({phase:evidence.phase,steps:evidence.steps.length,errors:evidence.errors,failure:evidence.failure??null}));if(evidence.phase!=='passed')process.exit(1);
