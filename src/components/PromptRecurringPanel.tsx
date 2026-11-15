import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Alert,Button,Card,Checkbox,Field,Fieldset,Grid,Heading,Inline,Input,Option,Select,Stack,Text} from '@ten98/ui';
import {ApiError,errMsg} from '../lib/api';
import {promptCalendar,promptTrackersResponse,promptTrackerResponse,promptTrackerMutationResponse,type PromptTracker} from '../lib/prompt-recurring';
import {modelApi,ModelResponseError} from './OpenRouterModelPicker';
import type {WorkspaceRole} from '@ten98/runtime/browser';

type Role=WorkspaceRole;
type Preparation={id:string;expiresAt:string;input:{promptId:string;versionId:string;models:string[];systemText:string;maxCompletionTokens:number;reuseCached?:boolean}};
type Attempt={path:string;body:Record<string,unknown>};
function nextDue(value:string|null,zone:string){if(!value)return 'Not scheduled';try{return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:zone}).format(new Date(value))+' · '+zone;}catch{return value+' · UTC instant; local zone preview unavailable';}}
export function PromptRecurringPanel({projectId,userId,role,preparation,onUnauthorized,onRole,onOpenComparison}:{projectId:string;userId:string;role:Role|null;preparation:Preparation|null;onUnauthorized:()=>void;onRole:(role:Role)=>void;onOpenComparison:(id:string)=>void}){
 const base='/api/projects/'+projectId+'/prompt-trackers',identity=projectId+':'+userId,live=useRef(identity),generation=useRef(0),controller=useRef<AbortController|null>(null),mounted=useRef(false);
 const authority=useRef({role,revision:0}),dataAuthority=useRef(-1),pointAuthority=useRef(-1),verifiedRole=useRef<{identity:string;revision:number;role:Role}|null>(null);if(authority.current.role!==role)authority.current={role,revision:authority.current.revision+1};
 live.current=identity;
 const[data,setData]=useState<ReturnType<typeof promptTrackersResponse.parse>|null>(null),[point,setPoint]=useState<ReturnType<typeof promptTrackerResponse.parse>|null>(null),[status,setStatus]=useState<'active'|'archived'|'all'>('active'),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState<Attempt|null>(null);
 const[name,setName]=useState(''),[interval,setInterval]=useState<'daily'|'weekly'|'monthly'>('daily'),[timezone,setZone]=useState('UTC'),[hour,setHour]=useState('9'),[minute,setMinute]=useState('0'),[weekday,setWeekday]=useState('1'),[consent,setConsent]=useState(false);
 const attemptRef=useRef<Attempt|null>(null);attemptRef.current=attempt;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;controller.current?.abort();};},[identity]);
 useEffect(()=>{if(!attemptRef.current)setConsent(false);},[preparation?.id]);
 const shown=dataAuthority.current===authority.current.revision&&data?.projectId===projectId?data:null,shownPoint=pointAuthority.current===authority.current.revision&&point?.projectId===projectId?point:null,owner=role==='owner'&&verifiedRole.current?.identity===identity&&verifiedRole.current.revision===authority.current.revision&&verifiedRole.current.role==='owner'&&(shown?.role==='owner'||shownPoint?.role==='owner'||attempt!==null),fresh=!!preparation&&preparation.input.reuseCached===false&&Date.parse(preparation.expiresAt)>Date.now();
 function purge(message:string){generation.current++;controller.current?.abort();controller.current=null;verifiedRole.current=null;setData(null);setPoint(null);setConsent(false);setBusy(false);setError(message);}
 function pageUrl(filter=status,after:string|null=cursor){const params=new URLSearchParams();if(filter!=='active')params.set('status',filter);if(after)params.set('cursor',after);const query=params.toString();return base+(query?'?'+query:'');}
 async function request(path=pageUrl(),body?:Record<string,unknown>){
  if(controller.current)return;const abort=new AbortController(),token=++generation.current,scope=identity,roleRevision=authority.current.revision;controller.current=abort;setBusy(true);setError('');
  if(body)setAttempt({path,body});
  try{
   const raw=await modelApi<unknown>(path,{method:body?'POST':'GET',...(body?{body}:{}),signal:abort.signal});if(!mounted.current||live.current!==scope||token!==generation.current||roleRevision!==authority.current.revision)return;
   let currentRole:Role,item:PromptTracker|undefined,page:ReturnType<typeof promptTrackersResponse.parse>|undefined;
   if(body){
    const parsed=promptTrackerMutationResponse.safeParse(raw);if(!parsed.success||parsed.data.projectId!==projectId)throw new Error('The complete recurring acknowledgement could not be verified. Inspect saved status.');
    const parts=path.slice(base.length).split('/').filter(Boolean),{ack}=parsed.data;
    if(parsed.data.role!=='owner'||ack.requestId!==body.requestId||ack.action!==(parts[1]??'create')||parts[0]&&ack.trackerId!==parts[0]||ack.preparationId!==(body.preparationId??null)||parsed.data.item.id!==ack.trackerId||ack.action==='create'&&parsed.data.item.createdRequestId!==body.requestId||ack.action==='run'&&ack.occurrenceId===null)throw new Error('The saved acknowledgement did not match this exact recurring request. Inspect status before retrying.');
    currentRole=parsed.data.role;item=parsed.data.item;
   }else if(path===base||path.startsWith(base+'?')){
    const parsed=promptTrackersResponse.safeParse(raw),filter=new URLSearchParams(path.split('?')[1]??'').get('status')??'active';
    if(!parsed.success||parsed.data.projectId!==projectId||parsed.data.status!==filter||new Set(parsed.data.items.map(row=>row.id)).size!==parsed.data.items.length||parsed.data.items.some(row=>filter==='active'&&row.archivedAt!==null||filter==='archived'&&row.archivedAt===null))throw new Error('The complete tracker page could not be verified. Reload saved status.');
    currentRole=parsed.data.role;page=parsed.data;
   }else{
    const parsed=promptTrackerResponse.safeParse(raw);if(!parsed.success||parsed.data.projectId!==projectId||parsed.data.item.id!==path.slice(base.length+1))throw new Error('The selected tracker could not be verified. Reload saved status.');currentRole=parsed.data.role;item=parsed.data.item;
   }
   verifiedRole.current={identity:scope,revision:roleRevision,role:currentRole};
   if(page){dataAuthority.current=roleRevision;setData(page);setPoint(null);}
   if(item){const saved=item;pointAuthority.current=roleRevision;setPoint({projectId,role:currentRole,item:saved});setData(previous=>previous&&dataAuthority.current===roleRevision?{...previous,role:currentRole,items:previous.items.flatMap(row=>row.id!==saved.id?[row]:previous.status==='active'&&saved.archivedAt!==null||previous.status==='archived'&&saved.archivedAt===null?[]:[saved])}:null);}
   onRole(currentRole);if(body){setAttempt(null);setConsent(false);}
  }catch(cause){if(!mounted.current||live.current!==scope||token!==generation.current||roleRevision!==authority.current.revision)return;if(cause instanceof ApiError&&[401,403,404].includes(cause.status)){purge('Recurring tracking access is unavailable. Reload access.');if(cause.status===401)onUnauthorized();return;}setData(null);setPoint(null);if(cause instanceof ModelResponseError&&cause.readOnly)setConsent(false);setError((body?'This change may already have been accepted. Inspect saved status or retry the identical request. ':'')+errMsg(cause));}
  finally{if(mounted.current&&live.current===scope&&token===generation.current){controller.current=null;setBusy(false);}}
 }
 function calendar(){const result=promptCalendar.safeParse({interval,timezone,hour:Number(hour),minute:Number(minute),weekday:interval==='weekly'?Number(weekday):null});if(!result.success)throw new Error('Choose a daily, weekly or month-end time and supported named zone.');return result.data;}
 function create(event:FormEvent){event.preventDefault();if(!owner||!fresh||attempt)return;try{if(!name.trim())throw new Error('Give this tracker a name.');void request(base,{requestId:crypto.randomUUID(),preparationId:preparation!.id,name:name.trim(),calendar:calendar(),approve:consent});}catch(cause){setError(errMsg(cause));}}
 function approve(item:PromptTracker){if(!owner||!fresh||!consent||attempt)return;try{void request(base+'/'+item.id+'/approve',{requestId:crypto.randomUUID(),revision:item.revision,preparationId:preparation!.id,calendar:calendar()});}catch(cause){setError(errMsg(cause));}}
 const items=shown?.items??[],visible=shownPoint&&!items.some(item=>item.id===shownPoint.item.id)?[shownPoint.item,...items]:items;
 const same=(item:PromptTracker)=>!!preparation&&item.definition.promptId===preparation.input.promptId&&item.definition.versionId===preparation.input.versionId&&item.definition.systemText===preparation.input.systemText&&item.definition.maxCompletionTokens===preparation.input.maxCompletionTokens&&JSON.stringify(item.definition.models)===JSON.stringify(preparation.input.models);
 return <Card><details open={fresh} onToggle={event=>{if(event.currentTarget.open)void request();}}>
  <summary>Recurring prompt tracking</summary>
  <Stack>
  <Text>Each scheduled run requests fresh model answers using the saved prompt version, models, system message and output limit. These API answers do not measure consumer web search.</Text>
  <Text size="sm" tone="muted">Trackers start paused. Only an owner can approve future requests. Monthly runs use the last calendar day. When clocks change, skipped local times move forward and repeated times use the later occurrence. Missed runs are not backfilled.</Text>
  <Inline align="end"><Field label="Tracker collection"><Select value={status} disabled={busy} onChange={event=>{const filter=event.target.value as typeof status;setStatus(filter);setCursor(null);setData(null);setPoint(null);void request(pageUrl(filter,null));}}><Option value="active">Active and paused</Option><Option value="archived">Archived</Option><Option value="all">All trackers</Option></Select></Field><Button variant="secondary" type="button" disabled={busy} onClick={()=>void request()}>Refresh recurring status</Button></Inline>
  <Text size="sm" tone="muted">Showing up to 20 trackers per page. Archiving keeps earlier runs and request outcomes.</Text>
  {busy&&<Text role="status">Reading or saving recurring status…</Text>}{error&&<Alert tone="danger" role="alert">{error}</Alert>}
  {attempt&&<Stack><Alert variant="banner">Keep this exact request until its result is known. Refreshing status does not start new work.</Alert><Inline><Button type="button" variant="secondary" disabled={busy} onClick={()=>void request(attempt.path===base?pageUrl():attempt.path.replace(/\/(approve|pause|run|archive|restore)$/,''))}>Inspect saved tracker</Button><Button type="button" variant="secondary" disabled={busy||!owner} onClick={()=>void request(attempt.path,attempt.body)}>Retry same recurring request</Button></Inline></Stack>}
  {owner&&<Stack as="form" onSubmit={create}>
   <Fieldset legend="Recurring setup" disabled={busy||!!attempt}>
    {!fresh&&<Text>Choose models and select Schedule above to configure a tracker.</Text>}
    <Field label="Tracker name"><Input value={name} onChange={e=>setName(e.target.value)} maxLength={120}/></Field>
    <Grid columns="auto" minItemWidth="sm">
     <Field label="Cadence"><Select value={interval} onChange={e=>setInterval(e.target.value as typeof interval)}><Option value="daily">Daily</Option><Option value="weekly">Weekly</Option><Option value="monthly">Monthly, month end</Option></Select></Field>
     <Field label="Recurring time zone"><Input value={timezone} maxLength={100} onChange={e=>setZone(e.target.value)}/></Field>
     <Field label="Local hour"><Input type="number" min={0} max={23} value={hour} onChange={e=>setHour(e.target.value)}/></Field><Field label="Local minute"><Input type="number" min={0} max={59} value={minute} onChange={e=>setMinute(e.target.value)}/></Field>
     {interval==='weekly'&&<Field label="Weekday"><Select value={weekday} onChange={e=>setWeekday(e.target.value)}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day,i)=><Option key={day} value={i}>{day}</Option>)}</Select></Field>}
    </Grid>
    <Checkbox label="I authorize future fresh requests for this definition until paused or approval changes." checked={consent} onChange={e=>setConsent(e.target.checked)}/>
    <Text size="sm" tone="muted">Only this saved prompt and model selection will run. Pause the tracker to stop future requests.</Text>
    <Button variant="primary" disabled={!fresh} type="submit">{consent?'Approve and schedule new tracker':'Save paused tracker'}</Button>
   </Fieldset>
  </Stack>}
  {(shown||shownPoint)&&<Stack><Heading level={3}>{shown?.items.length??0} trackers on this page</Heading>{shownPoint&&!items.some(item=>item.id===shownPoint.item.id)&&<Text>Selected tracker outside this page</Text>}{visible.map(item=><Card as="article" headingLevel={4} title={item.name} key={item.id}>
   <Stack><Text>{item.archivedAt?'Archived':item.enabled?'Enabled':'Paused'} · {item.calendar.interval==='monthly'?'month end':item.calendar.interval} · Next {nextDue(item.nextDueAt,item.calendar.timezone)}</Text>
   <Text>{item.definition.models.join(' + ')} · Prompt version <bdi>{item.definition.versionId}</bdi></Text>{item.lastStatus&&<Text role="status">{item.lastStatus}</Text>}
   {owner&&!item.archivedAt&&<Inline><Button type="button" variant="secondary" disabled={busy||!!attempt||!item.enabled} onClick={()=>void request(base+'/'+item.id+'/pause',{requestId:crypto.randomUUID(),revision:item.revision})}>Pause {item.name}</Button><Button type="button" variant="secondary" disabled={busy||!!attempt||!fresh||!same(item)||!consent} onClick={()=>approve(item)}>Approve and resume {item.name}</Button><Button type="button" variant="secondary" disabled={busy||!!attempt||!item.enabled} onClick={()=>void request(base+'/'+item.id+'/run',{requestId:crypto.randomUUID(),revision:item.revision})}>Run now {item.name}</Button></Inline>}
   {owner&&<Inline><Button type="button" variant="secondary" disabled={busy||!!attempt} onClick={()=>void request(base+'/'+item.id+'/'+(item.archivedAt?'restore':'archive'),{requestId:crypto.randomUUID(),revision:item.revision})}>{item.archivedAt?'Restore paused':'Archive'} {item.name}</Button></Inline>}
   <Text size="sm" tone="muted">Pausing stops requests that have not been sent. Requests already sent may still complete; open the original run to cancel remaining requests or check an unconfirmed outcome. Restored trackers need approval before running again.</Text>
   <Stack as="ul">{item.occurrences.map(o=><Inline as="li" key={o.id}><Text as="span">{o.scheduledFor} · {o.status}{o.reason?' · '+o.reason:''}</Text>{o.comparisonId&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>onOpenComparison(o.comparisonId!)}>Open occurrence comparison</Button>}</Inline>)}</Stack>
   <Text size="sm" tone="muted">Latest 10 scheduled runs within the saved history period. Request outcomes are kept separately from answers, which may expire.</Text></Stack>
  </Card>)}{shown&&<Inline>{cursor&&<Button type="button" variant="secondary" disabled={busy} onClick={()=>{setCursor(null);setPoint(null);void request(pageUrl(status,null));}}>First tracker page</Button>}{shown.nextCursor&&<Button type="button" variant="secondary" disabled={busy} onClick={()=>{const next=shown.nextCursor;setCursor(next);setPoint(null);void request(pageUrl(status,next));}}>Next tracker page</Button>}</Inline>}</Stack>}
  </Stack>
 </details></Card>;
}
