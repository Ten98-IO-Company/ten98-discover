// Actual shared stylesheet acceptance. Synthetic markup, no app/API/DB/provider.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
assert.equal(process.env.TEN98_DESIGN_SYSTEM_BROWSER,'1');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const styles=await readFile('src/styles.css','utf8'),tokens=await readFile('src/design-tokens.css','utf8'),analytics=await readFile('src/components/analytics.css','utf8'),campaign=await readFile('src/campaign-ui.css','utf8'),account=await readFile('src/components/account-settings.css','utf8');
const html=`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>Shared stylesheet check</title><main class="page-content"><section class="card"><h1>Shared controls</h1><p class="hint">Synthetic interface acceptance</p><div class="row"><button class="btn primary">Primary</button><button class="btn">Secondary</button><button class="btn danger">Danger</button><button class="btn primary" disabled>Disabled primary</button><button class="btn ghost" disabled>Disabled secondary</button></div><label for="text">Text</label><input id="text" placeholder="Example"><label for="inactive">Unavailable input</label><input id="inactive" disabled value="Example"><label for="choice">Choice</label><select id="choice"><option>Example</option></select><div class="notice">Information</div><div class="alert">Error</div><span class="pill good">Success</span><span class="preview-badge">Warning</span><nav class="section-nav" aria-label="Probe navigation"><details class="workspace-tools" open><summary class="nav-item selected">Analytics</summary><a class="nav-item selected" href="#text">Example link</a></details></nav><div class="table-wrap prompt-table" tabindex="0" role="region" aria-label="Example table"><table><thead><tr><th>Label</th><th>Value</th></tr></thead><tbody><tr><td>Retained example</td><td>1</td></tr></tbody></table></div></section></main></html>`;
const analyticsProbe='<link rel="stylesheet" href="/analytics.css"><section class="analytics" aria-label="Analytics preset probe"><fieldset class="analytics-fieldset" disabled><legend>Disabled analytics range</legend><div class="analytics-presets"><button class="btn analytics-preset active" id="disabled-preset" aria-pressed="true">Last 7 days</button></div></fieldset></section>';
const paths=new Map([['/',html.replace('</main>',analyticsProbe+'</main>')],['/styles.css',styles],['/design-tokens.css',tokens],['/analytics.css',analytics],['/campaign-ui.css',campaign],['/components/account-settings.css',account]]),outbound=[],errors=[];
const server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(req.method!=='GET'||!paths.has(path)){res.writeHead(path==='/favicon.ico'?204:404);return res.end();}res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/html');res.end(paths.get(path));});
let browser;
try{
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
 const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
 const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce',colorScheme:'dark',serviceWorkers:'block'});
 await context.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(req.method()==='GET'&&url.origin===origin)return route.continue();outbound.push(req.url());return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 const style=selector=>page.locator(selector).evaluate(e=>{const s=getComputedStyle(e);return{color:s.color,background:s.backgroundColor,border:s.borderTopColor,opacity:s.opacity,outline:s.outlineWidth,offset:s.outlineOffset,height:e.getBoundingClientRect().height,font:parseFloat(s.fontSize),transition:s.transitionDuration};});
 const ratio=(a,b)=>{const luminance=s=>s.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 const measurements={};
 assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'light','Production stays light even on a dark OS');
 for(const selector of ['.btn.primary:not(:disabled)','.btn:not(.primary):not(.danger):not(:disabled)','#text','#choice','.btn.danger','.notice','.alert','.pill.good','.preview-badge']){const s=await style(selector);measurements[selector]=ratio(s.color,s.background);assert.ok(measurements[selector]>=4.5,selector+' contrast');}
 for(const selector of ['.btn.primary:not(:disabled)','.btn:not(.primary):not(.danger):not(:disabled)']){await page.locator(selector).hover();await page.mouse.down();const s=await style(selector);assert.ok(ratio(s.color,s.background)>=4.5,selector+' pressed contrast');if(selector==='.btn.primary:not(:disabled)')assert.equal(s.background,'rgb(61, 43, 156)');await page.mouse.up();}
 for(const selector of ['.btn.primary:disabled','.btn.ghost:disabled','#inactive']){await page.locator(selector).hover();const s=await style(selector);assert.equal(s.opacity,'1');assert.equal(s.background,'rgb(245, 244, 250)');assert.equal(s.color,'rgb(104, 117, 138)');assert.ok(ratio(s.color,s.background)>=3);}
 assert.equal(await page.locator('#disabled-preset').isDisabled(),true);
 for(const hover of [false,true]){if(hover)await page.locator('#disabled-preset').hover();const s=await style('#disabled-preset');assert.equal(s.opacity,'1');assert.equal(s.background,'rgb(245, 244, 250)');assert.equal(s.color,'rgb(104, 117, 138)');assert.equal(s.border,'rgb(135, 147, 165)');measurements['analytics disabled preset'+(hover?' hover':'')]=ratio(s.color,s.background);assert.ok(ratio(s.color,s.background)>=3);}
 const input=await style('#text');assert.ok(ratio(input.border,input.background)>=3);const placeholder=await page.locator('#text').evaluate(e=>getComputedStyle(e,'::placeholder').color);assert.ok(ratio(placeholder,input.background)>=4.5);
 assert.equal((await style('summary')).color,'rgb(89, 67, 206)');
 assert.equal((await style('.btn.primary:not(:disabled)')).transition,'0s');
 console.log('PASS actual shared styles: light rollout, text/borders/placeholders, primary pressed and disabled precedence.');
 await page.keyboard.press('Tab');
 for(const selector of ['#text','.prompt-table']){await page.locator(selector).focus();const s=await style(selector);assert.equal(s.outline,'3px',selector+' keyboard outline');assert.equal(s.offset,'2px',selector+' keyboard outline offset');}
 await page.emulateMedia({forcedColors:'active'});await page.locator('#text').focus();assert.equal((await style('#text')).outline,'3px');assert.equal(await page.locator('#text').evaluate(e=>getComputedStyle(e).forcedColorAdjust),'auto');await page.emulateMedia({forcedColors:'none'});
 for(const width of [1440,360,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,width+' no page overflow');if(width<400)for(const selector of ['.btn.primary:not(:disabled)','#text','#choice','summary'])assert.ok((await style(selector)).height>=44,selector+' touch target');for(const selector of ['.hint','th:first-child','.preview-badge'])assert.ok((await style(selector)).font>=12);}
 console.log('PASS actual shared styles: keyboard focus, forced colors, reduced motion and320/360/1440 geometry.');
 for(const mode of ['dark','system']){
  await page.emulateMedia({colorScheme:'dark'});await page.evaluate(mode=>document.documentElement.dataset.theme=mode,mode);
  for(const selector of ['.btn:not(.primary):not(.danger):not(:disabled)','#text','#choice','.btn.danger','.notice','.alert','.pill.good','.preview-badge','td:first-child']){
   const pair=await page.locator(selector).evaluate(e=>{const text=getComputedStyle(e).color;let surface='rgba(0, 0, 0, 0)';for(let node=e;node&&surface==='rgba(0, 0, 0, 0)';node=node.parentElement)surface=getComputedStyle(node).backgroundColor;return{text,surface};});
   assert.ok(ratio(pair.text,pair.surface)>=4.5,mode+' '+selector+' readable text');
  }
 }
 console.log('PASS actual shared styles: neutral controls, tables, feedback and status text in dark/System-dark themes.');
 await page.evaluate(()=>{const group=document.createElement('div');group.className='keyword-tabs';group.innerHTML='<button class="btn primary" aria-pressed="true">Research</button><button class="btn ghost">Saved keywords</button>';document.querySelector('main').append(group);});
 assert.equal(await page.locator('.keyword-tabs .primary').evaluate(e=>getComputedStyle(e).borderBottomWidth),'2px');
 assert.equal(await page.locator('.keyword-tabs .primary').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
 console.log('PASS common keyword section controls reuse Campaign underline tabs.');
 assert.deepEqual(outbound,[]);assert.deepEqual(errors,[]);await mkdir('private/design-system-evidence',{recursive:true});await writeFile('private/design-system-evidence/contrast.json',JSON.stringify(measurements,null,2));
}finally{await browser?.close();await new Promise(done=>server.close(done));}
