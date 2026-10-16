import type {PoolClient} from 'pg';
import type {BoardActivityResult} from '../lib/boards.ts';
import {FoundationError} from './auth.ts';
import {analyticsPopulation} from './analytics-population.ts';
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
