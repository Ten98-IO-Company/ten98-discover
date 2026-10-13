import {MIMEType} from 'node:util';
import {inspectCrawlCharset,type CrawlAnalysis,type CrawlEvidence,type CrawlPageInput} from './crawl-analysis.ts';
import {analyzeCrawlPageIsolated} from './crawl-analysis-isolated.ts';
import {evaluateCrawlRobotsIsolated,type CrawlRobotsEvaluation} from './crawl-robots-isolated.ts';
import {parseCrawlSitemapIsolated} from './crawl-sitemap-isolated.ts';
import type {SitemapAnalysis} from './crawl-sitemap.ts';
import type {CrawlDocumentKind,CrawlDocumentObservation,CrawlDownloadReason} from './crawl-network.ts';

export const auditEvidenceLimit=65536;
export type AuditEvidence=Omit<CrawlEvidence,'links'>;
export type AuditPreparationInput={url:string;download:CrawlDocumentObservation}&(
  {kind:'html';crawlDepth:number|null}|{kind:'robots';policyOrigin:string}|{kind:'sitemap'});
export type PreparedAuditObservation=
  |{status:'prepared';kind:'html';fetchState:CrawlPageInput['fetchState'];analysis:Omit<CrawlAnalysis,'evidence'>;evidence:AuditEvidence|null;evidenceBytes:number;evidenceTruncated:boolean;links:CrawlEvidence['links']}
  |{status:'prepared';kind:'robots';evaluation:CrawlRobotsEvaluation}
  |{status:'prepared';kind:'sitemap';analysis:SitemapAnalysis}
  |{status:'unavailable';kind:CrawlDocumentKind;reason:CrawlDownloadReason|'challenge_observed'|'invalid_charset'|'unsupported_charset'|'invalid_utf8'|'parser_invalid_input'|'parser_timeout'|'parser_aborted'|'parser_child_error'};

// jsonb::text adds one space per structural colon/comma. String contents are not separators.
function storedBytes(value:unknown):number {
  const json=JSON.stringify(value);let spaces=0,quoted=false,escaped=false;
  for(const char of json){if(escaped){escaped=false;continue;}if(quoted&&char==='\\'){escaped=true;continue;}if(char==='"')quoted=!quoted;else if(!quoted&&(char===':'||char===','))spaces++;}
  return Buffer.byteLength(json)+spaces;
}
function boundedEvidence(source:CrawlEvidence|null):{evidence:AuditEvidence|null;evidenceBytes:number;evidenceTruncated:boolean;links:CrawlEvidence['links']} {
  if(!source)return {evidence:null,evidenceBytes:0,evidenceTruncated:false,links:[]};
  const evidence:AuditEvidence={title:source.title,description:source.description,htmlCanonicals:[],headerCanonicals:[],robotsMeta:[],xRobotsTags:[],headings:[],images:[],openGraph:{title:null,description:null,image:null},hreflang:[]};
  let evidenceBytes=storedBytes(evidence),evidenceTruncated=false;
  // Isolated parser limits guarantee the two prioritized text fields fit with the fixed object shape.
  if(evidenceBytes>auditEvidenceLimit)throw new Error('Invalid bounded parser evidence.');
  const graphBytes=storedBytes(source.openGraph)-storedBytes(evidence.openGraph);
  if(evidenceBytes+graphBytes<=auditEvidenceLimit){evidence.openGraph=source.openGraph;evidenceBytes+=graphBytes;}else evidenceTruncated=true;
  for(const key of ['htmlCanonicals','headerCanonicals','robotsMeta','xRobotsTags','headings','images','hreflang'] as const){
    const target=evidence[key] as unknown[];
    for(const item of source[key]){
      const bytes=storedBytes(item)+(target.length?2:0);
      if(evidenceBytes+bytes>auditEvidenceLimit){evidenceTruncated=true;continue;}
      target.push(item);evidenceBytes+=bytes;
    }
  }
  return {evidence,evidenceBytes,evidenceTruncated,links:source.links};
}
function mime(value:string|null):string|null {try{return value===null?null:new MIMEType(value).essence;}catch{return null;}}

