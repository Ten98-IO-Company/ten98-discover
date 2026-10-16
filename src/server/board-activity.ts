import type {PoolClient} from 'pg';
import type {BoardActivityResult,BoardDimensionResult,BoardSummaryResult} from '../lib/boards.ts';
import {revenueChannelRules} from '../lib/revenue.ts';
import {FoundationError} from './auth.ts';
import {analyticsPopulation} from './analytics-population.ts';
import {analyticsSummarySql,hideAnalyticsSummary} from './analytics.ts';
import {analyticsCustomVisitsSql} from './analytics-dimensions.ts';
import type {explorerQuery} from './explorer-input.ts';
import {retentionCoverage} from './retention.ts';

// Called inside the board's current-membership workspace SHARE gate. No new capture or rollup.
export async function boardActivity(client:PoolClient,projectId:string,userId:string,scope:string,query:ReturnType<typeof explorerQuery>,profile:BoardActivityResult['profile'],limit=10):Promise<BoardActivityResult>{
 if(query.cohort||query.predicates)throw new FoundationError(400,'Board activity supports exact field and typed event-property filters.');
 if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[query.timeZone])).rowCount)throw new FoundationError(400,'The database does not support this timezone.');
 const selected={...query,kind:profile==='events'?'custom':'pageviews'}, {ctes,values,population}=analyticsPopulation(projectId,userId,selected,null,false);
 values.push(limit);const take='$'+values.length;
 const counts=(alias:string)=>`jsonb_build_object('events',count(${alias}.id),'identifiedEvents',count(${alias}.visitor_id),'unidentifiedEvents',count(${alias}.id) FILTER(WHERE ${alias}.visitor_id IS NULL),'estimatedVisitors',CASE WHEN count(${alias}.visitor_id)>0 THEN count(DISTINCT ${alias}.visitor_id) END)`;
 const row=(await client.query(`${ctes}, daily_counts AS (
   SELECT (received_at AT TIME ZONE $5)::date AS day,count(*) AS events,count(visitor_id) AS identified,count(DISTINCT visitor_id) AS visitors FROM ${population} GROUP BY 1
  ), weekly_counts AS (
   SELECT extract(isodow FROM received_at AT TIME ZONE $5)::int AS weekday,extract(hour FROM received_at AT TIME ZONE $5)::int AS hour,
    count(*) AS events,count(visitor_id) AS identified,count(DISTINCT visitor_id) AS visitors FROM ${population} GROUP BY 1,2
  ), event_names AS MATERIALIZED (SELECT event_name,count(*) AS events FROM ${population} GROUP BY event_name),
  ranked AS MATERIALIZED (SELECT * FROM event_names ORDER BY events DESC,event_name COLLATE "C" LIMIT ${take}),
  event_days AS (SELECT event_name,(received_at AT TIME ZONE $5)::date AS day,count(*) AS events FROM ${population} GROUP BY 1,2)
  SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT analytics_retained_from FROM target) AS retained_from,
   (SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,(SELECT ${counts('s')} FROM ${population} s) AS totals,
   (SELECT json_agg(json_build_object('date',to_char(c.day,'YYYY-MM-DD'),'start',c.start,'end',c.finish,'events',COALESCE(d.events,0),'identifiedEvents',COALESCE(d.identified,0),'unidentifiedEvents',COALESCE(d.events-d.identified,0),'estimatedVisitors',CASE WHEN d.identified>0 THEN d.visitors END) ORDER BY c.day)
    FROM calendar c LEFT JOIN daily_counts d ON d.day=c.day::date WHERE c.finish IS NOT NULL) AS daily,
   (SELECT json_agg(json_build_object('weekday',w,'hour',h,'events',COALESCE(d.events,0),'identifiedEvents',COALESCE(d.identified,0),'unidentifiedEvents',COALESCE(d.events-d.identified,0),'estimatedVisitors',CASE WHEN d.identified>0 THEN d.visitors END) ORDER BY w,h)
    FROM generate_series(1,7) w CROSS JOIN generate_series(0,23) h LEFT JOIN weekly_counts d ON d.weekday=w AND d.hour=h) AS weekly,
   (SELECT count(*) FROM event_names)::text AS total_names,
   (SELECT COALESCE(json_agg(json_build_object('name',r.event_name,'events',r.events,'daily',(SELECT json_agg(json_build_object('date',to_char(c.day,'YYYY-MM-DD'),'events',COALESCE(d.events,0)) ORDER BY c.day) FROM calendar c LEFT JOIN event_days d ON d.day=c.day::date AND d.event_name=r.event_name WHERE c.finish IS NOT NULL)) ORDER BY r.events DESC,r.event_name COLLATE "C"),'[]'::json) FROM ranked r) AS series,
   (SELECT COALESCE(sum(events),0)::text FROM event_names n WHERE NOT EXISTS(SELECT 1 FROM ranked r WHERE r.event_name=n.event_name)) AS other_events,
   (SELECT json_agg(json_build_object('date',to_char(c.day,'YYYY-MM-DD'),'events',COALESCE((SELECT sum(d.events) FROM event_days d WHERE d.day=c.day::date AND NOT EXISTS(SELECT 1 FROM ranked r WHERE r.event_name=d.event_name)),0)) ORDER BY c.day) FROM calendar c WHERE c.finish IS NOT NULL) AS other_daily`,values)).rows[0];
 if(!row.allowed)throw new FoundationError(404,'Project not found or unavailable.');
 const start=row.start.toISOString(),end=row.finish.toISOString(),coverage=retentionCoverage(start,end,row.retained_from),unavailable=coverage.status==='unavailable';
 const blank={events:null,identifiedEvents:null,unidentifiedEvents:null,estimatedVisitors:null};
 const daily:BoardActivityResult['daily']=row.daily.map((day:BoardActivityResult['daily'][number])=>{const from=new Date(day.start).toISOString(),to=new Date(day.end).toISOString(),status=retentionCoverage(from,to,row.retained_from).status;return{...day,start:from,end:to,skipped:from===to,coverage:status,...status==='unavailable'?blank:{}};});
 const byDay=new Map(daily.map(day=>[day.date,day.coverage]));
 const series:BoardActivityResult['series']=profile!=='events'||unavailable?[]:row.series.map((item:BoardActivityResult['series'][number])=>({...item,daily:item.daily.map(day=>({...day,events:byDay.get(day.date)==='unavailable'?null:day.events}))}));
 const result:BoardActivityResult={version:'native-board-activity-v1',profile,projectId,scope,range:{from:query.from,to:query.to,timeZone:query.timeZone,start,end},coverage,
  method:{identity:'rotating-project-key',population:profile==='events'?'matching-custom-events':'matching-pageviews',visitorCountsAdditive:false,weeklyRepeatedHours:'combined',eventRanking:'whole-filtered-range-count-then-name'},
  totals:unavailable?blank:row.totals,daily,weekly:profile==='weekly'?row.weekly.map((bin:BoardActivityResult['weekly'][number])=>({...bin,coverage:coverage.status,...unavailable?blank:{}})):[],series,
  eventNames:profile==='events'?{total:unavailable?null:Number(row.total_names),returned:series.length,omitted:unavailable?null:Number(row.total_names)-series.length,otherEvents:unavailable?null:Number(row.other_events),otherDaily:row.other_daily.map((day:{date:string;events:number})=>({...day,events:byDay.get(day.date)==='unavailable'?null:day.events}))}:null};
 // Fail instead of emitting rounded bigint counts or an oversized response.
 const pending:unknown[]=[result];while(pending.length){const value=pending.pop();if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<0))throw new FoundationError(503,'The board activity result is too large. Narrow its dates or filters.');if(value&&typeof value==='object')pending.push(...Object.values(value));}
 return result;
}

