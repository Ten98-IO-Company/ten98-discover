import {isIP} from 'node:net';
import {toUSVString} from 'node:util';
import {redirectUrl} from './domain-redirect-network.ts';

const URL_LIMIT=2048, HEADER_LIMIT=16384, DATE_LIMIT=8_640_000_000_000_000;
export type AuditExclusion='invalid_scope'|'invalid_base'|'invalid_input'|'too_long'|'invalid_unicode'|'invalid_characters'|'invalid_percent_encoding'|'userinfo'|'query'|'blocked_url'|'outside_origin';
export type AuditCandidate={status:'accepted';url:string}|{status:'excluded';reason:AuditExclusion};

function syntaxIssue(raw:unknown):AuditExclusion|null {
  if(typeof raw!=='string'||!raw)return 'invalid_input';
  if(raw.length>URL_LIMIT||Buffer.byteLength(raw)>URL_LIMIT)return 'too_long';
  if(toUSVString(raw)!==raw)return 'invalid_unicode';
  if(/[\p{Cc} \\]/u.test(raw))return 'invalid_characters';
  let decoded:string;
  try{decoded=decodeURIComponent(raw);}catch{return 'invalid_percent_encoding';}
  if(/[\p{Cc}\\]/u.test(decoded))return 'invalid_characters';
  const authority=/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(raw)?.[1];
  if(authority?.includes('@'))return 'userinfo';
  if(raw.split('#',1)[0].includes('?'))return 'query';
  return null;
}
function publicUrl(raw:string,base?:URL):URL|null {
  if(syntaxIssue(raw))return null;
  try{return redirectUrl(raw,base);}catch{return null;}
}
function scopeOrigin(raw:string):URL|null {
  const url=publicUrl(raw);
  return url&&url.protocol==='https:'&&url.origin===raw&&!isIP(url.hostname.replace(/^\[|\]$/g,''))?url:null;
}
/** Admission is not authority, robots permission or DNS validation. All are rechecked by the worker. */
export function resolveAuditCandidate(raw:string,baseUrl:string,origin:string):AuditCandidate {
  const scope=scopeOrigin(origin);
  if(!scope)return {status:'excluded',reason:'invalid_scope'};
  const base=publicUrl(baseUrl);
  if(!base||base.origin!==scope.origin)return {status:'excluded',reason:'invalid_base'};
  const issue=syntaxIssue(raw);
  if(issue)return {status:'excluded',reason:issue};
  const url=publicUrl(raw,base);
  if(!url)return {status:'excluded',reason:'blocked_url'};
  if(url.origin!==scope.origin)return {status:'excluded',reason:'outside_origin'};
  return {status:'accepted',url:url.href};
}
/** The returned policyOrigin stays fixed even when a robots redirect crosses origins. */
export function resolveRobotsRedirect(raw:string,currentUrl:string,policyOrigin:string):{status:'accepted';url:string;policyOrigin:string}|{status:'excluded';reason:AuditExclusion} {
  if(!scopeOrigin(policyOrigin))return {status:'excluded',reason:'invalid_scope'};
  const base=publicUrl(currentUrl);
  if(!base)return {status:'excluded',reason:'invalid_base'};
  const issue=syntaxIssue(raw);
  if(issue)return {status:'excluded',reason:issue};
  const url=publicUrl(raw,base);
  return url?{status:'accepted',url:url.href,policyOrigin}:{status:'excluded',reason:'blocked_url'};
}

