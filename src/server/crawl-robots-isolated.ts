import {performance} from 'node:perf_hooks';
import {runCrawlParser} from './crawl-analysis-isolated.ts';
import {ROBOTS_MAX_BYTES,ROBOTS_MAX_MATCH_WORK,type RobotsDecision} from './crawl-robots.ts';

export type CrawlRobotsInput={robotsUrl:string;body:Uint8Array;productToken:string;targetUrls:string[];maxCrawlDelaySeconds?:number};
export type CrawlRobotsEvaluation={
  digest:string;policyStatus:'ready'|'unavailable';reason:string|null;origin:string|null;
  sitemaps:string[];crawlDelaySeconds:number|null;decisions:RobotsDecision[];
};
export type IsolatedRobotsResult={status:'ok';evaluation:CrawlRobotsEvaluation}|{status:'invalid_input'|'timeout'|'aborted'|'child_error'};
const keys=new Set(['robotsUrl','body','productToken','targetUrls','maxCrawlDelaySeconds']);
const boundedUrl=(value:unknown)=>typeof value==='string'&&value.length<=2048&&Buffer.byteLength(value)<=2048;

/** Batches at most100 decisions; raw policy/URL values never become logs or executable arguments. */
export async function evaluateCrawlRobotsIsolated(input:CrawlRobotsInput,signal?:AbortSignal):Promise<IsolatedRobotsResult> {
  const started=performance.now();
  if(signal?.aborted)return {status:'aborted'};
  let payload:Buffer;
  try{
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.has(key))||
      !boundedUrl(input.robotsUrl)||!(input.body instanceof Uint8Array)||input.body.byteLength>ROBOTS_MAX_BYTES||
      typeof input.productToken!=='string'||input.productToken.length>128||
      !Array.isArray(input.targetUrls)||input.targetUrls.length<1||input.targetUrls.length>100||!input.targetUrls.every(boundedUrl)||
      input.maxCrawlDelaySeconds!==undefined&&(!Number.isFinite(input.maxCrawlDelaySeconds)||input.maxCrawlDelaySeconds<0))return {status:'invalid_input'};
    payload=Buffer.from(JSON.stringify({operation:'robots',robotsUrl:input.robotsUrl,bodyBase64:Buffer.from(input.body).toString('base64'),
      productToken:input.productToken,targetUrls:[...input.targetUrls],maxCrawlDelaySeconds:input.maxCrawlDelaySeconds??0}));
  }catch{return {status:'invalid_input'};}
  const count=input.targetUrls.length;
  return runCrawlParser(payload,started,signal,value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const envelope=value as Record<string,unknown>;
    if(envelope.status==='invalid_input'&&Object.keys(envelope).length===1)return {status:'invalid_input'};
    if(envelope.status!=='ok'||Object.keys(envelope).length!==2)return null;
    const e=envelope.evaluation as CrawlRobotsEvaluation|undefined;
    const reason=(s:unknown)=>typeof s==='string'&&/^[a-z0-9_]{1,80}$/u.test(s);
    const delay=(n:unknown)=>n===null||typeof n==='number'&&Number.isFinite(n)&&n>=0;
    if(!e||typeof e!=='object'||!/^[a-f0-9]{64}$/u.test(e.digest)||!['ready','unavailable'].includes(e.policyStatus)||
      !(e.reason===null||reason(e.reason))||!(e.origin===null||boundedUrl(e.origin))||!delay(e.crawlDelaySeconds)||
      !Array.isArray(e.sitemaps)||e.sitemaps.length>100||!e.sitemaps.every(boundedUrl)||
      !Array.isArray(e.decisions)||e.decisions.length!==count||e.decisions.some(d=>!d||!['allowed','disallowed','unavailable'].includes(d.status)||
        !reason(d.reason)||!delay(d.crawlDelaySeconds)||!Number.isSafeInteger(d.work)||d.work<0||d.work>ROBOTS_MAX_MATCH_WORK||
        !(d.matchedLine===null||Number.isSafeInteger(d.matchedLine)&&d.matchedLine>0&&d.matchedLine<=ROBOTS_MAX_BYTES)))return null;
    if(e.policyStatus==='unavailable'&&(e.reason===null||e.origin!==null||e.sitemaps.length||e.decisions.some(d=>d.status!=='unavailable')))return null;
    if(e.policyStatus==='ready'&&(e.reason!==null||e.origin===null))return null;
    return {status:'ok',evaluation:e};
  });
}
