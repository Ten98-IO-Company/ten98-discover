import {z} from 'zod';
import {getDatabase} from './db.ts';
import {FoundationError} from './auth.ts';
import {authenticateApiKey,authorizeApiKey} from './api-keys.ts';
import {retentionCoverage} from './retention.ts';
import {publicAnalyticsSettings} from './native-analytics.ts';
import type {SessionReadAuthority} from './session-explorer.ts';
import {environmentCatalog,environmentVersion} from '../lib/analytics-environment.ts';
import {realtimeLimits,type RealtimeSnapshot} from '../lib/realtime.ts';
import {geographyProjectionSql,realtimeGeographyCtes,realtimeGeographySql,applyRealtimeGeographyCoverage} from './geography-sql.ts';

const missing=()=>new FoundationError(404,'Project not found or unavailable.');
const limitation='Estimates count retained project-scoped visitor keys, not persistent people. Keys rotate monthly and can change with identity inputs or the signing secret; cookieless and consented keys stay separate. Minute visitor estimates cannot be added to obtain period visitors. Active estimates include any observed event; period and minute estimates require page views.';
const stamp=(expression:string)=>`to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export function realtimeProject(projectId:string,params:URLSearchParams){
 if(!z.uuid().safeParse(projectId).success||[...params].length)throw new FoundationError(400,'Live traffic uses the fixed window with no query parameters.');
 return projectId.toLowerCase();
}

export async function projectRealtime(projectId:string,authority:SessionReadAuthority,params:URLSearchParams):Promise<RealtimeSnapshot>{
 projectId=realtimeProject(projectId,params);
 const client=await getDatabase().pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='5s'; SET LOCAL TIME ZONE 'UTC'");
  const preliminary=authority.kind==='api-key'?await authenticateApiKey(authority.token,client):null;
  let userId=authority.kind==='session'?authority.userId:preliminary!.userId;
  const hint=(await client.query('SELECT p.workspace_id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rows[0]?.workspace_id as string|undefined;
  if(!hint||preliminary&&preliminary.workspaceId!==hint)throw missing();
  // Same short workspace read gate as session reports; refresh authority after any wait.
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[hint]);
  const currentKey=authority.kind==='api-key'?await authorizeApiKey(authority.token,hint,'analytics:read',client):null;
  if(currentKey)userId=currentKey.userId;
  // ponytail: scan the indexed, fixed 30-minute retained population directly; introduce rollups only after measured query cost requires them.
  const {rows}=await client.query(`WITH clock AS MATERIALIZED (SELECT at AS authority_at,date_trunc('milliseconds',at) AS as_of FROM (SELECT clock_timestamp() AS at) instant),
   key_authority AS MATERIALIZED (SELECT $3::uuid IS NULL OR EXISTS(SELECT 1 FROM api_key k JOIN membership m ON m.workspace_id=k.workspace_id AND m.user_id=k.issuer_user_id
    JOIN project p ON p.workspace_id=k.workspace_id AND p.id=$1 CROSS JOIN clock c
    WHERE k.id=$3::uuid AND k.issuer_user_id=$2 AND m.role IN('owner','admin','editor','viewer') AND 'analytics:read'=ANY(k.scopes)
      AND k.revoked_at IS NULL AND k.expires_at>c.authority_at) AS valid),
   target AS MATERIALIZED (SELECT p.id,p.origin,p.analytics_settings,p.analytics_retained_from,w.raw_analytics_days
    FROM project p JOIN workspace w ON w.id=p.workspace_id JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2
    CROSS JOIN key_authority k WHERE p.id=$1 AND k.valid),
   context AS MATERIALIZED (SELECT t.*,c.as_of,c.as_of-interval '30 minutes' AS start,c.as_of-interval '5 minutes' AS active_start,
    GREATEST(t.analytics_retained_from,c.as_of-t.raw_analytics_days*interval '24 hours') AS cutoff FROM target t CROSS JOIN clock c),
   observations AS MATERIALIZED (SELECT e.id,e.event_name,e.path,e.received_at,e.visitor_id,e.visit_id,e.source,e.collection_basis,${geographyProjectionSql('e')} AS geography,
    CASE WHEN jsonb_typeof(e.dimensions->'origin')='string' AND length(e.dimensions->>'origin') BETWEEN 1 AND 2048 THEN e.dimensions->>'origin' ELSE c.origin END AS origin,
    CASE WHEN jsonb_typeof(e.dimensions->'referrerHost')='string' AND length(e.dimensions->>'referrerHost') BETWEEN 1 AND 2048 THEN e.dimensions->>'referrerHost' END AS referrer_host,
    CASE WHEN e.dimensions->>'environmentVersion'=$4 THEN $4 END AS environment_version,
    CASE WHEN e.dimensions->>'environmentVersion'=$4 AND e.dimensions->>'browser'=ANY($5::text[]) THEN e.dimensions->>'browser' END AS browser,
    CASE WHEN e.dimensions->>'environmentVersion'=$4 AND e.dimensions->>'os'=ANY($6::text[]) THEN e.dimensions->>'os' END AS os,
    CASE WHEN e.dimensions->>'environmentVersion'=$4 AND e.dimensions->>'device'=ANY($7::text[]) THEN e.dimensions->>'device' END AS device
    FROM event e CROSS JOIN context c WHERE e.project_id=$1 AND e.received_at>=c.start AND e.received_at<c.as_of AND e.received_at>=c.cutoff),
   minute_counts AS (SELECT date_trunc('minute',received_at) AS minute,count(*) FILTER(WHERE event_name='page_view') AS pageviews,
    count(*) FILTER(WHERE event_name<>'page_view') AS custom,count(*) FILTER(WHERE event_name='page_view' AND visitor_id IS NOT NULL) AS identified,
    count(DISTINCT visitor_id) FILTER(WHERE event_name='page_view') AS visitors FROM observations GROUP BY 1),
   minutes AS (SELECT GREATEST(calendar.minute,c.start) AS start,LEAST(calendar.minute+interval '1 minute',c.as_of) AS finish,
    COALESCE(b.pageviews,0) AS pageviews,COALESCE(b.custom,0) AS custom,COALESCE(b.identified,0) AS identified,b.visitors
    FROM context c CROSS JOIN LATERAL generate_series(date_trunc('minute',c.start),date_trunc('minute',c.as_of-interval '1 microsecond'),interval '1 minute') AS calendar(minute)
    LEFT JOIN minute_counts b ON b.minute=calendar.minute),
   pages AS (SELECT path,count(*) AS pageviews FROM observations WHERE event_name='page_view' GROUP BY path ORDER BY count(*) DESC,path COLLATE "C" ASC LIMIT 15),
   referrers AS (SELECT referrer_host,count(*) AS pageviews FROM observations WHERE event_name='page_view' GROUP BY referrer_host ORDER BY count(*) DESC,referrer_host COLLATE "C" ASC NULLS LAST LIMIT 15),
   recent AS (SELECT * FROM observations ORDER BY received_at DESC,id DESC LIMIT 100)${realtimeGeographyCtes}
   SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT valid FROM key_authority) AS key_valid,c.as_of,c.start,c.active_start,c.cutoff,c.analytics_settings,
    json_build_object('pageViews',count(*) FILTER(WHERE event_name='page_view'),'customEvents',count(*) FILTER(WHERE event_name<>'page_view'),
     'estimatedVisitors',CASE WHEN count(*) FILTER(WHERE event_name='page_view' AND visitor_id IS NOT NULL)>0 THEN count(DISTINCT visitor_id) FILTER(WHERE event_name='page_view') END) AS totals,
    json_build_object('identifiedPageViews',count(*) FILTER(WHERE event_name='page_view' AND visitor_id IS NOT NULL),'unidentifiedPageViews',count(*) FILTER(WHERE event_name='page_view' AND visitor_id IS NULL)) AS measurement,
    json_build_object('cookieless',count(*) FILTER(WHERE event_name='page_view' AND collection_basis='cookieless'),'consent',count(*) FILTER(WHERE event_name='page_view' AND collection_basis='consent'),'unknown',count(*) FILTER(WHERE event_name='page_view' AND collection_basis IS NULL)) AS collection,
    json_build_object('estimatedVisitors',CASE WHEN count(*) FILTER(WHERE received_at>=c.active_start AND visitor_id IS NOT NULL)>0 THEN count(DISTINCT visitor_id) FILTER(WHERE received_at>=c.active_start) END,
     'identifiedEvents',count(*) FILTER(WHERE received_at>=c.active_start AND visitor_id IS NOT NULL),'unidentifiedEvents',count(*) FILTER(WHERE received_at>=c.active_start AND visitor_id IS NULL)) AS active,
    json_build_object('recordedPageViews',count(*) FILTER(WHERE event_name='page_view' AND referrer_host IS NOT NULL),'notRecordedPageViews',count(*) FILTER(WHERE event_name='page_view' AND referrer_host IS NULL)) AS referrer_coverage,
    ${realtimeGeographySql} AS geography,count(o.id) AS total_events,
    COALESCE((SELECT json_agg(json_build_object('start',start,'end',finish,'partial',finish-start<interval '1 minute','pageViews',pageviews,'customEvents',custom,
     'estimatedVisitors',CASE WHEN identified>0 THEN visitors END,'identifiedPageViews',identified,'unidentifiedPageViews',pageviews-identified) ORDER BY start) FROM minutes),'[]') AS minutes,
    COALESCE((SELECT json_agg(json_build_object('path',path,'pageViews',pageviews) ORDER BY pageviews DESC,path COLLATE "C") FROM pages),'[]') AS pages,
    COALESCE((SELECT json_agg(json_build_object('host',referrer_host,'pageViews',pageviews) ORDER BY pageviews DESC,referrer_host COLLATE "C" ASC NULLS LAST) FROM referrers),'[]') AS referrers,
    COALESCE((SELECT json_agg(json_build_object('id',id,'receivedAt',${stamp('received_at')},'kind',CASE WHEN event_name='page_view' THEN 'pageview' ELSE 'custom' END,
     'eventName',event_name,'path',path,'origin',origin,'visitorKey',visitor_id,'browser',browser,'os',os,'device',device,'environmentVersion',environment_version,
     'referrerHost',referrer_host,'source',source,'collectionBasis',collection_basis,'geography',geography) ORDER BY received_at DESC,id DESC) FROM recent),'[]') AS activity
   FROM context c LEFT JOIN observations o ON true GROUP BY c.as_of,c.start,c.active_start,c.cutoff,c.analytics_settings`,
   [projectId,userId,currentKey?.id??null,environmentVersion,environmentCatalog.browser,environmentCatalog.os,environmentCatalog.device]);
  const row=rows[0];if(currentKey&&!row?.key_valid)throw new FoundationError(401,'The API key is invalid, expired or unavailable.');if(!row?.allowed)throw missing();
  const start=(row.start as Date).toISOString(),end=(row.as_of as Date).toISOString(),activeStart=(row.active_start as Date).toISOString(),cutoff=(row.cutoff as Date).toISOString();
  const coverage=retentionCoverage(start,end,cutoff),activeCoverage=retentionCoverage(activeStart,end,cutoff),unavailable=coverage.status==='unavailable';
  const result:RealtimeSnapshot={version:'native-realtime-v1',projectId,asOf:end,range:{start,end,timeZone:'UTC',seconds:1800},activeWindow:{start:activeStart,end,seconds:300},coverage,
   collection:{mode:publicAnalyticsSettings(row.analytics_settings).collectionMode??'consent-first',captureCoverage:'unknown',pageViews:unavailable?{cookieless:null,consent:null,unknown:null}:row.collection},
   totals:unavailable?{pageViews:null,customEvents:null,estimatedVisitors:null}:row.totals,
   measurement:{method:'rotating-project-key',identifiedPageViews:unavailable?null:row.measurement.identifiedPageViews,unidentifiedPageViews:unavailable?null:row.measurement.unidentifiedPageViews,limitation},
   active:{...(activeCoverage.status==='unavailable'?{estimatedVisitors:null,identifiedEvents:null,unidentifiedEvents:null}:row.active),coverage:activeCoverage},
   minutes:row.minutes.map((minute:Omit<RealtimeSnapshot['minutes'][number],'coverage'>)=>{const from=new Date(minute.start).toISOString(),to=new Date(minute.end).toISOString(),status=retentionCoverage(from,to,cutoff).status;return {...minute,start:from,end:to,coverage:status,...status==='unavailable'?{pageViews:null,customEvents:null,estimatedVisitors:null,identifiedPageViews:null,unidentifiedPageViews:null}:{}};}),
   pages:row.pages,referrers:row.referrers,referrerCoverage:unavailable?{recordedPageViews:null,notRecordedPageViews:null}:row.referrer_coverage,
   activity:{limit:100,totalEvents:unavailable?null:Number(row.total_events),sampled:!unavailable&&Number(row.total_events)>realtimeLimits.activity,rows:row.activity},
   geography:applyRealtimeGeographyCoverage(row.geography,coverage.status)};
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'Live traffic is temporarily unavailable. Try again.');throw error;}
 finally{client.release();}
}
