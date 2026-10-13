import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { expireGoogleImportPages } from './google-retention.ts';
import { expirePromptResults } from './prompt-execution-retention.ts';
import { expireDomainRedirectEvidence } from './domain-redirects.ts';
import { expireKeywordResults } from './keyword-retention.ts';
import { expireSiteAuditData, previewSiteAuditRetention } from './site-audit-retention.ts';

const days = z.number().int().min(1).max(3650);
export const retentionSettingsInput = z.object({ rawAnalyticsDays: days, replayDays: days, rawProviderEvidenceDays: days, derivedHistoryDays: days }).strict();
export type RetentionSettings = z.infer<typeof retentionSettingsInput>;
const previewInput = z.object({ revision: z.number().int().positive(), settings: retentionSettingsInput }).strict();
const tokenInput = previewInput.extend({ version: z.literal(1), workspaceId: z.uuid(), userId: z.string().min(1).max(128), issuedAt: z.number().int().nonnegative() }).strict();
const settingsSql = `json_build_object('rawAnalyticsDays',w.raw_analytics_days,'replayDays',w.replay_days,
  'rawProviderEvidenceDays',w.raw_provider_evidence_days,'derivedHistoryDays',w.derived_history_days)`;
export const retentionCategories = Object.freeze({ rawAnalytics: 'active', replay: 'not_implemented', rawProviderEvidence: 'active', derivedHistory: 'active' } as const);

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
    const current = await client.query('SELECT retention_revision AS revision,clock_timestamp() AS now FROM workspace WHERE id=$1', [workspaceId]);
    if (current.rows[0].revision !== input.revision) throw new FoundationError(409, 'Retention changed. Reload and preview again.');
    const asOf = current.rows[0].now as Date;
    const cutoff = new Date(asOf.getTime() - input.settings.rawAnalyticsDays * 86_400_000);
    const derivedCutoff = new Date(asOf.getTime() - input.settings.derivedHistoryDays * 86_400_000);
    let derivedEstimate: { status: 'available' | 'unavailable'; imports: number | null; atLeast: boolean } = { status: 'unavailable', imports: null, atLeast: false };
    const rawEvidenceCutoff=new Date(asOf.getTime()-input.settings.rawProviderEvidenceDays*86_400_000);
    let promptEstimate: {status:'available'|'unavailable';results:number|null;inputs:number|null;atLeast:boolean}={status:'unavailable',results:null,inputs:null,atLeast:false};
    let redirectEstimate:{status:'available'|'unavailable';checks:number|null;atLeast:boolean}={status:'unavailable',checks:null,atLeast:false};
    let auditEstimate: { status: 'available' | 'unavailable'; rawRuns: number | null; rawPages: number | null; rawEdges: number | null; derivedRuns: number | null; derivedPages: number | null; atLeast: boolean } =
      { status: 'unavailable', rawRuns: null, rawPages: null, rawEdges: null, derivedRuns: null, derivedPages: null, atLeast: false };
    let keywordEstimate: { status: 'available' | 'unavailable'; results: number | null; atLeast: boolean } = { status: 'unavailable', results: null, atLeast: false };
    let savedKeywordEstimate: { status: 'available' | 'unavailable'; metrics: number | null; atLeast: boolean } = { status: 'unavailable', metrics: null, atLeast: false };
    let estimate: { status: 'available' | 'unavailable'; rows: number | null; atLeast: boolean; logicalBytes: number | null } = { status: 'unavailable', rows: null, atLeast: false, logicalBytes: null };
    await client.query('SAVEPOINT estimate');
    try {
      await client.query("SET LOCAL statement_timeout='2s'");
      const sample = await client.query(`SELECT pg_column_size(e)::integer AS bytes FROM project p JOIN event e ON e.project_id=p.id
        WHERE p.workspace_id=$1 AND e.received_at<$2 ORDER BY p.id,e.received_at,e.id LIMIT 10001`, [workspaceId, cutoff]);
      estimate = { status: 'available', rows: Math.min(sample.rows.length, 10000), atLeast: sample.rows.length > 10000,
        logicalBytes: sample.rows.slice(0, 10000).reduce((sum, row) => sum + row.bytes, 0) };
      const imports = await client.query(`SELECT i.id FROM project p JOIN google_import i ON i.project_id=p.id
        WHERE p.workspace_id=$1 AND i.completed_at<$2 AND i.data_expired_at IS NULL
          AND i.status IN ('completed','partial','failed','denied') LIMIT 10001`, [workspaceId, derivedCutoff]);
      derivedEstimate = { status: 'available', imports: Math.min(imports.rows.length, 10000), atLeast: imports.rows.length > 10000 };
      const keywords = await client.query(`SELECT id FROM keyword_research_run
        WHERE workspace_id=$1 AND result IS NOT NULL AND completed_at<$2 LIMIT 10001`, [workspaceId, derivedCutoff]);
      keywordEstimate = { status: 'available', results: Math.min(keywords.rows.length, 10000), atLeast: keywords.rows.length > 10000 };
      const savedKeywords = await client.query(`SELECT k.id FROM saved_keyword k JOIN project p ON p.id=k.project_id
        WHERE p.workspace_id=$1 AND k.metric_data IS NOT NULL AND k.metric_observed_at<$2 LIMIT 10001`, [workspaceId, derivedCutoff]);
      savedKeywordEstimate = { status: 'available', metrics: Math.min(savedKeywords.rows.length, 10000), atLeast: savedKeywords.rows.length > 10000 };
      const prompts=await client.query('SELECT id FROM prompt_execution WHERE workspace_id=$1 AND result IS NOT NULL AND completed_at<$2 LIMIT 10001',[workspaceId,rawEvidenceCutoff]);
      const promptInputs=await client.query(`SELECT q.id FROM prompt_execution_quote q JOIN prompt_comparison c ON c.quote_id=q.id
       WHERE q.workspace_id=$1 AND q.input_purged_at IS NULL AND EXISTS(SELECT 1 FROM prompt_execution r WHERE r.comparison_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM prompt_execution r WHERE r.comparison_id=c.id
          AND (r.status IN('queued','running') OR r.completed_at IS NULL OR r.completed_at>=$2)) LIMIT 10001`,[workspaceId,rawEvidenceCutoff]);
      promptEstimate={status:'available',results:Math.min(prompts.rows.length,10000),inputs:Math.min(promptInputs.rows.length,10000),atLeast:prompts.rows.length>10000||promptInputs.rows.length>10000};
      const redirects=await client.query("SELECT id FROM domain_redirect_check WHERE workspace_id=$1 AND status='completed' AND observation IS NOT NULL AND completed_at<$2 LIMIT 10001",[workspaceId,rawEvidenceCutoff]);
      redirectEstimate={status:'available',checks:Math.min(redirects.rows.length,10000),atLeast:redirects.rows.length>10000};
      auditEstimate = await previewSiteAuditRetention(client, workspaceId, { rawCutoff: rawEvidenceCutoff, derivedCutoff });
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT estimate');
      if (!['57014','55P03'].includes((error as { code?: string }).code ?? '')) throw error;
    }
    await client.query('COMMIT');
    return { ...input, asOf: asOf.toISOString(), cutoff: cutoff.toISOString(), estimate, derivedCutoff: derivedCutoff.toISOString(), derivedEstimate, keywordEstimate, savedKeywordEstimate, promptEstimate, redirectEstimate, auditEstimate, rawEvidenceCutoff:rawEvidenceCutoff.toISOString(), categories: retentionCategories,
      previewToken: makeToken({ version: 1, workspaceId, userId, ...input, issuedAt: asOf.getTime() }) };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function saveRetention(workspaceId: string, userId: string, raw: unknown) {
  const preview = readToken(raw);
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspaceId]);
    await requireOwner(client, workspaceId, userId);
    if (preview.workspaceId !== workspaceId || preview.userId !== userId) throw new FoundationError(400, 'Preview these settings again before saving.');
    const { rows } = await client.query('SELECT retention_revision AS revision,clock_timestamp() AS now FROM workspace WHERE id=$1', [workspaceId]);
    const age = (rows[0].now as Date).getTime() - preview.issuedAt;
    if (rows[0].revision !== preview.revision || age < 0 || age > 300_000) throw new FoundationError(409, 'Retention changed or the preview expired. Reload and preview again.');
    const s = preview.settings;
    await client.query(`UPDATE workspace SET raw_analytics_days=$2,replay_days=$3,raw_provider_evidence_days=$4,derived_history_days=$5,
      retention_revision=retention_revision+1,retention_updated_at=clock_timestamp() WHERE id=$1`, [workspaceId, s.rawAnalyticsDays, s.replayDays, s.rawProviderEvidenceDays, s.derivedHistoryDays]);
    await client.query('UPDATE project SET retention_next_run_at=clock_timestamp() WHERE workspace_id=$1', [workspaceId]);
    await client.query('COMMIT');
    return await getRetention(workspaceId, userId);
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
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
      clock_timestamp()-w.derived_history_days*interval '24 hours' AS derived_cutoff,
      clock_timestamp()-w.raw_provider_evidence_days*interval '24 hours' AS raw_evidence_cutoff
      FROM project p JOIN workspace w ON w.id=p.workspace_id WHERE p.id=$1`, [selected]);
    const state = rows[0];
    const cutoff = state.retention_policy_revision === state.retention_revision && state.retention_cutoff ? state.retention_cutoff : state.cutoff;
    const deleted = await client.query(`WITH expired AS (
      SELECT id FROM event WHERE project_id=$1 AND received_at<$2 ORDER BY received_at,id LIMIT 1000 FOR UPDATE
    ) DELETE FROM event e USING expired WHERE e.project_id=$1 AND e.id=expired.id RETURNING e.visitor_id`, [selected, cutoff]);
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
      OR EXISTS(SELECT 1 FROM analytics_visitor v WHERE v.project_id=$1 AND v.last_seen_at<$2
        AND NOT EXISTS(SELECT 1 FROM event e WHERE e.project_id=v.project_id AND e.visitor_id=v.id)) AS pending`, [selected, cutoff]);
    const imported = await expireGoogleImportPages(client, selected!, state.derived_cutoff);
    const keywords = await expireKeywordResults(client, selected!, state.derived_cutoff);
    const prompts=await expirePromptResults(client,selected!,state.raw_evidence_cutoff);
    const redirects=await expireDomainRedirectEvidence(client,selected!,state.raw_evidence_cutoff);
    const audits = await expireSiteAuditData(client, selected!, { rawCutoff: state.raw_evidence_cutoff, derivedCutoff: state.derived_cutoff });
    const complete = !pending.rows[0].pending && !imported.pending && !keywords.pending && !prompts.pending && !redirects.pending && !audits.pending;
    await client.query(`UPDATE project SET analytics_retained_from=GREATEST(analytics_retained_from,$2::timestamptz),
      retention_policy_revision=$3,retention_cutoff=CASE WHEN $4 THEN NULL ELSE $2::timestamptz END,
      retention_next_run_at=clock_timestamp()+CASE WHEN $4 THEN interval '1 hour' ELSE interval '10 seconds' END,
      retention_last_completed_at=CASE WHEN $4 THEN clock_timestamp() ELSE retention_last_completed_at END,retention_error=NULL WHERE id=$1`, [selected, cutoff, state.retention_revision, complete]);
    await client.query('COMMIT');
    return { projectId: selected, deletedEvents: deleted.rowCount ?? 0, deletedVisitors: removedVisitors.rowCount ?? 0, expiredGoogleImports: imported.expiredImports, expiredKeywordResults: keywords.expiredKeywordResults, expiredSavedKeywordMetrics: keywords.expiredSavedKeywordMetrics, expiredPromptResults: prompts.expiredPromptResults, expiredPromptInputs: prompts.expiredPromptInputs, expiredDomainRedirects:redirects.expiredDomainRedirects,
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
