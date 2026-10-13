import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { getConfig } from '../src/server/config.ts';
import { closeDatabase, getDatabase } from '../src/server/db.ts';
import { expireSiteAuditData, previewSiteAuditRetention } from '../src/server/site-audit-retention.ts';
import { deleteSiteAudit, getSiteAudit, getSiteAuditPage, listSiteAuditIssues, listSiteAuditLinks, listSiteAuditPages, listSiteAudits, startSiteAudit } from '../src/server/site-audits.ts';
import { getRetention, previewRetention, runRetentionBatch, saveRetention } from '../src/server/retention.ts';

export async function runSiteAuditRetentionChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  for (const value of [getConfig().appUrl, getConfig().databaseUrl]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname));
  const { pool } = getDatabase(), owner = randomUUID();
  const cutoff = new Date('2026-01-01T00:00:00.000Z'), beforeAll = new Date('2000-01-01T00:00:00.000Z');
  const cutoffPair = { rawCutoff: cutoff, derivedCutoff: beforeAll };
  const startIntent = { version: 1, mode: 'static', domainId: null, startPath: '/', maxPages: 50 };
  const hash = createHash('sha256').update(JSON.stringify(startIntent)).digest('hex');
  const config = { mode: 'static', startPath: '/', startUrl: 'https://example.com/', maxPages: 50, requestLimit: 250,
    bodyCapacityBytes: 524288000, frontierLimit: 10000, edgeLimit: 100000, sitemapDocuments: 20, sitemapDepth: 3,
    minIntervalMs: 1000, maxAttempts: 2, userAgent: 'TenMonitorBot/1.0', robotsProductToken: 'TenMonitorBot' };
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [owner, 'Audit retention fixture', `${owner}@integration.test`]);
  async function project() {
    const workspaceId = randomUUID(), id = randomUUID();
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Audit retention fixture')", [workspaceId]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, owner]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Audit retention fixture','https://example.com',$3,'infinity')", [id, workspaceId, randomUUID()]);
    return { id, workspaceId };
  }
  type Project = Awaited<ReturnType<typeof project>>;
  async function receipt(p: Project, options: { status?: string; at?: Date; microseconds?: number } = {}) {
    const id = randomUUID(), requestId = randomUUID(), status = options.status ?? 'completed';
    const active = ['queued', 'running', 'cancelling'].includes(status), leased = ['running', 'cancelling'].includes(status);
    await pool.query(`INSERT INTO site_audit_run(id,workspace_id,project_id,user_id,request_id,request_hash,origin,config,
      status,phase,created_at,deadline_at,completed_at,queue_job_id,lease_owner,lease_expires_at,
      robots_state,robots_body,robots_digest,coverage,summary)
      VALUES($1,$2,$3,$4,$5,$6,'https://example.com',$7,$8,$9,$10::timestamptz-interval '1 minute',
        $10::timestamptz+interval '29 minutes',CASE WHEN $11 THEN NULL ELSE $10::timestamptz+$12*interval '1 microsecond' END,
        $13,$14,CASE WHEN $14::uuid IS NULL THEN NULL ELSE clock_timestamp()+interval '1 minute' END,
        'present',$15,$16,'{"reasons":[],"discoveryComplete":true,"linksComplete":true,"scopeExclusions":0,"rawEvidenceRecorded":true}',
        '{"findingsComplete":true,"findings":2}')`,
      [id, p.workspaceId, p.id, owner, requestId, hash, JSON.stringify(config), status, leased ? 'pages' : null,
        options.at ?? cutoff, active, options.microseconds ?? -1, randomUUID(), leased ? randomUUID() : null, Buffer.from('User-agent: *\nAllow: /'), 'a'.repeat(64)]);
    return { id, requestId, project: p };
  }
  type Receipt = Awaited<ReturnType<typeof receipt>>;
  async function pages(run: Receipt, count = 1, record = true) {
    return (await pool.query<{ id: string }>(`INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url,state,fetch_state,
      analysis_coverage,facts,evidence,evidence_recorded,evidence_truncated)
      SELECT gen_random_uuid(),$1,$2,'html','https://example.com/page-'||n,'done','ok','analyzed','{"wordCount":42}',
        CASE WHEN $4 THEN '{"title":"Synthetic observed title"}'::jsonb ELSE NULL END,$4,$4 FROM generate_series(1,$3::int) n RETURNING id`,
      [run.id, run.project.id, count, record])).rows.map(row => row.id);
  }
  async function graph(run: Receipt, sourceId: string, targetId: string, count: number) {
    await pool.query(`INSERT INTO site_audit_edge(id,run_id,source_page_id,kind,target_url,anchor)
      SELECT gen_random_uuid(),$1,$2,'link','https://example.com/target-'||n,'Synthetic anchor' FROM generate_series(1,$3::int) n`, [run.id, sourceId, count]);
    await pool.query(`INSERT INTO site_audit_issue(id,run_id,page_id,target_page_id,issue_key,rule_version,code,severity,details)
      SELECT gen_random_uuid(),$1,$2,$3,lpad(to_hex(n),64,'0'),'static-graph-v1','broken-internal-link','warning','{}'
      FROM generate_series(1,$4::int) n`, [run.id, sourceId, targetId, count]);
  }
  async function lock(client: PoolClient, p: Project) {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='2s'");
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [p.workspaceId]);
    await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE', [p.id]);
  }
  async function expire(p: Project, cutoffs = cutoffPair) {
    const client = await pool.connect();
    try { await lock(client, p); const result = await expireSiteAuditData(client, p.id, cutoffs); await client.query('COMMIT'); return result; }
    finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  }
  async function preview(p: Project, cutoffs = cutoffPair) {
    const client = await pool.connect();
    try { return await previewSiteAuditRetention(client, p.workspaceId, cutoffs); } finally { client.release(); }
  }
  async function row(run: Receipt) { return (await pool.query('SELECT * FROM site_audit_run WHERE id=$1', [run.id])).rows[0]; }
  async function counts(run: Receipt) {
    return (await pool.query(`SELECT (SELECT count(*)::int FROM site_audit_page WHERE run_id=$1) AS pages,
      (SELECT count(*)::int FROM site_audit_edge WHERE run_id=$1) AS edges,
      (SELECT count(*)::int FROM site_audit_issue WHERE run_id=$1) AS issues,
      (SELECT count(*)::int FROM site_audit_page WHERE run_id=$1 AND evidence IS NOT NULL) AS evidence,
      (SELECT count(*)::int FROM site_audit_edge WHERE run_id=$1 AND anchor IS NOT NULL) AS anchors`, [run.id])).rows[0];
  }
  const isStatus = (status: number) => (error: unknown) => (error as { status?: number }).status === status;

  const boundary = await project(), foreign = await project();
  const old = await receipt(boundary), exact = await receipt(boundary, { microseconds: 0 }), newer = await receipt(boundary, { microseconds: 1 }), other = await receipt(foreign);
  for (const r of [old, exact, newer, other]) await pages(r);
  const terminal = [old];
  for (const status of ['partial', 'failed', 'cancelled']) { const r = await receipt(boundary, { status }); await pages(r); terminal.push(r); }
  const queued = await receipt(boundary, { status: 'queued' }); await pages(queued);
  for (let n = 0; n < 4; n++) assert.equal((await expire(boundary)).pending, n < 3);
  for (const r of terminal) {
    const saved = await row(r); assert.ok(saved.raw_expired_at); assert.ok(saved.raw_cleanup_completed_at); assert.equal(saved.data_expired_at, null);
    assert.equal((await counts(r)).evidence, 0); assert.equal((await getSiteAuditPage(boundary.id, owner, r.id, (await pool.query('SELECT id FROM site_audit_page WHERE run_id=$1', [r.id])).rows[0].id)).page.analysis.facts?.wordCount, 42);
  }
  for (const r of [exact, newer, other, queued]) { assert.equal((await row(r)).raw_expired_at, null); assert.equal((await counts(r)).evidence, 1); }
  for (const status of ['running', 'cancelling']) {
    const p = await project(), active = await receipt(p, { status }); await pages(active);
    assert.equal((await expire(p, { rawCutoff: cutoff, derivedCutoff: cutoff })).pending, false);
    assert.equal((await row(active)).data_expired_at, null);
    await pool.query("UPDATE site_audit_run SET status='cancelled',phase=NULL,lease_owner=NULL,lease_expires_at=NULL,completed_at=clock_timestamp() WHERE id=$1", [active.id]);
  }
  console.log('PASS audit strict microsecond cutoffs, terminal outcomes, active leases and workspace isolation');

  const rawProject = await project(), rawRun = await receipt(rawProject), rawPages = await pages(rawRun, 1001);
  await graph(rawRun, rawPages[0], rawPages[1], 1001);
  assert.deepEqual(await preview(rawProject), { status: 'available', rawRuns: 1, rawPages: 1001, rawEdges: 1001, derivedRuns: 0, derivedPages: 0, atLeast: false });
  const rawFirst = await expire(rawProject);
  assert.equal(rawFirst.clearedAuditEvidence, 2001); assert.equal(rawFirst.expiredAuditRuns, 0); assert.equal(rawFirst.pending, true);
  assert.deepEqual(await counts(rawRun), { pages: 1001, edges: 1001, issues: 1001, evidence: 1, anchors: 1 });
  const remaining = (await pool.query('SELECT id FROM site_audit_page WHERE run_id=$1 AND evidence IS NOT NULL', [rawRun.id])).rows[0].id;
  const hidden = await getSiteAuditPage(rawProject.id, owner, rawRun.id, remaining);
  assert.equal(hidden.run.rawEvidenceStatus, 'expired'); assert.equal(hidden.run.dataStatus, 'available'); assert.equal(hidden.page.evidence, null); assert.equal(hidden.page.rawEvidenceStatus, 'expired');
  assert.equal(hidden.page.analysis.facts?.wordCount, 42);
  const hiddenLinks = await listSiteAuditLinks(rawProject.id, owner, rawRun.id, rawPages[0], new URLSearchParams());
  assert.ok(hiddenLinks.links.length); assert.ok(hiddenLinks.links.every(link => link.anchor === null && link.anchorStatus === 'expired'));
  assert.equal((await expire(rawProject)).clearedAuditEvidence, 2); assert.equal((await expire(rawProject)).pending, false);
  assert.equal((await row(rawRun)).coverage.rawEvidenceRecorded, true);
  assert.equal((await pool.query('SELECT bool_and(evidence_recorded AND evidence_truncated) AS retained FROM site_audit_page WHERE run_id=$1', [rawRun.id])).rows[0].retained, true);
  console.log('PASS audit bounded raw batches hide residual payloads and retain facts, graph, flags and outcome');

  const estimateProject = await project(), estimateRun = await receipt(estimateProject), estimatePages = await pages(estimateRun, 2);
  await graph(estimateRun, estimatePages[0], estimatePages[1], 10001);
  // Existing dense history followed by a previously unseen run reproduces stale
  // selectivity estimates. Each cleanup still has the production two-second cap.
  await pool.query('ANALYZE site_audit_page');
  await pool.query('ANALYZE site_audit_edge');
  await pool.query('ANALYZE site_audit_issue');
  const derivedProject = await project(), derivedRun = await receipt(derivedProject), derivedPages = await pages(derivedRun, 1002);
  await graph(derivedRun, derivedPages[0], derivedPages[1], 1001);
  assert.deepEqual(await preview(derivedProject, { rawCutoff: beforeAll, derivedCutoff: cutoff }),
    { status: 'available', rawRuns: 1, rawPages: 1002, rawEdges: 1001, derivedRuns: 1, derivedPages: 1002, atLeast: false });
  const derivedFirst = await expire(derivedProject, { rawCutoff: beforeAll, derivedCutoff: cutoff });
  assert.deepEqual({ pages: derivedFirst.removedAuditPages, edges: derivedFirst.removedAuditEdges, issues: derivedFirst.removedAuditIssues }, { pages: 1000, edges: 1000, issues: 1000 });
  assert.equal(derivedFirst.expiredAuditRuns, 1); assert.equal(derivedFirst.pending, true);
  assert.deepEqual(await counts(derivedRun), { pages: 2, edges: 1, issues: 1, evidence: 2, anchors: 1 });
  assert.equal((await row(derivedRun)).raw_cleanup_completed_at, null);
  assert.equal((await listSiteAuditPages(derivedProject.id, owner, derivedRun.id, new URLSearchParams())).pages.length, 0);
  const expiredIssues = await listSiteAuditIssues(derivedProject.id, owner, derivedRun.id, new URLSearchParams());
  assert.equal(expiredIssues.run.dataStatus, 'expired'); assert.equal(expiredIssues.matchingRetainedCount, null); assert.deepEqual(expiredIssues.issues, []);
  await assert.rejects(getSiteAuditPage(derivedProject.id, owner, derivedRun.id, derivedPages[0]), isStatus(410));
  assert.equal((await expire(derivedProject, { rawCutoff: beforeAll, derivedCutoff: beforeAll })).pending, false);
  assert.equal((await counts(derivedRun)).pages, 2, 'Derived policy extension also stops physical cleanup despite old markers.');
  assert.equal((await getSiteAudit(derivedProject.id, owner, derivedRun.id)).run.dataStatus, 'expired');
  const derivedLast = await expire(derivedProject, { rawCutoff: beforeAll, derivedCutoff: cutoff });
  assert.equal(derivedLast.removedAuditPages, 2); assert.equal(derivedLast.expiredAuditRuns, 0); assert.equal(derivedLast.pending, false);
  assert.ok((await row(derivedRun)).raw_cleanup_completed_at); assert.ok((await row(derivedRun)).data_cleanup_completed_at);
  assert.deepEqual((await row(derivedRun)).summary, { findings: 2, findingsComplete: true });
  await expire(rawProject, { rawCutoff: cutoff, derivedCutoff: cutoff });
  assert.equal((await getSiteAudit(rawProject.id, owner, rawRun.id)).run.dataStatus, 'expired');
  console.log('PASS audit derived-before-raw and raw-before-derived expiry, bounded descendant deletion and truthful receipts');

  const extensionProject = await project(), extensionRun = await receipt(extensionProject, { at: new Date(Date.now() - 100 * 86400000) });
  await pages(extensionRun, 1001);
  assert.equal((await runRetentionBatch(extensionProject.id))?.complete, false);
  assert.equal((await counts(extensionRun)).evidence, 1);
  const current = await getRetention(extensionProject.workspaceId, owner);
  const proposal = await previewRetention(extensionProject.workspaceId, owner, { revision: current.revision,
    settings: { ...current.settings, rawProviderEvidenceDays: 3650, derivedHistoryDays: 3650 } });
  assert.deepEqual(proposal.auditEstimate, { status: 'available', rawRuns: 0, rawPages: 0, rawEdges: 0, derivedRuns: 0, derivedPages: 0, atLeast: false });
  const gate = await pool.connect();
  try {
    await lock(gate, extensionProject);
    let resolved = false;
    const save = saveRetention(extensionProject.workspaceId, owner, { previewToken: proposal.previewToken }).then(value => { resolved = true; return value; });
    await delay(35); assert.equal(resolved, false);
    assert.equal(await runRetentionBatch(extensionProject.id), null, 'A pending policy owner gates cleanup.');
    await gate.query('COMMIT'); await save;
  } finally { await gate.query('ROLLBACK').catch(() => {}); gate.release(); }
  assert.equal((await runRetentionBatch(extensionProject.id))?.complete, true);
  assert.equal((await counts(extensionRun)).evidence, 1, 'Old markers must not override a newly extended cutoff.');
  assert.equal((await getSiteAudit(extensionProject.id, owner, extensionRun.id)).run.rawEvidenceStatus, 'expired');
  await assert.rejects(saveRetention(extensionProject.workspaceId, owner, { previewToken: proposal.previewToken }), isStatus(409));
  const shortened = await getRetention(extensionProject.workspaceId, owner);
  const shortPreview = await previewRetention(extensionProject.workspaceId, owner, { revision: shortened.revision, settings: { ...shortened.settings, rawProviderEvidenceDays: 1 } });
  assert.equal(shortPreview.auditEstimate.rawPages, 1);
  await saveRetention(extensionProject.workspaceId, owner, { previewToken: shortPreview.previewToken });
  assert.equal((await runRetentionBatch(extensionProject.id))?.complete, true); assert.equal((await counts(extensionRun)).evidence, 0);
  console.log('PASS audit fresh policy extension, gated save, stale preview and later eligible resumption');

  const rollbackProject = await project(), rollbackRun = await receipt(rollbackProject), rollbackPage = (await pages(rollbackRun))[0], neverRecorded = randomUUID();
  await pool.query("INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url) VALUES($1,$2,$3,'html','https://example.com/unfetched')", [neverRecorded, rollbackRun.id, rollbackProject.id]);
  const transaction = await pool.connect();
  try {
    await lock(transaction, rollbackProject); await expireSiteAuditData(transaction, rollbackProject.id, cutoffPair);
    let readResolved = false;
    const reading = getSiteAuditPage(rollbackProject.id, owner, rollbackRun.id, rollbackPage).then(value => { readResolved = true; return value; });
    await delay(35); assert.equal(readResolved, false);
    await transaction.query('ROLLBACK'); assert.notEqual((await reading).page.evidence, null);
    await lock(transaction, rollbackProject); await expireSiteAuditData(transaction, rollbackProject.id, cutoffPair);
    const committed = getSiteAuditPage(rollbackProject.id, owner, rollbackRun.id, rollbackPage);
    await transaction.query('COMMIT'); assert.equal((await committed).page.evidence, null);
  } finally { await transaction.query('ROLLBACK').catch(() => {}); transaction.release(); }
  assert.equal((await getSiteAuditPage(rollbackProject.id, owner, rollbackRun.id, neverRecorded)).page.rawEvidenceStatus, 'not_recorded');
  await assert.rejects(getSiteAuditPage(foreign.id, owner, rollbackRun.id, rollbackPage), isStatus(404));
  console.log('PASS audit shared read gates and marker/payload atomic commit or rollback');

  const deletionProject = await project(), deletionRun = await receipt(deletionProject, { at: new Date() }), deletionPages = await pages(deletionRun, 2);
  await graph(deletionRun, deletionPages[0], deletionPages[1], 1001);
  const preservedKeys = ['id', 'workspace_id', 'project_id', 'user_id', 'request_id', 'request_hash', 'domain_id', 'status', 'created_at', 'completed_at'];
  const receiptBefore = await row(deletionRun);
  assert.deepEqual(await deleteSiteAudit(deletionProject.id, owner, deletionRun.id, {}), { deleted: true, id: deletionRun.id });
  await assert.rejects(startSiteAudit(deletionProject.id, owner, { requestId: deletionRun.requestId, domainId: null, startPath: '/', mode: 'static' }), isStatus(410));
  assert.equal((await expire(deletionProject, { rawCutoff: beforeAll, derivedCutoff: beforeAll })).pending, true);
  assert.equal((await expire(deletionProject, { rawCutoff: beforeAll, derivedCutoff: beforeAll })).pending, false);
  const receiptAfter = await row(deletionRun);
  for (const key of preservedKeys) assert.deepEqual(receiptAfter[key], receiptBefore[key]);
  for (const key of ['config', 'origin', 'domain_hostname', 'domain_verified_at', 'domain_revision', 'summary']) assert.equal(receiptAfter[key], null);
  assert.deepEqual(await deleteSiteAudit(deletionProject.id, owner, deletionRun.id, {}), { deleted: true, id: deletionRun.id });
  assert.deepEqual((await listSiteAudits(deletionProject.id, owner, new URLSearchParams())).runs, []);
  await assert.rejects(startSiteAudit(deletionProject.id, owner, { requestId: deletionRun.requestId, domainId: null, startPath: '/', mode: 'static' }), isStatus(410));
  await assert.rejects(getSiteAudit(foreign.id, owner, deletionRun.id), isStatus(404));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM site_audit_run WHERE project_id=$1', [deletionProject.id])).rows[0].n, 1);
  console.log('PASS audit explicit deletion bypasses cutoffs but retains non-resurrectable, tenant-scoped replay tombstones');

  assert.deepEqual(await preview(estimateProject), { status: 'available', rawRuns: 1, rawPages: 2, rawEdges: 10000, derivedRuns: 0, derivedPages: 0, atLeast: true });
  const estimatePolicy = await getRetention(estimateProject.workspaceId, owner);
  const tableGate = await pool.connect();
  try {
    await tableGate.query('BEGIN'); await tableGate.query('LOCK TABLE site_audit_edge IN ACCESS EXCLUSIVE MODE');
    const unavailable = await previewRetention(estimateProject.workspaceId, owner, { revision: estimatePolicy.revision, settings: estimatePolicy.settings });
    assert.deepEqual(unavailable.auditEstimate, { status: 'unavailable', rawRuns: null, rawPages: null, rawEdges: null, derivedRuns: null, derivedPages: null, atLeast: false });
    assert.equal(unavailable.estimate.status, 'available'); assert.ok(unavailable.previewToken);
  } finally { await tableGate.query('ROLLBACK'); tableGate.release(); }
  console.log('PASS audit capped preview lower bounds and timeout-safe unavailable estimates');

  const atomicProject = await project(), atomicRun = await receipt(atomicProject, { at: new Date(Date.now() - 400 * 86400000) }); await pages(atomicRun);
  const eventId = randomUUID(), connection = randomUUID(), ledger = randomUUID(), sessionId = randomUUID();
  await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at) VALUES($1,$2,'page_view','/synthetic',clock_timestamp()-interval '400 days')", [eventId, atomicProject.id]);
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name,encrypted_credentials) VALUES($1,$2,'openrouter','Protected synthetic fixture','{\"syntheticOpaqueEnvelope\":true}')", [connection, atomicProject.workspaceId]);
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month)
    VALUES($1,$2,$3,1,$4,$5,'fixture',$6,100,'uncertain','2026-01-01')`, [ledger, atomicProject.workspaceId, connection, owner, randomUUID(), 'b'.repeat(64)]);
  await pool.query("INSERT INTO project_context(project_id,brand_name) VALUES($1,'Authored brand')", [atomicProject.id]);
  await pool.query("INSERT INTO report(id,project_id,title,source_html) VALUES($1,$2,'Authored report','<h1>Retained</h1>')", [randomUUID(), atomicProject.id]);
  await pool.query('INSERT INTO session(id,token,"userId","expiresAt") VALUES($1,$2,$3,clock_timestamp()+interval \'1 day\')', [sessionId, randomUUID(), owner]);
  async function protectedSnapshot() {
    return (await pool.query(`SELECT (SELECT row_to_json(c) FROM provider_connection c WHERE id=$1) AS credentials,
      (SELECT row_to_json(r) FROM provider_request r WHERE id=$2) AS ledger,
      (SELECT row_to_json(c) FROM project_context c WHERE project_id=$3) AS context,
      (SELECT row_to_json(r) FROM report r WHERE project_id=$3) AS report,
      (SELECT row_to_json(s) FROM session s WHERE id=$4) AS session`, [connection, ledger, atomicProject.id, sessionId])).rows[0];
  }
  const protectedBefore = await protectedSnapshot(), functionName = `audit_retention_failure_${randomUUID().replaceAll('-', '')}`;
  // Fail the final shared project publication, after native and audit deletions.
  // This is database rollback, not an implementation-mirroring query mock.
  await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${atomicProject.id}' AND NEW.retention_error IS NULL AND NEW.retention_policy_revision IS NOT NULL THEN
      RAISE EXCEPTION 'Synthetic retention publication failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${functionName} BEFORE UPDATE ON project FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  try { await assert.rejects(runRetentionBatch(atomicProject.id), /Synthetic retention publication failure/); }
  finally { await pool.query(`DROP TRIGGER ${functionName} ON project`); await pool.query(`DROP FUNCTION ${functionName}()`); }
  assert.equal((await row(atomicRun)).data_expired_at, null); assert.equal((await counts(atomicRun)).evidence, 1);
  assert.equal((await pool.query('SELECT 1 FROM event WHERE project_id=$1 AND id=$2', [atomicProject.id, eventId])).rowCount, 1);
  assert.equal((await pool.query('SELECT retention_error FROM project WHERE id=$1', [atomicProject.id])).rows[0].retention_error, 'cleanup_failed');
  assert.deepEqual(await protectedSnapshot(), protectedBefore);
  const beforeHelper = (await pool.query('SELECT analytics_retained_from FROM project WHERE id=$1', [atomicProject.id])).rows[0].analytics_retained_from;
  await expire(atomicProject, { rawCutoff: new Date(), derivedCutoff: new Date() });
  assert.deepEqual((await pool.query('SELECT analytics_retained_from FROM project WHERE id=$1', [atomicProject.id])).rows[0].analytics_retained_from, beforeHelper);
  assert.equal((await runRetentionBatch(atomicProject.id))?.complete, true); assert.deepEqual(await protectedSnapshot(), protectedBefore);
  console.log('PASS audit/native transaction rollback, retry and protected credentials, finance, authored data, sessions and analytics watermark');
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/site-audit-retention-integration.ts')) {
  try { await runSiteAuditRetentionChecks(); console.log('Site Audit retention integration passed.'); }
  finally { await closeDatabase(); }
}
