import {useEffect,useId,useRef,useState} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {api,ApiError,errMsg} from '../lib/api';
import type {RankLocationOption,RankLanguageOption,RankLocationOptions,RankTrackingFieldErrors} from './RankTrackingFields';
import {RankTrackingView,type RankRole,type RankTracker,type RankKeyword,type RankConnection,type RankDetail,type RankCreate,type RankEdit} from './RankTrackingView';
import {RankCheckPanel,type RankCheckEntry} from './RankCheckPanel';
import {RankHistoryPanel} from './RankHistoryPanel';
import {RankSchedulePanel} from './RankSchedulePanel';

type Props={workspaceId:string;projectId:string;userId:string;origin:string;onUnauthorized:()=>void;onOpenProviders:()=>void};
type Filter='active'|'archived'|'all';
type Intent={path:string;body:Record<string,unknown>;trackerId?:string};
type Operation={controller:AbortController;write:boolean};
type CheckEntry=RankCheckEntry&{generation:number;returnToSchedule?:boolean};
type ScheduleEntry={quoteId?:string;returnCheck?:CheckEntry};
type State={role:RankRole|null;mode:'list'|'new'|'detail';loaded:boolean;filter:Filter;trackers:RankTracker[];nextCursor:string|null;connections:RankConnection[];vaultConfigured:boolean;detail:RankDetail|null;
  create:RankCreate;catalogReady:boolean;countries:RankLocationOption[];languages:RankLanguageOption[];localLocations:RankLocationOptions;localOffset:number|null;appliedQuery:string;fieldErrors:RankTrackingFieldErrors;
  editing:boolean;edit:RankEdit;adding:boolean;words:string;matchCase:boolean;selected:string[];dirty:boolean;reading:boolean;writing:boolean;pending:boolean;conflict:boolean;error:string;notice:string;focus:string|null};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const safeText=(v:unknown,max:number,min=1):v is string=>typeof v==='string'&&v.length>=min&&v.length<=max&&!v.includes('\0')&&!/[\uD800-\uDFFF]/u.test(v);
const str=(v:unknown,max:number,min=1):v is string=>safeText(v,max,min)&&!/[\u0000-\u001f\u007f]/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const int=(v:unknown,min:number,max:number)=>Number.isInteger(v)&&Number(v)>=min&&Number(v)<=max;
const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));
const nullableDate=(v:unknown)=>v===null||date(v);
const validRole=(v:unknown):v is RankRole=>['owner','admin','editor','viewer'].includes(v as string);
const writer=(role:RankRole|null)=>role!==null&&role!=='viewer';
const settings=(v:Record<string,any>)=>safeText(v.name,120)&&['desktop','mobile','both'].includes(v.devices)&&int(v.depth,10,100)&&v.depth%10===0&&int(v.maxCrawlPages,1,10);
function validTracker(v:unknown):v is RankTracker{return object(v)&&uuid(v.id)&&settings(v)&&str(v.domain,253)&&int(v.countryCode,1,2147483647)&&str(v.countryIso,2,2)&&int(v.locationCode,1,2147483647)&&str(v.locationName,512)&&str(v.locationType,80)&&str(v.languageCode,16)&&str(v.languageName,128)&&['revision','keywordsRevision','authoredRevision'].every(k=>int(v[k],1,2147483646))&&int(v.keywordCount,0,1000)&&nullableDate(v.archivedAt)&&date(v.createdAt)&&date(v.updatedAt)&&object(v.schedule)&&['manual','daily','weekly','monthly'].includes(v.schedule.interval)&&typeof v.schedule.enabled==='boolean'&&nullableDate(v.schedule.nextDueAt);}
function validKeyword(v:unknown):v is RankKeyword{return object(v)&&uuid(v.id)&&str(v.keyword,200)&&typeof v.matchCase==='boolean'&&nullableDate(v.pinnedAt)&&date(v.createdAt);}
function validDetail(v:unknown,expected?:string):v is RankDetail{return object(v)&&validRole(v.role)&&validTracker(v.tracker)&&(!expected||v.tracker.id===expected)&&Array.isArray(v.keywords)&&v.keywords.length===v.tracker.keywordCount&&v.keywords.every(validKeyword)&&new Set(v.keywords.map(k=>k.id.toLowerCase())).size===v.keywords.length&&(v.replayed===undefined||typeof v.replayed==='boolean');}
function validList(v:unknown):v is {role:RankRole;vaultConfigured:boolean;connections:RankConnection[];trackers:RankTracker[];nextCursor:string|null}{return object(v)&&validRole(v.role)&&typeof v.vaultConfigured==='boolean'&&Array.isArray(v.connections)&&v.connections.every(c=>object(c)&&uuid(c.id)&&safeText(c.name,120)&&['untested','ok','error'].includes(c.checkStatus))&&Array.isArray(v.trackers)&&v.trackers.length<=50&&v.trackers.every(validTracker)&&new Set(v.trackers.map(t=>t.id.toLowerCase())).size===v.trackers.length&&(v.nextCursor===null||str(v.nextCursor,512));}
const badResponse=()=>new Error('The server response could not be verified.');
const blankLocal=():RankLocationOptions=>({query:'',options:[],loading:false,error:null,hasMore:false});
const editFor=(tracker:RankTracker):RankEdit=>({name:tracker.name,devices:tracker.devices,depth:tracker.depth,maxCrawlPages:tracker.maxCrawlPages});
function initial(origin:string):State{
  let domain='';try{domain=new URL(origin).hostname;}catch{/* An invalid parent origin cannot create a target. */}
  return {role:null,mode:'list',loaded:false,filter:'active',trackers:[],nextCursor:null,connections:[],vaultConfigured:false,detail:null,
    create:{name:domain,connectionId:'',value:{domain,countryLocationCode:'',targeting:'national',localLocationCode:'',languageCode:'',devices:'mobile',depth:10,maxCrawlPages:1}},catalogReady:false,countries:[],languages:[],localLocations:blankLocal(),localOffset:null,appliedQuery:'',fieldErrors:{},
    editing:false,edit:{name:'',devices:'mobile',depth:10,maxCrawlPages:1},adding:false,words:'',matchCase:false,selected:[],dirty:false,reading:false,writing:false,pending:false,conflict:false,error:'',notice:'',focus:null};
}

