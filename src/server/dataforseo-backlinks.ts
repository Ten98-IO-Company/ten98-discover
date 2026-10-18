import {FoundationError} from './auth.ts';
import {dataforseoJson,dataforseoRefusal,dataforseoRefusalEvidence,dataforseoRefusalMessage} from './dataforseo-transport.ts';
import {microUsd,providerMicros,validText} from './keyword-research-input.ts';
import {normalizePublicHostname} from './domains.ts';
import {backlinkEndpoint,backlinkEndpointName,backlinkPayload,backlinkReconcileEndpoint,backlinkUrlMatches,matchesBacklinkPayload,type BacklinkRequest,type BacklinkResult,type BacklinkRow,type BacklinkGroupMetrics} from './backlink-research-input.ts';
import type {DomainOutcome} from './dataforseo-domains.ts';
type Obj=Record<string,unknown>;
const object=(v:unknown):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v);
function invalid():never{throw new Error('The backlink response could not be verified.');}
function metric(v:unknown,max=Number.MAX_SAFE_INTEGER,integer=false):number|null{if(v==null)return null;if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>max||integer&&!Number.isSafeInteger(v))invalid();return v;}
function flag(v:unknown):boolean|null{if(v==null)return null;if(typeof v!=='boolean')invalid();return v;}
function stamp(v:unknown):string|null{if(v==null)return null;if(typeof v!=='string'||v.length>40||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})? ?(?:Z|\+00:00)$/.test(v))invalid();const normalized=v.replace(' ','T').replace(' +00:00','+00:00'),d=new Date(normalized);if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,19)!==normalized.slice(0,19))invalid();return d.toISOString();}
function url(value:unknown,host:unknown){
 if(!validText(value,4096)||!validText(host,253))invalid();const u=new URL(value);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||/[\\\s]/u.test(value)||normalizePublicHostname(u.hostname)!==host)invalid();return value;
}
function row(value:unknown,r:Extract<BacklinkRequest,{report:'backlinks_profile_v1'}>):BacklinkRow{
 if(!object(value)||value.type!=='backlink')invalid();
 const sourceUrl=url(value.url_from,value.domain_from),targetUrl=url(value.url_to,value.domain_to);
 if(!backlinkUrlMatches(targetUrl,r)||r.sourceHost&&value.domain_from!==r.sourceHost)invalid();
 const dofollow=flag(value.dofollow),isLost=flag(value.is_lost);
 if(r.follow!=='all'&&dofollow!==(r.follow==='dofollow')||r.status!=='all'&&isLost!==(r.status==='lost'))invalid();
 if(value.anchor!=null&&(typeof value.anchor!=='string'||value.anchor.length>4096||value.anchor!==''&&!validText(value.anchor.replace(/[\t\r\n]/g,' '),4096)))invalid();
 return {sourceUrl,targetUrl,sourceDomain:value.domain_from as string,targetDomain:value.domain_to as string,rank:metric(value.rank,100),pageRank:metric(value.page_from_rank,100),domainRank:metric(value.domain_from_rank,100),spamScore:metric(value.backlink_spam_score,100),dofollow,isLost,isBroken:flag(value.is_broken),anchor:typeof value.anchor==='string'?value.anchor:null,firstSeen:stamp(value.first_seen),lastSeen:stamp(value.last_seen),linksCount:metric(value.links_count,Number.MAX_SAFE_INTEGER,true)};
}
export type BacklinkOutcome=Omit<DomainOutcome,'result'>&{result:BacklinkResult|null};
function groupMetrics(v:Obj):BacklinkGroupMetrics{return {backlinks:metric(v.backlinks,Number.MAX_SAFE_INTEGER,true),referringDomains:metric(v.referring_domains,Number.MAX_SAFE_INTEGER,true),referringMainDomains:metric(v.referring_main_domains,Number.MAX_SAFE_INTEGER,true),referringPages:metric(v.referring_pages,Number.MAX_SAFE_INTEGER,true),referringPagesNofollow:metric(v.referring_pages_nofollow,Number.MAX_SAFE_INTEGER,true),referringIps:metric(v.referring_ips,Number.MAX_SAFE_INTEGER,true),referringSubnets:metric(v.referring_subnets,Number.MAX_SAFE_INTEGER,true),brokenBacklinks:metric(v.broken_backlinks,Number.MAX_SAFE_INTEGER,true),brokenPages:metric(v.broken_pages,Number.MAX_SAFE_INTEGER,true),rank:metric(v.rank,100),spamScore:metric(v.backlinks_spam_score,100),firstSeen:stamp(v.first_seen),lostAt:stamp(v.lost_date)};}
const final=new Set([20000,40102,40103,40106,40501,40502,40503,40504,40505,40506]);
export function parseBacklinkOutcome(response:{httpStatus:number;body:unknown},request:BacklinkRequest,id:string,now=new Date()):BacklinkOutcome{
 const outcome:BacklinkOutcome={cost:null,reference:null,result:null,diagnostic:'The provider charge is unknown. Reconcile it before spending again.',evidence:{httpStatus:response.httpStatus,statusCode:null,taskStatus:null,reportedCost:null,taskCost:null}};
 const refused=dataforseoRefusal(response);if(refused)return {...outcome,cost:'0.000000',diagnostic:dataforseoRefusalMessage[refused],evidence:dataforseoRefusalEvidence(response)};
 try{
  const b=response.body;if(!object(b))invalid();outcome.evidence.reportedCost=b.cost;outcome.evidence.statusCode=typeof b.status_code==='number'?b.status_code:null;
  if(response.httpStatus!==200||b.status_code!==20000||b.tasks_count!==1||!Array.isArray(b.tasks)||b.tasks.length!==1||!object(b.tasks[0]))invalid();
  const task=b.tasks[0];outcome.evidence.taskCost=task.cost;outcome.evidence.taskStatus=typeof task.status_code==='number'?task.status_code:null;
  if(!validText(task.id,128)||JSON.stringify(task.path)!==JSON.stringify(['v3','backlinks',backlinkEndpointName(request),'live'])||!matchesBacklinkPayload(task.data,request,id)||typeof task.status_code!=='number'||!final.has(task.status_code)||providerMicros(b.cost)!==providerMicros(task.cost))invalid();
  outcome.reference=task.id;outcome.cost=microUsd(providerMicros(task.cost));outcome.diagnostic='The charge was recorded, but no readable result is available. A new run needs a new paid quote.';
  if(task.status_code!==20000||task.result_count!==1||!Array.isArray(task.result)||task.result.length!==1||!object(task.result[0]))invalid();
  const r=task.result[0];if(r.target!==backlinkPayload(request,id).target)invalid();
  const base={source:'DataForSEO Backlinks' as const,retrievedAt:now.toISOString(),target:request.target,scope:request.scope,status:request.status,rankScale:'one_hundred' as const};
  if(request.report==='backlinks_overview_v1'){
   const rank=metric(r.rank,100);outcome.result={...base,report:request.report,returnedCount:1,totalCount:1,limited:false,rows:[{backlinks:metric(r.backlinks,Number.MAX_SAFE_INTEGER,true),referringDomains:metric(r.referring_domains,Number.MAX_SAFE_INTEGER,true),referringMainDomains:metric(r.referring_main_domains,Number.MAX_SAFE_INTEGER,true),referringPages:metric(r.referring_pages,Number.MAX_SAFE_INTEGER,true),referringIps:metric(r.referring_ips,Number.MAX_SAFE_INTEGER,true),referringSubnets:metric(r.referring_subnets,Number.MAX_SAFE_INTEGER,true),brokenBacklinks:metric(r.broken_backlinks,Number.MAX_SAFE_INTEGER,true),spamScore:metric(r.backlinks_spam_score,100),rank:request.scope==='subfolder'?null:rank,firstSeen:stamp(r.first_seen),lostAt:stamp(r.lost_date)}]};
  }else{
   const items=r.items===null&&r.items_count===0?[]:r.items;
   if((request.report==='backlinks_profile_v1'?r.mode!=='as_is':r.mode!=null)||r.custom_mode!=null||!Number.isSafeInteger(r.total_count)||Number(r.total_count)<0||!Array.isArray(items)||items.length>request.limit||r.items_count!==items.length||items.length>Math.max(0,Number(r.total_count)-request.offset))invalid();
   const page={...base,offset:request.offset,limit:request.limit,follow:request.follow,sourceHost:request.sourceHost??null,returnedCount:items.length,totalCount:Number(r.total_count),limited:request.offset>0||Number(r.total_count)>items.length};
   if(request.report==='backlinks_profile_v1'){
    const rows=items.map(v=>row(v,request));if(new Set(rows.map(v=>v.sourceUrl)).size!==rows.length)invalid();
    outcome.result={...page,report:request.report,order:request.order,rows};
   }else if(request.report==='backlinks_referring_domains_v1'){
    const rows=items.map(v=>{if(!object(v)||v.type!=='backlinks_referring_domain'||!validText(v.domain,253)||normalizePublicHostname(v.domain)!==v.domain)invalid();return {...groupMetrics(v),domain:v.domain};});
    if(new Set(rows.map(v=>v.domain)).size!==rows.length)invalid();outcome.result={...page,report:request.report,order:request.order,rows};
   }else{
    const rows=items.map(v=>{if(!object(v)||v.type!=='backlinks_anchor'||typeof v.anchor!=='string'||v.anchor.length>4096||v.anchor!==''&&!validText(v.anchor.replace(/[\t\r\n]/g,' '),4096))invalid();return {...groupMetrics(v),anchor:v.anchor};});
    if(new Set(rows.map(v=>v.anchor)).size!==rows.length)invalid();outcome.result={...page,report:request.report,order:request.order,rows};
   }
  }
  if(Buffer.byteLength(JSON.stringify(outcome.result),'utf8')>2097152)invalid();outcome.diagnostic=null;
 }catch{outcome.result=null;/* Verified financial evidence survives unusable content. */}
 return outcome;
}
export async function requestBacklinkResearch(credentials:unknown,request:BacklinkRequest,id:string,send:typeof fetch=fetch):Promise<BacklinkOutcome>{
 try{return parseBacklinkOutcome(await dataforseoJson(backlinkEndpoint(request),credentials,'POST',[backlinkPayload(request,id)],send),request,id);}catch{return {cost:null,reference:null,result:null,diagnostic:'The request may have reached the provider. Its charge is unknown; reconcile it before spending again.',evidence:{httpStatus:null,statusCode:null,taskStatus:null,reportedCost:null,taskCost:null}};}
}
export function parseBacklinkReconciliation(response:{httpStatus:number;body:unknown},request:BacklinkRequest,id:string){
 const b=response.body;if(response.httpStatus!==200||!object(b)||b.status_code!==20000||providerMicros(b.cost)!==0n||b.tasks_count!==1||!Array.isArray(b.tasks)||b.tasks.length!==1||!object(b.tasks[0]))invalid();
 const task=b.tasks[0];if(task.status_code!==20000||providerMicros(task.cost)!==0n||!Array.isArray(task.result)||task.result.length>=1000)invalid();
 const matches=task.result.filter(v=>object(v)&&v.url==='v3/backlinks/'+backlinkEndpointName(request)+'/live'&&matchesBacklinkPayload(v.metadata,request,id));
 if(matches.length!==1||!object(matches[0])||!validText(matches[0].id,128)||typeof matches[0].status!=='string'||!/^\d{5}$/.test(matches[0].status)||!final.has(Number(matches[0].status)))invalid();
 return {reference:matches[0].id,cost:microUsd(providerMicros(matches[0].cost)),statusCode:Number(matches[0].status)};
}
export async function reconcileBacklinkCharge(credentials:unknown,request:BacklinkRequest,id:string,dispatchedAt:Date,send:typeof fetch=fetch){
 if(!Number.isFinite(dispatchedAt.getTime())||Date.now()-dispatchedAt.getTime()>28*86400000)throw new FoundationError(409,'The provider charge lookup window expired. Review the recorded receipt.');
 const stamp=(date:Date)=>date.toISOString().replace('T',' ').slice(0,19)+' +00:00';
 try{return parseBacklinkReconciliation(await dataforseoJson(backlinkReconcileEndpoint,credentials,'POST',[{datetime_from:stamp(new Date(dispatchedAt.getTime()-60000)),datetime_to:stamp(new Date(Math.min(Date.now(),dispatchedAt.getTime()+120000))),limit:1000,offset:0,sort:'asc',include_metadata:true}],send),request,id);}catch{throw new FoundationError(409,'The charge could not be matched uniquely. The charge remains unresolved; do not repeat the paid request.');}
}
