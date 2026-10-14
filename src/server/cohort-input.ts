import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {cleanText,parse,text} from './context-input.ts';
import {explorerFilters,explorerQuery} from './explorer-input.ts';

const definition=z.object({schemaVersion:z.literal(1),name:text(200,1).refine(value=>value.length<=200),query:z.string().max(20000).refine(cleanText)}).strict();
const qualificationKeys=new Set(['from','to','timeZone','kind',...explorerFilters,'propertyKey','propertyType','propertyValue','predicates']);
export type CohortDefinition={schemaVersion:1;name:string;query:string};

// Save fixed qualification dates and predicates, never report grouping or member IDs.
export function parseCohortDefinition(raw:unknown,now=new Date()):CohortDefinition{
  const input=parse(definition,raw),params=new URLSearchParams(input.query);
  for(const key of params.keys())if(!qualificationKeys.has(key))throw new FoundationError(400,'Cohorts accept qualification dates and supported predicates only.');
  if(!['from','to','timeZone'].every(key=>params.has(key)))throw new FoundationError(400,'Choose explicit cohort dates and a timezone.');
  if(params.has('path')===params.has('eventName'))throw new FoundationError(400,'Choose one cohort action: a path or an event name.');
  const value=explorerQuery(params,now),query=new URLSearchParams({from:value.from,to:value.to,timeZone:value.timeZone,kind:value.kind});
  if(value.to>explorerQuery(new URLSearchParams({timeZone:value.timeZone}),now).to)throw new FoundationError(400,'Qualification dates cannot extend into the future in the selected timezone.');
  for(const key of explorerFilters)if(Object.hasOwn(value.filters,key))query.set(key,value.filters[key]);
  if(value.property){
    query.set('propertyKey',value.property.key);query.set('propertyType',value.property.type);
    if(value.property.type!=='missing')query.set('propertyValue',JSON.stringify(value.property.value));
  }
  if(value.predicates)query.set('predicates',JSON.stringify(value.predicates));
  const normalized=query.toString();
  if(normalized.length>20000)throw new FoundationError(400,'The cohort query is too large.');
  return {schemaVersion:1,name:input.name,query:normalized};
}
