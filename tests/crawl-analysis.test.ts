import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCrawlPage,crawlAnalysisLimits as limits,type CrawlPageInput} from '../src/server/crawl-analysis.ts';

const origin='https://example.com/';
const words=(n:number)=>Array.from({length:n},(_,i)=>`word${i}`).join(' ');
function page(body=`<h1></h1><p>${words(150)}</p><a href="/next"></a>`,head='<title>Useful page title</title><meta name="description" content="'+ 'd'.repeat(80)+'">'){return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;}
function analyze(html:string|null=page(),extra:Partial<CrawlPageInput>={}){return analyzeCrawlPage({url:origin,status:200,fetchState:'ok',contentType:'text/html; charset=UTF-8',html,bodyComplete:true,responseTimeMs:1500,crawlDepth:0,...extra});}
const codes=(result:ReturnType<typeof analyze>)=>result.findings.map(f=>f.code);
const has=(html:string,code:string,extra:Partial<CrawlPageInput>={})=>codes(analyze(html,extra)).includes(code as never);

test('complete HTML exposes measured facts separately from bounded text; no body or markup returned',()=>{
  const result=analyze();assert.equal(result.coverage,'analyzed');assert.deepEqual(result.findings,[]);
  assert.equal(result.facts?.wordCount,150);assert.equal(result.facts?.indexability,'no_noindex_observed');
  assert.equal(result.facts?.linksTotal,1);assert.equal(result.facts?.internalLinks,1);assert.equal(result.facts?.headingCounts[0],1);
  assert.equal(result.evidence?.title,'Useful page title');assert.match(result.facts!.contentHash!,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(result).includes('word149'));assert.ok(!JSON.stringify(result).includes('<h1>'));
  assert.equal(analyze(page('<p>one</p>two<span>three</span><br>four')).facts?.wordCount,3);
  assert.equal(analyze(page('<div>one</div><div>two</div>')).facts?.contentHash,analyze(page('<p>one two</p>')).facts?.contentHash);
});

test('every title and description threshold preserves equality and missing versus unavailable',()=>{
  for(const [length,expected] of [[0,'missing-title'],[9,'title-too-short'],[10,null],[60,null],[61,'title-too-long']] as const){
    const result=analyze(page(undefined,`<title>${'x'.repeat(length)}</title><meta name="description" content="${'d'.repeat(80)}">`));
    assert.equal(result.facts?.titleLength,length);assert.deepEqual(codes(result),expected?[expected]:[]);
  }
  for(const [length,expected] of [[0,'missing-meta-description'],[69,'meta-description-too-short'],[70,null],[160,null],[161,'meta-description-too-long']] as const){
    const result=analyze(page(undefined,`<title>Useful page title</title><meta name="description" content="${'d'.repeat(length)}">`));
    assert.equal(result.facts?.descriptionLength,length);assert.deepEqual(codes(result),expected?[expected]:[]);
  }
  assert.equal(analyze(page(undefined,'')).facts?.titleLength,0);
  assert.equal(analyze(null,{bodyComplete:false}).facts,null);
});

test('heading, content, image, outgoing-link, timing and depth rules use their exact boundaries',()=>{
  assert.ok(has(page('<p>text</p>'),'missing-h1'));
  assert.ok(has(page('<h1>A</h1><h1>B</h1>'),'multiple-h1'));
  assert.ok(has(page('<h1>A</h1><h3>B</h3>'),'heading-order-skip'));
  assert.ok(!has(page('<h1>A</h1><h2>B</h2><h1>C</h1>'),'heading-order-skip'));
  for(const count of [149,150])assert.equal(has(page(`<h1></h1><p>${words(count)}</p><a href="/next"></a>`),'thin-content'),count===149);
  const image=analyze(page('<h1>A</h1><img src="/a"><img src="/b" alt=""><img alt="descriptive">'));
  assert.equal(image.evidence?.images[2].src,null);assert.equal(image.facts?.imagesTotal,3);assert.equal(image.facts?.imagesMissingAlt,1);assert.ok(codes(image).includes('images-missing-alt'));
  assert.ok(!has(page('<img alt="">'),'images-missing-alt'));
  assert.ok(has(page('<p>text</p>'),'no-outgoing-links'));
  assert.ok(!has(page('<a href="https://elsewhere.example/">out</a>'),'no-outgoing-links'));
  for(const time of [1500,1501])assert.equal(has(page(),'slow-response',{responseTimeMs:time}),time===1501);
  for(const depth of [null,4,5])assert.equal(has(page(),'deep-page',{crawlDepth:depth}),depth===5);
});