/** No admission/robots authority here. All markup parsing uses the fixed isolated child and worker-root cwd. */
export async function prepareAuditObservation(input:AuditPreparationInput,signal?:AbortSignal):Promise<PreparedAuditObservation> {
  const {kind,download}=input;
  const unavailable=(reason:Extract<PreparedAuditObservation,{status:'unavailable'}>['reason']):PreparedAuditObservation=>({status:'unavailable',kind,reason});
  if(signal?.aborted)return unavailable('parser_aborted');
  const status=download.status,challenge=download.headers.challenge;
  if(kind!=='html'){
    if(status===429)return unavailable('http_status');
    if(challenge)return unavailable('challenge_observed');
    if(!download.complete)return unavailable(download.reason);
    if(status===null||status<200||status>=300||status===204||status===205||status===206)return unavailable('http_status');
  }
  const parseHtml=kind==='html';
  const statusOnly=challenge||status===null||status===401||status===403||status===407||status===429||status>=300||status===204||status===205||status===206;
  let html:string|null=null;
  if(download.complete&&!statusOnly){
    const charset=inspectCrawlCharset(download.headers.contentType);
    if(charset==='invalid'||charset==='unsupported')return unavailable(charset==='invalid'?'invalid_charset':'unsupported_charset');
    if(parseHtml){try{html=new TextDecoder('utf-8',{fatal:true}).decode(download.body);}catch{return unavailable('invalid_utf8');}}
  }
  if(parseHtml){
    const fetchState:CrawlPageInput['fetchState']=status===429?'rate_limited':challenge||status===401||status===403||status===407||download.reason==='blocked'?'blocked':
      download.complete||status!==null&&(status>=300||[204,205,206].includes(status))||download.reason==='unsupported_mime'||download.reason==='expanded_limit'||download.reason==='wire_limit'||download.reason==='partial_response'||download.reason==='incomplete_body'?'ok':'error';
    const parsed=await analyzeCrawlPageIsolated({url:input.url,status,fetchState,contentType:statusOnly?null:download.headers.contentType,
      html,bodyComplete:download.complete,responseTimeMs:download.headersMs,crawlDepth:input.crawlDepth,linkHeaders:statusOnly?[]:download.headers.link,xRobotsTags:statusOnly?[]:download.headers.xRobotsTag},signal);
    if(parsed.status!=='ok')return unavailable(`parser_${parsed.status}`);
    if(challenge&&status!==429)parsed.analysis.reasons.push('challenge_observed');
    else if(!download.complete&&!statusOnly)parsed.analysis.reasons.push(download.reason);
    const {evidence,...analysis}=parsed.analysis;
    return {status:'prepared',kind:'html',fetchState,analysis,...boundedEvidence(evidence)};
  }
  // The status/complete checks above establish a complete byte buffer. MIME is observation, never authority.
  if(!download.complete)return unavailable(download.reason);
  const essence=mime(download.headers.contentType);
  if(kind==='robots'){
    if(essence!==null&&essence!=='text/plain')return unavailable('unsupported_mime');
    const parsed=await evaluateCrawlRobotsIsolated({robotsUrl:input.policyOrigin+'/robots.txt',body:download.body,productToken:'TenMonitorBot',targetUrls:[input.policyOrigin+'/robots.txt'],maxCrawlDelaySeconds:1800},signal);
    return parsed.status==='ok'?{status:'prepared',kind,evaluation:parsed.evaluation}:unavailable(`parser_${parsed.status}`);
  }
  if(essence!==null&&!['application/xml','text/xml','application/octet-stream','application/gzip','application/x-gzip'].includes(essence)&&!essence.endsWith('+xml'))return unavailable('unsupported_mime');
  const parsed=await parseCrawlSitemapIsolated({documentUrl:input.url,body:download.body},signal);
  return parsed.status==='ok'?{status:'prepared',kind,analysis:parsed.analysis}:unavailable(`parser_${parsed.status}`);
}
