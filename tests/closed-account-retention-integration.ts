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
  // An operator closure by an open operator: the closed target alone decides, so the old row goes, then its tombstone.
  await closureAudit(operated, active, old);
  // A saved keyword still uses an aged run as its metric source: the run, its quote and its receipt stay.
  const blockedEntry = await keywordEntry(closed, old), savedKeyword = randomUUID();
  await pool.query("INSERT INTO saved_keyword(id,project_id,keyword,location_code,language_code,metric_source_run_id) VALUES($1,$2,'retention fixture',2840,'en',$3)", [savedKeyword, project, blockedEntry.id]);
  // Recurring prompt work: an occurrence requested by an open account stays; an occurrence and its quote, which reference
  // each other, go together.
  const prompt = randomUUID(), version = randomUUID(), tracker = randomUUID(), openOccurrence = randomUUID(), cycleOccurrence = randomUUID(), cycleQuote = randomUUID();
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query("INSERT INTO project_prompt(id,project_id,current_version_id,topic) VALUES($1,$2,$3,'Retention')", [prompt, project, version]);
    await setup.query("INSERT INTO prompt_text_version(id,project_id,prompt_id,number,text,lower_text,created_by) VALUES($1,$2,$3,1,'Retention fixture prompt','retention fixture prompt',$4)", [version, project, prompt, active]);
    await setup.query('COMMIT');
  } catch (error) { await setup.query('ROLLBACK'); throw error; } finally { setup.release(); }
  await pool.query(`INSERT INTO prompt_tracker(id,workspace_id,project_id,created_request_id,name,input,definition_hash,calendar,maximum_micros)
    VALUES($1,$2,$3,$4,'Retention tracker','{"reuseCached":false}',$5,'{"interval":"daily"}',1000)`, [tracker, workspace.id, project, randomUUID(), 'c'.repeat(64)]);
  const occurrence = (id: string, user: string, requestedBy: string, day: number) => pool.query(`INSERT INTO prompt_occurrence(id,tracker_id,workspace_id,project_id,user_id,requested_by,approval_id,definition_hash,scheduled_for,trigger,request_key,status,created_at)
    VALUES($1,$2,$3,$4,$5,$6,gen_random_uuid(),$7,now()-$8::interval+make_interval(days=>$9),'calendar',gen_random_uuid(),'skipped',now()-$8::interval)`, [id, tracker, workspace.id, project, user, requestedBy, 'c'.repeat(64), old, day]);
  await occurrence(openOccurrence, closed, active, 0);
  await occurrence(cycleOccurrence, closed, closed, 1);
  await pool.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,created_at,expires_at,recurring_occurrence_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$8,'{}','[]','[]',$8,now()-$9::interval,now()-$9::interval+interval '5 minutes',$10)`, [cycleQuote, workspace.id, project, closed, prompt, version, connection, 'd'.repeat(64), old, cycleOccurrence]);
  await pool.query("UPDATE prompt_occurrence SET status='quoted',quote_id=$2 WHERE id=$1", [cycleOccurrence, cycleQuote]);
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
  assert.equal(await closureAuditExists(operated), false, 'An aged closure audit of a closed target remains because its actor is open.');
  assert.equal(await exists('"user"', gone), false, 'An unreferenced tombstone remains.');
  assert.equal(await exists('"user"', operated), false, 'An unreferenced tombstone remains.');
  assert.equal(await exists('prompt_occurrence', cycleOccurrence), false, 'The occurrence and quote cycle was not deleted.');
  assert.equal(await exists('prompt_execution_quote', cycleQuote), false, 'The occurrence and quote cycle was not deleted.');

  for (const [table, id] of [['provider_request', uncertainEntry.id], ['keyword_quote', uncertainEntry.quote], ['keyword_research_run', uncertainEntry.id],
    ['provider_request', recentReceipt], ['instance_operator_audit', recentOperatorAudit],
    ['provider_request', activeEntry.id], ['keyword_quote', activeEntry.quote], ['keyword_research_run', activeEntry.id], ['instance_operator_audit', activeAudit],
    ['analytics_annotation', annotation], ['provider_request', blockedEntry.id], ['keyword_quote', blockedEntry.quote], ['keyword_research_run', blockedEntry.id],
    ['prompt_occurrence', openOccurrence]] as const) assert.ok(await exists(table, id), `A retained ${table} row was deleted.`);
  assert.ok(await closureAuditExists(closed), 'A recent closure audit was deleted.');
  for (const id of [closed, authored, active]) assert.ok(await exists('"user"', id), 'A referenced or open account row was deleted.');

  // Idempotent: a default run finds nothing more among these fixtures.
  await runClosedAccountRetention();
  assert.ok(await exists('provider_request', recentReceipt) && await exists('"user"', closed));

  // Fan-out: one aged rank run with many charged dispatches is larger than a small cap. The run passes over that entry,
  // still deletes the next eligible receipt and finishes; a run with room deletes the whole entry at once.
  const ranked = await account('ranked'), small = await account('small'), rankConfig = randomUUID(), rankRun = randomUUID(), dispatches = 12;
  await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
    VALUES($1,$2,$3,'Retention tracker','retention.integration.test',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),'desktop',10,1)`, [rankConfig, workspace.id, project]);
  await pool.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,expires_at,request_key,created_at,started_at,completed_at)
    VALUES($1,$2,$3,$4,$5,'manual','queued','completed',1,1,$6,1,$7,'Retention fixture','{}',$7,$8,1000,now()-$9::interval,now()-$9::interval+interval '5 minutes',gen_random_uuid(),now()-$9::interval,now()-$9::interval,now()-$9::interval)`,
    [rankRun, workspace.id, project, rankConfig, ranked, connection, 'e'.repeat(64), dispatches, old]);
  const dispatchIds: string[] = [];
  for (let ordinal = 0; ordinal < dispatches; ordinal++) {
    const id = await receipt(ranked, old);
    dispatchIds.push(id);
    await pool.query(`INSERT INTO rank_dispatch(id,workspace_id,project_id,run_id,ordinal,method,task_count,request,request_hash,phase,created_at)
      VALUES($1,$2,$3,$4,$5,'queued',1,'[{}]',$6,'finished',now()-$7::interval)`, [id, workspace.id, project, rankRun, ordinal, 'f'.repeat(64), old]);
  }
  const smallReceipt = await receipt(small, old);
  for (const id of [ranked, small]) await close(id);
  const crowded = await runClosedAccountRetention({ batchRows: 5, runRows: 10 });
  assert.ok(crowded.skipped >= 1 && crowded.capped && !crowded.ledgerFailed && !crowded.tombstonesFailed, 'An oversized ledger entry must be passed over, not fail the run.');
  assert.ok(Object.values(crowded.deleted).reduce((sum, n) => sum + n, 0) + crowded.tombstones <= 10);
  assert.ok(await exists('rank_run', rankRun) && await exists('rank_dispatch', dispatchIds[0]), 'An oversized entry was partly deleted.');
  assert.equal(await exists('provider_request', smallReceipt), false, 'The run did not move on past the oversized entry.');
  assert.equal(await exists('"user"', small), false, 'The tombstone pass did not run.');
  const roomy = await runClosedAccountRetention({ batchRows: 5, runRows: 100 });
  assert.equal(roomy.deleted.rank_run, 1);
  assert.equal(roomy.deleted.rank_dispatch, dispatches);
  for (const id of dispatchIds) assert.equal(await exists('provider_request', id), false, 'A rank receipt remains.');
  assert.equal(await exists('"user"', ranked), false, 'An unreferenced tombstone remains.');
  console.log('PASS closed-account retention ages out only closed accounts\' 7-year ledger and audit rows, keeps receipts under reconciliation and removes unreferenced tombstones within the cap');
}
