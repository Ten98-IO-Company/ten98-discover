import {z} from 'zod';
import {getDatabase} from './db.ts';
import {FoundationError} from './auth.ts';
import {authenticateApiKey,authorizeApiKey} from './api-keys.ts';
import {nativeCollectionPolicy,publicAnalyticsSettings} from './native-analytics.ts';
import {analyticsEnvironment} from './analytics-environment.ts';
import {resolveAnalyticsNetwork} from './analytics-network.ts';
import {collectGeography} from './analytics-geography.ts';
import {eventPath} from './validation.ts';
import {environmentCatalog,environmentVersion} from '../lib/analytics-environment.ts';
import {performanceObservation,readPerformanceQuery,performanceReport,type PerformanceReport} from '../lib/web-performance.ts';
import type {SessionReadAuthority} from './session-explorer.ts';

/** No visitor/session identity, event traffic, properties or client-supplied environment. */
export async function collectPerformance(request:Request,raw:unknown,peerAddress?:string){
 const input=performanceObservation.parse(raw),client=await getDatabase().pool.connect();
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='5s'");
  await client.query('SELECT id FROM project WHERE public_key=$1 FOR SHARE',[input.siteKey]);
  const {project,userAgent,reason,basis}=await nativeCollectionPolicy(client,request,input.siteKey,input,'event');
  if(reason||project.analytics_settings.capturePerformance!==true){await client.query('COMMIT');return {accepted:false,reason:reason??'collection_disabled'};}
  const settings=publicAnalyticsSettings(project.analytics_settings),screen=settings.captureScreen?input.dimensions?.screen:undefined;
  const dimensions={...analyticsEnvironment(userAgent,screen?.width),...screen?{screenWidth:screen.width,screenHeight:screen.height}:{},...settings.captureGeography===true?{geography:collectGeography(resolveAnalyticsNetwork(request,peerAddress))}:{}};
  const result=await client.query(`INSERT INTO web_performance(project_id,navigation_id,metric,value,revision,origin,path,dimensions,collection_basis)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
   ON CONFLICT(project_id,navigation_id,metric) DO UPDATE SET value=excluded.value,revision=excluded.revision,dimensions=CASE WHEN web_performance.created_at<(SELECT analytics_retained_from FROM project WHERE id=$1) THEN excluded.dimensions ELSE web_performance.dimensions END,created_at=CASE WHEN web_performance.created_at<(SELECT analytics_retained_from FROM project WHERE id=$1) THEN excluded.created_at ELSE web_performance.created_at END,updated_at=clock_timestamp()
    WHERE (excluded.revision>web_performance.revision OR web_performance.created_at<(SELECT analytics_retained_from FROM project WHERE id=$1)) AND web_performance.origin=excluded.origin
      AND web_performance.path=excluded.path AND web_performance.collection_basis=excluded.collection_basis
   RETURNING revision`,[project.id,input.navigationId,input.metric,input.value,input.revision,new URL(input.url).origin,eventPath(input.url),JSON.stringify(dimensions),basis]);
  await client.query('COMMIT');return {accepted:true,duplicate:!result.rowCount};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'Performance collection took too long. Its outcome may be unknown.');throw error;}
 finally{client.release();}
}

