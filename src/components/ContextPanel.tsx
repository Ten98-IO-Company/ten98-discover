import {useEffect, useRef, useState, type FormEvent} from 'react';
import { Button, DataTable, Field, Heading, Inline, Input, Select, Sheet, Stack, Tabs, Text, Textarea, useConfirmDialog } from '@ten98/ui'
import {useBlocker} from '@tanstack/react-router';
import {api, ApiError, errMsg} from '../lib/api';
import {SiteAnalysisPanel} from './SiteAnalysisPanel';
import type {WorkspaceRole} from '@ten98/runtime/browser';

type Section = {key:string;title:string|null;content:string;updatedAt:string;updatedBy:string};
type Persona = {id:string;name:string;description:string;updatedAt:string;updatedBy:string};
type Competitor = {id:string;primaryDomain:string;domains:string[];name:string|null;aliases:string[];notes:string|null;updatedAt:string;updatedBy:string};
type KeyPage = {id:string;url:string;role:'hub'|'spoke'|'money'|'other';topic:string|null;notes:string|null;updatedAt:string;updatedBy:string};
type Research = {id:string;entryDate:string;summary:string;createdAt:string;createdBy:string};
type Context = {project:{id:string;name:string;origin:string};role:WorkspaceRole;revision:number;profile:{name:string;aliases:string[]};sections:Section[];missingSections:string[];customSections:Section[];personas:Persona[];competitors:Competitor[];keyPages:KeyPage[];researchLog:Research[];researchLogNextCursor:string|null;reportTemplates:{id:string;name:string;preview:string;truncated:boolean}[];reportTemplatesTruncated:boolean};
const sectionTitles = {business_overview:'Business overview',current_goal:'Current goal',positioning:'Positioning',writing_preferences:'Writing preferences'} as const;
type SectionKey = keyof typeof sectionTitles;
type Editor =
  | {kind:'business';name:string;aliases:string;sections:Record<SectionKey,string>}
  | {kind:'section';key:string;title:string;content:string;existing:boolean}
  | {kind:'persona';id:string;name:string;description:string}
  | {kind:'competitor';primaryDomain:string;name:string;domains:string;aliases:string;notes:string;existing:boolean}
  | {kind:'key-page';url:string;role:KeyPage['role'];topic:string;notes:string;existing:boolean}
  | {kind:'research';summary:string};
type Op =
  | {kind:'profile';name?:string;aliases?:string[]}
  | {kind:'section';key:string;title?:string;content:string}
  | {kind:'remove-section';key:string}
  | {kind:'persona';id:string;name:string;description:string}
  | {kind:'competitor';primaryDomain:string;name:string;domains:string[];aliases:string[];notes:string}
  | {kind:'key-page';url:string;role:KeyPage['role'];topic:string;notes:string}
  | {kind:'research';summary:string}
  | {kind:'remove-persona'|'remove-competitor'|'remove-key-page'|'remove-research';id:string};
type Attempt = {revision:number;requestId:string;updates:Op[]};
const lines = (value:string) => [...new Set(value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean))];
const prose = {whiteSpace:'pre-wrap',overflowWrap:'anywhere'} as const;
function date(value:string) {const parsed=new Date(value);return Number.isNaN(parsed.getTime())?value:parsed.toLocaleString();}

