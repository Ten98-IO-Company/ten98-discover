// Saved-report CSS is rebuilt from validated slices of the author's text, so the browser tokenizes
// exactly what was checked: the output keeps no comments, no escapes and no unbalanced brackets.
// Resource loading is refused by a value-function allow-list, not by a list of known loaders;
// the share page's Content-Security-Policy remains a separate second layer.

/** CSS functions that compute colours, lengths, shapes or transforms and never fetch a resource. */
const allowedFunctions = new Set([
  'rgb','rgba','hsl','hsla','hwb','lab','lch','oklab','oklch','color','color-mix','light-dark',
  'calc','min','max','clamp','round','mod','rem','abs','sign','sin','cos','tan','asin','acos','atan','atan2','pow','sqrt','hypot','log','exp','var',
  'linear-gradient','radial-gradient','conic-gradient','repeating-linear-gradient','repeating-radial-gradient','repeating-conic-gradient',
  'translate','translatex','translatey','translatez','translate3d','scale','scalex','scaley','scalez','scale3d',
  'rotate','rotatex','rotatey','rotatez','rotate3d','skew','skewx','skewy','matrix','matrix3d','perspective',
  'blur','brightness','contrast','drop-shadow','grayscale','hue-rotate','invert','opacity','saturate','sepia',
  'cubic-bezier','steps','linear','repeat','minmax','fit-content','counter','counters',
  'inset','circle','ellipse','polygon','rect','xywh',
]);
const blockedProperties = new Set(['behavior','-moz-binding']);
/** At-rules whose block is a rule list. Every other at-rule (@import, @font-face, @namespace, ...) is dropped. */
const groupingAtRules = new Set(['media','supports','container','layer']);
const keyframesAtRules = new Set(['keyframes','-webkit-keyframes']);
const maxAtRuleDepth = 8;
// Selectors and at-rule preludes cannot fetch, but loader-shaped text is refused there too.
const loaderText = /(?:url|image|image-set|cross-fade|element|src|expression)\s*\(/iu;
const functionName = /([-\w\u{80}-\u{10FFFF}]+)\s*\(/gu;
const fragmentUrl = /url\(\s*#[A-Za-z_][\w-]*\s*\)/giu;
// CSS whitespace is space, tab, LF, CR and FF. Escapes, other control characters, markup and braces are refused.
const unsafeText = /[\\<{}\u0000-\u0008\u000b\u000e-\u001f\u007f]/u;
const closers: Record<string,string> = {'(':')','[':']','{':'}'};

// An escape, a string (ending at its quote or before a newline, as CSS Syntax does) or a comment.
const commentOrString = /\\[\s\S]?|"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?|\/\*[\s\S]*?(?:\*\/|$)/gu;
// No `u` flag: an escape skips exactly two UTF-16 units and scanning resumes there.
const structural = /[\\"'()[\]{};\n]/g;

/** Removes comments outside strings, replacing each with a space so adjacent tokens stay separate. */
function stripComments(css:string) {
  return css.replace(commentOrString,match=>match.startsWith('/*') ? ' ' : match);
}

/**
 * Reads from `start` to the first top-level character in `stops`, matching brackets and strings
 * as CSS Syntax does. `complete` is false when the slice has a stray closer or an unclosed string or bracket.
 */
function readUntil(css:string, start:number, stops:string) {
  let quote='', complete=true;
  const stack:string[]=[];
  structural.lastIndex=start;
  for (let found=structural.exec(css); found; found=structural.exec(css)) {
    const char=found[0], index=found.index;
    if (char==='\\') structural.lastIndex=index+2;
    else if (quote) {
      if (char===quote) quote='';
      else if (char==='\n') { quote=''; complete=false; }
    } else if (char==='"' || char==="'") quote=char;
    else if (!stack.length && stops.includes(char)) return {end:index,stop:char,complete};
    else if (closers[char]) stack.push(closers[char]);
    else if (char===stack.at(-1)) stack.pop();
    else if (char===')' || char===']' || char==='}') complete=false;
  }
  return {end:css.length,stop:'',complete:complete && !quote && !stack.length};
}

function safeValue(value:string, fragmentUrls=false) {
  const checked=fragmentUrls ? value.replace(fragmentUrl,' ') : value;
  for (const [,name] of checked.matchAll(functionName)) if (!allowedFunctions.has(name.toLowerCase())) return false;
  return true;
}

function safeDeclaration(declaration:string) {
  if (!declaration.trim()) return true;
  if (unsafeText.test(declaration)) return false;
  const match=/^\s*(--[\w-]+|-?[A-Za-z][\w-]*)\s*:([\s\S]*)$/u.exec(declaration);
  return !!match && !blockedProperties.has(match[1].toLowerCase()) && safeValue(match[2]);
}

function declarations(css:string) {
  const kept:string[]=[];
  for (let index=0; index<=css.length;) {
    const piece=readUntil(css,index,';');
    const declaration=css.slice(index,piece.end);
    if (piece.complete && safeDeclaration(declaration)) kept.push(declaration);
    index=piece.end+1;
  }
  return kept.join(';');
}

function safePrelude(prelude:string) {
  return !!prelude.trim() && !unsafeText.test(prelude) && !loaderText.test(prelude);
}

const atRuleName=(prelude:string)=>/^\s*@([-\w]+)/u.exec(prelude)?.[1].toLowerCase();

/** Keeps allowed `prelude{block}` rules and `@layer` statements from a rule list. */
function rules(css:string, depth:number, keyframes:boolean):string {
  let output='';
  for (let index=0; index<css.length;) {
    const head=readUntil(css,index,'{;');
    const prelude=css.slice(index,head.end);
    if (!head.stop) { if (!prelude.trim()) output+=prelude; break; }
    if (head.stop===';') {
      if (!keyframes && atRuleName(prelude)==='layer' && head.complete && safePrelude(prelude)) output+=prelude+';';
      index=head.end+1; continue;
    }
    const body=readUntil(css,head.end+1,'}');
    if (!body.stop) break;
    const block=css.slice(head.end+1,body.end), name=atRuleName(prelude);
    if (head.complete && body.complete && safePrelude(prelude)) {
      if (name===undefined) output+=prelude+'{'+declarations(block)+'}';
      else if (!keyframes && depth<maxAtRuleDepth && groupingAtRules.has(name)) output+=prelude+'{'+rules(block,depth+1,false)+'}';
      else if (!keyframes && depth<maxAtRuleDepth && keyframesAtRules.has(name)) output+=prelude+'{'+rules(block,depth+1,true)+'}';
    }
    index=body.end+1;
  }
  return output;
}

/** Sanitises a style attribute value. */
export function sanitizeDeclarations(css:string) {
  return declarations(stripComments(css));
}

/** Sanitises the text of a `<style>` element. */
export function sanitizeStylesheet(css:string) {
  return rules(stripComments(css),0,false);
}

/** Checks an SVG paint or clip attribute: only same-document `url(#id)` references may name a resource. */
export function safeSvgPaint(value:string) {
  return !unsafeText.test(value) && safeValue(value,true);
}
