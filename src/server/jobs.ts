import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { FoundationError } from './auth.ts';
import { registerResourceCleanup } from './resource-cleanup.ts';

const queueName = 'setup-probe';
let bossPromise: Promise<PgBoss> | undefined;
let workerPromise: Promise<void> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatTask: Promise<unknown> | undefined;
let workerStarted = false;

export function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    registerResourceCleanup('jobs', stopJobs);
    const boss = new PgBoss({ connectionString: getConfig().databaseUrl, schedule: false, connectionTimeoutMillis: 5000 });
    boss.on('error', () => console.error('Job queue unavailable; check database availability.'));
    bossPromise = (async () => {
      try {
        await boss.start();
        await boss.createQueue(queueName);
        return boss;
      } catch (error) {
        await boss.stop({ graceful: false }).catch(() => undefined);
        bossPromise = undefined;
        throw error;
      }
    })();
  }
  return bossPromise;
}

export async function enqueueProbe(projectId: string, userId: string, requestId: string) {
  const boss = await getBoss();
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT w.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.id=$1 FOR UPDATE OF w', [projectId]);
    const access = await client.query('SELECT m.role FROM membership m JOIN project p ON p.workspace_id=m.workspace_id WHERE p.id=$1 AND m.user_id=$2', [projectId, userId]);
    if (!['owner', 'admin', 'editor'].includes(access.rows[0]?.role)) throw new FoundationError(404, 'Project not found or unavailable.');
    const inserted = await client.query<{ id: string; status: string }>(
      `INSERT INTO import_probe(id, project_id, user_id, request_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, request_id) DO NOTHING RETURNING id, status`,
      [randomUUID(), projectId, userId, requestId],
    );
    let probe = inserted.rows[0];
    if (probe) {
      const jobId = await boss.send(queueName, { probeId: probe.id }, {
        id: probe.id, retryLimit: 2, retryDelay: 5, expireInSeconds: 30,
        db: { executeSql: (text, values) => client.query(text, values) },
      });
      if (!jobId) throw new Error('Probe could not be queued');
    } else {
      const existing = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM import_probe WHERE project_id = $1 AND request_id = $2',
        [projectId, requestId],
      );
      probe = existing.rows[0];
      if (!probe) throw new Error('Probe no longer exists');
    }
    await client.query('COMMIT');
    return probe;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileProbes(projectId?: string): Promise<void> {
  const { pool } = getDatabase();
  const pending = await pool.query(
    'SELECT 1 FROM import_probe WHERE status = $1 AND ($2::text IS NULL OR project_id = $2) LIMIT 1',
    ['queued', projectId ?? null],
  );
  if (!pending.rowCount) return;
  await getBoss();
  // Pinned pg-boss 12 stores all queue partitions beneath pgboss.job; recheck this read when upgrading it.
  await pool.query(
    `UPDATE import_probe probe SET status = 'failed', completed_at = now(),
       error = 'The worker check did not complete. Run the check again.'
     FROM import_probe pending LEFT JOIN pgboss.job job ON job.id = pending.id AND job.name = $1
     WHERE probe.id = pending.id AND probe.status = 'queued'
       AND ($2::text IS NULL OR probe.project_id = $2)
       AND (job.id IS NULL OR job.state IN ('failed', 'cancelled', 'completed'))`,
    [queueName, projectId ?? null],
  );
}

async function heartbeat() {
  const boss = await getBoss();
  if (!await boss.getQueue(queueName)) throw new Error('Worker queue is unavailable');
  await reconcileProbes();
  // ponytail: one worker health row covers the single-worker Compose profile; use instance IDs before scaling workers.
  return getDatabase().pool.query(
    `INSERT INTO worker_heartbeat(id, last_seen_at) VALUES ('foundation-worker', now())
     ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  );
}

export function startWorker(): Promise<void> {
  if (!workerPromise) workerPromise = (async () => {
    try {
      const boss = await getBoss();
      await boss.work<{ probeId: string }>(queueName, { batchSize: 5 }, async (jobs) => {
        for (const job of jobs) {
          if (typeof job.data?.probeId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(job.data.probeId)) {
            throw new Error('Invalid setup probe payload');
          }
          await getDatabase().pool.query(
            `WITH access AS (
               SELECT ip.id, EXISTS (
                 SELECT 1 FROM project p JOIN membership m ON m.workspace_id = p.workspace_id
                 WHERE p.id = ip.project_id AND m.user_id = ip.user_id AND m.role IN ('owner', 'admin', 'editor')
               ) AS allowed FROM import_probe ip WHERE ip.id = $1 AND ip.status = 'queued'
             ) UPDATE import_probe ip SET
               status = CASE WHEN access.allowed THEN 'completed' ELSE 'denied' END,
               completed_at = now(),
               error = CASE WHEN access.allowed THEN NULL ELSE 'Project access was revoked before this check ran.' END
             FROM access WHERE ip.id = access.id AND ip.status = 'queued'`,
            [job.data.probeId],
          );
        }
      });
      workerStarted = true;
      await heartbeat();
      heartbeatTimer = setInterval(() => {
        if (!heartbeatTask) heartbeatTask = heartbeat()
          .catch(() => console.error('Worker heartbeat failed; check database availability.'))
          .finally(() => { heartbeatTask = undefined; });
      }, 10_000);
    } catch (error) {
      await stopJobs();
      throw error;
    }
  })();
  return workerPromise;
}

export async function stopJobs() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  await heartbeatTask;
  const boss = await bossPromise?.catch(() => undefined);
  try {
    await boss?.stop({ graceful: true, timeout: 30_000 });
  } finally {
    bossPromise = undefined;
    workerPromise = undefined;
    if (workerStarted) {
      workerStarted = false;
      await getDatabase().pool.query("DELETE FROM worker_heartbeat WHERE id = 'foundation-worker'")
        .catch(() => console.error('Worker heartbeat cleanup failed; it will expire automatically.'));
    }
  }
}
