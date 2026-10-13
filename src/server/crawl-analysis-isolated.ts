import childProcess from 'node:child_process';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {crawlAnalysisLimits,crawlRuleVersion,type CrawlAnalysis,type CrawlPageInput} from './crawl-analysis.ts';

export const crawlParserLimits=Object.freeze({inputBytes:7*1024*1024,outputBytes:12*1024*1024,stderrBytes:8192,deadlineMs:2000,heapMiB:64});
export type IsolatedCrawlResult={status:'ok';analysis:CrawlAnalysis}|{status:'invalid_input'|'timeout'|'aborted'|'child_error'};
const fields=new Set(['url','status','fetchState','contentType','html','bodyComplete','responseTimeMs','crawlDepth','linkHeaders','xRobotsTags']);
function encode(input:CrawlPageInput):Buffer|null {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.has(key)))return null;
  const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max&&Buffer.byteLength(value)<=max;
  if(!text(input.url,crawlAnalysisLimits.urlBytes)||
    input.status!==null&&(!Number.isInteger(input.status)||input.status<200||input.status>599)||
    !['ok','blocked','rate_limited','error','robots_disallowed','not_fetched'].includes(input.fetchState)||
    input.contentType!==null&&!text(input.contentType,1024)||input.html!==null&&!text(input.html,crawlAnalysisLimits.htmlBytes)||
    typeof input.bodyComplete!=='boolean'||input.responseTimeMs!==null&&(!Number.isFinite(input.responseTimeMs)||input.responseTimeMs<0)||
    input.crawlDepth!==null&&(!Number.isSafeInteger(input.crawlDepth)||input.crawlDepth<0))return null;
  const linkHeaders=input.linkHeaders??[],xRobotsTags=input.xRobotsTags??[];
  if(!Array.isArray(linkHeaders)||!Array.isArray(xRobotsTags)||linkHeaders.length+xRobotsTags.length>100)return null;
  let bytes=0;
  for(const value of [...linkHeaders,...xRobotsTags]){if(!text(value,crawlAnalysisLimits.headerBytes))return null;bytes+=Buffer.byteLength(value);}
  if(bytes>crawlAnalysisLimits.headerBytes)return null;
  // Never stringify the caller's object, its toJSON method, or unknown fields.
  const buffer=Buffer.from(JSON.stringify({url:input.url,status:input.status,fetchState:input.fetchState,contentType:input.contentType,html:input.html,
    bodyComplete:input.bodyComplete,responseTimeMs:input.responseTimeMs,crawlDepth:input.crawlDepth,linkHeaders:[...linkHeaders],xRobotsTags:[...xRobotsTags]}));
  return buffer.length<=crawlParserLimits.inputBytes?buffer:null;
}
function result(value:unknown):IsolatedCrawlResult|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const envelope=value as Record<string,unknown>;
  if(envelope.status==='invalid_input'&&Object.keys(envelope).length===1)return {status:'invalid_input'};
  if(envelope.status!=='ok'||Object.keys(envelope).length!==2)return null;
  const analysis=envelope.analysis as CrawlAnalysis|undefined;
  if(!analysis||analysis.ruleVersion!==crawlRuleVersion||
    !['unavailable','blocked','rate_limited','robots_disallowed','not_fetched','http_error','redirect','non_html','partial','shell','analyzed'].includes(analysis.coverage)||
    !Array.isArray(analysis.reasons)||analysis.reasons.length>10||analysis.reasons.some(reason=>typeof reason!=='string'||!/^[a-z_]{1,80}$/u.test(reason))||
    !Array.isArray(analysis.findings)||analysis.findings.length>30||
    analysis.findings.some(f=>!f||typeof f.code!=='string'||!/^[a-z-]{1,80}$/u.test(f.code)||!['critical','warning','info'].includes(f.severity)||!f.details||typeof f.details!=='object'||Array.isArray(f.details)||Object.values(f.details).some(n=>typeof n!=='number'||!Number.isFinite(n)))||
    analysis.facts!==null&&(!analysis.facts||typeof analysis.facts!=='object'||Array.isArray(analysis.facts))||
    analysis.evidence!==null&&(!analysis.evidence||typeof analysis.evidence!=='object'||Array.isArray(analysis.evidence)))return null;
  if(['analyzed','shell'].includes(analysis.coverage)?!analysis.facts||!analysis.evidence:analysis.facts!==null||analysis.evidence!==null)return null;
  if(analysis.facts&&analysis.evidence){
    const f=analysis.facts,e=analysis.evidence;
    const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
    const text=(s:unknown,max=4096)=>typeof s==='string'&&s.length<=max;
    const hash=(s:unknown)=>s===null||typeof s==='string'&&/^[a-f0-9]{64}$/u.test(s);
    const list=(items:unknown,max:number,check:(item:any)=>boolean)=>Array.isArray(items)&&items.length<=max&&items.every(check);
    if(![f.titleLength,f.descriptionLength,f.wordCount,f.imagesTotal,f.imagesMissingAlt,f.linksTotal,f.internalLinks,f.externalLinks,f.unresolvedLinks,f.hreflangCount,f.invalidCanonicals].every(count)||
      !hash(f.titleHash)||!hash(f.descriptionHash)||!hash(f.contentHash)||typeof f.structuredDataPresent!=='boolean'||
      !['noindex_observed','no_noindex_observed','unknown'].includes(f.indexability)||!['none','self','other','conflict','invalid'].includes(f.canonical)||
      !list(f.headingCounts,6,count)||f.headingCounts.length!==6||!list(f.headingOrder,1000,n=>count(n)&&n>=1&&n<=6)||
      !text(e.title)||!text(e.description)||!list(e.htmlCanonicals,100,s=>text(s,2048))||!list(e.headerCanonicals,crawlAnalysisLimits.headerBytes,s=>text(s,2048))||
      !list(e.robotsMeta,100,s=>text(s))||!list(e.xRobotsTags,100,s=>text(s))||!list(e.headings,1000,s=>text(s))||
      !list(e.images,1000,i=>!!i&&typeof i==='object'&&(i.src===null||text(i.src,2048))&&(i.alt===null||text(i.alt)))||
      !list(e.links,1000,l=>!!l&&typeof l==='object'&&text(l.url,2048)&&text(l.anchor,400)&&typeof l.internal==='boolean'&&typeof l.nofollow==='boolean')||
      !list(e.hreflang,100,h=>!!h&&typeof h==='object'&&text(h.language,200)&&text(h.url,2048))||
      !e.openGraph||typeof e.openGraph!=='object'||![e.openGraph.title,e.openGraph.description,e.openGraph.image].every(s=>s===null||text(s)))return null;
  }
  return {status:'ok',analysis};
}

