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
import {journeyStepSchema} from '../lib/journeys.ts';
import {attributionFields,attributionLimits,attributionMethod,type AttributionModel,type AttributionResult} from '../lib/attribution.ts';
import {internalNavigationSql,selfReferralSql} from './analytics-dimensions.ts';

const ownNames=['model','conversionKind','conversionValue'];
const names=new Set(['from','to','timeZone','kind','propertyKey','propertyType','propertyValue','cohortId','cohortRevision','predicates',...explorerFilters,...ownNames]);
const bad=()=>new FoundationError(400,'Check the attribution dates, filters and typed conversion.');
const missing=()=>new FoundationError(404,'Project not found or unavailable.');
const tooLarge=()=>new FoundationError(503,'This attribution result is too large. Choose a shorter range or more filters.');
export function attributionQuery(params:URLSearchParams,now=new Date()){
 if(params.toString().length>attributionLimits.queryCharacters)throw bad();
 for(const key of params.keys())if(!names.has(key)||params.getAll(key).length!==1)throw bad();
 const model=params.get('model')??'first-click';if(model!=='first-click'&&model!=='last-click')throw bad();
 const conversion=journeyStepSchema.safeParse({kind:params.get('conversionKind'),value:params.get('conversionValue')});if(!conversion.success)throw bad();
 const scope=new URLSearchParams(params);for(const key of ownNames)scope.delete(key);
 return {scope:explorerQuery(scope,now),model:model as AttributionModel,conversion:conversion.data};
}
function count(value:unknown):number{const n=typeof value==='string'?Number(value):value;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)throw tooLarge();return n;}
const usesGeography=(query:ReturnType<typeof explorerQuery>)=>geographyFields.some(field=>Object.hasOwn(query.filters,field))||!!query.predicates?.fields.some(row=>geographyFields.includes(row.field as GeoField));
// PostgreSQL length counts code points; add astral code points to match the native UTF-16 limits.
function metadata(expression:string,maximum:number){return `CASE WHEN jsonb_typeof(${expression})='string' THEN CASE WHEN length(${expression}#>>'{}')+length(regexp_replace(${expression}#>>'{}',U&'[\\0001-\\FFFF]','','g'))<=${maximum} THEN ${expression}#>>'{}' END END`;}

