import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {api,ApiError,errMsg} from '../lib/api';
import {Link} from '@tanstack/react-router';
import {RunCostSummary} from '@ten98/ui';
import {SavedKeywordsPanel,type ResearchSaveSeed} from './SavedKeywordsPanel';
import {isKeywordMetricRow} from '../lib/keyword-metrics';
import {workspaceRoles,type WorkspaceRole} from '@ten98/runtime';
import {useConfirmDialog} from './useConfirmDialog';

type Role=WorkspaceRole;
type Mode='overview'|'ideas';
type Market={locationCode:number;locationName:string;languageCode:string;languageName:string};
type Req={connectionId:string;mode:Mode;keywords:string[];locationCode:number;languageCode:string;limit:25|50|100};
type Quote={id:string;expiresAt:string;request:Req;connectionName:string;estimateUsd:string;perTaskUsd:string;perItemUsd:string;upperItems:number;priceAsOf:string};
type Row={keyword:string;searchVolume:number|null;cpcUsd:string|null;competition:number|null;competitionLevel:'LOW'|'MEDIUM'|'HIGH'|null;keywordDifficulty:number|null;intent:string|null;monthlySearches:Array<{year:number;month:number;searchVolume:number|null}>;metricsUpdatedAt:string|null;intentUpdatedAt:string|null};
type Result={retrievedAt:string;source:'DataForSEO Labs / Google';rows:Row[];missingKeywords:string[];totalCount:number|null;limited:boolean};
type Status='queued'|'running'|'completed'|'failed'|'uncertain'|'cancelled'|'reconciled';
type Charge='reserved'|'dispatched'|'settled'|'uncertain'|'cancelled';
type RunSummary={id:string;mode:Mode;keywords:string[];locationCode:number;languageCode:string;status:Status;createdAt:string;completedAt:string|null;estimateUsd:string;actualUsd:string|null;chargeStatus:Charge};
type Run=RunSummary&{request:Req;canCancel:boolean;diagnostic:string|null;result:Result|null;resultExpired:boolean};
type State={role:Role;vaultConfigured:boolean;spendingPaused:boolean;connections:Array<{id:string;name:string;checkStatus:'untested'|'ok'|'error'}>;catalog:{updatedAt:string|null;markets:Market[]};runs:RunSummary[]};

const isAbort=(e:unknown)=>(e as {name?:string}|null)?.name==='AbortError';
const num=(v:number|null)=>v==null?'Unavailable':v.toLocaleString();
const usd=(v:string|null)=>v==null?'Unavailable':'$'+v;
const dt=(iso:string|null)=>iso?new Date(iso).toLocaleString():'Unavailable';
const toSummary=(r:Run):RunSummary=>({id:r.id,mode:r.mode,keywords:r.keywords,locationCode:r.locationCode,languageCode:r.languageCode,status:r.status,createdAt:r.createdAt,completedAt:r.completedAt,estimateUsd:r.estimateUsd,actualUsd:r.actualUsd,chargeStatus:r.chargeStatus});
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const nullableDate=(v:unknown)=>v===null||date(v);
const nullableString=(v:unknown)=>v===null||typeof v==='string';
const amount=(v:unknown)=>typeof v==='string'&&/^(?:0|[1-9][0-9]*)\.[0-9]{6}$/.test(v);
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(x=>typeof x==='string');
const metric=(v:unknown,max=Number.MAX_SAFE_INTEGER,integer=false)=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max&&(!integer||Number.isSafeInteger(v));
function validRequest(value:unknown):value is Req{
  const r=value as Req|null;
  return !!r&&uuid(r.connectionId)&&['overview','ideas'].includes(r.mode)&&strings(r.keywords)&&r.keywords.length>=1&&r.keywords.length<=100&&Number.isSafeInteger(r.locationCode)&&r.locationCode>0&&typeof r.languageCode==='string'&&[25,50,100].includes(r.limit);
}
function validSummary(value:unknown):value is RunSummary{
  const r=value as RunSummary|null;
  return !!r&&uuid(r.id)&&['overview','ideas'].includes(r.mode)&&strings(r.keywords)&&Number.isSafeInteger(r.locationCode)&&r.locationCode>0&&typeof r.languageCode==='string'&&['queued','running','completed','failed','uncertain','cancelled','reconciled'].includes(r.status)&&date(r.createdAt)&&nullableDate(r.completedAt)&&amount(r.estimateUsd)&&(r.actualUsd===null||amount(r.actualUsd))&&['reserved','dispatched','settled','uncertain','cancelled'].includes(r.chargeStatus);
}
function validResult(value:unknown):value is Result{
  const r=value as Result|null;
  return !!r&&date(r.retrievedAt)&&r.source==='DataForSEO Labs / Google'&&strings(r.missingKeywords)&&metric(r.totalCount,Number.MAX_SAFE_INTEGER,true)&&typeof r.limited==='boolean'&&Array.isArray(r.rows)&&r.rows.length<=100&&r.rows.every(isKeywordMetricRow);
}
function sameRequest(a:Req,b:Req){return a.connectionId===b.connectionId&&a.mode===b.mode&&a.locationCode===b.locationCode&&a.languageCode===b.languageCode&&a.limit===b.limit&&a.keywords.length===b.keywords.length&&a.keywords.every((k,i)=>k===b.keywords[i]);}

