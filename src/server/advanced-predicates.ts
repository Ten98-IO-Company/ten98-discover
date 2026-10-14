import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import type {AdvancedPredicates,AdvancedPropertyPredicate} from './advanced-predicate-input.ts';

const fields={eventName:'s.event_name',path:'s.path',origin:'s.origin',referrer:"s.dimensions->>'referrerHost'",language:"s.dimensions->>'language'",
  browser:"s.dimensions->>'browser'",os:"s.dimensions->>'os'",device:"s.dimensions->>'device'",
  campaignSource:"s.dimensions->'campaign'->>'source'",campaignMedium:"s.dimensions->'campaign'->>'medium'",campaignName:"s.dimensions->'campaign'->>'campaign'",
  campaignTerm:"s.dimensions->'campaign'->>'term'",campaignContent:"s.dimensions->'campaign'->>'content'"} as const;
type Bind=(value:unknown)=>string;
function textPredicate(column:string,operator:string,value:string){
  switch(operator){
    case 'eq':return `${column}=${value}`;
    case 'neq':return `${column}<>${value}`;
    case 'contains':return `strpos(lower(${column}),lower(${value}))>0`;
    case 'not_contains':return `strpos(lower(${column}),lower(${value}))=0`;
    case 'prefix':return `starts_with(lower(${column}),lower(${value}))`;
    case 'suffix':return `right(lower(${column}),char_length(lower(${value})))=lower(${value})`;
    case 'regex':return `${column} ~* ${value}`;
    case 'not_regex':return `${column} !~* ${value}`;
    default:throw new FoundationError(400,'Unsupported additional filter operator.');
  }
}
function propertyPredicate(filter:AdvancedPropertyPredicate,bind:Bind,timeZone:string):string{
  const key=bind(filter.key)+'::text',property=`s.properties->${key}`;
  if(filter.operator==='exists')return `(s.properties ? ${key})`;
  if(filter.operator==='missing')return `NOT (s.properties ? ${key})`;
  return propertyValuePredicate(filter,bind,timeZone,property);
}
function propertyValuePredicate(filter:AdvancedPropertyPredicate,bind:Bind,timeZone:string,property:string):string{
  if(!('type' in filter))throw new FoundationError(400,'Unsupported additional property filter.');
  const type=bind(filter.type)+'::text',jsonType=bind(filter.type==='date'?'string':filter.type)+'::text';
  const guard=`${property}->>'type'=${type} AND jsonb_typeof(${property}->'value')=${jsonType}`;
  const value=`${property}->'value'`,text=`${property}->>'value'`;
  let condition:string;
  if(filter.type==='date'&&(filter.operator==='before'||filter.operator==='after')){
    // Native dates are normalized UTC strings with arbitrary fractional precision.
    // Day comparison discards the fraction rather than rounding across midnight.
    condition=`CASE WHEN left(${text},4)='0000' THEN ${filter.operator==='before'?'TRUE':'FALSE'} ELSE
      (((left(${text},19)||'Z')::timestamptz AT TIME ZONE ${bind(timeZone)}::text)::date ${filter.operator==='before'?'<':'>'} ${bind(filter.value)}::date) END`;
  }else if(filter.type==='number'&&['gt','gte','lt','lte'].includes(filter.operator)){
    const operator={gt:'>',gte:'>=',lt:'<',lte:'<='}[filter.operator as 'gt'|'gte'|'lt'|'lte'];
    condition=`(${text})::numeric ${operator} ${bind(filter.value)}::numeric`;
  }else if(filter.operator==='eq'||filter.operator==='neq'){
    condition=`${value}${filter.operator==='eq'?'=':'<>'}${bind(JSON.stringify(filter.value))}::jsonb`;
  }else if(filter.type==='array'){
    condition=`${filter.operator==='not_includes'?'NOT ':''}(${value} @> jsonb_build_array(${bind(JSON.stringify(filter.value))}::jsonb))`;
  }else{
    condition=textPredicate(text,filter.operator,bind(filter.value)+'::text');
  }
  // CASE prevents casts or type-specific operations from running on another type.
  return `(CASE WHEN ${guard} THEN (${condition}) ELSE FALSE END)`;
}

// All SQL identifiers/operators come from fixed maps. Only values use the caller's
// append-only binder, after the unchanged report/qualification parameter slots.
export function advancedPredicateSql(predicates:AdvancedPredicates|undefined,bind:Bind,timeZone:string):string{
  if(!predicates)return 'TRUE';
  const ordinary=predicates.fields.map(filter=>{
    const column=fields[filter.field];
    if(filter.operator==='exists')return `(${column} IS NOT NULL)`;
    if(filter.operator==='missing')return `(${column} IS NULL)`;
    if(!('value' in filter))throw new FoundationError(400,'Unsupported additional field filter.');
    return `COALESCE((${textPredicate(column,filter.operator,bind(filter.value)+'::text')}),FALSE)`;
  });
  return [...(ordinary.length?[`(${ordinary.join(predicates.match==='any'?' OR ':' AND ')})`]:[]),
    ...predicates.properties.map(filter=>propertyPredicate(filter,bind,timeZone))].join(' AND ')||'TRUE';
}
export function sessionPredicateSql(filters:AdvancedPropertyPredicate[]|undefined,bind:Bind,timeZone:string):string{
  if(!filters?.length)return 'TRUE';
  const conditions=filters.map(filter=>{
    const key=bind(filter.key)+'::text';
    const present=`SELECT 1 FROM analytics_session_property sp CROSS JOIN session_context c
      WHERE sp.project_id=s.project_id AND sp.visitor_key=s.visitor_id AND sp.property_key=${key} AND sp.updated_at>=c.cutoff`;
    if(filter.operator==='missing')return `((SELECT lost_at IS NULL AND NOT expired_values_present FROM session_context) AND NOT EXISTS(${present}))`;
    return `EXISTS(${present}${filter.operator==='exists'?'':` AND ${propertyValuePredicate(filter,bind,timeZone,'sp.property')}`})`;
  });
  return `(s.visitor_id IS NOT NULL AND ${conditions.join(' AND ')})`;
}
export function advancedPredicateMethod(predicates:AdvancedPredicates){
  return {version:'native-flat-predicates-v1' as const,requiredFilters:'all' as const,fieldMatch:predicates.match,propertyMatch:'all' as const,
    textSearch:'postgresql-lower-literal' as const,regex:'postgresql-case-insensitive' as const,dateComparison:'calendar-day-in-scope-timezone' as const,
    ...(predicates.sessionProperties?.length?{sessionPropertyMatch:'all' as const,sessionPropertyValues:'current-retained-at-report-snapshot' as const}:{})};
}
// Call only after current authorization and receipt replay decisions, under the
// caller's transaction/deadline. Empty datasets must still reject invalid syntax.
export async function validateAdvancedRegex(client:PoolClient,...groups:(AdvancedPredicates|undefined)[]){
  const patterns=groups.flatMap(group=>group?[...group.fields,...group.properties,...(group.sessionProperties??[])].flatMap(filter=>
    (filter.operator==='regex'||filter.operator==='not_regex')&&'value' in filter?[filter.value as string]:[]):[]);
  if(!patterns.length)return;
  try{await client.query("SELECT '' ~* pattern FROM unnest($1::text[]) AS patterns(pattern)",[patterns]);}
  catch(error){
    if((error as {code?:string})?.code==='2201B')throw new FoundationError(400,'Check the regular expression in the additional filters.');
    throw error;
  }
}