// The existing workspace gate owns current authority/policy and the 5s SQL timeout.
// Filters qualify visits; boundaries use every retained pageview in the requested window.
// ponytail: scan complete qualified visits, not the bounded journey reader; partition only if measured SQL cost requires it.
export async function boardDimension(client:PoolClient,projectId:string,userId:string,scope:string,query:ReturnType<typeof explorerQuery>,dimension:BoardDimensionResult['dimension'],limit:number):Promise<BoardDimensionResult>{
 if(query.cohort||query.predicates)throw new FoundationError(400,'Board dimensions support exact field and typed event-property filters.');
 if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[query.timeZone])).rowCount)throw new FoundationError(400,'The database does not support this timezone.');
 const {ctes,values,population}=analyticsPopulation(projectId,userId,{...query,kind:'pageviews'},null,false),boundary=dimension==='entry'||dimension==='exit';
 values.push(limit);const take='$'+values.length;
 const channel="CASE "+revenueChannelRules.map(([name,tokens])=>"WHEN lower(s.dimensions->'campaign'->>'medium')=ANY(ARRAY["+tokens.map(token=>"'"+token+"'").join(',')+"])THEN '"+name+"'").join(' ')+" WHEN NULLIF(s.dimensions->'campaign'->>'medium','')IS NOT NULL OR NULLIF(s.dimensions->'campaign'->>'source','')IS NOT NULL THEN 'other_tagged' WHEN NULLIF(s.dimensions->>'referrerHost','')IS NOT NULL THEN 'referrer_only' ELSE 'not_recorded' END";
 const key=dimension==='hostname'?`substring(s.dimensions->>'origin' from '^https?://(\\[[0-9a-f:.]+\\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$')`:channel;
 const row=(await client.query(`${ctes}, qualified_visits AS MATERIALIZED(
   SELECT DISTINCT visitor_id,visit_id FROM ${population} WHERE visitor_id IS NOT NULL AND visit_id IS NOT NULL
  )${boundary?`, retained_visit_pages AS MATERIALIZED(
   SELECT e.* FROM event e JOIN target t ON t.id=e.project_id JOIN qualified_visits q USING(visitor_id,visit_id)
    WHERE e.event_name='page_view' AND(t.analytics_retained_from IS NULL OR e.received_at>=t.analytics_retained_from)
  ), window_visit_pages AS MATERIALIZED(
   SELECT e.* FROM retained_visit_pages e CROSS JOIN bounds b WHERE e.received_at>=b.start AND e.received_at<b.finish AND(e.received_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
  ), visit_order AS MATERIALIZED(
   SELECT e.*,row_number()OVER(PARTITION BY visitor_id,visit_id ORDER BY received_at,id) AS first_rank,
    row_number()OVER(PARTITION BY visitor_id,visit_id ORDER BY received_at DESC,id DESC) AS last_rank,
    count(*)OVER(PARTITION BY visitor_id,visit_id,received_at) AS tied FROM window_visit_pages e
  ), boundary_evidence AS MATERIALIZED(
   SELECT q.visitor_id,q.visit_id,bool_or(e.received_at<b.start OR e.received_at>=b.finish) AS clipped
    FROM qualified_visits q JOIN retained_visit_pages e USING(visitor_id,visit_id) CROSS JOIN bounds b GROUP BY q.visitor_id,q.visit_id
  ), units AS MATERIALIZED(
   SELECT path AS key,id,visitor_id FROM visit_order WHERE ${dimension==='entry'?'first_rank':'last_rank'}=1
  )`:`, units AS MATERIALIZED(SELECT ${key} AS key,s.id,s.visitor_id FROM ${population} s)`},
  grouped AS MATERIALIZED(SELECT key,count(*) AS units,count(visitor_id) AS identified,
   CASE WHEN count(visitor_id)>0 THEN count(DISTINCT visitor_id) END AS visitors FROM units GROUP BY key),
  ranked AS(SELECT * FROM grouped ORDER BY units DESC,key COLLATE "C" NULLS FIRST LIMIT ${take})
  SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT analytics_retained_from FROM target) AS retained_from,
   (SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,
   (SELECT json_build_object('units',count(*),'identifiedUnits',count(visitor_id),'unidentifiedUnits',count(*)FILTER(WHERE visitor_id IS NULL),
    'estimatedVisitors',CASE WHEN count(visitor_id)>0 THEN count(DISTINCT visitor_id) END) FROM units) AS totals,
   (SELECT count(*) FROM ${population}) AS matching,(SELECT count(*) FROM ${population} WHERE visitor_id IS NULL) AS anonymous,
   (SELECT count(*) FROM qualified_visits) AS visits,
   ${boundary?"(SELECT count(*) FROM window_visit_pages)":"NULL::bigint"} AS retained_pages,
   ${boundary?"(SELECT count(*) FROM boundary_evidence WHERE clipped)":"NULL::bigint"} AS clipped,
   ${boundary?"(SELECT count(*) FROM visit_order WHERE "+(dimension==='entry'?'first_rank':'last_rank')+"=1 AND tied>1)":"NULL::bigint"} AS ties,
   (SELECT count(*) FROM grouped) AS groups,
   (SELECT COALESCE(json_agg(json_build_object('key',key,'units',units,'identifiedUnits',identified,'estimatedVisitors',visitors)ORDER BY units DESC,key COLLATE "C" NULLS FIRST),'[]'::json)FROM ranked) AS rows
  `,values)).rows[0];
 if(!row.allowed)throw new FoundationError(404,'Project not found or unavailable.');
 const start=row.start.toISOString(),end=row.finish.toISOString(),coverage=retentionCoverage(start,end,row.retained_from),unavailable=coverage.status==='unavailable',number=(value:unknown)=>value===null?null:Number(value);
 const rows:BoardDimensionResult['breakdown']['rows']=unavailable?[]:row.rows,returned=rows.reduce((sum,item)=>sum+item.units,0);
 const result:BoardDimensionResult={version:'native-board-dimension-v1',projectId,scope,dimension,range:{from:query.from,to:query.to,timeZone:query.timeZone,start,end},coverage,query:{filters:query.filters,property:query.property?.type==='missing'?{key:query.property.key,type:'missing'}:query.property},
  method:{metric:boundary?'observed-visits':'pageviews',identity:'rotating-project-key-hour-visit',boundaries:'whole-window-retained-pageviews',hostname:'recorded-origin-only',channel:'recorded-channel-tags-v1',historyComplete:false,visitorCountsAdditive:false},
  totals:unavailable?{units:null,identifiedUnits:null,unidentifiedUnits:null,estimatedVisitors:null}:row.totals,
  evidence:{matchingPageviews:unavailable?null:number(row.matching),anonymousPageviews:unavailable?null:number(row.anonymous),qualifiedVisits:unavailable?null:number(row.visits),retainedVisitPageviews:unavailable?null:number(row.retained_pages),windowClippedVisits:unavailable?null:number(row.clipped),orderingTieVisits:unavailable?null:number(row.ties),retentionClippedVisits:null},
  breakdown:{rows,totalGroups:unavailable?null:number(row.groups),returnedUnits:unavailable?null:returned,omittedUnits:unavailable?null:row.totals.units-returned,limit,truncated:!unavailable&&Number(row.groups)>rows.length}};
 const pending:unknown[]=[result];while(pending.length){const value=pending.pop();if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<0))throw new FoundationError(503,'The dimension result exceeds safe count limits.');if(value&&typeof value==='object')pending.push(...Object.values(value));}
 return result;
}
// Same selected-pageview arithmetic and whole-window custom-event suppression as Analytics.
export async function boardSummary(client:PoolClient,projectId:string,userId:string,scope:string,query:ReturnType<typeof explorerQuery>):Promise<BoardSummaryResult>{
 if(query.cohort||query.predicates)throw new FoundationError(400,'Board summaries support exact field and typed event-property filters.');
 if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[query.timeZone])).rowCount)throw new FoundationError(400,'The database does not support this timezone.');
 const {ctes,values,population}=analyticsPopulation(projectId,userId,{...query,kind:'all'},null,false);
 const row=(await client.query<{allowed:boolean;retained_from:string|null;start:Date;finish:Date;summary:Pick<BoardSummaryResult,'totals'|'measurement'>}>(`${ctes},
  custom_visits AS MATERIALIZED(${analyticsCustomVisitsSql('(SELECT start FROM bounds)','(SELECT finish FROM bounds)',"(e.received_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date")}),
  observations AS MATERIALIZED(SELECT s.*,c.visit_id IS NOT NULL AS visit_has_custom FROM ${population} s LEFT JOIN custom_visits c USING(visitor_id,visit_id)),${analyticsSummarySql.visits}
  SELECT EXISTS(SELECT 1 FROM target)AS allowed,(SELECT analytics_retained_from::text FROM target)AS retained_from,
   (SELECT start FROM bounds)AS start,(SELECT finish FROM bounds)AS finish,
   json_build_object('totals',${analyticsSummarySql.totals},'measurement',${analyticsSummarySql.measurement})AS summary FROM observations`,values)).rows[0];
 if(!row.allowed)throw new FoundationError(404,'Project not found or unavailable.');
 const start=row.start.toISOString(),end=row.finish.toISOString(),coverage=retentionCoverage(start,end,row.retained_from);
 if(coverage.status==='unavailable')hideAnalyticsSummary(row.summary);
 const {totals,measurement}=row.summary;
 for(const value of [totals.pageViews,totals.customEvents,measurement.identifiedPageViews,measurement.unidentifiedPageViews,measurement.visitors,measurement.visits])if(value!==null&&(!Number.isSafeInteger(value)||value<0))throw new FoundationError(503,'The summary exceeds safe count limits. Narrow its dates or filters.');
 for(const value of [measurement.bounceRate,measurement.averageVisitSeconds])if(value!==null&&(!Number.isFinite(value)||value<0))throw new FoundationError(503,'The summary measurement cannot be reported safely.');
 return{version:'native-board-summary-v1',projectId,scope,range:{from:query.from,to:query.to,timeZone:query.timeZone,start,end},coverage,
  method:{population:'selected-retained-observations',visits:'project-visitor-visit-pair',customSuppression:'whole-window-retained-custom-events',duration:'selected-pageview-span',historyComplete:false},totals,measurement};
}
