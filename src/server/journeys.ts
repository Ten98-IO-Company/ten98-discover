import {z} from 'zod';
import {getDatabase} from './db.ts';
import {FoundationError} from './auth.ts';
import {authenticateApiKey,authorizeApiKey} from './api-keys.ts';
import {explorerQuery,explorerFilters} from './explorer-input.ts';
import {analyticsPopulation,cohortCoverage,sessionScope} from './analytics-population.ts';
import {resolveCohort} from './cohorts.ts';
import {advancedPredicateMethod,validateAdvancedRegex} from './advanced-predicates.ts';
import {retentionCoverage} from './retention.ts';
import type {SessionReadAuthority} from './session-explorer.ts';
import {geographyFields,type GeoField} from '../lib/analytics-geography.ts';
import {journeysLimits,journeysMethod,journeyStepSchema,type JourneyStep,type JourneyPath,type JourneysResult} from '../lib/journeys.ts';

const ownNames=['steps','startKind','startValue','endKind','endValue'];
const names=new Set(['from','to','timeZone','kind','propertyKey','propertyType','propertyValue','cohortId','cohortRevision','predicates',...explorerFilters,...ownNames]);
const bad=()=>new FoundationError(400,'Check the journey dates, filters and typed first/last shown steps.');
const missing=()=>new FoundationError(404,'Project not found or unavailable.');
const tooLarge=()=>new FoundationError(503,'This journey result is too large. Choose a shorter range or more filters.');
export function journeysQuery(params:URLSearchParams,now=new Date()){
 if(params.toString().length>journeysLimits.queryCharacters)throw bad();
 for(const key of params.keys())if(!names.has(key)||params.getAll(key).length!==1)throw bad();
 const rawSteps=params.get('steps')??'3';if(!/^[2-7]$/.test(rawSteps))throw bad();
 const step=(prefix:'start'|'end'):JourneyStep|null=>{
  if(!params.has(prefix+'Kind')&&!params.has(prefix+'Value'))return null;
  const parsed=journeyStepSchema.safeParse({kind:params.get(prefix+'Kind'),value:params.get(prefix+'Value')});if(!parsed.success)throw bad();return parsed.data;
 };
 const scope=new URLSearchParams(params);for(const key of ownNames)scope.delete(key);
 return {scope:explorerQuery(scope,now),steps:Number(rawSteps),start:step('start'),end:step('end')};
}
function count(value:unknown):number{const n=typeof value==='string'?Number(value):value;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)throw tooLarge();return n;}
const usesGeography=(query:ReturnType<typeof explorerQuery>)=>geographyFields.some(field=>Object.hasOwn(query.filters,field))||!!query.predicates?.fields.some(row=>geographyFields.includes(row.field as GeoField));

