// Generated report-style inputs shared by tests/report-style.test.ts and tests/report-style-browser.mjs.
// Every input pairs a resource-loading construct with a way CSS Syntax can end a string, comment or
// rule early (newline, CR, CRLF, FF, NUL, their HTML entities, CDO/CDC), in each place a report can hold CSS.
import {parse, type DefaultTreeAdapterTypes as Html} from 'parse5';
import {tokenize, TokenType} from '@csstools/css-tokenizer';
import type {CssPolicy} from '../../src/server/report-style.ts';

/** Raw characters and, for attributes, the entity a report author could write instead. */
export const breaks:Array<{name:string;raw:string;entity:string}> = [
  {name:'LF',raw:'\n',entity:'&#10;'}, {name:'CR',raw:'\r',entity:'&#13;'}, {name:'CRLF',raw:'\r\n',entity:'&#13;&#10;'},
  {name:'FF',raw:'\f',entity:'&#12;'}, {name:'NUL',raw:'\0',entity:'&#0;'}, {name:'none',raw:'',entity:''},
];

/** Declarations that would fetch `target` if a browser applied them. */
export const loadingDeclarations = (target:string)=>[
  `background:url(${target}/a.png)`, `background:url("${target}/b.png")`, `background:URL( '${target}/c.png' )`,
  `background-image:image-set("${target}/d.png" 1x)`, `background-image:-webkit-image-set(url(${target}/e.png) 1x)`,
  `background-image:image("${target}/f.png")`, `background-image:cross-fade(url(${target}/g.png), url(${target}/h.png), 50%)`,
  `background-image:src("${target}/i.png")`, `list-style:url(${target}/j.png)`, `cursor:url(${target}/k.png), auto`,
  `border-image:url(${target}/l.png) 30`, `mask:url(${target}/m.svg#m)`, `filter:url(${target}/n.svg#f)`, `fill:url(${target}/o.svg#g)`,
  `content:url(${target}/p.png)`, `background:linear-gradient(red, blue), u\\72l(${target}/q.png)`, `--x:url(${target}/r.png);background:var(--x)`,
  `background-image:attr(title url)`, `background-image:attr(title type(<url>))`, `color:@import "${target}/s.css"`,
];

/** Rules that would fetch `target` if a browser kept them. */
export const loadingRules = (target:string)=>[
  `@import url(${target}/t.css);`, `@import "${target}/u.css";`, `@font-face{font-family:Loaded;src:url(${target}/v.woff2)}`,
  `@namespace x url(${target}/w);`, `@\\69mport "${target}/x.css";`,
];

/** Ways to make one checker see a construct inside a string, comment or bad token while a browser sees it as live. */
const declarationWrappers:Array<(item:string,brk:string)=>string> = [
  (item)=>item,
  (item,brk)=>`x:"${brk};${item};y:"`,
  (item,brk)=>`x:'${brk};${item};y:'`,
  (item,brk)=>`x:a\\${brk};${item}`,
  (item,brk)=>`/*${brk}*/${item}`,
  (item,brk)=>`x:"${brk}" ${item}`,
  (item)=>`--> ${item}`,
  (item)=>`<!-- ${item} -->`,
];
const ruleWrappers:Array<(rule:string,brk:string)=>string> = [
  (rule)=>rule,
  (rule,brk)=>`@layer x"${brk};${rule}@layer y";`,
  (rule)=>`@layer x";${rule}";`,
  (rule)=>`@layer (;${rule});`,
  (rule)=>`--> ${rule}`,
  (rule)=>`<!-- ${rule} -->`,
  (rule,brk)=>`@media all{p{x:"${brk};}${rule}`,
  (rule,brk)=>`p{x:"${brk}}${rule}`,
];

const escapeAttribute = (value:string)=>value.replaceAll('&','&amp;').replaceAll('"','&quot;');
/** Attribute text with each break written as its entity, which the HTML parser decodes to the raw character. */
const encode = (css:string, brk:{raw:string;entity:string})=>css.split(brk.raw).map(escapeAttribute).join(brk.entity);
const body = '<p class="c" title="TARGET_TITLE">Text</p><div>Block</div><svg width="20" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient><clipPath id="c"><rect width="9" height="9"/></clipPath></defs><rect width="10" height="10"/><text x="1" y="9">T</text></svg>';

