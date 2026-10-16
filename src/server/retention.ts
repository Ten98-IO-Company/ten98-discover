import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { expireGoogleImportPages } from './google-retention.ts';
import { expirePromptResults } from './prompt-execution-retention.ts';
import {expireAiSuggestions} from './ai-suggestion-worker.ts';
import {expireAiSearch,latchAiSearchExpiry,previewAiSearchRetention} from './ai-search.ts';
import {expireContentSupport,latchContentSupportExpiry,previewContentSupportRetention} from './ai-content-support.ts';
import { expireDomainRedirectEvidence } from './domain-redirects.ts';
import { expireKeywordResults } from './keyword-retention.ts';
import {expireDomainResearch} from './domain-research-retention.ts';
import { expireRankData, previewRankRetention } from './rank-retention.ts';
import { expireSiteAuditData, previewSiteAuditRetention } from './site-audit-retention.ts';
import {expireSessionProperties,latchSessionPropertyRetention} from './session-property-retention.ts';
import {expireIdentityLinks,latchIdentityLinkRetention} from './identity-links.ts';

const days = z.number().int().min(1).max(3650);
export const retentionSettingsInput = z.object({ rawAnalyticsDays: days, replayDays: days, rawProviderEvidenceDays: days, derivedHistoryDays: days }).strict();
export type RetentionSettings = z.infer<typeof retentionSettingsInput>;
const previewInput = z.object({ revision: z.number().int().positive(), settings: retentionSettingsInput }).strict();
const tokenInput = previewInput.extend({ version: z.literal(1), workspaceId: z.uuid(), userId: z.string().min(1).max(128), issuedAt: z.number().int().nonnegative() }).strict();
const settingsSql = `json_build_object('rawAnalyticsDays',w.raw_analytics_days,'replayDays',w.replay_days,
  'rawProviderEvidenceDays',w.raw_provider_evidence_days,'derivedHistoryDays',w.derived_history_days)`;
