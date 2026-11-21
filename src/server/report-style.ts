// Saved-report CSS is read with a CSS Syntax tokenizer (@csstools/css-tokenizer) and rebuilt from the
// tokens that pass an allow-list, so the browser tokenizes the output the same way it was checked.
// Resource loading is refused by token kind and a function allow-list, not by a list of known loaders;
// the share page's Content-Security-Policy remains a separate second layer.
// This module is pure (no app imports) so it can move to a shared package unchanged.
import {tokenize, TokenType, type CSSToken} from '@csstools/css-tokenizer';

/** What a caller lets through. A policy may only narrow `cssPolicyCeiling`; see `narrowCssPolicy`. */
export interface CssPolicy {
  /** Value functions that compute colours, lengths, shapes or transforms and never fetch a resource. */
  readonly functions: ReadonlySet<string>;
  /** At-rules kept: grouping rules whose block is a rule list, `@layer` statements and keyframes. */
  readonly atRules: ReadonlySet<string>;
  /** Properties that may name a same-document fragment, `url(#id)`, such as SVG paint servers and clip paths. */
  readonly fragmentUrlProperties: ReadonlySet<string>;
  /** How deeply at-rules may nest; a deeper at-rule is dropped with its block. */
  readonly maxDepth: number;
}

const ceilingFunctions = [
  'rgb','rgba','hsl','hsla','hwb','lab','lch','oklab','oklch','color','color-mix','light-dark',
  'calc','min','max','clamp','round','mod','rem','abs','sign','sin','cos','tan','asin','acos','atan','atan2','pow','sqrt','hypot','log','exp','var','env','attr',
  'linear-gradient','radial-gradient','conic-gradient','repeating-linear-gradient','repeating-radial-gradient','repeating-conic-gradient',
  ...['-webkit-','-moz-'].flatMap(prefix=>['linear-gradient','radial-gradient','repeating-linear-gradient','repeating-radial-gradient'].map(name=>prefix+name)),
  'translate','translatex','translatey','translatez','translate3d','scale','scalex','scaley','scalez','scale3d',
  'rotate','rotatex','rotatey','rotatez','rotate3d','skew','skewx','skewy','matrix','matrix3d','perspective',
  'blur','brightness','contrast','drop-shadow','grayscale','hue-rotate','invert','opacity','saturate','sepia',
  'cubic-bezier','steps','linear','repeat','minmax','fit-content','counter','counters',
  'inset','circle','ellipse','polygon','rect','xywh','path',
];

/** The widest policy any caller may use. Everything outside it is always dropped. */
export const cssPolicyCeiling:CssPolicy = Object.freeze({
  functions:new Set(ceilingFunctions),
  atRules:new Set(['media','supports','container','layer','keyframes','-webkit-keyframes']),
  fragmentUrlProperties:new Set(['fill','stroke','clip-path','filter','marker','marker-start','marker-mid','marker-end','mask']),
  maxDepth:8,
});

/** Builds a policy from subsets of the ceiling. Throws if any entry would widen it. */
export function narrowCssPolicy(narrowing:{functions?:Iterable<string>;atRules?:Iterable<string>;fragmentUrlProperties?:Iterable<string>;maxDepth?:number}={}):CssPolicy {
  const policy:CssPolicy = Object.freeze({
    functions:new Set([...narrowing.functions ?? cssPolicyCeiling.functions].map(name=>name.toLowerCase())),
    atRules:new Set([...narrowing.atRules ?? cssPolicyCeiling.atRules].map(name=>name.toLowerCase())),
    fragmentUrlProperties:new Set([...narrowing.fragmentUrlProperties ?? cssPolicyCeiling.fragmentUrlProperties].map(name=>name.toLowerCase())),
    maxDepth:narrowing.maxDepth ?? cssPolicyCeiling.maxDepth,
  });
  assertNarrow(policy);
  return policy;
}

/** Discover's saved-report policy. */
export const reportCssPolicy = narrowCssPolicy();

// Checked on every call, because a Set inside a frozen object can still be changed.
function assertNarrow(policy:CssPolicy) {
  for (const key of ['functions','atRules','fragmentUrlProperties'] as const)
    for (const entry of policy[key]) if (!cssPolicyCeiling[key].has(entry)) throw new RangeError(`CSS policy ${key} cannot add ${JSON.stringify(entry)}.`);
  if (!Number.isInteger(policy.maxDepth) || policy.maxDepth<0 || policy.maxDepth>cssPolicyCeiling.maxDepth)
    throw new RangeError(`CSS policy maxDepth must be an integer from 0 to ${cssPolicyCeiling.maxDepth}.`);
}

