import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {RunCostSummary, useConfirmDialog} from '@ten98/ui';
import {Link} from '@tanstack/react-router';
import {ApiError,errMsg} from '../lib/api';
import {openRouterModelId,openRouterProviderName,type OpenRouterCatalog} from '../lib/openrouter-models';
import {OpenRouterModelPicker,modelApi as api,ModelResponseError,readModelCatalog,modelUnavailableReason,validModelReservation,modelUsdMicros,type ModelQuoteRoute} from './OpenRouterModelPicker';
import {PromptRecurringPanel} from './PromptRecurringPanel';
import {workspaceRoles,type WorkspaceRole} from '@ten98/runtime';

type Role=WorkspaceRole;
type Model=string;
type Status='queued'|'running'|'completed'|'failed'|'uncertain'|'cancelled'|'reconciled';
type Charge='reserved'|'dispatched'|'uncertain'|'settled'|'cancelled';
type Input={connectionId:string;promptId:string;versionId:string;systemText:string;models:Model[];maxCompletionTokens:number;fundedCredits:true;reuseCached?:boolean};
type Message={role:'system'|'user';content:string};
type RouteQuote=ModelQuoteRoute;
type CacheChoice={model:string;sourceRunId:string|null;sourceComparisonId:string|null;observedAt:string|null;eligibleUntil:string|null};
type Quote={id:string;createdAt:string;expiresAt:string;input:Input;messages:Message[];connectionName:string;routes:RouteQuote[];estimateUsd:string;explanation:string;cacheReused:boolean;cache?:{version:'seven-day-v1';items:CacheChoice[]}};
type Source={url:string;title:string|null};
type Answer={text:string;resolvedModel:string;provider:string;finishReason:string;promptTokens:number|null;completionTokens:number|null;receivedAt:string};
type Reuse={sourceRunId:string;sourceComparisonId:string;observedAt:string;originalCharge:{status:'settled';estimateUsd:string;actualUsd:string}};
type RunSummary={id:string;model:Model;provider:string;status:Status;chargeStatus:Charge|null;estimateUsd:string|null;actualUsd:string|null;dispatchedAt:string|null;completedAt:string|null;diagnostic:string|null;resultExpired:boolean;reuse?:Reuse};
type Run=RunSummary&{result:Answer|null;reportedCost:string|null;isByok:boolean|null;upstreamReportedCost:string|null;generationId:string|null};
type Summary={id:string;quoteId:string;createdAt:string;cancelRequested:boolean;prompt:{id:string;versionId:string;textPreview:string};canCancel:boolean;runs:RunSummary[]};
type Comparison=Summary&{input:Input|null;messages:Message[]|null;inputExpired:boolean;cache:{reused:boolean;available:boolean};answerMode:'individual'};
type AnswerResponse={role:Role;comparisonId:string;run:Run;citations:{count:number|null;pageSize:20}};
type SourcePage={role:Role;comparisonId:string;runId:string;resultExpired:boolean;total:number|null;offset:number;nextOffset:number|null;items:Source[]};
type Card={run:Run|null;loading:boolean;error:string|null;sources:Source[];total:number|null;nextOffset:number|null;sourcesLoading:boolean;sourcesError:string|null};
type Metadata={role:Role;models:Model[];catalog:OpenRouterCatalog|null;vaultConfigured:boolean;spendingPaused:boolean;connections:{id:string;name:string;checkStatus:'untested'|'ok'|'error'}[];comparisons:Summary[];cache:{available:boolean};scheduling:{available:boolean;kind?:'owner-approved-text-v1'}};
type DetailResponse={role:Role;comparison:Comparison};
type ReconcileResponse=DetailResponse&{reconciliation:{status:'matched'|'inconclusive';message:string}};
export type ExecutionEntry={kind:'configure';promptId:string;versionId:string;authoredText:string}|{kind:'history'}|{kind:'receipt';comparisonId:string;promptId:string};
type Props={workspaceId:string;projectId:string;userId:string;entry:ExecutionEntry;onBack:()=>void;onUnauthorized:()=>void;backLabel?:string;initialExpiredAnswerIds?:string[];initialExpiredInputComparisonIds?:string[];onEvidenceExpired?:(evidence:{comparisonId:string;answerIds:string[];inputIds:string[]})=>void};
type Screen='setup'|'quote'|'unknown'|'history'|'detail';
type Attempt=Readonly<{quoteId:string;requestKey:string}>;
type Operation={generation:number;controller:AbortController;write:boolean};
const roles:readonly Role[]=workspaceRoles;
const statuses:Status[]=['queued','running','completed','failed','uncertain','cancelled','reconciled'];
const charges:Charge[]=['reserved','dispatched','uncertain','settled','cancelled'];
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const when=(v:string|null)=>v?new Date(v).toLocaleString():'Unavailable';
const money=(v:string|null)=>v===null?'Unknown':`USD ${v}`;
const active=(c:Summary)=>c.runs.some(r=>r.status==='queued'||r.status==='running');
const modelName=(m:string)=>m==='openai/gpt-4o-mini'?'GPT-4o-mini':m==='openai/gpt-4o'?'GPT-4o':m;
const outcome=(r:RunSummary)=>({queued:'Waiting to start',running:'Request sent',completed:'Answer received',failed:'No supported answer',uncertain:'Charge unconfirmed',cancelled:'Not sent',reconciled:'Charge confirmed'}[r.status]);
const textStyle={whiteSpace:'pre-wrap' as const,overflowWrap:'anywhere' as const};
function citationUrl(raw:string){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function checkedRole(value:unknown):Role{if(!roles.includes(value as Role))throw new Error('The response could not be read. Reload access.');return value as Role;}
const nullableString=(value:unknown)=>value===null||typeof value==='string';
const date=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const optionalDate=(value:unknown)=>value===null||date(value);
const model=openRouterModelId;
const tokens=(value:unknown)=>value===null||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=2000000;
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const safeText=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max&&!/[\u0000\uD800-\uDFFF]/u.test(value);
const exactKeys=(value:Record<string,unknown>,names:string[])=>Object.keys(value).length===names.length&&names.every(key=>Object.hasOwn(value,key));
const sourceCount=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=100;
const summaryKeys=['id','model','provider','status','chargeStatus','estimateUsd','actualUsd','dispatchedAt','completedAt','diagnostic','resultExpired'];
const reported=(value:unknown)=>value===null||typeof value==='string'&&value.length<=140&&/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
const emptyCard=():Card=>({run:null,loading:false,error:null,sources:[],total:null,nextOffset:null,sourcesLoading:false,sourcesError:null});
function validMessages(value:unknown):value is Message[]{return Array.isArray(value)&&value.length>=1&&value.length<=2&&value.every((m,i)=>object(m)&&exactKeys(m,['role','content'])&&m.role===(i===value.length-1?'user':'system')&&safeText(m.content,i===value.length-1?2000:4000));}
function validInput(value:unknown):value is Input{
  const i=value as Input|null;
  return object(i)&&exactKeys(i,['connectionId','promptId','versionId','systemText','models','maxCompletionTokens','fundedCredits',...(Object.hasOwn(i,'reuseCached')?['reuseCached']:[])])&&(i.reuseCached===undefined||typeof i.reuseCached==='boolean')&&uuid(i.connectionId)&&uuid(i.promptId)&&uuid(i.versionId)&&safeText(i.systemText,4000)&&Array.isArray(i.models)&&i.models.length>=1&&i.models.length<=4&&i.models.every(model)&&new Set(i.models).size===i.models.length&&Number.isInteger(i.maxCompletionTokens)&&i.maxCompletionTokens>=16&&i.maxCompletionTokens<=4096&&i.fundedCredits===true;
}
function validAnswer(value:unknown):value is Answer{
  const a=value as Answer|null;
  return object(a)&&exactKeys(a,['text','resolvedModel','provider','finishReason','promptTokens','completionTokens','receivedAt'])&&safeText(a.text,250000)&&model(a.resolvedModel)&&openRouterProviderName(a.provider)&&['stop','length','content_filter'].includes(a.finishReason)&&tokens(a.promptTokens)&&tokens(a.completionTokens)&&date(a.receivedAt);
}
function validRunSummary(value:unknown):value is RunSummary{
  const r=value as RunSummary|null;
  if(!r||!uuid(r.id)||!model(r.model)||!openRouterProviderName(r.provider)||!statuses.includes(r.status)||!optionalDate(r.dispatchedAt)||!optionalDate(r.completedAt)||!nullableString(r.diagnostic)||typeof r.resultExpired!=='boolean')return false;
  if(Object.hasOwn(r,'reuse')){const p=r.reuse;return object(p)&&exactKeys(p,['sourceRunId','sourceComparisonId','observedAt','originalCharge'])&&uuid(p.sourceRunId)&&p.sourceRunId!==r.id&&uuid(p.sourceComparisonId)&&date(p.observedAt)&&p.observedAt===r.completedAt&&r.status==='completed'&&r.chargeStatus===null&&r.estimateUsd===null&&r.actualUsd===null&&r.dispatchedAt===null&&object(p.originalCharge)&&exactKeys(p.originalCharge,['status','estimateUsd','actualUsd'])&&p.originalCharge.status==='settled'&&modelUsdMicros(p.originalCharge.estimateUsd)!==null&&modelUsdMicros(p.originalCharge.actualUsd)!==null;}
  return r.chargeStatus!==null&&charges.includes(r.chargeStatus)&&modelUsdMicros(r.estimateUsd)!==null&&(r.actualUsd===null||modelUsdMicros(r.actualUsd)!==null);
}
const runKeys=(r:RunSummary)=>[...summaryKeys,...(Object.hasOwn(r,'reuse')?['reuse']:[])];
function validQuoteReservation(q:Quote,input:Input){
 if(input.reuseCached===undefined)return q.cache===undefined&&q.cacheReused===false&&validModelReservation(q.routes,q.estimateUsd,input.models,input.maxCompletionTokens,4);
 const plan=q.cache;if(!object(plan)||!exactKeys(plan,['version','items'])||plan.version!=='seven-day-v1'||!Array.isArray(plan.items)||plan.items.length!==input.models.length||plan.items.some((i,index)=>!object(i)||!exactKeys(i,['model','sourceRunId','sourceComparisonId','observedAt','eligibleUntil'])||i.model!==input.models[index]||(i.sourceRunId===null?(i.sourceComparisonId!==null||i.observedAt!==null||i.eligibleUntil!==null):(!input.reuseCached||!uuid(i.sourceRunId)||!uuid(i.sourceComparisonId)||!date(i.observedAt)||!date(i.eligibleUntil)||Date.parse(i.eligibleUntil)<=Date.parse(q.createdAt)||Date.parse(i.eligibleUntil)>Date.parse(i.observedAt)+7*86400000))))return false;
 if(new Set(plan.items.filter(i=>i.sourceRunId!==null).map(i=>i.sourceRunId)).size!==plan.items.filter(i=>i.sourceRunId!==null).length||plan.items.some(i=>i.observedAt!==null&&Date.parse(i.observedAt)>Date.parse(q.createdAt))||q.cacheReused!==plan.items.some(i=>i.sourceRunId!==null)||!Array.isArray(q.routes)||q.routes.length!==input.models.length)return false;
 for(const [index,route]of q.routes.entries())if(!validModelReservation([route],route.estimateUsd,[input.models[index]],input.maxCompletionTokens,4))return false;
 const paid=q.routes.filter((_r,index)=>plan.items[index].sourceRunId===null);
 return paid.length?validModelReservation(paid,q.estimateUsd,paid.map(r=>r.model),input.maxCompletionTokens,4):q.estimateUsd==='0.000000';
}
function validSummary(value:unknown):value is Summary{
  const c=value as Summary|null;
  return !!c&&uuid(c.id)&&uuid(c.quoteId)&&date(c.createdAt)&&typeof c.cancelRequested==='boolean'&&typeof c.canCancel==='boolean'&&!!c.prompt&&uuid(c.prompt.id)&&uuid(c.prompt.versionId)&&safeText(c.prompt.textPreview,320)&&Array.isArray(c.runs)&&c.runs.length>=1&&c.runs.length<=4&&c.runs.every(r=>validRunSummary(r)&&exactKeys(r,runKeys(r)))&&new Set(c.runs.map(r=>r.id)).size===c.runs.length&&new Set(c.runs.map(r=>r.model)).size===c.runs.length;
}
const sameComparisonIdentity=(a:Summary,b:Summary)=>a.id===b.id&&a.quoteId===b.quoteId&&a.createdAt===b.createdAt&&a.prompt.id===b.prompt.id&&a.prompt.versionId===b.prompt.versionId&&a.prompt.textPreview===b.prompt.textPreview&&JSON.stringify(a.runs.map(r=>[r.id,r.model,r.provider,r.reuse??null]))===JSON.stringify(b.runs.map(r=>[r.id,r.model,r.provider,r.reuse??null]));
function checkedComparison(value:unknown):DetailResponse{
  const data=value as DetailResponse;checkedRole(data?.role);const c=data?.comparison;
  if(!validSummary(c)||c.answerMode!=='individual'||typeof c.inputExpired!=='boolean'||(c.inputExpired?(c.input!==null||c.messages!==null):(!validInput(c.input)||!validMessages(c.messages))))throw new Error('The response was incomplete. Reload the saved run.');
  if(!exactKeys(c,['id','quoteId','createdAt','cancelRequested','prompt','canCancel','runs','input','messages','inputExpired','cache','answerMode'])||!object(c.cache)||!exactKeys(c.cache,['reused','available'])||typeof c.cache.available!=='boolean'||c.cache.reused!==c.runs.some(r=>!!r.reuse)||c.cache.reused&&!c.cache.available)throw new Error('The saved summary was not bounded metadata.');
  if(c.input&&(c.input.promptId!==c.prompt.id||c.input.versionId!==c.prompt.versionId||JSON.stringify(c.input.models)!==JSON.stringify(c.runs.map(r=>r.model))||c.messages?.[0].role==='system'&&c.messages[0].content!==c.input.systemText||c.messages?.some(m=>m.role==='system')!==!!c.input.systemText))throw new Error('The saved run identity could not be verified.');
  return data;
}
function Messages({messages}:{messages:Message[]}){return <>{!messages.some(m=>m.role==='system')&&<p>No system message</p>}{messages.map((m,i)=><div key={i}><strong>{m.role==='system'?'System':'User'}</strong><p style={textStyle}>{m.content}</p></div>)}</>;}

export function PromptExecutionsPanel(props:Props){
  const key=props.entry.kind==='configure'?`${props.entry.promptId}:${props.entry.versionId}`:props.entry.kind==='receipt'?`${props.entry.promptId}:${props.entry.comparisonId}`:'history';
  return <Panel key={`${props.userId}:${props.workspaceId}:${props.projectId}:${props.entry.kind}:${key}`} {...props}/>;
}
function Panel({workspaceId,projectId,userId,entry,onBack,onUnauthorized,backLabel='Back to library',onEvidenceExpired,initialExpiredAnswerIds=[],initialExpiredInputComparisonIds=[]}:Props){
  const B='/api/projects/'+encodeURIComponent(projectId)+'/prompt-executions',uid=useId();
  const [confirm,confirmDialog]=useConfirmDialog({ danger: true });
  const [screen,setScreen]=useState<Screen>(entry.kind==='configure'?'setup':entry.kind==='receipt'?'detail':'history');
  const [metadata,setMetadata]=useState<Metadata|null>(null),[role,setRole]=useState<Role|null>(null);
  const [comparison,setComparison]=useState<Comparison|null>(null),[quote,setQuote]=useState<Quote|null>(null);
  const [cards,setCards]=useState<Record<string,Card>>({});
  const [attempt,setAttempt]=useState<Attempt|null>(null),[connectionId,setConnectionId]=useState('');
  const [models,setModels]=useState<Model[]>([]),[systemText,setSystemText]=useState(''),[maxTokens,setMaxTokens]=useState('1024');
  const [funded,setFunded]=useState(false),[busy,setBusy]=useState(false),[writing,setWriting]=useState(false),[accessLost,setAccessLost]=useState(false);
  const [reuseCached,setReuseCached]=useState(true);
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [polling,setPolling]=useState(false),[clock,setClock]=useState(Date.now());
  const mounted=useRef(false),generation=useRef(0),operation=useRef<Operation|null>(null);
  const roleAuthority=useRef<{value:Role|null}>({value:null}),recurringAuthority=roleAuthority.current;
  const selection=useRef<string|null>(null),attemptRef=useRef<Attempt|null>(null),pollingUntil=useRef(0);
  const restoreReceipt=useRef(entry.kind==='receipt');
  const expiredInputs=useRef(new Set(initialExpiredInputComparisonIds.filter(uuid))),expiredResults=useRef(new Set(initialExpiredAnswerIds.filter(uuid)));
  const initialized=useRef(false),notified=useRef(false),unauthorizedRef=useRef(onUnauthorized),backRef=useRef(onBack),expiryRef=useRef(onEvidenceExpired);
  unauthorizedRef.current=onUnauthorized;backRef.current=onBack;expiryRef.current=onEvidenceExpired;
  const heading=useRef<HTMLHeadingElement|null>(null),focusNext=useRef(true);
  const connectionControl=useRef<HTMLSelectElement|null>(null),modelControl=useRef<HTMLDivElement|null>(null);
  const systemControl=useRef<HTMLTextAreaElement|null>(null),tokensControl=useRef<HTMLInputElement|null>(null),fundedControl=useRef<HTMLInputElement|null>(null);
  const current=(op:Operation)=>mounted.current&&operation.current===op&&generation.current===op.generation;
  function invalidate(){generation.current++;operation.current?.controller.abort();operation.current=null;setBusy(false);setWriting(false);setPolling(false);}
  function begin(write=false,replaceRead=true):Operation|null{
    if(!mounted.current||operation.current&&(operation.current.write||!replaceRead))return null;
    operation.current?.controller.abort();const op={generation:++generation.current,controller:new AbortController(),write};
    operation.current=op;setBusy(true);setWriting(write);return op;
  }
  function finish(op:Operation){if(current(op)){operation.current=null;setBusy(false);setWriting(false);setCards(old=>Object.fromEntries(Object.entries(old).map(([id,card])=>[id,{...card,loading:false,sourcesLoading:false,...(card.loading?{error:'This answer read was interrupted. Retry loading it.'}:{}),...(card.sourcesLoading?{sourcesError:'This source read was interrupted. Retry loading it.'}:{})}])));}}
  function setPending(value:Attempt|null){attemptRef.current=value;setAttempt(value);}
  function move(view:Screen){focusNext.current=true;setScreen(view);}
  function clearDraft(){setReuseCached(true);setQuote(null);setPending(null);setConnectionId('');setModels([]);setSystemText('');setMaxTokens('1024');setFunded(false);}
  function applyRole(value:Role){if(roleAuthority.current.value!==value)roleAuthority.current={value};setRole(value);setAccessLost(false);if(value==='viewer'){if(attemptRef.current)move('unknown');else{clearDraft();if(['setup','quote','unknown'].includes(screen))move('history');}}}
  function purge(message:string){
    invalidate();clearDraft();setMetadata(null);setComparison(null);setCards({});roleAuthority.current={value:null};setRole(null);selection.current=null;setPolling(false);
    setNotice(null);setError(message);setAccessLost(true);initialized.current=false;restoreReceipt.current=entry.kind==='receipt';move(entry.kind==='configure'?'setup':entry.kind==='receipt'?'detail':'history');
  }
  function failure(e:unknown,op:Operation):boolean{
    if(!current(op)||(e instanceof Error&&e.name==='AbortError'))return true;
    if(e instanceof ModelResponseError&&e.readOnly){purge('The complete saved response could not be verified. Reload access to continue.');return true;}
    if(e instanceof ApiError&&[401,403,404].includes(e.status)){
      purge(e.status===401?'Your session expired. Sign in again.':'Access unavailable. Reload access to continue.');
      if(e.status===401&&!notified.current){notified.current=true;unauthorizedRef.current();}return true;
    }return false;
  }
  function rememberExpiredResults(c:Summary){const answerIds=c.runs.filter(run=>run.resultExpired).map(run=>run.id);for(const id of answerIds)expiredResults.current.add(id);if(answerIds.length)expiryRef.current?.({comparisonId:c.id,answerIds,inputIds:[]});}
  async function readMetadata(op:Operation){
    const data=await api<Metadata>(B,{signal:op.controller.signal});if(!current(op))return null;
    try{checkedRole(data?.role);if(!Array.isArray(data.models)||data.models.length>2000||!data.models.every(model)||new Set(data.models).size!==data.models.length||!Array.isArray(data.connections)||data.connections.some(c=>!c||!uuid(c.id)||typeof c.name!=='string'||!['untested','ok','error'].includes(c.checkStatus))||!Array.isArray(data.comparisons)||!data.comparisons.every(validSummary)||typeof data.vaultConfigured!=='boolean'||typeof data.spendingPaused!=='boolean'||!object(data.cache)||!exactKeys(data.cache,['available'])||typeof data.cache.available!=='boolean')throw new Error();
      // Older metadata has no discovery snapshot: history remains readable, but
      // its finite model hints are not promoted into a current catalog.
      data.catalog=data.catalog===undefined?null:readModelCatalog(data.catalog);if(data.catalog&&JSON.stringify(data.models)!==JSON.stringify(data.catalog.models.filter(m=>m.admission==='candidate').map(m=>m.id)))throw new Error();}
    catch{purge('Readiness could not be verified. Reload access to continue.');return null;}
    data.comparisons.forEach(rememberExpiredResults);setMetadata(data);applyRole(data.role);
    if(!initialized.current&&data.role!=='viewer'){
      initialized.current=true;setConnectionId(data.connections.length===1&&data.connections[0].checkStatus==='ok'?data.connections[0].id:'');
      setModels([]);
    }return data;
  }
  async function refreshMetadata(){
    const op=begin();if(!op)return;setError(null);
    try{
      if(entry.kind==='receipt'&&(!uuid(entry.comparisonId)||!uuid(entry.promptId))){purge('The saved run reference is invalid.');return;}
      const data=await readMetadata(op);if(!data||!current(op))return;
      if(entry.kind==='receipt'&&restoreReceipt.current){selection.current=entry.comparisonId;move('detail');if(await readComparison(op,entry.comparisonId))restoreReceipt.current=false;}
    }catch(e){if(current(op)&&!failure(e,op))setError(errMsg(e));}finally{finish(op);}
  }
  async function refreshModels(){
    if(role==='viewer'||attemptRef.current)return;const op=begin(true);if(!op)return;setError(null);
    try{const data=await api<{role:Role;catalog:unknown}>('/api/projects/'+encodeURIComponent(projectId)+'/openrouter-models',{method:'POST',body:{},signal:op.controller.signal});if(!current(op))return;checkedRole(data?.role);const catalog=readModelCatalog(data.catalog);applyRole(data.role);if(data.role==='viewer')return;
      setMetadata(old=>old?{...old,role:data.role,catalog,models:catalog.models.filter(m=>m.admission==='candidate').map(m=>m.id)}:old);
      if(models.some(id=>!catalog.models.some(m=>m.id===id&&!modelUnavailableReason(m))))setQuote(null);setNotice('Model metadata refreshed. Your selections were kept; no quote or paid request was started.');
    }catch(e){if(current(op)&&!failure(e,op)){if(e instanceof ApiError&&(e.status===0||e.status>=500)){setMetadata(old=>old?.catalog?{...old,catalog:{...old.catalog,status:old.catalog.status==='unavailable'?'unavailable':'stale'}}:old);setError(errMsg(e));}else if(e instanceof ApiError){setError(errMsg(e));}else purge('The model catalog response could not be verified. Reload access.');}}finally{finish(op);}
  }
  useEffect(()=>{mounted.current=true;void refreshMetadata();return ()=>{mounted.current=false;generation.current++;operation.current?.controller.abort();operation.current=null;};},[B]);
  useEffect(()=>{if(focusNext.current){heading.current?.focus();focusNext.current=false;}},[screen,quote?.id,comparison?.id,accessLost]);
  useEffect(()=>{if(!quote)return;const timer=setInterval(()=>setClock(Date.now()),1000);return ()=>clearInterval(timer);},[quote?.id]);
  async function mayLeave(){return !attemptRef.current||(await confirm({title:'Leave this run?',description:'This start may already have been accepted. Leaving discards local retry controls and does not stop server work.',confirmLabel:'Leave run'})&&!operation.current?.write);}
  async function back(){if(operation.current?.write||!await mayLeave())return;invalidate();setPending(null);backRef.current();}
  async function history(){if(operation.current?.write||!await mayLeave())return;invalidate();restoreReceipt.current=false;setPending(null);setQuote(null);setComparison(null);setCards({});selection.current=null;setError(null);setNotice(null);move('history');void refreshMetadata();}
  async function setup(){if(operation.current?.write||entry.kind!=='configure'||!await mayLeave())return;invalidate();setPending(null);setQuote(null);setError(null);setNotice(null);move('setup');}
  function edit(change:()=>void){if(operation.current?.write||attemptRef.current)return;if(operation.current)invalidate();setQuote(null);setError(null);setNotice(null);change();}
  function showComparison(data:DetailResponse,explicit=true){
    if(data.comparison.inputExpired){expiredInputs.current.add(data.comparison.id);expiryRef.current?.({comparisonId:data.comparison.id,answerIds:[],inputIds:data.comparison.runs.map(run=>run.id)});}
    rememberExpiredResults(data.comparison);
    data={...data,comparison:{...data.comparison,...(expiredInputs.current.has(data.comparison.id)?{inputExpired:true,input:null,messages:null}:{}),runs:data.comparison.runs.map(run=>expiredResults.current.has(run.id)?{...run,resultExpired:true}:run)}};
    applyRole(data.role);setComparison(data.comparison);selection.current=data.comparison.id;
    setCards(old=>Object.fromEntries(data.comparison.runs.map(run=>[run.id,run.resultExpired?emptyCard():{...(old[run.id]??emptyCard()),run:old[run.id]?.run?{...old[run.id].run!,...run}:null,loading:false,sourcesLoading:false}])));
    setMetadata(old=>old?{...old,comparisons:[data.comparison,...old.comparisons.filter(c=>c.id!==data.comparison.id)].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.id.localeCompare(a.id)).slice(0,20)}:old);
    if(explicit){pollingUntil.current=Date.now()+300_000;setPolling(active(data.comparison)&&!document.hidden);move('detail');}else if(!active(data.comparison))setPolling(false);
  }
  async function readComparison(op:Operation,id:string,automatic=false,expected?:Summary){
    const raw=await api<unknown>(B+'/comparisons/'+encodeURIComponent(id)+'/summary',{signal:op.controller.signal});if(!current(op)||selection.current!==id)return false;
    let data:DetailResponse;try{data=checkedComparison(raw);const prior=expected??(comparison?.id===id?comparison:null);if(data.comparison.id!==id||entry.kind==='receipt'&&id===entry.comparisonId&&data.comparison.prompt.id!==entry.promptId||prior&&!sameComparisonIdentity(data.comparison,prior))throw new Error();}
    catch{purge('The saved run response could not be verified. Reload access to continue.');return false;}
    showComparison(data,!automatic);
    for(const run of data.comparison.runs){if(!current(op)||selection.current!==id)break;if(!expiredResults.current.has(run.id))await readAnswer(op,id,run,data.role);}
    return current(op);
  }
  function expireAnswer(id:string,runId:string){
    const first=!expiredResults.current.has(runId);expiredResults.current.add(runId);
    setComparison(old=>old?.id===id?{...old,runs:old.runs.map(run=>run.id===runId?{...run,resultExpired:true}:run)}:old);
    setCards(old=>({...old,[runId]:{...emptyCard(),run:old[runId]?.run?{...old[runId].run!,resultExpired:true,result:null}:null}}));
    if(first)expiryRef.current?.({comparisonId:id,answerIds:[runId],inputIds:[]});
  }
  function readFailed(error:unknown,op:Operation){
    if(!current(op)||op.controller.signal.aborted)return true;
    return error instanceof ApiError&&[401,403,404].includes(error.status)?failure(error,op):false;
  }
  async function readSources(op:Operation,id:string,run:RunSummary,expectedRole:Role,total:number,offset:number){
    if(expiredResults.current.has(run.id))return;
    setCards(old=>({...old,[run.id]:{...(old[run.id]??emptyCard()),sourcesLoading:true,sourcesError:null}}));
    try{
      const data=await api<SourcePage>(B+'/runs/'+encodeURIComponent(run.id)+'/citations?offset='+offset,{signal:op.controller.signal});if(!current(op)||selection.current!==id)return;
      if(!object(data)||data.comparisonId!==id||data.runId!==run.id||data.role!==expectedRole){purge('The source-page identity or current access changed. Reload access to continue.');return;}
      if(!exactKeys(data,['role','comparisonId','runId','resultExpired','total','offset','nextOffset','items'])||typeof data.resultExpired!=='boolean'||data.offset!==offset||!Array.isArray(data.items))throw new Error('The reported source page could not be verified.');
      if(data.resultExpired){if(data.total!==null||data.nextOffset!==null||data.items.length!==0)throw new Error('Expired source evidence was inconsistent.');expireAnswer(id,run.id);return;}
      if(expiredResults.current.has(run.id))return;
      if(!sourceCount(data.total)||data.total!==total||data.nextOffset!==(offset+20<total?offset+20:null)||data.items.length!==Math.max(0,Math.min(20,total-offset))||data.items.some(c=>!object(c)||!exactKeys(c,['url','title'])||typeof c.url!=='string'||citationUrl(c.url)!==c.url||!(c.title===null||safeText(c.title,600)&&Array.from(c.title).length<=300)))throw new Error('The complete reported source page could not be verified.');
      setCards(old=>({...old,[run.id]:{...old[run.id],sources:offset===0?data.items:[...old[run.id].sources,...data.items],total:data.total,nextOffset:data.nextOffset,sourcesLoading:false,sourcesError:null}}));
    }catch(e){if(!readFailed(e,op))setCards(old=>({...old,[run.id]:{...(old[run.id]??emptyCard()),sourcesLoading:false,sourcesError:errMsg(e)}}));}
  }
  async function readAnswer(op:Operation,id:string,run:RunSummary,expectedRole:Role){
    setCards(old=>({...old,[run.id]:{...(old[run.id]??emptyCard()),loading:true,error:null}}));
    try{
      const data=await api<AnswerResponse>(B+'/runs/'+encodeURIComponent(run.id),{signal:op.controller.signal});if(!current(op)||selection.current!==id)return;
      if(!object(data)||data.role!==expectedRole||data.comparisonId!==id||!object(data.run)||data.run.id!==run.id||data.run.model!==run.model||data.run.provider!==run.provider||JSON.stringify(data.run.reuse??null)!==JSON.stringify(run.reuse??null)){purge('The answer identity or current access changed. Reload access to continue.');return;}
      const next=data.run;
      if(!exactKeys(data,['role','comparisonId','run','citations'])||!validRunSummary(next)||!exactKeys(next,[...runKeys(next),'result','reportedCost','isByok','upstreamReportedCost','generationId'])||!(next.result===null||validAnswer(next.result)&&next.result.resolvedModel===next.model&&next.result.provider===next.provider)||!reported(next.reportedCost)||!reported(next.upstreamReportedCost)||!(next.isByok===null||typeof next.isByok==='boolean')||!(next.generationId===null||typeof next.generationId==='string'&&/^gen-[0-9A-Za-z-]{1,124}$/.test(next.generationId))||!object(data.citations)||!exactKeys(data.citations,['count','pageSize'])||data.citations.pageSize!==20||(next.result===null?data.citations.count!==null:!sourceCount(data.citations.count))||next.resultExpired&&next.result!==null)throw new Error('The complete saved answer could not be verified.');
      if(next.resultExpired){expireAnswer(id,run.id);return;}if(expiredResults.current.has(run.id))return;
      setCards(old=>({...old,[run.id]:{...emptyCard(),run:next,total:data.citations.count,nextOffset:data.citations.count?0:null}}));
      if(data.citations.count!==null&&data.citations.count>0)await readSources(op,id,next,expectedRole,data.citations.count,0);
    }catch(e){if(!readFailed(e,op))setCards(old=>({...old,[run.id]:{...(old[run.id]??emptyCard()),loading:false,error:errMsg(e)}}));}
  }
  async function retryCard(run:RunSummary,sources=false){
    if(!comparison||role===null||busy)return;const id=comparison.id,op=begin();if(!op)return;
    try{const card=cards[run.id];if(sources&&card?.total!==null&&card?.total!==undefined&&card.nextOffset!==null)await readSources(op,id,run,role,card.total,card.nextOffset);else if(!sources)await readAnswer(op,id,run,role);}finally{finish(op);}
  }
  async function openComparison(id:string,automatic=false){
    if(automatic&&operation.current)return;const op=begin(false,!automatic);if(!op)return;
    if(!automatic){selection.current=id;setError(null);setNotice(null);if(comparison?.id!==id){setComparison(null);setCards({});}move('detail');}
    try{
      await readComparison(op,id,automatic);
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
      [models.length<1||models.length>4||new Set(models).size!==models.length||models.some(id=>!metadata?.catalog?.models.some(m=>m.id===id&&!modelUnavailableReason(m))),'Choose one to four supported models.',modelControl.current],
      [!/^\d+$/.test(maxTokens)||!Number.isInteger(Number(maxTokens))||Number(maxTokens)<16||Number(maxTokens)>4096,'Choose an integer output allowance from 16 to 4096.',tokensControl.current],
      [systemText.length>4000||/[\u0000\u000b\u000c\uD800-\uDFFF]/u.test(systemText),'Use a valid system message of at most 4000 characters without unsupported control characters.',systemControl.current],
      [!funded,'Confirm that this connection uses OpenRouter funded credits.',fundedControl.current],
    ];
    const problem=checks.find(c=>c[0]);if(problem){setError(problem[1]);const details=problem[2]?.closest('details');if(details)details.open=true;problem[2]?.focus();return;}
    const op=begin(true);if(!op)return;setError(null);setNotice(null);setQuote(null);setPolling(false);
    const body:Input={connectionId,promptId:entry.promptId,versionId:entry.versionId,systemText,models:[...models],maxCompletionTokens:Number(maxTokens),fundedCredits:true,...(metadata?.cache?.available?{reuseCached}:{})};
    try{
      const data=await api<{role:Role;quote:Quote}>(B+'/quote',{method:'POST',body,signal:op.controller.signal});if(!current(op))return;
      checkedRole(data?.role);
      const q=data.quote;
      if(!uuid(q?.id)||!date(q.expiresAt)||!date(q.createdAt)||!validMessages(q.messages)||!validInput(q.input)||Object.keys(q.input).length!==Object.keys(body).length||Object.entries(body).some(([k,v])=>JSON.stringify(q.input[k as keyof Input])!==JSON.stringify(v))||typeof q.connectionName!=='string'||typeof q.explanation!=='string'||!validQuoteReservation(q,body)||JSON.stringify(q.messages)!==JSON.stringify([...(body.systemText?[{role:'system',content:body.systemText}]:[]),{role:'user',content:entry.authoredText}]))throw new Error('The quote did not match the complete submitted request and reservation. Get a new quote.');
      applyRole(data.role);if(data.role==='viewer')return;setClock(Date.now());setQuote(data.quote);move('quote');
    }catch(e){if(current(op)&&!failure(e,op))setError(errMsg(e));}finally{finish(op);}
  }
  async function start(){
    if(!quote||role==='viewer')return;const recovering=attemptRef.current!==null;
    if(!recovering&&(Date.parse(quote.expiresAt)<=Date.now()||!metadata?.vaultConfigured||(metadata.spendingPaused&&quote.routes.some((_r,i)=>!quote.cache?.items[i].sourceRunId)))){setError('This quote cannot start now. Review readiness or get a new quote.');return;}
    const op=begin(true);if(!op)return;setError(null);setNotice(null);setPolling(false);let posted=false,acknowledged=false;
    try{
      // Refresh local authority before acting; final server gates remain authoritative.
      const latest=await readMetadata(op);if(!latest||!current(op)||latest.role==='viewer')return;
      if(!recovering&&(!latest.vaultConfigured||(latest.spendingPaused&&quote.routes.some((_r,i)=>!quote.cache?.items[i].sourceRunId))||Date.parse(quote.expiresAt)<=Date.now()))throw new Error('Spending settings or quote validity changed. Review readiness before starting.');
      const body=attemptRef.current??Object.freeze({quoteId:quote.id,requestKey:crypto.randomUUID()});setPending(body);posted=true;
      const raw=await api<unknown>(B+'/comparisons',{method:'POST',body,signal:op.controller.signal});if(!current(op))return;
      const data=checkedComparison(raw);if(data.comparison.quoteId!==body.quoteId||data.comparison.prompt.id!==quote.input.promptId||data.comparison.prompt.versionId!==quote.input.versionId||JSON.stringify(data.comparison.runs.map(r=>[r.model,r.provider]))!==JSON.stringify(quote.routes.map(r=>[r.model,r.providerName]))||data.comparison.runs.some((r,i)=>(r.reuse?.sourceRunId??null)!==(quote.cache?.items[i].sourceRunId??null)||(r.reuse?.sourceComparisonId??null)!==(quote.cache?.items[i].sourceComparisonId??null)||(r.reuse?.observedAt??null)!==(quote.cache?.items[i].observedAt??null)))throw new Error('The start response did not match this quote.');
      acknowledged=true;setPending(null);setQuote(null);showComparison(data);op.write=false;setWriting(false);await readComparison(op,data.comparison.id,false,data.comparison);if(current(op))setNotice('The saved prompt run is shown below.');
    }catch(e){
      if(!current(op)||failure(e,op))return;const uncertain=!(e instanceof ApiError)||e.status===0||e.status>=500;
      if(acknowledged){setError('The run was saved, but its status could not be read. Retry loading the saved run; do not start another request.');}
      else if((posted||recovering)&&uncertain){move('unknown');setError('This start may already have been accepted. Retry the same request, or inspect Recent runs before starting anything new.');}
      else{if(posted){setPending(null);setQuote(null);move(entry.kind==='configure'?'setup':'history');}setError(errMsg(e));}
    }finally{finish(op);}
  }
  async function cancel(){
    if(!comparison||!comparison.canCancel||role==='viewer')return;const id=comparison.id,op=begin(true);if(!op)return;setError(null);setNotice(null);setPolling(false);
    try{
      const raw=await api<unknown>(B+'/comparisons/'+encodeURIComponent(id)+'/cancel',{method:'POST',body:{},signal:op.controller.signal});if(!current(op)||selection.current!==id)return;
      const data=checkedComparison(raw);if(!sameComparisonIdentity(data.comparison,comparison))throw new Error('Reload this run to check its state.');showComparison(data);op.write=false;setWriting(false);await readComparison(op,id,false,data.comparison);if(current(op))setNotice('Remaining requests updated. Requests already sent may still be charged.');
    }catch(e){if(current(op)&&!failure(e,op))setError(errMsg(e));}finally{finish(op);}
  }
  async function reconcile(run:Run){
    if(!comparison||role!=='owner'||run.status!=='uncertain'||!run.generationId)return;const id=comparison.id,op=begin(true);if(!op)return;setError(null);setNotice(null);setPolling(false);
    try{
      const raw=await api<ReconcileResponse>(B+'/runs/'+encodeURIComponent(run.id)+'/reconcile',{method:'POST',body:{},signal:op.controller.signal});if(!current(op)||selection.current!==id)return;
      const data=checkedComparison(raw);if(!sameComparisonIdentity(data.comparison,comparison)||!raw.reconciliation||!['matched','inconclusive'].includes(raw.reconciliation.status)||typeof raw.reconciliation.message!=='string')throw new Error('Reload this run to check its state.');showComparison(data);op.write=false;setWriting(false);await readComparison(op,id,false,data.comparison);if(current(op))setNotice(raw.reconciliation.message);
    }catch(e){if(current(op)&&!failure(e,op))setError(errMsg(e));}finally{finish(op);}
  }
  const writer=role==='owner'||role==='admin'||role==='editor';
  const paidCount=quote?quote.routes.filter((_r,i)=>!quote.cache?.items[i].sourceRunId).length:0;
  const blocked=!metadata?.vaultConfigured||(metadata.spendingPaused&&paidCount>0),expired=quote?Date.parse(quote.expiresAt)<=clock||quote.cache?.items.some(i=>i.eligibleUntil!==null&&Date.parse(i.eligibleUntil)<=clock)===true:false;
  const providerHelp=role==='owner'?<Link to='/' search={{workspace:workspaceId,project:projectId,view:'providers'}} className='btn ghost' aria-disabled={writing||undefined} onClick={event=>{if(operation.current?.write)event.preventDefault();}}>Providers and spending</Link>:<p className="hint">Ask a workspace owner to configure this connection or the paid-work pause.</p>;
  const title=accessLost?'Access unavailable':screen==='history'?'Recent runs':screen==='detail'?'Prompt run':screen==='setup'?'Review a prompt run':screen==='unknown'?'Run start unconfirmed':'Review before spending';
  return <section className="research-panel stack" aria-label="Prompt execution" style={{minWidth:0}}>
    <div className="row between"><button type="button" className="btn ghost" onClick={back} disabled={writing}>{backLabel}</button>{screen!=='history'&&!accessLost&&<button type="button" className="btn ghost" onClick={history} disabled={writing}>Recent runs</button>}</div>
    <h2 tabIndex={-1} ref={heading}>{title}</h2>
    {error&&<div className="alert" role="alert" id={uid+'-error'}>{error}</div>}{notice&&<p role="status">{notice}</p>}
    {busy&&<p role="status" className="hint">{operation.current?.write?'Waiting for the requested action…':'Loading saved state…'}</p>}
    {accessLost?<button type="button" className="btn" onClick={()=>void refreshMetadata()} disabled={writing}>Reload access</button>:!metadata?<div><p>Loading readiness and recent runs.</p>{error&&<button type="button" className="btn" onClick={()=>void refreshMetadata()} disabled={writing}>Retry loading</button>}</div>:<>
      {['setup','quote','unknown'].includes(screen)&&<>
        {(!metadata.vaultConfigured||metadata.connections.length===0||!metadata.connections.some(c=>c.checkStatus==='ok'))&&<div className="banner"><p>{!metadata.vaultConfigured?'Credential storage is unavailable. Ask your administrator to restore it before starting a run.':metadata.connections.length===0?'No OpenRouter connection is configured.':'No OpenRouter connection has a successful account check.'}</p>{providerHelp}</div>}
        {metadata.spendingPaused&&<div className="banner"><p>Spending is paused. You may reuse eligible saved answers. Any new provider request needs an owner to enable spending.</p>{providerHelp}</div>}
      </>}
      {screen==='setup'&&entry.kind==='configure'&&writer&&<form className="card stack" onSubmit={getQuote} noValidate>
        <h3>Authored prompt version</h3><p style={textStyle}>{entry.authoredText}</p>
        <fieldset disabled={writing||attempt!==null} style={{border:0,padding:0,minWidth:0}}><legend>Run setup</legend>
          <div className="field"><label htmlFor={uid+'-connection'}>OpenRouter connection</label><select ref={connectionControl} id={uid+'-connection'} aria-describedby={error?uid+'-error':undefined} value={connectionId} onChange={e=>edit(()=>setConnectionId(e.target.value))} style={{width:'100%'}}><option value="">Choose a connection</option>{metadata.connections.map(c=><option key={c.id} value={c.id} disabled={c.checkStatus!=='ok'}>{c.name} — {c.checkStatus==='ok'?'Check passed':c.checkStatus==='error'?'Check failed':'Not checked'}</option>)}</select><p className="hint">A successful account check does not guarantee funding, route availability or execution permission.</p></div>
          <div ref={modelControl} tabIndex={-1} aria-describedby={error?uid+'-error':undefined}><OpenRouterModelPicker catalog={metadata.catalog} selected={models} maximum={4} disabled={busy||!!attempt} refreshing={busy} canRefresh={writer} onChange={value=>edit(()=>setModels(value))} onRefresh={()=>void refreshModels()}/></div>
          <div className="field"><label htmlFor={uid+'-tokens'}>Maximum output tokens</label><input ref={tokensControl} id={uid+'-tokens'} type="number" min={16} max={4096} step={1} value={maxTokens} onChange={e=>edit(()=>setMaxTokens(e.target.value))} aria-describedby={error?uid+'-error':undefined}/><p className="hint">Allowed: 16–4096.</p></div>
          {metadata.cache?.available&&<div className="field"><label htmlFor={uid+'-answer-source'}>Answer source</label><select id={uid+'-answer-source'} value={reuseCached?'reuse':'fresh'} onChange={e=>edit(()=>setReuseCached(e.target.value==='reuse'))}><option value="reuse">Reuse eligible saved answers</option><option value="fresh">Request fresh answers</option></select><p className="hint">Saved answers can be up to seven days old. Fresh answers require new paid requests; the quote shows each choice.</p></div>}
          <details className="field"><summary>Optional system message</summary><label htmlFor={uid+'-system'}>System message</label><textarea ref={systemControl} id={uid+'-system'} maxLength={4000} value={systemText} onChange={e=>edit(()=>setSystemText(e.target.value))} style={{width:'100%',minHeight:96}} aria-describedby={error?uid+'-error':undefined}/><p className="hint">Up to 4000 characters. Project context is not added automatically.</p></details>
          <label className="row" style={{minHeight:44}}><input ref={fundedControl} type="checkbox" checked={funded} onChange={e=>edit(()=>setFunded(e.target.checked))} aria-describedby={error?uid+'-error':undefined}/>This connection uses OpenRouter funded credits.</label><p className="hint">Upstream BYOK invoices are outside this app’s supported billing route.</p>
          <button type="submit" className="btn primary" disabled={!metadata.vaultConfigured}>Get quote</button><p className="hint">Checks the current price without requesting an answer or authorizing a charge.</p>
        </fieldset>
      </form>}
      {(screen==='quote'||screen==='unknown')&&quote&&writer&&<div className="card stack">
        <RunCostSummary title="New spending reservation" scope={<>Connection: {quote.connectionName} · Authored version <bdi dir="ltr">{quote.input.versionId}</bdi></>} units={<>{paidCount} new paid {paidCount===1?'request':'requests'}; {quote.routes.length-paidCount} saved answers. Maximum output tokens: {quote.input.maxCompletionTokens} per request.</>} estimatedPrice={money(quote.estimateUsd)} settledPrice="No settled charge reported" quoteExpiryLabel={when(quote.expiresAt)} receipt={attempt?<bdi dir="ltr">{attempt.requestKey}</bdi>:<bdi dir="ltr">{quote.id}</bdi>} state={screen==='unknown'?'uncertain':attempt?'pending':blocked?'blocked':expired?'expired':'quoted'} reason={screen==='unknown'?'This start may already have been accepted. Recover the same request.':attempt?'Start request is awaiting a receipt.':blocked?'Provider readiness or the manual spending pause blocks this start.':expired?'This unused quote expired.':'Review the exact request before authorizing Start.'} warnings={<>Prices observed {when(quote.createdAt)}. OpenRouter funded credits · No fallback.</>}/>
        <div className="stack">{quote.routes.map((route,index)=>{const hit=quote.cache?.items[index];return <div key={route.model}><strong><bdi dir="ltr">{modelName(route.model)}</bdi> · {route.providerName}</strong>{hit?.sourceRunId?<p>Reuse answer observed {when(hit.observedAt)}. Eligible until {when(hit.eligibleUntil)}. No new provider request or charge.</p>:<p>{money(route.estimateUsd)} reservation</p>}<details><summary>Price and capacity details</summary><p>Provider route: <bdi dir="ltr">{route.tag}</bdi> · Context capacity {route.contextLength??'Not recorded in this older quote'}</p><p>Prompt capacity {route.promptCapacity}; output capacity {route.completionCapacity}. Prompt-token price USD {route.promptPrice}; completion-token price USD {route.completionPrice}; request price USD {route.requestPrice}.</p></details></div>;})}</div>
        <h3>Exact request</h3><Messages messages={quote.messages}/><p>Maximum output tokens: {quote.input.maxCompletionTokens}</p>
        <p className="hint">{quote.explanation}</p><p className="hint">This conservative reservation uses full prompt-capacity pricing. Actual credit charges may be lower; it is not an invoice guarantee. Taxes, credit-purchase fees and upstream BYOK invoices are excluded.</p>
        {screen==='unknown'?<div className="banner"><p>This start may already have been accepted. Retrying resends the identical quote and request key; it does not create a new paid attempt. This recovery remains available after quote expiry.</p><button type="button" className="btn primary" onClick={()=>void start()} disabled={writing||!attempt}>Retry same start request</button></div>:<div className="row"><button type="button" className="btn primary" onClick={()=>void start()} disabled={writing||blocked||expired}>{paidCount===0?'Use saved answers':`Start ${paidCount} paid ${paidCount===1?'request':'requests'}`}</button><button type="button" className="btn ghost" onClick={setup} disabled={writing}>Back to setup</button>{expired&&<button type="button" className="btn" onClick={setup} disabled={writing}>Get new quote</button>}</div>}
        {expired&&!attempt&&screen!=='unknown'&&<p className="hint">This unused quote expired. Return to setup and explicitly get a new quote.</p>}
      </div>}
      {screen==='unknown'&&attempt&&!writer&&<div className="banner"><p>The pending Start request is retained. Your current role cannot start or retry paid work; inspect saved runs or refresh access before recovery.</p><button type="button" className="btn" disabled={writing} onClick={()=>void refreshMetadata()}>Refresh recovery access</button></div>}
      {screen==='history'&&<div className="card stack"><div className="row between"><h3>Recent prompt runs</h3><button type="button" className="btn" onClick={()=>void refreshMetadata()} disabled={writing}>Refresh</button></div><p className="hint">Latest 20 prompt runs across this project, regardless of prompt-library filters.</p>
        {metadata.comparisons.length===0&&!error?<p>No prompt runs yet. Choose a saved prompt in the library to review your first run.</p>:metadata.comparisons.length>0&&<div className="table-wrap" role="region" aria-label="Recent prompt runs" tabIndex={0}><table style={{minWidth:680}}><thead><tr><th>Authored prompt version</th><th>Models</th><th>Started</th><th>Outcome</th><th>Action</th></tr></thead><tbody>{metadata.comparisons.map(c=><tr key={c.id}><td style={{minWidth:200,...textStyle}}>{c.prompt.textPreview}</td><td>{c.runs.map(r=>modelName(r.model)).join(' + ')}</td><td>{when(c.createdAt)}</td><td>{c.runs.filter(r=>r.chargeStatus==='uncertain').length>0?`${c.runs.filter(r=>r.chargeStatus==='uncertain').length} need charge review`:c.runs.map(outcome).join(' · ')}</td><td><button type="button" className="btn" onClick={()=>void openComparison(c.id)} disabled={writing}>Open run</button></td></tr>)}</tbody></table></div>}
      </div>}
      {metadata.scheduling?.available===true&&metadata.scheduling.kind==='owner-approved-text-v1'&&<PromptRecurringPanel projectId={projectId} userId={userId} role={role} quote={screen==='quote'&&!attempt?quote:null} onUnauthorized={onUnauthorized} onRole={value=>{if(roleAuthority.current===recurringAuthority)applyRole(value);}} onOpenComparison={id=>void openComparison(id)}/>}
      {screen==='detail'&&(comparison?<div className="stack">
        <div className="card"><div className="row between"><h3>Authored prompt version</h3><button type="button" className="btn" onClick={()=>void openComparison(comparison.id)} disabled={writing}>Refresh status</button></div><p style={textStyle}>{comparison.prompt.textPreview}</p><p>Started {when(comparison.createdAt)} · {comparison.runs.length} model {comparison.runs.length===1?'request':'requests'}</p>
          {active(comparison)&&<p className="hint">{polling?'Checking saved status every 5 seconds, for at most 5 minutes.':'Automatic status checks stopped. Refresh status to check again.'}</p>}
          {writer&&comparison.canCancel&&<div><button type="button" className="btn" onClick={()=>void cancel()} disabled={writing}>Stop remaining requests</button><p className="hint">Requests already sent may still be charged. Leaving this page does not cancel them.</p></div>}
          {comparison.inputExpired?<p>Copied execution input expired under workspace retention. The authored version preview above is preserved separately.</p>:<details><summary>Copied prompt and system input</summary>{comparison.messages?<Messages messages={comparison.messages}/>:<p>Copied input is unavailable.</p>}</details>}
          {(comparison.runs.some(r=>r.chargeStatus==='uncertain')||metadata.spendingPaused)&&<div className="banner">{comparison.runs.some(r=>r.chargeStatus==='uncertain')&&<p>An earlier charge is unconfirmed; new paid work is blocked until an owner reconciles it.</p>}{metadata.spendingPaused&&<p>Paid provider work is paused by an owner.</p>}{providerHelp}</div>}
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,320px),1fr))',gap:16,minWidth:0}}>{comparison.runs.map(summary=>{const card=cards[summary.id]??emptyCard(),run=card.run??summary,detail=card.run;return <article className="card stack" key={run.id} style={{minWidth:0}}>
          <h3 style={{overflowWrap:'anywhere'}}><bdi dir="ltr">{modelName(run.model)}</bdi> · {run.provider}</h3><strong>{outcome(run)}</strong><RunCostSummary scope={<><bdi dir="ltr">{modelName(run.model)}</bdi> · {run.provider}</>} units={run.reuse?'One reused saved answer; no new provider request':'One model request'} estimatedPrice={run.reuse?'No new reservation':money(run.estimateUsd)} settledPrice={run.reuse?'No new request charge':run.chargeStatus==='cancelled'&&run.actualUsd===null?'Not sent':money(run.actualUsd)} receipt={<bdi dir="ltr">{run.id}</bdi>} state={run.chargeStatus==='uncertain'?'uncertain':run.chargeStatus==='cancelled'?'blocked':run.reuse||run.chargeStatus==='settled'?'settled':'pending'} reason={run.reuse?'Reused answer; no new provider request or charge.':run.chargeStatus==='cancelled'?'This request was not sent.':`Charge state: ${run.chargeStatus}`}/>{run.reuse&&<div><p>Reused answer observed {when(run.reuse.observedAt)}. This action made no provider request and incurred no new charge.</p><p className="hint">Original request charge: {money(run.reuse.originalCharge.actualUsd)} · {run.reuse.originalCharge.status}. Source run <bdi dir="ltr">{run.reuse.sourceRunId}</bdi>.</p></div>}
          {run.diagnostic&&<p style={textStyle}>{run.diagnostic}</p>}{detail?.isByok&&<div className="alert"><strong>Unexpected upstream BYOK billing</strong><p>The recorded credit charge excludes external provider billing. An owner must review this separate invoice.</p></div>}
          {run.status==='uncertain'&&<div className="banner"><p>The charge is unconfirmed; unknown does not mean free.</p>{role==='owner'?(detail?.generationId?<><button type="button" className="btn" onClick={()=>void reconcile(detail)} disabled={writing}>Check charge receipt</button><p className="hint">Read-only provider lookup; does not request another answer.</p></>:<p>{card.loading?'Loading the saved charge metadata.':card.error?'Charge metadata is unavailable until this answer is reloaded.':'No saved generation ID is available for automatic matching. This charge remains unresolved.'}</p>):<p>A workspace owner can review the charge.</p>}</div>}
          <AnswerView run={run} card={card} busy={busy} onAnswer={()=>void retryCard(summary)} onSources={()=>void retryCard(summary,true)}/>
          {detail&&(detail.reportedCost!==null||detail.upstreamReportedCost!==null)&&<details><summary>Original charge evidence</summary>{detail.reportedCost!==null&&<p>Reported credit cost: USD {detail.reportedCost}</p>}{detail.upstreamReportedCost!==null&&<p>Reported upstream cost: USD {detail.upstreamReportedCost}</p>}<p className="hint">Original reported evidence is separate from app-accounted credit charges.</p></details>}
        </article>;})}</div><p className="hint">These direct API responses do not establish consumer ChatGPT behavior, live web search, ranking or brand visibility. Reused answers may be up to seven days old; provider model updates in place may not be detected. Recurring tracking requires a separate explicit owner approval and always requests fresh answers.</p>
      </div>:<div><p>{error?'The selected run could not be read.':'Loading the selected run.'}</p>{error&&selection.current&&<button type="button" className="btn" onClick={()=>void openComparison(selection.current!)} disabled={writing}>Retry loading run</button>}</div>)}
    </>}
    {confirmDialog}
  </section>;
}
function AnswerView({run,card,busy,onAnswer,onSources}:{run:RunSummary;card:Card;busy:boolean;onAnswer:()=>void;onSources:()=>void}){
  if(run.resultExpired)return <p>Answer and citations expired under workspace retention.</p>;
  const state=<>{card.loading&&<p role="status">Loading this answer.</p>}{card.error&&<div role="alert"><p>Could not load this answer. {card.error}</p><button type="button" className="btn" onClick={onAnswer} disabled={busy}>Retry loading answer</button></div>}</>;
  if(!card.run)return <>{state}{!card.loading&&!card.error&&<div><p>This answer has not been loaded.</p><button type="button" className="btn" onClick={onAnswer} disabled={busy}>Load answer</button></div>}</>;
  if(!card.run.result)return <>{state}<p>{run.status==='reconciled'?'Only the charge was recovered. A new answer needs a fresh paid quote.':run.status==='queued'?'Waiting to send this request.':run.status==='running'?'The request was sent; the answer and charge are pending.':run.status==='cancelled'?'This request was not sent.':'No supported answer is available. A failed request may still be charged.'}</p></>;
  const result=card.run.result;
  return <>
    {state}
    {result.text===''?<p>Provider returned an empty answer.</p>:<div role="region" aria-label={`Answer from ${modelName(run.model)}`} tabIndex={0} style={{...textStyle,maxHeight:'28rem',overflow:'auto',minWidth:0}}>{result.text}</div>}
    <details><summary>Reported citations ({card.total??'Unavailable'})</summary>{card.total===0?<p>No citations reported.</p>:<><p>{card.sources.length} of {card.total??'an unavailable number of'} reported sources loaded.</p><ul>{card.sources.map((citation,index)=><li key={index} style={{overflowWrap:'anywhere'}}><a href={citation.url} target="_blank" rel="noopener noreferrer">{citation.title||citation.url}</a></li>)}</ul>{card.sourcesLoading&&<p role="status">Loading reported sources.</p>}{card.sourcesError?<div role="alert"><p>Could not load reported sources. {card.sourcesError}</p><button type="button" className="btn" onClick={onSources} disabled={busy}>Retry loading sources</button></div>:card.nextOffset!==null&&<button type="button" className="btn" onClick={onSources} disabled={busy||card.sourcesLoading}>Show more sources</button>}</>}</details>
    <details><summary>Response metadata</summary><p>Resolved model: {result.resolvedModel} · Provider: {result.provider} · Finish: {result.finishReason}</p><p>Prompt tokens: {result.promptTokens??'Unavailable'} · Completion tokens: {result.completionTokens??'Unavailable'} · Received {when(result.receivedAt)}</p></details>
  </>;
}