export function ContextPanel(props:{workspaceId:string;projectId:string;userId:string;headerBottom:number;onUnauthorized:()=>void}) {
  return <ContextPanelInner key={`${props.projectId}:${props.userId}`} {...props}/>;
}
function ContextPanelInner({workspaceId,projectId,userId,headerBottom,onUnauthorized}:{workspaceId:string;projectId:string;userId:string;headerBottom:number;onUnauthorized:()=>void}) {
  const base=`/api/projects/${encodeURIComponent(projectId)}/context`;
  const [tab,setTab]=useState('brand');
  const [data,setData]=useState<Context|null>(null),[editor,setEditor]=useState<Editor|null>(null);
  const [confirm,confirmDialog]=useConfirmDialog({ danger: true });
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
  async function discard() {
    if(retry&&!await confirm({title:'Discard the local attempt and reload the saved data?',description:'This save may already have succeeded.',confirmLabel:'Discard and reload'})) return false;
    if(editor&&!retry&&!await confirm({title:'Discard the unsaved form and reload saved data?',description:'Your edits in this form have not been saved.',confirmLabel:'Reload saved data',danger:false})) return false;
    return true;
  }
  async function load(ask=false) {
    if(locked.current||(ask&&!await discard())) return;
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
  async function open(value:Editor) {
    if(locked.current||retry||conflict)return;
    if(editor&&(!await confirm({title:'Discard the unsaved form and edit another item?',description:'Your edits in this form have not been saved.',confirmLabel:'Discard and edit',danger:false})||locked.current))return;
    setEditor(value);setError('');setNotice('');formRef.current?.scrollIntoView({block:'nearest'});
  }
  async function closeEditor() {
    if(locked.current)return;
    if(retry||conflict){void load(true);return;}
    if(await confirm({title:'Discard this unsaved form?',description:'Your edits in this form have not been saved.',confirmLabel:'Discard form'})){setEditor(null);setError('');}
  }
  async function remove(op:Op,label:string) {
    if(!data||locked.current||retry||conflict||editor)return;
    if(!await confirm({title:`Delete ${label}?`,description:'This removes the saved content and cannot be undone.',confirmLabel:'Delete'})||locked.current)return;
    void save({revision:data.revision,requestId:crypto.randomUUID(),updates:[op]});
  }
  async function submit(event:FormEvent) {
    event.preventDefault();if(!data||!editor||locked.current||retry||conflict)return;
    let updates:Op[]=[];
    if(editor.kind==='business') {
      const aliases=lines(editor.aliases);
      if(aliases.length>20||aliases.some(v=>v.length>120)){setError('Use up to 20 aliases, each at most 120 characters.');return;}
      if(editor.name.trim()!==data.profile.name||JSON.stringify(aliases)!==JSON.stringify(data.profile.aliases)) updates.push({kind:'profile',name:editor.name.trim(),aliases});
      for(const key of Object.keys(sectionTitles) as SectionKey[])if(editor.sections[key].trim()!==(data.sections.find(row=>row.key===key)?.content??''))updates.push({kind:'section',key,content:editor.sections[key]});
    } else if(editor.kind==='section')updates=[{kind:'section',key:editor.existing?editor.key:`custom:${editor.key}`,title:editor.title,content:editor.content}];
    else if(editor.kind==='persona') {
      if(!editor.name.trim()){setError('Enter a persona name.');return;}
      updates=[{kind:'persona',id:editor.id,name:editor.name.trim(),description:editor.description}];
    } else if(editor.kind==='competitor') {
      const aliases=lines(editor.aliases),domains=lines(editor.domains),allDomains=[...new Set([editor.primaryDomain.trim(),...domains])];
      if(aliases.length>20||aliases.some(v=>v.length>120)||allDomains.length>20){setError('Use up to 20 domains including the primary domain, and up to 20 aliases of 120 characters each.');return;}
      updates=[{kind:'competitor',primaryDomain:editor.primaryDomain,name:editor.name,domains:allDomains,aliases,notes:editor.notes}];
    }else if(editor.kind==='key-page')updates=[{kind:'key-page',url:editor.url,role:editor.role,topic:editor.topic,notes:editor.notes}];
    else updates=[{kind:'research',summary:editor.summary}];
    if(!updates.length){setNotice('No changes to save.');return;}
    if(updates.some(op=>op.kind==='section'&&!op.content.trim()&&[...data.sections,...data.customSections].some(row=>row.key===op.key))&&(!await confirm({title:'Save blank content?',description:'Saving blank content deletes the cleared sections.',confirmLabel:'Save and delete sections'})||locked.current))return;
    void save({revision:data.revision,requestId:crypto.randomUUID(),updates});
  }
  const canEdit=data&&['owner','admin','editor'].includes(data.role),blocked=!!busy||!!retry||conflict;
  const recovery=<>{retry&&<Inline wrap><Button variant="primary" type="button" disabled={!!busy} onClick={()=>void save(retry)}>Retry same save</Button><Button variant="ghost" type="button" disabled={!!busy} onClick={()=>void load(true)}>Discard attempt and reload</Button></Inline>}{conflict&&<Stack gap={2}><Text>Your form is unchanged. Reloading discards the draft and shows the latest saved data.</Text><Button variant="secondary" type="button" disabled={!!busy} onClick={()=>void load(true)}>Reload saved data (discard draft)</Button></Stack>}</>;
  const personas=data?.personas??[];
  const businessEditor=():Editor=>({kind:'business',name:data!.profile.name,aliases:data!.profile.aliases.join('\n'),sections:Object.fromEntries((Object.keys(sectionTitles) as SectionKey[]).map(key=>[key,data!.sections.find(row=>row.key===key)?.content??''])) as Record<SectionKey,string>});
  return <section className="card" aria-label="Project context" style={{overflowWrap:'anywhere'}}>
    <div className="row between"><div><h2>Project context</h2><p className="hint">Shared knowledge for this project.</p></div><Inline wrap>{data&&<SiteAnalysisPanel workspaceId={workspaceId} projectId={projectId} userId={userId} contextRevision={data.revision} onSaved={()=>void load()} onUnauthorized={onUnauthorized} disabled={!!editor||blocked}/>}{!editor&&<Button variant="ghost" type="button" disabled={!!busy} onClick={()=>void load(true)}>Refresh</Button>}</Inline></div>
    {busy&&!editor&&<p role="status" className="dim">{busy}…</p>}
    {notice&&!editor&&<p role="status" className="banner">{notice}</p>}
    {error&&!editor&&<div className="alert" role="alert"><p>{error}</p>{!data&&!busy&&<Button variant="secondary" type="button" onClick={()=>void load()}>Retry loading</Button>}{recovery}</div>}
    {data&&<>
      <p className="footnote">Saved revision {data.revision} · {canEdit?'You can edit this context.':'Read-only access.'}</p>

      <Tabs label="Project context sections" value={tab} onValueChange={setTab} items={[
        {value:'brand',label:'Brand',content:<Stack gap={4}>
        <div className="row between" style={{marginTop:12}}><div><h3>{data.profile.name}</h3>{data.profile.aliases.length>0&&<p className="dim">Aliases: {data.profile.aliases.join(', ')}</p>}</div>{canEdit&&<Button type="button" variant="secondary" disabled={blocked} onClick={()=>open(businessEditor())}>Edit business context</Button>}</div>
        {(Object.keys(sectionTitles) as SectionKey[]).map(key=><div key={key} style={{marginBottom:16}}><h4>{sectionTitles[key]}</h4><p style={prose} className={data.sections.some(row=>row.key===key)?undefined:'dim'}>{data.sections.find(row=>row.key===key)?.content??'Not added yet.'}</p></div>)}
        <div className="row between"><h3>Custom sections ({data.customSections.length}/20)</h3>{canEdit&&<Button type="button" variant="ghost" disabled={blocked||data.customSections.length>=20} onClick={()=>open({kind:'section',key:'',title:'',content:'',existing:false})}>Add custom section</Button>}</div>
        {data.customSections.length===0&&<p className="dim">No custom sections yet.</p>}
        {data.customSections.map(row=><div key={row.key} style={{marginBottom:16}}><h4>{row.title??row.key}</h4><p style={prose}>{row.content}</p><p className="hint">Updated {date(row.updatedAt)}</p>{canEdit&&<div className="row"><Button variant="ghost" type="button" disabled={blocked} onClick={()=>open({kind:'section',key:row.key,title:row.title??row.key.slice(7),content:row.content,existing:true})}>Edit {row.title??row.key}</Button><Button variant="ghost" type="button" disabled={blocked||!!editor} onClick={()=>remove({kind:'remove-section',key:row.key},'this custom section')}>Delete {row.title??row.key}</Button></div>}</div>)}
        </Stack>},
        {value:'competitors',label:'Competitors',content:<Stack gap={4}>
          <Heading level={3} size="sm">Competitors ({data.competitors.length}/100)</Heading>
          <Text size="sm" tone="muted">These records describe competitors. They do not verify domain control or enable tracking.</Text>
          {canEdit&&<Inline><Button type="button" variant="secondary" disabled={blocked||data.competitors.length>=100} onClick={()=>open({kind:'competitor',primaryDomain:'',name:'',domains:'',aliases:'',notes:'',existing:false})}>Add competitor</Button></Inline>}
          <DataTable<Competitor> ariaLabel="Competitors" rows={data.competitors} rowKey={row=>row.id} responsive="stack" searchable={false} sortable={false} pagination={false} emptyTitle="No competitors saved." emptyDescription={null} columns={[
            {key:'name',header:'Competitor',rowHeader:true,wrap:true,render:row=><Text>{row.name||row.primaryDomain}</Text>},
            {key:'primaryDomain',header:'Primary domain',wrap:true,render:row=><Text>{row.primaryDomain}</Text>}
          ]} rowDetail={row=><Stack gap={3}>
            <Stack gap={1}><Text weight="semibold">Additional domains</Text><Text preserveWhitespace>{row.domains.filter(domain=>domain!==row.primaryDomain).join('\n')||'None'}</Text></Stack>
            <Stack gap={1}><Text weight="semibold">Aliases</Text><Text preserveWhitespace>{row.aliases.join(', ')||'None'}</Text></Stack>
            <Stack gap={1}><Text weight="semibold">Notes</Text><Text preserveWhitespace>{row.notes||'No notes added.'}</Text></Stack>
          </Stack>} rowActions={canEdit?row=><Inline gap={2} wrap><Button variant="ghost" type="button" disabled={blocked} onClick={()=>open({kind:'competitor',primaryDomain:row.primaryDomain,name:row.name??'',domains:row.domains.filter(v=>v!==row.primaryDomain).join('\n'),aliases:row.aliases.join('\n'),notes:row.notes??'',existing:true})}>Edit {row.primaryDomain}</Button><Button variant="ghost" type="button" disabled={blocked||!!editor} onClick={()=>remove({kind:'remove-competitor',id:row.id},'this competitor')}>Delete {row.primaryDomain}</Button></Inline>:undefined}/>
        </Stack>},
        {value:'pages',label:'Pages',content:<Stack gap={4}>
          <Heading level={3} size="sm">Key pages ({data.keyPages.length}/100)</Heading>
          <Text size="sm" tone="muted">Saved page metadata only; no URLs are fetched. Queries remain stored, so remove sensitive query values.</Text>
          {canEdit&&<Inline><Button type="button" variant="secondary" disabled={blocked||data.keyPages.length>=100} onClick={()=>open({kind:'key-page',url:'',role:'other',topic:'',notes:'',existing:false})}>Add key page</Button></Inline>}
          <DataTable<KeyPage> ariaLabel="Pages" rows={data.keyPages} rowKey={row=>row.id} responsive="stack" searchable={false} sortable={false} pagination={false} emptyTitle="No key pages saved." emptyDescription={null} columns={[
            {key:'topic',header:'Topic',rowHeader:true,wrap:true,render:row=><Text>{row.topic||'Key page'}</Text>},
            {key:'url',header:'URL',wrap:true,render:row=><Text preserveWhitespace>{row.url}</Text>},
            {key:'role',header:'Role',render:row=>row.role}
          ]} rowDetail={row=><Stack gap={1}><Text weight="semibold">Page notes</Text><Text preserveWhitespace>{row.notes||'No notes added.'}</Text></Stack>} rowActions={canEdit?row=><Inline gap={2} wrap><Button variant="ghost" type="button" disabled={blocked} onClick={()=>open({kind:'key-page',url:row.url,role:row.role,topic:row.topic??'',notes:row.notes??'',existing:true})}>Edit page {row.topic||row.url}</Button><Button variant="ghost" type="button" disabled={blocked||!!editor} onClick={()=>remove({kind:'remove-key-page',id:row.id},'this key page')}>Delete page {row.topic||row.url}</Button></Inline>:undefined}/>
        </Stack>},
        {value:'personas',label:'Personas',content:<Stack gap={4}><Heading level={3} size="sm">Personas ({personas.length}/20)</Heading>
        <Stack gap={4}>
          <Text size="sm" tone="muted">Describe the people you want to reach.</Text>
          {canEdit&&<Inline><Button type="button" variant="secondary" disabled={blocked||personas.length>=20} onClick={()=>open({kind:'persona',id:crypto.randomUUID(),name:'',description:''})}>Add persona</Button></Inline>}
          {personas.length===0?<Text tone="muted">No personas saved.</Text>:personas.map(row=><Stack as="section" key={row.id} aria-label={row.name} gap={2}>
            <Heading level={3} size="sm">{row.name}</Heading>
            <Text preserveWhitespace tone={row.description?'default':'muted'}>{row.description||'No description added.'}</Text>
            <Text size="sm" tone="muted">Updated {date(row.updatedAt)}</Text>
            {canEdit&&<Inline gap={2}><Button variant="ghost" type="button" aria-label={`Edit persona ${row.name}`} disabled={blocked} onClick={()=>open({kind:'persona',id:row.id,name:row.name,description:row.description})}>Edit</Button><Button variant="ghost" type="button" aria-label={`Delete persona ${row.name}`} disabled={blocked||!!editor} onClick={()=>remove({kind:'remove-persona',id:row.id},'this persona')}>Delete</Button></Inline>}
          </Stack>)}
          {canEdit&&personas.length>=20&&<Text size="sm" tone="muted">You can save up to 20 personas. Delete one to add another.</Text>}
        </Stack>
        </Stack>},
        {value:'notes',label:'Notes',content:<Stack gap={4}><Heading level={3} size="sm">Research log</Heading>
<p className="hint">Authored notes are retained until explicitly deleted.</p>{canEdit&&<Button variant="secondary" type="button" disabled={blocked} onClick={()=>open({kind:'research',summary:''})}>Add research note</Button>}
        {data.researchLog.length===0?<p className="dim">No research notes saved.</p>:data.researchLog.map(row=><div key={row.id} style={{marginTop:16}}><strong>{row.entryDate} UTC</strong><p style={prose}>{row.summary}</p><p className="hint">Author ID: {row.createdBy}</p>{canEdit&&<Button variant="ghost" type="button" disabled={blocked||!!editor} onClick={()=>remove({kind:'remove-research',id:row.id},'this research note')}>Delete note from {row.entryDate}</Button>}</div>)}
        {data.researchLogNextCursor&&<Button variant="secondary" type="button" disabled={blocked} onClick={()=>void older()}>Load older entries</Button>}
<Heading level={3} size="sm">Report template summaries</Heading><p className="hint">Read-only previews from Reports.</p>{data.reportTemplates.length===0?<p className="dim">No report templates saved.</p>:data.reportTemplates.map(row=><div key={row.id} style={{marginTop:12}}><h3>{row.name}</h3><p style={prose}>{row.preview}</p>{row.truncated&&<p className="hint">Preview shortened to 200 characters.</p>}</div>)}{data.reportTemplatesTruncated&&<p className="hint">Showing the latest 20 templates. Open Reports to browse all templates.</p>}</Stack>}
      ]}/>
      {editor&&canEdit&&<Sheet open modal={false} topInset={headerBottom} width="sm" onClose={()=>void closeEditor()} closeDisabled={!!busy} busy={busy==='Saving changes'} unconfirmed={retry?error:undefined} error={!retry&&error?error:undefined} recovery={retry||conflict?recovery:undefined}
        actions={<Button variant="ghost" type="button" disabled={!!busy} onClick={()=>void load(true)}>Refresh</Button>}
        title={editor.kind==='business'?'Edit business context':editor.kind==='section'?'Custom section':editor.kind==='persona'?'Persona':editor.kind==='competitor'?'Competitor':editor.kind==='key-page'?'Key page':'Add research note'}>
      <form ref={formRef} onSubmit={submit} aria-label="Edit project context">
        {notice&&<p role="status" className="banner">{notice}</p>}
        <fieldset disabled={blocked} style={{border:0,padding:0,margin:0,minWidth:0}}>
          {editor.kind==='business'&&<>
            <Field label="Brand name" htmlFor="context-field-1"><Input id="context-field-1" required maxLength={120} value={editor.name} onChange={e=>setEditor({...editor,name:e.target.value})}/></Field>
            <Field label="Brand aliases, one per line" htmlFor="context-field-2" description="Up to 20 aliases, each at most 120 characters."><Textarea id="context-field-2" aria-label="Brand aliases, one per line" maxLength={2440} value={editor.aliases} onChange={e=>setEditor({...editor,aliases:e.target.value})}/></Field>
            {(Object.keys(sectionTitles) as SectionKey[]).map(key=><Field key={key} label={sectionTitles[key]} htmlFor={`context-${key}`} description="Up to 4,000 characters. Clear the field to remove this section."><Textarea id={`context-${key}`} aria-label={sectionTitles[key]} maxLength={4000} value={editor.sections[key]} onChange={e=>setEditor({...editor,sections:{...editor.sections,[key]:e.target.value}})}/></Field>)}
          </>}
          {editor.kind==='section'&&<>
            <Field label="Section key" htmlFor="context-field-3" description="A short lowercase key such as audience-notes. The key stays fixed after creation."><Input id="context-field-3" required readOnly={editor.existing} maxLength={editor.existing?67:60} pattern={editor.existing?undefined:'[a-z0-9]+(-[a-z0-9]+)*'} value={editor.key} onChange={e=>setEditor({...editor,key:e.target.value})}/></Field>
            <Field label="Section title" htmlFor="context-field-4"><Input id="context-field-4" required maxLength={120} value={editor.title} onChange={e=>setEditor({...editor,title:e.target.value})}/></Field>
            <Field label="Section content" htmlFor="context-field-5" description="Up to 4,000 characters. Clearing a saved section removes it."><Textarea id="context-field-5" aria-label="Section content" required={!editor.existing} maxLength={4000} value={editor.content} onChange={e=>setEditor({...editor,content:e.target.value})}/></Field>
          </>}
          {editor.kind==='persona'&&<Stack gap={4}>
            <Field label="Persona name" htmlFor="context-persona-name" required><Input id="context-persona-name" required maxLength={120} value={editor.name} onChange={e=>setEditor({...editor,name:e.target.value})}/></Field>
            <Field label="Persona description" htmlFor="context-persona-description" description="Describe their needs, goals and interests. Up to 4,000 characters."><Textarea id="context-persona-description" maxLength={4000} value={editor.description} onChange={e=>setEditor({...editor,description:e.target.value})}/></Field>
          </Stack>}
          {editor.kind==='competitor'&&<>
            <Field label="Primary domain" htmlFor="context-field-6" description="Public hostname only, without https://, a path or a port. It stays fixed after creation."><Input id="context-field-6" required readOnly={editor.existing} maxLength={253} placeholder="competitor.com" value={editor.primaryDomain} onChange={e=>setEditor({...editor,primaryDomain:e.target.value})}/></Field>
            <Field label="Competitor name" htmlFor="context-field-7"><Input id="context-field-7" maxLength={120} value={editor.name} onChange={e=>setEditor({...editor,name:e.target.value})}/></Field>
            <Field label="Additional domains, one per line" htmlFor="context-field-8" description="Up to 19 additional hostnames. Domains cannot belong to two competitors."><Textarea id="context-field-8" aria-label="Additional domains, one per line" maxLength={5100} value={editor.domains} onChange={e=>setEditor({...editor,domains:e.target.value})}/></Field>
            <Field label="Competitor aliases, one per line" htmlFor="context-field-9" description="Up to 20 aliases, each at most 120 characters."><Textarea id="context-field-9" aria-label="Competitor aliases, one per line" maxLength={2440} value={editor.aliases} onChange={e=>setEditor({...editor,aliases:e.target.value})}/></Field>
            <Field label="Competitor notes" htmlFor="context-field-10"><Textarea id="context-field-10" aria-label="Competitor notes" maxLength={500} value={editor.notes} onChange={e=>setEditor({...editor,notes:e.target.value})}/></Field>
          </>}
          {editor.kind==='key-page'&&<>
            <Field label="Page URL" htmlFor="context-field-11" description="HTTP(S) only. Query values are stored; remove secrets before saving. The URL stays fixed after creation."><Input id="context-field-11" type="url" required readOnly={editor.existing} maxLength={2048} placeholder="https://example.com/page" value={editor.url} onChange={e=>setEditor({...editor,url:e.target.value})}/></Field>
            <Field label="Page role" htmlFor="context-field-12"><Select id="context-field-12" aria-label="Page role" value={editor.role} onChange={e=>setEditor({...editor,role:e.target.value as KeyPage['role']})}><option value="other">Other</option><option value="hub">Hub</option><option value="spoke">Spoke</option><option value="money">Money page</option></Select></Field>
            <Field label="Page topic" htmlFor="context-field-13"><Input id="context-field-13" maxLength={200} value={editor.topic} onChange={e=>setEditor({...editor,topic:e.target.value})}/></Field>
            <Field label="Page notes" htmlFor="context-field-14"><Textarea id="context-field-14" aria-label="Page notes" maxLength={500} value={editor.notes} onChange={e=>setEditor({...editor,notes:e.target.value})}/></Field>
          </>}
          {editor.kind==='research'&&<Field label="Research summary" htmlFor="context-field-15" description="Up to 1,000 characters. The server records the UTC date and author."><Textarea id="context-field-15" aria-label="Research summary" required maxLength={1000} value={editor.summary} onChange={e=>setEditor({...editor,summary:e.target.value})}/></Field>}
          <Button variant="primary" type="submit">Save changes</Button>
        </fieldset>
        <Button variant="ghost" type="button" disabled={!!busy} onClick={()=>void closeEditor()}>Cancel</Button>
      </form></Sheet>}
    </>}
    {confirmDialog}
  </section>;
}
