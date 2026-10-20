import assert from 'node:assert/strict';
import {test} from 'node:test';
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
