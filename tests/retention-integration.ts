import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getConfig } from '../src/server/config.ts';
import { credentialKeys, encryptCredentials } from '../src/server/credential-vault.ts';
import { getDatabase } from '../src/server/db.ts';
import { analyticsIdentity, collectNative, trackingConsentEpoch } from '../src/server/native-analytics.ts';
import { getRetention, previewRetention, runRetentionBatch, saveRetention } from '../src/server/retention.ts';

export async function runRetentionChecks({ ownerId }: { ownerId: string }): Promise<void> {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Retention checks require the isolated integration-test opt-in.');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(getConfig().databaseUrl).hostname), 'Retention checks require a local PostgreSQL database.');
  assert.ok(credentialKeys(), 'Retention protected-record fixtures require the synthetic integration credential keyring.');
  const { pool } = getDatabase();
  assert.equal((await pool.query('SELECT 1 FROM "user" WHERE id=$1', [ownerId])).rowCount, 1, 'Supply the existing synthetic integration owner.');
  const defaults = { rawAnalyticsDays: 90, replayDays: 7, rawProviderEvidenceDays: 90, derivedHistoryDays: 365 };
  const memberId = randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [memberId, 'Retention fixture member', `${memberId}@retention.integration.test`]);

  async function workspace(actor = ownerId) {
    const id = randomUUID();
    await pool.query('INSERT INTO workspace(id,name) VALUES($1,$2)', [id, 'Retention acceptance']);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [id, actor]);
    return id;
  }
  async function project(workspaceId: string) {
    const id = randomUUID(), siteKey = randomUUID(), origin = `https://${id}.retention.integration.test`;
    // An ordinary worker must not claim test fixtures during setup. The trusted
    // explicit-project runner deliberately bypasses this scheduling field.
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,$3,$4,$5,'infinity')", [id, workspaceId, 'Retention acceptance', origin, siteKey]);
    return { id, siteKey, origin };
  }
  async function pause(id: string) { await pool.query("UPDATE project SET retention_next_run_at='infinity' WHERE id=$1", [id]); }
  async function activate(id: string, cutoff: string) {
    await pool.query(`UPDATE project p SET retention_cutoff=$2,retention_policy_revision=w.retention_revision,retention_next_run_at='infinity'
      FROM workspace w WHERE p.id=$1 AND p.workspace_id=w.id`, [id, cutoff]);
  }
  async function events(id: string) { return (await pool.query('SELECT count(*)::int AS n FROM event WHERE project_id=$1', [id])).rows[0].n as number; }
  async function progress(id: string) {
    return (await pool.query(`SELECT retention_cutoff,retention_policy_revision,analytics_retained_from,retention_last_completed_at,retention_error
      FROM project WHERE id=$1`, [id])).rows[0];
  }
  async function expectStatus(work: Promise<unknown>, status: number, message: string) {
    await assert.rejects(work, (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === status, message);
  }
  async function waitBlocked(blocker: PoolClient) {
    for (let attempt = 0; attempt < 100; attempt++) {
      await blocker.query('SELECT pg_stat_clear_snapshot()');
      const result = await blocker.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pg_backend_pid()=ANY(pg_blocking_pids(pid))');
      if (result.rowCount) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('The pending operation must actually wait for the PostgreSQL authorization lock.');
  }

  const settingsWorkspace = await workspace();
  const initial = await getRetention(settingsWorkspace, ownerId);
  assert.equal(initial.workspaceId, settingsWorkspace); assert.equal(initial.role, 'owner');
  assert.equal(initial.revision, 1); assert.deepEqual(initial.settings, defaults);
  const candidate = { ...defaults, rawAnalyticsDays: 30, replayDays: 14, rawProviderEvidenceDays: 180, derivedHistoryDays: 730 };
  const preview = await previewRetention(settingsWorkspace, ownerId, { revision: initial.revision, settings: candidate });
  assert.deepEqual(preview.settings, candidate);
  assert.equal(preview.revision, initial.revision);
  assert.equal(new Date(preview.asOf).getTime() - new Date(preview.cutoff).getTime(), 30 * 86_400_000, 'The displayed cutoff must represent exactly the proposed retention days.');
  assert.deepEqual(preview.estimate, { status: 'available', rows: 0, atLeast: false, logicalBytes: 0 });
  assert.deepEqual(preview.savedKeywordEstimate, { status: 'available', metrics: 0, atLeast: false });
  assert.deepEqual((await getRetention(settingsWorkspace, ownerId)).settings, defaults, 'Preview must not save the policy.');
  const foreignWorkspace = await workspace(memberId);
  await expectStatus(getRetention(foreignWorkspace, ownerId), 404, 'Foreign policy must remain unavailable.');
  await expectStatus(previewRetention(foreignWorkspace, ownerId, { revision: 1, settings: candidate }), 404, 'Foreign previews must be denied.');
  await expectStatus(saveRetention(foreignWorkspace, ownerId, { previewToken: preview.previewToken }), 404, 'A preview token cannot grant foreign workspace access.');
  await expectStatus(saveRetention(settingsWorkspace, memberId, { previewToken: preview.previewToken }), 404, 'Authorization must precede token binding for a nonmember.');
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [settingsWorkspace, memberId]);
  const memberPreview = await previewRetention(settingsWorkspace, memberId, { revision: 1, settings: candidate });
  for (const role of ['admin', 'editor', 'viewer']) {
    await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role', [settingsWorkspace, memberId, role]);
    assert.equal((await getRetention(settingsWorkspace, memberId)).role, role, 'Every current member may inspect retention.');
    await expectStatus(previewRetention(settingsWorkspace, memberId, { revision: 1, settings: candidate }), 403, 'Only an owner may preview deletion.');
    await expectStatus(saveRetention(settingsWorkspace, memberId, { previewToken: memberPreview.previewToken }), 403, 'Only an owner may confirm a policy.');
    await expectStatus(saveRetention(settingsWorkspace, memberId, { previewToken: preview.previewToken }), 403, 'A differently bound token must not bypass live owner authorization.');
  }
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2', [settingsWorkspace, memberId]);
  await expectStatus(saveRetention(settingsWorkspace, memberId, { previewToken: memberPreview.previewToken }), 404, 'A valid preview cannot preserve removed membership.');
  for (const invalid of [null, {}, { revision: 1, settings: { ...defaults, rawAnalyticsDays: 0 } },
    { revision: 1, settings: { ...defaults, replayDays: 3651 } }, { revision: 1, settings: { ...defaults, derivedHistoryDays: 1.5 } },
    { revision: 1, settings: { ...defaults, rawProviderEvidenceDays: '90' } }, { revision: 1, settings: { ...defaults, unknown: true } }]) {
    await expectStatus(previewRetention(settingsWorkspace, ownerId, invalid), 400, 'Invalid policy input must fail closed.');
  }
  await expectStatus(saveRetention(settingsWorkspace, ownerId, { previewToken: 'invalid' }), 400, 'An unsigned confirmation must not save.');
  await expectStatus(saveRetention(settingsWorkspace, ownerId, { previewToken: preview.previewToken, settings: defaults }), 400, 'Confirmation cannot replace the previewed policy.');
  const saved = await saveRetention(settingsWorkspace, ownerId, { previewToken: preview.previewToken });
  assert.equal(saved.revision, 2); assert.deepEqual(saved.settings, candidate);
  await expectStatus(saveRetention(settingsWorkspace, ownerId, { previewToken: preview.previewToken }), 409, 'Replaying a saved preview must be stale.');
  await expectStatus(previewRetention(settingsWorkspace, ownerId, { revision: 1, settings: defaults }), 409, 'A stale editor must obtain the current policy.');

  // Change role while the save is genuinely waiting, so an authorization check
  // performed before obtaining the lock cannot accidentally satisfy this test.
  const demotionWorkspace = await workspace();
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [demotionWorkspace, memberId]);
  const demotionPreview = await previewRetention(demotionWorkspace, ownerId, { revision: 1, settings: candidate });
  const blocker = await pool.connect();
  let delayedSave: Promise<unknown> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [demotionWorkspace]);
    delayedSave = expectStatus(saveRetention(demotionWorkspace, ownerId, { previewToken: demotionPreview.previewToken }), 403, 'A waiting save must observe owner demotion.');
    void delayedSave.catch(() => {});
    await waitBlocked(blocker);
    await blocker.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", [demotionWorkspace, ownerId]);
    await blocker.query('COMMIT');
    await delayedSave;
    assert.equal((await getRetention(demotionWorkspace, memberId)).revision, 1, 'Denied saves must leave the policy unchanged.');
  } finally { await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); await delayedSave?.catch(() => {}); }
  console.log('PASS retention defaults, exact preview cutoff, strict inputs, member/owner isolation, stale confirmation and locked demotion');

  const batchWorkspace = await workspace(), target = await project(batchWorkspace), foreign = await project(foreignWorkspace);
  const cutoff = '2024-04-01T00:00:00.000Z', deadVisitor = 'a'.repeat(64), liveVisitor = 'b'.repeat(64), orphanVisitor = 'c'.repeat(64), visit = 'd'.repeat(64);
  await activate(target.id, cutoff);
  await pool.query(`INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES
    ($1,$2,'2024-03-01','2024-03-31'),($1,$3,'2024-03-01','2024-04-02'),($1,$4,'2024-03-01','2024-03-01')`, [target.id, deadVisitor, liveVisitor, orphanVisitor]);
  await pool.query(`INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id)
    SELECT gen_random_uuid(),$1,'page_view','/expired',$2::timestamptz-interval '2 days',CASE WHEN n<=1001 THEN $3 ELSE $4 END,$5
    FROM generate_series(1,2102) n`, [target.id, cutoff, deadVisitor, liveVisitor, visit]);
  await pool.query(`INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id) VALUES
    (gen_random_uuid(),$1,'signup','/before',$2::timestamptz-interval '1 microsecond',$3,$4),
    (gen_random_uuid(),$1,'page_view','/exact',$2,$3,$4),
    (gen_random_uuid(),$1,'purchase','/after',$2::timestamptz+interval '1 microsecond',$3,$4)`, [target.id, cutoff, liveVisitor, visit]);
  await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at) VALUES(gen_random_uuid(),$1,'page_view','/foreign','2000-01-01')", [foreign.id]);

  // Retention must never treat accounting, report snapshots or authorization
  // material as raw analytics merely because these rows have old timestamps.
  const providerId = randomUUID(), ledgerId = randomUUID(), reportId = randomUUID(), shareId = randomUUID(), sessionId = randomUUID(), accountId = randomUUID(), oidcId = randomUUID(), trackingId = randomUUID();
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name,encrypted_credentials,created_at) VALUES($1,$2,'openrouter','Synthetic retained connection',$3,'2000-01-01')", [providerId, batchWorkspace,
    encryptCredentials({ apiKey: 'synthetic-never-sent-to-a-provider' }, { workspaceId: batchWorkspace, id: providerId, provider: 'openrouter', revision: 1 })]);
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month,created_at)
    VALUES($1,$2,$3,1,$4,$5,'fixture.retention',$6,10,5,'settled','2000-01-01','2000-01-01')`, [ledgerId, batchWorkspace, providerId, ownerId, randomUUID(), 'e'.repeat(64)]);
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month,created_at)
    SELECT gen_random_uuid(),$1,$2,1,$3,gen_random_uuid(),'fixture.retention',$4,10,status,'2000-01-01','2000-01-01'
    FROM unnest(ARRAY['reserved','dispatched','uncertain','cancelled']) status`, [batchWorkspace, providerId, ownerId, 'e'.repeat(64)]);
  await pool.query("INSERT INTO workspace_budget(workspace_id,monthly_limit_micros) VALUES($1,100)", [batchWorkspace]);
  await pool.query("INSERT INTO report(id,project_id,title,source_html,created_at) VALUES($1,$2,'Retained report','<p>Retained source</p>','2000-01-01')", [reportId, target.id]);
  await pool.query("INSERT INTO report_share(id,report_id,token_hash,slug_label,label,snapshot_html,report_revision,expires_at,created_at) VALUES($1,$2,$3,'retained','Retained snapshot','<p>Retained snapshot</p>',1,'2099-01-01','2000-01-01')", [shareId, reportId, createHash('sha256').update(randomUUID()).digest('hex')]);
  await pool.query('INSERT INTO session(id,token,"userId","expiresAt","createdAt") VALUES($1,$2,$3,\'2099-01-01\',\'2000-01-01\')', [sessionId, randomUUID(), memberId]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId","createdAt") VALUES($1,$2,\'retention-fixture\',$3,\'2000-01-01\')', [accountId, randomUUID(), memberId]);
  await pool.query("INSERT INTO oidc_provider(id,draft,credential,created_at) VALUES($1,$2,$3,'2000-01-01')", [oidcId,
    { name: 'Retained synthetic identity configuration', issuer: 'https://identity.retention.integration.test', clientId: 'synthetic', authentication: 'basic', allowedOrigins: [], allowedAddresses: [], trustVerifiedEmail: false },
    encryptCredentials({ clientSecret: 'synthetic-never-sent-to-an-identity-provider' }, { workspaceId: 'instance', id: oidcId, provider: 'oidc-provider', revision: 1 })]);
  await pool.query("INSERT INTO tracking_revision(id,project_id,environment,number,consent_epoch,configuration,created_by,created_at) VALUES($1,$2,'live',1,$3,'{\"destinations\":[]}',$4,'2000-01-01')", [trackingId, target.id, randomUUID(), ownerId]);
  await pool.query("INSERT INTO tracking_state(project_id,environment,active_revision) VALUES($1,'live',$2)", [target.id, trackingId]);
  const protectedQueries: [string, unknown[]][] = [
    ['SELECT row_to_json(t) AS data FROM provider_connection t WHERE id=$1', [providerId]],
    ['SELECT row_to_json(t) AS data FROM provider_request t WHERE workspace_id=$1 ORDER BY id', [batchWorkspace]],
    ['SELECT row_to_json(t) AS data FROM workspace_budget t WHERE workspace_id=$1', [batchWorkspace]],
    ['SELECT row_to_json(t) AS data FROM report t WHERE id=$1', [reportId]],
    ['SELECT row_to_json(t) AS data FROM report_share t WHERE id=$1', [shareId]],
    ['SELECT row_to_json(t) AS data FROM session t WHERE id=$1', [sessionId]],
    ['SELECT row_to_json(t) AS data FROM account t WHERE id=$1', [accountId]],
    ['SELECT row_to_json(t) AS data FROM oidc_provider t WHERE id=$1', [oidcId]],
    ['SELECT row_to_json(t) AS data FROM tracking_revision t WHERE id=$1', [trackingId]],
    ['SELECT row_to_json(t) AS data FROM tracking_state t WHERE project_id=$1', [target.id]],
    ['SELECT row_to_json(t) AS data FROM event t WHERE project_id=$1', [foreign.id]],
    ['SELECT analytics_settings,analytics_epoch,analytics_revision FROM project WHERE id=$1', [target.id]],
  ];
  const snapshot = async () => Promise.all(protectedQueries.map(async ([sql, values]) => (await pool.query(sql, values)).rows));
  const protectedBefore = await snapshot();
  const first = await runRetentionBatch(target.id);
  assert.ok(first); assert.equal(first.projectId, target.id); assert.equal(first.deletedEvents, 1000); assert.equal(first.complete, false);
  assert.equal(await events(target.id), 1105);
  const persisted = await progress(target.id);
  assert.equal(new Date(persisted.retention_cutoff).toISOString(), cutoff, 'A partial batch must persist the cutoff needed to resume.');
  await pause(target.id);
  // A separate Node process has no module state from the first batch. Only the
  // persisted cursor/policy may govern this resumed execution.
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {runRetentionBatch} from './src/server/retention.ts';
    import {closeDatabase} from './src/server/db.ts';
    try { console.log(JSON.stringify(await runRetentionBatch(process.argv[1]))); }
    catch { console.error('Retention restart failed; diagnostic details redacted.'); process.exitCode=1; }
    finally { await closeDatabase(); }
  `, target.id], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 15_000, maxBuffer: 16_384 });
  assert.equal(restarted.status, 0, 'The resumed worker must succeed in a new process.');
  const second = JSON.parse(restarted.stdout.trim());
  assert.equal(second.projectId, target.id); assert.equal(second.deletedEvents, 1000); assert.equal(second.complete, false);
  await pause(target.id);
  const third = await runRetentionBatch(target.id);
  assert.ok(third); assert.equal(third.deletedEvents, 103); assert.equal(third.complete, true);
  await pause(target.id);
  assert.deepEqual((await pool.query('SELECT path FROM event WHERE project_id=$1 ORDER BY path', [target.id])).rows, [{ path: '/after' }, { path: '/exact' }], 'Only timestamps strictly before the cutoff may be deleted.');
  const retainedVisitors = await pool.query(`SELECT id,to_char(first_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS first,
    to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS last FROM analytics_visitor WHERE project_id=$1`, [target.id]);
  assert.deepEqual(retainedVisitors.rows, [{ id: liveVisitor, first: '2024-04-01 00:00:00.000000', last: '2024-04-01 00:00:00.000001' }], 'Expired/orphan visitors disappear and surviving bounds derive from surviving events.');
  const completed = await progress(target.id);
  assert.equal(new Date(completed.analytics_retained_from).toISOString(), cutoff);
  assert.ok(completed.retention_last_completed_at); assert.equal(completed.retention_error, null);
  assert.deepEqual(await snapshot(), protectedBefore, 'Retention must preserve unrelated workspace and protected records byte for byte.');
  console.log('PASS retention bounded batches, real process restart, microsecond cutoff, visitor foreign keys/bounds and protected records');

  const extensionWorkspace = await workspace(), extension = await project(extensionWorkspace);
  const oldCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await pool.query('UPDATE workspace SET raw_analytics_days=30 WHERE id=$1', [extensionWorkspace]);
  await activate(extension.id, oldCutoff);
  await pool.query(`INSERT INTO event(id,project_id,event_name,path,received_at) SELECT gen_random_uuid(),$1,'page_view','/previous-target',now()-interval '60 days' FROM generate_series(1,1001)`, [extension.id]);
  const partial = await runRetentionBatch(extension.id);
  assert.ok(partial); assert.equal(partial.deletedEvents, 1000); assert.equal(partial.complete, false);
  await pause(extension.id);
  const beforeExtension = await progress(extension.id);
  const extensionPreview = await previewRetention(extensionWorkspace, ownerId, { revision: 1, settings: defaults });
  await saveRetention(extensionWorkspace, ownerId, { previewToken: extensionPreview.previewToken });
  await pause(extension.id);
  const extended = await runRetentionBatch(extension.id);
  assert.ok(extended); assert.equal(extended.deletedEvents, 0, 'Extending to 90 days must stop the stale 30-day deletion target.');
  assert.equal(await events(extension.id), 1, 'Deleted history stays deleted, but remaining newly protected history survives.');
  const afterExtension = await progress(extension.id);
  if (beforeExtension.analytics_retained_from) assert.ok(new Date(afterExtension.analytics_retained_from).getTime() >= new Date(beforeExtension.analytics_retained_from).getTime(), 'The retained-history boundary must never move backwards.');
  await pause(extension.id);

  const estimateWorkspace = await workspace(), estimateProject = await project(estimateWorkspace);
  await pool.query(`INSERT INTO event(id,project_id,event_name,path,received_at,properties) SELECT gen_random_uuid(),$1,'page_view','/estimate','2000-01-01','{"fixture":"logical bytes"}' FROM generate_series(1,10001)`, [estimateProject.id]);
  const capped = await previewRetention(estimateWorkspace, ownerId, { revision: 1, settings: defaults });
  assert.equal(capped.estimate.status, 'available'); assert.equal(capped.estimate.rows, 10000); assert.equal(capped.estimate.atLeast, true);
  assert.ok(capped.estimate.logicalBytes !== null && capped.estimate.logicalBytes > 0, 'Logical bytes must come from actual sampled rows.');
  const estimateLock = await pool.connect();
  try {
    await estimateLock.query('BEGIN'); await estimateLock.query('LOCK TABLE event IN ACCESS EXCLUSIVE MODE');
    const unavailable = await previewRetention(estimateWorkspace, ownerId, { revision: 1, settings: defaults });
    assert.deepEqual(unavailable.estimate, { status: 'unavailable', rows: null, atLeast: false, logicalBytes: null }, 'A timed-out estimate must remain unknown rather than claiming zero data.');
    assert.ok(unavailable.previewToken, 'An unavailable estimate must not abort the authenticated preview transaction.');
  } finally { await estimateLock.query('ROLLBACK'); estimateLock.release(); }
  console.log('PASS retention extension cancels stale deletion target and preview estimates are capped or explicitly unavailable');

  const rollbackWorkspace = await workspace(), rollback = await project(rollbackWorkspace), rollbackVisitor = 'f'.repeat(64);
  await activate(rollback.id, cutoff);
  await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,'2000-01-01','2000-01-01')", [rollback.id, rollbackVisitor]);
  await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id) VALUES(gen_random_uuid(),$1,'page_view','/rollback','2000-01-01',$2,$3)", [rollback.id, rollbackVisitor, visit]);
  const beforeFailure = await progress(rollback.id), triggerName = `retention_fixture_${randomUUID().replaceAll('-', '')}`;
  // Deliberately fail visitor cleanup after the real event DELETE. The function
  // and trigger are unique, scoped to this project and always removed.
  await pool.query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.project_id='${rollback.id}' THEN RAISE EXCEPTION 'synthetic retention rollback'; END IF; RETURN OLD; END $$`);
  try {
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE DELETE ON analytics_visitor FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`);
    await assert.rejects(runRetentionBatch(rollback.id), 'A failed cleanup must fail the batch.');
    assert.equal(await events(rollback.id), 1, 'An error after event deletion must roll the deletion back.');
    assert.equal((await pool.query('SELECT 1 FROM analytics_visitor WHERE project_id=$1', [rollback.id])).rowCount, 1);
    const failed = await progress(rollback.id);
    assert.deepEqual(failed.analytics_retained_from, beforeFailure.analytics_retained_from);
    assert.deepEqual(failed.retention_last_completed_at, beforeFailure.retention_last_completed_at);
    assert.ok(failed.retention_error && !failed.retention_error.includes('synthetic retention rollback'), 'Persist only a redacted operational error.');
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON analytics_visitor`);
    await pool.query(`DROP FUNCTION ${triggerName}()`);
  }
  const retry = await runRetentionBatch(rollback.id);
  assert.ok(retry); assert.equal(retry.deletedEvents, 1); assert.equal(retry.complete, true);
  assert.equal((await progress(rollback.id)).retention_error, null, 'A successful retry clears the previous failure.');
  await pause(rollback.id);

  const collectorWorkspace = await workspace(), collector = await project(collectorWorkspace), userAgent = 'Retention acceptance browser';
  await activate(collector.id, cutoff);
  const networkMode = process.env.ANALYTICS_NETWORK_MODE;
  process.env.ANALYTICS_NETWORK_MODE = 'direct';
  try {
    const identity = analyticsIdentity({ projectId: collector.id, ip: '127.0.0.1', userAgent });
    assert.ok(identity);
    await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,'2000-01-01','2000-01-01')", [collector.id, identity.visitor]);
    await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id) VALUES(gen_random_uuid(),$1,'page_view','/old-identity','2000-01-01',$2,$3)", [collector.id, identity.visitor, identity.visit]);
    const epoch = (await pool.query('SELECT analytics_epoch FROM project WHERE id=$1', [collector.id])).rows[0].analytics_epoch;
    const observations = Array.from({ length: 4 }, () => ({ eventId: randomUUID(), name: 'page_view', url: collector.origin + '/current', consent: { analytics: true as const, epoch: trackingConsentEpoch(epoch, null) } }));
    const racing = await Promise.all([runRetentionBatch(collector.id), ...observations.map(input => collectNative(new Request(collector.origin, { headers: { origin: collector.origin, 'user-agent': userAgent } }), collector.siteKey, input, '127.0.0.1'))]);
    for (const result of racing.slice(1)) assert.ok(result && 'accepted' in result && result.accepted, 'Concurrent collectors must still commit.');
    assert.equal(await events(collector.id), observations.length);
    const integrity = await pool.query(`SELECT v.first_seen_at=min(e.received_at) AND v.last_seen_at=max(e.received_at) AS valid FROM analytics_visitor v
      JOIN event e ON e.project_id=v.project_id AND e.visitor_id=v.id WHERE v.project_id=$1 GROUP BY v.id,v.first_seen_at,v.last_seen_at`, [collector.id]);
    assert.deepEqual(integrity.rows, [{ valid: true }], 'Concurrent collection and cleanup must preserve the visitor FK and final timestamp bounds.');
  } finally {
    if (networkMode === undefined) delete process.env.ANALYTICS_NETWORK_MODE; else process.env.ANALYTICS_NETWORK_MODE = networkMode;
    await pause(collector.id);
  }
  const workspaceLock = await pool.connect();
  try {
    await workspaceLock.query('BEGIN'); await workspaceLock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [collectorWorkspace]);
    assert.equal(await runRetentionBatch(collector.id), null, 'A locked workspace must be skipped so a second worker does not interfere.');
  } finally { await workspaceLock.query('ROLLBACK'); workspaceLock.release(); }
  console.log('PASS retention transactional rollback/retry, concurrent native collection and locked-workspace exclusion');
}