const stats=(alias:string)=>`json_build_object('count',${alias}.n,'p50',${alias}.p50,'p75',${alias}.p75,'p95',${alias}.p95)`;
const aggregates=`count(o.value) AS n,percentile_cont(0.5) WITHIN GROUP(ORDER BY o.value) AS p50,percentile_cont(0.75) WITHIN GROUP(ORDER BY o.value) AS p75,percentile_cont(0.95) WITHIN GROUP(ORDER BY o.value) AS p95`;
export async function projectPerformance(projectId:string,authority:SessionReadAuthority,params:URLSearchParams|string):Promise<PerformanceReport>{
 if(!z.uuid().safeParse(projectId).success)throw new FoundationError(400,'Choose a project.');projectId=projectId.toLowerCase();
 let query:ReturnType<typeof readPerformanceQuery>;try{query=readPerformanceQuery(params);}catch{throw new FoundationError(400,'Choose a valid performance range, metric, percentile and supported filters.');}
 const client=await getDatabase().pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='5s'; SET LOCAL TIME ZONE 'UTC'");
  const preliminary=authority.kind==='api-key'?await authenticateApiKey(authority.token,client):null;
  let userId=authority.kind==='session'?authority.userId:preliminary!.userId;
  const hint=(await client.query('SELECT p.workspace_id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rows[0]?.workspace_id as string|undefined;
  if(!hint||preliminary&&preliminary.workspaceId!==hint)throw new FoundationError(404,'Project not found or unavailable.');
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[hint]);
  const key=authority.kind==='api-key'?await authorizeApiKey(authority.token,hint,'analytics:read',client):null;if(key)userId=key.userId;
  // One current authority clock and one SQL snapshot for every metric, UTC day and category.
  // ponytail: percentile scans cover raw retained values; add reviewed rollups only after measured volume requires them.
  const {rows}=await client.query(`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at),
   key_authority AS MATERIALIZED (SELECT $3::uuid IS NULL OR EXISTS(SELECT 1 FROM api_key k JOIN membership m ON m.workspace_id=k.workspace_id AND m.user_id=k.issuer_user_id
    JOIN project p ON p.workspace_id=k.workspace_id AND p.id=$1 CROSS JOIN clock c WHERE k.id=$3::uuid AND k.issuer_user_id=$2
    AND m.role IN('owner','admin','editor','viewer') AND 'analytics:read'=ANY(k.scopes) AND k.revoked_at IS NULL AND k.expires_at>c.at) AS valid),
   target AS MATERIALIZED (SELECT p.analytics_settings,m.role,GREATEST(p.analytics_retained_from,c.at-w.raw_analytics_days*interval '24 hours') AS cutoff,c.at
    FROM project p JOIN workspace w ON w.id=p.workspace_id JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2
    CROSS JOIN clock c CROSS JOIN key_authority k WHERE p.id=$1 AND k.valid AND m.role IN('owner','admin','editor','viewer')),
   raw AS MATERIALIZED (SELECT v.metric,v.value,v.path,v.created_at,
    CASE WHEN v.dimensions->>'environmentVersion'=$10 AND v.dimensions->>'browser'=ANY($11::text[]) THEN v.dimensions->>'browser' END AS browser,
    CASE WHEN v.dimensions->>'environmentVersion'=$10 AND v.dimensions->>'os'=ANY($12::text[]) THEN v.dimensions->>'os' END AS os,
    CASE WHEN v.dimensions->>'environmentVersion'=$10 AND v.dimensions->>'device'=ANY($13::text[]) THEN v.dimensions->>'device' END AS device
    FROM web_performance v CROSS JOIN target t WHERE v.project_id=$1 AND v.created_at>=$4::date AND v.created_at<($5::date+1)
      AND v.created_at>=t.cutoff AND v.created_at<t.at AND ($9::text IS NULL OR v.path=$9)),
   observed AS MATERIALIZED (SELECT * FROM raw WHERE
    (NOT $8::jsonb ? 'browser' OR CASE WHEN $8::jsonb->>'browser'='not-recorded' THEN browser IS NULL ELSE browser=$8::jsonb->>'browser' END)
    AND (NOT $8::jsonb ? 'os' OR CASE WHEN $8::jsonb->>'os'='not-recorded' THEN os IS NULL ELSE os=$8::jsonb->>'os' END)
    AND (NOT $8::jsonb ? 'device' OR CASE WHEN $8::jsonb->>'device'='not-recorded' THEN device IS NULL ELSE device=$8::jsonb->>'device' END)),
   metrics AS (SELECT m.metric,${aggregates} FROM unnest(ARRAY['lcp','inp','cls','fcp','ttfb']) m(metric) LEFT JOIN observed o ON o.metric=m.metric GROUP BY m.metric),
   daily_values AS (SELECT created_at::date AS day,${aggregates} FROM observed o WHERE metric=$6 GROUP BY 1),
   daily AS (SELECT calendar.day::date AS day,COALESCE(d.n,0) AS n,d.p50,d.p75,d.p95 FROM generate_series($4::date::timestamp,$5::date::timestamp,interval '1 day') calendar(day) LEFT JOIN daily_values d ON d.day=calendar.day),
   grouped AS (SELECT CASE $7 WHEN 'path' THEN path WHEN 'browser' THEN browser WHEN 'os' THEN os ELSE device END AS value,${aggregates} FROM observed o WHERE metric=$6 GROUP BY 1),
   top_groups AS (SELECT * FROM grouped ORDER BY n DESC,value COLLATE "C" ASC NULLS LAST LIMIT 51)
   SELECT (SELECT valid FROM key_authority) AS key_valid,t.role,t.analytics_settings,t.at,t.cutoff,
    (SELECT json_object_agg(metric,${stats('metrics')}) FROM metrics) AS summary,
    COALESCE((SELECT json_agg(json_build_object('day',to_char(day,'YYYY-MM-DD'),'stats',${stats('daily')}) ORDER BY day) FROM daily),'[]') AS daily,
    json_build_object('limited',(SELECT count(*)>50 FROM top_groups),'items',COALESCE((SELECT json_agg(json_build_object('value',value,'stats',${stats('g')}) ORDER BY n DESC,value COLLATE "C" ASC NULLS LAST) FROM (SELECT * FROM top_groups ORDER BY n DESC,value COLLATE "C" ASC NULLS LAST LIMIT 50) g),'[]')) AS breakdown
   FROM target t`,[projectId,userId,key?.id??null,query.from,query.to,query.metric,query.breakdown,JSON.stringify(query.filters),query.path??null,environmentVersion,environmentCatalog.browser,environmentCatalog.os,environmentCatalog.device]);
  const row=rows[0];if(key&&!row?.key_valid)throw new FoundationError(401,'The API key is invalid, expired or unavailable.');if(!row)throw new FoundationError(404,'Project not found or unavailable.');
  const settings=publicAnalyticsSettings(row.analytics_settings),parsed=performanceReport.safeParse({version:1,projectId,role:row.role,enabled:settings.enabled&&settings.capturePerformance===true,query,asOf:(row.at as Date).toISOString(),retainedFrom:(row.cutoff as Date).toISOString(),summary:row.summary,daily:row.daily,breakdown:row.breakdown});if(!parsed.success)throw new FoundationError(503,'The performance report could not be verified.');const result=parsed.data;
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>2097152)throw new FoundationError(503,'The performance report is too large. Narrow its filters.');
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'Performance is temporarily unavailable. Try again.');throw error;}
 finally{client.release();}
}
