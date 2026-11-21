import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer,createServerModuleRunnerTransport} from 'vite';
import {ESModulesEvaluator,ModuleRunner} from 'vite/module-runner';
import {parse, type DefaultTreeAdapterTypes as Html} from 'parse5';
import {FoundationError} from '../src/server/auth.ts';
import {reportDocument, sanitizeReportHtml, saveReport,createReportShare,handleReportShare} from '../src/server/reports.ts';

function elements(source:string) {
  const result:Html.Element[]=[], pending:Html.ParentNode[]=[parse(source)];
  while (pending.length) for (const node of pending.pop()!.childNodes) if ('tagName' in node) { result.push(node); pending.push(node); }
  return result;
}

test('reports preserve static document styling, tables, raster data and SVG charts',()=>{
  const source='<html lang="en"><head><title>October</title><style>body{font-family:system-ui} td{color:#456}</style></head><body><h1>Results</h1><table><tr><th scope="col">Visits</th></tr><tr><td>42</td></tr></table><svg viewBox="0 0 10 10"><rect width="4" height="8" fill="blue"/><text x="1" y="9">42</text></svg><img alt="Chart" src="data:image/png;base64,iVBORw0KGgo=" /></body></html>';
  const sanitized=sanitizeReportHtml(source);
  assert.match(sanitized,/<title>October<\/title>/);
  assert.match(sanitized,/<style>body\{font-family:system-ui\}/);
  assert.match(sanitized,/<th scope="col">Visits/);
  assert.match(sanitized,/<svg viewBox="0 0 10 10">/);
  assert.match(sanitized,/src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.equal(sanitizeReportHtml(sanitized),sanitized,'A persisted static snapshot must remain stable under the current policy.');
});

test('reports remove active HTML, navigation, handlers and foreign namespace escapes after browser reparsing',()=>{
  const attacks=[
    '<script>globalThis.leak=1</script><p onclick="leak()">ok</p><iframe srcdoc="<script>leak()</script>"></iframe>',
    '<base href="https://external.invalid"><meta http-equiv="refresh" content="0;url=https://external.invalid"><link rel="stylesheet" href="https://external.invalid">',
    '<form action="https://external.invalid"><input name="secret"><button>Send</button></form><a href="javascript:leak()" target="_top" ping="https://external.invalid">Navigate</a>',
    '<svg><a xlink:href="javascript:leak()">Go</a><foreignObject><div><script>leak()</script></div></foreignObject><script>leak()</script><animate onbegin="leak()"/></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=leak()>">',
    '<noscript><p title="</noscript><img src=x onerror=leak()>">',
    '<svg><style><img src=x onerror=leak()></style></svg><object data="https://external.invalid"></object><embed src="https://external.invalid">',
  ];
  for(const source of attacks) {
    const sanitized=sanitizeReportHtml(source);
    for(const element of elements(sanitized)) {
      assert.equal(['script','iframe','form','input','button','base','meta','link','foreignObject','animate','object','embed','math','noscript'].includes(element.tagName),false,'Active element survived the browser parse.');
      assert.equal(element.attrs.some(attr=>/^on/i.test(attr.name)||['href','target','ping','srcdoc','action'].includes(attr.name)||attr.prefix||attr.namespace),false,'Active attribute survived the browser parse.');
    }
  }
});

test('external or mislabeled image sources are removed while author text is escaped',()=>{
  const images=['https://external.invalid/image.png','//external.invalid/p.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,PHNjcmlwdD4=','data:image/png;base64,iVBORw0KGgo','data:image/png;base64,iVBORw0KGgo=\n'];
  for(const src of images) assert.equal(elements(sanitizeReportHtml(`<img src="${src}" alt="plain">`)).find(node=>node.tagName==='img')!.attrs.some(attr=>attr.name==='src'),false);
  assert.match(sanitizeReportHtml('<p>&lt;script&gt;visible text&lt;/script&gt;</p>'),/&lt;script&gt;visible text&lt;\/script&gt;/);
});

function styleOf(source:string) {
  const sanitized=sanitizeReportHtml(source);
  assert.equal(sanitizeReportHtml(sanitized),sanitized,'Sanitised styles must be stable when a snapshot is sanitised again.');
  const found=elements(sanitized);
  const sheet=found.find(node=>node.tagName==='style')?.childNodes.map(node=>(node as Html.TextNode).value).join('');
  return {sheet,inline:found.find(node=>node.tagName==='p')?.attrs.find(attr=>attr.name==='style')?.value};
}
const hex=(char:string)=>char.charCodeAt(0).toString(16);
const alternate=(name:string)=>[...name].map((char,index)=>index%2 ? char.toUpperCase() : char.toLowerCase()).join('');
// Each spelling a browser may resolve to the same identifier, plus a raw control character.
const spellings=(name:string)=>({
  plain:name, upper:name.toUpperCase(), mixed:alternate(name),
  escapedSpace:`\\${hex(name[0])} ${name.slice(1)}`, escapedHex:`${name.slice(0,-1)}\\${hex(name.at(-1)!)}`, escapedZeroPadded:`\\${hex(name[0]).padStart(6,'0')}${name.slice(1)}`,
  comment:`${name[0]}/**/${name.slice(1)}`, control:`${name[0]}\u0001${name.slice(1)}`,
});
const loaders:Array<[string,(name:string)=>string]>=[
  ['url',name=>`background:${name}(https://external.invalid/a.png)`],
  ['url',name=>`background:${name}("https://external.invalid/a.png")`],
  ['image-set',name=>`background-image:${name}("https://external.invalid/a.png" 1x)`],
  ['-webkit-image-set',name=>`background-image:${name}("https://external.invalid/a.png" 1x)`],
  ['image',name=>`background-image:${name}("https://external.invalid/a.png")`],
  ['cross-fade',name=>`background-image:${name}("https://external.invalid/a.png", "https://external.invalid/b.png", 50%)`],
  ['element',name=>`background:${name}(#chart)`],
  ['src',name=>`background-image:${name}("https://external.invalid/a.png")`],
  ['expression',name=>`width:${name}(document.body.clientWidth)`],
  ['url',name=>`background:linear-gradient(red, transparent), ${name}(https://external.invalid/a.png)`],
  ['url',name=>`background:linear-gradient(red, ${name}(https://external.invalid/a.png))`],
  ['url',name=>`--brand-image:${name}(https://external.invalid/a.png)`],
];
const blockedProperties:Array<[string,(name:string)=>string]>=[
  ['behavior',name=>`${name}:url(https://external.invalid/a.htc)`],
  ['behavior',name=>`${name}:default`],
  ['-moz-binding',name=>`${name}:none`],
];

test('report styles drop every function that can load a resource or run script, in each spelling',()=>{
  for(const [name,declaration] of loaders) for(const [variant,spelling] of Object.entries({...spellings(name),space:`${name} `,newline:`${name}\n`})) {
    const css=declaration(spelling), context=`${name} ${variant}: ${css}`;
    assert.equal(styleOf(`<p style='color:red;${css};margin:0'>x</p>`).inline,'color:red;margin:0',context);
    assert.equal(styleOf(`<style>p{color:red;${css};margin:0}</style>`).sheet,'p{color:red;margin:0}',context);
    assert.equal(styleOf(`<style>@media print{p{color:red;${css}}}</style>`).sheet,'@media print{p{color:red}}',context);
  }
  for(const [name,declaration] of blockedProperties) for(const [variant,spelling] of Object.entries({...spellings(name),space:`${name} `,newline:`${name}\n`})) {
    const css=declaration(spelling), context=`${name} ${variant}: ${css}`;
    assert.equal(styleOf(`<p style='color:red;${css}'>x</p>`).inline,'color:red',context);
    assert.equal(styleOf(`<style>p{color:red;${css}}</style>`).sheet,'p{color:red}',context);
  }
  assert.equal(styleOf(`<p style='background:url(https://external.invalid/a.png)'>x</p>`).inline,undefined,'An emptied style attribute is removed.');
});

test('report stylesheets drop @import, @font-face, @namespace and other unlisted at-rules in each spelling',()=>{
  const rules:Array<[string,(name:string)=>string]>=[
    ['import',name=>`@${name} url(https://external.invalid/a.css);`],
    ['import',name=>`@${name} "https://external.invalid/a.css" screen;`],
    ['font-face',name=>`@${name}{font-family:Brand;src:url(https://external.invalid/a.woff2)}`],
    ['font-face',name=>`@${name}{font-family:Brand;src:local(Brand)}`],
    ['namespace',name=>`@${name} svg url(http://www.w3.org/2000/svg);`],
    ['counter-style',name=>`@${name} marks{system:cyclic;symbols:url(https://external.invalid/a.png)}`],
  ];
  for(const [name,rule] of rules) for(const [variant,spelling] of Object.entries({...spellings(name),space:`${name}  `,newline:`${name}\n`})) {
    const css=rule(spelling), context=`@${name} ${variant}: ${css}`;
    assert.equal(styleOf(`<style>${css}p{color:red}</style>`).sheet,'p{color:red}',context);
    assert.equal(styleOf(`<style>@media screen{${css}p{color:red}}</style>`).sheet,'@media screen{p{color:red}}',context);
  }
  assert.equal(styleOf('<style>@import url(https://external.invalid/a.css);p{color:red}</style>').sheet,'p{color:red}');
  assert.equal(styleOf('<style>p{color:red}@font-face{font-family:Brand;src:url(https://external.invalid/a.woff2)}</style>').sheet,'p{color:red}');
});

test('report styles read escapes as CSS does, drop unbalanced text, and keep only same-document SVG paint references',()=>{
  assert.equal(styleOf(`<p style='color:red;content:"\\201C";width:calc(1px'>x</p>`).inline,'color:red;content:"\u201C"','A string is written back from its value.');
  assert.equal(styleOf(`<style>.md\\:flex{display:flex}p{color:red}a){color:blue}</style>`).sheet,'.md\\:flex{display:flex}p{color:red}');
  assert.equal(styleOf(`<style>p{color:red}q{color:blue</style>`).sheet,'p{color:red}');
  assert.equal(styleOf(`<style>p{color:red;q{color:blue}}</style>`).sheet,'p{color:red}','Nested rules are dropped.');
  assert.equal(styleOf(`<style>p{color:red}/* note */ q{color:blue /* x */}</style>`).sheet,'p{color:red} q{color:blue }','Comments beside whitespace are dropped.');
  assert.equal(styleOf(`<style>p{margin:1px/* x */2px}</style>`).sheet,'p{margin:1px/**/2px}','A comment between two tokens stays an empty comment.');
  const svg=elements(sanitizeReportHtml('<svg><linearGradient id="g"/><rect fill="url(#g)" stroke="URL(https://external.invalid/a.svg#g)"/><rect fill="blue" clip-path="u\\72l(#g)"/><path fill="url(#g) red" stroke="none"/><rect fill=\'url("#g")\' stroke="url(#g) url(https://external.invalid/b.svg)"/></svg>'))
    .filter(node=>['rect','path'].includes(node.tagName)).map(node=>Object.fromEntries(node.attrs.map(attr=>[attr.name,attr.value])));
  assert.deepEqual(svg,[{fill:'url(#g)'},{fill:'blue','clip-path':'u\\72l(#g)'},{fill:'url(#g) red',stroke:'none'},{fill:'url("#g")'}]);
});

test('report styles read strings as text, not functions',()=>{
  const kept='content:"Total (EUR)";font-family:"Foo (Bar)", \'Baz (Qux)\', serif;quotes:"(" ")"';
  assert.equal(styleOf(`<p style="${kept.replaceAll('"','&quot;')}">x</p>`).inline,kept);
  assert.equal(styleOf(`<style>p{${kept}}</style>`).sheet,`p{${kept}}`);
  assert.equal(styleOf(`<style>p{content:"\\28 x"}</style>`).sheet,'p{content:"(x"}');
  for(const dropped of ['content:"a" url(https://external.invalid/a.png)','background:url("https://external.invalid/a.png")','content:"(" image-set("a.png" 1x)','background:url ("https://external.invalid/a.png")'])
    assert.equal(styleOf(`<style>p{color:red;${dropped}}</style>`).sheet,'p{color:red}',dropped);
});

test('report styles keep prefixed gradients, path() and env(), and drop @page, @property and @scope',()=>{
  const kept='background:-webkit-linear-gradient(top, #fff, #000);background-image:-moz-repeating-radial-gradient(circle, red, blue 10%);'
    +'clip-path:path("M0 0 L10 10 Z");padding-left:env(safe-area-inset-left, 8px)';
  assert.equal(styleOf(`<style>p{${kept}}</style>`).sheet,`p{${kept}}`);
  for(const rule of ['@page{margin:1cm}','@property --size{syntax:"<length>";inherits:false;initial-value:0px}','@scope (.card){img{border:0}}'])
    assert.equal(styleOf(`<style>${rule}p{color:red}</style>`).sheet,'p{color:red}',rule);
});

test('report style sanitising stays linear on long identifiers, hyphen runs and unclosed parentheses',()=>{
  const run=330000;
  const source=`<p style="color:${'a'.repeat(run)}">a</p><style>p{b:${'-'.repeat(run)}}q{c:${'b'.repeat(run/10)} (}</style><p style="x:${'('.repeat(run)}">b</p>`;
  assert.ok(Buffer.byteLength(source)<1048576 && Buffer.byteLength(source)>1000000);
  const started=performance.now();
  sanitizeReportHtml(source);
  // Before the identifier-start lookbehind, an 80 KB identifier alone took about 20 seconds.
  assert.ok(performance.now()-started<2000,`sanitising took ${Math.round(performance.now()-started)} ms`);
});

test('harmless report styles for colour, size and layout survive unchanged',()=>{
  const inline='display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:calc(var(--gap) * 2);color:rgb(10 20 30 / 50%);'
    +'background:linear-gradient(90deg, #fff, hsl(0 0% 90%));transform:translateX(-50%) rotate(2deg);font:600 14px/1.4 "Segoe UI", system-ui, sans-serif;'
    +'border:1px solid color-mix(in srgb, currentColor 20%, transparent);box-shadow:0 1px 2px rgba(0,0,0,.2);width:clamp(200px, 50%, 600px) !important;';
  assert.equal(styleOf(`<p style='${inline}'>x</p>`).inline,inline);
  const sheet=':root{--accent:#0b5;--gap:8px}\nbody{margin:0;font-family:system-ui}\n'
    +'table{border-collapse:collapse;width:100%}\nth,td{padding:4px 8px;text-align:right}\ntr:nth-child(2n) td{background:#f5f5f5}\n'
    +'a[title^="Report"]::after{content:" (report)"}\n'
    +'@media (max-width: 600px) and (prefers-color-scheme: dark){body{color:#eee;background:#111}}\n'
    +'@supports (display:grid){.cards{display:grid;grid-template-areas:"a b" "c d"}}\n'
    +'@layer base, report;\n@layer base{h1{font-size:2rem}}\n@container (min-width: 400px){.card{padding:1rem}}\n'
    +'@keyframes grow{from{transform:scaleX(0)}50%{opacity:.5}to{transform:scaleX(1)}}\n.bar{animation:grow 1s cubic-bezier(.2,.8,.2,1) both;filter:drop-shadow(0 1px 1px #0003)}\n';
  assert.equal(styleOf(`<style>${sheet}</style>`).sheet,sheet);
});

test('all document callers receive an opaque sandbox and resource restrictions',async()=>{
  const response=reportDocument('<script>leak()</script><p>Safe</p>');
  const csp=response.headers.get('content-security-policy')!;
  assert.ok(csp.startsWith('sandbox;'));
  for(const directive of ["default-src 'none'","script-src 'none'","style-src 'unsafe-inline'","img-src data:","connect-src 'none'","form-action 'none'","base-uri 'none'","frame-ancestors 'self'"]) assert.ok(csp.includes(directive));
  assert.equal(csp.includes('allow-'),false);
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.equal(response.headers.get('cache-control'),'no-store, max-age=0');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal((await response.text()).includes('<script>'),false);
});

test('HTML work is bounded by UTF8 bytes, nodes and depth rather than a report-count ceiling',()=>{
  for(const source of ['', ' ', '\0', '\ud800', '\udfff', 'ü'.repeat(524289), '<div>'.repeat(130)+'deep'+'</div>'.repeat(130), '<br>'.repeat(20001)]) {
    assert.throws(()=>sanitizeReportHtml(source),(error:unknown)=>error instanceof FoundationError && error.status===400);
  }
});

test('invalid PostgreSQL text is rejected at input boundaries without echoing names, briefs or HTML',async()=>{
  const id='66e7a296-c395-4ba4-af9a-899c39549509';
  for(const invalid of ['private-sentinel\0','private-sentinel\ud800','private-sentinel\udfff']) {
    const rejected=(error:unknown)=>error instanceof FoundationError&&error.status===400&&!error.message.includes('private-sentinel');
    await assert.rejects(saveReport(id,id,{title:invalid,html:'<p>Valid</p>'}),rejected);
    await assert.rejects(saveReport(id,id,{title:'Valid',html:invalid}),rejected);
    await assert.rejects(saveReport(id,id,{name:invalid,brief:'Valid'},undefined,true),rejected);
    await assert.rejects(saveReport(id,id,{name:'Valid',brief:invalid},undefined,true),rejected);
    await assert.rejects(createReportShare(id,id,id,{label:invalid,revision:1,expiresAt:'2030-01-01T00:00:00Z'}),rejected);
  }
});

test('missing public reports reuse shared presentation without changing their security contract',async()=>{
  const headers={
    'cache-control':'no-store, max-age=0','content-type':'text/html; charset=utf-8',
    'cross-origin-resource-policy':'same-origin',
    'content-security-policy':"sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    'permissions-policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow, noarchive',
  };
  const missing=await handleReportShare(new Request('https://app.invalid/share/request-private-sentinel?token=private-token'));
  assert.equal(missing.status,404);
  assert.deepEqual(Object.fromEntries(missing.headers),headers);
  const body=await missing.text();
  assert.match(body,/class="t98-auth-layout auth-shell/);
  assert.match(body,/class="t98-auth-title">Report unavailable<\/h1>/);
  assert.match(body,/<html lang="en" data-theme="system">/);
  assert.match(body,/<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(body,/<style>[\s\S]*\.t98-auth-layout/);
  assert.equal(body.includes('request-private-sentinel'),false);
  assert.equal(body.includes('private-token'),false);
  assert.equal(elements(body).some(element=>['script','link','form','iframe'].includes(element.tagName)),false);
  for(const method of ['HEAD','POST','PATCH']) {
    const response=await handleReportShare(new Request(method==='HEAD'?'https://app.invalid/share/invalid':`https://app.invalid/share/example-${'a'.repeat(43)}`,{method}));
    assert.equal(response.status,404);
    assert.deepEqual(Object.fromEntries(response.headers),headers);
    assert.equal(await response.text(),method==='HEAD'?'':body);
  }
  const authored=reportDocument('<h1>Saved snapshot</h1><script>active()</script>');
  assert.deepEqual(Object.fromEntries(authored.headers),headers);
  assert.equal(await authored.text(),'<!DOCTYPE html>\n<html><head></head><body><h1>Saved snapshot</h1></body></html>');
});

test('the Nitro dev module runner serves the same missing-report document as Node',async()=>{
  const request=()=>new Request('https://app.invalid/share/invalid');
  const native=await (await handleReportShare(request())).text();
  const server=await createServer({configFile:false,cacheDir:'private/reports-dev-runner-'+process.pid,appType:'custom',ssr:{external:true},server:{host:'127.0.0.1',middlewareMode:true,hmr:false,ws:false,watch:null}});
  // Mirrors nitro's dev worker: its default import.meta has no working resolve().
  const runner=new ModuleRunner({transport:createServerModuleRunnerTransport({channel:server.environments.ssr.hot}),hmr:false},new ESModulesEvaluator());
  try {
    const reports=await runner.import<typeof import('../src/server/reports.ts')>('/src/server/reports.ts');
    const missing=await reports.handleReportShare(request());
    assert.equal(missing.status,404);
    assert.equal(await missing.text(),native);
  } finally { await runner.close(); await server.close(); }
});
