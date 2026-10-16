// Diagnostic only: evaluate this function on the isolated ordinary replay frame.
// No automatic execution; retain the original failed readiness assertion and all bounds.
// Synthetic iframe interaction equivalence and layout probes are restored before return.
export function calibrationProbe({geometry:g,point,variant}){
  const iframe=document.querySelector('iframe'),doc=iframe?.contentDocument,view=iframe?.contentWindow,root=doc?.scrollingElement;
  if(!doc||!view||root!==doc.documentElement||!doc.body||doc.compatMode!=='CSS1Compat')throw Error('Calibration document unavailable.');
  const originalStyle=root.getAttribute('style'),originalFrameStyle=iframe.getAttribute('style'),originalScrolling=iframe.getAttribute('scrolling'),originalScroll={x:view.scrollX,y:view.scrollY},result={variant,synthetic:true,rootVariantSynthetic:variant!=='original',attempts:[],restored:false};
  let marker=null,fixed=null;
  const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  const size=node=>{const r=node.getBoundingClientRect();return[r.width,r.height,node.clientWidth,node.clientHeight,node===root?0:node.scrollWidth,node===root?0:node.scrollHeight];};
  const supported=()=>root===doc.documentElement&&doc.compatMode==='CSS1Compat'&&!!doc.body&&root.clientWidth===g.viewportWidth&&root.clientHeight===g.viewportHeight&&view.getComputedStyle(root).direction===g.direction&&[root,doc.body].every(node=>{const s=view.getComputedStyle(node);return s.writingMode==='horizontal-tb'&&['transform','perspective','rotate','scale','translate'].every(key=>s[key]==='none');});
  const facts=()=>({scrolling:iframe.getAttribute('scrolling'),frameStyle:iframe.getAttribute('style'),pointerEvents:iframe.style.pointerEvents,rootStyle:root.getAttribute('style'),root:rect(root),clientWidth:root.clientWidth,clientHeight:root.clientHeight,pageWidth:root.scrollWidth,pageHeight:root.scrollHeight,clientLeft:root.clientLeft,clientTop:root.clientTop,innerWidth:view.innerWidth,innerHeight:view.innerHeight,scrollX:view.scrollX,scrollY:view.scrollY,supported:supported()});
  const restore=(node,name,value)=>{if(value===null)node.removeAttribute(name);else node.setAttribute(name,value);};
  try{
   result.interaction={qualification:'Explicitly synthetic ordinary-replay DOM equivalent of shipped enableInteract only: iframe scrolling auto and pointerEvents auto. No replay asset or captured event change.',before:facts()};
   iframe.setAttribute('scrolling','auto');iframe.style.pointerEvents='auto';result.interaction.equivalent=facts();
   if(!supported())throw Error('Exact enableInteract DOM equivalent did not reproduce the recorded root viewport.');
   if(variant==='margin-left-1')root.style.setProperty('margin-left','1px','important');
   else if(variant==='position-left-1'){root.style.setProperty('position','relative','important');root.style.setProperty('left','1px','important');}
   else if(variant!=='original')throw Error('Unknown calibration variant.');
   view.scrollTo(0,0);
   const nodes=Array.from(doc.querySelectorAll('*'));if(nodes.length>20000||nodes.some(node=>node.shadowRoot))throw Error('Calibration tree exceeds existing gate.');
   function layout(){return JSON.stringify([view.scrollX,view.scrollY,nodes.map(node=>{const r=node.getBoundingClientRect(),s=view.getComputedStyle(node),values=[r.left,r.top].concat(size(node));if(!values.every(Number.isFinite)||s.writingMode!=='horizontal-tb'||['transform','perspective','rotate','scale','translate'].some(key=>s[key]!=='none')||s.animationName!=='none'||s.transitionDuration.split(',').some(value=>parseFloat(value)!==0))throw Error('Unsupported calibration layout.');return values;})]);}
   const natural=layout(),naturalExtent={width:root.scrollWidth,height:root.scrollHeight},naturalRoot=rect(root),style=view.getComputedStyle(root);
   result.natural={extent:naturalExtent,root:naturalRoot,clientWidth:root.clientWidth,clientHeight:root.clientHeight,clientLeft:root.clientLeft,clientTop:root.clientTop,scrollX:view.scrollX,scrollY:view.scrollY,innerWidth:view.innerWidth,innerHeight:view.innerHeight,nodeCount:nodes.length,supported:supported(),style:{marginLeft:style.marginLeft,marginRight:style.marginRight,position:style.position,left:style.left,right:style.right,filter:style.filter,contain:style.contain,zoom:style.zoom}};
   const css='all:initial!important;position:absolute!important;left:0!important;top:0!important;width:1px!important;height:1px!important;display:block!important;margin:0!important;padding:0!important;border:0!important;box-sizing:border-box!important;visibility:hidden!important;pointer-events:none!important;transform:none!important;zoom:1!important;';
   fixed=doc.createElement('div');fixed.setAttribute('aria-hidden','true');fixed.style.cssText=css;fixed.style.setProperty('position','fixed','important');root.appendChild(fixed);
   const fixedZero=rect(fixed);fixed.style.setProperty('left','1px','important');const fixedX=rect(fixed);fixed.style.setProperty('left','0px','important');fixed.style.setProperty('top','1px','important');const fixedY=rect(fixed);fixed.remove();fixed=null;
   result.fixed={zero:fixedZero,dx:fixedX.left-fixedZero.left,dy:fixedY.top-fixedZero.top,layoutUnchanged:layout()===natural,extentUnchanged:root.scrollWidth===naturalExtent.width&&root.scrollHeight===naturalExtent.height};
   for(const name of ['original','root-box-origin','fixed-origin','absolute-zero-origin']){
    const attempt={name};result.attempts.push(attempt);
    marker=doc.createElement('div');marker.setAttribute('aria-hidden','true');marker.setAttribute('data-ten98-calibration-probe','');marker.style.cssText=css;root.appendChild(marker);
    const box=()=>{const r=marker.getBoundingClientRect();return{left:r.left+view.scrollX,top:r.top+view.scrollY,width:r.width,height:r.height};};
    attempt.insertLayoutUnchanged=layout()===natural;
    const zero=box();marker.style.setProperty('left','1px','important');const x=box();marker.style.setProperty('left','0px','important');marker.style.setProperty('top','1px','important');const y=box(),dx=x.left-zero.left,dy=y.top-zero.top;
    const ox=name==='original'?0:name==='root-box-origin'?naturalRoot.left:name==='fixed-origin'?fixedZero.left:zero.left;
    const oy=name==='original'?0:name==='root-box-origin'?naturalRoot.top:name==='fixed-origin'?fixedZero.top:zero.top;
    const left=ox+(g.direction==='rtl'?g.viewportWidth-g.pageWidth:g.pageWidth-1),top=oy+g.pageHeight-1;
    attempt.axes={zero,x,y,dx,dy,originX:ox,originY:oy};
    attempt.axesExact=[zero.left,zero.top,zero.width,zero.height,dx,dy].every(Number.isFinite)&&dx>0&&dy>0&&x.top===zero.top&&y.left===zero.left&&zero.width===dx&&zero.height===dy;
    if(attempt.axesExact){
     marker.style.setProperty('left',String((left-zero.left)/dx)+'px','important');marker.style.setProperty('top',String((top-zero.top)/dy)+'px','important');marker.style.setProperty('width',String(1/dx)+'px','important');marker.style.setProperty('height',String(1/dy)+'px','important');
     const placed=box();attempt.target={left,top,width:1,height:1};attempt.placed=placed;
     attempt.gates={placementExact:placed.left===left&&placed.top===top&&placed.width===1&&placed.height===1,layoutUnchanged:layout()===natural,rootSupported:supported(),widthExact:root.scrollWidth===g.pageWidth,heightExact:root.scrollHeight===g.pageHeight};
     attempt.extent={width:root.scrollWidth,height:root.scrollHeight};attempt.accepted=attempt.insertLayoutUnchanged&&attempt.axesExact&&Object.values(attempt.gates).every(Boolean);
     view.scrollTo(g.direction==='rtl'?0:g.pageWidth-g.viewportWidth,g.pageHeight-g.viewportHeight);
     const target=doc.getElementById('target');if(!target)throw Error('Recorded calibration target missing.');
     const r=rect(target),center={x:point.x-(view.scrollX+(g.direction==='rtl'?g.pageWidth-g.viewportWidth:0))+ox,y:point.y-view.scrollY+oy};
     attempt.coordinate={target:r,center,deltaX:center.x-(r.left+r.right)/2,deltaY:center.y-(r.top+r.bottom)/2,inside:center.x>=r.left&&center.x<=r.right&&center.y>=r.top&&center.y<=r.bottom,scrollX:view.scrollX,scrollY:view.scrollY};
    }
    marker.remove();marker=null;view.scrollTo(0,0);
    attempt.restored=layout()===natural&&root.scrollWidth===naturalExtent.width&&root.scrollHeight===naturalExtent.height;
    if(!attempt.restored)throw Error('Calibration marker changed the retained layout.');
   }
  }finally{
   if(marker)marker.remove();if(fixed)fixed.remove();
   restore(root,'style',originalStyle);restore(iframe,'scrolling',originalScrolling);restore(iframe,'style',originalFrameStyle);
   view.scrollTo(originalScroll.x,originalScroll.y);const styleAfterScroll=root.getAttribute('style');
   if(styleAfterScroll!==originalStyle)restore(root,'style',originalStyle);
   const restored=facts();result.restoration={rootStyleBefore:originalStyle,rootStyleAfterScroll:styleAfterScroll,rootStyleAfter:restored.rootStyle,ordinaryBefore:result.interaction?.before,ordinaryAfter:restored};
   result.restored=!!result.interaction&&JSON.stringify(restored)===JSON.stringify(result.interaction.before)&&!doc.querySelector('[data-ten98-calibration-probe]');
  }
  return result;
 }
