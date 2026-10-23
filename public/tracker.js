// ten98 foundation monitor: initial page_view, SPA navigations, bfcache restores, custom events.
// Dependency-free IIFE. Instrumentation must never break the host page.
(function () {
  'use strict';
  // Disk previews and opaque sandboxed documents have no verifiable website origin.
  if (!['http:', 'https:'].includes(location.protocol) || location.origin === 'null' || window.origin === 'null') return;

  var NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
  var PAGE_VIEW = 'page_view';
  /** @type {Set<Ten98Tracker.PerformanceCapture>} */
  var performanceCaptures = new Set();
  var performanceDocumentChanged = false;
  /** @type {Record<string,number>} */
  var replayLimits = {chunkBytes:262144,eventsPerChunk:200,chunks:1024,recordingBytes:67108864,eventBytes:4194304,fragmentParts:64,depth:64,nodes:20000,drainMs:60000,pageSize:20,chunkPageSize:4};
  var replayMemoryLimit = 8388608;
  var replayUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  // Numeric heatmaps are independent of replay. Native root extents already include
  // CSS zoom; the RTL offset follows the retained Edge geometry calibration.
  /** @type {Record<string,number>} */
  var heatmapLimits = {batchBytes:32768,observations:20,captureBatches:256,captureBytes:8388608,captureMs:300000,drainMs:60000,extent:10000000,viewport:20000,pageSize:20,points:5000};

  /** @param {Uint8Array<ArrayBuffer>} bytes @param {(hash:string|null)=>void} done */
  function backgroundHash(bytes, done) {
    crypto.subtle.digest('SHA-256',bytes).then(function(value){done(Array.from(new Uint8Array(value),function(n){return n.toString(16).padStart(2,'0');}).join(''));},function(){done(null);});
  }
  /** @param {Ten98Tracker.BackgroundRef|null|undefined} ref */
  function backgroundLocator(ref) {
    if(!ref || !ref.hash || !ref.location || ref.acks!==ref.total)return null;
    return Object.assign({},ref.location,{eventSha256:ref.hash});
  }
  /** @param {Ten98Tracker.ReplayCapture} c @param {Ten98Tracker.RecorderEvent} event @param {Uint8Array} _bytes @returns {Ten98Tracker.BackgroundRef|null} */
  function backgroundSnapshot(c,event,_bytes) {
    var h=c.state.heatmapCapture;
    if(!h || !h.reply || !h.reply.accepted || !heatmapCurrent(h,false) || !replayCurrent(c,false) || c.epoch!==h.epoch)return null;
    if(event.type!==4&&event.type!==2)return null;
    var heatmap = h;
    /** @type {Ten98Tracker.BackgroundRef} */
    var ref={hash:null,location:null,acks:0,total:1};
    backgroundHash(new TextEncoder().encode(JSON.stringify({type:event.type,timestamp:event.timestamp,data:event.data})),function(value){ref.hash=value;if(value)void heatmapBackgroundPump(heatmap);});
    if(event.type===4){c.backgroundMeta={ref:ref,href:event.data.href,width:event.data.width,height:event.data.height,timestamp:event.timestamp};return ref;}
    var meta=c.backgroundMeta,fact=heatmapGeometry(),offset=performance.now()-h.start;
    if(!meta||meta.href!==h.url||meta.timestamp>event.timestamp||!fact||![meta.width,meta.height].every(function(value){return Number.isInteger(value)&&value>=1&&value<=heatmapLimits.viewport;})||meta.width!==window.innerWidth||meta.height!==window.innerHeight||meta.width<fact.geometry.viewportWidth||meta.height<fact.geometry.viewportHeight||!Number.isFinite(offset)||offset<0||offset>300000)return ref;
    var plane=JSON.stringify(fact.geometry);
    if(h.backgroundPlans.length>=256||h.backgroundPlans.some(function(p){return p.plane===plane;}))return ref;
    /** @type {Ten98Tracker.BackgroundPlan} */
    var plan={requestId:uuid(),replay:c,meta:meta.ref,snapshot:ref,geometry:fact.geometry,plane:plane,geometryKey:null,offset:offset,sent:false};
    h.backgroundPlans.push(plan);backgroundHash(new TextEncoder().encode(plane),function(key){plan.geometryKey=key;if(key)void heatmapBackgroundPump(heatmap);});
    return ref;
  }
  /** @param {Ten98Tracker.HeatmapCapture} h @param {string} plane */
  function requestHeatmapSnapshot(h,plane) {
    var r=h.state.replayCapture,shared=hub();
    if(!r||!r.started||!replayCurrent(r,false)||!heatmapCurrent(h,false)||r.epoch!==h.epoch||h.backgroundRequested[plane]||
      h.backgroundPlans.some(function(p){return p.plane===plane;})||!shared||!shared.takeReplaySnapshot||shared.takeReplaySnapshot.protocolVersion!==1)return;
    h.backgroundRequested[plane]=true; // At most one real rrweb checkout per accepted capture/layout.
    shared.takeReplaySnapshot();
  }
  /** @param {Ten98Tracker.HeatmapCapture} h */
  async function heatmapBackgroundPump(h) {
    if(h.sending||h.backgroundSending||h.queue.length||!heatmapCurrent(h,false))return;
    var plan=h.backgroundPlans.find(function(p){return !p.sent&&p.geometryKey&&h.backgroundBatches[p.plane]&&backgroundLocator(p.meta)&&backgroundLocator(p.snapshot)&&replayCurrent(p.replay,false);});
    if(!plan)return;h.backgroundSending=true;plan.sent=true;
    try{
      var r=plan.replay;
      // Plans exist only after both begin replies and a recorder event were accepted.
      var recording = /** @type {Ten98Tracker.ActiveReplayRecord} */ (r.record);
      var acceptedHeatmap = /** @type {Ten98Tracker.HeatmapReply} */ (h.reply);
      var body=JSON.stringify({siteKey:h.state.siteKey,requestId:plan.requestId,url:h.url,consent:{analytics:true,replay:true,epoch:h.epoch},
        captureId:acceptedHeatmap.captureId,heatmapToken:acceptedHeatmap.token,recordingId:recording.reply.recordingId,replayToken:recording.reply.token,batchRequestId:h.backgroundBatches[plan.plane],
        geometryKey:plan.geometryKey,geometry:plan.geometry,heatmapOffsetMs:plan.offset,meta:backgroundLocator(plan.meta),snapshot:backgroundLocator(plan.snapshot)});
      if(new TextEncoder().encode(body).length>4096)return;
      for(var attempt=0;attempt<2&&heatmapCurrent(h,false)&&replayCurrent(r,false);attempt++){
        var result;try{result=await heatmapRequest(h,'/api/heatmaps/backgrounds',body);}catch(_){continue;}
        if(result.status===202&&replayKeys(result.value,['accepted','duplicate','requestId'])&&result.value.accepted===true&&typeof result.value.duplicate==='boolean'&&result.value.requestId===plan.requestId)break;
        if([400,401,403,409,413].includes(result.status))break;
      }
    }catch(_){/* An optional background failure never stops independent numeric collection. */}
    finally{h.backgroundSending=false;if(h.active&&h.queue.length)void heatmapPump(h);else if(h.active)void heatmapBackgroundPump(h);}
  }
  /** @param {Ten98Tracker.HeatmapCapture} c @param {boolean} drain */
  function heatmapCurrent(c, drain) {
    return c.active && c.state.heatmapCapture === c && !c.state.heatmapHidden && c.state.nativeGeneration === c.generation && c.state.config && c.state.config.consentEpoch === c.epoch &&
      c.state.config.nativeTracking.heatmap && c.state.config.nativeTracking.heatmap.enabled === true && c.state.config.nativeTracking.heatmap.sampleRate === c.settings.sampleRate &&
      nativeReady(c.state,true) && (currentUrl() === c.url || drain && c.nextUrl === currentUrl()) && performance.now() < c.start + (drain ? 360000 : 300000);
  }
  /** @param {Ten98Tracker.HeatmapCapture} c */
  function heatmapUnlisten(c) {
    if (!c.click) return;
    document.removeEventListener('click',c.click,true); window.removeEventListener('scroll',/** @type {(event:Event)=>void} */ (c.scroll),true); window.removeEventListener('resize',/** @type {()=>void} */ (c.resize));
    c.click = c.scroll = c.resize = null;
  }
  /** @param {Ten98Tracker.State} state @param {Ten98Tracker.HeatmapCapture} [expected] */
  function stopHeatmap(state, expected) {
    var c = expected || state.heatmapCapture;
    if (!c || expected && state.heatmapCapture !== expected) return;
    c.active = false; heatmapUnlisten(c); clearInterval(c.flushTimer); clearTimeout(c.endTimer);
    if (c.controller) c.controller.abort(); c.queue.length = c.parts.length = 0; c.queuedBytes = 0;
    c.backgroundPlans=[];c.backgroundBatches={};c.backgroundRequested={};c.reply = null; // Keep the terminal sampling marker, never its upload capability.
  }
  /** @returns {Ten98Tracker.GeometryFact|null} */
  function heatmapGeometry() {
    var root = document.scrollingElement, style = root && getComputedStyle(root), visual = window.visualViewport;
    if (!root || !style || style.writingMode !== 'horizontal-tb' || !['ltr','rtl'].includes(style.direction) || visual && (visual.scale !== 1 || visual.offsetLeft !== 0 || visual.offsetTop !== 0)) return null;
    var w=root.scrollWidth,h=root.scrollHeight,vw=root.clientWidth,vh=root.clientHeight,sx=window.scrollX,sy=window.scrollY;
    if (![w,h,vw,vh,sx,sy].every(Number.isFinite) || w<1 || h<1 || w>10000000 || h>10000000 || vw<1 || vh<1 || vw>20000 || vh>20000 || w<vw || h<vh || sy<0 || sy>h-vh) return null;
    var left=sx+(style.direction==='rtl'?w-vw:0);
    // Retain the measured Edge RTL root-zoom endpoint, including its physical one-pixel offset.
    if (left<0 || left>w-vw && !(style.direction==='rtl' && sx>0 && sx<=1)) return null;
    return {geometry:{basis:'document-css-v1',direction:/** @type {'ltr'|'rtl'} */ (style.direction),pageWidth:w,pageHeight:h,viewportWidth:vw,viewportHeight:vh},scrollX:sx,scrollY:sy,left:left};
  }
  /** @param {Ten98Tracker.HeatmapCapture} c @param {string} path @param {string} body @returns {Promise<{status:number;value:unknown}>} */
  async function heatmapRequest(c,path,body) {
    var controller=new AbortController();c.controller=controller;
    var timer=setTimeout(function(){controller.abort();},5000),/** @type {Promise<never>} */ cancelled=new Promise(function(_,reject){controller.signal.addEventListener('abort',function(){reject(new Error('Heatmap request cancelled.'));},{once:true});});
    try{return await Promise.race([cancelled,(async function(){
      if(!heatmapCurrent(c,c.ending))throw new Error('Heatmap permission changed.');
      var response=await fetch(c.state.origin+path,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',mode:'cors',cache:'no-store',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:body});
      var text=await readNativeResponse(response,controller.signal,8192);if(!heatmapCurrent(c,c.ending))throw new Error('Heatmap permission changed.');return{status:response.status,value:JSON.parse(text)};
    })()]);}finally{clearTimeout(timer);if(c.controller===controller)c.controller=null;}
  }
  /** @param {unknown} raw @param {Ten98Tracker.HeatmapCapture} c @returns {raw is Ten98Tracker.HeatmapReply} */
  function heatmapReply(raw,c) {
    var v = /** @type {Ten98Tracker.HeatmapReply} */ (raw);
    if(!replayKeys(v,['accepted','reason','captureId','token','createdAt','deadlineAt','uploadUntil','settings','limits']) || typeof v.accepted!=='boolean' || typeof v.captureId!=='string' || !replayUuid.test(v.captureId) || v.captureId.length!==36 || v.reason!==(v.accepted?null:'not_sampled') ||
      (v.accepted?typeof v.token!=='string'||v.token.length>4096||!/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(v.token):v.token!==null) ||
      !replayKeys(v.settings,['enabled','sampleRate']) || v.settings.enabled!==true || v.settings.sampleRate!==c.settings.sampleRate || !replayKeys(v.limits,Object.keys(heatmapLimits)) || Object.keys(heatmapLimits).some(function(k){return v.limits[k]!==heatmapLimits[k];}))return false;
    return /** @type {('createdAt'|'deadlineAt'|'uploadUntil')[]} */ (['createdAt','deadlineAt','uploadUntil']).every(function(k){try{return new Date(v[k]).toISOString()===v[k];}catch(_){return false;}}) && Date.parse(v.deadlineAt)-Date.parse(v.createdAt)===300000 && Date.parse(v.uploadUntil)-Date.parse(v.deadlineAt)===60000;
  }
  /** @param {Ten98Tracker.HeatmapCapture} c */
  function heatmapFlush(c) {
    if(!c.parts.length)return;
    // Parts can be added only by listeners installed after the accepted begin reply.
    var accepted = /** @type {Ten98Tracker.HeatmapReply} */ (c.reply);
    var requestId=uuid(),body=JSON.stringify({siteKey:c.state.siteKey,requestId:requestId,url:c.url,consent:{analytics:true,epoch:c.epoch},captureId:accepted.captureId,token:accepted.token,geometry:c.geometry,observations:c.parts}),bytes=new TextEncoder().encode(body).length;
    if(bytes>32768 || c.queuedBytes+bytes>8388608 || c.usedBytes+c.queuedBytes+bytes>8388608 || c.usedBatches+c.queue.length>=256)throw new Error('Heatmap capacity reached.');
    c.queue.push({body:body,bytes:bytes,requestId:requestId,geometry:c.geometry});c.queuedBytes+=bytes;c.parts=[];
  }
  /** @param {Ten98Tracker.HeatmapCapture} c */
  async function heatmapPump(c) {
    if(c.sending || c.backgroundSending || !c.reply || !heatmapCurrent(c,c.ending))return;if(!c.queue.length){void heatmapBackgroundPump(c);return;}
    c.sending=true;
    try{
      var entry=c.queue[0],accepted=false;
      for(var attempt=0;attempt<2&&heatmapCurrent(c,c.ending);attempt++){
        var result;try{result=await heatmapRequest(c,'/api/heatmaps/batches',entry.body);}catch(_){continue;}
        var v=result.value;if(result.status===202&&replayKeys(v,['accepted','duplicate','requestId'])&&v.accepted===true&&typeof v.duplicate==='boolean'&&v.requestId===entry.requestId){accepted=true;break;}
        if([400,401,403,409,413].includes(result.status))break;
      }
      if(!accepted || !heatmapCurrent(c,c.ending))throw new Error('Heatmap outcome is unknown.');
      c.queue.shift();c.queuedBytes-=entry.bytes;c.usedBytes+=entry.bytes;c.usedBatches++;var plane=JSON.stringify(entry.geometry);c.backgroundBatches[plane]=entry.requestId;requestHeatmapSnapshot(c,plane);
    }catch(_){stopHeatmap(c.state,c);}finally{c.sending=false;}
    if(c.active&&c.queue.length)void heatmapPump(c);else if(c.active&&!c.ending)void heatmapBackgroundPump(c);
    else if(c.active&&c.ending){var next=c.nextUrl;stopHeatmap(c.state,c);if(next===currentUrl()&&!c.state.heatmapRestartRequired){c.state.heatmapCapture=null;startHeatmap(c.state);}}
  }
  /** @param {Ten98Tracker.HeatmapCapture} c @param {string} [nextUrl] */
  function heatmapFinish(c,nextUrl) {
    if(!c.active || c.state.heatmapCapture!==c)return;
    if(!heatmapCurrent(c,true)){stopHeatmap(c.state,c);return;}
    c.ending=true;c.nextUrl=nextUrl||null;heatmapUnlisten(c);clearInterval(c.flushTimer);clearTimeout(c.endTimer);
    c.endTimer=setTimeout(function(){stopHeatmap(c.state,c);},Math.max(0,c.start+360000-performance.now()));
    try{heatmapFlush(c);if(c.queue.length)void heatmapPump(c);else{stopHeatmap(c.state,c);if(nextUrl===currentUrl()){c.state.heatmapCapture=null;startHeatmap(c.state);}}}catch(_){stopHeatmap(c.state,c);}
  }
  /** @param {Ten98Tracker.HeatmapCapture} c @param {Event} event @param {"click"|"scroll"} kind */
  function heatmapObserve(c,event,kind) {
    try{
      if(!heatmapCurrent(c,false)){if(heatmapCurrent(c,true)&&performance.now()>=c.start+300000)heatmapFinish(c);else stopHeatmap(c.state,c);return;}
      if(!event || event.isTrusted!==true || kind==='click'&&(/** @type {MouseEvent} */ (event).button!==0||/** @type {MouseEvent} */ (event).detail<1) || kind==='scroll'&&event.target!==document&&event.target!==window&&event.target!==document.scrollingElement)return;
      var fact=heatmapGeometry();if(!fact){stopHeatmap(c.state,c);return;}var geometry=fact.geometry;
    /** @type {Ten98Tracker.HeatmapPoint} */ var point={kind:kind,scrollX:fact.scrollX,scrollY:fact.scrollY,offsetMs:performance.now()-c.start};
      if(!Number.isFinite(point.offsetMs)||point.offsetMs<c.lastOffset||point.offsetMs>300000){stopHeatmap(c.state,c);return;}
      if(kind==='click'){
        var pointer = /** @type {MouseEvent} */ (event);
        if(!Number.isFinite(pointer.clientX)||!Number.isFinite(pointer.clientY)||pointer.clientX<0||pointer.clientY<0||pointer.clientX>geometry.viewportWidth||pointer.clientY>geometry.viewportHeight)return;
        point.x=pointer.clientX+fact.left;point.y=pointer.clientY+fact.scrollY;point.clientX=pointer.clientX;point.clientY=pointer.clientY;
        if(point.x<0||point.x>geometry.pageWidth||point.y<0||point.y>geometry.pageHeight)return;
      }
      if(c.geometry&&JSON.stringify(c.geometry)!==JSON.stringify(geometry))heatmapFlush(c);
      c.geometry=geometry;c.lastOffset=point.offsetMs;c.parts.push(point);
      if(c.parts.length>=20)heatmapFlush(c);void heatmapPump(c);
    }catch(_){stopHeatmap(c.state,c);}
  }
  /** @param {Ten98Tracker.State} state @param {boolean} [fresh] */
  function startHeatmap(state,fresh) {
    var h=hub(),settings=state.config&&state.config.nativeTracking.heatmap;
    if(h){if(!h.heatmapStates)h.heatmapStates=[];if(!h.heatmapStates.includes(state))h.heatmapStates.push(state);}
    if(fresh&&state.heatmapCapture&&!state.heatmapCapture.active)state.heatmapCapture=null; // Only an explicit new grant clears a revoked capture.
    if(!h || !settings || settings.enabled!==true || !nativeReady(state,true) || state.heatmapCapture || state.heatmapRestartRequired || state.heatmapHidden || typeof performance==='undefined' || typeof performance.now!=='function' || typeof fetch!=='function' || typeof TextEncoder!=='function' || typeof TextDecoder!=='function' || typeof ReadableStream!=='function' || typeof AbortController!=='function')return;
    if(!heatmapGeometry())return;
    /** @type {Ten98Tracker.HeatmapCapture} */
    var c={state:state,url:currentUrl(),epoch:state.config.consentEpoch,generation:state.nativeGeneration,settings:{enabled:true,sampleRate:settings.sampleRate},start:performance.now(),active:true,queue:[],parts:[],queuedBytes:0,usedBytes:0,usedBatches:0,lastOffset:0,sending:false,ending:false,reply:null,backgroundPlans:[],backgroundBatches:{},backgroundRequested:{},backgroundSending:false};state.heatmapCapture=c;
    (async function(){try{
      var body=JSON.stringify({siteKey:state.siteKey,requestId:uuid(),url:c.url,consent:{analytics:true,epoch:c.epoch}}),result;
      for(var attempt=0;attempt<2&&heatmapCurrent(c,false);attempt++){try{result=await heatmapRequest(c,'/api/heatmaps/begin',body);}catch(_){result=null;}if(result&&(result.status===202&&heatmapReply(result.value,c)||[400,401,403,409,413].includes(result.status)))break;result=null;}
      if(!result||result.status!==202||!heatmapReply(result.value,c)||!heatmapCurrent(c,false))throw new Error('Heatmap Begin is unknown.');c.reply=result.value;
      if(!c.reply.accepted){stopHeatmap(state,c);return;}
      c.click=function(e){heatmapObserve(c,e,'click');};c.scroll=function(e){heatmapObserve(c,e,'scroll');};c.resize=function(){try{if(heatmapCurrent(c,false)){heatmapFlush(c);void heatmapPump(c);}else stopHeatmap(state,c);}catch(_){stopHeatmap(state,c);}};
      document.addEventListener('click',c.click,true);window.addEventListener('scroll',c.scroll,true);window.addEventListener('resize',c.resize);
      c.flushTimer=setInterval(function(){if(!heatmapCurrent(c,false)){if(heatmapCurrent(c,true)&&performance.now()>=c.start+300000)heatmapFinish(c);else stopHeatmap(state,c);return;}try{heatmapFlush(c);void heatmapPump(c);}catch(_){stopHeatmap(state,c);}},2000);
      c.endTimer=setTimeout(function(){heatmapFinish(c);},Math.max(0,c.start+300000-performance.now()));
    }catch(_){stopHeatmap(state,c);}})();
  }
  /** @param {Ten98Tracker.BootstrapHub} h */
  function heatmapNavigation(h) {
    (h.heatmapStates||[]).forEach(function(state){var c=state.heatmapCapture;if(!c)return;if(!nativeReady(state,true)){state.heatmapRestartRequired=true;stopHeatmap(state,c);return;}if(c.url===currentUrl())return;
      if(c.active&&c.reply){c.nextUrl=currentUrl();heatmapFinish(c,c.nextUrl);}else{stopHeatmap(state,c);state.heatmapCapture=null;}
    });
  }

  /** @param {Ten98Tracker.ReplayCapture} c @param {boolean} draining */
  function replayCurrent(c, draining) {
    var h = hub();
    // Every caller reaches this phase only after stored/default record validation.
    var record = /** @type {Ten98Tracker.ReplayRecord} */ (c.record);
    return c.active && c.state.replayCapture === c && c.state.nativeGeneration === c.generation && c.state.config && c.state.config.consentEpoch === c.epoch &&
      h && h.replayAllowed && h.replayAllowed.protocolVersion === 3 && h.replayAllowed(c.state) && nativeReady(c.state, true) &&
      Date.now() < (draining ? Math.min(record.localDeadline + 60000, Date.parse(/** @type {Ten98Tracker.ReplayReply} */ (record.reply).uploadUntil)) : record.localDeadline);
  }
  /** @param {Ten98Tracker.ReplayCapture} c */
  function replaySave(c) {
    var value = JSON.stringify(c.record);
    sessionStorage.setItem(c.key, value);
    if (sessionStorage.getItem(c.key) !== value) throw new Error('Replay tab storage is unavailable.');
  }
  /** @param {Ten98Tracker.State} state @param {boolean} erase @param {boolean} [terminal] */
  function stopReplay(state, erase, terminal) {
    var c = state.replayCapture;
    if (c) {
      c.active = false; clearInterval(c.flushTimer); clearTimeout(c.endTimer);
      if (c.controller) c.controller.abort();
      var stop = c.stop; c.stop = null; try { if (stop) stop(); } catch (_) {}
      if (hub() && /** @type {Ten98Tracker.BootstrapHub} */ (hub()).replayOwner === c) /** @type {Ten98Tracker.BootstrapHub} */ (hub()).replayOwner = null;
      c.queue.length = 0; c.parts.length = 0;c.partReferences.length=0;c.backgroundMeta=null;c.queuedBytes = c.partBytes = 0; c.partNodes = 1;
      if (terminal && c.record) try { var terminalRecord = /** @type {Record<string,unknown>} */ (c.record); terminalRecord.terminal = true; if (terminalRecord.reply && typeof terminalRecord.reply==='object') /** @type {Record<string,unknown>} */ (terminalRecord.reply).token = null; replaySave(c); } catch (_) {}
    }
    if (erase) { if (c) try { sessionStorage.removeItem(c.key); } catch (_) {} state.replayCapture = null; state.replayResumeRequest = null; }
  }
  /** @param {Ten98Tracker.ReplayCapture} c */
  function replayFail(c) { var allowed=false;try{allowed=/** @type {NonNullable<Ten98Tracker.BootstrapHub["replayAllowed"]>} */ (/** @type {Ten98Tracker.BootstrapHub} */ (hub()).replayAllowed)(c.state)&&nativeReady(c.state,true);}catch(_){}stopReplay(c.state,!allowed,true); }
  /** @param {unknown} value @param {string[]} names @returns {value is Record<string,unknown>} */
  function replayKeys(value, names) { return !!(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); })); }
  // Exact same keys and primitive values in any order: the begin reply's settings come back from JSONB with reordered keys.
  /** @param {unknown} value @param {Ten98Tracker.ReplaySettings} settings */
  function replaySameSettings(value, settings) { var expected = /** @type {Record<string,unknown>} */ (/** @type {unknown} */ (settings)), names = Object.keys(expected); return replayKeys(value,names) && names.every(function (key) { return value[key] === expected[key]; }); }
  /** @param {unknown} raw @param {Ten98Tracker.ReplaySettings} settings @param {boolean} [terminal] @returns {raw is Ten98Tracker.ReplayReply} */
  function replayReply(raw, settings, terminal) {
    var value = /** @type {Ten98Tracker.ReplayReply} */ (raw);
    if (!replayKeys(value,['accepted','reason','recordingId','token','createdAt','deadlineAt','uploadUntil','settings','limits']) || typeof value.accepted !== 'boolean' ||
      typeof value.recordingId !== 'string' || value.recordingId.length!==36 || !replayUuid.test(value.recordingId) || value.reason !== (value.accepted ? null : 'not_sampled') ||
      (value.accepted ? !(terminal && value.token === null) && (typeof value.token !== 'string' || value.token.length > 4096 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value.token)) : value.token !== null) ||
      !replaySameSettings(value.settings,settings) || !replayKeys(value.limits,Object.keys(replayLimits)) || Object.keys(replayLimits).some(function (key) { return value.limits[key] !== replayLimits[key]; })) return false;
    return /** @type {('createdAt'|'deadlineAt'|'uploadUntil')[]} */ (['createdAt','deadlineAt','uploadUntil']).every(function (key) { try { return new Date(value[key]).toISOString() === value[key]; } catch (_) { return false; } }) &&
      Date.parse(value.deadlineAt)-Date.parse(value.createdAt) === settings.maxDurationMs && Date.parse(value.uploadUntil)-Date.parse(value.deadlineAt) === 60000;
  }
  /** @param {unknown} raw @param {Ten98Tracker.State} state @param {Ten98Tracker.ReplaySettings} settings @returns {raw is Ten98Tracker.ReplayRecord} */
  function replayStored(raw, state, settings) {
    var value = /** @type {Ten98Tracker.ReplayRecord} */ (raw);
    return replayKeys(value,['version','siteKey','collector','origin','epoch','settings','requestId','beginUrl','localDeadline','nextSequence','usedBytes','terminal','reply']) && value.version === 1 &&
      value.siteKey === state.siteKey && value.collector === state.origin && value.origin === location.origin && value.epoch === /** @type {Ten98Tracker.PublicConfig} */ (state.config).consentEpoch && replaySameSettings(value.settings,settings) &&
      typeof value.requestId==='string' && value.requestId.length===36 && replayUuid.test(value.requestId) && typeof value.beginUrl === 'string' && value.beginUrl.length <= 4096 && new URL(value.beginUrl).origin === location.origin && !new URL(value.beginUrl).username && !new URL(value.beginUrl).password && !/[?#]/.test(value.beginUrl) &&
      Number.isFinite(value.localDeadline) && value.localDeadline <= Date.now()+settings.maxDurationMs && Number.isSafeInteger(value.nextSequence) && value.nextSequence >= 0 && value.nextSequence <= 1024 && Number.isSafeInteger(value.usedBytes) && value.usedBytes >= 0 && value.usedBytes <= 67108864 &&
      typeof value.terminal === 'boolean' && (value.reply === null || replayReply(value.reply, settings, value.terminal) && value.localDeadline <= Date.parse(value.reply.deadlineAt));
  }
  /** @param {Uint8Array<ArrayBuffer>} bytes */
  function replayBase64(bytes) {
    var text = ''; for (var i = 0; i < bytes.length; i += 16384) text += String.fromCharCode.apply(null, /** @type {number[]} */ (/** @type {unknown} */ (bytes.subarray(i,i+16384))));
    return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  /** @param {Ten98Tracker.ReplayCapture} c @param {string} path @param {string} body @param {number} limit @returns {Promise<{status:number;value:unknown}>} */
  async function replayRequest(c, path, body, limit) {
    var controller = new AbortController(); c.controller = controller;
    var timer = setTimeout(function () { controller.abort(); }, 5000);
    /** @type {Promise<never>} */ var cancelled = new Promise(function (_, reject) { controller.signal.addEventListener('abort',function () { reject(new Error('Replay request cancelled.')); },{once:true}); });
    try { return await Promise.race([cancelled,(async function () {
      if (!replayCurrent(c, c.finishing)) throw new Error('Replay permission changed.');
      var response = await fetch(c.state.origin + path, {method:'POST',credentials:'omit',referrerPolicy:'no-referrer',mode:'cors',cache:'no-store',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:body});
      var text = await readNativeResponse(response,controller.signal,limit);
      if (!replayCurrent(c,c.finishing)) throw new Error('Replay permission changed.');
      return {status:response.status,value:JSON.parse(text)};
    })()]); } finally { clearTimeout(timer); if (c.controller === controller) c.controller = null; }
  }
  /** @param {Ten98Tracker.ReplayCapture} c */
  function replayFlush(c) {
    if (!c.parts.length) return;
    var bytes = new TextEncoder().encode('[' + c.parts.join(',') + ']');
    var references=c.partReferences.splice(0);c.parts.length = 0; c.partBytes = 0; c.partNodes = 1; c.queue.push({bytes:bytes,final:false,references:references}); c.queuedBytes += bytes.length;
  }
  /** @param {Ten98Tracker.ReplayCapture} c */
  async function replayPump(c) {
    if (c.sending || !c.started || !c.queue.length || !replayCurrent(c,c.finishing)) return;
    c.sending = true;
    try {
      var chunk = c.queue[0], record = /** @type {Ten98Tracker.ActiveReplayRecord} */ (c.record);
      if (record.nextSequence >= 1024 || record.usedBytes + chunk.bytes.length > 67108864) throw new Error('Replay capacity reached.');
      var sequence = record.nextSequence++, prefix = new TextEncoder().encode(sequence + ':' + chunk.final + ':'), signed = new Uint8Array(prefix.length + chunk.bytes.length); signed.set(prefix); signed.set(chunk.bytes,prefix.length);
      record.usedBytes += chunk.bytes.length; replaySave(c); // Reserve a sequence before sending: a navigation can leave an explicit gap, never a reused sequence.
      var hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',signed)),function (v) { return v.toString(16).padStart(2,'0'); }).join('');
      var body = JSON.stringify({siteKey:c.state.siteKey,url:currentUrl(),consent:{analytics:true,replay:true,epoch:c.epoch},token:record.reply.token,sequence:sequence,final:chunk.final,data:replayBase64(chunk.bytes)}), accepted = false;
      for (var attempt = 0; attempt < 2 && replayCurrent(c,c.finishing); attempt++) {
        var result;
        try { result = await replayRequest(c,'/api/replay/chunks',body,2048); } catch (_) { continue; }
        var value = result.value;
        if (result.status === 202 && replayKeys(value,['accepted','duplicate','recordingId','sequence','sha256','complete']) && value.accepted === true && typeof value.duplicate === 'boolean' && typeof value.complete === 'boolean' && value.recordingId === record.reply.recordingId && value.sequence === sequence && value.sha256 === hash) { accepted = true; break; }
        if ([400,403,409,413].includes(result.status)) break;
      }
      if (!accepted || !replayCurrent(c,c.finishing)) throw new Error('Replay chunk outcome is incomplete.');
      (chunk.references||[]).forEach(function(part){part.ref.acks++;if(!part.ref.location)part.ref.location={kind:'event',sequence:sequence,index:part.index,chunkSha256:hash};});c.queue.shift(); c.queuedBytes -= chunk.bytes.length;var heat=c.state.heatmapCapture;if(heat)void heatmapBackgroundPump(heat);
      if (chunk.final) { stopReplay(c.state,false,true); return; }
    } catch (_) { if (c.active) replayFail(c); }
    finally { c.sending = false; }
    if (c.active) void replayPump(c);
  }
  /** @param {Ten98Tracker.ReplayCapture} c @param {string} text @param {Ten98Tracker.BackgroundRef|null} [reference] */
  function replayPart(c, text, reference) {
    var size = new TextEncoder().encode(text).length, pending = /** @type {{value:unknown;depth:number}[]} */ ([{value:JSON.parse(text),depth:1}]), nodes = 0;
    if (size + 2 > 262144) return false;
    while (pending.length) { var item = /** @type {{value:unknown;depth:number}} */ (pending.pop()); if (++nodes + 1 > replayLimits.nodes || item.depth > replayLimits.depth) return false; if (item.value && typeof item.value === 'object') Object.keys(item.value).forEach(function (key) { pending.push({value:/** @type {Record<string,unknown>} */ (item.value)[key],depth:item.depth+1}); }); }
    if (c.parts.length >= 200 || c.partBytes + size + c.parts.length + 2 > 262144 || c.partNodes + nodes > replayLimits.nodes) replayFlush(c);
    if (c.queuedBytes + (c.partBytes + size + c.parts.length + 2) * 2 > replayMemoryLimit) throw new Error('Replay memory queue is full.');
    if(reference)c.partReferences.push({ref:reference,index:c.parts.length});c.parts.push(text); c.partBytes += size; c.partNodes += nodes; return true;
  }
  /** @param {Ten98Tracker.ReplayCapture} c @param {Ten98Tracker.RecorderEvent} event */
  function replayEmit(c, event) {
    try {
      if (c.finishing) return;
      if (!replayCurrent(c,false)) { if (c.active) { if (Date.now() >= /** @type {Ten98Tracker.ReplayRecord} */ (c.record).localDeadline) finishReplay(c); else replayFail(c); } return; }
      if (!replayKeys(event,['type','timestamp','data']) || !Number.isInteger(event.type) || event.type < 0 || event.type > 4 || !Number.isSafeInteger(event.timestamp) || event.timestamp < 0 || event.timestamp > 8640000000000000 || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw new Error('Invalid recorder event.');
      if (event.type === 4) { var u = new URL(event.data.href); if (u.origin !== location.origin || /[?#]/.test(event.data.href)) throw new Error('Invalid recorder URL.'); }
      var text = JSON.stringify(event), bytes = new TextEncoder().encode(text),reference=null;
      if (bytes.length > 4194304) throw new Error('Replay event is too large.');reference=backgroundSnapshot(c,event,bytes);
      if (bytes.length + 2 > 262144 || !replayPart(c,text,reference))
      { var id = uuid(), size = 180000, total = Math.ceil(bytes.length/size); if (total > 64) throw new Error('Too many replay fragments.');if(reference){reference.total=total;reference.location={kind:'fragment',fragmentId:id};} for (var i=0;i<total;i++) if(!replayPart(c,JSON.stringify({type:'fragment',id:id,index:i,total:total,data:replayBase64(bytes.subarray(i*size,(i+1)*size))}),reference)) throw new Error('Replay fragment exceeds chunk limits.'); }
      if (c.parts.length >= 200) replayFlush(c);
      void replayPump(c);
    } catch (_) { replayFail(c); }
  }
  /** @param {Ten98Tracker.ReplayCapture} c */
  function finishReplay(c) {
    if (c.finishing || !c.active || c.state.replayCapture !== c) return;
    if (!replayCurrent(c,true)) { replayFail(c); return; }
    c.finishing = true; clearInterval(c.flushTimer); var stop = c.stop; c.stop = null; try { if (stop) stop(); } catch (_) {}
    c.endTimer=setTimeout(function(){if(c.active&&c.state.replayCapture===c)stopReplay(c.state,false,true);},Math.max(0,Math.min(/** @type {Ten98Tracker.ActiveReplayRecord} */ (c.record).localDeadline+60000,Date.parse(/** @type {Ten98Tracker.ActiveReplayRecord} */ (c.record).reply.uploadUntil))-Date.now()));
    replayFlush(c);
    // A dispatched chunk's hash/body never changes; final uses an unsent tail or a new empty chunk.
    if (!c.queue.length || c.sending && c.queue.length === 1) { if(c.queuedBytes+2>replayMemoryLimit){replayFail(c);return;}c.queue.push({bytes:new TextEncoder().encode('[]'),final:true}); c.queuedBytes += 2; }
    else c.queue[c.queue.length-1].final = true;
    void replayPump(c);
  }
  /** @param {Ten98Tracker.BootstrapHub} h */
  function replayNavigation(h) {
    (h.replayStates || []).forEach(function (state) {
      var c = state.replayCapture;
      if (replayPathExcluded(state)) { state.replayDocumentBlocked = true; stopReplay(state,true); return; }
      if (!c || !c.active) return;
      try { if (!nativeReady(state,true)) { state.replayDocumentBlocked = true; stopReplay(state,true); } } catch (_) { state.replayDocumentBlocked = true; stopReplay(state,true); }
    });
  }
  /** @param {Ten98Tracker.State} state */
  function replayPathExcluded(state) { try { return /** @type {Ten98Tracker.PublicConfig} */ (state.config).nativeTracking.excludedPaths.some(function (path) { return decodeURIComponent(location.pathname).startsWith(decodeURIComponent(path)); }); } catch (_) { return true; } }
  /** @param {Ten98Tracker.BootstrapHub} h */
  function hideReplay(h) {
    (h.replayStates || []).forEach(function (state) {
      var c = state.replayCapture;
      if (!c || !c.active) return;
      var record = /** @type {Ten98Tracker.ReplayRecord} */ (c.record);
      // Ordinary navigation never invents a final receipt or persists DOM. Lost unsent bytes reserve gaps.
      try { replayFlush(c); var unsent = c.queue.slice(c.sending?1:0),next=record.nextSequence+unsent.length,used=record.usedBytes+unsent.reduce(function(n,chunk){return n+chunk.bytes.length;},0);if(next>1024||used>67108864)throw new Error('Replay capacity reached.');record.nextSequence=next;record.usedBytes=used;replaySave(c);stopReplay(state,false);state.replayResumeRequest=record.requestId;if(state.replayCapture===c&&!c.active)state.replayCapture=null; }
      catch (_) { replayFail(c); }
    });
  }
  /** @param {Ten98Tracker.State} state */
  function startReplay(state) {
    var h = hub(), settings = state.config && state.config.nativeTracking.replay;
    if (h && settings) { if (!h.replayStates) h.replayStates=[]; if(!h.replayStates.includes(state))h.replayStates.push(state); if(replayPathExcluded(state)){state.replayDocumentBlocked=true;return;} }
    if (!h || !h.replayAllowed || h.replayAllowed.protocolVersion !== 3 || !h.replayAllowed(state) || !nativeReady(state,true) || state.replayCapture || state.replayDocumentBlocked || state.replayRestartRequired || state.replayOwnerSkipped || typeof crypto==='undefined' || !crypto.subtle || typeof btoa !== 'function' || typeof TextEncoder!=='function' || typeof TextDecoder!=='function' || typeof AbortController!=='function' || typeof ReadableStream!=='function' || typeof fetch!=='function') return;
    var activeSettings = /** @type {Ten98Tracker.ReplaySettings} */ (settings);
    var activeHub = h;
    // ponytail: rrweb owns one document mirror; one authorized site records, other sites keep analytics only until a new document.
    if (h.replayOwner && h.replayOwner.active) { state.replayOwnerSkipped = true; return; }
    /** @type {Ten98Tracker.ReplayCapture} */
    var c = {state:state,generation:state.nativeGeneration,epoch:state.config.consentEpoch,key:'ten98:replay:v1:'+state.origin+':'+state.siteKey+':'+state.environment,active:true,queue:[],parts:[],partReferences:[],partBytes:0,partNodes:1,queuedBytes:0,started:false,sending:false,finishing:false};
    state.replayCapture = c; h.replayOwner = c;
    try {
      var stored = sessionStorage.getItem(c.key);
      if (stored !== null) { c.record = /** @type {unknown} */ (JSON.parse(stored)); if (!replayStored(c.record,state,activeSettings) || state.replayResumeRequest && c.record.requestId !== state.replayResumeRequest) throw new Error('Invalid replay tab capability.'); }
      else { if(state.replayResumeRequest)throw new Error('Replay resume capability is unavailable.'); c.record = {version:1,siteKey:state.siteKey,collector:state.origin,origin:location.origin,epoch:c.epoch,settings:activeSettings,requestId:uuid(),beginUrl:currentUrl(),localDeadline:Date.now()+activeSettings.maxDurationMs,nextSequence:0,usedBytes:0,terminal:false,reply:null}; replaySave(c); }
      // The validation or fresh record above establishes this value before asynchronous work.
      var record = /** @type {Ten98Tracker.ReplayRecord} */ (c.record);
      if (record.terminal || Date.now() >= record.localDeadline) { replayFail(c); return; }
    } catch (_) { replayFail(c); return; }
    (async function () {
      try {
        if (!record.reply) {
          var body = JSON.stringify({siteKey:state.siteKey,requestId:record.requestId,url:record.beginUrl,consent:{analytics:true,replay:true,epoch:c.epoch}}), result;
          for (var attempt=0;attempt<2 && replayCurrent(c,false);attempt++) { try { result=await replayRequest(c,'/api/replay/begin',body,8192); } catch (_) { result=null; } if (result && (result.status===202 && replayReply(result.value,activeSettings,false) || [400,403,409,413].includes(result.status))) break; result=null; }
          if (!result || result.status!==202 || !replayReply(result.value,activeSettings,false) || !replayCurrent(c,false)) throw new Error('Replay begin is incomplete.');
          record.reply=result.value; record.localDeadline=Math.min(record.localDeadline,Date.parse(result.value.deadlineAt)); replaySave(c);
        }
        if (!record.reply.accepted) { record.terminal=true; replaySave(c); stopReplay(state,false); return; }
        if (!replayCurrent(c,false)) throw new Error('Replay deadline passed.');
        if (!activeHub.replayLoader) activeHub.replayLoader=new Promise(function (resolve) {
          if (activeHub.startReplayRecorder) { resolve(typeof activeHub.startReplayRecorder==='function' && activeHub.startReplayRecorder.protocolVersion===1); return; }
          var loader=document.createElement('script'), done=false, timer=setTimeout(function () { finish(false); },5000);
          /** @param {boolean} ok */
          function finish(ok) { if(done)return;done=true;clearTimeout(timer);loader.remove();resolve(ok); }
          loader.src=state.origin+'/replay.js';loader.async=true;loader.referrerPolicy='no-referrer';loader.setAttribute('data-ten98-replay','record');if(script&&script.nonce)loader.nonce=script.nonce;
          loader.onload=function () { finish(typeof activeHub.startReplayRecorder==='function' && activeHub.startReplayRecorder.protocolVersion===1); };loader.onerror=function () { finish(false); };(document.head||document.documentElement).appendChild(loader);
        });
        if (!await activeHub.replayLoader || !replayCurrent(c,false)) throw new Error('Replay recorder unavailable.');
        var stop=/** @type {NonNullable<Ten98Tracker.BootstrapHub["startReplayRecorder"]>} */ (activeHub.startReplayRecorder)(record.reply.settings,function (event) { if(event===null)replayFail(c);else replayEmit(c,event); });
        if(typeof stop!=='function'||!c.active){if(typeof stop==='function')stop();throw new Error('Replay recorder did not start.');}c.stop=stop;c.started=true;
        c.flushTimer=setInterval(function () { if(!replayCurrent(c,false)){if(Date.now()>=record.localDeadline)finishReplay(c);else if(c.active)replayFail(c);return;}replayFlush(c);void replayPump(c); },2000);
        c.endTimer=setTimeout(function () { finishReplay(c); },Math.max(0,record.localDeadline-Date.now()));void replayPump(c);
      } catch (_) { if(c.active)replayFail(c); }
    })();
  }

  /** @param {Ten98Tracker.State} state */
  function startPerformance(state) {
    var h = hub(), settings = state.config && state.config.nativeTracking;
    if (!h || !settings || settings.capturePerformance !== true || state.performanceCapture || performanceDocumentChanged || typeof PerformanceObserver !== 'function') return;
    var activeHub = h;
    /** @type {Ten98Tracker.PerformanceCapture} */
    var capture = {state: state, navigationId: uuid(), url: currentUrl(), epoch: /** @type {Ten98Tracker.PublicConfig} */ (state.config).consentEpoch, generation: state.nativeGeneration, revision: 0, active: true, started: false, requests: new Set()};
    state.performanceCapture = capture; performanceCaptures.add(capture);
    /** @param {boolean} ready */
    function begin(ready) {
      if (!ready || capture.started || !capture.active || state.nativeGeneration !== capture.generation || !state.config || state.config.consentEpoch !== capture.epoch || !nativeReady(state)) return;
      capture.started = true;
      /** @type {NonNullable<Ten98Tracker.BootstrapHub["startPerformance"]>} */ (activeHub.startPerformance)(function (metric) {
        try {
          if (!capture.active || !state.config || state.config.consentEpoch !== capture.epoch || state.nativeGeneration !== capture.generation || currentUrl() !== capture.url || !nativeReady(state)) return;
          if (capture.restoreAt !== undefined && (metric.navigationType !== 'back-forward-cache' || metric.navigationStartTime !== capture.restoreAt)) return;
          var name = typeof metric.name === 'string' ? metric.name.toLowerCase() : '';
          if (!['lcp', 'inp', 'cls', 'fcp', 'ttfb'].includes(name) || !Number.isFinite(metric.value) || metric.value < 0 || metric.value > (name === 'cls' ? 1000 : 3600000) || capture.revision >= 1000000) return;
          nativeEvent(state, {type: 'performance', navigationId: capture.navigationId, url: capture.url, metric: name, value: metric.value, revision: ++capture.revision});
        } catch (ignore) {}
      });
    }
    if (typeof activeHub.startPerformance === 'function' && activeHub.startPerformance.protocolVersion === 1) { begin(true); return; }
    if (!activeHub.performanceLoader) activeHub.performanceLoader = new Promise(function (resolve) {
      var loader = document.createElement('script'), finished = false;
      var timer = setTimeout(function () { finish(false); }, 5000);
      /** @param {boolean} ready */
      function finish(ready) { if (finished) return; finished = true; clearTimeout(timer); loader.remove(); resolve(ready); }
      loader.src = state.origin + '/performance.js'; loader.async = true; loader.referrerPolicy = 'no-referrer';
      if (script && script.nonce) loader.nonce = script.nonce;
      loader.onload = function () { finish(typeof activeHub.startPerformance === 'function' && activeHub.startPerformance.protocolVersion === 1); };
      loader.onerror = function () { finish(false); };
      (document.head || document.documentElement).appendChild(loader);
    });
    activeHub.performanceLoader.then(begin).catch(function () {});
  }

  function stopPerformanceNavigation() {
    // ponytail: document metrics stop at SPA path changes, so excluded routes cannot
    // leak into a later aggregate. Add soft-navigation metrics with upstream lifecycle support.
    performanceDocumentChanged = true;
    performanceCaptures.forEach(function (capture) { capture.active = false; capture.requests.forEach(function (request) { request.abort(); }); });
  }

  /** @param {PageTransitionEvent} event */
  function restorePerformance(event) {
    performanceCaptures.forEach(function (capture) {
      var state = capture.state;
      // A library loaded after restore cannot reconstruct fresh bfcache measurements.
      if (!capture.started || !Number.isFinite(event.timeStamp) || event.timeStamp < 0 || !state.config || state.config.nativeTracking.capturePerformance !== true || !nativeReady(state)) { capture.active = false; return; }
      capture.navigationId = uuid(); capture.url = currentUrl(); capture.revision = 0;
      capture.restoreAt = event.timeStamp;
      capture.epoch = state.config.consentEpoch; capture.generation = state.nativeGeneration; capture.active = true;
    });
  }

  function uuid() {
    var bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  /** @returns {Ten98Tracker.BootstrapHub|null} */
  function hub() {
    return window.__ten98FoundationHub || null;
  }

  function currentUrl() {
    return location.origin + location.pathname; // page URLs never carry query strings or fragments
  }

  // Adapted from Umami 3.4.0 (ec0ff50388c264ed8ce46f00967e92f7e71476ae) src/tracker/index.ts
  // Copyright (c) 2022 Umami Software, Inc. MIT License; see THIRD_PARTY_NOTICES.md.
  // A tag is a short label from data-tag (every event of the script) or the track() tag option (that event). The collector
  // owns the authoritative validation and the owner setting; this only drops values that cannot be a label.
  /** @param {unknown} value @returns {string|undefined} */
  function tagLabel(value) {
    if (typeof value !== 'string') return undefined;
    var label = value.trim();
    return label && label.length <= 50 ? label : undefined;
  }

  /** @param {Ten98Tracker.Site} site @param {string} name @param {unknown} [properties] @param {string} [tag] */
  function send(site, name, properties, tag) {
    try {
      var event = { name: name, eventId: uuid(), url: currentUrl() };
      var h = hub();
      if (h && typeof h.destinationEvent === 'function') h.destinationEvent(site, { name: name, eventId: event.eventId, url: event.url, properties: properties, tag: tag });
    } catch (ignore) {
      // Missing crypto/fetch or any other instrumentation failure stays invisible to the host.
    }
  }

  /** @param {Ten98Tracker.State} state @param {boolean} [consentOnly] @returns {state is Ten98Tracker.State & {config:Ten98Tracker.PublicConfig}} */
  function nativeReady(state, consentOnly) {
    var h = hub(), settings = state.config && state.config.nativeTracking;
    var allowed = h && (consentOnly ? h.nativeConsentAllowed : h.nativeAllowed);
    return !!(allowed && allowed.protocolVersion === 3 && allowed(state) && settings && settings.enabled && state.environment === 'live' &&
      !settings.excludedPaths.some(function (path) { return decodeURIComponent(location.pathname).startsWith(decodeURIComponent(path)); }));
  }
  /** @param {Ten98Tracker.State} state @param {string} epoch @param {number} generation @param {AbortController} controller @param {boolean} [consentOnly] */
  function nativeCurrent(state, epoch, generation, controller, consentOnly) {
    return !controller.signal.aborted && state.nativeGeneration === generation && state.config && state.config.consentEpoch === epoch && nativeReady(state, consentOnly);
  }
  /** @param {Response} response @param {AbortSignal} signal @param {number} [limit] */
  async function readNativeResponse(response, signal, limit) {
    var reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader(), bytes = 0, text = '';
    function cancel() { reader.cancel().catch(function () {}); }
    signal.addEventListener('abort', cancel, {once: true});
    try {
      var decoder = new TextDecoder('utf-8', {fatal: true});
      while (true) {
        if (signal.aborted) throw new Error('Native request cancelled.');
        var part = await reader.read();
        if (signal.aborted) throw new Error('Native request cancelled.');
        if (part.done) return text + decoder.decode();
        bytes += part.value.byteLength;
        if (bytes > (limit || 2048)) throw new Error('Native response too large.');
        text += decoder.decode(part.value, {stream: true});
      }
    } catch (error) { cancel(); throw error; }
    finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  }

  // Called only by the coordinator. Disallowed activity is never queued.
  /** @param {Ten98Tracker.State} state @param {unknown} raw */
  function nativeEvent(state, raw) {
    var event = /** @type {Ten98Tracker.NativeInput} */ (raw);
    try {
      var config = /** @type {Ten98Tracker.PublicConfig} */ (state.config), settings = config.nativeTracking;
      if (!nativeReady(state) || state.nativeRequests.size >= 20 || typeof TextDecoder !== 'function' || typeof ReadableStream !== 'function') return;
      var performanceEvent = event.type === 'performance', capture = state.performanceCapture;
      if (performanceEvent && (settings.capturePerformance !== true || !capture || !capture.active || capture.navigationId !== event.navigationId || capture.url !== event.url)) return;
      var performanceCapture = /** @type {Ten98Tracker.PerformanceCapture} */ (capture);
      var consented = /** @type {NonNullable<Ten98Tracker.Hub["nativeConsentAllowed"]>} */ (/** @type {Ten98Tracker.Hub} */ (hub()).nativeConsentAllowed)(state);
    /** @type {Ten98Tracker.Dimensions} */ var dimensions = {}; var epoch = config.consentEpoch, generation = state.nativeGeneration;
      if (!performanceEvent && consented && state.nativeIdentifier !== undefined) dimensions.distinctId = state.nativeIdentifier;
      if (!performanceEvent && navigator.language) dimensions.language = navigator.language;
      // The first page view of each visitor key (a native generation: a new identify ID, resetIdentity, consent basis or withdrawal start one)
      // keeps the document's referrer, even when consent or configuration arrives after an in-app navigation. A later page view for
      // another path in the same generation reports the previous in-app page, whose origin is this page's own (a self-referral, as
      // pinned Umami sends it); custom events follow the page they occur on. A switch justified by a sent view holds for the generation;
      // one justified by a still-pending view holds unless that view is dropped unsent. ponytail: a generation over-approximates the
      // server's visitor key (resetIdentity, A->B->A, a regrant or identify within a continued anonymous visit can repeat an external
      // landing) and misses server-only rotations (UTC month, IP, user agent); the server never credits a self-referral, so those keys
      // show no referrer at worst. Upgrade path: the collector returns the key it used.
      var prior = state.nativePageObservation, switched = state.selfReferral;
      var inApp = !!switched && switched.generation === generation && !(switched.from && switched.from.dropped);
      if (!inApp && event.name === PAGE_VIEW && prior && prior.generation === generation && !prior.dropped && prior.url !== event.url) {
        state.selfReferral = {generation: generation, from: prior.sent ? null : prior}; inApp = true;
      }
      var referrer = !performanceEvent && settings.captureReferrer && (inApp ? location.origin : document.referrer && new URL(document.referrer).origin);
      // Only a web origin is sent: the collector refuses any other scheme, such as android-app:// (whose origin is a tuple in Chrome on Android).
      if (referrer && /^https?:\/\//.test(referrer)) dimensions.referrer = referrer;
      var tag = !performanceEvent ? tagLabel(event.tag !== undefined ? event.tag : state.tag) : undefined;
      if (tag !== undefined) dimensions.tag = tag;
      if (settings.captureScreen && window.screen) dimensions.screen = {width: screen.width, height: screen.height};
      if (!performanceEvent && settings.captureCampaigns) {
        var query = new URL(location.href).searchParams;
    /** @type {Record<string,string>} */ var campaign = {};
      /** @type {Record<string,string>} */ var clickIds = {};
        ['source', 'medium', 'campaign', 'term', 'content'].forEach(function (key) { var value = query.get('utm_' + key); if (value) campaign[key] = value; });
        if (Object.keys(campaign).length) dimensions.campaign = campaign;
        // Pinned Umami's six paid-click identifiers (src/lib/attribution.ts), read like its collector: first occurrence, empty kept.
        // Only with the analytics grant (owner decision D1; cookieless basic events carry none). Each is cut to the collector's
        // 255 code points and a NUL-bearing value is skipped, so a long or malformed identifier never costs the page view.
        if (consented) ['gclid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id', 'twclid'].forEach(function (key) {
          var value = query.get(key);
          if (value !== null && value.indexOf('\u0000') === -1) clickIds[key] = Array.from(value).slice(0, 255).join('');
        });
        if (Object.keys(clickIds).length) dimensions.clickIds = clickIds;
      }
      /** @type {Ten98Tracker.NativePayload} */
      var payload = performanceEvent ? {type: 'performance', siteKey: state.siteKey, navigationId: event.navigationId, url: event.url, metric: event.metric, value: event.value, revision: event.revision, dimensions: dimensions} :
        {siteKey: state.siteKey, name: event.name, eventId: event.eventId, url: event.url, properties: event.properties, dimensions: dimensions, context: state.nativeContext || undefined};
      if (consented) payload.consent = {analytics: true, epoch: epoch};
      else payload.collection = {mode: 'cookieless', epoch: epoch};
      var body = JSON.stringify(payload);
      if (new TextEncoder().encode(body).length > 16384) return;
      // An attempted basic observation may already be stored even if its receipt is lost.
      /** @type {Ten98Tracker.PageObservation|null} */
      var observation = event.name === PAGE_VIEW ? {url: event.url, basic: !consented, sent: false, generation: generation} : null;
      if (observation) state.nativePageObservation = observation;
      var controller = new AbortController(); state.nativeRequests.add(controller);
      if (performanceEvent) performanceCapture.requests.add(controller);
      function current() { return nativeCurrent(state, epoch, generation, controller) && (!performanceEvent || performanceCapture.active && performanceCapture.navigationId === payload.navigationId && performanceCapture.url === payload.url); }
      var timer = setTimeout(function () { controller.abort(); }, 5000);
      Promise.resolve().then(function () { if (!current()) { if (observation) observation.dropped = true; return; } if (observation) observation.sent = true; return fetch(state.origin + (state.collectPath || '/api/collect'), {method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors',
        cache: 'no-store', redirect: 'error', keepalive: true, signal: controller.signal, headers: {'Content-Type': 'application/json'}, body: body}); })
        .then(async function (response) {
          if (!response) return;
          var text = await readNativeResponse(response, controller.signal);
          if (!response.ok) { warn('ten98 Discover: event was not accepted. Check installation diagnostics.'); return; }
          var result = /** @type {Record<string,unknown>} */ (JSON.parse(text));
          if (current() && result.accepted && typeof result.context === 'string' && result.context.length <= 1024) state.nativeContext = result.context;
        }).catch(function () { if (!controller.signal.aborted) warn('ten98 Discover: collector unavailable or blocked.'); })
        .finally(function () { clearTimeout(timer); state.nativeRequests.delete(controller); if (performanceEvent) performanceCapture.requests.delete(controller); });
      if (observation) { startPerformance(state); startReplay(state); startHeatmap(state); }
    } catch (ignore) {} // Invalid application properties must never break the host page.
  }

  /** @param {Ten98Tracker.State} state */
  function nativeStop(state) {
    if (state.replayCapture) state.replayRestartRequired = true;
    stopReplay(state, true);
    if (state.heatmapCapture) state.heatmapRestartRequired = true;
    stopHeatmap(state);
    if (state.performanceCapture) state.performanceCapture.active = false;
    state.nativeContext = null; state.nativeIdentifier = undefined; state.nativeGeneration = (state.nativeGeneration || 0) + 1;
    state.nativeRequests.forEach(function (request) { request.abort(); }); state.nativeRequests.clear();
  }

  /** @param {string} value */
  function clean(value) { return !/\u0000|[\uD800-\uDFFF]/u.test(value); }
  /** @param {unknown} identifier @param {unknown} raw @returns {Ten98Tracker.IdentifySnapshot} */
  function identifySnapshot(identifier, raw) {
    var leaves = 0;
    /** @type {Set<object>} */ var stack = new Set();
    /** @returns {never} */
    function bad() { throw new Error('Invalid identify input.'); }
    /** @param {unknown} value @returns {string} */
    function validId(value) { if (typeof value !== 'string' || !value.length || value.length > 256 || !clean(value) || /[\x00-\x1f\x7f]/.test(value)) bad(); return value; }
    /** @param {unknown} value @returns {Ten98Tracker.IdentifyScalar} */
    function scalar(value) {
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15) return value;
      if (typeof value === 'string' && value.length <= 1000 && clean(value)) return value;
      return bad();
    }
    /** @param {unknown} value @returns {value is Record<string,unknown>} */
    function object(value) { return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
    /** @param {unknown} value @param {string} path @param {number} depth @returns {Ten98Tracker.IdentifyProperties} */
    function copy(value, path, depth) {
      if (!object(value) || stack.has(value)) bad();
      stack.add(value);
    /** @type {Ten98Tracker.IdentifyProperties} */ var out = Object.create(null);
      Reflect.ownKeys(value).forEach(function (key) {
        var descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(value, key));
        if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) bad();
        var item = descriptor.value;
        if (depth === 1 && key === 'id') { var shortcut = validId(item); if (identifier !== undefined && identifier !== shortcut) bad(); identifier = shortcut; return; }
        if (!key.length || key.length > 80 || ['__proto__', 'prototype', 'constructor'].includes(key) || !clean(key)) bad();
        var next = (path ? path + '.' : '') + key.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
        if (next.length > 320) bad();
        if (object(item)) { if (depth >= 4) bad(); out[key] = copy(item, next, depth + 1); }
        else {
          if (++leaves > 50) bad();
          if (Array.isArray(item)) {
            if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 50) bad();
            Reflect.ownKeys(item).forEach(function (index) {
              if (index === 'length') return;
              var d = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(item, index));
              if (typeof index !== 'string' || !/^(0|[1-9]\d*)$/.test(index) || Number(index) >= item.length || !d.enumerable || !('value' in d)) bad();
            });
            var array = [];
            for (var i = 0; i < item.length; i++) { var d = Object.getOwnPropertyDescriptor(item, String(i)); if (!d || !('value' in d)) bad(); array.push(scalar(d.value)); }
            if (new TextEncoder().encode(JSON.stringify(array)).length > 4096) bad(); out[key] = array;
          } else out[key] = scalar(item);
        }
      });
      stack.delete(value); return out;
    }
    if (identifier !== undefined) validId(identifier);
    var properties = copy(raw, '', 1);
    if (new TextEncoder().encode(JSON.stringify(properties)).length > 6144) bad();
    return {identifier: /** @type {string|undefined} */ (identifier), properties: properties};
  }

  /** @param {Ten98Tracker.State} state @param {unknown} identifier @param {unknown} properties */
  async function nativeIdentify(state, identifier, properties) {
    /** @type {string|undefined} */ var requestId;
    /** @type {string|undefined} */ var sentAt;
    /** @type {AbortController|undefined} */ var controller;
    /** @type {ReturnType<typeof setTimeout>|undefined} */ var timer; var sent = false;
    /** @param {string} status @param {string} [reason] @returns {Ten98Tracker.IdentifyOutcome} */
    function outcome(status, reason) { return Object.assign({status: status}, requestId ? {requestId: requestId, sentAt: sentAt} : {}, reason ? {reason: reason} : {}); }
    try {
      if (!nativeReady(state, true)) return outcome('not_sent', 'collection_unavailable');
      if (state.nativeRequests.size >= 20) return outcome('not_sent', 'busy');
      if (typeof TextEncoder !== 'function' || typeof TextDecoder !== 'function' || typeof ReadableStream !== 'function' || typeof AbortController !== 'function' || typeof fetch !== 'function' || typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') return outcome('not_sent', 'browser_unavailable');
      var snapshot;
      try { snapshot = identifySnapshot(identifier, properties); } catch (_) { return outcome('invalid', 'invalid_input'); }
      var changed = snapshot.identifier !== undefined && snapshot.identifier !== state.nativeIdentifier;
      var nextId = snapshot.identifier === undefined ? state.nativeIdentifier : snapshot.identifier, epoch = state.config.consentEpoch;
      // Identifying an anonymous visitor keeps its signed visit context, so the collector can keep the current visit's key
      // (#371). Switching between explicit identifiers still starts without one.
      var context = changed && state.nativeIdentifier !== undefined ? null : state.nativeContext;
      requestId = uuid(); sentAt = new Date().toISOString(); controller = new AbortController();
      var activeController = controller;
      var body = JSON.stringify({type: 'identify', siteKey: state.siteKey, requestId: requestId, sentAt: sentAt, url: currentUrl(), properties: snapshot.properties,
        dimensions: nextId === undefined ? undefined : {distinctId: nextId}, context: context || undefined, consent: {analytics: true, epoch: epoch}});
      if (new TextEncoder().encode(body).length > 16384) return outcome('invalid', 'invalid_input');
      if (!nativeReady(state, true)) return outcome('not_sent', 'collection_unavailable');
      if (changed) { nativeStop(state); state.nativeIdentifier = nextId; state.nativeContext = context; }
      var generation = state.nativeGeneration;
      state.nativeRequests.add(activeController);
      /** @type {Promise<Ten98Tracker.IdentifyOutcome>} */
      var aborted = new Promise(function (resolve) { activeController.signal.addEventListener('abort', function () { resolve(outcome(sent ? 'unknown' : 'not_sent', sent ? undefined : 'cancelled')); }, {once: true}); });
      timer = setTimeout(function () { activeController.abort(); }, 5000);
      var work = Promise.resolve().then(async function () {
        if (!nativeCurrent(state, epoch, generation, activeController, true)) return outcome('not_sent', 'cancelled');
        sent = true;
        var response = await fetch(state.origin + (state.collectPath || '/api/collect'), {method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', cache: 'no-store', redirect: 'error', signal: activeController.signal, headers: {'Content-Type': 'application/json'}, body: body});
        var text = await readNativeResponse(response, activeController.signal);
        if (!nativeCurrent(state, epoch, generation, activeController, true)) return outcome('unknown');
        var decoded = /** @type {unknown} */ (JSON.parse(text));
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return outcome('unknown');
        var result = /** @type {Record<string,unknown>} */ (decoded);
        if ([400, 409].includes(response.status) && typeof result.error === 'string' && Object.keys(result).every(function (key) { return ['error', 'reason'].includes(key); })) {
          if (response.status === 400 && result.reason === 'request_expired') return outcome('expired', 'request_expired');
          return outcome('invalid', response.status === 409 ? 'request_conflict' : 'invalid_input');
        }
        if (response.status !== 202) return outcome('unknown');
        if (result.accepted === false && Object.keys(result).length === 2 && ['collection_disabled', 'consent_required', 'identity_unavailable'].includes(/** @type {string} */ (result.reason))) return outcome(result.reason === 'identity_unavailable' ? 'identity_unavailable' : 'rejected', /** @type {string} */ (result.reason));
        if (result.accepted !== true || typeof result.duplicate !== 'boolean' || Object.keys(result).some(function (key) { return !['accepted', 'duplicate', 'context'].includes(key); }) ||
          Object.prototype.hasOwnProperty.call(result, 'context') && (result.duplicate || typeof result.context !== 'string' || !result.context.length || result.context.length > 1024 || !clean(result.context))) return outcome('unknown');
        if (typeof result.context === 'string') state.nativeContext = result.context;
        return Object.assign(outcome('accepted'), {duplicate: result.duplicate});
      }).catch(function () { return outcome('unknown'); });
      return await Promise.race([work, aborted]);
    } catch (_) { return outcome(sent ? 'unknown' : 'not_sent', sent ? undefined : 'collection_unavailable'); }
    finally { if (timer) clearTimeout(timer); if (controller) state.nativeRequests.delete(controller); }
  }

  /** @param {unknown} first @param {unknown} [second] @param {unknown} [third] */
  function identify(first, second, third) {
    try {
      var explicit = typeof first === 'string', h = hub();
      if (arguments.length !== (explicit ? 3 : 2)) return Promise.resolve({status: 'invalid', reason: 'invalid_input'});
      if (!h || !h.destinationIdentify) return Promise.resolve({status: 'not_sent', reason: 'configuration_unavailable'});
      return h.destinationIdentify(explicit ? first : undefined, explicit ? second : first, /** @type {Ten98Tracker.SiteOptions} */ (explicit ? third : second));
    } catch (_) { return Promise.resolve({status: 'invalid', reason: 'invalid_input'}); }
  }
  /** @param {Ten98Tracker.SiteOptions} options */
  function resetIdentity(options) {
    try { var h = hub(); if (h && h.destinationResetIdentity) return h.destinationResetIdentity(options); } catch (_) {}
    return {ok: false, reason: 'Choose one configured site and environment.'};
  }

  /** @param {string} message */
  function warn(message) {
    try { console.warn(message); } catch (ignore) {}
  }

  /** @param {string} name @param {unknown} [properties] @param {string} [tag] */
  function fanout(name, properties, tag) {
    var h = hub();
    if (!h) return;
    for (var i = 0; i < h.sites.length; i++) send(h.sites[i], name, properties, tag);
  }

  // Sends a page_view only when origin+pathname actually changed (query/hash-only moves are ignored).
  function afterNav() {
    try {
      var h = hub();
      if (!h) return;
      var url = currentUrl();
      if (url === h.lastUrl) return;
      stopPerformanceNavigation();
      replayNavigation(h);
      heatmapNavigation(h);
      h.lastUrl = url;
      fanout(PAGE_VIEW);
    } catch (ignore) {}
  }

  /** @param {PageTransitionEvent} event */
  function onPageshow(event) {
    try {
      var h = hub();
      if (!h || !event || !event.persisted || h.restored) return; // ordinary pageshow must not duplicate
      h.restored = true; // exactly one restored page_view per bfcache restoration; pagehide re-arms
      (h.heatmapStates||[]).forEach(function(state){state.heatmapHidden=false;}); // Never resume or renew the discarded capture.
      restorePerformance(event);
      h.lastUrl = currentUrl();
      fanout(PAGE_VIEW);
    } catch (ignore) {}
  }

  function onPagehide() {
    try {
      var h = hub();
      if (h) { h.restored = false; hideReplay(h); (h.heatmapStates||[]).forEach(function(state){state.heatmapHidden=true;stopHeatmap(state);}); }
    } catch (ignore) {}
  }

  /** @param {"pushState"|"replaceState"} method */
  function patchHistory(method) {
    try {
      var nativeMethod = history[method];
      if (typeof nativeMethod !== 'function') return;
      history[method] = function () {
        var result = nativeMethod.apply(this, /** @type {Parameters<History["pushState"]>} */ (/** @type {unknown} */ (arguments))); // native this/args/return/exceptions untouched
        afterNav(); // origin/path collected only after the native call succeeded
        return result;
      };
    } catch (ignore) {} // A frozen host method must not disable initial/custom events.
  }

  /** @param {unknown} name @param {unknown} [properties] @param {unknown} [options] */
  function track(name, properties, options) {
    try {
      if (typeof name !== 'string' || name === PAGE_VIEW || name !== name.trim() || !NAME_RE.test(name)) return;
      fanout(name, properties, options && typeof options === 'object' ? tagLabel(/** @type {{tag?: unknown}} */ (options).tag) : undefined);
    } catch (ignore) {}
  }

  /** @param {MouseEvent} event */
  function onDeclaredClick(event) {
    try {
      var target = /** @type {(Node & Partial<Element>)|null} */ (event.target);
      if (target && target.nodeType === 3) target = target.parentElement;
      var element = target && typeof target.closest === 'function' && target.closest('[data-ten98-event]');
      if (!element) return;
      var name = element.getAttribute('data-ten98-event');
      if (typeof name !== 'string' || name === PAGE_VIEW || name !== name.trim() || !NAME_RE.test(name)) return;
      /** @type {Record<string,string>} */ var properties = {}; var count = 0, prefix = 'data-ten98-event-', attributes = element.getAttributeNames();
      for (var i = 0; i < attributes.length; i++) {
        if (!attributes[i].startsWith(prefix)) continue;
        var key = attributes[i].slice(prefix.length), value = element.getAttribute(attributes[i]);
        if (!key.length || key.length > 80 || !clean(key) || ['__proto__', 'prototype', 'constructor'].includes(key) ||
            typeof value !== 'string' || value.length > 1000 || !clean(value) || ++count > 50) return;
        properties[key] = value;
      }
      if (new TextEncoder().encode(JSON.stringify(properties)).length > 6144) return;
      track(name, properties); // Existing collection and destination gates decide whether anything is sent.
    } catch (ignore) {} // Never inspect undeclared content or interfere with the page's click/navigation.
  }

  /** @returns {Ten98Tracker.BootstrapHub} */
  function install() {
    /** @type {Ten98Tracker.Hook<typeof nativeEvent>} */ (nativeEvent).protocolVersion = /** @type {Ten98Tracker.Hook<typeof nativeStop>} */ (nativeStop).protocolVersion = /** @type {Ten98Tracker.Hook<typeof nativeIdentify>} */ (nativeIdentify).protocolVersion = /** @type {Ten98Tracker.Hook<typeof startReplay>} */ (startReplay).protocolVersion = /** @type {Ten98Tracker.Hook<typeof stopReplay>} */ (stopReplay).protocolVersion = /** @type {Ten98Tracker.Hook<typeof startHeatmap>} */ (startHeatmap).protocolVersion = 3;
    var h = { sites: [], lastUrl: currentUrl(), restored: false, nativeEvent: nativeEvent, nativeStop: nativeStop, nativeIdentify: nativeIdentify, replayStart:startReplay, replayStop:stopReplay, heatmapStart:startHeatmap, api: { track: track, identify: identify, resetIdentity: resetIdentity } };
    window.__ten98FoundationHub = h;
    patchHistory('pushState');
    patchHistory('replaceState');
    window.addEventListener('popstate', afterNav);
    window.addEventListener('pageshow', onPageshow, true); // reset RUM identity before the library's bfcache callbacks
    window.addEventListener('pagehide', onPagehide);
    try { document.addEventListener('click', onDeclaredClick, true); } catch (ignore) {}
    if (!window.ten98) window.ten98 = h.api; // never overwrite a foreign global
    return h;
  }

  /** @param {Ten98Tracker.BootstrapHub} h @param {Ten98Tracker.Site} site */
  function loadDestinations(h, site) {
    try {
      if (typeof h.destinationInit === 'function') { h.destinationInit(site); return; }
      if (h.destinationLoaderRequested || window.ten98 !== h.api) return;
      h.destinationLoaderRequested = true;
      var loader = document.createElement('script');
      loader.src = new URL('/destinations.js?v=3', site.endpoint).href;
      loader.async = true;
      loader.referrerPolicy = 'no-referrer';
      if (script && script.nonce) loader.nonce = script.nonce;
      loader.onerror = function () { warn('ten98 Discover: destination loader unavailable or blocked.'); };
      (document.head || document.documentElement).appendChild(loader);
    } catch (ignore) {} // A blocked coordinator leaves collection disabled.
  }

  try {
    var script = /** @type {HTMLScriptElement|null} */ (document.currentScript);
    if (!script) return;
    var siteKey = script.getAttribute('data-site-key');
    if (!siteKey) return;
    var environment = script.getAttribute('data-environment') || 'live';
    if (environment !== 'live' && environment !== 'test') return;
    var endpoint;
    try {
      // Optional first-party reverse proxy, like Umami: data-host-url is an origin (HTTPS unless it is the script origin);
      // every collector request uses it. data-collect-path renames only the collect route.
      var hostUrl = script.getAttribute('data-host-url'), collectPath = script.getAttribute('data-collect-path') || '/api/collect', base = script.src;
      if (!/^\/[a-z0-9][a-z0-9\/_-]{0,63}$/i.test(collectPath)) return;
      if (hostUrl !== null) { var host = new URL(hostUrl); if (host.username || host.password || host.pathname !== '/' || host.search || host.hash || host.protocol !== 'https:' && host.origin !== new URL(script.src).origin) return; base = host.origin; }
      endpoint = new URL(collectPath, base).href;
    } catch (badUrl) {
      return; // invalid collector URL: skip this site quietly
    }
    var registry = window.__ten98FoundationSites || (window.__ten98FoundationSites = new Set());
    var key = endpoint + ':' + siteKey + ':' + environment;
    if (registry.has(key)) return; // repeated init must not double send/patch/listen
    var h = hub() || install();
    var site = { endpoint: endpoint, siteKey: siteKey, environment: environment, tag: tagLabel(script.getAttribute('data-tag')) };
    h.sites.push(site);
    registry.add(key);
    loadDestinations(h, site);
    send(site, PAGE_VIEW); // dropped until consent; a restored grant permits one fresh observation
  } catch (ignore) {}
})();
