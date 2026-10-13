import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import childProcess from 'node:child_process';
import {prepareAuditObservation,auditEvidenceLimit} from '../src/server/site-audit-observation.ts';
import {analyzeCrawlPage,inspectCrawlCharset,type CrawlPageInput} from '../src/server/crawl-analysis.ts';
import type {CrawlDocumentObservation,CrawlResponseHeaders,CrawlDownloadReason} from '../src/server/crawl-network.ts';

const url='https://example.com/';
const headers=(contentType:string|null='text/html; charset=utf-8'):CrawlResponseHeaders=>({contentType,contentEncoding:null,location:null,retryAfter:null,challenge:false,link:[],xRobotsTag:[]});
function complete(body:string|Buffer,contentType:string|null='text/html; charset=utf-8'):CrawlDocumentObservation {
  const bytes=Buffer.isBuffer(body)?body:Buffer.from(body);
  return {status:200,headers:headers(contentType),wireBytes:bytes.length,httpDecodedBytes:bytes.length,decodedBytes:bytes.length,dnsMs:2,headersMs:20,durationMs:30,complete:true,body:bytes,reason:null};
}
function incomplete(status:number|null,reason:CrawlDownloadReason):CrawlDocumentObservation {
  return {...complete(''),status,complete:false,body:null,reason};
}
const prepare=(download:CrawlDocumentObservation,signal?:AbortSignal)=>prepareAuditObservation({kind:'html',url,download,crawlDepth:0},signal);
const page=(html:string,contentType='text/html'):CrawlPageInput=>({url,status:200,fetchState:'ok',contentType,html,bodyComplete:true,responseTimeMs:20,crawlDepth:0});

// Independent recursive count of jsonb's structural spaces; punctuation inside evidence text does not count.
function jsonbBytes(value:unknown):number {
  function spaces(item:unknown):number {
    if(Array.isArray(item))return Math.max(0,item.length-1)+item.reduce((sum,v)=>sum+spaces(v),0);
    if(item&&typeof item==='object'){const values=Object.values(item);return values.length+Math.max(0,values.length-1)+values.reduce<number>((sum,v)=>sum+spaces(v),0);}
    return 0;
  }
  return Buffer.byteLength(JSON.stringify(value))+spaces(value);
}

test('HTML preparation uses isolated facts, keeps links separate and does not grant URL scope',async()=>{
  const download=complete('<title>A useful title</title><meta name="description" content="A complete description"><h1>Hello</h1><a href="https://other.com/a?secret=x#f">Other</a>');
  const result=await prepare(download);assert.equal(result.status,'prepared');
  if(result.status!=='prepared'||result.kind!=='html')return;
  assert.equal(result.fetchState,'ok');assert.equal(result.analysis.coverage,'analyzed');assert.equal(result.evidence?.title,'A useful title');
  assert.equal(result.links[0].url,'https://other.com/a?secret=x');assert.equal(result.links[0].internal,false);
  assert.equal('evidence' in result.analysis,false);assert.equal('links' in result.evidence!,false);
  assert.equal(result.evidenceBytes,jsonbBytes(result.evidence));assert.equal(result.evidenceTruncated,false);
  assert.equal('body' in result,false);assert.equal('html' in result,false);
});

test('HTML URL discovery cannot normalize away raw authority or percent rejection before admission',async()=>{
  const html='<title>Discovery</title><h1>Links</h1>'+['https://@example.com/empty-user','//user@example.com/private','https:example.com/repair','https://%65xample.com/encoded-host','/path%FF','/path%5c'].map(href=>`<a href="${href}">Bad</a>`).join('')+'<a href="/A%2fb%3Fc">Valid reserved path</a>';
  const result=await prepare(complete(html));assert.equal(result.status,'prepared');
  if(result.status==='prepared'&&result.kind==='html'){assert.deepEqual(result.links.map(link=>link.url),[url+'A%2fb%3Fc']);assert.equal(result.analysis.facts?.unresolvedLinks,6);}
});

