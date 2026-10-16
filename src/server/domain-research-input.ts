import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {normalizePublicHostname} from './domains.ts';
import {validText} from './keyword-research-input.ts';

export const domainScopes=['subdomains','domain','subfolder','exact_url'] as const;
export type DomainScope=typeof domainScopes[number];
export type DomainTarget={target:string;hostname:string;path:string;scope:DomainScope};
export const domainRankedEndpoint='https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live';
export const domainReports=['overview_v1','pages_v1','competitors_v1'] as const;
export type DomainReport=typeof domainReports[number];
export const domainRequestInput=z.object({connectionId:z.uuid(),target:z.string().min(1).max(2048),scope:z.enum(domainScopes),locationCode:z.number().int().min(1).max(2147483647),languageCode:z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),limit:z.union([z.literal(1),z.literal(25),z.literal(50),z.literal(100)]),report:z.enum(domainReports).optional()}).strict();
export type DomainRequest=z.infer<typeof domainRequestInput>;
export function domainEndpointName(request:DomainRequest){return request.report==='overview_v1'?'domain_rank_overview':request.report==='pages_v1'?'relevant_pages':request.report==='competitors_v1'?'competitors_domain':'ranked_keywords';}
export function domainEndpoint(request:DomainRequest){return 'https://api.dataforseo.com/v3/dataforseo_labs/google/'+domainEndpointName(request)+'/live';}
function bad():never{throw new FoundationError(400,'Choose a public domain or URL, scope, supported market and result limit.');}
export function domainTarget(value:string,scope:DomainScope):DomainTarget{
 if(!domainScopes.includes(scope)||!validText(value,2048)||value!==value.trim()||/[\\\s]/u.test(value))bad();
 let url:URL;try{url=new URL(value.includes('://')?value:'https://'+value);}catch{bad();}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port)bad();
 let hostname:string;try{hostname=normalizePublicHostname(url.hostname).replace(/^www\./,'');}catch{bad();}
 const path=url.pathname.replace(/\/+$/,'')||'/';
 if(scope==='subfolder'&&path==='/')bad();
 // OpenSEO89e5 scope identity ignores query/fragment; expose that choice before quoting.
 const target=scope==='domain'||scope==='subdomains'?hostname:'https://'+hostname+path;
 if(Buffer.byteLength(target,'utf8')>2048)bad();
 return {target,hostname,path:scope==='domain'||scope==='subdomains'?'/':path,scope};
}
export function parseDomainRequest(raw:unknown):DomainRequest{
 const value=domainRequestInput.safeParse(raw);if(!value.success)bad();
 if((value.data.report==='overview_v1')!==(value.data.limit===1))bad();
 if((value.data.report==='overview_v1'||value.data.report==='competitors_v1')&&value.data.scope!=='subdomains')throw new FoundationError(400,'Overview and competitor reports cover the domain and its subdomains. Choose that scope explicitly; narrower reports are not available.');
 return {...value.data,target:domainTarget(value.data.target,value.data.scope).target};
}
export function domainUrlMatches(value:string,target:DomainTarget){
 try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)return false;
  const host=normalizePublicHostname(url.hostname).replace(/^www\./,'');
  if(target.scope==='subdomains')return host===target.hostname||host.endsWith('.'+target.hostname);
  if(host!==target.hostname)return false;
  const path=url.pathname.replace(/\/+$/,'')||'/';
  return target.scope==='domain'||target.scope==='exact_url'&&path===target.path||target.scope==='subfolder'&&(path===target.path||path.startsWith(target.path+'/'));
 }catch{return false;}
}
export function domainPayload(request:DomainRequest,id:string):Record<string,unknown>{
 const r=parseDomainRequest(request),t=domainTarget(r.target,r.scope);if(!z.uuid().safeParse(id).success)bad();
 const escape=(v:string)=>v.replace(/[\\%_]/g,c=>'\\'+c);
 // Fixed versioned profiles: see docs/domain-research.md for the provider contracts.
 const common={target:t.hostname,location_code:r.locationCode,language_code:r.languageCode,limit:r.limit,offset:0,tag:'ten98:domain:'+r.report+':'+id.toLowerCase()};
 if(r.report==='overview_v1')return {...common,ignore_synonyms:false};
 if(r.report==='competitors_v1')return {...common,item_types:['organic'],include_clickstream_data:false,ignore_synonyms:false,max_rank_group:100,exclude_top_domains:false,exclude_domains:[t.hostname,'www.'+t.hostname],order_by:['intersections,desc','domain,asc']};
 if(r.report==='pages_v1'){
  // OpenSEO89e5 researchScopeFilters adaptation (MIT, Ben Senescu); see notices.
  // LIKE avoids the provider's URL-regex restriction. At most eight conditions,
  // including query variants; every returned URL is checked again independently.
  const patterns=[t.hostname,'www.'+t.hostname].flatMap(host=>{const base='%://'+escape(host),path=escape(t.path);return t.scope==='domain'?[base,base+'?%',base+'/%']:t.scope==='subfolder'?[base+path,base+path+'/%',base+path+'?%']:t.path==='/'?[base,base+'/',base+'?%',base+'/?%']:[base+path,base+path+'/',base+path+'?%',base+path+'/?%'];});
  const filters=t.scope==='subdomains'?undefined:patterns.flatMap<unknown>((pattern,i)=>i?['or',['page_address','like',pattern]]:[['page_address','like',pattern]]);
  return {...common,item_types:['organic'],include_clickstream_data:false,historical_serp_mode:'live',ignore_synonyms:false,order_by:['metrics.organic.etv,desc','page_address,asc'],...(filters?{filters}:{})};
 }
 const host=['ranked_serp_element.serp_item.domain','in',[t.hostname,'www.'+t.hostname]],field='ranked_serp_element.serp_item.relative_url',path=escape(t.path);
 const filters=t.scope==='subdomains'?undefined:t.scope==='domain'?host:[host,'and',t.scope==='subfolder'?[[field,'=',t.path],'or',[field,'like',path+'/%'],'or',[field,'like',path+'?%']]:[[field,'in',[t.path,t.path==='/'?'/':t.path+'/']],'or',[field,'like',path+'?%'],'or',[field,'like',(t.path==='/'?'':path)+'/?%']]];
 return {target:t.hostname,location_code:r.locationCode,language_code:r.languageCode,limit:r.limit,offset:0,item_types:['organic'],historical_serp_mode:'live',include_clickstream_data:false,load_rank_absolute:true,order_by:['ranked_serp_element.serp_item.etv,desc','keyword_data.keyword,asc'],...(filters?{filters}:{}),tag:'ten98:domain:'+id.toLowerCase()};
}
export function matchesDomainPayload(value:unknown,request:DomainRequest,id:string){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const expected=domainPayload(request,id),actual=value as Record<string,unknown>;
 return Object.entries(expected).every(([key,v])=>JSON.stringify(actual[key])===JSON.stringify(v))&&(!Object.hasOwn(expected,'filters')?actual.filters==null:true);
}
export type DomainRow={keyword:string;position:number|null;searchVolume:number|null;estimatedTraffic:number|null;cpcUsd:string|null;keywordDifficulty:number|null;url:string;metricsUpdatedAt:string|null};
export type DomainResult={source:'DataForSEO Labs / Google';retrievedAt:string;target:string;scope:DomainScope;locationCode:number;languageCode:string;rows:DomainRow[];returnedCount:number;totalCount:number;limited:boolean};
// These are provider estimates. Null never means zero; no rating is derived here.
export type DomainOrganicMetrics={rankedKeywords:number|null;estimatedTraffic:number|null;estimatedAdsValueUsd:number|null;rankDistribution:(number|null)[]};
export type DomainPageRow={url:string;organic:DomainOrganicMetrics};
export type DomainCompetitorRow={domain:string;sharedKeywords:number|null;averagePosition:number|null;fullDomain:DomainOrganicMetrics;targetOverlap:DomainOrganicMetrics};
type ReportBase=Omit<DomainResult,'rows'>;
export type DomainReportResult=DomainResult&{report?:never}|ReportBase&({report:'overview_v1';rows:DomainOrganicMetrics[]}|{report:'pages_v1';rows:DomainPageRow[]}|{report:'competitors_v1';rows:DomainCompetitorRow[]});