/** App-root cwd is the existing worker/CLI convention. No caller-selectable executable or entry point. */
export async function analyzeCrawlPageIsolated(input:CrawlPageInput,signal?:AbortSignal):Promise<IsolatedCrawlResult> {
  const started=performance.now();
  if(signal?.aborted)return {status:'aborted'};
  let payload:Buffer|null;
  try{payload=encode(input);}catch{return {status:'invalid_input'};}
  if(!payload)return {status:'invalid_input'};
  if(performance.now()-started>=crawlParserLimits.deadlineMs)return {status:'timeout'};
  const env:NodeJS.ProcessEnv={NODE_ENV:'production',TZ:'UTC'};
  // Node's Windows runtime may need the operating-system directory; no PATH, HOME, NODE_OPTIONS or app configuration.
  if(process.platform==='win32'&&process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
  return new Promise(resolveResult=>{
    let child:ReturnType<typeof childProcess.spawn>;
    try{child=childProcess.spawn(process.execPath,['--max-old-space-size=64',resolve(process.cwd(),'src/server/crawl-analysis-child.ts')],{
      cwd:process.cwd(),env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,
    });}catch{resolveResult({status:'child_error'});return;}
    let failure:Exclude<IsolatedCrawlResult['status'],'ok'>|null=null,closed=false,outputBytes=0,stderrBytes=0;
    const output:Buffer[]=[];
    const stop=(status:Exclude<IsolatedCrawlResult['status'],'ok'>)=>{
      if(closed)return;failure??=status;output.length=0;child.stdin?.destroy();
      // This fixed child cannot spawn descendants. Never look up or kill any unrelated PID/process group.
      try{child.kill('SIGKILL');}catch{/* The close/error event is still authoritative. */}
    };
    const abort=()=>stop('aborted');
    const timer=setTimeout(()=>stop('timeout'),Math.max(1,crawlParserLimits.deadlineMs-(performance.now()-started)));
    signal?.addEventListener('abort',abort,{once:true});
    child.once('error',()=>stop('child_error'));
    child.stdin?.on('error',()=>stop('child_error'));
    child.stdout?.on('error',()=>stop('child_error'));
    child.stderr?.on('error',()=>stop('child_error'));
    child.stdout?.on('data',(chunk:Buffer)=>{
      if(failure)return;outputBytes+=chunk.length;
      if(outputBytes>crawlParserLimits.outputBytes){stop('child_error');return;}output.push(chunk);
    });
    // Drain but never retain, log or return stderr: fatal errors can contain source or input fragments.
    child.stderr?.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>crawlParserLimits.stderrBytes)stop('child_error');});
    child.once('close',(code,exitSignal)=>{
      closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
      if(failure){resolveResult({status:failure});return;}
      if(signal?.aborted){resolveResult({status:'aborted'});return;}
      if(performance.now()-started>=crawlParserLimits.deadlineMs){resolveResult({status:'timeout'});return;}
      if(code!==0||exitSignal){resolveResult({status:'child_error'});return;}
      try{
        const parsed=result(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(output,outputBytes))));
        resolveResult(performance.now()-started>=crawlParserLimits.deadlineMs?{status:'timeout'}:parsed??{status:'child_error'});
      }catch{resolveResult({status:'child_error'});}
    });
    if(signal?.aborted)abort();else child.stdin!.end(payload);
  });
}
