import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {normalizePublicHostname} from './domains.ts';
import {validText} from './keyword-research-input.ts';
import {domainScopes,domainEndpointName,parseDomainRequest,type DomainRequest,type DomainReportResult,type DomainScope} from './domain-research-input.ts';

export const backlinkReports=['backlinks_overview_v1','backlinks_profile_v1','backlinks_referring_domains_v1','backlinks_anchors_v1'] as const;
export const backlinkOrders=['rank_desc','first_seen_desc','last_seen_desc'] as const;
export const backlinkGroupOrders=['backlinks_desc','rank_desc','first_seen_desc'] as const;
const common={connectionId:z.uuid(),target:z.string().min(1).max(2048),scope:z.enum(domainScopes),status:z.enum(['live','lost','all'])};
const page={limit:z.union([z.literal(25),z.literal(50),z.literal(100)]),offset:z.number().int().min(0).max(20000),follow:z.enum(['all','dofollow','nofollow']),sourceHost:z.string().min(1).max(253).optional()};
export const backlinkRequestInput=z.discriminatedUnion('report',[
 z.object({...common,report:z.literal('backlinks_overview_v1'),limit:z.literal(1)}).strict(),
 z.object({...common,...page,report:z.literal('backlinks_profile_v1'),order:z.enum(backlinkOrders)}).strict(),
 z.object({...common,...page,report:z.literal('backlinks_referring_domains_v1'),order:z.enum(backlinkGroupOrders)}).strict(),
 z.object({...common,...page,report:z.literal('backlinks_anchors_v1'),order:z.enum(backlinkGroupOrders)}).strict()
]);
export type BacklinkRequest=z.infer<typeof backlinkRequestInput>;
export type DomainResearchRequest=DomainRequest|BacklinkRequest;
export type DomainResearchResult=DomainReportResult|BacklinkResult;
export function isBacklinkRequest(r:DomainResearchRequest):r is BacklinkRequest{return backlinkReports.some(report=>report===r.report);}
function bad():never{throw new FoundationError(400,'Choose a public backlink target, explicit scope, status and supported report fields. URL targets cannot include a query or fragment.');}
function publicUrl(value:string){
 if(!validText(value,16384)||/[\\\s]/u.test(value))bad();
 let url:URL;try{url=new URL(value);}catch{bad();}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)bad();
 try{if(normalizePublicHostname(url.hostname)!==url.hostname)bad();decodeURIComponent(url.pathname);}catch{bad();}
 return url;
}
export function backlinkTarget(value:string,scope:DomainScope){
 if(!domainScopes.includes(scope)||!validText(value,2048)||value!==value.trim())bad();
 const url=publicUrl(value.includes('://')?value:'https://'+value);
 if(url.search||url.hash||value.includes('?')||value.includes('#'))bad();
 if(scope==='domain'||scope==='subdomains'){
  if(url.pathname!=='/')bad();
  return {target:url.hostname.replace(/^www\./,''),hostname:url.hostname.replace(/^www\./,''),scope};
 }
 if(!/^https?:\/\//i.test(value))bad();
 if(scope==='subfolder'){url.pathname=url.pathname.replace(/\/+$/,'');if(url.pathname==='/')bad();}
 const target=url.href;if(Buffer.byteLength(target,'utf8')>2048)bad();
 return {target,hostname:url.hostname,scope};
}
export function parseBacklinkRequest(raw:unknown):BacklinkRequest{
 const parsed=backlinkRequestInput.safeParse(raw);if(!parsed.success)bad();const r=parsed.data;
 if(r.report!=='backlinks_overview_v1'){
  if(r.offset%r.limit!==0)bad();
  if(r.sourceHost!==undefined){try{if(normalizePublicHostname(r.sourceHost)!==r.sourceHost)bad();}catch{bad();}}
 }
 return {...r,target:backlinkTarget(r.target,r.scope).target};
}
export function parseDomainResearchRequest(raw:unknown):DomainResearchRequest{
 const report=raw&&typeof raw==='object'&&!Array.isArray(raw)?(raw as Record<string,unknown>).report:undefined;
 return backlinkReports.some(value=>value===report)?parseBacklinkRequest(raw):parseDomainRequest(raw);
}
export function domainResearchPriceMode(r:DomainResearchRequest){return isBacklinkRequest(r)?r.report==='backlinks_overview_v1'?'backlinks_summary':r.report==='backlinks_profile_v1'?'backlinks_profile':r.report==='backlinks_referring_domains_v1'?'backlinks_referring_domains':'backlinks_anchors':domainEndpointName(r);}
export function backlinkEndpointName(r:BacklinkRequest){return r.report==='backlinks_overview_v1'?'summary':r.report==='backlinks_profile_v1'?'backlinks':r.report==='backlinks_referring_domains_v1'?'referring_domains':'anchors';}
export function backlinkEndpoint(r:BacklinkRequest){return 'https://api.dataforseo.com/v3/backlinks/'+backlinkEndpointName(r)+'/live';}
export const backlinkReconcileEndpoint='https://api.dataforseo.com/v3/backlinks/id_list';
export function backlinkUrlMatches(value:string,r:BacklinkRequest){
 try{const url=publicUrl(value),t=backlinkTarget(r.target,r.scope);
  if(r.scope==='subdomains')return url.hostname===t.hostname||url.hostname.endsWith('.'+t.hostname);
  if(r.scope==='domain')return url.hostname===t.hostname;
  if(r.scope==='exact_url')return url.href===t.target;
  const target=new URL(t.target);return url.protocol===target.protocol&&url.hostname===target.hostname&&(url.pathname===target.pathname||url.pathname.startsWith(target.pathname+'/'));
 }catch{return false;}
}
export function backlinkPayload(request:BacklinkRequest,id:string):Record<string,unknown>{
 const r=parseBacklinkRequest(request),t=backlinkTarget(r.target,r.scope);if(!z.uuid().safeParse(id).success)bad();
 // OpenSEO89e5 path-boundary LIKE adaptation; fixed scheme/host and no regex.
 // Current native contracts: https://github.com/Ten98-IO-Company/ten98-discover/wiki/SEO-Research#backlink-research. No hidden extra tasks.
 const escape=(v:string)=>v.replace(/[\\%_]/g,c=>'\\'+c),folder=r.scope==='subfolder';
 const scopeFilter:unknown[]=folder?[['url_to','=',t.target],'or',['url_to','like',escape(t.target)+'/%'],'or',['url_to','like',escape(t.target)+'?%']]:r.scope==='exact_url'?['url_to','in',new URL(t.target).pathname==='/'?[t.target,t.target.slice(0,-1)]:[t.target]]:r.scope==='subdomains'?[['domain_to','=',t.hostname],'or',['domain_to','like','%.'+escape(t.hostname)]]:['domain_to','=',t.hostname];
 const base={target:folder?t.hostname.replace(/^www\./,''):t.target,include_subdomains:r.scope==='subdomains'||folder&&t.hostname.startsWith('www.'),exclude_internal_backlinks:true,backlinks_status_type:r.status,rank_scale:'one_hundred',tag:'ten98:domain:'+r.report+':'+id.toLowerCase()};
 if(r.report==='backlinks_overview_v1')return {...base,include_indirect_links:false,internal_list_limit:1,...(folder?{backlinks_filters:scopeFilter}:{})};
 const filters:unknown[]=[scopeFilter];
 if(r.follow!=='all')filters.push('and',['dofollow','=',r.follow==='dofollow']);
 if(r.sourceHost)filters.push('and',['domain_from','=',r.sourceHost]);
 if(r.report!=='backlinks_profile_v1')return {...base,include_indirect_links:false,internal_list_limit:1,limit:r.limit,offset:r.offset,order_by:[(r.order==='backlinks_desc'?'backlinks':r.order==='rank_desc'?'rank':'first_seen')+',desc',(r.report==='backlinks_referring_domains_v1'?'domain':'anchor')+',asc'],backlinks_filters:filters};
 return {...base,mode:'as_is',limit:r.limit,offset:r.offset,order_by:[(r.order==='rank_desc'?'rank':r.order==='first_seen_desc'?'first_seen':'last_seen')+',desc','url_from,asc','url_to,asc'],filters};
}
export function matchesBacklinkPayload(value:unknown,r:BacklinkRequest,id:string){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const expected=backlinkPayload(r,id),actual=value as Record<string,unknown>;
 return (r.report==='backlinks_overview_v1'||r.report==='backlinks_profile_v1'||actual.mode==null)&&Object.entries(expected).every(([key,v])=>JSON.stringify(actual[key])===JSON.stringify(v))&&['filters','backlinks_filters','search_after_token','custom_mode','include_indirect_links','internal_list_limit'].every(key=>Object.hasOwn(expected,key)||actual[key]==null);
}
export type BacklinkOverviewRow={backlinks:number|null;referringDomains:number|null;referringMainDomains:number|null;referringPages:number|null;referringIps:number|null;referringSubnets:number|null;brokenBacklinks:number|null;spamScore:number|null;rank:number|null;firstSeen:string|null;lostAt:string|null};
export type BacklinkRow={sourceUrl:string;targetUrl:string;sourceDomain:string;targetDomain:string;rank:number|null;pageRank:number|null;domainRank:number|null;spamScore:number|null;dofollow:boolean|null;isLost:boolean|null;isBroken:boolean|null;anchor:string|null;firstSeen:string|null;lastSeen:string|null;linksCount:number|null};
export type BacklinkGroupMetrics={backlinks:number|null;referringDomains:number|null;referringMainDomains:number|null;referringPages:number|null;referringPagesNofollow:number|null;referringIps:number|null;referringSubnets:number|null;brokenBacklinks:number|null;brokenPages:number|null;rank:number|null;spamScore:number|null;firstSeen:string|null;lostAt:string|null};
type BacklinkGroupPage={offset:number;limit:25|50|100;follow:'all'|'dofollow'|'nofollow';sourceHost:string|null;order:typeof backlinkGroupOrders[number]};
type BacklinkBase={source:'DataForSEO Backlinks';retrievedAt:string;target:string;scope:DomainScope;status:BacklinkRequest['status'];rankScale:'one_hundred';returnedCount:number;totalCount:number;limited:boolean};
export type BacklinkResult=BacklinkBase&({report:'backlinks_overview_v1';rows:BacklinkOverviewRow[]}|{report:'backlinks_profile_v1';offset:number;limit:25|50|100;follow:'all'|'dofollow'|'nofollow';sourceHost:string|null;order:typeof backlinkOrders[number];rows:BacklinkRow[]}|BacklinkGroupPage&({report:'backlinks_referring_domains_v1';rows:(BacklinkGroupMetrics&{domain:string})[]}|{report:'backlinks_anchors_v1';rows:(BacklinkGroupMetrics&{anchor:string})[]}));
