import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {heatmapBatch,heatmapBegin,heatmapLimits} from '../src/lib/replay-heatmaps.ts';

const tracker=readFileSync(new URL('../public/tracker.js',import.meta.url),'utf8'),coordinator=readFileSync(new URL('../public/destinations.js',import.meta.url),'utf8');
const site='11111111-1111-4111-8111-111111111111',epoch='33333333-3333-4333-8333-333333333333',collector='https://analytics.example',page='https://site.example';
const denied={analytics:false,advertising:false,adUserData:false,adPersonalization:false},analytics={...denied,analytics:true};
// Synthetic VM platform and responses exercise the real two scripts; the separate
// native Edge calibration is evidence for the coordinate formula, not this VM.
type Handler=(event:any)=>void;
type Post={url:string;body:string;input:any;options:any};
function environment(options:{mode?:'cookieless'|'consent-first';heatmap?:unknown;privacy?:boolean;direction?:'ltr'|'rtl';sampled?:boolean}={}){
  const windows=new Map<string,Set<Handler>>(),documents=new Map<string,Set<Handler>>(),timers=new Map<number,{fn:()=>void;delay:number;interval:boolean}>(),storage=new Map<string,string>(),scripts:any[]=[],posts:Post[]=[];
  let time=0,wall=Date.parse('2026-10-16T00:00:00.000Z'),timerId=0,configEpoch=epoch;
  class Clock extends Date{constructor(value?:string|number){super(value===undefined?wall:value);}static now(){return wall;}}
  const root={scrollWidth:1200,scrollHeight:2400,clientWidth:320,clientHeight:600},style={direction:options.direction??'ltr',writingMode:'horizontal-tb',zoom:'1'};
  const add=(map:Map<string,Set<Handler>>,type:string,fn:Handler)=>{if(!map.has(type))map.set(type,new Set());map.get(type)!.add(fn);};
  const remove=(map:Map<string,Set<Handler>>,type:string,fn:Handler)=>map.get(type)?.delete(fn);
  const location={protocol:'https:',origin:page,pathname:'/start',search:'?private=discard',hash:'#discard',get href(){return this.origin+this.pathname+this.search+this.hash;},reload(){assert.fail('No vendor reload should occur.');}};
  const history={pushState(_state:unknown,_title:string,url:string){const next=new URL(url,location.href);location.pathname=next.pathname;location.search=next.search;location.hash=next.hash;},replaceState(_state:unknown,_title:string,url:string){this.pushState(_state,_title,url);}};
  const document:any={currentScript:{src:collector+'/tracker.js',getAttribute:(name:string)=>name==='data-site-key'?site:name==='data-environment'?'live':null},referrer:'',scrollingElement:root,
    addEventListener:(type:string,fn:Handler)=>add(documents,type,fn),removeEventListener:(type:string,fn:Handler)=>remove(documents,type,fn),
    createElement:()=>({}),querySelectorAll:()=>scripts,head:{appendChild(script:any){scripts.push(script);return script;}},
    get cookie():never{return assert.fail('Heatmaps must not inspect cookies.');},get body():never{return assert.fail('Heatmaps must not read body content or CSS zoom.');}};
  const response=(input:unknown,status=202)=>new Response(JSON.stringify(input),{status});
  const flags={begin:null as null|((post:Post)=>Promise<Response>|Response),batch:null as null|((post:Post)=>Promise<Response>|Response),config:null as null|Record<string,unknown>};
  const settings:Record<string,unknown>={enabled:true,collectionMode:options.mode??'consent-first',consentMode:'external',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:['/private'],...(options.heatmap===undefined?{heatmap:{enabled:true,sampleRate:options.sampled===false?0:1}}:{heatmap:options.heatmap})};
  const sandbox:any={document,location,history,origin:page,URL,Intl,Date:Clock,AbortController,TextEncoder,TextDecoder,ReadableStream,crypto:{randomUUID,getRandomValues:webcrypto.getRandomValues.bind(webcrypto)},
    navigator:{globalPrivacyControl:!!options.privacy,language:'en'},performance:{timeOrigin:wall,now:()=>time},scrollX:options.direction==='rtl'?-880:0,scrollY:0,
    visualViewport:{scale:1,offsetLeft:0,offsetTop:0},getComputedStyle:(element:unknown)=>{assert.equal(element,root);return style;},console:{warn(){}},
    setTimeout(fn:()=>void,delay:number){timers.set(++timerId,{fn,delay,interval:false});return timerId;},clearTimeout:(id:number)=>timers.delete(id),
    setInterval(fn:()=>void,delay:number){timers.set(++timerId,{fn,delay,interval:true});return timerId;},clearInterval:(id:number)=>timers.delete(id),
    addEventListener:(type:string,fn:Handler)=>add(windows,type,fn),removeEventListener:(type:string,fn:Handler)=>remove(windows,type,fn),dispatchEvent(event:any){for(const fn of [...windows.get(event.type)??[]])fn(event);},
    CustomEvent:class{type:string;detail:unknown;constructor(type:string,init:any){this.type=type;this.detail=init.detail;}},
    localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)},
    get sessionStorage():never{return assert.fail('Numeric heatmaps must not persist capabilities or points in browser storage.');},
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
      assert.equal(url,collector+'/api/heatmaps/batches');heatmapBatch.parse(post.input);
      return Promise.resolve(flags.batch?flags.batch(post):response({accepted:true,duplicate:false,requestId:post.input.requestId}));
    }};
  sandbox.window=sandbox;
  const context=vm.createContext(sandbox),local=(input:unknown)=>vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(input))})`,context);
  const drain=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
  const run=async()=>{vm.runInContext(tracker,context,{filename:'tracker.js'});assert.equal(scripts.length,1);vm.runInContext(coordinator,context,{filename:'destinations.js'});await drain();};
  const grant=async(value=analytics)=>{const result=sandbox.ten98.consent(local(value),local({siteKey:site,environment:'live',acknowledgeReload:true}));await drain();return result;};
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
