import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {api,ApiError,errMsg} from '../lib/api';
import {auditCoverages,auditIssueCodes,auditNavigation,type AuditNavigation,type NavigationSearch} from '../lib/navigation';

type Role='owner'|'admin'|'editor'|'viewer';
type Status='queued'|'running'|'cancelling'|'completed'|'partial'|'failed'|'cancelled';
type Coverage='unavailable'|'blocked'|'rate_limited'|'robots_disallowed'|'not_fetched'|'http_error'|'redirect'|'non_html'|'partial'|'shell'|'analyzed';
type Setup={role:Role;canStart:boolean;origins:{domainId:string|null;origin:string;authority:'canonical_project'|'verified_serving'}[];limits:{defaultPages:number;maxPages:number;maxMinutes:number;requestsPerSecond:number;bodyCapacityBytes:number;frontier:number;edges:number;sitemapDocuments:number;sitemapDepth:number};worker:{status:'ready'|'unavailable';lastHeartbeatAt:string|null}};
type Run={id:string;projectId:string;domainId:string|null;origin:string;status:Status;phase:'robots'|'discovery'|'pages'|'finalizing'|null;createdAt:string;startedAt:string|null;completedAt:string|null;deadlineAt:string;stopReason:string|null;canCancel:boolean;canDelete:boolean;config:{mode:'static';retainBodyText?:boolean;startPath:string;startUrl:string;maxPages:number;requestLimit:number;bodyCapacityBytes:number;frontierLimit:number;edgeLimit:number;sitemapDocuments:number;sitemapDepth:number};coverage:{reasons:string[];discoveryComplete:boolean;linksComplete:boolean;scopeExclusions:number;rawEvidenceRecorded:boolean;unavailablePages?:number;unfetchedPages?:number};summary:null|{pagesObserved:number;pagesAnalyzed:number;htmlPagesDiscovered:number;issuesDetected:number;issuesRetained:number;findingsComplete:boolean;retainedBySeverity:{critical:number;warning:number;info:number};graph:{status:string;reasons:string[];checks:Record<string,string>;findingsComplete:boolean}};progress:{requests:number;htmlPagesStarted:number;sitemapDocumentsStarted:number;frontier:number;edges:number;bodyCapacityChargedBytes:number;observedWireBytes:number;observedHttpDecodedBytes:number;observedDecodedBytes:number};dataStatus:'available'|'expired';rawEvidenceStatus:'available'|'expired'|'not_recorded';rawExpiredAt:string|null;dataExpiredAt:string|null};
type Facts={titleLength:number;descriptionLength:number;headingCounts:number[];headingOrder:number[];wordCount:number;imagesTotal:number;imagesMissingAlt:number;linksTotal:number;internalLinks:number;externalLinks:number;unresolvedLinks:number;structuredDataPresent:boolean;hreflangCount:number;indexability:'noindex_observed'|'no_noindex_observed'|'unknown';canonical:'none'|'self'|'other'|'conflict'|'invalid';invalidCanonicals:number};
type Evidence={title:string;description:string;htmlCanonicals:string[];headerCanonicals:string[];robotsMeta:string[];xRobotsTags:string[];headings:string[];images:{src:string|null;alt:string|null}[];openGraph:{title:string|null;description:string|null;image:string|null};hreflang:{language:string;url:string}[]};
type BodyEvidence={status:'not_recorded'|'pending'|'available'|'empty'|'unavailable'|'over_limit'|'expired';version:string|null;utf8Bytes:number|null;textIncluded:boolean;text:string|null};
type Page={id:string;url:string;resourceKind:'html'|'robots'|'sitemap';state:string;sources:{start:boolean;link:boolean;sitemap:boolean};linkDepth:number|null;sitemapDepth:number;observedAt:string|null;httpStatus:number|null;fetchState:string;analysis:{coverage:Coverage;reasons:string[];facts:Facts|null};responseTimeMs:number|null;rawEvidenceStatus:'not_recorded'|'expired'|'truncated'|'available';evidenceIncluded:boolean;evidence:Evidence|null;bodyEvidence?:BodyEvidence};
type Issue={id:string;pageId:string|null;pageUrl:string|null;targetPageId:string|null;targetPageUrl:string|null;relatedPageIds:string[];code:string;severity:'critical'|'warning'|'info';ruleVersion:string;details:Record<string,number>};
type Group={code:string;severity:Issue['severity'];retainedFindingCount:number|null;affectedUrlCount:number|null;unassignedFindingCount:number|null};
type IssueResult={role:Role;run:Run;issues:Issue[];groups:Group[]|null;nextCursor:string|null;matchingRetainedCount:number|null;findingsComplete:boolean;countBasis:'retained'};
type Edge={id:string;kind:'link'|'redirect'|'sitemap';sourcePageId:string;targetPageId:string|null;targetUrl:string;nofollow:boolean;anchor:string|null;anchorStatus:'expired'|'not_recorded'|'available'};
type List<T>={rows:T[];cursor:string|null;loaded:boolean};
type Filters={severity:string;code:string;pageId:string;coverage:string;resourceKind:'html'|'robots'|'sitemap'};
type View={runId:string|null;pageId:string|null;tab:'issues'|'pages';direction:'in'|'out';filters:Filters;appliedFilters:Filters};
type Slot='setup'|'history'|'run'|'results'|'page'|'links'|`group:${string}`;
type Read={epoch:number;ticket:number;controller:AbortController};
type Attempt={requestId:string;domainId:string|null;startPath:string;maxPages:number;mode:'static';retainBodyText:boolean};
type Props={projectId:string;userId:string;search?:NavigationSearch;onNavigate?:(value:AuditNavigation,replace?:boolean)=>void;onUnauthorized:()=>void;onOpenDomains:()=>void;onOpenRetention:()=>void};
const statuses:Status[]=['queued','running','cancelling','completed','partial','failed','cancelled'];
const active=(s:Status)=>s==='queued'||s==='running'||s==='cancelling';
const manages=(r:Role|null)=>r==='owner'||r==='admin';
const empty=<T,>():List<T>=>({rows:[],cursor:null,loaded:false});
const filters=():Filters=>({severity:'',code:'',pageId:'',coverage:'',resourceKind:'html'});
const initialView=():View=>({runId:null,pageId:null,tab:'issues',direction:'out',filters:filters(),appliedFilters:filters()});
const covers=auditCoverages;
const coverageLabels:Record<Coverage,string>={analyzed:'Analyzed',partial:'Partially analyzed',shell:'JavaScript rendering suspected',redirect:'Redirect',non_html:'Not HTML',http_error:'HTTP error',blocked:'Blocked',rate_limited:'Rate limited',robots_disallowed:'Disallowed by robots',not_fetched:'Not fetched',unavailable:'Unavailable'};
const issueCodes=auditIssueCodes;
const issueLabels:Record<string,string>={
  'blocked-page':'Crawler access blocked','rate-limited-page':'Requests rate limited','server-error':'Page returns a server error (5xx)','broken-page':'Page returns an error (4xx)','slow-response':'Response slower than the audit threshold','noindex-page':'Noindex directive observed','canonical-conflict':'Conflicting canonical URLs','canonicalized-page':'Canonical points to another page','deep-page':'Page reached at a deep link depth','javascript-rendering-suspected':'JavaScript rendering suspected','missing-title':'Missing title tag','title-too-long':'Title longer than the audit threshold','title-too-short':'Title shorter than the audit threshold','missing-meta-description':'Missing meta description','meta-description-too-long':'Description longer than the audit threshold','meta-description-too-short':'Description shorter than the audit threshold','missing-h1':'Missing main heading (H1)','multiple-h1':'Multiple main headings (H1)','heading-order-skip':'Heading order skips a level','thin-content':'Limited text in captured HTML','images-missing-alt':'Images missing alt text','no-outgoing-links':'No outgoing links recorded','duplicate-title':'Matching titles across pages','duplicate-meta-description':'Matching descriptions across pages','duplicate-content':'Matching captured content across pages','redirect-chain':'Multiple redirects in a chain','redirect-loop':'Redirect loop observed','broken-internal-link':'Broken internal link','orphan-page':'Sitemap page without a recorded inbound link',
};
const severityLabel=(value:Issue['severity'])=>({critical:'Critical',warning:'Warning',info:'Information'}[value]);
const words=(s:string)=>s.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]/g,' ').replace(/^./,c=>c.toUpperCase());
const date=(s:string|null)=>s&&Number.isFinite(Date.parse(s))?new Date(s).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'}):'Not recorded';
const issueAdvice:Record<string,[string,string]>={
  'blocked-page':['The crawler was blocked; content was not evaluated.','Check owner-approved crawler access and the recorded response. Do not bypass protection.'],
  'rate-limited-page':['The site limited requests.','Wait for cooldown and review the permitted crawler rate before explicitly rerunning.'],
  'server-error':['The recorded response was a server error.','Check the affected endpoint and server error logs with the operator.'],
  'broken-page':['The recorded response was a client error.','Verify the intended URL; repair it or incoming links as appropriate.'],
  'slow-response':['The recorded response exceeded this rule’s threshold.','Inspect the measured response and server path. This is not Lighthouse or Core Web Vitals.'],
  'noindex-page':['A noindex directive was observed.','Check whether exclusion is intentional before changing it.'],
  'canonical-conflict':['Canonical observations conflict.','Compare the retained header and HTML values with the intended target.'],
  'canonicalized-page':['The page points to another canonical.','Verify intent; this informational finding does not necessarily indicate a defect.'],
  'deep-page':['The page was reached at the recorded depth.','Review navigation if the page should be easier to discover.'],
  'javascript-rendering-suspected':['Captured HTML resembles an application shell.','Inspect server-delivered content; assessment remains limited without JavaScript rendering.'],
  'missing-title':['No usable title was found in analyzed HTML.','Inspect the retained title and provide or correct the intended title.'],
  'title-too-long':['The observed title length exceeds a heuristic threshold.','Review clarity and purpose; search results have no fixed guaranteed display limit.'],
  'title-too-short':['The observed title length is below a heuristic threshold.','Review clarity and purpose; a short title is not automatically defective.'],
  'missing-meta-description':['No usable description was found in analyzed HTML.','Inspect retained evidence and provide a description where appropriate.'],
  'meta-description-too-long':['Description length exceeds a heuristic threshold.','Review wording for this page’s purpose; this is not a declared ranking penalty.'],
  'meta-description-too-short':['Description length is below a heuristic threshold.','Review wording for this page’s purpose; this is not a declared ranking penalty.'],
  'missing-h1':['No H1 was observed in analyzed HTML.','Inspect the intended heading structure and main page heading.'],
  'multiple-h1':['More than one H1 was observed.','Inspect the intended heading structure; multiple H1s are not universally invalid.'],
  'heading-order-skip':['The observed heading order skips a level.','Check the semantic content hierarchy.'],
  'thin-content':['Analyzed text is below the implemented word threshold.','Check page purpose and content; short does not necessarily mean poor quality.'],
  'images-missing-alt':['Some observed images lack alt attributes.','Use meaningful alternatives for informative images; empty alt may suit decorative images.'],
  'no-outgoing-links':['No outgoing links were recorded in eligible analyzed HTML.','Inspect intended navigation; this may be intentional.'],
  'duplicate-title':['Matching normalized titles were observed across pages.','Compare related pages and their purpose before editing; related-page evidence is sampled.'],
  'duplicate-meta-description':['Matching normalized descriptions were observed across pages.','Compare related pages and their purpose before editing; related-page evidence is sampled.'],
  'duplicate-content':['Matching normalized content was observed across pages.','Compare related pages and their purpose before editing content or canonicals; evidence is sampled.'],
  'redirect-chain':['Multiple observed redirects lead to a terminal target.','Inspect the chain and use the final intended URL where appropriate.'],
  'redirect-loop':['The observed redirect path contains a cycle.','Inspect recorded related pages and correct the cycle.'],
  'broken-internal-link':['A recorded internal link targets an observed broken response.','Inspect source and target; repair the destination or link.'],
  'orphan-page':['A sitemap-discovered page has no recorded inbound link within the completed observed graph.','Check intended site navigation. This does not establish that no links exist across the whole site or web.'],
};
const number=(n:number|null|undefined)=>n==null?'Unavailable':n.toLocaleString();
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const roleValue=(v:unknown):v is Role=>['owner','admin','editor','viewer'].includes(v as string);
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(x=>typeof x==='string');
const timestamp=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const httpUrl=(v:unknown)=>{if(typeof v!=='string'||v.length>8192||/[\x00-\x20\x7f]/.test(v))return false;try{const url=new URL(v);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}};
const groupKey=(group:Pick<Group,'severity'|'code'>)=>group.severity+':'+group.code;
const issueLabel=(code:string)=>issueLabels[code]??words(code);
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
function validIssueResult(value:unknown,projectId:string,runId:string,scope:Filters):value is IssueResult{
  if(!record(value)||!roleValue(value.role)||!validRun(value.run,projectId)||value.run.id!==runId||!Array.isArray(value.issues)||value.issues.length>50||value.countBasis!=='retained'||typeof value.findingsComplete!=='boolean'||value.nextCursor!==null&&(typeof value.nextCursor!=='string'||!value.nextCursor||value.nextCursor.length>4096)||value.matchingRetainedCount!==null&&!count(value.matchingRetainedCount))return false;
  const code=(v:unknown)=>typeof v==='string'&&v.length<=128&&/^[a-z][a-z0-9-]*$/.test(v),severity=(v:unknown)=>['critical','warning','info'].includes(v as string);
  const matches=(v:Record<string,unknown>)=>(!scope.code||v.code===scope.code)&&(!scope.severity||v.severity===scope.severity);
  if(value.run.dataStatus==='expired')return value.groups===null&&value.issues.length===0&&value.nextCursor===null&&value.matchingRetainedCount===null;
  if(!Array.isArray(value.groups))return false;
  const keys=new Set<string>(),ids=new Set<string>();
  for(const group of value.groups){
    if(!record(group)||!code(group.code)||!severity(group.severity)||!matches(group))return false;
    const key=String(group.severity)+':'+group.code;if(keys.has(key))return false;keys.add(key);
    if(active(value.run.status)){if(['retainedFindingCount','affectedUrlCount','unassignedFindingCount'].some(k=>group[k]!==null))return false;}
    else if(!['retainedFindingCount','affectedUrlCount','unassignedFindingCount'].every(k=>count(group[k]))||group.retainedFindingCount===0||Number(group.affectedUrlCount)+Number(group.unassignedFindingCount)>Number(group.retainedFindingCount))return false;
  }
  if(active(value.run.status)&&value.matchingRetainedCount!==null||!active(value.run.status)&&!count(value.matchingRetainedCount))return false;
  for(const item of value.issues){
    if(!record(item)||!uuid(item.id)||ids.has(item.id)||!code(item.code)||!severity(item.severity)||!matches(item)||!keys.has(String(item.severity)+':'+item.code)||item.pageId!==null&&!uuid(item.pageId)||item.targetPageId!==null&&!uuid(item.targetPageId)||!Array.isArray(item.relatedPageIds)||!item.relatedPageIds.every(uuid)||new Set(item.relatedPageIds).size!==item.relatedPageIds.length||scope.pageId&&item.pageId!==scope.pageId||!record(item.details)||!Object.values(item.details).every(n=>typeof n==='number'&&Number.isFinite(n))||typeof item.ruleVersion!=='string'||!item.ruleVersion||item.ruleVersion.length>128)return false;
    if(item.pageUrl!==null&&(!uuid(item.pageId)||!httpUrl(item.pageUrl))||item.targetPageUrl!==null&&(!uuid(item.targetPageId)||!httpUrl(item.targetPageUrl)))return false;
    ids.add(item.id);
  }
  if(!active(value.run.status)){
    const total=value.groups.reduce((sum,group)=>sum+group.retainedFindingCount,0);
    if(!count(total)||total!==value.matchingRetainedCount)return false;
    for(const group of value.groups){
      const rows=value.issues.filter(item=>item.code===group.code&&item.severity===group.severity);
      if(rows.length>group.retainedFindingCount||new Set(rows.filter(item=>item.pageUrl!==null).map(item=>item.pageUrl)).size>group.affectedUrlCount||rows.filter(item=>item.pageUrl===null).length>group.unassignedFindingCount)return false;
    }
  }
  return true;
}
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
function Panel({projectId,search,onNavigate,onUnauthorized,onOpenDomains,onOpenRetention}:Props){
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
  const [expanded,setExpanded]=useState<Record<string,boolean>>({}),[filtersOpen,setFiltersOpen]=useState(false);
  const [groups,setGroups]=useState<Group[]|null>(null),[groupRows,setGroupRows]=useState<Record<string,List<Issue>>>({});
  const resultRequest=useRef<Filters|null>(null);
  const alive=useRef(false),epoch=useRef(0),ticket=useRef(0),reads=useRef(new Map<Slot,Read>()),mutation=useRef<object|null>(null);
  const attemptRef=useRef<Attempt|null>(null),attemptOrigin=useRef<string|null>(null),viewRef=useRef(view),runRef=useRef<Run|null>(null),runTicket=useRef(0),roleTicket=useRef(0);
  const callbacks=useRef({onNavigate,onUnauthorized,onOpenDomains,onOpenRetention});callbacks.current={onNavigate,onUnauthorized,onOpenDomains,onOpenRetention};
  const navigation=search?auditNavigation(search):{},navigationString=JSON.stringify(navigation),ownNavigation=useRef<string|null>(null),receivedNavigation=useRef<string|null>(null);
  const chosenDomain=useRef(false),historyFocus=useRef<string|null>(null),resultFocus=useRef<string|null>(null),pendingFocus=useRef<string|null>(null),heading=useRef<HTMLHeadingElement|null>(null);
  const rawExpired=useRef(new Set<string>()),dataExpired=useRef(new Set<string>()),bodyExpired=useRef(new Set<string>());
  function invalidateReads(){epoch.current++;for(const op of reads.current.values())op.controller.abort();reads.current.clear();setBusy({});}
  function publishNavigation(next:View,replace=false){
    if(!callbacks.current.onNavigate)return;
    const f=next.appliedFilters,value:AuditNavigation=next.runId?{auditRun:next.runId,...(next.pageId?{auditPage:next.pageId}:{}),...(next.tab==='pages'?{auditTab:'pages'}:{}),...(f.severity?{auditSeverity:f.severity as AuditNavigation['auditSeverity']}:{}),...(f.code?{auditCode:f.code}:{}),...(f.pageId?{auditAffectedPage:f.pageId}:{}),...(f.coverage?{auditCoverage:f.coverage as AuditNavigation['auditCoverage']}:{}),...(f.resourceKind!=='html'?{auditResource:f.resourceKind}:{}),...(next.pageId&&next.direction==='in'?{auditDirection:'in'}:{})}:{};
    const key=JSON.stringify(auditNavigation({workspace:search?.workspace,project:projectId,view:'audits',...value}));if(key===receivedNavigation.current||key===ownNavigation.current)return;ownNavigation.current=key;callbacks.current.onNavigate(value,replace);
  }
  function changeView(next:View,navigate=false,replace=false){viewRef.current=next;setView(next);if(navigate)publishNavigation(next,replace);}
  function receiveRole(next:Role,sequence:number){if(!roleValue(next)){const message='Audit access could not be verified. Reload access.';purge();setError(message);throw new Error(message);}if(sequence>=roleTicket.current){roleTicket.current=sequence;setRole(next);}}
  function clearGroups(){for(const [slot,op] of reads.current){if(slot.startsWith('group:')){op.controller.abort();reads.current.delete(slot);}}setBusy(old=>Object.fromEntries(Object.entries(old).filter(([slot])=>!slot.startsWith('group:'))));setErrors(old=>Object.fromEntries(Object.entries(old).filter(([slot])=>!slot.startsWith('group:'))));setExpanded({});setGroupRows({});}
  function clearLists(){resultRequest.current=null;clearGroups();setGroups(null);setFiltersOpen(false);setIssues(empty());setPages(empty());setLinks(empty());setIssueCount(null);setAllFindings(false);}
  function purge(){invalidateReads();setSetup(null);setRole(null);setHistory(empty());setRun(null);runRef.current=null;setPage(null);clearLists();changeView(initialView(),true,true);attemptRef.current=null;attemptOrigin.current=null;setAttempt(null);setUncertain(false);setDomain('');chosenDomain.current=false;setPath('/');setMaxPages('50');setRetainBodyText(false);setUpdated(null);setErrors({});setMessage('');pendingFocus.current=uid+'history-heading';}
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
      clearGroups();setGroups(null);setIssues(empty());setPages(empty());setIssueCount(null);setAllFindings(false);
      const generation=epoch.current;
      queueMicrotask(()=>{if(alive.current&&generation===epoch.current&&!mutation.current){void loadHistory(undefined,true,true);if(viewRef.current.pageId){void loadPage();void loadLinks();}else void loadResults();}});
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
      if(slot.startsWith('group:')&&current.runId){dataExpired.current.add(current.runId);if(runRef.current)receiveRun({...runRef.current,dataStatus:'expired',dataExpiredAt:runRef.current.dataExpiredAt??new Date().toISOString()},++ticket.current);void loadRun();return;}
      if((slot==='page'||slot==='links')&&current.runId){changeView({...current,pageId:null},true,true);void loadRun();void loadResults();}
      else{changeView(initialView(),true,true);runRef.current=null;setRun(null);void loadHistory();}return;
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
  function loadHistory(cursor?:string,recover=true,preserve=false){const q=new URLSearchParams({limit:'50'});if(cursor)q.set('cursor',cursor);return read<{role:Role;runs:Run[];nextCursor:string|null}>('history',B+'?'+q,(data,sequence)=>{receiveRole(data.role,sequence);setHistory(old=>preserve?{...old,loaded:true,cursor:old.loaded?old.cursor:data.nextCursor,rows:[...data.runs.map(rememberExpiry),...old.rows.filter(row=>!data.runs.some(next=>next.id===row.id))]}:append(old,data.runs.map(rememberExpiry),data.nextCursor,!!cursor));},recover);}
  function loadRun(refresh=false){const id=viewRef.current.runId;if(!id)return Promise.resolve();if(refresh)clearGroups();return read<{role:Role;run:Run}>('run',B+'/'+id,(data,sequence)=>{if(!validRun(data.run,projectId)||data.run.id!==id)throw new Error('The audit response was incomplete. Retry the refresh.');receiveRole(data.role,sequence);receiveRun(data.run,sequence);});}
  function loadResults(cursor?:string,requested?:Filters){
    const current=viewRef.current;if(!current.runId||current.pageId)return Promise.resolve();
    const scope=cursor?current.appliedFilters:requested??resultRequest.current??current.appliedFilters;resultRequest.current=scope;
    const q=new URLSearchParams({limit:'50'});if(cursor)q.set('cursor',cursor);
    if(current.tab==='issues'){
      if(scope.severity)q.set('severity',scope.severity);if(scope.code)q.set('code',scope.code);if(scope.pageId)q.set('pageId',scope.pageId);
      return read<IssueResult>('results',B+'/'+current.runId+'/issues?'+q,(data,sequence)=>{receiveRole(data.role,sequence);if(!validIssueResult(data,projectId,current.runId!,scope))throw new Error('The finding observations could not be matched. Retry the results read.');receiveRun(data.run,sequence);if(runRef.current?.dataStatus==='expired'||active(data.run.status)&&!active(runRef.current!.status))return;if(JSON.stringify(viewRef.current.appliedFilters)!==JSON.stringify(scope))clearGroups();changeView({...viewRef.current,appliedFilters:scope},true);setGroups(data.groups);setIssues(old=>append(old,data.issues,data.nextCursor,!!cursor));setIssueCount(data.matchingRetainedCount);setAllFindings(data.findingsComplete);});
    }
    q.set('resourceKind',scope.resourceKind);if(scope.coverage)q.set('coverage',scope.coverage);
    return read<{role:Role;run:Run;pages:Page[];nextCursor:string|null}>('results',B+'/'+current.runId+'/pages?'+q,(data,sequence)=>{receiveRole(data.role,sequence);if(!validRun(data.run,projectId)||data.run.id!==current.runId||!Array.isArray(data.pages)){setPages(empty());throw new Error('The page observations could not be matched. Retry the results read.');}receiveRun(data.run,sequence);if(runRef.current?.dataStatus==='expired')return;const rows=data.pages.map(value=>checkedPage(value,false));if(JSON.stringify(viewRef.current.appliedFilters)!==JSON.stringify(scope))clearGroups();changeView({...viewRef.current,appliedFilters:scope},true);setPages(old=>append(old,rows,data.nextCursor,!!cursor));});
  }
  function loadGroup(group:Group,cursor?:string){
    const current=viewRef.current;if(!current.runId||current.pageId||current.tab!=='issues'||!issueCodes.includes(group.code))return Promise.resolve();
    const key=groupKey(group),slot:Slot=`group:${key}`,scope={...current.appliedFilters,code:group.code,severity:group.severity},q=new URLSearchParams({limit:'50',code:group.code,severity:group.severity});if(scope.pageId)q.set('pageId',scope.pageId);if(cursor)q.set('cursor',cursor);
    return read<IssueResult>(slot,B+'/'+current.runId+'/issues?'+q,(data,sequence)=>{receiveRole(data.role,sequence);if(!validIssueResult(data,projectId,current.runId!,scope))throw new Error('The group findings could not be matched. Retry this issue type.');receiveRun(data.run,sequence);if(!reads.current.has(slot)||runRef.current?.dataStatus==='expired'||active(data.run.status)&&!active(runRef.current!.status))return;setGroupRows(old=>({...old,[key]:append(old[key]??empty(),data.issues,data.nextCursor,!!cursor)}));});
  }
  function toggleGroup(group:Group,open:boolean){const key=groupKey(group),slot:Slot=`group:${key}`;setExpanded(old=>({...old,[key]:open}));if(open){if(!groupRows[key]?.loaded&&!reads.current.has(slot))void loadGroup(group);}else{reads.current.get(slot)?.controller.abort();reads.current.delete(slot);setBusy(old=>({...old,[slot]:false}));}}
  function loadPage(){const current=viewRef.current;if(!current.runId||!current.pageId)return Promise.resolve();return read<{role:Role;run:Run;page:Page}>('page',B+'/'+current.runId+'/pages/'+current.pageId,(data,sequence)=>{receiveRole(data.role,sequence);if(!validRun(data.run,projectId)||data.run.id!==current.runId||data.page?.id!==current.pageId){setPage(null);throw new Error('The page observation could not be matched. Retry the page read.');}receiveRun(data.run,sequence);if(runRef.current?.dataStatus!=='expired')setPage(checkedPage(data.page,true));});}
  function loadLinks(cursor?:string){const current=viewRef.current;if(!current.runId||!current.pageId)return Promise.resolve();const q=new URLSearchParams({limit:'50',direction:current.direction});if(cursor)q.set('cursor',cursor);return read<{role:Role;run:Run;links:Edge[];nextCursor:string|null}>('links',B+'/'+current.runId+'/pages/'+current.pageId+'/links?'+q,(data,sequence)=>{receiveRole(data.role,sequence);receiveRun(data.run,sequence);if(runRef.current?.dataStatus==='expired')return;const rows=runRef.current?.rawEvidenceStatus==='expired'?data.links.map(edge=>({...edge,anchor:null,anchorStatus:'expired' as const})):data.links;setLinks(old=>append(old,rows,data.nextCursor,!!cursor));});}
  function selectRun(id:string){if(mutation.current)return;historyFocus.current=uid+'audit-'+id;pendingFocus.current=uid+'run-heading';invalidateReads();setErrors({});setError('');setMessage('');setRun(null);runRef.current=null;runTicket.current=0;setPage(null);clearLists();changeView({...initialView(),runId:id},true);void loadRun();void loadResults();}
  function selectPage(id:string){if(mutation.current)return;if(!viewRef.current.pageId)resultFocus.current=document.activeElement instanceof HTMLElement?document.activeElement.id:null;pendingFocus.current=uid+'page-heading';invalidateReads();setErrors(old=>({results:old.results}));setPage(null);setLinks(empty());changeView({...viewRef.current,pageId:id,direction:'out'},true);void loadPage();void loadLinks();}
  function back(){if(mutation.current)return;const fromPage=!!viewRef.current.pageId;invalidateReads();setErrors(old=>fromPage?{results:old.results}:{});setError('');if(viewRef.current.pageId){pendingFocus.current=resultFocus.current||uid+'run-heading';setPage(null);setLinks(empty());changeView({...viewRef.current,pageId:null},true);if(!(viewRef.current.tab==='issues'?issues.loaded:pages.loaded))void loadResults();void loadRun();}else{pendingFocus.current=historyFocus.current||uid+'history-heading';changeView(initialView(),true);setRun(null);runRef.current=null;setPage(null);clearLists();void loadSetup();if(!history.loaded)void loadHistory();}}
  function switchTab(tab:View['tab']){if(mutation.current)return;invalidateReads();clearGroups();setGroups(null);setErrors({});setIssues(empty());setPages(empty());setIssueCount(null);resultRequest.current=null;changeView({...viewRef.current,tab},true);void loadResults();void loadRun();}
  function filterChange(patch:Partial<Filters>){if(mutation.current)return;changeView({...viewRef.current,filters:{...viewRef.current.filters,...patch}});}
  function applyFilters(next=viewRef.current.filters){if(mutation.current)return;const current=viewRef.current,fields=current.tab==='issues'?{severity:next.severity,code:next.code,pageId:next.pageId}:{coverage:next.coverage,resourceKind:next.resourceKind};changeView({...current,filters:{...current.filters,...fields}});void loadResults(undefined,{...current.appliedFilters,...fields});}
  function pageFindings(){if(mutation.current||!viewRef.current.pageId)return;const pageId=viewRef.current.pageId;invalidateReads();clearGroups();setGroups(null);setErrors({});setPage(null);setLinks(empty());setIssues(empty());setIssueCount(null);resultRequest.current=null;changeView({...viewRef.current,pageId:null,tab:'issues',filters:{...filters(),pageId},appliedFilters:{...filters(),pageId}},true);void loadResults();void loadRun();}
  function directionChange(direction:View['direction']){if(mutation.current)return;reads.current.get('links')?.controller.abort();reads.current.delete('links');setLinks(empty());changeView({...viewRef.current,direction},true);void loadLinks();}
  function beginWrite(){if(mutation.current||!alive.current)return null;invalidateReads();const token={};mutation.current=token;setWriting(true);setError('');setMessage('');return {token,epoch:epoch.current,sequence:++ticket.current};}
  function currentWrite(op:NonNullable<ReturnType<typeof beginWrite>>){return alive.current&&mutation.current===op.token&&epoch.current===op.epoch;}
  function endWrite(op:NonNullable<ReturnType<typeof beginWrite>>){if(mutation.current===op.token){mutation.current=null;if(alive.current)setWriting(false);}}
  async function start(e:FormEvent){
    e.preventDefault();if(mutation.current||!manages(role)||!attemptRef.current&&!setup?.canStart)return;
    let intent=attemptRef.current;
    if(!intent){const selected=setup?.origins.find(o=>(o.domainId??'canonical')===domain),limit=Number(maxPages);if(!selected||!setup||!path.startsWith('/')||path.startsWith('//')||/[?#]/.test(path)||!Number.isInteger(limit)||limit<1||limit>setup.limits.maxPages){setError('Choose an eligible domain, a query-free rooted path and a valid whole page limit.');return;}if(limit>500&&!window.confirm(`Audit up to ${limit} HTML pages? The 30-minute deadline starts when queued, including waiting time.`))return;intent={requestId:crypto.randomUUID(),domainId:selected.domainId,startPath:path,maxPages:limit,mode:'static',retainBodyText};attemptRef.current=intent;attemptOrigin.current=selected.origin;setAttempt(intent);}
    const op=beginWrite();if(!op)return;
    try{
      const data=await api<unknown>(B,{method:'POST',body:intent});if(!currentWrite(op))return;
      if(!record(data)||!roleValue(data.role)||typeof data.created!=='boolean'||!validRun(data.run,projectId)||data.run.domainId!==intent.domainId||data.run.origin!==attemptOrigin.current||data.run.config.maxPages!==intent.maxPages||(data.run.config.retainBodyText??false)!==intent.retainBodyText||data.run.config.startPath!==new URL(intent.startPath,'https://example.com').pathname||data.run.config.startUrl!==new URL(intent.startPath,attemptOrigin.current!).href)throw new Error('The start acknowledgement was incomplete or did not match this request. Retry the same start request to confirm its receipt.');
      attemptRef.current=null;attemptOrigin.current=null;setAttempt(null);setUncertain(false);setRetainBodyText(false);receiveRole(data.role,op.sequence);pendingFocus.current=uid+'run-heading';changeView({...initialView(),runId:data.run.id},true);runTicket.current=0;runRef.current=null;clearLists();setPage(null);receiveRun(data.run,op.sequence);setMessage(data.created?'Audit request accepted.':'The original audit receipt was recovered.');
    }catch(e){if(currentWrite(op)){const status=e instanceof ApiError?e.status:0;if(status===0||status===408||status===429||status>=500){setUncertain(true);setError(errMsg(e)+' The outcome is unknown; retry this unchanged request.');}else{attemptRef.current=null;attemptOrigin.current=null;setAttempt(null);setUncertain(false);if([401,403,404].includes(status))readError(e,'setup',true);else setError(errMsg(e));}}}
    finally{endWrite(op);}
    if(alive.current&&epoch.current===op.epoch&&!attemptRef.current){void loadHistory(undefined,true,true);if(viewRef.current.runId)void loadResults();else void loadSetup();}
  }
  async function mutate(action:'cancel'|'delete'){
    const selected=runRef.current;if(mutation.current||!selected||!manages(role)||!(action==='cancel'?selected.canCancel:selected.canDelete))return;
    if(!window.confirm(action==='cancel'?'Cancel this audit? Requests already in progress may take a moment to stop. Collected observations stay in history.':'Delete this audit and its collected details? This cannot be undone. A minimal request record is kept to prevent accidental reruns.'))return;
    const op=beginWrite();if(!op)return;
    try{const data=await api<unknown>(B+'/'+selected.id+'/'+action,{method:'POST',body:{}});if(!currentWrite(op))return;
      if(action==='cancel'){if(!record(data)||!roleValue(data.role)||!validRun(data.run,projectId)||data.run.id!==selected.id)throw new Error('Cancellation could not be confirmed. Refresh the audit before trying again.');receiveRole(data.role,op.sequence);receiveRun(data.run,op.sequence);setMessage(data.run.status==='cancelling'?'Cancellation request accepted.':'Audit cancellation confirmed.');}
      else{if(!record(data)||data.deleted!==true||data.id!==selected.id)throw new Error('Deletion could not be confirmed. Refresh history before trying again.');changeView(initialView(),true);runRef.current=null;setRun(null);setPage(null);clearLists();setHistory(old=>({...old,rows:old.rows.filter(row=>row.id!==selected.id)}));setMessage('Audit deleted. Collected details are queued for cleanup.');}
    }catch(e){if(currentWrite(op)){setError(errMsg(e));readError(e,'run',true);}}
    finally{endWrite(op);}
    if(alive.current&&epoch.current===op.epoch){void loadHistory(undefined,true,true);if(viewRef.current.runId)void loadRun();else void loadSetup();}
  }
  useEffect(()=>{alive.current=true;void loadSetup();void loadHistory();return()=>{alive.current=false;epoch.current++;for(const op of reads.current.values())op.controller.abort();reads.current.clear();attemptRef.current=null;attemptOrigin.current=null;};},[]);
  useEffect(()=>{
    if(!search||receivedNavigation.current===navigationString)return;
    if(ownNavigation.current===navigationString){ownNavigation.current=null;receivedNavigation.current=navigationString;return;}
    // External history/URL intent invalidates older reads, never starts an audit.
    invalidateReads();
    if(mutation.current){if(attemptRef.current){setUncertain(true);setError('The start outcome is unknown after navigation changed. Return to audits and retry the unchanged request.');}return;}
    ownNavigation.current=null;receivedNavigation.current=navigationString;
    const f:Filters={severity:navigation.auditSeverity??'',code:navigation.auditCode??'',pageId:navigation.auditAffectedPage??'',coverage:navigation.auditCoverage??'',resourceKind:navigation.auditResource??'html'};
    const prior=viewRef.current,next:View={runId:navigation.auditRun??null,pageId:navigation.auditPage??null,tab:navigation.auditTab??'issues',direction:navigation.auditDirection??'out',filters:f,appliedFilters:f};
    const sameResults=prior.runId===next.runId&&prior.tab===next.tab&&JSON.stringify(prior.appliedFilters)===JSON.stringify(f);
    setErrors(old=>sameResults?{results:old.results}:{});setPage(null);setLinks(empty());
    if(!sameResults){clearLists();setRun(null);runRef.current=null;runTicket.current=0;}else next.filters=prior.filters;
    pendingFocus.current=next.pageId?uid+'page-heading':next.runId?(prior.pageId?resultFocus.current:uid+'run-heading'):historyFocus.current||uid+'history-heading';
    changeView(next);
    if(navigation.auditInvalid){setError('This audit link is invalid. Open audit history to choose a saved audit.');return;}
    setError('');
    if(next.runId){void loadRun();if(next.pageId){void loadPage();void loadLinks();}else if(!sameResults||!(next.tab==='issues'?issues.loaded:pages.loaded))void loadResults();}
    else{void loadSetup();if(!history.loaded)void loadHistory();}
  },[navigationString,writing]);
  useEffect(()=>{if(!run||!active(run.status)||view.runId!==run.id)return;const id=run.id;const refresh=()=>{if(!document.hidden&&alive.current&&viewRef.current.runId===id&&!mutation.current&&!reads.current.has('run'))void loadRun();};const timer=window.setInterval(refresh,5000);document.addEventListener('visibilitychange',refresh);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[run?.id,run?.status,view.runId]);
  useEffect(()=>{if(view.runId||!history.rows.some(row=>active(row.status)))return;const refresh=()=>{if(!document.hidden&&alive.current&&!viewRef.current.runId&&!mutation.current&&!reads.current.has('history'))void loadHistory(undefined,true,true);};const timer=window.setInterval(refresh,5000);document.addEventListener('visibilitychange',refresh);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[view.runId,history.rows]);
  useEffect(()=>{if(view!==viewRef.current||!pendingFocus.current)return;const target=document.getElementById(pendingFocus.current);if(target){target.focus();pendingFocus.current=null;return;}const ready=view.pageId?!!page||!!errors.page:view.runId?!!run||!!errors.run:history.loaded||!!errors.history;if(ready){heading.current?.focus();pendingFocus.current=null;}});
  const managed=manages(role),selectedOrigin=setup?.origins.find(o=>(o.domainId??'canonical')===domain);
  const issueGroups=[...(groups??[])].sort((a,b)=>['critical','warning','info'].indexOf(a.severity)-['critical','warning','info'].indexOf(b.severity)||(b.retainedFindingCount??-1)-(a.retainedFindingCount??-1)||issueLabel(a.code).localeCompare(issueLabel(b.code))||a.code.localeCompare(b.code));
  const errorBox=(slot:Slot,retry:()=>void)=>errors[slot]?<div className="alert" role="alert">{errors[slot]} <button type="button" className="btn" disabled={writing} onClick={retry}>Retry {slot==='run'?'refresh':slot}</button></div>:null;
  const listStatus=(loaded:boolean,slot:Slot)=>busy[slot]?<p role="status">Loading…</p>:!loaded&&!errors[slot]?<p className="hint">Apply filters to load results.</p>:null;
  if(search&&receivedNavigation.current!==navigationString&&ownNavigation.current!==navigationString)return <section className="research-panel site-audits" aria-label="Site audits"><p role="status">Loading audit navigation…</p></section>;
  return <section className="research-panel site-audits" aria-label="Site audits" style={{'--control-md':'var(--control-touch)'} as import('react').CSSProperties}>
    {navigation.auditInvalid&&<button className="btn" disabled={writing} onClick={()=>callbacks.current.onNavigate?.({},true)}>Open audit history</button>}
    {error&&<div className="alert" role="alert">{error} {!writing&&!setup&&<button className="btn" onClick={()=>{void loadSetup();void loadHistory();}}>Reload access</button>}</div>}
    {message&&<p className="notice" role="status">{message}</p>}
    <p className="hint">Manual static HTML audit. Rendered pages, protected-site credentials, scheduling and Lighthouse are not available yet.</p>
    {!view.runId?<>
      {errorBox('setup',()=>void loadSetup())}{busy.setup&&<p role="status">Loading audit setup…</p>}
      {managed&&setup&&<details className="card audit-launch" open><summary>{history.rows.length?'Start another audit':'Start an audit'}</summary>
        {!setup.origins.length&&!attempt?<div className="empty"><p>No eligible HTTPS domain. Add and verify a serving domain to run an audit.</p><button className="btn" disabled={writing} onClick={()=>callbacks.current.onOpenDomains()}>Manage domains</button></div>:<form onSubmit={e=>void start(e)}>
          {setup.worker.status==='unavailable'&&<p className="banner">Worker unavailable. Queued audits expire 30 minutes after creation, including time spent waiting. Ask the operator to check the worker.</p>}
          <fieldset className="audit-launch-fields" disabled={writing||!!attempt} style={{border:0,padding:0,margin:0}}>
            <div className="field"><label htmlFor={uid+'domain'}>Domain</label><select id={uid+'domain'} value={domain} onChange={e=>{chosenDomain.current=true;setDomain(e.target.value);}}><option value="">Choose a domain</option>{setup.origins.map(o=><option key={o.domainId??'canonical'} value={o.domainId??'canonical'}>{o.origin} · {o.authority==='canonical_project'?'Project origin':'Verified serving domain'}</option>)}</select></div>
            <div className="field"><label htmlFor={uid+'path'}>Start path</label><input id={uid+'path'} value={path} maxLength={2048} required onChange={e=>setPath(e.target.value)} aria-describedby={uid+'path-help'}/><p className="hint" id={uid+'path-help'}>Start with /. Queries and fragments are not supported. Other paths on this origin may be discovered.</p></div>
            <p className="mono">{attempt?attemptOrigin.current+attempt.startPath:selectedOrigin?selectedOrigin.origin+path:'Choose an eligible domain.'}</p>
            <div className="field"><label htmlFor={uid+'limit'}>Maximum HTML pages</label><input id={uid+'limit'} type="number" min={1} max={setup.limits.maxPages} step={1} required value={maxPages} onChange={e=>setMaxPages(e.target.value)}/><p className="hint">An attempt limit, not a promise that every page will be analyzed.</p></div>
            <label style={{display:'flex',alignItems:'center',gap:'var(--space-2)',minHeight:44}}><input type="checkbox" checked={retainBodyText} onChange={e=>setRetainBodyText(e.target.checked)} aria-describedby={uid+'body-help'}/>Retain page text for content analysis</label><p className="hint" id={uid+'body-help'}>Copies public static page text under workspace raw-evidence retention. It may include public personal information and boilerplate. Does not send it to AI.</p>
          </fieldset>
          <p className="hint">Static HTML · same origin · robots respected · query URLs excluded · no paid provider API.</p>
          <details><summary>Operational limits</summary><p>Worker heartbeat: {date(setup.worker.lastHeartbeatAt)}. One active audit per workspace; one running audit across the installation. Up to {setup.limits.maxMinutes} minutes from queueing; at most {setup.limits.requestsPerSecond} request per second.</p><p>Up to 3 × the page limit + 100 requests; {number(setup.limits.bodyCapacityBytes/1048576)} MiB body-capacity allowance, {number(setup.limits.frontier)} discovered resources, {number(setup.limits.edges)} recorded edges, {setup.limits.sitemapDocuments} sitemaps and sitemap depth {setup.limits.sitemapDepth}. These are ceilings, not throughput or TCP-bandwidth guarantees.</p></details>
          {uncertain&&<p className="banner">Start outcome unknown. The original request and settings are retained. Retry to recover the same receipt.</p>}
          <div className="row"><button className="btn primary" type="submit" disabled={writing||!attempt&&(!setup.canStart||!selectedOrigin)}>{writing?'Starting…':attempt?'Retry start request':setup.worker.status==='unavailable'?'Queue audit':'Start audit'}</button><button className="btn" type="button" disabled={writing||!!attempt} onClick={()=>callbacks.current.onOpenDomains()}>Manage domains</button></div>
        </form>}
      </details>}
      {role&&!managed&&<p className="notice">You can inspect audits. A workspace owner or admin can start, cancel or delete them.</p>}
      <section className="card"><div className="row between"><h2 id={uid+'history-heading'} ref={heading} tabIndex={-1}>Audit history</h2><button className="btn" disabled={writing||busy.history} onClick={()=>void loadHistory()}>Refresh history</button></div>{errorBox('history',()=>void loadHistory())}
        {busy.history&&<p role="status">Loading audit history…</p>}
        {history.loaded&&!history.rows.length&&<p className="empty">No audits yet. {managed?'Choose an eligible domain to start the first audit.':'Ask a workspace owner or admin to start an audit.'}</p>}
        {!!history.rows.length&&<div className="table-wrap" tabIndex={0} role="region" aria-label="Audit history"><table><thead><tr><th>Started</th><th>Origin and start path</th><th>Outcome</th><th>Attempted / analyzed</th><th>Retained findings</th><th>Action</th></tr></thead><tbody>{history.rows.map(row=><tr key={row.id}><td>{row.startedAt?date(row.startedAt):'Not started'}<p className="hint">Queued {date(row.createdAt)}</p></td><td>{row.origin}<br/><span className="mono">{row.config.startPath}</span></td><td>{words(row.status)}{row.dataStatus==='expired'&&<p className="hint">Detailed data expired</p>}</td><td>{row.summary?number(row.summary.pagesObserved)+' / '+number(row.summary.pagesAnalyzed):'Summary not produced'}</td><td>{number(row.summary?.issuesRetained)}</td><td><button id={uid+'audit-'+row.id} className="btn" disabled={writing} onClick={()=>selectRun(row.id)}>View audit</button></td></tr>)}</tbody></table></div>}
        {history.cursor&&<button className="btn" disabled={writing||busy.history} onClick={()=>void loadHistory(history.cursor!)}>Load more audits</button>}
      </section>
    </>:<>
      <button className="btn ghost" disabled={writing} onClick={back}>{view.pageId?'← Back to results':'← Back to audits'}</button>
      {errorBox('run',()=>void loadRun())}{!run&&busy.run&&<p role="status">Loading audit…</p>}
      {run&&<section className="card">
        <div className="row between" style={{gap:'var(--space-3)',marginBottom:'var(--space-2)'}}>
          <h2 id={uid+'run-heading'} ref={heading} tabIndex={-1} style={{margin:0}}>{run.origin} <span className="pill">{words(run.status)}</span></h2>
          <div className="row"><button className="btn" disabled={writing||busy.run} onClick={()=>void loadRun(true)}>Refresh status</button>{managed&&run.canCancel&&<button className="btn" disabled={writing} onClick={()=>void mutate('cancel')}>{writing?'Saving…':'Cancel audit'}</button>}{managed&&run.canDelete&&<button className="btn ghost" disabled={writing} onClick={()=>void mutate('delete')}>Delete audit</button>}</div>
        </div>
        <p className="mono">Start path: {run.config.startPath} · Static HTML</p><p className="hint">{run.startedAt?'Started '+date(run.startedAt):'Not started · Queued '+date(run.createdAt)}</p>
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
      {run&&run.dataStatus!=='expired'&&!view.pageId&&<section className="card"><nav className="row" aria-label="Audit results"><button className={view.tab==='issues'?'btn primary':'btn'} style={{fontWeight:view.tab==='issues'?700:500,textDecoration:view.tab==='issues'?'underline':undefined,textUnderlineOffset:'0.2em'}} aria-pressed={view.tab==='issues'} disabled={writing} onClick={()=>switchTab('issues')}>Issues</button><button className={view.tab==='pages'?'btn primary':'btn'} style={{fontWeight:view.tab==='pages'?700:500,textDecoration:view.tab==='pages'?'underline':undefined,textUnderlineOffset:'0.2em'}} aria-pressed={view.tab==='pages'} disabled={writing} onClick={()=>switchTab('pages')}>Pages</button></nav>
        <p className="hint">{view.tab==='issues'?'Findings recorded by this audit':'Recorded URLs and their coverage'}</p><details open={filtersOpen} onToggle={e=>setFiltersOpen(e.currentTarget.open)}><summary>Filters</summary>
        <form onSubmit={e=>{e.preventDefault();applyFilters();}}><div className="row">
          {view.tab==='issues'?<><div className="field"><label htmlFor={uid+'severity'}>Severity</label><select id={uid+'severity'} disabled={writing} value={view.filters.severity} onChange={e=>filterChange({severity:e.target.value})}><option value="">All severities</option>{(['critical','warning','info'] as const).map(x=><option key={x} value={x}>{severityLabel(x)}</option>)}</select></div><div className="field"><label htmlFor={uid+'code'}>Issue type</label><select id={uid+'code'} disabled={writing} value={view.filters.code} onChange={e=>filterChange({code:e.target.value})}><option value="">All issue types</option>{issueCodes.map(x=><option key={x} value={x}>{issueLabel(x)}</option>)}</select></div></>:<><div className="field"><label htmlFor={uid+'resource'}>Resource</label><select id={uid+'resource'} disabled={writing} value={view.filters.resourceKind} onChange={e=>filterChange({resourceKind:e.target.value as Filters['resourceKind']})}>{['html','robots','sitemap'].map(x=><option key={x} value={x}>{x==='html'?'HTML':words(x)}</option>)}</select></div><div className="field"><label htmlFor={uid+'coverage'}>Coverage</label><select id={uid+'coverage'} disabled={writing} value={view.filters.coverage} onChange={e=>filterChange({coverage:e.target.value})}><option value="">All coverage</option>{covers.map(x=><option key={x} value={x}>{coverageLabels[x]}</option>)}</select></div></>}
          <button className="btn" type="submit" disabled={writing||busy.results}>Apply filters</button><button className="btn ghost" type="button" disabled={writing} onClick={()=>{applyFilters(filters());}}>Clear filters</button>
        </div></form>
        {(view.tab==='issues'?['severity','code','pageId'] as const:['coverage','resourceKind'] as const).some(key=>view.filters[key]!==view.appliedFilters[key])&&<p className="notice">Changes not applied. The previous applied results remain below.</p>}
        </details>
        {view.tab==='issues'&&view.appliedFilters.pageId&&<p className="notice">Showing findings where the selected page is the primary affected page. Clear filters to return to all findings.</p>}
        {errorBox('results',()=>void loadResults())}{errors.results&&(issues.loaded||pages.loaded)&&<p className="banner">Previous applied results are shown; the requested results could not be refreshed. Retry uses the failed request’s filters.</p>}{view.tab==='issues'?busy.results?<p role="status">Loading issue types…</p>:null:listStatus(pages.loaded,'results')}
        {view.tab==='issues'?<>
          {active(run.status)&&<p className="hint">Findings may change until finalization.</p>}{issueCount!==null&&(issueGroups.length>0||view.appliedFilters.code||view.appliedFilters.severity||view.appliedFilters.pageId)&&<p>{number(issueCount)} matching retained findings.</p>}{issues.loaded&&!allFindings&&<p className="hint">The retained finding list may be incomplete.</p>}
          {issues.loaded&&!busy.results&&!errors.results&&!issueGroups.length&&<div className="empty"><p>{view.appliedFilters.code||view.appliedFilters.severity||view.appliedFilters.pageId?'No retained findings match these filters. Open Filters to adjust or clear them.':active(run.status)?'No retained findings observed yet.':!active(run.status)&&run.summary!==null&&run.summary.pagesAnalyzed>0&&run.summary.issuesDetected===0&&issueCount===0?'Inspect the recorded pages to review their coverage and evidence.':'No retained findings are available in this list.'}</p>{!view.appliedFilters.code&&!view.appliedFilters.severity&&!view.appliedFilters.pageId&&<button className="btn" disabled={writing} onClick={()=>switchTab('pages')}>View recorded pages</button>}</div>}
          {!!issueGroups.length&&<div className="audit-issue-list" role="region" aria-label="Audit findings">
            <h3>Issue types</h3><p className="hint">Counts use retained findings and their distinct primary affected URLs. Target and related pages are separate evidence.</p>
            {issueGroups.map((group,index)=>{const key=groupKey(group),slot:Slot=`group:${key}`,list=groupRows[key]??empty<Issue>();return <div key={key} className="audit-issue-group">
              {(index===0||issueGroups[index-1].severity!==group.severity)&&<h3>{severityLabel(group.severity)}</h3>}
              <details open={expanded[key]??false} onToggle={e=>toggleGroup(group,e.currentTarget.open)}>
                <summary><span>{issueLabel(group.code)}</span>{' · '}<span className="audit-group-count">{group.affectedUrlCount===null?'Count pending':number(group.affectedUrlCount)+' affected URLs'}</span></summary>
                <p><strong>Why: </strong>{issueAdvice[group.code]?.[0]??'A finding was recorded under this rule.'}</p><p><strong>What to check: </strong>{issueAdvice[group.code]?.[1]??'Inspect the recorded page before choosing a change.'}</p>
                <p aria-live="polite">{group.affectedUrlCount===null?'Count pending · Findings may change until finalization.':number(group.affectedUrlCount)+' affected URLs · '+number(group.retainedFindingCount)+' retained findings'}{group.unassignedFindingCount!==null&&group.unassignedFindingCount>0?' · '+number(group.unassignedFindingCount)+' findings have no primary page':''}</p>
                {!issueCodes.includes(group.code)?<p className="notice">Details unavailable in this app version.</p>:<>
                  {errors[slot]&&<div className="alert" role="alert">{errors[slot]} <button className="btn" disabled={writing||busy[slot]} onClick={()=>void loadGroup(group,list.cursor??undefined)}>Retry findings</button></div>}
                  {busy[slot]&&<p role="status">Loading findings for {issueLabel(group.code)}…</p>}
                  {list.loaded&&!list.rows.length&&!busy[slot]&&!errors[slot]&&<p>No retained findings available for this issue type.</p>}
                  <ul className="audit-finding-list">{list.rows.map(item=><li key={item.id}>
                    {item.pageUrl?<a dir="auto" href={item.pageUrl} target="_blank" rel="noopener noreferrer">{item.pageUrl}</a>:<p className="hint">Primary page URL unavailable.</p>}
                    {Object.entries(item.details).map(([key,value])=><p className="hint" key={key}>{words(key)}: {number(value)}</p>)}
                    <div className="row">{item.pageId&&<button id={uid+'issue-'+item.id} className="btn" disabled={writing} aria-label={'View saved evidence: '+issueLabel(item.code)+' · '+item.pageId.slice(0,8)} onClick={()=>selectPage(item.pageId!)}>View saved evidence</button>}
                    {item.targetPageId&&item.targetPageId!==item.pageId&&<button id={uid+'target-'+item.id} className="btn" disabled={writing} aria-label={'View target page: '+issueLabel(item.code)+' · '+item.targetPageId.slice(0,8)} onClick={()=>selectPage(item.targetPageId!)}>View target page</button>}
                    {item.relatedPageIds.filter(id=>id!==item.pageId&&id!==item.targetPageId).map((id,i)=><button id={uid+'related-'+item.id+'-'+id} key={id} className="btn" disabled={writing} aria-label={'View related page '+(i+1)+': '+issueLabel(item.code)+' · '+id.slice(0,8)} onClick={()=>selectPage(id)}>View related page {i+1}</button>)}</div>
                    {item.targetPageUrl&&<p>Target URL: <a dir="auto" href={item.targetPageUrl} target="_blank" rel="noopener noreferrer">{item.targetPageUrl}</a></p>}
                    {!!item.relatedPageIds.length&&<p className="hint">Related pages are a retained sample.</p>}
                    <details><summary>Rule details</summary><p className="mono">{item.ruleVersion} · {item.code} · {severityLabel(item.severity)}</p></details>
                  </li>)}</ul>
                  {list.cursor&&<button className="btn" disabled={writing||busy[slot]} onClick={()=>void loadGroup(group,list.cursor!)}>Load more findings</button>}
                </>}
              </details>
            </div>;})}
          </div>}
        </>:<>
          {pages.loaded&&<p className="hint">{number(pages.rows.length)} loaded recorded resources.</p>}
          {pages.loaded&&!busy.results&&!errors.results&&!pages.rows.length&&<p className="empty">No recorded pages match these filters.</p>}
          {!!pages.rows.length&&<div className="table-wrap" tabIndex={0} role="region" aria-label="Recorded audit pages"><table><thead><tr><th>URL</th><th>HTTP</th><th>Coverage</th><th>H1 / Words / Images</th><th>Total response</th><th>Action</th></tr></thead><tbody>{pages.rows.map(item=><tr key={item.id}><td>{item.url}</td><td>{item.httpStatus??'No status recorded'}</td><td>{coverageLabels[item.analysis.coverage]??'Unavailable'}<p className="hint">Resource: {words(item.state)}</p></td><td>{item.analysis.facts?number(item.analysis.facts.headingCounts[0])+' / '+number(item.analysis.facts.wordCount)+' / '+number(item.analysis.facts.imagesTotal)+' ('+number(item.analysis.facts.imagesMissingAlt)+' missing alt)':'Unavailable'}</td><td>{item.responseTimeMs===null?'Not recorded':number(item.responseTimeMs)+' ms'}</td><td><button id={uid+'page-'+item.id} className="btn" disabled={writing} onClick={()=>selectPage(item.id)}>View page</button></td></tr>)}</tbody></table></div>}
          {pages.cursor&&<button className="btn" disabled={writing||busy.results} onClick={()=>void loadResults(pages.cursor!)}>Load more pages</button>}
        </>}
      </section>}
      {run&&run.dataStatus!=='expired'&&view.pageId&&<section className="card">{errorBox('page',()=>void loadPage())}{busy.page&&<p role="status">Loading page details…</p>}{page&&<>
        <h2 id={uid+'page-heading'} tabIndex={-1}>{page.url}</h2><p>{coverageLabels[page.analysis.coverage]??'Unavailable'} · HTTP {page.httpStatus??'not recorded'} · Observed {date(page.observedAt)}</p><p className="hint">Sources: {Object.entries(page.sources).filter(([,value])=>value).map(([key])=>words(key)).join(', ')||'Not recorded'}; link depth {number(page.linkDepth)}; sitemap depth {page.sitemapDepth}. Total response {page.responseTimeMs===null?'not recorded':number(page.responseTimeMs)+' ms'}.</p><button className="btn" disabled={writing} onClick={pageFindings}>View page findings</button><p className="hint">Only findings where this is the primary affected page.</p><Reasons reasons={page.analysis.reasons}/>
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
