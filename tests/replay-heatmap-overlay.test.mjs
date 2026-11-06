import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

// Synthetic adapter/DOM seam only. Actual rrweb geometry remains the separate Edge gate.
// Advance one native timeout task at a time; cancelled work cannot publish readiness.
function readinessTimers(){
 const pending=new Map(),delays=[];let nextId=0,runs=0;
 return{delays,get size(){return pending.size;},get runs(){return runs;},
  setTimeout(callback,delay){assert.ok(delay===0||delay===16);assert.equal(pending.size,0,'Only one readiness retry may be pending.');const id=++nextId;pending.set(id,callback);delays.push(delay);return id;},
  clearTimeout(id){pending.delete(id);},
  next(){const entry=pending.entries().next().value;assert.ok(entry,'Expected a pending readiness task.');assert.ok(++runs<=120,'Readiness work must remain bounded.');pending.delete(entry[0]);entry[1]();}
 };
}

test('historical overlay position commands repaint actual native offsets before delayed scroll events',()=>{
 const asset=readFileSync(resolve('public/replay.js'),'utf8');
 const marker='// App adapter appended inside the private CommonJS closure around pinned rrweb.';
 const start=asset.indexOf(marker),end=asset.lastIndexOf('\n})();');
 assert.ok(start>0&&end>start);assert.equal(asset.indexOf(marker,start+1),-1);
 const source=asset.slice(start,end);
 const cases=[
  {direction:'ltr',pageWidth:2400,pageHeight:3000,viewportWidth:1440,viewportHeight:900},
  {direction:'rtl',pageWidth:2400,pageHeight:3000,viewportWidth:320,viewportHeight:700},
  {direction:'ltr',pageWidth:2400,pageHeight:3600,viewportWidth:1440,viewportHeight:900},
  {direction:'rtl',pageWidth:2400,pageHeight:3600,viewportWidth:900,viewportHeight:600},
  {direction:'rtl',pageWidth:5085,pageHeight:6000,viewportWidth:1440,viewportHeight:900},
 ];
 for(const shape of cases)for(const mode of ['click','scroll','replay']){
  const geometry={basis:'document-css-v1',...shape},maxX=shape.pageWidth-shape.viewportWidth,maxY=shape.pageHeight-shape.viewportHeight;
  const root={scrollWidth:shape.pageWidth,scrollHeight:shape.pageHeight,clientWidth:shape.viewportWidth,clientHeight:shape.viewportHeight,appendChild(){}};
  const docListeners={},windowListeners={},timers=readinessTimers(),messages=[],observers=[],replayerListeners={};
  let destroyed=0,scrollCalls=0;
  const element=tag=>({tag,style:{},attributes:{},children:[],setAttribute(k,v){this.attributes[k]=v;},appendChild(child){this.children.push(child);},replaceChildren(){this.children=[];}});
  const wrapper=element('wrapper');
  const view={scrollX:0,scrollY:0,getComputedStyle:()=>({direction:shape.direction,writingMode:'horizontal-tb',scrollbarWidth:'none',transform:'none',perspective:'none',rotate:'none',scale:'none',translate:'none'}),scrollTo(x,y){
   const minimum=shape.direction==='rtl'?-maxX:0,maximum=shape.direction==='rtl'?0:maxX;
   this.scrollX=Math.max(minimum,Math.min(maximum,x));this.scrollY=Math.max(0,Math.min(maxY,y));scrollCalls++;
   // Deliberately no scroll callback: native offsets advance before that later notification.
  }};
  const innerDoc={scrollingElement:root,documentElement:root,compatMode:'CSS1Compat',body:{},addEventListener:(type,fn)=>{docListeners[type]=fn;},createElement:()=>({style:{},getBoundingClientRect:()=>({left:0,top:0,width:shape.viewportWidth,height:shape.viewportHeight}),remove(){}})};
  const iframe={width:String(shape.viewportWidth),height:String(shape.viewportHeight),offsetLeft:0,offsetTop:0,clientLeft:2,clientTop:2,contentDocument:innerDoc,contentWindow:view,addEventListener(){}};
  class Replayer{
   constructor(){this.iframe=iframe;this.wrapper=wrapper;}
   disableInteract(){} enableInteract(){} pause(){} getMirror(){return{getId:()=>1};} on(type,listener){replayerListeners[type]=listener;} getMetaData(){return{totalTime:1};} destroy(){destroyed++;}
  }
  const parent={},port={postMessage:value=>messages.push(JSON.parse(JSON.stringify(value))),start(){},close(){},onmessage:null};
  const document={currentScript:{getAttribute:()=> 'player'},body:{style:{}},createElementNS:(_ns,tag)=>element(tag)};
  const context={module:{exports:{Replayer}},document,window:{parent},parent,innerWidth:800,innerHeight:500,TextEncoder,
   addEventListener:(type,fn)=>{windowListeners[type]=fn;},removeEventListener(){},setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout,clearInterval(){},setInterval(){return 1;},
   MutationObserver:class{observe(){}disconnect(){}},ResizeObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}};
  runInNewContext('(function(){'+source+'\n})();',context,{timeout:1000});
  const points=[{x:shape.pageWidth-80,y:shape.pageHeight-80,count:1}],bands=Array.from({length:10},(_,i)=>({depth:(i+1)*10,captures:10-i}));
  const heatmap=mode==='click'?{mode,geometry,points}:{mode,geometry,captures:10,bands};
  windowListeners.message({source:parent,data:{type:'ten98-replay-init',protocol:1,...(mode==='replay'?{}:{heatmap}),events:[
   {type:4,timestamp:0,data:{width:shape.viewportWidth,height:shape.viewportHeight}},
   {type:2,timestamp:1,data:{node:{type:0,childNodes:[]},initialOffset:{left:0,top:0},ten98Layout:{version:1,boxes:[]}}},
  ]},ports:[port]});
  // Synthetic delayed vendor Finish: paused end-seek must not publish playback state in static heatmap mode.
  assert.equal(typeof replayerListeners.finish,'function');
  if(mode==='replay'){assert.deepEqual(messages,[{type:'ready',duration:1}]);replayerListeners.finish();assert.deepEqual(messages,[{type:'ready',duration:1},{type:'ended'}]);assert.equal(timers.size,0);port.onmessage({data:{type:'destroy'}});assert.equal(destroyed,1);continue;}
  replayerListeners.finish();assert.deepEqual(messages,[],'Static end-seek completion must not precede geometry readiness.');
  assert.equal(timers.size,1);timers.next();
  assert.deepEqual(messages,[{type:'ready',duration:1}]);replayerListeners.finish();assert.deepEqual(messages,[{type:'ready',duration:1}],'Static preview must not emit playback-ended after readiness either.');assert.equal(observers.length,1);
  const svg=wrapper.children[0];assert.match(svg.style.cssText,/^position:absolute;left:2px;top:2px;/,'The plane starts at the frame viewport origin, past the iframe border.');
  const check=()=>{
   const left=view.scrollX+(shape.direction==='rtl'?maxX:0),top=view.scrollY;
   if(mode==='click'){
    assert.equal(svg.children.length,1);
    assert.equal(Number(svg.children[0].attributes.cx),points[0].x-left);
    assert.equal(Number(svg.children[0].attributes.cy),points[0].y-top);
   }else{
    assert.equal(svg.children.length,10);
    for(const [i,rect]of svg.children.entries()){
     assert.equal(Number(rect.attributes.y),i*shape.pageHeight/10-top);
     assert.equal(Number(rect.attributes.height),shape.pageHeight/10);
     assert.equal(Number(rect.attributes['fill-opacity']),.5*bands[i].captures/10);
    }
   }
  };
  check();
  for(const [axis,value]of [['x',maxX],['y',maxY],['x',maxX/2],['y',maxY/2]]){
   port.onmessage({data:{type:'heatmap-position',axis,value}});check();
  }
  assert.equal(scrollCalls,6);assert.equal(destroyed,0);
  if(shape.direction==='rtl')for(const nativeEndpoint of [.25,1]){view.scrollX=nativeEndpoint;docListeners.scroll({target:innerDoc});assert.equal(destroyed,0);check();}
  // Existing native scroll and outer resize paths still retain their current behavior.
  view.scrollTo(shape.direction==='rtl'?-maxX:0,0);docListeners.scroll({target:innerDoc});check();
  windowListeners.resize();check();assert.match(wrapper.style.transform,/^scale\(/);
  if(shape.pageWidth===5085){
   view.scrollX=1.001;docListeners.scroll({target:innerDoc});assert.equal(messages.at(-1).type,'error');assert.equal(destroyed,1);assert.equal(observers[0].disconnected,true);
   const calls=scrollCalls;port.onmessage({data:{type:'heatmap-position',axis:'y',value:0}});assert.equal(scrollCalls,calls);continue;
  }
  // A different document plane must still fail closed rather than paint against stale geometry.
  root.scrollHeight++;observers[0].callback();
  assert.equal(messages.at(-1).type,'error');assert.equal(destroyed,1);assert.equal(observers[0].disconnected,true);
  const calls=scrollCalls;port.onmessage({data:{type:'heatmap-position',axis:'y',value:0}});assert.equal(scrollCalls,calls);
 }
});


