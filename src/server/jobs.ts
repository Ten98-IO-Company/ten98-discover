import { randomUUID } from 'node:crypto';
import { PgBoss, type Job, type WorkOptions } from 'pg-boss';
import type { PoolClient } from 'pg';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { FoundationError } from './auth.ts';
import { registerResourceCleanup } from './resource-cleanup.ts';
import { runRetentionBatch } from './retention.ts';
import {runTrackedAssetRetention} from './tracked-assets.ts';
import { googleQueue, reconcileGoogleImports, startGoogleImportWorker } from './google-jobs.ts';
import {keywordQueue,executeKeywordResearch,reconcileKeywordJobs} from './keyword-research.ts';
import {domainResearchQueue,executeDomainResearch,reconcileDomainResearchJobs} from './domain-research.ts';
import {promptExecutionQueue,executePromptExecution,executePromptComparison,reconcilePromptExecutionJobs} from './prompt-execution.ts';
import {suggestionQueue} from './ai-suggestions.ts';
import {executeAiSuggestion,reconcileAiSuggestionJobs} from './ai-suggestion-worker.ts';
import {aiSearchQueue,executeAiSearch,reconcileAiSearchJobs} from './ai-search.ts';
import {contentSupportQueue} from './ai-content-support.ts';
import {executeContentSupport,reconcileContentSupportJobs} from './ai-content-support-worker.ts';
import {domainRedirectQueue,executeDomainRedirectCheck,reconcileDomainRedirectChecks} from './domain-redirects.ts';
import {siteAuditQueue} from './site-audits.ts';
import {rankQueue} from './rank-execution.ts';
import {rankPollQueue,executeRankDispatch,pollRankDispatch,reconcileRankJobs} from './rank-worker.ts';
import {claimDueRankOccurrence} from './rank-recurring.ts';
import {claimDuePromptOccurrence} from './prompt-recurring.ts';
import {startSiteAuditWorker,reconcileSiteAudits,stopSiteAudits} from './site-audit-worker.ts';
import {accountClosureRetentionCron,accountClosureRetentionJobOptions,accountClosureRetentionQueue,runClosedAccountRetention} from './account-closure-retention.ts';
const reconcilers = [reconcileKeywordJobs, reconcileDomainResearchJobs, reconcileRankJobs, reconcilePromptExecutionJobs, reconcileAiSuggestionJobs, reconcileAiSearchJobs, reconcileContentSupportJobs, reconcileDomainRedirectChecks];

const queueName = 'setup-probe';
/**
 * Idle polling contract. Queues with `notify` wake the worker through a transactional pg_notify
 * on the job insert, so polling is only a 30 s backstop. When LISTEN is unavailable (for example
 * a transaction-mode PgBouncer) pg-boss falls back to `pollingIntervalSeconds`, which keeps the
 * previous 2 s (prompt children 0.5 s) latency. Rank polls are created with a future
 * `startAfter`, which a NOTIFY on insert cannot announce, so that queue keeps plain 2 s polling.
 */
export const jobPolling = { pollingIntervalSeconds: 2, notifyPollingIntervalSeconds: 30 } as const;
export const jobQueues = (): { name: string; notify: boolean }[] => [queueName, googleQueue, keywordQueue, domainResearchQueue, promptExecutionQueue, suggestionQueue, aiSearchQueue, contentSupportQueue, domainRedirectQueue, siteAuditQueue, rankQueue, rankPollQueue, accountClosureRetentionQueue]
  .map((name) => ({ name, notify: name !== rankPollQueue }));
/**
 * Only the worker holds the dedicated LISTEN connection; producers emit NOTIFY regardless. The worker also runs the
 * pg-boss cron timekeeper for the daily closed-account retention job; web processes never schedule.
 */
export const bossOptions = (connectionString: string, listen: boolean) => ({ connectionString, schedule: listen, connectionTimeoutMillis: 5000, useListenNotify: listen });
let listenForJobs = false;
let bossPromise: Promise<PgBoss> | undefined;
let workerPromise: Promise<void> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatTask: Promise<unknown> | undefined;
let retentionTask: Promise<unknown> | undefined;
let recurringTimer: ReturnType<typeof setInterval> | undefined;
let recurringTask: Promise<unknown> | undefined;
let workerStarted = false;