function normKeywords(text:string):string[]{
  const seen=new Set<string>();const out:string[]=[];
  for(const line of text.split('\n')){
    const k=line.trim().replace(/\s+/g,' ').toLowerCase();
    if(k&&!seen.has(k)){seen.add(k);out.push(k);}
  }
  return out;
}

function keywordProblem(ks:string[],mode:Mode):string|null{
  if(mode==='ideas'&&ks.length!==1)return 'Ideas mode needs exactly one seed keyword; found '+ks.length+'.';
  if(mode==='overview'&&(ks.length<1||ks.length>100))return 'Overview needs 1 to 100 unique keywords; found '+ks.length+'.';
  for(const k of ks){
    if([...k].length>80)return '"'+k+'" is longer than 80 characters.';
    if(k.split(' ').length>10)return '"'+k+'" has more than 10 words.';
  }
  return null;
}

function statusLabel(r:RunSummary):string{
  switch(r.status){
    case 'queued':return 'Queued (not sent to the provider yet)';
    case 'running':return 'Running';
    case 'completed':return 'Completed';
    case 'failed':return 'Failed';
    case 'cancelled':return 'Cancelled';
    case 'uncertain':return 'Uncertain (charge unknown)';
    case 'reconciled':return 'Reconciled';
  }
}

function chargeNote(r:RunSummary):string{
  if(r.chargeStatus==='uncertain'||r.status==='uncertain')return 'The charge for this run is unknown. Spending stays blocked pending reconciliation; unknown is not free.';
  if(r.actualUsd!=null)return 'Actual charge $'+r.actualUsd+' (reserved estimate $'+r.estimateUsd+').'+(r.status==='failed'?' A failed run can still be charged by the provider.':'');
  return 'Reserved estimate $'+r.estimateUsd+'; no settled charge yet.';
}

export function KeywordResearchPanel({workspaceId,projectId,userId,onUnauthorized}:{workspaceId:string;projectId:string;userId:string;onUnauthorized:()=>void}){
  // Keyed remount clears all drafts, quotes, pending request keys and results on scope change.
  return <KeywordWorkspace key={userId+'|'+projectId} {...{workspaceId,projectId,userId,onUnauthorized}}/>;
}

