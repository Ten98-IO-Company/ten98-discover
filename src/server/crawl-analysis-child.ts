import {analyzeCrawlPage,type CrawlPageInput} from './crawl-analysis.ts';
import {createHash} from 'node:crypto';
import {parseRobotsPolicy,evaluateRobotsPolicy,ROBOTS_MAX_BYTES} from './crawl-robots.ts';
import {parseSitemap} from './crawl-sitemap.ts';

// One request per child. The supervisor owns the wall-clock deadline and process lifetime.
const inputLimit=7*1024*1024;
let bytes=0;
const chunks:Buffer[]=[];
try {
  for await(const chunk of process.stdin){
    const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;
    if(bytes>inputLimit){process.stdin.destroy();throw new TypeError();}chunks.push(buffer);
  }
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError();
  if('operation' in value){
    const v=value as Record<string,unknown>;
    if(v.operation==='sitemap'){
      const capacity=5*1024*1024;
      if(typeof v.documentUrl!=='string'||Buffer.byteLength(v.documentUrl)>2048||typeof v.bodyBase64!=='string'||v.bodyBase64.length>4*Math.ceil(capacity/3))throw new TypeError();
      const body=Buffer.from(v.bodyBase64,'base64');
      if(body.length>capacity||body.toString('base64')!==v.bodyBase64)throw new TypeError();
      process.stdout.write(JSON.stringify({status:'ok',analysis:parseSitemap({documentUrl:v.documentUrl,chunks:[body]})}));
    }else{
    if(v.operation!=='robots'||typeof v.bodyBase64!=='string'||v.bodyBase64.length>4*Math.ceil(ROBOTS_MAX_BYTES/3)||
      typeof v.robotsUrl!=='string'||typeof v.productToken!=='string'||!Array.isArray(v.targetUrls)||v.targetUrls.length<1||v.targetUrls.length>100||
      v.targetUrls.some(url=>typeof url!=='string'||Buffer.byteLength(url)>2048)||
      typeof v.maxCrawlDelaySeconds!=='number'||!Number.isFinite(v.maxCrawlDelaySeconds)||v.maxCrawlDelaySeconds<0)throw new TypeError();
    const body=Buffer.from(v.bodyBase64,'base64');
    if(body.length>ROBOTS_MAX_BYTES||body.toString('base64')!==v.bodyBase64)throw new TypeError();
    const policy=parseRobotsPolicy({robotsUrl:v.robotsUrl,body,productToken:v.productToken});
    const evaluation={digest:createHash('sha256').update(body).digest('hex'),policyStatus:policy.status,
      reason:policy.status==='unavailable'?policy.reason:null,origin:policy.status==='ready'?policy.origin:null,
      sitemaps:policy.status==='ready'?policy.sitemaps:[],crawlDelaySeconds:policy.status==='ready'?policy.crawlDelaySeconds:null,
      decisions:v.targetUrls.map(url=>evaluateRobotsPolicy(policy,url,{maxCrawlDelaySeconds:v.maxCrawlDelaySeconds as number}))};
    process.stdout.write(JSON.stringify({status:'ok',evaluation}));
    }
  }else{
    const analysis=analyzeCrawlPage(value as CrawlPageInput);
    process.stdout.write(JSON.stringify({status:'ok',analysis}));
  }
}catch(error){
  if(error instanceof TypeError||error instanceof SyntaxError)process.stdout.write('{"status":"invalid_input"}');
  else process.exitCode=1;
}
