import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {FunnelBreakdown} from '@ten98/ui';
import {api,ApiError,errMsg} from '../lib/api';
import {MatchFields,PropertyFields,type MatchDraft,type PropertyDraft} from './AnalysisCriteriaFields';
import type {AnalysisDefinition,AnalysisStep,PropertyPredicate} from '../server/funnel-input';
import type {AnalysisItem,AnalysisKind,AnalysisResult,AnalysisWitnessResult} from '../server/funnels';

type Role='owner'|'admin'|'editor'|'viewer';
type Props={projectId:string;userId:string;onUnauthorized:()=>void};
type StepDraft=MatchDraft&{pageViewsOnly:boolean;properties:PropertyDraft[]};
type DefinitionDraft={name:string;description:string;windowMinutes:string;steps:StepDraft[];condition:MatchDraft};
type Scope={from:string;to:string;timeZone:string;filters:Record<string,{on:boolean;value:string}>;property:{on:boolean;key:string;type:string;value:string}};
type Intent={action:'save'|'delete';path:string;body:Record<string,unknown>;id:string|null};
const filterFields=[['eventName','Event name'],['path','Path'],['origin','Origin'],['referrer','Referrer'],['language','Language'],['campaignSource','Campaign source'],['campaignMedium','Campaign medium'],['campaignName','Campaign name'],['campaignTerm','Campaign term'],['campaignContent','Campaign content']] as const;
const propTypes=['missing','string','number','boolean','null','date','array'];
const match=():MatchDraft=>({type:'path',match:'exact',value:''});
const step=():StepDraft=>({...match(),pageViewsOnly:false,properties:[]});
const blank=():DefinitionDraft=>({name:'',description:'',windowMinutes:'60',steps:[step(),step()],condition:match()});
function initialScope():Scope{const today=new Date();return{from:new Date(today.getTime()-6*864e5).toISOString().slice(0,10),to:today.toISOString().slice(0,10),timeZone:'UTC',filters:Object.fromEntries(filterFields.map(([key])=>[key,{on:false,value:''}])),property:{on:false,key:'',type:'missing',value:''}};}
function editDraft(item:AnalysisItem):DefinitionDraft{
  const d=item.definition;
  return {...blank(),name:d.name,description:d.description,...(d.kind==='goal'?{condition:{...d.condition}}:{windowMinutes:String(d.windowMinutes),steps:d.steps.map(s=>({...s,properties:s.properties.map(p=>({key:p.key,operator:p.operator,type:p.operator==='missing'?'string':p.type,valueText:p.operator==='missing'?'':JSON.stringify(p.value)}))}))})};
}
function definition(kind:AnalysisKind,draft:DefinitionDraft):AnalysisDefinition{
  const base={name:draft.name.trim(),description:draft.description.trim()};
  if(kind==='goal')return{kind,...base,condition:{...draft.condition}};
  const steps:AnalysisStep[]=draft.steps.map((s,index)=>({...s,properties:s.properties.map(p=>{
    if(p.operator==='missing')return{key:p.key,operator:p.operator};
    let value:unknown;try{value=JSON.parse(p.valueText);}catch{throw new Error(`Step ${index+1}: enter a valid JSON value for each property filter.`);}
    if((p.operator==='contains'||p.operator==='not_contains')&&typeof value!=='string')throw new Error(`Step ${index+1}: contains filters need a JSON string in quotes.`);
    return{key:p.key,operator:p.operator,type:p.type,value} as PropertyPredicate;
  })}));
  return{kind,...base,windowMinutes:Number(draft.windowMinutes),steps};
}
function scopeParams(scope:Scope):string{
  const p=new URLSearchParams({from:scope.from,to:scope.to,timeZone:scope.timeZone.trim()});
  for(const [key]of filterFields)if(scope.filters[key].on)p.set(key,scope.filters[key].value);
  if(scope.property.on){p.set('propertyKey',scope.property.key);p.set('propertyType',scope.property.type);if(scope.property.type!=='missing')p.set('propertyValue',scope.property.value);}
  return p.toString();
}
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const roles=['owner','admin','editor','viewer'];
const roleValue=(v:unknown):v is Role=>typeof v==='string'&&roles.includes(v);
const metric=(v:unknown)=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0;
const rateValue=(v:unknown)=>metric(v)&&(v===null||(v as number)<=1);
const matchValue=(v:unknown)=>record(v)&&['path','event'].includes(String(v.type))&&['exact','prefix','suffix','contains'].includes(String(v.match))&&typeof v.value==='string';
const date=(v:string)=>new Date(v).toLocaleString();
const number=(v:number|null)=>v===null?'Unavailable':v.toLocaleString();
const percent=(v:number|null)=>v===null?'Unavailable':new Intl.NumberFormat(undefined,{style:'percent',maximumFractionDigits:1}).format(v);
export function validItem(v:unknown,projectId:string,kind:AnalysisKind):v is AnalysisItem{
  if(!record(v)||typeof v.id!=='string'||v.projectId!==projectId||!Number.isInteger(v.revision)||(v.revision as number)<1||typeof v.createdAt!=='string'||typeof v.updatedAt!=='string'||!record(v.definition))return false;
  const d=v.definition;if(d.kind!==kind||typeof d.name!=='string'||typeof d.description!=='string')return false;
  return kind==='goal'?matchValue(d.condition):Number.isInteger(d.windowMinutes)&&Array.isArray(d.steps)&&d.steps.length>=2&&d.steps.length<=8&&d.steps.every(s=>matchValue(s)&&record(s)&&typeof s.pageViewsOnly==='boolean'&&Array.isArray(s.properties)&&s.properties.every(p=>record(p)&&typeof p.key==='string'&&['missing','eq','neq','contains','not_contains'].includes(String(p.operator))&&(p.operator==='missing'||propTypes.includes(String(p.type))&&'value'in p)));
}
export function matchLabel(m:MatchDraft,goal=false,pageViewsOnly=false){return `${m.type==='event'?'Custom event':goal||pageViewsOnly?'Viewed page':'Activity at path'} · ${m.match==='exact'?'equals':m.match==='prefix'?'starts with':m.match==='suffix'?'ends with':'contains'} ${m.value}`;}

