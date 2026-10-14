import {types} from 'node:util';
import {z} from 'zod';
import {eventInput,InputError} from './validation.ts';
import {cleanText} from './context-input.ts';
import {normalizeDimensions,normalizeProperties,type NormalizedProperties} from './analytics-input.ts';
import {boundedTimestampInput} from './annotation-input.ts';

export const identifyBodyLimit=16384;
export type IdentifyInput={type:'identify';siteKey:string;requestId:string;sentAt:string;url:string;properties:NormalizedProperties;
  dimensions?:{distinctId?:string};context?:string;consent?:{analytics:true;epoch:string}};
const input=eventInput.pick({siteKey:true,url:true,context:true,consent:true}).extend({
  type:z.literal('identify'),requestId:z.uuid(),sentAt:boundedTimestampInput.refine(value=>{
    const date=new Date(value),year=date.getUTCFullYear();
    return !value.endsWith('-00:00')&&Number.isFinite(date.getTime())&&year>=1970&&year<=9998;
  }).transform(value=>new Date(value).toISOString()),properties:z.unknown(),dimensions:z.unknown().optional(),
}).strict();
function bad():never{throw new InputError(400,'Check the identify fields, types and limits.');}
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))bad();
  for(const key of Reflect.ownKeys(value)){
    const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
    if(typeof key!=='string'||!descriptor.enumerable||!('value'in descriptor)||descriptor.value===undefined)bad();
  }
  return value as Record<string,unknown>;
}

// Syntax and normalization only. Current authorization, consent and request age
// belong in the transaction; sentAt never decides which property update is latest.
export function parseIdentifyInput(raw:unknown):IdentifyInput{
  const data=object(raw);
  if(Object.hasOwn(data,'consent'))object(data.consent);
  const parsed=input.safeParse(data);if(!parsed.success)bad();
  const value=parsed.data;
  if(value.url.length>2048||!cleanText(value.url)||value.context!==undefined&&(value.context.length>1024||!cleanText(value.context)))bad();
  const properties=object(value.properties);
  // The SDK consumes its top-level id shortcut before making this request.
  // Nested ordinary caller data is not an identity shortcut or a PII guarantee.
  if(Object.hasOwn(properties,'id'))bad();
  const normalized=normalizeProperties(properties);
  let dimensions:{distinctId?:string}|undefined;
  if(Object.hasOwn(data,'dimensions')){
    const source=object(value.dimensions);if(Object.keys(source).some(key=>key!=='distinctId'))bad();
    dimensions=normalizeDimensions(source);
  }
  return {type:value.type,siteKey:value.siteKey,requestId:value.requestId,sentAt:value.sentAt,url:value.url,properties:normalized,
    ...(dimensions?{dimensions}:{}),...(value.context!==undefined?{context:value.context}:{}),...(value.consent?{consent:value.consent}:{})};
}
