import {environmentFields} from '../lib/analytics-environment.ts';
import {geographyFields} from '../lib/analytics-geography.ts';

// One visit definition for every report that shows bounce rate or visit duration. Callers pass trusted CTE names and
// column lists only, never request input.
//
// A filtered population (an Analytics selection, a board or Explorer filter, or a row's own value) counts the visits with
// at least one matching page view and measures each of those visits as a whole. Environment and location values scope the
// measured visit instead, like the dashboard's browser/OS/device and location filters, so a browser or country row still
// equals the report filtered by it. This deliberately departs from pinned Umami 3.4.0 getWebsiteStats, which measures only
// the filtered rows of each visit, so a referrer or path filter there reports ~100% bounce and ~0 s duration.

/** Fields whose values scope each measured visit rather than select visits. */
export const visitScopeFields:readonly string[]=[...environmentFields,...geographyFields];

/** Per-visit page-view count, whole-window custom-event flag and page-view span over a scoped population carrying visit_has_custom. */
export function visitMetricsSql(source:string,keys:string[]=[]){
 const group=[...keys,'visitor_id','visit_id'].join(',');
 return `SELECT ${group},count(*) FILTER (WHERE event_name='page_view') AS pageviews,bool_or(visit_has_custom) AS custom,
  extract(epoch FROM (max(received_at) FILTER (WHERE event_name='page_view')-min(received_at) FILTER (WHERE event_name='page_view'))) AS duration
  FROM ${source} WHERE visitor_id IS NOT NULL AND visit_id IS NOT NULL GROUP BY ${group} HAVING count(*) FILTER (WHERE event_name='page_view')>0`;
}

/**
 * Per-event values measured without one row per event and value (#414). `visitValuesSql` groups a scoped population carrying
 * visit_has_custom by visit and `columns`. Over those rows, `valueCountsSql` gives each `fields` entry's (field name to column) page
 * views, and `valueVisitsSql` re-aggregates each visit and value into visitMetricsSql's page views, custom flag and page-view span. Both
 * compose exactly: counts add, flags or, and the span keeps the outer page-view bounds. Rows carry `field` and the value as `as`.
 */
export function visitValuesSql(source:string,columns:string[]){
 const group=['visitor_id','visit_id',...columns].join(',');
 return `SELECT ${group},count(*) FILTER (WHERE event_name='page_view') AS pageviews,bool_or(visit_has_custom) AS custom,
  min(received_at) FILTER (WHERE event_name='page_view') AS first_view,max(received_at) FILTER (WHERE event_name='page_view') AS last_view
  FROM ${source} GROUP BY ${group}`;
}
// One grouping set per field; GROUPING() names the set, since a grouped value may itself be NULL.
const fieldValueSql=(fields:Record<string,string>,as:string)=>{
 const sets=Object.entries(fields);
 return `CASE ${sets.map(([field,column])=>`WHEN GROUPING(${column})=0 THEN '${field}'`).join(' ')} END COLLATE "C" AS field,CASE ${sets.map(([,column])=>`WHEN GROUPING(${column})=0 THEN ${column}`).join(' ')} END AS ${as}`;
};
export function valueCountsSql(values:string,fields:Record<string,string>,as:string){
 return `SELECT ${fieldValueSql(fields,as)},sum(pageviews)::bigint AS pageviews,COALESCE(sum(pageviews) FILTER (WHERE visitor_id IS NOT NULL),0)::bigint AS identified
  FROM ${values} GROUP BY GROUPING SETS (${Object.values(fields).map(column=>`(${column})`).join(',')}) HAVING sum(pageviews)>0`;
}
/**
 * Per `keys` group of visitMetricsSql-shaped `visits`: distinct visitors, visits, bounce rate and average visit duration. It aggregates
 * each visitor first, so no sort is needed for the distinct count; sums of counts and durations reproduce count(*), the bounce share and
 * avg() exactly (numeric avg is the exact sum divided by the count).
 */
export function visitMeasurementSql(visits:string,keys:string[]){
 const group=keys.join(',');
 return `SELECT ${group},count(*) AS visitors,sum(visits)::bigint AS visits,100.0*sum(bounces)::bigint/NULLIF(sum(visits)::bigint,0) AS bounce,sum(duration)/sum(visits) AS duration
  FROM (SELECT ${group},visitor_id,count(*) AS visits,count(*) FILTER (WHERE pageviews=1 AND NOT custom) AS bounces,sum(duration) AS duration FROM ${visits} GROUP BY ${group},visitor_id) v GROUP BY ${group}`;
}
/** Without `fields`, each whole visit: visitMetricsSql over the population `values` groups. */
export function valueVisitsSql(values:string,fields:Record<string,string>={},as='value'){
 const keyed=Object.keys(fields).length>0;
 return `SELECT ${keyed?fieldValueSql(fields,as)+',':''}visitor_id,visit_id,sum(pageviews)::bigint AS pageviews,bool_or(custom) AS custom,extract(epoch FROM (max(last_view)-min(first_view))) AS duration
  FROM ${values} WHERE visitor_id IS NOT NULL AND visit_id IS NOT NULL
  GROUP BY ${keyed?`GROUPING SETS (${Object.values(fields).map(column=>`(${column},visitor_id,visit_id)`).join(',')})`:'visitor_id,visit_id'} HAVING sum(pageviews)>0`;
}

/**
 * Each `keys` group's visits with a matching page view in `matches`, measured by `metrics` (visitMetricsSql keyed by `visit`:
 * any scope columns, then visitor_id and visit_id). The metrics ride a window over both inputs instead of a join: CTE row
 * estimates are often 1, which would plan a quadratic nested loop.
 */
export function matchedVisitsSql(matches:string,metrics:string,keys:string[]=[],visit=['visitor_id','visit_id']){
 const names=keys.map(key=>key.split(' AS ').at(-1)!),columns=[...visit,...names].join(',');
 return `SELECT ${columns},pageviews,custom,duration FROM (
   SELECT ${columns},matched,max(pageviews) OVER visit AS pageviews,bool_or(custom) OVER visit AS custom,max(duration) OVER visit AS duration FROM (
    SELECT DISTINCT ${[...visit,...keys].join(',')},true AS matched,NULL::bigint AS pageviews,NULL::boolean AS custom,NULL::numeric AS duration
     FROM ${matches} WHERE event_name='page_view' AND visitor_id IS NOT NULL AND visit_id IS NOT NULL
    UNION ALL SELECT ${[...visit,...names.map(()=>'NULL')].join(',')},false,pageviews,custom,duration FROM ${metrics}
   ) pairs WINDOW visit AS (PARTITION BY ${visit.map(column=>`(${column})::text COLLATE "C"`).join(',')})
  ) measured WHERE matched AND pageviews IS NOT NULL`;
}
