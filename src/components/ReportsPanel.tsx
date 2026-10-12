import {useEffect,useRef,useState,type FormEvent} from 'react';
import {api,ApiError,errMsg} from '../lib/api';

type Role='owner'|'admin'|'editor'|'viewer';
type Tab='reports'|'report-templates';
type Summary={id:string;title?:string;name?:string;revision:number;createdAt:string;updatedAt:string};
type Detail=Summary&{html?:string;brief?:string};
type Listed={role:Role;reports?:Summary[];templates?:Summary[];nextCursor:string|null};
type Selected={role:Role;report?:Detail;template?:Detail};
type Share={id:string;label:string;reportRevision:number;createdAt:string;expiresAt:string;revokedAt:string|null};
type Shares={shares:Share[];nextCursor:string|null};
type Props={projectId:string;userId:string;onUnauthorized:()=>void};
const blankHtml='<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Report</title></head>\n<body>\n<h1>Report</h1>\n<table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody><tr><td>Example metric</td><td>0</td></tr></tbody></table>\n</body>\n</html>';
const label=(row:Summary)=>row.title??row.name??'';
const content=(row:Detail)=>row.html??row.brief??'';
const canShare=(role:Role|null)=>role==='owner'||role==='admin';
const date=(value:string)=>new Date(value).toLocaleString();
function localDateTime(value:Date) {
  const pad=(part:number)=>String(part).padStart(2,'0');
  return `${value.getFullYear()}-${pad(value.getMonth()+1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}
function append<T extends {id:string}>(before:T[],after:T[]) {return [...new Map([...before,...after].map(row=>[row.id,row])).values()];}

export default function ReportsPanel(props:Props) {
  // An account or project switch must discard drafts and one-time capabilities immediately.
  return <ReportsView key={`${props.userId}:${props.projectId}`} {...props}/>;
}

function ReportsView({projectId,onUnauthorized}:Props) {
  const [tab,setTab]=useState<Tab>('reports');
  const selectedTab=useRef<Tab>('reports');
  const [role,setRole]=useState<Role|null>(null);
  const [rows,setRows]=useState<Summary[]>([]);
  const [next,setNext]=useState<string|null>(null);
  const [loaded,setLoaded]=useState(false);
  const [record,setRecord]=useState<Detail|null>(null);
  const [editor,setEditor]=useState(false);
  const [title,setTitle]=useState('');
  const [body,setBody]=useState('');
  const [preview,setPreview]=useState(false);
  const [conflict,setConflict]=useState(false);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [deleteConfirm,setDeleteConfirm]=useState(false);
  const [shares,setShares]=useState<Share[]>([]);
  const [sharesLoaded,setSharesLoaded]=useState(false);
  const [sharesNext,setSharesNext]=useState<string|null>(null);
  const [oneTime,setOneTime]=useState<{id:string;url:string}|null>(null);
  const [shareLabel,setShareLabel]=useState('');
  const [expiry,setExpiry]=useState(()=>localDateTime(new Date(Date.now()+30*86400000)));
  const [shareConfirm,setShareConfirm]=useState(false);
  const [revokeConfirm,setRevokeConfirm]=useState<string|null>(null);
  const active=useRef({alive:false,generation:0,locked:false});
  const controller=useRef<AbortController|null>(null);
  const unauthorized=useRef(onUnauthorized);unauthorized.current=onUnauthorized;
  const shareField=useRef<HTMLInputElement|null>(null);
  const briefField=useRef<HTMLTextAreaElement|null>(null);
  const reports=tab==='reports',writable=role!==null&&role!=='viewer';
  const collection=`/api/projects/${projectId}/${tab}`;
  const baseline=record?content(record):reports?blankHtml:'';
  const dirty=editor&&(title!==(record?label(record):'')||body!==baseline);
  const navDisabled=pending||dirty;

  function clearEditor() {
    setRecord(null);setEditor(false);setTitle('');setBody('');setPreview(false);setConflict(false);
    setShares([]);setSharesLoaded(false);setSharesNext(null);setOneTime(null);setShareConfirm(false);setRevokeConfirm(null);setDeleteConfirm(false);
  }
  function applyRecord(value:Detail) {
    setRecord(value);setEditor(true);setTitle(label(value));setBody(content(value));setPreview(false);setConflict(false);
    setOneTime(null);setShares([]);setSharesLoaded(false);setSharesNext(null);setShareLabel(label(value));setShareConfirm(false);setRevokeConfirm(null);setDeleteConfirm(false);
    setExpiry(localDateTime(new Date(Date.now()+30*86400000)));
  }
  type Requester=<T>(path:string,body?:unknown)=>Promise<T>;
  async function readList(request:Requester,kind:Tab=selectedTab.current,cursor?:string) {
    const result=await request<Listed>(`/api/projects/${projectId}/${kind}${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`);
    setRole(result.role);setRows(previous=>cursor?append(previous,result.reports??result.templates??[]):result.reports??result.templates??[]);
    setNext(result.nextCursor);setLoaded(true);
    if(!canShare(result.role)) {setShares([]);setSharesNext(null);setOneTime(null);setShareConfirm(false);setRevokeConfirm(null);}
  }
  async function readShares(request:Requester,id:string,cursor?:string) {
    const result=await request<Shares>(`/api/projects/${projectId}/reports/${id}/shares${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`);
    setShares(previous=>cursor?append(previous,result.shares):result.shares);setSharesLoaded(true);setSharesNext(result.nextCursor);
    setOneTime(previous=>previous&&result.shares.some(share=>share.id===previous.id&&(share.revokedAt||Date.parse(share.expiresAt)<=Date.now()))?null:previous);
  }

  // One operation at a time includes its refresh and clipboard callbacks. The ref closes double-click races.
  async function run(work:(request:Requester,current:()=>boolean)=>Promise<void>) {
    if(!active.current.alive||active.current.locked) return;
    active.current.locked=true;setPending(true);setError('');setNotice('');
    const generation=active.current.generation,ac=new AbortController();controller.current=ac;
    const current=()=>active.current.alive&&active.current.generation===generation&&!ac.signal.aborted;
    const request:Requester=async<T,>(path:string,value?:unknown)=>{
      const result=await api<T>(path,{signal:ac.signal,...(value===undefined?{}:{method:'POST',body:value})});
      if(!current()) throw new DOMException('Cancelled','AbortError');return result;
    };
    try {await work(request,current);}
    catch(failure) {
      if(!current()||failure instanceof Error&&failure.name==='AbortError') return;
      if(failure instanceof ApiError&&failure.status===401) {
        clearEditor();setRole(null);setRows([]);setNext(null);setLoaded(false);unauthorized.current();return;
      }
      if(failure instanceof ApiError&&(failure.status===403||failure.status===404)) {
        clearEditor();setRole(null);setRows([]);setNext(null);setLoaded(false);
        try {await readList(request);} catch(refreshFailure) {
          if(!current()) return;
          if(refreshFailure instanceof ApiError&&refreshFailure.status===401) {unauthorized.current();return;}
        }
      }
      if(!current()) return;
      if(failure instanceof ApiError&&failure.status===409&&failure.message.startsWith('This report changed.')) setConflict(true);
      setError(errMsg(failure));
    } finally {
      if(current()) {active.current.locked=false;setPending(false);controller.current=null;}
    }
  }

  useEffect(()=>{
    active.current.alive=true;active.current.locked=false;active.current.generation++;
    void run(async request=>{await readList(request,'reports');});
    return ()=>{active.current.alive=false;active.current.generation++;active.current.locked=false;controller.current?.abort();};
  },[]);

  function switchTab(kind:Tab) {
    if(active.current.locked||dirty||kind===tab) return;
    clearEditor();setRows([]);setNext(null);setLoaded(false);setRole(null);selectedTab.current=kind;setTab(kind);
    void run(async request=>{await readList(request,kind);});
  }
  function select(id:string,reload=false) {
    if(active.current.locked||dirty&&!reload) return;
    setOneTime(null);setShareConfirm(false);setRevokeConfirm(null);setDeleteConfirm(false);setPreview(false);
    void run(async request=>{
      const result=await request<Selected>(`${collection}/${id}`),selected=result.report??result.template;
      if(!selected) throw new Error('The saved item could not be loaded. Try again.');
      setRole(result.role);applyRecord(selected);
      if(reports&&canShare(result.role)) await readShares(request,id);
    });
  }
  function create() {
    if(active.current.locked||dirty||!writable) return;
    clearEditor();setEditor(true);setBody(reports?blankHtml:'');setError('');setNotice('');
  }
  function cancel() {
    if(active.current.locked) return;
    if(record&&conflict) {select(record.id,true);return;}
    if(record) {setTitle(label(record));setBody(content(record));} else clearEditor();
    setConflict(false);setError('');setDeleteConfirm(false);
  }
  function save(event:FormEvent) {
    event.preventDefault();if(!writable||!dirty) return;
    if(reports&&new TextEncoder().encode(body).length>1048576) {setError('HTML must fit within 1 MiB. Reduce the source before saving.');return;}
    void run(async request=>{
      const input=reports?{title,html:body}:{name:title,brief:body};
      const result=await request<Selected>(`${collection}${record?`/${record.id}`:''}`,{...input,...(record?{revision:record.revision}:{})});
      const saved=result.report??result.template;if(!saved) throw new Error('The saved item could not be loaded. Refresh the list.');
      applyRecord(saved);await readList(request);if(reports&&canShare(role)) await readShares(request,saved.id);
      setNotice(reports?'Report saved. Preview the saved version before sharing.':'Template saved.');
    });
  }
  function remove() {
    if(!record||!deleteConfirm||!writable||dirty) return;
    void run(async request=>{await request(`${collection}/${record.id}/delete`,{revision:record.revision});clearEditor();await readList(request);setNotice(reports?'Report deleted. Its public links are now unavailable.':'Template deleted.');});
  }
  function share(event:FormEvent) {
    event.preventDefault();if(!record||!canShare(role)||!shareConfirm||dirty) return;
    const parsed=new Date(expiry);if(!Number.isFinite(parsed.getTime())) {setError('Choose a valid expiry date and time.');return;}
    void run(async request=>{
      const result=await request<{share:Share;url:string}>(`${collection}/${record.id}/shares`,{label:shareLabel,revision:record.revision,expiresAt:parsed.toISOString()});
      setOneTime({id:result.share.id,url:result.url});setShares(previous=>append([result.share],previous));setShareConfirm(false);
      await readShares(request,record.id);setNotice('Link created. Copy it now; the full URL is shown only once.');
    });
  }
  function revoke(id:string) {
    if(!record||revokeConfirm!==id||!canShare(role)) return;
    void run(async request=>{await request(`${collection}/${record.id}/shares/${id}/revoke`,{});setOneTime(previous=>previous?.id===id?null:previous);setRevokeConfirm(null);await readShares(request,record.id);setNotice('Link revoked. New visits cannot read this snapshot.');});
  }
  function copy(value:string,field:HTMLInputElement|HTMLTextAreaElement|null) {
    void run(async(_request,current)=>{
      try {await navigator.clipboard.writeText(value);if(current()) setNotice('Copied.');}
      catch {if(current()) {field?.focus();field?.select();setNotice('Automatic copy is unavailable. The text is selected; copy it using your device.');}}
    });
  }

  return <section aria-label='Reports and sharing'>
    <div className='card'>
      <div className='row' aria-label='Report sections'>
        <button className={`btn ${reports?'primary':''}`} aria-pressed={reports} disabled={navDisabled} onClick={()=>switchTab('reports')}>Reports</button>
        <button className={`btn ${!reports?'primary':''}`} aria-pressed={!reports} disabled={navDisabled} onClick={()=>switchTab('report-templates')}>Templates</button>
      </div>
      <p className='dim' style={{marginTop:12}}>{reports?'Save full HTML and share a static snapshot under this installation’s domain.':'Save reusable writing briefs. Templates are plain text and do not run or generate reports.'}</p>
      {dirty&&<p className='hint'>Save or cancel your edits before switching records or tabs.</p>}
      {pending&&<p role='status'>Working…</p>}
      {error&&<p className='alert' role='alert'>{error}</p>}
      {notice&&<p role='status'>{notice}</p>}
      <div className='row'>
        {writable&&<button className='btn primary' disabled={navDisabled} onClick={create}>{reports?'New report':'New template'}</button>}
        <button className='btn' disabled={navDisabled} onClick={()=>void run(async request=>{await readList(request);})}>{loaded?'Refresh list':'Retry loading'}</button>
      </div>
      {loaded&&rows.length===0&&<p className='dim' style={{marginTop:12}}>{reports?'No reports saved yet.':'No templates saved yet.'} {writable?'Create one to get started.':'Ask an editor to create one.'}</p>}
      {rows.length>0&&<div className='table-wrap'><table><thead><tr><th>Name</th><th>Revision</th><th>Updated</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}>
        <td><button className='btn ghost' style={{overflowWrap:'anywhere',textAlign:'left'}} disabled={navDisabled} onClick={()=>select(row.id)}>{label(row)}</button></td><td>{row.revision}</td><td>{date(row.updatedAt)}</td>
      </tr>)}</tbody></table></div>}
      {next&&<button className='btn' disabled={navDisabled} onClick={()=>void run(async request=>{await readList(request,tab,next);})}>Load more {reports?'reports':'templates'}</button>}
    </div>

    {editor&&<section className='card' aria-label={reports?'Report editor':'Template editor'}>
      <h2>{record?`${reports?'Report':'Template'} · saved revision ${record.revision}`:reports?'New report':'New template'}</h2>
      <form onSubmit={save}>
        <div className='field'><label htmlFor='report-title'>{reports?'Report title':'Template name'}</label><input id='report-title' value={title} maxLength={120} required readOnly={!writable} disabled={pending} onChange={event=>setTitle(event.target.value)}/></div>
        <div className='field'><label htmlFor='report-body'>{reports?'HTML source':'Template brief'}</label><textarea id='report-body' ref={briefField} value={body} required maxLength={reports?1048576:20000} readOnly={!writable||pending} className={reports?'mono':''} style={{width:'100%',minHeight:reports?280:180,resize:'vertical',padding:10}} onChange={event=>setBody(event.target.value)}/></div>
        {reports&&<p className='hint'>Your original source stays private to project members. Previews and shared snapshots remove scripts, forms, navigation and external assets. Use inline styles, static SVG or embedded raster images. Maximum HTML size: 1 MiB.</p>}
        {!writable&&<p className='dim'>Your current role can read this saved item.</p>}
        <div className='row' style={{marginTop:12}}>
          {writable&&<button className='btn primary' disabled={pending||!dirty}>{record?'Save changes':reports?'Save report':'Save template'}</button>}
          {dirty&&<button type='button' className='btn' disabled={pending} onClick={cancel}>Cancel edits</button>}
          {!reports&&<button type='button' className='btn' disabled={pending} onClick={()=>copy(body,briefField.current)}>Copy brief</button>}
          {record&&reports&&<button type='button' className='btn' disabled={pending} onClick={()=>setPreview(value=>!value)}>{preview?'Hide preview':'Preview saved report'}</button>}
          {record&&writable&&<button type='button' className='btn' disabled={pending||dirty} onClick={()=>setDeleteConfirm(true)}>{reports?'Delete report':'Delete template'}</button>}
        </div>
      </form>
      {conflict&&record&&<div className='alert'><p>The saved item changed. Your typed edits are still above. Reloading discards those edits and opens the latest saved version.</p><button className='btn' disabled={pending} onClick={()=>select(record.id,true)}>Reload saved version</button></div>}
      {deleteConfirm&&record&&<div className='alert'><p>Delete “{label(record)}”? {reports?'This permanently removes the report and makes all its public links unavailable.':'This permanently removes the writing brief.'}</p><div className='row'><button className='btn' disabled={pending||dirty} onClick={remove}>Confirm deletion</button><button className='btn ghost' disabled={pending} onClick={()=>setDeleteConfirm(false)}>Keep {reports?'report':'template'}</button></div></div>}
      {preview&&record&&reports&&<div style={{marginTop:16}}><p className='hint'>Saved revision {record.revision}. Unsaved changes are not included.</p><iframe key={`${record.id}:${record.revision}`} title='Saved report preview' src={`${collection}/${record.id}/preview?revision=${record.revision}`} sandbox='' referrerPolicy='no-referrer' style={{width:'100%',height:450,border:'1px solid var(--line)',background:'white'}}/></div>}
    </section>}

    {record&&reports&&canShare(role)&&<section className='card' aria-label='Public report links'>
      <h2>Share saved revision {record.revision}</h2>
      <p>Anyone with a link can read that snapshot until it expires or is revoked. Later edits do not change existing snapshots. Up to 20 active links can exist per report.</p>
      <form onSubmit={share}>
        <div className='field'><label htmlFor='share-label'>Link label</label><input id='share-label' value={shareLabel} maxLength={120} required disabled={pending||dirty} onChange={event=>setShareLabel(event.target.value)}/></div>
        <div className='field'><label htmlFor='share-expiry'>Link expiry</label><input id='share-expiry' type='datetime-local' value={expiry} required disabled={pending||dirty} onChange={event=>setExpiry(event.target.value)}/><p className='hint'>Use your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Choose between one hour and 365 days from now.</p></div>
        <label className='row'><input type='checkbox' style={{width:'auto'}} checked={shareConfirm} disabled={pending||dirty} onChange={event=>setShareConfirm(event.target.checked)}/>I have reviewed saved revision {record.revision} and want to share it.</label>
        <button className='btn primary' disabled={pending||dirty||!shareConfirm}>Create public link</button>
      </form>
      {oneTime&&<div style={{marginTop:16}}><label htmlFor='share-url'>One-time share URL</label><input id='share-url' ref={shareField} value={oneTime.url} readOnly/><p className='hint'>Copy this URL now. It disappears when you change records or leave this view.</p><button className='btn' disabled={pending} onClick={()=>copy(oneTime.url,shareField.current)}>Copy link</button></div>}
      <div className='row between' style={{marginTop:20}}><h2>Link history</h2><button className='btn' disabled={pending} onClick={()=>void run(async request=>{await readShares(request,record.id);})}>Refresh links</button></div>
      {shares.length===0?<p className='dim'>{sharesLoaded?'No public links have been created.':'Link history has not loaded. Choose Refresh links to try again.'}</p>:<div className='table-wrap'><table><thead><tr><th>Label</th><th>Revision</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody>{shares.map(item=>{
        const state=item.revokedAt?'Revoked':Date.parse(item.expiresAt)<=Date.now()?'Expired':'Active';
        return <tr key={item.id}><td style={{overflowWrap:'anywhere'}}>{item.label}</td><td>{item.reportRevision}</td><td>{date(item.expiresAt)}</td><td>{state}</td><td>{state==='Active'&&(revokeConfirm===item.id?<div><p>Revoke this link?</p><button className='btn' disabled={pending} onClick={()=>revoke(item.id)}>Confirm revocation</button><button className='btn ghost' disabled={pending} onClick={()=>setRevokeConfirm(null)}>Keep link</button></div>:<button className='btn' disabled={pending} onClick={()=>setRevokeConfirm(item.id)}>Revoke link</button>)}</td></tr>;
      })}</tbody></table></div>}
      {sharesNext&&<button className='btn' disabled={pending} onClick={()=>void run(async request=>{await readShares(request,record.id,sharesNext);})}>Load more links</button>}
    </section>}
  </section>;
}
