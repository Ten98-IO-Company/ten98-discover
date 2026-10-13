import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {Link} from '@tanstack/react-router';
import {api,ApiError,errMsg} from '../lib/api';

type Role='owner'|'admin'|'editor'|'viewer';
type Model='openai/gpt-4o-mini'|'openai/gpt-4o';
type Status='queued'|'running'|'completed'|'failed'|'uncertain'|'cancelled'|'reconciled';
type Charge='reserved'|'dispatched'|'uncertain'|'settled'|'cancelled';
type Input={connectionId:string;promptId:string;versionId:string;systemText:string;models:Model[];maxCompletionTokens:number;fundedCredits:true};
type Message={role:'system'|'user';content:string};
type RouteQuote={model:Model;tag:'openai';providerName:'OpenAI';promptCapacity:number;completionCapacity:number;promptPrice:string;completionPrice:string;requestPrice:string;estimateUsd:string};
type Quote={id:string;createdAt:string;expiresAt:string;input:Input;messages:Message[];connectionName:string;routes:RouteQuote[];estimateUsd:string;explanation:string;cacheReused:false};
type Answer={text:string;resolvedModel:string;provider:string;finishReason:string;citations:{url:string;title:string|null}[];promptTokens:number|null;completionTokens:number|null;receivedAt:string};
type RunSummary={id:string;model:Model;provider:string;status:Status;chargeStatus:Charge;estimateUsd:string;actualUsd:string|null;dispatchedAt:string|null;completedAt:string|null;diagnostic:string|null;resultExpired:boolean};
type Run=RunSummary&{result:Answer|null;reportedCost:string|null;isByok:boolean|null;upstreamReportedCost:string|null;generationId:string|null};
type Summary={id:string;quoteId:string;createdAt:string;cancelRequested:boolean;prompt:{id:string;versionId:string;textPreview:string};canCancel:boolean;runs:RunSummary[]};
type Comparison=Omit<Summary,'runs'>&{runs:Run[];input:Input|null;messages:Message[]|null;inputExpired:boolean;cache:{reused:false;available:false}};
type Metadata={role:Role;models:Model[];vaultConfigured:boolean;spendingPaused:boolean;connections:{id:string;name:string;checkStatus:'untested'|'ok'|'error'}[];comparisons:Summary[];cache:{available:false};scheduling:{available:false}};
type DetailResponse={role:Role;comparison:Comparison};
type ReconcileResponse=DetailResponse&{reconciliation:{status:'matched'|'inconclusive';message:string}};
export type ExecutionEntry={kind:'configure';promptId:string;versionId:string;authoredText:string}|{kind:'history'};
type Props={workspaceId:string;projectId:string;userId:string;entry:ExecutionEntry;onBack:()=>void;onUnauthorized:()=>void};
type Screen='setup'|'quote'|'unknown'|'history'|'detail';
type Attempt=Readonly<{quoteId:string;requestKey:string}>;
type Operation={generation:number;controller:AbortController;write:boolean};
const roles:Role[]=['owner','admin','editor','viewer'];
const statuses:Status[]=['queued','running','completed','failed','uncertain','cancelled','reconciled'];
const charges:Charge[]=['reserved','dispatched','uncertain','settled','cancelled'];
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const when=(v:string|null)=>v?new Date(v).toLocaleString():'Unavailable';
const money=(v:string|null)=>v===null?'Unknown':`USD ${v}`;
const active=(c:Summary)=>c.runs.some(r=>r.status==='queued'||r.status==='running');
const modelName=(m:string)=>m==='openai/gpt-4o-mini'?'GPT-4o-mini':m==='openai/gpt-4o'?'GPT-4o':m;
const outcome=(r:RunSummary)=>({queued:'Waiting for worker',running:'Request sent',completed:'Answer received',failed:'No supported answer',uncertain:'Charge unconfirmed',cancelled:'Not dispatched',reconciled:'Charge confirmed'}[r.status]);
const textStyle={whiteSpace:'pre-wrap' as const,overflowWrap:'anywhere' as const};
function citationUrl(raw:string){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function checkedRole(value:unknown):Role{if(!roles.includes(value as Role))throw new Error('The response could not be read. Reload access.');return value as Role;}
const nullableString=(value:unknown)=>value===null||typeof value==='string';
const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const optionalDate=(value:unknown)=>value===null||date(value);
const model=(value:unknown)=>value==='openai/gpt-4o-mini'||value==='openai/gpt-4o';
const tokens=(value:unknown)=>value===null||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function validMessages(value:unknown):value is Message[]{return Array.isArray(value)&&value.every(m=>m&&['system','user'].includes(m.role)&&typeof m.content==='string');}
function validInput(value:unknown):value is Input{
  const i=value as Input|null;
  return !!i&&uuid(i.connectionId)&&uuid(i.promptId)&&uuid(i.versionId)&&typeof i.systemText==='string'&&Array.isArray(i.models)&&i.models.length>=1&&i.models.length<=2&&i.models.every(model)&&new Set(i.models).size===i.models.length&&Number.isInteger(i.maxCompletionTokens)&&i.maxCompletionTokens>=16&&i.maxCompletionTokens<=4096&&i.fundedCredits===true;
}
function validAnswer(value:unknown):value is Answer{
  const a=value as Answer|null;
  return !!a&&typeof a.text==='string'&&typeof a.resolvedModel==='string'&&typeof a.provider==='string'&&typeof a.finishReason==='string'&&tokens(a.promptTokens)&&tokens(a.completionTokens)&&date(a.receivedAt)&&Array.isArray(a.citations)&&a.citations.every(c=>c&&typeof c.url==='string'&&nullableString(c.title));
}
function validRunSummary(value:unknown):value is RunSummary{
  const r=value as RunSummary|null;
  return !!r&&uuid(r.id)&&model(r.model)&&typeof r.provider==='string'&&statuses.includes(r.status)&&charges.includes(r.chargeStatus)&&typeof r.estimateUsd==='string'&&nullableString(r.actualUsd)&&optionalDate(r.dispatchedAt)&&optionalDate(r.completedAt)&&nullableString(r.diagnostic)&&typeof r.resultExpired==='boolean';
}
function validSummary(value:unknown):value is Summary{
  const c=value as Summary|null;
  return !!c&&uuid(c.id)&&uuid(c.quoteId)&&date(c.createdAt)&&typeof c.cancelRequested==='boolean'&&typeof c.canCancel==='boolean'&&!!c.prompt&&uuid(c.prompt.id)&&uuid(c.prompt.versionId)&&typeof c.prompt.textPreview==='string'&&Array.isArray(c.runs)&&c.runs.length>=1&&c.runs.length<=2&&c.runs.every(validRunSummary);
}
function checkedComparison(value:unknown):DetailResponse{
  const data=value as DetailResponse;checkedRole(data?.role);const c=data?.comparison;
  if(!validSummary(c)||typeof c.inputExpired!=='boolean'||!(c.input===null||validInput(c.input))||!(c.messages===null||validMessages(c.messages))||c.cache?.reused!==false||c.cache?.available!==false||c.runs.some(r=>!(r.result===null||validAnswer(r.result))||!nullableString(r.reportedCost)||!nullableString(r.upstreamReportedCost)||!nullableString(r.generationId)||!(r.isByok===null||typeof r.isByok==='boolean')))throw new Error('The response was incomplete. Reload the saved run.');
  return data;
}
function Messages({messages}:{messages:Message[]}){return <>{!messages.some(m=>m.role==='system')&&<p>No system message</p>}{messages.map((m,i)=><div key={i}><strong>{m.role==='system'?'System':'User'}</strong><p style={textStyle}>{m.content}</p></div>)}</>;}

export function PromptExecutionsPanel(props:Props){
  const key=props.entry.kind==='configure'?`${props.entry.promptId}:${props.entry.versionId}`:'history';
  return <Panel key={`${props.userId}:${props.projectId}:${key}`} {...props}/>;
}
function Panel({workspaceId,projectId,entry,onBack,onUnauthorized}:Props){
  const B='/api/projects/'+encodeURIComponent(projectId)+'/prompt-executions',uid=useId();
  const [screen,setScreen]=useState<Screen>(entry.kind==='configure'?'setup':'history');
  const [metadata,setMetadata]=useState<Metadata|null>(null),[role,setRole]=useState<Role|null>(null);
  const [comparison,setComparison]=useState<Comparison|null>(null),[quote,setQuote]=useState<Quote|null>(null);
  const [attempt,setAttempt]=useState<Attempt|null>(null),[connectionId,setConnectionId]=useState('');
  const [models,setModels]=useState<Model[]>([]),[systemText,setSystemText]=useState(''),[maxTokens,setMaxTokens]=useState('1024');
  const [funded,setFunded]=useState(false),[busy,setBusy]=useState(false),[writing,setWriting]=useState(false),[accessLost,setAccessLost]=useState(false);
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [polling,setPolling]=useState(false),[clock,setClock]=useState(Date.now());
  const mounted=useRef(false),generation=useRef(0),operation=useRef<Operation|null>(null);
  const selection=useRef<string|null>(null),attemptRef=useRef<Attempt|null>(null),pollingUntil=useRef(0);
  const initialized=useRef(false),notified=useRef(false),unauthorizedRef=useRef(onUnauthorized),backRef=useRef(onBack);
  unauthorizedRef.current=onUnauthorized;backRef.current=onBack;
  const heading=useRef<HTMLHeadingElement|null>(null),focusNext=useRef(true);
  const connectionControl=useRef<HTMLSelectElement|null>(null),modelControl=useRef<HTMLInputElement|null>(null);
  const systemControl=useRef<HTMLTextAreaElement|null>(null),tokensControl=useRef<HTMLInputElement|null>(null),fundedControl=useRef<HTMLInputElement|null>(null);
  const current=(op:Operation)=>mounted.current&&operation.current===op&&generation.current===op.generation;
  function invalidate(){generation.current++;operation.current?.controller.abort();operation.current=null;setBusy(false);setWriting(false);setPolling(false);}
  function begin(write=false,replaceRead=true):Operation|null{
    if(!mounted.current||operation.current&&(operation.current.write||!replaceRead))return null;
    operation.current?.controller.abort();const op={generation:++generation.current,controller:new AbortController(),write};
    operation.current=op;setBusy(true);setWriting(write);return op;
  }
  function finish(op:Operation){if(current(op)){operation.current=null;setBusy(false);setWriting(false);}}
  function setPending(value:Attempt|null){attemptRef.current=value;setAttempt(value);}
  function move(view:Screen){focusNext.current=true;setScreen(view);}
  function clearDraft(){setQuote(null);setPending(null);setConnectionId('');setModels([]);setSystemText('');setMaxTokens('1024');setFunded(false);}
  function applyRole(value:Role){setRole(value);setAccessLost(false);if(value==='viewer'){clearDraft();if(['setup','quote','unknown'].includes(screen))move('history');}}
  function purge(message:string){
    clearDraft();setMetadata(null);setComparison(null);setRole(null);selection.current=null;setPolling(false);
    setNotice(null);setError(message);setAccessLost(true);initialized.current=false;move(entry.kind==='configure'?'setup':'history');
  }
  function failure(e:unknown,op:Operation):boolean{
    if(!current(op)||(e instanceof Error&&e.name==='AbortError'))return true;
    if(e instanceof ApiError&&[401,403,404].includes(e.status)){
      purge(e.status===401?'Your session expired. Sign in again.':'Access unavailable. Reload access to continue.');
      if(e.status===401&&!notified.current){notified.current=true;unauthorizedRef.current();}return true;
    }return false;
  }
  async function readMetadata(op:Operation){
    const data=await api<Metadata>(B,{signal:op.controller.signal});if(!current(op))return null;
    checkedRole(data?.role);if(!Array.isArray(data.models)||!data.models.every(model)||!Array.isArray(data.connections)||data.connections.some(c=>!c||!uuid(c.id)||typeof c.name!=='string'||!['untested','ok','error'].includes(c.checkStatus))||!Array.isArray(data.comparisons)||!data.comparisons.every(validSummary)||typeof data.vaultConfigured!=='boolean'||typeof data.spendingPaused!=='boolean')throw new Error('Readiness could not be read. Reload access.');
    setMetadata(data);applyRole(data.role);
    if(!initialized.current&&data.role!=='viewer'){
      initialized.current=true;setConnectionId(data.connections.length===1&&data.connections[0].checkStatus==='ok'?data.connections[0].id:'');
      setModels(data.models.includes('openai/gpt-4o-mini')?['openai/gpt-4o-mini']:data.models.slice(0,1));
    }return data;
  }
  async function refreshMetadata(){
    const op=begin();if(!op)return;setError(null);
    try{await readMetadata(op);}catch(e){if(current(op)&&!failure(e,op))setError(errMsg(e));}finally{finish(op);}
  }
  useEffect(()=>{mounted.current=true;void refreshMetadata();return ()=>{mounted.current=false;generation.current++;operation.current?.controller.abort();operation.current=null;};},[B]);
  useEffect(()=>{if(focusNext.current){heading.current?.focus();focusNext.current=false;}},[screen,quote?.id,comparison?.id,accessLost]);
  useEffect(()=>{if(!quote)return;const timer=setInterval(()=>setClock(Date.now()),1000);return ()=>clearInterval(timer);},[quote?.id]);
  function mayLeave(){return !attemptRef.current||window.confirm('This start may already have been accepted. Leaving discards local retry controls and does not stop server work. Leave this run?');}
  function back(){if(operation.current?.write||!mayLeave())return;invalidate();setPending(null);backRef.current();}
  function history(){if(operation.current?.write||!mayLeave())return;invalidate();setPending(null);setQuote(null);setComparison(null);selection.current=null;setError(null);setNotice(null);move('history');void refreshMetadata();}
  function setup(){if(operation.current?.write||entry.kind!=='configure'||!mayLeave())return;invalidate();setPending(null);setQuote(null);setError(null);setNotice(null);move('setup');}
  function edit(change:()=>void){if(operation.current?.write||attemptRef.current)return;if(operation.current)invalidate();setQuote(null);setError(null);setNotice(null);change();}
  function showComparison(data:DetailResponse,explicit=true){
    applyRole(data.role);setComparison(data.comparison);selection.current=data.comparison.id;
    setMetadata(old=>old?{...old,comparisons:[data.comparison,...old.comparisons.filter(c=>c.id!==data.comparison.id)].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.id.localeCompare(a.id)).slice(0,20)}:old);
    if(explicit){pollingUntil.current=Date.now()+300_000;setPolling(active(data.comparison)&&!document.hidden);move('detail');}else if(!active(data.comparison))setPolling(false);
  }
  async function openComparison(id:string,automatic=false){
    if(automatic&&operation.current)return;const op=begin(false,!automatic);if(!op)return;
    if(!automatic){selection.current=id;setError(null);setNotice(null);if(comparison?.id!==id)setComparison(null);move('detail');}
    try{
      const raw=await api<unknown>(B+'/comparisons/'+encodeURIComponent(id),{signal:op.controller.signal});if(!current(op)||selection.current!==id)return;
      const data=checkedComparison(raw);if(data.comparison.id!==id)throw new Error('The requested run could not be read.');showComparison(data,!automatic);
    }catch(e){if(!current(op)||failure(e,op))return;setError(automatic?'Status could not be refreshed. Refresh status to try again.':errMsg(e));setPolling(false);}finally{finish(op);}
  }
  const activeStatuses=comparison?.runs.map(r=>r.status).join('|');
  useEffect(()=>{
    if(!polling||screen!=='detail'||!comparison||!active(comparison))return;
    const id=comparison.id;let stopped=false;let timer:ReturnType<typeof setTimeout>;
    function stop(){stopped=true;clearTimeout(timer);setPolling(false);}
    const tick=async()=>{
      if(stopped||!mounted.current||selection.current!==id)return;
      if(document.hidden||Date.now()>=pollingUntil.current){stop();return;}
      if(!operation.current)await openComparison(id,true);
      if(!stopped&&selection.current===id)timer=setTimeout(tick,5000);
    };
    const visibility=()=>{if(document.hidden)stop();};document.addEventListener('visibilitychange',visibility);timer=setTimeout(tick,5000);
    return ()=>{stopped=true;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
  },[polling,screen,comparison?.id,activeStatuses]);
  async function getQuote(event:FormEvent){
    event.preventDefault();if(operation.current?.write||entry.kind!=='configure'||attemptRef.current)return;
    const checks:[boolean,string,HTMLElement|null][]=[
      [!metadata?.connections.some(c=>c.id===connectionId&&c.checkStatus==='ok'),'Choose a connection whose account check passed.',connectionControl.current],
      [models.length<1||models.length>2||new Set(models).size!==models.length||models.some(m=>!metadata?.models.includes(m)),'Choose one or two supported models.',modelControl.current],
      [!/^\d+$/.test(maxTokens)||!Number.isInteger(Number(maxTokens))||Number(maxTokens)<16||Number(maxTokens)>4096,'Choose an integer output allowance from 16 to 4096.',tokensControl.current],
      [systemText.length>4000||/[\u0000\u000b\u000c\uD800-\uDFFF]/u.test(systemText),'Use a valid system message of at most 4000 characters without unsupported control characters.',systemControl.current],
      [!funded,'Confirm that this connection uses OpenRouter funded credits.',fundedControl.current],
    ];
    const problem=checks.find(c=>c[0]);if(problem){setError(problem[1]);const details=problem[2]?.closest('details');if(details)details.open=true;problem[2]?.focus();return;}
    const op=begin(true);if(!op)return;setError(null);setNotice(null);setQuote(null);setPolling(false);
    const body:Input={connectionId,promptId:entry.promptId,versionId:entry.versionId,systemText,models:[...models],maxCompletionTokens:Number(maxTokens),fundedCredits:true};
    try{
      const data=await api<{role:Role;quote:Quote}>(B+'/quote',{method:'POST',body,signal:op.controller.signal});if(!current(op))return;
      checkedRole(data?.role);
      const q=data.quote;
      if(!uuid(q?.id)||!date(q.expiresAt)||!date(q.createdAt)||!validMessages(q.messages)||!validInput(q.input)||q.input.promptId!==body.promptId||q.input.versionId!==body.versionId||typeof q.connectionName!=='string'||typeof q.explanation!=='string'||!Array.isArray(q.routes)||q.routes.length<1||q.routes.length>2||q.routes.some(r=>!r||!model(r.model)||typeof r.providerName!=='string'||typeof r.estimateUsd!=='string'||typeof r.promptPrice!=='string'||typeof r.completionPrice!=='string'||typeof r.requestPrice!=='string'||!Number.isSafeInteger(r.promptCapacity)||!Number.isSafeInteger(r.completionCapacity))||typeof q.estimateUsd!=='string')throw new Error('The quote could not be read. Get a new quote.');
      applyRole(data.role);if(data.role==='viewer')return;setClock(Date.now());setQuote(data.quote);move('quote');
    }catch(e){if(current(op)&&!failure(e,op))setError(errMsg(e));}finally{finish(op);}
  }
  async function start(){
    if(!quote||role==='viewer')return;const recovering=attemptRef.current!==null;
    if(!recovering&&(Date.parse(quote.expiresAt)<=Date.now()||!metadata?.vaultConfigured||metadata.spendingPaused)){setError('This quote cannot start now. Review readiness or get a new quote.');return;}
    const op=begin(true);if(!op)return;setError(null);setNotice(null);setPolling(false);let posted=false;
    try{
      // Refresh local authority before acting; final server gates remain authoritative.
      const latest=await readMetadata(op);if(!latest||!current(op)||latest.role==='viewer')return;
      if(!recovering&&(!latest.vaultConfigured||latest.spendingPaused||Date.parse(quote.expiresAt)<=Date.now()))throw new Error('Spending settings or quote validity changed. Review readiness before starting.');
      const body=attemptRef.current??Object.freeze({quoteId:quote.id,requestKey:crypto.randomUUID()});setPending(body);posted=true;
      const raw=await api<unknown>(B+'/comparisons',{method:'POST',body,signal:op.controller.signal});if(!current(op))return;
      const data=checkedComparison(raw);if(data.comparison.quoteId!==body.quoteId||data.comparison.prompt.id!==quote.input.promptId||data.comparison.prompt.versionId!==quote.input.versionId)throw new Error('The start response did not match this quote.');
      setPending(null);setQuote(null);showComparison(data);setNotice('The saved prompt run is shown below.');
    }catch(e){
      if(!current(op)||failure(e,op))return;const uncertain=!(e instanceof ApiError)||e.status===0||e.status>=500;
      if((posted||recovering)&&uncertain){move('unknown');setError('This start may already have been accepted. Retry the same request, or inspect Recent runs before starting anything new.');}
      else{if(posted){setPending(null);setQuote(null);move(entry.kind==='configure'?'setup':'history');}setError(errMsg(e));}
    }finally{finish(op);}
  }
  async function cancel(){
    if(!comparison||!comparison.canCancel||role==='viewer')return;const id=comparison.id,op=begin(true);if(!op)return;setError(null);setNotice(null);setPolling(false);
    try{
      const raw=await api<unknown>(B+'/comparisons/'+encodeURIComponent(id)+'/cancel',{method:'POST',body:{},signal:op.controller.signal});if(!current(op)||selection.current!==id)return;
      const data=checkedComparison(raw);if(data.comparison.id!==id)throw new Error('Reload this run to check its state.');showComparison(data);setNotice('Remaining requests updated. Requests already sent may still be charged.');
    }catch(e){if(current(op)&&!failure(e,op))setError(errMsg(e));}finally{finish(op);}
  }
  async function reconcile(run:Run){
    if(!comparison||role!=='owner'||run.status!=='uncertain'||!run.generationId)return;const id=comparison.id,op=begin(true);if(!op)return;setError(null);setNotice(null);setPolling(false);
    try{
      const raw=await api<ReconcileResponse>(B+'/runs/'+encodeURIComponent(run.id)+'/reconcile',{method:'POST',body:{},signal:op.controller.signal});if(!current(op)||selection.current!==id)return;
      const data=checkedComparison(raw);if(data.comparison.id!==id||!raw.reconciliation||!['matched','inconclusive'].includes(raw.reconciliation.status)||typeof raw.reconciliation.message!=='string')throw new Error('Reload this run to check its state.');showComparison(data);setNotice(raw.reconciliation.message);setMetadata(old=>old?{...old,spendingPaused:true}:old);
    }catch(e){if(current(op)&&!failure(e,op))setError(errMsg(e));}finally{finish(op);}
  }
  const writer=role==='owner'||role==='admin'||role==='editor';
  const blocked=!metadata?.vaultConfigured||metadata.spendingPaused,expired=quote?Date.parse(quote.expiresAt)<=clock:false;
  const providerHelp=role==='owner'?<Link to='/' search={{workspace:workspaceId,project:projectId,view:'providers'}} className='btn ghost' aria-disabled={writing||undefined} onClick={event=>{if(operation.current?.write)event.preventDefault();}}>Providers and spending</Link>:<p className="hint">Ask a workspace owner to configure this connection or spending limits.</p>;
  const title=accessLost?'Access unavailable':screen==='history'?'Recent runs':screen==='detail'?'Prompt run':screen==='setup'?'Review a prompt run':screen==='unknown'?'Start acknowledgement unknown':'Review before spending';
  return <section className="research-panel stack" aria-label="Prompt execution" style={{minWidth:0}}>
    <div className="row between"><button type="button" className="btn ghost" onClick={back} disabled={writing}>Back to library</button>{screen!=='history'&&!accessLost&&<button type="button" className="btn ghost" onClick={history} disabled={writing}>Recent runs</button>}</div>
    <h2 tabIndex={-1} ref={heading}>{title}</h2>
    {error&&<div className="alert" role="alert" id={uid+'-error'}>{error}</div>}{notice&&<p role="status">{notice}</p>}
    {busy&&<p role="status" className="hint">{operation.current?.write?'Waiting for the requested action…':'Loading saved state…'}</p>}
    {accessLost?<button type="button" className="btn" onClick={()=>void refreshMetadata()} disabled={writing}>Reload access</button>:!metadata?<div><p>Loading readiness and recent runs.</p>{error&&<button type="button" className="btn" onClick={()=>void refreshMetadata()} disabled={writing}>Retry loading</button>}</div>:<>
      {['setup','quote','unknown'].includes(screen)&&<>
        {(!metadata.vaultConfigured||metadata.connections.length===0||!metadata.connections.some(c=>c.checkStatus==='ok'))&&<div className="banner"><p>{!metadata.vaultConfigured?'The credential encryption keyring is unavailable.':metadata.connections.length===0?'No OpenRouter connection is configured.':'No OpenRouter connection has a successful account check.'}</p>{providerHelp}</div>}
        {metadata.spendingPaused&&<div className="banner"><p>Spending is paused. You can inspect a quote, but an owner must enable spending before a new run can start. Saved results remain available.</p>{providerHelp}</div>}
      </>}
      {screen==='setup'&&entry.kind==='configure'&&writer&&<form className="card stack" onSubmit={getQuote} noValidate>
        <h3>Authored prompt version</h3><p style={textStyle}>{entry.authoredText}</p>
        <fieldset disabled={writing||attempt!==null} style={{border:0,padding:0,minWidth:0}}><legend>Run setup</legend>
          <div className="field"><label htmlFor={uid+'-connection'}>OpenRouter connection</label><select ref={connectionControl} id={uid+'-connection'} aria-describedby={error?uid+'-error':undefined} value={connectionId} onChange={e=>edit(()=>setConnectionId(e.target.value))} style={{width:'100%'}}><option value="">Choose a connection</option>{metadata.connections.map(c=><option key={c.id} value={c.id} disabled={c.checkStatus!=='ok'}>{c.name} — {c.checkStatus==='ok'?'Check passed':c.checkStatus==='error'?'Check failed':'Not checked'}</option>)}</select><p className="hint">A successful account check does not guarantee funding, route availability or execution permission.</p></div>
          <fieldset className="field"><legend>Models</legend>{metadata.models.map((model,index)=><label className="row" key={model} style={{minHeight:44}}><input ref={index===0?modelControl:undefined} type="checkbox" checked={models.includes(model)} onChange={e=>edit(()=>setModels(e.target.checked?[...models,model]:models.filter(m=>m!==model)))} aria-describedby={error?uid+'-error':undefined}/>{modelName(model)}</label>)}<p className="hint">Choose one or two models. Each selected model is a separate paid request.</p></fieldset>
          <div className="field"><label htmlFor={uid+'-tokens'}>Maximum output tokens</label><input ref={tokensControl} id={uid+'-tokens'} type="number" min={16} max={4096} step={1} value={maxTokens} onChange={e=>edit(()=>setMaxTokens(e.target.value))} aria-describedby={error?uid+'-error':undefined}/><p className="hint">Allowed: 16–4096.</p></div>
          <details className="field"><summary>Optional system message</summary><label htmlFor={uid+'-system'}>System message</label><textarea ref={systemControl} id={uid+'-system'} maxLength={4000} value={systemText} onChange={e=>edit(()=>setSystemText(e.target.value))} style={{width:'100%',minHeight:96}} aria-describedby={error?uid+'-error':undefined}/><p className="hint">Up to 4000 characters. Project context is not added automatically.</p></details>
          <label className="row" style={{minHeight:44}}><input ref={fundedControl} type="checkbox" checked={funded} onChange={e=>edit(()=>setFunded(e.target.checked))} aria-describedby={error?uid+'-error':undefined}/>This connection uses OpenRouter funded credits.</label><p className="hint">Upstream BYOK invoices are outside this app’s supported billing route.</p>
          <button type="submit" className="btn primary" disabled={!metadata.vaultConfigured}>Get quote</button><p className="hint">Read-only provider lookup. This does not request an answer or authorize a charge.</p>
        </fieldset>
      </form>}
      {(screen==='quote'||screen==='unknown')&&quote&&writer&&<div className="card stack">
        <div><p className="hint">Total reservation</p><strong style={{fontSize:26,overflowWrap:'anywhere'}}>{money(quote.estimateUsd)}</strong><p>Connection: {quote.connectionName} · Valid until {when(quote.expiresAt)}</p><p className="hint">Prices observed {when(quote.createdAt)}. OpenRouter funded credits · No fallback · No cache reuse.</p></div>
        <div className="stack">{quote.routes.map(route=><div key={route.model}><strong>{modelName(route.model)} · {route.providerName}</strong><p>{money(route.estimateUsd)} reservation</p><details><summary>Price and capacity details</summary><p>Prompt capacity {route.promptCapacity}; output capacity {route.completionCapacity}. Prompt-token price USD {route.promptPrice}; completion-token price USD {route.completionPrice}; request price USD {route.requestPrice}.</p></details></div>)}</div>
        <h3>Exact request</h3><Messages messages={quote.messages}/><p>Maximum output tokens: {quote.input.maxCompletionTokens}</p>
        <p className="hint">{quote.explanation}</p><p className="hint">This conservative reservation uses full prompt-capacity pricing. Actual credit charges may be lower; it is not an invoice guarantee. Taxes, credit-purchase fees and upstream BYOK invoices are excluded.</p>
        {screen==='unknown'?<div className="banner"><p>This start may already have been accepted. Retrying resends the identical quote and request key; it does not create a new paid attempt. This recovery remains available after quote expiry.</p><button type="button" className="btn primary" onClick={()=>void start()} disabled={writing||!attempt}>Retry same start request</button></div>:<div className="row"><button type="button" className="btn primary" onClick={()=>void start()} disabled={writing||blocked||expired}>Start {quote.routes.length} paid {quote.routes.length===1?'request':'requests'}</button><button type="button" className="btn ghost" onClick={setup} disabled={writing}>Back to setup</button>{expired&&<button type="button" className="btn" onClick={setup} disabled={writing}>Get new quote</button>}</div>}
        {expired&&screen!=='unknown'&&<p className="hint">This unused quote expired. Return to setup and explicitly get a new quote.</p>}
      </div>}
      {screen==='history'&&<div className="card stack"><div className="row between"><h3>Latest project comparisons</h3><button type="button" className="btn" onClick={()=>void refreshMetadata()} disabled={writing}>Refresh</button></div><p className="hint">Latest 20 project comparisons. Prompt-library filters do not filter this list.</p>
        {metadata.comparisons.length===0&&!error?<p>No prompt runs yet. Choose a saved prompt in the library to review your first run.</p>:metadata.comparisons.length>0&&<div className="table-wrap" role="region" aria-label="Recent prompt runs" tabIndex={0}><table style={{minWidth:680}}><thead><tr><th>Authored prompt version</th><th>Models</th><th>Started</th><th>Outcome</th><th>Action</th></tr></thead><tbody>{metadata.comparisons.map(c=><tr key={c.id}><td style={{minWidth:200,...textStyle}}>{c.prompt.textPreview}</td><td>{c.runs.map(r=>modelName(r.model)).join(' + ')}</td><td>{when(c.createdAt)}</td><td>{c.runs.filter(r=>r.chargeStatus==='uncertain').length>0?`${c.runs.filter(r=>r.chargeStatus==='uncertain').length} need charge review`:c.runs.map(outcome).join(' · ')}</td><td><button type="button" className="btn" onClick={()=>void openComparison(c.id)} disabled={writing}>Open run</button></td></tr>)}</tbody></table></div>}
      </div>}
      {screen==='detail'&&(comparison?<div className="stack">
        <div className="card"><div className="row between"><h3>Authored prompt version</h3><button type="button" className="btn" onClick={()=>void openComparison(comparison.id)} disabled={writing}>Refresh status</button></div><p style={textStyle}>{comparison.prompt.textPreview}</p><p>Started {when(comparison.createdAt)} · {comparison.runs.length} model {comparison.runs.length===1?'request':'requests'}</p>
          {active(comparison)&&<p className="hint">{polling?'Checking saved status every 5 seconds, for at most 5 minutes.':'Automatic status checks stopped. Refresh status to check again.'}</p>}
          {writer&&comparison.canCancel&&<div><button type="button" className="btn" onClick={()=>void cancel()} disabled={writing}>Stop remaining requests</button><p className="hint">Requests already sent may still be charged. Leaving this page does not cancel them.</p></div>}
          {comparison.inputExpired?<p>Copied execution input expired under workspace retention. The authored version preview above is preserved separately.</p>:<details><summary>Copied prompt and system input</summary>{comparison.messages?<Messages messages={comparison.messages}/>:<p>Copied input is unavailable.</p>}</details>}
          {(comparison.runs.some(r=>r.chargeStatus==='uncertain'||r.isByok)||metadata.spendingPaused)&&<div className="banner"><p>Spending is paused until an owner reviews the charge and spending settings.</p>{providerHelp}</div>}
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,320px),1fr))',gap:16,minWidth:0}}>{comparison.runs.map(run=><article className="card stack" key={run.id} style={{minWidth:0}}>
          <h3 style={{overflowWrap:'anywhere'}}>{modelName(run.model)} · {run.provider}</h3><strong>{outcome(run)}</strong><p>Reserved {money(run.estimateUsd)}</p><p>Credit charge: {run.chargeStatus==='cancelled'&&run.actualUsd===null?'Not dispatched':money(run.actualUsd)}</p><p className="hint">Charge state: {run.chargeStatus}</p>
          {run.diagnostic&&<p style={textStyle}>{run.diagnostic}</p>}{run.isByok&&<div className="alert"><strong>Unexpected upstream BYOK billing</strong><p>The recorded credit charge excludes external provider billing. An owner must review this separate invoice.</p></div>}
          {run.status==='uncertain'&&<div className="banner"><p>The charge is unconfirmed; unknown does not mean free.</p>{role==='owner'?(run.generationId?<><button type="button" className="btn" onClick={()=>void reconcile(run)} disabled={writing}>Check charge receipt</button><p className="hint">Read-only provider lookup; does not request another answer.</p></>:<p>No saved generation ID is available for automatic matching. This charge remains unresolved.</p>):<p>A workspace owner can review the charge.</p>}</div>}
          <AnswerView run={run}/>
          {(run.reportedCost!==null||run.upstreamReportedCost!==null)&&<details><summary>Original charge evidence</summary>{run.reportedCost!==null&&<p>Reported credit cost: USD {run.reportedCost}</p>}{run.upstreamReportedCost!==null&&<p>Reported upstream cost: USD {run.upstreamReportedCost}</p>}<p className="hint">Original reported evidence is separate from app-accounted credit charges.</p></details>}
        </article>)}</div><p className="hint">These direct API responses do not establish consumer ChatGPT behavior, live web search, ranking or brand visibility. Scheduling and result caching are not available.</p>
      </div>:<div><p>{error?'The selected run could not be read.':'Loading the selected run.'}</p>{error&&selection.current&&<button type="button" className="btn" onClick={()=>void openComparison(selection.current!)} disabled={writing}>Retry loading run</button>}</div>)}
    </>}
  </section>;
}
function AnswerView({run}:{run:Run}){
  if(run.resultExpired)return <p>Answer and citations expired under workspace retention.</p>;
  if(!run.result)return <p>{run.status==='reconciled'?'Only the charge was recovered. A new answer needs a fresh paid quote.':run.status==='queued'?'Waiting for the worker.':run.status==='running'?'The request was sent; the answer and charge are pending.':run.status==='cancelled'?'This request was not dispatched.':'No supported answer is available. A failed request may still be charged.'}</p>;
  const result=run.result;
  return <>
    {result.text===''?<p>Provider returned an empty answer.</p>:<div role="region" aria-label={`Answer from ${modelName(run.model)}`} tabIndex={0} style={{...textStyle,maxHeight:'28rem',overflow:'auto',minWidth:0}}>{result.text}</div>}
    <details><summary>Reported citations ({result.citations.length})</summary>{result.citations.length===0?<p>No citations reported.</p>:<ul>{result.citations.map((citation,index)=>{const href=citationUrl(citation.url);return <li key={index} style={{overflowWrap:'anywhere'}}>{href?<a href={href} target="_blank" rel="noopener noreferrer">{citation.title||citation.url}</a>:<span>{citation.title||citation.url} (link unavailable)</span>}</li>;})}</ul>}</details>
    <details><summary>Response metadata</summary><p>Resolved model: {result.resolvedModel} · Provider: {result.provider} · Finish: {result.finishReason}</p><p>Prompt tokens: {result.promptTokens??'Unavailable'} · Completion tokens: {result.completionTokens??'Unavailable'} · Received {when(result.receivedAt)}</p></details>
  </>;
}