test('explicit challenge and HTTP status outrank charset/body problems without missing-content findings',async()=>{
  for(const [status,coverage,fetchState] of [[401,'blocked','blocked'],[403,'blocked','blocked'],[407,'blocked','blocked'],[429,'rate_limited','rate_limited'],[404,'http_error','ok'],[503,'http_error','ok'],[302,'redirect','ok']] as const){
    const download=incomplete(status,status===302?'redirect':'http_status');download.headers.contentType='text/html; charset=windows-1252';
    const result=await prepare(download);assert.equal(result.status,'prepared');
    if(result.status!=='prepared'||result.kind!=='html')continue;
    assert.equal(result.analysis.coverage,coverage);assert.equal(result.fetchState,fetchState);assert.equal(result.analysis.facts,null);assert.equal(result.evidence,null);
    assert.equal(result.analysis.findings.some(f=>f.code.startsWith('missing-')||f.code==='thin-content'),false);
  }
  const challenged=complete(Buffer.from([0xff]),'text/html; charset=iso-8859-1');challenged.headers.challenge=true;challenged.headers.link=Array(101).fill('bad');challenged.headers.contentType='text/html; '+ 'x'.repeat(1500);
  const result=await prepare(challenged);assert.equal(result.status,'prepared');
  if(result.status==='prepared'&&result.kind==='html'){assert.equal(result.fetchState,'blocked');assert.equal(result.analysis.coverage,'blocked');assert.deepEqual(result.analysis.reasons,['challenge_observed']);assert.equal(result.analysis.facts,null);}
  const rateLimited=await prepare({...challenged,status:429});assert.equal(rateLimited.status,'prepared');
  if(rateLimited.status==='prepared'&&rateLimited.kind==='html'){assert.equal(rateLimited.fetchState,'rate_limited');assert.equal(rateLimited.analysis.coverage,'rate_limited');assert.deepEqual(rateLimited.analysis.reasons,[]);}
  for(const kind of ['robots','sitemap'] as const){const input=kind==='robots'?{kind,url,download:challenged,policyOrigin:url.slice(0,-1)}:{kind,url,download:challenged};assert.deepEqual(await prepareAuditObservation(input),{status:'unavailable',kind,reason:'challenge_observed'});}
});

test('HTTP charset validation rejects ambiguity and unsupported decoding; UTF-8 BOM is never a conflicting-declaration override',async()=>{
  for(const value of ['text/html; charset=utf-8','text/html; charset="UTF-8"','text/html; charset=utf8','text/html; charset="unicode-1-1-utf-8"'])assert.equal(inspectCrawlCharset(value),'utf8');
  for(const value of ['text/html; charset=','text/html; charset="','text/html; charset=utf-8; charset=utf-8','not-a-type'])assert.equal(inspectCrawlCharset(value),'invalid');
  for(const value of ['text/html; charset=windows-1252','text/html; charset=utf-16','text/html; charset=us-ascii'])assert.equal(inspectCrawlCharset(value),'unsupported');
  assert.equal(inspectCrawlCharset('text/html; note="a;charset=windows-1252"'),'absent');
  for(const body of [Buffer.from([0xc3,0x28]),Buffer.from([0xff,0xfe,0x3c,0])])assert.deepEqual(await prepare(complete(body)),{status:'unavailable',kind:'html',reason:'invalid_utf8'});
  const bom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('<title>UTF8 title</title><h1>Page</h1>')]);
  assert.equal((await prepare(complete(bom))).status,'prepared');
  assert.deepEqual(await prepare(complete(bom,'text/html; charset=windows-1252')),{status:'unavailable',kind:'html',reason:'unsupported_charset'});
});

test('real DOM charset declarations suppress content findings; comments and script lookalikes do not',async()=>{
  for(const meta of ['<meta charset="windows-1252">','<meta charset="UTF-16" hidden>','<meta http-equiv="content-type" content="text/html; charset=shift_jis">','<meta charset="utf-8"><meta charset="iso-8859-1">']){
    const analysis=analyzeCrawlPage(page(meta+'<title>A title</title><h1>Page</h1>'));assert.equal(analysis.coverage,'partial');assert.equal(analysis.facts,null);assert.deepEqual(analysis.reasons,['unsupported_charset']);assert.equal(analysis.findings.some(f=>f.code.startsWith('missing-')),false);
  }
  const unsafe=await prepare(complete('<title>Title</title><body><meta charset="windows-1252"><h1>Page</h1>'));assert.equal(unsafe.status,'prepared');
  if(unsafe.status==='prepared'&&unsafe.kind==='html'){assert.equal(unsafe.analysis.coverage,'partial');assert.equal(unsafe.analysis.facts,null);}
  const harmless=`<meta charset="UTF-8"><!-- <meta charset="windows-1252"> --><script>const example = '<meta charset="utf-16">';</script><title>UTF8 title</title><h1>Page</h1>`;
  const result=await prepare(complete(harmless));assert.equal(result.status,'prepared');if(result.status==='prepared'&&result.kind==='html')assert.equal(result.analysis.coverage,'analyzed');
});

test('bounded evidence fits jsonb storage, prioritizes title/description, retains whole items and leaves links separate',async()=>{
  const title='Priority title : , \\ "',description='Priority description : , \\ "',heading='😀:;,\\"'.repeat(80);
  const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
  const html=`<title>${escape(title)}</title><meta name="description" content="${escape(description)}"><h1>Main</h1>`+Array.from({length:120},()=>`<h2>${escape(heading)}</h2>`).join('')+'<a href="/next">Next</a>';
  const result=await prepare(complete(html));assert.equal(result.status,'prepared');
  if(result.status!=='prepared'||result.kind!=='html')return;
  assert.equal(result.analysis.coverage,'analyzed');assert.equal(result.evidence?.title,title);assert.equal(result.evidence?.description,description);
  assert.equal(result.evidenceTruncated,true);assert.ok(result.evidenceBytes<=auditEvidenceLimit);assert.equal(result.evidenceBytes,jsonbBytes(result.evidence));
  assert.ok(result.evidence!.headings.length>1&&result.evidence!.headings.length<121);assert.ok(result.evidence!.headings.slice(1).every(h=>h===heading));
  assert.equal(result.analysis.facts?.headingCounts[1],120);assert.equal(result.links.length,1);assert.equal(result.links[0].url,url+'next');
});

