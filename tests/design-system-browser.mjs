// Actual shared stylesheet acceptance. Synthetic markup, no app/API/DB/provider.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {readCssSource} from './css-source.mjs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AppField} from '@ten98/ui/app';
import {AppTopbar} from '@ten98/ui';
import {launchChromium} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_DESIGN_SYSTEM_BROWSER,'1');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const [styles,tokens,analytics,campaign,account]=await Promise.all(['src/styles.css','src/design-tokens.css','src/components/analytics.css','src/campaign-ui.css','src/components/account-settings.css'].map(file=>readCssSource(file)));
const html=`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>Shared stylesheet check</title><main class="page-content"><section class="card"><h1>Shared controls</h1><p class="hint">Synthetic interface acceptance</p><div class="row"><button class="btn primary">Primary</button><button class="btn">Secondary</button><button class="btn danger">Danger</button><button class="btn primary" disabled>Disabled primary</button><button class="btn ghost" disabled>Disabled secondary</button></div><label for="text">Text</label><input id="text" placeholder="Example"><label for="inactive">Unavailable input</label><input id="inactive" disabled value="Example"><label for="choice">Choice</label><select id="choice"><option>Example</option></select><div class="notice">Information</div><div class="alert">Error</div><span class="pill good">Success</span><nav class="section-nav" aria-label="Probe navigation"><details class="workspace-tools" open><summary class="nav-item selected">Analytics</summary><a class="nav-item selected" href="#text">Example link</a></details></nav><div class="table-wrap prompt-table" tabindex="0" role="region" aria-label="Example table"><table><thead><tr><th>Label</th><th>Value</th></tr></thead><tbody><tr><td>Retained example</td><td>1</td></tr></tbody></table></div></section></main></html>`;
const analyticsProbe='<link rel="stylesheet" href="/analytics.css"><section class="analytics" aria-label="Analytics preset probe"><fieldset class="analytics-fieldset" disabled><legend>Disabled analytics range</legend><div class="analytics-presets"><button class="btn analytics-preset active" id="disabled-preset" aria-pressed="true">Last 7 days</button></div></fieldset></section>';
const headerProbe='<header class="t98-shell-header t98-shell-header--topbar">'+renderToStaticMarkup(createElement(AppTopbar,{wrap:true,breadcrumb:{icon:'folder',scope:'Discover',current:'Measure'},actions:createElement('span',{className:'t98-probe-actions'})}))+'</header>';
const sharedFieldProbe=renderToStaticMarkup(createElement(AppField,{label:'Shared disabled field',id:'shared-inactive',disabled:true,defaultValue:'Confirmed value'}));
const retainedText='Saved <b>literal</b>\nRetained context';
const sharedTextareaProbe=renderToStaticMarkup(createElement(AppField,{label:'Shared retained text',id:'shared-textarea',multiline:true,value:retainedText,readOnly:true,rows:3,'aria-describedby':'shared-textarea-context'}))+'<p id="shared-textarea-context">Retained text supplied by the application.</p>';
const paths=new Map([['/',html.replace('<main',headerProbe+'<main').replace('Example link</a>','Example link<span class="nav-count" aria-hidden="true">3</span></a>').replace('</section>',sharedFieldProbe+sharedTextareaProbe+'</section>').replace('</main>',analyticsProbe+'</main>')],['/styles.css',styles],['/design-tokens.css',tokens],['/analytics.css',analytics],['/campaign-ui.css',campaign],['/components/account-settings.css',account]]),outbound=[],errors=[];
const server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(req.method!=='GET'||!paths.has(path)){res.writeHead(path==='/favicon.ico'?204:404);return res.end();}res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/html');res.end(paths.get(path));});
let browser;
try{
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
 browser=await launchChromium();
 const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce',colorScheme:'dark',serviceWorkers:'block'});
 await context.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(req.method()==='GET'&&url.origin===origin)return route.continue();outbound.push(req.url());return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 const retained=page.locator('#shared-textarea');assert.equal(await retained.inputValue(),retainedText);assert.deepEqual(await retained.evaluate(node=>({tag:node.tagName,id:node.id,label:node.labels[0]?.querySelector('span')?.textContent,readOnly:node.readOnly,rows:node.rows,description:node.getAttribute('aria-describedby')})),{tag:'TEXTAREA',id:'shared-textarea',label:'Shared retained text',readOnly:true,rows:3,description:'shared-textarea-context'});assert.equal(await retained.locator('b').count(),0);console.log('PASS actual shared multiline SSR preserves supplied value, readonly state, native identity, rows and accessible description.');
 const style=selector=>page.locator(selector).evaluate(e=>{const s=getComputedStyle(e);return{color:s.color,background:s.backgroundColor,border:s.borderTopColor,opacity:s.opacity,outline:s.outlineWidth,offset:s.outlineOffset,height:e.getBoundingClientRect().height,font:parseFloat(s.fontSize),transition:s.transitionDuration};});
 const ratio=(a,b)=>{const luminance=s=>s.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 const measurements={};
 const nativeSurfaces=async name=>{
  const value=await page.evaluate(()=>{
   const read=selector=>{const node=document.querySelector(selector),s=getComputedStyle(node);return{color:s.color,background:s.backgroundColor,height:node.getBoundingClientRect().height};};
   const token=role=>{const probe=document.createElement('span');probe.style.backgroundColor=`var(--color-${role})`;document.body.append(probe);const color=getComputedStyle(probe).backgroundColor;probe.remove();return color;};
   return{header:read('.t98-shell-header'),heading:read('.t98-app-topbar__current'),field:read('#shared-inactive'),surface:token('surface'),disabledSurface:token('disabled-surface')};
  });
  // Discover retains its existing solid topbar override; the shared field must inherit disabled roles.
  assert.equal(value.header.background,value.surface,name+' native header surface');
  assert.equal(value.field.background,value.disabledSurface,name+' shared disabled field surface');
  assert.ok(value.header.height>=44,name+' native header geometry');
  assert.ok(ratio(value.heading.color,value.header.background)>=4.5,name+' header text contrast');
  assert.ok(ratio(value.field.color,value.field.background)>=3,name+' disabled field contrast');
  assert.equal(await page.locator('#shared-inactive').isDisabled(),true);
  assert.equal(await page.locator('#shared-inactive').inputValue(),'Confirmed value');
  measurements['native surfaces '+name]=value;
 };
 await nativeSurfaces('default-light-dark-OS');
 assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'light','Production stays light even on a dark OS');
 for(const selector of ['.btn.primary:not(:disabled)','.btn:not(.primary):not(.danger):not(:disabled)','#text','#choice','.btn.danger','.notice','.alert','.pill.good']){const s=await style(selector);measurements[selector]=ratio(s.color,s.background);assert.ok(measurements[selector]>=4.5,selector+' contrast');}
 for(const selector of ['.btn.primary:not(:disabled)','.btn:not(.primary):not(.danger):not(:disabled)']){await page.locator(selector).hover();await page.mouse.down();const s=await style(selector);assert.ok(ratio(s.color,s.background)>=4.5,selector+' pressed contrast');if(selector==='.btn.primary:not(:disabled)')assert.equal(s.background,'rgb(61, 43, 156)');await page.mouse.up();}
 for(const selector of ['.btn.primary:disabled','.btn.ghost:disabled','#inactive']){await page.locator(selector).hover();const s=await style(selector);assert.equal(s.opacity,'1');assert.equal(s.background,'rgb(242, 243, 245)');assert.equal(s.color,'rgb(96, 100, 108)');assert.ok(ratio(s.color,s.background)>=3);}
 assert.equal(await page.locator('#disabled-preset').isDisabled(),true);
 for(const hover of [false,true]){if(hover)await page.locator('#disabled-preset').hover();const s=await style('#disabled-preset');assert.equal(s.opacity,'1');assert.equal(s.background,'rgb(242, 243, 245)');assert.equal(s.color,'rgb(96, 100, 108)');assert.equal(s.border,'rgb(139, 141, 152)');measurements['analytics disabled preset'+(hover?' hover':'')]=ratio(s.color,s.background);assert.ok(ratio(s.color,s.background)>=3);}
 const input=await style('#text');assert.ok(ratio(input.border,input.background)>=3);const placeholder=await page.locator('#text').evaluate(e=>getComputedStyle(e,'::placeholder').color);assert.ok(ratio(placeholder,input.background)>=4.5);
 assert.equal((await style('summary')).color,'rgb(28, 29, 33)');
 assert.equal((await style('.btn.primary:not(:disabled)')).transition,'0s');
 console.log('PASS actual shared styles: light rollout, text/borders/placeholders, primary pressed and disabled precedence.');
 await page.keyboard.press('Tab');
 for(const selector of ['#text','.prompt-table']){await page.locator(selector).focus();const s=await style(selector);assert.equal(s.outline,'3px',selector+' keyboard outline');assert.equal(s.offset,'2px',selector+' keyboard outline offset');}
 await page.emulateMedia({forcedColors:'active'});await page.locator('#text').focus();assert.equal((await style('#text')).outline,'3px');assert.equal(await page.locator('#text').evaluate(e=>getComputedStyle(e).forcedColorAdjust),'auto');await page.emulateMedia({forcedColors:'none'});
 for(const width of [1440,360,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,width+' no page overflow');if(width<400)for(const selector of ['.btn.primary:not(:disabled)','#text','#choice','summary'])assert.ok((await style(selector)).height>=44,selector+' touch target');for(const selector of ['.hint','th:first-child'])assert.ok((await style(selector)).font>=12);}
 console.log('PASS actual shared styles: keyboard focus, forced colors, reduced motion and320/360/1440 geometry.');
 for(const mode of ['dark','system']){
  await page.emulateMedia({colorScheme:'dark'});await page.evaluate(mode=>document.documentElement.dataset.theme=mode,mode);
  await nativeSurfaces(mode+'-dark-OS');
  for(const selector of ['.btn:not(.primary):not(.danger):not(:disabled)','#text','#choice','.btn.danger','.notice','.alert','.pill.good','td:first-child','summary.nav-item.selected','a.nav-item.selected','.nav-count']){
   const pair=await page.locator(selector).evaluate(e=>{const text=getComputedStyle(e).color;let surface='rgba(0, 0, 0, 0)';for(let node=e;node&&surface==='rgba(0, 0, 0, 0)';node=node.parentElement)surface=getComputedStyle(node).backgroundColor;return{text,surface};});
   assert.ok(ratio(pair.text,pair.surface)>=4.5,mode+' '+selector+' readable text');
  }
  for(const selector of ['.btn.primary:not(:disabled)','.btn:not(.primary):not(.danger):not(:disabled)','.btn.danger','a.nav-item.selected']){await page.locator(selector).hover();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));const value=await style(selector);assert.ok(ratio(value.color,value.background)>=4.5,mode+' '+selector+' hover contrast');}
 }
 await page.emulateMedia({colorScheme:'light'});
 for(const mode of ['dark','system','light']){await page.evaluate(mode=>document.documentElement.dataset.theme=mode,mode);await nativeSurfaces(mode+'-light-OS');}
 console.log('PASS actual shared styles: neutral controls, tables, feedback and status text in dark/System-dark themes.');
 console.log('PASS native header and shared disabled field preserve semantic surfaces, contrast and values across explicit/System themes.');
 await page.evaluate(()=>{const group=document.createElement('div');group.className='keyword-tabs';group.innerHTML='<button class="btn primary" aria-pressed="true">Research</button><button class="btn ghost">Saved keywords</button>';document.querySelector('main').append(group);});
 assert.equal(await page.locator('.keyword-tabs .primary').evaluate(e=>getComputedStyle(e).borderBottomWidth),'2px');
 assert.equal(await page.locator('.keyword-tabs .primary').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
 console.log('PASS common keyword section controls reuse Campaign underline tabs.');
 await page.evaluate(()=>{const button=document.createElement('button');button.type='button';button.className='avatar';button.setAttribute('aria-label','Example account menu');button.textContent='MS';window.headerClicks=0;button.onclick=()=>window.headerClicks++;document.querySelector('.t98-app-topbar__actions').append(button);});
 const headerCases=[];
 // @ten98/ui wrap mode stacks the breadcrumb on its own full-width row on narrow screens, so 320px has two rows.
 for(const [width,normalHeight]of [[1440,69],[900,69],[320,91]]){
  await page.setViewportSize({width,height:900});assert.equal(await page.locator('.t98-shell-header').evaluate(node=>node.getBoundingClientRect().height),normalHeight,'Preserve normal header height');
  const doubled=await page.evaluate(()=>{const header=document.querySelector('.t98-shell-header'),crumb=document.querySelector('.t98-app-topbar__breadcrumb');window.headerText=[crumb.querySelector('.t98-app-topbar__scope').textContent,crumb.querySelector('.t98-app-topbar__current').textContent];window.headerScopeTitle=crumb.querySelector('.t98-app-topbar__scope').title;const scopeNode=crumb.querySelector('.t98-app-topbar__scope');scopeNode.textContent='Discover workspace with a complete retained observation context';scopeNode.title=scopeNode.textContent;crumb.querySelector('.t98-app-topbar__current').textContent='Research / Saved keyword report with a very long project and website scope';const nodes=[header,...header.querySelectorAll('*')].filter(node=>node instanceof HTMLElement&&node.getClientRects().length);window.headerFonts=nodes.map(node=>({node,font:parseFloat(getComputedStyle(node).fontSize),value:node.style.getPropertyValue('font-size'),priority:node.style.getPropertyPriority('font-size')}));for(const entry of window.headerFonts)entry.node.style.setProperty('font-size',entry.font*2+'px','important');return window.headerFonts.map(entry=>({before:entry.font,after:parseFloat(getComputedStyle(entry.node).fontSize)}));});
  assert.ok(doubled.length>=7);assert.ok(doubled.every(entry=>Math.abs(entry.after-entry.before*2)<0.1));await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const geometry=await page.evaluate(()=>{const header=document.querySelector('.t98-shell-header'),crumb=document.querySelector('.t98-app-topbar__breadcrumb'),avatar=header.querySelector('.avatar'),r=avatar.getBoundingClientRect();return{viewport:innerWidth,page:document.documentElement.scrollWidth,height:header.getBoundingClientRect().height,headerWidth:header.scrollWidth,headerClient:header.clientWidth,crumbWidth:crumb.scrollWidth,crumbClient:crumb.clientWidth,avatar:{left:r.left,right:r.right,width:r.width,height:r.height},labels:[...crumb.querySelectorAll('.t98-app-topbar__scope,.t98-app-topbar__current')].map(node=>{const s=getComputedStyle(node),lineHeight=parseFloat(s.lineHeight)||parseFloat(s.fontSize)*1.2;return{scope:node.classList.contains('t98-app-topbar__scope'),text:node.textContent,title:node.title,whiteSpace:s.whiteSpace,overflow:s.overflowX,rects:node.getClientRects().length,lines:Math.round(node.getBoundingClientRect().height/lineHeight)};})};});
  assert.ok(geometry.page<=width);assert.ok(geometry.headerWidth<=geometry.headerClient+1);assert.ok(geometry.crumbWidth<=geometry.crumbClient+1);assert.ok(geometry.avatar.left>=0&&geometry.avatar.right<=width);assert.ok(geometry.labels.every(label=>label.rects>0&&label.whiteSpace!=='nowrap'&&(label.scope?label.title===label.text&&label.lines<=2:label.overflow!=='hidden')));assert.equal(geometry.labels[0].text,'Discover workspace with a complete retained observation context');assert.equal(geometry.labels[1].text,'Research / Saved keyword report with a very long project and website scope');if(width===320)assert.ok(geometry.height>normalHeight,'Narrow doubled text expands the header');
  await page.getByRole('button',{name:'Example account menu',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.headerClicks),headerCases.length+1);headerCases.push({width,normalHeight,doubled,geometry});await page.evaluate(()=>{for(const entry of window.headerFonts)entry.node.style.setProperty('font-size',entry.value,entry.priority);const crumb=document.querySelector('.t98-app-topbar__breadcrumb');{const scopeNode=crumb.querySelector('.t98-app-topbar__scope');scopeNode.textContent=window.headerText[0];scopeNode.title=window.headerScopeTitle;}crumb.querySelector('.t98-app-topbar__current').textContent=window.headerText[1];});
 }
 measurements.headerCases=headerCases;console.log('PASS native header keeps69/69/91px minima and complete320/900/1440 doubled-font context with a contained keyboard-operable account control.');
 assert.deepEqual(outbound,[]);assert.deepEqual(errors,[]);await mkdir('private/design-system-evidence',{recursive:true});await writeFile('private/design-system-evidence/contrast.json',JSON.stringify(measurements,null,2));
}finally{await browser?.close();await new Promise(done=>server.close(done));}
