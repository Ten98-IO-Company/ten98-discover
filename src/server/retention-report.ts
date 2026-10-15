import {z} from 'zod';
import {getDatabase} from './db.ts';
import {FoundationError} from './auth.ts';
import {authenticateApiKey,authorizeApiKey} from './api-keys.ts';
import {analyticsPopulation,cohortCoverage,sessionScope} from './analytics-population.ts';
import {resolveCohort} from './cohorts.ts';
import {explorerQuery,csvCell} from './explorer-input.ts';
import {validateAdvancedRegex} from './advanced-predicates.ts';
import {retentionCoverage} from './retention.ts';
import {retentionReportQuery} from './retention-report-input.ts';
import {geographyFields} from '../lib/analytics-geography.ts';
import {retentionOffsets,retentionLimits,retentionReportVersion,retentionLimitation,retentionCalendar,retentionCell,readRetentionReport,type RetentionReport,type RetentionRow} from '../lib/retention-report.ts';
import type {SessionReadAuthority} from './session-explorer.ts';

const missing=()=>new FoundationError(404,'Project not found or unavailable.');
const stamp=(value:string)=>`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const iso=(value:string|Date)=>new Date(value).toISOString();
const geoUsed=(query:ReturnType<typeof explorerQuery>)=>geographyFields.some(field=>Object.hasOwn(query.filters,field))||!!query.predicates?.fields.some(filter=>(geographyFields as readonly string[]).includes(filter.field));

export async function projectRetentionReport(projectId:string,authority:SessionReadAuthority,params:URLSearchParams):Promise<RetentionReport>{
  if(!z.uuid().safeParse(projectId).success)throw new FoundationError(400,'Choose a valid project.');projectId=projectId.toLowerCase();
  const input=retentionReportQuery(params),client=await getDatabase().pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='250ms'; SET LOCAL TIME ZONE 'UTC'");
    const preliminary=authority.kind==='api-key'?await authenticateApiKey(authority.token,client):null;
    let userId=authority.kind==='session'?authority.userId:preliminary!.userId;
    const workspace=(await client.query('SELECT p.workspace_id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rows[0]?.workspace_id as string|undefined;
    if(!workspace||preliminary&&preliminary.workspaceId!==workspace)throw missing();
    // Same bounded publication gate as session reads; authority is refreshed after every possible wait.
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[workspace]);
    let key=authority.kind==='api-key'?await authorizeApiKey(authority.token,workspace,'analytics:read',client):null;
    if(key)userId=key.userId;
    if(!(await client.query('SELECT 1 FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1 AND p.workspace_id=$3',[projectId,userId,workspace])).rowCount)throw missing();
    const query=input.scope,item=query.cohort?await resolveCohort(client,projectId,userId,query.cohort.id,query.cohort.revision):null,qualification=item?explorerQuery(new URLSearchParams(item.definition.query)):null;
    await validateAdvancedRegex(client,query.predicates,qualification?.predicates);
    for(const zone of new Set([query.timeZone,...qualification?[qualification.timeZone]:[]]))if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[zone])).rowCount)throw new FoundationError(400,'The database does not support this timezone.');
    if(authority.kind==='api-key'){key=await authorizeApiKey(authority.token,workspace,'analytics:read',client);userId=key.userId;}
    // Passing null uses the existing raw clock and the same receipt fence for entry AND qualification.
    const {ctes,values,population,reportCandidates,qualificationCandidates}=analyticsPopulation(projectId,userId,query,qualification,false,null);
    values.push(key?.id??null);const keySlot=`$${values.length}`;values.push([...retentionOffsets]);const offsetSlot=`$${values.length}`;
    const geography=geoUsed(query)||!!qualification&&geoUsed(qualification);
    // ponytail: one indexed calendar-month scan; add rollups only after measured query limits require them.
    const {rows}=await client.query(`${ctes}, key_authority AS MATERIALIZED (SELECT ${keySlot}::uuid IS NULL OR EXISTS(SELECT 1 FROM api_key k
      JOIN membership m ON m.workspace_id=k.workspace_id AND m.user_id=k.issuer_user_id JOIN project p ON p.workspace_id=k.workspace_id AND p.id=$1 CROSS JOIN session_clock c
      WHERE k.id=${keySlot}::uuid AND k.issuer_user_id=$2 AND m.role IN('owner','admin','editor','viewer') AND 'analytics:read'=ANY(k.scopes) AND k.revoked_at IS NULL AND k.expires_at>c.as_of) AS valid),
      entry_keys AS MATERIALIZED (SELECT visitor_id,min((received_at AT TIME ZONE $5)::date) AS day FROM ${population} WHERE visitor_id IS NOT NULL GROUP BY visitor_id),
      entry_days AS (SELECT (received_at AT TIME ZONE $5)::date AS day,count(*) AS events,count(visitor_id) AS keyed FROM ${population} GROUP BY 1),
      sizes AS (SELECT day,count(*) AS keys FROM entry_keys GROUP BY day),
      return_scope AS MATERIALIZED (SELECT e.visitor_id,(e.received_at AT TIME ZONE $5)::date AS day FROM event e JOIN target t ON t.id=e.project_id CROSS JOIN bounds b CROSS JOIN session_page p
        WHERE e.received_at>=b.start AND e.received_at<b.finish AND e.received_at<p.event_before AND (t.analytics_retained_from IS NULL OR e.received_at>=t.analytics_retained_from)
          AND (e.received_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date),
      key_days AS MATERIALIZED (SELECT DISTINCT k.visitor_id,k.day AS cohort_day,r.day FROM return_scope r JOIN entry_keys k ON k.visitor_id=r.visitor_id),
      returns AS (SELECT cohort_day,day,count(*) AS keys FROM key_days GROUP BY cohort_day,day)
      SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT valid FROM key_authority) AS key_valid,
        (SELECT m.role FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1) AS role,
        (SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,(SELECT analytics_retained_from FROM target) AS retained_from,
        ${stamp('c.as_of')} AS clock,json_build_object('asOf',c.as_of,'cutoff',c.cutoff,'lostAt',c.lost_at,'expiredValuesPresent',c.expired_values_present) AS session_context,
        ${reportCandidates?`(SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*) FILTER(WHERE visitor_id IS NULL)) FROM ${reportCandidates})`:'null'} AS report_candidates,
        ${qualificationCandidates?`(SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*) FILTER(WHERE visitor_id IS NULL)) FROM ${qualificationCandidates})`:'null'} AS qualification_candidates,
        ${item?`(SELECT json_build_object('start',start,'end',finish,'events',(SELECT count(*) FROM qualification),'identified',(SELECT count(visitor_id) FROM qualification),'members',(SELECT count(*) FROM cohort_keys)) FROM qualification_bounds)`:'null'} AS qualification,
        ${geography?`(SELECT json_build_object('source','db-ip-city-lite','scope','matching-entry-events','databaseCount',count(DISTINCT (geography->'databaseBuild',geography->'databaseSha256')) FILTER(WHERE geography IS NOT NULL),'oldestDatabaseBuild',min((geography->>'databaseBuild')::bigint),'newestDatabaseBuild',max((geography->>'databaseBuild')::bigint)) FROM ${population})`:'null'} AS geography,
        (SELECT json_build_object('events',count(*),'keyed',count(visitor_id),'keys',(SELECT count(*) FROM entry_keys)) FROM ${population}) AS entry_totals,
        (SELECT json_build_object('events',count(*),'unkeyed',count(*) FILTER(WHERE visitor_id IS NULL)) FROM return_scope) AS return_totals,
        (SELECT json_agg(json_build_object('date',to_char(d.day,'YYYY-MM-DD'),'start',d.start,'end',d.finish,'events',COALESCE(e.events,0),'keyed',COALESCE(e.keyed,0),'keys',COALESCE(s.keys,0),
          'returns',(SELECT json_agg(COALESCE(r.keys,0) ORDER BY o.days_after) FROM unnest(${offsetSlot}::int[]) o(days_after) LEFT JOIN returns r ON r.cohort_day=d.day::date AND r.day=d.day::date+o.days_after)) ORDER BY d.day)
          FROM calendar d LEFT JOIN entry_days e ON e.day=d.day::date LEFT JOIN sizes s ON s.day=d.day::date WHERE d.finish IS NOT NULL) AS days
        FROM session_context c CROSS JOIN session_page p CROSS JOIN report_arguments`,values);
    const raw=rows[0];if(key&&!raw?.key_valid)throw new FoundationError(401,'The API key is invalid, expired or unavailable.');if(!raw?.allowed)throw missing();
    retentionReportQuery(params,new Date(raw.clock));
    const start=iso(raw.start),end=iso(raw.finish),coverage=retentionCoverage(start,end,raw.retained_from),cohort=cohortCoverage(item,qualification,raw);
    const sessionProperties=query.predicates?.sessionProperties?.length?sessionScope(raw.session_context,raw.report_candidates,query.predicates.sessionProperties.some(filter=>filter.operator==='missing'),coverage.status==='unavailable'||cohort?.membership.status==='unavailable',coverage.status==='partial'):undefined;
    const reason=coverage.status==='unavailable'?'history-unavailable':cohort?.membership.status==='unavailable'?'cohort-unavailable':sessionProperties?.selection.status==='unavailable'?'session-property-unavailable':raw.entry_totals.events>0&&raw.entry_totals.keyed===0?'identity-unavailable':null;
    const suppressed=reason!==null&&reason!=='identity-unavailable';
    const selection:RetentionReport['selection']={status:reason?'unavailable':'available',reason,assignment:reason?'unavailable':coverage.status==='partial'||cohort?.coverage.status==='partial'||sessionProperties?.selection.countsAreLowerBounds||cohort?.membership.countsAreLowerBounds?'retained-only':'complete'};
    const reportRows:RetentionRow[]=raw.days.map((day:{date:string;start:string;end:string;events:number;keyed:number;keys:number})=>{
      const from=iso(day.start),to=iso(day.end),status=retentionCoverage(from,to,raw.retained_from).status,calendar=retentionCalendar(from,to,raw.clock),unknown=suppressed||status==='unavailable'||calendar==='not-started'||calendar==='skipped';
      return {date:day.date,start:from,end:to,skipped:from===to,calendar,coverage:status,matchingEvents:unknown?null:day.events,keyedEvents:unknown?null:day.keyed,unkeyedEvents:unknown?null:day.events-day.keyed,cohortKeys:unknown||day.events>0&&day.keyed===0?null:day.keys,cells:[]};
    });
    for(let n=0;n<reportRows.length;n++)reportRows[n].cells=retentionOffsets.map((offset,i)=>retentionCell(reportRows[n],offset,reportRows[n+offset],raw.clock,selection,raw.days[n].returns[i]));
    const result:RetentionReport={version:retentionReportVersion,projectId,role:raw.role,asOf:raw.clock,query:input.query,range:{from:query.from,to:query.to,start,end,observedEnd:Date.parse(end)<Date.parse(raw.clock)?end:raw.clock},offsets:retentionOffsets,coverage,selection,
      identity:{unit:'rotating-visitor-key',entryEvents:suppressed?null:raw.entry_totals.events,keyedEntryEvents:suppressed?null:raw.entry_totals.keyed,unkeyedEntryEvents:suppressed?null:raw.entry_totals.events-raw.entry_totals.keyed,observedKeys:suppressed||reason==='identity-unavailable'?null:raw.entry_totals.keys,returnScopeEvents:suppressed?null:raw.return_totals.events,unkeyedReturnScopeEvents:suppressed?null:raw.return_totals.unkeyed},rows:reportRows,...cohort?{cohort}:{},...sessionProperties?{sessionProperties}:{},...geography?{geographyProvenance:suppressed?{source:'db-ip-city-lite',scope:'matching-entry-events',databaseCount:null,oldestDatabaseBuild:null,newestDatabaseBuild:null}:raw.geography}:{},csv:''};
    result.csv=retentionReportCsv(result);if(Buffer.byteLength(result.csv,'utf8')>retentionLimits.csv||Buffer.byteLength(JSON.stringify(result),'utf8')>retentionLimits.json)throw new FoundationError(503,'The retention report exceeds the response limit. Use fewer entry filters.');
    readRetentionReport(result,input.query,projectId);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'The retention report took too long. Try again with more specific entry filters.');throw error;}
  finally{client.release();}
}

export function retentionReportCsv(report:RetentionReport){
  const lines:unknown[][]=[['Report',retentionReportVersion],['Project',report.projectId],['Month',report.query.month],['Timezone',report.query.timeZone],['Report generated',report.asOf],['Entry selection',JSON.stringify(report.query)],['Event watermark',report.coverage.retainedFrom],['History coverage',report.coverage.status],['Cohort assignment',report.selection.assignment],['Selection',report.selection.reason??'available'],['Identity unit',report.identity.unit],['Limitation',retentionLimitation],['Keyed entry events',report.identity.keyedEntryEvents],['Unkeyed entry events',report.identity.unkeyedEntryEvents],['Observed keys',report.identity.observedKeys],['Unkeyed whole-month return-scope events',report.identity.unkeyedReturnScopeEvents]];
  if(report.cohort)lines.push(['Saved qualification',report.cohort.item.id,report.cohort.item.revision,report.cohort.range.from,report.cohort.range.to,report.cohort.coverage.status],['Qualification limitation',report.cohort.limitation]);
  if(report.sessionProperties)lines.push(['Current session-property selection',report.sessionProperties.selection.status,report.sessionProperties.selection.reason],['Session-property limitation',report.sessionProperties.limitation]);
  if(report.geographyProvenance){const g=report.geographyProvenance;lines.push(['Location source','DB-IP City Lite','https://db-ip.com/db/lite.php','CC BY4.0','https://creativecommons.org/licenses/by/4.0/'],['Location builds',g.databaseCount,g.oldestDatabaseBuild,g.newestDatabaseBuild,g.scope]);}
  lines.push(['Cohort date','Cohort calendar','Cohort coverage','Matching events','Keyed events','Unkeyed events','Observed cohort keys','Day offset','Return date','Return calendar','Return coverage','State','Returned keys','Denominator','Percentage']);
  for(const row of report.rows)for(const cell of row.cells)lines.push([row.date,row.calendar,row.coverage,row.matchingEvents,row.keyedEvents,row.unkeyedEvents,row.cohortKeys,cell.offset,cell.date,cell.calendar,cell.coverage,cell.status,cell.returnedKeys,cell.denominator,cell.percentage]);
  return lines.map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
