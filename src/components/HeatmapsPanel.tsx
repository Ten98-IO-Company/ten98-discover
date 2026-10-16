import {useEffect,useMemo,useRef,useState} from 'react';
import {z} from 'zod';
import {ApiError} from '../lib/api';
import {readHeatmapQuery,heatmapPages,heatmapGeometries,heatmapClicks,heatmapScroll,heatmapBackgroundPage,type HeatmapOverlay,type ReplayEventLocator,type HeatmapQuery} from '../lib/replay-heatmaps';
import {InvalidReplay,readReplayResponse,ReplayPreview} from './SessionReplayPanel';
import {boundedTree,reassembleReplay,type ReplayEvent} from '../lib/session-replay';

type Props={projectId:string;userId:string;query?:string;onNavigate:(query:string)=>void;onUnauthorized:()=>void;onSettings?:()=>void;readOwner?:string;readEnabled?:boolean};
const schema=z.union([heatmapPages,heatmapGeometries,heatmapClicks,heatmapScroll]);
type Report=z.infer<typeof schema>;
const count=(value:number|null)=>value===null?'Unavailable':new Intl.NumberFormat('en-US').format(value);
function serialize(value:HeatmapQuery){const p=new URLSearchParams({from:value.from,to:value.to,mode:value.mode});for(const key of ['origin','path','geometry','cursor'] as const){const v=value[key];if(v!==undefined)p.set(key,v);}return p.toString();}
function selection(raw:string){return readHeatmapQuery(raw);}
const layout=(value:{pageWidth:number;pageHeight:number;viewportWidth:number;viewportHeight:number;direction:string})=>`${value.viewportWidth} × ${value.viewportHeight} viewport · ${value.pageWidth} × ${value.pageHeight} document · ${value.direction.toUpperCase()}`;

