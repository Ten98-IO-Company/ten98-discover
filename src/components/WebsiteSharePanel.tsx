import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {api,ApiError} from '../lib/api';
import {newShareToken} from '../lib/boards';
import {websiteShareCreate,websiteShareRevoke,websiteShareListSchema,websiteShareWriteSchema,websiteShareLimits,type WebsiteShareItem,type WebsiteShareList,type WebsiteShareSection} from '../lib/website-shares';

type Pending={operation:'create'|'revoke';shareId:string|null;body:string};
type Draft={label:string;sections:Record<WebsiteShareSection,boolean>;expiresAt:string};
const sectionLabels:Record<WebsiteShareSection,string>={overview:'Overview',events:'Events',locations:'Regions and cities'};
const touch={minHeight:44,maxWidth:'100%',whiteSpace:'normal' as const,overflowWrap:'anywhere' as const};
const creatorText=(creator:WebsiteShareItem['creator'])=>creator===null?'Created by a deleted account':(creator.member?'Created by ':'Former member: ')+creator.name+' ('+creator.email+')';
class InvalidReply extends Error{}
type Props={projectId:string;isCurrent?:()=>boolean;onUnauthorized:()=>void};
/** Owner/admin management of public website links (P45). The token exists only in this tab and is shown once. */
export function WebsiteSharePanel({projectId,isCurrent,onUnauthorized}:Props){
 const [rows,setRows]=useState<WebsiteShareList|null>(null),[draft,setDraft]=useState<Draft|null>(null),[pending,setPending]=useState<Pending|null>(null),[secret,setSecret]=useState<{shareId:string;url:string}|null>(null);
 const [busy,setBusy]=useState(false),[writing,setWriting]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const mounted=useRef(true),readOp=useRef<AbortController|null>(null),writeLock=useRef(false),cursor=useRef<string|null>(null),back=useRef<string[]>([]),live=useRef({isCurrent,onUnauthorized});live.current={isCurrent,onUnauthorized};
 const allowed=()=>mounted.current&&(live.current.isCurrent?.()??true),base='/api/projects/'+encodeURIComponent(projectId)+'/website-shares';
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;readOp.current?.abort();};},[]);
 function refuse(cause:unknown){setRows(null);setDraft(null);setSecret(null);setPending(null);if(cause instanceof ApiError&&cause.status===401)live.current.onUnauthorized();else setError('Website sharing is unavailable for your current access. Owners and admins can manage links.');}
 async function load(next:string|null=null){
  if(!allowed())return;readOp.current?.abort();const ctrl=new AbortController();readOp.current=ctrl;setBusy(true);setError('');
  try{const result=websiteShareListSchema.parse(await api<unknown>(base+(next?'?'+new URLSearchParams({cursor:next}):''),{signal:ctrl.signal}));
   if(ctrl.signal.aborted||!allowed())return;if(result.projectId!==projectId||new Set(result.items.map(row=>row.id)).size!==result.items.length||result.nextCursor!==null&&result.nextCursor===next)throw new InvalidReply();
   cursor.current=next;setRows(result);setSecret(old=>old&&result.items.some(row=>row.id===old.shareId&&row.state!=='active')?null:old);}
  catch(cause){if(ctrl.signal.aborted||!allowed())return;if(cause instanceof ApiError&&[401,403,404].includes(cause.status))refuse(cause);else setError(cause instanceof ApiError&&cause.status===429?'Too many requests. Wait a minute, then load the links again.':'Shared links could not be read. Try loading them again.');}
  finally{if(readOp.current===ctrl){readOp.current=null;if(mounted.current)setBusy(false);}}
 }
 function newDraft(){setDraft({label:'',sections:{overview:true,events:true,locations:false},expiresAt:new Date(Date.now()+30*864e5).toISOString().slice(0,16)});setError('');setNotice('');}
 function start(operation:Pending['operation'],row?:WebsiteShareItem){
  if(!allowed()||pending||writeLock.current)return;
  try{let body:unknown;const requestId=crypto.randomUUID();
   if(operation==='revoke')body=websiteShareRevoke.parse({requestId});
   else{if(!draft)return;const expiresAt=new Date(draft.expiresAt+':00.000Z').toISOString(),lifetime=Date.parse(expiresAt)-Date.now();
    if(!(lifetime>=websiteShareLimits.minLifetimeMs&&lifetime<=websiteShareLimits.maxLifetimeMs))throw Error('Choose an expiry between one hour and 365 days from now (UTC).');
    body=websiteShareCreate.parse({requestId,label:draft.label,sections:(Object.keys(sectionLabels) as WebsiteShareSection[]).filter(key=>draft.sections[key]),expiresAt,token:newShareToken()});}
   const attempt={operation,shareId:row?.id??null,body:JSON.stringify(body)};setPending(attempt);void send(attempt);
  }catch(cause){setError(cause instanceof z.ZodError?'Name the link (1–120 characters) and choose at least one section.':cause instanceof RangeError?'Choose a valid expiry date and time.':cause instanceof Error?cause.message:'Check the shared-link fields.');}
 }
 async function send(attempt:Pending){
  if(!allowed()||writeLock.current)return;writeLock.current=true;setWriting(true);setError('');
  try{const body=JSON.parse(attempt.body),result=websiteShareWriteSchema.parse(await api<unknown>(base+(attempt.operation==='revoke'?'/'+attempt.shareId+'/revoke':''),{method:'POST',body}));if(!allowed())return;
   if(result.projectId!==projectId||result.ack.requestId!==body.requestId||result.ack.operation!==attempt.operation||attempt.shareId!==null&&result.ack.shareId!==attempt.shareId||result.item!==null&&result.item.id!==result.ack.shareId)throw new InvalidReply();
   setPending(null);setNotice(attempt.operation==='create'?'Shared link created.':'Shared link revoked. It stops working on its next read.');
   if(attempt.operation==='create'){setDraft(null);if(result.item?.state==='active'){const href=new URL('/share/websites/'+result.ack.shareId,window.location.origin);href.hash=body.token;setSecret({shareId:result.ack.shareId,url:href.href});}}
   else setSecret(old=>old?.shareId===result.ack.shareId?null:old);
   if(rows)void load(cursor.current);
  }catch(cause){if(!allowed())return;
   if(cause instanceof ApiError&&[401,403,404].includes(cause.status))refuse(cause);
   else if(cause instanceof ApiError&&[400,409].includes(cause.status)){setPending(null);setError(cause.status===409?'This request conflicts with an earlier one. Load the links, then start a new request.':'Check the shared-link fields, then start a new request.');}
   else setError('The shared-link request is unconfirmed. Retry the same request; its exact payload is kept in this tab.');}
  finally{writeLock.current=false;if(mounted.current)setWriting(false);}
 }
 return <section className="stack" aria-label="Public website links" aria-busy={busy||writing} style={{minWidth:0,overflowWrap:'anywhere'}}>
  <h3>Public website links</h3>
  <p className="hint">Owner and admin access only. Anyone with a link sees the approved sections of this website's analytics, for the dates they choose, until the link expires or is revoked. Individual sessions, visitors, event properties and filters are never shared.</p>
  <div className="row" style={{flexWrap:'wrap'}}><button className="btn" type="button" style={touch} disabled={busy} onClick={()=>{back.current=[];void load();}}>Load public links</button><button className="btn" type="button" style={touch} disabled={writing||!!pending} onClick={newDraft}>New public link</button></div>
  {error&&<p className="alert" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {pending&&<div className="banner" role="status"><p>The {pending.operation} request still needs its exact acknowledgment. Reading the current links does not acknowledge it.</p><div className="row" style={{flexWrap:'wrap'}}><button className="btn" type="button" style={touch} disabled={writing} onClick={()=>void send(pending)}>Retry the same request</button><button className="btn" type="button" style={touch} disabled={writing} onClick={()=>{setPending(null);setNotice('Retry discarded. The original request may have completed; load the links and revoke any link you cannot use.');}}>Discard the retry</button></div></div>}
  {secret&&<div className="banner stack"><label>New public website URL<input className="input" readOnly value={secret.url} onFocus={event=>event.currentTarget.select()} style={touch}/></label><button className="btn" type="button" style={touch} onClick={()=>void navigator.clipboard.writeText(secret.url).then(()=>setNotice('Public link copied.'),()=>setNotice('Select and copy the URL manually.'))}>Copy public website URL</button><p>Copy this link now. Its secret is kept only in this tab and is never returned by the server.</p></div>}
  {draft&&<fieldset className="stack" disabled={writing||!!pending}><legend>Create a public link</legend>
   <label>Link name<input className="input" maxLength={120} value={draft.label} onChange={event=>setDraft({...draft,label:event.target.value})} style={touch}/></label>
   <p className="hint">Recipients see this name as the page heading.</p>
   <fieldset><legend>Sections to share</legend>{(Object.keys(sectionLabels) as WebsiteShareSection[]).map(key=><label className="tracked-check" key={key} style={touch}><input type="checkbox" checked={draft.sections[key]} onChange={event=>setDraft({...draft,sections:{...draft.sections,[key]:event.target.checked}})}/>{sectionLabels[key]}</label>)}
    <p className="hint">Overview: totals, daily pageviews, top pages, referrers, browsers, operating systems, devices and countries. Events: custom event counts and names. Page paths, referrer hosts and event names are shown exactly as recorded. Counts are exact and recipients can choose a single day, so on a low-traffic website any section can single out individual visits; regions and cities most of all.</p></fieldset>
   <label>Link expires (UTC)<input className="input" type="datetime-local" value={draft.expiresAt} onChange={event=>setDraft({...draft,expiresAt:event.target.value})} style={touch}/></label>
   <p className="hint">Between one hour and 365 days. A link cannot be edited; to change it, revoke it and create a new one.</p>
   <div className="row" style={{flexWrap:'wrap'}}><button className="btn primary" type="button" style={touch} onClick={()=>start('create')}>Create public link</button><button className="btn" type="button" style={touch} onClick={()=>setDraft(null)}>Cancel</button></div>
  </fieldset>}
  {busy&&<p role="status">Loading public links…</p>}
  {rows&&<><p className="hint">Existing links never reveal their secrets. To replace a lost link, revoke it and create a new one.</p>
   <ul className="board-list">{rows.items.map(row=><li className="card stack" key={row.id}><h4><bdi>{row.label}</bdi></h4><p>{row.sections.map(key=>sectionLabels[key]).join(', ')}</p><p>{row.state==='active'?'Active':row.state==='expired'?'Expired':'Revoked'} · expires <time dateTime={row.expiresAt}>{row.expiresAt}</time></p><p className="hint">{creatorText(row.creator)}</p>
    {row.state!=='revoked'&&<button className="btn danger" type="button" style={touch} disabled={writing||!!pending} onClick={()=>{if(confirm('Revoke this public link now? New reads are refused immediately and the link cannot be restored. Pages already open keep what they loaded until their next refresh (up to 5 minutes).'))start('revoke',row);}}>Revoke: {row.label}</button>}</li>)}</ul>
   {!rows.items.length&&<p>No public links on this page.</p>}
   <div className="row" style={{flexWrap:'wrap'}}><button className="btn" type="button" style={touch} disabled={busy||!back.current.length} onClick={()=>void load(back.current.pop()||null)}>Previous public links</button><button className="btn" type="button" style={touch} disabled={busy||!rows.nextCursor} onClick={()=>{back.current.push(cursor.current??'');void load(rows.nextCursor);}}>Next 20 public links</button></div></>}
 </section>;
}
