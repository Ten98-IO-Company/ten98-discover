import { getDatabase } from './db.ts';

/** Offline operation: stop every web/worker writer before restoring and calling this.
 * A restored reservation cannot prove whether the original installation sent it later.
 * Preserve financial evidence, but never make that old authorization spendable again.
 */
export async function quarantineRestoredSpending() {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT id FROM workspace ORDER BY id FOR UPDATE');
    const budgets = await client.query(`INSERT INTO workspace_budget(workspace_id,paused)
      SELECT id,true FROM workspace
      ON CONFLICT(workspace_id) DO UPDATE SET paused=true,updated_at=clock_timestamp()
      WHERE NOT workspace_budget.paused`);
    const cancelled = await client.query(`UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp()
      WHERE status='reserved'`);
    const schedules = await client.query(`UPDATE rank_config SET schedule_enabled=false,next_due_at=NULL,
      last_skip_reason='Restored installation: review and explicitly approve a new schedule.',updated_at=clock_timestamp()
      WHERE schedule_enabled OR next_due_at IS NOT NULL`);
    const promptSchedules=await client.query(`UPDATE prompt_tracker SET enabled=false,next_due_at=NULL,approval_id=NULL,approval_user_id=NULL,
      approval_connection_revision=NULL,approval_key_fingerprint=NULL,approval_models_hash=NULL,approved_at=NULL,
      revision=LEAST(revision+1,2147483646),last_status='Restored installation: review a fresh quote and explicitly approve again.',updated_at=clock_timestamp()
      WHERE enabled OR approval_id IS NOT NULL OR next_due_at IS NOT NULL`);
    // Replay grants are browser-held capabilities: restoring the same signing key must not revive them.
    await client.query("UPDATE tracked_asset SET active=false,collection_enabled=false,revision=LEAST(revision::bigint+1,2147483647)::integer,updated_at=clock_timestamp() WHERE active OR collection_enabled");
    await client.query('UPDATE tracked_asset_share SET revoked_at=clock_timestamp(),revision=LEAST(revision::bigint+1,2147483647)::integer WHERE revoked_at IS NULL');
    await client.query('UPDATE project_share SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL');
    await client.query(`UPDATE project SET analytics_settings=jsonb_set(jsonb_set(analytics_settings,'{replay,enabled}','false'::jsonb),'{heatmap,enabled}','false'::jsonb),
      analytics_epoch=gen_random_uuid(),analytics_revision=LEAST(analytics_revision::bigint+1,2147483647)::integer WHERE analytics_settings?'replay' OR analytics_settings?'heatmap'`);
    await client.query('COMMIT');
    return { pausedBudgets: budgets.rowCount ?? 0, cancelledReservations: cancelled.rowCount ?? 0, disabledSchedules: (schedules.rowCount??0)+(promptSchedules.rowCount??0) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
