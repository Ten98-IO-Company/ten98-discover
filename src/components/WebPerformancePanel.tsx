import {useEffect,useId,useMemo,useRef,useState,type FormEvent} from 'react';
import {Inline,Stack,TimeSeriesChart,type ChartSeries} from '@ten98/ui';
import {ApiError} from '../lib/api';
import {analyticsDay} from '../lib/navigation';
import {environmentCatalog,isEnvironmentFilter} from '../lib/analytics-environment';
import {performanceMetrics,performanceBreakdowns,performanceLabels,performanceReport,performanceRating,performanceValue,performanceQuery,readPerformanceQuery,type PerformanceIntent,type PerformanceMetric,type PerformanceReport,type PerformanceStats} from '../lib/web-performance';

type Props={projectId:string;userId:string;query?:string;onNavigate:(query:string)=>void;onUnauthorized:()=>void;onSettings?:()=>void;readOwner?:string;readEnabled?:boolean};
type Draft=Pick<PerformanceIntent,'from'|'to'|'filters'|'path'>;
const labels={path:'Page path',browser:'Browser',os:'Operating system',device:'Device'},ratings={good:'Good','needs-improvement':'Needs improvement',poor:'Poor',unavailable:'Unavailable'};
const clean=(value:string)=>!/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value),safeCount=(value:number)=>Number.isSafeInteger(value)&&value>=0;
const draftOf=(intent:PerformanceIntent):Draft=>({from:intent.from,to:intent.to,filters:{...intent.filters},...intent.path===undefined?{}:{path:intent.path}});
const initial=()=>readPerformanceQuery(new URLSearchParams());

