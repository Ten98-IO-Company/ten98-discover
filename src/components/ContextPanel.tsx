import {useEffect, useRef, useState, type FormEvent} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {api, ApiError, errMsg} from '../lib/api';
import type {WorkspaceRole} from '@ten98/runtime';

type Section = {key:string;title:string|null;content:string;updatedAt:string;updatedBy:string};
type Competitor = {id:string;primaryDomain:string;domains:string[];name:string|null;aliases:string[];notes:string|null;updatedAt:string;updatedBy:string};
type KeyPage = {id:string;url:string;role:'hub'|'spoke'|'money'|'other';topic:string|null;notes:string|null;updatedAt:string;updatedBy:string};
type Research = {id:string;entryDate:string;summary:string;createdAt:string;createdBy:string};
type Context = {project:{id:string;name:string;origin:string};role:WorkspaceRole;revision:number;profile:{name:string;aliases:string[]};sections:Section[];missingSections:string[];customSections:Section[];competitors:Competitor[];keyPages:KeyPage[];researchLog:Research[];researchLogNextCursor:string|null;reportTemplates:{id:string;name:string;preview:string;truncated:boolean}[];reportTemplatesTruncated:boolean};
const sectionTitles = {business_overview:'Business overview',current_goal:'Current goal',positioning:'Positioning',writing_preferences:'Writing preferences'} as const;
type SectionKey = keyof typeof sectionTitles;
type Editor =
  | {kind:'business';name:string;aliases:string;sections:Record<SectionKey,string>}
  | {kind:'section';key:string;title:string;content:string;existing:boolean}
  | {kind:'competitor';primaryDomain:string;name:string;domains:string;aliases:string;notes:string;existing:boolean}
  | {kind:'key-page';url:string;role:KeyPage['role'];topic:string;notes:string;existing:boolean}
  | {kind:'research';summary:string};
type Op =
  | {kind:'profile';name?:string;aliases?:string[]}
  | {kind:'section';key:string;title?:string;content:string}
  | {kind:'remove-section';key:string}
  | {kind:'competitor';primaryDomain:string;name:string;domains:string[];aliases:string[];notes:string}
  | {kind:'key-page';url:string;role:KeyPage['role'];topic:string;notes:string}
  | {kind:'research';summary:string}
  | {kind:'remove-competitor'|'remove-key-page'|'remove-research';id:string};
type Attempt = {revision:number;requestId:string;updates:Op[]};
const lines = (value:string) => [...new Set(value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean))];
const prose = {whiteSpace:'pre-wrap',overflowWrap:'anywhere'} as const;
const textareaStyle = {width:'100%',minHeight:100,padding:10,font:'inherit',border:'1px solid var(--line)',borderRadius:8} as const;
function date(value:string) {const parsed=new Date(value);return Number.isNaN(parsed.getTime())?value:parsed.toLocaleString();}

