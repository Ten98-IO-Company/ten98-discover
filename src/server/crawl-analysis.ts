import {createHash} from 'node:crypto';
import {toUSVString} from 'node:util';
import {parse, type DefaultTreeAdapterTypes as Html} from 'parse5';

export const crawlAnalysisLimits=Object.freeze({htmlBytes:1048576,headerBytes:16384,urlBytes:2048,nodes:20000,depth:128,links:1000,images:1000,headings:1000,annotations:100,text:2048});
export const crawlRuleVersion='static-html-v1';
export type CrawlPageInput={
  url:string; status:number|null; fetchState:'ok'|'blocked'|'rate_limited'|'error'|'robots_disallowed'|'not_fetched';
  contentType:string|null; html:string|null; bodyComplete:boolean; responseTimeMs:number|null; crawlDepth:number|null;
  linkHeaders?:string[]; xRobotsTags?:string[];
};
const severities={
  'blocked-page':'critical','rate-limited-page':'warning','server-error':'critical','broken-page':'warning',
  'slow-response':'info','noindex-page':'info','canonical-conflict':'warning','canonicalized-page':'info','deep-page':'info',
  'javascript-rendering-suspected':'warning','missing-title':'critical','title-too-long':'info','title-too-short':'info',
  'missing-meta-description':'warning','meta-description-too-long':'info','meta-description-too-short':'info',
  'missing-h1':'warning','multiple-h1':'warning','heading-order-skip':'info','thin-content':'warning','images-missing-alt':'warning','no-outgoing-links':'warning',
} as const;
export type CrawlFinding={code:keyof typeof severities;severity:'critical'|'warning'|'info';details:Record<string,number>};
export type CrawlCoverage='unavailable'|'blocked'|'rate_limited'|'robots_disallowed'|'not_fetched'|'http_error'|'redirect'|'non_html'|'partial'|'shell'|'analyzed';
type Link={url:string;anchor:string;internal:boolean;nofollow:boolean};
export type CrawlEvidence={
  title:string;description:string;htmlCanonicals:string[];headerCanonicals:string[];robotsMeta:string[];xRobotsTags:string[];
  headings:string[];images:{src:string|null;alt:string|null}[];links:Link[];
  openGraph:{title:string|null;description:string|null;image:string|null};hreflang:{language:string;url:string}[];
};
export type CrawlFacts={
  titleLength:number;titleHash:string|null;descriptionLength:number;descriptionHash:string|null;
  headingCounts:number[];headingOrder:number[];wordCount:number;contentHash:string|null;
  imagesTotal:number;imagesMissingAlt:number;linksTotal:number;internalLinks:number;externalLinks:number;unresolvedLinks:number;
  structuredDataPresent:boolean;hreflangCount:number;indexability:'noindex_observed'|'no_noindex_observed'|'unknown';
  canonical:'none'|'self'|'other'|'conflict'|'invalid';invalidCanonicals:number;
};
export type CrawlAnalysis={ruleVersion:typeof crawlRuleVersion;coverage:CrawlCoverage;reasons:string[];facts:CrawlFacts|null;evidence:CrawlEvidence|null;findings:CrawlFinding[]};
const namespace='http://www.w3.org/1999/xhtml';
const omitted=new Set(['script','style','noscript','template','svg','math']);
const blocks=new Set('address article aside blockquote br dd div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table td th tr ul'.split(' '));
const goodText=(s:string)=>toUSVString(s)===s&&!s.includes('\0');
const normalizeText=(s:string)=>s.replace(/\s+/gu,' ').trim();
const clip=(s:string,max:number=crawlAnalysisLimits.text)=>Array.from(s).slice(0,max).join('');
const hash=(s:string)=>s?createHash('sha256').update(s).digest('hex'):null;
const attr=(node:Html.Element,name:string)=>node.attrs.find(a=>a.name===name&&!a.namespace)?.value;
const tokens=(value:string)=>value.toLowerCase().trim().split(/\s+/u).filter(Boolean);
const executable=(n:Html.Element)=>n.tagName==='script'&&['','module','text/javascript','application/javascript'].includes(attr(n,'type')?.trim().toLowerCase()??'');

