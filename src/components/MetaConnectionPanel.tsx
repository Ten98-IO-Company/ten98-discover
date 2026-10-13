import {useEffect,useId,useRef,useState} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {api,ApiError,errMsg} from '../lib/api';
import {MetaConnectionView,type MetaAccountOption} from './MetaConnectionView';

type Role='owner'|'admin'|'editor'|'viewer';
type Account={id:string;name:string;currency:string;timeZone:string;status:number};
type Connection={id:string;name:string;revision:number;status:'select_account'|'ready'|'reconnect'|'disconnected'|'deleted';account:Account|null;scopes:string[];accessExpiresAt:string|null;dataAccessExpiresAt:string|null;validatedAt:string|null;updatedAt:string};
type App={operator:boolean;configured:boolean;enabled:boolean;vaultConfigured:boolean;httpsReady:boolean;redirectUri:string};
type Props={userId:string;workspaceId:string;projectId:string;onUnauthorized:()=>void;onOpenAppSetup:()=>void};
type Operation={controller:AbortController;signal:AbortSignal;write:boolean};
type Intent={kind:'connect';requestId:string;name:string;connectionId?:string;revision?:number}|{kind:'select';requestId:string;connectionId:string;revision:number;accountId:string}|{kind:'disconnect';requestId:string;connectionId:string;revision:number;revokeAtMeta:boolean};
type State={role:Role|null;app:App|null;loaded:boolean;reading:boolean;writeState:'idle'|'submitting'|'unknown';error:string;notice:string;mode:'connections'|'account'|'disconnect';name:string;connections:Connection[];connection:Connection|null;accounts:Account[];selected:Account|null;accountId:string;discovery:'not_loaded'|'loaded'|'empty'|'partial'|'failed';nextAccounts:string|null;accountCursors:Array<string|undefined>;nextConnections:string|null;connectionCursors:Array<string|undefined>;focus:boolean};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=2048,min=0):v is string=>typeof v==='string'&&v.length>=min&&v.length<=max&&!/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const decimal=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,39}$(?![\s\S])/.test(v);
const revision=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=1&&Number(v)<=2147483647;
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));
const nullableDate=(v:unknown)=>v===null||date(v);
const role=(v:unknown):v is Role=>['owner','admin','editor','viewer'].includes(v as string);
const cursor=(v:unknown,max=20000)=>v===null||text(v,max,1);
function account(v:unknown):v is Account{return object(v)&&decimal(v.id)&&text(v.name,512,1)&&typeof v.currency==='string'&&/^[A-Z]{3}$(?![\s\S])/.test(v.currency)&&text(v.timeZone,120,1)&&Number.isSafeInteger(v.status)&&v.status>=0;}
function connection(v:unknown):v is Connection{return object(v)&&uuid(v.id)&&text(v.name,120,1)&&revision(v.revision)&&['select_account','ready','reconnect','disconnected','deleted'].includes(v.status)&&(v.account===null||account(v.account))&&(v.status!=='ready'||v.account!==null)&&(v.status!=='deleted'||v.account===null)&&Array.isArray(v.scopes)&&v.scopes.length<=100&&v.scopes.every((s:unknown)=>text(s,100,1))&&nullableDate(v.accessExpiresAt)&&nullableDate(v.dataAccessExpiresAt)&&nullableDate(v.validatedAt)&&date(v.updatedAt);}
function app(v:unknown):v is App{return object(v)&&['operator','configured','enabled','vaultConfigured','httpsReady'].every(k=>typeof v[k]==='boolean')&&v.redirectUri===window.location.origin+'/api/meta/callback';}
const mismatch=()=>new Error('The server response could not be verified. Reload before continuing.');
const dateLabel=(value:string|null)=>value===null?'Expiry not reported':new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
const accountLabel=(a:Account|null)=>a?`${a.name} · Account ${a.id}`:'No account selected';
const option=(a:Account):MetaAccountOption=>({...a,statusLabel:`Account status code ${a.status}`,selectable:true,unavailableReason:null});
const statusLabels:Record<Connection['status'],string>={select_account:'Account selection needed',ready:'Account selected',reconnect:'Reconnect needed',disconnected:'Disconnected',deleted:'Deleted locally'};
const statusDetails:Record<Connection['status'],string>={select_account:'Choose the advertising account for this connection.',ready:'This connection identifies an account. It does not install a pixel or import a report.',reconnect:'Approve access again for this same account.',disconnected:'Local credentials have been removed.',deleted:'This source cannot be reconnected. Add a new connection after local deletion completes.'};
function authorizationUrl(value:unknown,redirectUri:string):string|null{
 if(typeof value!=='string'||value.length>2048)return null;
 try{const u=new URL(value),p=u.searchParams,keys=['client_id','config_id','response_type','redirect_uri','state'];
  if(u.origin!=='https://www.facebook.com'||u.username||u.password||u.hash||u.pathname!=='/v26.0/dialog/oauth'||p.size!==keys.length||keys.some(k=>p.getAll(k).length!==1)||!decimal(p.get('client_id'))||!decimal(p.get('config_id'))||p.get('response_type')!=='code'||p.get('redirect_uri')!==redirectUri||!/^[-_A-Za-z0-9]{43}$(?![\s\S])/.test(p.get('state')??''))return null;
  return u.href;
 }catch{return null;}
}