export const retentionCategories = Object.freeze({ rawAnalytics: 'active', replay: 'active', rawProviderEvidence: 'active', derivedHistory: 'active' } as const);

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new FoundationError(400, 'Check the retention fields and try again.');
  return result.data;
}
async function requireOwner(client: PoolClient, workspaceId: string, userId: string) {
  const { rows } = await client.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
  if (!rows[0]) throw new FoundationError(404, 'Workspace not found or unavailable.');
  if (rows[0].role !== 'owner') throw new FoundationError(403, 'Only a workspace owner can change retention.');
}
function signature(body: string) { return createHmac('sha256', getConfig().authSecret).update(`ten98.retention.preview.v1:${body}`).digest('hex'); }
function makeToken(payload: z.infer<typeof tokenInput>) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signature(body)}`;
}
function readToken(value: unknown) {
  const { previewToken } = parse(z.object({ previewToken: z.string().min(1).max(4096) }).strict(), value);
  if (!/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$(?![\s\S])/.test(previewToken)) throw new FoundationError(400, 'Preview these settings again before saving.');
  const [body, signed] = previewToken.split('.');
  if (!timingSafeEqual(Buffer.from(signed, 'hex'), Buffer.from(signature(body), 'hex'))) throw new FoundationError(400, 'Preview these settings again before saving.');
  try { return parse(tokenInput, JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))); }
  catch { throw new FoundationError(400, 'Preview these settings again before saving.'); }
}

export async function getRetention(workspaceId: string, userId: string) {
  const { rows } = await getDatabase().pool.query(`SELECT w.id AS "workspaceId",m.role,w.retention_revision AS revision,
    ${settingsSql} AS settings,w.retention_updated_at AS "updatedAt",
    (SELECT count(*)::integer FROM project p WHERE p.workspace_id=w.id AND p.retention_error IS NOT NULL) AS "failedProjects",
    (SELECT max(retention_last_completed_at) FROM project p WHERE p.workspace_id=w.id) AS "lastCompletedAt"
    FROM workspace w JOIN membership m ON m.workspace_id=w.id AND m.user_id=$2 WHERE w.id=$1`, [workspaceId, userId]);
  if (!rows[0]) throw new FoundationError(404, 'Workspace not found or unavailable.');
  return { ...rows[0], categories: retentionCategories };
}

export async function previewRetention(workspaceId: string, userId: string, raw: unknown) {
  const input = parse(previewInput, raw);
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='250ms'");
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE', [workspaceId]);
    await requireOwner(client, workspaceId, userId);
    const current = await client.query('SELECT retention_revision AS revision,raw_analytics_days,raw_provider_evidence_days,clock_timestamp() AS now FROM workspace WHERE id=$1', [workspaceId]);
    if (current.rows[0].revision !== input.revision) throw new FoundationError(409, 'Retention changed. Reload and preview again.');
    const asOf = current.rows[0].now as Date;
    const cutoff = new Date(asOf.getTime() - input.settings.rawAnalyticsDays * 86_400_000);
    const profileCutoff = new Date(asOf.getTime()-Math.min(current.rows[0].raw_analytics_days,input.settings.rawAnalyticsDays)*86_400_000);
    let profileEstimate:{status:'available'|'unavailable';properties:number|null;atLeast:boolean}={status:'unavailable',properties:null,atLeast:false};
    let identityLinkEstimate:{status:'available'|'unavailable';links:number|null;atLeast:boolean}={status:'unavailable',links:null,atLeast:false};
    const derivedCutoff = new Date(asOf.getTime() - input.settings.derivedHistoryDays * 86_400_000);
    let derivedEstimate: { status: 'available' | 'unavailable'; imports: number | null; atLeast: boolean } = { status: 'unavailable', imports: null, atLeast: false };
    let metaEstimate: { status: 'available' | 'unavailable'; imports: number | null; atLeast: boolean } = { status: 'unavailable', imports: null, atLeast: false };
    let metaInventoryEstimate: { status: 'available' | 'unavailable'; inventories: number | null; atLeast: boolean } = { status: 'unavailable', inventories: null, atLeast: false };
    const rawEvidenceCutoff=new Date(asOf.getTime()-input.settings.rawProviderEvidenceDays*86_400_000);
    let promptEstimate: {status:'available'|'unavailable';results:number|null;inputs:number|null;atLeast:boolean}={status:'unavailable',results:null,inputs:null,atLeast:false};
    let aiSearchEstimate:{status:'available'|'unavailable';results:number|null;inputs:number|null;protected:number|null;atLeast:boolean}={status:'unavailable',results:null,inputs:null,protected:null,atLeast:false};
    let contentSupportEstimate:{status:'available'|'unavailable';results:number|null;inputs:number|null;atLeast:boolean}={status:'unavailable',results:null,inputs:null,atLeast:false};
    let redirectEstimate:{status:'available'|'unavailable';checks:number|null;atLeast:boolean}={status:'unavailable',checks:null,atLeast:false};
    let auditEstimate: { status: 'available' | 'unavailable'; rawRuns: number | null; rawPages: number | null; rawEdges: number | null; derivedRuns: number | null; derivedPages: number | null; atLeast: boolean } =
      { status: 'unavailable', rawRuns: null, rawPages: null, rawEdges: null, derivedRuns: null, derivedPages: null, atLeast: false };
    let rankEstimate: { status: 'available' | 'unavailable'; rawRuns: number | null; rawTasks: number | null; derivedRuns: number | null; derivedTasks: number | null; keywordMetrics: number | null; atLeast: boolean } =
      { status: 'unavailable', rawRuns: null, rawTasks: null, derivedRuns: null, derivedTasks: null, keywordMetrics: null, atLeast: false };
    let keywordEstimate: { status: 'available' | 'unavailable'; results: number | null; atLeast: boolean } = { status: 'unavailable', results: null, atLeast: false };
    let domainResearchEstimate: {status:'available'|'unavailable';results:number|null;atLeast:boolean}={status:'unavailable',results:null,atLeast:false};
    let savedKeywordEstimate: { status: 'available' | 'unavailable'; metrics: number | null; atLeast: boolean } = { status: 'unavailable', metrics: null, atLeast: false };
    let estimate: { status: 'available' | 'unavailable'; rows: number | null; atLeast: boolean; logicalBytes: number | null } = { status: 'unavailable', rows: null, atLeast: false, logicalBytes: null };
    let replayEstimate:{status:'available'|'unavailable';recordings:number|null;chunks:number|null;atLeast:boolean;logicalBytes:number|null}={status:'unavailable',recordings:null,chunks:null,atLeast:false,logicalBytes:null};
    await client.query('SAVEPOINT estimate');
    try {
      await client.query("SET LOCAL statement_timeout='2s'");
      const sample = await client.query(`SELECT bytes FROM (
        SELECT pg_column_size(e)::integer AS bytes,p.id AS project_id,e.received_at AS at,e.id::text AS id,'event' AS kind
          FROM project p JOIN event e ON e.project_id=p.id WHERE p.workspace_id=$1 AND e.received_at<$2
        UNION ALL SELECT pg_column_size(e)::integer,a.id::text,e.received_at,e.id::text,'tracked-asset'
          FROM tracked_asset a JOIN tracked_asset_event e ON e.asset_id=a.id WHERE a.workspace_id=$1 AND e.received_at<$2
        UNION ALL SELECT pg_column_size(v)::integer,p.id,v.created_at,v.navigation_id::text||v.metric,'performance'
          FROM project p JOIN web_performance v ON v.project_id=p.id WHERE p.workspace_id=$1 AND v.created_at<$2
        UNION ALL SELECT pg_column_size(h)::integer,p.id,h.received_at,h.request_id::text,'heatmap'
          FROM project p JOIN heatmap_batch h ON h.project_id=p.id WHERE p.workspace_id=$1 AND h.received_at<GREATEST(p.analytics_retained_from,$2::timestamptz)
        UNION ALL SELECT pg_column_size(c)::integer,p.id,c.created_at,c.id::text,'heatmap-capture'
          FROM project p JOIN heatmap_capture c ON c.project_id=p.id WHERE p.workspace_id=$1 AND c.path IS NOT NULL AND c.created_at<GREATEST(p.analytics_retained_from,$2::timestamptz)
        ) raw ORDER BY project_id,at,id,kind LIMIT 10001`, [workspaceId, cutoff]);
      estimate = { status: 'available', rows: Math.min(sample.rows.length, 10000), atLeast: sample.rows.length > 10000,
        logicalBytes: sample.rows.slice(0, 10000).reduce((sum, row) => sum + row.bytes, 0) };
      const replayCutoff=new Date(asOf.getTime()-input.settings.replayDays*86400000);
      const replayRows=(await client.query(`SELECT kind,bytes FROM(
        SELECT 'recording' AS kind,pg_column_size(r)::integer AS bytes,r.created_at,r.id AS recording_id,-1 AS sequence FROM session_recording r JOIN project p ON p.id=r.project_id WHERE p.workspace_id=$1 AND r.created_at<GREATEST(p.replay_retained_from,$2) AND(r.entry_path IS NOT NULL OR r.chunk_count<>0 OR r.byte_count<>0 OR r.created_at<$3)
        UNION ALL SELECT 'chunk',pg_column_size(c)::integer,r.created_at,r.id,c.sequence FROM session_recording_chunk c JOIN session_recording r ON r.id=c.recording_id JOIN project p ON p.id=r.project_id WHERE p.workspace_id=$1 AND r.created_at<GREATEST(p.replay_retained_from,$2)
        ) sampled ORDER BY created_at,recording_id,sequence LIMIT 10001`,[workspaceId,replayCutoff,derivedCutoff])).rows;
      const replaySample=replayRows.slice(0,10000);replayEstimate={status:'available',recordings:replaySample.filter(r=>r.kind==='recording').length,chunks:replaySample.filter(r=>r.kind==='chunk').length,atLeast:replayRows.length>10000,logicalBytes:replaySample.reduce((n,r)=>n+r.bytes,0)};
      const profiles=await client.query(`SELECT s.property_key FROM project p JOIN analytics_session_property s ON s.project_id=p.id
        WHERE p.workspace_id=$1 AND s.updated_at<GREATEST(p.session_properties_retained_from,$2::timestamptz) LIMIT 10001`,[workspaceId,profileCutoff]);
      profileEstimate={status:'available',properties:Math.min(profiles.rows.length,10000),atLeast:profiles.rows.length>10000};
      const links=await client.query(`SELECT l.visitor_key FROM project p JOIN analytics_identity_link l ON l.project_id=p.id
        JOIN workspace w ON w.id=p.workspace_id WHERE p.workspace_id=$1
        AND l.last_accepted_at<GREATEST(p.identity_links_retained_from,statement_timestamp()-LEAST(w.raw_analytics_days,$2::integer)*interval '24 hours') LIMIT 10001`,[workspaceId,input.settings.rawAnalyticsDays]);
      identityLinkEstimate={status:'available',links:Math.min(links.rows.length,10000),atLeast:links.rows.length>10000};
      const imports = await client.query(`SELECT i.id FROM project p JOIN google_import i ON i.project_id=p.id
        WHERE p.workspace_id=$1 AND i.completed_at<$2 AND i.data_expired_at IS NULL
          AND i.status IN ('completed','partial','failed','denied') LIMIT 10001`, [workspaceId, derivedCutoff]);
      derivedEstimate = { status: 'available', imports: Math.min(imports.rows.length, 10000), atLeast: imports.rows.length > 10000 };
      const metaImports = await client.query(`SELECT id FROM meta_import
        WHERE workspace_id=$1 AND completed_at IS NOT NULL AND payload_cleanup_completed_at IS NULL
          AND (data_expired_at IS NOT NULL OR deleted_at IS NOT NULL OR completed_at<=$2) LIMIT 10001`, [workspaceId, derivedCutoff]);
      metaEstimate = { status: 'available', imports: Math.min(metaImports.rows.length, 10000), atLeast: metaImports.rows.length > 10000 };
      const metaInventories = await client.query(`SELECT id FROM meta_campaign_inventory
        WHERE workspace_id=$1 AND completed_at IS NOT NULL AND payload_cleanup_completed_at IS NULL
          AND (data_expired_at IS NOT NULL OR deleted_at IS NOT NULL OR completed_at<=$2) LIMIT 10001`, [workspaceId, derivedCutoff]);
      metaInventoryEstimate = { status: 'available', inventories: Math.min(metaInventories.rows.length, 10000), atLeast: metaInventories.rows.length > 10000 };
      const keywords = await client.query(`SELECT id FROM keyword_research_run
        WHERE workspace_id=$1 AND result IS NOT NULL AND completed_at<$2 LIMIT 10001`, [workspaceId, derivedCutoff]);
      keywordEstimate = { status: 'available', results: Math.min(keywords.rows.length, 10000), atLeast: keywords.rows.length > 10000 };
      const domainResearch=await client.query('SELECT id FROM domain_research_run WHERE workspace_id=$1 AND result IS NOT NULL AND completed_at<$2 LIMIT 10001',[workspaceId,derivedCutoff]);
      domainResearchEstimate={status:'available',results:Math.min(domainResearch.rows.length,10000),atLeast:domainResearch.rows.length>10000};
      const savedKeywords = await client.query(`SELECT k.id FROM saved_keyword k JOIN project p ON p.id=k.project_id
        WHERE p.workspace_id=$1 AND k.metric_data IS NOT NULL AND k.metric_observed_at<$2 LIMIT 10001`, [workspaceId, derivedCutoff]);
      savedKeywordEstimate = { status: 'available', metrics: Math.min(savedKeywords.rows.length, 10000), atLeast: savedKeywords.rows.length > 10000 };
      const prompts=await client.query('SELECT id FROM prompt_execution WHERE workspace_id=$1 AND result IS NOT NULL AND completed_at<$2 LIMIT 10001',[workspaceId,rawEvidenceCutoff]);
      const promptInputs=await client.query(`SELECT q.id FROM prompt_execution_quote q JOIN prompt_comparison c ON c.quote_id=q.id
       WHERE q.workspace_id=$1 AND q.input_purged_at IS NULL AND EXISTS(SELECT 1 FROM prompt_comparison_item i WHERE i.comparison_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM prompt_comparison_item i JOIN prompt_execution r ON r.id=i.execution_id WHERE i.comparison_id=c.id
          AND (r.status IN('queued','running') OR r.completed_at IS NULL OR r.completed_at>=$2)) LIMIT 10001`,[workspaceId,rawEvidenceCutoff]);
      promptEstimate={status:'available',results:Math.min(prompts.rows.length,10000),inputs:Math.min(promptInputs.rows.length,10000),atLeast:prompts.rows.length>10000||promptInputs.rows.length>10000};
      const redirects=await client.query("SELECT id FROM domain_redirect_check WHERE workspace_id=$1 AND status='completed' AND observation IS NOT NULL AND completed_at<$2 LIMIT 10001",[workspaceId,rawEvidenceCutoff]);
      redirectEstimate={status:'available',checks:Math.min(redirects.rows.length,10000),atLeast:redirects.rows.length>10000};
      rankEstimate = await previewRankRetention(client, workspaceId, { rawCutoff: rawEvidenceCutoff, derivedCutoff });
      aiSearchEstimate=await previewAiSearchRetention(client,workspaceId,new Date(asOf.getTime()-Math.min(current.rows[0].raw_provider_evidence_days,input.settings.rawProviderEvidenceDays)*86_400_000));
      auditEstimate = await previewSiteAuditRetention(client, workspaceId, { rawCutoff: rawEvidenceCutoff, derivedCutoff });
      contentSupportEstimate=await previewContentSupportRetention(client,workspaceId,input.settings.rawProviderEvidenceDays,input.settings.derivedHistoryDays);
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT estimate');
      if (!['57014','55P03'].includes((error as { code?: string }).code ?? '')) throw error;
    }
    await client.query('COMMIT');
    return { ...input, asOf: asOf.toISOString(), cutoff: cutoff.toISOString(), estimate, replayEstimate, profileEstimate, identityLinkEstimate, derivedCutoff: derivedCutoff.toISOString(), derivedEstimate, metaEstimate, metaInventoryEstimate, keywordEstimate, domainResearchEstimate, savedKeywordEstimate, promptEstimate, aiSearchEstimate, contentSupportEstimate, redirectEstimate, auditEstimate, rankEstimate, rawEvidenceCutoff:rawEvidenceCutoff.toISOString(), categories: retentionCategories,
      previewToken: makeToken({ version: 1, workspaceId, userId, ...input, issuedAt: asOf.getTime() }) };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function saveRetention(workspaceId: string, userId: string, raw: unknown) {
  const preview = readToken(raw);
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspaceId]);
    await requireOwner(client, workspaceId, userId);
    if (preview.workspaceId !== workspaceId || preview.userId !== userId) throw new FoundationError(400, 'Preview these settings again before saving.');
    const { rows } = await client.query('SELECT retention_revision AS revision,raw_analytics_days,replay_days,raw_provider_evidence_days,derived_history_days,clock_timestamp() AS now FROM workspace WHERE id=$1', [workspaceId]);
    const age = (rows[0].now as Date).getTime() - preview.issuedAt;
    if (rows[0].revision !== preview.revision || age < 0 || age > 300_000) throw new FoundationError(409, 'Retention changed or the preview expired. Reload and preview again.');
    const s = preview.settings;
    await client.query(`UPDATE workspace SET raw_analytics_days=$2,replay_days=$3,raw_provider_evidence_days=$4,derived_history_days=$5,
      retention_revision=retention_revision+1,retention_updated_at=clock_timestamp() WHERE id=$1`, [workspaceId, s.rawAnalyticsDays, s.replayDays, s.rawProviderEvidenceDays, s.derivedHistoryDays]);
    const projects=await client.query('UPDATE project SET retention_next_run_at=clock_timestamp() WHERE workspace_id=$1 RETURNING id', [workspaceId]);
    const saveClock=(await client.query(`SELECT instant AS now,to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS link_as_of,
      to_char((instant-$1::integer*interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS link_cutoff,
      to_char((instant-$2::integer*interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ai_search_cutoff
      FROM (SELECT clock_timestamp() AS instant) clock`,[Math.min(rows[0].raw_analytics_days,s.rawAnalyticsDays),Math.min(rows[0].raw_provider_evidence_days,s.rawProviderEvidenceDays)])).rows[0];
    const saveNow=saveClock.now as Date;
    await client.query('UPDATE tracked_asset SET retained_from=GREATEST(retained_from,$2::timestamptz),next_cleanup_at=clock_timestamp() WHERE workspace_id=$1',[workspaceId,saveClock.link_cutoff]);
    await client.query('UPDATE project SET replay_retained_from=GREATEST(replay_retained_from,$2::timestamptz) WHERE workspace_id=$1',[workspaceId,new Date(saveNow.getTime()-Math.min(rows[0].replay_days,s.replayDays)*86400000)]);
    await latchSessionPropertyRetention(client,projects.rows.map(p=>p.id),new Date(saveNow.getTime()-Math.min(rows[0].raw_analytics_days,s.rawAnalyticsDays)*86_400_000),saveNow);
    await latchIdentityLinkRetention(client,projects.rows.map(p=>p.id),saveClock.link_cutoff,saveClock.link_as_of);
    await latchAiSearchExpiry(client,projects.rows.map(p=>p.id),saveClock.ai_search_cutoff);
    // Atomic old/new minimum latching precedes commit. A timeout rolls back the
    // complete policy change; physical deletion remains bounded per worker tick.
    await latchContentSupportExpiry(client,projects.rows.map(p=>p.id),{rawDays:Math.min(rows[0].raw_provider_evidence_days,s.rawProviderEvidenceDays),derivedDays:Math.min(rows[0].derived_history_days,s.derivedHistoryDays)});
    await client.query('COMMIT');
    return await getRetention(workspaceId, userId);
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); if(['57014','55P03'].includes((error as {code?:string})?.code??''))throw new FoundationError(503,'Retention is busy. Reload and preview again.');throw error; }
  finally { client.release(); }
}

export function retentionCoverage(start: string, end: string, retainedFrom: string | Date | null) {
  const boundary = retainedFrom === null ? null : new Date(retainedFrom).toISOString();
  return { status: boundary === null || Date.parse(start) >= Date.parse(boundary) ? 'complete' as const :
    Date.parse(end) <= Date.parse(boundary) ? 'unavailable' as const : 'partial' as const, retainedFrom: boundary };
}

// ponytail: one short workspace/project transaction per tick suits the single-host worker.
// Add measured concurrency/partitioning only when this bounded pass cannot keep up.
export async function runRetentionBatch(projectId?: string) {
  const client = await getDatabase().pool.connect();
  let selected: string | undefined;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='250ms'");
    await client.query("SET LOCAL statement_timeout='2s'");
    const candidate = await client.query(`SELECT p.id,p.workspace_id FROM project p JOIN workspace w ON w.id=p.workspace_id
      WHERE ($1::text IS NULL AND p.retention_next_run_at<=clock_timestamp()) OR p.id=$1
      ORDER BY p.retention_next_run_at,p.id LIMIT 1 FOR UPDATE OF w SKIP LOCKED`, [projectId ?? null]);
    if (!candidate.rows[0]) { await client.query('COMMIT'); return null; }
    selected = candidate.rows[0].id;
    await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE', [selected]);
    // Fresh statement after both gates: collection/settings may have committed while we waited.
    const { rows } = await client.query(`SELECT p.retention_cutoff,p.retention_policy_revision,w.retention_revision,
      clock_timestamp()-w.raw_analytics_days*interval '24 hours' AS cutoff,
      GREATEST(p.replay_retained_from,clock_timestamp()-w.replay_days*interval '24 hours') AS replay_cutoff,
      clock_timestamp()-w.derived_history_days*interval '24 hours' AS derived_cutoff,
      clock_timestamp()-w.raw_provider_evidence_days*interval '24 hours' AS raw_evidence_cutoff,clock_timestamp() AS profile_as_of,
      to_char((statement_timestamp()-w.raw_analytics_days*interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS link_cutoff,
      to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS link_as_of
      FROM project p JOIN workspace w ON w.id=p.workspace_id WHERE p.id=$1`, [selected]);
    const state = rows[0];
    const cutoff = state.retention_policy_revision === state.retention_revision && state.retention_cutoff ? state.retention_cutoff : state.cutoff;
    const deleted = await client.query(`WITH expired AS (
      SELECT id FROM event WHERE project_id=$1 AND received_at<$2 ORDER BY received_at,id LIMIT 1000 FOR UPDATE
    ) DELETE FROM event e USING expired WHERE e.project_id=$1 AND e.id=expired.id RETURNING e.visitor_id`, [selected, cutoff]);
    // Each chunk is <=256KiB: 32 rows bound one pass to at most8MiB of replay payload.
    const replayPaths=await client.query(`WITH expired AS(
      SELECT id FROM session_recording WHERE project_id=$1 AND created_at<$2 AND entry_path IS NOT NULL ORDER BY created_at,id LIMIT 1000 FOR UPDATE
      )UPDATE session_recording r SET entry_path=NULL FROM expired e WHERE r.id=e.id`,[selected,state.replay_cutoff]);
    const replayChunks=await client.query(`WITH expired AS(
      SELECT c.recording_id,c.sequence FROM session_recording_chunk c JOIN session_recording r ON r.id=c.recording_id
      WHERE r.project_id=$1 AND r.created_at<$2 ORDER BY r.created_at,r.id,c.sequence LIMIT 32 FOR UPDATE OF c
      )DELETE FROM session_recording_chunk c USING expired e WHERE c.recording_id=e.recording_id AND c.sequence=e.sequence`,[selected,state.replay_cutoff]);
    // Retain bounded-lived request tombstones so a lost Begin ACK cannot recreate purged content.
    const replayMetadata=await client.query(`WITH expired AS(
      SELECT r.id FROM session_recording r WHERE r.project_id=$1 AND r.created_at<$2 AND NOT EXISTS(SELECT 1 FROM session_recording_chunk c WHERE c.recording_id=r.id)
      AND(r.chunk_count<>0 OR r.byte_count<>0 OR r.last_sequence IS NOT NULL OR r.first_event_timestamp IS NOT NULL OR r.last_event_timestamp IS NOT NULL OR r.complete OR r.missing_fragments IS NOT NULL)
      ORDER BY r.created_at,r.id LIMIT 1000 FOR UPDATE
      )UPDATE session_recording r SET chunk_count=0,byte_count=0,last_sequence=NULL,first_event_timestamp=NULL,last_event_timestamp=NULL,complete=false,missing_fragments=NULL FROM expired e WHERE r.id=e.id`,[selected,state.replay_cutoff]);
    const replayRecordings=await client.query(`WITH expired AS(
      SELECT r.id FROM session_recording r WHERE r.project_id=$1 AND r.created_at<LEAST($2::timestamptz,$3::timestamptz) AND entry_path IS NULL AND NOT EXISTS(SELECT 1 FROM session_recording_chunk c WHERE c.recording_id=r.id)
      ORDER BY r.created_at,r.id LIMIT 1000 FOR UPDATE
      )DELETE FROM session_recording r USING expired e WHERE r.id=e.id`,[selected,state.replay_cutoff,state.derived_cutoff]);
    const replayPending=(await client.query(`SELECT EXISTS(SELECT 1 FROM session_recording r WHERE project_id=$1 AND(created_at<LEAST($2::timestamptz,$3::timestamptz) OR(created_at<$2 AND(entry_path IS NOT NULL OR chunk_count<>0 OR byte_count<>0 OR last_sequence IS NOT NULL OR first_event_timestamp IS NOT NULL OR last_event_timestamp IS NOT NULL OR complete OR missing_fragments IS NOT NULL OR EXISTS(SELECT 1 FROM session_recording_chunk c WHERE c.recording_id=r.id))))) AS pending`,[selected,state.replay_cutoff,state.derived_cutoff])).rows[0].pending;
    await client.query('UPDATE project SET replay_retained_from=GREATEST(replay_retained_from,$2::timestamptz) WHERE id=$1',[selected,state.replay_cutoff]);
    const performance=await client.query(`WITH expired AS (
      SELECT navigation_id,metric FROM web_performance WHERE project_id=$1 AND created_at<$2
      ORDER BY created_at,navigation_id,metric LIMIT 1000 FOR UPDATE
    ) DELETE FROM web_performance v USING expired e WHERE v.project_id=$1 AND v.navigation_id=e.navigation_id AND v.metric=e.metric`,[selected,cutoff]);
    // Each batch is <=32KiB;64 rows add at most2MiB to the existing bounded pass.
    const heatmapBatches=await client.query(`WITH expired AS(SELECT h.request_id FROM heatmap_batch h JOIN project p ON p.id=h.project_id WHERE h.project_id=$1 AND h.received_at<GREATEST(p.analytics_retained_from,$2::timestamptz) ORDER BY h.received_at,h.request_id LIMIT 64 FOR UPDATE OF h)DELETE FROM heatmap_batch h USING expired e WHERE h.project_id=$1 AND h.request_id=e.request_id`,[selected,cutoff]);
    const heatmapPaths=await client.query(`WITH expired AS(SELECT c.id FROM heatmap_capture c JOIN project p ON p.id=c.project_id WHERE c.project_id=$1 AND c.path IS NOT NULL AND c.created_at<GREATEST(p.analytics_retained_from,$2::timestamptz) ORDER BY c.created_at,c.id LIMIT 1000 FOR UPDATE OF c)UPDATE heatmap_capture c SET path=NULL FROM expired e WHERE c.project_id=$1 AND c.id=e.id`,[selected,cutoff]);
    // Reference metadata has no independent lifetime and never keeps either source alive.
    const heatmapBackgrounds=await client.query(`WITH expired AS(
      SELECT b.project_id,b.capture_id,b.geometry_key FROM heatmap_background b JOIN session_recording r ON r.project_id=b.project_id AND r.id=b.recording_id
      JOIN heatmap_capture h ON h.project_id=b.project_id AND h.id=b.capture_id
      WHERE b.project_id=$1 AND(r.created_at<$2 OR r.entry_path IS NULL OR h.path IS NULL)
      ORDER BY b.accepted_at,b.capture_id,b.geometry_key LIMIT 64 FOR UPDATE OF b
      )DELETE FROM heatmap_background b USING expired e WHERE b.project_id=e.project_id AND b.capture_id=e.capture_id AND b.geometry_key=e.geometry_key`,[selected,state.replay_cutoff]);
    const heatmapBackgroundPending=(await client.query(`SELECT EXISTS(SELECT 1 FROM heatmap_background b JOIN session_recording r ON r.project_id=b.project_id AND r.id=b.recording_id JOIN heatmap_capture h ON h.project_id=b.project_id AND h.id=b.capture_id WHERE b.project_id=$1 AND(r.created_at<$2 OR r.entry_path IS NULL OR h.path IS NULL))AS pending`,[selected,state.replay_cutoff])).rows[0].pending;
    const heatmapCaptures=await client.query(`WITH expired AS(SELECT c.id FROM heatmap_capture c WHERE c.project_id=$1 AND c.created_at<LEAST($2::timestamptz,$3::timestamptz)AND c.path IS NULL AND NOT EXISTS(SELECT 1 FROM heatmap_batch b WHERE b.project_id=c.project_id AND b.capture_id=c.id)ORDER BY c.created_at,c.id LIMIT 1000 FOR UPDATE)DELETE FROM heatmap_capture c USING expired e WHERE c.project_id=$1 AND c.id=e.id`,[selected,cutoff,state.derived_cutoff]);
    const heatmapPending=(await client.query(`SELECT EXISTS(SELECT 1 FROM heatmap_batch h JOIN project p ON p.id=h.project_id WHERE h.project_id=$1 AND h.received_at<GREATEST(p.analytics_retained_from,$2::timestamptz))OR EXISTS(SELECT 1 FROM heatmap_capture c JOIN project p ON p.id=c.project_id WHERE c.project_id=$1 AND(c.created_at<LEAST($2::timestamptz,$3::timestamptz)OR(c.path IS NOT NULL AND c.created_at<GREATEST(p.analytics_retained_from,$2::timestamptz))))AS pending`,[selected,cutoff,state.derived_cutoff])).rows[0].pending;
    const affected = [...new Set(deleted.rows.map(row => row.visitor_id).filter(Boolean))];
    if (affected.length) {
      await client.query(`UPDATE analytics_visitor v SET (first_seen_at,last_seen_at)=(
        SELECT min(received_at),max(received_at) FROM event WHERE project_id=v.project_id AND visitor_id=v.id)
        WHERE v.project_id=$1 AND v.id=ANY($2::text[]) AND EXISTS(SELECT 1 FROM event WHERE project_id=v.project_id AND visitor_id=v.id)`, [selected, affected]);
    }
    const removedVisitors = await client.query(`WITH expired AS (
      SELECT v.id FROM analytics_visitor v WHERE v.project_id=$1 AND v.last_seen_at<$2
        AND NOT EXISTS(SELECT 1 FROM event e WHERE e.project_id=v.project_id AND e.visitor_id=v.id)
      ORDER BY v.last_seen_at,v.id LIMIT 1000
    ) DELETE FROM analytics_visitor v USING expired WHERE v.project_id=$1 AND v.id=expired.id`, [selected, cutoff]);
    const pending = await client.query(`SELECT EXISTS(SELECT 1 FROM event WHERE project_id=$1 AND received_at<$2)
      OR EXISTS(SELECT 1 FROM web_performance WHERE project_id=$1 AND created_at<$2)
      OR EXISTS(SELECT 1 FROM analytics_visitor v WHERE v.project_id=$1 AND v.last_seen_at<$2
        AND NOT EXISTS(SELECT 1 FROM event e WHERE e.project_id=v.project_id AND e.visitor_id=v.id)) AS pending`, [selected, cutoff]);
    const profiles=await expireSessionProperties(client,selected!,state.cutoff,state.profile_as_of);
    const links=await expireIdentityLinks(client,selected!,state.link_cutoff,state.link_as_of);
    const imported = await expireGoogleImportPages(client, selected!, state.derived_cutoff);
    const keywords = await expireKeywordResults(client, selected!, state.derived_cutoff);
    const domainResearch=await expireDomainResearch(client,selected!,state.derived_cutoff);
    const prompts=await expirePromptResults(client,selected!,state.raw_evidence_cutoff,state.derived_cutoff);
    const suggestions=await expireAiSuggestions(client,selected!,state.raw_evidence_cutoff);
    const aiSearch=await expireAiSearch(client,selected!,state.raw_evidence_cutoff);
    const contentSupport=await expireContentSupport(client,selected!);
    const redirects=await expireDomainRedirectEvidence(client,selected!,state.raw_evidence_cutoff);
    const audits = await expireSiteAuditData(client, selected!, { rawCutoff: state.raw_evidence_cutoff, derivedCutoff: state.derived_cutoff });
    const ranks = await expireRankData(client, selected!, { rawCutoff: state.raw_evidence_cutoff, derivedCutoff: state.derived_cutoff });
    const complete = !heatmapBackgroundPending && !heatmapPending && !replayPending && !domainResearch.pending && !contentSupport.pending && !aiSearch.pending && !links.pending && !profiles.pending && !suggestions.pending && !ranks.pending && !pending.rows[0].pending && !imported.pending && !keywords.pending && !prompts.pending && !redirects.pending && !audits.pending;
    await client.query(`UPDATE project SET analytics_retained_from=GREATEST(analytics_retained_from,$2::timestamptz),
      retention_policy_revision=$3,retention_cutoff=CASE WHEN $4 THEN NULL ELSE $2::timestamptz END,
      retention_next_run_at=clock_timestamp()+CASE WHEN $4 THEN interval '1 hour' ELSE interval '10 seconds' END,
      retention_last_completed_at=CASE WHEN $4 THEN clock_timestamp() ELSE retention_last_completed_at END,retention_error=NULL WHERE id=$1`, [selected, cutoff, state.retention_revision, complete]);
    await client.query('COMMIT');
    return { projectId: selected, deletedEvents: deleted.rowCount ?? 0, deletedPerformance:performance.rowCount??0,deletedHeatmapBackgrounds:heatmapBackgrounds.rowCount??0,deletedHeatmapBatches:heatmapBatches.rowCount??0,clearedHeatmapPaths:heatmapPaths.rowCount??0,deletedHeatmapCaptures:heatmapCaptures.rowCount??0, clearedReplayPaths:replayPaths.rowCount??0,clearedReplayMetadata:replayMetadata.rowCount??0,deletedReplayChunks:replayChunks.rowCount??0,deletedReplayRecordings:replayRecordings.rowCount??0,deletedVisitors: removedVisitors.rowCount ?? 0, expiredGoogleImports: imported.expiredImports, expiredKeywordResults: keywords.expiredKeywordResults, expiredSavedKeywordMetrics: keywords.expiredSavedKeywordMetrics, expiredPromptResults: prompts.expiredPromptResults, expiredPromptInputs: prompts.expiredPromptInputs, expiredDomainRedirects:redirects.expiredDomainRedirects,
      expiredDomainResearchResults:domainResearch.expiredDomainResearchResults,
      expiredSuggestionResults:suggestions.expiredSuggestionResults,expiredSuggestionInputs:suggestions.expiredSuggestionInputs,
      expiredAiSearchResults:aiSearch.expiredAiSearchResults,expiredAiSearchInputs:aiSearch.expiredAiSearchInputs,expiredAiSearchQuotes:aiSearch.expiredAiSearchQuotes,
      expiredContentSupportInputs:contentSupport.expiredContentSupportInputs,expiredContentSupportResults:contentSupport.expiredContentSupportResults,
      expiredSessionProperties:profiles.expiredProperties,expiredIdentifyReceipts:profiles.expiredReceipts,
      expiredIdentityLinks:links.expiredIdentityLinks,
      expiredRankRuns: ranks.expiredRankRuns, expiredRankTasks: ranks.expiredRankTasks, clearedRankEvidence: ranks.clearedRankEvidence, expiredRankKeywordMetrics: ranks.expiredRankKeywordMetrics,
      expiredAuditRuns: audits.expiredAuditRuns, removedAuditPages: audits.removedAuditPages, removedAuditEdges: audits.removedAuditEdges,
      removedAuditIssues: audits.removedAuditIssues, clearedAuditEvidence: audits.clearedAuditEvidence, complete };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (selected) {
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='250ms'");
        await client.query("UPDATE project SET retention_error='cleanup_failed',retention_next_run_at=clock_timestamp()+interval '1 minute' WHERE id=$1", [selected]);
        await client.query('COMMIT');
      } catch { await client.query('ROLLBACK').catch(() => {}); }
    }
    throw error;
  } finally { client.release(); }
}