test('incomplete, non-HTML, shell and narrow challenge observations never become invented empty content',async()=>{
  const partial=await prepare(incomplete(200,'incomplete_body'));assert.equal(partial.status,'prepared');if(partial.status==='prepared'&&partial.kind==='html'){assert.equal(partial.analysis.coverage,'partial');assert.equal(partial.analysis.facts,null);assert.ok(partial.analysis.reasons.includes('incomplete_body'));}
  const pdf=incomplete(200,'unsupported_mime');pdf.headers.contentType='application/pdf';const nonHtml=await prepare(pdf);assert.equal(nonHtml.status,'prepared');if(nonHtml.status==='prepared'&&nonHtml.kind==='html')assert.equal(nonHtml.analysis.coverage,'non_html');
  for(const [html,coverage] of [['<div id="root"></div><script src="/app.js"></script>','shell'],['<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>','unavailable']] as const){
    const result=await prepare(complete(html));assert.equal(result.status,'prepared');if(result.status==='prepared'&&result.kind==='html'){assert.equal(result.analysis.coverage,coverage);assert.equal(result.analysis.findings.some(f=>f.code.startsWith('missing-')||f.code==='thin-content'),false);}
  }
});

test('robots keeps the original policy origin and exposes delay/sitemaps without authorizing pages',async()=>{
  const download=complete('User-agent: TenMonitorBot\nDisallow: /private\nCrawl-delay: 2\nSitemap: https://other.com/sitemap.xml\n','text/plain; charset=utf-8');
  const result=await prepareAuditObservation({kind:'robots',url:'https://other.com/redirected.txt',policyOrigin:'https://example.com',download});
  assert.equal(result.status,'prepared');if(result.status!=='prepared'||result.kind!=='robots')return;
  assert.equal(result.evaluation.origin,'https://example.com');assert.equal(result.evaluation.crawlDelaySeconds,2);assert.deepEqual(result.evaluation.sitemaps,['https://other.com/sitemap.xml']);
  assert.equal(result.evaluation.decisions.length,1);assert.equal(result.evaluation.decisions[0].reason,'implicit_robots');
  const html=await prepareAuditObservation({kind:'robots',url:url+'robots.txt',policyOrigin:url.slice(0,-1),download:complete('<title>Unavailable</title>')});assert.deepEqual(html,{status:'unavailable',kind:'robots',reason:'unsupported_mime'});
  for(const status of [404,410])assert.deepEqual(await prepareAuditObservation({kind:'robots',url:url+'robots.txt',policyOrigin:url.slice(0,-1),download:incomplete(status,'http_status')}),{status:'unavailable',kind:'robots',reason:'http_status'});
});

test('sitemaps use the isolated XML parser; failed tails and unsupported XML encodings yield no entries',async()=>{
  const xml='<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a?x=1</loc></url></urlset>';
  const input={kind:'sitemap' as const,url:url+'sitemap.xml',download:complete(xml,'application/xml')};
  const result=await prepareAuditObservation(input);assert.equal(result.status,'prepared');if(result.status==='prepared'&&result.kind==='sitemap'){assert.equal(result.analysis.status,'complete');assert.equal(result.analysis.entries[0].url,url+'a?x=1');}
  for(const body of [xml+'<', '<?xml version="1.0" encoding="ISO-8859-1"?>'+xml]){const failed=await prepareAuditObservation({...input,download:complete(body,'application/xml')});assert.equal(failed.status,'prepared');if(failed.status==='prepared'&&failed.kind==='sitemap'){assert.equal(failed.analysis.status,'unavailable');assert.deepEqual(failed.analysis.entries,[]);}}
});

test('aborted or failed parser work returns only a fixed failure, with no retained prefix',async()=>{
  const controller=new AbortController();controller.abort();assert.deepEqual(await prepare(complete('<title>Hidden prefix</title>'),controller.signal),{status:'unavailable',kind:'html',reason:'parser_aborted'});
  const mocked=mock.method(childProcess,'spawn',()=>{throw new Error('Private child details must not escape');});
  try{assert.deepEqual(await prepare(complete('<title>Hidden prefix</title>')),{status:'unavailable',kind:'html',reason:'parser_child_error'});}finally{mocked.mock.restore();}
});
