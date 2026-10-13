import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfig } from '../src/server/config.ts';
import { closeDatabase, getDatabase } from '../src/server/db.ts';
import { createWorkspace } from '../src/server/teams.ts';
import { expireGoogleImportPages } from '../src/server/google-retention.ts';
import { expireKeywordResults } from '../src/server/keyword-retention.ts';
import { enqueueGoogleImport, listGoogleConnections, readGoogleImport } from '../src/server/google-jobs.ts';
import { getRetention, previewRetention, saveRetention, runRetentionBatch } from '../src/server/retention.ts';
import { stopJobs } from '../src/server/jobs.ts';

export async function runGoogleRetentionChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  for (const value of [getConfig().appUrl, getConfig().databaseUrl]) assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(value).hostname));
  const { pool } = getDatabase(), owner = randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [owner, 'Google retention fixture', `${owner}@retention.integration.test`]);
  async function project() {
    const { workspace } = await createWorkspace(owner, { name: 'Google retention fixture' });
    const id = randomUUID();
    await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)', [id, workspace.id, 'Retention fixture', 'https://retention.integration.test', randomUUID()]);
    return { id, workspaceId: workspace.id };
  }
  const primary = await project(), foreign = await project();
  async function keyword(p: typeof primary, completedAt: Date) {
    const connectionId=randomUUID(),id=randomUUID(),quoteId=randomUUID();
    await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'dataforseo','Retention fixture')",[connectionId,p.workspaceId]);
    await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month,provider_reference)
      VALUES($1,$2,$3,1,$4,$5,'keyword.overview',$6,12120,12120,'settled','2026-01-01','retained-task')`,[id,p.workspaceId,connectionId,owner,randomUUID(),'a'.repeat(64)]);
    await pool.query(`INSERT INTO keyword_quote(id,workspace_id,project_id,user_id,connection_id,connection_revision,request,account_fingerprint,per_task_micros,per_item_micros,estimate_micros,price_as_of,expires_at)
      VALUES($1,$2,$3,$4,$5,1,'{"mode":"overview","keywords":["synthetic"]}',$6,12000,120,12120,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,[quoteId,p.workspaceId,p.id,owner,connectionId,'b'.repeat(64)]);
    await pool.query(`INSERT INTO keyword_research_run(id,workspace_id,project_id,user_id,quote_id,status,result,reconciliation_evidence,completed_at)
      VALUES($1,$2,$3,$4,$5,'completed','{"rows":[{"keyword":"synthetic","searchVolume":0}]}','{"taskId":"retained-task","reportedCost":0.01212}',$6)`,[id,p.workspaceId,p.id,owner,quoteId,completedAt]);
    return {id,quoteId};
  }

  const cutoff = new Date(Date.now() - 30 * 86_400_000), old = new Date(cutoff.getTime() - 1);
  async function receipt(p = primary, status = 'completed', completedAt: Date | null = old) {
    const connectionId = randomUUID(), id = randomUUID(), requestId = randomUUID();
    await pool.query(`INSERT INTO google_connection(id,workspace_id,project_id,name,provider,revision,app_revision,status)
      VALUES($1,$2,$3,'Retention fixture','gsc',1,1,'disconnected')`, [connectionId, p.workspaceId, p.id]);
    await pool.query(`INSERT INTO google_import(id,connection_id,project_id,user_id,request_id,connection_revision,app_revision,report,date_from,date_to,status,pages,row_count,source,quality,completed_at)
      VALUES($1,$2,$3,$4,$5,1,1,'gsc_daily','2026-01-01','2026-01-01',$6,1,1,'{"provider":"gsc","propertyId":"sc-domain:retention.integration.test"}',
      '{"warnings":["Original quality"],"metadata":{"fixture":"private aggregate metadata"}}',$7)`, [id, connectionId, p.id, owner, requestId, status, completedAt]);
    await pool.query(`INSERT INTO google_import_page(import_id,page,rows) VALUES($1,0,'[{"dimensions":["2026-01-01"],"metrics":{"clicks":0,"impressions":1,"ctr":0,"position":null}}]')`, [id]);
    return { id, connectionId, requestId };
  }
  async function expire() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [primary.workspaceId]);
      await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE', [primary.id]);
      const result = await expireGoogleImportPages(client, primary.id, cutoff);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const older = await receipt(), exact = await receipt(primary, 'completed', cutoff), newer = await receipt(primary, 'completed', new Date(cutoff.getTime() + 1));
  const other = await receipt(foreign), active = await receipt(primary, 'queued', old), running = await receipt(primary, 'running', old);
  for (const status of ['partial','failed','denied']) await receipt(primary, status);
  for (let i = 0; i < 21; i++) await receipt();
  assert.equal((await readGoogleImport(primary.id, owner, older.id, 0)).rows.length, 1);
  const first = await expire(); assert.deepEqual(first, { expiredImports: 20, pending: true });
  const second = await expire(); assert.deepEqual(second, { expiredImports: 5, pending: false });
  assert.deepEqual(await expire(), { expiredImports: 0, pending: false });
  for (const retained of [exact,newer,active,running,other]) {
    const row = (await pool.query('SELECT data_expired_at FROM google_import WHERE id=$1', [retained.id])).rows[0];
    assert.equal(row.data_expired_at, null, 'Exact boundary, new, active and foreign receipts must survive.');
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM google_import_page WHERE import_id=$1', [retained.id])).rows[0].n, 1);
  }
  const expired = await readGoogleImport(primary.id, owner, older.id, 0);
  assert.equal(expired.import.status, 'completed'); assert.equal(expired.import.dataStatus, 'expired'); assert.equal(expired.import.rowCount, 1);
  assert.deepEqual(expired.rows, []); assert.equal(expired.nextOffset, null); assert.deepEqual(expired.quality.metadata, {});
  assert.match(expired.quality.warnings.join(' '), /expired/);
  const retried = await enqueueGoogleImport(primary.id, owner, older.connectionId, { requestId: older.requestId, report: 'gsc_daily', from: '2026-01-01', to: '2026-01-01' });
  assert.equal(retried.import.id, older.id); assert.equal(retried.import.dataStatus, 'expired');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM google_import WHERE project_id=$1 AND request_id=$2', [primary.id, older.requestId])).rows[0].n, 1);
  const listed = await listGoogleConnections(primary.id, owner);
  assert.equal(listed.connections.find(row => row.id === older.connectionId)?.imports[0].dataStatus, 'expired');
  await assert.rejects(readGoogleImport(foreign.id, owner, older.id, 0), (error: unknown) => (error as { status: number }).status === 404);

  const concurrent = await receipt();
  const gate = await pool.connect();
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [primary.workspaceId]);
    await gate.query('SELECT id FROM project WHERE id=$1 FOR UPDATE', [primary.id]);
    await expireGoogleImportPages(gate, primary.id, cutoff);
    let resolved = false;
    const read = readGoogleImport(primary.id, owner, concurrent.id, 0).then(value => { resolved = true; return value; });
    await delay(50); assert.equal(resolved, false, 'Report read must serialize behind cleanup.');
    await gate.query('ROLLBACK');
    assert.equal((await read).rows.length, 1, 'Failed cleanup must preserve observations atomically.');
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [primary.workspaceId]);
    await gate.query('SELECT id FROM project WHERE id=$1 FOR UPDATE', [primary.id]);
    await expireGoogleImportPages(gate, primary.id, cutoff);
    const afterCommit = readGoogleImport(primary.id, owner, concurrent.id, 0);
    await gate.query('COMMIT');
    assert.equal((await afterCommit).import.dataStatus, 'expired');
  } finally { await gate.query('ROLLBACK').catch(() => {}); gate.release(); }

  const oldKeyword=await keyword(primary,old), exactKeyword=await keyword(primary,cutoff),newKeyword=await keyword(primary,new Date(cutoff.getTime()+1)),foreignKeyword=await keyword(foreign,old);
  const evidenceBefore=(await pool.query('SELECT row_to_json(p) AS ledger,r.reconciliation_evidence FROM provider_request p JOIN keyword_research_run r ON r.id=p.id WHERE p.id=$1',[oldKeyword.id])).rows[0];
  const keywordGate=await pool.connect();try{await keywordGate.query('BEGIN');await keywordGate.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[primary.workspaceId]);await keywordGate.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[primary.id]);assert.deepEqual(await expireKeywordResults(keywordGate,primary.id,cutoff),{expiredKeywordResults:1,pending:false});await keywordGate.query('COMMIT');}finally{await keywordGate.query('ROLLBACK').catch(()=>{});keywordGate.release();}
  for(const retained of [exactKeyword,newKeyword,foreignKeyword])assert.notEqual((await pool.query('SELECT result FROM keyword_research_run WHERE id=$1',[retained.id])).rows[0].result,null);
  for(let n=0;n<101;n++)await keyword(primary,old);
  const policy = await getRetention(primary.workspaceId, owner);
  const preview = await previewRetention(primary.workspaceId, owner, { revision: policy.revision, settings: { ...policy.settings, derivedHistoryDays: 1 } });
  assert.equal(preview.derivedEstimate.status, 'available'); assert.equal(preview.derivedEstimate.imports, 2);
  assert.deepEqual(preview.keywordEstimate,{status:'available',results:103,atLeast:false});
  await saveRetention(primary.workspaceId, owner, { previewToken: preview.previewToken });
  const partial=await runRetentionBatch(primary.id);assert.equal(partial?.expiredGoogleImports,2);assert.equal(partial?.expiredKeywordResults,100);assert.equal(partial?.complete,false);
  const last=await runRetentionBatch(primary.id);assert.equal(last?.expiredKeywordResults,3);assert.equal(last?.complete,true);
  const evidenceAfter=(await pool.query('SELECT row_to_json(p) AS ledger,r.reconciliation_evidence FROM provider_request p JOIN keyword_research_run r ON r.id=p.id WHERE p.id=$1',[oldKeyword.id])).rows[0];assert.deepEqual(evidenceAfter,evidenceBefore);assert.equal((await pool.query('SELECT id FROM keyword_quote WHERE id=$1',[oldKeyword.quoteId])).rowCount,1);
  assert.notEqual((await pool.query('SELECT result FROM keyword_research_run WHERE id=$1',[foreignKeyword.id])).rows[0].result,null);
  console.log('PASS shared Google/keyword cutoff, separate workspace preview counts, partial-batch scheduling and financial receipt preservation');
  assert.equal((await readGoogleImport(primary.id, owner, exact.id, 0)).import.dataStatus, 'expired');
  const extended = await getRetention(primary.workspaceId, owner);
  const longer = await previewRetention(primary.workspaceId, owner, { revision: extended.revision, settings: { ...extended.settings, derivedHistoryDays: 3650 } });
  await saveRetention(primary.workspaceId, owner, { previewToken: longer.previewToken });
  await runRetentionBatch(primary.id);
  assert.equal((await readGoogleImport(primary.id, owner, older.id, 0)).import.dataStatus, 'expired', 'Extending retention cannot reconstruct deleted rows.');
  assert.equal((await pool.query('SELECT data_expired_at FROM google_import WHERE id=$1', [other.id])).rows[0].data_expired_at, null);
  // Publication and cleanup share the workspace gate. A cleanup attempt while
  // publication is in progress must skip it; newly terminal data is then retained.
  const publisher = await pool.connect();
  try {
    await publisher.query('BEGIN');
    await publisher.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [primary.workspaceId]);
    await publisher.query("UPDATE google_import SET status='completed',completed_at=clock_timestamp() WHERE id=$1", [active.id]);
    assert.equal(await runRetentionBatch(primary.id), null);
    await publisher.query('COMMIT');
    await runRetentionBatch(primary.id);
    assert.equal((await readGoogleImport(primary.id, owner, active.id, 0)).import.dataStatus, 'available');
  } finally { await publisher.query('ROLLBACK').catch(() => {}); publisher.release(); }
}

if (process.argv[1]?.replaceAll('\\','/').endsWith('/google-retention-integration.ts')) {
  try { await runGoogleRetentionChecks(); console.log('Google snapshot retention integration passed.'); }
  finally { await stopJobs(); await closeDatabase(); }
}