export function ContextPanel(props:{projectId:string;userId:string;onUnauthorized:()=>void}) {
  return <ContextPanelInner key={`${props.projectId}:${props.userId}`} {...props}/>;
}
function ContextPanelInner({projectId,onUnauthorized}:{projectId:string;userId:string;onUnauthorized:()=>void}) {
  const base=`/api/projects/${encodeURIComponent(projectId)}/context`;
  const [data,setData]=useState<Context|null>(null),[editor,setEditor]=useState<Editor|null>(null);
  const [busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [conflict,setConflict]=useState(false),[retry,setRetry]=useState<Attempt|null>(null);
  const alive=useRef(true),locked=useRef(false),generation=useRef(0),controller=useRef<AbortController|null>(null);
  const unauthorized=useRef(onUnauthorized);unauthorized.current=onUnauthorized;
  const formRef=useRef<HTMLFormElement|null>(null);
  const unconfirmed=!!retry||busy==='Saving changes',protectExit=!!editor||conflict||unconfirmed;
  useBlocker({shouldBlockFn:()=>protectExit&&!window.confirm(unconfirmed?'This save may already have succeeded. Leave and lose the option to retry it? Select Cancel to stay.':'Discard the unsaved project context form and leave? Select Cancel to stay.'),enableBeforeUnload:()=>protectExit});
  function begin(label:string) {
    if(locked.current) return null;
    locked.current=true;setBusy(label);setError('');setNotice('');
    const ac=new AbortController();controller.current=ac;const gen=++generation.current;
    return {ac,gen};
  }
  function current(request:{ac:AbortController;gen:number}) {return alive.current&&request.gen===generation.current&&!request.ac.signal.aborted;}
  function finish(request:{ac:AbortController;gen:number}) {if(current(request)){locked.current=false;controller.current=null;setBusy(null);}}
  function purge() {
    generation.current++;controller.current?.abort();controller.current=null;locked.current=false;
    setData(null);setEditor(null);setRetry(null);setConflict(false);setNotice('');setBusy(null);
  }
  function accessError(e:unknown) {
    if(!(e instanceof ApiError)||![401,403,404].includes(e.status)) return false;
    purge();if(e.status===401) unauthorized.current();else setError(errMsg(e));return true;
  }
  function discard() {
    if(retry&&!window.confirm('This save may already have succeeded. Discard the local attempt and reload the saved data?')) return false;
    if(editor&&!retry&&!window.confirm('Discard the unsaved form and reload saved data?')) return false;
    return true;
  }
  async function load(ask=false) {
    if(locked.current||(ask&&!discard())) return;
    const request=begin('Loading context');if(!request)return;
    if(ask){setEditor(null);setRetry(null);setConflict(false);}
    try {const value=await api<Context>(base,{signal:request.ac.signal});if(current(request))setData(value);}
    catch(e){if(current(request)&&!accessError(e))setError(errMsg(e));}
    finally{finish(request);}
  }
  async function save(attempt:Attempt) {
    const request=begin('Saving changes');if(!request)return;
    setRetry(null);
    try {
      const value=await api<Context>(`${base}/update`,{method:'POST',body:attempt,signal:request.ac.signal});
      if(!current(request))return;
      setData(value);setEditor(null);setConflict(false);setNotice('Changes saved. No provider work was started.');
    } catch(e) {
      if(!current(request)||accessError(e))return;
      if(e instanceof ApiError&&e.status>0&&e.status<500){setError(errMsg(e));if(e.status===409)setConflict(true);}
      else {setRetry(attempt);setError('The save could not be confirmed. It may already have succeeded. Retry sends the exact same request safely.');}
    } finally{finish(request);}
  }
  async function older() {
    if(!data?.researchLogNextCursor)return;
    const request=begin('Loading older notes');if(!request)return;
    try {
      const value=await api<{entries:Research[];nextCursor:string|null}>(`${base}/research-log?cursor=${encodeURIComponent(data.researchLogNextCursor)}`,{signal:request.ac.signal});
      if(current(request))setData(previous=>previous?{...previous,researchLog:[...previous.researchLog,...value.entries.filter(row=>!previous.researchLog.some(old=>old.id===row.id))],researchLogNextCursor:value.nextCursor}:null);
    }catch(e){if(current(request)&&!accessError(e))setError(errMsg(e));}finally{finish(request);}
  }
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;generation.current++;controller.current?.abort();locked.current=false;};},[]);
  useEffect(()=>{if(editor){formRef.current?.scrollIntoView({block:'nearest'});formRef.current?.querySelector<HTMLElement>('input:not([readonly]),textarea,select')?.focus();}},[editor?.kind]);
  function open(value:Editor) {
    if(locked.current||retry||conflict)return;
    if(editor&&!window.confirm('Discard the unsaved form and edit another item?'))return;
    setEditor(value);setError('');setNotice('');formRef.current?.scrollIntoView({block:'nearest'});
  }
  function remove(op:Op,label:string) {
    if(!data||locked.current||retry||conflict||editor)return;
    if(!window.confirm(`Delete ${label}? This removes the saved content and cannot be undone.`))return;
    void save({revision:data.revision,requestId:crypto.randomUUID(),updates:[op]});
  }
  function submit(event:FormEvent) {
    event.preventDefault();if(!data||!editor||locked.current||retry||conflict)return;
    let updates:Op[]=[];
    if(editor.kind==='business') {
      const aliases=lines(editor.aliases);
      if(aliases.length>20||aliases.some(v=>v.length>120)){setError('Use up to 20 aliases, each at most 120 characters.');return;}
      if(editor.name.trim()!==data.profile.name||JSON.stringify(aliases)!==JSON.stringify(data.profile.aliases)) updates.push({kind:'profile',name:editor.name.trim(),aliases});
      for(const key of Object.keys(sectionTitles) as SectionKey[])if(editor.sections[key].trim()!==(data.sections.find(row=>row.key===key)?.content??''))updates.push({kind:'section',key,content:editor.sections[key]});
    } else if(editor.kind==='section')updates=[{kind:'section',key:editor.existing?editor.key:`custom:${editor.key}`,title:editor.title,content:editor.content}];
    else if(editor.kind==='competitor') {
      const aliases=lines(editor.aliases),domains=lines(editor.domains),allDomains=[...new Set([editor.primaryDomain.trim(),...domains])];
      if(aliases.length>20||aliases.some(v=>v.length>120)||allDomains.length>20){setError('Use up to 20 domains including the primary domain, and up to 20 aliases of 120 characters each.');return;}
      updates=[{kind:'competitor',primaryDomain:editor.primaryDomain,name:editor.name,domains:allDomains,aliases,notes:editor.notes}];
    }else if(editor.kind==='key-page')updates=[{kind:'key-page',url:editor.url,role:editor.role,topic:editor.topic,notes:editor.notes}];
    else updates=[{kind:'research',summary:editor.summary}];
    if(!updates.length){setNotice('No changes to save.');return;}
    if(updates.some(op=>op.kind==='section'&&!op.content.trim()&&[...data.sections,...data.customSections].some(row=>row.key===op.key))&&!window.confirm('Saving blank content deletes the cleared sections. Continue?'))return;
    void save({revision:data.revision,requestId:crypto.randomUUID(),updates});
  }
  const canEdit=data&&['owner','admin','editor'].includes(data.role),blocked=!!busy||!!retry||conflict;
  const businessEditor=():Editor=>({kind:'business',name:data!.profile.name,aliases:data!.profile.aliases.join('\n'),sections:Object.fromEntries((Object.keys(sectionTitles) as SectionKey[]).map(key=>[key,data!.sections.find(row=>row.key===key)?.content??''])) as Record<SectionKey,string>});
  return <section className="card" aria-label="Project context" style={{overflowWrap:'anywhere'}}>
    <div className="row between"><div><h2>Project context</h2><p className="hint">Shared knowledge for this project. Saving context does not start tracking or paid work.</p></div><button className="btn ghost" type="button" disabled={!!busy} onClick={()=>void load(true)}>Refresh</button></div>
    {busy&&<p role="status" className="dim">{busy}…</p>}
    {notice&&<p role="status" className="banner">{notice}</p>}
    {error&&<div className="alert" role="alert"><p>{error}</p>{!data&&!busy&&<button className="btn" type="button" onClick={()=>void load()}>Retry loading</button>}{retry&&<div className="row"><button className="btn primary" type="button" disabled={!!busy} onClick={()=>void save(retry)}>Retry same save</button><button className="btn ghost" type="button" disabled={!!busy} onClick={()=>void load(true)}>Discard attempt and reload</button></div>}{conflict&&<><p>Your form is unchanged. Reloading discards the draft and shows the latest saved data.</p><button className="btn" type="button" disabled={!!busy} onClick={()=>void load(true)}>Reload saved data (discard draft)</button></>}</div>}
    {data&&<>
      <p className="footnote">Saved revision {data.revision} · {canEdit?'You can edit this context.':'Read-only access.'}</p>
      {editor&&canEdit&&<form ref={formRef} onSubmit={submit} className="card" aria-label="Edit project context" style={{marginTop:16}}>
        <h3>{editor.kind==='business'?'Edit business context':editor.kind==='section'?'Custom section':editor.kind==='competitor'?'Competitor':editor.kind==='key-page'?'Key page':'Add research note'}</h3>
        <fieldset disabled={blocked} style={{border:0,padding:0,margin:0,minWidth:0}}>
          {editor.kind==='business'&&<>
            <label className="field">Brand name<input required maxLength={120} value={editor.name} onChange={e=>setEditor({...editor,name:e.target.value})}/></label>
            <label className="field">Brand aliases, one per line<textarea aria-label="Brand aliases, one per line" maxLength={2440} style={textareaStyle} value={editor.aliases} onChange={e=>setEditor({...editor,aliases:e.target.value})}/><span className="hint">Up to 20 aliases, each at most 120 characters.</span></label>
            {(Object.keys(sectionTitles) as SectionKey[]).map(key=><label className="field" key={key}>{sectionTitles[key]}<textarea aria-label={sectionTitles[key]} style={textareaStyle} maxLength={4000} value={editor.sections[key]} onChange={e=>setEditor({...editor,sections:{...editor.sections,[key]:e.target.value}})}/><span className="hint">Up to 4,000 characters. Clear the field to remove this section.</span></label>)}
          </>}
          {editor.kind==='section'&&<>
            <label className="field">Section key<input required readOnly={editor.existing} maxLength={editor.existing?67:60} pattern={editor.existing?undefined:'[a-z0-9]+(-[a-z0-9]+)*'} value={editor.key} onChange={e=>setEditor({...editor,key:e.target.value})}/><span className="hint">A short lowercase key such as audience-notes. The key stays fixed after creation.</span></label>
            <label className="field">Section title<input required maxLength={120} value={editor.title} onChange={e=>setEditor({...editor,title:e.target.value})}/></label>
            <label className="field">Section content<textarea aria-label="Section content" required={!editor.existing} maxLength={4000} style={textareaStyle} value={editor.content} onChange={e=>setEditor({...editor,content:e.target.value})}/><span className="hint">Up to 4,000 characters. Clearing a saved section removes it.</span></label>
          </>}
          {editor.kind==='competitor'&&<>
            <label className="field">Primary domain<input required readOnly={editor.existing} maxLength={253} placeholder="competitor.com" value={editor.primaryDomain} onChange={e=>setEditor({...editor,primaryDomain:e.target.value})}/><span className="hint">Public hostname only, without https://, a path or a port. It stays fixed after creation.</span></label>
            <label className="field">Competitor name<input maxLength={120} value={editor.name} onChange={e=>setEditor({...editor,name:e.target.value})}/></label>
            <label className="field">Additional domains, one per line<textarea aria-label="Additional domains, one per line" maxLength={5100} style={textareaStyle} value={editor.domains} onChange={e=>setEditor({...editor,domains:e.target.value})}/><span className="hint">Up to 19 additional hostnames. Domains cannot belong to two competitors.</span></label>
            <label className="field">Competitor aliases, one per line<textarea aria-label="Competitor aliases, one per line" maxLength={2440} style={textareaStyle} value={editor.aliases} onChange={e=>setEditor({...editor,aliases:e.target.value})}/><span className="hint">Up to 20 aliases, each at most 120 characters.</span></label>
            <label className="field">Competitor notes<textarea aria-label="Competitor notes" maxLength={500} style={textareaStyle} value={editor.notes} onChange={e=>setEditor({...editor,notes:e.target.value})}/></label>
          </>}
          {editor.kind==='key-page'&&<>
            <label className="field">Page URL<input type="url" required readOnly={editor.existing} maxLength={2048} placeholder="https://example.com/page" value={editor.url} onChange={e=>setEditor({...editor,url:e.target.value})}/><span className="hint">HTTP(S) only. Query values are stored; remove secrets before saving. The URL stays fixed after creation.</span></label>
            <label className="field">Page role<select aria-label="Page role" value={editor.role} onChange={e=>setEditor({...editor,role:e.target.value as KeyPage['role']})}><option value="other">Other</option><option value="hub">Hub</option><option value="spoke">Spoke</option><option value="money">Money page</option></select></label>
            <label className="field">Page topic<input maxLength={200} value={editor.topic} onChange={e=>setEditor({...editor,topic:e.target.value})}/></label>
            <label className="field">Page notes<textarea aria-label="Page notes" maxLength={500} style={textareaStyle} value={editor.notes} onChange={e=>setEditor({...editor,notes:e.target.value})}/></label>
          </>}
          {editor.kind==='research'&&<label className="field">Research summary<textarea aria-label="Research summary" required maxLength={1000} style={textareaStyle} value={editor.summary} onChange={e=>setEditor({...editor,summary:e.target.value})}/><span className="hint">Up to 1,000 characters. The server records the UTC date and author.</span></label>}
          <button className="btn primary" type="submit">Save changes</button>
        </fieldset>
        <button className="btn ghost" type="button" disabled={!!busy} onClick={()=>{if(retry||conflict){void load(true);return;}if(window.confirm('Discard this unsaved form?')){setEditor(null);setError('');}}}>Cancel</button>
      </form>}
      <details open style={{marginTop:18}}><summary><strong>Business context</strong></summary>
        <div className="row between" style={{marginTop:12}}><div><h3>{data.profile.name}</h3>{data.profile.aliases.length>0&&<p className="dim">Aliases: {data.profile.aliases.join(', ')}</p>}</div>{canEdit&&<button type="button" className="btn" disabled={blocked} onClick={()=>open(businessEditor())}>Edit business context</button>}</div>
        {(Object.keys(sectionTitles) as SectionKey[]).map(key=><div key={key} style={{marginBottom:16}}><h4>{sectionTitles[key]}</h4><p style={prose} className={data.sections.some(row=>row.key===key)?undefined:'dim'}>{data.sections.find(row=>row.key===key)?.content??'Not added yet.'}</p></div>)}
        <div className="row between"><h3>Custom sections ({data.customSections.length}/20)</h3>{canEdit&&<button type="button" className="btn ghost" disabled={blocked||data.customSections.length>=20} onClick={()=>open({kind:'section',key:'',title:'',content:'',existing:false})}>Add custom section</button>}</div>
        {data.customSections.length===0&&<p className="dim">No custom sections yet.</p>}
        {data.customSections.map(row=><div key={row.key} style={{marginBottom:16}}><h4>{row.title??row.key}</h4><p style={prose}>{row.content}</p><p className="hint">Updated {date(row.updatedAt)}</p>{canEdit&&<div className="row"><button className="btn ghost" type="button" disabled={blocked} onClick={()=>open({kind:'section',key:row.key,title:row.title??row.key.slice(7),content:row.content,existing:true})}>Edit {row.title??row.key}</button><button className="btn ghost" type="button" disabled={blocked||!!editor} onClick={()=>remove({kind:'remove-section',key:row.key},'this custom section')}>Delete {row.title??row.key}</button></div>}</div>)}
      </details>
      <details style={{marginTop:18}}><summary><strong>Competitors ({data.competitors.length}/100)</strong></summary><p className="hint">These records describe competitors. They do not verify domain control or enable tracking.</p>{canEdit&&<button className="btn" type="button" disabled={blocked||data.competitors.length>=100} onClick={()=>open({kind:'competitor',primaryDomain:'',name:'',domains:'',aliases:'',notes:'',existing:false})}>Add competitor</button>}
        {data.competitors.length===0?<p className="dim">No competitors saved.</p>:data.competitors.map(row=><div className="card" key={row.id} style={{marginTop:12}}><h3>{row.name||row.primaryDomain}</h3><p style={prose}>{row.domains.join('\n')}</p>{row.aliases.length>0&&<p>Aliases: {row.aliases.join(', ')}</p>}{row.notes&&<p style={prose}>{row.notes}</p>}{canEdit&&<div className="row"><button className="btn ghost" type="button" disabled={blocked} onClick={()=>open({kind:'competitor',primaryDomain:row.primaryDomain,name:row.name??'',domains:row.domains.filter(v=>v!==row.primaryDomain).join('\n'),aliases:row.aliases.join('\n'),notes:row.notes??'',existing:true})}>Edit {row.primaryDomain}</button><button className="btn ghost" type="button" disabled={blocked||!!editor} onClick={()=>remove({kind:'remove-competitor',id:row.id},'this competitor')}>Delete {row.primaryDomain}</button></div>}</div>)}
      </details>
      <details style={{marginTop:18}}><summary><strong>Key pages ({data.keyPages.length}/100)</strong></summary><p className="hint">Saved page metadata only; no URLs are fetched. Queries remain stored, so remove sensitive query values.</p>{canEdit&&<button className="btn" type="button" disabled={blocked||data.keyPages.length>=100} onClick={()=>open({kind:'key-page',url:'',role:'other',topic:'',notes:'',existing:false})}>Add key page</button>}
        {data.keyPages.length===0?<p className="dim">No key pages saved.</p>:data.keyPages.map(row=><div className="card" key={row.id} style={{marginTop:12}}><h3>{row.topic||'Key page'}</h3><p style={prose}>{row.url}</p><p className="hint">Role: {row.role}</p>{row.notes&&<p style={prose}>{row.notes}</p>}{canEdit&&<div className="row"><button className="btn ghost" type="button" disabled={blocked} onClick={()=>open({kind:'key-page',url:row.url,role:row.role,topic:row.topic??'',notes:row.notes??'',existing:true})}>Edit page {row.topic||row.url}</button><button className="btn ghost" type="button" disabled={blocked||!!editor} onClick={()=>remove({kind:'remove-key-page',id:row.id},'this key page')}>Delete page {row.topic||row.url}</button></div>}</div>)}
      </details>
      <details style={{marginTop:18}}><summary><strong>Research log</strong></summary><p className="hint">Authored notes are retained until explicitly deleted. These are notes, not provider spending receipts.</p>{canEdit&&<button className="btn" type="button" disabled={blocked} onClick={()=>open({kind:'research',summary:''})}>Add research note</button>}
        {data.researchLog.length===0?<p className="dim">No research notes saved.</p>:data.researchLog.map(row=><div key={row.id} style={{marginTop:16}}><strong>{row.entryDate} UTC</strong><p style={prose}>{row.summary}</p><p className="hint">Author ID: {row.createdBy}</p>{canEdit&&<button className="btn ghost" type="button" disabled={blocked||!!editor} onClick={()=>remove({kind:'remove-research',id:row.id},'this research note')}>Delete note from {row.entryDate}</button>}</div>)}
        {data.researchLogNextCursor&&<button className="btn" type="button" disabled={blocked} onClick={()=>void older()}>Load older entries</button>}
      </details>
      <details style={{marginTop:18}}><summary><strong>Report template summaries</strong></summary><p className="hint">Read-only previews from Reports.</p>{data.reportTemplates.length===0?<p className="dim">No report templates saved.</p>:data.reportTemplates.map(row=><div key={row.id} style={{marginTop:12}}><h3>{row.name}</h3><p style={prose}>{row.preview}</p>{row.truncated&&<p className="hint">Preview shortened to 200 characters.</p>}</div>)}{data.reportTemplatesTruncated&&<p className="hint">Showing the latest 20 templates. Open Reports to browse all templates.</p>}</details>
    </>}
  </section>;
}