test('fetch and coverage states never fabricate content absence or a successful analysis',()=>{
  const cases:[Partial<CrawlPageInput>,string,string[]][]=[
    [{fetchState:'blocked',status:403},'blocked',['blocked-page']],
    [{fetchState:'blocked',status:200},'blocked',['blocked-page']],
    [{fetchState:'rate_limited',status:429},'rate_limited',['rate-limited-page']],
    [{status:429},'rate_limited',['rate-limited-page']],
    [{fetchState:'error',status:null},'unavailable',[]],
    [{fetchState:'not_fetched',status:null},'not_fetched',[]],
    [{fetchState:'robots_disallowed',status:null},'robots_disallowed',[]],
    [{status:503},'http_error',['server-error']],[{status:404},'http_error',['broken-page']],
    [{status:301},'redirect',[]],[{status:304},'unavailable',[]],[{status:204},'non_html',[]],[{status:205},'non_html',[]],[{status:206},'partial',[]],[{status:null},'unavailable',[]],
    [{contentType:'application/pdf'},'non_html',[]],[{contentType:'application/xhtml+xml'},'non_html',[]],
    [{contentType:null},'unavailable',[]],[{bodyComplete:false},'partial',[]],
  ];
  for(const [extra,coverage,expected] of cases){const result=analyze('',extra);assert.equal(result.coverage,coverage);assert.equal(result.facts,null);assert.equal(result.evidence,null);assert.deepEqual(codes(result),expected);}
  assert.deepEqual(codes(analyze('',{bodyComplete:false,responseTimeMs:1501})),['slow-response']);
});

test('JS shell suppresses false content findings, including a script in head; JSON scripts alone do not imply rendering',()=>{
  for(const html of [page('<div id="root"></div><script src="/app.js"></script>',''),page('<div id="__next"></div>','<script type="module" src="/app.js"></script>'),page('<div id="app"></div><script type="  " src="/app"></script>')]){
    const result=analyze(html);assert.equal(result.coverage,'shell');assert.equal(result.facts?.indexability,'unknown');assert.deepEqual(codes(result),['javascript-rendering-suspected']);
  }
  assert.equal(analyze(page('<div id="root"></div><script type="application/ld+json">{}</script>')).coverage,'analyzed');
  assert.equal(analyze(page('<div id="root"></div><script src="/app"></script><h1>Rendered heading</h1>')).coverage,'analyzed');
  assert.equal(analyze(page('<div id="root"></div><script src="/app"></script><noscript><h1>Fallback ignored</h1></noscript>')).coverage,'shell');
  const noindex=analyze(page('<div id="root"></div><script src="/app"></script>','<meta name="robots" content="noindex">'));
  assert.deepEqual(codes(noindex),['noindex-page','javascript-rendering-suspected']);
});

test('paired challenge document signals suppress SEO absence while ordinary bot scripts do not',()=>{
  const title='<title>Just a moment...</title>';
  const endpoint='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1';
  const external=`<script src="${endpoint}"></script>`;
  const inline=`<script>window._cf_chl_opt={}; var source='${endpoint}';</script>`;
  for(const script of [external,inline,`<script>(function(){window._cf_chl_opt={}; var source='${endpoint}';}());</script>`]){
    const result=analyze(page(script,title));assert.equal(result.coverage,'unavailable');assert.deepEqual(result.reasons,['challenge_suspected']);
    assert.equal(result.facts,null);assert.equal(result.evidence,null);assert.deepEqual(result.findings,[]);
  }
  for(const [head,body] of [
    [title,'<h1>Ordinary content</h1>'],['<title>Application page</title>',external],
    [title,'<script src="/cdn-cgi/challenge-platform/scripts/jsd/api.js"></script>'],
    [title,'<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'],
    [title,`<script type="application/ld+json">window._cf_chl_opt={}; "${endpoint}"</script>`],
    [title,`<template>${external}</template>`],[title,`<pre>${inline.replaceAll('<','&lt;')}</pre>`],
    [title,`<script>const example="window._cf_chl_opt = {}; ${endpoint}";</script>`],
    [title,`<script>/* window._cf_chl_opt = {}; ${endpoint} */</script>`],
    [title,`<script>example._cf_chl_opt='${endpoint}';</script>`],
    [title,inline.replace('<script>','<script src="">')],[title,external.replace(endpoint,endpoint.toUpperCase())],
    [title,`<script src="https://elsewhere.example${endpoint}"></script>`],
  ])assert.equal(analyze(page(body,head)).coverage,'analyzed');
  assert.equal(analyze(page(external,title),{status:202}).coverage,'unavailable');
  assert.equal(analyze(page('<h1>Processing</h1>'),{status:202}).coverage,'analyzed');
});