export type AuditRetryAfter='absent'|'malformed'|'delta_seconds'|'http_date'|'capacity_exceeded';
export type AuditPacing={status:'ready'|'cannot_fit';nextRequestAtMs:number|null;retryAfter:AuditRetryAfter}|{status:'invalid_input'};
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const longDays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function validTime(value:unknown):value is number {return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=DATE_LIMIT;}
function calendar(year:number,month:number,day:number,hour:number,minute:number,second:number):number|null {
  if(year<1900||month<0||day<1||day>31||hour>23||minute>59||second>60)return null;
  const date=new Date(0);date.setUTCFullYear(year,month,day);date.setUTCHours(hour,minute,Math.min(second,59),0);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month||date.getUTCDate()!==day)return null;
  // A leap second is conservatively mapped to the following instant, never earlier.
  return date.getTime()+(second===60?1000:0);
}
/** RFC 9110 section 5.6.7: exact three wire grammars, rather than permissive Date.parse. */
function httpDate(value:string,nowMs:number):number|null {
  let match:RegExpExecArray|null,dayName:string,year:number,month:number,day:number,hour:number,minute:number,second:number,obsolete=false;
  if((match=/^([A-Z][a-z]{2}), ([0-9]{2}) ([A-Z][a-z]{2}) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(value))){
    [,dayName]=match;day=Number(match[2]);month=months.indexOf(match[3]);year=Number(match[4]);hour=Number(match[5]);minute=Number(match[6]);second=Number(match[7]);
  }else if((match=/^([A-Z][a-z]+), ([0-9]{2})-([A-Z][a-z]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(value))){
    dayName=weekdays[longDays.indexOf(match[1])];day=Number(match[2]);month=months.indexOf(match[3]);year=Number(match[4]);hour=Number(match[5]);minute=Number(match[6]);second=Number(match[7]);obsolete=true;
  }else if((match=/^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ([0-9]{2}| [0-9]) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(value))){
    [,dayName]=match;month=months.indexOf(match[2]);day=Number(match[3]);hour=Number(match[4]);minute=Number(match[5]);second=Number(match[6]);year=Number(match[7]);
  }else return null;
  if(obsolete){
    const horizon=new Date(nowMs);horizon.setUTCFullYear(horizon.getUTCFullYear()+50);
    if(!Number.isFinite(horizon.getTime()))return null;
    year=Math.floor(horizon.getUTCFullYear()/100)*100+year;
    const candidate=calendar(year,month,day,hour,minute,second);
    if(candidate!==null&&candidate>horizon.getTime())year-=100;
  }
  const time=calendar(year,month,day,hour,minute,second);
  if(time===null||weekdays[new Date(time-(second===60?1000:0)).getUTCDay()]!==dayName)return null;
  return time;
}

/** Calculate a persisted schedule; ready does not authorize immediate dispatch or reset budgets. */
export function planAuditRequest(input:{nowMs:number;nextRequestAtMs:number|null;deadlineMs:number;retryAfter?:string|null}):AuditPacing {
  if(!input||!validTime(input.nowMs)||!validTime(input.deadlineMs)||(input.nextRequestAtMs!==null&&!validTime(input.nextRequestAtMs))||(input.retryAfter!=null&&typeof input.retryAfter!=='string'))return {status:'invalid_input'};
  let next=Math.max(input.nextRequestAtMs??0,input.nowMs+1000),retryAfter:AuditRetryAfter='absent';
  if(input.retryAfter!=null){
    const raw=input.retryAfter;
    if(raw.length>HEADER_LIMIT||Buffer.byteLength(raw)>HEADER_LIMIT)return {status:'cannot_fit',nextRequestAtMs:null,retryAfter:'capacity_exceeded'};
    const value=raw.replace(/^[ \t]+|[ \t]+$/g,'');
    retryAfter='malformed';
    if(value&&!/[^0-9]/.test(value)){
      retryAfter='delta_seconds';
      // Compare bounded decimal text first; a huge valid delay is never an early-retry fallback.
      const digits=value.replace(/^0+/,'')||'0';
      if(digits.length>13)return {status:'cannot_fit',nextRequestAtMs:null,retryAfter};
      const target=BigInt(input.nowMs)+BigInt(digits)*1000n;
      if(target>BigInt(DATE_LIMIT))return {status:'cannot_fit',nextRequestAtMs:null,retryAfter};
      next=Math.max(next,Number(target));
    }else if(/^[\x20-\x7e]*$/.test(value)){
      const time=httpDate(value,input.nowMs);
      if(time!==null){retryAfter='http_date';next=Math.max(next,time);}
    }
  }
  return {status:next<input.deadlineMs?'ready':'cannot_fit',nextRequestAtMs:next<=DATE_LIMIT?next:null,retryAfter};
}