const blockedProperties = new Set(['behavior','-moz-binding']);
/** Brackets nest at most this deep inside one prelude or declaration; deeper text is dropped. */
const maxBlockDepth = 32;
const selectorFunctions = new Set(['not','is','where','has','nth-child','nth-last-child','nth-of-type','nth-last-of-type','lang','dir']);
const fragment = /^#[A-Za-z_][\w-]*$/u;
const openers:Partial<Record<TokenType,TokenType>> = {
  [TokenType.OpenParen]:TokenType.CloseParen, [TokenType.Function]:TokenType.CloseParen,
  [TokenType.OpenSquare]:TokenType.CloseSquare, [TokenType.OpenCurly]:TokenType.CloseCurly,
};
const closers = new Set([TokenType.CloseParen,TokenType.CloseSquare,TokenType.CloseCurly]);
const invisible = (token:CSSToken|undefined)=>token?.[0]===TokenType.Whitespace || token?.[0]===TokenType.Comment;

/**
 * Which tokens a context accepts. `functions` maps a lower-case function name to the context of its
 * arguments; `url` is decided separately. `paren` and `square` are the contexts of plain blocks.
 */
interface Context {
  readonly kinds:ReadonlySet<TokenType>;
  readonly delims:string;
  readonly functions:(name:string)=>Context|undefined;
  readonly paren?:Context;
  readonly square?:Context;
  /** `<` only as a range comparison in media and container queries. */
  readonly comparisons?:boolean;
  /** False in values, where a `(` block never directly follows a name: `url (x)` is refused like `url(x)`. */
  readonly bareParens?:boolean;
}
const comparisonFollows = (token:CSSToken)=>[TokenType.Whitespace,TokenType.Ident,TokenType.Number,TokenType.Dimension,TokenType.Percentage].includes(token[0])
  || (token[0]===TokenType.Delim && token[4].value==='=');
const inert = [TokenType.Whitespace,TokenType.Comment,TokenType.Ident,TokenType.Number,TokenType.Percentage,TokenType.Dimension,TokenType.Comma];

const contextCache = new WeakMap<CssPolicy,ReturnType<typeof createContexts>>();
function contexts(policy:CssPolicy) {
  let found=contextCache.get(policy);
  if (!found) contextCache.set(policy,found=createContexts(policy));
  return found;
}

function createContexts(policy:CssPolicy) {
  const value:Context = {
    kinds:new Set([...inert,TokenType.String,TokenType.Hash]), delims:'!/*+-.%',
    functions:name=>policy.functions.has(name) ? value : undefined,
    get paren() { return value; }, get square() { return value; }, bareParens:false,
  };
  const condition:Context = {
    kinds:new Set([...inert,TokenType.Colon,TokenType.String,TokenType.Hash]), delims:'!/*+-.%<>=', comparisons:true,
    functions:name=>name==='style' ? condition : policy.functions.has(name) ? value : undefined,
    get paren() { return condition; },
  };
  const supports:Context = {...condition, delims:'!/*+-.%', comparisons:false, functions:name=>policy.functions.has(name) ? value : undefined, get paren() { return supports; }};
  const selector:Context = {
    kinds:new Set([...inert,TokenType.Colon,TokenType.String,TokenType.Hash]), delims:'.*>+~|&^$=-',
    functions:name=>selectorFunctions.has(name) ? selector : undefined,
    get square() { return selector; },
  };
  const keyframeSelector:Context = {kinds:new Set([TokenType.Whitespace,TokenType.Comment,TokenType.Ident,TokenType.Percentage,TokenType.Comma]), delims:'', functions:()=>undefined};
  const keyframesName:Context = {kinds:new Set([TokenType.Whitespace,TokenType.Comment,TokenType.Ident,TokenType.String]), delims:'', functions:()=>undefined};
  return {value,condition,supports,selector,keyframeSelector,keyframesName};
}
type Contexts = ReturnType<typeof contexts>;

/** CSS Syntax input preprocessing: CRLF, CR and FF become LF, and NUL becomes U+FFFD. */
function preprocess(css:string) {
  return css.replace(/\r\n?|\f/gu,'\n').replaceAll('\0','\uFFFD');
}

function lex(css:string) {
  const tokens=tokenize({css:preprocess(css)});
  tokens.pop(); // EOF
  return tokens;
}

/** Index of the token closing the block opened at `index`, or -1 if the input ends first. */
function blockEnd(tokens:CSSToken[], index:number, end:number) {
  const stack:TokenType[]=[openers[tokens[index][0]]!];
  for (let i=index+1; i<end; i++) {
    const type=tokens[i][0], closer=openers[type];
    if (closer) stack.push(closer);
    else if (type===stack.at(-1) && (stack.pop(), !stack.length)) return i;
  }
  return -1;
}

