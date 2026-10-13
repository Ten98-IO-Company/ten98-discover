import type { PoolClient } from 'pg';

// The shared retention pass holds workspace/project gates and reads the current policy first.
export async function expireKeywordResults(client: PoolClient, projectId: string, cutoff: Date) {
  const expired = await client.query(`WITH candidates AS (
    SELECT id FROM keyword_research_run WHERE project_id=$1 AND result IS NOT NULL AND completed_at<$2
    ORDER BY completed_at,id LIMIT 100 FOR UPDATE
  ) UPDATE keyword_research_run r SET result=NULL,result_purged_at=clock_timestamp()
    FROM candidates c WHERE r.id=c.id`, [projectId, cutoff]);
  // Only abandoned quotes are disposable. Used quotes and all charge evidence remain as receipts.
  await client.query(`DELETE FROM keyword_quote WHERE id IN (
    SELECT q.id FROM keyword_quote q WHERE q.project_id=$1 AND q.expires_at<clock_timestamp()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM keyword_research_run r WHERE r.quote_id=q.id)
    ORDER BY q.expires_at,q.id LIMIT 100
  )`, [projectId]);
  const pending = await client.query(`SELECT
    EXISTS(SELECT 1 FROM keyword_research_run WHERE project_id=$1 AND result IS NOT NULL AND completed_at<$2)
    OR EXISTS(SELECT 1 FROM keyword_quote q WHERE q.project_id=$1 AND q.expires_at<clock_timestamp()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM keyword_research_run r WHERE r.quote_id=q.id)) AS pending`, [projectId, cutoff]);
  return { expiredKeywordResults: expired.rowCount ?? 0, pending: pending.rows[0].pending as boolean };
}