export function MetaConnectionPanel(props:Props){return <Controller key={`${props.userId}:${props.workspaceId}:${props.projectId}`} {...props}/>;}
function Controller(props:Props){
 const prefix=useId()+'-meta-',base=`/api/projects/${props.projectId}/meta`;
 const initial=():State=>({role:null,app:null,loaded:false,reading:false,writeState:'idle',error:'',notice:'',mode:'connections',name:'',connections:[],connection:null,accounts:[],selected:null,accountId:'',discovery:'not_loaded',nextAccounts:null,accountCursors:[undefined],nextConnections:null,connectionCursors:[undefined],focus:false});
 const [s,setState]=useState(initial),state=useRef(s),alive=useRef(true),op=useRef<Operation|null>(null),intent=useRef<Intent|null>(null);
 function patch(value:Partial<State>){if(alive.current){state.current={...state.current,...value};setState(state.current);}}
 function invalidate(){op.current?.controller.abort();op.current=null;}
 function locked(){return op.current?.write===true||intent.current!==null;}
 useBlocker({withResolver:false,shouldBlockFn:()=>locked(),enableBeforeUnload:()=>locked()});
 useEffect(()=>{alive.current=true;void loadConnections();return()=>{alive.current=false;invalidate();intent.current=null;};},[]);
 useEffect(()=>{if(s.focus){document.getElementById(prefix+'heading')?.focus();patch({focus:false});}},[s.focus,s.mode]);
 function begin(write=false){if(!alive.current||op.current?.write||(!write&&intent.current))return null;invalidate();const controller=new AbortController(),value={controller,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(150000)]),write};op.current=value;patch({reading:!write,error:'',notice:'',...(write?{writeState:'submitting' as const}:{})});return value;}
 const current=(value:Operation)=>alive.current&&op.current===value;
 function finish(value:Operation){if(current(value)){op.current=null;patch({reading:false,...(state.current.writeState==='submitting'?{writeState:'idle' as const}:{})});}}
 function purge(message:string,unauthorized=false){invalidate();intent.current=null;patch({...initial(),error:message,loaded:true});if(unauthorized)props.onUnauthorized();}
 function failed(error:unknown,value:Operation){if(!current(value))return;if(error instanceof ApiError&&[401,403,404].includes(error.status)){purge(errMsg(error),error.status===401);return;}if(error instanceof Error&&error.name==='AbortError')return;patch({error:errMsg(error)});}
 function readRole(next:Role){patch({role:next,...(next!=='owner'?{mode:'connections' as const,name:'',connection:null,accounts:[],selected:null,accountId:'',nextAccounts:null,accountCursors:[undefined],discovery:'not_loaded' as const}:{})});}
 function clearAccounts(){patch({accounts:[],selected:null,accountId:'',discovery:'not_loaded',nextAccounts:null,accountCursors:[undefined]});}
 function appReady(){const a=state.current.app;return !!a&&a.configured&&a.enabled&&a.vaultConfigured&&a.httpsReady;}
 async function loadConnections(cursors:Array<string|undefined>=[undefined],notice=''){
  const value=begin();if(!value)return;clearAccounts();patch({role:null,app:null,loaded:false,mode:'connections',connection:null,connections:[],nextConnections:null,name:'',focus:true});
  try{
   const page=cursors.at(-1),data=await api<unknown>(base+(page?'?'+new URLSearchParams({cursor:page}):''),{signal:value.signal});if(!current(value))return;
   if(!object(data)||!role(data.role)||!Array.isArray(data.connections)||data.connections.length>50||!data.connections.every(connection)||new Set(data.connections.map(c=>c.id)).size!==data.connections.length||!cursor(data.nextCursor,1024))throw mismatch();
   readRole(data.role);patch({connections:data.connections,nextConnections:data.nextCursor,connectionCursors:cursors,loaded:true,notice});
   const setup=await api<unknown>('/api/meta/app',{signal:value.signal});if(!current(value))return;if(!app(setup))throw mismatch();patch({app:setup});
  }catch(error){failed(error,value);}finally{finish(value);}
 }
 async function open(id:string,mode:'account'|'disconnect'){
  if(locked()||state.current.role!=='owner')return;const known=state.current.connections.find(c=>c.id===id);if(!known||known.status==='deleted')return;
  const value=begin();if(!value)return;clearAccounts();patch({role:null,connection:null,mode,focus:true});
  try{const data=await api<unknown>(`${base}/connections/${id}`,{signal:value.signal});if(!current(value))return;
   if(!object(data)||!role(data.role)||!connection(data.connection)||data.connection.id!==id)throw mismatch();readRole(data.role);
   const c=data.connection;patch({connections:state.current.connections.map(old=>old.id===id?c:old)});
   if(data.role==='owner')patch({connection:c,mode:c.status==='deleted'||mode==='account'&&c.status!=='select_account'?'connections':mode});
  }catch(error){failed(error,value);}finally{finish(value);}
 }
 async function accounts(cursors:Array<string|undefined>=[undefined],inspectId?:string){
  const c=state.current.connection;if(locked()||state.current.reading||state.current.role!=='owner'||!c||c.status!=='select_account'||!appReady())return;
  if(inspectId!==undefined&&!decimal(inspectId)){patch({error:'Enter the account ID digits exactly as Meta shows them.'});return;}
  const value=begin();if(!value)return;const page=cursors.at(-1);
  try{const data=await api<unknown>(`${base}/connections/${c.id}/${inspectId===undefined?'accounts':'inspect'}`,{method:'POST',body:{revision:c.revision,...(inspectId===undefined?(page?{cursor:page}:{}):{accountId:inspectId})},signal:value.signal});if(!current(value))return;
   if(!object(data)||!role(data.role))throw mismatch();if(data.role!=='owner'){purge('Your workspace role changed. Reload connections to review your current access.');return;}
   if(data.connectionId!==c.id||data.revision!==c.revision)throw mismatch();
   if(inspectId!==undefined){if(!account(data.account)||data.account.id!==inspectId)throw mismatch();patch({selected:data.account,notice:'Account checked. Review it and confirm to save this source.'});}
   else{if(!Array.isArray(data.accounts)||data.accounts.length>100||!data.accounts.every(account)||new Set(data.accounts.map(a=>a.id)).size!==data.accounts.length||typeof data.complete!=='boolean'||!cursor(data.nextCursor)||data.complete!==(data.nextCursor===null))throw mismatch();patch({accounts:data.accounts,nextAccounts:data.nextCursor,accountCursors:cursors,discovery:data.nextCursor?'partial':data.accounts.length?'loaded':'empty'});}
  }catch(error){if(!current(value))return;if(error instanceof ApiError&&error.status===409){purge('This connection changed. Reload connections and review it before continuing.');}else{patch({discovery:'failed'});failed(error,value);}}finally{finish(value);}
 }
 function back(){if(locked())return;invalidate();clearAccounts();patch({reading:false,mode:'connections',connection:null,error:'',notice:'',focus:true});if(state.current.role===null)void loadConnections();}
 async function send(saved:Intent){
  if(op.current?.write||!alive.current||state.current.role!=='owner')return;intent.current=saved;const value=begin(true);if(!value)return;
  let reloadNotice:string|undefined;
  try{
   const {kind,connectionId,...rest}=saved,path=kind==='connect'?base+'/connect':`${base}/connections/${connectionId}/${kind}`;
   const data=await api<unknown>(path,{method:'POST',body:{...rest,...(kind==='connect'&&connectionId?{connectionId}:{})},signal:value.signal});if(!current(value))return;
   if(kind==='connect'){
    const target=object(data)&&state.current.app?authorizationUrl(data.authorizationUrl,state.current.app.redirectUri):null;if(!target)throw mismatch();
    // Only this verified, fixed provider endpoint may escape the local router.
    intent.current=null;finish(value);window.location.assign(target);return;
   }
   if(!object(data)||!object(data.acknowledgement))throw mismatch();const ack=data.acknowledgement;
   if(ack.requestId!==saved.requestId||ack.connectionId!==saved.connectionId)throw mismatch();
   if(saved.kind==='select'){
    if(!role(data.role))throw mismatch();if(data.role!=='owner'){purge('Your workspace role changed. Reload connections to review your current access.');return;}
    if(ack.selectedAccountId!==saved.accountId||ack.revision!==saved.revision+1||typeof data.replayed!=='boolean'||!connection(data.connection)||data.connection.id!==saved.connectionId||data.connection.revision<ack.revision)throw mismatch();
    intent.current=null;clearAccounts();patch({mode:'connections',connection:null,connections:state.current.connections.map(c=>c.id===data.connection.id?data.connection:c),writeState:'idle',focus:true,notice:data.connection.status==='ready'&&data.connection.account?.id===saved.accountId?'Account selected. Report imports are a separate action.':'The account selection was acknowledged. This connection has changed since that request; review its current status.'});
   }else{
    if(ack.revision!==saved.revision||ack.revokeAtMeta!==saved.revokeAtMeta||data.disconnected!==true||!['not_requested','unconfirmed','confirmed'].includes(data.remoteRevocation)||(!saved.revokeAtMeta&&data.remoteRevocation!=='not_requested')||(saved.revokeAtMeta&&data.remoteRevocation==='not_requested'))throw mismatch();
    intent.current=null;clearAccounts();patch({writeState:'idle',role:null,connections:[],connection:null,mode:'connections'});
    reloadNotice=data.remoteRevocation==='confirmed'?'Disconnected locally. Meta confirmed grant revocation.':data.remoteRevocation==='unconfirmed'?'Disconnected locally. Meta revocation was not confirmed. Review the app grant in Meta.':'Disconnected locally. Meta access was not revoked.';
   }
  }catch(error){if(!current(value))return;
   if(error instanceof ApiError&&error.status>=400&&error.status<500&&![408,429].includes(error.status)){
    intent.current=null;patch({writeState:'idle'});if(error.status===409){purge('This connection or app setup changed. Reload connections and review before trying again.');}else failed(error,value);
   }else patch({writeState:'unknown',error:saved.kind==='connect'?'Authorization could not be confirmed. Start authorization again to create a new attempt.':'The result is not confirmed. Retry the same request.'});
  }finally{finish(value);}
  if(reloadNotice!==undefined&&alive.current)void loadConnections([undefined],reloadNotice);
 }
 function connect(connectionId?:string){
  if(locked()||state.current.reading||state.current.role!=='owner'||!appReady())return;const c=connectionId?state.current.connections.find(c=>c.id===connectionId):undefined;if(connectionId&&(!c||c.status==='deleted'))return;
  const name=c?.name??state.current.name.trim();if(!text(name,120,1)){patch({error:'Enter a connection name of up to 120 characters.'});return;}
  clearAccounts();void send({kind:'connect',requestId:crypto.randomUUID(),name,...(c?{connectionId:c.id,revision:c.revision}:{})});
 }
 function restart(){const saved=intent.current;if(state.current.writeState!=='unknown'||saved?.kind!=='connect'||op.current)return;void send({...saved,requestId:crypto.randomUUID()});}
 function retry(){const saved=intent.current;if(state.current.writeState==='unknown'&&saved&&saved.kind!=='connect'&&!op.current)void send(saved);}
 function confirm(){const c=state.current.connection,a=state.current.selected;if(locked()||state.current.reading||state.current.role!=='owner'||!c||c.status!=='select_account'||!a||!appReady())return;void send({kind:'select',requestId:crypto.randomUUID(),connectionId:c.id,revision:c.revision,accountId:a.id});}
 function disconnect(revokeAtMeta:boolean){const c=state.current.connection;if(locked()||state.current.reading||state.current.role!=='owner'||!c||c.status==='deleted')return;void send({kind:'disconnect',requestId:crypto.randomUUID(),connectionId:c.id,revision:c.revision,revokeAtMeta});}
 const setupMessage=!s.app?'Meta setup status could not be loaded. Reload connections to check it.':!s.app.configured||!s.app.enabled?'Meta connections are not enabled on this installation. Ask the instance operator to finish Meta app setup.':!s.app.vaultConfigured?'The credential vault is unavailable. Ask the instance operator to restore it.':!s.app.httpsReady?'Meta authorization requires this installation to use HTTPS. Ask the instance operator to finish setup.':'';
 const discoveryLabel={not_loaded:'Load accounts or check a specific account ID.',loaded:'The returned list is complete for this request; it may not include every account you expect.',empty:'No accounts were returned for this grant.',partial:'Account discovery is incomplete. Load the next page or check a specific account ID.',failed:'Account discovery failed. Reload accounts or check a specific account ID.'}[s.discovery];
 const busy=s.reading||s.writeState!=='idle',owner=s.role==='owner',ready=appReady();
 return <>
  {s.role===null&&s.mode!=='connections'&&s.writeState==='idle'&&<button type="button" className="btn ghost" style={{minHeight:44}} onClick={back}>Back to connections</button>}
  <MetaConnectionView prefix={prefix} role={s.role} loaded={s.loaded} reading={s.reading} writeState={s.writeState} error={s.error} notice={s.notice} mode={s.mode} setupMessage={setupMessage} canOpenAppSetup={s.app?.operator===true} canConnect={ready} name={s.name}
   connections={s.connections.map(c=>({id:c.id,name:c.name,statusLabel:statusLabels[c.status],statusDetail:statusDetails[c.status],accountLabel:accountLabel(c.account),currencyLabel:c.account?.currency??'Unavailable',timeZoneLabel:c.account?.timeZone??'Unavailable',tokenExpiryLabel:dateLabel(c.accessExpiresAt),dataExpiryLabel:dateLabel(c.dataAccessExpiresAt),canChoose:owner&&ready&&c.status==='select_account',canReconnect:owner&&ready&&c.status!=='deleted',canDisconnect:owner&&c.status!=='disconnected'&&c.status!=='deleted'}))}
   connectionName={s.connection?.name??''} connectionAccountLabel={s.connection?.account?accountLabel(s.connection.account):null} accounts={s.accounts.map(option)} discoveryLabel={discoveryLabel} discoveryState={s.discovery} canPreviousAccounts={s.accountCursors.length>1} canNextAccounts={s.nextAccounts!==null} selectedAccount={s.selected?option(s.selected):null} accountId={s.accountId} canCheckAccount={ready&&decimal(s.accountId)} canConfirmAccount={ready&&s.connection?.status==='select_account'&&s.selected!==null} canRemoteRevoke={true} canRetrySame={intent.current!==null&&intent.current.kind!=='connect'} canRestartConnect={intent.current?.kind==='connect'} pendingActionLabel={intent.current?.kind==='connect'?'Starting Meta authorization…':intent.current?.kind==='select'?'Saving the selected account…':'Disconnecting this source…'}
   onName={name=>{if(!busy)patch({name});}} onAccountId={accountId=>{if(!busy)patch({accountId});}} onConnect={()=>connect()} onOpenAppSetup={()=>{if(!locked()&&s.app?.operator)props.onOpenAppSetup();}} onReload={()=>void loadConnections()} onChoose={id=>void open(id,'account')} onReconnect={connect} onReviewDisconnect={id=>void open(id,'disconnect')}
   onPreviousAccounts={()=>void accounts(s.accountCursors.slice(0,-1))} onNextAccounts={()=>{if(s.nextAccounts)void accounts([...s.accountCursors,s.nextAccounts]);}} onReloadAccounts={()=>void accounts()} onPickAccount={id=>{if(!busy&&owner){const found=s.accounts.find(a=>a.id===id);if(found)patch({selected:found});}}} onCheckAccount={()=>void accounts(s.accountCursors,s.accountId)} onConfirmAccount={confirm} onDisconnect={disconnect} onRetrySame={retry} onRestartConnect={restart} onBack={back}/>
  {s.role!==null&&s.mode==='connections'&&(s.connectionCursors.length>1||s.nextConnections!==null)&&<nav className="row" aria-label="Meta connection pages">
   <button type="button" className="btn ghost" style={{minHeight:44}} disabled={busy||s.connectionCursors.length<2} onClick={()=>void loadConnections(s.connectionCursors.slice(0,-1))}>Previous connections</button>
   <button type="button" className="btn ghost" style={{minHeight:44}} disabled={busy||s.nextConnections===null} onClick={()=>{if(s.nextConnections)void loadConnections([...s.connectionCursors,s.nextConnections]);}}>Next connections</button>
  </nav>}
 </>;
}
