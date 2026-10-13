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
    await client.query('COMMIT');
    return { pausedBudgets: budgets.rowCount ?? 0, cancelledReservations: cancelled.rowCount ?? 0, disabledSchedules: schedules.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
