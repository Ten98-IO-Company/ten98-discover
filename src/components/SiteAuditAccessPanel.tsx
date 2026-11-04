import {useEffect,useId,useRef,useState} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {Button,Field,Inline,Input,Option,Select,Sheet,Stack,Text,Tooltip,useConfirmDialog} from '@ten98/ui';
import {api,ApiError} from '../lib/api';
import {siteAuditAccessMutationResponse,siteAuditAccessResponse,siteAuditAccessSave,type SiteAuditAccessResponse} from '../lib/site-audit-access';

type Props={projectId:string;userId:string;disabled?:boolean;onUnauthorized:()=>void;onChanged:()=>void};
type Attempt={operation:'save'|'remove';origin:string;domainId:string|null;credentialId:string|null;body:{requestId:string;expectedRevision:number;domainId?:string|null;signatureInput?:string;signature?:string;credentialId?:string}};
const manages=(role:string|null|undefined)=>role==='owner'||role==='admin';
export function SiteAuditAccessPanel(props:Props){return <AccessPanel key={props.userId+':'+props.projectId} {...props}/>;}
function AccessPanel({projectId,disabled=false,onUnauthorized,onChanged}:Props){
 const base=`/api/projects/${encodeURIComponent(projectId)}/audits/access`,uid=useId();
 const [open,setOpen]=useState(false),[data,setData]=useState<SiteAuditAccessResponse|null>(null),[domain,setDomain]=useState('');
 const [signatureInput,setSignatureInput]=useState(''),[signature,setSignature]=useState(''),[pending,setPending]=useState<Attempt|null>(null);
 const [busy,setBusy]=useState(false),[writing,setWriting]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[conflict,setConflict]=useState(false),[refreshFailed,setRefreshFailed]=useState(false);
 const [confirm,confirmDialog]=useConfirmDialog({danger:true});
 const mounted=useRef(true),operation=useRef<AbortController|null>(null),pendingRef=useRef<Attempt|null>(null),roleRef=useRef<string|null>(null),writingRef=useRef(false),dataRef=useRef<SiteAuditAccessResponse|null>(null);
 const callbacks=useRef({onUnauthorized,onChanged}),domainControl=useRef<HTMLSelectElement>(null);callbacks.current={onUnauthorized,onChanged};
 const dirty=!!(signatureInput||signature),locked=writing||pending!==null,editable=manages(data?.role);
 const state=useRef({open,dirty,domain});state.current={open,dirty,domain};
 const selected=data?.origins.find(value=>(value.domainId??'')===domain),credential=data?.credentials.find(value=>(value.domainId??'')===domain);
 function clearSecrets(){setSignatureInput('');setSignature('');}
 function keepAttempt(value:Attempt|null){pendingRef.current=value;setPending(value);}
 function purge(){
  operation.current?.abort();operation.current=null;writingRef.current=false;roleRef.current=null;dataRef.current=null;setBusy(false);setWriting(false);keepAttempt(null);clearSecrets();setData(null);setConflict(false);setRefreshFailed(false);setNotice('');
 }
 function accessFailure(cause:unknown){if(!(cause instanceof ApiError)||![401,403,404].includes(cause.status))return false;purge();setError('Crawler access is no longer available.');if(cause.status===401)callbacks.current.onUnauthorized();return true;}
 function begin(write=false){if(operation.current||!mounted.current)return null;const controller=new AbortController();operation.current=controller;writingRef.current=write;setBusy(true);setWriting(write);setError('');return controller;}
 function current(controller:AbortController){return mounted.current&&operation.current===controller&&!controller.signal.aborted;}
 function finish(controller:AbortController){if(current(controller)){operation.current=null;writingRef.current=false;setBusy(false);setWriting(false);}}
 function apply(value:SiteAuditAccessResponse,preserve=false){
  const old=dataRef.current,selection=state.current.domain;
  const before=old?.credentials.find(item=>(item.domainId??'')===selection),after=value.credentials.find(item=>(item.domainId??'')===selection);
  const oldOrigin=old?.origins.find(item=>(item.domainId??'')===selection)?.origin,newOrigin=value.origins.find(item=>(item.domainId??'')===selection)?.origin;
  roleRef.current=value.role;dataRef.current=value;setData(value);setRefreshFailed(false);
  if(!manages(value.role)){clearSecrets();keepAttempt(null);setConflict(false);setNotice('');}
  else if(preserve){if((before?.revision??0)!==(after?.revision??0)||before?.id!==after?.id||oldOrigin!==newOrigin)setConflict(true);}
  else{clearSecrets();setConflict(false);}
  if(!preserve&&!value.origins.some(item=>(item.domainId??'')===selection))setDomain(value.origins[0]?.domainId??'');
 }
 function validate(value:SiteAuditAccessResponse){
  if(value.projectId!==projectId||new Set(value.origins.map(item=>item.domainId)).size!==value.origins.length||new Set(value.credentials.map(item=>item.domainId)).size!==value.credentials.length||new Set(value.credentials.map(item=>item.id)).size!==value.credentials.length)throw Error('Unmatched access metadata');
 }
 async function load(preserve=false){
  if(pendingRef.current)return;const controller=begin();if(!controller)return;
  try{const value=siteAuditAccessResponse.parse(await api(base,{signal:controller.signal}));if(!current(controller))return;validate(value);apply(value,preserve&&state.current.dirty);}
  catch(cause){if(current(controller)&&!accessFailure(cause)){roleRef.current=null;setRefreshFailed(true);setNotice('');setError('Crawler access could not be refreshed. Retry refresh.');}}
  finally{finish(controller);}
 }
 async function send(attempt:Attempt){
  if(!manages(roleRef.current)||pendingRef.current&&pendingRef.current!==attempt)return;
  const controller=begin(true);if(!controller)return;const captured=pendingRef.current??structuredClone(attempt);keepAttempt(captured);setNotice('');
  try{
   const raw=await api(base+(captured.operation==='remove'?'/remove':''),{method:'POST',body:captured.body,signal:controller.signal});
   if(!current(controller))return;const value=siteAuditAccessMutationResponse.parse(raw);validate(value);
   const ack=value.ack,record=value.credentials.find(item=>item.id===ack.credentialId);
   if(ack.requestId!==captured.body.requestId||ack.operation!==captured.operation||ack.revision!==captured.body.expectedRevision+1||captured.credentialId!==null&&ack.credentialId!==captured.credentialId||!record||record.domainId!==captured.domainId||record.revision<ack.revision)throw Error('Unmatched acknowledgement');
   if(record.revision===ack.revision&&(record.origin!==captured.origin||(captured.operation==='save'?record.revokedAt!==null:record.revokedAt===null)))throw Error('Unmatched saved access');
   keepAttempt(null);apply(value);setNotice(manages(value.role)?record.revision>ack.revision?'Original request confirmed. Showing the latest crawler access.':captured.operation==='save'?'Crawler access saved. Select it when running an audit.':'Crawler access removed.':'');callbacks.current.onChanged();
  }catch(cause){
   if(!current(controller)||accessFailure(cause))return;
   // Never render server error text: credential validation responses must not echo submitted secrets.
   if(!(cause instanceof ApiError)||cause.status===0||cause.status===408||cause.status===429||cause.status>=500)setError('The response could not be confirmed. This action may already have succeeded.');
   else{keepAttempt(null);if(cause.status===409){setConflict(true);setError('Crawler access changed. Reload and review it before saving.');}else setError('Crawler access could not be saved. Check the Shopify signature values and try again.');}
  }finally{finish(controller);}
 }
 function save(){
  if(!selected||!data?.vaultConfigured||busy||locked||conflict||refreshFailed||!manages(roleRef.current))return;
  const body=siteAuditAccessSave.safeParse({requestId:crypto.randomUUID(),expectedRevision:credential?.revision??0,domainId:selected.domainId,signatureInput,signature});
  if(!body.success){setError('Enter both Shopify signature values, up to 4,096 characters each.');return;}
  void send({operation:'save',origin:selected.origin,domainId:selected.domainId,credentialId:credential?.id??null,body:body.data});
 }
 async function remove(){
  if(!credential||credential.revokedAt||busy||locked||conflict||refreshFailed||dirty||!manages(roleRef.current))return;
  if(!await confirm({title:'Remove crawler access?',description:'Audits using this saved access will require new access before they can run.',confirmLabel:'Remove access'}))return;
  if(busy||pendingRef.current||!manages(roleRef.current))return;
  void send({operation:'remove',origin:credential.origin,domainId:credential.domainId,credentialId:credential.id,body:{requestId:crypto.randomUUID(),expectedRevision:credential.revision,credentialId:credential.id}});
 }
 async function reload(){
  if(locked||busy)return;
  if(!refreshFailed&&dirty&&!await confirm({title:'Discard access edits and reload?',description:'The latest saved crawler access will be shown.',confirmLabel:'Reload access'}))return;
  setNotice('');await load(refreshFailed);
  if(mounted.current&&state.current.open)requestAnimationFrame(()=>domainControl.current?.focus());
 }
 async function close(){
  if(writingRef.current||pendingRef.current)return;
  if(state.current.dirty&&!await confirm({title:'Discard unsaved access edits?',description:'Your saved crawler access will stay as it is.',confirmLabel:'Discard edits'}))return;
  state.current={...state.current,dirty:false,open:false};purge();setError('');setOpen(false);
 }
 function select(value:string){if(busy||locked||conflict||refreshFailed)return;clearSecrets();setDomain(value);setNotice('');setError('');}
 useBlocker({shouldBlockFn:()=>state.current.open&&(writingRef.current||pendingRef.current!==null||state.current.dirty)&&(writingRef.current||pendingRef.current!==null||!window.confirm('Discard unsaved access edits and leave?')),enableBeforeUnload:()=>state.current.open&&(writingRef.current||pendingRef.current!==null||state.current.dirty)});
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;operation.current?.abort();operation.current=null;pendingRef.current=null;dataRef.current=null;};},[]);
 useEffect(()=>{if(!open)return;const refresh=()=>{if(!document.hidden&&!operation.current&&!pendingRef.current)void load(true);};window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh);},[open]);
 const blocked=busy||locked||conflict||refreshFailed;
 const accessState=credential?.revokedAt?'Removed':credential&&Date.parse(credential.expiresAt)<=Date.now()?'Expired':credential?.verification==='verified'?'Verified':credential?'Unverified':'No saved access';
 return <><Button variant="secondary" disabled={disabled||open} onClick={()=>{setOpen(true);void load();}}>Crawler access</Button>
 {open&&<Sheet open modal={false} title="Shopify crawler access" width="md" busy={writing} closeDisabled={locked} onClose={()=>void close()} error={!pending&&error?error:undefined} unconfirmed={pending&&!writing?error||'The action may already have succeeded.':undefined}
  recovery={pending&&!writing?<Button onClick={()=>void send(pending)}>Retry same request</Button>:undefined}
  footer={editable?<Inline wrap>{credential&&!credential.revokedAt&&<Button variant="secondary" disabled={blocked||dirty} onClick={()=>void remove()}>Remove access</Button>}<Button disabled={blocked||!selected||!data?.vaultConfigured} onClick={save}>Save crawler access</Button></Inline>:undefined}>
  <Stack gap={5}>
   {busy&&!writing&&<Text role="status">Loading crawler access…</Text>}{notice&&<Text role="status">{notice}</Text>}
   {data?<>
    <Inline wrap><Text weight="semibold">{accessState}</Text><Button variant="ghost" disabled={locked||busy} onClick={()=>void reload()}>{refreshFailed?'Retry refresh':conflict?'Reload latest access':'Refresh access'}</Button></Inline>
    <Field label="Audit domain" htmlFor={uid+'domain'}><Select ref={domainControl} id={uid+'domain'} value={domain} disabled={blocked} onChange={event=>select(event.target.value)}>{!data.origins.length&&<Option value="">No eligible domain</Option>}{data.origins.map(value=><Option key={value.domainId??'canonical'} value={value.domainId??''}>{value.origin}</Option>)}</Select></Field>
    {credential&&<Stack gap={2}><Text>Saved origin: {credential.origin}</Text><Text>Expires: {new Date(credential.expiresAt).toLocaleString()}</Text>{accessState==='Unverified'&&<Text tone="muted">The signature could not be verified with Shopify. Review this state before selecting it for an audit.</Text>}</Stack>}
    {conflict&&<Text role="alert">The selected origin or saved access changed. Reload and review before continuing.</Text>}
    {editable&&<Stack gap={4} data-sensitive="true" data-rrweb-mask="true">
     {!data.vaultConfigured&&<Text role="alert">Credential storage is unavailable. Contact your instance operator before saving access.</Text>}
     <Field label="Signature-Input" htmlFor={uid+'input'}><Input id={uid+'input'} type="password" autoComplete="off" data-sensitive="true" data-rrweb-mask="true" maxLength={4096} value={signatureInput} disabled={blocked||!selected||!data.vaultConfigured} onChange={event=>setSignatureInput(event.target.value)}/></Field>
     <Field label="Signature" htmlFor={uid+'signature'}><Input id={uid+'signature'} type="password" autoComplete="off" data-sensitive="true" data-rrweb-mask="true" maxLength={4096} value={signature} disabled={blocked||!selected||!data.vaultConfigured} onChange={event=>setSignature(event.target.value)}/></Field>
     <Text size="sm" tone="muted">Saving access does not run an audit. Choose saved access separately when you run or schedule one.</Text>
    </Stack>}
    <Tooltip content="Create crawler access in Shopify for this exact domain, then paste its Signature-Input and Signature values. Shopify controls expiry. Discover sets Signature-Agent automatically."><Button variant="ghost">How to get crawler access</Button></Tooltip>
    <Button variant="ghost" href="https://help.shopify.com/en/manual/promoting-marketing/seo/crawling-your-store">Shopify crawler access instructions</Button>
   </>:!busy&&<Button onClick={()=>void load()}>Reload access</Button>}
  </Stack>
 </Sheet>}{confirmDialog}</>;
}
