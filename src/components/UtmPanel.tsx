import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {Alert,Button,Card,Checkbox,DataTable,Disclosure,Field,FormActions,FormGrid,Grid,Heading,Inline,Input,Stack,Text,saveFile} from '@ten98/ui';
import {ApiError,errMsg} from '../lib/api';
import {analyticsFieldLimit} from '../lib/analytics-dimensions';
import {buildUtmParams,utmFields,utmFilterFields,validUtmResult,type UtmField} from '../lib/utm-report';
import {buildParams,initialDraft,TIMEZONES,FILTERS,labelOf,type Draft} from './ExplorerFilters';
import {readCombination,validReportBase,validCohortResult,PropertyShares,type ExploreResult} from './ExplorerPanel';

type Panel={phase:'idle'|'loading'|'error'|'ready';result?:ExploreResult;params?:string;error?:string};
type Panels=Record<UtmField,Panel>;
const emptyPanels=():Panels=>Object.fromEntries(utmFields.map(([field])=>[field,{phase:'idle'}])) as Panels;
const firstDraft=():Draft=>({...initialDraft(),kind:'pageviews',groupBy:'campaignSource'});

export function UtmPanel({projectId,userId,onUnauthorized}:{projectId:string;userId:string;onUnauthorized:()=>void}){
  const uid=useId(),[draft,setDraft]=useState(firstDraft),[panels,setPanels]=useState(emptyPanels),[applied,setApplied]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[denied,setDenied]=useState(false);
  const identity=projectId+':'+userId,[scopeIdentity,setScopeIdentity]=useState(identity),live=useRef({identity,onUnauthorized}),mounted=useRef(false),generation=useRef(0),operation=useRef<AbortController|null>(null),blocked=useRef(false);
  live.current={identity,onUnauthorized};
  useEffect(()=>{
    mounted.current=true;generation.current++;operation.current?.abort();blocked.current=false;setScopeIdentity(identity);setDraft(firstDraft());setPanels(emptyPanels());setApplied('');setError('');setDenied(false);
    return()=>{mounted.current=false;generation.current++;operation.current?.abort();};
  },[identity]);
  const patch=(value:Partial<Draft>)=>{
    generation.current++;operation.current?.abort();setDraft(old=>({...old,...value}));setError('');
    setPanels(old=>Object.fromEntries(utmFields.map(([field])=>[field,old[field].phase==='loading'?{phase:'idle'}:old[field]])) as Panels);
  };
  const scope=buildParams(draft),unapplied=!!applied&&('error'in scope||scope.qs!==applied);
  async function load(fields:readonly UtmField[],qs:string,reauthorize=false){
    if(operation.current||!mounted.current||live.current.identity!==identity||blocked.current&&!reauthorize)return;
    const controller=new AbortController(),token=++generation.current,owner=identity;operation.current=controller;blocked.current=false;setDenied(false);setBusy(true);setError('');
    const current=()=>mounted.current&&live.current.identity===owner&&generation.current===token&&!controller.signal.aborted&&!blocked.current;
    setPanels(old=>({...old,...Object.fromEntries(fields.map(field=>[field,{phase:'loading'}]))}));
    let next=0;
    const worker=async()=>{while(current()&&next<fields.length){
      const field=fields[next++];
      try{
        const params=buildUtmParams(new URLSearchParams(qs),field),result=await readCombination(`/api/projects/${projectId}/explore?${params}`,controller.signal);
        if(!current())return;
        if(!validUtmResult(result,params)||!validReportBase(result,params)||!validCohortResult(result,params,projectId))throw new Error('This campaign report could not be verified. Retry this panel.');
        if(current())setPanels(old=>({...old,[field]:{phase:'ready',result,params:params.toString()}}));
      }catch(cause){
        // Authority outranks any held success, even when the user has since edited this draft.
        if(cause instanceof ApiError&&[401,403,404].includes(cause.status)&&mounted.current&&live.current.identity===owner){
          blocked.current=true;generation.current++;controller.abort();setPanels(emptyPanels());setApplied('');setDenied(true);setError(cause.status===401?'Your session expired. Sign in again.':'Project access changed. All campaign results were cleared. Explicitly reload access to try again.');
          if(cause.status===401)live.current.onUnauthorized();return;
        }
        if(current())setPanels(old=>({...old,[field]:{phase:'error',error:errMsg(cause)}}));
      }
    }};
    try{await Promise.all(Array.from({length:Math.min(2,fields.length)},worker));}
    finally{if(operation.current===controller){operation.current=null;if(mounted.current)setBusy(false);}}
  }
  function apply(event:FormEvent){
    event.preventDefault();if(operation.current)return;
    if('error'in scope){setError(scope.error);return;}
    try{buildUtmParams(new URLSearchParams(scope.qs),'campaignSource');}catch(cause){setError(errMsg(cause));return;}
    setScopeIdentity(identity);setApplied(scope.qs);setPanels(emptyPanels());void load(utmFields.map(([field])=>field),scope.qs,true);
  }
  function download(field:UtmField,panel:Panel){
    if(scopeIdentity!==identity||blocked.current||!panel.result||!panel.params)return;
    try{saveFile(`utm-${field}-${panel.result.range.from}-${panel.result.range.to}.csv`,panel.result.csv,'text/csv;charset=utf-8');}
    catch(cause){setError(errMsg(cause));}
  }
  const visible=scopeIdentity===identity?panels:emptyPanels(),appliedParams=new URLSearchParams(scopeIdentity===identity?applied:'');
  return <Stack as="section" aria-label="UTM reports">
    <Stack gap={1}><Heading level={2} size="lg">UTM reports</Heading><Text tone="muted" size="sm">Compare recorded campaign tags across pageviews. Each panel counts only pageviews with a nonempty value for that field; the five populations overlap.</Text></Stack>
    <Card><Stack as="form" onSubmit={apply} aria-label="UTM report scope">
      <FormGrid>
        <Field label="From" htmlFor={`${uid}-from`}><Input id={`${uid}-from`} type="date" required max={draft.to} value={draft.from} onChange={e=>patch({from:e.target.value})}/></Field>
        <Field label="To" htmlFor={`${uid}-to`}><Input id={`${uid}-to`} type="date" required min={draft.from} value={draft.to} onChange={e=>patch({to:e.target.value})}/></Field>
        <Field label="Time zone" htmlFor={`${uid}-zone`}><Input id={`${uid}-zone`} required list={`${uid}-zones`} value={draft.timeZone} onChange={e=>patch({timeZone:e.target.value})}/><datalist id={`${uid}-zones`}>{TIMEZONES.map(zone=><option key={zone} value={zone}/>)}</datalist></Field>
      </FormGrid>
      <Disclosure summary="Exact filters" variant="plain"><Stack><Text tone="muted" size="sm">Enabled filters must all match. Origin must be an exact HTTP(S) origin without a path. Other blank enabled values match an empty stored value; each panel still requires its own nonempty tag.</Text>{utmFilterFields.map(field=><Inline key={field} align="end"><Checkbox label={`Enable ${labelOf(FILTERS,field)}`} checked={draft.filters[field].on} onChange={e=>patch({filters:{...draft.filters,[field]:{...draft.filters[field],on:e.target.checked}}})}/><Field label={`${labelOf(FILTERS,field)} equals`} htmlFor={`${uid}-${field}`}><Input id={`${uid}-${field}`} disabled={!draft.filters[field].on} maxLength={analyticsFieldLimit(field)} value={draft.filters[field].value} onChange={e=>patch({filters:{...draft.filters,[field]:{...draft.filters[field],value:e.target.value}}})}/></Field></Inline>)}</Stack></Disclosure>
      <FormActions><Button variant="primary" type="submit" disabled={busy}>{busy?'Loading reports…':denied?'Reload access and apply':applied&&!unapplied?'Refresh reports':'Apply reports'}</Button></FormActions>
      {error&&<Alert tone="danger" role="alert">{error}</Alert>}{unapplied&&<Text tone="muted" size="sm" role="status">Unapplied changes. Results and CSV still describe the applied scope below.</Text>}
    </Stack></Card>
    {appliedParams.has('from')&&<Card aria-label="Applied UTM scope" title="Applied scope" headingLevel={3}><Stack><Text>{appliedParams.get('from')} to {appliedParams.get('to')} · {appliedParams.get('timeZone')} · Pageviews</Text>{utmFilterFields.filter(field=>appliedParams.has(field)).map(field=><Text key={field} tone="muted" size="sm">{labelOf(FILTERS,field)} equals <bdi>{JSON.stringify(appliedParams.get(field))}</bdi></Text>)}<Text tone="muted" size="sm">Shares use all observed pageviews tagged with that field, including values outside its top 100 table. They are not shares of all traffic or visitors.</Text></Stack></Card>}
    <Grid columns={2}>{utmFields.map(([field,label])=>{
      const panel=visible[field],result=panel.result,total=result?.totals.pageViews,rows=result?.breakdown.groups??[];
      return <Card key={field} as="section" title={label} headingLevel={3} aria-busy={panel.phase==='loading'}><Stack>
        {panel.phase==='idle'&&<Text tone="muted" size="sm">Choose dates and apply reports to view this campaign field.</Text>}
        {panel.phase==='loading'&&<Text role="status">Loading {label.toLowerCase()}…</Text>}
        {panel.phase==='error'&&<><Alert tone="danger" role="alert">{panel.error}</Alert><Button type="button" variant="secondary" disabled={busy||denied} onClick={()=>void load([field],applied)}>Retry {label.toLowerCase()}</Button></>}
        {panel.phase==='ready'&&result&&<>
          <Text weight="semibold">{total===null?'Unavailable':total} {total===null?'':'tagged pageviews'}</Text>
          {result.coverage.status!=='complete'&&<Alert tone="warning" variant="banner" role="status">{result.coverage.status==='unavailable'?'This history is no longer retained. Unavailable is not zero; choose a more recent range.':'Partial retained history. Counts and shares describe only observed tagged pageviews, not the missing history.'}</Alert>}
          <Text tone="muted" size="sm">{result.range.from} to {result.range.to} · {result.range.timeZone}. {result.coverage.retainedFrom?`Retained from ${result.coverage.retainedFrom}.`:'No retention boundary.'}</Text>
          {total!==null&&total===0&&<Text tone="muted" size="sm">No retained pageviews match these filters with a nonempty {label.toLowerCase()} tag.</Text>}
          {total!==null&&total!==undefined&&total>0&&<><PropertyShares items={rows.map(row=>({key:JSON.stringify(['utm',row.value]),label:row.value as string,count:row.events}))} total={total} label={`${label} tagged-pageview shares`} noun="tagged pageviews"/>
            <Text tone="muted" size="sm">Showing all {rows.length} returned values of {result.breakdown.totalGroups}. {result.breakdown.truncated?`${total-result.breakdown.returnedGroupEvents!} tagged pageviews across ${result.breakdown.totalGroups!-rows.length} other values are omitted from the exact table and CSV breakdown.`:'No matching values were omitted.'} The ring combines smaller returned values; the exact table below does not.</Text>
            <DataTable stickyHeader ariaLabel={`${label} exact values`} searchable={false} sortable={false} pagination={false} rows={rows} rowKey={row=>row.value as string} columns={[{key:'value',header:label,wrap:true,render:row=><bdi>{row.value as string}</bdi>},{key:'events',header:'Tagged pageviews',numeric:true},{key:'share',header:'Share of tagged pageviews',numeric:true,render:row=>`${(row.events/total*100).toFixed(1)}%`}]}/>
          </>}
          <Button type="button" variant="secondary" onClick={()=>download(field,panel)}>Download {label.toLowerCase()} CSV</Button>
          <Text tone="muted" size="sm">Includes the applied dates, filters, daily rows and returned campaign values.</Text>
        </>}
      </Stack></Card>;
    })}</Grid>
  </Stack>;
}
