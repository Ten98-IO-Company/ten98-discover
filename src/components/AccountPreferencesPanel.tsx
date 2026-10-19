import {Icon} from './CampaignUI';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {ApiError,errMsg} from '../lib/api';
import {accountLocaleInventory,accountLocaleMapping,accountPreferencesDefaults,accountPreferencesWireInputSchema,canonicalAccountTimeZone,type AccountPreferencesInput,type AccountPreferencesDto} from '../lib/account-preferences';
import {requestAccountPreferences,useAccountPresentation} from '../lib/account-presentation';

type Draft=Omit<AccountPreferencesInput,'expectedRevision'>;
export function AccountPreferencesPanel({expectedUserId,onUnauthorized}:{expectedUserId:string;onUnauthorized:()=>void}){
  const account=useAccountPresentation(),uid=useId(),[draft,setDraft]=useState<Draft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reloadRequired,setReloadRequired]=useState(false);
  const operation=useRef(0),request=useRef<AbortController|null>(null),mounted=useRef(true),locked=useRef(false);
  const acknowledged=useRef<AccountPreferencesDto|null>(null);
  const data=account?.data?.user.id===expectedUserId?account.data:null;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;operation.current++;request.current?.abort();};},[]);
  useEffect(()=>{operation.current++;request.current?.abort();locked.current=false;setBusy(false);setError('');if(!data||data!==acknowledged.current){acknowledged.current=null;setNotice('');}setReloadRequired(false);setDraft(data?{name:data.user.name,timeZone:data.preferences.timeZone,locale:data.preferences.locale,theme:data.preferences.theme}:null);},[data]);
  const blocked=!data||!draft||!!account?.loading||!!account?.error||busy;
  const changed=!!data&&!!draft&&(draft.name!==data.user.name||draft.timeZone!==data.preferences.timeZone||draft.locale!==data.preferences.locale||draft.theme!==data.preferences.theme);
  const dirty=!!data&&(data.preferences.revision===0||changed);
  useBlocker({shouldBlockFn:()=>changed&&!window.confirm('Discard your unsaved preferences?'),enableBeforeUnload:()=>changed});
  const zones=Array.from(new Set(['UTC',...(data?[data.preferences.timeZone]:[]),...Intl.supportedValuesOf('timeZone')])).sort();
  const zone=draft?canonicalAccountTimeZone(draft.timeZone):null,mapping=draft?accountLocaleMapping(draft.locale):null;
  function field<K extends keyof Draft>(key:K,value:Draft[K]){setDraft(previous=>previous?{...previous,[key]:value}:previous);setNotice('');setError('');}
  async function save(event:FormEvent){
    event.preventDefault();if(blocked||locked.current||reloadRequired||!dirty||!data||!draft||!account)return;
    const input=accountPreferencesWireInputSchema.safeParse({expectedRevision:data.preferences.revision,...draft});
    if(!input.success){setError('Enter a name of 1–120 characters and choose a recognized named time zone and regional format.');return;}
    const generation=++operation.current,controller=new AbortController();request.current=controller;locked.current=true;setBusy(true);setError('');setNotice('');
    const current=()=>mounted.current&&!controller.signal.aborted&&operation.current===generation;
    try{
      const saved=await requestAccountPreferences(controller.signal,input.data);if(!current())return;
      if(saved.user.id!==expectedUserId){account.unavailable('The signed-in account changed.');onUnauthorized();return;}
      acknowledged.current=saved;if(account.accept(saved))setNotice('Preferences saved.');else acknowledged.current=null;
    }catch(failure){
      if(!current())return;
      if(failure instanceof ApiError&&failure.status===401){account.unavailable('Your session ended.');onUnauthorized();return;}
      if(failure instanceof ApiError&&[403,404].includes(failure.status)){account.unavailable('Your account access changed. Reload saved preferences to continue.');return;}
      setReloadRequired(true);setError(failure instanceof ApiError&&failure.status===409?'Preferences changed on another device. Reload saved preferences before saving again.':errMsg(failure));
    }finally{if(current()){locked.current=false;request.current=null;setBusy(false);}}
  }
  return <section className="account-settings account-preferences" aria-label="Profile and appearance">
    <p className="dim">Personal settings follow your account across workspaces. Changes apply after Save.</p>
    {account?.loading&&<p role="status">Loading saved preferences…</p>}
    {account?.error&&<div className="alert" role="alert">{account.error}</div>}
    {error&&<div className="alert" role="alert">{error}</div>}
    {notice&&<p role="status">{notice}</p>}
    <form onSubmit={save} className="account-preferences-form">
      <div className="account-settings-grid">
      <fieldset className="panel settings-panel preferences-profile" disabled={blocked}><legend className="sr-only">Profile</legend>
        <div className="provider-settings-heading"><span className="provider-initial"><Icon name="user" size={18}/></span><div><h2>Your account</h2><p><bdi dir="ltr">{data?.user.email??'Unavailable'}</bdi></p></div></div>
        <p className="provider-source">Personal profile</p>
        <div className="field"><label htmlFor={uid+'-name'}>Display name</label><input id={uid+'-name'} autoComplete="name" maxLength={120} value={draft?.name??''} onChange={e=>field('name',e.target.value)} required/></div>
        <div className="field"><span>Email</span><p><bdi dir="ltr">{data?.user.email??'Unavailable'}</bdi></p><p className="hint field-help">Email and sign-in security are managed separately.</p></div>
      </fieldset>
      <fieldset className="panel settings-panel preferences-regional" disabled={blocked}><legend className="sr-only">Regional format</legend>
        <div className="provider-settings-heading"><span className="provider-initial"><Icon name="globe" size={18}/></span><div><h2>Regional format</h2><p>Dates, numbers and time zone</p></div></div>
        <p className="hint field-help" id={uid+'-format-help'}>Interface text is currently English. This changes dates and numbers in account settings; report formats and applied report time zones stay unchanged.</p>
        <div className="field"><label htmlFor={uid+'-zone'}>Time zone</label><input id={uid+'-zone'} list={uid+'-zones'} value={draft?.timeZone??''} onChange={e=>field('timeZone',e.target.value)} aria-describedby={uid+'-format-help'} autoComplete="off" required/><datalist id={uid+'-zones'}>{zones.map(value=><option value={value} key={value}/>)}</datalist></div>
        <button className="btn button" type="button" onClick={()=>{const value=canonicalAccountTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);if(value)field('timeZone',value);}}>Use device time zone</button>
        <div className="field"><label htmlFor={uid+'-locale'}>Date and number format</label><select id={uid+'-locale'} value={draft?.locale??'en-US'} onChange={e=>field('locale',e.target.value as Draft['locale'])} aria-describedby={uid+'-format-help'}>{accountLocaleInventory.map(([code,label,direction])=><option key={code} value={code} lang={accountLocaleMapping(code).formatLocale} dir={direction}>{label} · {code}</option>)}</select></div>
        <div className="preferences-preview" aria-label="Draft format preview"><p className="hint field-help">Preview only · your draft</p>{mapping&&zone?<dl><dt>Number</dt><dd lang={mapping.formatLocale} dir={mapping.direction}>{new Intl.NumberFormat(mapping.formatLocale).format(1234567.89)}</dd><dt>Date and time</dt><dd lang={mapping.formatLocale} dir={mapping.direction}>{new Intl.DateTimeFormat(mapping.formatLocale,{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date())}</dd></dl>:<p>This browser cannot preview that time zone. Choose a recognized named time zone to change it.</p>}</div>
      </fieldset>
      <fieldset className="panel settings-panel preferences-theme" disabled={blocked}><legend className="sr-only">Appearance</legend><div className="provider-settings-heading"><span className="provider-initial"><Icon name="sun" size={18}/></span><div><h2>Appearance</h2><p>Choose a light, dark or system appearance.</p></div></div><p className="hint field-help">Light is the default. System follows your device after you save.</p><div className="row button-wrap">{(['light','dark','system'] as const).map(value=><label key={value} htmlFor={uid+'-'+value}><input id={uid+'-'+value} type="radio" name={uid+'-theme'} checked={draft?.theme===value} onChange={()=>field('theme',value)}/>{value[0].toUpperCase()+value.slice(1)}</label>)}</div></fieldset>
      </div>
      <div className="button-wrap account-settings-actions"><button className="btn button primary" disabled={blocked||reloadRequired||!dirty}>{busy?'Saving…':'Save preferences'}</button><button className="btn button" type="button" disabled={blocked} onClick={()=>{if(draft)setDraft({...draft,...accountPreferencesDefaults});acknowledged.current=null;setNotice('Defaults are staged. Save to apply them.');}}>Restore default preferences</button><button className="btn button" type="button" disabled={busy||!!account?.loading} onClick={()=>{acknowledged.current=null;setNotice('');void account?.reload();}}>Reload saved preferences</button></div>
      <p className="hint field-help">Reload replaces unsaved edits. Preferences do not change financial values, exports or saved report evidence.</p>
    </form>
  </section>;
}
