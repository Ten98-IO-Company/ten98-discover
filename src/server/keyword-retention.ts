import type { PoolClient } from 'pg';

// The shared retention pass holds workspace/project gates and reads the current policy first.
export async function expireKeywordResults(client: PoolClient, projectId: string, cutoff: Date) {
  const expired = await client.query(`WITH candidates AS (
    SELECT id FROM keyword_research_run WHERE project_id=$1 AND result IS NOT NULL AND completed_at<$2
    ORDER BY completed_at,id LIMIT 100 FOR UPDATE
  ) UPDATE keyword_research_run r SET result=NULL,result_purged_at=clock_timestamp()
    FROM candidates c WHERE r.id=c.id`, [projectId, cutoff]);
  const saved = await client.query(`WITH candidates AS (
    SELECT id FROM saved_keyword WHERE project_id=$1 AND metric_data IS NOT NULL AND metric_observed_at<$2
    ORDER BY metric_observed_at,id LIMIT 100 FOR UPDATE
  ) UPDATE saved_keyword k SET metric_data=NULL,metric_expired_at=clock_timestamp()
    FROM candidates c WHERE k.id=c.id`, [projectId, cutoff]);
  if(saved.rowCount) await client.query('UPDATE project SET saved_keyword_metrics_revision=saved_keyword_metrics_revision+1 WHERE id=$1',[projectId]);
  // Only abandoned quotes are disposable. Used quotes and all charge evidence remain as receipts.
  await client.query(`DELETE FROM keyword_quote WHERE id IN (
    SELECT q.id FROM keyword_quote q WHERE q.project_id=$1 AND q.saved_refresh_plan_id IS NULL AND q.expires_at<clock_timestamp()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM keyword_research_run r WHERE r.quote_id=q.id)
    ORDER BY q.expires_at,q.id LIMIT 100
  )`, [projectId]);
  // An unstarted, long-expired plan has no request-key receipt or incurred charge.
  // Started plans and their immutable target UUIDs/used quotes are never purged.
  const plans=await client.query<{id:string}>(`SELECT p.id FROM saved_keyword_refresh_plan p WHERE p.project_id=$1 AND p.started_at IS NULL
    AND p.expires_at<clock_timestamp()-interval '24 hours'
    AND NOT EXISTS(SELECT 1 FROM keyword_quote q JOIN keyword_research_run r ON r.quote_id=q.id WHERE q.saved_refresh_plan_id=p.id)
    ORDER BY p.expires_at,p.id LIMIT 100 FOR UPDATE`,[projectId]);
  if(plans.rowCount){const ids=plans.rows.map(p=>p.id);await client.query('DELETE FROM keyword_quote WHERE saved_refresh_plan_id=ANY($1::uuid[])',[ids]);await client.query('DELETE FROM saved_keyword_refresh_plan WHERE id=ANY($1::uuid[])',[ids]);}
  const pending = await client.query(`SELECT
    EXISTS(SELECT 1 FROM keyword_research_run WHERE project_id=$1 AND result IS NOT NULL AND completed_at<$2)
    OR EXISTS(SELECT 1 FROM saved_keyword WHERE project_id=$1 AND metric_data IS NOT NULL AND metric_observed_at<$2)
    OR EXISTS(SELECT 1 FROM keyword_quote q WHERE q.project_id=$1 AND q.saved_refresh_plan_id IS NULL AND q.expires_at<clock_timestamp()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM keyword_research_run r WHERE r.quote_id=q.id))
    OR EXISTS(SELECT 1 FROM saved_keyword_refresh_plan p WHERE p.project_id=$1 AND p.started_at IS NULL AND p.expires_at<clock_timestamp()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM keyword_quote q JOIN keyword_research_run r ON r.quote_id=q.id WHERE q.saved_refresh_plan_id=p.id)) AS pending`, [projectId, cutoff]);
  return { expiredKeywordResults: expired.rowCount ?? 0, expiredSavedKeywordMetrics:saved.rowCount??0, pending: pending.rows[0].pending as boolean };
}
