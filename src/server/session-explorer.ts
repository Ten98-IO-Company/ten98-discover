import {z} from 'zod';
import {getDatabase} from './db.ts';
import {FoundationError} from './auth.ts';
import {authenticateApiKey,authorizeApiKey} from './api-keys.ts';
import {canonicalHash} from './context-input.ts';
import {explorerQuery} from './explorer-input.ts';
import {resolveCohort} from './cohorts.ts';
import {retentionCoverage} from './retention.ts';
import {advancedPredicateMethod,validateAdvancedRegex} from './advanced-predicates.ts';
import {analyticsPopulation,cohortCoverage,sessionScope} from './analytics-population.ts';
import {analyticsCalendarSql} from './analytics-scope.ts';
import {geographyProjectionSql} from './geography-sql.ts';
import {sessionListQuery,sessionActivityQuery,sessionCursorScope,encodeSessionCursor,
  linkedActivityQuery,linkedActivityScope,type LinkedActivity,
  type SessionList,type SessionDetail,type SessionReadMeta,type SessionSelection,type SessionRow} from './session-explorer-input.ts';

export type SessionReadAuthority={kind:'session';userId:string}|{kind:'api-key';token:string};
const identityLimitation='Observed project-scoped visitor keys rotate each UTC month and when identity inputs or the signing secret change. They are not persistent people. Linked identified activity is a separate view of retained explicit evidence.';
const propertyLimitation='These are current retained values for this observed key at this page snapshot, not values at event time. Absence is unknown after property evidence loss.';
const missing=()=>new FoundationError(404,'Project or observed key not found or unavailable.');
const invalid=()=>new FoundationError(400,'Check the session dates, filters and page cursor.');
const iso=(value:string|Date|null)=>value===null?null:new Date(value).toISOString();
// Fixed internal expressions only; retain PostgreSQL microseconds in cursor/hash text.
const stamp=(expression:string)=>`to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function listSessions(projectId:string,authority:SessionReadAuthority,params:URLSearchParams):Promise<SessionList>{
  return readSessions(projectId,authority,params,null) as Promise<SessionList>;
}
export async function getSessionDetail(projectId:string,visitorKey:string,authority:SessionReadAuthority,params:URLSearchParams):Promise<SessionDetail>{
  return readSessions(projectId,authority,params,visitorKey) as Promise<SessionDetail>;
}

export async function getLinkedSessionActivity(projectId:string,visitorKey:string,authority:SessionReadAuthority,params:URLSearchParams):Promise<LinkedActivity>{
  if(!z.uuid().safeParse(projectId).success)throw invalid();projectId=projectId.toLowerCase();
  const client=await getDatabase().pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL statement_timeout='5s'");await client.query("SET LOCAL lock_timeout='250ms'");
    const preliminary=authority.kind==='api-key'?await authenticateApiKey(authority.token,client):null;
    let userId=authority.kind==='session'?authority.userId:preliminary!.userId;
    const before=await client.query('SELECT p.workspace_id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId]);
    const workspaceId=before.rows[0]?.workspace_id as string|undefined;
    if(!workspaceId||preliminary&&preliminary.workspaceId!==workspaceId)throw missing();
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[workspaceId]);
    if(authority.kind==='api-key')userId=(await authorizeApiKey(authority.token,workspaceId,'analytics:read',client)).userId;
    if(!(await client.query('SELECT 1 FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1 AND p.workspace_id=$3',[projectId,userId,workspaceId])).rowCount)throw missing();
    const input=linkedActivityQuery(visitorKey,params),cursor=input.cursor;
    if(cursor&&(cursor.projectId!==projectId||cursor.visitorKey!==visitorKey||cursor.pageSize!==input.pageSize))throw invalid();
    if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[input.timeZone])).rowCount)throw new FoundationError(400,'The database does not support this timezone.');
    const currentKey=authority.kind==='api-key'?await authorizeApiKey(authority.token,workspaceId,'analytics:read',client):null;
    if(currentKey)userId=currentKey.userId;
    // The target is gated again at the statement clock before any identity resolution.
    const {rows}=await client.query(`WITH RECURSIVE clock AS MATERIALIZED (SELECT clock_timestamp() AS as_of),
      key_authority AS MATERIALIZED (SELECT $11::uuid IS NULL OR EXISTS(SELECT 1 FROM api_key k
        JOIN membership m ON m.workspace_id=k.workspace_id AND m.user_id=k.issuer_user_id
        JOIN project p ON p.workspace_id=k.workspace_id AND p.id=$1 CROSS JOIN clock c
        WHERE k.id=$11::uuid AND k.issuer_user_id=$2 AND m.role IN ('owner','admin','editor','viewer')
          AND 'analytics:read'=ANY(k.scopes) AND k.revoked_at IS NULL AND k.expires_at>c.as_of) AS valid),
      target AS MATERIALIZED (SELECT p.*,w.raw_analytics_days,w.retention_revision FROM project p
        JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 JOIN workspace w ON w.id=p.workspace_id
        CROSS JOIN key_authority k WHERE p.id=$1 AND k.valid), ${analyticsCalendarSql},
      context AS MATERIALIZED (SELECT t.*,c.as_of,COALESCE($7::timestamptz,c.as_of) AS event_before,
        GREATEST(t.analytics_retained_from,t.identity_links_retained_from,c.as_of-t.raw_analytics_days*interval '24 hours',t.identity_event_evidence_started_at) AS event_cutoff,
        GREATEST(t.identity_links_retained_from,c.as_of-t.raw_analytics_days*interval '24 hours') AS link_cutoff,
        GREATEST(t.analytics_retained_from,c.as_of-t.raw_analytics_days*interval '24 hours') AS observed_cutoff
        FROM target t CROSS JOIN clock c),
      anchor AS MATERIALIZED (SELECT l.* FROM analytics_identity_link l JOIN context c ON c.id=l.project_id
        WHERE l.visitor_key=$6 AND l.last_accepted_at>=c.link_cutoff),
      edges AS MATERIALIZED (SELECT l.* FROM analytics_identity_link l JOIN anchor a
        ON l.project_id=a.project_id AND l.identity_version=a.identity_version AND l.key_generation=a.key_generation AND l.identity_token=a.identity_token
        CROSS JOIN context c WHERE l.last_accepted_at>=c.link_cutoff),
      candidates AS MATERIALIZED (SELECT e.*,${geographyProjectionSql('e')} AS geography,COALESCE(e.dimensions->>'origin',c.origin) AS origin FROM event e
        JOIN edges l ON l.project_id=e.project_id AND l.visitor_key=e.visitor_id CROSS JOIN context c CROSS JOIN bounds b
        WHERE e.source='browser' AND e.received_at>=l.first_accepted_at AND e.received_at>=c.event_cutoff
          AND e.received_at>=b.start AND e.received_at<b.finish AND e.received_at<c.event_before
          AND (e.received_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date),
      qualified AS MATERIALIZED (SELECT e.* FROM candidates e CROSS JOIN context c
        WHERE e.identity_link_evidence_version=1 AND c.identity_event_evidence_started_at IS NOT NULL),
      visit_spans AS (SELECT visitor_id,visit_id,extract(epoch FROM max(received_at)-min(received_at)) AS seconds FROM qualified GROUP BY visitor_id,visit_id),
      page_rows AS MATERIALIZED (SELECT * FROM qualified WHERE $8::timestamptz IS NULL OR (received_at,id)<($8::timestamptz,$9::uuid)
        ORDER BY received_at DESC,id DESC LIMIT $10::integer)
      SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT valid FROM key_authority) AS key_valid,
        ${stamp('c.as_of')} AS clock,${stamp('c.event_before')} AS event_before,c.event_before<=c.as_of AS bound_valid,
        (SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,
        EXISTS(SELECT 1 FROM event e WHERE e.project_id=c.id AND e.visitor_id=$6 AND e.received_at>=c.observed_cutoff AND e.received_at<c.event_before) AS observed,
        c.raw_analytics_days,c.retention_revision,${stamp('c.event_cutoff')} AS event_cutoff,${stamp('c.link_cutoff')} AS link_cutoff,
        ${stamp('GREATEST(c.observed_cutoff,c.link_cutoff)')} AS retained_cutoff,
        ${stamp('c.analytics_retained_from')} AS event_watermark,${stamp('c.identity_links_retained_from')} AS link_watermark,
        ${stamp('c.identity_event_evidence_started_at')} AS evidence_start,${stamp('c.identity_links_started_at')} AS links_start,
        ${stamp('c.identity_links_evidence_lost_at')} AS links_loss,COALESCE(c.analytics_settings->'linkIdentities'='true'::jsonb,false) AS linking_enabled,
        (SELECT json_build_object('version',a.identity_version,'keyGeneration',a.key_generation,'token',a.identity_token,'firstAt',${stamp('a.first_accepted_at')}) FROM anchor a) AS anchor,
        (SELECT count(*) FROM edges) AS edge_count,
        (SELECT count(*) FROM analytics_identity_link l JOIN anchor a ON l.project_id=a.project_id AND l.identity_version=a.identity_version
          AND l.key_generation=a.key_generation AND l.identity_token=a.identity_token WHERE l.last_accepted_at<c.link_cutoff) AS expired_edge_count,
        (SELECT count(*)::integer FROM candidates WHERE identity_link_evidence_version IS NULL) AS unproven,
        (SELECT json_build_object('events',count(*),'pageViews',count(*) FILTER(WHERE event_name='page_view'),'customEvents',count(*) FILTER(WHERE event_name<>'page_view'),
          'observedKeys',count(DISTINCT visitor_id),'visits',count(DISTINCT (visitor_id,visit_id)),'firstAt',min(received_at),'lastAt',max(received_at),
          'observedVisitSpanSeconds',(SELECT sum(seconds)::text FROM visit_spans),'meanObservedVisitSpanSeconds',(SELECT avg(seconds)::text FROM visit_spans)) FROM qualified) AS totals,
        COALESCE((SELECT json_agg(json_build_object('id',id,'receivedAt',${stamp('received_at')},'visitorKey',visitor_id,'visitKey',visit_id,
          'kind',CASE WHEN event_name='page_view' THEN 'pageview' ELSE 'custom' END,'eventName',event_name,'path',path,'origin',origin,
          'properties',properties,'dimensions',(dimensions-'distinctId'-'geography')||CASE WHEN geography IS NOT NULL THEN jsonb_build_object('geography',geography) ELSE '{}'::jsonb END,'source','browser','metricVersion',metric_version,'identityEvidenceVersion',1)
          ORDER BY received_at DESC,id DESC) FROM page_rows),'[]') AS page
      FROM clock LEFT JOIN context c ON true`,[projectId,userId,input.from,input.to,input.timeZone,visitorKey,cursor?.eventBefore??null,
        cursor?.last.at??null,cursor?.last.id??null,input.pageSize+1,currentKey?.id??null]);
    const row=rows[0];if(currentKey&&!row?.key_valid)throw new FoundationError(401,'The API key is invalid, expired or unavailable.');
    if(!row?.allowed||!row.observed)throw missing();if(!row.bound_valid)throw invalid();
    const policyHash=canonicalHash(['linked-retention-policy-v1',row.retention_revision,row.raw_analytics_days]);
    if(cursor&&cursor.retention.policyHash!==policyHash)throw new FoundationError(409,'Retention settings changed. Reload this activity.');
    const anchor=row.anchor?canonicalHash(['linked-anchor-v1',row.anchor.version,row.anchor.keyGeneration,row.anchor.token,row.anchor.firstAt]):null;
    if(cursor&&(!anchor||cursor.anchor!==anchor))throw new FoundationError(409,'Activity changed. Reload to continue.');
    const scope=anchor?linkedActivityScope(projectId,input,anchor):null;
    if(cursor&&cursor.scope!==scope)throw invalid();
    const evidenceHash=canonicalHash(['linked-evidence-v1',row.event_watermark,row.link_watermark,row.evidence_start,row.links_loss,row.edge_count,row.expired_edge_count,anchor]);
    const changed=!!cursor&&cursor.retention.initialEvidenceHash!==evidenceHash;
    const start=iso(row.start)!,end=iso(row.finish)!,micro=(value:string)=>value.replace(/\.(\d{3})Z$/,'.$1000Z');
    const reason=!anchor?'link_evidence_unavailable':micro(end)<=row.retained_cutoff?'event_history_unavailable':
      !row.evidence_start||micro(end)<=row.evidence_start?'explicit_event_evidence_unavailable':
      row.totals.events===0&&row.unproven>0?'explicit_event_evidence_unavailable':null;
    const unavailable=reason!==null,page=row.page.slice(0,input.pageSize),last=page.at(-1);
    const nextCursor=!unavailable&&row.page.length>input.pageSize&&last?encodeSessionCursor({version:1,route:'linked-activity',projectId,
      visitorKey,anchor:anchor!,scope:scope!,pageSize:input.pageSize,eventBefore:row.event_before,
      retention:{policyHash,initialEvidenceHash:cursor?.retention.initialEvidenceHash??evidenceHash},last:{at:last.receivedAt,id:last.id}}):null;
    const warnings:LinkedActivity['coverage']['warnings']=[];
    if(row.unproven>0)warnings.push('legacy_evidence_excluded');
    if(micro(start)<row.event_cutoff)warnings.push('retained_range_clipped');
    if(row.links_loss!==null)warnings.push('project_link_evidence_lost');if(!row.linking_enabled)warnings.push('new_linking_disabled');if(changed)warnings.push('evidence_changed');
    const result:LinkedActivity={projectId,baseVisitorKey:visitorKey,method:'explicit-identified-activity-v1',asOf:row.clock,
      range:{from:input.from,to:input.to,timeZone:input.timeZone,start,end},
      selection:unavailable?{status:'unavailable',reason}:{status:'available',reason:null,reference:{version:1,keyGeneration:row.anchor.keyGeneration,token:row.anchor.token},scope:'direct-marked-events-in-selected-dates'},
      summary:unavailable?null:{...row.totals,firstAt:iso(row.totals.firstAt),lastAt:iso(row.totals.lastAt)},activity:unavailable?null:page,
      coverage:{status:unavailable?'unavailable':'partial',eventRetainedFrom:row.event_cutoff,linkRetainedFrom:row.link_cutoff,eventEvidenceStartedAt:row.evidence_start,
        linksStartedAt:row.links_start,linkEvidenceLostAt:row.links_loss,linkingEnabled:row.linking_enabled,unprovenEventsExcluded:row.unproven,
        legacyEvidence:'not_backfilled',historyComplete:false,historyScope:'retained_direct_explicit_observations_only',warnings},
      paging:{mode:'current-page-with-fixed-event-bound',eventBefore:row.event_before,consistency:'current-per-page',nextCursor,limit:input.pageSize,retentionEvidenceChanged:changed}};
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});
    if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'This query took too long. Choose a shorter date range.');throw error;
  }finally{client.release();}
}

async function readSessions(projectId:string,authority:SessionReadAuthority,params:URLSearchParams,visitorKey:string|null):Promise<SessionList|SessionDetail>{
  if(!z.uuid().safeParse(projectId).success)throw invalid();projectId=projectId.toLowerCase();
  const client=await getDatabase().pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL statement_timeout='5s'");await client.query("SET LOCAL lock_timeout='250ms'");
    const preliminary=authority.kind==='api-key'?await authenticateApiKey(authority.token,client):null;
    let userId=authority.kind==='session'?authority.userId:preliminary!.userId;
    const before=await client.query('SELECT p.workspace_id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId]);
    const workspaceId=before.rows[0]?.workspace_id as string|undefined;
    if(!workspaceId||preliminary&&preliminary.workspaceId!==workspaceId)throw missing();
    // ponytail: bounded page reads serialize with workspace mutations; measure contention before replacing this gate.
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[workspaceId]);
    if(authority.kind==='api-key')userId=(await authorizeApiKey(authority.token,workspaceId,'analytics:read',client)).userId;
    if(!(await client.query('SELECT 1 FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1 AND p.workspace_id=$3',[projectId,userId,workspaceId])).rowCount)throw missing();
    const input=visitorKey===null?sessionListQuery(params):sessionActivityQuery(visitorKey,params),list='query'in input;
    const query=list?{...input.query,groupBy:'event',groupProperty:null}:explorerQuery(new URLSearchParams({from:input.from,to:input.to,timeZone:input.timeZone}));
    const key=list?input.query.visitorKey:input.visitorKey,cursor=input.cursor,scopeHash=sessionCursorScope(projectId,input);
    if(cursor&&(cursor.projectId!==projectId||cursor.scope!==scopeHash||cursor.pageSize!==input.pageSize||!list&&cursor.route==='activity'&&cursor.visitorKey!==key))throw invalid();
    const item=query.cohort?await resolveCohort(client,projectId,userId,query.cohort.id,query.cohort.revision):null;
    const qualification=item?explorerQuery(new URLSearchParams(item.definition.query)):null;
    await validateAdvancedRegex(client,query.predicates,qualification?.predicates);
    for(const zone of new Set([query.timeZone,...qualification?[qualification.timeZone]:[]]))if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[zone])).rowCount)throw new FoundationError(400,'The database does not support this timezone.');
    const currentKey=authority.kind==='api-key'?await authorizeApiKey(authority.token,workspaceId,'analytics:read',client):null;
    if(currentKey)userId=currentKey.userId;
    const {ctes,values,population,reportCandidates,qualificationCandidates}=analyticsPopulation(projectId,userId,query,qualification,true,cursor?.eventBefore??null);
    const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
    const keySlot=bind(key),atSlot=bind(cursor?.last.at??null),lastSlot=bind(cursor?(cursor.route==='list'?cursor.last.visitorKey:cursor.last.id):null),limitSlot=bind(input.pageSize+1),apiKeySlot=bind(currentKey?.id??null);
    const pageSql=list?`, grouped AS MATERIALIZED (SELECT visitor_id,min(received_at) AS first_at,max(received_at) AS last_at,
      count(*) AS events,count(*) FILTER(WHERE event_name='page_view') AS pageviews,count(*) FILTER(WHERE event_name<>'page_view') AS custom,
      count(DISTINCT visit_id) AS visits FROM selected WHERE visitor_id IS NOT NULL GROUP BY visitor_id),
      page_rows AS MATERIALIZED (SELECT * FROM grouped WHERE ${atSlot}::timestamptz IS NULL OR last_at<${atSlot}::timestamptz
        OR(last_at=${atSlot}::timestamptz AND visitor_id>${lastSlot}::text) ORDER BY last_at DESC,visitor_id ASC LIMIT ${limitSlot}::integer)`:
      `, visit_spans AS (SELECT visit_id,extract(epoch FROM max(received_at)-min(received_at)) AS seconds FROM selected GROUP BY visit_id),
      page_rows AS MATERIALIZED (SELECT * FROM selected WHERE ${atSlot}::timestamptz IS NULL OR (received_at,id)<(${atSlot}::timestamptz,${lastSlot}::uuid)
        ORDER BY received_at DESC,id DESC LIMIT ${limitSlot}::integer),
      current_properties AS MATERIALIZED (SELECT property_key,property,updated_at FROM analytics_session_property sp CROSS JOIN session_context c
        WHERE sp.project_id=$1 AND sp.visitor_key=${keySlot}::text AND sp.updated_at>=c.cutoff ORDER BY property_key COLLATE "C" LIMIT 51)`;
    const {rows}=await client.query(`${ctes}, key_authority AS MATERIALIZED (SELECT ${apiKeySlot}::uuid IS NULL OR EXISTS(SELECT 1 FROM api_key k
        JOIN membership m ON m.workspace_id=k.workspace_id AND m.user_id=k.issuer_user_id
        JOIN project p ON p.workspace_id=k.workspace_id AND p.id=$1 CROSS JOIN session_clock c
        WHERE k.id=${apiKeySlot}::uuid AND k.issuer_user_id=$2 AND m.role IN ('owner','admin','editor','viewer')
          AND 'analytics:read'=ANY(k.scopes) AND k.revoked_at IS NULL AND k.expires_at>c.as_of) AS valid)
      ${list?'':`, identity_target AS MATERIALIZED (SELECT p.id,GREATEST(p.identity_links_retained_from,c.as_of-w.raw_analytics_days*interval '24 hours') AS link_cutoff
        FROM project p JOIN target t ON t.id=p.id JOIN workspace w ON w.id=p.workspace_id
        CROSS JOIN session_clock c CROSS JOIN key_authority k WHERE k.valid)`},
      selected AS MATERIALIZED (SELECT s.* FROM ${population} s WHERE (${keySlot}::text IS NULL OR s.visitor_id=${keySlot}::text)),
      selected_candidates AS MATERIALIZED (SELECT s.* FROM ${reportCandidates??population} s WHERE (${keySlot}::text IS NULL OR s.visitor_id=${keySlot}::text))${pageSql}
      SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT to_char(analytics_retained_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM target) AS retained_from,
        (SELECT valid FROM key_authority) AS key_valid,
        (SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,
        ${stamp('c.as_of')} AS clock,${stamp('b.event_before')} AS event_before,b.event_before<=c.as_of AS bound_valid,
        c.policy_revision,c.raw_days,${stamp('c.event_watermark')} AS event_watermark,${stamp('c.lost_at')} AS profile_loss_at,
        json_build_object('asOf',c.as_of,'cutoff',c.cutoff,'lostAt',c.lost_at,'expiredValuesPresent',c.expired_values_present) AS session_context,
        (SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*) FILTER(WHERE visitor_id IS NULL)) FROM selected_candidates) AS report_candidates,
        ${qualificationCandidates?`(SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*) FILTER(WHERE visitor_id IS NULL)) FROM qualification_candidates)`:'null'} AS qualification_candidates,
        ${item?`(SELECT json_build_object('start',start,'end',finish,'events',(SELECT count(*) FROM qualification),'identified',(SELECT count(visitor_id) FROM qualification),'members',(SELECT count(*) FROM cohort_keys)) FROM qualification_bounds)`:'null'} AS qualification,
        (SELECT json_build_object('events',count(*),'pageViews',count(*) FILTER(WHERE event_name='page_view'),'customEvents',count(*) FILTER(WHERE event_name<>'page_view'),
          'identified',count(visitor_id),'unidentified',count(*) FILTER(WHERE visitor_id IS NULL),'visits',count(DISTINCT visit_id),'firstAt',min(received_at),'lastAt',max(received_at)) FROM selected) AS totals,
        ${list?`(SELECT count(*)::integer FROM grouped) AS total_keys,
          COALESCE((SELECT json_agg(json_build_object('visitorKey',visitor_id,'firstAt',first_at,'lastAt',last_at,'cursorAt',${stamp('last_at')},
            'events',events,'pageViews',pageviews,'customEvents',custom,'visits',visits) ORDER BY last_at DESC,visitor_id ASC) FROM page_rows),'[]') AS page`:
          `EXISTS(SELECT 1 FROM analytics_identity_link l JOIN identity_target t ON t.id=l.project_id
            WHERE l.visitor_key=${keySlot}::text AND l.last_accepted_at>=t.link_cutoff) AS linked_lookup_available,
          EXISTS(SELECT 1 FROM event e JOIN target t ON t.id=e.project_id WHERE e.visitor_id=${keySlot}::text
            AND(t.analytics_retained_from IS NULL OR e.received_at>=t.analytics_retained_from) AND e.received_at<b.event_before) AS observed,
          (SELECT sum(seconds)::text FROM visit_spans) AS span,(SELECT avg(seconds)::text FROM visit_spans) AS mean_span,
          COALESCE((SELECT json_agg(json_build_object('id',id,'receivedAt',received_at,'cursorAt',${stamp('received_at')},'visitKey',visit_id,
            'kind',CASE WHEN event_name='page_view' THEN 'pageview' ELSE 'custom' END,'eventName',event_name,'path',path,'origin',origin,
            'properties',properties,'dimensions',(dimensions-'distinctId'-'geography')||CASE WHEN geography IS NOT NULL THEN jsonb_build_object('geography',geography) ELSE '{}'::jsonb END,'source',source,'metricVersion',metric_version) ORDER BY received_at DESC,id DESC) FROM page_rows),'[]') AS page,
          COALESCE((SELECT json_agg(json_build_object('key',property_key,'property',property,'updatedAt',updated_at) ORDER BY property_key COLLATE "C") FROM current_properties),'[]') AS properties`}
      FROM session_context c CROSS JOIN session_page b CROSS JOIN report_arguments`,values);
    const row=rows[0];if(currentKey&&!row?.key_valid)throw new FoundationError(401,'The API key is invalid, expired or unavailable.');
    if(!row?.allowed||!list&&!row.observed)throw missing();if(!row.bound_valid)throw invalid();
    const context=row.session_context,lossKnown=context.lostAt!==null||context.expiredValuesPresent;
    const policyHash=canonicalHash(['session-retention-policy-v1',row.policy_revision,row.raw_days]);
    const evidenceHash=canonicalHash(['session-retention-evidence-v1',row.event_watermark,row.profile_loss_at,lossKnown]);
    if(cursor&&cursor.retention.policyHash!==policyHash)throw new FoundationError(409,'Retention settings changed. Reload this list.');
    const start=iso(row.start)!,end=iso(row.finish)!,coverage=retentionCoverage(start,end,row.retained_from),cohort=cohortCoverage(item,qualification,row);
    const sessionProperties=query.predicates?.sessionProperties?.length?sessionScope(context,row.report_candidates,query.predicates.sessionProperties.some(filter=>filter.operator==='missing'),
      coverage.status==='unavailable'||cohort?.membership.status==='unavailable',coverage.status==='partial'||!!cohort?.membership.countsAreLowerBounds):undefined;
    const reason=coverage.status==='unavailable'?'event_history_unavailable':cohort?.membership.status==='unavailable'?'cohort_membership_unavailable':
      sessionProperties?.selection.status==='unavailable'?'session_property_selection_unavailable':row.totals.events>0&&row.totals.identified===0?'identity_unavailable':null;
    const selection:SessionSelection=reason?{status:'unavailable',reason,countsAreLowerBounds:false}:{status:'available',reason:null,
      countsAreLowerBounds:coverage.status==='partial'||!!cohort?.membership.countsAreLowerBounds||!!sessionProperties?.selection.countsAreLowerBounds||row.totals.unidentified>0};
    const unavailable=selection.status==='unavailable',page=row.page.slice(0,input.pageSize),last=page.at(-1);
    const nextCursor=!unavailable&&row.page.length>input.pageSize&&last?encodeSessionCursor({version:1,projectId,scope:scopeHash,pageSize:input.pageSize,eventBefore:row.event_before,
      retention:{policyHash,initialEvidenceHash:cursor?.retention.initialEvidenceHash??evidenceHash},...(list?{route:'list',last:{at:last.cursorAt,visitorKey:last.visitorKey}}:
        {route:'activity',visitorKey:key!,last:{at:last.cursorAt,id:last.id}})}):null;
    const meta:SessionReadMeta={method:'observed-visitor-session-explorer-v1',asOf:iso(context.asOf)!,range:{from:query.from,to:query.to,timeZone:query.timeZone,start,end},coverage,
      identity:{unit:'rotating-visitor-key',identifiedEvents:unavailable?null:row.totals.identified,
        unidentifiedEvents:unavailable||sessionProperties&&row.report_candidates.unidentified>0?null:row.totals.unidentified,limitation:identityLimitation},selection,
      retention:{policy:{revision:row.policy_revision,rawAnalyticsDays:row.raw_days},eventRetainedFrom:iso(row.event_watermark),profileEvidenceLostAt:iso(row.profile_loss_at),profileEvidenceLost:lossKnown,
        fingerprint:canonicalHash(['session-retention-v1',policyHash,evidenceHash])},...(cohort?{cohort}:{}),...(sessionProperties?{sessionProperties}:{}),
      ...(query.predicates?{predicateMethod:advancedPredicateMethod(query.predicates)}:{}),
      paging:{mode:'current-page-with-fixed-event-bound',eventBefore:row.event_before,consistency:'current-per-page',nextCursor,limit:input.pageSize,
        retentionEvidenceChanged:!!cursor&&cursor.retention.initialEvidenceHash!==evidenceHash}};
    let result:SessionList|SessionDetail;
    if(list)result={...meta,query:input.query,totalKeys:unavailable?null:row.total_keys,
      rows:unavailable?null:page.map(({cursorAt:_,...entry}:SessionRow&{cursorAt:string})=>({...entry,firstAt:iso(entry.firstAt)!,lastAt:iso(entry.lastAt)!}))};
    else{
      if(row.properties.length>50)throw new FoundationError(503,'Current properties are unavailable. Try again.');
      result={...meta,visitorKey:key!,activityScope:'all-key-activity-in-selected-dates',
        summary:{events:unavailable?null:row.totals.events,pageViews:unavailable?null:row.totals.pageViews,customEvents:unavailable?null:row.totals.customEvents,
          visits:unavailable?null:row.totals.visits,firstAt:unavailable?null:iso(row.totals.firstAt),lastAt:unavailable?null:iso(row.totals.lastAt),
          observedVisitSpanSeconds:unavailable?null:row.span,meanObservedVisitSpanSeconds:unavailable?null:row.mean_span},
        activity:unavailable?null:page.map(({cursorAt:_,...entry}:SessionDetail['activity'] extends (infer T)[]|null?T&{cursorAt:string}:never)=>({...entry,receivedAt:iso(entry.receivedAt)!})),
        currentProperties:{method:'current-retained-session-properties-v1',asOf:meta.asOf,retainedFrom:iso(context.cutoff)!,
          evidence:{lost:lossKnown,lostAt:iso(context.lostAt),expiredValuesPresent:context.expiredValuesPresent},
          values:row.properties.map((entry:SessionDetail['currentProperties']['values'][number])=>({...entry,updatedAt:iso(entry.updatedAt)!})),
          absence:lossKnown?'unknown-after-evidence-loss':'unobserved-without-known-loss',limitation:propertyLimitation},
        linkedIdentities:row.linked_lookup_available?
          {status:'lookup-available',action:'open-linked-activity',limitation:'A retained direct link can be checked in these dates. Event evidence may be incomplete or unavailable.'}:
          {status:'unavailable',reason:'link_evidence_unavailable',limitation:'No retained direct identity link is available for this observed key. Its observed activity and current properties remain separate.'}};
    }
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});
    if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'This query took too long. Choose a shorter date range or more filters.');
    throw error;
  }finally{client.release();}
}
