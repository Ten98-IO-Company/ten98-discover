// Feed this file to the built runtime image's Node stdin from /app; no DB or network required.
import assert from 'node:assert/strict';
import {analyzeCrawlPageIsolated} from './src/server/crawl-analysis-isolated.ts';
import {evaluateCrawlRobotsIsolated} from './src/server/crawl-robots-isolated.ts';
import {parseCrawlSitemapIsolated} from './src/server/crawl-sitemap-isolated.ts';

assert.equal(process.platform,'linux');assert.equal(process.cwd(),'/app');assert.notEqual(process.getuid(),0);
const timeout=setTimeout(()=>{process.stderr.write('Crawler runtime check exceeded its deadline.\n');process.exit(1);},15_000);
try{
  const input={url:'https://example.test/',status:200,fetchState:'ok',contentType:'text/html',html:'<title>Container fixture</title><h1>Static page</h1>',bodyComplete:true,responseTimeMs:5,crawlDepth:0};
  const page=await analyzeCrawlPageIsolated(input);
  assert.equal(page.status,'ok');assert.equal(page.analysis.coverage,'analyzed');assert.equal(page.analysis.evidence.title,'Container fixture');
  const robots=await evaluateCrawlRobotsIsolated({robotsUrl:'https://example.test/robots.txt',body:Buffer.from('User-agent: *\nDisallow: /private'),productToken:'TenMonitorBot',targetUrls:['https://example.test/','https://example.test/private']});
  assert.equal(robots.status,'ok');assert.deepEqual(robots.evaluation.decisions.map(d=>d.status),['allowed','disallowed']);
  const sitemap=await parseCrawlSitemapIsolated({documentUrl:'https://example.test/sitemap.xml',body:Buffer.from('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.test/</loc></url></urlset>')});
  assert.equal(sitemap.status,'ok');assert.equal(sitemap.analysis.status,'complete');assert.deepEqual(sitemap.analysis.entries,[{url:'https://example.test/'}]);
  const hostile=await analyzeCrawlPageIsolated({...input,html:'<div>'.repeat(190000)});
  assert.ok(['timeout','child_error'].includes(hostile.status));assert.equal('analysis' in hostile,false);
  const controller=new AbortController(),pending=analyzeCrawlPageIsolated({...input,html:'<div>'.repeat(190000)},controller.signal);
  controller.abort();assert.deepEqual(await pending,{status:'aborted'});
  process.stdout.write('Crawler runtime checks passed: unprivileged source layout, HTML, robots, sitemap, hostile input and cancellation.\n');
}finally{clearTimeout(timeout);}
