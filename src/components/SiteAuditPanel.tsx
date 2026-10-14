import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {api,ApiError,errMsg} from '../lib/api';

type Role='owner'|'admin'|'editor'|'viewer';
type Status='queued'|'running'|'cancelling'|'completed'|'partial'|'failed'|'cancelled';
type Coverage='unavailable'|'blocked'|'rate_limited'|'robots_disallowed'|'not_fetched'|'http_error'|'redirect'|'non_html'|'partial'|'shell'|'analyzed';
type Setup={role:Role;canStart:boolean;origins:{domainId:string|null;origin:string;authority:'canonical_project'|'verified_serving'}[];limits:{defaultPages:number;maxPages:number;maxMinutes:number;requestsPerSecond:number;bodyCapacityBytes:number;frontier:number;edges:number;sitemapDocuments:number;sitemapDepth:number};worker:{status:'ready'|'unavailable';lastHeartbeatAt:string|null}};
type Run={id:string;projectId:string;domainId:string|null;origin:string;status:Status;phase:'robots'|'discovery'|'pages'|'finalizing'|null;createdAt:string;startedAt:string|null;completedAt:string|null;deadlineAt:string;stopReason:string|null;canCancel:boolean;canDelete:boolean;config:{mode:'static';retainBodyText?:boolean;startPath:string;startUrl:string;maxPages:number;requestLimit:number;bodyCapacityBytes:number;frontierLimit:number;edgeLimit:number;sitemapDocuments:number;sitemapDepth:number};coverage:{reasons:string[];discoveryComplete:boolean;linksComplete:boolean;scopeExclusions:number;rawEvidenceRecorded:boolean;unavailablePages?:number;unfetchedPages?:number};summary:null|{pagesObserved:number;pagesAnalyzed:number;htmlPagesDiscovered:number;issuesDetected:number;issuesRetained:number;findingsComplete:boolean;retainedBySeverity:{critical:number;warning:number;info:number};graph:{status:string;reasons:string[];checks:Record<string,string>;findingsComplete:boolean}};progress:{requests:number;htmlPagesStarted:number;sitemapDocumentsStarted:number;frontier:number;edges:number;bodyCapacityChargedBytes:number;observedWireBytes:number;observedHttpDecodedBytes:number;observedDecodedBytes:number};dataStatus:'available'|'expired';rawEvidenceStatus:'available'|'expired'|'not_recorded';rawExpiredAt:string|null;dataExpiredAt:string|null};
type Facts={titleLength:number;descriptionLength:number;headingCounts:number[];headingOrder:number[];wordCount:number;imagesTotal:number;imagesMissingAlt:number;linksTotal:number;internalLinks:number;externalLinks:number;unresolvedLinks:number;structuredDataPresent:boolean;hreflangCount:number;indexability:'noindex_observed'|'no_noindex_observed'|'unknown';canonical:'none'|'self'|'other'|'conflict'|'invalid';invalidCanonicals:number};
type Evidence={title:string;description:string;htmlCanonicals:string[];headerCanonicals:string[];robotsMeta:string[];xRobotsTags:string[];headings:string[];images:{src:string|null;alt:string|null}[];openGraph:{title:string|null;description:string|null;image:string|null};hreflang:{language:string;url:string}[]};
type BodyEvidence={status:'not_recorded'|'pending'|'available'|'empty'|'unavailable'|'over_limit'|'expired';version:string|null;utf8Bytes:number|null;textIncluded:boolean;text:string|null};
type Page={id:string;url:string;resourceKind:'html'|'robots'|'sitemap';state:string;sources:{start:boolean;link:boolean;sitemap:boolean};linkDepth:number|null;sitemapDepth:number;observedAt:string|null;httpStatus:number|null;fetchState:string;analysis:{coverage:Coverage;reasons:string[];facts:Facts|null};responseTimeMs:number|null;rawEvidenceStatus:'not_recorded'|'expired'|'truncated'|'available';evidenceIncluded:boolean;evidence:Evidence|null;bodyEvidence?:BodyEvidence};
type Issue={id:string;pageId:string|null;targetPageId:string|null;relatedPageIds:string[];code:string;severity:'critical'|'warning'|'info';ruleVersion:string;details:Record<string,number>};
type Edge={id:string;kind:'link'|'redirect'|'sitemap';sourcePageId:string;targetPageId:string|null;targetUrl:string;nofollow:boolean;anchor:string|null;anchorStatus:'expired'|'not_recorded'|'available'};
type List<T>={rows:T[];cursor:string|null;loaded:boolean};
type Filters={severity:string;code:string;pageId:string;coverage:string;resourceKind:'html'|'robots'|'sitemap'};
type View={runId:string|null;pageId:string|null;tab:'issues'|'pages';direction:'in'|'out';filters:Filters};
type Slot='setup'|'history'|'run'|'results'|'page'|'links';
type Read={epoch:number;ticket:number;controller:AbortController};
type Attempt={requestId:string;domainId:string|null;startPath:string;maxPages:number;mode:'static';retainBodyText:boolean};
type Props={projectId:string;userId:string;onUnauthorized:()=>void;onOpenDomains:()=>void;onOpenRetention:()=>void};
const statuses:Status[]=['queued','running','cancelling','completed','partial','failed','cancelled'];
const active=(s:Status)=>s==='queued'||s==='running'||s==='cancelling';
const manages=(r:Role|null)=>r==='owner'||r==='admin';
const empty=<T,>():List<T>=>({rows:[],cursor:null,loaded:false});
const filters=():Filters=>({severity:'',code:'',pageId:'',coverage:'',resourceKind:'html'});
const initialView=():View=>({runId:null,pageId:null,tab:'issues',direction:'out',filters:filters()});
const covers:Coverage[]=['analyzed','partial','shell','redirect','non_html','http_error','blocked','rate_limited','robots_disallowed','not_fetched','unavailable'];
const coverageLabels:Record<Coverage,string>={analyzed:'Analyzed',partial:'Partially analyzed',shell:'JavaScript rendering suspected',redirect:'Redirect',non_html:'Not HTML',http_error:'HTTP error',blocked:'Blocked',rate_limited:'Rate limited',robots_disallowed:'Disallowed by robots',not_fetched:'Not fetched',unavailable:'Unavailable'};
const issueCodes='blocked-page,rate-limited-page,server-error,broken-page,slow-response,noindex-page,canonical-conflict,canonicalized-page,deep-page,javascript-rendering-suspected,missing-title,title-too-long,title-too-short,missing-meta-description,meta-description-too-long,meta-description-too-short,missing-h1,multiple-h1,heading-order-skip,thin-content,images-missing-alt,no-outgoing-links,duplicate-title,duplicate-meta-description,duplicate-content,redirect-chain,redirect-loop,broken-internal-link,orphan-page'.split(',');
const words=(s:string)=>s.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]/g,' ').replace(/^./,c=>c.toUpperCase());
const date=(s:string|null)=>s&&Number.isFinite(Date.parse(s))?new Date(s).toLocaleString():'Not recorded';
const number=(n:number|null|undefined)=>n==null?'Unavailable':n.toLocaleString();
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const roleValue=(v:unknown):v is Role=>['owner','admin','editor','viewer'].includes(v as string);
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(x=>typeof x==='string');
const timestamp=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
function validRun(v:unknown,projectId:string):v is Run {
  if(!record(v)||!uuid(v.id)||v.projectId!==projectId||v.domainId!==null&&!uuid(v.domainId)||!statuses.includes(v.status as Status)||typeof v.origin!=='string'||!record(v.config)||!record(v.progress)||!record(v.coverage))return false;
  const config=v.config,progress=v.progress,coverage=v.coverage;
  if(config.mode!=='static'||config.retainBodyText!==undefined&&typeof config.retainBodyText!=='boolean'||typeof config.startPath!=='string'||typeof config.startUrl!=='string'||!['maxPages','requestLimit','bodyCapacityBytes','frontierLimit','edgeLimit','sitemapDocuments','sitemapDepth'].every(key=>count(config[key])))return false;
  if(!['requests','htmlPagesStarted','sitemapDocumentsStarted','frontier','edges','bodyCapacityChargedBytes','observedWireBytes','observedHttpDecodedBytes','observedDecodedBytes'].every(key=>count(progress[key])))return false;
  if(!strings(coverage.reasons)||!['discoveryComplete','linksComplete','rawEvidenceRecorded'].every(key=>typeof coverage[key]==='boolean')||!count(coverage.scopeExclusions)||!['unavailablePages','unfetchedPages'].every(key=>coverage[key]===undefined||count(coverage[key])))return false;
  if(typeof v.canCancel!=='boolean'||typeof v.canDelete!=='boolean'||!['available','expired'].includes(v.dataStatus as string)||!['available','expired','not_recorded'].includes(v.rawEvidenceStatus as string)||v.stopReason!==null&&typeof v.stopReason!=='string')return false;
  if(v.phase!==null&&!['robots','discovery','pages','finalizing'].includes(v.phase as string)||!timestamp(v.createdAt)||!timestamp(v.deadlineAt)||!['startedAt','completedAt','rawExpiredAt','dataExpiredAt'].every(key=>v[key]===null||timestamp(v[key])))return false;
  if(v.summary===null)return true;
  const summary=v.summary;if(!record(summary)||!record(summary.graph)||!record(summary.graph.checks)||!record(summary.retainedBySeverity))return false;
  const graph=summary.graph,checks=summary.graph.checks,severity=summary.retainedBySeverity;
  return ['pagesObserved','pagesAnalyzed','htmlPagesDiscovered','issuesDetected','issuesRetained'].every(key=>count(summary[key]))&&typeof summary.findingsComplete==='boolean'&&['critical','warning','info'].every(key=>count(severity[key]))&&typeof graph.findingsComplete==='boolean'&&strings(graph.reasons)&&['complete','partial','unavailable'].includes(graph.status as string)&&['duplicates','redirects','brokenLinks','orphans'].every(key=>typeof checks[key]==='string')&&Object.values(checks).every(value=>typeof value==='string');
}
function append<T extends {id:string}>(old:List<T>,rows:T[],cursor:string|null,more:boolean):List<T>{return {rows:[...new Map([...(more?old.rows:[]),...rows].map(row=>[row.id,row])).values()],cursor,loaded:true};}
function validBodyEvidence(value:unknown,detail:boolean):value is BodyEvidence|undefined{
  if(value===undefined)return true; // Legacy fixtures/receipts do not imply captured text.
  if(!record(value)||typeof value.textIncluded!=='boolean'||!['not_recorded','pending','available','empty','unavailable','over_limit','expired'].includes(value.status as string))return false;
  if(value.status==='available'||value.status==='empty'){
    if(value.version!=='static-dom-body-v1'||!count(value.utf8Bytes)||Number(value.utf8Bytes)>65536||(value.status==='empty'?value.utf8Bytes!==0:Number(value.utf8Bytes)===0)||value.textIncluded!==detail)return false;
    if(!detail)return value.text===null;
    if(typeof value.text!=='string'||value.text.includes('\0')||(value.status==='empty'?value.text!=='':value.text===''))return false;
    const bytes=new TextEncoder().encode(value.text);return bytes.length===value.utf8Bytes&&new TextDecoder().decode(bytes)===value.text;
  }
  return value.utf8Bytes===null&&value.text===null&&value.textIncluded===false&&(value.status==='not_recorded'||value.status==='pending'?value.version===null:value.status==='expired'||value.status==='unavailable'?value.version===null||value.version==='static-dom-body-v1':value.version==='static-dom-body-v1');
}
function Reasons({reasons}:{reasons:string[]}) {
  if(!reasons.length)return null;
  return <details><summary>Why coverage is limited</summary><ul>{reasons.map(reason=><li key={reason}>{reason.includes('limit')||reason.includes('capacity')?'A configured limit was reached':reason.includes('deadline')||reason.includes('pacing')?'There was insufficient time for another request':reason.includes('robots')?'Robots policy limited or prevented discovery':reason.includes('permission')||reason.includes('scope')?'Access or the selected domain changed':reason.includes('cancel')?'Cancelled by a workspace member':'Part of the audit could not be completed'} <span className="mono">({reason})</span></li>)}</ul></details>;
}
function TextItems({items}:{items:string[]}){return items.length?<ul>{items.map((item,i)=><li key={i}>{item||'Observed empty value'}</li>)}</ul>:<p className="dim">None recorded.</p>;}

