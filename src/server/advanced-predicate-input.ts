import {types} from 'node:util';
import {z} from 'zod';
import {normalizeProperties,type PropertyPrimitive} from './analytics-input.ts';
import {cleanText} from './context-input.ts';
import {InputError} from './validation.ts';

export const predicateFields=['eventName','path','origin','referrer','language','browser','os','device','campaignSource','campaignMedium','campaignName','campaignTerm','campaignContent'] as const;
type Field=typeof predicateFields[number];
type Presence='exists'|'missing';
type Equality='eq'|'neq';
type TextOperator=Equality|'contains'|'not_contains'|'prefix'|'suffix'|'regex'|'not_regex';
type NumberOperator=Equality|'gt'|'gte'|'lt'|'lte';
export type AdvancedFieldPredicate={field:Field;operator:Presence}|{field:Field;operator:TextOperator;value:string};
export type AdvancedPropertyPredicate=
  |{key:string;operator:Presence}
  |{key:string;operator:TextOperator;type:'string';value:string}
  |{key:string;operator:NumberOperator;type:'number';value:number}
  |{key:string;operator:Equality;type:'boolean';value:boolean}
  |{key:string;operator:Equality;type:'null';value:null}
  |{key:string;operator:Equality|'before'|'after';type:'date';value:string}
  |{key:string;operator:Equality;type:'array';value:PropertyPrimitive[]}
  |{key:string;operator:'includes'|'not_includes';type:'array';value:PropertyPrimitive};
export type AdvancedPredicates={version:1;match:'all'|'any';fields:AdvancedFieldPredicate[];properties:AdvancedPropertyPredicate[];sessionProperties?:AdvancedPropertyPredicate[]};
const textOperators=['eq','neq','contains','not_contains','prefix','suffix','regex','not_regex'];
function bad():never{throw new InputError(400,'Check the additional filters, their types and limits.');}
function literal(value:unknown,max:number,empty=false):string{
  if(typeof value!=='string'||(!empty&&!value.length)||value.length>max||!cleanText(value))bad();
  return value;
}
// The public parser accepts data only; do not invoke getters or serialization hooks.
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))bad();
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))bad();
  const out:Record<string,unknown>=Object.create(null);
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||!keys.includes(key))bad();
    const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
    if(!descriptor.enumerable||!('value' in descriptor))bad();
    out[key]=descriptor.value;
  }
  return out;
}
function array(value:unknown,max:number):unknown[]{
  if(!Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max||Reflect.ownKeys(value).length!==value.length+1)bad();
  return Array.from({length:value.length},(_,index)=>{
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
    if(!descriptor?.enumerable||!('value' in descriptor))bad();
    return descriptor.value;
  });
}
function fieldPredicate(raw:unknown):AdvancedFieldPredicate{
  const input=object(raw,['field','operator','value']),field=input.field as Field,operator=input.operator as TextOperator|Presence;
  if(!predicateFields.includes(field))bad();
  if(operator==='exists'||operator==='missing'){
    if(Object.hasOwn(input,'value'))bad();
    return {field,operator};
  }
  if(!textOperators.includes(operator))bad();
  const value=literal(input.value,['path','origin'].includes(field)?2048:320,operator==='eq'||operator==='neq');
  if(field==='origin'&&(operator==='eq'||operator==='neq')){
    try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.origin!==value)bad();}catch{bad();}
  }
  return {field,operator,value};
}
function propertyPredicate(raw:unknown):AdvancedPropertyPredicate{
  const input=object(raw,['key','operator','type','value']),key=literal(input.key,320),operator=input.operator;
  if(operator==='exists'||operator==='missing'){
    if(Object.hasOwn(input,'type')||Object.hasOwn(input,'value'))bad();
    return {key,operator};
  }
  if(!Object.hasOwn(input,'value'))bad();
  const type=input.type,rawValue=input.value;
  if(type==='date'&&(operator==='before'||operator==='after')){
    const value=literal(rawValue,10);
    if(!z.iso.date().safeParse(value).success||value<'1970-01-01'||value>'9998-12-31')bad();
    return {key,operator,type,value};
  }
  if(type==='array'&&(operator==='includes'||operator==='not_includes')){
    const normalized=normalizeProperties({value:[rawValue]}).value;
    if(normalized.type!=='array')bad();
    return {key,operator,type,value:normalized.value[0]};
  }
  const normalized=normalizeProperties({value:rawValue}).value;
  if(type==='string'){
    if(typeof operator!=='string'||!textOperators.includes(operator))bad();
    return {key,operator:operator as TextOperator,type,value:literal(rawValue,1000,operator==='eq'||operator==='neq')};
  }
  if(!normalized||normalized.type!==type)bad();
  if(type==='number'&&normalized.type==='number'){
    if(!['eq','neq','gt','gte','lt','lte'].includes(operator as string))bad();
    return {key,operator:operator as NumberOperator,type,value:normalized.value};
  }
  if(operator!=='eq'&&operator!=='neq')bad();
  switch(normalized.type){
    case 'boolean':return {key,operator,type:'boolean',value:normalized.value};
    case 'null':return {key,operator,type:'null',value:null};
    case 'date':return {key,operator,type:'date',value:normalized.value};
    case 'array':return {key,operator,type:'array',value:normalized.value};
    default:return bad();
  }
}

// Flat groups only. Existing exact filters remain a separate required AND group.
// Returned member order is the canonical wire order; repeated clauses stay ordered.
export function parseAdvancedPredicates(raw:unknown):AdvancedPredicates{
  const input=object(raw,['version','match','fields','properties','sessionProperties']);
  if(input.version!==1||(input.match!=='all'&&input.match!=='any'))bad();
  const fields=array(input.fields,20),properties=array(input.properties,10),sessionProperties=Object.hasOwn(input,'sessionProperties')?array(input.sessionProperties,10):[];
  const propertyCount=properties.length+sessionProperties.length,total=fields.length+propertyCount;
  if(!total||total>20||propertyCount>10||(input.match==='any'&&!fields.length))bad();
  const result:AdvancedPredicates={version:1,match:input.match,fields:fields.map(fieldPredicate),properties:properties.map(propertyPredicate),
    ...(sessionProperties.length?{sessionProperties:sessionProperties.map(propertyPredicate)}:{})};
  if(new URLSearchParams({predicates:JSON.stringify(result)}).toString().length>20000)bad();
  return result;
}