export function ConversionsPanel(props:Props){return <Panel key={props.userId+':'+props.projectId} {...props}/>;}
function Panel({projectId,onUnauthorized}:Props){
  const uid=useId(),[kind,setKind]=useState<AnalysisKind>('funnel'),kindRef=useRef(kind);
  const [role,setRole]=useState<Role|null>(null),[items,setItems]=useState<AnalysisItem[]>([]),[nextCursor,setNextCursor]=useState<string|null>(null);
  const [view,setView]=useState<'list'|'editor'|'result'|'witnesses'>('list'),[selected,setSelected]=useState<AnalysisItem|null>(null);
  const [opening,setOpening]=useState<{id:string;edit:boolean}|null>(null);
  const [draft,setDraft]=useState<DefinitionDraft>(blank),[dirty,setDirty]=useState(false),[scope,setScope]=useState<Scope>(initialScope),[applied,setApplied]=useState('');
  const [result,setResult]=useState<AnalysisResult|null>(null),[witness,setWitness]=useState<AnalysisWitnessResult|null>(null);
  const [reading,setReading]=useState(false),[writing,setWriting]=useState(false),[loaded,setLoaded]=useState(false),[denied,setDenied]=useState(false),[conflict,setConflict]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[intent,setIntent]=useState<Intent|null>(null);
  const alive=useRef(false),epoch=useRef(0),readRef=useRef<AbortController|null>(null),writeRef=useRef<object|null>(null),intentRef=useRef<Intent|null>(null),unauthorized=useRef(onUnauthorized);
  const pendingFocus=useRef<string|null>(null),resultFocus=useRef<string|null>(null),listFocus=useRef<string|null>(null);unauthorized.current=onUnauthorized;
  const base=()=>'/api/projects/'+encodeURIComponent(projectId)+'/'+(kindRef.current==='funnel'?'funnels':'goals');
  function stopRead(){epoch.current++;readRef.current?.abort();readRef.current=null;setReading(false);}
  function resetIntent(){intentRef.current=null;setIntent(null);}
  function clear(){stopRead();setRole(null);setItems([]);setSelected(null);setOpening(null);setResult(null);setWitness(null);setNextCursor(null);setDraft(blank());setScope(initialScope());setApplied('');setDirty(false);setConflict(false);setLoaded(false);setView('list');setMessage('');resetIntent();}
  function failure(e:unknown){
    if(e instanceof ApiError&&[401,403,404].includes(e.status)){clear();setDenied(true);if(e.status===401)unauthorized.current();}
    if(e instanceof ApiError&&e.status===409)setConflict(true);
    setError(errMsg(e));
  }
  async function read<T>(path:string,commit:(data:T)=>void){
    if(writeRef.current)return;stopRead();const controller=new AbortController(),generation=epoch.current;readRef.current=controller;setReading(true);setError('');
    try{const data=await api<T>(path,{signal:controller.signal});if(alive.current&&!controller.signal.aborted&&generation===epoch.current)commit(data);}
    catch(e){if(alive.current&&!controller.signal.aborted&&generation===epoch.current)failure(e);}
    finally{if(alive.current&&generation===epoch.current){readRef.current=null;setReading(false);}}
  }
  function loadList(cursor?:string){
    return read<unknown>(base()+(cursor?'?'+new URLSearchParams({cursor}):''),data=>{
      if(!record(data)||!roleValue(data.role)||!Array.isArray(data.items)||!data.items.every(v=>validItem(v,projectId,kindRef.current))||data.nextCursor!==null&&typeof data.nextCursor!=='string')throw new Error('The saved list was incomplete. Reload it.');
      setRole(data.role);setDenied(false);setItems(old=>cursor?[...old,...(data.items as AnalysisItem[]).filter(item=>!old.some(v=>v.id===item.id))]:data.items as AnalysisItem[]);setNextCursor(data.nextCursor as string|null);setLoaded(true);
      if(!cursor&&pendingFocus.current&&!data.items.some(item=>pendingFocus.current===uid+'open-'+item.id))pendingFocus.current=uid+'list';
    });
  }
  function checkResult(data:unknown,item:AnalysisItem):asserts data is AnalysisResult{
    if(!record(data)||!roleValue(data.role)||!validItem(data.item,projectId,kindRef.current)||data.item.id!==item.id||data.item.revision!==item.revision||!record(data.range)||!['from','to','timeZone','start','end'].every(k=>typeof (data.range as Record<string,unknown>)[k]==='string')||typeof data.generatedAt!=='string'||!record(data.coverage)||!['complete','partial','unavailable'].includes(String(data.coverage.status))||!record(data.identity)||!['complete','partial','unavailable'].includes(String(data.identity.status))||!['identifiedEvents','unidentifiedEvents','visitors'].every(k=>metric((data.identity as Record<string,unknown>)[k]))||!Array.isArray(data.steps)||!data.steps.every(s=>record(s)&&Number.isInteger(s.step)&&metric(s.visitors)&&metric(s.dropped)&&rateValue(s.conversionRate)&&rateValue(s.remainingRate))||!(data.goal===null||record(data.goal)&&metric(data.goal.visitors)&&metric(data.goal.totalVisitors)&&rateValue(data.goal.rate)))throw new Error('The conversion result was incomplete. Reload the results.');
    if(item.definition.kind==='funnel'?(data.steps.length!==item.definition.steps.length||data.steps.some((s,i)=>s.step!==i+1)||data.goal!==null):(data.steps.length!==0||data.goal===null))throw new Error('The conversion result did not match the saved definition. Reload it.');
  }
  function evaluate(item:AnalysisItem,query=scopeParams(scope),focus=false){
    setResult(null);setWitness(null);setConflict(false);setView('result');setApplied(query);if(focus)pendingFocus.current=uid+'result';
    const params=new URLSearchParams(query);params.set('revision',String(item.revision));
    return read<unknown>(base()+'/'+item.id+'/result?'+params,data=>{checkResult(data,item);setRole(data.role);setSelected(data.item);setResult(data);});
  }
  function openItem(id:string,edit=false){
    if(writeRef.current||intentRef.current)return;setOpening({id,edit});setSelected(null);setDraft(blank());setResult(null);setWitness(null);setConflict(false);setError('');setMessage('');setView(edit?'editor':'result');listFocus.current=uid+'open-'+id;
    return read<unknown>(base()+'/'+id,data=>{
      if(!record(data)||!roleValue(data.role)||!validItem(data.item,projectId,kindRef.current)||data.item.id!==id)throw new Error('The saved definition was incomplete. Reload it.');
      setRole(data.role);setSelected(data.item);setOpening(null);setDenied(false);
      if(edit){setDraft(editDraft(data.item));setDirty(false);pendingFocus.current=uid+'editor';}
      else{const item=data.item;queueMicrotask(()=>{if(alive.current)void evaluate(item,scopeParams(scope),true);});}
    });
  }
  function leave(){if(writeRef.current||intentRef.current)return false;if(dirty&&!window.confirm('Discard your unsaved definition changes?'))return false;setDirty(false);return true;}
  function list(){if(!leave())return;stopRead();setView('list');setSelected(null);setOpening(null);setResult(null);setWitness(null);setDraft(blank());setConflict(false);setError('');pendingFocus.current=listFocus.current||uid+'list';void loadList();}
  function changeKind(next:AnalysisKind){if(next===kindRef.current||!leave())return;clear();kindRef.current=next;setKind(next);setDenied(false);setError('');pendingFocus.current=uid+'list';void loadList();}
  function create(){if(!leave()||!role||role==='viewer')return;stopRead();setDraft(blank());setSelected(null);setOpening(null);setView('editor');setConflict(false);setMessage('');setError('');pendingFocus.current=uid+'editor';}
  async function mutate(pending:Intent){
    if(writeRef.current||!alive.current)return;stopRead();const token={};writeRef.current=token;setWriting(true);setError('');setMessage('');const generation=epoch.current;
    let saved:AnalysisItem|null=null,removed=false;
    try{
      const data=await api<unknown>(pending.path,{method:'POST',body:pending.body});if(!alive.current||generation!==epoch.current)return;
      if(!record(data)||!roleValue(data.role)||typeof data.deleted!=='boolean'||typeof data.replayed!=='boolean')throw new Error('The save acknowledgement was incomplete.');
      if(pending.action==='delete'?(data.deleted!==true||data.id!==pending.id):(data.deleted?data.item!==null:!validItem(data.item,projectId,kindRef.current)||(pending.id!==null&&data.item.id!==pending.id)))throw new Error('The acknowledgement did not match this definition.');
      resetIntent();setRole(data.role);setDirty(false);setConflict(false);
      if(data.deleted){removed=true;setSelected(null);setResult(null);setWitness(null);setView('list');setMessage(pending.action==='delete'?'Definition deleted. Collected events are unchanged.':'The earlier save was accepted, and this definition has since been deleted.');pendingFocus.current=uid+'list';}
      else{const item=data.item as AnalysisItem;saved=item;setSelected(item);setDraft(editDraft(item));setMessage(data.replayed?'The original save was confirmed. The current saved definition is shown.':'Definition saved.');setView('result');setResult(null);}
    }catch(e){if(alive.current&&generation===epoch.current){if(!(e instanceof ApiError)||e.status===0||e.status>=500)setError(errMsg(e)+' The outcome is unknown. Retry the same request to confirm it.');else{resetIntent();failure(e);}}}
    finally{if(writeRef.current===token){writeRef.current=null;if(alive.current)setWriting(false);}}
    if(alive.current&&generation===epoch.current&&!intentRef.current){
      if(removed)void loadList();else if(saved)void evaluate(saved,scopeParams(scope),true);
    }
  }
  function save(e:FormEvent){
    e.preventDefault();if(writeRef.current||reading||opening||conflict||!role||role==='viewer')return;
    if(intentRef.current){void mutate(intentRef.current);return;}
    try{const value=definition(kind,draft),pending:Intent={action:'save',path:base()+(selected?'/'+selected.id+'/update':''),body:{requestId:crypto.randomUUID(),...(selected?{revision:selected.revision}:{}),definition:value},id:selected?.id??null};intentRef.current=pending;setIntent(pending);void mutate(pending);}catch(e){setError(errMsg(e));}
  }
  function remove(){
    if(writeRef.current||intentRef.current||!selected||!role||role==='viewer'||!window.confirm(`Delete “${selected.definition.name}”? This removes its saved definition. Collected events are unchanged.`))return;
    const pending:Intent={action:'delete',path:base()+'/'+selected.id+'/delete',body:{requestId:crypto.randomUUID(),revision:selected.revision},id:selected.id};intentRef.current=pending;setIntent(pending);void mutate(pending);
  }
  function inspect(stepNumber:number,cursor?:string){
    if(!selected||writeRef.current||intentRef.current)return;
    if(!cursor){resultFocus.current=uid+'evidence-'+stepNumber;setWitness(null);pendingFocus.current=uid+'witness';}setView('witnesses');
    const params=new URLSearchParams(applied);params.set('revision',String(selected.revision));params.set('step',String(stepNumber));if(cursor)params.set('cursor',cursor);
    void read<unknown>(base()+'/'+selected.id+'/witnesses?'+params,data=>{
      checkResult(data,selected);const w=data as AnalysisWitnessResult;
      if(w.step!==stepNumber||!Array.isArray(w.witnesses)||!w.witnesses.every(v=>record(v)&&Array.isArray(v.events)&&v.events.length===stepNumber&&v.events.every(e=>record(e)&&(['id','eventName','path','origin','receivedAt']as const).every(k=>typeof e[k]==='string')))||w.nextCursor!==null&&typeof w.nextCursor!=='string')throw new Error('The matching activity was incomplete. Reload the results.');
      setRole(w.role);setResult(w);setWitness(old=>cursor&&old?{...w,witnesses:[...old.witnesses,...w.witnesses.filter(row=>!old.witnesses.some(prior=>prior.events.at(-1)?.id===row.events.at(-1)?.id))]}:w);
    });
  }
  useEffect(()=>{alive.current=true;void loadList();return()=>{alive.current=false;epoch.current++;readRef.current?.abort();};},[]);
  useEffect(()=>{if(!pendingFocus.current)return;const element=document.getElementById(pendingFocus.current);if(element){element.focus();pendingFocus.current=null;}});
  const locked=writing||!!intent,managed=role!==null&&role!=='viewer',unapplied=scopeParams(scope)!==applied;
  const patch=(value:Partial<DefinitionDraft>)=>{setDraft(d=>({...d,...value}));setDirty(true);};
  const selectedDefinition=selected?.definition;
  return <section className="research-panel conversions" aria-label="Conversions">
    <div className="row conversion-tabs" role="group" aria-label="Conversion type">{(['funnel','goal']as const).map(k=><button key={k} className={'btn'+(kind===k?' primary':'')} aria-pressed={kind===k} disabled={locked} onClick={()=>changeKind(k)}>{k==='funnel'?'Funnels':'Goals'}</button>)}</div>
    {error&&<div className="alert" role="alert">{error} {denied&&<button className="btn" disabled={reading} onClick={()=>void loadList()}>Reload access</button>}</div>}
    {message&&<p className="notice" role="status">{message}</p>}
    {intent&&!writing&&<div className="banner"><p>The original request is kept unchanged until its outcome is confirmed.</p><button className="btn primary" onClick={()=>void mutate(intent)}>Retry same {intent.action}</button></div>}
    {conflict&&selected&&<p className="banner">The saved definition changed. <button className="btn" disabled={locked} onClick={()=>{if(!dirty||window.confirm('Discard this draft and load the latest saved definition?'))void openItem(selected.id,view==='editor');}}>Reload saved definition</button></p>}
    {view==='list'?<div className="card">
      <div className="row between"><h2 tabIndex={-1} id={uid+'list'}>Saved {kind==='funnel'?'funnels':'goals'}</h2><div className="row"><button className="btn" disabled={locked||reading} onClick={()=>void loadList()}>Refresh list</button>{managed&&<button className="btn primary" disabled={locked} onClick={create}>New {kind}</button>}</div></div>
      <p className="hint">{kind==='funnel'?'Measure how estimated visitors move through ordered activity.':'Measure which estimated visitors complete a page view or custom event.'}</p>
      {reading&&<p role="status">Loading saved definitions…</p>}
      {loaded&&!items.length&&<div className="empty"><p>No saved {kind==='funnel'?'funnels':'goals'} yet.</p><p>{managed?'Create a definition to measure your collected events.':'An editor can create the first definition.'}</p></div>}
      {!!items.length&&<div className="table-wrap" role="region" aria-label="Saved conversion definitions" tabIndex={0}><table><thead><tr><th>Name</th><th>Definition</th><th>Updated</th><th>Action</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td>{item.definition.name}</td><td>{item.definition.kind==='funnel'?`${item.definition.steps.length} steps · ${item.definition.windowMinutes} minutes between steps`:matchLabel(item.definition.condition,true)}</td><td>{date(item.updatedAt)}</td><td><button className="btn" disabled={locked} id={uid+'open-'+item.id} onClick={()=>void openItem(item.id)}>View results</button></td></tr>)}</tbody></table></div>}
      {nextCursor&&<button className="btn" disabled={reading||locked} onClick={()=>void loadList(nextCursor)}>Load more definitions</button>}
    </div>:<>
      <button className="btn ghost" disabled={locked} onClick={view==='witnesses'?()=>{stopRead();setView('result');pendingFocus.current=resultFocus.current;}:list}>← Back to {view==='witnesses'?'results':'list'}</button>
      {opening&&<p role="status">{reading?'Loading saved definition…':<button className="btn" onClick={()=>void openItem(opening.id,opening.edit)}>Retry loading definition</button>}</p>}
      {view==='editor'?<form className="card stack" onSubmit={save}>
        <h2 tabIndex={-1} id={uid+'editor'}>{selected||opening?.edit?'Edit':'New'} {kind}</h2>
        {!managed?<p className="notice">Your current role can inspect saved definitions.</p>:<fieldset disabled={locked||reading||!!opening} className="conversion-fields">
          <div className="field"><label htmlFor={uid+'name'}>Name</label><input id={uid+'name'} required maxLength={200} value={draft.name} onChange={e=>patch({name:e.target.value})}/></div>
          <details><summary>Description</summary><label htmlFor={uid+'description'}>Description (optional)</label><textarea id={uid+'description'} maxLength={500} value={draft.description} onChange={e=>patch({description:e.target.value})}/></details>
          {kind==='goal'?<MatchFields idPrefix={uid+'goal'} pathLabel="Viewed page" value={draft.condition} onChange={condition=>patch({condition})} disabled={locked}/>:<>
            <div className="field"><label htmlFor={uid+'window'}>Minutes between steps</label><input id={uid+'window'} type="number" min={1} max={1440} step={1} required value={draft.windowMinutes} onChange={e=>patch({windowMinutes:e.target.value})}/><p className="hint">Each step must follow the previous step within this window, in strictly later receipt time.</p></div>
            {draft.steps.map((s,index)=><fieldset key={index} className="conversion-step"><legend>Step {index+1}</legend>
              <MatchFields idPrefix={uid+'step-'+index} pathLabel="Activity at path" value={s} disabled={locked} onChange={value=>patch({steps:draft.steps.map((old,i)=>i===index?{...old,...value,pageViewsOnly:value.type==='event'?false:old.pageViewsOnly}:old)})}/>
              {s.type==='path'&&<label className="row"><input type="checkbox" checked={s.pageViewsOnly} onChange={e=>patch({steps:draft.steps.map((old,i)=>i===index?{...old,pageViewsOnly:e.target.checked}:old)})}/>Page views only</label>}
              {(s.type==='event'||s.properties.length>0)&&<><PropertyFields idPrefix={uid+'properties-'+index} items={s.properties} disabled={locked} onChange={properties=>patch({steps:draft.steps.map((old,i)=>i===index?{...old,properties}:old)})}/>{s.type==='path'&&<p className="banner">Remove these property filters or choose Custom event before saving this step.</p>}</>}
              <div className="row"><button type="button" className="btn" aria-label={`Move step ${index+1} up`} disabled={index===0} onClick={()=>{const steps=[...draft.steps];[steps[index-1],steps[index]]=[steps[index],steps[index-1]];patch({steps});}}>Move up</button><button type="button" className="btn" aria-label={`Move step ${index+1} down`} disabled={index===draft.steps.length-1} onClick={()=>{const steps=[...draft.steps];[steps[index],steps[index+1]]=[steps[index+1],steps[index]];patch({steps});}}>Move down</button><button type="button" className="btn" aria-label={`Remove step ${index+1}`} disabled={draft.steps.length<=2} onClick={()=>patch({steps:draft.steps.filter((_,i)=>i!==index)})}>Remove step</button></div>
            </fieldset>)}
            <button type="button" className="btn" disabled={draft.steps.length>=8} onClick={()=>patch({steps:[...draft.steps,step()]})}>Add step</button>
          </>}
        </fieldset>}
        <div className="row">{managed&&<button className="btn primary" type="submit" disabled={locked||reading||!!opening||conflict}>{writing?'Saving…':`Save ${kind}`}</button>}<button className="btn" type="button" disabled={locked} onClick={list}>Cancel editing</button></div>
      </form>:<>
        {selected&&<div className="row between"><h2 id={uid+'result'} tabIndex={-1}>{selected.definition.name}</h2>{managed&&<div className="row"><button className="btn" disabled={locked} onClick={()=>void openItem(selected.id,true)}>Edit definition</button><button className="btn" disabled={locked} onClick={remove}>Delete definition</button></div>}</div>}
        {view==='result'&&selected&&<>
          <details className="card"><summary>Saved definition · revision {selected.revision}</summary>{selectedDefinition?.kind==='funnel'?<><p>{selectedDefinition.windowMinutes} minutes between adjacent steps.</p><ol>{selectedDefinition.steps.map((s,i)=><li key={i}>{matchLabel(s,false,s.pageViewsOnly)}{s.properties.length>0&&<span> · {s.properties.length} property conditions</span>}</li>)}</ol></>:selectedDefinition?.kind==='goal'?<p>{matchLabel(selectedDefinition.condition,true)}</p>:null}</details>
          <form className="card stack" onSubmit={e=>{e.preventDefault();void evaluate(selected);}}>
            <fieldset disabled={locked} className="conversion-fields"><div className="explorer-toolbar">{(['from','to']as const).map(key=><div key={key}><label htmlFor={uid+key}>{key==='from'?'From':'To'}</label><input id={uid+key} type="date" required value={scope[key]} onChange={e=>setScope(old=>({...old,[key]:e.target.value}))}/></div>)}<div><label htmlFor={uid+'zone'}>Time zone</label><input id={uid+'zone'} required maxLength={80} value={scope.timeZone} onChange={e=>setScope(old=>({...old,timeZone:e.target.value}))} placeholder="Asia/Dubai"/></div></div>
              <p className="hint">Whole calendar days in this time zone. All participating activity must fall within the selected period.</p>
              <details><summary>More filters</summary><p className="hint">Exact filters apply to every step and to the goal population.</p>{filterFields.map(([key,label])=><div className="field" key={key}><label className="row"><input type="checkbox" checked={scope.filters[key].on} onChange={e=>setScope(old=>({...old,filters:{...old.filters,[key]:{...old.filters[key],on:e.target.checked}}}))}/>Filter by {label.toLowerCase()}</label><label htmlFor={uid+'scope-'+key}>{label} equals</label><input id={uid+'scope-'+key} disabled={!scope.filters[key].on} value={scope.filters[key].value} onChange={e=>setScope(old=>({...old,filters:{...old.filters,[key]:{...old.filters[key],value:e.target.value}}}))}/></div>)}
                <label className="row"><input type="checkbox" checked={scope.property.on} onChange={e=>setScope(old=>({...old,property:{...old.property,on:e.target.checked}}))}/>Filter by event property</label>
                {scope.property.on&&<div className="stack"><div className="field"><label htmlFor={uid+'scope-property'}>Property key</label><input id={uid+'scope-property'} required maxLength={320} value={scope.property.key} onChange={e=>setScope(old=>({...old,property:{...old.property,key:e.target.value}}))}/></div><div className="field"><label htmlFor={uid+'scope-type'}>Property type</label><select id={uid+'scope-type'} value={scope.property.type} onChange={e=>setScope(old=>({...old,property:{...old.property,type:e.target.value}}))}>{propTypes.map(type=><option key={type}>{type}</option>)}</select></div>{scope.property.type!=='missing'&&<div className="field"><label htmlFor={uid+'scope-value'}>Property value (JSON)</label><input id={uid+'scope-value'} required value={scope.property.value} onChange={e=>setScope(old=>({...old,property:{...old.property,value:e.target.value}}))} placeholder={'"starter", 42, true, null'}/></div>}</div>}
              </details>
            </fieldset><div className="row"><button className="btn primary" type="submit" disabled={locked||reading||conflict}>Apply filters</button><button className="btn" type="button" disabled={locked||reading||conflict} onClick={()=>void evaluate(selected,applied||scopeParams(scope))}>Refresh results</button></div>{unapplied&&result&&<p role="status" className="hint">You have unapplied filter changes. The results show the previous scope.</p>}
          </form>
        </>}
        {reading&&<p role="status">Loading {view==='witnesses'?'matching activity':'conversion results'}…</p>}
        {result&&<>
          <p className="hint">{result.range.from} through {result.range.to} · {result.range.timeZone} · Report generated {date(result.generatedAt)}</p>
          {result.coverage.status!=='complete'&&<p className="banner">{result.coverage.status==='partial'?'Part of this period has expired. Visitor counts are observed lower bounds; rates and drop-offs are unavailable.':'Event evidence for this period is unavailable.'}</p>}
          {result.identity.status==='unavailable'?<p className="notice">No retained visitor identities are available for this scope. Conversion counts cannot be established.</p>:<p className="hint">Estimated visitors use rotating monthly identities and can span visits. {number(result.identity.unidentifiedEvents)} observations without a visitor identity are excluded.</p>}
          {view==='result'&&(kind==='funnel'?<FunnelBreakdown label="Funnel conversion results" countLabel="Estimated visitors" context={<p>Saved revision {result.item.revision} · {result.range.from} through {result.range.to} · {result.range.timeZone} · {selectedDefinition?.kind==='funnel'&&selectedDefinition.windowMinutes} minutes between adjacent steps · Strictly later receipt time.</p>} steps={result.steps.map(s=>({id:String(s.step),label:`${s.step}. ${selectedDefinition?.kind==='funnel'?matchLabel(selectedDefinition.steps[s.step-1],false,selectedDefinition.steps[s.step-1].pageViewsOnly):''}`,count:s.visitors===null?null:number(s.visitors),reason:s.visitors===null?(result.coverage.status==='unavailable'?'Event evidence for this period is unavailable.':'No retained visitor identities are available for this scope.'):undefined,conversion:s.remainingRate===null?null:percent(s.remainingRate)+' overall',conversionReason:result.coverage.status!=='complete'?'Rates are unavailable because event history is incomplete.':result.identity.status==='unavailable'?'Rates are unavailable because retained visitor identities are unavailable.':'The first step has no estimated visitors, so the overall rate has no denominator.',detail:<><p>Drop-off: {s.step===1?'—':number(s.dropped)} · From previous: {s.step===1?'—':percent(s.conversionRate)}</p><button className="btn" id={uid+'evidence-'+s.step} disabled={locked||reading||s.visitors===null||s.visitors===0} onClick={()=>inspect(s.step)}>View matching activity</button></>}))}/>:result.goal&&<div className="card"><div className="metric-grid"><div><p className="metric-value">{number(result.goal.visitors)}</p><p className="metric-label">Visitors reaching the goal</p></div><div><p className="metric-value">{number(result.goal.totalVisitors)}</p><p className="metric-label">Visitors in the selected scope</p></div><div><p className="metric-value">{percent(result.goal.rate)}</p><p className="metric-label">Goal conversion rate</p></div></div><button className="btn" id={uid+'evidence-1'} disabled={locked||reading||result.goal.visitors===null||result.goal.visitors===0} onClick={()=>inspect(1)}>View matching activity</button></div>)}
        </>}
        {view==='witnesses'&&<div className="card stack"><h2 id={uid+'witness'} tabIndex={-1}>Matching activity{witness?` for ${kind==='funnel'?'step '+witness.step:'this goal'}`:''}</h2><p className="hint">One observed chain per estimated visitor. These are fresh reads; new events or retention cleanup can change later pages.</p>{witness&&!witness.witnesses.length&&<p>No matching retained activity remains. Refresh the results.</p>}{witness?.witnesses.map((row,i)=><div className="conversion-witness" key={row.events.at(-1)!.id}><h3>Observed visitor {i+1}</h3><ol>{row.events.map(e=><li key={e.id}><p>{e.path}</p><p className="hint">{e.eventName} · <time dateTime={e.receivedAt}>{e.receivedAt}</time> · {e.origin}</p></li>)}</ol></div>)}{witness?.nextCursor&&<button className="btn" disabled={reading||locked} onClick={()=>inspect(witness.step,witness.nextCursor!)}>Load more matching activity</button>}</div>}
      </>}
    </>}
  </section>;
}