export function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    registerResourceCleanup('jobs', stopJobs);
    const boss = new PgBoss(bossOptions(getConfig().databaseUrl, listenForJobs));
    boss.on('error', () => console.error('Job queue unavailable; check database availability.'));
    bossPromise = (async () => {
      try {
        await boss.start();
        // createQueue leaves an existing queue untouched, so updateQueue applies notify to prior installs.
        for (const { name, notify } of jobQueues()) { await boss.createQueue(name); await boss.updateQueue(name, { notify }); }
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

/**
 * Every worker registers through this helper. After a non-empty batch it wakes its own worker so
 * a backlog (for example the prompt children committed in one transaction, which Postgres folds
 * into one NOTIFY) drains back to back instead of waiting out the idle backstop.
 */
export async function workJobs<T extends object>(boss: PgBoss, name: string, options: Pick<WorkOptions, 'batchSize' | 'pollingIntervalSeconds'>, handler: (jobs: Job<T>[]) => Promise<unknown>) {
  let workerId: string | undefined;
  // A single-job batch stores the handler's resolved value as the job output.
  workerId = await boss.work<T>(name, { ...jobPolling, ...options }, async (jobs) => {
    try { return await handler(jobs); } finally { if (workerId && jobs.length) boss.notifyWorker(workerId); }
  });
  return workerId;
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

/** Account closure: deny the account's queued worker checks and cancel their jobs in the caller's transaction. */
export async function cancelQueuedProbes(client: PoolClient, userId: string): Promise<number> {
  const denied = await client.query<{ id: string }>(
    `UPDATE import_probe SET status='denied', completed_at=now(), error='The account was closed before this check ran.'
     WHERE user_id=$1 AND status='queued' RETURNING id`, [userId],
  );
  if (denied.rowCount) {
    const boss = await getBoss();
    await boss.cancel(queueName, denied.rows.map((row) => row.id), { db: { executeSql: (text, values) => client.query(text, values) } });
  }
  return denied.rowCount ?? 0;
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
  await reconcileGoogleImports();
  for (const reconcile of reconcilers) await reconcile();
  await reconcileSiteAudits();
  // ponytail: one worker health row covers the single-worker Compose profile; use instance IDs before scaling workers.
  return getDatabase().pool.query(
    `INSERT INTO worker_heartbeat(id, last_seen_at) VALUES ('foundation-worker', now())
     ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  );
}

export function startWorker(): Promise<void> {
  if (!workerPromise) workerPromise = (async () => {
    try {
      listenForJobs = true;
      const boss = await getBoss();
      for (const reconcile of reconcilers) await reconcile();
      await workJobs<{ probeId: string }>(boss, queueName, { batchSize: 5 }, async (jobs) => {
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
      await startGoogleImportWorker(boss);
      await workJobs<{runId:string}>(boss,keywordQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeKeywordResearch(job.data?.runId);});
      await workJobs<{runId:string}>(boss,domainResearchQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeDomainResearch(job.data?.runId);});
      await workJobs<{dispatchId:string}>(boss,rankQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeRankDispatch(job.data?.dispatchId);});
      await workJobs<{dispatchId:string;generation:string}>(boss,rankPollQueue,{batchSize:1},async jobs=>{for(const job of jobs)await pollRankDispatch(job.data?.dispatchId,job.data?.generation);});
      // ponytail: the comparisonId branch drains jobs queued before per-child Start; remove one release after C2
      // ponytail: one job per child since D3. NOTIFY plus workJobs' post-batch wake start children immediately; the 0.5s poll
      // keeps the pre-D3 ceiling when LISTEN is unavailable. Children still run one at a time per worker.
      // Upgrade path: localConcurrency for parallel children.
      await workJobs<{executionId?:string;comparisonId?:string}>(boss,promptExecutionQueue,{batchSize:1,pollingIntervalSeconds:0.5},async jobs=>{for(const job of jobs)await(job.data?.executionId?executePromptExecution(job.data.executionId):executePromptComparison(job.data?.comparisonId as string));});
      await workJobs<{runId:string}>(boss,suggestionQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeAiSuggestion(job.data?.runId);});
      await workJobs<{runId:string}>(boss,aiSearchQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeAiSearch(job.data?.runId);});
      await workJobs<{runId:string}>(boss,contentSupportQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeContentSupport(job.data?.runId);});
      await workJobs<{checkId:string}>(boss,domainRedirectQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeDomainRedirectCheck(job.data?.checkId);});
      await startSiteAuditWorker(boss);
      // Closed-account retention (https://github.com/Ten98-IO-Company/ten98-discover/wiki/Account-Closure#retention): one bounded run a day. Its per-table counts are the
      // job output in pgboss.job; they hold no account ids or personal data.
      await workJobs(boss,accountClosureRetentionQueue,{batchSize:1},async()=>{
        const summary=await runClosedAccountRetention();
        console.log(`Closed-account retention: ${Object.values(summary.deleted).reduce((sum,n)=>sum+n,0)} rows and ${summary.tombstones} tombstones deleted${summary.capped?'; more remain for the next run':''}.`);
        if(summary.ledgerFailed||summary.tombstonesFailed)console.error('Closed-account retention stopped early; inspect database availability. The next daily run continues.');
        return summary;
      });
      await boss.schedule(accountClosureRetentionQueue,accountClosureRetentionCron,null,{...accountClosureRetentionJobOptions});
      workerStarted = true;
      await heartbeat();
      heartbeatTimer = setInterval(() => {
        if (!heartbeatTask) heartbeatTask = heartbeat()
          .catch(() => console.error('Worker heartbeat failed; check database availability.'))
          .finally(() => { heartbeatTask = undefined; });
        if (!retentionTask) retentionTask = runRetentionBatch().then(()=>runTrackedAssetRetention())
          .catch(() => console.error('Retention cleanup failed; inspect retention status and database availability.'))
          .finally(() => { retentionTask = undefined; });
      }, 10_000);
      // Keep provider preflight outside heartbeat/healthcheck and never overlap a
      // prior claim. ponytail: one due tracker per family per tick caps each at six
      // starts/minute; use a bounded claim queue if workload requires more.
      recurringTimer = setInterval(() => {
        if (!recurringTask) recurringTask = Promise.allSettled([claimDueRankOccurrence(),claimDuePromptOccurrence()])
          .then(results=>{if(results.some(result=>result.status==='rejected'))console.error('Recurring schedule check failed; inspect schedule status and database availability.');})
          .finally(() => { recurringTask = undefined; });
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
  if (recurringTimer) clearInterval(recurringTimer);
  recurringTimer = undefined;
  await heartbeatTask;
  await retentionTask;
  await recurringTask;
  await stopSiteAudits();
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