export function RankTrackingPanel(props:Props){return <RankController key={`${props.userId}:${props.workspaceId}:${props.projectId}`} {...props}/>;}
function RankController(props:Props){
  const prefix=useId()+'-rank-',base=`/api/projects/${props.projectId}/rank-trackers`;
  const [s,setState]=useState(()=>initial(props.origin)),state=useRef(s),operation=useRef<Operation|null>(null),intent=useRef<Intent|null>(null),alive=useRef(true);
  const [check,setCheck]=useState<CheckEntry|null>(null),checkGeneration=useRef(0),[observations,setObservations]=useState(false),[schedule,setSchedule]=useState<ScheduleEntry|null>(null);
  function patch(value:Partial<State>){if(!alive.current)return;state.current={...state.current,...value};setState(state.current);}
  function locked(){return operation.current?.write===true||intent.current!==null;}
  function invalidate(){operation.current?.controller.abort();operation.current=null;}
  function canLeave(){return !locked()&&(!state.current.dirty||window.confirm('Discard unsaved tracker changes?'));}
  useBlocker({withResolver:false,shouldBlockFn:()=>!canLeave(),enableBeforeUnload:()=>state.current.dirty||locked()});
  useEffect(()=>{alive.current=true;void loadList('active');return()=>{alive.current=false;invalidate();};},[]);
  useEffect(()=>{if(!s.focus)return;const target=document.getElementById(prefix+s.focus);if(target){target.focus();patch({focus:null});}},[s.focus,s.mode,s.detail,s.loaded]);
  function begin(write=false):Operation|null{
    if(!alive.current||operation.current?.write||(!write&&intent.current))return null;
    invalidate();const op={controller:new AbortController(),write};operation.current=op;patch({reading:!write,writing:write,error:'',notice:'',...(write?{pending:false}:{})});return op;
  }
  const current=(op:Operation)=>alive.current&&operation.current===op;
  function finish(op:Operation){if(current(op)){operation.current=null;patch({reading:false,writing:false,localLocations:{...state.current.localLocations,loading:false}});}}
  function purge(message:string,unauthorized=false){invalidate();intent.current=null;state.current=initial(props.origin);setState({...state.current,error:message});state.current={...state.current,error:message};if(unauthorized)props.onUnauthorized();}
  function failure(error:unknown,op:Operation){
    if(!current(op))return;
    if(error instanceof ApiError&&[401,403,404].includes(error.status)){purge(errMsg(error),error.status===401);return;}
    if(error instanceof Error&&error.name==='AbortError')return;
    patch({error:errMsg(error)});
  }
  function role(next:RankRole){
    patch({role:next});if(next==='viewer'){patch({editing:false,adding:false,selected:[],words:'',dirty:false,catalogReady:false,countries:[],languages:[],localLocations:blankLocal(),create:initial(props.origin).create,...(state.current.mode==='new'?{mode:'list' as const}: {})});}
  }
  function resetForms(){patch({dirty:false,editing:false,adding:false,words:'',matchCase:false,selected:[],fieldErrors:{}});}
  async function loadList(filter:Filter,cursor?:string,focus?:string){
    const op=begin();if(!op)return;patch({mode:'list',filter,...(!cursor?{loaded:false,trackers:[],nextCursor:null,detail:null}:{})});
    try{const data=await api<unknown>(`${base}?${new URLSearchParams({archived:filter,...(cursor?{cursor}:{})})}`,{signal:op.controller.signal});if(!current(op))return;if(!validList(data))throw badResponse();
      role(data.role);const rows=cursor?[...state.current.trackers,...data.trackers]:data.trackers;
      patch({loaded:true,trackers:[...new Map(rows.map(t=>[t.id,t])).values()],nextCursor:data.nextCursor,connections:data.connections,vaultConfigured:data.vaultConfigured,conflict:false,...(focus?{focus:rows.some(t=>'open-'+t.id===focus)?focus:'list-heading'}:{})});
    }catch(e){failure(e,op);}finally{finish(op);}
  }
  async function loadDetail(id:string,focus=false){
    const op=begin();if(!op)return;patch({mode:'detail',...(state.current.detail?.tracker.id!==id?{detail:null}:{})});
    try{const data=await api<unknown>(`${base}/${id}`,{signal:op.controller.signal});if(!current(op))return;if(!validDetail(data,id))throw badResponse();role(data.role);patch({detail:data,edit:editFor(data.tracker),conflict:false,...(focus?{focus:'detail-heading'}:{})});}
    catch(e){failure(e,op);}finally{finish(op);}
  }
  function refresh(){if(!canLeave())return;resetForms();const at=state.current;if(at.mode==='detail'&&at.detail)void loadDetail(at.detail.tracker.id);else void loadList(at.filter);}
  function back(){if(!canLeave())return;const id=state.current.detail?.tracker.id;resetForms();void loadList(state.current.filter,undefined,id?'open-'+id:'list-heading');}
  function open(id:string){if(!canLeave())return;resetForms();void loadDetail(id,true);}
  function newTracker(){if(!writer(state.current.role)||!canLeave())return;invalidate();resetForms();const defaults=initial(props.origin);patch({mode:'new',reading:false,create:defaults.create,catalogReady:false,countries:[],languages:[],localLocations:blankLocal(),localOffset:null,appliedQuery:'',focus:'new-heading',error:''});}
  function changeCreate(next:RankCreate){
    if(locked()||!writer(state.current.role))return;const old=state.current.create;
    if(next.connectionId!==old.connectionId){invalidate();patch({reading:false,create:{...next,value:{...next.value,countryLocationCode:'',localLocationCode:'',languageCode:'',targeting:'national'}},catalogReady:false,countries:[],languages:[],localLocations:blankLocal(),localOffset:null,appliedQuery:'',dirty:true,fieldErrors:{}});return;}
    if(next.value.countryLocationCode!==old.value.countryLocationCode||next.value.targeting!==old.value.targeting){invalidate();patch({reading:false,localLocations:blankLocal(),localOffset:null,appliedQuery:''});next={...next,value:{...next.value,localLocationCode:''}};}
    patch({create:next,dirty:true,fieldErrors:{}});
  }
  async function catalog(){
    const at=state.current;if(locked()||!writer(at.role)||!at.create.connectionId||!at.vaultConfigured)return;
    const op=begin();if(!op)return;
    try{const data=await api<unknown>(base+'/catalog',{method:'POST',body:{connectionId:at.create.connectionId},signal:op.controller.signal});if(!current(op))return;
      if(!object(data)||!validRole(data.role)||!object(data.catalog)||!date(data.catalog.verifiedAt)||!Array.isArray(data.catalog.countries)||data.catalog.countries.length<1||data.catalog.countries.length>300||!data.catalog.countries.every(c=>object(c)&&int(c.code,1,2147483647)&&c.countryCode===c.code&&c.type==='Country'&&str(c.name,512))||!Array.isArray(data.catalog.languages)||data.catalog.languages.length<1||data.catalog.languages.length>200||!data.catalog.languages.every(l=>object(l)&&str(l.code,16)&&str(l.name,128)))throw badResponse();
      role(data.role);if(!writer(data.role))return;
      const countries:RankLocationOption[]=data.catalog.countries.map(c=>({code:String(c.code),label:c.name})),languages:RankLanguageOption[]=data.catalog.languages.map(l=>({code:l.code,label:l.name}));
      if(new Set(countries.map(c=>c.code)).size!==countries.length||new Set(languages.map(l=>l.code)).size!==languages.length)throw badResponse();
      patch({countries,languages,catalogReady:true});
    }catch(e){failure(e,op);}finally{finish(op);}
  }
  function localQuery(query:string){if(locked())return;invalidate();const at=state.current;patch({reading:false,localLocations:{query,options:at.localLocations.options.filter(o=>o.code===at.create.value.localLocationCode),loading:false,error:null,hasMore:false},localOffset:null,appliedQuery:''});}
  async function searchLocal(more=false){
    const at=state.current;if(locked()||!writer(at.role)||!at.catalogReady||!at.create.value.countryLocationCode||at.create.value.targeting!=='local'||(more&&(at.localOffset===null||at.appliedQuery!==at.localLocations.query)))return;
    const op=begin();if(!op)return;patch({localLocations:{...at.localLocations,loading:true,error:null}});
    const country=Number(at.create.value.countryLocationCode),query=at.localLocations.query;
    try{const data=await api<unknown>(`${base}/locations?${new URLSearchParams({connectionId:at.create.connectionId,countryCode:String(country),query,offset:String(more?at.localOffset:0)})}`,{signal:op.controller.signal});if(!current(op))return;
      if(!object(data)||!validRole(data.role)||!date(data.verifiedAt)||!int(data.total,0,300000)||(data.nextOffset!==null&&!int(data.nextOffset,1,300000))||!Array.isArray(data.rows)||data.rows.length>50||!data.rows.every(r=>object(r)&&int(r.code,1,2147483647)&&r.countryCode===country&&r.type!=='Country'&&str(r.name,512)))throw badResponse();
      role(data.role);if(!writer(data.role))return;
      const keep=more?state.current.localLocations.options:state.current.localLocations.options.filter(o=>o.code===state.current.create.value.localLocationCode),rows:RankLocationOption[]=data.rows.map(r=>({code:String(r.code),label:r.name}));
      patch({localLocations:{query,options:[...new Map([...keep,...rows].map(r=>[r.code,r])).values()],loading:false,error:null,hasMore:data.nextOffset!==null},localOffset:data.nextOffset,appliedQuery:query});
    }catch(e){failure(e,op);if(current(op))patch({localLocations:{...state.current.localLocations,loading:false,error:errMsg(e)}});}finally{finish(op);}
  }
  async function send(saved:Intent){
    if(operation.current?.write||!alive.current)return;intent.current=saved;const op=begin(true);if(!op)return;
    try{const data=await api<unknown>(saved.path,{method:'POST',body:saved.body,signal:op.controller.signal});if(!current(op))return;if(!validDetail(data,saved.trackerId)||typeof data.replayed!=='boolean')throw badResponse();
      intent.current=null;resetForms();role(data.role);patch({mode:'detail',detail:data,edit:editFor(data.tracker),pending:false,conflict:false,notice:data.replayed?'Saved change recovered.':'Tracker saved.',focus:'detail-heading',catalogReady:false,countries:[],languages:[],localLocations:blankLocal(),create:initial(props.origin).create});
    }catch(e){if(!current(op))return;
      if(e instanceof ApiError&&e.status>=400&&e.status<500&&![408,429].includes(e.status)){intent.current=null;patch({pending:false,conflict:e.status===409});failure(e,op);}
      else{patch({pending:true,error:e instanceof ApiError&&e.status===429?'The retry was rate limited. Wait before retrying the same request; its original outcome is still unknown.':''});}
    }finally{finish(op);}
  }
  function mutate(path:string,body:Record<string,unknown>,trackerId?:string){
    if(locked()||!writer(state.current.role)||state.current.conflict)return;
    try{const saved:Intent={path,body:structuredClone({...body,requestId:crypto.randomUUID()}),trackerId};void send(saved);}catch{patch({error:'This browser could not prepare a safe request. Reload before trying again.'});}
  }
  function createTracker(){
    const at=state.current;if(locked()||!at.catalogReady)return;const c=at.create,v=c.value,errors:RankTrackingFieldErrors={};
    if(!str(v.domain,253))errors.domain='Enter the target domain.';
    if(!at.countries.some(o=>o.code===v.countryLocationCode))errors.countryLocationCode='Choose a country.';
    if(!at.languages.some(o=>o.code===v.languageCode))errors.languageCode='Choose a language.';
    if(v.targeting==='local'&&!at.localLocations.options.some(o=>o.code===v.localLocationCode))errors.localLocationCode='Choose a city or region from the search results.';
    patch({fieldErrors:errors});if(Object.keys(errors).length)return;
    if(!safeText(c.name.trim(),120)||!at.connections.some(o=>o.id===c.connectionId)){patch({error:'Enter a tracker name and choose a connection.'});return;}
    mutate(base,{connectionId:c.connectionId,name:c.name,domain:v.domain,countryCode:Number(v.countryLocationCode),locationCode:Number(v.targeting==='national'?v.countryLocationCode:v.localLocationCode),languageCode:v.languageCode,devices:v.devices,depth:v.depth,maxCrawlPages:v.maxCrawlPages});
  }
  function edit(){if(locked()||!writer(state.current.role)||!state.current.detail||!canLeave())return;invalidate();resetForms();patch({reading:false,editing:true,edit:editFor(state.current.detail.tracker),focus:'edit-heading'});}
  function changeEdit(value:RankEdit){if(!locked())patch({edit:value,dirty:true});}
  function saveEdit(){const at=state.current;if(!at.detail||!safeText(at.edit.name.trim(),120)){patch({error:'Enter a tracker name, up to 120 characters.'});return;}mutate(`${base}/${at.detail.tracker.id}/update`,{revision:at.detail.tracker.authoredRevision,...at.edit},at.detail.tracker.id);}
  function cancelForm(){if(!canLeave())return;invalidate();resetForms();patch({reading:false,focus:'detail-heading'});}
  function archive(){const at=state.current;if(locked()||!writer(at.role)||!at.detail||!canLeave())return;const archived=at.detail.tracker.archivedAt===null;if(!window.confirm(archived?'Archive this tracker? Its keywords are kept.':'Reactivate this tracker? No rank check will start.'))return;mutate(`${base}/${at.detail.tracker.id}/archive`,{revision:at.detail.tracker.authoredRevision,archived},at.detail.tracker.id);}
  function add(){if(locked()||!writer(state.current.role)||state.current.detail?.tracker.archivedAt!==null||!canLeave())return;invalidate();resetForms();patch({reading:false,adding:true,focus:'add-heading'});}
  function saveWords(){const at=state.current;if(!at.detail)return;const words=at.words.split(/\r?\n/).filter(w=>w.trim()!=='');if(words.length<1||words.length>2000||words.some(w=>!str(w,200))){patch({error:'Enter 1–2,000 nonempty lines, each up to 200 characters. A tracker can contain 1,000 unique keywords.'});return;}mutate(`${base}/${at.detail.tracker.id}/keywords/add`,{revision:at.detail.tracker.authoredRevision,keywords:words,matchCase:at.matchCase},at.detail.tracker.id);}
  function selection(id:string,checked:boolean){const at=state.current;if(locked()||at.conflict||!writer(at.role)||!at.detail?.keywords.some(k=>k.id===id))return;patch({selected:checked?[...new Set([...at.selected,id])]:at.selected.filter(k=>k!==id)});}
  function keywordMutation(kind:'pin'|'remove',pinned?:boolean){const at=state.current;if(locked()||!writer(at.role)||!at.detail||at.selected.length===0||!canLeave())return;if(kind==='remove'&&!window.confirm(`Remove ${at.selected.length} selected keyword(s)?`))return;mutate(`${base}/${at.detail.tracker.id}/keywords/${kind}`,{revision:at.detail.tracker.authoredRevision,keywordIds:at.selected,...(kind==='pin'?{pinned}:{})},at.detail.tracker.id);}
  function checks(mode:'history'|'setup',subset=false){const at=state.current;if(!at.detail||!canLeave()||mode==='setup'&&(!writer(at.role)||at.detail.tracker.archivedAt!==null||!at.detail.keywords.length)||subset&&!at.selected.length)return;const keywordIds=subset?[...at.selected]:undefined;invalidate();resetForms();patch({reading:false});setCheck({generation:++checkGeneration.current,mode,...(keywordIds?{keywordIds}:{})});}
  function latest(){if(!state.current.detail||!canLeave())return;invalidate();resetForms();patch({reading:false});setObservations(true);}
  function openSchedule(){if(!state.current.detail||!canLeave())return;invalidate();resetForms();patch({reading:false});setSchedule({});}
  const schedulePanel=schedule&&s.detail?<RankSchedulePanel {...props} trackerId={s.detail.tracker.id} trackerName={s.detail.tracker.name} quoteId={schedule.quoteId} knownQuoteExpiresAt={schedule.returnCheck?.knownExpiresAt} backLabel={schedule.returnCheck?'Back to quote':observations?'Back to observations':'Back to tracker'}
    onBack={()=>{setSchedule(null);if(schedule.returnCheck)setCheck({...schedule.returnCheck,generation:++checkGeneration.current});else if(!observations)void loadDetail(s.detail!.tracker.id,true);}}
    onPrepareQuote={()=>{setSchedule(null);setCheck({generation:++checkGeneration.current,mode:'setup',purpose:'schedule',returnToSchedule:true});}}/>:null;
  const checkPanel=check&&s.detail?<RankCheckPanel key={check.generation} {...props} tracker={s.detail.tracker} connections={s.connections} vaultConfigured={s.vaultConfigured} entry={check} backLabel={check.returnToSchedule?'Back to schedule':observations?'Back to observations':'Back to tracker'}
    onConfigureSchedule={(quoteId,expiresAt)=>{setCheck(null);setSchedule({quoteId,returnCheck:{...check,mode:'run',runId:quoteId,knownExpiresAt:expiresAt}});}}
    onBack={()=>{setCheck(null);if(check.returnToSchedule)setSchedule({});else if(!observations)void loadDetail(s.detail!.tracker.id,true);}}/>:null;
  if(observations&&s.detail)return <><div hidden={check!==null||schedule!==null}><RankHistoryPanel {...props} tracker={s.detail.tracker} active={check===null&&schedule===null} onBack={()=>{setObservations(false);void loadDetail(s.detail!.tracker.id,true);}} onOpenRun={runId=>setCheck({generation:++checkGeneration.current,mode:'run',runId})}/></div>{schedulePanel??checkPanel}</>;
  if(schedulePanel)return schedulePanel;
  if(checkPanel)return checkPanel;
  return <RankTrackingView {...s} prefix={prefix} locked={s.writing||intent.current!==null} pending={s.pending&&!s.writing}
    onChecks={()=>checks('history')} onPrepareCheck={()=>checks('setup')} onPrepareSelected={()=>checks('setup',true)} onObservations={latest} onSchedule={openSchedule}
    onRefresh={refresh} onFilter={filter=>{if(canLeave()){resetForms();void loadList(filter);}}} onMore={()=>{if(state.current.nextCursor&&!state.current.reading)void loadList(state.current.filter,state.current.nextCursor);}}
    onNew={newTracker} onOpen={open} onBack={back} onCreateChange={changeCreate} onCatalog={()=>void catalog()} onLocalQuery={localQuery} onSearchLocal={()=>void searchLocal()} onMoreLocal={()=>void searchLocal(true)} onCreate={createTracker} onCancelCreate={back}
    onEdit={edit} onEditChange={changeEdit} onSaveEdit={saveEdit} onCancelEdit={cancelForm} onArchive={archive} onAdd={add} onWords={words=>{if(!locked())patch({words,dirty:true});}} onMatchCase={matchCase=>{if(!locked())patch({matchCase,dirty:true});}} onSaveWords={saveWords} onCancelWords={cancelForm}
    onSelect={selection} onSelectAll={checked=>{if(!locked()&&!state.current.conflict&&writer(state.current.role))patch({selected:checked?state.current.detail?.keywords.map(k=>k.id)??[]:[]});}} onPin={pinned=>keywordMutation('pin',pinned)} onRemove={()=>keywordMutation('remove')}
    onRetry={()=>{if(intent.current&&!operation.current?.write)void send(intent.current);}} onReload={refresh} onOpenProviders={()=>{if(state.current.role==='owner'&&canLeave()){resetForms();invalidate();props.onOpenProviders();}}}/>
}