export async function projectJourneys(projectId:string,authority:SessionReadAuthority,params:URLSearchParams):Promise<JourneysResult>{
 if(!z.uuid().safeParse(projectId).success)throw bad();projectId=projectId.toLowerCase();const input=journeysQuery(params);
 const client=await getDatabase().pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='5s'");
  const preliminary=authority.kind==='api-key'?await authenticateApiKey(authority.token,client):null;
  let userId=authority.kind==='session'?authority.userId:preliminary!.userId;
  const hint=(await client.query('SELECT p.workspace_id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rows[0]?.workspace_id as string|undefined;
  if(!hint||preliminary&&preliminary.workspaceId!==hint)throw missing();
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[hint]);
  const currentKey=authority.kind==='api-key'?await authorizeApiKey(authority.token,hint,'analytics:read',client):null;if(currentKey)userId=currentKey.userId;
  const query=input.scope,item=query.cohort?await resolveCohort(client,projectId,userId,query.cohort.id,query.cohort.revision):null;
  const qualification=item?explorerQuery(new URLSearchParams(item.definition.query)):null;
  await validateAdvancedRegex(client,query.predicates,qualification?.predicates);
  for(const zone of new Set([query.timeZone,...qualification?[qualification.timeZone]:[]]))if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[zone])).rowCount)throw new FoundationError(400,'The database does not support this timezone.');
  const {ctes,values,population,sessionAware,reportCandidates,qualificationCandidates}=analyticsPopulation(projectId,userId,query,qualification,false);
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  const stepSlot=bind(input.steps),startSlot=bind(input.start===null?null:JSON.stringify(input.start)),endSlot=bind(input.end===null?null:JSON.stringify(input.end)),keySlot=bind(currentKey?.id??null);
  const geo=usesGeography(query)||!!qualification&&usesGeography(qualification);
  // ponytail: indexed bounded raw aggregation, at most7 displayed runs and100 prefixes;
  // introduce measured rollups only if the fixed5-second report ceiling is insufficient.
  const {rows}=await client.query(`${ctes}, journey_clock AS MATERIALIZED(SELECT clock_timestamp() AS as_of),
   key_authority AS MATERIALIZED(SELECT ${keySlot}::uuid IS NULL OR EXISTS(SELECT 1 FROM api_key k
    JOIN membership m ON m.workspace_id=k.workspace_id AND m.user_id=k.issuer_user_id JOIN project p ON p.workspace_id=k.workspace_id AND p.id=$1 CROSS JOIN journey_clock c
    WHERE k.id=${keySlot}::uuid AND k.issuer_user_id=$2 AND m.role IN('owner','admin','editor','viewer')
     AND 'analytics:read'=ANY(k.scopes) AND k.revoked_at IS NULL AND k.expires_at>c.as_of) AS valid),
   typed AS MATERIALIZED(SELECT s.id,s.visitor_id,s.visit_id,s.received_at,
    jsonb_build_object('kind',CASE WHEN event_name='page_view' THEN 'pageview' ELSE 'custom' END,'value',CASE WHEN event_name='page_view' THEN path ELSE event_name END) AS step
    FROM ${population} s WHERE s.source='browser' AND s.visitor_id IS NOT NULL AND s.visit_id IS NOT NULL),
   previous AS(SELECT *,lag(step) OVER(PARTITION BY visitor_id,visit_id ORDER BY received_at,id) AS prior FROM typed),
   numbered AS(SELECT *,sum(CASE WHEN step IS DISTINCT FROM prior THEN 1 ELSE 0 END) OVER(PARTITION BY visitor_id,visit_id ORDER BY received_at,id ROWS UNBOUNDED PRECEDING) AS ordinal FROM previous),
   runs AS MATERIALIZED(SELECT visitor_id,visit_id,ordinal,min(step::text)::jsonb AS step,count(*) AS observations FROM numbered GROUP BY visitor_id,visit_id,ordinal),
   visits AS MATERIALIZED(SELECT visitor_id,visit_id,jsonb_agg(step ORDER BY ordinal) FILTER(WHERE ordinal<=${stepSlot}::integer) AS items,
    array_agg(observations ORDER BY ordinal) FILTER(WHERE ordinal<=${stepSlot}::integer) AS raw_counts,bool_or(ordinal>${stepSlot}::integer) AS additional
    FROM runs GROUP BY visitor_id,visit_id),
   grouped AS MATERIALIZED(SELECT items,count(*) AS visits,count(*) FILTER(WHERE additional) AS additional FROM visits
    WHERE (${startSlot}::jsonb IS NULL OR items->0=${startSlot}::jsonb) AND (${endSlot}::jsonb IS NULL OR items->-1=${endSlot}::jsonb) GROUP BY items),
   ranked AS MATERIALIZED(SELECT * FROM grouped ORDER BY visits DESC,items::text COLLATE "C" ASC LIMIT 100),
   raw_counts AS(SELECT v.items,n.position,sum(v.raw_counts[n.position]) AS observations FROM visits v JOIN ranked r ON r.items=v.items
    CROSS JOIN LATERAL generate_subscripts(v.raw_counts,1)n(position) GROUP BY v.items,n.position),
   tied AS(SELECT visitor_id,visit_id FROM typed GROUP BY visitor_id,visit_id,received_at HAVING count(DISTINCT step)>1)
   SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT valid FROM key_authority) AS key_valid,
    (SELECT to_char(analytics_retained_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM target) AS retained_from,(SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,(SELECT as_of FROM journey_clock) AS as_of,
    ${sessionAware?`(SELECT json_build_object('asOf',as_of,'cutoff',cutoff,'lostAt',lost_at,'expiredValuesPresent',expired_values_present) FROM session_context)`:'null'} AS session_context,
    ${reportCandidates?`(SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*) FILTER(WHERE visitor_id IS NULL)) FROM ${reportCandidates})`:'null'} AS report_candidates,
    ${qualificationCandidates?`(SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*) FILTER(WHERE visitor_id IS NULL)) FROM ${qualificationCandidates})`:'null'} AS qualification_candidates,
    ${item?`(SELECT json_build_object('start',start,'end',finish,'events',(SELECT count(*) FROM qualification),'identified',(SELECT count(visitor_id) FROM qualification),'members',(SELECT count(*) FROM cohort_keys)) FROM qualification_bounds)`:'null'} AS qualification,
    ${geo?`(SELECT json_build_object('source','db-ip-city-lite','scope','matching-report-events','databaseCount',count(DISTINCT(geography->'databaseBuild',geography->'databaseSha256')) FILTER(WHERE geography IS NOT NULL),'oldestDatabaseBuild',min((geography->>'databaseBuild')::bigint),'newestDatabaseBuild',max((geography->>'databaseBuild')::bigint)) FROM ${population})`:'null'} AS geography_provenance,
    (SELECT count(*) FROM ${population}) AS matching_events,(SELECT count(*) FROM typed) AS sequenced_events,(SELECT count(*) FROM visits) AS observed_visits,
    (SELECT count(DISTINCT(visitor_id,visit_id)) FROM tied) AS ordering_ties,
    (SELECT json_build_object('cookieless',count(*) FILTER(WHERE collection_basis='cookieless'),'consent',count(*) FILTER(WHERE collection_basis='consent'),'unknown',count(*) FILTER(WHERE collection_basis IS NULL)) FROM ${population}) AS collection,
    (SELECT count(*) FROM grouped) AS prefixes,(SELECT COALESCE(sum(visits),0) FROM grouped) AS matching_visits,(SELECT COALESCE(sum(visits),0) FROM ranked) AS displayed_visits,
    COALESCE((SELECT json_agg(json_build_object('items',r.items,'observedVisits',r.visits,'rawObservationCounts',(SELECT json_agg(observations ORDER BY position) FROM raw_counts c WHERE c.items=r.items),'additionalObservedStepsVisits',r.additional) ORDER BY r.visits DESC,r.items::text COLLATE "C") FROM ranked r),'[]') AS paths` ,values);
  const row=rows[0];if(currentKey&&!row?.key_valid)throw new FoundationError(401,'The API key is invalid, expired or unavailable.');if(!row?.allowed)throw missing();
  const start=(row.start as Date).toISOString(),end=(row.finish as Date).toISOString(),coverage=retentionCoverage(start,end,row.retained_from);
  const cohort=cohortCoverage(item,qualification,row),sessionProperties=query.predicates?.sessionProperties?.length?sessionScope(row.session_context,row.report_candidates,query.predicates.sessionProperties.some(filter=>filter.operator==='missing'),coverage.status==='unavailable'||cohort?.membership.status==='unavailable',coverage.status==='partial'||!!cohort?.membership.countsAreLowerBounds):undefined;
  const matching=count(row.matching_events),sequenced=count(row.sequenced_events),unknown=matching-sequenced;
  const reason=coverage.status==='unavailable'?'event_history_unavailable':cohort?.membership.status==='unavailable'?'cohort_membership_unavailable':sessionProperties?.selection.status==='unavailable'?'session_property_selection_unavailable':matching>0&&sequenced===0?'identity_unavailable':null;
  const unavailable=reason!==null,hidden=unavailable&&reason!=='identity_unavailable';
  const paths:JourneyPath[]=[];if(!unavailable)for(const path of row.paths as JourneyPath[]){
   if(path.items.length<1||path.items.length>input.steps||path.rawObservationCounts.length!==path.items.length)throw tooLarge();
   const visits=count(path.observedVisits),additional=count(path.additionalObservedStepsVisits);if(visits===0||additional>visits||path.items.length<input.steps&&additional!==0)throw tooLarge();
   const raw=path.rawObservationCounts.map(count);if(raw.some(n=>n<visits))throw tooLarge();
   const items=path.items.map(value=>{const parsed=journeyStepSchema.safeParse(value);if(!parsed.success)throw tooLarge();return parsed.data;});
   paths.push({items,observedVisits:visits,rawObservationCounts:raw,additionalObservedStepsVisits:additional});
  }
  const {groupBy:_,groupProperty:__,...scope}=query,totalPrefixes=count(row.prefixes),matchingVisits=count(row.matching_visits),displayedVisits=count(row.displayed_visits);
  const result:JourneysResult={version:'native-journeys-v1',projectId,asOf:(row.as_of as Date).toISOString(),range:{from:query.from,to:query.to,timeZone:query.timeZone,start,end},query:{...scope,steps:input.steps,start:input.start,end:input.end},method:journeysMethod,coverage,
   selection:{status:unavailable?'unavailable':'available',reason,evidenceIncomplete:unavailable||coverage.status==='partial'||unknown>0||!!cohort?.membership.countsAreLowerBounds||!!sessionProperties?.selection.countsAreLowerBounds},
   measurement:{matchingEvents:hidden?null:matching,sequencedEvents:hidden?null:sequenced,unsequencedEvents:hidden||sessionProperties&&row.report_candidates.unidentified>0?null:unknown,observedVisits:unavailable?null:count(row.observed_visits),orderingTieVisits:unavailable?null:count(row.ordering_ties),collection:hidden?{cookieless:null,consent:null,unknown:null}:row.collection},
   paths:unavailable?null:paths,ranking:{mode:'top100',limit:100,totalPrefixes:unavailable?null:totalPrefixes,matchingObservedVisits:unavailable?null:matchingVisits,displayedObservedVisits:unavailable?null:displayedVisits,omittedObservedVisits:unavailable?null:matchingVisits-displayedVisits,truncated:!unavailable&&totalPrefixes>journeysLimits.paths},
   ...(cohort?{cohort}:{}),...(sessionProperties?{sessionProperties}:{}),...(query.predicates?{predicateMethod:advancedPredicateMethod(query.predicates)}:{}),
   ...(geo?{geographyProvenance:hidden?{source:'db-ip-city-lite',scope:'matching-report-events',databaseCount:null,oldestDatabaseBuild:null,newestDatabaseBuild:null}:row.geography_provenance}:{})};
  if(Buffer.byteLength(JSON.stringify(result))>journeysLimits.responseBytes)throw tooLarge();
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'This query took too long. Choose a shorter date range or more filters.');throw error;}
 finally{client.release();}
}
