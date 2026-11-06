import type {PoolClient} from 'pg';

const clock=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const copiedInputExpired=`(q.raw_anchor_at<read_clock.at-LEAST(q.raw_days_at_preparation,w.raw_provider_evidence_days,COALESCE($2::integer,w.raw_provider_evidence_days))*interval '24 hours'
 OR q.derived_anchor_at<read_clock.at-LEAST(q.derived_days_at_preparation,w.derived_history_days,COALESCE($3::integer,w.derived_history_days))*interval '24 hours')`;
const dependencyId=(key:string)=>`CASE WHEN length(d->>'${key}')=36 AND d->>'${key}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN (d->>'${key}')::uuid END`;
// Guard casts rather than casting indexed columns: malformed dependencies latch
// unavailable while valid IDs keep primary-key lookups. No source payload is read.
const sourceUnavailable=`(jsonb_array_length(q.dependencies)<>(SELECT count(DISTINCT d->>'executionId') FROM jsonb_array_elements(q.dependencies)d)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(q.dependencies)d WHERE NOT EXISTS(
 SELECT 1 FROM prompt_execution e
 JOIN prompt_comparison c ON c.id=e.comparison_id AND c.project_id=e.project_id AND c.workspace_id=e.workspace_id
 JOIN prompt_execution_quote s ON s.id=c.quote_id AND s.project_id=c.project_id AND s.workspace_id=c.workspace_id
 JOIN prompt_text_version v ON v.id=s.version_id AND v.prompt_id=s.prompt_id AND v.project_id=s.project_id
 WHERE e.id=${dependencyId('executionId')} AND c.id=${dependencyId('comparisonId')} AND s.id=${dependencyId('quoteId')}
 AND s.prompt_id=${dependencyId('promptId')} AND v.id=${dependencyId('versionId')}
 AND e.project_id=q.project_id AND e.workspace_id=q.workspace_id
 AND e.result_purged_at IS NULL AND e.result IS NOT NULL AND s.input_purged_at IS NULL AND s.input IS NOT NULL AND s.messages IS NOT NULL
 AND ${clock('e.completed_at')}=d->>'completedAt' AND ${clock('c.created_at')}=d->>'requestedAt' AND ${clock('s.created_at')}=d->>'quoteCreatedAt'
 AND e.completed_at<=read_clock.at AND e.completed_at>=read_clock.at-w.raw_provider_evidence_days*interval '24 hours'
 AND c.created_at<=read_clock.at AND c.created_at>=read_clock.at-w.derived_history_days*interval '24 hours'
 AND length(d->>'resultHash')=64 AND d->>'resultHash' ~ '^[a-f0-9]+$'
 AND length(d->>'requestHash')=64 AND d->>'requestHash' ~ '^[a-f0-9]+$'
 )))`;
// Copied-policy expiry takes precedence when both conditions hold. Missing/purged
// dependencies with otherwise-current copied evidence are source_expired.
const expiryReason=`CASE WHEN ${copiedInputExpired} THEN 'input_expired' WHEN ${sourceUnavailable} THEN 'source_expired' END`;
const resultPresent='(r.raw_result IS NOT NULL OR r.proposal IS NOT NULL OR r.result_hash IS NOT NULL)';

/** Caller owns workspace/project mutation locks. A latch is permanent even if policy lengthens. */
export async function latchOpportunitiesExpiry(client:PoolClient,projectIds:string[],policy?:{rawDays:number;derivedDays:number},preparationIds?:string[]){
 if(!projectIds.length)return;
 await client.query(`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at), candidates AS(
 SELECT q.id,${expiryReason} AS reason,read_clock.at FROM ai_opportunity_preparation q JOIN workspace w ON w.id=q.workspace_id CROSS JOIN read_clock
 WHERE q.project_id=ANY($1::text[]) AND ($4::uuid[] IS NULL OR q.id=ANY($4::uuid[])) AND q.raw_expired_at IS NULL)
 UPDATE ai_opportunity_preparation q SET raw_expired_at=c.at,unavailable_reason=c.reason FROM candidates c WHERE q.id=c.id AND c.reason IS NOT NULL`,[projectIds,policy?.rawDays??null,policy?.derivedDays??null,preparationIds??null]);
}

/** Purge at most 100 results and 100 copied inputs; identities, dependencies and history survive. */
export async function expireOpportunities(client:PoolClient,projectId:string){
 await latchOpportunitiesExpiry(client,[projectId]);
 const results=await client.query(`WITH candidates AS(SELECT r.id FROM ai_opportunity_run r JOIN ai_opportunity_preparation q ON q.id=r.preparation_id
 WHERE q.project_id=$1 AND q.raw_expired_at IS NOT NULL AND ${resultPresent} ORDER BY r.created_at,r.id LIMIT 100 FOR UPDATE OF r)
 UPDATE ai_opportunity_run r SET raw_result=NULL,proposal=NULL,result_hash=NULL,result_purged_at=COALESCE(result_purged_at,clock_timestamp()) FROM candidates c WHERE r.id=c.id`,[projectId]);
 const inputs=await client.query(`WITH candidates AS(SELECT id FROM ai_opportunity_preparation WHERE project_id=$1 AND raw_expired_at IS NOT NULL AND input_purged_at IS NULL ORDER BY created_at,id LIMIT 100 FOR UPDATE)
 UPDATE ai_opportunity_preparation q SET source_input=NULL,snapshot=NULL,messages=NULL,input_purged_at=clock_timestamp() FROM candidates c WHERE q.id=c.id`,[projectId]);
 const pending=(await client.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM ai_opportunity_preparation q WHERE q.project_id=$1 AND q.raw_expired_at IS NOT NULL
 AND(q.input_purged_at IS NULL OR EXISTS(SELECT 1 FROM ai_opportunity_run r WHERE r.preparation_id=q.id AND ${resultPresent}))) AS pending`,[projectId])).rows[0].pending;
 return {expiredOpportunityInputs:inputs.rowCount??0,expiredOpportunityResults:results.rowCount??0,pending};
}

/** Same decision as the latch, without mutation. The 10,001st row only signals a capped preview. */
export async function previewOpportunitiesRetention(client:PoolClient,workspaceId:string,rawDays:number,derivedDays:number){
 const rows=(await client.query<{id:string;input:boolean;result:boolean}>(`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at)
 SELECT q.id,q.input_purged_at IS NULL AS input,EXISTS(SELECT 1 FROM ai_opportunity_run r WHERE r.preparation_id=q.id AND ${resultPresent}) AS result
 FROM ai_opportunity_preparation q JOIN workspace w ON w.id=q.workspace_id CROSS JOIN read_clock
 WHERE q.workspace_id=$1 AND(q.raw_expired_at IS NOT NULL OR (${expiryReason}) IS NOT NULL)
 AND(q.input_purged_at IS NULL OR EXISTS(SELECT 1 FROM ai_opportunity_run r WHERE r.preparation_id=q.id AND ${resultPresent}))
 ORDER BY q.created_at,q.id LIMIT 10001`,[workspaceId,rawDays,derivedDays])).rows;
 const counted=rows.slice(0,10000);return {status:'available' as const,inputs:counted.filter(r=>r.input).length,results:counted.filter(r=>r.result).length,atLeast:rows.length>10000};
}
