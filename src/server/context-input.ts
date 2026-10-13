import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {domainToASCII} from 'node:url';
import {toUSVString} from 'node:util';
import {z} from 'zod';
import {FoundationError} from './auth.ts';

export const sectionKeys=['business_overview','current_goal','positioning','writing_preferences'] as const;
export const citationPublisherCategories=['editorial','reviews','ecommerce','social','developer','pr','reference','institutional','other'] as const;
export type CitationPublisherCategory=typeof citationPublisherCategories[number];
export const cleanText=(value:string)=>toUSVString(value)===value&&!value.includes('\0');
export const text=(max:number,min=0)=>z.string().trim().min(min).max(max).refine(cleanText);
export const revision=z.number().int().positive().max(2147483646);
export const names=z.array(text(120,1)).max(20).transform(values=>[...new Set(values)]);
export function parse<S extends z.ZodType>(schema:S,value:unknown):z.output<S> {
  const result=schema.safeParse(value);
  if(!result.success) throw new FoundationError(400,'Check the submitted fields and limits, then try again.');
  return result.data;
}
export function contextHost(input:string):string {
  const bad=()=>new FoundationError(400,'Enter a public hostname without a scheme, path, port or wildcard.');
  if(!cleanText(input)||!input||input.length>1024||/[\s\u0000-\u001f\u007f%/\\:@?#*]/u.test(input)) throw bad();
  const ascii=domainToASCII(input.endsWith('.')?input.slice(0,-1):input).toLowerCase();
  const reserved=['localhost','local','internal','invalid','test','example','onion','home.arpa'];
  if(!ascii||ascii.length>253||isIP(ascii)||reserved.some(s=>ascii===s||ascii.endsWith(`.${s}`))) throw bad();
  const labels=ascii.split('.');
  if(labels.length<2||labels.some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))||/^\d+$/.test(labels.at(-1)!)) throw bad();
  const url=new URL(`https://${ascii}`);
  if(url.hostname!==ascii||isIP(url.hostname)) throw bad();
  return ascii;
}
export function keyPageUrl(input:string):string {
  if(!cleanText(input)||/[\u0000-\u0020\u007f\\]/u.test(input)) throw new FoundationError(400,'Enter an HTTP(S) page URL without credentials or spaces.');
  let url:URL;
  try {url=new URL(input);} catch {throw new FoundationError(400,'Enter a complete HTTP(S) page URL.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password) throw new FoundationError(400,'Enter an HTTP(S) page URL without credentials.');
  contextHost(url.hostname); url.hash='';
  if(url.href.length>2048) throw new FoundationError(400,'The page URL is too long.');
  return url.href;
}
const sectionKey=z.union([z.enum(sectionKeys),z.string().max(67).regex(/^custom:[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/)]);
const host=text(1024,1).transform(contextHost);
export const contextOp=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('profile'),name:text(120,1).optional(),aliases:names.optional()}).strict(),
  z.object({kind:z.literal('citation-brand-domain'),domain:host,action:z.enum(['add','remove'])}).strict(),
  z.object({kind:z.literal('citation-category'),domain:host,category:z.enum(citationPublisherCategories).nullable()}).strict(),
  z.object({kind:z.literal('section'),key:sectionKey,title:text(120,1).optional(),content:text(4000)}).strict(),
  z.object({kind:z.literal('remove-section'),key:z.string().max(67).regex(/^custom:[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/)}).strict(),
  z.object({kind:z.literal('competitor'),primaryDomain:host,name:text(120).optional(),domains:z.array(host).min(1).max(20).optional(),aliases:names.optional(),notes:text(500).optional()}).strict(),
  z.object({kind:z.literal('remove-competitor'),id:z.uuid()}).strict(),
  z.object({kind:z.literal('key-page'),url:text(2048,1).transform(keyPageUrl),role:z.enum(['hub','spoke','money','other']).optional(),topic:text(200).optional(),notes:text(500).optional()}).strict(),
  z.object({kind:z.literal('remove-key-page'),id:z.uuid()}).strict(),
  z.object({kind:z.literal('research'),summary:text(1000,1)}).strict(),
  z.object({kind:z.literal('remove-research'),id:z.uuid()}).strict(),
]);
export const contextPatch=z.object({revision,requestId:z.uuid(),updates:z.array(contextOp).min(1).max(50)}).strict();
export const tags=z.array(text(80,1).transform(value=>value.toLowerCase()).refine(value=>value.length<=80)).max(20).transform(values=>[...new Set(values)]);
export const promptFields={text:text(2000,1),topic:text(100,1).optional(),tags:tags.optional(),enabled:z.boolean().optional()};
export const promptBatch=z.object({requestId:z.uuid(),prompts:z.array(z.object(promptFields).strict()).min(1).max(100)}).strict();
export const promptPatch=z.object({requestId:z.uuid(),revision,text:promptFields.text.optional(),topic:promptFields.topic,tags:promptFields.tags,enabled:promptFields.enabled}).strict().refine(value=>['text','topic','tags','enabled'].some(key=>key in value));
export const promptAction=z.object({requestId:z.uuid(),revision}).strict();
export function canonicalHash(value:unknown):string {
  function canonical(v:unknown):unknown {return Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):v;}
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Behavior adapted from Elmo tag-utils.ts at 3c673d0; see THIRD_PARTY_NOTICES.md. */
export function classificationTerms(name:string,website:string,aliases:string[]) {
  const terms=[name,...aliases].map(n=>n.trim().toLowerCase()).filter(Boolean);
  try {const host=new URL(website).hostname.replace(/^www\./,'').toLowerCase();terms.push(host,host.split('.')[0]);} catch {}
  return [...new Set(terms.filter(Boolean))];
}
export function classifyPrompt(value:string,name:string,website:string,aliases:string[],userTags:string[]) {
  const lower=value.toLowerCase();
  const systemIsBranded=classificationTerms(name,website,aliases).some(term=>lower.includes(term));
  const branded=userTags.includes('branded'),unbranded=userTags.includes('unbranded');
  const isBranded=branded!==unbranded?branded:systemIsBranded;
  // ponytail: preserves upstream substring matching; an explicitly versioned matcher can improve false positives later.
  return {isBranded,systemIsBranded,isOverridden:isBranded!==systemIsBranded,version:'elmo-substring-v1'};
}
