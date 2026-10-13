import type {SpecializedFilters,SpecializedNavigation,SpecializedReport} from '../server/prompt-citation-specializations';
import type {CitationFilters} from '../server/prompt-citations';
import {validCitationFilters,validCitationEvidence,citationSafeHref} from './citation-report.ts';

const periods=['current','previous'] as const;
const eligibility=['eligible','queued','running','no_answer','empty','truncated','content_filtered','expired','invalid'] as const;
const coverageKeys=['attempted',...eligibility];
const filterKeys=['from','to','timeZone','model','promptId','tag','urlGrouping','query','publisherCategory','pageType','sourceType','ownership','entityId','productAttribution'];
const navigationKeys=['view','period','groupId','gapPromptId','evidenceMode'];
const gapKeys=['evaluatedPrompts','promptsWithCompetitor','observedCandidates','confirmedCandidates','matchingCandidates'];
const methods={reddit:'reddit-path-community-v1',googleLabels:'google-retained-link-labels-elmo-v1',productAttribution:'google-product-name-elmo-v1',gaps:'prompt-period-domain-gap-v1'};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const own=(v:Record<string,any>,key:string)=>Object.hasOwn(v,key);
const shape=(v:unknown,keys:readonly string[]):v is Record<string,any>=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>own(v,k));
const integer=(v:unknown,max=100000):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=max;
const prose=(v:unknown,max=2*1024*1024):v is string=>typeof v==='string'&&v.length<=max&&!/[\x00\uD800-\uDFFF]/u.test(v);
const text=(v:unknown,max=2048,min=0):v is string=>prose(v,max)&&v.length>=min&&!/[\x01-\x1f\x7f]/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&v.length===64&&/^[a-f0-9]+$/.test(v);
const member=(v:unknown,values:readonly string[]):v is string=>typeof v==='string'&&values.includes(v);
const array=(v:unknown,max:number):v is any[]=>Array.isArray(v)&&v.length<=max&&Object.keys(v).length===v.length&&Array.from({length:v.length},(_,i)=>own(v,String(i))).every(Boolean);
const stamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,19)===v.slice(0,19)&&!v.startsWith('0000');
const equal=(v:unknown,expected:object,keys:readonly string[])=>shape(v,keys)&&keys.every(k=>v[k]===(expected as Record<string,unknown>)[k]);
const countKeys=['executions','annotations','prompts'];
function count(v:unknown,maxExecutions:number,maxAnnotations=maxExecutions*100):boolean{
 return object(v)&&countKeys.every(k=>own(v,k))&&integer(v.executions,maxExecutions)&&integer(v.annotations,maxAnnotations)&&integer(v.prompts,v.executions)&&v.executions<=v.annotations&&v.annotations<=v.executions*100&&(v.executions===0)===(v.prompts===0);
}
const subset=(a:Record<string,number>,b:Record<string,number>)=>countKeys.every(k=>a[k]<=b[k]);
const sameCount=(a:Record<string,number>,b:Record<string,number>)=>countKeys.every(k=>a[k]===b[k]);
function partition(total:Record<string,number>,parts:Record<string,number>[]):boolean{
 return parts.every(p=>subset(p,total))&&parts.reduce((n,p)=>n+p.annotations,0)===total.annotations&&['executions','prompts'].every(k=>Math.max(...parts.map(p=>p[k]))<=total[k]&&parts.reduce((n,p)=>n+p[k],0)>=total[k]);
}
function coverage(v:unknown):boolean{return shape(v,coverageKeys)&&coverageKeys.every(k=>integer(v[k],1000))&&eligibility.reduce((n,k)=>n+v[k],0)===v.attempted;}
function baseFilters(f:SpecializedFilters):CitationFilters{const {productAttribution:_,...base}=f;return base;}

export function validSpecializedCitationFilters(v:unknown):v is SpecializedFilters{
 try{return shape(v,filterKeys)&&(v.productAttribution===null||member(v.productAttribution,['brand','competitor','other']))&&validCitationFilters(baseFilters(v as SpecializedFilters));}catch{return false;}
}
export function validSpecializedCitationNavigation(v:unknown):v is SpecializedNavigation{
 if(!shape(v,navigationKeys)||!member(v.view,['reddit','reddit_pages','shopping','search','gaps','prompts','evidence'])||v.period!==null&&!member(v.period,periods)||v.groupId!==null&&!hex(v.groupId)||v.gapPromptId!==null&&!uuid(v.gapPromptId)||v.evidenceMode!==null&&!member(v.evidenceMode,['matching','gap_all']))return false;
 if(['reddit','shopping','search'].includes(v.view))return v.period===null&&v.groupId===null&&v.gapPromptId===null&&v.evidenceMode===null;
 if(v.view==='gaps')return v.period!==null&&v.groupId===null&&v.gapPromptId===null&&v.evidenceMode===null;
 if(v.view==='reddit_pages'||v.view==='prompts')return v.period!==null&&v.groupId!==null&&v.gapPromptId===null&&v.evidenceMode===null;
 return v.period!==null&&(v.evidenceMode==='gap_all'?v.groupId===null&&v.gapPromptId!==null:v.evidenceMode==='matching'&&v.groupId!==null);
}