/** Report documents for the browser and the unit tests; `target` is the origin a fetch would reach. */
export function structuredCorpus(target:string):string[] {
  const documents:string[]=[], page=(head:string,extra='')=>`<html><head>${head}</head><body>${extra}${body.replace('TARGET_TITLE',`${target}/title.png`)}</body></html>`;
  for (const brk of breaks) {
    for (const item of loadingDeclarations(target)) for (const wrap of declarationWrappers) {
      const css=`color:red;${wrap(item,brk.raw)};margin:0`;
      documents.push(page(`<style>*{${css}}</style>`), page(`<style>@media all{*{${css}}}</style>`), page(`<style>@layer x{*{${css}}}</style>`));
      for (const encoded of [false,true]) {
        if (encoded && !brk.raw) continue;
        const text=encoded ? encode(css,brk) : escapeAttribute(css);
        documents.push(page('',`<p style="${text}">Styled</p><svg><rect width="10" height="10" style="${text}"/></svg>`));
      }
    }
    for (const rule of loadingRules(target)) for (const wrap of ruleWrappers) {
      const css=wrap(rule,brk.raw);
      documents.push(page(`<style>${css}*{color:red;font-family:Loaded}</style>`), page(`<style>@media all{${css}*{color:red;font-family:Loaded}}</style>`));
    }
    for (const value of [`url(${target}/y.svg#g)`,`url("${target}/z.svg#g")`,`url(#g)${brk.raw}url(${target}/aa.svg)`,`url(#g) url(${target}/ab.svg)`,`u\\72l(${target}/ac.svg#g)`])
      for (const encoded of [false,true]) {
        if (encoded && !brk.raw) continue;
        const text=encoded ? encode(value,brk) : escapeAttribute(value);
        documents.push(page('',`<svg><rect width="10" height="10" fill="${text}" stroke="${text}" clip-path="${text}"/></svg>`));
      }
  }
  // Reports refuse a raw NUL outright; the entity form above still reaches the style sanitizer.
  return documents.filter(source=>!source.includes('\0'));
}

/** Text that must survive sanitising unchanged. */
export const keptStyles = {
  declarations:[
    'width:calc(100% - (2 * var(--gap)))', 'content:attr(data-label)', 'content:"<"', 'content:"{}"', 'content:"Total (EUR)"',
    'font-family:"Foo (Bar)", \'Baz (Qux)\', serif', 'background:-webkit-linear-gradient(top, #fff, #000)', 'padding-left:env(safe-area-inset-left, 8px)',
    'clip-path:path("M0 0 L10 10 Z")', 'color:rgb(10 20 30 / 50%) !important',
  ],
  svgStyle:['fill:url(#g)','clip-path:url(#c)','filter:url(#f)','stroke:url("#g")','marker-end:url(#m)','mask:url(#m)'],
  rules:[
    '@media (400px <= width <= 700px){p{color:red}}', '@media (width >= 600px) and (height < 400px){p{color:red}}',
    '.md\\:flex{display:flex}', '.w-1\\/2{width:50%}', 'rect{fill:url(#g);clip-path:url(#c);filter:url(#f)}',
    '@container card (min-width: 400px){p{color:red}}', '@layer base.components, report;',
  ],
  presentation:['url(#g)','url("#g")',"url('#g')",'url(#g) red','none'],
};

/**
 * Seeded stylesheets, declaration lists and values. Each is mostly well-formed CSS, with fragments
 * that matter to CSS Syntax (string, comment and escape boundaries, loaders, at-keywords, CDO/CDC)
 * mixed into values, selectors, preludes and the gaps between rules.
 */
