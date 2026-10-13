import type { PoolClient } from 'pg';

type Cutoffs = { rawCutoff: Date; derivedCutoff: Date };
// Reopening free collection changes completed_at. It must never renew payload age.
const runAnchor = 'COALESCE(r.started_at,r.created_at)';
const taskAnchor = `LEAST(COALESCE(t.observed_at,${runAnchor}),${runAnchor})`;
const rawDue = `(r.raw_expired_at IS NOT NULL OR r.data_expired_at IS NOT NULL OR t.raw_expired_at IS NOT NULL OR t.data_expired_at IS NOT NULL OR ${taskAnchor}<$2 OR ${taskAnchor}<$3)`;
const derivedDue = `(r.data_expired_at IS NOT NULL OR t.data_expired_at IS NOT NULL OR ${taskAnchor}<$3)`;
const rawTask = `(${rawDue} AND (t.raw_expired_at IS NULL OR t.raw_evidence IS NOT NULL))`;
const derivedTask = `(${derivedDue} AND (t.data_expired_at IS NULL OR t.position IS NOT NULL OR t.rank_basis IS NOT NULL
  OR t.absolute_position IS NOT NULL OR t.ranking_url IS NOT NULL OR t.serp_features IS NOT NULL
  OR t.checked_depth IS NOT NULL OR t.returned_item_count IS NOT NULL OR t.raw_evidence IS NOT NULL))`;
const runEligible = `r.started_at IS NOT NULL AND (
  ((${runAnchor}<$2 OR ${runAnchor}<$3) AND r.raw_expired_at IS NULL)
  OR (${runAnchor}<$3 AND r.data_expired_at IS NULL)
  OR EXISTS(SELECT 1 FROM rank_task t WHERE t.run_id=r.id AND (${rawTask} OR ${derivedTask})))`;

