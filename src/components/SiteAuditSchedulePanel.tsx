import {useEffect,useId,useRef,useState} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {z} from 'zod';
import {workspaceRoles,type WorkspaceRole} from '@ten98/runtime/browser';
import {Button,Checkbox,DataTable,Field,Heading,Inline,Input,Option,Select,Sheet,Stack,Text,Tooltip,useConfirmDialog} from '@ten98/ui';
import {api,ApiError,errMsg} from '../lib/api';
import {siteAuditScheduleMutationResponse,siteAuditScheduleResponse,siteAuditScheduleSave,type SiteAuditSchedule,type SiteAuditScheduleResponse} from '../lib/site-audit-recurring';
import {siteAuditAccessResponse,type SiteAuditAccessBinding} from '../lib/site-audit-access';

type Props={projectId:string;userId:string;disabled?:boolean;onUnauthorized:()=>void;onOpenRun:(id:string)=>void};
type Draft={domainId:string;startPath:string;maxPages:string;retainBodyText:boolean;includeQueryUrls:boolean;crawlerAccess:SiteAuditAccessBinding|null;interval:'daily'|'weekly'|'monthly';timezone:string;time:string;weekday:string};
type Attempt={operation:'save'|'pause';body:{requestId:string;expectedRevision:number;calendar?:SiteAuditSchedule['calendar'];definition?:SiteAuditSchedule['definition']}};
const setupSchema=z.object({role:z.enum(workspaceRoles),crawlerAccess:siteAuditAccessResponse.shape.credentials.default([]),origins:z.array(z.object({domainId:z.uuid().nullable(),origin:z.string().url()})),limits:z.object({defaultPages:z.number().int().positive(),maxPages:z.number().int().positive()})});
type Setup=z.infer<typeof setupSchema>;
const manages=(role:WorkspaceRole|null)=>role==='owner'||role==='admin';
const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function date(value:string|null,timezone:string){if(!value)return 'Not scheduled';try{return new Date(value).toLocaleString(undefined,{timeZone:timezone,year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});}catch{return 'Unavailable';}}
function draftFrom(schedule:SiteAuditSchedule|null,setup:Setup):Draft{
 const calendar=schedule?.calendar;
 return {domainId:schedule?(schedule.definition.domainId??''):(setup.origins[0]?.domainId??''),crawlerAccess:schedule?.definition.crawlerAccess?{...schedule.definition.crawlerAccess}:null,startPath:schedule?.definition.startPath??'/',maxPages:String(schedule?.definition.maxPages??setup.limits.defaultPages),retainBodyText:schedule?.definition.retainBodyText??false,includeQueryUrls:schedule?.definition.includeQueryUrls??false,interval:calendar?.interval??'weekly',timezone:calendar?.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone,time:calendar?`${String(calendar.hour).padStart(2,'0')}:${String(calendar.minute).padStart(2,'0')}`:'09:00',weekday:String(calendar?.weekday??1)};
}
export function SiteAuditSchedulePanel(props:Props){return <SchedulePanel key={props.userId+':'+props.projectId} {...props}/>;}
function SchedulePanel({projectId,disabled=false,onUnauthorized,onOpenRun}:Props){
 const base=`/api/projects/${encodeURIComponent(projectId)}/audits/schedule`,uid=useId();
 const [open,setOpen]=useState(false),[role,setRole]=useState<WorkspaceRole|null>(null),[schedule,setSchedule]=useState<SiteAuditSchedule|null>(null),[setup,setSetup]=useState<Setup|null>(null);
 const [draft,setDraft]=useState<Draft|null>(null),[savedDraft,setSavedDraft]=useState<Draft|null>(null),[busy,setBusy]=useState(false),[writing,setWriting]=useState(false),[pending,setPending]=useState<Attempt|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[conflict,setConflict]=useState(false),[refreshFailed,setRefreshFailed]=useState(false);
 const [confirm,confirmDialog]=useConfirmDialog({danger:true});
 const mounted=useRef(true),operation=useRef<AbortController|null>(null),pendingRef=useRef<Attempt|null>(null),writingRef=useRef(false),roleRef=useRef<WorkspaceRole|null>(null),revisionRef=useRef<number|null>(null);
 const callbacks=useRef({onUnauthorized,onOpenRun}),domainControl=useRef<HTMLSelectElement>(null);callbacks.current={onUnauthorized,onOpenRun};
 const dirty=draft!==null&&JSON.stringify(draft)!==JSON.stringify(savedDraft),locked=writing||pending!==null,editable=manages(role)&&draft!==null;
 const stateRef=useRef({dirty,open});stateRef.current={dirty,open};
 function keepAttempt(value:Attempt|null){pendingRef.current=value;setPending(value);}
 function purge(message:string){
  operation.current?.abort();operation.current=null;writingRef.current=false;setBusy(false);setWriting(false);keepAttempt(null);roleRef.current=null;revisionRef.current=null;
  setRole(null);setSchedule(null);setSetup(null);setDraft(null);setSavedDraft(null);setConflict(false);setRefreshFailed(false);setNotice('');setError(message);
 }
 function accessFailure(cause:unknown){if(!(cause instanceof ApiError)||![401,403,404].includes(cause.status))return false;purge(errMsg(cause));if(cause.status===401)callbacks.current.onUnauthorized();return true;}
 function begin(write=false){if(operation.current||!mounted.current)return null;const controller=new AbortController();operation.current=controller;writingRef.current=write;setBusy(true);setWriting(write);setError('');return controller;}
 function current(controller:AbortController){return mounted.current&&operation.current===controller&&!controller.signal.aborted;}
 function finish(controller:AbortController){if(current(controller)){operation.current=null;writingRef.current=false;setBusy(false);setWriting(false);}}
 function apply(value:SiteAuditScheduleResponse,origins:Setup,preserve=false){
  const nextRole=manages(value.role)&&!manages(origins.role)?origins.role:value.role;
  roleRef.current=nextRole;setRefreshFailed(false);setRole(nextRole);setSchedule(value.schedule);setSetup(origins);
  if(!manages(nextRole)){setDraft(null);setSavedDraft(null);keepAttempt(null);setConflict(false);setNotice('');}
  else if(!preserve){const next=draftFrom(value.schedule,origins);setDraft(next);setSavedDraft(next);setConflict(false);}
  else if(revisionRef.current!==(value.schedule?.revision??0))setConflict(true);
  revisionRef.current=value.schedule?.revision??0;
 }
 async function load(preserve=false){
  if(pendingRef.current)return;const controller=begin();if(!controller)return;
  try{
   const reads=await Promise.allSettled([api(base,{signal:controller.signal}),api(`/api/projects/${encodeURIComponent(projectId)}/audits/setup`,{signal:controller.signal})]);
   if(!current(controller))return;
   // A failed setup read must not hide access revoked by the other response.
   for(const read of reads)if(read.status==='rejected'&&read.reason instanceof ApiError&&[401,403,404].includes(read.reason.status))throw read.reason;
   const [raw,originRaw]=reads.map(read=>{if(read.status==='rejected')throw read.reason;return read.value;});
   const value=siteAuditScheduleResponse.parse(raw),origins=setupSchema.parse(originRaw);
   if(value.projectId!==projectId)throw Error('The schedule belongs to another project.');
   apply(value,origins,preserve&&stateRef.current.dirty);
  }catch(cause){if(current(controller)&&!accessFailure(cause)){roleRef.current=null;setRefreshFailed(true);setNotice('');setError(cause instanceof z.ZodError?'The saved schedule could not be verified. Retry refresh.':errMsg(cause));}}finally{finish(controller);}
 }
 async function send(attempt:Attempt){
  if(!manages(roleRef.current)||pendingRef.current&&pendingRef.current!==attempt)return;
  const replay=pendingRef.current!==null;let posted=false;const controller=begin(true);if(!controller)return;const captured=pendingRef.current??structuredClone(attempt);keepAttempt(captured);setNotice('');
  try{
   const definition=captured.body.definition;
   if(!replay&&captured.operation==='save'&&definition?.crawlerAccess){
    const live=setupSchema.parse(await api(`/api/projects/${encodeURIComponent(projectId)}/audits/setup`,{signal:controller.signal}));if(!current(controller))return;setSetup(live);roleRef.current=live.role;setRole(live.role);
    if(!manages(live.role)){setDraft(null);setSavedDraft(null);keepAttempt(null);throw new Error('Your current access does not allow scheduling audits.');}
    const origin=setup?.origins.find(item=>item.domainId===definition.domainId)?.origin;
    if(!live.origins.some(item=>item.domainId===definition.domainId&&item.origin===origin)||!live.crawlerAccess.some(item=>item.id===definition.crawlerAccess!.id&&item.revision===definition.crawlerAccess!.revision&&item.domainId===definition.domainId&&item.origin===origin&&!item.revokedAt&&Date.parse(item.expiresAt)>Date.now()))throw new Error('The selected crawler access is unavailable or changed. Choose saved access again before enabling.');
   }
   posted=true;
   const raw=await api(base+(captured.operation==='pause'?'/pause':''),{method:'POST',body:captured.body,signal:controller.signal});
   if(!current(controller))return;const value=siteAuditScheduleMutationResponse.parse(raw);
   if(value.projectId!==projectId||value.ack.requestId!==captured.body.requestId||value.ack.operation!==captured.operation||value.ack.revision!==captured.body.expectedRevision+1||!value.schedule||value.schedule.revision<value.ack.revision)throw Error('The schedule acknowledgement could not be matched.');
   if(captured.operation==='save'&&((value.ack.crawlerAccess?.id??null)!==(definition?.crawlerAccess?.id??null)||(value.ack.crawlerAccess?.revision??null)!==(definition?.crawlerAccess?.revision??null)))throw Error('The schedule acknowledgement did not match the selected crawler access.');
   if(captured.operation==='save'&&value.schedule.revision===value.ack.revision){
    const definition=captured.body.definition!,origin=setup?.origins.find(item=>item.domainId===definition.domainId)?.origin;
    if(!origin)throw Error('The schedule origin could not be matched.');const startUrl=new URL(definition.startPath,origin);
    if(value.schedule.origin!==origin||value.schedule.definition.startPath!==startUrl.href.slice(startUrl.origin.length)||(value.schedule.definition.includeQueryUrls??false)!==(definition.includeQueryUrls??false)||(value.schedule.definition.crawlerAccess?.id??null)!==(definition.crawlerAccess?.id??null)||(value.schedule.definition.crawlerAccess?.revision??null)!==(definition.crawlerAccess?.revision??null))throw Error('The schedule acknowledgement did not match the query policy, start URL or crawler access.');
   }
   keepAttempt(null);if(setup)apply(value,setup);setNotice(manages(value.role)?value.schedule.revision>value.ack.revision?'Original request confirmed. Showing the latest schedule.':captured.operation==='save'?'Recurring audits enabled.':'Recurring audits paused.':'');
  }catch(cause){
   if(!current(controller)||accessFailure(cause))return;
   if(!posted&&!replay){keepAttempt(null);setError(errMsg(cause));}
   else if(!(cause instanceof ApiError)||cause.status===0||cause.status===408||cause.status===429||cause.status>=500)setError('The response could not be confirmed. This action may already have succeeded.');
   else{keepAttempt(null);setError(errMsg(cause));if(cause.status===409)setConflict(true);}
  }finally{finish(controller);}
 }
 function save(){
  if(!draft||!setup||locked||busy||conflict||refreshFailed||!manages(roleRef.current)||draft.crawlerAccess&&!selectedAccess)return;
  const [hour,minute]=draft.time.split(':').map(Number);
  const body={requestId:crypto.randomUUID(),expectedRevision:schedule?.revision??0,calendar:{interval:draft.interval,timezone:draft.timezone,hour,minute,weekday:draft.interval==='weekly'?Number(draft.weekday):null},definition:{mode:'static' as const,domainId:draft.domainId||null,startPath:draft.startPath,maxPages:Number(draft.maxPages),retainBodyText:draft.retainBodyText,includeQueryUrls:draft.includeQueryUrls,...(draft.crawlerAccess?{crawlerAccess:draft.crawlerAccess}:{})}};
  const checked=siteAuditScheduleSave.safeParse(body);
  if(!checked.success||!/^\d{2}:\d{2}$/.test(draft.time)||!setup.origins.some(value=>(value.domainId??'')===draft.domainId)||!draft.startPath.startsWith('/')||draft.startPath.startsWith('//')||draft.startPath.includes('#')||!draft.includeQueryUrls&&draft.startPath.includes('?')||Number(draft.maxPages)>setup.limits.maxPages){setError('Choose an eligible domain, a rooted path without a fragment, a valid page limit and calendar. Enable query URLs to include query parameters.');return;}
  try{new Intl.DateTimeFormat(undefined,{timeZone:draft.timezone});}catch{setError('Enter a valid IANA time zone, such as Asia/Dubai.');return;}
  void send({operation:'save',body:checked.data});
 }
 async function reload(){
  if(locked||busy)return;if(!refreshFailed&&dirty&&!await confirm({title:'Discard schedule edits and reload?',description:'Review the latest saved schedule before enabling it.',confirmLabel:'Reload schedule'}))return;
  setNotice('');await load(refreshFailed);if(mounted.current&&stateRef.current.open)requestAnimationFrame(()=>domainControl.current?.focus());
 }
 async function close(runId?:string){
  if(writingRef.current||pendingRef.current)return;
  if(stateRef.current.dirty&&!await confirm({title:'Discard unsaved schedule edits?',description:'Your saved schedule will stay as it is.',confirmLabel:'Discard edits'}))return;
  stateRef.current={dirty:false,open:false};operation.current?.abort();operation.current=null;setBusy(false);setOpen(false);setDraft(null);setSavedDraft(null);setConflict(false);setNotice('');if(runId)callbacks.current.onOpenRun(runId);
 }
 function edit(change:Partial<Draft>){if(!locked&&!busy&&!conflict&&manages(roleRef.current))setDraft(value=>value?{...value,...change}:value);}
 useBlocker({shouldBlockFn:()=>stateRef.current.open&&(writingRef.current||pendingRef.current!==null||stateRef.current.dirty)&&(writingRef.current||pendingRef.current!==null||!window.confirm('Discard unsaved schedule edits and leave?')),enableBeforeUnload:()=>stateRef.current.open&&(writingRef.current||pendingRef.current!==null||stateRef.current.dirty)});
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;operation.current?.abort();};},[]);
 useEffect(()=>{if(!open)return;const refresh=()=>{if(!document.hidden&&!operation.current&&!pendingRef.current)void load(true);};window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh);},[open]);
 const blocked=locked||busy||conflict||refreshFailed;
 const selectedOrigin=setup?.origins.find(item=>(item.domainId??'')===draft?.domainId);
 const eligibleAccess=(setup?.crawlerAccess??[]).filter(item=>item.domainId===selectedOrigin?.domainId&&item.origin===selectedOrigin?.origin&&!item.revokedAt&&Date.parse(item.expiresAt)>Date.now());
 const selectedAccess=draft?.crawlerAccess?eligibleAccess.find(item=>item.id===draft.crawlerAccess!.id&&item.revision===draft.crawlerAccess!.revision):null;
 const savedAccess=schedule?.definition.crawlerAccess?setup?.crawlerAccess.find(item=>item.id===schedule.definition.crawlerAccess!.id&&item.revision===schedule.definition.crawlerAccess!.revision):null;
 return <><Button variant="secondary" disabled={disabled||open} onClick={()=>{setOpen(true);void load();}}>Schedule audits</Button>
 {open&&<Sheet open modal={false} title="Schedule audits" width="md" busy={writing} closeDisabled={locked} onClose={()=>void close()} error={!pending&&error?error:undefined} unconfirmed={pending&&!writing?error||'The action may already have succeeded.':undefined}
  recovery={pending&&!writing?<Button onClick={()=>void send(pending)}>Retry same request</Button>:undefined}
  footer={editable?<Inline wrap>{schedule?.enabled&&<Button variant="secondary" disabled={blocked||dirty} onClick={()=>void send({operation:'pause',body:{requestId:crypto.randomUUID(),expectedRevision:schedule.revision}})}>Pause recurring audits</Button>}<Button disabled={blocked||!setup?.origins.length||!!draft?.crawlerAccess&&!selectedAccess} onClick={save}>{schedule?'Save and enable':'Enable recurring audits'}</Button></Inline>:undefined}>
  <Stack gap={5}>
   {busy&&!writing&&<Text role="status">Loading schedule…</Text>}
   {notice&&<Text role="status">{notice}</Text>}
   {role&&<Inline wrap><Text weight="semibold">{schedule?.enabled?'Recurring audits enabled':schedule?'Recurring audits paused':'No recurring audits'}</Text><Button variant="ghost" disabled={locked||busy} onClick={()=>void reload()}>{refreshFailed?'Retry refresh':conflict?'Reload latest schedule':'Refresh schedule'}</Button></Inline>}
   {!role&&!busy&&<Button onClick={()=>void load()}>Reload access</Button>}
   {conflict&&<Text role="alert">The schedule changed. Reload and review it before saving.</Text>}
   {schedule&&<Stack gap={2}><Text>Next occurrence: {date(schedule.nextDueAt,schedule.calendar.timezone)}</Text><Text size="sm" tone="muted">{schedule.calendar.timezone} · {schedule.calendar.interval==='monthly'?'Last day of month':schedule.calendar.interval==='weekly'?weekdays[schedule.calendar.weekday!]: 'Daily'}</Text>{schedule.lastStatus&&<Text size="sm">Latest status: {schedule.lastStatus.replaceAll('_',' ')}</Text>}</Stack>}
   {editable&&draft&&setup?<Stack gap={4}>
    <Field label="Audit domain" htmlFor={uid+'domain'}><Select ref={domainControl} id={uid+'domain'} value={draft.domainId} disabled={blocked} onChange={event=>edit({domainId:event.target.value,crawlerAccess:null})}>{!setup.origins.length&&<Option value="">No eligible domain</Option>}{setup.origins.map(value=><Option key={value.domainId??'canonical'} value={value.domainId??''}>{value.origin}</Option>)}</Select></Field>
    <Field label="Saved crawler access" htmlFor={uid+'access'}><Select id={uid+'access'} value={draft.crawlerAccess?draft.crawlerAccess.id+':'+draft.crawlerAccess.revision:''} disabled={blocked} onChange={event=>{const item=eligibleAccess.find(value=>value.id+':'+value.revision===event.target.value);edit({crawlerAccess:item?{id:item.id,revision:item.revision}:null});}}><Option value="">None — unsigned audit</Option>{draft.crawlerAccess&&!selectedAccess&&<Option value={draft.crawlerAccess.id+':'+draft.crawlerAccess.revision} disabled>Selected access unavailable — choose again</Option>}{eligibleAccess.map(item=><Option key={item.id+':'+item.revision} value={item.id+':'+item.revision}>{item.verification==='verified'?'Verified':'Unverified'} Shopify access · revision {item.revision} · expires {date(item.expiresAt,'UTC')}</Option>)}</Select></Field>
    {draft.crawlerAccess&&!selectedAccess&&<Text role="alert">Selected crawler access is unavailable. Choose another saved revision or an unsigned audit.</Text>}
    {selectedAccess&&<Text size="sm" tone="muted">{selectedAccess.verification==='verified'?'Verified':'Unverified'} crawler access · expires {date(selectedAccess.expiresAt,'UTC')}</Text>}
    <Field label="Start path" htmlFor={uid+'path'}><Input id={uid+'path'} value={draft.startPath} disabled={blocked} maxLength={2048} onChange={event=>edit({startPath:event.target.value})}/></Field>
    <Field label="Maximum HTML pages" htmlFor={uid+'pages'} description={`Up to ${setup.limits.maxPages} pages per audit`}><Input id={uid+'pages'} type="number" min={1} max={setup.limits.maxPages} step={1} value={draft.maxPages} disabled={blocked} onChange={event=>edit({maxPages:event.target.value})}/></Field>
    <Tooltip content="Exact query variants are crawled separately under the same page limit."><Checkbox label="Include URLs with query parameters" checked={draft.includeQueryUrls} disabled={blocked} onChange={event=>edit({includeQueryUrls:event.target.checked})}/></Tooltip>
    <Checkbox label="Retain page body text" checked={draft.retainBodyText} disabled={blocked} onChange={event=>edit({retainBodyText:event.target.checked})}/>
    <Field label="Repeat" htmlFor={uid+'interval'}><Select id={uid+'interval'} value={draft.interval} disabled={blocked} onChange={event=>edit({interval:event.target.value as Draft['interval']})}><Option value="daily">Daily</Option><Option value="weekly">Weekly</Option><Option value="monthly">Last day of month</Option></Select></Field>
    {draft.interval==='weekly'&&<Field label="Weekday" htmlFor={uid+'weekday'}><Select id={uid+'weekday'} value={draft.weekday} disabled={blocked} onChange={event=>edit({weekday:event.target.value})}>{weekdays.map((day,index)=><Option value={String(index)} key={day}>{day}</Option>)}</Select></Field>}
    <Field label="Time" htmlFor={uid+'time'}><Input id={uid+'time'} type="time" value={draft.time} disabled={blocked} onChange={event=>edit({time:event.target.value})}/></Field>
    <Field label="Time zone" htmlFor={uid+'timezone'}><Input id={uid+'timezone'} value={draft.timezone} disabled={blocked} maxLength={100} onChange={event=>edit({timezone:event.target.value})}/></Field>
    <Tooltip content="Enabling authorizes recurring static HTML audits with these settings. Pausing cancels queued occurrences; audits already running may finish."><Button variant="ghost">How recurring audits work</Button></Tooltip>
   </Stack>:role&&schedule?<Stack gap={2}><Text>{schedule.origin}{schedule.definition.startPath==='/'?'':schedule.definition.startPath}</Text><Text>{schedule.definition.maxPages} maximum HTML pages · {schedule.definition.retainBodyText?'Body text retained':'Body text not retained'}</Text><Text>{schedule.definition.includeQueryUrls?'Query URLs included':'Query URLs excluded'}</Text><Text>{schedule.definition.crawlerAccess?`Saved crawler access · revision ${schedule.definition.crawlerAccess.revision} · ${savedAccess?'expires '+date(savedAccess.expiresAt,'UTC'):'expiry unavailable'}`:'Crawler access: unsigned audit'}</Text></Stack>:null}
   {role&&<Stack gap={3}><Heading level={3} size="sm">Scheduled audit history</Heading>
    {schedule?.occurrences.length?<DataTable ariaLabel="Scheduled audit history" rows={schedule.occurrences} rowKey={row=>row.id} searchable={false} sortable={false} pagination={false} responsive="stack" columns={[
     {key:'scheduledFor',header:'Scheduled',rowHeader:true,wrap:true,render:row=>date(row.scheduledFor,schedule.calendar.timezone)},
     {key:'status',header:'Status',wrap:true,render:row=><Stack gap={1}><Text>{row.status.replaceAll('_',' ')}</Text>{row.reason&&<Text size="sm" tone="muted">{row.reason.replaceAll('_',' ')}</Text>}</Stack>},
     {key:'action',header:'Audit',render:row=>row.runId?<Button variant="secondary" disabled={locked||busy} onClick={()=>void close(row.runId!)}>View audit</Button>:<Text size="sm">{row.status==='skipped'?'No audit started':'Unavailable'}</Text>},
    ]}/>:<Text tone="muted">No scheduled audits yet.</Text>}
   </Stack>}
  </Stack>
 </Sheet>}{confirmDialog}</>;
}
