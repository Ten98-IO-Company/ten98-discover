import {z} from 'zod';
import {deriveAnalyticsComparison} from '../lib/analytics-comparison.ts';
import {getDatabase} from './db.ts';
import {FoundationError} from './auth.ts';
import {authenticateApiKey,authorizeApiKey} from './api-keys.ts';
import {canonicalHash,cleanText} from './context-input.ts';
import {explorerQuery,explorerFilters} from './explorer-input.ts';
import {analyticsPopulation,cohortCoverage,sessionScope} from './analytics-population.ts';
import {resolveCohort} from './cohorts.ts';
import {validateAdvancedRegex,advancedPredicateMethod} from './advanced-predicates.ts';
import {retentionCoverage} from './retention.ts';
import {geographyProjectionSql,geographyKeySql,geographyKeyOrderSql} from './geography-sql.ts';
import {environmentCatalog,environmentVersion} from '../lib/analytics-environment.ts';
import {revenueCurrencies,revenueCurrencyCatalogVersion,revenueReportVersion,revenueReportLimits,revenueUnits,revenueDecimal,revenueAverage,revenueChannel,revenueChannelRules,revenueComparisonChanges,type RevenueComparisonSummary,type RevenueTotals,type RevenueResult,type RevenueSource,type RevenueBreakdown} from '../lib/revenue.ts';
import type {SessionReadAuthority} from './session-explorer.ts';