test('numeric extent preservation calibrates without fixture IDs and releases on natural drift or teardown',()=>{
 const asset=readFileSync(resolve('public/replay.js'),'utf8'),start=asset.indexOf('// App adapter appended inside the private CommonJS closure around pinned rrweb.'),source=asset.slice(start,asset.lastIndexOf('\n})();'));
 assert.ok(start>0);
 function scene({direction='rtl',zoom=1,fault='',exact=false,mirror=true,replay=false,metaWidth=1440,metaHeight=900,gutter=0,classic=false}={}){
  // classic: a real scrollbar occupies the gutter, so the recorded viewport and the client box are both narrower; otherwise the gutter is reserved behind hidden scrollbars and only the initial containing block shrinks.
  const client=classic?1440-gutter:1440,geometry={basis:'document-css-v1',direction,pageWidth:exact?2400*zoom:(zoom===2?5085:2542),pageHeight:exact?3000*zoom:3200*zoom,viewportWidth:client,viewportHeight:900};
  let naturalWidth=2400*zoom,naturalHeight=3000*zoom,destroyed=0;if(fault==='oversized')naturalWidth=geometry.pageWidth+1;
  const timers=readinessTimers(),messages=[],observers=[],mutations=[],markers=[],listeners={},docListeners={},events={};
  const css=()=>({direction,writingMode:'horizontal-tb',scrollbarWidth:'none',transform:'none',perspective:'none',rotate:'none',scale:'none',translate:'none',animationName:'none',transitionDuration:'0s'});
  const view={scrollX:0,scrollY:0,innerWidth:metaWidth,innerHeight:metaHeight,getComputedStyle(node){const s=css();s.position=node===fixed?'fixed':'static';if(node===root){if(fault==='scrollbar')s.scrollbarWidth='auto';if(fault==='root-transform')s.transform='matrix(1,0,0,1,1,0)';if(fault==='writing-mode')s.writingMode='vertical-rl';}if(node===body&&fault==='body-transform')s.scale='2';if(node===body&&['body-scroller','body-scrolled'].includes(fault))s.overflowY='auto';if(node===plane){if(fault==='child-transform')s.transform='matrix(1,0,0,1,1,0)';if(fault==='animation')s.animationName='moving';if(fault==='transition')s.transitionDuration='0.2s';}return s;},scrollTo(x,y){this.scrollX=Math.max(direction==='rtl'?-(geometry.pageWidth-geometry.viewportWidth):0,Math.min(direction==='rtl'?0:geometry.pageWidth-geometry.viewportWidth,x));this.scrollY=Math.max(0,Math.min(geometry.pageHeight-geometry.viewportHeight,y));}};
  const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
  const node=(kind)=>({kind,nodeType:1,getClientRects(){return[this.getBoundingClientRect()];},attributes:{},children:[],getAttribute(name){return this.attributes[name]??null;},setAttribute(name,value){this.attributes[name]=value;},appendChild(child){child.parentNode=this;this.children.push(child);return child;},remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;const index=markers.indexOf(this);if(index>=0)markers.splice(index,1);}});
  const root=node('root'),body=node('body'),plane=node('natural-plane'),target=node('natural-target'),fixed=node('fixed');if(fault==='shadow-root')plane.shadowRoot={};if(fault==='body-scrolled')body.scrollTop=100;
  root.attributes.class='rrweb-paused';root.appendChild(body);body.appendChild(plane);plane.appendChild(target);body.appendChild(fixed);
  root.getBoundingClientRect=()=>rect(gutter-view.scrollX,-view.scrollY,1440,naturalHeight);
  body.getBoundingClientRect=()=>rect(gutter-view.scrollX,-view.scrollY,1440,900);
  plane.getBoundingClientRect=()=>rect(gutter+(direction==='rtl'?1440-naturalWidth:0)-view.scrollX+(fault==='selector-shift'&&markers.length?1:0),-view.scrollY,naturalWidth,naturalHeight);
  target.getBoundingClientRect=()=>rect(gutter+(direction==='rtl'?1440-112*zoom:naturalWidth-112*zoom)-view.scrollX,naturalHeight-112*zoom-view.scrollY,64*zoom,64*zoom);
  fixed.getBoundingClientRect=()=>rect(gutter+8*zoom,8*zoom,100*zoom,44*zoom);
  for(const n of[root,body,plane,target,fixed])Object.defineProperties(n,{clientWidth:{get:()=>n===root?client:n.getBoundingClientRect().width/zoom},clientHeight:{get:()=>n===root?900:n.getBoundingClientRect().height/zoom},scrollWidth:{get:()=>n===root?Math.max(naturalWidth,...markers.map(m=>{const r=m.getBoundingClientRect();return direction==='rtl'?gutter+client-(r.left+view.scrollX):r.right+view.scrollX-gutter;})):n===body?naturalWidth/zoom:n.getBoundingClientRect().width/zoom},scrollHeight:{get:()=>n===root?Math.max(naturalHeight,...markers.map(m=>{const r=m.getBoundingClientRect();return r.bottom+view.scrollY;})):n===body?naturalHeight/zoom:n.getBoundingClientRect().height/zoom}});
  const innerDoc={scrollingElement:root,documentElement:root,compatMode:fault==='quirks'?'BackCompat':'CSS1Compat',body,querySelectorAll:()=>fault==='node-cap'?Array.from({length:20001},()=>root):[root,body,plane,target,fixed],addEventListener:(name,fn)=>{docListeners[name]=fn;},createElement(){
   const m=node('marker'),properties={};m.style={setProperty(name,value){properties[name]=value;},set cssText(value){for(const part of value.split(';')){const index=part.indexOf(':');if(index>=0)properties[part.slice(0,index)]=part.slice(index+1).replace('!important','');}}};
   m.getBoundingClientRect=()=>{const left=parseFloat(properties.left||'0')*zoom,top=parseFloat(properties.top||'0')*zoom,width=properties.width==='auto'?1440-gutter:parseFloat(properties.width||'1')*zoom,height=properties.height==='auto'?900:parseFloat(properties.height||'1')*zoom,scrolled=properties.position==='fixed'?0:1;return rect(gutter+left-scrolled*view.scrollX,top-scrolled*view.scrollY+(fault==='axes'?left/4:0),width,height);};markers.push(m);return m;
  }};
  const element=tag=>({tag,style:{},children:[],attributes:{},setAttribute(k,v){this.attributes[k]=v;},appendChild(child){this.children.push(child);return child;},replaceChildren(){this.children=[];}});
  const wrapper=element('wrapper'),iframe={width:String(metaWidth),height:String(metaHeight),offsetLeft:0,offsetTop:0,clientLeft:2,clientTop:2,contentDocument:innerDoc,contentWindow:view,addEventListener(){}};
  class Replayer{constructor(){this.iframe=iframe;this.wrapper=wrapper;}disableInteract(){}enableInteract(){}pause(){}getMirror(){return{getId:()=>mirror?1:-1,getNode:id=>[root,body,plane,target,fixed][id-2]};}getMetaData(){return{totalTime:1};}on(name,fn){events[name]=fn;}destroy(){destroyed++;}}
  const parent={},port={postMessage:value=>messages.push(JSON.parse(JSON.stringify(value))),start(){},close(){}},outerDoc={currentScript:{getAttribute:()=> 'player'},body:{style:{}},createElementNS:(_ns,tag)=>element(tag)};
  const context={module:{exports:{Replayer}},document:outerDoc,window:{parent},parent,innerWidth:1440,innerHeight:900,TextEncoder,addEventListener:(name,fn)=>{listeners[name]=fn;},removeEventListener:(name,fn)=>{if(listeners[name]===fn)delete listeners[name];},setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout,clearInterval(){},setInterval(){return 1;},ResizeObserver:class{constructor(callback){this.callback=callback;this.targets=[];observers.push(this);}observe(n){this.targets.push(n);}disconnect(){this.disconnected=true;}},MutationObserver:class{constructor(callback){this.callback=callback;mutations.push(this);}observe(_root,options){this.options=options;}disconnect(){this.disconnected=true;}}};
  runInNewContext('(function(){'+source+'\n})();',context,{timeout:1000});
  listeners.message({source:parent,data:{type:'ten98-replay-init',protocol:1,events:[{type:4,timestamp:0,data:{width:metaWidth,height:metaHeight}},{type:2,timestamp:1,data:{node:{type:0,childNodes:[root,body,plane,target,fixed].map((n,i)=>({type:2,id:i+2}))},initialOffset:{left:0,top:0},ten98Layout:{version:1,boxes:[root,body,plane,target,fixed].map((n,i)=>{const r=n.getBoundingClientRect();return[i+2,r.left-gutter,r.top,r.width,r.height];})}}}],...replay?{}:{heatmap:{mode:'click',geometry,points:[{x:geometry.pageWidth-80,y:geometry.pageHeight-80,count:1}]}}},ports:[port]});
  return{geometry,root,body,plane,target,fixed,view,timers,messages,observers,mutations,markers,listeners,port,wrapper,destroyed:()=>destroyed,shrink(){naturalHeight-=50;},naturalRect(n){const r=n.getBoundingClientRect();return[r.left+view.scrollX,r.top+view.scrollY,r.width,r.height];}};
 }
 for(const direction of['ltr','rtl'])for(const zoom of[1,2]){
  const h=scene({direction,zoom}),before=h.naturalRect(h.target);h.timers.next();
  assert.deepEqual(h.messages,[{type:'ready',duration:1}]);assert.equal(h.markers.length,1);assert.equal(h.root.scrollWidth,h.geometry.pageWidth);assert.equal(h.root.scrollHeight,h.geometry.pageHeight);assert.deepEqual(h.naturalRect(h.target),before,'The empty extent must not move existing content.');
  assert.match(h.wrapper.children[0].style.cssText,/^position:absolute;left:2px;top:2px;/);
  const marker=h.markers[0],r=marker.getBoundingClientRect();assert.equal(r.left+h.view.scrollX,direction==='rtl'?1440-h.geometry.pageWidth:h.geometry.pageWidth-1);assert.equal(r.top+h.view.scrollY,h.geometry.pageHeight-1);assert.equal(r.width,1);assert.equal(r.height,1);assert.equal(marker.children.length,0);assert.equal(marker.attributes['aria-hidden'],'true');
  assert.equal(h.mutations[0].options.attributeOldValue,true);h.mutations[0].callback([{type:'attributes',target:h.root,attributeName:'class',oldValue:'rrweb-paused'}]);assert.equal(h.destroyed(),0,'Delayed rrweb Finish may repeat the same paused root class without changing layout.');
  if(direction==='rtl'&&zoom===1){h.shrink();assert.equal(h.root.scrollHeight,h.geometry.pageHeight,'The marker would mask natural shrink without its mutation guard.');h.mutations[0].callback([{type:'attributes',target:h.plane,attributeName:'style',oldValue:''}]);}
  else if(direction==='rtl'){h.shrink();h.observers.find(o=>o.targets.includes(h.plane)).callback([{target:h.plane}]);}
  else if(zoom===1){h.shrink();h.port.onmessage({data:{type:'heatmap-position',axis:'y',value:0}});}
  else h.port.onmessage({data:{type:'destroy'}});
  assert.equal(h.markers.length,0);assert.equal(h.destroyed(),1);assert.ok(h.observers.every(o=>o.disconnected));assert.ok(h.mutations.every(o=>o.disconnected));assert.equal(h.messages.at(-1).type,direction==='ltr'&&zoom===2?'ready':'error');const count=h.messages.length;h.mutations[0].callback([{type:'childList',target:h.body}]);assert.equal(h.messages.length,count,'Queued callbacks after teardown must be harmless.');
 }
 for(const fault of['body-scroller','body-scrolled','root-transform','body-transform','writing-mode','child-transform','animation','transition','selector-shift','axes','oversized','node-cap','quirks','shadow-root']){
  const h=scene({fault});h.timers.next();assert.equal(h.messages.at(-1).type,'error',fault);assert.equal(h.markers.length,0);assert.equal(h.destroyed(),1);
 }
 const exact=scene({exact:true,fault:'child-transform'});exact.timers.next();assert.equal(exact.messages.at(-1).type,'error','An exact outer extent does not excuse unsupported interior layout.');assert.equal(exact.markers.length,0);
 for(const fault of['root-transform','writing-mode','body-scroller','body-scrolled']){const h=scene({exact:true,fault});h.timers.next();assert.equal(h.messages.at(-1).type,'error');assert.equal(h.markers.length,0);}
 for(const exact of[false,true]){
  const h=scene({exact,fault:'scrollbar'}),before=h.naturalRect(h.target);h.timers.next();
  assert.equal(h.view.getComputedStyle(h.root).scrollbarWidth,'auto');assert.deepEqual(h.messages,[{type:'ready',duration:1}]);assert.equal(h.markers.length,exact?0:1);assert.equal(h.root.scrollWidth,h.geometry.pageWidth);assert.equal(h.root.scrollHeight,h.geometry.pageHeight);assert.deepEqual(h.naturalRect(h.target),before,'Native default scrollbar styling cannot move the restored content.');
  h.shrink();h.port.onmessage({data:{type:'heatmap-position',axis:'y',value:0}});assert.equal(h.messages.at(-1).type,'error','Default scrollbar styling retains the exact natural-drift fence.');assert.equal(h.markers.length,0);assert.equal(h.destroyed(),1);
 }
 for(const exact of[false,true]){
  const h=scene({direction:'ltr',exact,fault:'scrollbar',metaWidth:1455,metaHeight:915}),before=h.naturalRect(h.target);h.timers.next();
  assert.deepEqual(h.messages,[{type:'ready',duration:1}]);assert.equal(h.root.clientWidth,1440);assert.equal(h.root.clientHeight,900);assert.deepEqual(h.naturalRect(h.target),before,'A larger native Meta frame retains exact client geometry and content placement.');
  h.shrink();h.port.onmessage({data:{type:'heatmap-position',axis:'y',value:0}});assert.equal(h.messages.at(-1).type,'error');assert.equal(h.markers.length,0);
 }
 for(const metadata of[{metaWidth:1439},{metaHeight:899},{metaWidth:0},{metaWidth:20001},{metaWidth:1455.5}]){
  const h=scene({exact:true,...metadata});if(h.timers.size)h.timers.next();assert.equal(h.messages.at(-1).type,'error','Narrower, nonpositive, over-limit or noninteger Meta cannot admit a background.');assert.equal(h.markers.length,0);
 }
 // A classic scrollbar drawn on the left of the replay frame shifts the whole document 15 client px and narrows the client box like the recording did; the recorded top-level viewport had no such offset.
 for(const direction of['ltr','rtl'])for(const exact of[false,true]){
  const h=scene({direction,exact,gutter:15,classic:true}),before=h.naturalRect(h.target);h.timers.next();
  assert.deepEqual(h.messages,[{type:'ready',duration:1}],direction+' gutter');assert.equal(h.markers.length,exact?0:1);assert.equal(h.root.scrollWidth,h.geometry.pageWidth);assert.equal(h.root.scrollHeight,h.geometry.pageHeight);assert.deepEqual(h.naturalRect(h.target),before);
  if(!exact){const r=h.markers[0].getBoundingClientRect();assert.equal(r.left+h.view.scrollX,15+(direction==='rtl'?h.geometry.viewportWidth-h.geometry.pageWidth:h.geometry.pageWidth-1));assert.equal(r.top+h.view.scrollY,h.geometry.pageHeight-1);}
  assert.match(h.wrapper.children[0].style.cssText,/^position:absolute;left:17px;top:2px;/,'The plane follows the measured in-frame viewport origin, not client (0,0).');
  h.port.onmessage({data:{type:'destroy'}});assert.equal(h.markers.length,0);
 }
 // A gutter reserved behind hidden scrollbars narrows the initial containing block while clientWidth still reads the recorded 1440: no origin can repair that frame, so it fails closed.
 for(const direction of['ltr','rtl'])for(const exact of[false,true]){const h=scene({direction,exact,gutter:15});h.timers.next();assert.equal(h.messages.at(-1).type,'error',direction+' reserved gutter');assert.equal(h.markers.length,0);assert.equal(h.destroyed(),1);}
 const waiting=scene({mirror:false});for(let i=0;i<120&&waiting.timers.size;i++)waiting.timers.next();assert.equal(waiting.messages.at(-1).type,'error');assert.equal(waiting.markers.length,0,'A transient document outside the rebuilt rrweb mirror must never receive an extent.');assert.equal(waiting.timers.runs,120);assert.equal(waiting.timers.size,0);assert.equal(waiting.destroyed(),1);assert.deepEqual(waiting.timers.delays,[0,...Array(119).fill(16)]);
 for(const retry of[false,true]){const h=scene({mirror:false});assert.deepEqual(h.messages,[]);assert.deepEqual(h.timers.delays,[0]);if(retry){h.timers.next();assert.deepEqual(h.messages,[]);assert.deepEqual(h.timers.delays,[0,16]);}assert.equal(h.timers.size,1);h.port.onmessage({data:{type:'destroy'}});assert.equal(h.timers.size,0,'Destroy cancels initial and retry readiness tasks.');assert.equal(h.destroyed(),1);assert.deepEqual(h.messages,[]);assert.equal(h.markers.length,0);assert.equal(h.wrapper.children.length,0);}
 const added=scene({exact:true});added.timers.next();assert.equal(added.messages.at(-1).type,'ready');const beforeAdded=added.naturalRect(added.target);added.mutations[0].callback([{type:'childList',target:added.body}]);assert.deepEqual(added.naturalRect(added.target),beforeAdded);assert.equal(added.messages.at(-1).type,'error','An untracked absolute insertion must refuse an exact-extent background even when all old boxes stay unchanged.');
 const ordinary=scene({replay:true,fault:'root-transform'});assert.deepEqual(ordinary.messages,[{type:'ready',duration:1}]);assert.equal(ordinary.timers.size,0);assert.equal(ordinary.markers.length,0);ordinary.port.onmessage({data:{type:'destroy'}});
});