export function SiteAuditPanel(props:Props){return <Panel key={props.userId+':'+props.projectId} {...props}/>;}
function Panel({projectId,onUnauthorized,onOpenDomains,onOpenRetention}:Props){
  const B='/api/projects/'+encodeURIComponent(projectId)+'/audits',uid=useId();
  const [setup,setSetup]=useState<Setup|null>(null),[role,setRole]=useState<Role|null>(null);
  const [history,setHistory]=useState<List<Run>>(empty),[run,setRun]=useState<Run|null>(null),[page,setPage]=useState<Page|null>(null);
  const [issues,setIssues]=useState<List<Issue>>(empty),[pages,setPages]=useState<List<Page>>(empty),[links,setLinks]=useState<List<Edge>>(empty);
  const [issueCount,setIssueCount]=useState<number|null>(null),[allFindings,setAllFindings]=useState(false);
  const [view,setView]=useState<View>(initialView),[busy,setBusy]=useState<Partial<Record<Slot,boolean>>>({});
  const [errors,setErrors]=useState<Partial<Record<Slot,string>>>({}),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [writing,setWriting]=useState(false),[attempt,setAttempt]=useState<Attempt|null>(null),[uncertain,setUncertain]=useState(false);
  const [domain,setDomain]=useState(''),[path,setPath]=useState('/'),[maxPages,setMaxPages]=useState('50'),[updated,setUpdated]=useState<string|null>(null);
  const [retainBodyText,setRetainBodyText]=useState(false);
  const alive=useRef(false),epoch=useRef(0),ticket=useRef(0),reads=useRef(new Map<Slot,Read>()),mutation=useRef<object|null>(null);
  const attemptRef=useRef<Attempt|null>(null),attemptOrigin=useRef<string|null>(null),viewRef=useRef(view),runRef=useRef<Run|null>(null),runTicket=useRef(0),roleTicket=useRef(0);
  const callbacks=useRef({onUnauthorized,onOpenDomains,onOpenRetention});callbacks.current={onUnauthorized,onOpenDomains,onOpenRetention};
  const chosenDomain=useRef(false),historyFocus=useRef<string|null>(null),resultFocus=useRef<string|null>(null),pendingFocus=useRef<string|null>(null),heading=useRef<HTMLHeadingElement|null>(null);
  const rawExpired=useRef(new Set<string>()),dataExpired=useRef(new Set<string>()),bodyExpired=useRef(new Set<string>());
  function invalidateReads(){epoch.current++;for(const op of reads.current.values())op.controller.abort();reads.current.clear();setBusy({});}
  function changeView(next:View){viewRef.current=next;setView(next);}
  function receiveRole(next:Role,sequence:number){if(!roleValue(next)){const message='Audit access could not be verified. Reload access.';purge();setError(message);throw new Error(message);}if(sequence>=roleTicket.current){roleTicket.current=sequence;setRole(next);}}
  function clearLists(){setIssues(empty());setPages(empty());setLinks(empty());setIssueCount(null);setAllFindings(false);}
  function purge(){invalidateReads();setSetup(null);setRole(null);setHistory(empty());setRun(null);runRef.current=null;setPage(null);clearLists();changeView(initialView());attemptRef.current=null;attemptOrigin.current=null;setAttempt(null);setUncertain(false);setDomain('');chosenDomain.current=false;setPath('/');setMaxPages('50');setRetainBodyText(false);setUpdated(null);setErrors({});setMessage('');pendingFocus.current=uid+'history-heading';}
  function rememberExpiry(value:Run){if(value.rawEvidenceStatus==='expired')rawExpired.current.add(value.id);if(value.dataStatus==='expired')dataExpired.current.add(value.id);return {...value,...(rawExpired.current.has(value.id)?{rawEvidenceStatus:'expired' as const}:{}),...(dataExpired.current.has(value.id)?{dataStatus:'expired' as const}:{})};}
  function expiredPage(value:Page):Page{
    if(value.bodyEvidence?.status==='expired')bodyExpired.current.add(value.id);
    const expired=runRef.current?.rawEvidenceStatus==='expired'||value.rawEvidenceStatus==='expired';
    const body=value.bodyEvidence;
    if(expired&&body&&['available','empty'].includes(body.status))bodyExpired.current.add(value.id);
    return {...value,...(expired?{evidence:null,rawEvidenceStatus:value.rawEvidenceStatus==='not_recorded'?'not_recorded' as const:'expired' as const}:{}),...(body&&bodyExpired.current.has(value.id)?{bodyEvidence:{status:'expired' as const,version:body.version,utf8Bytes:null,textIncluded:false,text:null}}:{})};
  }
  function checkedPage(value:Page,detail:boolean){
    const body=value?.bodyEvidence,current=runRef.current;
    if(!value||!uuid(value.id)||typeof value.url!=='string'||!validBodyEvidence(body,detail)||body&&body.status!=='not_recorded'&&(current?.config.retainBodyText!==true||value.resourceKind!=='html')||body?.status==='pending'&&(value.observedAt!==null||!current||!active(current.status))||body&&['available','empty'].includes(body.status)&&(value.analysis?.coverage!=='analyzed'||!timestamp(value.observedAt))){setPage(null);setPages(empty());throw new Error('Captured page text could not be verified. Retry the page read.');}
    return expiredPage(value);
  }
  function receiveRun(next:Run,sequence:number){
    if(next.id!==viewRef.current.runId)return;
    next=rememberExpiry(next);
    const prior=runRef.current;
    // An earlier request can observe a later DB snapshot: expiry wins over request ordering.
    if(sequence<runTicket.current){
      if(!prior||next.dataStatus!=='expired'&&next.rawEvidenceStatus!=='expired')return;
      next={...prior,...(next.dataStatus==='expired'?{dataStatus:'expired' as const,dataExpiredAt:next.dataExpiredAt}:{}),...(next.rawEvidenceStatus==='expired'?{rawEvidenceStatus:'expired' as const,rawExpiredAt:next.rawExpiredAt}:{})};
      sequence=runTicket.current;
    }
    // Expiry cannot be undone by an older detail envelope or an extended policy.
    if(prior?.id===next.id&&prior.dataStatus==='expired')next={...next,dataStatus:'expired',dataExpiredAt:prior.dataExpiredAt};
    if(prior?.id===next.id&&prior.rawEvidenceStatus==='expired')next={...next,rawEvidenceStatus:'expired',rawExpiredAt:prior.rawExpiredAt};
    runTicket.current=sequence;runRef.current=next;setRun(next);setUpdated(new Date().toISOString());
    setHistory(old=>({...old,rows:old.rows.map(row=>row.id===next.id?next:row)}));
    if(next.dataStatus==='expired'){clearLists();setPage(null);}
    else if(next.rawEvidenceStatus==='expired'){setPage(old=>old?expiredPage(old):null);setPages(old=>({...old,rows:old.rows.map(expiredPage)}));setLinks(old=>({...old,rows:old.rows.map(edge=>({...edge,anchor:null,anchorStatus:'expired'}))}));}
    if(prior&&active(prior.status)&&!active(next.status)){
      setIssues(empty());setPages(empty());setIssueCount(null);setAllFindings(false);
      const generation=epoch.current;
      queueMicrotask(()=>{if(alive.current&&generation===epoch.current&&!mutation.current){void loadHistory();if(viewRef.current.pageId){void loadPage();void loadLinks();}else void loadResults();}});
    }
  }
  function recoverAccess(){const generation=epoch.current;queueMicrotask(()=>{if(alive.current&&epoch.current===generation&&!mutation.current){void loadSetup(false);void loadHistory(undefined,false);}});}
  function readError(e:unknown,slot:Slot,recover:boolean){
    if(e instanceof Error&&e.name==='AbortError')return;
    if(e instanceof ApiError&&[401,403,404].includes(e.status)){
      purge();setError(errMsg(e));
      if(e.status===401){callbacks.current.onUnauthorized();return;}
      if(recover)recoverAccess();return;
    }
    if(e instanceof ApiError&&e.status===410){
      const current=viewRef.current;invalidateReads();setPage(null);clearLists();setError(errMsg(e));
      if((slot==='page'||slot==='links')&&current.runId){changeView({...current,pageId:null});void loadRun();void loadResults();}
      else{changeView(initialView());runRef.current=null;setRun(null);void loadHistory();}return;
    }
    setErrors(old=>({...old,[slot]:errMsg(e)}));
  }
  async function read<T>(slot:Slot,url:string,commit:(data:T,sequence:number)=>void,recover=true){
    if(!alive.current||mutation.current)return;
    reads.current.get(slot)?.controller.abort();
    const op:Read={epoch:epoch.current,ticket:++ticket.current,controller:new AbortController()};reads.current.set(slot,op);
    setBusy(old=>({...old,[slot]:true}));setErrors(old=>({...old,[slot]:undefined}));
    const current=()=>alive.current&&epoch.current===op.epoch&&reads.current.get(slot)===op;
    try{const result=await api<T>(url,{signal:op.controller.signal});if(current())commit(result,op.ticket);}
    catch(e){if(current())readError(e,slot,recover);}
    finally{if(current()){reads.current.delete(slot);setBusy(old=>({...old,[slot]:false}));}}
  }
  function loadSetup(recover=true){return read<Setup>('setup',B+'/setup',(data,sequence)=>{receiveRole(data.role,sequence);setSetup(data);if(!chosenDomain.current){chosenDomain.current=true;const first=data.origins.find(o=>o.domainId===null)??data.origins[0];setDomain(first?(first.domainId??'canonical'):'');setMaxPages(String(data.limits.defaultPages));}},recover);}
  function loadHistory(cursor?:string,recover=true){const q=new URLSearchParams({limit:'50'});if(cursor)q.set('cursor',cursor);return read<{role:Role;runs:Run[];nextCursor:string|null}>('history',B+'?'+q,(data,sequence)=>{receiveRole(data.role,sequence);setHistory(old=>append(old,data.runs.map(rememberExpiry),data.nextCursor,!!cursor));},recover);}
  function loadRun(){const id=viewRef.current.runId;if(!id)return Promise.resolve();return read<{role:Role;run:Run}>('run',B+'/'+id,(data,sequence)=>{if(!validRun(data.run,projectId))throw new Error('The audit response was incomplete. Retry the refresh.');receiveRole(data.role,sequence);receiveRun(data.run,sequence);});}
  function loadResults(cursor?:string){
    const current=viewRef.current;if(!current.runId||current.pageId)return Promise.resolve();
    const q=new URLSearchParams({limit:'50'});if(cursor)q.set('cursor',cursor);
    if(current.tab==='issues'){
      if(current.filters.severity)q.set('severity',current.filters.severity);if(current.filters.code)q.set('code',current.filters.code);if(current.filters.pageId)q.set('pageId',current.filters.pageId);
      return read<{role:Role;run:Run;issues:Issue[];nextCursor:string|null;matchingRetainedCount:number|null;findingsComplete:boolean}>('results',B+'/'+current.runId+'/issues?'+q,(data,sequence)=>{receiveRole(data.role,sequence);receiveRun(data.run,sequence);if(runRef.current?.dataStatus==='expired')return;setIssues(old=>append(old,data.issues,data.nextCursor,!!cursor));setIssueCount(data.matchingRetainedCount);setAllFindings(data.findingsComplete);});
    }
    q.set('resourceKind',current.filters.resourceKind);if(current.filters.coverage)q.set('coverage',current.filters.coverage);
    return read<{role:Role;run:Run;pages:Page[];nextCursor:string|null}>('results',B+'/'+current.runId+'/pages?'+q,(data,sequence)=>{receiveRole(data.role,sequence);if(!validRun(data.run,projectId)||data.run.id!==current.runId||!Array.isArray(data.pages)){setPages(empty());throw new Error('The page observations could not be matched. Retry the results read.');}receiveRun(data.run,sequence);if(runRef.current?.dataStatus==='expired')return;const rows=data.pages.map(value=>checkedPage(value,false));setPages(old=>append(old,rows,data.nextCursor,!!cursor));});
  }
  function loadPage(){const current=viewRef.current;if(!current.runId||!current.pageId)return Promise.resolve();return read<{role:Role;run:Run;page:Page}>('page',B+'/'+current.runId+'/pages/'+current.pageId,(data,sequence)=>{receiveRole(data.role,sequence);if(!validRun(data.run,projectId)||data.run.id!==current.runId||data.page?.id!==current.pageId){setPage(null);throw new Error('The page observation could not be matched. Retry the page read.');}receiveRun(data.run,sequence);if(runRef.current?.dataStatus!=='expired')setPage(checkedPage(data.page,true));});}
  function loadLinks(cursor?:string){const current=viewRef.current;if(!current.runId||!current.pageId)return Promise.resolve();const q=new URLSearchParams({limit:'50',direction:current.direction});if(cursor)q.set('cursor',cursor);return read<{role:Role;run:Run;links:Edge[];nextCursor:string|null}>('links',B+'/'+current.runId+'/pages/'+current.pageId+'/links?'+q,(data,sequence)=>{receiveRole(data.role,sequence);receiveRun(data.run,sequence);if(runRef.current?.dataStatus==='expired')return;const rows=runRef.current?.rawEvidenceStatus==='expired'?data.links.map(edge=>({...edge,anchor:null,anchorStatus:'expired' as const})):data.links;setLinks(old=>append(old,rows,data.nextCursor,!!cursor));});}
  function selectRun(id:string){if(mutation.current)return;historyFocus.current=uid+'audit-'+id;pendingFocus.current=uid+'run-heading';invalidateReads();setErrors({});setError('');setMessage('');setRun(null);runRef.current=null;runTicket.current=0;setPage(null);clearLists();changeView({...initialView(),runId:id});void loadRun();void loadResults();}
  function selectPage(id:string){if(mutation.current)return;if(!viewRef.current.pageId)resultFocus.current=document.activeElement instanceof HTMLElement?document.activeElement.id:null;pendingFocus.current=uid+'page-heading';invalidateReads();setErrors({});setPage(null);setLinks(empty());changeView({...viewRef.current,pageId:id,direction:'out'});void loadPage();void loadLinks();}
  function back(){if(mutation.current)return;invalidateReads();setErrors({});setError('');if(viewRef.current.pageId){pendingFocus.current=resultFocus.current||uid+'run-heading';setPage(null);setLinks(empty());changeView({...viewRef.current,pageId:null});if(!(viewRef.current.tab==='issues'?issues.loaded:pages.loaded))void loadResults();void loadRun();}else{pendingFocus.current=historyFocus.current||uid+'history-heading';changeView(initialView());setRun(null);runRef.current=null;setPage(null);clearLists();void loadSetup();void loadHistory();}}
  function switchTab(tab:View['tab']){if(mutation.current)return;invalidateReads();setErrors({});setIssues(empty());setPages(empty());setIssueCount(null);changeView({...viewRef.current,tab});void loadResults();void loadRun();}
  function filterChange(patch:Partial<Filters>){if(mutation.current)return;reads.current.get('results')?.controller.abort();reads.current.delete('results');setBusy(old=>({...old,results:false}));setErrors(old=>({...old,results:undefined}));setIssues(empty());setPages(empty());setIssueCount(null);changeView({...viewRef.current,filters:{...viewRef.current.filters,...patch}});}
  function pageFindings(){if(mutation.current||!viewRef.current.pageId)return;const pageId=viewRef.current.pageId;invalidateReads();setErrors({});setPage(null);setLinks(empty());setIssues(empty());setIssueCount(null);changeView({...viewRef.current,pageId:null,tab:'issues',filters:{...filters(),pageId}});void loadResults();void loadRun();}
  function directionChange(direction:View['direction']){if(mutation.current)return;reads.current.get('links')?.controller.abort();reads.current.delete('links');setLinks(empty());changeView({...viewRef.current,direction});void loadLinks();}
  function beginWrite(){if(mutation.current||!alive.current)return null;invalidateReads();const token={};mutation.current=token;setWriting(true);setError('');setMessage('');return {token,epoch:epoch.current,sequence:++ticket.current};}
  function currentWrite(op:NonNullable<ReturnType<typeof beginWrite>>){return alive.current&&mutation.current===op.token&&epoch.current===op.epoch;}
  function endWrite(op:NonNullable<ReturnType<typeof beginWrite>>){if(mutation.current===op.token){mutation.current=null;if(alive.current)setWriting(false);}}
  async function start(e:FormEvent){
    e.preventDefault();if(mutation.current||!manages(role)||!attemptRef.current&&!setup?.canStart)return;
    let intent=attemptRef.current;
    if(!intent){const selected=setup?.origins.find(o=>(o.domainId??'canonical')===domain),limit=Number(maxPages);if(!selected||!setup||!path.startsWith('/')||path.startsWith('//')||/[?#]/.test(path)||!Number.isInteger(limit)||limit<1||limit>setup.limits.maxPages){setError('Choose an eligible domain, a query-free rooted path and a valid whole page limit.');return;}intent={requestId:crypto.randomUUID(),domainId:selected.domainId,startPath:path,maxPages:limit,mode:'static',retainBodyText};attemptRef.current=intent;attemptOrigin.current=selected.origin;setAttempt(intent);}
    const op=beginWrite();if(!op)return;
    try{
      const data=await api<unknown>(B,{method:'POST',body:intent});if(!currentWrite(op))return;
      if(!record(data)||!roleValue(data.role)||typeof data.created!=='boolean'||!validRun(data.run,projectId)||data.run.domainId!==intent.domainId||data.run.origin!==attemptOrigin.current||data.run.config.maxPages!==intent.maxPages||(data.run.config.retainBodyText??false)!==intent.retainBodyText||data.run.config.startPath!==new URL(intent.startPath,'https://example.com').pathname||data.run.config.startUrl!==new URL(intent.startPath,attemptOrigin.current!).href)throw new Error('The start acknowledgement was incomplete or did not match this request. Retry the same start request to confirm its receipt.');
      attemptRef.current=null;attemptOrigin.current=null;setAttempt(null);setUncertain(false);setRetainBodyText(false);receiveRole(data.role,op.sequence);pendingFocus.current=uid+'run-heading';changeView({...initialView(),runId:data.run.id});runTicket.current=0;runRef.current=null;clearLists();setPage(null);receiveRun(data.run,op.sequence);setMessage(data.created?'Audit request accepted.':'The original audit receipt was recovered.');
    }catch(e){if(currentWrite(op)){const status=e instanceof ApiError?e.status:0;if(status===0||status===408||status===429||status>=500){setUncertain(true);setError(errMsg(e)+' The outcome is unknown; retry this unchanged request.');}else{attemptRef.current=null;attemptOrigin.current=null;setAttempt(null);setUncertain(false);if([401,403,404].includes(status))readError(e,'setup',true);else setError(errMsg(e));}}}
    finally{endWrite(op);}
    if(alive.current&&epoch.current===op.epoch&&!attemptRef.current){void loadHistory();if(viewRef.current.runId)void loadResults();else void loadSetup();}
  }
  async function mutate(action:'cancel'|'delete'){
    const selected=runRef.current;if(mutation.current||!selected||!manages(role)||!(action==='cancel'?selected.canCancel:selected.canDelete))return;
    if(!window.confirm(action==='cancel'?'Cancel this audit? Requests already in progress may take a moment to stop. Collected observations stay in history.':'Delete this audit and its collected details? This cannot be undone. A minimal request record is kept to prevent accidental reruns.'))return;
    const op=beginWrite();if(!op)return;
    try{const data=await api<unknown>(B+'/'+selected.id+'/'+action,{method:'POST',body:{}});if(!currentWrite(op))return;
      if(action==='cancel'){if(!record(data)||!roleValue(data.role)||!validRun(data.run,projectId)||data.run.id!==selected.id)throw new Error('Cancellation could not be confirmed. Refresh the audit before trying again.');receiveRole(data.role,op.sequence);receiveRun(data.run,op.sequence);setMessage(data.run.status==='cancelling'?'Cancellation request accepted.':'Audit cancellation confirmed.');}
      else{if(!record(data)||data.deleted!==true||data.id!==selected.id)throw new Error('Deletion could not be confirmed. Refresh history before trying again.');changeView(initialView());runRef.current=null;setRun(null);setPage(null);clearLists();setHistory(old=>({...old,rows:old.rows.filter(row=>row.id!==selected.id)}));setMessage('Audit deleted. Collected details are queued for cleanup.');}
    }catch(e){if(currentWrite(op)){setError(errMsg(e));readError(e,'run',true);}}
    finally{endWrite(op);}
    if(alive.current&&epoch.current===op.epoch){void loadHistory();if(viewRef.current.runId)void loadRun();else void loadSetup();}
  }
  useEffect(()=>{alive.current=true;void loadSetup();void loadHistory();return()=>{alive.current=false;epoch.current++;for(const op of reads.current.values())op.controller.abort();reads.current.clear();attemptRef.current=null;attemptOrigin.current=null;};},[]);
  useEffect(()=>{if(!run||!active(run.status)||view.runId!==run.id)return;const id=run.id;const refresh=()=>{if(!document.hidden&&alive.current&&viewRef.current.runId===id&&!mutation.current&&!reads.current.has('run'))void loadRun();};const timer=window.setInterval(refresh,5000);document.addEventListener('visibilitychange',refresh);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[run?.id,run?.status,view.runId]);
  useEffect(()=>{if(!pendingFocus.current)return;const target=document.getElementById(pendingFocus.current);if(target){target.focus();pendingFocus.current=null;return;}const ready=view.pageId?!!page||!!errors.page:view.runId?!!run||!!errors.run:history.loaded||!!errors.history;if(ready){heading.current?.focus();pendingFocus.current=null;}});
  const managed=manages(role),selectedOrigin=setup?.origins.find(o=>(o.domainId??'canonical')===domain);
  const errorBox=(slot:Slot,retry:()=>void)=>errors[slot]?<div className="alert" role="alert">{errors[slot]} <button type="button" className="btn" disabled={writing} onClick={retry}>Retry {slot==='run'?'refresh':slot}</button></div>:null;
  const listStatus=(loaded:boolean,slot:Slot)=>busy[slot]?<p role="status">Loading…</p>:!loaded&&!errors[slot]?<p className="hint">Apply filters to load results.</p>:null;
  return <section className="research-panel site-audits" aria-label="Site audits" style={{'--control-md':'var(--control-touch)'} as import('react').CSSProperties}>
    {error&&<div className="alert" role="alert">{error} {!writing&&!setup&&<button className="btn" onClick={()=>{void loadSetup();void loadHistory();}}>Reload access</button>}</div>}
    {message&&<p className="notice" role="status">{message}</p>}
    <p className="hint">Manual static HTML audit. Rendered pages, protected-site credentials, scheduling and Lighthouse are not available yet.</p>
    {!view.runId?<>
      {errorBox('setup',()=>void loadSetup())}{busy.setup&&<p role="status">Loading audit setup…</p>}
      {managed&&setup&&<details className="card" open={!history.rows.length||!!attempt}><summary>{history.rows.length?'Start another audit':'Start an audit'}</summary>
        {!setup.origins.length&&!attempt?<div className="empty"><p>No eligible HTTPS domain. Add and verify a serving domain to run an audit.</p><button className="btn" disabled={writing} onClick={()=>callbacks.current.onOpenDomains()}>Manage domains</button></div>:<form onSubmit={e=>void start(e)}>
          {setup.worker.status==='unavailable'&&<p className="banner">Worker unavailable. Queued audits expire 30 minutes after creation, including time spent waiting. Ask the operator to check the worker.</p>}
          <p className="hint">Worker heartbeat: {date(setup.worker.lastHeartbeatAt)}. One active audit per workspace; one running audit across the installation.</p>
          <fieldset disabled={writing||!!attempt} style={{border:0,padding:0,margin:0}}>
            <div className="field"><label htmlFor={uid+'domain'}>Domain</label><select id={uid+'domain'} value={domain} onChange={e=>{chosenDomain.current=true;setDomain(e.target.value);}}><option value="">Choose a domain</option>{setup.origins.map(o=><option key={o.domainId??'canonical'} value={o.domainId??'canonical'}>{o.origin} · {o.authority==='canonical_project'?'Project origin':'Verified serving domain'}</option>)}</select></div>
            <div className="field"><label htmlFor={uid+'path'}>Start path</label><input id={uid+'path'} value={path} maxLength={2048} required onChange={e=>setPath(e.target.value)} aria-describedby={uid+'path-help'}/><p className="hint" id={uid+'path-help'}>Start with /. Queries and fragments are not supported. Other paths on this origin may be discovered.</p></div>
            <p className="mono">{attempt?attemptOrigin.current+attempt.startPath:selectedOrigin?selectedOrigin.origin+path:'Choose an eligible domain.'}</p>
            <div className="field"><label htmlFor={uid+'limit'}>Maximum HTML pages</label><input id={uid+'limit'} type="number" min={1} max={setup.limits.maxPages} step={1} required value={maxPages} onChange={e=>setMaxPages(e.target.value)}/><p className="hint">An attempt limit, not a promise that every page will be analyzed.</p></div>
            <label style={{display:'flex',alignItems:'center',gap:'var(--space-2)',minHeight:44}}><input type="checkbox" checked={retainBodyText} onChange={e=>setRetainBodyText(e.target.checked)} aria-describedby={uid+'body-help'}/>Retain page text for content analysis</label><p className="hint" id={uid+'body-help'}>Copies public static page text under workspace raw-evidence retention. It may include public personal information and boilerplate. Does not send it to AI.</p>
          </fieldset>
          <p>Static HTML on this origin only. Respects robots rules. Query URLs are excluded. JavaScript is not rendered.</p>
          <p className="hint">Up to {setup.limits.maxMinutes} minutes from queueing; at most {setup.limits.requestsPerSecond} request per second. No paid provider API is used.</p>
          <details><summary>Operational limits</summary><p>Up to 3 × the page limit + 100 requests; {number(setup.limits.bodyCapacityBytes/1048576)} MiB body-capacity allowance, {number(setup.limits.frontier)} discovered resources, {number(setup.limits.edges)} recorded edges, {setup.limits.sitemapDocuments} sitemaps and sitemap depth {setup.limits.sitemapDepth}. These are ceilings, not throughput or TCP-bandwidth guarantees.</p></details>
          {uncertain&&<p className="banner">Start outcome unknown. The original request and settings are retained. Retry to recover the same receipt.</p>}
          <div className="row"><button className="btn primary" type="submit" disabled={writing||!attempt&&(!setup.canStart||!selectedOrigin)}>{writing?'Starting…':attempt?'Retry start request':setup.worker.status==='unavailable'?'Queue audit':'Start audit'}</button><button className="btn" type="button" disabled={writing||!!attempt} onClick={()=>callbacks.current.onOpenDomains()}>Manage domains</button></div>
        </form>}
      </details>}
      {role&&!managed&&<p className="notice">You can inspect audits. A workspace owner or admin can start, cancel or delete them.</p>}
      <section className="card"><div className="row between"><h2 id={uid+'history-heading'} ref={heading} tabIndex={-1}>Audit history</h2><button className="btn" disabled={writing||busy.history} onClick={()=>void loadHistory()}>Refresh history</button></div>{errorBox('history',()=>void loadHistory())}
        {busy.history&&<p role="status">Loading audit history…</p>}
        {history.loaded&&!history.rows.length&&<p className="empty">No audits yet. {managed?'Choose an eligible domain to start the first audit.':'Ask a workspace owner or admin to start an audit.'}</p>}
        {!!history.rows.length&&<div className="table-wrap" tabIndex={0} role="region" aria-label="Audit history"><table><thead><tr><th>Started</th><th>Origin and start path</th><th>Outcome</th><th>Attempted / analyzed</th><th>Retained findings</th><th>Action</th></tr></thead><tbody>{history.rows.map(row=><tr key={row.id}><td>{date(row.createdAt)}</td><td>{row.origin}<br/><span className="mono">{row.config.startPath}</span></td><td>{words(row.status)}{row.dataStatus==='expired'&&<p className="hint">Detailed data expired</p>}</td><td>{row.summary?number(row.summary.pagesObserved)+' / '+number(row.summary.pagesAnalyzed):'Summary not produced'}</td><td>{number(row.summary?.issuesRetained)}</td><td><button id={uid+'audit-'+row.id} className="btn" disabled={writing} onClick={()=>selectRun(row.id)}>View audit</button></td></tr>)}</tbody></table></div>}
        {history.cursor&&<button className="btn" disabled={writing||busy.history} onClick={()=>void loadHistory(history.cursor!)}>Load more audits</button>}
      </section>
    </>:<>
      <button className="btn ghost" disabled={writing} onClick={back}>{view.pageId?'← Back to results':'← Back to audits'}</button>
      {errorBox('run',()=>void loadRun())}{!run&&busy.run&&<p role="status">Loading audit…</p>}
      {run&&<section className="card">
        <div className="row between" style={{gap:'var(--space-3)',marginBottom:'var(--space-2)'}}>
          <h2 id={uid+'run-heading'} ref={heading} tabIndex={-1} style={{margin:0}}>{run.origin} <span className="pill">{words(run.status)}</span></h2>
          <div className="row"><button className="btn" disabled={writing||busy.run} onClick={()=>void loadRun()}>Refresh status</button>{managed&&run.canCancel&&<button className="btn" disabled={writing} onClick={()=>void mutate('cancel')}>{writing?'Saving…':'Cancel audit'}</button>}{managed&&run.canDelete&&<button className="btn ghost" disabled={writing} onClick={()=>void mutate('delete')}>Delete audit</button>}</div>
        </div>
        <p className="mono">Start path: {run.config.startPath} · Static HTML</p>
        {busy.run&&<p className="hint" role="status">Refreshing saved audit status…</p>}
        {errors.run&&<p className="hint">The saved result is shown below; its status could not be refreshed.</p>}
        {active(run.status)&&<>
          <p role="status">{run.phase?({robots:'Checking robots rules',discovery:'Discovering pages',pages:'Checking pages',finalizing:'Finalizing findings'}[run.phase]):'Waiting for an update'}</p>
          <p>{number(run.progress.htmlPagesStarted)} HTML pages attempted; {number(run.progress.requests)} requests used. Requests include robots, sitemaps, redirects and retries.</p>
          <p className="hint">Deadline {date(run.deadlineAt)} · Refreshed {date(updated)}</p>
        </>}
        {run.dataStatus==='expired'&&<p className="banner">Detailed audit results expired under this workspace's retention policy. Counts below are the saved audit summary. <button className="btn" disabled={writing} onClick={()=>callbacks.current.onOpenRetention()}>Data retention</button></p>}
        {run.summary?<>
          <h3 style={{margin:'var(--space-3) 0 var(--space-2)'}}>{run.dataStatus==='expired'?'Saved audit summary':active(run.status)?'Audit in progress':run.summary.pagesAnalyzed===0?'No pages were fully analyzed.':run.summary.issuesDetected===0?'No findings recorded in '+number(run.summary.pagesAnalyzed)+' analyzed pages':number(run.summary.issuesDetected)+' findings detected'}</h3>
          <div className="row" style={{gap:'var(--space-4)'}}><p><span>Pages analyzed</span>: <strong>{number(run.summary.pagesAnalyzed)}</strong></p><p><span>Pages attempted</span>: <strong>{number(run.summary.pagesObserved)}</strong></p></div>
          <p className="hint">These results describe the pages observed in this static audit.</p>
          {(run.summary.pagesAnalyzed===0||run.summary.issuesDetected>run.summary.issuesRetained)&&<p>{number(run.summary.issuesDetected)} findings detected · {number(run.summary.issuesRetained)} findings retained.</p>}
          {(!run.summary.findingsComplete||run.summary.issuesDetected>run.summary.issuesRetained)&&<p className="banner">Detailed findings are a bounded subset of detected findings.</p>}
        </>:<p className="notice">Summary not produced. Available observations can still be inspected.</p>}
        {(!run.coverage.discoveryComplete||!run.coverage.linksComplete)&&<p className="banner">Coverage is incomplete. A low finding count does not mean the whole site is clear.</p>}
        <Reasons reasons={[...new Set([...run.coverage.reasons,...(run.stopReason?[run.stopReason]:[])])]}/>
        {!active(run.status)&&<p className="hint" role="status">Finished {date(run.completedAt)} · Refreshed {date(updated)}</p>}
        <details><summary>Audit details</summary>
          <p className="hint">Queued {date(run.createdAt)} · Started {date(run.startedAt)} · Deadline {date(run.deadlineAt)} · Finished {date(run.completedAt)}</p>
          {run.summary&&<><p>Findings detected: {number(run.summary.issuesDetected)} · Findings retained: {number(run.summary.issuesRetained)}.</p><p className="hint">{number(run.summary.htmlPagesDiscovered)} HTML pages discovered. Retained severity counts: {number(run.summary.retainedBySeverity.critical)} critical, {number(run.summary.retainedBySeverity.warning)} warning, {number(run.summary.retainedBySeverity.info)} information.</p></>}
          <p>Discovery: {run.coverage.discoveryComplete?'Complete within the observed scope':'Incomplete'}. Link coverage: {run.coverage.linksComplete?'Complete within the observed scope':'Incomplete'}.</p>{run.summary&&<ul>{Object.entries(run.summary.graph.checks).map(([key,value])=><li key={key}>{words(key)}: {words(value)}</li>)}</ul>}<p>Page attempt limit {run.config.maxPages}; request limit {run.config.requestLimit}. Body-capacity allowance used: {number(run.progress.bodyCapacityChargedBytes)} bytes. Observed wire / HTTP-decoded / decoded bytes: {number(run.progress.observedWireBytes)} / {number(run.progress.observedHttpDecodedBytes)} / {number(run.progress.observedDecodedBytes)}.</p><p>Scope exclusions: {number(run.coverage.scopeExclusions)}; unavailable HTML pages: {number(run.coverage.unavailablePages)}; unfetched HTML pages: {number(run.coverage.unfetchedPages)}. These are observed counts, not an estimate of the whole website.</p>
        </details>
      </section>}
      {run&&run.dataStatus!=='expired'&&!view.pageId&&<section className="card"><nav className="row" aria-label="Audit results"><button className={view.tab==='issues'?'btn primary':'btn'} style={{fontWeight:view.tab==='issues'?700:500,textDecoration:view.tab==='issues'?'underline':undefined,textUnderlineOffset:'0.2em'}} aria-pressed={view.tab==='issues'} disabled={writing} onClick={()=>switchTab('issues')}>Findings</button><button className={view.tab==='pages'?'btn primary':'btn'} style={{fontWeight:view.tab==='pages'?700:500,textDecoration:view.tab==='pages'?'underline':undefined,textUnderlineOffset:'0.2em'}} aria-pressed={view.tab==='pages'} disabled={writing} onClick={()=>switchTab('pages')}>Pages</button></nav>
        <details><summary>Filters</summary>
        <form onSubmit={e=>{e.preventDefault();if(!mutation.current)void loadResults();}}><div className="row">
          {view.tab==='issues'?<><div className="field"><label htmlFor={uid+'severity'}>Severity</label><select id={uid+'severity'} disabled={writing} value={view.filters.severity} onChange={e=>filterChange({severity:e.target.value})}><option value="">All severities</option>{['critical','warning','info'].map(x=><option key={x}>{x}</option>)}</select></div><div className="field"><label htmlFor={uid+'code'}>Issue type</label><select id={uid+'code'} disabled={writing} value={view.filters.code} onChange={e=>filterChange({code:e.target.value})}><option value="">All issue types</option>{issueCodes.map(x=><option key={x} value={x}>{words(x)}</option>)}</select></div></>:<><div className="field"><label htmlFor={uid+'resource'}>Resource</label><select id={uid+'resource'} disabled={writing} value={view.filters.resourceKind} onChange={e=>filterChange({resourceKind:e.target.value as Filters['resourceKind']})}>{['html','robots','sitemap'].map(x=><option key={x} value={x}>{x==='html'?'HTML':words(x)}</option>)}</select></div><div className="field"><label htmlFor={uid+'coverage'}>Coverage</label><select id={uid+'coverage'} disabled={writing} value={view.filters.coverage} onChange={e=>filterChange({coverage:e.target.value})}><option value="">All coverage</option>{covers.map(x=><option key={x} value={x}>{coverageLabels[x]}</option>)}</select></div></>}
          <button className="btn" type="submit" disabled={writing||busy.results}>Apply filters</button><button className="btn ghost" type="button" disabled={writing} onClick={()=>{filterChange(filters());void loadResults();}}>Clear filters</button>
        </div></form>
        </details>
        {view.tab==='issues'&&view.filters.pageId&&<p className="notice">Showing findings where the selected page is the primary affected page. Clear filters to return to all findings.</p>}
        {errorBox('results',()=>void loadResults())}{listStatus(view.tab==='issues'?issues.loaded:pages.loaded,'results')}
        {view.tab==='issues'?<>
          {active(run.status)&&<p className="hint">Findings may change until finalization.</p>}{issueCount!==null&&(issues.rows.length>0||view.filters.code||view.filters.severity||view.filters.pageId)&&<p>{number(issueCount)} matching retained findings.</p>}{issues.loaded&&!allFindings&&<p className="hint">The retained finding list may be incomplete.</p>}
          {issues.loaded&&!busy.results&&!errors.results&&!issues.rows.length&&<div className="empty"><p>{view.filters.code||view.filters.severity||view.filters.pageId?'No retained findings match these filters. Open Filters to adjust or clear them.':!active(run.status)&&run.summary!==null&&run.summary.pagesAnalyzed>0&&run.summary.issuesDetected===0&&issueCount===0?'Inspect the recorded pages to review their coverage and evidence.':'No retained findings are available in this list.'}</p>{!view.filters.code&&!view.filters.severity&&!view.filters.pageId&&<button className="btn" disabled={writing} onClick={()=>switchTab('pages')}>View recorded pages</button>}</div>}
          {!!issues.rows.length&&<div className="table-wrap" tabIndex={0} role="region" aria-label="Audit findings"><table><thead><tr><th>Severity</th><th>Finding and observation</th><th>Pages</th></tr></thead><tbody>{issues.rows.map(item=><tr key={item.id}><td><span className="pill">{words(item.severity)}</span></td><td><strong>{words(item.code)}</strong>{Object.entries(item.details).map(([key,value])=><p className="hint" key={key}>{words(key)}: {number(value)}</p>)}<details><summary>Rule details</summary><p className="mono">{item.ruleVersion} · {item.code}</p></details></td><td>{item.pageId&&<button id={uid+'issue-'+item.id} className="btn" disabled={writing} onClick={()=>selectPage(item.pageId!)}>View affected page</button>}{item.targetPageId&&item.targetPageId!==item.pageId&&<button id={uid+'target-'+item.id} className="btn" disabled={writing} onClick={()=>selectPage(item.targetPageId!)}>View target page</button>}{item.relatedPageIds.filter(id=>id!==item.pageId&&id!==item.targetPageId).map((id,i)=><button id={uid+'related-'+item.id+'-'+id} key={id} className="btn" disabled={writing} onClick={()=>selectPage(id)}>View related page {i+1}</button>)}</td></tr>)}</tbody></table></div>}
          {issues.cursor&&<button className="btn" disabled={writing||busy.results} onClick={()=>void loadResults(issues.cursor!)}>Load more issues</button>}
        </>:<>
          {pages.loaded&&!busy.results&&!errors.results&&!pages.rows.length&&<p className="empty">No recorded pages match these filters.</p>}
          {!!pages.rows.length&&<div className="table-wrap" tabIndex={0} role="region" aria-label="Recorded audit pages"><table><thead><tr><th>URL</th><th>HTTP</th><th>Coverage</th><th>Total response</th><th>Action</th></tr></thead><tbody>{pages.rows.map(item=><tr key={item.id}><td>{item.url}</td><td>{item.httpStatus??'No status recorded'}</td><td>{coverageLabels[item.analysis.coverage]??'Unavailable'}<p className="hint">Resource: {words(item.state)}</p></td><td>{item.responseTimeMs===null?'Not recorded':number(item.responseTimeMs)+' ms'}</td><td><button id={uid+'page-'+item.id} className="btn" disabled={writing} onClick={()=>selectPage(item.id)}>View page</button></td></tr>)}</tbody></table></div>}
          {pages.cursor&&<button className="btn" disabled={writing||busy.results} onClick={()=>void loadResults(pages.cursor!)}>Load more pages</button>}
        </>}
      </section>}
      {run&&run.dataStatus!=='expired'&&view.pageId&&<section className="card">{errorBox('page',()=>void loadPage())}{busy.page&&<p role="status">Loading page details…</p>}{page&&<>
        <h2 id={uid+'page-heading'} tabIndex={-1}>{page.url}</h2><p>{coverageLabels[page.analysis.coverage]??'Unavailable'} · HTTP {page.httpStatus??'not recorded'} · Observed {date(page.observedAt)}</p><p className="hint">Sources: {Object.entries(page.sources).filter(([,value])=>value).map(([key])=>words(key)).join(', ')||'Not recorded'}; link depth {number(page.linkDepth)}; sitemap depth {page.sitemapDepth}. Total response {page.responseTimeMs===null?'not recorded':number(page.responseTimeMs)+' ms'}.</p><button className="btn" disabled={writing} onClick={pageFindings}>View page findings</button><Reasons reasons={page.analysis.reasons}/>
        {page.analysis.facts?<details><summary>Page facts and counts</summary><dl>{Object.entries({titleLength:page.analysis.facts.titleLength,descriptionLength:page.analysis.facts.descriptionLength,wordCount:page.analysis.facts.wordCount,imagesTotal:page.analysis.facts.imagesTotal,imagesMissingAlt:page.analysis.facts.imagesMissingAlt,linksTotal:page.analysis.facts.linksTotal,internalLinks:page.analysis.facts.internalLinks,externalLinks:page.analysis.facts.externalLinks,unresolvedLinks:page.analysis.facts.unresolvedLinks,hreflangCount:page.analysis.facts.hreflangCount}).map(([key,value])=><div key={key}><dt>{words(key)}</dt><dd>{number(value)}</dd></div>)}</dl><p>Indexability: {page.analysis.facts.indexability==='noindex_observed'?'Noindex observed':page.analysis.facts.indexability==='no_noindex_observed'?'No noindex observed':'Unknown'}. Canonical: {words(page.analysis.facts.canonical)}. Structured data: {page.analysis.facts.structuredDataPresent?'Observed':'Not observed'}.</p><details><summary>Heading counts and order</summary><p>{page.analysis.facts.headingCounts.map((n,i)=>'H'+(i+1)+': '+number(n)).join(' · ')}</p><p>Observed order: {page.analysis.facts.headingOrder.map(n=>'H'+n).join(' → ')||'None observed'}</p></details></details>:<p className="notice">SEO facts are unavailable for this observation. Missing facts are not missing page elements.</p>}
        <details><summary>Captured page text</summary>
          <p className="hint">Static HTML text from this page, observed {date(page.observedAt)}. It may include navigation, footers and other boilerplate. It is not rendered or live page content.</p>
          {page.bodyEvidence?.status==='available'?<><p className="hint">{number(page.bodyEvidence.utf8Bytes)} UTF-8 bytes · {page.bodyEvidence.version}</p><div className="mono" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{page.bodyEvidence.text}</div></>:page.bodyEvidence?.status==='empty'?<p>The captured static page text was empty.</p>:<p>{page.bodyEvidence?.status==='pending'?'Page text has not been observed yet.':page.bodyEvidence?.status==='over_limit'?'Page text exceeded the 65,536-byte retention limit. No text was retained.':page.bodyEvidence?.status==='unavailable'?'Page text is unavailable for this observation. This does not establish that the page has no content.':page.bodyEvidence?.status==='expired'?'Captured page text expired under workspace raw-evidence retention.':'Page text was not recorded for this observation.'}</p>}
        </details>
        {page.rawEvidenceStatus==='expired'?<p className="banner">Copied page evidence expired; retained facts may still be available.</p>:page.rawEvidenceStatus==='not_recorded'?<p className="notice">Copied page metadata was not recorded.</p>:page.evidence?<><p className="hint">Extracted evidence, not complete page source. Omitted records are not evidence of absent elements.</p>{page.rawEvidenceStatus==='truncated'&&<p className="banner">Only a retained subset of copied evidence is available.</p>}<details open><summary>Title and description</summary><h3>Title</h3><p>{page.evidence.title||'Observed empty title'}</p><h3>Description</h3><p>{page.evidence.description||'Observed empty description'}</p></details><details><summary>Heading text</summary><TextItems items={page.evidence.headings}/></details><details><summary>Canonical and robots observations</summary><h3>HTML canonicals</h3><TextItems items={page.evidence.htmlCanonicals}/><h3>Header canonicals</h3><TextItems items={page.evidence.headerCanonicals}/><h3>Robots meta</h3><TextItems items={page.evidence.robotsMeta}/><h3>X-Robots-Tag</h3><TextItems items={page.evidence.xRobotsTags}/></details><details><summary>Images</summary>{page.evidence.images.length?<ul>{page.evidence.images.map((image,i)=><li key={i}>{image.src??'Source not recorded'}<p>Alt: {image.alt===null?'Not recorded':image.alt||'Observed empty alt attribute'}</p></li>)}</ul>:<p>None recorded.</p>}</details><details><summary>Open Graph and hreflang</summary><p>Title: {page.evidence.openGraph.title??'Not recorded'}</p><p>Description: {page.evidence.openGraph.description??'Not recorded'}</p><p>Image URL: {page.evidence.openGraph.image??'Not recorded'}</p><TextItems items={page.evidence.hreflang.map(x=>x.language+': '+x.url)}/></details></>:<p className="notice">Copied evidence is unavailable.</p>}
      </>}
        <h3>Recorded links</h3><div className="row"><button className="btn" aria-pressed={view.direction==='out'} disabled={writing} onClick={()=>directionChange('out')}>Outgoing</button><button className="btn" aria-pressed={view.direction==='in'} disabled={writing} onClick={()=>directionChange('in')}>Incoming</button><button className="btn" disabled={writing||busy.links} onClick={()=>void loadLinks()}>Refresh links</button></div>{errorBox('links',()=>void loadLinks())}{busy.links&&<p role="status">Loading recorded links…</p>}{!run.coverage.linksComplete&&<p className="hint">Link coverage is incomplete; an empty list does not prove no links exist.</p>}
        {links.loaded&&!links.rows.length&&<p className="empty">No links recorded in this direction.</p>}
        {!!links.rows.length&&<div className="table-wrap" tabIndex={0} role="region" aria-label="Recorded page links"><table><thead><tr><th>Relation</th><th>{view.direction==='in'?'Source page':'Target URL'}</th><th>Anchor</th></tr></thead><tbody>{links.rows.map(edge=><tr key={edge.id}><td>{words(edge.kind)}{edge.nofollow?' · nofollow':''}</td><td>{view.direction==='in'?<button className="btn" disabled={writing} onClick={()=>selectPage(edge.sourcePageId)}>View source page</button>:<>{edge.targetUrl}{edge.targetPageId?<p><button className="btn" disabled={writing} onClick={()=>selectPage(edge.targetPageId!)}>View target page</button></p>:<p className="hint">No saved HTML target. This does not establish a broken link.</p>}</>}</td><td>{edge.anchorStatus==='available'?edge.anchor||'Observed empty anchor':words(edge.anchorStatus)}</td></tr>)}</tbody></table></div>}{links.cursor&&<button className="btn" disabled={writing||busy.links} onClick={()=>void loadLinks(links.cursor!)}>Load more links</button>}
      </section>}
    </>}
  </section>;
}