// A project ID is not in this DTO. The controller must bind the request/response
// generation to its mounted project; hashes/group references are not authority.
export function validSpecializedCitationReport(value:unknown,f:SpecializedFilters,n:SpecializedNavigation,pageIndex:number):value is SpecializedReport{
 try{return report(value,f,n,pageIndex);}catch{return false;}
}
function report(v:unknown,f:SpecializedFilters,n:SpecializedNavigation,pageIndex:number):boolean{
 if(!validSpecializedCitationFilters(f)||!validSpecializedCitationNavigation(n)||!integer(pageIndex,2000)||!shape(v,['role','filters','navigation','asOf','contextRevision','profileHash','selectionRevision','eligibilityVersion','classifierVersion','ownershipVersion','googleDomainsVersion','methods','label','warnings','entities','googleConsumerModule','unresolvedEvidence','current','previous','evidenceStates','page','totalRows','nextCursor']))return false;
 if(!member(v.role,['owner','admin','editor','viewer'])||!equal(v.filters,f,filterKeys)||!equal(v.navigation,n,navigationKeys)||!stamp(v.asOf)||!integer(v.contextRevision,2147483647)||v.contextRevision<1||!hex(v.profileHash)||!hex(v.selectionRevision)||v.eligibilityVersion!=='retained-nonempty-stop-v1'||v.classifierVersion!=='elmo-3c673d0-native-axes-v1'||v.ownershipVersion!=='citation-host-suffix-v1'||!text(v.googleDomainsVersion,160)||!/^google-supported-2026-10-13-sha256-[a-f0-9]{64}$/.test(v.googleDomainsVersion)||!equal(v.methods,methods,Object.keys(methods))||v.label!=='Specialized retained citation observations using current project context'||!array(v.warnings,10)||!v.warnings.every(w=>text(w)))return false;
 if(!equal(v.googleConsumerModule,{status:'not_recorded',reason:'consumer_surface_not_captured'},['status','reason'])||!shape(v.unresolvedEvidence,['redditCommunityId','shoppingLabelId','searchQueryId','googleWrapperId'])||!Object.values(v.unresolvedEvidence).every(hex)||new Set(Object.values(v.unresolvedEvidence)).size!==4)return false;
 if(!array(v.entities,101)||v.entities.length<1||!v.entities.every((e,i)=>shape(e,['id','label'])&&(i===0?e.id==='brand':uuid(e.id))&&prose(e.label,512)&&e.label.length>0)||new Set(v.entities.map(e=>e.id.toLowerCase())).size!==v.entities.length||f.entityId!==null&&!v.entities.some(e=>e.id===f.entityId))return false;
 const ids=v.entities.slice(1).map(e=>e.id),base=baseFilters(f),formatter=new Intl.DateTimeFormat('en-CA',{timeZone:f.timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
 const sourceUnfiltered=[f.query,f.publisherCategory,f.pageType,f.sourceType,f.ownership,f.entityId].every(value=>value===null);
 const localDay=(s:string)=>{const parts=formatter.formatToParts(new Date(s)),p=(name:string)=>parts.find(p=>p.type===name)!.value;return `${p('year')}-${p('month')}-${p('day')}`;};
 const length=1+(Date.parse(f.to)-Date.parse(f.from))/86400000,previousFrom=new Date(Date.parse(f.from)-length*86400000).toISOString().slice(0,10),previousTo=new Date(Date.parse(f.from)-86400000).toISOString().slice(0,10);
 if(!/^\d{4}-\d\d-\d\d$/.test(previousFrom)||previousFrom.startsWith('0000'))return false;
 for(const side of periods){const p=v[side];
  if(!shape(p,['from','to','open','coverage','eligibleAnswers','reddit','google','gaps'])||p.from!==(side==='current'?f.from:previousFrom)||p.to!==(side==='current'?f.to:previousTo)||p.open!==(p.to>=localDay(v.asOf))||!coverage(p.coverage)||p.eligibleAnswers!==(p.coverage.eligible||null))return false;
  if(!shape(p.reddit,['all','community','ungrouped'])||!shape(p.google,['shopping','labelledShopping','unlabelledShopping','matchingProducts','search','labelledSearch','unlabelledSearch','wrappers'])||![...Object.values(p.reddit),...Object.values(p.google)].every(c=>shape(c,countKeys)&&count(c,p.coverage.eligible)))return false;
  if(!partition(p.reddit.all,[p.reddit.community,p.reddit.ungrouped])||!partition(p.google.shopping,[p.google.labelledShopping,p.google.unlabelledShopping])||!partition(p.google.search,[p.google.labelledSearch,p.google.unlabelledSearch])||!subset(p.google.matchingProducts,p.google.labelledShopping)||f.productAttribution===null&&!sameCount(p.google.matchingProducts,p.google.labelledShopping)||p.reddit.all.annotations+p.google.shopping.annotations+p.google.search.annotations+p.google.wrappers.annotations>p.coverage.eligible*100)return false;
  if(!shape(p.gaps,['status',...gapKeys]))return false;
  if(p.gaps.status==='brand_identity_unavailable'){if(!gapKeys.every(k=>p.gaps[k]===null))return false;}
  else if(p.gaps.status!=='ready'||!gapKeys.every(k=>integer(p.gaps[k],p.coverage.eligible))||p.gaps.promptsWithCompetitor>p.gaps.evaluatedPrompts||p.gaps.observedCandidates>p.gaps.promptsWithCompetitor||p.gaps.confirmedCandidates>p.gaps.observedCandidates||p.gaps.matchingCandidates>p.gaps.observedCandidates||sourceUnfiltered&&p.gaps.matchingCandidates!==p.gaps.observedCandidates||p.open&&p.gaps.confirmedCandidates!==0)return false;
 }
 if(v.current.gaps.status!==v.previous.gaps.status||v.current.coverage.attempted+v.previous.coverage.attempted>1000||!array(v.evidenceStates,1000)||v.evidenceStates.length!==v.current.coverage.attempted+v.previous.coverage.attempted||!v.evidenceStates.every(e=>shape(e,['id','period','eligibility'])&&uuid(e.id)&&member(e.period,periods)&&member(e.eligibility,eligibility))||new Set(v.evidenceStates.map(e=>e.id.toLowerCase())).size!==v.evidenceStates.length)return false;
 for(const side of periods){const entries=v.evidenceStates.filter(e=>e.period===side);if(!coverageKeys.every(k=>k==='attempted'?entries.length===v[side].coverage.attempted:entries.filter(e=>e.eligibility===k).length===v[side].coverage[k]))return false;}
 const eligible=(id:string,side:string)=>v.evidenceStates.some((e:any)=>e.id===id&&e.period===side&&e.eligibility==='eligible');
 const rep=(r:unknown,side:typeof periods[number],present:boolean)=>!present?r===null:shape(r,['executionId','comparisonId','retainedCitationIndex','retainedUrl','retainedTitle','requestedAt'])&&uuid(r.executionId)&&eligible(r.executionId,side)&&uuid(r.comparisonId)&&integer(r.retainedCitationIndex,99)&&prose(r.retainedUrl,2048)&&citationSafeHref(r.retainedUrl)!==null&&(r.retainedTitle===null||prose(r.retainedTitle))&&stamp(r.requestedAt)&&localDay(r.requestedAt)>=v[side].from&&localDay(r.requestedAt)<=v[side].to;
 const prompt=(r:Record<string,any>,maxVersions:number)=>uuid(r.promptId)&&(f.promptId===null||f.promptId===r.promptId)&&uuid(r.representativeVersionId)&&prose(r.promptPreview,320)&&Array.from(r.promptPreview).length<=160&&integer(r.versionCount,maxVersions)&&r.versionCount>0;
 const sortedIds=(list:unknown)=>array(list,100)&&list.every((id,i)=>uuid(id)&&ids.includes(id)&&(i===0||list[i-1]<id));
 if(!shape(v.page,n.view==='evidence'?['kind','basis','rows']:['kind','rows'])||v.page.kind!==n.view||!integer(v.totalRows)||!array(v.page.rows,50)||v.page.rows.length!==Math.min(50,Math.max(0,v.totalRows-pageIndex*50))||v.nextCursor!==null&&(!text(v.nextCursor,512,1)||!/^[A-Za-z0-9_-]+$/.test(v.nextCursor))||(v.nextCursor!==null)!==(v.totalRows>(pageIndex+1)*50))return false;
 const rows=v.page.rows,keys=rows.map(r=>object(r)?(['gaps','prompts'].includes(n.view)?r.promptId:r.id):null);if(new Set(keys.map(id=>typeof id==='string'?id.toLowerCase():id)).size!==rows.length)return false;
 const side=n.period!,p=side?v[side]:null;
 let valid=false;
 if(['reddit','shopping','search'].includes(n.view)){
  const summary=(side:typeof periods[number])=>n.view==='reddit'?v[side].reddit.community:n.view==='shopping'?v[side].google.matchingProducts:v[side].google.labelledSearch;
  if(v.totalRows>summary('current').annotations+summary('previous').annotations||v.totalRows===0&&(summary('current').annotations+summary('previous').annotations)>0)return false;
  valid=rows.every(r=>{
   const fields=['id','label','current','previous','kind',...(n.view==='reddit'?['communityKey','currentNewPages','previousNotObservedPages','changeStatus']:n.view==='shopping'?['labelBasis','attribution','currentRepresentative','previousRepresentative']:['labelBasis'])];
   if(!shape(r,fields)||!hex(r.id)||!prose(r.label)||!r.label||periods.some(s=>!shape(r[s],[...countKeys,'groupedPages'])||!count(r[s],summary(s).executions,summary(s).annotations)||!subset(r[s],summary(s))||!integer(r[s].groupedPages,r[s].annotations)||(r[s].groupedPages===0)!==(r[s].annotations===0))||r.current.annotations+r.previous.annotations===0)return false;
   if(n.view==='reddit'){
    const status=!v.previous.coverage.attempted?'no_previous':!v.previous.coverage.eligible||!v.current.coverage.eligible?'unavailable':v.previous.open||v.current.open?'in_progress':v.previous.coverage.eligible*10<v.previous.coverage.attempted*9||v.current.coverage.eligible*10<v.current.coverage.attempted*9?'incomplete':'ready';
    return r.kind==='reddit'&&typeof r.communityKey==='string'&&/^r\/[a-z0-9_]{1,64}$/.test(r.communityKey)&&r.label===r.communityKey&&r.changeStatus===status&&(status==='ready'?integer(r.currentNewPages,r.current.groupedPages)&&integer(r.previousNotObservedPages,r.previous.groupedPages):r.currentNewPages===null&&r.previousNotObservedPages===null);
   }
   if(n.view==='search')return r.kind==='query'&&r.labelBasis==='retained_url_q'&&text(r.label,2048,1)&&!/[\u0080-\u009f]/u.test(r.label);
   return r.kind==='product'&&member(r.labelBasis,['retained_title','url_product_id','mixed'])&&shape(r.attribution,['kind','competitorId'])&&member(r.attribution.kind,['brand','competitor','other'])&&(r.attribution.kind==='competitor'?uuid(r.attribution.competitorId)&&ids.includes(r.attribution.competitorId):r.attribution.competitorId===null)&&(f.productAttribution===null||r.attribution.kind===f.productAttribution)&&rep(r.currentRepresentative,'current',r.current.annotations>0)&&rep(r.previousRepresentative,'previous',r.previous.annotations>0);
  });
  if(valid)valid=periods.every(s=>rows.reduce((sum,r)=>sum+r[s].annotations,0)<=summary(s).annotations);
  if(valid&&pageIndex===0&&v.totalRows<=50)valid=periods.every(s=>partition(summary(s),rows.map(r=>r[s])));
 }else if(n.view==='gaps'){
  if(p.gaps.status==='brand_identity_unavailable')valid=v.totalRows===0;
  else valid=v.totalRows===p.gaps.matchingCandidates&&rows.every(r=>shape(r,['promptId','representativeVersionId','promptPreview','versionCount','period','coverage','status','brandAnnotations','competitorCount','competitorIds','matchingCompetitorCount'])&&coverage(r.coverage)&&coverageKeys.every(k=>r.coverage[k]<=p.coverage[k])&&r.coverage.eligible>0&&prompt(r,r.coverage.attempted)&&r.period===side&&r.brandAnnotations===0&&r.status===(r.coverage.eligible<r.coverage.attempted?'incomplete_evidence':p.open?'in_progress':'confirmed_observed_gap')&&shape(r.competitorCount,countKeys)&&count(r.competitorCount,r.coverage.eligible)&&r.competitorCount.annotations>0&&r.competitorCount.prompts===1&&shape(r.matchingCompetitorCount,countKeys)&&count(r.matchingCompetitorCount,r.competitorCount.executions,r.competitorCount.annotations)&&subset(r.matchingCompetitorCount,r.competitorCount)&&r.matchingCompetitorCount.prompts===1&&sortedIds(r.competitorIds)&&r.competitorIds.length>0);
  if(valid)valid=coverageKeys.every(k=>rows.reduce((sum,r)=>sum+r.coverage[k],0)<=p.coverage[k])&&rows.filter(r=>r.status==='confirmed_observed_gap').length<=(p.gaps.confirmedCandidates??0)&&(!sourceUnfiltered||rows.every(r=>sameCount(r.competitorCount,r.matchingCompetitorCount)));
 }else if(n.view==='prompts')valid=!Object.values(v.unresolvedEvidence).includes(n.groupId)&&v.totalRows<=p.coverage.eligible&&rows.every(r=>shape(r,['promptId','representativeVersionId','promptPreview','versionCount','count'])&&shape(r.count,countKeys)&&count(r.count,p.coverage.eligible)&&r.count.prompts===1&&prompt(r,r.count.executions))&&rows.reduce((sum,r)=>sum+r.count.executions,0)<=p.coverage.eligible;
 else if(n.view==='reddit_pages'){
  const trend=!v.previous.coverage.attempted?'no_previous':!v.previous.coverage.eligible||!v.current.coverage.eligible?'unavailable':v.previous.open||v.current.open?'in_progress':v.previous.coverage.eligible*10<v.previous.coverage.attempted*9||v.current.coverage.eligible*10<v.current.coverage.attempted*9?'incomplete':'ready';
  valid=!Object.values(v.unresolvedEvidence).includes(n.groupId)&&v.totalRows<=p.reddit.community.annotations&&rows.every(r=>shape(r,['id','urlId','groupedUrl','count','representative','newlyObserved'])&&hex(r.id)&&r.id===r.urlId&&prose(r.groupedUrl,20480)&&citationSafeHref(r.groupedUrl)!==null&&shape(r.count,countKeys)&&count(r.count,p.reddit.community.executions,p.reddit.community.annotations)&&r.count.annotations>0&&rep(r.representative,side,true)&&(trend==='ready'?typeof r.newlyObserved==='boolean':r.newlyObserved===null))&&rows.reduce((sum,r)=>sum+r.count.annotations,0)<=p.reddit.community.annotations;
 }else{
  if(v.page.basis!==n.evidenceMode||v.totalRows>p.coverage.eligible*100||n.evidenceMode==='gap_all'&&p.gaps.status!=='ready')return false;
  const unresolved=n.groupId===v.unresolvedEvidence.redditCommunityId?'reddit':n.groupId===v.unresolvedEvidence.shoppingLabelId?'google_shopping':n.groupId===v.unresolvedEvidence.searchQueryId?'google_search':n.groupId===v.unresolvedEvidence.googleWrapperId?'google_wrapper':null;
  const unresolvedCount=unresolved==='reddit'?p.reddit.ungrouped:unresolved==='google_shopping'?p.google.unlabelledShopping:unresolved==='google_search'?p.google.unlabelledSearch:unresolved==='google_wrapper'?p.google.wrappers:null;
  if(unresolvedCount&&(v.totalRows>unresolvedCount.annotations||n.gapPromptId===null&&v.totalRows!==unresolvedCount.annotations))return false;
  const seen=new Set<string>();valid=rows.every(r=>{
   if(!shape(r,['id','executionId','comparisonId','promptId','versionId','requestedAt','date','period','model','retainedCitationIndex','retainedUrl','retainedTitle','urlId','groupedUrl','hostname','trackable','classification'])||!shape(r.classification,['ownership','publisherCategory','automaticPublisherCategory','publisherBasis','pageType','pageTypeBasis','sourceType'])||!shape(r.classification.ownership,['brand','competitorIds','ambiguous'])||!array(r.classification.ownership.competitorIds,100)||!validCitationEvidence(r,base,{period:side,from:p.from,to:p.to,eligible:id=>eligible(id,side),competitorIds:ids,applySourceFilters:n.evidenceMode!=='gap_all'})||n.gapPromptId!==null&&r.promptId!==n.gapPromptId||n.evidenceMode==='gap_all'&&r.classification.ownership.brand)return false;
   if(unresolved&&(unresolved==='reddit'?r.hostname!=='reddit.com'&&!r.hostname?.endsWith('.reddit.com'):r.classification.sourceType!==unresolved))return false;
   const key=r.executionId.toLowerCase()+':'+r.retainedCitationIndex;if(seen.has(key))return false;seen.add(key);return true;
  });
 }
 // The HTTP reader also bounds the decoded body. Reject an oversized assembled
 // object rather than accepting individually valid strings totalling >2 MiB.
 return valid&&new TextEncoder().encode(JSON.stringify(v)).byteLength<=2*1024*1024;
}
