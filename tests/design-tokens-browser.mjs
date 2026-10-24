// Token-only real-browser probe. No standalone dashboard, app integration, DB or providers.
// Requires Node24 and an explicitly supplied installed Playwright module; installs nothing.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readCssSource} from './css-source.mjs';
import {launchChromium} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_DESIGN_TOKENS_BROWSER,'1','Explicit token-probe opt-in required');
assert.ok(process.env.PLAYWRIGHT_MODULE,'Supply an installed Playwright entry point');
const evidence=resolve('private/design-token-evidence');
const css=await readCssSource('src/design-tokens.css');
// @ten98/ui bundles Inter beside its token CSS. The only URLs allowed are same-package relative font files, and the
// probe serves exactly those from the installed package, so no font request can leave the fixture origin.
const localFont=/^\.\/fonts\/[\w.-]+\.woff2$/;
const cssUrls=[...css.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi)].map(match=>match[2]);
const fontFiles=await Promise.all(cssUrls.filter(url=>localFont.test(url)).map(async url=>[url.slice(1),{type:'font/woff2',body:await readFile(new URL(url,import.meta.resolve('@ten98/ui/app-tokens.css')))}]));
const colors={
 canvas:['#F8F9FC','#10161F'],surface:['#FFFFFF','#17202C'],'surface-subtle':['#F5F4FA','#1D2938'],'surface-raised':['#FFFFFF','#223044'],text:['#252435','#EAF0F8'],'text-muted':['#696374','#ADB9CA'],'text-placeholder':['#68758A','#A0ADBF'],border:['#EAEAF1','#344258'],'border-control':['#8793A5','#788BA6'],accent:['#5943CE','#C2B6FF'],'accent-hover':['#4731B6','#D3CAFF'],'accent-active':['#3D2B9C','#E3DDFF'],'on-accent':['#FFFFFF','#2C2056'],'accent-subtle':['#EFECFC','#352A54'],success:['#176B49','#80D8AE'],'success-subtle':['#EAF5EF','#173C2D'],warning:['#825208','#F3CC78'],'warning-subtle':['#FFF5DC','#3E321B'],danger:['#B42318','#FFA399'],'danger-subtle':['#FEEDEB','#492A2A'],info:['#245AA8','#99C2FF'],'info-subtle':['#EDF4FF','#223751'],'disabled-text':['#696374','#A0ADBF'],'disabled-surface':['#F5F4FA','#1D2938'],focus:['#5943CE','#C2B6FF'],'chart-1':['#5943CE','#C2B6FF'],'chart-2':['#14796F','#71CFC3'],'chart-3':['#926008','#E5BE73'],'chart-4':['#9A417F','#E7A0CC'],'chart-5':['#59687C','#B0BDD1'],overlay:['rgb(16 22 31 / 40%)','rgb(0 0 0 / 60%)'],
};
const fixed={
 'font-sans':'"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif','font-heading':'"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif','font-mono':'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
 'text-xs':'0.75rem','text-sm':'0.8125rem','text-md':'0.875rem','text-lg':'1rem','text-xl':'1.25rem','text-2xl':'1.5rem','text-metric':'1.75rem','leading-tight':'1.25','leading-normal':'1.5','leading-relaxed':'1.65','weight-normal':'400','weight-medium':'500','weight-semibold':'600','weight-bold':'700',
 'space-0':'0','space-1':'0.25rem','space-2':'0.5rem','space-3':'0.75rem','space-4':'1rem','space-5':'1.25rem','space-6':'1.5rem','space-8':'2rem','space-10':'2.5rem','space-12':'3rem','radius-sm':'0.25rem','radius-md':'0.5625rem','radius-lg':'0.75rem','radius-pill':'999px','border-width':'1px','focus-width':'3px','focus-offset':'2px',
 'sidebar-width':'14.5rem','topbar-height':'4.3125rem','content-max':'90rem','form-max':'42rem','auth-max':'28rem','reading-max':'70ch','control-sm':'2.25rem','control-md':'2.5rem','control-touch':'2.75rem','icon-sm':'1rem','icon-md':'1.25rem','z-sticky':'10','z-popover':'20','z-dialog':'30','shadow-panel':'none','shadow-popover':'0 4px 16px rgb(16 22 31 / 12%)','shadow-dialog':'0 12px 40px rgb(16 22 31 / 20%)','motion-fast':'120ms','motion-normal':'180ms','ease-standard':'cubic-bezier(0.2, 0, 0, 1)',
};
// These styles merely exercise semantic tokens; they are not a proposed product stylesheet.
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Token test probe</title><link rel="stylesheet" href="/tokens.css"><style>
body{background:var(--color-canvas);color:var(--color-text);font:var(--text-md)/var(--leading-normal) var(--font-sans)}
main{background:var(--color-surface);padding:var(--space-4)}p{padding:var(--space-2)}.muted{color:var(--color-text-muted)}.muted-tint{color:var(--color-text-muted);background:var(--color-accent-subtle)}
button,input{font:inherit;min-height:var(--control-md);padding-inline:var(--space-3);border:var(--border-width) solid var(--color-border-control);border-radius:var(--radius-sm);background:var(--color-surface);color:var(--color-text);transition:color var(--motion-fast) var(--ease-standard),background-color var(--motion-fast) var(--ease-standard)}
::placeholder{color:var(--color-text-placeholder);opacity:1}.primary{background:var(--color-accent);color:var(--color-on-accent);border-color:var(--color-accent)}.primary:hover{background:var(--color-accent-hover);border-color:var(--color-accent-hover)}.primary:active{background:var(--color-accent-active);border-color:var(--color-accent-active)}
:disabled{background:var(--color-disabled-surface);color:var(--color-disabled-text);opacity:1}
:focus-visible{outline:var(--focus-width) solid var(--color-focus);outline-offset:var(--focus-offset)}
@media(forced-colors:active){:focus-visible{outline-color:CanvasText}}
@media(prefers-reduced-motion:reduce){button,input{transition:none;animation:none}}
</style><main><p>Token test probe — synthetic, no application or live services</p><p class="muted">Supporting text</p><p class="muted-tint">Supporting text on the accent tint</p><button type="button" class="primary">Primary</button><button type="button">Secondary</button><button type="button" disabled>Disabled example</button><label>Example input <input placeholder="Example only"></label>
${['success','warning','danger','info'].map(t=>`<p data-tone="${t}" style="color:var(--color-${t});background:var(--color-${t}-subtle)">${t} text</p>`).join('')}
</main></html>`;
const paths=new Map([['/probe',{type:'text/html; charset=utf-8',body:html}],['/tokens.css',{type:'text/css; charset=utf-8',body:css}],...fontFiles]),requests=[],external=[],errors=[],failures=[],passed=[];
const server=createServer((request,response)=>{const path=new URL(request.url,'http://localhost').pathname;requests.push({path,method:request.method});if(request.method!=='GET'||!paths.has(path)){response.writeHead(path==='/favicon.ico'?204:404);return response.end();}const file=paths.get(path);response.writeHead(200,{'content-type':file.type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"});response.end(file.body);});
let browser,page;
try{
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await launchChromium();
 const context=await browser.newContext({viewport:{width:800,height:700},serviceWorkers:'block',colorScheme:'light',reducedMotion:'reduce'});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===origin&&route.request().method()==='GET'&&(paths.has(u.pathname)||u.pathname==='/favicon.ico'))return route.continue();external.push(route.request().method()+' '+u.href);return route.abort();});
 page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});await mkdir(evidence,{recursive:true});
 const theme=mode=>page.evaluate(mode=>{if(mode==='absent')document.documentElement.removeAttribute('data-theme');else document.documentElement.dataset.theme=mode;},mode);
 const group=async(name,check)=>{await page.emulateMedia({colorScheme:'light',forcedColors:'none',reducedMotion:'reduce'});await page.goto(origin+'/probe');try{await check();passed.push(name);console.log('PASS '+name);}catch(error){failures.push({name,error:error?.stack??String(error)});console.error('FAIL '+name+': '+error.message);await page.screenshot({path:resolve(evidence,`failure-${failures.length}.png`)}).catch(()=>{});}};
 const values=selector=>page.evaluate(({selector,colors,fixed})=>{const element=document.querySelector(selector),computed=getComputedStyle(element),probe=document.createElement('span');element.append(probe);const normalized={};for(const[name,pair]of Object.entries(colors)){probe.style.color='var(--color-'+name+')';const actual=getComputedStyle(probe).color;normalized[name]={actual,expected:pair.map(color=>{probe.style.color=color;return getComputedStyle(probe).color;})};}probe.remove();return{colors:normalized,fixed:Object.fromEntries(Object.keys(fixed).map(name=>[name,computed.getPropertyValue('--'+name).trim().replace(/[\s"']/g,'')])),scheme:computed.colorScheme};},{selector,colors,fixed});
 const compare=(result,dark,label)=>{for(const[name,value]of Object.entries(result.colors))assert.equal(value.actual,value.expected[dark?1:0],label+' '+name);for(const[name,value]of Object.entries(fixed))assert.equal(result.fixed[name],value.replace(/[\s"']/g,''),label+' '+name);assert.equal(result.scheme,dark?'dark':'light',label+' color-scheme');};
 await group('exact variables and all root/nested theme contexts',async()=>{
  const declarations=await page.evaluate(()=>{
   const sheet=[...document.styleSheets].find(s=>s.href?.endsWith('/tokens.css')),properties=new Set(),canonical=new Set(),bad=[];
   function inspect(rules){for(const rule of rules){
    if(rule instanceof CSSMediaRule){inspect(rule.cssRules);}
    else if(rule instanceof CSSStyleRule){
     const legacy=[...rule.style].some(property=>!property.startsWith('--t98-')&&property!=='color-scheme');
     const scope=legacy?/^:root$|^\.t98-theme$|^\[data-theme\]$|^(?::root|html)?\[data-theme=["']?(light|dark|system)["']?\]$/:/^:root$|^\.t98-theme$|^\[data-density=["']?(comfortable|compact)["']?\]$|^(?::root|html)?\[data-theme=["']?(light|dark|system)["']?\]$/;
     for(const selector of rule.selectorText.split(',').map(s=>s.trim()))if(!scope.test(selector))bad.push(selector);
     for(const property of rule.style){(property.startsWith('--t98-')?canonical:properties).add(property);if(!property.startsWith('--')&&property!=='color-scheme')bad.push(property);}
    }else if(rule instanceof CSSFontFaceRule){
     // Bundled font faces may load only same-package relative files; any other source is not token CSS.
     const sources=[...rule.style.getPropertyValue('src').matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g)].map(match=>match[2]);
     if(!sources.length||!sources.every(url=>/^\.\/fonts\/[\w.-]+\.woff2$/.test(url)))bad.push(rule.cssText.slice(0,100));
    }else bad.push(rule.cssText.slice(0,100));
   }}
   inspect(sheet.cssRules);return{properties:[...properties].sort(),canonical:[...canonical].sort(),bad};
  });
  assert.ok(declarations.canonical.includes('--t98-accent'),'The package canonical tokens are loaded');
  assert.deepEqual(declarations.bad,[],'Token file declares only variables/theme scopes');assert.deepEqual(declarations.properties,[...Object.keys(colors).map(k=>'--color-'+k),...Object.keys(fixed).map(k=>'--'+k),'color-scheme'].sort());
  for(const os of ['light','dark']){await page.emulateMedia({colorScheme:os});for(const mode of ['absent','light','dark','system']){await theme(mode);compare(await values('html'),mode==='dark'||mode==='system'&&os==='dark',os+'/'+mode);}
   await theme(os==='dark'?'light':'dark');for(const mode of ['light','dark','system']){await page.evaluate(mode=>{document.getElementById('nested')?.remove();const nested=document.createElement('section');nested.id='nested';nested.dataset.theme=mode;document.body.append(nested);},mode);compare(await values('#nested'),mode==='dark'||mode==='system'&&os==='dark',os+'/nested/'+mode);}}
 });
 const ratio=(a,b)=>{const lum=s=>{const rgb=s.match(/^rgba?\(([^)]+)\)$/);assert.ok(rgb,'Browser normalized RGB');const channels=rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);assert.ok(channels.length===3||channels[3]===1,'Measured opaque pair');return channels.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);},x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 const sample=(selector,pseudo=null)=>page.locator(selector).evaluate((element,pseudo)=>{const style=getComputedStyle(element,pseudo);let color=style.backgroundColor;for(let ancestor=element;ancestor&&color==='rgba(0, 0, 0, 0)';ancestor=ancestor.parentElement)color=getComputedStyle(ancestor).backgroundColor;return{color:style.color,background:color,border:style.borderTopColor,opacity:style.opacity};},pseudo);
 await group('browser-computed text, control, semantic and chart contrast',async()=>{
  const measured={};for(const mode of ['light','dark']){await theme(mode);const results={};for(const selector of ['main','.muted','.muted-tint','.primary','button:not([class]):not(:disabled)','input',...['success','warning','danger','info'].map(t=>'[data-tone='+t+']')]){const s=await sample(selector);results[selector]=ratio(s.color,s.background);assert.ok(results[selector]>=4.5,mode+' '+selector+' text contrast '+results[selector]);}
   const input=await sample('input'),placeholder=await sample('input','::placeholder'),disabled=await sample(':disabled');results.controlBorder=ratio(input.border,input.background);results.placeholder=ratio(placeholder.color,input.background);results.disabled=ratio(disabled.color,disabled.background);assert.ok(results.controlBorder>=3);assert.ok(results.placeholder>=4.5);assert.equal(disabled.opacity,'1');assert.ok(results.disabled>=3,'Disabled text remains readable; disabled controls are WCAG contrast-exempt');
   for(const state of ['hover','active']){await page.locator('.primary').hover();if(state==='active')await page.mouse.down();const s=await sample('.primary');assert.ok(ratio(s.color,s.background)>=4.5,mode+' '+state);if(state==='active')await page.mouse.up();}await page.mouse.move(790,690);
   results.charts=await page.evaluate(()=>{const probe=document.createElement('span');document.querySelector('main').append(probe);const colors=[];for(let n=1;n<=5;n++){probe.style.color='var(--color-chart-'+n+')';colors.push(getComputedStyle(probe).color);}probe.remove();return colors;});for(const c of results.charts)assert.ok(ratio(c,input.background)>=3,'Chart series against surface');measured[mode]=results;await page.screenshot({path:resolve(evidence,`token-probe-${mode}.png`)});}
  await writeFile(resolve(evidence,'contrast.json'),JSON.stringify(measured,null,2));
 });
 await group('focus-token rendering and forced-colors/reduced-motion compatibility probe',async()=>{
  for(const mode of ['light','dark']){await theme(mode);await page.locator('input').focus();await page.keyboard.press('Shift+Tab');const focus=await page.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e);return{width:s.outlineWidth,offset:s.outlineOffset,style:s.outlineStyle,color:s.outlineColor,background:getComputedStyle(e.parentElement).backgroundColor};});assert.equal(focus.width,'2px');assert.equal(focus.offset,'2px');assert.notEqual(focus.style,'none');assert.ok(ratio(focus.color,focus.background)>=3);}
  await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});assert.equal(await page.evaluate(()=>matchMedia('(forced-colors: active)').matches),true);await page.locator('input').focus();await page.keyboard.press('Shift+Tab');const forced=await page.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e);return{width:s.outlineWidth,style:s.outlineStyle,adjust:s.forcedColorAdjust,color:s.outlineColor,background:getComputedStyle(e.parentElement).backgroundColor};});assert.equal(forced.width,'2px');assert.notEqual(forced.style,'none');assert.notEqual(forced.adjust,'none');assert.ok(ratio(forced.color,forced.background)>=3);
  await page.emulateMedia({forcedColors:'none',reducedMotion:'no-preference'});assert.equal(await page.locator('input').evaluate(e=>getComputedStyle(e).transitionDuration),'0.12s, 0.12s');await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('input').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');await page.screenshot({path:resolve(evidence,'token-probe-accessibility.png')});
 });
 await group('isolated CSS-only source and zero application/remote requests',async()=>{assert.doesNotMatch(css,/@import/i);assert.doesNotMatch(css.replace(/@font-face\s*\{[^}]*\}/gi,''),/url\s*\(/i,'Only font faces reference files');assert.equal(cssUrls.length,(css.match(/url\s*\(/gi)??[]).length);assert.ok(cssUrls.length>0&&cssUrls.every(url=>localFont.test(url)),'Token CSS loads only same-package relative font files, never a remote, protocol-relative or data source');assert.equal(await page.locator('script,iframe,img,video,object,embed').count(),0);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.method==='GET'&&(paths.has(r.path)||r.path==='/favicon.ico')));assert.equal((await context.cookies()).length,0);});
 await writeFile(resolve(evidence,'result.json'),JSON.stringify({cssSha256:createHash('sha256').update(css).digest('hex'),browserVersion:browser.version(),passed,failures,limits:['Token values/theme behavior and representative in-memory property application only.','Focus/forced-colors/reduced-motion rules belong to the test probe, not token-only CSS or accepted production styling.','No standalone8-group specimen pass, application layout/navigation/theme preference or accessibility certification is claimed. Actual app viewport, RTL and zoom acceptance remains separate.']},null,2));
 assert.equal(failures.length,0,`${failures.length} token probe group(s) failed; see private/design-token-evidence/result.json`);
}finally{await browser?.close();await new Promise(done=>server.close(done));}
