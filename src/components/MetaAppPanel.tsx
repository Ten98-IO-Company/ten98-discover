import {useEffect,useId,useRef,useState} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {api,ApiError,errMsg} from '../lib/api';
import {MetaAppView,type MetaAppCallback} from './MetaAppView';

type Registration={id:string;appId:string;configId:string;revision:number;active:boolean;enabled:boolean;declaredMode:'development'|'live';boundOrigin:string;deleteDataUrl:string};
type Metadata={operator:true;configured:boolean;enabled:boolean;vaultConfigured:boolean;httpsReady:boolean;redirectUri:string;activeRegistrationId:string|null;registration:Registration|null;registrations:Registration[];nextCursor:string|null};
type Draft={appId:string;configId:string;enabled:boolean;declaredMode:'development'|'live';activate:boolean};
type Target={registrationId?:string;appId?:string;newDraft?:boolean};
type Operation={controller:AbortController;signal:AbortSignal;write:boolean};
type State={operator:boolean|null;metadata:Metadata|null;selected:Registration|null;newRegistration:boolean;draft:Draft;baseline:Draft;secret:string;reading:boolean;writeState:'idle'|'submitting'|'unknown';confirmDisable:boolean;error:string;notice:string;pages:Array<string|undefined>};
type Props={userId:string;onUnauthorized:()=>void;onBack:()=>void;backLabel:string};
const blank=():Draft=>({appId:'',configId:'',enabled:false,declaredMode:'development',activate:false});
const initial=():State=>({operator:null,metadata:null,selected:null,newRegistration:false,draft:blank(),baseline:blank(),secret:'',reading:false,writeState:'idle',confirmDisable:false,error:'',notice:'',pages:[undefined]});
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i.test(v);
const decimal=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,39}$(?![\s\S])/.test(v);
const secretValid=(v:string)=>v.length<=512&&/^[\x21-\x7e]+$(?![\s\S])/.test(v);
const mismatch=()=>new Error('The app setup response could not be verified. Reload app setup.');
function registration(v:unknown):Registration{
 if(!object(v)||!uuid(v.id)||!decimal(v.appId)||!decimal(v.configId)||!Number.isSafeInteger(v.revision)||Number(v.revision)<1||Number(v.revision)>2147483647||typeof v.active!=='boolean'||typeof v.enabled!=='boolean'||!['development','live'].includes(v.declaredMode as string)||typeof v.boundOrigin!=='string'||v.boundOrigin.length>2048||v.deleteDataUrl!==window.location.origin+`/api/meta/apps/${v.id}/delete-data`)throw mismatch();
 try{const u=new URL(v.boundOrigin);if(!['http:','https:'].includes(u.protocol)||u.origin!==v.boundOrigin)throw mismatch();}catch{throw mismatch();}
 return {id:v.id,appId:v.appId,configId:v.configId,revision:Number(v.revision),active:v.active,enabled:v.enabled,declaredMode:v.declaredMode as Registration['declaredMode'],boundOrigin:v.boundOrigin,deleteDataUrl:v.deleteDataUrl as string};
}
function metadata(v:unknown,target:Target={}):Metadata|false{
 if(!object(v)||typeof v.operator!=='boolean')throw mismatch();if(!v.operator)return false;
 if(!['configured','enabled','vaultConfigured','httpsReady'].every(k=>typeof v[k]==='boolean')||v.redirectUri!==window.location.origin+'/api/meta/callback'||!(v.activeRegistrationId===null||uuid(v.activeRegistrationId))||v.configured!==(v.activeRegistrationId!==null)||!v.configured&&v.enabled||!Array.isArray(v.registrations)||v.registrations.length>50||!(v.nextCursor===null||typeof v.nextCursor==='string'&&v.nextCursor.length<=512&&/^[A-Za-z0-9_-]+$(?![\s\S])/.test(v.nextCursor)))throw mismatch();
 const selected=v.registration===null?null:registration(v.registration),rows=v.registrations.map(registration);
 if(new Set(rows.map(r=>r.id)).size!==rows.length||new Set(rows.map(r=>r.appId)).size!==rows.length)throw mismatch();
 if(target.registrationId&&selected?.id!==target.registrationId||target.appId&&selected!==null&&selected.appId!==target.appId)throw mismatch();
 if(!target.registrationId&&!target.appId&&(selected?.id??null)!==v.activeRegistrationId)throw mismatch();
 for(const r of [...rows,...(selected?[selected]:[])])if(r.active!==(r.id===v.activeRegistrationId)||r.active&&r.enabled!==v.enabled)throw mismatch();
 const onPage=selected?rows.find(r=>r.id===selected.id):undefined;if(onPage&&JSON.stringify(onPage)!==JSON.stringify(selected))throw mismatch();
 return {operator:true,configured:v.configured as boolean,enabled:v.enabled as boolean,vaultConfigured:v.vaultConfigured as boolean,httpsReady:v.httpsReady as boolean,redirectUri:v.redirectUri as string,activeRegistrationId:v.activeRegistrationId as string|null,registration:selected,registrations:rows,nextCursor:v.nextCursor as string|null};
}
function draftFor(r:Registration|null):Draft{return r?{appId:r.appId,configId:r.configId,enabled:r.enabled,declaredMode:r.declaredMode,activate:false}:blank();}

