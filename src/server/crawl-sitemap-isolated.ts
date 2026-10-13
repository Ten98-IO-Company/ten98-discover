import {performance} from 'node:perf_hooks';
import {runCrawlParser} from './crawl-analysis-isolated.ts';
import {sitemapLimits,type SitemapAnalysis} from './crawl-sitemap.ts';

export const crawlSitemapCapacityBytes=5*1024*1024;
export type CrawlSitemapInput={documentUrl:string;body:Uint8Array};
export type IsolatedSitemapResult={status:'ok';analysis:SitemapAnalysis}|{status:'invalid_input'|'timeout'|'aborted'|'child_error'};
const reasons=new Set(['invalid_document_url','invalid_xml','unsupported_xml_declaration','doctype_forbidden','element_limit','depth_limit','name_limit','attribute_limit','attribute_value_limit','unsupported_format','entry_limit','invalid_structure','invalid_entry','foreign_origin','outside_document_directory','retained_url_limit','input_error','invalid_chunk','body_limit','invalid_utf8']);
const text=(s:unknown)=>typeof s==='string'&&s.length<=sitemapLimits.urlBytes&&Buffer.byteLength(s)<=sitemapLimits.urlBytes;

/** Only complete supplied bodies enter the disposable parser; output never grants fetch authority. */
export async function parseCrawlSitemapIsolated(input:CrawlSitemapInput,signal?:AbortSignal):Promise<IsolatedSitemapResult> {
  const started=performance.now();
  if(signal?.aborted)return {status:'aborted'};
  let payload:Buffer,bodyBytes:number;
  try{
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='documentUrl'&&key!=='body')||
      !text(input.documentUrl)||!(input.body instanceof Uint8Array)||input.body.byteLength>crawlSitemapCapacityBytes)return {status:'invalid_input'};
    bodyBytes=input.body.byteLength;
    payload=Buffer.from(JSON.stringify({operation:'sitemap',documentUrl:input.documentUrl,bodyBase64:Buffer.from(input.body).toString('base64')}));
  }catch{return {status:'invalid_input'};}
  return runCrawlParser(payload,started,signal,value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const envelope=value as Record<string,unknown>;
    if(envelope.status==='invalid_input'&&Object.keys(envelope).length===1)return {status:'invalid_input'};
    if(envelope.status!=='ok'||Object.keys(envelope).length!==2)return null;
    const a=envelope.analysis as SitemapAnalysis|undefined;
    const count=(n:unknown,max:number)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=max;
    if(!a||typeof a!=='object'||!['complete','partial','unavailable'].includes(a.status)||!Array.isArray(a.reasons)||a.reasons.length>reasons.size||
      a.reasons.some(r=>!reasons.has(r))||new Set(a.reasons).size!==a.reasons.length||
      ![null,'urlset','sitemapindex'].includes(a.kind)||!count(a.bytesRead,bodyBytes)||typeof a.entriesComplete!=='boolean'||
      !Array.isArray(a.entries)||a.entries.length>sitemapLimits.entries||!a.counts||typeof a.counts!=='object'||
      Object.keys(a.counts).length!==5||![a.counts.seen,a.counts.accepted,a.counts.invalid,a.counts.omitted,a.counts.foreignOrigin].every(n=>count(n,sitemapLimits.entries)))return null;
    const c=a.counts;
    if(c.seen!==c.accepted+c.invalid||c.omitted>c.accepted||c.foreignOrigin>c.accepted||a.entries.length!==c.accepted-c.omitted)return null;
    let retained=0;
    for(const entry of a.entries){
      if(!entry||typeof entry!=='object'||!text(entry.url)||Object.keys(entry).length!==1)return null;
      const u=new URL(entry.url);
      if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.hash||u.href!==entry.url||/[\u0000-\u0020\u007f\\]/u.test(entry.url)||/%(?![a-f0-9]{2})/iu.test(entry.url))return null;
      retained+=Buffer.byteLength(entry.url);if(retained>sitemapLimits.retainedUrlBytes)return null;
    }
    if(a.status==='unavailable'){
      if(a.kind!==null||a.reasons.length!==1||a.entriesComplete||Object.values(c).some(Boolean))return null;
    }else{
      if(a.kind===null||a.bytesRead!==bodyBytes||a.entriesComplete!==(c.invalid===0&&c.omitted===0&&!a.reasons.includes('invalid_structure')))return null;
      if(a.status==='complete'?(a.reasons.length!==0||!a.entriesComplete||c.foreignOrigin!==0):a.reasons.length===0)return null;
    }
    return {status:'ok',analysis:a};
  });
}
