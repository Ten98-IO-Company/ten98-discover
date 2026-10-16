import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {normalizePublicHostname} from './domains.ts';
import {validText} from './keyword-research-input.ts';

export const domainScopes=['subdomains','domain','subfolder','exact_url'] as const;
export type DomainScope=typeof domainScopes[number];
export type DomainTarget={target:string;hostname:string;path:string;scope:DomainScope};
export const domainRankedEndpoint='https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live';
export const domainRequestInput=z.object({connectionId:z.uuid(),target:z.string().min(1).max(2048),scope:z.enum(domainScopes),locationCode:z.number().int().min(1).max(2147483647),languageCode:z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),limit:z.union([z.literal(25),z.literal(50),z.literal(100)])}).strict();
export type DomainRequest=z.infer<typeof domainRequestInput>;
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
export function domainPayload(request:DomainRequest,id:string){
 const r=parseDomainRequest(request),t=domainTarget(r.target,r.scope);if(!z.uuid().safeParse(id).success)bad();
 const escape=(v:string)=>v.replace(/[\\%_]/g,c=>'\\'+c);
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