/** Analysis only: successful normalization never authorizes a network request. */
function resolvedUrl(raw:string,base?:string):string|null {
  if(!goodText(raw)||Buffer.byteLength(raw)>crawlAnalysisLimits.urlBytes||/[\u0000-\u0020\u007f\\]/u.test(raw))return null;
  try{const url=new URL(raw,base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||Buffer.byteLength(url.href)>crawlAnalysisLimits.urlBytes)return null;url.hash='';return url.href;}catch{return null;}
}
/** Split only outside quoted strings and <URI> values; commas inside Link targets are data. */
function splitHeader(value:string,separator:string):string[]|null {
  const parts:string[]=[];let start=0,quoted=false,angle=false,escaped=false;
  for(let i=0;i<value.length;i++){
    const c=value[i];if(escaped){escaped=false;continue;}if(quoted&&c==='\\'){escaped=true;continue;}
    if(c==='"'&&!angle)quoted=!quoted;else if(!quoted&&c==='<'){if(angle)return null;angle=true;}else if(!quoted&&c==='>'){if(!angle)return null;angle=false;}
    else if(c===separator&&!quoted&&!angle){parts.push(value.slice(start,i).trim());start=i+1;}
  }
  if(quoted||angle||escaped)return null;parts.push(value.slice(start).trim());return parts;
}
function canonicalMention(value:string):boolean {
  const relation=/(?:^|;)\s*rel\s*=\s*"?([^;"]*)/iu.exec(value)?.[1];
  return relation!==undefined&&tokens(relation).includes('canonical');
}
function headerCanonicals(headers:string[],base:string):{urls:string[];invalid:number} {
  const urls=new Set<string>();let invalid=0;
  for(const header of headers){
    const entries=splitHeader(header,',');if(!entries){if(canonicalMention(header))invalid++;continue;}
    for(const entry of entries){
      const pieces=splitHeader(entry,';'),target=pieces?.shift()?.match(/^<([^<>]*)>$/u);
      if(!pieces||!target){if(canonicalMention(entry))invalid++;continue;}
      let rel:string|undefined,anchored=false,bad=false;
      for(const piece of pieces){
        const match=/^([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s";,]+))$/u.exec(piece);
        if(!match){if(/^[!#$%&'*+.^_`|~\w-]+$/u.test(piece))continue;bad=true;continue;}const name=match[1].toLowerCase(),value=match[2]?.replace(/\\(.)/gu,'$1')??match[3];
        if(name==='rel'){if(rel!==undefined){bad=true;break;}rel=value;}
        if(name==='anchor')anchored=true;
      }
      if(bad){if(rel&&tokens(rel).includes('canonical')||canonicalMention(entry))invalid++;continue;}if(!rel||!tokens(rel).includes('canonical')||anchored)continue;
      const url=target[1]?resolvedUrl(target[1],base):null;if(url)urls.add(url);else invalid++;
    }
  }
  return {urls:[...urls],invalid};
}
function noindex(meta:string[],headers:string[]):boolean {
  if(meta.some(s=>s.toLowerCase().split(/[\s,]+/u).some(s=>s==='noindex'||s==='none')))return true;
  for(const header of headers){
    let applies=true;
    for(let value of header.split(',')){
      const scoped=/^\s*([a-z][a-z0-9_-]*)\s*:\s*(.*)$/iu.exec(value);
      if(scoped){if(scoped[1].toLowerCase()==='unavailable_after')continue;applies=scoped[1].toLowerCase()==='googlebot';value=scoped[2];}
      if(applies&&value.toLowerCase().trim().split(/\s+/u).some(s=>s==='noindex'||s==='none'))return true;
    }
  }
  return false;
}

/** Pure extraction; live untrusted input requires a separate deadline/heap-limited parser process.
 * DOM limits apply after parse5 builds its tree. Evidence is raw, short-lived text, not a durable DTO. */
export function analyzeCrawlPage(input:CrawlPageInput):CrawlAnalysis {
  const url=resolvedUrl(input.url);
  if(!url||!['ok','blocked','rate_limited','error','robots_disallowed','not_fetched'].includes(input.fetchState)||
    input.status!==null&&(!Number.isInteger(input.status)||input.status<200||input.status>599)||
    input.responseTimeMs!==null&&(!Number.isFinite(input.responseTimeMs)||input.responseTimeMs<0)||
    input.crawlDepth!==null&&(!Number.isSafeInteger(input.crawlDepth)||input.crawlDepth<0)||typeof input.bodyComplete!=='boolean')throw new TypeError('Invalid crawl observation.');
  const out:CrawlAnalysis={ruleVersion:crawlRuleVersion,coverage:'unavailable',reasons:[],facts:null,evidence:null,findings:[]};
  const issue=(code:CrawlFinding['code'],details:Record<string,number>={})=>out.findings.push({code,severity:severities[code],details});
  if(input.fetchState!=='ok'){
    out.coverage=input.fetchState==='error'?'unavailable':input.fetchState;
    if(input.fetchState==='blocked')issue('blocked-page',input.status===null?{}:{status:input.status});
    if(input.fetchState==='rate_limited')issue('rate-limited-page',input.status===null?{}:{status:input.status});
    return out;
  }
  if(input.status===null)return out;
  if(input.status===429){out.coverage='rate_limited';issue('rate-limited-page',{status:429});return out;}
  if(input.status>=400){out.coverage='http_error';issue(input.status>=500?'server-error':'broken-page',{status:input.status});return out;}
  if(input.status>=300){out.coverage=[301,302,303,307,308].includes(input.status)?'redirect':'unavailable';if(out.coverage==='unavailable')out.reasons.push('unsupported_response_status');return out;}
  if(input.status===204||input.status===205){out.coverage='non_html';out.reasons.push('no_content_status');return out;}
  if(input.status===206){out.coverage='partial';out.reasons.push('partial_response_status');return out;}
  if(input.responseTimeMs!==null&&input.responseTimeMs>1500)issue('slow-response',{responseTimeMs:input.responseTimeMs});
  // Missing/ambiguous MIME does not establish that this was an HTML document.
  if(input.contentType===null){out.reasons.push('content_type_unavailable');return out;}
  if(typeof input.contentType!=='string'||!goodText(input.contentType)||/[\r\n]/u.test(input.contentType)||input.contentType.length>1024){out.reasons.push('content_type_invalid');return out;}
  if(input.contentType.split(';',1)[0].trim().toLowerCase()!=='text/html'){out.coverage='non_html';return out;}
  if(!input.bodyComplete||input.html===null){out.coverage='partial';out.reasons.push('body_incomplete');return out;}
  if(typeof input.html!=='string'||!goodText(input.html)){out.coverage='partial';out.reasons.push('invalid_text');return out;}
  if(Buffer.byteLength(input.html)>crawlAnalysisLimits.htmlBytes){out.coverage='partial';out.reasons.push('html_limit');return out;}
  const linkHeaders=input.linkHeaders??[],robotHeaders=input.xRobotsTags??[];
  if(!Array.isArray(linkHeaders)||!Array.isArray(robotHeaders)||linkHeaders.length+robotHeaders.length>100||
    [...linkHeaders,...robotHeaders].some(h=>typeof h!=='string'||!goodText(h)||/[\r\n]/u.test(h))||
    [...linkHeaders,...robotHeaders].reduce((n,h)=>n+Buffer.byteLength(h),0)>crawlAnalysisLimits.headerBytes){out.coverage='partial';out.reasons.push('header_invalid_or_limit');return out;}
  const doc=parse(input.html,{scriptingEnabled:true});
  const nodes:Html.Element[]=[];const stack:{node:Html.Node;depth:number}[]=[{node:doc,depth:0}];let count=0;
  // ponytail: bounded DOM for one <=1 MiB page; use a streaming tokenizer if measured worker memory requires it.
  while(stack.length){const {node,depth}=stack.pop()!;
    if(++count>crawlAnalysisLimits.nodes||depth>crawlAnalysisLimits.depth){out.coverage='partial';out.reasons.push('tree_limit');return out;}
    if('tagName' in node&&node.namespaceURI===namespace)nodes.push(node);
    if('childNodes' in node)for(let i=node.childNodes.length-1;i>=0;i--)stack.push({node:node.childNodes[i],depth:depth+1});
  }
  const head=nodes.find(n=>n.tagName==='head'),body=nodes.find(n=>n.tagName==='body');
  if(!head||!body){out.coverage='partial';out.reasons.push('body_unavailable');return out;}
  function inside(node:Html.Element,parent:Html.Element){for(let p:Html.ParentNode|null=node.parentNode;p&&'parentNode' in p;p=p.parentNode)if(p===parent)return true;return false;}
  function excluded(node:Html.Element){if(attr(node,'hidden')!==undefined||attr(node,'aria-hidden')?.toLowerCase()==='true')return true;for(let p:Html.ParentNode|null=node.parentNode;p&&'tagName' in p;p=p.parentNode)if(omitted.has(p.tagName)||attr(p,'hidden')!==undefined||attr(p,'aria-hidden')?.toLowerCase()==='true')return true;return false;}
  function text(node:Html.Node):string {
    const pieces:string[]=[];const pending:(Html.Node|string)[]=[node];
    while(pending.length){const n=pending.pop()!;
      if(typeof n==='string'){pieces.push(n);continue;}
      if('value' in n){pieces.push(n.value);continue;}
      if('tagName' in n&&(omitted.has(n.tagName)||attr(n,'hidden')!==undefined||attr(n,'aria-hidden')?.toLowerCase()==='true'))continue;
      if('tagName' in n&&blocks.has(n.tagName)){pieces.push(' ');pending.push(' ');}
      if('childNodes' in n)for(let i=n.childNodes.length-1;i>=0;i--)pending.push(n.childNodes[i]);
    }return normalizeText(pieces.join(''));
  }
  const headNodes=nodes.filter(n=>inside(n,head)&&!excluded(n));
  const baseNode=headNodes.find(n=>n.tagName==='base'&&attr(n,'href')!==undefined);
  const base=baseNode?resolvedUrl(attr(baseNode,'href')!.trim(),url):url;
  if(base===null){out.coverage='partial';out.reasons.push('base_url_invalid');return out;}
  const effectiveBase=base??url;
  const title=text(headNodes.find(n=>n.tagName==='title')??{nodeName:'#text',value:'',parentNode:null});
  const description=headNodes.find(n=>n.tagName==='meta'&&attr(n,'name')?.toLowerCase()==='description');
  const descriptionText=normalizeText(description?attr(description,'content')??'':'');
  const evidence:CrawlEvidence={title:clip(title),description:clip(descriptionText),htmlCanonicals:[],headerCanonicals:[],robotsMeta:[],xRobotsTags:robotHeaders.map(h=>clip(h)),headings:[],images:[],links:[],openGraph:{title:null,description:null,image:null},hreflang:[]};
  const canonicals=new Set<string>();let invalidCanonicals=0,annotations=0;
  for(const n of headNodes){
    if(n.tagName==='meta'){
      const name=attr(n,'name')?.toLowerCase();if(name==='robots'||name==='googlebot')evidence.robotsMeta.push(clip(attr(n,'content')??''));
      const property=attr(n,'property')?.toLowerCase(),value=attr(n,'content');
      if(property==='og:title'&&value!==undefined)evidence.openGraph.title??=clip(value);
      if(property==='og:description'&&value!==undefined)evidence.openGraph.description??=clip(value);
      if(property==='og:image'&&value?.trim())evidence.openGraph.image??=resolvedUrl(value.trim(),effectiveBase);
    }
    if(n.tagName==='link'){
      const rel=tokens(attr(n,'rel')??'');
      if(rel.includes('canonical')){const target=resolvedUrl((attr(n,'href')??'').trim(),effectiveBase);if(target&&attr(n,'href')?.trim()&&base!==null)canonicals.add(target);else invalidCanonicals++;}
      if(rel.includes('alternate')&&attr(n,'hreflang')){const target=resolvedUrl((attr(n,'href')??'').trim(),effectiveBase);if(target&&attr(n,'href')?.trim()&&base!==null)evidence.hreflang.push({language:clip(attr(n,'hreflang')!,100),url:target});}
    }
    if(n.tagName==='meta'||n.tagName==='link')annotations++;
  }
  if(annotations>crawlAnalysisLimits.annotations){out.coverage='partial';out.reasons.push('annotation_limit');return out;}
  const headerCanonical=headerCanonicals(linkHeaders,url);invalidCanonicals+=headerCanonical.invalid;
  evidence.htmlCanonicals=[...canonicals];evidence.headerCanonicals=headerCanonical.urls;
  const allCanonical=new Set([...evidence.htmlCanonicals,...evidence.headerCanonicals]);
  const canonical:CrawlFacts['canonical']=allCanonical.size>1?'conflict':invalidCanonicals?'invalid':allCanonical.size===0?'none':allCanonical.has(url)?'self':'other';
  const headingCounts=[0,0,0,0,0,0],headingOrder:number[]=[],links=new Map<string,Link>();
  let imagesTotal=0,imagesMissingAlt=0,unresolvedLinks=0,structuredDataPresent=false,appRoot=false,executableScript=false;
  const bodyNodes=nodes.filter(n=>inside(n,body)&&!excluded(n));
  for(const n of nodes){if(n.tagName==='script'&&attr(n,'type')?.toLowerCase()==='application/ld+json')structuredDataPresent=true;}
  for(const n of bodyNodes){
    if(['root','app','__next','__nuxt'].includes(attr(n,'id')??''))appRoot=true;
    if(executable(n))executableScript=true;
    if(/^h[1-6]$/u.test(n.tagName)){const level=Number(n.tagName[1]);headingCounts[level-1]++;headingOrder.push(level);if(evidence.headings.length<crawlAnalysisLimits.headings)evidence.headings.push(clip(text(n)));}
    if(n.tagName==='img'){
      imagesTotal++;const alt=attr(n,'alt');if(alt===undefined)imagesMissingAlt++;
      if(evidence.images.length<crawlAnalysisLimits.images)evidence.images.push({src:attr(n,'src')?.trim()?resolvedUrl(attr(n,'src')!.trim(),effectiveBase):null,alt:alt===undefined?null:clip(alt)});
    }
    if(n.tagName==='a'&&attr(n,'href')?.trim()&&!attr(n,'href')!.trim().startsWith('#')){
      const raw=attr(n,'href')!.trim(),target=resolvedUrl(raw,effectiveBase);
      if(!target){try{if(['http:','https:'].includes(new URL(raw,effectiveBase).protocol))unresolvedLinks++;}catch{unresolvedLinks++;}continue;}
      if(!links.has(target)&&links.size<=crawlAnalysisLimits.links)links.set(target,{url:target,anchor:clip(text(n),200),internal:new URL(target).origin===new URL(url).origin,nofollow:tokens(attr(n,'rel')??'').includes('nofollow')});
    }
  }
  // Scripts in <head> also bootstrap otherwise empty SPA roots.
  executableScript ||= headNodes.some(executable);
  if(links.size>crawlAnalysisLimits.links||imagesTotal>crawlAnalysisLimits.images||headingOrder.length>crawlAnalysisLimits.headings){out.coverage='partial';out.reasons.push('extraction_limit');return out;}
  evidence.links=[...links.values()];
  const content=text(body),wordCount=content?content.split(' ').length:0;
  const shell=appRoot&&executableScript&&wordCount<20&&headingOrder.length===0&&links.size===0&&imagesTotal===0;
  // Evaluate directives before clipping their evidence; a long valid header/meta must not lose a final noindex.
  const robotMeta=headNodes.filter(n=>n.tagName==='meta'&&['robots','googlebot'].includes(attr(n,'name')?.toLowerCase()??'')).map(n=>attr(n,'content')??'');
  const blockedIndex=noindex(robotMeta,robotHeaders);
  out.facts={titleLength:title.length,titleHash:hash(title),descriptionLength:descriptionText.length,descriptionHash:hash(descriptionText),headingCounts,headingOrder,wordCount,contentHash:hash(content),imagesTotal,imagesMissingAlt,linksTotal:links.size,internalLinks:evidence.links.filter(l=>l.internal).length,externalLinks:evidence.links.filter(l=>!l.internal).length,unresolvedLinks,structuredDataPresent,hreflangCount:evidence.hreflang.length,indexability:blockedIndex?'noindex_observed':shell?'unknown':'no_noindex_observed',canonical,invalidCanonicals};
  out.evidence=evidence;out.coverage=shell?'shell':'analyzed';
  if(blockedIndex)issue('noindex-page');
  if(canonical==='conflict')issue('canonical-conflict');
  if(canonical==='other')issue('canonicalized-page');
  if(input.crawlDepth!==null&&input.crawlDepth>=5)issue('deep-page',{depth:input.crawlDepth});
  if(shell){issue('javascript-rendering-suspected',{wordCount});return out;}
  if(!title)issue('missing-title');else if(title.length>60)issue('title-too-long',{length:title.length});else if(title.length<10)issue('title-too-short',{length:title.length});
  if(!descriptionText)issue('missing-meta-description');else if(descriptionText.length>160)issue('meta-description-too-long',{length:descriptionText.length});else if(descriptionText.length<70)issue('meta-description-too-short',{length:descriptionText.length});
  if(headingCounts[0]===0)issue('missing-h1');else if(headingCounts[0]>1)issue('multiple-h1',{count:headingCounts[0]});
  if(headingOrder.some((level,i)=>i>0&&level>headingOrder[i-1]+1))issue('heading-order-skip');
  if(!blockedIndex&&wordCount<150)issue('thin-content',{wordCount});
  if(imagesMissingAlt>0)issue('images-missing-alt',{missing:imagesMissingAlt,total:imagesTotal});
  if(!blockedIndex&&links.size===0&&unresolvedLinks===0&&base!==null)issue('no-outgoing-links');
  return out;
}