/** Index of the first top-level token of one of `types`, skipping whole blocks; `end` if none. */
function seek(tokens:CSSToken[], start:number, end:number, types:ReadonlySet<TokenType>) {
  for (let i=start; i<end; i++) {
    const type=tokens[i][0];
    if (types.has(type)) return i;
    if (openers[type]) { const close=blockEnd(tokens,i,end); if (close<0) return end; i=close; }
  }
  return end;
}

/** A same-document reference: `url(#id)` or `url("#id")` and nothing else. */
function fragmentReference(tokens:CSSToken[], index:number, end:number) {
  const token=tokens[index];
  if (token[0]===TokenType.URL) return fragment.test(token[4].value) && token[1].endsWith(')') ? index : -1;
  let i=index+1;
  while (invisible(tokens[i]) && i<end) i++;
  const argument=tokens[i];
  if (argument?.[0]!==TokenType.String || !fragment.test(argument[4].value) || !/^(["']).*\1$/su.test(argument[1])) return -1;
  for (i++; invisible(tokens[i]) && i<end; i++);
  return tokens[i]?.[0]===TokenType.CloseParen && i<end ? i : -1;
}

function followsName(tokens:CSSToken[], start:number, index:number) {
  let i=index-1;
  while (i>=start && invisible(tokens[i])) i--;
  return i>=start && tokens[i][0]===TokenType.Ident;
}

/**
 * Whether every token in [start, end) is allowed in `base`. Blocks must close inside the range and
 * nest at most `maxBlockDepth` deep. Returns false for at-keywords, url, bad-url and bad-string
 * tokens, CDO/CDC, braces, semicolons and any function outside the context's allow-list.
 */
function allowed(tokens:CSSToken[], start:number, end:number, base:Context, fragments=false) {
  const stack:Array<{closer:TokenType;context:Context}>=[];
  for (let i=start; i<end; i++) {
    const token=tokens[i], type=token[0], context=stack.at(-1)?.context ?? base;
    if (closers.has(type)) { if (stack.at(-1)?.closer!==type) return false; stack.pop(); continue; }
    let inner:Context|undefined;
    if (type===TokenType.Function || type===TokenType.URL) {
      const name=type===TokenType.URL ? 'url' : token[4].value.toLowerCase();
      if (name==='url') {
        const close=fragments && stack.length===0 ? fragmentReference(tokens,i,end) : -1;
        if (close<0) return false;
        i=close; continue;
      }
      inner=context.functions(name);
    } else if (type===TokenType.OpenParen) {
      if (context.bareParens===false && followsName(tokens,start,i)) return false;
      inner=context.paren;
    }
    else if (type===TokenType.OpenSquare) inner=context.square;
    else if (type===TokenType.Delim) {
      const delim=token[4].value;
      if (!context.delims.includes(delim)) return false;
      // `<` only compares a range. It is never followed by `/`, so a stylesheet cannot spell an end tag.
      if (delim==='<' && !(context.comparisons && i+1<end && comparisonFollows(tokens[i+1]))) return false;
      continue;
    } else if (context.kinds.has(type)) continue;
    else return false;
    if (!inner || stack.length>=maxBlockDepth) return false;
    stack.push({closer:openers[type]!,context:inner});
  }
  return stack.length===0;
}

/** Writes tokens back as text. Strings are re-quoted from their value; comments are dropped, or kept as an empty comment where they separate two tokens. */
function serialize(tokens:CSSToken[], start:number, end:number) {
  let output='';
  for (let i=start; i<end; i++) {
    const token=tokens[i];
    if (token[0]===TokenType.Comment) { if (i>start && i+1<end && !invisible(tokens[i-1]) && !invisible(tokens[i+1])) output+='/**/'; }
    else if (token[0]===TokenType.String) output+=quote(token[1][0],token[4].value);
    else output+=token[1];
  }
  return output;
}

function quote(mark:string, value:string) {
  return mark+value.replace(/[\\"'\u0000-\u001f\u007f]|<(?=\/)/gu,char=>
    char==='\\' || char===mark ? '\\'+char : char==='"' || char==="'" ? char : `\\${char.codePointAt(0)!.toString(16)} `)+mark;
}

const semicolon = new Set([TokenType.Semicolon]);
const preludeEnd = new Set([TokenType.Semicolon,TokenType.OpenCurly]);
const ruleStart = new Set([TokenType.OpenCurly]);

function declaration(tokens:CSSToken[], start:number, end:number, policy:CssPolicy, use:Contexts) {
  let i=start;
  while (invisible(tokens[i]) && i<end) i++;
  const name=tokens[i];
  if (name?.[0]!==TokenType.Ident || blockedProperties.has(name[4].value.toLowerCase())) return false;
  for (i++; invisible(tokens[i]) && i<end; i++);
  if (tokens[i]?.[0]!==TokenType.Colon || i>=end) return false;
  return allowed(tokens,i+1,end,use.value,policy.fragmentUrlProperties.has(name[4].value.toLowerCase()));
}

/** Keeps the allowed declarations of a style block or attribute, separated as the author separated them. */
function declarations(tokens:CSSToken[], start:number, end:number, policy:CssPolicy, use:Contexts) {
  const kept:string[]=[];
  for (let i=start; i<=end;) {
    const stop=seek(tokens,i,end,semicolon);
    let blank=true;
    for (let j=i; j<stop && blank; j++) blank=invisible(tokens[j]);
    if (blank || declaration(tokens,i,stop,policy,use)) kept.push(serialize(tokens,i,stop));
    i=stop+1;
  }
  return kept.join(';');
}

/**
 * An `@layer` prelude: a name such as `a` or `a.b` (no space around the dot), a comma list of names
 * for the statement form, or nothing for an anonymous block. Nothing else is kept.
 */
function layerPrelude(tokens:CSSToken[], start:number, end:number, statement:boolean) {
  let names=0, expectName=true, spaced=false;
  for (let i=start; i<end; i++) {
    const token=tokens[i];
    if (invisible(token)) { spaced=true; continue; }
    if (expectName) {
      if (token[0]!==TokenType.Ident) return false;
      names++; expectName=false;
    } else if (token[0]===TokenType.Comma && statement) expectName=true;
    else if (token[0]===TokenType.Delim && token[4].value==='.' && !spaced && i+1<end && tokens[i+1][0]===TokenType.Ident) expectName=true;
    else return false;
    spaced=false;
  }
  return names ? !expectName : !statement;
}

type Mode = 'top'|'nested'|'keyframes';

/** Keeps the allowed rules of a rule list, following CSS Syntax "consume a list of rules". */
function rules(tokens:CSSToken[], start:number, end:number, depth:number, mode:Mode, policy:CssPolicy, use:Contexts):string {
  let output='', pending='';
  for (let i=start; i<end;) {
    const token=tokens[i], type=token[0];
    if (type===TokenType.Whitespace) { pending+=token[1]; i++; continue; }
    if (type===TokenType.Comment || (mode==='top' && (type===TokenType.CDO || type===TokenType.CDC))) { i++; continue; }
    if (type===TokenType.AtKeyword) {
      const stop=seek(tokens,i+1,end,preludeEnd);
      const name=token[4].value.toLowerCase(), known=mode!=='keyframes' && policy.atRules.has(name);
      if (stop>=end) break;
      if (tokens[stop][0]===TokenType.Semicolon) {
        if (known && name==='layer' && layerPrelude(tokens,i+1,stop,true)) output+=pending+serialize(tokens,i,stop)+';';
        pending=''; i=stop+1; continue;
      }
      const close=blockEnd(tokens,stop,end);
      if (close<0) break;
      if (known && depth<policy.maxDepth) {
        const keyframes=name.endsWith('keyframes');
        const prelude=keyframes ? use.keyframesName : name==='supports' ? use.supports : use.condition;
        if (name==='layer' ? layerPrelude(tokens,i+1,stop,false) : allowed(tokens,i+1,stop,prelude) && (!keyframes || tokens.slice(i+1,stop).filter(item=>!invisible(item)).length===1))
          output+=pending+serialize(tokens,i,stop)+'{'+rules(tokens,stop+1,close,depth+1,keyframes ? 'keyframes' : 'nested',policy,use)+'}';
      }
      pending=''; i=close+1; continue;
    }
    const stop=seek(tokens,i,end,ruleStart);
    if (stop>=end) break;
    const close=blockEnd(tokens,stop,end);
    if (close<0) break;
    if (allowed(tokens,i,stop,mode==='keyframes' ? use.keyframeSelector : use.selector))
      output+=pending+serialize(tokens,i,stop)+'{'+declarations(tokens,stop+1,close,policy,use)+'}';
    pending=''; i=close+1;
  }
  return output+pending;
}

/** Sanitises a style attribute value. */
export function sanitizeDeclarations(css:string, policy:CssPolicy) {
  assertNarrow(policy);
  const tokens=lex(css);
  return declarations(tokens,0,tokens.length,policy,contexts(policy));
}

/** Sanitises the text of a `<style>` element. */
export function sanitizeStylesheet(css:string, policy:CssPolicy) {
  assertNarrow(policy);
  const tokens=lex(css);
  return rules(tokens,0,tokens.length,0,'top',policy,contexts(policy));
}

/** Sanitises an SVG presentation attribute read as the value of `property`; undefined drops it. */
export function sanitizePresentationValue(property:string, value:string, policy:CssPolicy) {
  assertNarrow(policy);
  const tokens=lex(value);
  return allowed(tokens,0,tokens.length,contexts(policy).value,policy.fragmentUrlProperties.has(property.toLowerCase())) ? serialize(tokens,0,tokens.length) : undefined;
}
