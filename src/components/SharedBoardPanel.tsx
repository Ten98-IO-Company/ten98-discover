import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {readResponseText} from '@ten98/runtime';
import {DataTable} from '@ten98/ui';
import {formatReportInstant} from '../lib/report-time';
import {boardLimits,decodePublicBoardManifest,decodePublicBoardCard,parseHostedBoardShare,parseHostedWebsiteShare,type PublicBoardCard} from '../lib/boards';
import {decodePublicWebsiteShare,websiteShareLimits,type PublicWebsiteShare} from '../lib/website-shares';
import {serializeGeographyKey,type GeoCountryKey} from '../lib/analytics-geography';
import {Stats,Coverage,ActivityView,ScopeFields,scopeValue,rowStyle,cardLabel,n,atomLabel} from './BoardsPanel';
import {CountryMap,geographyLabel} from './GeographyCard';
import {DailyChart} from './AnalyticsPanel';
import {GeographyAttribution} from './GeographyAttribution';
import {PropertyShares} from './ExplorerPanel';
import {MinuteChart} from './RealtimePanel';
import {RevenueTrend} from './RevenuePanel';

type Manifest=NonNullable<ReturnType<typeof decodePublicBoardManifest>>;
type Card=NonNullable<Manifest['rows'][number]['cards'][number]>;
const unavailable='This shared board is unavailable, revoked, expired or could not be verified.';
const percent=(value:number|null)=>value===null?'Unavailable':(value*100).toFixed(1)+'%';
const money=(value:string|null,currency:string)=><bdi dir="ltr">{value===null?'Unavailable':value+' '+currency}</bdi>;
function Table({name,columns,rows}:{name:string;columns:string[];rows:ReactNode[][]}){
 return <DataTable ariaLabel={name} searchable={false} sortable={false} pagination={false} responsive="stack" emptyTitle="No matching retained rows." emptyDescription="Unavailable evidence is not zero." rows={rows.map((cells,i)=>({cells,i}))} rowKey={(row:{i:number})=>String(row.i)} columns={columns.map((label,j)=>({key:'c'+j,header:label,rowHeader:j===0,wrap:true,render:(row:{cells:ReactNode[]})=>row.cells[j]}))}/>;
}
function PublicCard({value}:{value:PublicBoardCard}){
 if(value.status==='unsupported')return <p role="status" className="banner">{value.message} No other scope or dataset was substituted.</p>;
 const retention='coverage'in value.data?<><Coverage value={value.data.coverage.status}/>{value.data.coverage.retainedFrom&&<p className="hint">Retained from <time dateTime={value.data.coverage.retainedFrom}>{formatReportInstant(value.data.coverage.retainedFrom,'UTC')}</time>.</p>}</>:null;
 let body:ReactNode;
 switch(value.cardType){
 case'TextBlock':body=<p style={{whiteSpace:'pre-wrap'}}>{value.data.text||'Empty text card'}</p>;break;
 case'WebsiteMetricsBar':{const d=value.data;body='measurement'in d?<><Stats values={[{label:d.kind==='link'?'Accepted redirect requests':'Accepted image loads',value:n(d.summary.requests)},{label:'Estimated visitors',value:n(d.summary.estimatedVisitors)},{label:'Estimated visits',value:n(d.summary.estimatedVisits)}]}/><p className="hint">HTTP requests, not people or email opens. Proxies, caching and prefetching can change counts.</p></>:<><Stats values={[{label:'Recorded pageviews',value:n(d.pageViews)},{label:'Estimated visitors',value:n(d.visitors)},{label:'Observed visits',value:n(d.visits)},{label:'Bounce rate',value:d.bounceRate===null?'Unavailable':d.bounceRate.toFixed(1)+'%'},{label:'Average observed visit',value:d.averageVisitSeconds===null?'Unavailable':d.averageVisitSeconds.toFixed(1)+' s'}]}/><p className="hint">Visits and duration use selected retained pageviews. A retained custom event in the same visit and date range prevents a bounce, even when report filters exclude it.</p></>;break;}
 case'EventsMetricsBar':{const d=value.data;body=<Stats values={[{label:'Recorded custom events',value:n(d.customEvents)},{label:'Estimated visitors',value:n(d.visitors)},{label:'Observed visits',value:n(d.visits)},{label:'Recorded event names',value:n(d.eventNames)}]}/>;break;}
 case'WebsiteChart':{const d=value.data,asset='measurement'in d;body=<ActivityView countLabel={asset?(d.kind==='link'?'Accepted redirect requests':'Accepted image loads'):'Recorded pageviews'} data={{profile:'visitors',range:d.range,coverage:d.coverage,daily:d.daily.map(day=>({...day,events:'requests'in day?day.requests:day.pageViews})),weekly:[],series:[],eventNames:null}}/>;break;}
 case'WeeklyTraffic':{const d=value.data;body=<ActivityView data={{...d,profile:'weekly',daily:[],series:[],eventNames:null}}/>;break;}
 case'EventsChart':body=<ActivityView data={{...value.data,profile:'events',weekly:[]}}/>;break;
 case'RealtimeHeader':{const d=value.data;body=<><Stats values={[{label:'Pageviews · last 30 minutes',value:n(d.pageViews)},{label:'Custom events · last 30 minutes',value:n(d.customEvents)},{label:'Estimated visitors · last 30 minutes',value:n(d.estimatedVisitors)},{label:'Recorded known-country groups',value:n(d.knownCountryGroups)}]}/><p>Snapshot as of <time dateTime={d.asOf}>{formatReportInstant(d.asOf,'UTC')}</time>.</p></>;break;}
 case'RealtimeChart':body=<><MinuteChart data={value.data}/><p>Snapshot as of <time dateTime={value.data.asOf}>{formatReportInstant(value.data.asOf,'UTC')}</time>.</p></>;break;
 case'RealtimeActiveUsers':body=<><Stats values={[{label:'Active visitor estimates · last 5 minutes',value:n(value.data.estimatedVisitors)}]}/><p>Rotating visitor keys, not verified people online. Snapshot as of <time dateTime={value.data.asOf}>{formatReportInstant(value.data.asOf,'UTC')}</time>.</p></>;break;
 case'Goal':{const d=value.data,c=d.definition.condition;body=<><h4>{d.definition.name} · revision {d.analysisRevision}</h4><p>{d.definition.description}</p><p>{c.type} {c.match} <bdi>{c.value}</bdi></p>{d.goal?<><Stats values={[{label:'Qualified visitor estimates',value:n(d.goal.visitors)},{label:'Total visitor estimates',value:n(d.goal.totalVisitors)},{label:'Conversion rate',value:percent(d.goal.rate)}]}/>{d.goal.rate!==null&&<progress max={1} value={d.goal.rate} aria-label="Goal conversion rate" aria-valuetext={percent(d.goal.rate)}/>}</>:<p>Goal evidence unavailable.</p>}</>;break;}
 case'Funnel':{const d=value.data;body=<><h4>{d.definition.name} · revision {d.analysisRevision}</h4><p>{d.definition.description}</p><p>Ordered steps, with up to {d.definition.windowMinutes} minutes between adjacent steps.</p><Table name="Shared funnel steps" columns={['Step and condition','Visitor estimates','Dropped','Conversion','Remaining']} rows={d.steps.map(step=>{const condition=d.definition.steps[step.step-1];return[condition?<><bdi>{step.step}. {condition.condition.type} {condition.condition.match} {condition.condition.value}</bdi><p>{condition.pageViewsOnly?'Pageviews only':'Matching activity'}</p>{condition.properties.map((p,i)=><p key={i}><bdi>{p.key} {p.operator}{'value'in p?' '+JSON.stringify(p.value)+' ('+p.type+')':''}</bdi></p>)}</>:'Unavailable step',n(step.visitors),n(step.dropped),percent(step.conversionRate),percent(step.remainingRate)];})}/></>;break;}
 case'RevenueMetricsBar':{const d=value.data;body=<Stats values={[{label:'Recorded net',value:money(d.net,d.currency)},{label:'Average sale observation',value:money(d.averageSale,d.currency)},{label:'Net per qualified revenue key',value:money(d.keyedNetPerQualifiedKey,d.currency)},{label:'Sale observations',value:n(d.saleObservations)},{label:'Revenue key estimates',value:n(d.revenueKeys)}]}/>;break;}
 case'RevenueChart':{const d=value.data;body=d.available?<RevenueTrend keyboardScroll report={{range:d.range,query:{currency:d.currency},daily:d.daily,series:d.series}}/>:<p>Recorded revenue is unavailable, not zero.</p>;break;}
 case'RevenueMetricsTable':{const d=value.data,b=d.breakdown;body=b?<><Table name="Shared revenue breakdown" columns={[d.dimension,'Net','Sales','Refunds','Sale share']} rows={b.rows.map(row=>[<bdi>{atomLabel(row.key)}</bdi>,money(row.totals.net,d.currency),money(row.totals.sales,d.currency),money(row.totals.refunds,d.currency),row.saleShare===null?'Unavailable':row.saleShare+'%'])}/><p>{b.rows.length} returned of {b.totalGroups} groups; omitted net {money(b.omitted.net,d.currency)}. Full sales denominator {money(d.sales,d.currency)}.</p></>:<p>Recorded revenue is unavailable, not zero.</p>;break;}
 case'UTM':case'MetricsTable':case'WorldMap':{const d=value.data;
  if('rows'in d){body=<><Table name="Shared dimension data" columns={[d.dimension,d.metric==='observed-visits'?'Observed visits':'Recorded pageviews','Visitor estimates']} rows={d.rows.map(row=>[<bdi>{atomLabel(row.key)}</bdi>,n(row.units),n(row.estimatedVisitors)])}/><p>{d.rows.length} returned of {n(d.totalGroups)} groups; {n(d.omittedUnits)} units omitted.</p>{(d.dimension==='entry'||d.dimension==='exit')&&<p className="hint">First or last retained pageview in the selected whole window for visits with matching activity; not full-history entry or exit. {n(d.evidence.windowClippedVisits)} window-clipped visits; {n(d.evidence.orderingTieVisits)} tied boundaries. Retention clipping is unknown.</p>}</>;
  }else{const asset='measurement'in d,rows=d.groups.map(row=>'key'in row?{key:row.key,count:row.requests,visitors:row.estimatedVisitors}:{key:row.value,count:row.events,visitors:row.visitors}),total='returnedRequests'in d?d.returnedRequests:d.returnedEvents;const map=rows.flatMap(row=>{const key=serializeGeographyKey('country',row.key);return key&&row.count!==null?[{key:JSON.parse(key)as GeoCountryKey,pageViews:row.count,visitors:row.visitors}]:[];});
   body=<>{value.cardType==='WorldMap'&&d.coverage.status!=='unavailable'&&rows.every(row=>row.count!==null)&&<><CountryMap rows={map} countLabel={asset?'Accepted requests':'Recorded pageviews'} preferVisitors={!asset}/><GeographyAttribution/></>}{value.cardType==='UTM'&&rows.every(row=>row.count!==null)&&<PropertyShares items={rows.map((row,i)=>({key:String(i),label:atomLabel(row.key),count:row.count!}))} total={total} label="Returned UTM groups" noun="pageviews"/>}<Table name="Shared dimension data" columns={[d.dimension,asset?'Accepted requests':'Recorded events','Visitor estimates']} rows={rows.map(row=>[<bdi>{atomLabel(row.key)}</bdi>,n(row.count),n(row.visitors)])}/><p>{rows.length} returned of {n(d.totalGroups)} groups{d.truncated?' · Additional groups omitted':''}. {asset?'Requests are not people or email opens.':'Visitor estimates can overlap; UTM shares describe only returned groups.'}</p></>;
  }break;}
 }
 return <>{retention}{body}{'evidenceIncomplete'in value.data&&value.data.evidenceIncomplete&&<p className="banner">Revenue evidence is incomplete. Missing observations can change attribution and totals; these are not lower bounds.</p>}</>;
}
class ShareReadError extends Error{readonly status:number;constructor(status=0){super(unavailable);this.status=status;}}
async function request(path:string,token:string,signal:AbortSignal,body?:unknown,header='X-Ten98-Board-Share'):Promise<unknown>{
 const active=AbortSignal.any([signal,AbortSignal.timeout(25000)]);
 const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',signal:active,headers:{[header]:token,...body===undefined?{}:{'Content-Type':'application/json'}},...body===undefined?{}:{body:JSON.stringify(body)}});
 if(!response.ok){await response.body?.cancel();throw new ShareReadError(response.status);}if(!response.body||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw new ShareReadError();
 try{return JSON.parse(await readResponseText(response,{maxBytes:boardLimits.responseBytes,signal:active}));}catch(error){throw error instanceof RangeError?new ShareReadError():error;}
}
const fragmentValue=(value:string)=>value.startsWith('#')?value.slice(1):value;
type ShareEntryCapture={owner:string;seenFragment:string;capturedFragment:string|null;rawFragment:string|null;scrubPending:boolean;version:number};
type ShareKind='boards'|'websites';
const entryCopy={boards:{heading:'Shared board',loading:'Loading shared board…',malformed:'No board was requested.',parse:parseHostedBoardShare},websites:{heading:'Shared website',loading:'Loading shared website…',malformed:'No website data was requested.',parse:parseHostedWebsiteShare}} as const;
export function SharedBoardPanel({kind='boards',path,search,fragment,entry,historyState}:{kind?:ShareKind;path:string;search:string;fragment:string;entry:string;historyState:object}){
 const held=useRef<ShareEntryCapture|null>(null),owner=JSON.stringify([entry,path,search]),seen=fragmentValue(fragment);
 let capture=held.current;
 if(!capture||capture.owner!==owner||capture.seenFragment!==seen&&!(capture.scrubPending&&seen==='')){capture={owner,seenFragment:seen,capturedFragment:null,rawFragment:null,scrubPending:false,version:(capture?.version??0)+1};held.current=capture;}
 else if(capture.seenFragment!==seen){capture.seenFragment=seen;capture.scrubPending=false;}
 const owned=capture,currentEntry=()=>held.current===owned&&window.location.pathname===path&&window.location.search===search&&owned.rawFragment!==null&&window.location.hash===owned.rawFragment;
 const captureFragment=()=>{if(held.current!==owned||window.location.pathname!==path||window.location.search!==search)return undefined;if(owned.capturedFragment===null){owned.capturedFragment=window.location.hash;owned.rawFragment=owned.capturedFragment;}return currentEntry()?owned.capturedFragment:undefined;};
 return <SharedEntry key={owned.version} kind={kind} path={path} search={search} historyState={historyState} captureFragment={captureFragment} currentEntry={currentEntry} beforeScrub={()=>{if(held.current===owned){owned.scrubPending=true;owned.rawFragment='';}}}/>;
}
function SharedEntry({kind,path,search,historyState,captureFragment,currentEntry,beforeScrub}:{kind:ShareKind;path:string;search:string;historyState:object;captureFragment:()=>string|undefined;currentEntry:()=>boolean;beforeScrub:()=>void}){
 const [link,setLink]=useState<ReturnType<typeof parseHostedBoardShare>|undefined>(undefined),copy=entryCopy[kind];
 useEffect(()=>{const rawFragment=captureFragment();if(rawFragment===undefined)return;const parsed=copy.parse(path,search,rawFragment);beforeScrub();if(rawFragment)window.history.replaceState(window.history.state??historyState,'',window.location.pathname+window.location.search);if(currentEntry())setLink(parsed);},[]);
 return link===undefined?<main className="boards-panel tracked-shared stack"><h1>{copy.heading}</h1><p role="status">{copy.loading}</p></main>:link?kind==='websites'?<SharedWebsiteSession link={link} currentEntry={currentEntry}/>:<SharedSession link={link} currentEntry={currentEntry}/>:<main className="boards-panel tracked-shared stack"><h1>{copy.heading}</h1><p role="alert">This link is incomplete or malformed. Open the original link from its owner. {copy.malformed}</p></main>;
}
function SharedSession({link,currentEntry}:{link:NonNullable<ReturnType<typeof parseHostedBoardShare>>;currentEntry:()=>boolean}){
 const [manifest,setManifest]=useState<Manifest|null>(null),[results,setResults]=useState<Record<string,PublicBoardCard>>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[scope,setScope]=useState(''),[draft,setDraft]=useState(''),[filterError,setFilterError]=useState('');
 const mounted=useRef(false),serial=useRef(0),active=useRef<AbortController|null>(null),terminal=useRef(false),paused=useRef(false),scopeRef=useRef(''),manifestRef=useRef<Manifest|null>(null);
 const purge=(clearContext=true)=>{serial.current++;active.current?.abort();active.current=null;if(clearContext)manifestRef.current=null;setManifest(null);setResults({});setBusy(false);};
 async function refresh(nextScope?:string){
  if(!mounted.current||!currentEntry()||document.hidden||active.current||terminal.current)return;
  const ctrl=new AbortController(),generation=++serial.current;active.current=ctrl;paused.current=false;setBusy(true);setError('');setResults({});setManifest(null);const current=()=>mounted.current&&!ctrl.signal.aborted&&serial.current===generation&&!terminal.current&&currentEntry();
  try{const data=decodePublicBoardManifest(await request('/api/board-shares/'+link.shareId+'/manifest',link.token,ctrl.signal),link.shareId);if(!current())return;if(!data||Date.parse(data.expiresAt)<=Date.now())throw new ShareReadError(404);scopeValue(data.scope);
   const applied=nextScope??(manifestRef.current?.grantRevision===data.grantRevision?scopeRef.current:data.scope);scopeValue(applied);manifestRef.current=data;scopeRef.current=applied;setScope(applied);setDraft(applied);setManifest(data);
   const queue=data.rows.flatMap(row=>row.cards.filter((card):card is Card=>card!==null));let index=0;
   const worker=async()=>{for(;;){const card=queue[index++];if(!card||!current())return;const raw=await request('/api/board-shares/'+link.shareId+'/cards/'+card.id+'/read',link.token,ctrl.signal,{grantRevision:data.grantRevision,boardRevision:data.boardRevision,scope:applied});if(!current())return;const decoded=decodePublicBoardCard(raw,{shareId:link.shareId,grantRevision:data.grantRevision,boardRevision:data.boardRevision,cardId:card.id,cardType:card.type,scope:applied,entityKind:card.type==='TextBlock'?'none':card.entityKind});if(!decoded)throw new ShareReadError();if(Date.parse(data.expiresAt)<=Date.now())throw new ShareReadError(404);if(decoded.status==='ready'&&decoded.cardType==='WorldMap'&&decoded.data.groups.some(row=>serializeGeographyKey('country','key'in row?row.key:row.value)===null))throw new ShareReadError();if(current())setResults(previous=>({...previous,[card.id]:decoded}));}};
   await Promise.all([worker(),worker()]);
  }catch(cause){if(!current())return;const authority=cause instanceof ShareReadError&&[401,403,404].includes(cause.status);if(authority)terminal.current=true;paused.current=true;purge(authority);setError(cause instanceof ShareReadError&&cause.status===409?'The approved board or scope changed. Refresh the current share before continuing.':unavailable);}
  finally{if(active.current===ctrl){active.current=null;if(current())setBusy(false);}}
 }
 useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;serial.current++;active.current?.abort();};},[]);
 useEffect(()=>{void refresh();const visible=()=>{if(document.hidden)purge(false);else if(!paused.current)void refresh();},timer=setInterval(()=>{if(!document.hidden&&!paused.current)void refresh();},30000);document.addEventListener('visibilitychange',visible);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visible);};},[]);
 useEffect(()=>{if(!manifest)return;let timer:ReturnType<typeof setTimeout>;const expire=()=>{const remaining=Date.parse(manifest.expiresAt)-Date.now();if(remaining>0){timer=setTimeout(expire,Math.min(remaining,2147483647));return;}terminal.current=true;purge();setError('This shared board has expired. Open a current link from its owner.');};expire();return()=>clearTimeout(timer);},[manifest]);
 function apply(){try{const next=scopeValue(draft);setFilterError('');void refresh(next);}catch{setFilterError('Use valid dates, a named time zone and supported exact filters. Approved boundaries are checked by the server.');}}
 const params=new URLSearchParams(scope);
 return <main className="boards-panel tracked-shared stack" data-theme={manifest?.theme??'light'}><h1>Shared board</h1><div><button className="btn" disabled={busy||terminal.current} onClick={()=>void refresh()}>Refresh shared board</button></div>{busy&&<p role="status">Loading approved card data…</p>}{error&&<p role="alert" className="alert">{error}</p>}{manifest&&<><h2><bdi>{manifest.label}</bdi></h2><p>Approved board revision {manifest.boardRevision} · share revision {manifest.grantRevision} · expires <time dateTime={manifest.expiresAt}>{formatReportInstant(manifest.expiresAt,'UTC')}</time>.</p><p>Historical scope: {params.get('from')} to {params.get('to')} · {params.get('timeZone')}. Live cards use their own fixed recent window{manifest.ongoingLive?'; ongoing live access is approved':'.'}.</p><details><summary>Approved scope and filters</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{[...new URLSearchParams(manifest.scope)].map(([key,value])=>key+': '+value).join('\n')}</pre></details>{manifest.allowFilter&&<details><summary>Narrow this shared report</summary><ScopeFields value={draft} onChange={setDraft}/><button className="btn" disabled={busy} onClick={apply}>Apply approved filters</button>{filterError&&<p role="alert">{filterError}</p>}<p className="hint">The owner’s dates and fixed filters cannot be widened. Unsupported changes are refused, never silently removed.</p></details>}<section className="stack" aria-label="Shared board cards">{manifest.rows.map(row=><div className={'board-row board-columns-'+row.cards.length} key={row.id} style={rowStyle(row)}>{row.cards.map((card,i)=>card?<section className="card stack board-result" key={card.id} style={{minHeight:row.minHeight}}><h3>{card.title??cardLabel(card.type,card.type==='TextBlock'?null:{kind:card.entityKind})}</h3>{card.description&&<p>{card.description}</p>}{card.type!=='TextBlock'&&<p className="hint"><bdi>{card.entityLabel}</bdi></p>}{results[card.id]?<PublicCard value={results[card.id]}/>:<p role="status">Loading this approved card…</p>}</section>:<div className="card board-empty" aria-hidden="true" key={'empty-'+i}/>)}</div>)}</section></>}<p className="hint">Only the selected cards and approved scope are shared. Access is checked on every read and while this tab is visible. Visitor counts are estimates, not verified people. The secret was removed from the address bar; after reloading, reopen the original link.</p></main>;
}
const websiteUnavailable='This shared website is unavailable, revoked, expired or could not be verified.';
const utcDay=(offsetDays=0)=>new Date(Date.now()+offsetDays*864e5).toISOString().slice(0,10);
const touch={minHeight:44,maxWidth:'100%'};
const metric=(value:number|null,unit='')=>value===null?'Unavailable':value.toFixed(1)+unit;
function SharedWebsiteSession({link,currentEntry}:{link:NonNullable<ReturnType<typeof parseHostedWebsiteShare>>;currentEntry:()=>boolean}){
 const [data,setData]=useState<PublicWebsiteShare|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[draft,setDraft]=useState(()=>({from:utcDay(-6),to:utcDay()})),[rangeError,setRangeError]=useState('');
 const mounted=useRef(false),serial=useRef(0),active=useRef<AbortController|null>(null),terminal=useRef(false),paused=useRef(false),range=useRef(draft);
 const purge=()=>{serial.current++;active.current?.abort();active.current=null;setData(null);setBusy(false);};
 async function refresh(){
  if(!mounted.current||!currentEntry()||document.hidden||active.current||terminal.current)return;
  const ctrl=new AbortController(),generation=++serial.current,applied=range.current;active.current=ctrl;paused.current=false;setBusy(true);setError('');
  const current=()=>mounted.current&&!ctrl.signal.aborted&&serial.current===generation&&!terminal.current&&currentEntry();
  try{const decoded=decodePublicWebsiteShare(await request('/api/website-shares/'+link.shareId+'/read',link.token,ctrl.signal,applied,'X-Ten98-Website-Share'),link.shareId,applied);if(!current())return;if(!decoded)throw new ShareReadError();setData(decoded);}
  catch(cause){if(!current())return;const status=cause instanceof ShareReadError?cause.status:0;if([401,403,404].includes(status))terminal.current=true;paused.current=true;purge();setError(status===400?'Choose a valid UTC date range of 1 to 366 days.':status===429?'This shared website was read too often. Wait a minute, then refresh.':websiteUnavailable);}
  finally{if(active.current===ctrl){active.current=null;if(current())setBusy(false);}}
 }
 useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;serial.current++;active.current?.abort();};},[]);
 useEffect(()=>{void refresh();const visible=()=>{if(document.hidden)purge();else if(!paused.current)void refresh();},timer=setInterval(()=>{if(!document.hidden&&!paused.current)void refresh();},websiteShareLimits.refreshMs);document.addEventListener('visibilitychange',visible);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visible);};},[]);
 useEffect(()=>{if(!data)return;let timer:ReturnType<typeof setTimeout>;const expire=()=>{const remaining=Date.parse(data.expiresAt)-Date.now();if(remaining>0){timer=setTimeout(expire,Math.min(remaining,2147483647));return;}terminal.current=true;purge();setError('This shared website has expired. Open a current link from its owner.');};expire();return()=>clearTimeout(timer);},[data]);
 function apply(){
  const day=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)?Date.parse(value+'T00:00:00.000Z'):NaN,days=(day(draft.to)-day(draft.from))/864e5+1;
  if(!(days>=1&&days<=366)){setRangeError('Choose a start date on or before the end date, 1 to 366 days, in UTC.');return;}
  setRangeError('');range.current={...draft};active.current?.abort();active.current=null;void refresh();
 }
 const d=data,o=d?.overview,e=d?.events,l=d?.locations,environment=(rows:{value:string|null;pageViews:number;visitors:number|null}[])=>rows.map(row=>[<bdi>{row.value??'Not recorded'}</bdi>,n(row.pageViews),n(row.visitors)]);
 return <main className="boards-panel tracked-shared stack"><h1>Shared website</h1>
  <form className="row" style={{flexWrap:'wrap',alignItems:'end'}} onSubmit={event=>{event.preventDefault();apply();}}>
   <label>From (UTC)<input className="input" type="date" required value={draft.from} onChange={event=>setDraft({...draft,from:event.target.value})} style={touch}/></label>
   <label>To (UTC)<input className="input" type="date" required value={draft.to} onChange={event=>setDraft({...draft,to:event.target.value})} style={touch}/></label>
   <button className="btn" type="submit" disabled={busy||terminal.current} style={touch}>Show these dates</button>
   <button className="btn" type="button" disabled={busy||terminal.current} style={touch} onClick={()=>void refresh()}>Refresh shared website</button>
  </form>
  {rangeError&&<p role="alert">{rangeError}</p>}{busy&&<p role="status">Loading the shared website…</p>}{error&&<p role="alert" className="alert">{error}</p>}
  {d&&<><h2><bdi>{d.label}</bdi></h2><p>{d.range.from} to {d.range.to} (UTC) · expires <time dateTime={d.expiresAt}>{formatReportInstant(d.expiresAt,'UTC')}</time>.</p><Coverage value={d.coverage.status}/>{d.coverage.retainedFrom&&<p className="hint">Retained from <time dateTime={d.coverage.retainedFrom}>{formatReportInstant(d.coverage.retainedFrom,'UTC')}</time>.</p>}
   {o&&<section className="card stack" aria-label="Shared overview"><h3>Overview</h3>
    <Stats values={[{label:'Recorded pageviews',value:n(o.pageViews)},{label:'Estimated visitors',value:n(o.visitors)},{label:'Observed visits',value:n(o.visits)},{label:'Bounce rate',value:metric(o.bounceRate,'%')},{label:'Average observed visit',value:metric(o.averageVisitSeconds,' s')}]}/>
    <DailyChart daily={o.daily.map(day=>({...day,customEvents:null}))} metrics={['pageViews']}/>
    <Table name="Daily pageviews" columns={['Date (UTC)','Recorded pageviews']} rows={o.daily.map(day=>[day.date,day.coverage==='unavailable'?'Unavailable':n(day.pageViews)])}/>
    <Table name="Top pages" columns={['Path','Recorded pageviews']} rows={o.pages.map(row=>[<bdi>{row.path}</bdi>,n(row.pageViews)])}/>
    <Table name="Top referrers" columns={['Referrer host','Recorded pageviews','Estimated visitors']} rows={o.referrers.map(row=>[<bdi>{row.host}</bdi>,n(row.pageViews),n(row.visitors)])}/>
    <Table name="Browsers" columns={['Browser','Recorded pageviews','Estimated visitors']} rows={environment(o.browsers)}/>
    <Table name="Operating systems" columns={['Operating system','Recorded pageviews','Estimated visitors']} rows={environment(o.operatingSystems)}/>
    <Table name="Devices" columns={['Device','Recorded pageviews','Estimated visitors']} rows={environment(o.devices)}/>
    {d.coverage.status!=='unavailable'&&<><CountryMap rows={o.countries}/><GeographyAttribution/></>}
    <Table name="Countries" columns={['Country','Recorded pageviews','Estimated visitors']} rows={o.countries.map(row=>[<bdi>{geographyLabel(row.key)}</bdi>,n(row.pageViews),n(row.visitors)])}/>
   </section>}
   {e&&<section className="card stack" aria-label="Shared events"><h3>Events</h3>
    <Stats values={[{label:'Recorded custom events',value:n(e.customEvents)}]}/>
    <DailyChart daily={e.daily.map(day=>({...day,pageViews:null}))} metrics={['customEvents']}/>
    <Table name="Daily custom events" columns={['Date (UTC)','Recorded custom events']} rows={e.daily.map(day=>[day.date,day.coverage==='unavailable'?'Unavailable':n(day.customEvents)])}/>
    <Table name="Top custom events" columns={['Event name','Recorded events']} rows={e.names.map(row=>[<bdi>{row.name}</bdi>,n(row.count)])}/>
   </section>}
   {l&&<section className="card stack" aria-label="Shared locations"><h3>Regions and cities</h3>
    <Table name="Regions" columns={['Region','Recorded pageviews','Estimated visitors']} rows={l.regions.map(row=>[<bdi>{geographyLabel(row.key,row.regionName)}</bdi>,n(row.pageViews),n(row.visitors)])}/>
    <Table name="Cities" columns={['City','Recorded pageviews','Estimated visitors']} rows={l.cities.map(row=>[<bdi>{geographyLabel(row.key,row.regionName)}</bdi>,n(row.pageViews),n(row.visitors)])}/>
    <GeographyAttribution/>
   </section>}
  </>}
  <p className="hint">Only the sections its owner approved are shared, and access is checked again on every read while this tab is visible. Visitor counts are estimates, not verified people. The secret was removed from the address bar; after reloading, reopen the original link.</p></main>;
}