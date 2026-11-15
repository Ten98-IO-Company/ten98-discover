import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parse, type DefaultTreeAdapterTypes as Html} from 'parse5';
import {cssPolicyCeiling,narrowCssPolicy,reportCssPolicy,sanitizeDeclarations,sanitizePresentationValue,sanitizeStylesheet,type CssPolicy} from '../src/server/report-style.ts';
import {sanitizeReportHtml} from '../src/server/reports.ts';
import {breaks,cssProblems,documentProblems,fuzzCorpus,keptStyles,loadingDeclarations,loadingRules,structuredCorpus} from './helpers/report-style-corpus.ts';

const target='https://external.invalid';
const sheet=(css:string,policy:CssPolicy=reportCssPolicy)=>sanitizeStylesheet(css,policy);
const inline=(css:string,policy:CssPolicy=reportCssPolicy)=>sanitizeDeclarations(css,policy);

function styleParts(html:string) {
  const result:{sheets:string[];styles:string[];paints:string[]}={sheets:[],styles:[],paints:[]}, pending:Html.ParentNode[]=[parse(html)];
  while (pending.length) for (const node of pending.pop()!.childNodes) if ('tagName' in node) {
    if (node.tagName==='style') result.sheets.push(node.childNodes.map(child=>(child as Html.TextNode).value).join(''));
    for (const attr of node.attrs) (attr.name==='style' ? result.styles : ['fill','stroke','clip-path'].includes(attr.name) ? result.paints : []).push(attr.value);
    pending.push(node);
  }
  return result;
}

test('string, comment and rule boundaries follow CSS Syntax for LF, CR, CRLF, FF and NUL, raw or entity-encoded',()=>{
  // Each of these was kept by the previous pattern-based reader and fetched by a browser.
  for (const brk of breaks.filter(item=>item.raw)) {
    const cases=[
      `x:"${brk.raw};background:url(${target}/a.png);y:"`,
      `x:"${brk.raw};background-image:image-set("${target}/a.png" 1x);y:"`,
    ];
    for (const css of cases) {
      const kept=inline(`color:red;${css}`);
      assert.deepEqual(cssProblems(kept,'declarations',reportCssPolicy),[],JSON.stringify(css));
      // NUL does not end a string (it becomes U+FFFD inside it), so there the loader stays quoted text.
      if (brk.name!=='NUL') assert.doesNotMatch(kept,/external\.invalid\/a\.png/u,JSON.stringify(css));
      const encoded=css.split(brk.raw).map(part=>part.replaceAll('"','&quot;')).join(brk.entity);
      for (const html of [`<p style="color:red;${encoded}">x</p>`,`<svg><rect style="color:red;${encoded}"/></svg>`,`<style>@media all{p{color:red;${css}}}</style>`].filter(item=>!item.includes('\0'))) {
        const output=sanitizeReportHtml(html);
        assert.deepEqual(documentProblems(output,reportCssPolicy),[],html);
        assert.equal(sanitizeReportHtml(output),output,html);
      }
    }
    const layered=sheet(`@layer x"${brk.raw};@import '${target}/a.css';@layer y";p{color:red}`);
    assert.doesNotMatch(layered,/@import/u,JSON.stringify(brk));
  }
  // The preprocessing itself: CR, CRLF and FF become LF and NUL becomes U+FFFD in what is written back.
  assert.equal(inline('margin:1px\r2px\r\n3px\f4px'),'margin:1px\n2px\n3px\n4px');
  assert.equal(inline('font-family:a\0b'),'font-family:a�b');
  assert.equal(inline('x:"a\fb;color:red'),'color:red','A string ends at FF, so the semicolon ends the declaration.');
  assert.equal(inline('x:"a\rb;color:red'),'color:red','A string ends at CR.');
  assert.equal(inline('x:"a\nb";color:red'),'','The quote after a newline opens a new string that runs to the end.');
  assert.equal(sanitizePresentationValue('fill','url(#g)\f',reportCssPolicy),'url(#g)\n');
});

