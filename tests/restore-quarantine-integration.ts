import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts';
import { stopJobs } from '../src/server/jobs.ts';
import { quarantineRestoredSpending } from '../src/server/restore-quarantine.ts';
import { saveBudget, saveProvider } from '../src/server/providers.ts';
import { dispatchSpend, reserveSpend } from '../src/server/spending.ts';
import { executeKeywordResearch } from '../src/server/keyword-research.ts';
import { createPrompts } from '../src/server/prompts.ts';
import { executePromptComparison, quotePromptExecution, startPromptExecution } from '../src/server/prompt-execution.ts';

// A fresh migrated synthetic database only. No server, worker or real provider starts.
assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
assert.equal(process.env.TEN98_RESTORE_TEST, '1');
const config = getConfig(), url = new URL(config.databaseUrl);
const ci = process.env.GITHUB_ACTIONS === 'true' && process.env.TEN98_ISOLATED_CI_DATABASE === '1' && url.pathname === '/ten98_restore_quarantine_ci';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.equal(url.port, ci ? '5432' : '55501');
assert.match(url.pathname, /^\/ten98_restore_quarantine_[a-z0-9_]+$/);
assert.equal(url.search, ''); assert.equal(url.hash, '');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.appUrl).hostname));
const pool = getDatabase().pool, originalFetch = globalThis.fetch;
let unexpected = 0, paid = 0;
globalThis.fetch = async () => { unexpected++; throw new Error('External traffic forbidden in restore acceptance.'); };
const send: typeof fetch = async (address, options) => {
  assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'omit');
  const path = String(address);
  if (path === 'https://openrouter.ai/api/v1/models?output_modalities=text&offset=0&limit=500') return Response.json({ data: [{ id: 'openai/gpt-4o-mini', canonical_slug: 'openai/gpt-4o-mini', name: 'openai/gpt-4o-mini', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, context_length: 128000, top_provider: { max_completion_tokens: 16384 }, supported_parameters: ['max_tokens'], pricing: { prompt: '0.00000015', completion: '0.0000006', request: '0' } }], total_count: 1, links: { next: null } });
  if (path === 'https://openrouter.ai/api/v1/key') return Response.json({ data: { is_free_tier: false, is_management_key: false } });
  if (path === 'https://openrouter.ai/api/v1/models/openai/gpt-4o-mini/endpoints') return Response.json({ data: { id: 'openai/gpt-4o-mini', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, endpoints: [{
    tag: 'openai', provider_name: 'OpenAI', model_id: 'openai/gpt-4o-mini', status: 0, context_length: 128000,
    max_prompt_tokens: null, max_completion_tokens: 16384, supported_parameters: ['max_tokens'],
    pricing: { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '0.000000075', discount: 0 },
  }] } });
  paid++; throw new Error('A quarantined job attempted provider dispatch.');
};
try {
  await assertSchema();
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM workspace')).rows[0].count, 0, 'Use a newly created empty test database.');
  const owner = randomUUID(), workspace = randomUUID(), other = randomUUID(), project = randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Restore fixture\',$2)', [owner, owner + '@restore.integration.test']);
  for (const id of [workspace, other]) {
    await pool.query('INSERT INTO workspace(id,name) VALUES($1,\'Restore fixture\')', [id]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
  }
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Restore fixture','https://restore.integration.test',$3,'infinity')", [project, workspace, randomUUID()]);
  const connection = (await saveProvider(workspace, owner, { name: 'Synthetic only', provider: 'openrouter', credentials: { apiKey: 'synthetic-never-live' }, monthlyLimitUsd: '10' })).connection.id;
  await pool.query("UPDATE provider_connection SET check_status='ok' WHERE id=$1", [connection]);
  await saveBudget(workspace, owner, { monthlyLimitUsd: '10', paused: false });
  const reservation = () => ({ connectionId: connection, requestKey: randomUUID(), operation: 'restore.fixture', estimateUsd: '0.01', inputHash: 'a'.repeat(64) });
  const request = reservation(), reserved = await reserveSpend(workspace, owner, request);
  const protectedIds: string[] = [];
  for (const status of ['dispatched', 'uncertain', 'settled', 'cancelled']) {
    const id = randomUUID(); protectedIds.push(id);
    await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month,provider_reference)
      VALUES($1,$2,$3,1,$4,$5,'restore.fixture',$6,10000,$7,$8,date_trunc('month',now())::date,$9)`, [id, workspace, connection, owner, randomUUID(), 'b'.repeat(64), status === 'settled' ? 3456 : null, status, 'synthetic-receipt-' + id]);
  }
  // The uncertain charge belongs to historical work; temporarily omit it while
  // creating the already-authorized comparison snapshot, then restore its state.
  await pool.query("UPDATE provider_request SET status='cancelled' WHERE id=$1", [protectedIds[1]]);
  const prompt = (await createPrompts(project, owner, { requestId: randomUUID(), prompts: [{ text: 'Synthetic restore acceptance', enabled: false }] })).items[0];
  const quote = (await quotePromptExecution(project, owner, { connectionId: connection, promptId: prompt.id, versionId: prompt.currentVersionId, systemText: '', models: ['openai/gpt-4o-mini'], maxCompletionTokens: 64, fundedCredits: true }, send)).quote;
  const comparison = (await startPromptExecution(project, owner, { quoteId: quote.id, requestKey: randomUUID() })).comparison;
  await pool.query("UPDATE provider_request SET status='uncertain' WHERE id=$1", [protectedIds[1]]);
  const keywordQuote = randomUUID();
  await pool.query(`INSERT INTO keyword_quote(id,workspace_id,project_id,user_id,connection_id,connection_revision,request,account_fingerprint,per_task_micros,per_item_micros,estimate_micros,price_as_of,expires_at)
    VALUES($1,$2,$3,$4,$5,1,'{}',$6,1,1,10000,clock_timestamp(),clock_timestamp()+interval '5 minutes')`, [keywordQuote, workspace, project, owner, connection, 'c'.repeat(64)]);
  await pool.query("INSERT INTO keyword_research_run(id,workspace_id,project_id,user_id,quote_id,status) VALUES($1,$2,$3,$4,$5,'queued')", [reserved.id, workspace, project, owner, keywordQuote]);
  const schedule = randomUUID();
  await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages,
    schedule_interval,schedule_timezone,schedule_hour,schedule_minute,schedule_enabled,approval_id,approval_user_id,approval_config_revision,approval_keywords_revision,approval_request_hash,approval_connection_id,approval_connection_revision,approval_account_fingerprint,approval_account_fingerprint_version,approval_max_micros,approved_at,next_due_at)
    VALUES($1,$2,$3,'Restored schedule','example.com',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),'desktop',10,1,
    'daily','UTC',0,0,true,$4,$5,1,1,$6,$7,1,$6,2,10000,clock_timestamp(),clock_timestamp())`, [schedule, workspace, project, randomUUID(), owner, 'd'.repeat(64), connection]);
  const snapshot = async () => (await pool.query('SELECT * FROM provider_request WHERE id=ANY($1::uuid[]) ORDER BY id', [protectedIds])).rows;
  const evidence = await snapshot();
  const encrypted = (await pool.query('SELECT encrypted_credentials FROM provider_connection WHERE id=$1', [connection])).rows[0].encrypted_credentials;
  await pool.query("CREATE FUNCTION restore_fixture_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic quarantine failure'; END $$");
  await pool.query('CREATE TRIGGER restore_fixture_reject BEFORE UPDATE ON rank_config FOR EACH ROW EXECUTE FUNCTION restore_fixture_reject()');
  await assert.rejects(quarantineRestoredSpending());
  assert.equal((await pool.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1', [workspace])).rows[0].paused, false);
  assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1', [reserved.id])).rows[0].status, 'reserved');
  assert.equal((await pool.query('SELECT 1 FROM workspace_budget WHERE workspace_id=$1', [other])).rowCount, 0);
  await pool.query('DROP TRIGGER restore_fixture_reject ON rank_config');
  await pool.query('DROP FUNCTION restore_fixture_reject()');
  console.log('PASS restore quarantine failure rolls back every budget, reservation and schedule change');

  const first = await quarantineRestoredSpending();
  assert.deepEqual(first, { pausedBudgets: 2, cancelledReservations: 2, disabledSchedules: 1 });
  assert.deepEqual(await snapshot(), evidence);
  assert.deepEqual((await pool.query('SELECT encrypted_credentials FROM provider_connection WHERE id=$1', [connection])).rows[0].encrypted_credentials, encrypted);
  const standing = (await pool.query('SELECT schedule_enabled,next_due_at,approval_id,approval_account_fingerprint FROM rank_config WHERE id=$1', [schedule])).rows[0];
  assert.equal(standing.schedule_enabled, false); assert.equal(standing.next_due_at, null); assert.ok(standing.approval_id); assert.equal(standing.approval_account_fingerprint, 'd'.repeat(64));
  assert.deepEqual(await quarantineRestoredSpending(), { pausedBudgets: 0, cancelledReservations: 0, disabledSchedules: 0 });
  console.log('PASS quarantine pauses all workspaces, cancels only reserved work, disables standing schedules and preserves charge/credential evidence idempotently');

  await saveBudget(workspace, owner, { monthlyLimitUsd: '10', paused: false });
  await assert.rejects(dispatchSpend(workspace, owner, reserved.id), { status: 409 });
  assert.equal((await reserveSpend(workspace, owner, request)).status, 'cancelled', 'Same request receipt cannot regain authorization.');
  await executeKeywordResearch(reserved.id, send);
  await executePromptComparison(comparison.id, send);
  assert.equal((await pool.query('SELECT status FROM keyword_research_run WHERE id=$1', [reserved.id])).rows[0].status, 'cancelled');
  assert.equal((await pool.query('SELECT status FROM prompt_execution WHERE comparison_id=$1', [comparison.id])).rows[0].status, 'cancelled');
  assert.equal(paid, 0); assert.equal(unexpected, 0); assert.deepEqual(await snapshot(), evidence);
  console.log('PASS owner unpause and duplicate receipts cannot revive restored spending; real keyword/prompt worker handlers converge to cancelled with zero paid sends');

  const block = 'data:text/javascript,' + encodeURIComponent("globalThis.fetch=async()=>{throw new Error('No network allowed in restore CLI acceptance');}");
  const child = spawnSync(process.execPath, ['--import', block, 'src/server/cli.ts', 'restore-quarantine'], {
    cwd: process.cwd(), env: { ...process.env, CREDENTIAL_KEYS: '', CREDENTIAL_ACTIVE_KEY: '' }, encoding: 'utf8', timeout: 30_000, maxBuffer: 64_000, windowsHide: true,
  });
  assert.equal(child.status, 0, 'Offline CLI must work without opening the credential keyring.');
  assert.match(child.stdout, /Restore spending quarantine applied:/);
  for (const value of [config.databaseUrl, config.authSecret, config.bootstrapToken, JSON.stringify(encrypted)]) assert.ok(!(child.stdout + child.stderr).includes(value));
  assert.equal((await pool.query('SELECT bool_and(paused) AS paused FROM workspace_budget')).rows[0].paused, true);
  console.log('PASS real CLI quarantines without provider decryption, network access or secret output');
} finally {
  try { await stopJobs(); } finally { globalThis.fetch = originalFetch; await closeDatabase(); }
}