test('robots combine generic and Googlebot directives, scope each X-Robots value, and do not equate nofollow with noindex',()=>{
  for(const extra of ['<meta name="ROBOTS" content="index, noindex">','<meta name="googlebot" content="none">']){
    const result=analyze(page('<p>small</p>',extra));assert.ok(codes(result).includes('noindex-page'));assert.ok(!codes(result).includes('thin-content'));assert.ok(!codes(result).includes('no-outgoing-links'));
  }
  assert.equal(analyze(page(undefined,'<meta name="otherbot" content="noindex">')).facts?.indexability,'no_noindex_observed');
  for(const header of ['noindex','googlebot: noindex, nofollow','otherbot: index, googlebot: none'])assert.equal(analyze(page(),{xRobotsTags:[header]}).facts?.indexability,'noindex_observed');
  for(const header of ['nofollow','otherbot: noindex, nofollow','googlebot-news: noindex','unavailable_after: 01 Jan 2000 00:00:00 GMT'])assert.equal(analyze(page(),{xRobotsTags:[header]}).facts?.indexability,'no_noindex_observed');
  assert.equal(analyze(page(),{xRobotsTags:['otherbot: noindex','noindex']}).facts?.indexability,'noindex_observed');
  assert.equal(analyze(page(undefined,`<meta name="robots" content="${'index,'.repeat(500)}noindex">`)).facts?.indexability,'noindex_observed');
});

test('canonical observations resolve base URLs, preserve query order/trailing slash, and report conflicts without fetching',()=>{
  assert.equal(analyze(page()).facts?.canonical,'none');
  assert.equal(analyze(page(undefined,'<link REL="canonical alternate" href="/#fragment">')).facts?.canonical,'self');
  const other=analyze(page(undefined,'<base href="https://cdn.example/sub/"><link rel="canonical" href="article?b=2&a=1">'));
  assert.equal(other.facts?.canonical,'other');assert.equal(other.evidence?.htmlCanonicals[0],'https://cdn.example/sub/article?b=2&a=1');assert.ok(codes(other).includes('canonicalized-page'));
  const conflict=analyze(page(undefined,'<link rel="canonical" href="/one">'),{linkHeaders:['</two>; rel="canonical"']});
  assert.equal(conflict.facts?.canonical,'conflict');assert.ok(codes(conflict).includes('canonical-conflict'));
  assert.equal(analyze(page(undefined,'<link rel="canonical" href="/same"><link rel="canonical" href="/same/">')).facts?.canonical,'conflict');
  assert.equal(analyze(page(undefined,'<link rel="canonical" href="javascript:alert(1)">')).facts?.canonical,'invalid');
  assert.equal(analyze(page(undefined,'<link rel="canonical" href="">')).facts?.canonical,'invalid');
  assert.equal(analyze(page(undefined,'<base href="javascript:bad"><link rel="canonical" href="/">')).coverage,'partial');
  const header=analyze(page(),{linkHeaders:['</a,b>; title="a; b, c"; rel="alternate canonical", </ignored>; rel=canonical; anchor="/different"']});
  assert.deepEqual(header.evidence?.headerCanonicals,['https://example.com/a,b']);
  for(const link of ['</>; rel="canonical','</>; rel=canonical; rel=alternate','<https://user:pass@example.com/>; rel=canonical'])assert.equal(analyze(page(),{linkHeaders:[link]}).facts?.canonical,'invalid');
  assert.deepEqual(analyze(page(),{linkHeaders:['</>; rel=canonical']}).evidence?.headerCanonicals,[origin]);
  for(const extra of ['</asset>; rel=preload; as', '</asset>; rel=preload; malformed parameter', '</asset>; rel="preload']){
    const unrelated=analyze(page(undefined,'<link rel="canonical" href="/">'),{linkHeaders:[extra]});assert.equal(unrelated.facts?.canonical,'self');assert.equal(unrelated.facts?.invalidCanonicals,0);
  }
  assert.equal(analyze(page(),{linkHeaders:['<>; rel=canonical']}).facts?.canonical,'invalid');
});

