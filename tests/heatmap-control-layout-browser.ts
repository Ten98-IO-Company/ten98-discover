// TEN98_HEATMAP_CONTROL_LAYOUT=1 PLAYWRIGHT_MODULE=/installed/playwright/index.mjs node tests/heatmap-control-layout-browser.ts
// Shipped tracker, ingress codecs and player; synthetic loopback acknowledgements, never database/authentication proof.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {readReplayChunk,reassembleReplay,replayLimits,replayBegin,replayUpload,type ReplayPart} from '../src/lib/session-replay.ts';
import {heatmapBegin,heatmapBatch,heatmapBackgroundUpload,heatmapLimits} from '../src/lib/replay-heatmaps.ts';
import {launchChromium} from './helpers/playwright.mjs';
import {mkdirSync} from 'node:fs';
assert.equal(process.env.TEN98_HEATMAP_CONTROL_LAYOUT,'1');assert.ok(process.env.PLAYWRIGHT_MODULE);
const root=process.cwd(),out=resolve(root,'private/swarm/heatmap-live-diagnosis');
mkdirSync(out,{recursive:true});
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const sources=Object.fromEntries(['public/replay.js','public/tracker.js','public/destinations.js','src/lib/session-replay.ts','src/lib/replay-heatmaps.ts','tests/heatmap-control-layout-browser.ts'].map(p=>[p,hash(readFileSync(resolve(root,p)))]));
const shipped=readFileSync(resolve(root,'public/replay.js'),'utf8');
type Scene={name:string;direction:'ltr'|'rtl';sizing:'border-box'|'content-box';unsupported?:'multiline'|'icon'|'pseudo'|'shadow';shadow?:'blocked'|'nested'|'unblocked'|'moved'};
const scenes:Scene[]=[...(['ltr','rtl'] as const).flatMap(direction=>(['border-box','content-box'] as const).map(sizing=>({name:direction+'-'+sizing,direction,sizing}))),...(['multiline','icon','pseudo'] as const).map(unsupported=>({name:unsupported,direction:'ltr' as const,sizing:'border-box' as const,unsupported}))];
const shadowScenes:Scene[]=(['blocked','nested','unblocked','moved'] as const).map(shadow=>({name:'shadow-'+shadow,direction:'ltr',sizing:'border-box',shadow,...shadow==='unblocked'||shadow==='moved'?{unsupported:'shadow' as const}:{}}));
let scene=scenes[0]!;
function asset(){return shipped;}
const site='5a000000-0000-4000-8000-000000000001',epoch='5a000000-0000-4000-8000-000000000002',nonce='diagnostic-local-only';
const settings={enabled:true,sampleRate:1,maskLevel:'strict',maxDurationMs:300000,blockSelector:''};
let origin='';
function baseRecordHtml(){return `<!doctype html><html lang="en" dir="${scene.direction}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Controlled heatmap text test</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:20px;font:20px/22px Arial,sans-serif;background:white;color:#182b36}h1{font:24px/30px Arial,sans-serif;margin:0 0 16px}#sample{width:220px;margin:0;font:20px/22px Arial,sans-serif;overflow-wrap:anywhere}button{box-sizing:${scene.sizing};font:16px/22px Arial,sans-serif;min-height:44px;margin:12px 12px 0 0;padding:10px;border:1px solid #536875;border-radius:4px}#target{box-sizing:border-box;display:block;width:64px;height:64px;margin:0;padding:0;background:#9ed6cc}#status{height:44px;margin:12px 0 0;font:16px/22px Arial,sans-serif}button:focus-visible{outline:3px solid #3345b6;outline-offset:2px}${scene.sizing==='content-box'?'button{min-height:0}':''}${scene.unsupported==='multiline'?'#withdraw{width:90px;overflow-wrap:anywhere}':scene.unsupported==='pseudo'?'#withdraw::before{content:"WWWWWW"}':''}</style>
<script defer src="${origin}/tracker.js" data-site-key="${site}" data-environment="live" referrerpolicy="no-referrer"></script></head><body>
<h1>Controlled heatmap text test</h1><p id="sample">${'W'.repeat(100)}</p><button id="target" type="button">Target</button>
<button id="allow" type="button">Allow analytics and replay</button><button id="withdraw" type="button">${scene.unsupported==='multiline'?'W'.repeat(45):scene.unsupported==='icon'?'<span>WWWWWW</span>Withdraw analytics and replay':'Withdraw analytics and replay'}</button>
<p id="status" aria-live="polite">Synthetic page; collection requires the Allow button.</p>
<script nonce="${nonce}">const site={siteKey:${JSON.stringify(site)},environment:'live',collectorOrigin:${JSON.stringify(origin)}};const status=document.getElementById('status');document.getElementById('allow').onclick=()=>{window.ten98.consent({analytics:true,replay:true,advertising:false,adUserData:false,adPersonalization:false},{...site,acknowledgeReload:true});status.textContent='Synthetic capture allowed. No custom events or revenue.';};document.getElementById('withdraw').onclick=()=>{window.ten98.consent({analytics:false,replay:false,advertising:false,adUserData:false,adPersonalization:false},{...site,acknowledgeReload:true});status.textContent='Analytics and replay withdrawn.';};</script></body></html>`;}
function recordHtml(){
 const html=baseRecordHtml();if(!scene.shadow)return html;
 const host='<div class="qa-blocked-shadow" id="private-shadow-host"></div>',setup=`const host=document.getElementById('private-shadow-host');const shadow=host.attachShadow({mode:'open'});const child=document.createElement('div');child.textContent='PRIVATE_SHADOW_MARKER';shadow.appendChild(child);${scene.shadow==='nested'?"child.attachShadow({mode:'open'}).textContent='NESTED_PRIVATE_SHADOW_MARKER';":''}${scene.shadow==='moved'?"host.style.marginTop='40px';":''}`;
 return html.replace('</style>','.qa-blocked-shadow{display:block;width:40px;height:40px}</style>').replace('<p id="sample">',host+'<p id="sample">').replace('<script nonce="'+nonce+'">const site=','<script nonce="'+nonce+'">'+setup+'const site=');
}
function playerHtml(){const inner=`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; worker-src 'none'; frame-src about:; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><div id="replay-root"></div><script nonce="${nonce}" data-ten98-replay="player" referrerpolicy="no-referrer" src="${origin}/replay.js"></script>`;
 return `<!doctype html><html><body style="margin:0"><div id="host"></div><script>window.messages=[];window.mount=(payload)=>{window.messages=[];const f=document.createElement('iframe');f.style='width:1280px;height:720px;border:0';f.sandbox='allow-scripts allow-same-origin';f.src='data:text/html;charset=utf-8,'+encodeURIComponent(${JSON.stringify(inner).replaceAll('<','\\u003c')});f.onload=()=>{const channel=new MessageChannel();channel.port1.onmessage=e=>window.messages.push(e.data);channel.port1.start();f.contentWindow.postMessage({type:'ten98-replay-init',protocol:1,...payload},'*',[channel.port2]);};document.getElementById('host').replaceChildren(f);};</script></body></html>`;}
