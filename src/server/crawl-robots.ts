import {toUSVString} from 'node:util';

export const ROBOTS_MAX_BYTES = 512 * 1024;
export const ROBOTS_MAX_MATCH_WORK = 2_000_000;
const MAX_URL_BYTES = 2048, MAX_SITEMAPS = 100;

type Rule = Readonly<{pattern:string; allow:boolean; line:number; specificity:number}>;
type Unavailable = Readonly<{status:'unavailable'; reason:string}>;
export type RobotsPolicy = Unavailable | Readonly<{
  status:'ready'; origin:string; productToken:string; rules:readonly Rule[];
  sitemaps:readonly string[]; crawlDelaySeconds:number|null;
}>;
export type RobotsDecision = Readonly<{
  status:'allowed'|'disallowed'|'unavailable'; reason:string;
  matchedLine:number|null; crawlDelaySeconds:number|null; work:number;
}>;
const unavailable = (reason:string):Unavailable => Object.freeze({status:'unavailable',reason});
const trim = (value:string) => value.replace(/^[ \t]+|[ \t]+$/g,'');
const token = (value:string) => /^[a-z_-]+$/i.test(value) && !value.endsWith('\n');

function webUrl(value:string):URL|null {
  if(typeof value!=='string'||!/^https?:\/\//i.test(value)||value.length>MAX_URL_BYTES||toUSVString(value)!==value||Buffer.byteLength(value)>MAX_URL_BYTES||/[\u0000-\u0020\u007f\\]/u.test(value))return null;
  try {
    const url=new URL(value);
    const authority=value.slice(value.indexOf('//')+2).split(/[/?#]/,1)[0];
    return authority&&!authority.includes('@')&&!url.username&&!url.password&&Buffer.byteLength(url.href)<=MAX_URL_BYTES ? url : null;
  } catch {return null;}
}

// Canonical ASCII comparison form. Encoded reserved octets stay encoded; raw rule
// * and terminal $ retain syntax, whereas literal URL * / $ become %2A / %24.
function canonical(value:string,rule:boolean):string|null {
  let output='';
  for(let i=0;i<value.length;i++) {
    const char=value[i],code=value.codePointAt(i)!;
    if(char==='%') {
      const hex=value.slice(i+1,i+3);
      if(!/^[0-9a-f]{2}$/i.test(hex))return null;
      const decoded=String.fromCharCode(Number.parseInt(hex,16));
      output+=/^[a-z0-9._~-]$/i.test(decoded)?decoded:'%'+hex.toUpperCase();i+=2;
    } else if(code>127) {
      output+=encodeURIComponent(String.fromCodePoint(code));if(code>0xffff)i++;
    } else if(char==='*')output+=rule?'*':'%2A';
    else if(char==='$')output+=rule&&i===value.length-1?'$':'%24';
    else output+=/^[a-z0-9._~:/?@!&'()+,;=\-]$/i.test(char)?char:encodeURIComponent(char);
  }
  return output;
}

/** Pure policy compilation. robotsUrl identifies the INITIAL authority, even after redirects. */
export function parseRobotsPolicy(input:{robotsUrl:string;body:string|Uint8Array;productToken:string}):RobotsPolicy {
  const base=webUrl(input.robotsUrl);
  if(!base||base.pathname!=='/robots.txt'||base.search||base.hash)return unavailable('invalid_robots_url');
  if(typeof input.productToken!=='string'||input.productToken.length>128||!token(input.productToken))return unavailable('invalid_product_token');
  let text:string;
  if(typeof input.body==='string') {
    if(input.body.length>ROBOTS_MAX_BYTES||Buffer.byteLength(input.body)>ROBOTS_MAX_BYTES)return unavailable('body_limit');
    if(toUSVString(input.body)!==input.body)return unavailable('invalid_utf8');
    text=input.body;
  } else if(input.body instanceof Uint8Array) {
    if(input.body.byteLength>ROBOTS_MAX_BYTES)return unavailable('body_limit');
    try {text=new TextDecoder('utf-8',{fatal:true}).decode(input.body);}catch{return unavailable('invalid_utf8');}
  } else return unavailable('invalid_body');
  text=text.replace(/^\uFEFF/u,'');
  type Group={agents:string[];rules:{value:string;allow:boolean;line:number}[];delays:string[];hasRule:boolean};
  const groups:Group[]=[],sitemaps:string[]=[];
  let group:Group|undefined;
  for(const [index,raw] of text.split(/\r\n|\r|\n/).entries()) {
    const line=trim(raw.split('#',1)[0]),colon=line.indexOf(':');
    if(colon<0||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(line))continue;
    const field=trim(line.slice(0,colon)).toLowerCase(),value=trim(line.slice(colon+1));
    if(field==='user-agent') {
      if(value!=='*'&&!token(value))continue;
      if(!group||group.hasRule){group={agents:[],rules:[],delays:[],hasRule:false};groups.push(group);}
      group.agents.push(value.toLowerCase());
    } else if(field==='allow'||field==='disallow') {
      if(!group||value&&(!value.startsWith('/')||/[\u0000-\u0020\u007f]/u.test(value)))continue;
      group.hasRule=true;
      if(value)group.rules.push({value,allow:field==='allow',line:index+1});
    } else if(field==='crawl-delay') {
      group?.delays.push(value);
    } else if(field==='sitemap') {
      const url=webUrl(value);
      if(!url||url.hash)continue;
      if(sitemaps.length===MAX_SITEMAPS)return unavailable('sitemap_limit');
      sitemaps.push(url.href);
    }
    // Other records, including observations, never end a group. Host is ignored.
  }
  const productToken=input.productToken.toLowerCase();
  const exact=groups.filter(g=>g.agents.includes(productToken));
  const selected=exact.length?exact:groups.filter(g=>g.agents.includes('*'));
  const rules:Rule[]=[];
  let crawlDelaySeconds:number|null=null;
  for(const selectedGroup of selected) {
    for(const raw of selectedGroup.rules) {
      const pattern=canonical(raw.value,true);
      if(pattern===null)return unavailable('unsupported_rule');
      rules.push(Object.freeze({pattern,allow:raw.allow,line:raw.line,specificity:pattern.length}));
    }
    for(const delay of selectedGroup.delays) {
      if(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(delay)||!Number.isFinite(Number(delay)))return unavailable('unsupported_crawl_delay');
      crawlDelaySeconds=Math.max(crawlDelaySeconds??0,Number(delay));
    }
  }
  return Object.freeze({status:'ready',origin:base.origin,productToken,rules:Object.freeze(rules),sitemaps:Object.freeze(sitemaps),crawlDelaySeconds});
}

/** No scheduling occurs. A positive delay requires explicit caller capacity to honor it. */
export function evaluateRobotsPolicy(policy:RobotsPolicy,targetUrl:string,options:{maxCrawlDelaySeconds?:number}={}):RobotsDecision {
  let work=0;
  const result=(status:RobotsDecision['status'],reason:string,line:number|null=null):RobotsDecision=>({status,reason,matchedLine:line,crawlDelaySeconds:policy.status==='ready'?policy.crawlDelaySeconds:null,work});
  if(policy.status==='unavailable')return result('unavailable',policy.reason);
  const target=webUrl(targetUrl);
  if(!target)return result('unavailable','invalid_target_url');
  if(target.origin!==policy.origin)return result('unavailable','origin_mismatch');
  const capacity=options.maxCrawlDelaySeconds??0;
  if(!Number.isFinite(capacity)||capacity<0)return result('unavailable','invalid_delay_capacity');
  if((policy.crawlDelaySeconds??0)>capacity)return result('unavailable','crawl_delay_not_supported');
  const path=canonical(target.pathname+target.search,false);
  if(path===null)return result('unavailable','invalid_target_encoding');
  if(path==='/robots.txt')return result('allowed','implicit_robots');
  let best:Rule|undefined;
  for(const rule of policy.rules) {
    const anchored=rule.pattern.endsWith('$'),pattern=anchored?rule.pattern.slice(0,-1):rule.pattern;
    let matches=false;
    if(!pattern.includes('*')) {
      matches=!anchored||pattern.length===path.length;
      for(let i=0;matches&&i<pattern.length;i++) {
        if(work===ROBOTS_MAX_MATCH_WORK)return result('unavailable','match_work_limit');work++;
        if(pattern[i]!==path[i])matches=false;
      }
    } else {
      // ponytail: bounded O(pattern × URL) DP avoids regex/backtracking; a larger
      // crawler needs isolated parsing and measured capacity, not an unbounded loop.
      let previous=new Uint8Array(path.length+1),next=new Uint8Array(path.length+1);previous[0]=1;
      for(const char of pattern) {
        for(let j=0;j<=path.length;j++) {
          if(work===ROBOTS_MAX_MATCH_WORK)return result('unavailable','match_work_limit');work++;
          next[j]=char==='*'?(previous[j]||(j>0?next[j-1]:0)):(j>0&&char===path[j-1]?previous[j-1]:0);
        }
        [previous,next]=[next,previous];
      }
      matches=anchored?previous[path.length]===1:previous.includes(1);
    }
    if(matches&&(!best||rule.specificity>best.specificity||(rule.specificity===best.specificity&&rule.allow)))best=rule;
  }
  return result(best&&!best.allow?'disallowed':'allowed',best?'matched_rule':'no_matching_rule',best?.line??null);
}
