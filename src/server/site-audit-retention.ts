import type { PoolClient } from 'pg';

type Cutoffs = { rawCutoff: Date; derivedCutoff: Date };
const terminal = "r.completed_at IS NOT NULL AND r.status IN('completed','partial','failed','cancelled')";
const rawDue = '(r.deleted_at IS NOT NULL OR r.raw_expired_at IS NOT NULL OR r.data_expired_at IS NOT NULL OR r.completed_at<$2 OR r.completed_at<$3)';
const derivedDue = '(r.deleted_at IS NOT NULL OR r.data_expired_at IS NOT NULL OR r.completed_at<$3)';
const eligible = `(${terminal}) AND (
  (${rawDue} AND r.raw_cleanup_completed_at IS NULL)
  OR (${derivedDue} AND r.data_cleanup_completed_at IS NULL))`;

/** Caller holds authorized W/P gates and UPDATE locks on these bounded run IDs. */
export async function markSiteAuditReadExpiry(client: PoolClient, projectId: string, ids: string[]) {
  if (!ids.length) return [];
  if (ids.length > 101) throw new Error('Audit read selection exceeds its bound.');
  // Fresh DB clock after lock waits; retain native microseconds and elapsed days.
  return (await client.query<{ id: string; raw_expired_at: Date | null; data_expired_at: Date | null }>(`
    WITH policy AS MATERIALIZED (
      SELECT clock_timestamp() AS at,w.raw_provider_evidence_days AS raw_days,w.derived_history_days AS derived_days
      FROM project p JOIN workspace w ON w.id=p.workspace_id WHERE p.id=$1
    ) UPDATE site_audit_run r SET
      raw_expired_at=COALESCE(r.raw_expired_at,policy.at),
      data_expired_at=CASE WHEN r.data_expired_at IS NOT NULL OR r.completed_at<policy.at-policy.derived_days*interval '24 hours'
        THEN COALESCE(r.data_expired_at,policy.at) ELSE NULL END
    FROM policy WHERE r.project_id=$1 AND r.id=ANY($2::uuid[]) AND ${terminal} AND r.deleted_at IS NULL
      AND ((r.raw_expired_at IS NULL AND (r.data_expired_at IS NOT NULL
        OR r.completed_at<policy.at-policy.raw_days*interval '24 hours'
        OR r.completed_at<policy.at-policy.derived_days*interval '24 hours'))
        OR (r.data_expired_at IS NULL AND r.completed_at<policy.at-policy.derived_days*interval '24 hours'))
    RETURNING r.id,r.raw_expired_at,r.data_expired_at`, [projectId, ids])).rows;
}

// Caller holds workspace -> project locks and supplies freshly read policy cutoffs.
// ponytail: one run and at most 1,000 rows per child category per tick. Increase
// measured worker throughput before adding another cleanup coordinator.
export async function expireSiteAuditData(client: PoolClient, projectId: string, cutoffs: Cutoffs) {
  const values = [projectId, cutoffs.rawCutoff, cutoffs.derivedCutoff];
  const result = { expiredAuditRuns: 0, removedAuditPages: 0, removedAuditEdges: 0,
    removedAuditIssues: 0, clearedAuditEvidence: 0, pending: false };
  const selected = (await client.query<{ id: string; derived: boolean; newly_expired: boolean; robots_recorded: boolean }>(`
    SELECT r.id,${derivedDue} AS derived,
      r.data_expired_at IS NULL AS newly_expired,r.robots_body IS NOT NULL AS robots_recorded
    FROM site_audit_run r WHERE r.project_id=$1 AND ${eligible}
    ORDER BY r.completed_at,r.id LIMIT 1 FOR UPDATE`, values)).rows[0];
  if (selected) {
    // Mark before clearing any child. API readers share these gates and suppress
    // remaining payloads even when physical cleanup takes several transactions.
    await client.query(`UPDATE site_audit_run SET raw_expired_at=COALESCE(raw_expired_at,clock_timestamp()),
      data_expired_at=CASE WHEN $2 THEN COALESCE(data_expired_at,clock_timestamp()) ELSE data_expired_at END,
      robots_body=NULL WHERE id=$1`, [selected.id, selected.derived]);
    result.clearedAuditEvidence = Number(selected.robots_recorded);
    if (selected.derived) {
      result.expiredAuditRuns = Number(selected.newly_expired);
      // Materialize each bounded selection once: stale statistics can otherwise
      // inline it on the inner side of a repeated deletion join.
      const edges = await client.query(`WITH expired AS MATERIALIZED (
        SELECT id FROM site_audit_edge WHERE run_id=$1 ORDER BY id LIMIT 1000
      ) DELETE FROM site_audit_edge e USING expired WHERE e.run_id=$1 AND e.id=expired.id`, [selected.id]);
      const issues = await client.query(`WITH expired AS MATERIALIZED (
        SELECT id FROM site_audit_issue WHERE run_id=$1 ORDER BY id LIMIT 1000
      ) DELETE FROM site_audit_issue i USING expired WHERE i.run_id=$1 AND i.id=expired.id`, [selected.id]);
      // Explicitly remove descendants first; a single page must never cascade
      // through an unbounded set of source/target issue or edge rows.
      const pages = await client.query(`WITH expired AS MATERIALIZED (
        SELECT p.id FROM site_audit_page p WHERE p.run_id=$1
          AND NOT EXISTS(SELECT 1 FROM site_audit_edge e WHERE e.run_id=$1 AND e.source_page_id=p.id)
          AND NOT EXISTS(SELECT 1 FROM site_audit_issue i WHERE i.run_id=$1 AND i.page_id=p.id)
          AND NOT EXISTS(SELECT 1 FROM site_audit_issue i WHERE i.run_id=$1 AND i.target_page_id=p.id)
        ORDER BY p.id LIMIT 1000
      ) DELETE FROM site_audit_page p USING expired WHERE p.run_id=$1 AND p.id=expired.id`, [selected.id]);
      result.removedAuditEdges = edges.rowCount ?? 0;
      result.removedAuditIssues = issues.rowCount ?? 0;
      result.removedAuditPages = pages.rowCount ?? 0;
      await client.query(`UPDATE site_audit_run r SET
        data_cleanup_completed_at=COALESCE(data_cleanup_completed_at,clock_timestamp()),
        raw_cleanup_completed_at=COALESCE(raw_cleanup_completed_at,clock_timestamp()),
        config=CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE config END,
        origin=CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE origin END,
        domain_hostname=CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE domain_hostname END,
        domain_verified_at=CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE domain_verified_at END,
        domain_revision=CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE domain_revision END,
        summary=CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE summary END
        WHERE r.id=$1 AND NOT EXISTS(SELECT 1 FROM site_audit_edge WHERE run_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM site_audit_issue WHERE run_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM site_audit_page WHERE run_id=r.id)`, [selected.id]);
    } else {
      const pages = await client.query(`WITH expired AS MATERIALIZED (
        SELECT id FROM site_audit_page WHERE run_id=$1 AND evidence IS NOT NULL ORDER BY id LIMIT 1000
      ) UPDATE site_audit_page p SET evidence=NULL FROM expired WHERE p.run_id=$1 AND p.id=expired.id`, [selected.id]);
      const edges = await client.query(`WITH expired AS MATERIALIZED (
        SELECT id FROM site_audit_edge WHERE run_id=$1 AND anchor IS NOT NULL ORDER BY id LIMIT 1000
      ) UPDATE site_audit_edge e SET anchor=NULL FROM expired WHERE e.run_id=$1 AND e.id=expired.id`, [selected.id]);
      result.clearedAuditEvidence += (pages.rowCount ?? 0) + (edges.rowCount ?? 0);
      await client.query(`UPDATE site_audit_run r SET raw_cleanup_completed_at=COALESCE(raw_cleanup_completed_at,clock_timestamp())
        WHERE r.id=$1 AND r.robots_body IS NULL
          AND NOT EXISTS(SELECT 1 FROM site_audit_page WHERE run_id=r.id AND evidence IS NOT NULL)
          AND NOT EXISTS(SELECT 1 FROM site_audit_edge WHERE run_id=r.id AND anchor IS NOT NULL)`, [selected.id]);
    }
  }
  result.pending = (await client.query<{ pending: boolean }>(`
    SELECT EXISTS(SELECT 1 FROM site_audit_run r WHERE r.project_id=$1 AND ${eligible}) AS pending`, values)).rows[0].pending;
  return result;
}

