// TEN98_REPORT_STYLE_BROWSER=1 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs [REPORT_STYLE_BROWSERS=chromium,webkit] node tests/report-style-browser.mjs
// Loads every distinct sanitised report from the generated style corpus in real browsers, with no
// Content-Security-Policy, and asserts that nothing reaches a loopback listener that each loader names.
// A control run of unsanitised inputs proves the same harness sees those loaders fetch.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {launchChromium,loadPlaywright} from './helpers/playwright.mjs';
import {sanitizeReportHtml} from '../src/server/reports.ts';
import {fuzzCorpus,keptStyles,loadingDeclarations,loadingRules,structuredCorpus} from './helpers/report-style-corpus.ts';
assert.equal(process.env.TEN98_REPORT_STYLE_BROWSER,'1');

const listen=handler=>new Promise(resolve=>{const server=createServer(handler);server.listen(0,'127.0.0.1',()=>resolve(server));});
const originOf=server=>`http://127.0.0.1:${server.address().port}`;

// The listener answers like a real asset host so a browser has no reason to stop at the first response.
const hits=[];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=','base64');
const listener=await listen((request,response)=>{
  hits.push(request.url);
  const type=request.url.endsWith('.css') ? 'text/css' : request.url.includes('.svg') ? 'image/svg+xml' : request.url.endsWith('.woff2') ? 'font/woff2' : 'image/png';
  response.writeHead(200,{'content-type':type,'access-control-allow-origin':'*'});
  response.end(type==='image/png' ? png : type==='image/svg+xml' ? '<svg xmlns="http://www.w3.org/2000/svg"><filter id="f"/><mask id="m"/><linearGradient id="g"/></svg>' : '');
});
const target=originOf(listener);

let documents=[];
const pageRequests=new Map();
const pages=await listen((request,response)=>{
  const path=request.url;
  pageRequests.set(path,(pageRequests.get(path) ?? 0)+1);
  const batch=/^\/batch\/(\d+)$/u.exec(path), item=/^\/case\/(\d+)$/u.exec(path);
  response.writeHead(batch || item ? 200 : 404,{'content-type':'text/html; charset=utf-8'});
  if (batch) {
    const start=Number(batch[1])*batchSize;
    response.end('<!doctype html><body style="margin:0;display:grid;grid-template-columns:repeat(10,150px)">'
      +documents.slice(start,start+batchSize).map((_,index)=>`<iframe src="/case/${start+index}" width="150" height="100" style="border:0"></iframe>`).join('')+'</body>');
  } else response.end(item ? documents[Number(item[1])] ?? '' : '');
});
const pageOrigin=originOf(pages);
const batchSize=100;

/** Loads `list` in `browserType`, returning listener hits, unexpected page-server requests and other origins asked for. */
async function load(name,list) {
  documents=list; hits.length=0; pageRequests.clear();
  const foreign=[];
  const browser=name==='chromium' ? await launchChromium() : await (await loadPlaywright())[name].launch({headless:true});
  try {
    const context=await browser.newContext({viewport:{width:1500,height:1000},serviceWorkers:'block'});
    context.on('request',request=>{ if (!request.url().startsWith(pageOrigin) && !request.url().startsWith(target) && !request.url().startsWith('data:') && !request.url().startsWith('about:')) foreign.push(request.url()); });
    const page=await context.newPage();
    page.setDefaultTimeout(20000);
    for (let start=0; start<list.length; start+=batchSize) {
      await page.goto(`${pageOrigin}/batch/${start/batchSize}`,{waitUntil:'load'});
      // Style, layout and font matching run after load; give deferred fetches time to start.
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150)))));
    }
    await page.waitForTimeout(500);
  } finally { await browser.close(); }
  const repeated=[...pageRequests].filter(([path,count])=>path!=='/favicon.ico' && (count>1 || !/^\/(?:batch|case)\/\d+$/u.test(path)));
  return {hits:[...hits],repeated,foreign};
}

const sanitized=new Set();
for (const html of structuredCorpus(target)) sanitized.add(sanitizeReportHtml(html));
const {sheets,lists,values}=fuzzCorpus(1500,11,target);
for (let index=0; index<sheets.length; index++) {
  const attr=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;');
  // Generated sheets never spell `</style`, so each stays inside its element.
  const html=`<style>${sheets[index]}</style><p style="${attr(lists[index])}">Text</p><svg width="20" height="20"><rect width="9" height="9" fill="${attr(values[index])}"/></svg>`;
  try { sanitized.add(sanitizeReportHtml(html)); } catch { /* reports with a raw NUL are refused before any CSS is read */ }
}
const kept=[...keptStyles.declarations,...keptStyles.svgStyle].map(css=>`<p style="${css.replaceAll('"','&quot;')}">Text</p><svg width="20" height="20"><linearGradient id="g"/><rect width="9" height="9" style="${css.replaceAll('"','&quot;')}"/></svg>`)
  .concat(keptStyles.rules.map(css=>`<style>${css}</style><p class="md:flex w-1/2">Text</p><svg width="20" height="20"><rect width="9" height="9"/></svg>`));
for (const html of kept) sanitized.add(sanitizeReportHtml(html));
const corpus=[...sanitized];

// Unsanitised control: one plain document per loader.
const page=(head,body='')=>`<!doctype html><html><head>${head}</head><body>${body}<p class="c" title="${target}/title.png">Text</p><div>Block</div><svg width="20" height="20"><rect width="10" height="10"/></svg></body></html>`;
const control=[...loadingDeclarations(target).map(css=>page(`<style>*{${css}}</style>`)),...loadingRules(target).map(rule=>page(`<style>${rule}*{font-family:Loaded}</style>`))];

const browsers=(process.env.REPORT_STYLE_BROWSERS ?? 'chromium').split(',').map(item=>item.trim()).filter(Boolean);
const summary=[];
try {
  for (const name of browsers) {
    const controlRun=await load(name,control);
    const fetched=new Set(controlRun.hits.map(url=>url.split(/[?#]/u)[0]));
    for (const path of ['/a.png','/b.png','/c.png','/q.png','/r.png','/t.css','/u.css','/v.woff2']) assert.ok(fetched.has(path),`${name} control did not fetch ${path}; fetched ${[...fetched].join(', ')}`);
    const run=await load(name,corpus);
    assert.deepEqual(run.hits,[],`${name}: sanitised reports reached the listener`);
    assert.deepEqual(run.repeated,[],`${name}: sanitised reports requested a page-server URL other than their own document`);
    assert.deepEqual(run.foreign,[],`${name}: sanitised reports requested another origin`);
    summary.push(`${name}: ${corpus.length} distinct sanitised reports, 0 requests; control fetched ${fetched.size} distinct loader URLs (${[...fetched].sort().join(' ')})`);
  }
} finally {
  listener.close(); pages.close();
}
console.log(summary.join('\n'));