export function fuzzCorpus(count:number, seed=1, target='https://external.invalid') {
  let state=seed>>>0;
  const next=(limit:number)=>{ state=(state*1664525+1013904223)>>>0; return (state>>>8)%limit; };
  const pick=<T,>(items:readonly T[])=>items[next(items.length)];
  const nasty=['url(','URL(','u\\72l(','url(#g)','url("#g")',`url(${target}/fuzz-a.png)`,'image-set(','src(','attr(title)','"',"'",'\\','\\\n','\\31 ','/*','*/','/**/','<!--','-->','<','</','<=','{','}','(',')','[',']',';',':',
    `@import "${target}/fuzz-b.css";`,'@media ','@layer ','@x','#','!important','\n','\r','\r\n','\f','\0','\t',' ','x"\f;','x"\r;',"'\n",'&#12;'];
  const plain=['red','1px','50%','2n+1','calc(1px + 2px)','(1px)','var(--x)','rgb(1 2 3 / 50%)','"text"',"'text'",'#fff','a','-b',',','/','*','+',' ',' ','linear-gradient(red, blue)','attr(data-x)'];
  const piece=()=>next(4) ? pick(plain) : pick(nasty);
  const value=()=>{ let text=''; for (let n=next(6)+1; n>0; n--) text+=piece(); return text; };
  const declarationList=()=>Array.from({length:next(4)+1},()=>`${pick(['color','fill','background','--x','clip-path','content','filter','mask','behavior'])}:${value()}`).join(pick([';',';',' ; ',';\n']));
  const selector=()=>pick(['p','.a','a[b="c"]','*','p:not(.x)','.md\\:x','li:nth-child(2n+1)','h1, h2',pick(nasty)+'p','p'+pick(nasty)]);
  const rule=():string=>pick([
    ()=>`${selector()}{${declarationList()}}`,
    ()=>`@media (${pick(['400px <= width','width:1px','x'+pick(nasty)])}){${rule()}}`,
    ()=>`@layer ${pick(['a','a.b, c',pick(nasty)])};`, ()=>`@layer a{${rule()}}`, ()=>`@supports (${declarationList()}){${rule()}}`,
    ()=>`@import "${target}/fuzz-c.css";`, ()=>`@font-face{${declarationList()}}`, ()=>`@keyframes k{from{${declarationList()}}to{${declarationList()}}}`,
    ()=>pick(nasty),
  ])();
  const sheets:string[]=[], lists:string[]=[], values:string[]=[];
  for (let i=0; i<count; i++) {
    sheets.push(Array.from({length:next(4)+1},rule).join(pick(['','\n',' ',pick(nasty)])));
    lists.push(declarationList());
    values.push(value());
  }
  return {sheets,lists,values};
}

function elements(source:string) {
  const result:Html.Element[]=[], pending:Html.ParentNode[]=[parse(source)];
  while (pending.length) for (const node of pending.pop()!.childNodes) if ('tagName' in node) { result.push(node); pending.push(node); }
  return result;
}

const fragment=/^#[A-Za-z_][\w-]*$/u;
const selectorFunctions=new Set(['not','is','where','has','nth-child','nth-last-child','nth-of-type','nth-last-of-type','lang','dir','style']);

/**
 * Re-tokenizes CSS from sanitised output and lists anything that should not be there: url, bad-url,
 * bad-string or unexpected at-keyword tokens, functions outside the policy, or `</` in a stylesheet.
 */
export function cssProblems(css:string, kind:'sheet'|'declarations'|'value', policy:CssPolicy) {
  const problems:string[]=[];
  const tokens=tokenize({css});
  let previous:TokenType|undefined;
  for (let i=0; i<tokens.length; i++) {
    const token=tokens[i], type=token[0];
    if (type===TokenType.BadURL || type===TokenType.BadString || type===TokenType.CDO || type===TokenType.CDC) problems.push(`${type} token`);
    if (type===TokenType.URL && !fragment.test(token[4].value)) problems.push(`url token ${token[1]}`);
    if (type===TokenType.Function) {
      const name=token[4].value.toLowerCase();
      if (name==='url') {
        const argument=tokens.slice(i+1).find(item=>item[0]!==TokenType.Whitespace);
        if (argument?.[0]!==TokenType.String || !fragment.test(argument[4].value)) problems.push(`url function ${token[1]}`);
      } else if (!policy.functions.has(name) && !selectorFunctions.has(name)) problems.push(`function ${name}`);
    }
    if (type===TokenType.AtKeyword) {
      if (kind!=='sheet' || !policy.atRules.has(token[4].value.toLowerCase())) problems.push(`at-keyword ${token[1]}`);
      else if (previous!==undefined && ![TokenType.CloseCurly,TokenType.OpenCurly,TokenType.Semicolon].includes(previous)) problems.push(`at-keyword ${token[1]} inside a prelude or value`);
    }
    if (type!==TokenType.Whitespace && type!==TokenType.Comment && type!==TokenType.EOF) previous=type;
  }
  if (kind==='sheet' && /<\//u.test(css)) problems.push('</ in a stylesheet');
  return problems;
}

/** Problems in every style element, style attribute and SVG paint attribute of a sanitised document. */
export function documentProblems(html:string, policy:CssPolicy) {
  const problems:string[]=[];
  for (const element of elements(html)) {
    if (element.tagName==='style') problems.push(...cssProblems(element.childNodes.map(node=>(node as Html.TextNode).value).join(''),'sheet',policy));
    for (const attr of element.attrs) {
      if (attr.name==='style') problems.push(...cssProblems(attr.value,'declarations',policy));
      if (['fill','stroke','clip-path'].includes(attr.name)) problems.push(...cssProblems(attr.value,'value',policy));
    }
  }
  return problems;
}