export async function previewSiteAuditRetention(client: PoolClient, workspaceId: string, cutoffs: Cutoffs) {
  // Limits belong inside each aggregate: callers need a bounded lower bound,
  // never a count(*) over all historical child rows or an invented exact zero.
  const values = [workspaceId, cutoffs.rawCutoff, cutoffs.derivedCutoff];
  const raw = `r.workspace_id=$1 AND (${terminal}) AND r.raw_cleanup_completed_at IS NULL AND ${rawDue}`;
  const derived = `r.workspace_id=$1 AND (${terminal}) AND r.data_cleanup_completed_at IS NULL AND ${derivedDue}`;
  const counts = (await client.query<{ raw_runs: number; raw_pages: number; raw_edges: number; derived_runs: number; derived_pages: number }>(`
    SELECT
      (SELECT count(*)::integer FROM (SELECT r.id FROM site_audit_run r WHERE ${raw}
        AND (r.robots_body IS NOT NULL OR EXISTS(SELECT 1 FROM site_audit_page p WHERE p.run_id=r.id AND p.evidence IS NOT NULL)
          OR EXISTS(SELECT 1 FROM site_audit_edge e WHERE e.run_id=r.id AND e.anchor IS NOT NULL)) LIMIT 10001) s) AS raw_runs,
      (SELECT count(*)::integer FROM (SELECT p.id FROM site_audit_run r JOIN site_audit_page p ON p.run_id=r.id
        WHERE ${raw} AND p.evidence IS NOT NULL LIMIT 10001) s) AS raw_pages,
      (SELECT count(*)::integer FROM (SELECT e.id FROM site_audit_run r JOIN site_audit_edge e ON e.run_id=r.id
        WHERE ${raw} AND e.anchor IS NOT NULL LIMIT 10001) s) AS raw_edges,
      (SELECT count(*)::integer FROM (SELECT r.id FROM site_audit_run r WHERE ${derived} LIMIT 10001) s) AS derived_runs,
      (SELECT count(*)::integer FROM (SELECT p.id FROM site_audit_run r JOIN site_audit_page p ON p.run_id=r.id
        WHERE ${derived} LIMIT 10001) s) AS derived_pages`, values)).rows[0];
  return { status: 'available' as const, rawRuns: Math.min(counts.raw_runs, 10000), rawPages: Math.min(counts.raw_pages, 10000),
    rawEdges: Math.min(counts.raw_edges, 10000), derivedRuns: Math.min(counts.derived_runs, 10000),
    derivedPages: Math.min(counts.derived_pages, 10000), atLeast: Object.values(counts).some(count => count > 10000) };
}
