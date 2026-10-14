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
import {sessionListQuery,sessionActivityQuery,sessionCursorScope,encodeSessionCursor,
  type SessionList,type SessionDetail,type SessionReadMeta,type SessionSelection,type SessionRow} from './session-explorer-input.ts';

export type SessionReadAuthority={kind:'session';userId:string}|{kind:'api-key';token:string};
const identityLimitation='Observed project-scoped visitor keys rotate each UTC month and when identity inputs or the signing secret change. They are not persistent people; continuity across keys is unavailable.';
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
    const {rows}=await client.query(`${ctes}, selected AS MATERIALIZED (SELECT s.* FROM ${population} s WHERE (${keySlot}::text IS NULL OR s.visitor_id=${keySlot}::text)),
      selected_candidates AS MATERIALIZED (SELECT s.* FROM ${reportCandidates??population} s WHERE (${keySlot}::text IS NULL OR s.visitor_id=${keySlot}::text))${pageSql}
      SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT analytics_retained_from FROM target) AS retained_from,
        (${apiKeySlot}::uuid IS NULL OR EXISTS(SELECT 1 FROM api_key k JOIN membership m ON m.workspace_id=k.workspace_id AND m.user_id=k.issuer_user_id
          JOIN project p ON p.workspace_id=k.workspace_id AND p.id=$1 WHERE k.id=${apiKeySlot}::uuid AND k.issuer_user_id=$2
          AND m.role IN ('owner','admin','editor','viewer') AND 'analytics:read'=ANY(k.scopes) AND k.revoked_at IS NULL AND k.expires_at>c.as_of)) AS key_valid,
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
          `EXISTS(SELECT 1 FROM event e JOIN target t ON t.id=e.project_id WHERE e.visitor_id=${keySlot}::text
            AND(t.analytics_retained_from IS NULL OR e.received_at>=t.analytics_retained_from) AND e.received_at<b.event_before) AS observed,
          (SELECT sum(seconds)::text FROM visit_spans) AS span,(SELECT avg(seconds)::text FROM visit_spans) AS mean_span,
          COALESCE((SELECT json_agg(json_build_object('id',id,'receivedAt',received_at,'cursorAt',${stamp('received_at')},'visitKey',visit_id,
            'kind',CASE WHEN event_name='page_view' THEN 'pageview' ELSE 'custom' END,'eventName',event_name,'path',path,'origin',origin,
            'properties',properties,'dimensions',dimensions-'distinctId','source',source,'metricVersion',metric_version) ORDER BY received_at DESC,id DESC) FROM page_rows),'[]') AS page,
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
        linkedIdentities:{status:'unavailable',reason:'link-evidence-not-stored',limitation:identityLimitation}};
    }
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});
    if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'This query took too long. Choose a shorter date range or more filters.');
    throw error;
  }finally{client.release();}
}