const receipt:{runs:unknown[];network:{requests:number;external:string[]};errors:string[];sources:typeof sources;cleanup:string[];elapsedMs?:number}={runs:[],network:{requests:0,external:[]},errors:[],sources,cleanup:[]};
const started=Date.now();const watchdog=setTimeout(()=>{console.error('120 second diagnostic limit');process.exit(2);},120000);
const server=createServer((req,res)=>{const url=new URL(req.url??'/',origin);res.setHeader('cache-control','no-store');if(['/tracker.js','/destinations.js','/replay.js'].includes(url.pathname)){res.setHeader('content-type','text/javascript');res.end(url.pathname==='/replay.js'?asset():readFileSync(resolve(root,'public'+url.pathname)));return;}if(url.pathname==='/qa/heatmap-text'){res.setHeader('content-type','text/html');res.setHeader('content-security-policy',`default-src 'self'; script-src 'nonce-${nonce}' ${origin}; style-src 'nonce-${nonce}'; connect-src ${origin}; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);res.end(recordHtml());return;}if(url.pathname==='/player'){res.setHeader('content-type','text/html');res.end(playerHtml());return;}res.writeHead(url.pathname==='/favicon.ico'?204:404);res.end();});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port;
const browser=await launchChromium({args:['--disable-background-networking','--disable-component-update','--disable-domain-reliability']});
try{
 for(scene of process.argv.includes('--blocked-shadow')?shadowScenes:process.argv.includes('--baseline')?scenes.slice(0,1):process.argv.includes('--focused')?[scenes[0]!,scenes[1]!,scenes[3]!]:[...scenes,...shadowScenes]){
  const mode=scene.name;
  settings.blockSelector=scene.shadow&&scene.shadow!=='unblocked'?'.qa-blocked-shadow':'';
  const context=await browser.newContext({viewport:{width:1280,height:720},locale:'en-US'});context.setDefaultTimeout(8000);
  const parts:ReplayPart[]=[],backgrounds:ReturnType<typeof heatmapBackgroundUpload.parse>[]=[],batches:ReturnType<typeof heatmapBatch.parse>[]=[];let chunks=0;
  const api:string[]=[],captureId=randomUUID(),recordingId=randomUUID();
  await context.route('**/*',async (route:{request():{url():string;postData():string|null};abort():Promise<void>;continue():Promise<void>;fulfill(value:unknown):Promise<void>})=>{const request=route.request(),url=new URL(request.url());receipt.network.requests++;assert.ok(receipt.network.requests<=150);if(url.origin!==origin){receipt.network.external.push(url.origin);await route.abort();return;}if(!url.pathname.startsWith('/api/')){await route.continue();return;}api.push(url.pathname);
   try{const raw=request.postData()!;assert.ok(!raw.includes('W'.repeat(100)));const body:unknown=JSON.parse(raw);const reply=(value:unknown)=>route.fulfill({status:url.pathname==='/api/tracking-config'?200:202,contentType:'application/json',body:JSON.stringify(value)});const now=Date.now(),stamps={createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+300000).toISOString(),uploadUntil:new Date(now+360000).toISOString()};
    if(url.pathname==='/api/tracking-config')return reply({schemaVersion:3,siteKey:site,environment:'live',origin,revisionId:null,consentEpoch:epoch,validUntil:new Date(now+60000).toISOString(),configuration:{destinations:[]},nativeTracking:{enabled:true,collectionMode:'consent-first',consentMode:'external',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:[],replay:settings,heatmap:{enabled:true,sampleRate:1}}});
    if(url.pathname==='/api/collect')return reply({accepted:true});
    if(url.pathname==='/api/heatmaps/begin'){heatmapBegin.parse(body);return reply({accepted:true,reason:null,captureId,token:'synthetic-heatmap.'+'a'.repeat(64),...stamps,settings:{enabled:true,sampleRate:1},limits:heatmapLimits});}
    if(url.pathname==='/api/replay/begin'){replayBegin.parse(body);return reply({accepted:true,reason:null,recordingId,token:'synthetic-replay.'+'b'.repeat(64),...stamps,settings,limits:replayLimits});}
    if(url.pathname==='/api/replay/chunks'){const upload=replayUpload.parse(body),chunk=readReplayChunk(upload.data);assert.equal(upload.sequence,chunks++);parts.push(...chunk.parts);return reply({accepted:true,duplicate:false,recordingId,sequence:upload.sequence,sha256:hash(Buffer.concat([Buffer.from(upload.sequence+':'+upload.final+':'),Buffer.from(chunk.bytes)])),complete:upload.final});}
    if(url.pathname==='/api/heatmaps/batches'){const batch=heatmapBatch.parse(body);batches.push(batch);return reply({accepted:true,duplicate:false,requestId:batch.requestId});}
    assert.equal(url.pathname,'/api/heatmaps/backgrounds');const background=heatmapBackgroundUpload.parse(body);backgrounds.push(background);return reply({accepted:true,duplicate:false,requestId:background.requestId});
   }catch(e){receipt.errors.push(String(e));await route.abort();}
  });
  try{
   const page=await context.newPage();page.on('pageerror',(e:Error)=>receipt.errors.push(e.message));
   await page.goto(origin+'/qa/heatmap-text');await page.waitForFunction(()=>Boolean((window as unknown as {ten98?:unknown}).ten98));await page.locator('#allow').click();
   await page.waitForFunction(()=>Boolean((window as unknown as {__ten98FoundationHub?:{replayStates?:{replayCapture?:{started?:boolean}}[]}}).__ten98FoundationHub?.replayStates?.some(s=>s.replayCapture?.started)));
   const native=await page.evaluate(()=>Object.fromEntries(['target','allow','withdraw','sample','status'].map(id=>[id,document.getElementById(id)!.getBoundingClientRect().toJSON()]))) as Record<string,{x:number;y:number;width:number;height:number}>;await page.locator('#target').click();
   const center={x:native.target.x+native.target.width/2,y:native.target.y+native.target.height/2};
   if(mode==='ltr-border-box')assert.deepEqual(center,{x:52,y:318});
   const until=Date.now()+8000;while(!backgrounds.length||!batches.some(b=>b.observations.some(p=>p.kind==='click'&&Math.abs(p.x-center.x)<=1&&Math.abs(p.y-center.y)<=1))){assert.ok(Date.now()<until,'Capture ACK timeout');await new Promise(r=>setTimeout(r,25));}
   const capture=reassembleReplay(parts);assert.deepEqual(capture.missingFragments,[]);for(const text of ['W'.repeat(100),'Allow analytics and replay','Withdraw analytics and replay'])assert.ok(!JSON.stringify(capture.events).includes(text),'Strict masking must survive ingress reassembly');const background=backgrounds[0]!;const eventHash=(e:typeof capture.events[number])=>hash(JSON.stringify({type:e.type,timestamp:e.timestamp,data:e.data}));
   const meta=capture.events.find(e=>eventHash(e)===background.meta.eventSha256),snapshot=capture.events.find(e=>eventHash(e)===background.snapshot.eventSha256);assert.ok(meta&&snapshot);
   if(scene.shadow&&scene.shadow!=='unblocked'){
    assert.doesNotMatch(JSON.stringify(capture.events),/PRIVATE_SHADOW_MARKER/);
    const pending:unknown[]=[snapshot.data.node];let blocked:Record<string,unknown>|undefined;
    while(pending.length){const value=pending.pop();if(!value||typeof value!=='object'||Array.isArray(value))continue;const node=value as Record<string,unknown>,attributes=node.attributes as Record<string,unknown>|undefined;if(attributes?.class==='qa-blocked-shadow'){blocked=node;break;}if(Array.isArray(node.childNodes))pending.push(...node.childNodes);}
    assert.ok(blocked);assert.equal(blocked.isShadowHost,true);assert.deepEqual(blocked.childNodes,[]);assert.deepEqual(blocked.attributes,{class:'qa-blocked-shadow',rr_width:'40px',rr_height:'40px'});
   }
   const point=batches.flatMap(b=>b.observations).find(p=>p.kind==='click'&&Math.abs(p.x-center.x)<=1&&Math.abs(p.y-center.y)<=1)!;
   assert.ok(point.kind==='click');
   await page.close();const player=await context.newPage();player.on('pageerror',(e:Error)=>receipt.errors.push(e.message));await player.goto(origin+'/player');
   await player.evaluate((payload:unknown)=>(window as unknown as {mount:(p:unknown)=>void}).mount(payload),{events:[meta,snapshot],heatmap:{mode:'click',geometry:background.geometry,points:[{x:point.x,y:point.y,count:1}]}});
   await player.waitForFunction(()=>(window as unknown as {messages:{type:string}[]}).messages.some(m=>m.type==='ready'||m.type==='error'));
   const messages=await player.evaluate(()=>(window as unknown as {messages:{type:string}[]}).messages) as {type:string}[];
   assert.equal(messages[0]?.type,scene.unsupported?'error':'ready',mode+' must preserve supported controls and refuse unsupported geometry');
   let alignment:unknown=null,driftRejected=false;
   if(messages.some(m=>m.type==='ready')){
    const outer=player.frames().find((f:{url():string})=>f.url().startsWith('data:'));assert.ok(outer);
    alignment=await outer.evaluate(()=>{const iframe=document.querySelector<HTMLIFrameElement>('.replayer-wrapper iframe')!,doc=iframe.contentDocument!,target=doc.getElementById('target')!,circle=document.querySelector<SVGCircleElement>('.replayer-wrapper svg circle')!,wrapper=document.querySelector<HTMLElement>('.replayer-wrapper')!;const f=iframe.getBoundingClientRect(),r=target.getBoundingClientRect(),c=circle.getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(wrapper).transform),ox=f.left+iframe.clientLeft*m.a,oy=f.top+iframe.clientTop*m.d;return{target:r.toJSON(),deltaX:(c.left+c.width/2-ox)/m.a-(r.left+r.width/2),deltaY:(c.top+c.height/2-oy)/m.d-(r.top+r.height/2),sample:doc.getElementById('sample')!.getBoundingClientRect().toJSON()};});
    const measured=alignment as {deltaX:number;deltaY:number};assert.ok(Math.abs(measured.deltaX)<=1&&Math.abs(measured.deltaY)<=1);await player.screenshot({path:out+'/'+mode+'.png'});
    await outer.evaluate(()=>{const doc=document.querySelector<HTMLIFrameElement>('iframe')!.contentDocument!;doc.getElementById('allow')!.style.width='300px';});
    await player.waitForFunction(()=>(window as unknown as {messages:{type:string}[]}).messages.some(m=>m.type==='error'));driftRejected=true;
   }
   receipt.runs.push({mode,native,chunks,api,geometry:background.geometry,layout:snapshot.data.ten98Layout,messages,alignment,driftRejected});
   if(!messages.some(m=>m.type==='ready'))await player.screenshot({path:out+'/'+mode+'.png'});console.log('PASS '+mode+' '+JSON.stringify({messages,alignment,driftRejected}));
  }finally{await context.close();receipt.cleanup.push(mode+' context closed');}
 }
 assert.deepEqual(receipt.network.external,[]);assert.deepEqual(receipt.errors,[]);
}finally{await browser.close();receipt.cleanup.push('browser closed');await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));receipt.cleanup.push('loopback server closed');clearTimeout(watchdog);receipt.elapsedMs=Date.now()-started;assert.deepEqual(Object.fromEntries(Object.keys(sources).map(p=>[p,hash(readFileSync(resolve(root,p)))])),sources);writeFileSync(out+(process.argv.includes('--baseline')?'/control-baseline.json':process.argv.includes('--focused')?'/control-final.json':'/control-browser.json'),JSON.stringify(receipt,null,2)+'\n');}