export function HeatmapsPanel({projectId,userId,query='',onNavigate,onUnauthorized,onSettings,readOwner='',readEnabled=true}:Props){
 const parsed=useMemo(()=>{try{if(!z.uuid().safeParse(projectId).success||query.length>6144)throw Error();return{value:selection(query)};}catch{return{value:null};}},[query,userId,projectId]);
 const applied=parsed.value,owner=JSON.stringify([userId,projectId,readOwner,applied??query]);
 const [result,setResult]=useState<{owner:string;data:Report;generation:number}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[draft,setDraft]=useState(()=>({from:applied?.from??'',to:applied?.to??''})),[draftError,setDraftError]=useState(''),[tablePage,setTablePage]=useState(0),[filter,setFilter]=useState('');
 const serial=useRef(0),operation=useRef<AbortController|null>(null),mounted=useRef(false),blocked=useRef(false),notified=useRef(false),back=useRef<string[]>([]),live=useRef({owner,readEnabled,onUnauthorized});live.current={owner,readEnabled,onUnauthorized};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;serial.current++;operation.current?.abort();};},[]);
 useEffect(()=>{blocked.current=false;notified.current=false;back.current=[];setFilter('');},[userId,projectId]);
 useEffect(()=>{setDraft({from:applied?.from??'',to:applied?.to??''});setDraftError('');},[userId,projectId,applied?.from,applied?.to]);
 useEffect(()=>{serial.current++;operation.current?.abort();setResult(null);setError('');setBusy(false);setTablePage(0);if(applied&&readEnabled)void load();return()=>{serial.current++;operation.current?.abort();};},[owner,readEnabled]);
 async function load(recover=false){
  if(!mounted.current||!applied||!readEnabled||blocked.current&&!recover)return;operation.current?.abort();const ctrl=new AbortController(),token=++serial.current;operation.current=ctrl;if(recover)blocked.current=false;setBusy(true);setError('');
  const current=()=>mounted.current&&live.current.owner===owner&&live.current.readEnabled&&serial.current===token&&!ctrl.signal.aborted;
  try{const data=await readReplayResponse(`/api/projects/${projectId}/heatmaps?${serialize(applied)}`,schema,ctrl.signal);if(!current())return;if(data.projectId!==projectId||serialize(data.query)!==serialize(applied))throw new InvalidReplay('The heatmap response did not match this project and applied scope.');setResult({owner,data,generation:token});setTablePage(0);}
  catch(cause){if(!current())return;if(cause instanceof InvalidReplay||cause instanceof ApiError&&[401,403,404].includes(cause.status)){blocked.current=true;setResult(null);setError('Heatmap access or response could not be verified. Recorded values were cleared.');if(cause instanceof ApiError&&cause.status===401&&!notified.current){notified.current=true;live.current.onUnauthorized();}}else{setError(cause instanceof ApiError&&cause.status===400?'This live page is no longer available. Start from the first page.':'The heatmap read was not completed. Reload to try this read again.');}}
  finally{if(current())setBusy(false);if(operation.current===ctrl)operation.current=null;}
 }
 function navigate(value:HeatmapQuery,remember=true){const next=serialize(value);if(applied&&next===serialize(applied)){void load(true);return;}if(remember&&applied)back.current.push(serialize(applied));serial.current++;operation.current?.abort();blocked.current=false;setResult(null);setError('');setBusy(true);onNavigate(next);}
 function previous(){const value=back.current.pop();if(value!==undefined)navigate(selection(value),false);}
 function apply(){try{const value=selection(new URLSearchParams({from:draft.from,to:draft.to,mode:'pages'}).toString());back.current=[];navigate(value,false);}catch{setDraftError('Choose 1–366 valid UTC days, with From on or before To.');}}
 const data=readEnabled&&result?.owner===owner?result.data:null,pages=data&&'items'in data?data:null,clicks=data&&'points'in data?data:null,scroll=data&&'bands'in data?data:null;
 const geometry=clicks?.geometry??scroll?.geometry??null,canSettings=!error&&(data?.role==='owner'||data?.role==='admin');
 const backgroundCurrent=()=>mounted.current&&live.current.owner===owner&&live.current.readEnabled&&result?.generation===serial.current;
 const overlay:HeatmapOverlay|null=geometry&&clicks&&clicks.totals.observations!==null?{mode:'click',geometry,points:clicks.points}:geometry&&scroll&&scroll.captures!==null&&scroll.bands.every(b=>b.captures!==null)?{mode:'scroll',geometry,captures:scroll.captures,bands:scroll.bands.flatMap(b=>b.captures===null?[]:[{depth:b.depth,captures:b.captures}])}:null;
 const shownPages=pages&&'origin'in(pages.items[0]??{})?pages.items.filter(item=>'path'in item&&item.path.toLowerCase().includes(filter.toLowerCase())):null;
 const points=clicks?.points.slice(tablePage*50,tablePage*50+50)??[],max=clicks?Math.max(1,...clicks.points.map(point=>point.count)):1;
 return <section className="research-panel heatmaps-panel" aria-label="Heatmaps" aria-busy={busy}>
  <header><h2>Heatmaps</h2><p className="hint">Review sampled clicks and scroll depth on one captured page layout. Captured documents are not people, sessions or visits. Replay permission is separate.</p>{canSettings&&onSettings&&<button type="button" className="btn" onClick={onSettings}>Heatmap collection settings</button>}</header>
  {!applied?<div className="alert" role="alert"><p>This heatmap link has invalid, repeated or unsupported parameters. No observations were read.</p><button type="button" className="btn" onClick={()=>onNavigate('')}>Reset heatmap view</button></div>:!readEnabled?<p role="status">Waiting for the current heatmap route. No observations are being read.</p>:<>
   <form className="heatmap-filters" onSubmit={event=>{event.preventDefault();apply();}}><label>From (UTC)<input type="date" required value={draft.from} onChange={event=>setDraft(old=>({...old,from:event.target.value}))}/></label><label>To (UTC)<input type="date" required value={draft.to} onChange={event=>setDraft(old=>({...old,to:event.target.value}))}/></label><button type="submit" className="btn primary" disabled={busy}>Apply dates</button></form>{draftError&&<p role="alert">{draftError}</p>}
   <div className="row"><button type="button" className="btn" disabled={busy} onClick={()=>void load(true)}>Reload heatmap</button>{back.current.length>0&&<button type="button" className="btn" disabled={busy} onClick={previous}>Back</button>}{applied.mode!=='pages'&&<button type="button" className="btn" disabled={busy} onClick={()=>navigate({from:applied.from,to:applied.to,mode:'pages'})}>Choose another page</button>}</div>
   <p className="hint">Applied dates: {applied.from} to {applied.to} · UTC</p>{busy&&<p role="status">Loading heatmap observations…</p>}{error&&<div className="alert" role="alert"><p>{error}</p><button type="button" className="btn" onClick={()=>{back.current=[];navigate({from:applied.from,to:applied.to,mode:'pages'},false);}}>Start from first page</button></div>}
   {data&&<>
    {!data.enabled&&<p className="banner" role="status">Heatmap collection is off. Retained observations can still be read.</p>}{data.coverage!=='complete'&&<p className="banner" role="status">{data.coverage==='unavailable'?'This range is unavailable after retention. Missing observations are not zero.':'Only part of these dates is retained. Earlier observations are unavailable, not zero.'}</p>}
    {applied.origin&&<header><h3><bdi>{applied.path}</bdi></h3><p><bdi>{applied.origin}</bdi></p></header>}
    {pages&&<section className="card stack" aria-label={applied.mode==='pages'?'Captured pages':'Captured layouts'}><h3>{applied.mode==='pages'?'Choose a page':'Choose one captured layout'}</h3>{shownPages&&<label>Filter this page of results<input type="search" value={filter} onChange={event=>setFilter(event.target.value)}/></label>}
     {pages.items.length===0?<p>{data.coverage==='unavailable'?'No retained page layouts are available.':'No observations match this applied range.'}</p>:<ul className="heatmap-choices">{pages.items.map(item=>{
      if('origin'in item){if(filter&&!item.path.toLowerCase().includes(filter.toLowerCase()))return null;return <li key={item.key}><button type="button" className="btn" disabled={busy} onClick={()=>navigate({from:applied.from,to:applied.to,mode:'geometries',origin:item.origin,path:item.path})}><span><bdi>{item.path}</bdi><small><bdi>{item.origin}</bdi></small></span><span>{count(item.captures)} captured documents</span></button></li>;}
      return <li key={item.key}><button type="button" className="btn" disabled={busy} onClick={()=>navigate({from:applied.from,to:applied.to,mode:'click',origin:applied.origin,path:applied.path,geometry:item.key})}><span>{layout(item.geometry)}</span><span>{count(item.captures)} captured documents</span></button></li>;
     })}</ul>}{shownPages&&filter&&shownPages.length===0&&pages.items.length>0&&<p>No matching paths on this page of results.</p>}
     <div className="row">{back.current.length>0&&<button type="button" className="btn" disabled={busy} onClick={previous}>Previous results</button>}<button type="button" className="btn" disabled={busy||pages.nextCursor===null} onClick={()=>{if(pages.nextCursor)navigate({...applied,cursor:pages.nextCursor});}}>Next 20 results</button></div><p className="hint">Live pages contain up to 20 results. Changing retention or new observations can change later pages.</p>
    </section>}
    {(clicks||scroll)&&<section className="card stack" aria-label="Selected layout heatmap"><div className="row"><h3>{geometry?layout(geometry):'Captured layout unavailable'}</h3><div className="row" aria-label="Heatmap type"><button type="button" className={applied.mode==='click'?'btn primary':'btn'} aria-pressed={applied.mode==='click'} disabled={busy||applied.mode==='click'} onClick={()=>navigate({...applied,mode:'click'})}>Clicks</button><button type="button" className={applied.mode==='scroll'?'btn primary':'btn'} aria-pressed={applied.mode==='scroll'} disabled={busy||applied.mode==='scroll'} onClick={()=>navigate({...applied,mode:'scroll'})}>Scroll depth</button></div></div>
     {overlay&&<HistoricalBackground key={owner+':background:'+result?.generation} projectId={projectId} query={applied} readEnabled={readEnabled&&!busy&&result?.generation===serial.current} owner={owner}
 overlay={overlay}
 onRole={role=>{if(backgroundCurrent())setResult(old=>old?.owner===owner?{...old,data:{...old.data,role:old.data.role==='viewer'?'viewer':role}}:old);}}
 onAccessLoss={cause=>{if(!backgroundCurrent())return;blocked.current=true;serial.current++;operation.current?.abort();setResult(null);setBusy(false);setError('Heatmap access or background response could not be verified. Recorded values were cleared.');if(cause instanceof ApiError&&cause.status===401&&!notified.current){notified.current=true;live.current.onUnauthorized();}}}/>}
     {clicks&&<><dl className="session-metrics"><div><dt>Recorded clicks</dt><dd>{count(clicks.totals.observations)}</dd></div><div><dt>Captured documents</dt><dd>{count(clicks.totals.captures)}</dd></div></dl>{clicks.totals.observations===null||geometry===null?<p>Click observations are unavailable for this layout and range.</p>:clicks.points.length===0?<p>No clicks were recorded for this retained layout and range.</p>:<>
      <svg className="heatmap-plane" role="img" aria-label="Recorded click density on the selected document plane" viewBox={`0 0 ${geometry.pageWidth} ${geometry.pageHeight}`} preserveAspectRatio="xMidYMid meet" style={{direction:'ltr'}}><rect width={geometry.pageWidth} height={geometry.pageHeight} fill="var(--color-surface-subtle)"/>{clicks.points.map(point=><circle key={point.x+':'+point.y} cx={point.x} cy={point.y} r={Math.max(geometry.pageWidth,geometry.pageHeight)/150} fill="var(--color-chart-1)" opacity={0.15+0.85*Math.sqrt(point.count/max)}><title>{point.x}, {point.y}: {count(point.count)} recorded clicks</title></circle>)}</svg><p className="hint">Document scaled to fit. Only this exact geometry is shown; responsive layouts are not merged.</p>
      <div className="table-wrap" role="region" aria-label="Recorded click coordinates" tabIndex={0}><table><thead><tr><th scope="col">Document X</th><th scope="col">Document Y</th><th scope="col">Recorded clicks</th></tr></thead><tbody>{points.map(point=><tr key={point.x+':'+point.y}><td>{point.x}</td><td>{point.y}</td><td>{count(point.count)}</td></tr>)}</tbody></table></div><p>Rows {tablePage*50+1}–{Math.min((tablePage+1)*50,clicks.points.length)} of {count(clicks.points.length)} returned coordinate groups.</p><div className="row"><button type="button" className="btn" disabled={tablePage===0} onClick={()=>setTablePage(old=>old-1)}>Previous 50 coordinates</button><button type="button" className="btn" disabled={(tablePage+1)*50>=clicks.points.length} onClick={()=>setTablePage(old=>old+1)}>Next 50 coordinates</button></div>
     </>}{clicks.totals.limited&&<p className="banner">{count(clicks.totals.returnedGroups)} of {count(clicks.totals.groups)} coordinate groups returned; {count(clicks.totals.omittedGroups)} groups are omitted. Total recorded clicks include omitted groups.</p>}</>}
     {scroll&&<><p><strong>{count(scroll.captures)}</strong> captured documents with scroll observations.</p>{scroll.captures===null?<p>Scroll depth is unavailable for this layout and range.</p>:<><div className="table-wrap" role="region" aria-label="Recorded scroll depth" tabIndex={0}><table><thead><tr><th scope="col">Reached at least</th><th scope="col">Captured documents</th><th scope="col">Share</th></tr></thead><tbody>{scroll.bands.map(band=><tr key={band.depth}><th scope="row">{band.depth}% of document height</th><td>{count(band.captures)}</td><td>{scroll.captures===null?'Unavailable':scroll.captures===0?'No captured documents':`${((band.captures??0)/scroll.captures*100).toFixed(1)}%`}</td></tr>)}</tbody></table></div><p className="hint">Each captured document is counted once at its maximum observed depth. Bands are cumulative and must not be added together.</p></>}</>}
    </section>}
    <details className="card"><summary>Observation and retention evidence</summary><p>Snapshot: <time dateTime={data.asOf}>{data.asOf}</time>.</p><p>Retained from: <time dateTime={data.retainedFrom}>{data.retainedFrom}</time>.</p><p>Sampling, consent, exclusions and privacy settings can leave activity unobserved. Zero means no matching retained observation, never proof of no activity.</p>{geometry&&<p>Coordinate basis: {geometry.basis} · Direction: {geometry.direction}. Numeric observations contain no DOM or page text.</p>}</details>
   </>}
  </>}
 </section>;
}

