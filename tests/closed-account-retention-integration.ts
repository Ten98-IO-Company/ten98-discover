import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, getDatabase } from '../src/server/db.ts';
import { createWorkspace } from '../src/server/teams.ts';
import { runClosedAccountRetention, type ClosedAccountRetentionSummary } from '../src/server/account-closure-retention.ts';

// Needs an isolated synthetic PostgreSQL database; never a real installation. Every account and row here is created by
// this module and backdated explicitly; fixtures stay for inspection. Contract: docs/account-closure.md#retention.
export async function runClosedAccountRetentionChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  const config = getConfig();
  for (const url of [config.appUrl, config.databaseUrl]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  const { pool } = getDatabase(), suffix = randomUUID().slice(0, 8);
  const old = '7 years 1 day', recent = '6 years 11 months';

  async function account(label: string) {
    const id = randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [id, `Retention ${label}`, `${label}-${suffix}@retention.integration.test`]);
    return id;
  }
  const close = (id: string) => pool.query(`UPDATE "user" SET name='Closed account',email='closed-' || gen_random_uuid() || '@invalid',image=NULL,
    "emailVerified"=false,"twoFactorEnabled"=false,closed_at=clock_timestamp() WHERE id=$1`, [id]);
  const active = await account('active'), closed = await account('closed'), gone = await account('gone'), authored = await account('authored'), operated = await account('operated');
  const { workspace } = await createWorkspace(active, { name: 'Closed-account retention fixture' });
  const project = randomUUID(), connection = randomUUID();
  await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)', [project, workspace.id, 'Retention fixture', 'https://retention.integration.test', randomUUID()]);
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'dataforseo','Retention fixture, no credentials')", [connection, workspace.id]);

  async function receipt(user: string, age: string, status = 'settled') {
    const id = randomUUID();
    await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month,created_at,updated_at)
      VALUES($1,$2,$3,1,$4,gen_random_uuid(),'retention.fixture',$5,1000,$6,$7,date_trunc('month',now())::date,now()-$8::interval,now()-$8::interval)`,
      [id, workspace.id, connection, user, 'a'.repeat(64), status === 'settled' ? 1000 : null, status, age]);
    return id;
  }
  /** A paid keyword run: its receipt, quote and run, all created at the same age. */
  async function keywordEntry(user: string, age: string, status = 'settled') {
    const id = await receipt(user, age, status), quote = randomUUID();
    await pool.query(`INSERT INTO keyword_quote(id,workspace_id,project_id,user_id,connection_id,connection_revision,request,account_fingerprint,per_task_micros,per_item_micros,estimate_micros,price_as_of,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,1,'{"mode":"overview","keywords":["synthetic"]}',$6,900,100,1000,now()-$7::interval,now()-$7::interval,now()-$7::interval+interval '5 minutes')`,
      [quote, workspace.id, project, user, connection, 'b'.repeat(64), age]);
    await pool.query(`INSERT INTO keyword_research_run(id,workspace_id,project_id,user_id,quote_id,status,created_at,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,now()-$7::interval,now()-$7::interval)`, [id, workspace.id, project, user, quote, status === 'settled' ? 'completed' : 'uncertain', age]);
    return { id, quote };
  }
  const operatorAudit = async (user: string, age: string) =>
    (await pool.query<{ id: string }>("INSERT INTO instance_operator_audit(user_id,action,created_at) VALUES($1,'grant',now()-$2::interval) RETURNING id::text", [user, age])).rows[0].id;
  const closureAudit = (user: string, actor: string, age: string) => pool.query(
    'INSERT INTO account_closure_audit(user_id,actor_user_id,kind,reason,created_at) VALUES($1,$2,$3,$4,now()-$5::interval)',
    [user, actor, user === actor ? 'self' : 'operator', user === actor ? null : 'Retention fixture basis', age]);

  // The closed account: aged ledger and audit rows go; recent rows, an uncertain charge and its run stay.
  const agedEntry = await keywordEntry(closed, old), uncertainEntry = await keywordEntry(closed, old, 'uncertain');
  const cancelledReceipt = await receipt(closed, old, 'cancelled'), recentReceipt = await receipt(closed, recent);
  const agedOperatorAudit = await operatorAudit(closed, old), recentOperatorAudit = await operatorAudit(closed, recent);
  await closureAudit(closed, closed, recent);
  // An open account's equally old rows are never candidates.
  const activeEntry = await keywordEntry(active, old), activeAudit = await operatorAudit(active, old);
  // Only aged rows: everything goes, then the tombstone.
  const goneReceipts = [await receipt(gone, old), await receipt(gone, old)];
  await closureAudit(gone, gone, old);
  // Aged audit goes, but authored workspace content still names the account, so its tombstone stays.
  await closureAudit(authored, authored, old);
  const annotation = randomUUID();
  await pool.query("INSERT INTO analytics_annotation(id,project_id,user_id,date,note) VALUES($1,$2,$3,now(),'Retention fixture note')", [annotation, project, authored]);
  // An operator closure names an open operator as actor: the row also belongs to an open account and stays.
  await closureAudit(operated, active, old);
  for (const id of [closed, gone, authored, operated]) await close(id);

  const exists = async (table: string, id: string) => (await pool.query(`SELECT 1 FROM ${table} WHERE id::text=$1`, [id])).rowCount === 1;
  const closureAuditExists = async (user: string) => (await pool.query('SELECT 1 FROM account_closure_audit WHERE user_id=$1', [user])).rowCount === 1;
  const goneRows = async () => (await Promise.all(goneReceipts.map(id => exists('provider_request', id)))).some(Boolean) || await closureAuditExists(gone);

  // Capped runs: each deletes at most three rows (one keyword entry is exactly three) until nothing is left.
  const cap = 3;
  const runs: ClosedAccountRetentionSummary[] = [];
  for (let run = 0; run < 20; run++) {
    const summary = await runClosedAccountRetention({ batchRows: 1, runRows: cap, batches: 200 });
    runs.push(summary);
    const total = Object.values(summary.deleted).reduce((sum, n) => sum + n, 0) + summary.tombstones;
    assert.ok(total <= cap, 'A run deleted more rows than its cap.');
    // The tombstone stays while any row still names it.
    if (await goneRows()) assert.ok(await exists('"user"', gone), 'A tombstone was deleted while rows still referenced it.');
    if (!total) break;
  }
  assert.ok(runs[0].capped, 'The first capped run reports that more remains.');
  assert.ok(runs.length > 2 && !runs.at(-1)!.capped, 'Capped runs make progress and finish.');

  for (const id of [agedEntry.id, cancelledReceipt, ...goneReceipts]) assert.equal(await exists('provider_request', id), false, 'An aged closed-account receipt remains.');
  assert.equal(await exists('keyword_quote', agedEntry.quote), false);
  assert.equal(await exists('keyword_research_run', agedEntry.id), false);
  assert.equal(await exists('instance_operator_audit', agedOperatorAudit), false);
  assert.equal(await closureAuditExists(gone), false);
  assert.equal(await closureAuditExists(authored), false);
  assert.equal(await exists('"user"', gone), false, 'An unreferenced tombstone remains.');

  for (const [table, id] of [['provider_request', uncertainEntry.id], ['keyword_quote', uncertainEntry.quote], ['keyword_research_run', uncertainEntry.id],
    ['provider_request', recentReceipt], ['instance_operator_audit', recentOperatorAudit],
    ['provider_request', activeEntry.id], ['keyword_quote', activeEntry.quote], ['keyword_research_run', activeEntry.id], ['instance_operator_audit', activeAudit],
    ['analytics_annotation', annotation]] as const) assert.ok(await exists(table, id), `A retained ${table} row was deleted.`);
  assert.ok(await closureAuditExists(closed) && await closureAuditExists(operated), 'A recent or open-actor closure audit was deleted.');
  for (const id of [closed, authored, operated, active]) assert.ok(await exists('"user"', id), 'A referenced or open account row was deleted.');

  // Idempotent: a default run finds nothing more among these fixtures.
  await runClosedAccountRetention();
  assert.ok(await exists('provider_request', recentReceipt) && await exists('"user"', closed));
  console.log('PASS closed-account retention ages out only closed accounts\' 7-year ledger and audit rows, keeps receipts under reconciliation and removes unreferenced tombstones within the cap');
}
