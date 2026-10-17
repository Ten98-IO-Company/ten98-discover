import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,webcrypto,createHash} from 'node:crypto';
import vm from 'node:vm';
import {heatmapBatch,heatmapBegin,heatmapLimits,heatmapBackgroundUpload} from '../src/lib/replay-heatmaps.ts';

const tracker=readFileSync(new URL('../public/tracker.js',import.meta.url),'utf8'),coordinator=readFileSync(new URL('../public/destinations.js',import.meta.url),'utf8');
const site='11111111-1111-4111-8111-111111111111',epoch='33333333-3333-4333-8333-333333333333',collector='https://analytics.example',page='https://site.example';
const denied={analytics:false,advertising:false,adUserData:false,adPersonalization:false},analytics={...denied,analytics:true};
// Synthetic VM platform and responses exercise the real two scripts; the separate
// native Edge calibration is evidence for the coordinate formula, not this VM.
type Handler=(event:any)=>void;
type Post={url:string;body:string;input:any;options:any};
function environment(options:{mode?:'cookieless'|'consent-first';heatmap?:unknown;privacy?:boolean;direction?:'ltr'|'rtl';sampled?:boolean;replay?:boolean;viewport?:{width:number;height:number}}={}){
  const windows=new Map<string,Set<Handler>>(),documents=new Map<string,Set<Handler>>(),timers=new Map<number,{fn:()=>void;delay:number;interval:boolean}>(),storage=new Map<string,string>(),scripts:any[]=[],posts:Post[]=[];
  let replayEmit:((v:unknown)=>void)|undefined,takeSnapshots=0;const replayStorage=new Map<string,string>(),recordingId=randomUUID();let time=0,wall=Date.parse('2026-10-16T00:00:00.000Z'),timerId=0,configEpoch=epoch;
  class Clock extends Date{constructor(value?:string|number){super(value===undefined?wall:value);}static now(){return wall;}}
  const root={scrollWidth:1200,scrollHeight:2400,clientWidth:320,clientHeight:600},style={direction:options.direction??'ltr',writingMode:'horizontal-tb',zoom:'1'};
  const add=(map:Map<string,Set<Handler>>,type:string,fn:Handler)=>{if(!map.has(type))map.set(type,new Set());map.get(type)!.add(fn);};
  const remove=(map:Map<string,Set<Handler>>,type:string,fn:Handler)=>map.get(type)?.delete(fn);
  const location={protocol:'https:',origin:page,pathname:'/start',search:'?private=discard',hash:'#discard',get href(){return this.origin+this.pathname+this.search+this.hash;},reload(){assert.fail('No vendor reload should occur.');}};
  const history={pushState(_state:unknown,_title:string,url:string){const next=new URL(url,location.href);location.pathname=next.pathname;location.search=next.search;location.hash=next.hash;},replaceState(_state:unknown,_title:string,url:string){this.pushState(_state,_title,url);}};
  const document:any={currentScript:{src:collector+'/tracker.js',getAttribute:(name:string)=>name==='data-site-key'?site:name==='data-environment'?'live':null},referrer:'',scrollingElement:root,
    addEventListener:(type:string,fn:Handler)=>add(documents,type,fn),removeEventListener:(type:string,fn:Handler)=>remove(documents,type,fn),
    createElement:()=>options.replay?{setAttribute(){},remove(){}}:{},querySelectorAll:()=>scripts,head:{appendChild(script:any){scripts.push(script);return script;}},
    get cookie():never{return assert.fail('Heatmaps must not inspect cookies.');},get body():never{return assert.fail('Heatmaps must not read body content or CSS zoom.');}};
  const response=(input:unknown,status=202)=>new Response(JSON.stringify(input),{status});
  const flags={begin:null as null|((post:Post)=>Promise<Response>|Response),batch:null as null|((post:Post)=>Promise<Response>|Response),config:null as null|Record<string,unknown>,replayHold:false,replayHeld:[] as Array<()=>void>,background:null as null|((post:Post)=>Promise<Response>|Response)};
  const settings:Record<string,unknown>={...options.replay?{replay:{enabled:true,sampleRate:1,maskLevel:'strict',maxDurationMs:300000,blockSelector:''}}:{},enabled:true,collectionMode:options.mode??'consent-first',consentMode:'external',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:['/private'],...(options.heatmap===undefined?{heatmap:{enabled:true,sampleRate:options.sampled===false?0:1}}:{heatmap:options.heatmap})};
  const sandbox:any={document,location,history,origin:page,URL,Intl,Date:Clock,AbortController,TextEncoder,TextDecoder,ReadableStream,crypto:{randomUUID,getRandomValues:webcrypto.getRandomValues.bind(webcrypto),...options.replay?{subtle:{async digest(_name:string,data:Uint8Array){return Uint8Array.from(createHash('sha256').update(data).digest()).buffer;}}}:{}},
    navigator:{globalPrivacyControl:!!options.privacy,language:'en'},performance:{timeOrigin:wall,now:()=>time},get innerWidth(){return options.viewport?.width??root.clientWidth;},get innerHeight(){return options.viewport?.height??root.clientHeight;},scrollX:options.direction==='rtl'?-880:0,scrollY:0,
    visualViewport:{scale:1,offsetLeft:0,offsetTop:0},getComputedStyle:(element:unknown)=>{assert.equal(element,root);return style;},console:{warn(){}},
    setTimeout(fn:()=>void,delay:number){timers.set(++timerId,{fn,delay,interval:false});return timerId;},clearTimeout:(id:number)=>timers.delete(id),
    setInterval(fn:()=>void,delay:number){timers.set(++timerId,{fn,delay,interval:true});return timerId;},clearInterval:(id:number)=>timers.delete(id),
    addEventListener:(type:string,fn:Handler)=>add(windows,type,fn),removeEventListener:(type:string,fn:Handler)=>remove(windows,type,fn),dispatchEvent(event:any){for(const fn of [...windows.get(event.type)??[]])fn(event);},
    CustomEvent:class{type:string;detail:unknown;constructor(type:string,init:any){this.type=type;this.detail=init.detail;}},
    localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)},
    get sessionStorage(){if(options.replay)return{getItem:(key:string)=>replayStorage.get(key)??null,setItem:(key:string,value:string)=>replayStorage.set(key,value),removeItem:(key:string)=>replayStorage.delete(key)};return assert.fail('Numeric heatmaps must not persist capabilities or points in browser storage.');},
    fetch(url:string,init:any){
      assert.equal(new URL(url).origin,collector,'The VM must never contact another origin.');
      const post={url,body:init.body,input:JSON.parse(init.body),options:init};posts.push(post);
      if(url===collector+'/api/tracking-config')return Promise.resolve(new Response(JSON.stringify({schemaVersion:3,siteKey:site,environment:'live',origin:page,revisionId:null,consentEpoch:configEpoch,validUntil:new Date(wall+60000).toISOString(),configuration:{destinations:[]},nativeTracking:settings,...flags.config}),{status:200}));
      if(url===collector+'/api/collect')return Promise.resolve(response({accepted:true,context:'synthetic-native-context'}));
      if(url===collector+'/api/heatmaps/begin'){
        heatmapBegin.parse(post.input);
        if(flags.begin)return Promise.resolve(flags.begin(post));
        return Promise.resolve(response({accepted:options.sampled!==false,reason:options.sampled===false?'not_sampled':null,captureId:randomUUID(),token:options.sampled===false?null:'synthetic-'+randomUUID()+'.'+'a'.repeat(64),createdAt:new Date(wall).toISOString(),deadlineAt:new Date(wall+300000).toISOString(),uploadUntil:new Date(wall+360000).toISOString(),settings:{enabled:true,sampleRate:options.sampled===false?0:1},limits:heatmapLimits}));
      }
      if(options.replay&&url===collector+'/api/replay/begin')return Promise.resolve(response({accepted:true,reason:null,recordingId,token:'eyJ0cnVlIjp0cnVlfQ.'+'b'.repeat(64),createdAt:new Date(wall).toISOString(),deadlineAt:new Date(wall+300000).toISOString(),uploadUntil:new Date(wall+360000).toISOString(),settings:settings.replay,limits:{chunkBytes:262144,eventsPerChunk:200,chunks:1024,recordingBytes:67108864,eventBytes:4194304,fragmentParts:64,depth:64,nodes:20000,drainMs:60000,pageSize:20,chunkPageSize:4}}));
      if(options.replay&&url===collector+'/api/replay/chunks'){const bytes=Buffer.from(post.input.data,'base64url'),sha256=createHash('sha256').update(Buffer.concat([Buffer.from(post.input.sequence+':'+post.input.final+':'),bytes])).digest('hex'),ack=()=>response({accepted:true,duplicate:false,recordingId,sequence:post.input.sequence,sha256,complete:post.input.final});return flags.replayHold?new Promise<Response>(resolve=>flags.replayHeld.push(()=>resolve(ack()))):Promise.resolve(ack());}
      if(options.replay&&url===collector+'/api/heatmaps/backgrounds'){heatmapBackgroundUpload.parse(post.input);return Promise.resolve(flags.background?flags.background(post):response({accepted:true,duplicate:false,requestId:post.input.requestId}));}
      assert.equal(url,collector+'/api/heatmaps/batches');heatmapBatch.parse(post.input);
      return Promise.resolve(flags.batch?flags.batch(post):response({accepted:true,duplicate:false,requestId:post.input.requestId}));
    }};
  if(options.replay)sandbox.btoa=(text:string)=>Buffer.from(text,'binary').toString('base64');sandbox.window=sandbox;
  const context=vm.createContext(sandbox),local=(input:unknown)=>vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(input))})`,context);
  const drain=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
  const run=async()=>{vm.runInContext(tracker,context,{filename:'tracker.js'});assert.equal(scripts.length,1);vm.runInContext(coordinator,context,{filename:'destinations.js'});await drain();};
  const grant=async(value:typeof analytics&{replay?:boolean}=analytics)=>{const result=sandbox.ten98.consent(local(value),local({siteKey:site,environment:'live',acknowledgeReload:true}));await drain();return result;};
  const fire=(map:Map<string,Set<Handler>>,type:string,event:any)=>{for(const fn of [...map.get(type)??[]])fn({type,...event});};
  const click=async(x=40,y=80,extra:Record<string,unknown>={})=>{fire(documents,'click',{isTrusted:true,button:0,detail:1,clientX:x,clientY:y,target:null,...extra});await drain();};
  const scroll=async(x:number,y:number,target:unknown=document)=>{sandbox.scrollX=x;sandbox.scrollY=y;fire(windows,'scroll',{isTrusted:true,target});await drain();};
  const runTimers=async(delay:number)=>{for(const[id,timer]of[...timers])if(timer.delay===delay){if(!timer.interval)timers.delete(id);timer.fn();}await drain();};
  const advance=(ms:number)=>{time+=ms;wall+=ms;};
  return{sandbox,document,root,style,settings,flags,location,history,scripts,posts,run,grant,click,scroll,drain,runTimers,advance,
    begin:()=>posts.filter(p=>p.url.endsWith('/api/heatmaps/begin')),batches:()=>posts.filter(p=>p.url.endsWith('/api/heatmaps/batches')),
    state:()=>sandbox.__ten98FoundationHub.heatmapStates?.[0],
    async windowEvent(type:string,event:Record<string,unknown>={}){fire(windows,type,event);await drain();},
    setEpoch(value:string){configEpoch=value;},
    async refresh(){await runTimers(30000);},
    resetIdentity(){return sandbox.ten98.resetIdentity(local({siteKey:site,environment:'live'}));},
    async pulse(){await runTimers(2000);},
    backgrounds:()=>posts.filter(p=>p.url.endsWith('/api/heatmaps/backgrounds')),
    replayChunks:()=>posts.filter(p=>p.url.endsWith('/api/replay/chunks')),
    takeSnapshots:()=>takeSnapshots,
    async loadReplay(snapshotText='***',metadata?:{width:number;height:number}){
      assert.equal(options.replay,true);const script=scripts.find(s=>s.src?.endsWith('/replay.js'));assert.ok(script);
      const emit=()=>{assert.ok(replayEmit);replayEmit(local({type:4,timestamp:wall,data:{href:page+location.pathname,width:metadata?.width??sandbox.innerWidth,height:metadata?.height??sandbox.innerHeight}}));replayEmit(local({type:2,timestamp:wall+1,data:{node:{type:0,id:1,childNodes:[{type:3,id:2,textContent:snapshotText}]},initialOffset:{left:0,top:0}}}));};
      sandbox.__ten98FoundationHub.startReplayRecorder=Object.assign((_settings:unknown,callback:(v:unknown)=>void)=>{replayEmit=callback;emit();return()=>{};},{protocolVersion:1});
      sandbox.__ten98FoundationHub.takeReplaySnapshot=Object.assign(()=>{takeSnapshots++;emit();return true;},{protocolVersion:1});script.onload();await drain();
    },
    async releaseReplay(){flags.replayHold=false;for(const done of flags.replayHeld.splice(0))done();await drain();},
    response,
  };
}

test('heatmaps require explicit Analytics, preserve old optional settings, and never depend on replay or vendor/storage access',async()=>{
  for(const setup of [{mode:'cookieless' as const},{privacy:true},{heatmap:{enabled:false,sampleRate:1}},{heatmap:{enabled:true,sampleRate:1,unknown:true}},{heatmap:null}]){
    const e=environment(setup);await e.run();await e.click();await e.pulse();assert.equal(e.begin().length,0);
    if(!setup.privacy)await e.grant();await e.click();await e.pulse();
    assert.equal(e.begin().length,setup.mode==='cookieless'?1:0);
  }
  const e=environment();await e.run();assert.equal(e.begin().length,0);await e.grant();assert.equal(e.begin().length,1);
  const ordinary=e.posts.filter(p=>p.url.endsWith('/api/collect')).length;await e.click();await e.pulse();assert.equal(e.batches().length,1);assert.equal(e.posts.filter(p=>p.url.endsWith('/api/collect')).length,ordinary,'Numeric points never become ordinary traffic events.');assert.equal(e.scripts.length,1,'Only the existing coordinator loads; heatmaps need no replay asset.');
  for(const post of [...e.begin(),...e.batches()]){assert.equal(post.options.credentials,'omit');assert.equal(post.options.referrerPolicy,'no-referrer');assert.equal(post.options.keepalive,undefined);assert.equal(post.input.url,page+'/start');assert.deepEqual(post.input.consent,{analytics:true,epoch});}
  const legacy=environment();delete legacy.settings.heatmap;await legacy.run();await legacy.grant();assert.equal(legacy.begin().length,0);assert.ok(legacy.posts.some(p=>p.url.endsWith('/api/collect')),'Omitting heatmaps preserves ordinary analytics.');
});

test('native rendered CSS coordinates retain RTL scroll and per-event scroll while resize/growth splits exact geometry cohorts',async()=>{
  for(const direction of ['ltr','rtl'] as const){
    const e=environment({direction});e.style.zoom='2';await e.run();await e.grant();
    await e.scroll(direction==='rtl'?-600:280,100);await e.click(40,80);await e.scroll(direction==='rtl'?-500:380,200);await e.click(20,60);
    e.root.scrollHeight=2800;await e.click(10,30);await e.windowEvent('resize');await e.pulse();
    const batches=e.batches().map(p=>heatmapBatch.parse(p.input));assert.equal(batches.length,2);assert.equal(batches[0].geometry.pageHeight,2400);assert.equal(batches[1].geometry.pageHeight,2800);
    const clicks=batches[0].observations.filter(p=>p.kind==='click');assert.deepEqual(clicks.map(p=>[p.x,p.y,p.scrollX,p.scrollY]),[[320,180,direction==='rtl'?-600:280,100],[400,260,direction==='rtl'?-500:380,200]]);
    assert.equal(batches[0].geometry.viewportWidth,320);assert.equal(batches[0].geometry.pageWidth,1200,'CSS zoom is already included in native extents; it is never divided out.');
    const before=e.batches().length;await e.click(20,20,{isTrusted:false});await e.scroll(e.sandbox.scrollX,200,{});await e.pulse();assert.equal(e.batches().length,before);
  }
  for(const invalid of ['vertical','pinch','overscroll']){const e=environment();await e.run();await e.grant();if(invalid==='vertical')e.style.writingMode='vertical-rl';else if(invalid==='pinch')e.sandbox.visualViewport.scale=2;else e.sandbox.scrollY=-1;await e.click();await e.pulse();assert.equal(e.batches().length,0);assert.equal(e.state().heatmapCapture.active,false);}
});

test('observed RTL positive one-pixel endpoint retains physical coordinates and raw facts across shared capture callers',async()=>{
  for(const scrollX of [.25,1]){
    const e=environment({direction:'rtl',replay:true});
    Object.assign(e.root,{scrollWidth:5085,scrollHeight:6000,clientWidth:1440,clientHeight:900});e.style.zoom='2';e.sandbox.scrollX=scrollX;
    await e.run();await e.grant({...analytics,replay:true});
    assert.equal(e.begin().length,1,'The shared startup geometry check must admit the measured native endpoint.');
    assert.equal(e.state().heatmapCapture.active,true);await e.loadReplay();
    await e.scroll(scrollX,5100);await e.click(1279,740);await e.pulse();await e.drain();
    const batches=e.batches().map(post=>heatmapBatch.parse(post.input));assert.equal(batches.length,1);
    const geometry={basis:'document-css-v1' as const,direction:'rtl' as const,pageWidth:5085,pageHeight:6000,viewportWidth:1440,viewportHeight:900};
    assert.deepEqual(batches[0].geometry,geometry);
    assert.deepEqual(batches[0].observations.map(point=>[point.kind,point.scrollX,point.scrollY]),[['scroll',scrollX,5100],['click',scrollX,5100]]);
    const point=batches[0].observations.find(point=>point.kind==='click');assert.ok(point?.kind==='click');
    assert.deepEqual([point.x,point.y,point.clientX,point.clientY],[4924+scrollX,5840,1279,740],'Keep the physical client-plus-native-offset formula; do not clamp the point.');
    assert.equal(e.backgrounds().length,1,'The shared FullSnapshot geometry check must still associate the exact acknowledged plane.');
    assert.deepEqual(e.backgrounds()[0].input.geometry,geometry);
    assert.equal(e.takeSnapshots(),0,'The existing actual adapter checkout already supplied this geometry.');
    await e.click(1440,740);await e.pulse();assert.equal(e.batches().length,1,'A physical point beyond pageWidth remains rejected.');assert.equal(e.state().heatmapCapture.active,true);
  }
  for(const {direction,scrollX}of[{direction:'rtl' as const,scrollX:1.001},{direction:'rtl' as const,scrollX:-880.001},{direction:'ltr' as const,scrollX:-.001},{direction:'rtl' as const,scrollX:NaN}]){
    const e=environment({direction});await e.run();await e.grant();await e.scroll(scrollX,0);await e.click();await e.pulse();
    assert.equal(e.state().heatmapCapture.active,false);assert.equal(e.batches().length,0,'The narrow native RTL endpoint exception must not admit other out-of-range positions.');
  }
});

test('uploads are bounded to twenty points and one in-flight request; unknown acknowledgments retry the exact body once then stop',async()=>{
  const e=environment();await e.run();await e.grant();let release!:(response:Response)=>void;
  e.flags.batch=()=>new Promise(resolve=>{release=resolve;});for(let i=0;i<45;i++)await e.click(i%100,80);await e.pulse();assert.equal(e.batches().length,1);assert.equal(e.batches()[0].input.observations.length,20);
  e.flags.batch=null;release(e.response({accepted:true,duplicate:true,requestId:e.batches()[0].input.requestId}));await e.drain();assert.equal(e.batches().length,3);assert.deepEqual(e.batches().map(p=>p.input.observations.length),[20,20,5]);
  const unknown=environment();await unknown.run();await unknown.grant();unknown.flags.batch=()=>unknown.response({accepted:true,duplicate:false,requestId:randomUUID()});await unknown.click();await unknown.pulse();
  assert.equal(unknown.batches().length,2);assert.equal(unknown.batches()[0].body,unknown.batches()[1].body);assert.equal(unknown.state().heatmapCapture.active,false);await unknown.click();await unknown.pulse();await unknown.refresh();assert.equal(unknown.batches().length,2);assert.equal(unknown.begin().length,1);
  const unsampled=environment({sampled:false});await unsampled.run();await unsampled.grant();await unsampled.click();await unsampled.pulse();await unsampled.refresh();assert.equal(unsampled.begin().length,1);assert.equal(unsampled.batches().length,0);
});

test('withdrawal, current privacy/configuration, identity reset and excluded navigation abort and discard unsent numeric data',async()=>{
  for(const revoke of ['withdraw','privacy','expiry','epoch','identity','excluded']){
    const e=environment();await e.run();await e.grant();const oldToken=e.state().heatmapCapture.reply.token;await e.click();let release!:(response:Response)=>void;e.flags.batch=()=>new Promise(resolve=>{release=resolve;});await e.pulse();assert.equal(e.batches().length,1);
    if(revoke==='withdraw')await e.grant(denied);else if(revoke==='privacy')e.sandbox.navigator.globalPrivacyControl=true;else if(revoke==='expiry')e.advance(60001);else if(revoke==='epoch'){e.setEpoch(randomUUID());await e.refresh();}else if(revoke==='identity')e.resetIdentity();else e.history.pushState(null,'','/private/secret');
    await e.click();await e.pulse();assert.equal(e.batches()[0].options.signal.aborted,true,revoke);release(e.response({accepted:true,duplicate:false,requestId:e.batches()[0].input.requestId}));await e.drain();
    assert.equal(e.state().heatmapCapture.active,false,revoke);assert.equal(e.state().heatmapCapture.reply,null,'Terminal markers retain no upload capability.');assert.equal(e.state().heatmapCapture.queue.length,0);assert.equal(e.batches().length,1,'No retry or late upload after authority loss.');
    if(revoke==='withdraw'){e.flags.batch=null;await e.grant();assert.equal(e.begin().length,2);assert.notEqual(e.state().heatmapCapture.reply.token,oldToken);await e.click();await e.pulse();assert.notEqual(e.batches()[1].input.token,oldToken,'Only a fresh explicit grant obtains a new server capability.');}
  }
});

test('allowed SPA navigation drains its original path without extending its cap and begins the new current path; hidden/BFcache samples never resume',async()=>{
  const e=environment();await e.run();await e.grant();await e.click();e.history.pushState(null,'','/next?secret=discard');await e.drain();assert.equal(e.batches().length,1);assert.equal(e.batches()[0].input.url,page+'/start');assert.equal(e.begin().length,2);assert.equal(e.begin()[1].input.url,page+'/next');
  await e.click();await e.windowEvent('pagehide');await e.pulse();assert.equal(e.batches().length,1,'Pagehide discards unflushed points and never fabricates a final batch.');await e.windowEvent('pageshow',{persisted:true});await e.click();await e.pulse();assert.equal(e.begin().length,2);assert.equal(e.batches().length,1);
});

test('one sampled capture has a fixed five-minute observation window and sixty-second drain, with unchanged exact request on timeout retry',async()=>{
  const e=environment();await e.run();await e.grant();e.advance(299999);await e.refresh();await e.click();let release!:(response:Response)=>void;e.flags.batch=()=>new Promise(resolve=>{release=resolve;});
  e.advance(1);await e.runTimers(300000);assert.equal(e.batches().length,1);assert.equal(e.batches()[0].input.observations.length,1);e.advance(1);await e.click();assert.equal(e.state().heatmapCapture.parts.length,0);assert.equal(e.begin().length,1);
  await e.refresh();e.advance(59999);await e.runTimers(60000);assert.equal(e.batches()[0].options.signal.aborted,true);release(e.response({accepted:true,duplicate:false,requestId:e.batches()[0].input.requestId}));await e.drain();assert.equal(e.batches().length,1);assert.equal(e.state().heatmapCapture.active,false);
  const retry=environment();await retry.run();await retry.grant();retry.flags.batch=()=>new Promise(()=>{});await retry.click();await retry.pulse();await retry.runTimers(5000);assert.equal(retry.batches().length,2);assert.equal(retry.batches()[0].body,retry.batches()[1].body);await retry.runTimers(5000);assert.equal(retry.state().heatmapCapture.active,false);
});

// Synthetic VM callbacks/ACKs exercise coordinator causality only; real rrweb/Edge proof is a separate required gate.
test('historical links wait for both real code paths ACKs and each new accepted geometry requests only one current snapshot',async()=>{
 const e=environment({replay:true});await e.run();await e.grant({...analytics,replay:true});await e.loadReplay();let release!:(response:Response)=>void;
 e.flags.batch=()=>new Promise(resolve=>{release=resolve;});await e.click();await e.pulse();assert.equal(e.backgrounds().length,0,'No geometry ACK means no link even when replay chunks are acknowledged');
 e.flags.batch=null;release(e.response({accepted:true,duplicate:false,requestId:e.batches()[0].input.requestId}));await e.drain();assert.equal(e.backgrounds().length,1);const first=e.backgrounds()[0];assert.equal(first.input.batchRequestId,e.batches()[0].input.requestId);assert.equal(first.input.meta.kind,'event');assert.equal(first.input.snapshot.kind,'event');assert.equal('data'in first.input,false);assert.equal('replayOffsetMs'in first.input,false);
 e.root.scrollHeight+=100;await e.click();await e.pulse();await e.pulse();await e.drain();assert.equal(e.takeSnapshots(),1,'A new acknowledged layout uses the actual adapter checkout seam once');assert.equal(e.backgrounds().length,2);assert.notEqual(e.backgrounds()[1].input.geometryKey,first.input.geometryKey);await e.click();await e.pulse();assert.equal(e.takeSnapshots(),1);assert.equal(e.backgrounds().length,2);
});

test('fragment links wait for every chunk ACK; withdrawal and optional association loss cannot send stale references or stop numeric collection',async()=>{
 const e=environment({replay:true});await e.run();await e.grant({...analytics,replay:true});e.flags.replayHold=true;await e.loadReplay('*'.repeat(760000));await e.click();await e.pulse();assert.equal(e.backgrounds().length,0);
 await e.releaseReplay();for(let i=0;i<8;i++)await e.drain();assert.equal(e.backgrounds().length,1);assert.equal(e.backgrounds()[0].input.snapshot.kind,'fragment');assert.ok(e.replayChunks().length>=5);
 const revoked=environment({replay:true});await revoked.run();await revoked.grant({...analytics,replay:true});revoked.flags.replayHold=true;await revoked.loadReplay();await revoked.click();await revoked.pulse();await revoked.grant(analytics);await revoked.releaseReplay();assert.equal(revoked.backgrounds().length,0,'A late accepted replay response after withdrawal cannot create an association');
 const optional=environment({replay:true});await optional.run();await optional.grant({...analytics,replay:true});await optional.loadReplay();optional.flags.background=()=>optional.response({accepted:true,duplicate:false,requestId:randomUUID()});await optional.click();await optional.pulse();await optional.drain();assert.equal(optional.backgrounds().length,2,'Optional association retries at most the same request twice');assert.equal(optional.backgrounds()[0].body,optional.backgrounds()[1].body);assert.equal(optional.state().heatmapCapture.active,true);await optional.click();await optional.pulse();assert.equal(optional.batches().length,2,'Numeric collection survives optional association uncertainty');
});

test('backgrounds retain native Meta inner dimensions independently from client geometry and reject stale or impossible window facts',async()=>{
 for(const setup of [
  {viewport:{width:1440,height:900},metadata:undefined},
  {viewport:{width:1440,height:900},metadata:{width:1439,height:900}},
  {viewport:{width:1440,height:900},metadata:{width:1440,height:899}},
  {viewport:{width:20001,height:900},metadata:{width:20001,height:900}},
  {viewport:{width:1440.5,height:900},metadata:{width:1440.5,height:900}},
 ]){
  const e=environment({replay:true,viewport:setup.viewport});e.root.clientWidth=1425;e.root.clientHeight=885;e.root.scrollWidth=2400;
  await e.run();await e.grant({...analytics,replay:true});await e.loadReplay('***',setup.metadata);await e.click();await e.pulse();await e.drain();
  assert.equal(e.batches().length,1);assert.equal(e.state().heatmapCapture.active,true,'An unsupported optional background cannot stop numeric collection.');
  if(setup.metadata){assert.equal(e.backgrounds().length,0,'Meta must be a bounded integer pair exactly matching the live native window.');continue;}
  assert.equal(e.backgrounds().length,1);const background=e.backgrounds()[0].input;
  assert.equal(background.geometry.viewportWidth,1425);assert.equal(background.geometry.viewportHeight,885);
  const meta=e.replayChunks().flatMap(p=>JSON.parse(Buffer.from(p.input.data,'base64url').toString('utf8'))).find(p=>p.type===4);
  assert.deepEqual(meta.data,{href:page+'/start',width:1440,height:900});
  assert.equal(background.meta.eventSha256,createHash('sha256').update(JSON.stringify(meta)).digest('hex'),'The raw recorded Meta and its locator hash are never rewritten to client dimensions.');
 }
});