function KeywordWorkspace(props:{workspaceId:string;projectId:string;userId:string;onUnauthorized:()=>void}){
  const [tab,setTab]=useState<'research'|'saved'>('research'),[researchLocked,setResearchLocked]=useState(false),[savedLocked,setSavedLocked]=useState(false),[seed,setSeed]=useState<ResearchSaveSeed|null>(null);
  const locked=researchLocked||savedLocked;
  return <div className="keyword-workspace"><div className="row keyword-tabs" aria-label="Keyword sections"><button className={'btn '+(tab==='research'?'primary':'ghost')} aria-pressed={tab==='research'} disabled={locked&&tab!=='research'} onClick={()=>{setSeed(null);setTab('research');}}>Research</button><button className={'btn '+(tab==='saved'?'primary':'ghost')} aria-pressed={tab==='saved'} disabled={locked&&tab!=='saved'} onClick={()=>setTab('saved')}>Saved keywords</button></div>{locked&&<p className="hint">Finish or cancel the current changes before switching keyword sections.</p>}{tab==='research'?<Panel {...props} active onLockChange={setResearchLocked} onSaveRows={(run,indexes)=>{setSeed({key:crypto.randomUUID(),runId:run.id,rowIndexes:indexes,keywords:indexes.map(i=>run.result!.rows[i].keyword),locationCode:run.locationCode,languageCode:run.languageCode});setTab('saved');}}/>:<SavedKeywordsPanel {...props} active seed={seed} onLockChange={setSavedLocked}/>}</div>;
}
function Panel({workspaceId,projectId,onUnauthorized,active,onLockChange,onSaveRows}:{workspaceId:string;projectId:string;onUnauthorized:()=>void;active:boolean;onLockChange:(locked:boolean)=>void;onSaveRows:(run:Run,indexes:number[])=>void}){
  const B='/api/projects/'+encodeURIComponent(projectId)+'/keyword-research';
  const uid=useId();
  const [st,setSt]=useState<State|null>(null);
  const [loadErr,setLoadErr]=useState<string|null>(null);
  const [err,setErr]=useState<string|null>(null);
  const [msg,setMsg]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [writing,setWriting]=useState(false);
  const [formOpen,setFormOpen]=useState(true);
  const [mode,setMode]=useState<Mode>('overview');
  const [connId,setConnId]=useState('');
  const [kwText,setKwText]=useState('');
  const [marketKey,setMarketKey]=useState('');
  const [limit,setLimit]=useState<25|50|100>(50);
  const [quote,setQuote]=useState<Quote|null>(null);
  const [quoteKey,setQuoteKey]=useState<string|null>(null);
  const [lostStart,setLostStart]=useState(false);
  const [selected,setSelected]=useState<Run|null>(null);
  const [pollDead,setPollDead]=useState(false);
  const [reconConn,setReconConn]=useState('');
  const [reconMsg,setReconMsg]=useState<string|null>(null);
  type Operation={generation:number;controller:AbortController;write:boolean};
  const activeRef=useRef<Operation|null>(null);
  const aliveRef=useRef(false);
  const genRef=useRef(0);
  const formGenRef=useRef(0);
  const selectionRef=useRef<string|null>(null);
  const pollRef=useRef({id:'',count:0});
  const unauthRef=useRef(onUnauthorized);
  const notifiedRef=useRef(false);
  const resultHeading=useRef<HTMLHeadingElement|null>(null),focusResult=useRef(false);
  const [clock,setClock]=useState(Date.now());
  const [confirm,confirmDialog]=useConfirmDialog();
  unauthRef.current=onUnauthorized;
  useEffect(()=>{onLockChange(writing||lostStart);},[writing,lostStart,onLockChange]);

  const current=(op:Operation)=>aliveRef.current&&activeRef.current===op&&genRef.current===op.generation;
  function begin(write=false,replaceRead=false):Operation|null{
    if(!aliveRef.current||activeRef.current&&(activeRef.current.write||!replaceRead))return null;
    activeRef.current?.controller.abort();
    const op={generation:++genRef.current,controller:new AbortController(),write};
    activeRef.current=op;setBusy(true);setWriting(write);return op;
  }
  function finish(op:Operation){if(current(op)){activeRef.current=null;setBusy(false);setWriting(false);}}
  function clearQuote(){setQuote(null);setQuoteKey(null);setLostStart(false);}
  function edit(change:()=>void){
    if(activeRef.current?.write||lostStart)return;
    // Editing may interrupt a status read, but never an in-flight mutation.
    activeRef.current?.controller.abort();activeRef.current=null;genRef.current++;setBusy(false);
    formGenRef.current++;clearQuote();setErr(null);setMsg(null);change();
  }
  function purge(message:string){
    formGenRef.current++;selectionRef.current=null;focusResult.current=false;
    setSt(null);setSelected(null);clearQuote();setKwText('');setConnId('');setMarketKey('');
    setReconConn('');setReconMsg(null);setMsg(null);setErr(null);setPollDead(true);setLoadErr(message);
  }
  function handleErr(e:unknown,op:Operation):boolean{
    if(!current(op)||isAbort(e))return true;
    if(e instanceof ApiError&&(e.status===401||e.status===403||e.status===404)){
      purge(e.status===401?'Your session expired. Sign in again.':'Access unavailable. Reload access to continue.');
      if(e.status===401&&!notifiedRef.current){notifiedRef.current=true;unauthRef.current();}
      return true;
    }
    return false;
  }
  function applyState(s:State){
    setSt(s);setLoadErr(null);
    if(s.role==='viewer'){formGenRef.current++;clearQuote();setKwText('');setReconConn('');setReconMsg(null);}
    else {setConnId(id=>id||s.connections[0]?.id||'');setReconConn(id=>id||s.connections[0]?.id||'');}
  }
  async function access(op:Operation){
    const s=await api<State>(B,{signal:op.controller.signal});
    if(!current(op))return null;
    if(!workspaceRoles.includes(s?.role as WorkspaceRole)||typeof s.vaultConfigured!=='boolean'||typeof s.spendingPaused!=='boolean'||!Array.isArray(s.connections)||s.connections.some(c=>!c||!uuid(c.id)||typeof c.name!=='string'||!['untested','ok','error'].includes(c.checkStatus))||!Array.isArray(s.runs)||!s.runs.every(validSummary)||!Array.isArray(s.catalog?.markets)||!nullableDate(s.catalog.updatedAt)||s.catalog.markets.some(m=>!m||!Number.isSafeInteger(m.locationCode)||typeof m.locationName!=='string'||typeof m.languageCode!=='string'||typeof m.languageName!=='string'))throw new Error('The saved state could not be read. Reload access.');
    applyState(s);return s;
  }
  function runFrom(value:unknown):Run{
    const run=(value as {run?:Run}|null)?.run;
    if(!validSummary(run)||!validRequest(run.request)||typeof run.canCancel!=='boolean'||typeof run.resultExpired!=='boolean'||!nullableString(run.diagnostic)||!(run.result===null||validResult(run.result))||run.mode!==run.request.mode||run.locationCode!==run.request.locationCode||run.languageCode!==run.request.languageCode||run.keywords.length!==run.request.keywords.length||run.keywords.some((k,i)=>k!==run.request.keywords[i]))throw new Error('The server response was incomplete. Reload the saved run.');
    return run;
  }
  function showRun(run:Run,focus=false){
    if(focus){focusResult.current=true;setFormOpen(false);}
    selectionRef.current=run.id;
    if(pollRef.current.id!==run.id)pollRef.current={id:run.id,count:0};
    setPollDead(false);setSelected(run);
    setSt(s=>s?{...s,runs:[toSummary(run),...s.runs.filter(x=>x.id!==run.id)].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.id.localeCompare(a.id)).slice(0,20)}:s);
  }
  async function reloadAccess(){
    const op=begin(false,true);if(!op)return;
    setLoadErr(null);setErr(null);
    try{await access(op);}catch(e){if(current(op)&&!handleErr(e,op))setLoadErr(errMsg(e));}finally{finish(op);}
  }
  useEffect(()=>{
    aliveRef.current=true;void reloadAccess();
    return ()=>{aliveRef.current=false;genRef.current++;activeRef.current?.controller.abort();activeRef.current=null;};
  },[B]);
  useEffect(()=>{if(!quote)return;const timer=setInterval(()=>setClock(Date.now()),1000);return ()=>clearInterval(timer);},[quote?.id]);
  useEffect(()=>{if(focusResult.current&&selected){resultHeading.current?.focus();focusResult.current=false;}},[selected]);

  async function selectRun(id:string,automatic=false){
    if(automatic&&activeRef.current)return;
    const op=begin(false,!automatic);if(!op)return;
    if(!automatic){
      selectionRef.current=id;pollRef.current={id,count:0};setPollDead(false);setErr(null);setReconMsg(null);
      if(selected?.id!==id)setSelected(null);
    }
    try{
      // The run endpoint omits current role: refresh local authority metadata before detail/action.
      if(!await access(op)||!current(op))return;
      const response=await api<unknown>(B+'/runs/'+encodeURIComponent(id),{signal:op.controller.signal});
      if(!current(op)||selectionRef.current!==id)return;
      const run=runFrom(response);if(run.id!==id)throw new Error('The requested run could not be read.');
      showRun(run,!automatic&&selected?.id!==id);
    }catch(e){
      if(!current(op)||handleErr(e,op))return;
      setErr(automatic?'Status could not be refreshed. Use Check status to try again.':errMsg(e));setPollDead(true);
    }finally{finish(op);}
  }
  useEffect(()=>{
    if(!active||!selected||pollDead||!['queued','running'].includes(selected.status))return;
    const id=selected.id;let cancelled=false;let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{
      if(cancelled||selectionRef.current!==id||!aliveRef.current)return;
      if(document.visibilityState==='hidden'){timer=setTimeout(tick,2000);return;}
      if(activeRef.current){timer=setTimeout(tick,2000);return;}
      if(pollRef.current.count>=60){setPollDead(true);return;}
      pollRef.current.count++;await selectRun(id,true);
      if(!cancelled&&selectionRef.current===id)timer=setTimeout(tick,2000);
    };
    timer=setTimeout(tick,2000);
    return ()=>{cancelled=true;clearTimeout(timer);};
  },[active,selected?.id,selected?.status,pollDead]);

  const parsed=normKeywords(kwText);
  const markets=st?.catalog.markets??[];
  const market=markets.find(m=>marketKey===m.locationCode+'|'+m.languageCode);
  const quoteExpired=quote?Date.parse(quote.expiresAt)<=clock:false;

  async function refreshCatalog(){
    if(lostStart)return;
    const op=begin(true,true);if(!op)return;
    formGenRef.current++;clearQuote();setErr(null);setMsg(null);
    try{
      const state=await access(op);if(!state||!current(op))return;
      if(state.role==='viewer')throw new Error('Your current role can read research but cannot refresh markets.');
      const response=await api<{catalog:State['catalog']}>(B+'/catalog',{method:'POST',body:{connectionId:connId},signal:op.controller.signal});
      if(!current(op))return;
      setSt(s=>s?{...s,catalog:response.catalog}:s);setMsg('Markets refreshed. Prepare a new quote.');
    }catch(e){if(current(op)&&!handleErr(e,op))setErr(errMsg(e));}finally{finish(op);}
  }
  async function prepareQuote(ev:FormEvent){
    ev.preventDefault();if(lostStart)return;
    const op=begin(true,true);if(!op)return;
    const formGeneration=formGenRef.current;
    clearQuote();setErr(null);setMsg(null);
    try{
      const problem=keywordProblem(parsed,mode);if(problem)throw new Error(problem);
      if(!market)throw new Error('Choose a country or territory and language. Refresh markets first if none are listed.');
      const body:Req={connectionId:connId,mode,keywords:parsed,locationCode:market.locationCode,languageCode:market.languageCode,limit:mode==='overview'?100:limit};
      const state=await access(op);if(!state||!current(op))return;
      if(state.role==='viewer')throw new Error('Your current role can read research but cannot prepare quotes.');
      const response=await api<{quote:Quote}>(B+'/quote',{method:'POST',body,signal:op.controller.signal});
      if(!current(op)||formGeneration!==formGenRef.current)return;
      const q=response.quote;
      if(!uuid(q?.id)||!date(q.expiresAt)||!validRequest(q.request)||!sameRequest(q.request,body)||typeof q.connectionName!=='string'||!amount(q.estimateUsd)||!amount(q.perTaskUsd)||!amount(q.perItemUsd)||!Number.isSafeInteger(q.upperItems)||q.upperItems<1||!date(q.priceAsOf))throw new Error('The quote could not be read. Prepare a new quote.');
      setClock(Date.now());setQuote(response.quote);setMsg('Quote ready. Review the exact inputs and charge before starting.');
    }catch(e){if(current(op)&&!handleErr(e,op))setErr(errMsg(e));}finally{finish(op);}
  }
  async function startRun(){
    if(!quote)return;
    const op=begin(true,true);if(!op)return;
    const recovering=lostStart;
    let sent=false;
    setErr(null);setMsg(null);
    try{
      const state=await access(op);if(!state||!current(op))return;
      if(state.role==='viewer'){setErr('Your current role can read research but cannot start it.');return;}
      if(!recovering&&(state.spendingPaused||!state.vaultConfigured||Date.parse(quote.expiresAt)<=Date.now()))throw new Error('This quote cannot start now. Review spending settings or prepare a new quote.');
      const key=quoteKey??crypto.randomUUID();
      setQuoteKey(key);
      const body={quoteId:quote.id,requestKey:key};
      sent=true;
      const response=await api<unknown>(B+'/runs',{method:'POST',body,signal:op.controller.signal});
      if(!current(op))return;
      const run=runFrom(response);
      if(!sameRequest(run.request,quote.request))throw new Error('The start response did not match this quote.');
      clearQuote();showRun(run,true);setMsg('The saved research run is shown below.');
    }catch(e){
      if(!current(op)||handleErr(e,op))return;
      const ambiguous=!(e instanceof ApiError)||e.status===0||e.status>=500;
      if((sent||recovering)&&ambiguous){
        setLostStart(true);setErr('The start may already have been accepted. Retry the same request, or inspect Recent runs before starting new research.');
      }else{
        if(sent)clearQuote();
        setErr(e instanceof ApiError&&e.status===409?'The server rejected this attempt. Inspect Recent runs, then explicitly prepare a new quote if needed.':errMsg(e));
      }
    }finally{finish(op);}
  }
  async function cancelRun(){
    if(!selected?.canCancel||!await confirm({title:'Cancel this queued run?',description:'Requests already sent may still be charged.',confirmLabel:'Cancel run'}))return;
    const id=selected.id;const op=begin(true,true);if(!op)return;setErr(null);setMsg(null);
    try{
      const state=await access(op);if(!state||!current(op))return;
      if(state.role==='viewer')throw new Error('Your current role cannot cancel research.');
      const response=await api<unknown>(B+'/runs/'+encodeURIComponent(id)+'/cancel',{method:'POST',body:{},signal:op.controller.signal});
      if(!current(op))return;
      const run=runFrom(response);if(run.id!==id)throw new Error('Reload this run to check its current state.');
      showRun(run);setMsg('Run status updated. Requests already sent may still be charged.');
    }catch(e){if(current(op)&&!handleErr(e,op))setErr(errMsg(e));}finally{finish(op);}
  }
  async function reconcile(){
    if(!selected||selected.status!=='uncertain'||!reconConn)return;
    const id=selected.id;const op=begin(true,true);if(!op)return;setErr(null);setReconMsg(null);
    try{
      const state=await access(op);if(!state||!current(op))return;
      if(state.role!=='owner')throw new Error('Only a current workspace owner can check provider charges.');
      const response=await api<{run:Run;reconciliation:{status:'matched'|'inconclusive';message:string}}>(B+'/runs/'+encodeURIComponent(id)+'/reconcile',{method:'POST',body:{connectionId:reconConn},signal:op.controller.signal});
      if(!current(op))return;
      const run=runFrom(response);if(run.id!==id)throw new Error('Reload this run to check its current state.');
      if(!response.reconciliation||!['matched','inconclusive'].includes(response.reconciliation.status)||typeof response.reconciliation.message!=='string')throw new Error('Reload this run to check its current state.');
      showRun(run);setReconMsg(response.reconciliation.message);
    }catch(e){if(current(op)&&!handleErr(e,op))setErr(errMsg(e));}finally{finish(op);}
  }
  if(!st){
    return <section className="stack" aria-label="Keyword research">
      <div className="row between"><h2>Keyword research</h2><button type="button" className="btn ghost" onClick={()=>void reloadAccess()} disabled={writing}>Reload access</button></div>
      {loadErr?<div className="alert" role="alert">{loadErr}</div>:<p className="dim">Loading keyword research…</p>}
    </section>;
  }

  const canResearch=st.role!=='viewer';
  const isOwner=st.role==='owner';
  const selMarket=selected?markets.find(m=>m.locationCode===selected.request.locationCode&&m.languageCode===selected.request.languageCode):undefined;
  const startBlockers:string[]=[];
  if(st.spendingPaused)startBlockers.push('spending is paused');
  if(!st.vaultConfigured)startBlockers.push('credential storage needs installation operator setup');
  if(quoteExpired)startBlockers.push('the quote expired — prepare a new one');

  return <section className="research-panel keyword-research stack" style={{display:'grid',gap:16,minWidth:0}} aria-busy={busy} aria-label="Keyword research">
    <div className="row between"><h2>Keyword research</h2><div className="row">{isOwner&&<Link className="btn ghost" to="/" search={{workspace:workspaceId,project:projectId,view:'providers'}} aria-disabled={writing||undefined} onClick={event=>{if(activeRef.current?.write)event.preventDefault();}}>{st.connections.length===0?'Set up DataForSEO':'AI and search providers'}</Link>}<button type="button" className="btn ghost" onClick={()=>void reloadAccess()} disabled={writing}>Reload access</button></div></div>
    {!isOwner&&<p className="hint">Ask a workspace owner to manage AI and search providers or the paid-work pause. Your current role can still view saved results.</p>}
    {st.spendingPaused&&<div className="alert" role="alert">Spending is paused for this workspace. Saved history and results below remain available; new paid research is disabled.</div>}
    {msg&&<p role="status">{msg}</p>}
    {(err||loadErr)&&<div className="alert" role="alert">{err||loadErr}</div>}

    {canResearch&&(!st.vaultConfigured?
      <div className="alert" role="alert">Credential storage is not configured. Ask the installation operator to enable it, then ask a workspace owner to add a DataForSEO connection in AI and search providers. Adding a connection cannot fix missing credential storage.</div>
    :st.connections.length===0?
      <div className="alert" role="alert">No DataForSEO connection is saved yet. {isOwner ? 'Choose Set up DataForSEO to add one, then return here.' : 'Ask a workspace owner to add one in AI and search providers, then reload access.'}</div>
    :
      <details className="card" open={formOpen} onToggle={event=>setFormOpen(event.currentTarget.open)}><summary>New keyword research</summary><form className="stack" onSubmit={prepareQuote}><fieldset disabled={writing||lostStart} style={{border:0,padding:0,minWidth:0,display:'grid',gridTemplateColumns:'minmax(0,1fr)',gap:14}}><legend>Research inputs</legend>
        <div>
          <label htmlFor={uid+'-conn'}>Provider connection</label>
          <select id={uid+'-conn'} style={{width:'100%'}} value={connId} onChange={e=>edit(()=>setConnId(e.target.value))} required>
            {st.connections.map(c=><option key={c.id} value={c.id}>{c.name}{c.checkStatus==='ok'?' (check ok)':c.checkStatus==='error'?' (check failed)':' (untested)'}</option>)}
          </select>
          <p className="hint">A saved credential counts as connected only after a check passes — and even then not every endpoint is guaranteed to work.</p>
        </div>
        <div>
          <label htmlFor={uid+'-mode'}>Research mode</label>
          <select id={uid+'-mode'} value={mode} onChange={e=>edit(()=>setMode(e.target.value as Mode))}>
            <option value="overview">Keyword overview (metrics for 1–100 keywords)</option>
            <option value="ideas">Keyword ideas (suggestions for one seed)</option>
          </select>
        </div>
        <div>
          <label htmlFor={uid+'-kw'}>{mode==='overview'?'Keywords (one per line)':'Seed keyword'}</label>
          <textarea id={uid+'-kw'} rows={mode==='overview'?6:2} style={{width:'100%',minHeight:96}} value={kwText} onChange={e=>edit(()=>setKwText(e.target.value))} required/>
          <p className="hint">{parsed.length} unique {parsed.length===1?'keyword':'keywords'} after trimming, lowercasing and deduplicating. Max 80 characters and 10 words each; the server stays authoritative.</p>
        </div>
        <details open>
          <summary>Market and result limit</summary>
          <div className="stack">
            <div>
              <label htmlFor={uid+'-market'}>Country or territory and language</label>
              <select id={uid+'-market'} style={{width:'100%'}} value={marketKey} onChange={e=>edit(()=>setMarketKey(e.target.value))} required disabled={markets.length===0}>
                <option value="">Choose a market…</option>
                {markets.map(m=><option key={m.locationCode+'|'+m.languageCode} value={m.locationCode+'|'+m.languageCode}>{m.locationName} / {m.languageName} ({m.languageCode})</option>)}
              </select>
              <p className="hint">{markets.length===0?'No markets loaded. Refresh markets to fetch the catalog (a free provider request).':'Catalog updated '+dt(st.catalog.updatedAt)+'.'}</p>
            </div>
            {mode==='ideas'&&<div>
              <label htmlFor={uid+'-limit'}>Max ideas</label>
              <select id={uid+'-limit'} value={limit} onChange={e=>edit(()=>setLimit(Number(e.target.value) as 25|50|100))}>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>}
            <div className="row">
              <button type="button" className="btn" onClick={refreshCatalog} disabled={writing||!connId}>Refresh markets</button>
            </div>
          </div>
        </details>
        <div className="row">
          <button type="submit" className="btn primary" disabled={writing}>Prepare quote</button>
        </div>
        <p className="hint">Preparing a quote is a free account-price lookup; it starts no research and charges nothing.</p>
      </fieldset></form></details>
    )}

    {canResearch&&quote&&<div className="card stack" aria-label="Quote">
      <h3>Quote for {quote.request.mode==='overview'?'keyword overview':'keyword ideas'}</h3>
      <p>{quote.request.mode==='overview'
        ?quote.request.keywords.length+' keywords'
        :'Seed "'+(quote.request.keywords[0]??'')+'"'} · {market?market.locationName+' / '+market.languageName:'location '+quote.request.locationCode+', language '+quote.request.languageCode} · connection {quote.connectionName} · up to {quote.upperItems} billed items</p>
      <details><summary>Exact quoted keywords</summary><ol>{quote.request.keywords.map(keyword=><li key={keyword} style={{overflowWrap:'anywhere'}}>{keyword}</li>)}</ol></details>
      <RunCostSummary title="Quote cost" state={lostStart?'uncertain':quoteExpired?'expired':st.spendingPaused||!st.vaultConfigured?'blocked':'quoted'}
        scope={<span>{quote.request.mode} · {quote.request.keywords.join(', ')} · {market?market.locationName+' / '+market.languageName:'location '+quote.request.locationCode+', language '+quote.request.languageCode} · connection {quote.connectionName}</span>}
        units={<span>Up to {quote.upperItems} billed items · per task ${quote.perTaskUsd} · per item ${quote.perItemUsd}</span>}
        estimatedPrice={'$'+quote.estimateUsd}
        settledPrice={lostStart?undefined:'No settled charge reported'}
        quoteExpiryLabel={dt(quote.expiresAt)}
        receipt={<span>Quote {quote.id} · prices observed {dt(quote.priceAsOf)}</span>}
        reason={lostStart?'The start response was lost; this run may already exist and its charge is unknown.':quoteExpired?'The quote expired; prepare a new quote before starting.':startBlockers.length?'Start unavailable: '+startBlockers.join('; ')+'.':'Review the exact inputs and estimate before authorizing paid research.'}
        warnings="A 5-minute quote is not a provider price guarantee. This covers spending requested by this app, not all usage on the provider account. The quote itself charges nothing — only the button below authorizes paid research."/>
      {lostStart?
        <div className="alert" role="alert">
          <p>The start request was sent but the response was lost, so this run may already exist. Retrying sends the exact same request (same quote ID and request key); no new charge key is created and paid work is never silently retried.</p>
          <div className="row">
            <button type="button" className="btn primary" onClick={startRun} disabled={writing}>Retry same request</button>
            <button type="button" className="btn" onClick={()=>void (async()=>{if(await confirm({title:'Discard local retry controls?',description:'The server request may already exist; this does not cancel it.',confirmLabel:'Dismiss retry controls'})&&!activeRef.current?.write){clearQuote();setErr(null);setMsg('Local retry controls cleared. Check Recent runs before starting new research.');}})()} disabled={writing}>Dismiss retry controls</button>
          </div>
        </div>
      :
        <div className="row">
          <button type="button" className="btn primary" onClick={startRun} disabled={writing||quoteExpired||st.spendingPaused||!st.vaultConfigured}>Run quoted research (paid)</button>
        </div>}
      {!lostStart&&startBlockers.length>0&&<p className="hint">Start unavailable: {startBlockers.join('; ')}.</p>}
    </div>}

    {selected&&<div className="card stack" aria-label="Selected run">
      <h3 ref={resultHeading} tabIndex={-1}>{selected.mode==='overview'?'Keyword overview':'Keyword ideas'} results</h3>
      <p>{statusLabel(selected)} · created {dt(selected.createdAt)}{selected.completedAt?' · finished '+dt(selected.completedAt):''} · {selected.mode} · {selected.keywords.length} {selected.mode==='overview'?'keywords':'seed'} · {selMarket?selMarket.locationName+' / '+selMarket.languageName:'location '+selected.locationCode+', language '+selected.languageCode}</p>
      <RunCostSummary title="Run cost" state={selected.chargeStatus==='uncertain'||selected.status==='uncertain'?'uncertain':selected.actualUsd!=null?'settled':selected.chargeStatus==='reserved'||selected.chargeStatus==='dispatched'?'pending':selected.chargeStatus==='cancelled'?'blocked':'uncertain'}
        scope={<span>{selected.mode} · {selected.keywords.join(', ')} · {selMarket?selMarket.locationName+' / '+selMarket.languageName:'location '+selected.locationCode+', language '+selected.languageCode}</span>}
        units={<span>{selected.keywords.length} {selected.mode==='overview'?'keywords':'seed'} · requested limit {selected.request.limit}</span>}
        estimatedPrice={'$'+selected.estimateUsd}
        settledPrice={selected.chargeStatus==='uncertain'||selected.status==='uncertain'?undefined:selected.actualUsd!=null?'$'+selected.actualUsd:selected.chargeStatus==='cancelled'?'Charge cancelled; no settled charge reported.':undefined}
        receipt={'Run '+selected.id}
        reason={chargeNote(selected)}/>

      {selected.diagnostic&&<p className="hint">Diagnostic: {selected.diagnostic}</p>}
      {(selected.status==='queued'||selected.status==='running')&&<p role="status" className="dim">{pollDead?'Automatic status checks stopped.':selected.status==='queued'?'Waiting in queue; checking status every 2 seconds.':'Running; checking status every 2 seconds.'}</p>}
      <div className="row"><button type="button" className="btn" onClick={()=>void selectRun(selected.id)} disabled={writing}>Check status</button></div>
      {canResearch&&selected.canCancel&&<div className="row"><button type="button" className="btn" onClick={cancelRun} disabled={writing}>Cancel run</button></div>}
      {isOwner&&selected.status==='uncertain'&&selected.chargeStatus==='uncertain'&&<details>
        <summary>Check provider charge (owner)</summary>
        <div className="stack">
          <p className="hint">Runs a free metadata check against the provider account; the server validates that the connection matches. This does not rerun research and cannot recover a missing live result.</p>
          <div>
            <label htmlFor={uid+'-recon'}>Connection to check</label>
            <select id={uid+'-recon'} value={reconConn} onChange={e=>setReconConn(e.target.value)}>
              {st.connections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="row"><button type="button" className="btn" onClick={reconcile} disabled={writing||!reconConn}>Check provider charge</button></div>
          {reconMsg&&<p role="status">{reconMsg}</p>}
        </div>
      </details>}
      {selected.result&&!selected.resultExpired?
        <ResultView key={selected.id} run={selected} result={selected.result} canSave={canResearch&&selected.status==='completed'} disabled={writing||lostStart} onSave={indexes=>onSaveRows(selected,indexes)} marketName={selMarket?selMarket.locationName+' / '+selMarket.languageName:'location '+selected.request.locationCode+', language '+selected.request.languageCode}/>
      :selected.resultExpired?
        <p className="hint">The saved result for this run was purged and is no longer available. The charge record above is unaffected.</p>
      :selected.status==='reconciled'?
        <p className="hint">Only the cost was reconciled for this run; no result was recovered. Getting a result needs a fresh explicit quote.</p>
      :selected.status==='completed'?
        <p className="hint">This run completed but no saved result is available.</p>
      :selected.status==='failed'?
        <p className="hint">This run failed; no result was saved.</p>
      :selected.status==='cancelled'?
        <p className="hint">This run was cancelled; no result was saved.</p>
      :<p className="hint">Results appear here once the run finishes.</p>}
    </div>}

    <div className="card stack" aria-label="Run history">
      <h3>Recent runs</h3>
      {st.runs.length===0?
        <p className="dim">No research runs have been saved for this project.</p>
      :
        <div className="table-wrap" role="region" aria-label="Recent keyword runs" tabIndex={0}><table style={{minWidth:760}}>
          <thead><tr><th>Created</th><th>Mode</th><th>Keywords</th><th>Status</th><th>Charge</th><th>Open</th></tr></thead>
          <tbody>
            {st.runs.map(r=><tr key={r.id}>
              <td>{dt(r.createdAt)}</td>
              <td>{r.mode}</td>
              <td>{r.keywords.length} ({r.keywords.slice(0,2).join(', ')}{r.keywords.length>2?', …':''})</td>
              <td>{statusLabel(r)}</td>
              <td>{r.chargeStatus==='uncertain'||r.status==='uncertain'?'Unknown':r.actualUsd!=null?'$'+r.actualUsd:'est. $'+r.estimateUsd}</td>
              <td><button type="button" className="btn" onClick={()=>selectRun(r.id)} disabled={writing||selected?.id===r.id}>View</button></td>
            </tr>)}
          </tbody>
        </table></div>}
    </div>
    {confirmDialog}
  </section>;
}