function HistoricalBackground({projectId,query,owner,readEnabled,overlay,onRole,onAccessLoss}:{projectId:string;query:HeatmapQuery;owner:string;readEnabled:boolean;overlay:HeatmapOverlay;onRole:(role:'owner'|'admin'|'editor'|'viewer')=>void;onAccessLoss:(cause:unknown)=>void}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('No historical sample has been loaded. Numeric observations remain available.'),[progress,setProgress]=useState(0),[preview,setPreview]=useState<{events:ReplayEvent[];duration:number;at:string}|null>(null);
 const operation=useRef<AbortController|null>(null),serial=useRef(0),mounted=useRef(false),live=useRef({owner,readEnabled});live.current={owner,readEnabled};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;serial.current++;operation.current?.abort();};},[]);
 useEffect(()=>{serial.current++;operation.current?.abort();setBusy(false);setPreview(null);},[owner,readEnabled]);
 async function load(){
  if(!readEnabled||busy)return;operation.current?.abort();const ctrl=new AbortController(),id=++serial.current;operation.current=ctrl;setBusy(true);setPreview(null);setMessage('');setProgress(0);
  const current=()=>mounted.current&&live.current.owner===owner&&live.current.readEnabled&&!ctrl.signal.aborted&&serial.current===id;
  const signal=AbortSignal.any([ctrl.signal,AbortSignal.timeout(120000)]),chunks:z.infer<typeof heatmapBackgroundPage>['chunks']=[];
  let reference:z.infer<typeof heatmapBackgroundPage>['reference']=null,after:number|null=null,bytes=0,role:z.infer<typeof heatmapBackgroundPage>['role']|null=null;
  const invalid=()=>new InvalidReplay('This background did not match the exact retained page layout.');
  const digest=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),n=>n.toString(16).padStart(2,'0')).join('');
  try{
   for(let page=0;page<32;page++){
    const params=new URLSearchParams(serialize(query));if(after!==null)params.set('after',String(after));
    const value=await readReplayResponse('/api/projects/'+projectId+'/heatmaps/background?'+params,heatmapBackgroundPage,signal);if(!current())return;if(signal.aborted)throw Error('Historical sample load timed out.');
    if(value.projectId!==projectId||serialize(value.query)!==serialize(query))throw invalid();
    if(value.state!=='available'||!value.reference||!value.item){onRole(value.role);
     setMessage(value.state==='expired'?'The historical sample expired. Numeric observations can have a different retention period.':value.state==='incomplete'?'The historical sample is incomplete. No missing page content was invented.':value.state==='unsupported'?'This historical sample cannot be aligned with the captured layout.':'No matching retained historical sample is available. Older numeric captures were not retroactively attached.');
     return;
    }
    if(JSON.stringify(value.reference.geometry)!==JSON.stringify(overlay.geometry)||reference&&JSON.stringify(value.reference)!==JSON.stringify(reference))throw invalid();
    reference=value.reference;role=role==='viewer'?'viewer':value.role;let prior=after??-1;
    for(const chunk of value.chunks){if(chunk.sequence<=prior||!reference.sequences.includes(chunk.sequence))throw invalid();boundedTree(chunk.parts);prior=chunk.sequence;bytes+=chunk.bytes;if(bytes>33554432||chunks.length>=128)throw invalid();chunks.push(chunk);}
    if(!current())return;setProgress(chunks.length);
    if(value.nextAfter!==null){if(value.chunks.length!==4||value.nextAfter<= (after??-1))throw invalid();after=value.nextAfter;continue;}
    const expectedSequences=reference.sequences;if(chunks.length!==expectedSequences.length||chunks.some((c,i)=>c.sequence!==expectedSequences[i]))throw invalid();
    async function locate(locator:ReplayEventLocator):Promise<ReplayEvent>{
     let event:ReplayEvent;
     if(locator.kind==='event'){
      const chunk=chunks.find(c=>c.sequence===locator.sequence),part=chunk?.parts[locator.index];
      if(!chunk||chunk.sha256!==locator.chunkSha256||!part||part.type==='fragment')throw invalid();event=part;
     }else{
      const assembled=reassembleReplay(chunks.flatMap(c=>c.parts).filter(part=>part.type==='fragment'&&part.id===locator.fragmentId));
      if(assembled.missingFragments.length||assembled.events.length!==1)throw invalid();event=assembled.events[0];
     }
     boundedTree(event);if(await digest(event)!==locator.eventSha256)throw invalid();return event;
    }
    const meta=await locate(reference.meta),snapshot=await locate(reference.snapshot);if(!current())return;if(signal.aborted)throw Error('Historical sample load timed out.');
    if(query.origin===undefined||query.path===undefined||meta.type!==4||snapshot.type!==2||meta.timestamp>snapshot.timestamp||meta.data.href!==query.origin+query.path||
     Number(meta.data.width)<overlay.geometry.viewportWidth||Number(meta.data.height)<overlay.geometry.viewportHeight||new Date(snapshot.timestamp).toISOString()!==reference.observedAt)throw invalid();
    if(role!==null)onRole(role);setPreview({events:[meta,snapshot],duration:snapshot.timestamp-meta.timestamp,at:reference.observedAt});setMessage('');return;
   }
   throw invalid();
  }catch(cause){
   if(!current())return;setPreview(null);
   if(cause instanceof InvalidReplay||cause instanceof ApiError&&[401,403,404].includes(cause.status)){onAccessLoss(cause);return;}
   setMessage(cause instanceof ApiError&&cause.status===429?'Loading paused. Try again after a minute.':'The historical sample could not be loaded. Retry this free read; no recording or collection is started.');
  }finally{if(current())setBusy(false);if(operation.current===ctrl)operation.current=null;}
 }
 function cancel(){serial.current++;operation.current?.abort();operation.current=null;setBusy(false);setPreview(null);setMessage('Loading cancelled. Numeric observations were kept.');}
 return <section className="stack" aria-label="Historical heatmap sample" style={{gridTemplateColumns:'minmax(0,1fr)',minWidth:0}}>
  <p className="banner">Historical sample: one consenting captured document, not the background of every aggregate point. Masking and blocked resources may leave content unavailable. No live website is fetched.</p>
  <div className="row"><button className="btn" type="button" disabled={!readEnabled||busy} onClick={()=>void load()}>Load historical sample</button>{busy&&<button className="btn" type="button" onClick={cancel}>Cancel sample loading</button>}{preview&&<button className="btn" type="button" onClick={()=>{setPreview(null);setMessage('Historical sample closed. Numeric observations were kept.');}}>Close historical sample</button>}</div>
  {busy&&<p role="status">Loading historical sample data… {progress} verified parts.</p>}{message&&<p role="status">{message}</p>}
  {readEnabled&&preview&&<><p>Recorded sample time: <time dateTime={preview.at}>{new Date(preview.at).toLocaleString()}</time>. This is the original browser timestamp.</p><ReplayPreview key={owner+preview.at} events={preview.events} duration={preview.duration} heatmap={overlay}/></>}
 </section>;
}