test('@import text inside a kept @layer prelude, and CDO/CDC before an at-rule, never reach the output',()=>{
  assert.equal(sheet(`@layer x";@import '${target}/a.css';";p{color:red}`),'p{color:red}');
  assert.equal(sheet(`@layer (;@import "${target}/a.css";);p{color:red}`),'p{color:red}');
  assert.equal(sheet(`@layer a.b, c;@layer d e;p{color:red}`),'@layer a.b, c;p{color:red}','A layer statement is a comma list of dotted names.');
  assert.equal(sheet(`--> @font-face{font-family:F;src:url(${target}/f.woff2)}p{color:red}`),'p{color:red}');
  assert.equal(sheet(`<!-- @import "${target}/a.css"; -->p{color:red}`),' p{color:red}');
  assert.equal(sheet(`@media all{--> @import "${target}/a.css";p{color:red}}`),'@media all{}','Inside a block CDC starts a rule, which is dropped.');
  assert.equal(inline(`--> color:red;<!-- margin:0`),'','CDO and CDC are never part of a declaration.');
  assert.equal(sheet(`p{color:red;x:@import "${target}/a.css"}`),'p{color:red}');
  assert.equal(sheet(`@media all and @import{p{color:red}}q{color:blue}`),'q{color:blue}');
});

test('legitimate report styles survive unchanged',()=>{
  for (const css of keptStyles.declarations) {
    assert.equal(inline(css),css,css);
    assert.equal(sheet(`p{${css}}`),`p{${css}}`,css);
  }
  for (const css of keptStyles.svgStyle) {
    assert.equal(inline(css),css,css);
    const {styles}=styleParts(sanitizeReportHtml(`<svg><rect style="${css.replaceAll('"','&quot;')}"/></svg>`));
    assert.deepEqual(styles,[css],css);
  }
  for (const css of keptStyles.rules) assert.equal(sheet(css),css,css);
  for (const value of keptStyles.presentation) assert.equal(sanitizePresentationValue('fill',value,reportCssPolicy),value,value);
  assert.equal(sheet('p{content:"</style>"}'),'p{content:"\\3c /style>"}','A string never writes `</` into a stylesheet.');
  assert.equal(sanitizePresentationValue('fill','url(#g) url(https://external.invalid/b.svg)',reportCssPolicy),undefined);
  assert.equal(inline('background:url(#g)'),'','Only listed properties may name a fragment.');
});

for (const [label,policy] of [['report policy',reportCssPolicy],['narrowed policy',narrowCssPolicy({functions:['rgb','calc','var'],atRules:['media'],fragmentUrlProperties:['fill'],maxDepth:2})]] as const) {
  test(`every generated report keeps no loader and is stable when sanitised again (${label})`,()=>{
    const documents=structuredCorpus(target);
    assert.ok(documents.length>4000,`corpus has ${documents.length} documents`);
    for (const html of documents) {
      const parts=styleParts(sanitizeReportHtml(html));
      for (const css of parts.sheets) {
        const once=sheet(css,policy);
        assert.deepEqual(cssProblems(once,'sheet',policy),[],html);
        assert.equal(sheet(once,policy),once,html);
      }
      for (const css of parts.styles) {
        const once=inline(css,policy);
        assert.deepEqual(cssProblems(once,'declarations',policy),[],html);
        assert.equal(inline(once,policy),once,html);
      }
    }
    if (policy===reportCssPolicy) for (const html of documents) {
      const output=sanitizeReportHtml(html);
      assert.deepEqual(documentProblems(output,policy),[],html);
      assert.equal(sanitizeReportHtml(output),output,html);
    }
  });

  test(`generated stylesheets, declaration lists and values are stable and keep no loader (${label})`,()=>{
    const {sheets,lists,values}=fuzzCorpus(4000,label.length);
    let kept=0;
    for (const css of sheets) {
      const once=sheet(css,policy);
      if (once.includes('{')) kept++;
      assert.deepEqual(cssProblems(once,'sheet',policy),[],JSON.stringify(css));
      assert.equal(sheet(once,policy),once,JSON.stringify(css));
    }
    for (const css of lists) {
      const once=inline(css,policy);
      assert.deepEqual(cssProblems(once,'declarations',policy),[],JSON.stringify(css));
      assert.equal(inline(once,policy),once,JSON.stringify(css));
    }
    for (const css of values) {
      const once=sanitizePresentationValue('fill',css,policy);
      if (once===undefined) continue;
      assert.deepEqual(cssProblems(once,'value',policy),[],JSON.stringify(css));
      assert.equal(sanitizePresentationValue('fill',once,policy),once,JSON.stringify(css));
    }
    assert.ok(kept>300,`only ${kept} generated stylesheets kept a rule`);
  });
}

test('the corpus checker itself flags loaders, so a clean result is meaningful',()=>{
  let flagged=0;
  for (const item of loadingDeclarations(target)) if (cssProblems(`p{${item}}`,'sheet',reportCssPolicy).length) flagged++;
  for (const rule of loadingRules(target)) if (cssProblems(rule,'sheet',reportCssPolicy).length) flagged++;
  // attr(title url) is the one entry that only a browser can judge; the browser corpus check loads it.
  assert.equal(flagged,loadingDeclarations(target).length+loadingRules(target).length-1);
});