test('optional snapshot layout capture excludes blocked geometry and drops only evidence at unsupported or size limits',()=>{
 const asset=readFileSync(resolve('public/replay.js'),'utf8'),start=asset.indexOf('// App adapter appended inside the private CommonJS closure around pinned rrweb.'),source=asset.slice(start,asset.lastIndexOf('\n})();'));
 function capture({count=2,padding='',extra={},unsupported=false,blocked=false,blockedExtra={},blockedId=9000,blockedAttributes={rr_width:'40px',rr_height:'40px'},blockedChildren=[{type:2,id:9001,tagName:'span',isShadow:true,childNodes:[{type:2,id:9002,isShadowHost:true}]}],empty=false,scrollKind='',scrollTop=0,textLength=null,rectangles=1,inline=false,mixed=false}={}){
  let options,stopped=0;const emitted=[],lookups=[],hub={},window={__ten98FoundationHub:hub,scrollX:0,scrollY:0};
  const css={writingMode:'horizontal-tb',position:'static',transform:'none',perspective:'none',rotate:'none',scale:'none',translate:'none',animationName:'none',transitionDuration:'0s',overflowX:'visible',overflowY:'visible',display:inline?'inline':'block',whiteSpace:'normal',minHeight:'0px',maxHeight:'none',content:'none',paddingTop:'0px',paddingRight:'0px',paddingBottom:'0px',paddingLeft:'0px',borderTopWidth:'0px',borderRightWidth:'0px',borderBottomWidth:'0px',borderLeftWidth:'0px'};
  window.getComputedStyle=node=>({...css,...node===scroller&&scrollKind?{overflowY:'auto'}:{},...unsupported?{transform:'matrix(1,0,0,1,1,0)'}:{}});
  const nodes=Array.from({length:count},(_,i)=>({type:2,id:i+2,tagName:'div',attributes:{},...extra}));
  if(blocked)nodes.push({type:2,id:blockedId,tagName:'div',...blockedExtra,attributes:blockedAttributes,childNodes:blockedChildren});
  const liveNode=()=>({nodeType:1,scrollLeft:0,scrollTop:0,...textLength===null?{}:{tagName:'P',textContent:'*'.repeat(textLength),childNodes:mixed?[{nodeType:3},{nodeType:1}]:[{nodeType:3}]},getClientRects:()=>empty?[]:[{}],getBoundingClientRect:()=>({left:10,top:20,width:30,height:40})});
  const scroller={...liveNode(),scrollTop,clientHeight:300,scrollHeight:1200},root=scrollKind==='root'?scroller:liveNode();if(scrollKind==='root')window.scrollY=scrollTop;
  const record=opts=>{options=opts;return()=>{stopped++;};};record.mirror={getNode:id=>{lookups.push(id);if(id>=9000)throw Error('Private blocked geometry was read');return id===2&&scrollKind?scroller:liveNode();}};
  const document={currentScript:{getAttribute:()=> 'record'},querySelector:()=>null,documentElement:root,scrollingElement:root,body:scrollKind==='body'?scroller:liveNode(),createRange:()=>({selectNodeContents(){},getClientRects:()=>Array.from({length:rectangles},()=>({left:10,top:20,width:30,height:20}))})};
  runInNewContext('(function(){'+source+'\n})();',{module:{exports:{record}},document,window,TextEncoder},{timeout:1000});
  const stop=hub.startReplayRecorder({maskLevel:'strict',blockSelector:''},event=>emitted.push(event));assert.equal(typeof stop,'function');
  const event={type:2,timestamp:1,data:{node:{type:0,id:1,childNodes:nodes},initialOffset:{left:0,top:window.scrollY},padding}};if(padding==='byte-limit'){event.data.padding='';event.data.padding='x'.repeat(4194304-Buffer.byteLength(JSON.stringify(event))-10000);}options.emit(event);
  assert.equal(emitted.length,1);assert.ok(emitted[0]);assert.equal(stopped,0,'Optional evidence failure must leave ordinary recording running');return{event:JSON.parse(JSON.stringify(emitted[0])),lookups};
 }
 const scrollCases=[];for(const scrollKind of['root','body','div'])for(const scrollTop of[0,100])scrollCases.push(!!capture({scrollKind,scrollTop}).event.data.ten98Layout);
 assert.deepEqual(scrollCases,[true,true,false,false,false,false],'Only the actual document root may scroll: body and div must both omit metadata, including before their first scroll.');
 const visible=capture({blocked:true});assert.deepEqual(visible.event.data.ten98Layout,{version:1,boxes:[[3,10,20,30,40],[2,10,20,30,40]]});assert.deepEqual(visible.lookups,[3,2]);
 const blockedShadow=capture({blocked:true,blockedExtra:{isShadowHost:true},blockedChildren:[]});assert.deepEqual(blockedShadow.event.data.ten98Layout,visible.event.data.ten98Layout);assert.deepEqual(blockedShadow.lookups,[3,2],'Blocked host must never be measured');
 for(const extra of [{isShadow:true},{isShadowHost:true}])assert.equal(capture({extra}).event.data.ten98Layout,undefined,'Unblocked shadow trees remain unsupported');
 for(const blockedAttributes of [{rr_width:'40px'},{rr_height:'40px'},{rr_width:'NaNpx',rr_height:'40px'},{rr_width:'-1px',rr_height:'40px'},{rr_width:'10000001px',rr_height:'40px'},{rr_width:'40px',rr_height:40},{rr_width:'40px ',rr_height:'40px'}])assert.equal(capture({blocked:true,blockedExtra:{isShadowHost:true},blockedChildren:[],blockedAttributes}).event.data.ten98Layout,undefined,'Malformed blocked shadow dimensions must not bypass tree validation');
 for(const options of [{blockedId:0},{blockedId:2},{blockedExtra:{isShadow:true,isShadowHost:true}},{blockedExtra:{isShadowHost:'yes'}},{blockedExtra:{type:0,isShadowHost:true}},{blockedChildren:[{type:2,id:9001,isShadow:true}]},{blockedChildren:null},{blockedChildren:{}}])assert.equal(capture({blocked:true,blockedExtra:{isShadowHost:true},blockedChildren:[],...options}).event.data.ten98Layout,undefined,'Only empty valid blocked element hosts gain the existing exclusion');
 assert.deepEqual(capture({empty:true}).event.data.ten98Layout.boxes,[[3],[2]],'Non-rendered elements use an explicit empty marker');
 assert.equal(capture({textLength:100}).event.data.ten98Layout.version,2);
 assert.equal(capture({textLength:100,inline:true}).event.data.ten98Layout.version,1,'Inline text receives no block-restoration evidence');
 assert.equal(capture({textLength:100,mixed:true}).event.data.ten98Layout.version,1,'Mixed inline children receive no block-restoration evidence');
 for(const settings of [{textLength:8193},{textLength:200,count:200},{textLength:1,count:257},{textLength:1,rectangles:65},{textLength:1,rectangles:64,count:9}])assert.equal(capture(settings).event.data.ten98Layout,undefined,'Optional text evidence is omitted at its bounds without stopping ordinary capture');
 for(const settings of[{unsupported:true},{count:1001},{count:1000,extra:{a:1,b:1,c:1,d:1,e:1,f:1,g:1,h:1,i:1,j:1}},{count:1000,padding:'byte-limit'}]){
  const result=capture(settings);assert.equal(result.event.data.ten98Layout===undefined,true,'Evidence must be dropped for '+JSON.stringify({...settings,padding:settings.padding?.length}));assert.equal(result.event.type,2);assert.equal(result.event.data.node.childNodes.length,settings.count||2);
 }
});
