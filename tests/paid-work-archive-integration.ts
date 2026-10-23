import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts';
import { createWorkspace } from '../src/server/teams.ts';
import { deleteProject, getProjectDeletion } from '../src/server/project-delete.ts';
import { archivedColumn, archivePaidWork, exportPaidWorkArchive, paidWorkArchiveTables } from '../src/server/paid-work-archive.ts';
import { runClosedAccountRetention } from '../src/server/account-closure-retention.ts';

// Needs an isolated synthetic PostgreSQL database; never a real installation. Every account and row here is created by
// this module; fixtures stay for inspection. Contract: #292, #291 and https://github.com/Ten98-IO-Company/ten98-discover/wiki/Accounts-and-Data#closed-account-retention.
export async function runPaidWorkArchiveChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  const config = getConfig();
  for (const url of [config.appUrl, config.databaseUrl]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  const { pool } = getDatabase(), suffix = randomUUID().slice(0, 8);
  // Written into every name, free-text and JSON column of the fixtures; it must never reach an archive record.
  const marker = `archive-marker-${suffix}`, hex = (c: string) => c.repeat(64);

  async function account(label: string) {
    const id = randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [id, `${marker} ${label}`, `${label}-${suffix}@archive.integration.test`]);
    return id;
  }
  const owner = await account('owner'), closer = await account('closer');
  const { workspace } = await createWorkspace(owner, { name: `${marker} workspace` });
  async function website(label: string, workspaceId = workspace.id) {
    const id = randomUUID();
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,$3,$4,$5,'infinity')",
      [id, workspaceId, `${marker} ${label}`, `https://${label}-${suffix}.archive.integration.test`, randomUUID()]);
    return id;
  }
  const project = await website('deleted'), kept = await website('kept'), faulted = await website('faulted'), connection = randomUUID();
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'dataforseo',$3)", [connection, workspace.id, `${marker} connection`]);

  async function receipt(user: string, workspaceId = workspace.id, connectionId = connection) {
    const id = randomUUID();
    await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month,provider_reference)
      VALUES($1,$2,$3,1,$4,gen_random_uuid(),'archive.fixture',$5,1000,900,'settled',date_trunc('month',now())::date,'provider-charge-1')`, [id, workspaceId, connectionId, user, hex('a')]);
    return id;
  }
  /** A paid keyword run of `projectId` by `user`: its quote and run, and the owner's workspace receipt. */
  async function keywordEntry(user: string, projectId: string, workspaceId = workspace.id, connectionId = connection) {
    const id = await receipt(owner, workspaceId, connectionId), quote = randomUUID();
    await pool.query(`INSERT INTO keyword_quote(id,workspace_id,project_id,user_id,connection_id,connection_revision,request,account_fingerprint,per_task_micros,per_item_micros,estimate_micros,price_as_of,expires_at)
      VALUES($1,$2,$3,$4,$5,1,$6,$7,900,100,1000,now(),now()+interval '5 minutes')`, [quote, workspaceId, projectId, user, connectionId, JSON.stringify({ mode: 'overview', keywords: [marker] }), hex('b')]);
    await pool.query(`INSERT INTO keyword_research_run(id,workspace_id,project_id,user_id,quote_id,status,diagnostic,result,completed_at)
      VALUES($1,$2,$3,$4,$5,'completed',$6,$7,now())`, [id, workspaceId, projectId, user, quote, marker, JSON.stringify({ note: marker })]);
    return { id, quote };
  }

  // The deleted website's paid work: every table family that website deletion removed before #292.
  const keyword = await keywordEntry(closer, project), keptKeyword = await keywordEntry(owner, kept), faultKeyword = await keywordEntry(owner, faulted);
  const execution = await receipt(owner), prompt = randomUUID(), version = randomUUID(), promptQuote = randomUUID(), comparison = randomUUID(), item = randomUUID(), tracker = randomUUID(), occurrence = randomUUID();
  const seed = await pool.connect();
  try {
    await seed.query('BEGIN');
    await seed.query('INSERT INTO project_prompt(id,project_id,current_version_id) VALUES($1,$2,$3)', [prompt, project, version]);
    await seed.query('INSERT INTO prompt_text_version(id,project_id,prompt_id,number,text,lower_text,created_by) VALUES($1,$2,$3,1,$4,$4,$5)', [version, project, prompt, marker, owner]);
    await seed.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,'[]',$12,now()+interval '1 hour')`,
      [promptQuote, workspace.id, project, owner, prompt, version, connection, hex('c'), hex('d'), JSON.stringify({ prompt: marker }), JSON.stringify([{ content: marker }]), hex('e')]);
    await seed.query('INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key) VALUES($1,$2,$3,$4,$5,gen_random_uuid())', [comparison, promptQuote, workspace.id, project, owner]);
    await seed.query("INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,diagnostic,completed_at) VALUES($1,$2,$3,$4,0,'{}','completed',$5,now())", [execution, comparison, workspace.id, project, marker]);
    await seed.query('INSERT INTO prompt_comparison_item(id,comparison_id,workspace_id,project_id,position,execution_id,reused) VALUES($1,$2,$3,$4,1,$5,true)', [item, comparison, workspace.id, project, execution]);
    await seed.query(`INSERT INTO prompt_tracker(id,workspace_id,project_id,created_request_id,name,input,definition_hash,calendar,maximum_micros)
      VALUES($1,$2,$3,gen_random_uuid(),$4,'{"reuseCached":false}',$5,'{"interval":"daily"}',17)`, [tracker, workspace.id, project, marker, hex('a')]);
    await seed.query(`INSERT INTO prompt_occurrence(id,tracker_id,workspace_id,project_id,user_id,requested_by,approval_id,definition_hash,scheduled_for,trigger,request_key,quote_id,comparison_id,status,reason)
      VALUES($1,$2,$3,$4,$5,$6,gen_random_uuid(),$7,now(),'now',gen_random_uuid(),$8,$9,'started',$10)`, [occurrence, tracker, workspace.id, project, owner, closer, hex('a'), promptQuote, comparison, marker]);
    await seed.query('UPDATE prompt_execution_quote SET recurring_occurrence_id=$2,recurring_models_hash=$3 WHERE id=$1', [promptQuote, occurrence, hex('a')]);
    await seed.query('COMMIT');
  } catch (error) { await seed.query('ROLLBACK'); throw error; } finally { seed.release(); }

  const rankConfig = randomUUID(), rankRun = randomUUID(), dispatch = await receipt(owner), task = randomUUID();
  await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
    VALUES($1,$2,$3,$4,'archive.integration.test',2840,'United States','Country',2840,'US','en','English',now(),'desktop',10,1)`, [rankConfig, workspace.id, project, marker]);
  await pool.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,expires_at,request_key,started_at,completed_at)
    VALUES($1,$2,$3,$4,$5,'manual','queued','completed',1,1,$6,1,$7,$8,$9,$7,1,1000,now(),now()+interval '5 minutes',gen_random_uuid(),now(),now())`,
    [rankRun, workspace.id, project, rankConfig, owner, connection, hex('f'), marker, JSON.stringify({ keyword: marker })]);
  await pool.query("INSERT INTO rank_dispatch(id,workspace_id,project_id,run_id,ordinal,method,task_count,request,request_hash,phase,diagnostic) VALUES($1,$2,$3,$4,0,'queued',1,$5,$6,'finished',$7)",
    [dispatch, workspace.id, project, rankRun, JSON.stringify([{ keyword: marker }]), hex('a'), marker]);
  await pool.query("INSERT INTO rank_task(id,workspace_id,project_id,run_id,dispatch_id,keyword_id,keyword,match_case,device,result_status,provisional_micros) VALUES($1,$2,$3,$4,$5,gen_random_uuid(),$6,false,'desktop','pending',100)",
    [task, workspace.id, project, rankRun, dispatch, marker]);

  const suggestion = await receipt(owner), suggestionQuote = randomUUID();
  await pool.query(`INSERT INTO ai_suggestion_quote(id,workspace_id,project_id,user_id,request_id,connection_id,connection_revision,request_actor,key_fingerprint,input_hash,snapshot_hash,input,snapshot,messages,route,expires_at)
    VALUES($1,$2,$3,$4,gen_random_uuid(),$5,1,$6,$7,$6,$6,$8,$8,$9,'{}',now()+interval '1 hour')`,
    [suggestionQuote, workspace.id, project, owner, connection, hex('a'), hex('d'), JSON.stringify({ brand: marker }), JSON.stringify([{ content: marker }])]);
  await pool.query("INSERT INTO ai_suggestion_run(id,quote_id,workspace_id,project_id,user_id,request_id,status,generation_id,raw_result,diagnostic) VALUES($1,$2,$3,$4,$5,gen_random_uuid(),'failed','gen-archive',$6,$6)",
    [suggestion, suggestionQuote, workspace.id, project, owner, marker]);

  /** Every seeded row of the deleted website, with its source created_at as exact text. */
  // Each execution also has its own comparison item, written by the schema.
  const items = (await pool.query<{ id: string }>('SELECT id::text FROM prompt_comparison_item WHERE comparison_id=$1', [comparison])).rows.map(row => row.id);
  assert.ok(items.includes(item) && items.length === 2);
  const deletedRows: [string, string][] = [['keyword_quote', keyword.quote], ['keyword_research_run', keyword.id], ['prompt_execution_quote', promptQuote], ['prompt_comparison', comparison],
    ['prompt_execution', execution], ...items.map(id => ['prompt_comparison_item', id] as [string, string]), ['prompt_occurrence', occurrence], ['rank_run', rankRun], ['rank_dispatch', dispatch], ['rank_task', task],
    ['ai_suggestion_quote', suggestionQuote], ['ai_suggestion_run', suggestion]];
  const createdText = async (table: string, id: string) => (await pool.query<{ at: string }>(table === 'prompt_execution' || table === 'prompt_comparison_item'
    ? 'SELECT c.created_at::text AS at FROM prompt_comparison c WHERE c.id=$1' : table === 'rank_task' ? 'SELECT d.created_at::text AS at FROM rank_dispatch d WHERE d.id=$1'
    : `SELECT created_at::text AS at FROM ${table} WHERE id=$1`, [table === 'prompt_execution' || table === 'prompt_comparison_item' ? comparison : table === 'rank_task' ? dispatch : id])).rows[0].at;
  const created = new Map(await Promise.all(deletedRows.map(async ([table, id]) => [`${table}:${id}`, await createdText(table, id)] as const)));
  const receipts = (await pool.query('SELECT to_jsonb(r) AS row FROM provider_request r WHERE workspace_id=$1 ORDER BY id', [workspace.id])).rows;
  const archived = async (scope: string) => (await pool.query<{ source_table: string; source_id: string; workspace_id: string; project_id: string | null; account_ids: string[]; record: Record<string, unknown>; created_at: string }>(
    'SELECT source_table, source_id::text, workspace_id, project_id, account_ids, record, created_at::text FROM paid_work_archive WHERE workspace_id=$1 AND project_id IS NOT DISTINCT FROM $2 ORDER BY source_table, source_id',
    [workspace.id, scope === 'workspace' ? null : scope])).rows;
  const columnTypes = new Map((await pool.query<{ key: string; udt: string }>(`SELECT table_name || '.' || column_name AS key, udt_name AS udt FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name=ANY($1::text[])`, [paidWorkArchiveTables])).rows.map(row => [row.key, row.udt]));
  const exists = async (table: string, id: string) => (await pool.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id])).rowCount === 1;

  // A failed copy aborts the deletion: the website, its paid work and the archive are unchanged.
  const connect = pool.connect.bind(pool);
  let copyFailed = false;
  pool.connect = (async () => {
    const client = await connect(), query = client.query.bind(client);
    client.query = ((sql: unknown, values?: unknown[]) => {
      if (typeof sql === 'string' && sql.trimStart().startsWith('INSERT INTO paid_work_archive')) { copyFailed = true; return Promise.reject(new Error('Synthetic archive failure.')); }
      return query(sql as string, values);
    }) as typeof client.query;
    const release = client.release.bind(client);
    client.release = (...args: Parameters<typeof release>) => { client.query = query as typeof client.query; release(...args); };
    return client;
  }) as typeof pool.connect;
  try { await assert.rejects(deleteProject(workspace.id, faulted, owner, { requestId: randomUUID(), revision: 1, confirmation: 'DELETE' }), /Synthetic archive failure/); }
  finally { pool.connect = connect as typeof pool.connect; }
  assert.ok(copyFailed && await exists('project', faulted) && await exists('keyword_research_run', faultKeyword.id), 'A failed archive copy must roll back the website deletion.');
  assert.equal((await archived(faulted)).length, 0);

  // Website deletion archives every paid-work row of the website, then deletes them with it.
  const revision = (await getProjectDeletion(workspace.id, project, owner)).item!.revision;
  await deleteProject(workspace.id, project, owner, { requestId: randomUUID(), revision, confirmation: 'DELETE' });
  assert.equal(await exists('project', project), false);
  for (const [table, id] of deletedRows) assert.equal(await exists(table, id), false, `${table} must go with its website.`);
  const rows = await archived(project);
  assert.deepEqual(rows.map(row => `${row.source_table}:${row.source_id}`).sort(), deletedRows.map(([table, id]) => `${table}:${id}`).sort(), 'Every paid-work row of the website is archived exactly once.');
  for (const row of rows) {
    assert.equal(row.workspace_id, workspace.id);
    assert.equal(row.created_at, created.get(`${row.source_table}:${row.source_id}`), `${row.source_table} keeps its ledger entry's creation time.`);
    assert.equal(row.record.id, row.source_id);
    for (const key of Object.keys(row.record)) assert.ok(archivedColumn(key, columnTypes.get(`${row.source_table}.${key}`)!), `${row.source_table}.${key} must not be archived.`);
    for (const key of ['encrypted_credentials', 'key_fingerprint', 'account_fingerprint', 'request_actor', 'connection_name', 'diagnostic', 'input', 'messages', 'request', 'raw_result', 'keyword', 'reason'])
      assert.equal(Object.hasOwn(row.record, key), false, `${row.source_table}.${key} reached the archive.`);
    assert.equal(JSON.stringify(row.record).includes(marker), false, `${row.source_table} archived a name or free text.`);
    assert.equal(JSON.stringify(row.record).includes(hex('b').slice(0, 32)) || JSON.stringify(row.record).includes(hex('d').slice(0, 32)), false, `${row.source_table} archived a credential fingerprint.`);
  }
  const bySource = new Map(rows.map(row => [`${row.source_table}:${row.source_id}`, row]));
  assert.deepEqual(bySource.get(`keyword_research_run:${keyword.id}`)!.account_ids, [closer]);
  assert.deepEqual(bySource.get(`prompt_occurrence:${occurrence}`)!.account_ids, [owner, closer]);
  assert.deepEqual(bySource.get(`rank_task:${task}`)!.account_ids, []);
  assert.equal(bySource.get(`keyword_quote:${keyword.quote}`)!.record.estimate_micros, 1000);
  assert.equal(bySource.get(`rank_task:${task}`)!.record.provisional_micros, 100);
  assert.equal(bySource.get(`ai_suggestion_run:${suggestion}`)!.record.status, 'failed');
  assert.deepEqual((await pool.query('SELECT to_jsonb(r) AS row FROM provider_request r WHERE workspace_id=$1 ORDER BY id', [workspace.id])).rows, receipts, 'The workspace receipts stay live and unchanged.');
  assert.equal((await archived(kept)).length, 0, 'Another website of the workspace is not archived.');
  assert.ok(await exists('keyword_research_run', keptKeyword.id));
  console.log('PASS website deletion copies every paid-work row (accounting fields only, no credential, name or free text) to the archive in its transaction, and a failed copy deletes nothing');

  // Workspace scope: a workspace delete after archiving keeps its receipts and every website's paid work.
  const other = (await createWorkspace(owner, { name: `${marker} other workspace` })).workspace, otherProject = await website('other', other.id), otherConnection = randomUUID();
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'dataforseo',$3)", [otherConnection, other.id, marker]);
  const otherEntry = await keywordEntry(owner, otherProject, other.id, otherConnection);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    assert.deepEqual(Object.entries(await archivePaidWork(client, { workspaceId: other.id })).filter(([, n]) => n), [['provider_request', 1], ['keyword_quote', 1], ['keyword_research_run', 1]]);
    assert.deepEqual(Object.entries(await archivePaidWork(client, { workspaceId: other.id })).filter(([, n]) => n), [], 'Archiving again adds nothing.');
    await client.query('DELETE FROM workspace WHERE id=$1', [other.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const otherRows = (await pool.query<{ key: string; project_id: string | null }>("SELECT source_table || ':' || source_id AS key, project_id FROM paid_work_archive WHERE workspace_id=$1 ORDER BY 1", [other.id])).rows;
  assert.deepEqual(otherRows, [{ key: `keyword_quote:${otherEntry.quote}`, project_id: otherProject }, { key: `keyword_research_run:${otherEntry.id}`, project_id: otherProject }, { key: `provider_request:${otherEntry.id}`, project_id: null }]
    .sort((a, b) => a.key.localeCompare(b.key)));
  assert.equal(await exists('provider_request', otherEntry.id), false);

  // Operator export: the scope's rows in pages, oldest first, and a website filter.
  const exportClient = await pool.connect();
  try {
    const all = [];
    for await (const row of exportPaidWorkArchive(exportClient, { workspaceId: workspace.id }, 2)) all.push(row);
    assert.equal(all.length, deletedRows.length);
    const order = all.map(row => `${row.createdAt}\t${row.sourceTable}\t${row.sourceId}`);
    assert.deepEqual(order, [...order].sort(), 'Export pages keep oldest-first order.');
    const site = [];
    for await (const row of exportPaidWorkArchive(exportClient, { workspaceId: other.id, projectId: otherProject })) site.push(row.sourceTable);
    assert.deepEqual(site.sort(), ['keyword_quote', 'keyword_research_run']);
  } finally { exportClient.release(); }
  console.log('PASS workspace-scope archiving is idempotent and survives a workspace delete; the operator export pages a workspace or one website');

  // Retention: recent archive rows stay and keep the closed account they name; 7-year-old rows go, and then the tombstone.
  await pool.query(`UPDATE "user" SET name='Closed account',email='closed-' || gen_random_uuid() || '@invalid',image=NULL,"emailVerified"=false,"twoFactorEnabled"=false,closed_at=clock_timestamp() WHERE id=$1`, [closer]);
  const tombstone = async () => (await pool.query('SELECT 1 FROM "user" WHERE id=$1', [closer])).rowCount === 1;
  // No live row names the closer any more; only its archived keyword entry and prompt occurrence do.
  let summary = await runClosedAccountRetention();
  assert.ok(!summary.archiveFailed && !summary.tombstonesFailed);
  assert.equal((await archived(project)).length, deletedRows.length, 'Recent archive rows were deleted.');
  assert.ok(await tombstone(), 'A tombstone the archive still names was deleted.');
  await pool.query("UPDATE paid_work_archive SET created_at=created_at - interval '7 years 1 day' WHERE workspace_id=$1 AND project_id=$2 AND source_table IN ('keyword_quote','keyword_research_run','prompt_occurrence')", [workspace.id, project]);
  summary = await runClosedAccountRetention();
  assert.ok(summary.archived >= 3 && !summary.archiveFailed);
  assert.deepEqual((await archived(project)).map(row => row.source_table).filter(table => ['keyword_quote', 'keyword_research_run', 'prompt_occurrence'].includes(table)), [], 'Aged archive rows remain.');
  assert.equal((await archived(project)).length, deletedRows.length - 3, 'A recent archive row was deleted.');
  assert.equal(await tombstone(), false, 'The tombstone that only aged archive rows named remains.');
  summary = await runClosedAccountRetention();
  assert.equal((await archived(project)).length, deletedRows.length - 3, 'A second run is idempotent.');
  console.log('PASS the daily job deletes archive rows 7 years after their ledger creation, keeps newer ones and keeps a closed tombstone until no archived row names it');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runPaidWorkArchiveChecks(); } finally { await closeDatabase(); }
}