test('policies can only narrow the ceiling',()=>{
  assert.throws(()=>narrowCssPolicy({functions:['rgb','url']}),/cannot add "url"/u);
  assert.throws(()=>narrowCssPolicy({atRules:['import']}),/cannot add "import"/u);
  assert.throws(()=>narrowCssPolicy({fragmentUrlProperties:['background']}),/cannot add "background"/u);
  assert.throws(()=>narrowCssPolicy({maxDepth:cssPolicyCeiling.maxDepth+1}),/maxDepth/u);
  const forged={...reportCssPolicy,functions:new Set([...reportCssPolicy.functions,'image-set'])};
  assert.throws(()=>sanitizeStylesheet('p{color:red}',forged),/cannot add "image-set"/u);
  const narrowed=narrowCssPolicy({functions:['rgb']});
  (narrowed.functions as Set<string>).add('url');
  assert.throws(()=>sanitizeDeclarations('color:red',narrowed),/cannot add "url"/u,'A policy changed after it was built is checked again.');
  const plain=narrowCssPolicy({functions:['rgb'],atRules:['layer'],fragmentUrlProperties:[]});
  assert.equal(inline('color:rgb(1 2 3);width:calc(1px + 2px);fill:url(#g)',plain),'color:rgb(1 2 3)');
  assert.equal(sheet('@media all{p{color:red}}@layer a;',plain),'@layer a;');
});

test('narrowing what this sanitizer refuses makes these checks fail',()=>{
  // Brace and `<` refusal.
  assert.equal(inline('color:red;x:{a:b}'),'color:red');
  assert.equal(inline('color:red;--x:{a}'),'color:red');
  assert.equal(inline('color:red;x:a}'),'color:red');
  assert.equal(sheet('p{color:red;--x:{a} b}'),'p{color:red}');
  assert.equal(inline('color:red;x:a<b'),'color:red');
  assert.equal(sheet('p<q{color:red}r{color:blue}'),'r{color:blue}');
  assert.equal(sheet('@media (width </style>){p{color:red}}'),'');
  assert.equal(sheet('@media (width<=1px){p{color:red}}'),'@media (width<=1px){p{color:red}}');
  assert.equal(sheet('p{a:b;}}q{color:red}'),'p{a:b;}');
  // At-rule depth: eight levels are kept, the ninth is dropped with its block.
  const nested=(levels:number)=>'@media all{'.repeat(levels)+'p{color:red}'+'}'.repeat(levels);
  assert.equal(sheet(nested(8)),nested(8));
  assert.equal(sheet(nested(9)),'@media all{'.repeat(8)+'}'.repeat(8));
  assert.equal(sheet(nested(3),narrowCssPolicy({maxDepth:2})),'@media all{@media all{}}');
  // Bracket depth inside a value: 32 levels are kept, 33 are dropped.
  const brackets=(levels:number)=>`width:${'calc('.repeat(levels)}1px${')'.repeat(levels)}`;
  assert.equal(inline(brackets(32)),brackets(32));
  assert.equal(inline(brackets(33)),'');
  // Prefixed functions are matched by their whole name, never by stripping or matching a prefix.
  for (const css of ['-webkit-image-set(url(a.png) 1x)','-webkit-cross-fade(url(a.png), url(b.png), 50%)','-moz-element(#a)','-o-linear-gradient(red, blue)','-webkit-image(a.png)','-webkit-url(a.png)'])
    assert.equal(inline(`background-image:${css}`),'',css);
  assert.equal(inline('background:-webkit-linear-gradient(red, blue)'),'background:-webkit-linear-gradient(red, blue)');
});

test('style sanitising stays linear on deep, unclosed and comment-heavy input',()=>{
  const run=120000;
  const inputs=[
    '@media all{'.repeat(run*2/3)+'p{color:red}'+'}'.repeat(run*2/3),
    'p{a:'+'('.repeat(run*4)+'}',
    'p{a:b'+'/**/'.repeat(run)+'(c)}',
    '['.repeat(run*4),
    'p{color:red}'.repeat(run/2),
    `p{${'a:"'.repeat(run)}}`,
  ];
  for (const css of inputs) {
    assert.ok(css.length<1048576,`${css.length}`);
    const started=performance.now();
    sheet(css); inline(css);
    assert.ok(performance.now()-started<2000,`${css.slice(0,20)}… took ${Math.round(performance.now()-started)} ms`);
  }
});