export function MetaAppPanel(props:Props){return <Controller key={props.userId} {...props}/>;}
function Controller(props:Props){
 const prefix=useId()+'-meta-app-',[s,setState]=useState(initial),state=useRef(s),alive=useRef(true),op=useRef<Operation|null>(null),generation=useRef(0),recovery=useRef<Target|null>(null),focusPending=useRef(false);
 function patch(p:Partial<State>){if(alive.current){state.current={...state.current,...p};setState(state.current);}}
 function dirty(){return state.current.secret!==''||JSON.stringify(state.current.draft)!==JSON.stringify(state.current.baseline);}
 function locked(){return op.current?.write===true||state.current.writeState!=='idle';}
 function discard(){return !dirty()||window.confirm('Discard the unsaved Meta app changes? The typed secret will be cleared.');}
 function invalidate(){generation.current++;op.current?.controller.abort();op.current=null;}
 function purge(message:string,operator:boolean|null=null,unauthorized=false){invalidate();recovery.current=null;patch({...initial(),operator,error:message});if(unauthorized)props.onUnauthorized();}
 useBlocker({withResolver:false,shouldBlockFn:()=>{if(locked())return true;if(!discard())return true;invalidate();patch({secret:''});return false;},enableBeforeUnload:()=>locked()||dirty()});
 useEffect(()=>{alive.current=true;void load({},[undefined]);return()=>{alive.current=false;invalidate();recovery.current=null;state.current={...state.current,secret:''};};},[]);
 useEffect(()=>{if(focusPending.current&&!s.reading&&s.writeState==='idle'){focusPending.current=false;document.getElementById(prefix+'heading')?.focus();}},[s.reading,s.writeState,s.metadata,s.operator,prefix]);
 const current=(value:Operation)=>alive.current&&op.current===value;
 function begin(write=false){if(!alive.current||op.current?.write)return null;invalidate();const controller=new AbortController(),value={controller,write,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])};op.current=value;patch({reading:!write,secret:'',error:'',notice:'',confirmDisable:false,...(write?{writeState:'submitting' as const}:{})});return value;}
 function finish(value:Operation){if(current(value)){op.current=null;patch({reading:false,...(state.current.writeState==='submitting'?{writeState:'idle' as const}:{})});}}
 function denial(error:unknown,value:Operation){if(!current(value))return true;if(error instanceof ApiError&&[401,403,404].includes(error.status)){purge(errMsg(error),null,error.status===401);return true;}return false;}
 function apply(data:Metadata,target:Target,pages:Array<string|undefined>,notice=''){
  const selected=target.newDraft?null:data.registration,draft=draftFor(selected);if(!selected&&target.appId)draft.appId=target.appId;
  recovery.current=null;focusPending.current=true;patch({operator:true,metadata:data,selected,newRegistration:selected===null,draft,baseline:{...draft},secret:'',writeState:'idle',confirmDisable:false,pages,notice,error:''});
 }
 async function read(value:Operation,target:Target,pages:Array<string|undefined>){const params=new URLSearchParams();if(target.registrationId)params.set('registrationId',target.registrationId);else if(target.appId)params.set('appId',target.appId);const cursor=pages.at(-1);if(cursor)params.set('cursor',cursor);const raw=await api<unknown>('/api/meta/app'+(params.size?'?'+params:''),{signal:value.signal});if(!current(value))return null;const result=metadata(raw,target);if(result===false){purge('Only an instance operator can view or change Meta app setup.',false);return null;}return result;}
 async function load(target:Target,pages:Array<string|undefined>,notice=''){
  const value=begin();if(!value)return;focusPending.current=true;const wasUnknown=state.current.writeState==='unknown';patch({operator:null,metadata:null,selected:null,newRegistration:false,draft:blank(),baseline:blank()});
  try{const data=await read(value,target,pages);if(data&&current(value))apply(data,target,pages,notice||(wasUnknown?'Current metadata reloaded. Review it before another change; it does not prove which secret was saved.':''));}
  catch(error){if(!denial(error,value)){patch({error:errMsg(error),...(wasUnknown?{writeState:'unknown' as const}:{})});}}
  finally{finish(value);}
 }
 function selectionTarget():Target{return state.current.selected?{registrationId:state.current.selected.id}:state.current.newRegistration?{newDraft:true}:{};}
 function reload(){if(op.current?.write)return;if(state.current.writeState!=='unknown'&&!discard())return;void load(recovery.current??selectionTarget(),[undefined]);}
 function select(id:string){if(locked()||state.current.confirmDisable||!state.current.metadata||!state.current.metadata.registrations.some(r=>r.id===id)&&state.current.selected?.id!==id||!discard())return;void load({registrationId:id},[undefined]);}
 function fresh(){if(locked()||state.current.confirmDisable||!discard())return;void load({newDraft:true},[undefined]);}
 function page(forward:boolean){if(locked()||state.current.reading||state.current.confirmDisable||!discard())return;const pages=state.current.pages;if(forward){const next=state.current.metadata?.nextCursor;if(next)void load(selectionTarget(),[...pages,next]);}else if(pages.length>1)void load(selectionTarget(),pages.slice(0,-1));}
 function edit(p:Partial<Draft>){if(locked()||state.current.reading||state.current.confirmDisable||state.current.operator!==true)return;patch({draft:{...state.current.draft,...p},error:'',notice:''});}
 function canSave(){return state.current.operator===true&&!!state.current.metadata?.vaultConfigured&&!!state.current.metadata.httpsReady&&!state.current.reading&&!locked()&&!state.current.confirmDisable&&(state.current.selected?.revision??0)<2147483647&&dirty()&&decimal(state.current.draft.appId)&&decimal(state.current.draft.configId)&&(state.current.secret===''?!state.current.newRegistration:secretValid(state.current.secret));}
 async function save(){
  if(!canSave())return;const expected={...state.current.draft,revision:state.current.selected?.revision??0,id:state.current.selected?.id??null,wasActive:state.current.selected?.active??false};
  const body:{activeRegistrationId:string|null;revision:number;appId:string;configId:string;appSecret?:string;activate:boolean;enabled:boolean;declaredMode:'development'|'live'}={activeRegistrationId:state.current.metadata!.activeRegistrationId,revision:expected.revision,appId:expected.appId,configId:expected.configId,activate:expected.activate,enabled:expected.enabled,declaredMode:expected.declaredMode,...(state.current.secret?{appSecret:state.current.secret}:{})};
  recovery.current=expected.id?{registrationId:expected.id}:{appId:expected.appId};const value=begin(true);if(!value){delete body.appSecret;return;}
  let accepted=false;
  try{const pending=api<unknown>('/api/meta/app',{method:'POST',body,signal:value.signal});delete body.appSecret;const raw=await pending;accepted=true;if(!current(value))return;const data=metadata(raw,recovery.current!);if(data===false){purge('Only an instance operator can view or change Meta app setup.',false);return;}
   const selected=data.registration;if(!selected||selected.appId!==expected.appId||selected.revision<expected.revision+1)throw mismatch();
   if(selected.revision===expected.revision+1&&(selected.configId!==expected.configId||selected.enabled!==expected.enabled||selected.declaredMode!==expected.declaredMode||selected.active!==(expected.activate||expected.wasActive)))throw mismatch();
   const target={registrationId:selected.id};recovery.current=target;const latest=await read(value,target,[undefined]);if(latest&&current(value))apply(latest,target,[undefined],'App settings saved locally. Current metadata is shown; Meta approval has not been verified.');
  }catch(error){delete body.appSecret;if(!denial(error,value)){if(!accepted&&error instanceof ApiError&&error.status===400){recovery.current=null;patch({writeState:'idle',error:'The app settings were not accepted. Review the IDs and settings; enter a secret only if you intend to change it.'});}else patch({writeState:'unknown',error:'The result is not confirmed. Reload app setup before making another change.'});}}
  finally{finish(value);}
 }
 function reviewDisable(){if(locked()||state.current.reading||state.current.operator!==true||!state.current.selected?.enabled)return;patch({confirmDisable:true,error:'',notice:''});}
 async function disable(){
  if(locked()||state.current.reading||!state.current.confirmDisable||state.current.operator!==true||!state.current.selected?.enabled)return;
  const selected={id:state.current.selected.id,revision:state.current.selected.revision},target={registrationId:selected.id};recovery.current=target;const value=begin(true);if(!value)return;
  try{const raw=await api<unknown>(`/api/meta/apps/${selected.id}/disable`,{method:'POST',body:{revision:selected.revision},signal:value.signal});if(!current(value))return;const response=metadata(raw);if(response===false){purge('Only an instance operator can view or change Meta app setup.',false);return;}
   const latest=await read(value,target,[undefined]);if(latest&&current(value)){if(!latest.registration||latest.registration.enabled||latest.registration.revision<Math.min(selected.revision+1,2147483647))throw mismatch();apply(latest,target,[undefined],'Registration disabled locally. This does not revoke access at Meta or delete retained reports.');}
  }catch(error){if(!denial(error,value))patch({writeState:'unknown',error:'The result is not confirmed. Reload app setup before making another change.'});}
  finally{finish(value);}
 }
 function callbacks():MetaAppCallback[]{if(state.current.operator!==true||!state.current.metadata)return [];return [{kind:'oauth',label:'OAuth callback',url:state.current.metadata.redirectUri,helper:'Use this exact callback in the Meta app.'},...(state.current.selected?[{kind:'deletion' as const,label:'Data-deletion callback',url:state.current.selected.deleteDataUrl,helper:'Keep this callback configured for this retained registration.'}]:[])];}
 async function copy(kind:'oauth'|'deletion'){if(locked()||state.current.reading)return;const item=callbacks().find(c=>c.kind===kind);if(!item)return;const serial=generation.current;try{await navigator.clipboard.writeText(item.url);if(alive.current&&serial===generation.current&&callbacks().some(c=>c.kind===kind&&c.url===item.url))patch({notice:'Callback address copied.'});}catch{if(alive.current&&serial===generation.current)patch({notice:'Copy is unavailable. Select the address text to copy it manually.'});}}
 function back(){if(locked()||!discard())return;invalidate();recovery.current=null;patch(initial());props.onBack();}
 const choices=(s.metadata?.registrations??[]).map(r=>({id:r.id,label:`App ${r.appId} · ${r.active?'Active':'Inactive'} · ${r.enabled?'Enabled':'Disabled'}`}));if(s.selected&&!choices.some(c=>c.id===s.selected!.id))choices.unshift({id:s.selected.id,label:`App ${s.selected.appId} · ${s.selected.active?'Active':'Inactive'} · ${s.selected.enabled?'Enabled':'Disabled'}`});
 const readiness=!s.metadata?'':!s.metadata.httpsReady?'A stable HTTPS application origin is required before saving app settings.':!s.metadata.vaultConfigured?'The credential vault is unavailable. Ask the host operator to restore it. Local Disable remains available.':s.selected?.revision===2147483647?'This registration reached its revision limit. It can still be disabled.':'App mode is operator-declared. Saving does not verify Meta approval.';
 return <MetaAppView prefix={prefix} operator={s.operator} reading={s.reading} writeState={s.writeState} error={s.error} notice={s.notice} readiness={readiness} choices={choices} selected={s.selected?{id:s.selected.id,appId:s.selected.appId,statusLabel:`${s.selected.active?'Active':'Inactive'} · ${s.selected.enabled?'Enabled':'Disabled'}`,revisionLabel:`Revision ${s.selected.revision}`,active:s.selected.active,enabled:s.selected.enabled,boundOrigin:s.selected.boundOrigin}:null} newRegistration={s.newRegistration} canPrevious={s.pages.length>1} canNext={s.metadata?.nextCursor!==null&&s.metadata?.nextCursor!==undefined} appId={s.draft.appId} configId={s.draft.configId} secret={s.secret} enabled={s.draft.enabled} declaredMode={s.draft.declaredMode} activate={s.draft.activate} canSave={canSave()} canDisable={s.operator===true&&!!s.selected?.enabled&&!s.reading&&!locked()} confirmDisable={s.confirmDisable} callbacks={callbacks()} backLabel={props.backLabel} onSelect={select} onNew={fresh} onPrevious={()=>page(false)} onNext={()=>page(true)} onAppId={value=>{if(s.newRegistration)edit({appId:value});}} onConfigId={configId=>edit({configId})} onSecret={secret=>{if(!locked()&&!state.current.reading&&!state.current.confirmDisable&&state.current.operator===true)patch({secret,error:'',notice:''});}} onEnabled={enabled=>edit({enabled})} onMode={declaredMode=>edit({declaredMode})} onActivate={activate=>edit({activate})} onSave={()=>void save()} onReviewDisable={reviewDisable} onDisable={()=>void disable()} onKeepEnabled={()=>{if(!locked())patch({confirmDisable:false});}} onCopy={kind=>void copy(kind)} onReload={reload} onBack={back}/>;
}