function verified(value:unknown,projectId:string,intent:PerformanceIntent):PerformanceReport{
  const parsed=performanceReport.safeParse(value);
  if(!parsed.success)throw new Error('This performance report could not be verified. Reload the report.');
  const report=parsed.data,start=analyticsDay(intent.from)!,days=(analyticsDay(intent.to)!-start)/86400000+1,selected=report.summary[intent.metric];
  const validStats=(stats:PerformanceStats,metric:PerformanceMetric)=>safeCount(stats.count)&&[stats.p50,stats.p75,stats.p95].every(n=>n===null||n<=(metric==='cls'?1000:3600000));
  if(report.projectId!==projectId||JSON.stringify(report.query)!==JSON.stringify(intent)||performanceMetrics.some(metric=>!validStats(report.summary[metric],metric))||report.daily.length!==days||report.daily.some((row,index)=>row.day!==new Date(start+index*86400000).toISOString().slice(0,10)||!validStats(row.stats,intent.metric))||report.daily.reduce((sum,row)=>sum+row.stats.count,0)!==selected.count)throw new Error('This performance report does not match the applied scope. Reload the report.');
  const keys=new Set<string>();let count=0;
  for(const item of report.breakdown.items){
    const key=JSON.stringify(item.value);
    if(keys.has(key)||!validStats(item.stats,intent.metric)||item.stats.count===0||item.value!==null&&(!clean(item.value)||item.value.length>2048||(intent.breakdown==='path'?(!item.value.startsWith('/')||/[?#]/.test(item.value)):!isEnvironmentFilter(intent.breakdown,item.value))))throw new Error('The performance breakdown could not be verified. Reload the report.');
    keys.add(key);count+=item.stats.count;
  }
  if(!safeCount(count)||count>selected.count||!report.breakdown.limited&&count!==selected.count)throw new Error('The performance breakdown counts do not match this report. Reload the report.');
  return report;
}

async function readReport(path:string,signal:AbortSignal,projectId:string,intent:PerformanceIntent){
  const combined=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    const response=await fetch(path,{credentials:'same-origin',redirect:'error',cache:'no-store',signal:combined});
    if(!response.ok){await response.body?.cancel().catch(()=>{});const error=new ApiError(response.status===401?'Your session expired. Sign in again.':[403,404].includes(response.status)?'Project access changed. Performance results were cleared.':'The performance report could not be loaded. Try Reload report.');error.status=response.status;throw error;}
    const length=response.headers.get('content-length'),identity=!response.headers.get('content-encoding')||response.headers.get('content-encoding')==='identity';
    if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||length!==null&&(!/^(0|[1-9]\d*)$/.test(length)||Number(length)>2097152)||!response.body)throw new Error('This performance response could not be verified. Reload the report.');
    reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
    for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2097152)throw new Error('This performance report is too large. Choose a shorter date range.');text+=decoder.decode(part.value,{stream:true});}
    text+=decoder.decode();if(identity&&length!==null&&Number(length)!==bytes)throw new Error('This performance response was incomplete. Reload the report.');
    return verified(JSON.parse(text),projectId,intent);
  }catch(cause){if(signal.aborted)throw cause;if(cause instanceof ApiError||cause instanceof Error&&cause.message.startsWith('This performance')||cause instanceof Error&&cause.message.startsWith('The performance breakdown'))throw cause;throw new Error('The performance report was not received completely. Reload the report.');}
  finally{await reader?.cancel().catch(()=>{});}
}

export function WebPerformancePanel({projectId,userId,query='',onNavigate,onUnauthorized,onSettings,readOwner='',readEnabled=true}:Props){
  const uid=useId(),identity=JSON.stringify([userId,projectId,readOwner]);
  const parsed=useMemo(()=>{try{const intent=readPerformanceQuery(query);return{intent,canonical:performanceQuery(intent),error:''};}catch{return{intent:null,canonical:'',error:'This performance link has unsupported, repeated or invalid filters. Reset the view before loading a report.'};}},[query,identity]);
  const owner=JSON.stringify([identity,parsed.canonical]),[draft,setDraft]=useState<Draft>(()=>draftOf(parsed.intent??initial())),[view,setView]=useState<{owner:string;data?:PerformanceReport;error?:string;loading:boolean}>({owner:'',loading:false}),[denied,setDenied]=useState(false),[draftError,setDraftError]=useState('');
  const generation=useRef(0),operation=useRef<AbortController|null>(null),mounted=useRef(false),blocked=useRef(false),notified=useRef(false),live=useRef({owner,identity,readEnabled,onUnauthorized});live.current={owner,identity,readEnabled,onUnauthorized};
  const scope=parsed.intent?JSON.stringify(draftOf(parsed.intent)):'';
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;operation.current?.abort();};},[]);
  useEffect(()=>{blocked.current=false;notified.current=false;setDenied(false);setDraftError('');},[identity]);
  useEffect(()=>{setDraft(draftOf(parsed.intent??initial()));setDraftError('');},[identity,scope]);
  useEffect(()=>{
    generation.current++;operation.current?.abort();operation.current=null;setView({owner,loading:false});
    if(parsed.intent&&readEnabled&&!blocked.current)void load();
    return()=>{generation.current++;operation.current?.abort();operation.current=null;};
  },[owner,readEnabled]);
  async function load(recover=false){
    if(!parsed.intent||!readEnabled||!mounted.current||blocked.current&&!recover)return;
    operation.current?.abort();const controller=new AbortController(),token=++generation.current;operation.current=controller;if(recover){blocked.current=false;setDenied(false);}setView({owner,loading:true});
    const current=()=>mounted.current&&live.current.owner===owner&&live.current.readEnabled&&generation.current===token&&!controller.signal.aborted;
    try{const data=await readReport(`/api/projects/${projectId}/performance?${parsed.canonical}`,controller.signal,projectId,parsed.intent);if(current())setView({owner,data,loading:false});}
    catch(cause){if(!current())return;if(cause instanceof ApiError&&[401,403,404].includes(cause.status)){blocked.current=true;setDenied(true);setView({owner,error:cause.message,loading:false});if(cause.status===401&&!notified.current){notified.current=true;live.current.onUnauthorized();}}else setView({owner,error:cause instanceof Error?cause.message:'This performance report could not be verified. Reload the report.',loading:false});}
    finally{if(operation.current===controller)operation.current=null;}
  }
  function apply(event:FormEvent){event.preventDefault();if(!parsed.intent)return;try{const next=readPerformanceQuery(new URLSearchParams(performanceQuery({...parsed.intent,...draft})));setDraftError('');if(performanceQuery(next)===parsed.canonical)void load(true);else onNavigate(performanceQuery(next));}catch{setDraftError('Choose valid UTC dates covering 1 to 366 days and supported exact filters.');}}
  function change(value:Partial<PerformanceIntent>){if(parsed.intent&&!blocked.current)onNavigate(performanceQuery({...parsed.intent,...value}));}
  const report=readEnabled&&view.owner===owner&&!denied?view.data:undefined,intent=parsed.intent,busy=readEnabled&&view.owner===owner&&view.loading,percentile=intent?.percentile??75,pKey=percentile===50?'p50':percentile===95?'p95':'p75',metric=intent?.metric??'lcp',selected=report?.summary[metric];
  const changed=!!intent&&JSON.stringify(draft)!==JSON.stringify(draftOf(intent)),disabled=!intent||!readEnabled||denied;
  const chartTop=Math.max(0,...(report?.daily.map(row=>row.stats[pKey]??0)??[]))||1;
  // A day without a measured percentile is unavailable (hatched), never a zero bar; a measured 0 keeps its baseline mark.
  const trendSeries:ChartSeries[]=[{id:metric,label:`${metric.toUpperCase()} p${percentile}`,points:(report?.daily??[]).map((row,index)=>{const value=row.stats[pKey];return {x:index,xLabel:row.day,y:value,state:value===null?'unavailable':'observed',note:value===null?'No measured value.':undefined,title:value===null?undefined:`${row.day}: ${performanceValue(metric,value)} · ${row.stats.count} samples`};})}];
  const gapNote=report?`One bar is the selected daily percentile, not a sum or an average of daily values. ${report.daily.filter(row=>row.stats.count===0).length} days have no measured value; gaps are not zero.`:'';
  const settingsAction=report&&onSettings&&['owner','admin'].includes(report.role)?<button className="btn" type="button" style={{minHeight:44}} onClick={onSettings}>Performance collection settings</button>:null;
  return <Stack as="section" gap={4} className="research-panel" aria-label="Web performance" aria-busy={busy}>
    <header><h2>Web performance</h2><p className="hint">Real page-load measurements from this project. Choose a metric to inspect its daily trend and recorded environment.</p></header>
    {parsed.error?<div className="card stack"><p role="alert" className="alert">{parsed.error}</p><button type="button" className="btn" style={{minHeight:44}} onClick={()=>onNavigate(performanceQuery(initial()))}>Reset performance view</button></div>:<form className="card stack" style={{gridTemplateColumns:'minmax(0,1fr)'}} aria-label="Performance date and filters" onSubmit={apply}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,180px),1fr))',gap:12}}>
        <label htmlFor={`${uid}-from`}>From (UTC)<input id={`${uid}-from`} type="date" required value={draft.from} max={draft.to} onChange={event=>setDraft(old=>({...old,from:event.target.value}))} style={{minHeight:44,width:'100%',minWidth:0}}/></label>
        <label htmlFor={`${uid}-to`}>To (UTC)<input id={`${uid}-to`} type="date" required value={draft.to} min={draft.from} onChange={event=>setDraft(old=>({...old,to:event.target.value}))} style={{minHeight:44,width:'100%',minWidth:0}}/></label>
      </div>
      <details><summary style={{minHeight:44,paddingBlock:10}}>Exact performance filters</summary><div className="stack" style={{gridTemplateColumns:'minmax(0,1fr)'}}><label htmlFor={`${uid}-path`}>Page path<input id={`${uid}-path`} value={draft.path??''} maxLength={2048} placeholder="All page paths" onChange={event=>setDraft(old=>({...old,path:event.target.value||undefined}))} style={{minHeight:44,width:'100%',minWidth:0}}/></label>{(['browser','os','device'] as const).map(field=><label key={field} htmlFor={`${uid}-${field}`}>{labels[field]}<select id={`${uid}-${field}`} aria-label={labels[field]} value={draft.filters[field]??''} onChange={event=>setDraft(old=>{const filters={...old.filters};if(event.target.value)filters[field]=event.target.value;else delete filters[field];return{...old,filters};})} style={{minHeight:44,width:'100%',minWidth:0}}><option value="">All {field==='os'?'operating systems':field+'s'}</option><option value="not-recorded">Not recorded</option>{environmentCatalog[field].map(value=><option key={value} value={value}>{value}</option>)}</select></label>)}</div></details>
      <div className="row"><button type="submit" className="btn primary" style={{minHeight:44}} disabled={disabled}>Apply performance filters</button><button type="button" className="btn" style={{minHeight:44}} disabled={disabled} onClick={()=>change({filters:{},path:undefined})}>Clear exact filters</button></div>
      {changed&&<p role="status" className="hint">Unapplied changes. Metric, percentile and breakdown controls use the applied scope until you choose Apply.</p>}{draftError&&<p role="alert" className="alert">{draftError}</p>}
    </form>}
    {!readEnabled&&<p role="status" className="hint">Waiting for the current performance route. No report is being read.</p>}
    {intent&&readEnabled&&<>
      <Inline gap={3}><label htmlFor={`${uid}-percentile`}>Percentile<select id={`${uid}-percentile`} aria-label="Percentile" value={percentile} disabled={denied} style={{minHeight:44,maxWidth:'100%'}} onChange={event=>{const value=event.target.value;if(value==='50'||value==='75'||value==='95')change({percentile:value==='50'?50:value==='95'?95:75});}}><option value="50">p50 — Median</option><option value="75">p75 — 75th percentile</option><option value="95">p95 — 95th percentile</option></select></label><button className="btn" type="button" style={{minHeight:44}} disabled={busy} onClick={()=>void load(true)}>{denied?'Reload performance access':'Reload report'}</button></Inline>
      {busy&&<p role="status">Loading performance report…</p>}{view.owner===owner&&view.error&&<p role="alert" className="alert">{view.error}</p>}
      <p className="hint" aria-label="Applied performance scope">{intent.from} to {intent.to} · UTC{intent.path!==undefined?` · Page path equals ${JSON.stringify(intent.path)}`:''}{Object.entries(intent.filters).map(([field,value])=>` · ${labels[field as keyof typeof labels]} equals ${JSON.stringify(value)}`).join('')}</p>
    </>}
    {report&&<>
      {!report.enabled?<div className="banner stack" role="status"><p>Performance collection is disabled. Any measurements below are retained history; enabling collection does not recreate missing samples.</p>{settingsAction}</div>:settingsAction}
      {report.retainedFrom&&<p className="banner" role="status">Only raw measurements retained from <time>{report.retainedFrom}</time> are available. Earlier or unobserved measurements are unavailable, not zero.</p>}
      <div className="metric-grid" role="group" aria-label="Performance metrics">{performanceMetrics.map(name=>{const stats=report.summary[name],value=stats[pKey],rating=performanceRating(name,value);return <button type="button" key={name} className="card stack" aria-label={`${performanceLabels[name]} (${name.toUpperCase()})`} aria-pressed={metric===name} aria-describedby={`${uid}-${name}-value ${uid}-${name}-rating ${uid}-${name}-samples`} onClick={()=>change({metric:name})} style={{textAlign:'start',marginBottom:0,minHeight:148,minWidth:0,whiteSpace:'normal',borderColor:metric===name?'var(--color-accent)':'var(--line)',color:'var(--ink)',cursor:'pointer'}}><strong>{name.toUpperCase()}</strong><span className="hint">{performanceLabels[name]}</span><span id={`${uid}-${name}-value`} className="metric-value">{performanceValue(name,value)}</span><span id={`${uid}-${name}-rating`} style={{color:rating==='poor'?'var(--danger)':rating==='needs-improvement'?'var(--caution)':rating==='good'?'var(--green)':'var(--muted)'}}>{ratings[rating]}</span><span id={`${uid}-${name}-samples`} className="hint">{stats.count} measured samples · p{percentile}</span></button>;})}</div>
      <Stack as="section" gap={4} className="card" aria-label="Selected metric trend"><div><h3>{performanceLabels[metric]} · p{percentile}</h3><p>{selected?.count} measured samples in the applied range</p></div>
        {selected?.count===0?<><p className="hint">No retained measurements match this metric and scope. Unavailable does not mean good performance.</p><p className="hint">{gapNote}</p></>:<TimeSeriesChart label={`${metric.toUpperCase()} p${percentile} daily trend`} context={`${report.query.from} to ${report.query.to} · UTC · ${metric==='cls'?'unitless':'milliseconds'}`} kind="bars" fit={report.daily.length>=30&&report.daily.length<=90?'compress':undefined} series={trendSeries} yDomain={[0,chartTop]} formatY={value=>performanceValue(metric,value)} xHeader="UTC day" formatXTick={point=>point.xLabel.slice(5)} tableColumns={[{header:'Measured samples',values:report.daily.map(row=>row.stats.count)}]} summary={gapNote}/>}
      </Stack>
      <Stack as="section" gap={4} className="card" aria-label="Performance breakdown"><label htmlFor={`${uid}-breakdown`}>Break down by<select id={`${uid}-breakdown`} aria-label="Break down by" value={intent?.breakdown} style={{minHeight:44,maxWidth:'100%'}} onChange={event=>{const value=performanceBreakdowns.find(field=>field===event.target.value);if(value)change({breakdown:value});}}>{performanceBreakdowns.map(field=><option key={field} value={field}>{labels[field]}</option>)}</select></label>
        {report.breakdown.items.length===0?<p className="hint">No retained measurements to break down for this metric.</p>:<div className="table-wrap" tabIndex={0} role="region" aria-label={`${labels[report.query.breakdown]} performance values`}><table style={{minWidth:600}}><thead><tr><th scope="col">{labels[report.query.breakdown]}</th><th scope="col">{metric.toUpperCase()} p{percentile}</th><th scope="col">Measured samples</th><th scope="col">Rating</th></tr></thead><tbody>{report.breakdown.items.map(row=><tr key={JSON.stringify(row.value)}><th scope="row"><bdi>{row.value===null?'Not recorded':row.value}</bdi></th><td>{performanceValue(metric,row.stats[pKey])}</td><td>{row.stats.count}</td><td>{ratings[performanceRating(metric,row.stats[pKey])]}</td></tr>)}</tbody></table></div>}
        <p className="hint">{report.breakdown.limited?'Up to 50 recorded values are shown. Other matching measurements are omitted from this breakdown.':'All recorded breakdown values for this metric are shown.'} Each row’s percentile describes its own measured samples.</p>
      </Stack>
      <details className="card"><summary style={{minHeight:44,paddingBlock:10}}>How to read these measurements</summary><div className="stack"><p>Samples describe the initial document page URL. Changing an SPA route does not start a new page-load measurement. Browser support, consent or privacy settings, and whether a user interacts with the page affect which metrics can be observed. Sample counts can differ between metrics.</p><p>Standard web-vitals may read buffered initial-document timings for page-load work that happened before the current analytics grant. Measurements are sent only while collection is allowed. This does not replay earlier pageviews or custom events.</p><p>CLS is unitless; LCP, INP, FCP and TTFB use milliseconds. Good / Needs improvement / Poor use the metric’s standard thresholds for the selected percentile; they do not rate missing measurements.</p><p className="hint">Snapshot as of <time>{report.asOf}</time>. Percentiles describe observed samples, not every visit or visitor.</p></div></details>
    </>}
  </Stack>;
}