const invalid=()=>new FoundationError(400,'Choose explicit revenue dates, timezone, currency and supported filters.');
const missing=()=>new FoundationError(404,'Project or revenue key not found or unavailable.');
const large=()=>new FoundationError(503,'This revenue result is too large. Choose a shorter range or more filters.');
const instant=z.iso.datetime({precision:6}).refine(value=>value.endsWith('Z')&&!value.startsWith('0000-'));
const hex=z.string().length(64).regex(/^[a-f0-9]{64}$/);
const cursorSchema=z.object({version:z.literal(1),route:z.enum(['sessions','detail']),projectId:z.uuid(),scope:hex,pageSize:z.number().int().min(1).max(100),eventBefore:instant,policyHash:hex,evidenceHash:hex,last:z.object({at:instant,key:z.string().min(36).max(64)}).strict()}).strict();
type Cursor=z.infer<typeof cursorSchema>;
export function revenueQuery(params:URLSearchParams,route:'report'|'sessions'|'detail'='report',visitorKey:string|null=null){
 const own=['currency','search','pageSize','cursor',...(route==='report'?['compare']:[])],allowed=new Set(['from','to','timeZone','kind','propertyKey','propertyType','propertyValue','cohortId','cohortRevision','predicates',...explorerFilters,...own]);
 if(params.toString().length>revenueReportLimits.queryCharacters||!['from','to','timeZone','currency'].every(key=>params.has(key)))throw invalid();
 for(const key of params.keys())if(!allowed.has(key)||params.getAll(key).length!==1)throw invalid();
 const compare=params.get('compare');if(compare!==null&&(route!=='report'||!['prev','yoy'].includes(compare)))throw invalid();
 const currency=params.get('currency')!;if(!revenueCurrencies.includes(currency)||route==='detail'&&(!visitorKey||!hex.safeParse(visitorKey).success)||route==='report'&&params.has('cursor'))throw invalid();
 const search=params.get('search')??'',size=params.get('pageSize')??'50';if(search.length>200||!cleanText(search)||route==='detail'&&params.has('search')||! /^(?:[1-9][0-9]?|100)$/.test(size))throw invalid();
 const scopeParams=new URLSearchParams(params);for(const key of own)scopeParams.delete(key);const query=explorerQuery(scopeParams);
 let cursor:Cursor|null=null;const raw=params.get('cursor');if(raw!==null){try{if(!raw||raw.length>2048||!/^[A-Za-z0-9_-]+$/.test(raw))throw invalid();const bytes=Buffer.from(raw,'base64url');if(bytes.toString('base64url')!==raw)throw invalid();const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);cursor=cursorSchema.parse(JSON.parse(text));if(JSON.stringify(cursor)!==text||cursor.last.at>=cursor.eventBefore||cursor.route!==route||route==='sessions'&&!hex.safeParse(cursor.last.key).success||route==='detail'&&!z.uuid().safeParse(cursor.last.key).success)throw invalid();}catch{throw invalid();}}
 if(compare&&!deriveAnalyticsComparison(query,compare as 'prev'|'yoy'))throw invalid();
 return{query,currency,search,pageSize:Number(size),cursor,visitorKey,...compare?{compare:compare as 'prev'|'yoy'}:{}};
}
const stamp=(value:string)=>`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const totals=(alias:string)=>`jsonb_build_object('sales',COALESCE(sum(${alias}.amount) FILTER(WHERE ${alias}.revenue_kind='sale'),0)::numeric(44,4)::text,'refunds',COALESCE(sum(${alias}.amount) FILTER(WHERE ${alias}.revenue_kind='refund'),0)::numeric(44,4)::text,'net',COALESCE(sum(CASE WHEN ${alias}.revenue_kind='sale' THEN ${alias}.amount ELSE -${alias}.amount END),0)::numeric(44,4)::text,'saleObservations',count(*) FILTER(WHERE ${alias}.revenue_kind='sale'),'refundObservations',count(*) FILTER(WHERE ${alias}.revenue_kind='refund'))`;
const fixed=(value:unknown):string=>{if(typeof value!=='string')throw large();try{revenueUnits(value);return value;}catch{throw large();}};
const count=(value:unknown):number=>{const n=typeof value==='string'?Number(value):value;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)throw large();return n;};
function money(value:RevenueTotals):RevenueTotals{const result={sales:fixed(value.sales),refunds:fixed(value.refunds),net:fixed(value.net),saleObservations:count(value.saleObservations),refundObservations:count(value.refundObservations)};if(revenueUnits(result.sales)-revenueUnits(result.refunds)!==revenueUnits(result.net)||revenueUnits(result.sales)<0n||revenueUnits(result.refunds)<0n)throw large();return result;}
const zero=():RevenueTotals=>({sales:'0.0000',refunds:'0.0000',net:'0.0000',saleObservations:0,refundObservations:0});
const subtract=(a:RevenueTotals,b:RevenueTotals):RevenueTotals=>({sales:revenueDecimal(revenueUnits(a.sales)-revenueUnits(b.sales)),refunds:revenueDecimal(revenueUnits(a.refunds)-revenueUnits(b.refunds)),net:revenueDecimal(revenueUnits(a.net)-revenueUnits(b.net)),saleObservations:a.saleObservations-b.saleObservations,refundObservations:a.refundObservations-b.refundObservations});
const add=(a:RevenueTotals,b:RevenueTotals):RevenueTotals=>({sales:revenueDecimal(revenueUnits(a.sales)+revenueUnits(b.sales)),refunds:revenueDecimal(revenueUnits(a.refunds)+revenueUnits(b.refunds)),net:revenueDecimal(revenueUnits(a.net)+revenueUnits(b.net)),saleObservations:a.saleObservations+b.saleObservations,refundObservations:a.refundObservations+b.refundObservations});

export const projectRevenue=(projectId:string,authority:SessionReadAuthority,params:URLSearchParams)=>readRevenue(projectId,authority,params,'report',null);
export const listRevenueSessions=(projectId:string,authority:SessionReadAuthority,params:URLSearchParams)=>readRevenue(projectId,authority,params,'sessions',null);
export const getRevenueSession=(projectId:string,key:string,authority:SessionReadAuthority,params:URLSearchParams)=>readRevenue(projectId,authority,params,'detail',key);
async function readRevenue(projectId:string,authority:SessionReadAuthority,params:URLSearchParams,route:'report'|'sessions'|'detail',visitorKey:string|null):Promise<RevenueResult>{
 if(!z.uuid().safeParse(projectId).success)throw invalid();projectId=projectId.toLowerCase();const input=revenueQuery(params,route,visitorKey),{query,currency,cursor,pageSize,search,compare}=input;
 const derived=compare?deriveAnalyticsComparison(query,compare)!:null,previousQuery=derived?{...query,from:derived.range.from,to:derived.range.to}:null;
 const scopeHash=canonicalHash(['revenue-page-v1',projectId,query,currency,search,visitorKey]);if(cursor&&(cursor.projectId!==projectId||cursor.scope!==scopeHash||cursor.pageSize!==pageSize))throw invalid();
 const client=await getDatabase().pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");
  const preliminary=authority.kind==='api-key'?await authenticateApiKey(authority.token,client):null;let userId=authority.kind==='session'?authority.userId:preliminary!.userId;
  const workspace=(await client.query('SELECT p.workspace_id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rows[0]?.workspace_id as string|undefined;
  if(!workspace||preliminary&&preliminary.workspaceId!==workspace)throw missing();await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[workspace]);
  const key=authority.kind==='api-key'?await authorizeApiKey(authority.token,workspace,'analytics:read',client):null;if(key)userId=key.userId;
  const item=query.cohort?await resolveCohort(client,projectId,userId,query.cohort.id,query.cohort.revision):null,qualification=item?explorerQuery(new URLSearchParams(item.definition.query)):null;
  await validateAdvancedRegex(client,query.predicates,qualification?.predicates);for(const zone of new Set([query.timeZone,...qualification?[qualification.timeZone]:[]]))if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[zone])).rowCount)throw invalid();
  const{ctes,values,population,reportCandidates,qualificationCandidates}=analyticsPopulation(projectId,userId,query,qualification,false,cursor?.eventBefore??null,compare?'revenue-comparison':undefined);
  const bind=(value:unknown)=>{values.push(value);return`$${values.length}`;};
  const currencySlot=bind(currency),atSlot=bind(cursor?.last.at??null),lastSlot=bind(cursor?.last.key??null),limitSlot=bind(pageSize+1),searchSlot=bind(search),visitorSlot=bind(visitorKey);
  const env=(field:'browser'|'os'|'device')=>`CASE WHEN dimensions->>'environmentVersion'='${environmentVersion}' AND dimensions->>'${field}'=ANY(ARRAY[${environmentCatalog[field].map(value=>"'"+value.replaceAll("'","''")+"'").join(',')}]) THEN dimensions->>'${field}' END`;
  const text=(path:string,max:number)=>`CASE WHEN jsonb_typeof(${path})='string' THEN CASE WHEN length(${path}#>>'{}')+length(regexp_replace(${path}#>>'{}',U&'[\\0001-\\FFFF]','','g'))<=${max} THEN ${path}#>>'{}' END END`;
  const channelSql="CASE "+revenueChannelRules.map(([name,tokens])=>"WHEN lower(s.campaign_medium)=ANY(ARRAY["+tokens.map(value=>"'"+value+"'").join(',')+"])THEN '"+name+"'").join(' ')+" WHEN NULLIF(s.campaign_medium,'')IS NOT NULL OR NULLIF(s.campaign_source,'')IS NOT NULL THEN 'other_tagged' WHEN s.referrer IS NOT NULL THEN 'referrer_only' ELSE 'not_recorded' END";
  const currentOnly=compare?"revenue_period.name='current'":'TRUE',periodFrom=compare?'revenue_period.from_day':'$3::date',periodTo=compare?'revenue_period.to_day':'$4::date';
  const fromSlot=compare?bind(previousQuery!.from):null,toSlot=compare?bind(previousQuery!.to):null;
  const aggregatePrefix=compare?`WITH revenue_snapshot AS MATERIALIZED(SELECT clock_timestamp() AS as_of),revenue_period AS(SELECT 'current' AS name,$3::date AS from_day,$4::date AS to_day UNION ALL SELECT 'comparison',${fromSlot}::date,${toSlot}::date) SELECT revenue_period.name AS period,report.* FROM revenue_snapshot CROSS JOIN revenue_period CROSS JOIN LATERAL (`:'';
  // ponytail: exact raw aggregation under a5-second statement ceiling; measured rollups only if this report outgrows it.
  const{rows}=await client.query(`${aggregatePrefix}${ctes}, qualified_keys AS MATERIALIZED(SELECT DISTINCT visitor_id FROM ${population} WHERE source='browser' AND visitor_id IS NOT NULL AND visit_id IS NOT NULL),
   revenue_candidates AS MATERIALIZED(SELECT e.*,${geographyProjectionSql('e')} AS geography FROM event e JOIN target t ON t.id=e.project_id CROSS JOIN bounds b CROSS JOIN session_page p
    WHERE e.received_at>=b.start AND e.received_at<b.finish AND e.received_at<p.event_before AND (t.analytics_retained_from IS NULL OR e.received_at>=t.analytics_retained_from)
     AND (e.received_at AT TIME ZONE $5)::date BETWEEN ${periodFrom} AND ${periodTo}
     AND (e.source='browser' AND e.visitor_id IS NOT NULL AND e.visit_id IS NOT NULL AND EXISTS(SELECT 1 FROM qualified_keys k WHERE k.visitor_id=e.visitor_id)
      OR NOT(e.source='browser' AND e.visitor_id IS NOT NULL AND e.visit_id IS NOT NULL) AND EXISTS(SELECT 1 FROM ${population} q WHERE q.id=e.id))),
   revenue_projection AS MATERIALIZED(SELECT e.*,CASE WHEN jsonb_typeof(properties)='object' THEN EXISTS(SELECT 1 FROM jsonb_object_keys(properties)k WHERE starts_with(k,'ten98_revenue_')) ELSE FALSE END AS declared,
    CASE WHEN event_name<>'page_view' AND jsonb_typeof(properties)='object' THEN CASE WHEN properties ?& ARRAY['ten98_revenue_version','ten98_revenue_kind','ten98_revenue_amount','ten98_revenue_currency']
     AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(properties)k WHERE starts_with(k,'ten98_revenue_')AND k<>ALL(ARRAY['ten98_revenue_version','ten98_revenue_kind','ten98_revenue_amount','ten98_revenue_currency']))
     AND properties->'ten98_revenue_version'='{"type":"string","value":"1"}'::jsonb
     AND properties->'ten98_revenue_kind'=jsonb_build_object('type','string','value',properties->'ten98_revenue_kind'->>'value') AND properties->'ten98_revenue_kind'->>'value' IN('sale','refund')
     AND properties->'ten98_revenue_currency'=jsonb_build_object('type','string','value',properties->'ten98_revenue_currency'->>'value') AND properties->'ten98_revenue_currency'->>'value'=ANY(${bind(revenueCurrencies)}::text[])
     AND properties->'ten98_revenue_amount'=jsonb_build_object('type','string','value',properties->'ten98_revenue_amount'->>'value')
     AND properties->'ten98_revenue_amount'->>'value'~'^(0|[1-9][0-9]{0,14})(\\.[0-9]{1,4})?$' AND properties->'ten98_revenue_amount'->>'value'!~'[^0-9.]'
     THEN CASE WHEN (properties->'ten98_revenue_amount'->>'value')::numeric>0 THEN (properties->'ten98_revenue_amount'->>'value')::numeric(19,4) END END END AS amount FROM revenue_candidates e),
   revenue AS MATERIALIZED(SELECT *,properties->'ten98_revenue_kind'->>'value' AS revenue_kind,source='browser' AND visitor_id IS NOT NULL AND visit_id IS NOT NULL AS keyed FROM revenue_projection WHERE amount IS NOT NULL AND properties->'ten98_revenue_currency'->>'value'=${currencySlot}),
   key_totals AS MATERIALIZED(SELECT visitor_id,min(received_at) AS first_at,max(received_at) AS last_at,${totals('r')} AS totals FROM revenue r WHERE keyed GROUP BY visitor_id),
   first_observations AS MATERIALIZED(SELECT DISTINCT ON(e.visitor_id)e.visitor_id,e.received_at,e.id,e.dimensions,${geographyProjectionSql('e')} AS geography,
    count(*) OVER(PARTITION BY e.visitor_id,e.received_at) AS ties FROM event e JOIN key_totals k USING(visitor_id) JOIN target t ON t.id=e.project_id CROSS JOIN bounds b CROSS JOIN session_page p
    WHERE e.source='browser' AND e.visit_id IS NOT NULL AND e.received_at>=b.start AND e.received_at<b.finish AND e.received_at<p.event_before
     AND(t.analytics_retained_from IS NULL OR e.received_at>=t.analytics_retained_from)AND(e.received_at AT TIME ZONE $5)::date BETWEEN ${periodFrom} AND ${periodTo} ORDER BY e.visitor_id,e.received_at,e.id),
   sources AS MATERIALIZED(SELECT visitor_id,received_at,ties,geography,NULLIF(${text("dimensions->'referrerHost'",2048)},'') AS referrer,
    ${text("dimensions->'campaign'->'source'",200)} AS campaign_source,${text("dimensions->'campaign'->'medium'",200)} AS campaign_medium,${env('browser')} AS browser,${env('os')} AS os,${env('device')} AS device FROM first_observations),
   searched_keys AS MATERIALIZED(SELECT k.*,s.referrer,s.campaign_source,s.campaign_medium,s.browser,s.os,s.device,s.geography FROM key_totals k JOIN sources s USING(visitor_id)
    WHERE strpos(lower(concat_ws(' ',s.browser,s.os,s.device,s.geography->>'country',s.geography->'region'->>'name',s.geography->>'city')),lower(${searchSlot}))>0),
   key_page AS MATERIALIZED(SELECT * FROM searched_keys WHERE ${currentOnly} AND (${atSlot}::timestamptz IS NULL OR last_at<${atSlot}::timestamptz OR(last_at=${atSlot}::timestamptz AND visitor_id>${lastSlot})) ORDER BY last_at DESC,visitor_id ASC LIMIT ${limitSlot}),
   activity_page AS MATERIALIZED(SELECT * FROM revenue WHERE ${currentOnly} AND keyed AND visitor_id=${visitorSlot} AND(${atSlot}::timestamptz IS NULL OR(received_at,id)<(${atSlot}::timestamptz,${bind(route==='detail'?cursor?.last.key??null:null)}::uuid))ORDER BY received_at DESC,id DESC LIMIT ${limitSlot}),
   dimension_values AS MATERIALIZED(SELECT r.*,d.field,d.key FROM revenue r LEFT JOIN sources s USING(visitor_id) CROSS JOIN LATERAL(VALUES
    ('referrers',to_jsonb(CASE WHEN r.keyed THEN s.referrer END)),('channels',to_jsonb(CASE WHEN r.keyed THEN ${channelSql} ELSE 'not_recorded' END)),
    ('countries',${geographyKeySql('country','CASE WHEN r.keyed THEN s.geography END')}),('regions',${geographyKeySql('region','CASE WHEN r.keyed THEN s.geography END')}))d(field,key) WHERE ${currentOnly}),
   dimension_groups AS MATERIALIZED(SELECT field,key,${totals('d')} AS totals FROM dimension_values d WHERE field<>'channels' GROUP BY field,key),
   dimension_rank AS(SELECT *,row_number()OVER(PARTITION BY field ORDER BY(totals->>'net')::numeric DESC,(CASE WHEN field IN('countries','regions') THEN ${geographyKeyOrderSql('key')} ELSE key::text END)COLLATE "C" ASC NULLS FIRST)AS rank FROM dimension_groups),
   event_names AS MATERIALIZED(SELECT event_name,row_number()OVER(ORDER BY sum(CASE WHEN revenue_kind='sale' THEN amount ELSE -amount END)DESC,event_name COLLATE "C")AS rank FROM revenue WHERE ${currentOnly} GROUP BY event_name),
   trend AS MATERIALIZED(SELECT c.day::date::text AS date,CASE WHEN n.rank<=10 THEN r.event_name END AS name,${totals('r')}AS totals FROM calendar c JOIN revenue r ON r.received_at>=c.start AND r.received_at<c.finish JOIN event_names n USING(event_name)WHERE c.finish IS NOT NULL GROUP BY c.day,CASE WHEN n.rank<=10 THEN r.event_name END)
   SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT analytics_retained_from FROM target) AS retained_from,(SELECT start FROM bounds)AS start,(SELECT finish FROM bounds)AS finish,
    ${stamp('c.as_of')} AS clock,${stamp('p.event_before')} AS event_before,p.event_before<=c.as_of AS bound_valid,c.policy_revision,c.raw_days,${stamp('c.event_watermark')}AS watermark,${stamp('c.lost_at')}AS lost,
    json_build_object('asOf',c.as_of,'cutoff',c.cutoff,'lostAt',c.lost_at,'expiredValuesPresent',c.expired_values_present)AS session_context,
    ${reportCandidates?`(SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*)FILTER(WHERE visitor_id IS NULL))FROM ${reportCandidates})`:'null'} AS report_candidates,
    ${qualificationCandidates?`(SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*)FILTER(WHERE visitor_id IS NULL))FROM ${qualificationCandidates})`:'null'} AS qualification_candidates,
    ${item?`(SELECT json_build_object('start',start,'end',finish,'events',(SELECT count(*)FROM qualification),'identified',(SELECT count(visitor_id)FROM qualification),'members',(SELECT count(*)FROM cohort_keys))FROM qualification_bounds)`:'null'} AS qualification,
    (SELECT count(*)FROM ${population})AS qualifying_events,(SELECT count(*)FROM qualified_keys)AS qualified_keys,(SELECT count(*)FROM ${population} WHERE NOT(source='browser'AND visitor_id IS NOT NULL AND visit_id IS NOT NULL))AS unkeyed_qualification,
    (SELECT count(*)FROM revenue_projection WHERE declared AND amount IS NULL)AS invalid_declared,(SELECT count(*)FROM sources WHERE ties>1)AS ordering_ties,
    (SELECT ${totals('r')}FROM revenue r)AS totals,(SELECT ${totals('r')}FROM revenue r WHERE keyed)AS keyed,(SELECT ${totals('r')}FROM revenue r WHERE NOT keyed)AS unkeyed,
    (SELECT json_build_object('consent',count(*)FILTER(WHERE collection_basis='consent'),'cookieless',count(*)FILTER(WHERE collection_basis='cookieless'),'unknown',count(*)FILTER(WHERE collection_basis IS NULL))FROM revenue)AS collection,
    COALESCE((SELECT json_agg(json_build_object('date',c.day::date::text,'start',c.start,'end',c.finish,'totals',(SELECT ${totals('r')}FROM revenue r WHERE r.received_at>=c.start AND r.received_at<c.finish))ORDER BY c.day)FROM calendar c WHERE c.finish IS NOT NULL AND ${currentOnly}),'[]')AS daily,
    (SELECT count(*)FROM event_names)AS series_groups,COALESCE((SELECT json_agg(json_build_object('date',date,'eventName',name,'totals',totals)ORDER BY date,name COLLATE "C" NULLS LAST)FROM trend),'[]')AS trend,
    COALESCE((SELECT json_agg(json_build_object('field',field,'key',key,'totals',totals,'totalGroups',(SELECT count(*)FROM dimension_groups g WHERE g.field=d.field))ORDER BY field,rank)FROM dimension_rank d WHERE rank<=CASE WHEN field='countries'THEN 678 ELSE 100 END),'[]')AS dimensions,
    COALESCE((SELECT json_agg(json_build_object('key',key#>>'{}','totals',totals))FROM(SELECT key,${totals('d')}AS totals FROM dimension_values d WHERE field='channels'GROUP BY key)g),'[]')AS channels,
    (SELECT json_build_object('databaseCount',count(DISTINCT(geography->'databaseBuild',geography->'databaseSha256'))FILTER(WHERE geography IS NOT NULL),'oldestDatabaseBuild',min((geography->>'databaseBuild')::bigint),'newestDatabaseBuild',max((geography->>'databaseBuild')::bigint))FROM sources)AS geo,
    (SELECT count(*)FROM key_totals)AS total_keys,(SELECT count(*)FROM searched_keys)AS matching_keys,
    COALESCE((SELECT json_agg(json_build_object('visitorKey',visitor_id,'firstRevenueAt',${stamp('first_at')},'lastRevenueAt',${stamp('last_at')},'totals',totals,'source',json_build_object('referrer',referrer,'campaignSource',campaign_source,'campaignMedium',campaign_medium,'browser',browser,'os',os,'device',device,'geography',geography))ORDER BY last_at DESC,visitor_id ASC)FROM key_page),'[]')AS page,
    (SELECT totals FROM key_totals WHERE visitor_id=${visitorSlot})AS detail_totals,
    COALESCE((SELECT json_agg(json_build_object('id',id,'receivedAt',${stamp('received_at')},'eventName',event_name,'path',path,'kind',revenue_kind,'amount',amount::text,'collectionBasis',collection_basis)ORDER BY received_at DESC,id DESC)FROM activity_page),'[]')AS activity
   FROM session_context c CROSS JOIN session_page p${compare?")report ORDER BY CASE revenue_period.name WHEN 'current' THEN 0 ELSE 1 END":''}`,values);
  const row=rows[0];if(!row?.allowed||compare&&!rows[1]?.allowed)throw missing();if(!row.bound_valid||compare&&!rows[1].bound_valid)throw invalid();
  // Recheck authority using a fresh raw database clock after the actual report/event-lock wait.
  if(authority.kind==='api-key')await authorizeApiKey(authority.token,workspace,'analytics:read',client);
  if(!(await client.query('SELECT 1 FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rowCount)throw missing();
  function formatPeriod(row:typeof rows[number],query:typeof input.query,summaryOnly:boolean):RevenueResult|RevenueComparisonSummary{
  const policyHash=canonicalHash(['revenue-retention-policy-v1',row.policy_revision,row.raw_days]),evidenceHash=canonicalHash(['revenue-retention-evidence-v1',row.watermark,row.lost,row.session_context.expiredValuesPresent]);
  if(cursor&&(cursor.policyHash!==policyHash||cursor.evidenceHash!==evidenceHash))throw new FoundationError(409,'Revenue retention evidence changed. Reload this report.');
  const start=(row.start as Date).toISOString(),end=(row.finish as Date).toISOString(),coverage=retentionCoverage(start,end,row.retained_from),cohort=cohortCoverage(item,qualification,row);
  const sessionProperties=query.predicates?.sessionProperties?.length?sessionScope(row.session_context,row.report_candidates,query.predicates.sessionProperties.some(value=>value.operator==='missing'),coverage.status==='unavailable'||cohort?.membership.status==='unavailable',coverage.status==='partial'||!!cohort?.membership.countsAreLowerBounds):undefined;
  const reason=coverage.status==='unavailable'?'event_history_unavailable':cohort?.membership.status==='unavailable'?'cohort_membership_unavailable':sessionProperties?.selection.status==='unavailable'?'session_property_selection_unavailable':null,hidden=reason!==null;
  const total=money(row.totals),keyed=money(row.keyed),unkeyed=money(row.unkeyed),qualified=count(row.qualified_keys),qualifying=count(row.qualifying_events),unknown=count(row.unkeyed_qualification),invalidDeclared=count(row.invalid_declared),ties=count(row.ordering_ties);
  if(route==='detail'&&!hidden&&!row.detail_totals)throw missing();
  const provisional=Date.parse(end)>Date.parse(row.clock),incomplete=hidden||provisional||coverage.status==='partial'||unknown>0||invalidDeclared>0||ties>0||!!cohort?.membership.countsAreLowerBounds||!!sessionProperties?.selection.countsAreLowerBounds;
  const{groupBy:_,groupProperty:__,...scope}=query;
  const summary:RevenueComparisonSummary={asOf:row.clock,eventBefore:row.event_before,range:{from:query.from,to:query.to,timeZone:query.timeZone,start,end},calendar:{provisional},query:{...scope,currency},coverage,selection:{status:hidden?'unavailable':'available',reason,evidenceIncomplete:incomplete},identity:{status:hidden||qualifying>0&&qualified===0?'unavailable':unknown>0?'partial':'complete',qualifiedKeys:hidden||qualifying>0&&qualified===0?null:qualified,revenueKeys:hidden||qualifying>0&&qualified===0?null:count(row.total_keys),unkeyedQualificationEvents:hidden||sessionProperties&&row.report_candidates.unidentified>0?null:unknown},measurement:{qualifyingEvents:hidden?null:qualifying,invalidDeclaredObservations:hidden?null:invalidDeclared,orderingTieKeys:hidden?null:ties,keyed:hidden?null:keyed,unkeyed:hidden?null:unkeyed,collection:hidden?{consent:null,cookieless:null,unknown:null}:row.collection},money:hidden?null:{currency,scale:4,...total,averageSale:revenueAverage(total.sales,total.saleObservations),keyedNetPerQualifiedKey:revenueAverage(keyed.net,qualified)},retention:{policyHash,evidenceHash},...(cohort?{cohort}:{}),...(sessionProperties?{sessionProperties}:{}),...(query.predicates?{predicateMethod:advancedPredicateMethod(query.predicates)}:{})};
  if(summaryOnly)return summary;
  const dates=row.daily as {date:string;start:string;end:string;totals:RevenueTotals}[],daily:NonNullable<RevenueResult['daily']>=dates.map(day=>{const state=day.start===day.end?'skipped':Date.parse(day.start)>=Date.parse(row.clock)?'future':Date.parse(day.end)>Date.parse(row.clock)?'partial':retentionCoverage(day.start,day.end,row.retained_from).status;return{date:day.date,state,totals:hidden||state==='unavailable'||state==='future'?null:money(day.totals)};});
  const share=(sales:string)=>!incomplete&&revenueUnits(total.sales)>0n?revenueDecimal(revenueUnits(sales)*1000000n/revenueUnits(total.sales)):null;
  const breakdown=(field:string,limit:number):RevenueBreakdown=>{const entries=(row.dimensions as {field:string;key:unknown;totals:RevenueTotals;totalGroups:number}[]).filter(value=>value.field===field),displayed=entries.reduce((sum,value)=>add(sum,money(value.totals)),zero());return{rows:entries.map(value=>({key:value.key as RevenueBreakdown['rows'][number]['key'],totals:money(value.totals),saleShare:share(value.totals.sales)})),totalGroups:count(entries[0]?.totalGroups??0),limit,truncated:count(entries[0]?.totalGroups??0)>limit,displayed,omitted:subtract(total,displayed)};};
  const channels=new Map<string,RevenueTotals>();for(const entry of row.channels){const name=entry.key;channels.set(name,add(channels.get(name)??zero(),money(entry.totals)));}
  const channelRows=[...channels].sort((a,b)=>revenueUnits(a[1].net)===revenueUnits(b[1].net)?a[0]<b[0]?-1:1:revenueUnits(a[1].net)>revenueUnits(b[1].net)?-1:1).map(([key,totals])=>({key,totals,saleShare:share(totals.sales)}));
  const names=[...new Set((row.trend as {eventName:string|null}[]).map(entry=>entry.eventName))],series=names.map(name=>({eventName:name,other:name===null,daily:dates.map(day=>daily.find(value=>value.date===day.date)?.totals===null?null:money(row.trend.find((entry:{date:string;eventName:string|null})=>entry.date===day.date&&entry.eventName===name)?.totals??zero()))}));
  const source=(value:Omit<RevenueSource,'channel'>):RevenueSource=>({...value,channel:revenueChannel(value.campaignMedium,value.campaignSource,value.referrer)});
  const page=(route==='detail'?row.activity:row.page).slice(0,pageSize),last=page.at(-1);let nextCursor:string|null=null;
  if(!hidden&&(route==='detail'?row.activity:row.page).length>pageSize&&last){const value:Cursor={version:1,route:route==='detail'?'detail':'sessions',projectId,scope:scopeHash,pageSize,eventBefore:row.event_before,policyHash,evidenceHash,last:{at:route==='detail'?last.receivedAt:last.lastRevenueAt,key:route==='detail'?last.id:last.visitorKey}};nextCursor=Buffer.from(JSON.stringify(value)).toString('base64url');if(nextCursor.length>2048)throw large();}
  const result:RevenueResult={version:revenueReportVersion,currencyCatalogVersion:revenueCurrencyCatalogVersion,projectId,route,...summary,method:{qualification:'matching-native-key-or-direct-unkeyed',dimension:'first-retained-observation-in-window',identityUnit:'rotating-native-visitor-key',historyComplete:false,captureCoverage:'unknown',channel:'recorded-channel-tags-v1',paidVerification:'unavailable'},daily:hidden||route!=='report'?null:daily,series:hidden||route!=='report'?null:series,seriesGroups:hidden?null:count(row.series_groups),
   dimensions:hidden||route!=='report'?null:{referrers:breakdown('referrers',100),countries:breakdown('countries',678),regions:breakdown('regions',100),channels:{rows:channelRows,totalGroups:channelRows.length,limit:12,truncated:false,displayed:total,omitted:zero()}},
   dimensionGeographyProvenance:{source:'db-ip-city-lite',scope:'selected-first-dimension-observations-for-revenue-bearing-keys',databaseCount:hidden?null:count(row.geo.databaseCount),oldestDatabaseBuild:hidden?null:row.geo.oldestDatabaseBuild,newestDatabaseBuild:hidden?null:row.geo.newestDatabaseBuild},
   sessions:{search,totalRevenueKeys:hidden?null:count(row.total_keys),matchingSearchKeys:hidden?null:count(row.matching_keys),rows:hidden||route==='detail'?null:page.map((entry:RevenueResult['sessions']['rows'] extends(infer T)[]|null?T:never)=>({...entry,totals:money(entry.totals),source:source(entry.source)}))},
   detail:route==='detail'?{visitorKey:visitorKey!,summary:hidden?null:money(row.detail_totals),activity:hidden?null:page}:null,paging:{consistency:'current-per-page',limit:pageSize,nextCursor},retention:{policyHash,evidenceHash}};
  return result;
  }
  const result=formatPeriod(rows[0],query,false) as RevenueResult;
  if(compare&&derived&&previousQuery){const summary=formatPeriod(rows[1],previousQuery,true) as RevenueComparisonSummary;const state=(value:RevenueComparisonSummary)=>Date.parse(value.range.start)>=Date.parse(value.asOf)?'future' as const:value.calendar.provisional?'partial' as const:'complete' as const;result.comparison={version:'native-revenue-comparison-v1',mode:compare,summary,calendar:{current:state(result),comparison:state(summary)},periods:{currentDays:derived.alignment.currentDays,comparisonDays:derived.alignment.comparisonDays,overlapDays:derived.alignment.overlapDays},change:revenueComparisonChanges(result,summary)};}
  if(Buffer.byteLength(JSON.stringify(result))>revenueReportLimits.responseBytes)throw large();await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03','22003'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'This revenue query exceeded its limits. Choose a shorter range or more filters.');throw error;}finally{client.release();}
}