export async function projectAttribution(projectId:string,authority:SessionReadAuthority,params:URLSearchParams):Promise<AttributionResult>{
 if(!z.uuid().safeParse(projectId).success)throw bad();projectId=projectId.toLowerCase();const input=attributionQuery(params);
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
  const kindSlot=bind(input.conversion.kind),valueSlot=bind(input.conversion.value),keySlot=bind(currentKey?.id??null),order=input.model==='first-click'?'ASC':'DESC';
  const geo=usesGeography(query)||!!qualification&&usesGeography(qualification);
  // ponytail: indexed retained raw aggregation with a fixed5-second ceiling;
  // introduce measured rollups only if these bounded reports outgrow that ceiling.
  const {rows}=await client.query(`${ctes}, attribution_clock AS MATERIALIZED(SELECT clock_timestamp() AS as_of),
   key_authority AS MATERIALIZED(SELECT ${keySlot}::uuid IS NULL OR EXISTS(SELECT 1 FROM api_key k
    JOIN membership m ON m.workspace_id=k.workspace_id AND m.user_id=k.issuer_user_id JOIN project p ON p.workspace_id=k.workspace_id AND p.id=$1 CROSS JOIN attribution_clock c
    WHERE k.id=${keySlot}::uuid AND k.issuer_user_id=$2 AND m.role IN('owner','admin','editor','viewer')
     AND 'analytics:read'=ANY(k.scopes) AND k.revoked_at IS NULL AND k.expires_at>c.as_of) AS valid),
   conversions AS MATERIALIZED(SELECT s.* FROM ${population} s WHERE
    (${kindSlot}='pageview' AND s.event_name='page_view' AND s.path=${valueSlot}) OR
    (${kindSlot}='custom' AND s.event_name<>'page_view' AND s.event_name=${valueSlot})),
   keyed_conversions AS MATERIALIZED(SELECT * FROM conversions WHERE source='browser' AND visitor_id IS NOT NULL AND visit_id IS NOT NULL),
   converted AS MATERIALIZED(SELECT visitor_id,min(received_at) AS first_conversion_at,max(received_at) AS latest_conversion_at FROM keyed_conversions GROUP BY visitor_id),
   touch_candidates AS MATERIALIZED(SELECT e.id,e.visitor_id,e.received_at,${internalNavigationSql('e')} AS internal,
    CASE WHEN ${selfReferralSql('e')} THEN NULL ELSE NULLIF(${metadata("e.dimensions->'referrerHost'",2048)},'') END AS referrer,
    ${['source','medium','campaign','content','term'].map(field=>`${metadata(`CASE WHEN jsonb_typeof(e.dimensions->'campaign')='object' THEN e.dimensions->'campaign'->'${field}' END`,200)} AS campaign_${field}`).join(',')}
    FROM event e JOIN converted c ON c.visitor_id=e.visitor_id JOIN target p ON p.id=e.project_id CROSS JOIN bounds b
    WHERE e.source='browser' AND e.visit_id IS NOT NULL AND e.received_at>=b.start AND e.received_at<b.finish
     AND (e.received_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
     AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)
     ${input.model==='last-click'?'AND e.received_at<c.latest_conversion_at':'AND e.received_at<=c.first_conversion_at'}),
   touch_ties AS(SELECT *,count(*) OVER(PARTITION BY visitor_id,internal,received_at) AS timestamp_count FROM touch_candidates),
   -- Internal navigation (an untagged self-referral) is the touch only when the key has no other candidate.
   selected AS MATERIALIZED(SELECT DISTINCT ON(visitor_id) * FROM touch_ties ORDER BY visitor_id,internal,received_at ${order},id ${order}),
   dimension_fields(field) AS(VALUES ${attributionFields.map(field=>`('${field}')`).join(',')}),
   touch_values AS MATERIALIZED(SELECT field,value FROM selected s CROSS JOIN LATERAL(VALUES
    ('referrer',s.referrer),('campaignSource',s.campaign_source),('campaignMedium',s.campaign_medium),('campaignName',s.campaign_campaign),('campaignContent',s.campaign_content),('campaignTerm',s.campaign_term))v(field,value)),
   grouped AS MATERIALIZED(SELECT field,value,count(*) AS credits FROM touch_values WHERE value IS NOT NULL AND value<>'' GROUP BY field,value),
   ranked AS MATERIALIZED(SELECT *,row_number() OVER(PARTITION BY field ORDER BY credits DESC,value COLLATE "C") AS ordinal FROM grouped),
   dimension_reports AS(SELECT f.field,
    (SELECT count(*) FROM touch_values t WHERE t.field=f.field AND t.value IS NOT NULL AND t.value<>'') AS recorded,
    (SELECT count(*) FROM touch_values t WHERE t.field=f.field AND t.value='') AS empty,
    (SELECT count(*) FROM touch_values t WHERE t.field=f.field AND t.value IS NULL) AS missing,
    (SELECT count(*) FROM grouped g WHERE g.field=f.field) AS total_values,
    (SELECT COALESCE(sum(credits),0) FROM ranked r WHERE r.field=f.field AND ordinal<=20) AS displayed,
    COALESCE((SELECT json_agg(json_build_object('value',value,'credits',credits) ORDER BY credits DESC,value COLLATE "C") FROM ranked r WHERE r.field=f.field AND ordinal<=20),'[]') AS rows
    FROM dimension_fields f)
   SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT valid FROM key_authority) AS key_valid,
    (SELECT to_char(analytics_retained_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM target) AS retained_from,(SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,(SELECT as_of FROM attribution_clock) AS as_of,
    ${sessionAware?`(SELECT json_build_object('asOf',as_of,'cutoff',cutoff,'lostAt',lost_at,'expiredValuesPresent',expired_values_present) FROM session_context)`:'null'} AS session_context,
    ${reportCandidates?`(SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*) FILTER(WHERE visitor_id IS NULL)) FROM ${reportCandidates})`:'null'} AS report_candidates,
    ${qualificationCandidates?`(SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*) FILTER(WHERE visitor_id IS NULL)) FROM ${qualificationCandidates})`:'null'} AS qualification_candidates,
    ${item?`(SELECT json_build_object('start',start,'end',finish,'events',(SELECT count(*) FROM qualification),'identified',(SELECT count(visitor_id) FROM qualification),'members',(SELECT count(*) FROM cohort_keys)) FROM qualification_bounds)`:'null'} AS qualification,
    ${geo?`(SELECT json_build_object('source','db-ip-city-lite','scope','matching-conversion-events','databaseCount',count(DISTINCT(geography->'databaseBuild',geography->'databaseSha256')) FILTER(WHERE geography IS NOT NULL),'oldestDatabaseBuild',min((geography->>'databaseBuild')::bigint),'newestDatabaseBuild',max((geography->>'databaseBuild')::bigint)) FROM conversions)`:'null'} AS geography_provenance,
    (SELECT count(*) FROM conversions) AS conversion_events,(SELECT count(*) FROM keyed_conversions) AS keyed_events,
    (SELECT count(*) FROM converted) AS converted_keys,(SELECT count(DISTINCT(visitor_id,visit_id)) FROM keyed_conversions) AS converting_visits,
    (SELECT count(*) FROM selected) AS attributed_keys,(SELECT count(*) FROM selected WHERE timestamp_count>1) AS tied_keys,
    (SELECT json_build_object('cookieless',count(*) FILTER(WHERE collection_basis='cookieless'),'consent',count(*) FILTER(WHERE collection_basis='consent'),'unknown',count(*) FILTER(WHERE collection_basis IS NULL)) FROM conversions) AS collection,
    (SELECT json_object_agg(field,json_build_object('recorded',recorded,'empty',empty,'missing',missing,'totalValues',total_values,'displayed',displayed,'rows',rows)) FROM dimension_reports) AS dimensions`,values);
  const row=rows[0];if(currentKey&&!row?.key_valid)throw new FoundationError(401,'The API key is invalid, expired or unavailable.');if(!row?.allowed)throw missing();
  const start=(row.start as Date).toISOString(),end=(row.finish as Date).toISOString(),coverage=retentionCoverage(start,end,row.retained_from);
  const cohort=cohortCoverage(item,qualification,row),sessionProperties=query.predicates?.sessionProperties?.length?sessionScope(row.session_context,row.report_candidates,query.predicates.sessionProperties.some(filter=>filter.operator==='missing'),coverage.status==='unavailable'||cohort?.membership.status==='unavailable',coverage.status==='partial'||!!cohort?.membership.countsAreLowerBounds):undefined;
  const events=count(row.conversion_events),keyed=count(row.keyed_events),unknown=events-keyed,converted=count(row.converted_keys),attributed=count(row.attributed_keys),ties=count(row.tied_keys);
  const reason=coverage.status==='unavailable'?'event_history_unavailable':cohort?.membership.status==='unavailable'?'cohort_membership_unavailable':sessionProperties?.selection.status==='unavailable'?'session_property_selection_unavailable':events>0&&keyed===0?'identity_unavailable':null;
  const unavailable=reason!==null,hidden=unavailable&&reason!=='identity_unavailable',evidenceIncomplete=unavailable||coverage.status==='partial'||unknown>0||ties>0||!!cohort?.membership.countsAreLowerBounds||!!sessionProperties?.selection.countsAreLowerBounds;
  const dimensions={} as AttributionResult['dimensions'];for(const field of attributionFields){
   const raw=row.dimensions[field],recorded=count(raw.recorded),empty=count(raw.empty),notRecorded=count(raw.missing),total=count(raw.totalValues),displayed=count(raw.displayed);
   if(recorded+empty+notRecorded!==attributed||displayed>recorded||raw.rows.length!==Math.min(20,total))throw tooLarge();
   const seen=new Set<string>();let credits=0,prior=Number.MAX_SAFE_INTEGER;const results=raw.rows.map((value:{value:unknown;credits:unknown})=>{
    const n=count(value.credits);if(typeof value.value!=='string'||value.value.length===0||value.value.length>(field==='referrer'?2048:200)||seen.has(value.value)||n===0||n>prior||n>converted)throw tooLarge();
    seen.add(value.value);prior=n;credits+=n;return{value:value.value,creditedKeys:n,shareOfConvertedKeys:!evidenceIncomplete&&converted>0?n/converted*100:null};
   });if(credits!==displayed)throw tooLarge();
   dimensions[field]={rows:unavailable?null:results,recordedKeys:unavailable?null:recorded,emptyKeys:unavailable?null:empty,notRecordedKeys:unavailable?null:notRecorded,totalValues:unavailable?null:total,displayedKeys:unavailable?null:displayed,omittedKeys:unavailable?null:recorded-displayed,truncated:!unavailable&&total>20,limit:20};
  }
  if(keyed>events||attributed>converted||converted>keyed||ties>attributed||input.model==='first-click'&&attributed!==converted)throw tooLarge();
  const {groupBy:_,groupProperty:__,...scope}=query,collection={cookieless:count(row.collection.cookieless),consent:count(row.collection.consent),unknown:count(row.collection.unknown)};
  if(collection.cookieless+collection.consent+collection.unknown!==events)throw tooLarge();
  const result:AttributionResult={version:'native-attribution-v1',projectId,asOf:(row.as_of as Date).toISOString(),range:{from:query.from,to:query.to,timeZone:query.timeZone,start,end},query:{...scope,model:input.model,conversion:input.conversion},method:attributionMethod,coverage,
   selection:{status:unavailable?'unavailable':'available',reason,evidenceIncomplete},
   measurement:{conversionEvents:hidden?null:events,keyedConversionEvents:hidden?null:keyed,unkeyedConversionEvents:hidden||sessionProperties&&row.report_candidates.unidentified>0?null:unknown,convertedObservedKeys:unavailable?null:converted,convertingObservedVisits:unavailable?null:count(row.converting_visits),attributedKeys:unavailable?null:attributed,noEarlierTouchKeys:unavailable?null:converted-attributed,touchTimestampTieKeys:unavailable?null:ties,collection:hidden?{cookieless:null,consent:null,unknown:null}:collection},dimensions,
   paidAds:{status:'unavailable',reason:'native_paid_click_signal_not_recorded'},...(cohort?{cohort}:{}),...(sessionProperties?{sessionProperties}:{}),...(query.predicates?{predicateMethod:advancedPredicateMethod(query.predicates)}:{}),
   ...(geo?{geographyProvenance:hidden?{source:'db-ip-city-lite',scope:'matching-conversion-events',databaseCount:null,oldestDatabaseBuild:null,newestDatabaseBuild:null}:row.geography_provenance}:{})};
  if(Buffer.byteLength(JSON.stringify(result))>attributionLimits.responseBytes)throw tooLarge();
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'This query took too long. Choose a shorter date range or more filters.');throw error;}
 finally{client.release();}
}