test('HTML extraction honors namespaces, hidden/template/script content, exact origins and valid bounded links',()=>{
  const result=analyze(page('<h1>Visible &amp; safe</h1><template><h1>Ignored</h1><a href="/template">x</a></template><div hidden><h1>Hidden</h1></div><h2 hidden>Hidden too</h2><script>secret script</script><style>secret style</style><a href="/same?b=2&a=1#x" rel="NOFOLLOW">A &amp; B</a><a href="/same?b=2&a=1#y">duplicate</a><a href="https://www.example.com/">external</a><a href="mailto:x@example.com">email</a><a href="javascript:alert(1)">bad</a><a href="https://user:secret@example.com/">credential</a><a href="#same-page">fragment</a>', '<title>Entity &amp; title</title><meta PROPERTY="og:title" content="OG"><meta property="og:image" content="/img.png"><link rel="alternate" hreflang="en" href="/en"><script type="application/ld+json">{bad json}</script>'));
  assert.deepEqual(result.facts?.headingCounts,[1,0,0,0,0,0]);assert.equal(result.facts?.linksTotal,2);assert.equal(result.facts?.internalLinks,1);assert.equal(result.facts?.externalLinks,1);
  assert.equal(result.evidence?.links[0].url,'https://example.com/same?b=2&a=1');assert.equal(result.evidence?.links[0].nofollow,true);
  assert.equal(result.evidence?.links[0].anchor,'A & B');assert.equal(result.facts?.structuredDataPresent,true);assert.equal(result.facts?.hreflangCount,1);
  assert.equal(result.facts?.unresolvedLinks,1);assert.equal(result.evidence?.openGraph.image,'https://example.com/img.png');assert.ok(!JSON.stringify(result).includes('secret'));
  const unresolved=analyze(page('<a href="http://[">bad</a>'));assert.equal(unresolved.facts?.unresolvedLinks,1);assert.ok(!codes(unresolved).includes('no-outgoing-links'));
  const emptyUrls=analyze(page('<img><img src="">','<meta property="og:image" content=""><link rel="alternate" hreflang="en"><link rel="alternate" hreflang="fr" href="">'));
  assert.deepEqual(emptyUrls.evidence?.images.map(i=>i.src),[null,null]);assert.equal(emptyUrls.evidence?.openGraph.image,null);assert.deepEqual(emptyUrls.evidence?.hreflang,[]);
  assert.equal(analyze('<html><head><title>frames</title></head><frameset><frame src="/a"></frameset></html>').coverage,'partial');
});

test('caps fail closed rather than interpret a truncated page as missing content; snippets remain valid Unicode',()=>{
  const cases=[page('x'.repeat(limits.htmlBytes)),page('<div>'.repeat(limits.depth+1)+'x'+'</div>'.repeat(limits.depth+1)),page('<i></i>'.repeat(limits.nodes+1)),page('<img>'.repeat(limits.images+1)),page('<h1></h1>'.repeat(limits.headings+1)),page(Array.from({length:limits.links+1},(_,i)=>`<a href="/${i}">x</a>`).join('')),page('', '<meta name="a">'.repeat(limits.annotations+1)),page('bad\0text'),page('bad\ud800text')];
  for(const html of cases){const result=analyze(html);assert.equal(result.coverage,'partial');assert.equal(result.facts,null);assert.equal(result.evidence,null);assert.deepEqual(result.findings,[]);}
  for(const headers of [['noindex\r\nx-evil: value'],['x'.repeat(limits.headerBytes+1)],Array(101).fill('noindex')])assert.equal(analyze(page(),{xRobotsTags:headers}).coverage,'partial');
  const title='a'.repeat(2047)+'😀x';const result=analyze(page(undefined,`<title>${title}</title>`));
  assert.equal(Array.from(result.evidence!.title).length,2048);assert.ok(result.evidence!.title.endsWith('😀'));assert.equal(result.facts?.titleLength,title.length);
  assert.equal(analyze(page(Array.from({length:limits.links},(_,i)=>`<a href="/${i}"></a>`).join(''))).facts?.linksTotal,limits.links);
});

test('invalid observation metadata is rejected and normalized URLs do not grant network permission',()=>{
  for(const extra of [{url:'file:///etc/passwd'},{url:'https://user:pass@example.com/'},{url:'https://example.com/\n'},{status:199},{status:600},{responseTimeMs:-1},{responseTimeMs:Infinity},{crawlDepth:-1},{crawlDepth:1.5}])assert.throws(()=>analyze(page(),extra),TypeError);
  // The separate transport owns DNS, loopback and authorization checks; this parser performs no I/O.
  assert.equal(analyze(page(),{url:'https://localhost/'}).coverage,'analyzed');
});
