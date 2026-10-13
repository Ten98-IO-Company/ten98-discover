import {normalizePublicHostname} from './domains.ts';
import {validText} from './keyword-research-input.ts';
import {parseRankSerpRequest,type RankSerpRequest} from './rank-serp-input.ts';

export type RankObservation={
  status:'ranked'|'not_found';position:number|null;rankBasis:'organic'|'absolute';
  absolutePosition:number|null;rankingUrl:string|null;checkedDepth:number;
  returnedItemCount:number;pagesCount:number;serpFeatures:string[];
  observedAt:string;retrievedAt:string;
};
type RecordValue=Record<string,unknown>;
const object=(v:unknown):v is RecordValue=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const itemType=(v:unknown):v is string=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(v);
function invalid():never{throw new Error('The SERP observation could not be verified.');}
function observedTime(value:unknown,now:Date){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?: ?\+00:00|Z)$/.test(value))invalid();
  const normalized=value.replace(' ','T').replace(' +00:00','+00:00'),date=new Date(normalized);
  // Date accepts invalid civil dates by rolling into the next month.
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,19)!==normalized.slice(0,19)||date.getTime()>now.getTime()+300_000)invalid();
  return date.toISOString();
}
function resultUrl(value:unknown){
  if(!validText(value,4096))invalid();
  let url:URL;try{url=new URL(value);}catch{invalid();}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)invalid();
  let host:string;try{host=normalizePublicHostname(url.hostname);}catch{invalid();}
  return {url:url.href,host};
}

/** Interpret one already-bound task's result, never its identity or charge.
 * Provider item_types are SERP-wide; they do not imply the target owns a feature.
 * Callers must independently prove the account, tag, task and captured request.
 */
export function parseRankObservation(raw:unknown,rawRequest:RankSerpRequest,now=new Date()):RankObservation{
  const request=parseRankSerpRequest(rawRequest);
  if(!Number.isFinite(now.getTime())||!object(raw)||raw.type!=='organic'||raw.keyword!==request.keyword||raw.location_code!==request.locationCode||raw.language_code!==request.languageCode||
    !Array.isArray(raw.items)||raw.items.length>10000||raw.items_count!==raw.items.length||!integer(raw.pages_count,0,request.maxCrawlPages)||
    !Array.isArray(raw.item_types)||raw.item_types.length>100||!raw.item_types.every(itemType))invalid();
  const observedAt=observedTime(raw.datetime,now),types=new Set<string>(raw.item_types);
  if(types.size!==raw.item_types.length)invalid();
  const organic:Array<{group:number|null;absolute:number;url:string;host:string}>=[];
  const absoluteRanks=new Set<number>(),groupRanks=new Set<number>();
  for(const item of raw.items){
    if(!object(item)||!itemType(item.type)||!types.has(item.type))invalid();
    if(item.type!=='organic')continue; // Nested sitelinks and paid items are not organic positions.
    if(!integer(item.rank_absolute,1,10000)||!integer(item.page,1,raw.pages_count)||absoluteRanks.has(item.rank_absolute))invalid();
    absoluteRanks.add(item.rank_absolute);
    const group=item.rank_group==null?null:item.rank_group;
    if(group!==null){if(!integer(group,1,10000)||group>item.rank_absolute||groupRanks.has(group))invalid();groupRanks.add(group);}
    const link=resultUrl(item.url);
    if(item.domain!=null){let domain:string;try{domain=normalizePublicHostname(item.domain);}catch{invalid();}if(domain!==link.host)invalid();}
    organic.push({group,absolute:item.rank_absolute,...link});
  }
  if(raw.pages_count===0&&raw.items.length>0)invalid();
  // Never mix organic and absolute measurements in one observation. Absolute is
  // an explicitly labelled fallback only when every organic group rank is absent.
  const hasGroups=organic.some(item=>item.group!==null);
  if(hasGroups&&organic.some(item=>item.group===null))invalid();
  if(hasGroups){
    const ordered=[...organic].sort((a,b)=>a.group!-b.group!);
    if(ordered.some((item,index)=>index>0&&item.absolute<=ordered[index-1].absolute))invalid();
  }
  const rankBasis=hasGroups||organic.length===0?'organic':'absolute';
  const position=(item:typeof organic[number])=>rankBasis==='organic'?item.group!:item.absolute;
  let match:typeof organic[number]|undefined,checkedDepth=0;
  for(const item of organic){
    if((item.host===request.domain||item.host.endsWith('.'+request.domain))&&(!match||position(item)<position(match)))match=item;
  }
  // A gap cannot establish absence below a later observed match. Absolute-only
  // fallback preserves the match, but claims no prefix without all item types.
  while(rankBasis==='organic'&&checkedDepth<request.depth&&groupRanks.has(checkedDepth+1))checkedDepth++;
  return {status:match?'ranked':'not_found',position:match?position(match):null,rankBasis,
    absolutePosition:match?.absolute??null,rankingUrl:match?.url??null,
    checkedDepth,returnedItemCount:raw.items.length,pagesCount:raw.pages_count,
    serpFeatures:[...types].filter(type=>type!=='organic').sort(),observedAt,retrievedAt:now.toISOString()};
}
