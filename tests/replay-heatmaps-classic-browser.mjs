// TEN98_REPLAY_HEATMAPS_CLASSIC=1 PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node tests/replay-heatmaps-classic-browser.mjs
// Real shipped tracker, rrweb recorder and isolated player in Edge with CLASSIC (non-overlay) scrollbars: a classic RTL scrollbar is drawn on the
// LEFT inside the replay frame but on the right of the recording window, so the recorded viewport origin is not the frame's client (0,0).
// Overlay-scrollbar (default headless) scenes run in a second browser: plain pages stay playable, while a gutter reserved behind hidden scrollbars
// narrows the frame's initial containing block without changing clientWidth and must fail closed instead of painting a shifted plane.
// Synthetic config/Begin/ingress ACKs and an in-memory chunk store only. No database, authentication, retention or full-app claim.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'vite';
assert.equal(process.env.TEN98_REPLAY_HEATMAPS_CLASSIC,'1');assert.ok(process.env.PLAYWRIGHT_MODULE);
const root=process.cwd(),out=resolve(root,'private/replay-heatmaps/classic-browser-'+randomBytes(6).toString('hex'));mkdirSync(out,{recursive:true});
const {readReplayChunk,reassembleReplay,replayLimits,replayBegin,replayUpload}=await import(pathToFileURL(resolve(root,'src/lib/session-replay.ts')).href);
const {heatmapBegin,heatmapBatch,heatmapBackgroundUpload,heatmapPlane,heatmapLimits}=await import(pathToFileURL(resolve(root,'src/lib/replay-heatmaps.ts')).href);
const hash=value=>createHash('sha256').update(value).digest('hex'),eventSha=event=>hash(JSON.stringify({type:event.type,timestamp:event.timestamp,data:event.data})),planeKey=geometry=>hash(JSON.stringify(heatmapPlane(geometry)));
const site='5a000000-0000-4000-8000-000000000001',epoch='5a000000-0000-4000-8000-000000000002',nonce='ten98-classic-scrollbar-scene',recordPath='/classic/record',playerPath='/classic/player';
const settings={enabled:true,sampleRate:1,maskLevel:'strict',maxDurationMs:300000,blockSelector:'#private-zone'},secrets=['PRIVATE_DOM_MARKER','PRIVATE_INPUT_MARKER','PRIVATE_BLOCK_MARKER'];
// The blocked #private-zone text overflows 162px past its 40px box; in RTL that spill extends the recorded page LEFT of the plane while the
// masked replay renders only the plane, so the RTL scenes exercise the player's extent restoration, LTR the natural-extent path.
const scenes=[
 {width:1440,height:900,direction:'rtl',classic:true,gutter:true,expect:'ready'},{width:320,height:700,direction:'ltr',classic:true,gutter:true,expect:'ready'},{width:320,height:700,direction:'rtl',classic:true,gutter:true,expect:'ready'},
 {width:1440,height:900,direction:'rtl',classic:false,gutter:true,expect:'error'},{width:1440,height:900,direction:'rtl',classic:false,gutter:false,expect:'ready'},{width:320,height:700,direction:'ltr',classic:false,gutter:false,expect:'ready'},
];
const evidence={phase:'starting',qualification:'Classic-scrollbar Edge scenes through the real tracker, recorder and player; synthetic config/Begin/ingress ACKs and an in-memory chunk store only.',scenes:[],external:[],unexpected:[],pageErrors:[],cleanup:[]},save=()=>writeFileSync(out+'/evidence.json',JSON.stringify(evidence,null,2)+'\n');save();
const started=Date.now(),budgetMs=180000;
const wait=async(predicate,label)=>{const until=Date.now()+8000;while(!await predicate()){assert.ok(Date.now()<until&&Date.now()-started<budgetMs,label);await new Promise(r=>setTimeout(r,15));}};
const settle=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
let server,context,origin;const browsers={};
const browserFor=async scene=>browsers[scene.classic]??=await (await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)).chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'msedge',headless:true,...scene.classic?{ignoreDefaultArgs:['--hide-scrollbars']}:{},args:['--disable-background-networking','--disable-component-update','--disable-domain-reliability']});
function recordHtml(direction,gutter){
 const css="html,body{margin:0;padding:0;scroll-behavior:auto;overscroll-behavior:none}"+(gutter?"html{scrollbar-gutter:stable}":"")+"#plane{position:relative;width:2400px;height:3000px;background:#e6eef1}#target{position:absolute;right:48px;bottom:48px;width:64px;height:64px;background:#057a65}#bulk{position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden;white-space:pre}#controls{position:fixed;top:8px;left:8px;z-index:20;display:flex;flex-direction:column;gap:4px}button{min-height:44px;max-width:104px}#private-zone{position:absolute;left:20px;top:100px;width:40px;height:40px}input{position:absolute;left:100px;top:100px;width:150px}";
 const script=[
  "window.nativeFacts={clicks:[]};",
  "const rectangle=node=>{const b=node.getBoundingClientRect();return{left:b.left,top:b.top,right:b.right,bottom:b.bottom,width:b.width,height:b.height};};",
  "const facts=()=>{const r=document.scrollingElement;return{geometry:{basis:'document-css-v1',direction:getComputedStyle(r).direction,pageWidth:r.scrollWidth,pageHeight:r.scrollHeight,viewportWidth:r.clientWidth,viewportHeight:r.clientHeight},scrollX,scrollY,innerWidth,innerHeight,gutterX:innerWidth-r.clientWidth,gutterY:innerHeight-r.clientHeight,rootLeft:r.getBoundingClientRect().left+scrollX,scrollbarWidth:getComputedStyle(r).scrollbarWidth,target:rectangle(document.getElementById('target'))};};",
  "const choose=(analytics,replay)=>window.ten98.consent({analytics,replay,advertising:false,adUserData:false,adPersonalization:false},{siteKey:"+JSON.stringify(site)+",environment:'live',acknowledgeReload:true});",
  "document.getElementById('grant').onclick=()=>choose(true,true);",
  "document.addEventListener('click',e=>{if(e.target.id==='target')window.nativeFacts.clicks.push({trusted:e.isTrusted,clientX:e.clientX,clientY:e.clientY,...facts()});},true);"
 ].join('\n');
 return '<!doctype html><html lang="en" dir="'+direction+'"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-'+nonce+'\'; style-src \'unsafe-inline\'; connect-src \'self\'; worker-src \'none\'; frame-src \'none\'; img-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>Classic scrollbar capture</title><style>'+css+'</style><body><div id="plane"><div id="target"></div><div id="bulk">'+secrets[0].repeat(2000)+'</div><input aria-label="Private fixture input" value="'+secrets[1]+'"><div id="private-zone">'+secrets[2]+'</div></div><div id="controls"><button id="grant">Grant both</button></div><script nonce="'+nonce+'">'+script+'</script><script nonce="'+nonce+'" referrerpolicy="no-referrer" src="/tracker.js" data-site-key="'+site+'" data-environment="live"></script></body></html>';
}
function playerHtml(){
 // The inner document is the SessionReplayPanel player document with a fixed nonce.
 const inner='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-'+nonce+'\'; style-src \'unsafe-inline\'; img-src data: blob:; connect-src \'none\'; worker-src \'none\'; frame-src about:; font-src \'none\'; media-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"><div id="replay-root"></div><script nonce="'+nonce+'" data-ten98-replay="player" referrerpolicy="no-referrer" src="'+origin+'/replay.js"></script>';
 const script="window.messages=[];window.port=null;window.mount=({events,heatmap})=>{if(window.port){window.port.postMessage({type:'destroy'});window.port.close();}window.messages=[];const frame=document.createElement('iframe');frame.title='Isolated session replay';frame.sandbox='allow-scripts allow-same-origin';frame.referrerPolicy='no-referrer';frame.tabIndex=-1;frame.src='data:text/html;charset=utf-8,'+encodeURIComponent("+JSON.stringify(inner).replaceAll('<','\\u003c')+");frame.onload=()=>{const channel=new MessageChannel();window.port=channel.port1;channel.port1.onmessage=event=>{window.messages.push(event.data);};channel.port1.start();frame.contentWindow.postMessage({type:'ten98-replay-init',protocol:1,events,heatmap},'*',[channel.port2]);};document.getElementById('frame-host').replaceChildren(frame);};window.position=(axis,value)=>window.port.postMessage({type:'heatmap-position',axis,value});";
 return '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-'+nonce+'\'; style-src \'unsafe-inline\'; frame-src data:; worker-src \'none\'; connect-src \'none\'; img-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>Classic scrollbar alignment</title><style>body{margin:0;font:18px sans-serif}iframe{display:block;width:100%;height:500px;border:0}</style><body><div id="frame-host"></div><script nonce="'+nonce+'">'+script+'</script></body></html>';
}
async function fresh(scene){
 const memory={parts:[],chunks:0,batches:[],backgrounds:[],replay:null,heatmap:null},record={scene,api:[],faults:[]};evidence.scenes.push(record);save();
 context=await (await browserFor(scene)).newContext({viewport:{width:scene.width,height:scene.height},locale:'en-US'});context.setDefaultTimeout(8000);
 context.on('serviceworker',()=>{evidence.unexpected.push('serviceworker');save();});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  try{
   if(url.origin!==origin){evidence.external.push({method:request.method(),origin:url.origin});save();return route.abort();}
   if(!url.pathname.startsWith('/api/')){assert.equal(request.method(),'GET');assert.ok([recordPath,playerPath,'/tracker.js','/destinations.js','/replay.js','/favicon.ico'].includes(url.pathname),url.pathname);return route.continue();}
   assert.equal(request.method(),'POST');const raw=request.postData(),body=JSON.parse(raw),headers=await request.allHeaders();assert.equal(headers.cookie,undefined);assert.ok(secrets.every(s=>!raw.includes(s)),'No masked text may reach ingress');
   record.api.push({path:url.pathname,bytes:Buffer.byteLength(raw)});assert.ok(record.api.length<=90);
   const reply=value=>route.fulfill({status:url.pathname==='/api/tracking-config'?200:202,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify(value)});
   if(url.pathname==='/api/tracking-config'){assert.equal(body.siteKey,site);return reply({schemaVersion:3,siteKey:site,environment:'live',origin,revisionId:null,consentEpoch:epoch,validUntil:new Date(Date.now()+60000).toISOString(),configuration:{destinations:[]},nativeTracking:{enabled:true,collectionMode:'consent-first',consentMode:'external',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:[],replay:settings,heatmap:{enabled:true,sampleRate:1}}});}
   if(url.pathname==='/api/collect'){assert.equal(body.name,'page_view');return reply({accepted:true});}
   const now=Date.now(),stamps={createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+300000).toISOString(),uploadUntil:new Date(now+360000).toISOString()};
   if(url.pathname==='/api/heatmaps/begin'){heatmapBegin.parse(body);assert.equal(memory.heatmap,null);memory.heatmap={accepted:true,reason:null,captureId:randomUUID(),token:'synthetic-heatmap.'+'a'.repeat(64),...stamps,settings:{enabled:true,sampleRate:1},limits:heatmapLimits};return reply(memory.heatmap);}
   if(url.pathname==='/api/replay/begin'){replayBegin.parse(body);assert.equal(memory.replay,null);memory.replay={accepted:true,reason:null,recordingId:randomUUID(),token:'synthetic-replay.'+'b'.repeat(64),...stamps,settings,limits:replayLimits};return reply(memory.replay);}
   if(url.pathname==='/api/replay/chunks'){
    replayUpload.parse(body);assert.equal(body.token,memory.replay.token);const chunk=readReplayChunk(body.data),digest=hash(Buffer.concat([Buffer.from(body.sequence+':'+body.final+':'),Buffer.from(chunk.bytes)]));
    if(body.sequence<memory.chunks)return reply({accepted:true,duplicate:true,recordingId:memory.replay.recordingId,sequence:body.sequence,sha256:digest,complete:false});
    assert.equal(body.sequence,memory.chunks);assert.ok(memory.chunks<48);memory.chunks++;memory.parts.push(...chunk.parts);
    return reply({accepted:true,duplicate:false,recordingId:memory.replay.recordingId,sequence:body.sequence,sha256:digest,complete:false});
   }
   if(url.pathname==='/api/heatmaps/batches'){heatmapBatch.parse(body);assert.equal(body.token,memory.heatmap.token);assert.equal(body.geometry.direction,scene.direction);if(!memory.batches.some(b=>b.requestId===body.requestId))memory.batches.push(body);return reply({accepted:true,duplicate:false,requestId:body.requestId});}
   assert.equal(url.pathname,'/api/heatmaps/backgrounds');heatmapBackgroundUpload.parse(body);assert.equal(body.heatmapToken,memory.heatmap.token);assert.equal(body.replayToken,memory.replay.token);
   assert.ok(memory.batches.some(b=>b.requestId===body.batchRequestId),'An association must follow its acknowledged numeric batch');assert.equal(planeKey(body.geometry),body.geometryKey);
   if(!memory.backgrounds.some(b=>b.requestId===body.requestId))memory.backgrounds.push(body);return reply({accepted:true,duplicate:false,requestId:body.requestId});
  }catch(error){record.faults.push({name:error.name,message:error.message});save();await route.abort().catch(()=>{});}
 });
 const page=await context.newPage();page.on('pageerror',error=>{evidence.pageErrors.push({scene,message:error.message});save();});
 await page.goto(origin+recordPath+'?direction='+scene.direction+'&gutter='+(scene.gutter?'1':'0'),{waitUntil:'domcontentloaded'});
 await page.waitForFunction(site=>window.ten98?.destinationStatus?.({siteKey:site,environment:'live',collectorOrigin:location.origin}).ready,site);await settle(page);
 return{page,record,memory};
}
const pass=name=>{console.log('PASS '+name);};
try{
 server=await createServer({configFile:false,root,cacheDir:resolve(out,'vite-cache'),appType:'custom',publicDir:false,server:{fs:{strict:true,allow:[]},host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
 server.middlewares.use((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');res.setHeader('cache-control','no-store');if(url.pathname==='/favicon.ico'){res.statusCode=204;res.end();return;}if(['/tracker.js','/destinations.js','/replay.js'].includes(url.pathname)){res.setHeader('content-type','text/javascript; charset=utf-8');res.end(readFileSync(resolve(root,'public'+url.pathname)));return;}if(url.pathname===recordPath||url.pathname===playerPath){res.setHeader('content-type','text/html; charset=utf-8');res.end(url.pathname===recordPath?recordHtml(['ltr','rtl'].includes(url.searchParams.get('direction'))?url.searchParams.get('direction'):'ltr',url.searchParams.get('gutter')==='1'):playerHtml());return;}res.statusCode=404;res.end();});
 await server.listen();const address=server.httpServer.address();assert.equal(address.address,'127.0.0.1');origin='http://127.0.0.1:'+address.port;
 for(const scene of scenes){
  const {page,record,memory}=await fresh(scene);
  await page.getByRole('button',{name:'Grant both',exact:true}).click();
  await page.waitForFunction(()=>window.__ten98FoundationHub?.heatmapStates?.some(s=>s.heatmapCapture?.reply?.accepted)&&window.__ten98FoundationHub?.replayStates?.some(s=>s.replayCapture?.started));
  await page.mouse.wheel(scene.direction==='rtl'?-400:400,400);await settle(page);
  await page.locator('#target').click();await settle(page);
  const native=await page.evaluate(()=>window.nativeFacts.clicks.at(-1));record.native=native;save();
  assert.equal(native.trusted,true);assert.equal(native.scrollbarWidth,'auto');if(scene.classic)assert.ok(native.gutterX>0&&native.gutterY>0,'Classic scrollbars must reserve a native gutter; zero means overlay scrollbars and proves nothing.');else assert.equal(native.gutterX,0,'Overlay scrollbars leave the recording window without a client gutter.');
  assert.equal(native.innerWidth,scene.width);assert.equal(native.geometry.viewportWidth,scene.width-native.gutterX);assert.equal(native.rootLeft,0,'The recording window keeps its viewport origin at client (0,0) even with classic RTL scrollbars.');
  const key=planeKey(native.geometry);
  await wait(()=>memory.backgrounds.some(b=>b.geometryKey===key)&&memory.batches.some(b=>planeKey(b.geometry)===key&&b.observations.some(p=>p.kind==='click'&&p.clientX===native.clientX&&p.clientY===native.clientY&&p.scrollX===native.scrollX&&p.scrollY===native.scrollY)),'The real tracker must ACK both the trusted click and the snapshot association');
  const background=memory.backgrounds.find(b=>b.geometryKey===key),point=memory.batches.flatMap(b=>planeKey(b.geometry)===key?b.observations:[]).find(p=>p.kind==='click'&&p.clientX===native.clientX&&p.clientY===native.clientY&&p.scrollX===native.scrollX&&p.scrollY===native.scrollY);
  assert.deepEqual(background.geometry,native.geometry);
  const reconstructed=reassembleReplay(memory.parts);assert.deepEqual(reconstructed.missingFragments,[]);assert.ok(secrets.every(s=>!JSON.stringify(reconstructed.events).includes(s)));
  const meta=reconstructed.events.find(e=>eventSha(e)===background.meta.eventSha256),snapshot=reconstructed.events.find(e=>eventSha(e)===background.snapshot.eventSha256);
  assert.equal(meta?.type,4);assert.equal(snapshot?.type,2);assert.equal(meta.data.width,native.innerWidth);assert.equal(meta.data.height,native.innerHeight);
  record.recording={geometry:native.geometry,point:{x:point.x,y:point.y},meta:{width:meta.data.width,height:meta.data.height},chunks:memory.chunks};save();
  await page.close();
  const player=await context.newPage();player.on('pageerror',error=>{evidence.pageErrors.push({scene,message:error.message});save();});await player.goto(origin+playerPath,{waitUntil:'domcontentloaded'});
  await player.evaluate(value=>window.mount(value),{events:[meta,snapshot],heatmap:{mode:'click',geometry:background.geometry,points:[{x:point.x,y:point.y,count:1}]}});
  await player.waitForFunction(()=>window.messages.some(m=>m.type==='ready'||m.type==='error'));
  const messages=await player.evaluate(()=>window.messages);record.messages=messages;save();
  if(scene.expect==='error'){assert.deepEqual(messages[0],{type:'error',message:'This recording could not be played safely.'},'A gutter reserved behind hidden scrollbars narrows the frame block and must fail closed');await player.waitForFunction(()=>!document.querySelector('.replayer-wrapper'));const facts=await player.frames().find(frame=>frame.url().startsWith('data:')).evaluate(()=>({wrapper:document.querySelectorAll('.replayer-wrapper').length,svg:document.querySelectorAll('svg').length}));record.alignment=facts;assert.deepEqual(facts,{wrapper:0,svg:0},'A refused sample leaves no frame or plane behind');assert.deepEqual(record.faults,[]);await context.close();context=null;record.closed=true;save();pass((scene.classic?'CLASSIC ':'OVERLAY ')+scene.width+'x'+scene.height+' '+scene.direction+(scene.gutter?' gutter':' plain')+': refused (block narrower than the recorded viewport), no plane painted');continue;}
  assert.deepEqual(messages[0],{type:'ready',duration:snapshot.timestamp-meta.timestamp},'The sample must be playable');
  const outer=player.frames().find(frame=>frame.url().startsWith('data:'));assert.ok(outer);
  const g=background.geometry,corner={x:g.pageWidth-g.viewportWidth,y:g.pageHeight-g.viewportHeight};
  await player.evaluate(c=>{window.position('x',c.x);window.position('y',c.y);},corner);
  await wait(()=>outer.evaluate(c=>{const view=document.querySelector('iframe').contentWindow;return view.scrollX===(c.rtl?0:c.x)&&view.scrollY===c.y;},{...corner,rtl:scene.direction==='rtl'}).catch(()=>false),'Position commands must reach the recorded corner');
  const measure=await outer.evaluate(()=>{
   const iframe=document.querySelector('.replayer-wrapper iframe'),doc=iframe.contentDocument,view=iframe.contentWindow,root=doc.scrollingElement,target=doc.getElementById('target'),circle=document.querySelector('.replayer-wrapper svg circle'),marker=doc.querySelector('[data-ten98-heatmap-extent]');
   if(!target||!circle)throw Error('Reconstructed target or overlay circle is missing');
   const f=iframe.getBoundingClientRect(),r=target.getBoundingClientRect(),c=circle.getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(document.querySelector('.replayer-wrapper')).transform),sx=m.a,sy=m.d;
   // Player-document position of the reconstructed target: iframe border box, then its border and the inner client rect, all under the wrapper scale.
   const ox=f.left+iframe.clientLeft*sx,oy=f.top+iframe.clientTop*sy,box={left:ox+r.left*sx,top:oy+r.top*sy,right:ox+r.right*sx,bottom:oy+r.bottom*sy},center={x:c.left+c.width/2,y:c.top+c.height/2};
   return{geometry:{basis:'document-css-v1',direction:view.getComputedStyle(root).direction,pageWidth:root.scrollWidth,pageHeight:root.scrollHeight,viewportWidth:root.clientWidth,viewportHeight:root.clientHeight},innerWidth:view.innerWidth,gutterX:view.innerWidth-root.clientWidth,originX:root.getBoundingClientRect().left+view.scrollX,scrollX:view.scrollX,scrollY:view.scrollY,scale:[sx,sy],border:[iframe.clientLeft,iframe.clientTop],marker:marker?{left:marker.style.left,top:marker.style.top}:null,target:box,center,deltaX:(center.x-(box.left+box.right)/2)/sx,deltaY:(center.y-(box.top+box.bottom)/2)/sy};
  });
  record.alignment=measure;save();
  assert.deepEqual(measure.geometry,background.geometry,'The replay root must reproduce the recorded client and document extents');
  assert.equal(!!measure.marker,scene.direction==='rtl','RTL scenes restore the masked spill through the extent marker; LTR renders the exact extent naturally');
  assert.ok(Math.abs(measure.deltaX)<=1&&Math.abs(measure.deltaY)<=1,'Circle centre must coincide with the reconstructed target centre within 1 CSS px (a gutter or iframe-border error is 15 or 2 px): '+JSON.stringify({deltaX:measure.deltaX,deltaY:measure.deltaY}));
  assert.ok(measure.center.x>=measure.target.left&&measure.center.x<=measure.target.right&&measure.center.y>=measure.target.top&&measure.center.y<=measure.target.bottom);
  // The guards that fail closed on drift must survive with the measured origin in place.
  await outer.evaluate(()=>{const plane=document.querySelector('iframe').contentDocument.getElementById('plane');plane.style.height=String(plane.clientHeight-100)+'px';});
  await player.waitForFunction(()=>window.messages.some(m=>m.type==='error'));assert.equal(await outer.locator('.replayer-wrapper').count(),0,'Natural shrink must destroy the preview');
  record.shrinkRejected=true;
  const screenshot=resolve(out,(scene.classic?'classic-':'overlay-')+(scene.gutter?'gutter-':'plain-')+scene.width+'-'+scene.direction+'.png');await player.screenshot({path:screenshot});record.screenshot=screenshot;
  assert.deepEqual(record.faults,[]);await context.close();context=null;record.closed=true;save();
  pass((scene.classic?'CLASSIC ':'OVERLAY ')+scene.width+'x'+scene.height+' '+scene.direction+(scene.gutter?' gutter':' plain')+': recorded viewport '+native.geometry.viewportWidth+'x'+native.geometry.viewportHeight+' page '+native.geometry.pageWidth+'x'+native.geometry.pageHeight+', in-frame viewport origin x='+measure.originX+', marker '+(measure.marker?'installed':'not needed')+', delta '+measure.deltaX.toFixed(3)+'/'+measure.deltaY.toFixed(3)+' px');
 }
 assert.equal(evidence.scenes.length,6);assert.ok(evidence.scenes.every(s=>s.closed));assert.deepEqual(evidence.external,[]);assert.deepEqual(evidence.unexpected,[]);assert.deepEqual(evidence.pageErrors,[]);assert.ok(Date.now()-started<budgetMs);evidence.phase='passed';
}catch(error){evidence.phase='failed';evidence.failure={name:error.name,message:error.message,stack:error.stack};throw error;}
finally{try{await context?.close();}catch(error){evidence.cleanup.push('context:'+error.name);}for(const b of Object.values(browsers)){try{await b?.close();}catch(error){evidence.cleanup.push('browser:'+error.name);}}try{await server?.close();}catch(error){evidence.cleanup.push('server:'+error.name);}evidence.elapsedMs=Date.now()-started;if(evidence.cleanup.length)evidence.phase='failed';save();console.log('evidence '+out+'/evidence.json '+evidence.phase+' '+evidence.elapsedMs+'ms');}