// Caller holds workspace -> project gates and supplies freshly read policy cutoffs.
// ponytail: one run and at most 1,000 tasks/metrics per tick. Run markers hide
// residual payloads between batches; increase measured throughput before parallelizing.
export async function expireRankData(client: PoolClient, projectId: string, cutoffs: Cutoffs) {
  const values = [projectId, cutoffs.rawCutoff, cutoffs.derivedCutoff];
  const result = { expiredRankRuns: 0, expiredRankTasks: 0, clearedRankEvidence: 0, expiredRankKeywordMetrics: 0, pending: false };
  const selected = (await client.query<{ id: string; raw: boolean; derived: boolean; newly_expired: boolean }>(`
    SELECT r.id,(r.raw_expired_at IS NOT NULL OR r.data_expired_at IS NOT NULL OR ${runAnchor}<$2 OR ${runAnchor}<$3) AS raw,
      (r.data_expired_at IS NOT NULL OR ${runAnchor}<$3) AS derived,
      r.data_expired_at IS NULL AS newly_expired FROM rank_run r WHERE r.project_id=$1 AND ${runEligible}
    ORDER BY r.started_at,r.id LIMIT 1 FOR UPDATE`, values)).rows[0];
  if (selected) {
    await client.query(`UPDATE rank_run SET
      raw_expired_at=CASE WHEN $2 THEN COALESCE(raw_expired_at,clock_timestamp()) ELSE raw_expired_at END,
      data_expired_at=CASE WHEN $3 THEN COALESCE(data_expired_at,clock_timestamp()) ELSE data_expired_at END WHERE id=$1`,
      [selected.id, selected.raw, selected.derived]);
    result.expiredRankRuns = Number(selected.derived && selected.newly_expired);
    const changed = (await client.query<{ cleared: number; expired: number }>(`WITH candidates AS MATERIALIZED (
      SELECT t.id,${derivedDue} AS derived,t.data_expired_at IS NULL AS newly_expired,t.raw_evidence IS NOT NULL AS recorded
      FROM rank_task t JOIN rank_run r ON r.id=t.run_id WHERE r.project_id=$1 AND r.id=$4 AND (${rawTask} OR ${derivedTask})
      ORDER BY t.id LIMIT 1000 FOR UPDATE OF t
    ), changed AS (
      UPDATE rank_task t SET raw_evidence=NULL,raw_expired_at=COALESCE(t.raw_expired_at,clock_timestamp()),
        data_expired_at=CASE WHEN c.derived THEN COALESCE(t.data_expired_at,clock_timestamp()) ELSE t.data_expired_at END,
        position=CASE WHEN c.derived THEN NULL ELSE t.position END,rank_basis=CASE WHEN c.derived THEN NULL ELSE t.rank_basis END,
        absolute_position=CASE WHEN c.derived THEN NULL ELSE t.absolute_position END,ranking_url=CASE WHEN c.derived THEN NULL ELSE t.ranking_url END,
        serp_features=CASE WHEN c.derived THEN NULL ELSE t.serp_features END,checked_depth=CASE WHEN c.derived THEN NULL ELSE t.checked_depth END,
        returned_item_count=CASE WHEN c.derived THEN NULL ELSE t.returned_item_count END
      FROM candidates c WHERE t.id=c.id RETURNING c.recorded,c.derived,c.newly_expired
    ) SELECT count(*) FILTER(WHERE recorded)::integer AS cleared,
      count(*) FILTER(WHERE derived AND newly_expired)::integer AS expired FROM changed`, [...values, selected.id])).rows[0];
    result.clearedRankEvidence = changed.cleared;
    result.expiredRankTasks = changed.expired;
  }
  const metrics = await client.query<{ config_id: string }>(`WITH candidates AS MATERIALIZED (
    SELECT id FROM rank_keyword WHERE project_id=$1 AND metric_data IS NOT NULL AND metric_observed_at<$2
    ORDER BY metric_observed_at,id LIMIT 1000 FOR UPDATE
  ) UPDATE rank_keyword k SET metric_data=NULL,metric_expired_at=COALESCE(k.metric_expired_at,clock_timestamp())
    FROM candidates c WHERE k.id=c.id RETURNING k.config_id`, [projectId, cutoffs.derivedCutoff]);
  result.expiredRankKeywordMetrics = metrics.rowCount ?? 0;
  if (metrics.rowCount) await client.query('UPDATE rank_config SET metrics_revision=metrics_revision+1 WHERE id=ANY($1::uuid[])',
    [[...new Set(metrics.rows.map(row => row.config_id))]]);
  result.pending = (await client.query<{ pending: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM rank_run r WHERE r.project_id=$1 AND ${runEligible})
    OR EXISTS(SELECT 1 FROM rank_keyword WHERE project_id=$1 AND metric_data IS NOT NULL AND metric_observed_at<$3) AS pending`, values)).rows[0].pending;
  return result;
}

export async function previewRankRetention(client: PoolClient, workspaceId: string, cutoffs: Cutoffs) {
  const values = [workspaceId, cutoffs.rawCutoff, cutoffs.derivedCutoff];
  const counts = (await client.query<{ raw_runs: number; raw_tasks: number; derived_runs: number; derived_tasks: number; keyword_metrics: number }>(`SELECT
    (SELECT count(*)::integer FROM (SELECT r.id FROM rank_run r WHERE r.workspace_id=$1 AND r.started_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM rank_task t WHERE t.run_id=r.id AND t.raw_evidence IS NOT NULL
        AND ${rawDue}) LIMIT 10001) s) AS raw_runs,
    (SELECT count(*)::integer FROM (SELECT t.id FROM rank_task t JOIN rank_run r ON r.id=t.run_id
      WHERE r.workspace_id=$1 AND r.started_at IS NOT NULL AND t.raw_evidence IS NOT NULL
        AND ${rawDue} LIMIT 10001) s) AS raw_tasks,
    (SELECT count(*)::integer FROM (SELECT r.id FROM rank_run r WHERE r.workspace_id=$1 AND r.started_at IS NOT NULL
      AND ${runAnchor}<$3 AND r.data_expired_at IS NULL LIMIT 10001) s) AS derived_runs,
    (SELECT count(*)::integer FROM (SELECT t.id FROM rank_task t JOIN rank_run r ON r.id=t.run_id
      WHERE r.workspace_id=$1 AND r.started_at IS NOT NULL AND ${derivedTask} LIMIT 10001) s) AS derived_tasks,
    (SELECT count(*)::integer FROM (SELECT id FROM rank_keyword WHERE workspace_id=$1 AND metric_data IS NOT NULL
      AND metric_observed_at<$3 LIMIT 10001) s) AS keyword_metrics`, values)).rows[0];
  return { status: 'available' as const, rawRuns: Math.min(counts.raw_runs, 10000), rawTasks: Math.min(counts.raw_tasks, 10000),
    derivedRuns: Math.min(counts.derived_runs, 10000), derivedTasks: Math.min(counts.derived_tasks, 10000),
    keywordMetrics: Math.min(counts.keyword_metrics, 10000), atLeast: Object.values(counts).some(count => count > 10000) };
}
