import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {cleanText,parse,text} from './context-input.ts';
import {explorerFilters,explorerQuery} from './explorer-input.ts';

const definition=z.object({schemaVersion:z.literal(1),name:text(200,1).refine(value=>value.length<=200),query:z.string().max(20000).refine(cleanText)}).strict();
const predicateKeys=new Set(['kind',...explorerFilters,'propertyKey','propertyType','propertyValue']);
export type SegmentDefinition={schemaVersion:1;name:string;query:string};

// Store predicates, never the report's calendar, grouping or computed results.
export function parseSegmentDefinition(raw:unknown):SegmentDefinition{
  const input=parse(definition,raw),params=new URLSearchParams(input.query);
  for(const key of params.keys())if(!predicateKeys.has(key))throw new FoundationError(400,'Saved filters exclude report dates, timezone and grouping.');
  const value=explorerQuery(params),query=new URLSearchParams({kind:value.kind});
  for(const key of explorerFilters)if(Object.hasOwn(value.filters,key))query.set(key,value.filters[key]);
  if(value.property){
    query.set('propertyKey',value.property.key);query.set('propertyType',value.property.type);
    if(value.property.type!=='missing')query.set('propertyValue',JSON.stringify(value.property.value));
  }
  const normalized=query.toString();
  if(normalized.length>20000)throw new FoundationError(400,'The saved filter query is too large.');
  return {schemaVersion:1,name:input.name,query:normalized};
}