function ResultView({run,result,marketName,canSave,disabled,onSave}:{run:Run;result:Result;marketName:string;canSave:boolean;disabled:boolean;onSave:(indexes:number[])=>void}){
  const [selected,setSelected]=useState<number[]>([]);
  return <div className="stack">
    {result.rows.length===0&&<p>No matching keyword data was returned. Unavailable data is not zero.</p>}
    <p className="hint">Source: {result.source} · retrieved {dt(result.retrievedAt)} · market {marketName}. Showing {result.rows.length}{result.totalCount!=null?' of '+result.totalCount:''} keywords{result.limited?' (bounded to the requested limit of '+run.request.limit+')':''}. Volumes may overlap between keywords and are not summed.</p>
    {canSave&&result.rows.length>0&&<div className="row"><button className="btn ghost" disabled={disabled} onClick={()=>setSelected(result.rows.map((_,i)=>i))}>Select all results</button><button className="btn ghost" disabled={disabled||!selected.length} onClick={()=>setSelected([])}>Clear selection</button><button className="btn primary" disabled={disabled||!selected.length} onClick={()=>onSave(selected)}>Save {selected.length||''} selected keywords</button></div>}
    <div className="table-wrap" role="region" aria-label="Keyword data table" tabIndex={0}><table style={{minWidth:760}}>
      <thead><tr>{canSave&&<th>Select</th>}<th>Keyword</th><th>Est. monthly volume</th><th>Historical CPC (USD)</th><th>Paid competition</th><th>Organic difficulty</th><th>Intent</th><th>Metrics updated</th></tr></thead>
      <tbody>
        {result.rows.map((r,index)=><tr key={index}>
          {canSave&&<td><input type="checkbox" aria-label={'Select research keyword '+r.keyword} disabled={disabled} checked={selected.includes(index)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,index]:ids.filter(i=>i!==index))}/></td>}
          <td style={{minWidth:200,overflowWrap:'anywhere'}}>{r.keyword}
            {(r.monthlySearches.length>0||r.intentUpdatedAt)&&<details>
              <summary>Monthly history</summary>
              {r.monthlySearches.length>0?
                <div className="table-wrap" role="region" aria-label={`Monthly searches for ${r.keyword}`} tabIndex={0}><table>
                  <thead><tr><th>Month</th><th>Volume</th></tr></thead>
                  <tbody>{r.monthlySearches.map((m,i)=><tr key={i}><td>{m.year}-{String(m.month).padStart(2,'0')}</td><td>{num(m.searchVolume)}</td></tr>)}</tbody>
                </table></div>
              :<p className="hint">No monthly history available.</p>}
              <p className="hint">Intent updated: {dt(r.intentUpdatedAt)}</p>
            </details>}
          </td>
          <td>{num(r.searchVolume)}</td>
          <td>{usd(r.cpcUsd)}</td>
          <td>{r.competition==null?'Unavailable':r.competition+(r.competitionLevel?' ('+r.competitionLevel+')':'')}</td>
          <td>{num(r.keywordDifficulty)}</td>
          <td>{r.intent??'Unavailable'}</td>
          <td>{dt(r.metricsUpdatedAt)}</td>
        </tr>)}
      </tbody>
    </table></div>
    {result.missingKeywords.length>0&&<p className="hint">No data returned for {result.missingKeywords.length} keyword(s) — unavailable, not zero: {result.missingKeywords.join(', ')}</p>}
  </div>;
}
