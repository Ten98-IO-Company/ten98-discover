import {toUSVString} from 'node:util';
import {contextHost, citationPublisherCategories} from './context-input.ts';
import {classifyUrl} from './citation-domain-categories.ts';
import {isGoogleShoppingUrl, isGoogleSearchUrl, isGoogleRedirectUrl, normalizeUrl, resolvePageType} from './citation-taxonomy.ts';
export {googleDomainsVersion} from './citation-google-domains.ts';

export const publisherCategories = citationPublisherCategories;
export const pageTypes = ['homepage','article','listicle','howto','comparison','review','product','doc','forum','video','info','search','shopping','other'] as const;
export const sourceTypes = ['publisher','google_shopping','google_search','google_wrapper','unclassified'] as const;
export const ownershipKinds = ['untracked','brand','competitor','ambiguous'] as const;
export const classifierVersion = 'elmo-3c673d0-native-axes-v1';
export const ownershipVersion = 'citation-host-suffix-v1';
export type PublisherCategory = typeof publisherCategories[number];
export type PageType = typeof pageTypes[number];
export type SourceType = typeof sourceTypes[number];
export type OwnershipKind = typeof ownershipKinds[number];
export type UrlGrouping = 'retained-fragment-v1'|'elmo-url-v1';
export type CitationOwnership = {brand:boolean;competitorIds:string[];ambiguous:boolean};
export type CitationClassification = {
  ownership:CitationOwnership;publisherCategory:PublisherCategory;
  publisherBasis:'override'|'elmo-automatic'|'unclassified';
  automaticPublisherCategory:PublisherCategory;pageType:PageType;
  pageTypeBasis:'elmo-url-title-heuristic-v1';sourceType:SourceType;
};

function retainedUrl(value:string):URL {
  if(typeof value!=='string'||value.length>2048||toUSVString(value)!==value||value.includes('\0'))throw new Error('Invalid retained citation URL.');
  let url:URL;
  try{url=new URL(value);}catch{throw new Error('Invalid retained citation URL.');}
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Invalid retained citation URL.');
  return url;
}

export function groupCitationUrl(value:string,method:UrlGrouping):string {
  const url=retainedUrl(value);
  if(method==='elmo-url-v1')return normalizeUrl(value);
  if(method!=='retained-fragment-v1')throw new Error('Invalid citation grouping method.');
  url.hash='';return url.href;
}

export function createCitationClassifier(input:{
  brandDomains:string[];competitors:{id:string;domains:string[]}[];
  overrides:{domain:string;category:PublisherCategory}[];
}):(url:string,title:string|null)=>{hostname:string|null;trackable:boolean;classification:CitationClassification} {
  if(!Array.isArray(input.brandDomains)||input.brandDomains.length>20||!Array.isArray(input.competitors)||input.competitors.length>100||!Array.isArray(input.overrides)||input.overrides.length>100)throw new Error('Invalid citation classification context.');
  const owners=new Map<string,Set<string>>(),ids=new Set<string>();
  const add=(domain:string,id:string)=>{
    const host=contextHost(domain).replace(/^www\./,'');
    const set=owners.get(host)??new Set<string>();set.add(id);owners.set(host,set);
  };
  for(const host of input.brandDomains)add(host,'brand');
  for(const competitor of input.competitors){
    if(!competitor||typeof competitor.id!=='string'||!competitor.id||competitor.id.length>100||competitor.id==='brand'||ids.has(competitor.id)||!Array.isArray(competitor.domains)||competitor.domains.length>20)throw new Error('Invalid citation classification context.');
    ids.add(competitor.id);for(const host of competitor.domains)add(host,competitor.id);
  }
  const overrides=new Map<string,PublisherCategory>();
  for(const override of input.overrides){
    const host=contextHost(override.domain);
    if(!publisherCategories.includes(override.category)||overrides.has(host))throw new Error('Invalid citation category override.');
    overrides.set(host,override.category);
  }
  const empty=new Set<string>();
  return (value,title)=>{
    const url=retainedUrl(value);
    if(title!==null&&(typeof title!=='string'||toUSVString(title)!==title||title.includes('\0')))throw new Error('Invalid retained citation title.');
    let hostname:string|null;
    try{hostname=contextHost(url.hostname);}catch{hostname=null;}
    const matched=new Set<string>();
    if(hostname){
      let suffix=hostname.replace(/^www\./,'');
      while(suffix.includes('.')){
        for(const id of owners.get(suffix)??[])matched.add(id);
        suffix=suffix.slice(suffix.indexOf('.')+1);
      }
    }
    const brand=matched.delete('brand'),competitorIds=[...matched].sort();
    const ownership={brand,competitorIds,ambiguous:competitorIds.length>1||brand&&competitorIds.length>0};
    const automaticPublisherCategory=hostname?classifyUrl(hostname,value,title,empty,empty) as PublisherCategory:'other';
    const override=hostname?overrides.get(hostname):undefined;
    const sourceType:SourceType=!hostname?'unclassified':isGoogleShoppingUrl(value)?'google_shopping':isGoogleSearchUrl(value)?'google_search':isGoogleRedirectUrl(value)?'google_wrapper':'publisher';
    return {hostname,trackable:hostname!==null,classification:{
      ownership,publisherCategory:override??automaticPublisherCategory,
      publisherBasis:!hostname?'unclassified':override?'override':'elmo-automatic',automaticPublisherCategory,
      pageType:resolvePageType(value,title,automaticPublisherCategory),pageTypeBasis:'elmo-url-title-heuristic-v1',sourceType,
    }};
  };
}
