import assert from 'node:assert/strict';
import test from 'node:test';
import { accountClosureInventory, closedAccountLedgerDependents, closedAccountRetentionInterval } from '../src/server/account-closure-inventory.ts';
import {
  accountReferences, closedOnlySql, deleteSql, expandSql, ident, pruneSql, retentionTargets, selectRootsSql, tombstoneSql,
  type RetentionForeignKey, type RetentionTarget,
} from '../src/server/account-closure-retention.ts';
import { readMigrationSchema, type MigrationSchema } from './helpers/migration-schema.ts';

/** Closed-account retention (docs/account-closure.md#retention): classification coverage and the batch SQL builder. */

// The same account-link heuristic as the closure inventory coverage test.
const accountLink = /user_?id|_by$|actor|inviter/i;
/** Name-linked columns that do not hold an account id. */
const notAccountIds: ReadonlyMap<string, string> = new Map([
  'prompt_execution_quote.request_actor', 'ai_suggestion_quote.request_actor', 'ai_content_support_quote.request_actor',
].map(column => [column, 'A 64-character hex binding of the requesting actor, not an account id.']));
/** Live workspace rows that reference an aged-out table without being aged out themselves: they keep the row. */
const reviewedBlockers = ['rank_keyword', 'saved_keyword'];

const foreignKeys = (schema: MigrationSchema, table: string) => new Set([...schema.get(table)?.values() ?? []].flatMap(column => column.foreignKeys));

test('every kept table that names an account has an explicit retention class and account columns', () => {
  const schema = readMigrationSchema();
  for (const entry of accountClosureInventory) {
    if (entry.rule !== 'keep') { assert.equal(entry.retention, undefined, `${entry.table} is not kept, so it has no retention class.`); continue; }
    const columns = schema.get(entry.table)!;
    const named = [...columns.values()].filter(column => column.referencesUser || accountLink.test(column.name)).map(column => column.name);
    if (!named.length) { assert.equal(entry.retention, undefined, `${entry.table} names no account.`); continue; }
    assert.ok(entry.retention, `${entry.table} names an account: classify it as financial, audit or workspace in account-closure-inventory.ts.`);
    const { retention } = entry;
    assert.ok(retention.reason.length >= 20, `${entry.table} needs a stated retention reason.`);
    for (const column of retention.accountColumns) assert.ok(columns.has(column), `${entry.table}.${column} is not a migrated column.`);
    for (const column of named) assert.ok(retention.accountColumns.includes(column) || notAccountIds.has(`${entry.table}.${column}`), `${entry.table}.${column} names an account but is not an account column.`);
    assert.equal(retention.survivesWorkspaceDeletion, retention.class === 'financial', `${entry.table}: only financial rows survive workspace deletion.`);
    if (retention.class !== 'workspace') assert.ok(columns.has('created_at'), `${entry.table} ages out from created_at, which it lacks.`);
  }
});

test('the agreed retention classes', () => {
  const byClass = (name: string) => accountClosureInventory.filter(entry => entry.retention?.class === name).map(entry => entry.table).sort();
  assert.deepEqual(byClass('audit'), ['account_closure_audit', 'instance_operator_audit']);
  assert.deepEqual(byClass('financial'), [
    'ai_content_support_quote', 'ai_content_support_run', 'ai_search_quote', 'ai_search_run', 'ai_suggestion_quote', 'ai_suggestion_run',
    'domain_research_quote', 'domain_research_run', 'keyword_quote', 'keyword_research_run', 'prompt_comparison', 'prompt_execution_quote',
    'prompt_occurrence', 'provider_request', 'rank_run', 'saved_keyword_refresh_plan',
  ]);
  // An unresolved reservation, dispatch or uncertain charge never ages out, and neither does the work that references it.
  const receipts = accountClosureInventory.find(entry => entry.table === 'provider_request')!.retention!;
  assert.equal(receipts.eligibleWhen, "t.status IN ('settled','cancelled')");
  assert.equal(receipts.retainsReferencingRows, true);
  assert.equal(closedAccountRetentionInterval, '7 years');
  // Audit rows age out by their closed subject even when the actor is open; financial rows need every account closed.
  for (const entry of accountClosureInventory.filter(item => item.retention)) {
    const { retention } = entry;
    assert.equal(retention!.subjectColumn, retention!.class === 'audit' ? 'user_id' : undefined, entry.table);
    if (retention!.subjectColumn) assert.ok(retention!.accountColumns.includes(retention!.subjectColumn), entry.table);
  }
  const columns = (table: string) => retentionTargets().find(target => target.table === table)!.accountColumns;
  assert.deepEqual(columns('account_closure_audit'), ['user_id']);
  assert.deepEqual(columns('prompt_occurrence'), ['user_id', 'requested_by']);
  // The actor still keeps its own tombstone until the row ages out.
  assert.ok(accountReferences([]).some(ref => ref.table === 'account_closure_audit' && ref.column === 'actor_user_id'));
});

test('ledger dependents hang off a financial row and the aged-out graph has only reviewed outside references', () => {
  const schema = readMigrationSchema(), targets = retentionTargets(), names = new Set(targets.map(target => target.table));
  for (const dependent of closedAccountLedgerDependents) {
    assert.ok(schema.has(dependent.table), `${dependent.table} is not a migrated table.`);
    assert.ok(names.has(dependent.parent), `${dependent.table}'s parent ${dependent.parent} must age out too.`);
    assert.ok([...foreignKeys(schema, dependent.table)].some(key => key.table === dependent.parent), `${dependent.table} must reference ${dependent.parent}.`);
    assert.ok(![...schema.get(dependent.table)!.values()].some(column => column.referencesUser || accountLink.test(column.name)), `${dependent.table} names an account; classify it instead.`);
  }
  const outside = new Set<string>();
  for (const [table] of schema) for (const key of foreignKeys(schema, table)) {
    if (!names.has(key.table)) continue;
    assert.notEqual(key.onDelete, 'RESTRICT', `${table} restricts deletion of ${key.table}; the single delete statement needs deferred checks.`);
    if (!names.has(table)) outside.add(table);
  }
  assert.deepEqual([...outside].sort(), reviewedBlockers, 'A new table references an aged-out table. Classify it, make it a ledger dependent or review it as a blocker.');
});

test('the batch SQL builder selects only aged, closed-only rows in bounded, locked batches', () => {
  const closed = closedOnlySql(['user_id', 'requested_by']);
  assert.match(closed, /^\(t\."user_id" IS NOT NULL OR t\."requested_by" IS NOT NULL\) AND /);
  assert.match(closed, /\(t\."requested_by" IS NULL OR EXISTS \(SELECT 1 FROM "user" u WHERE u\.id=t\."requested_by" AND u\.closed_at IS NOT NULL\)\)/);
  const sql = selectRootsSql({ table: 'provider_request', accountColumns: ['user_id'], eligibleWhen: "t.status IN ('settled','cancelled')" });
  assert.match(sql, /FROM "provider_request" t/);
  assert.match(sql, /t\.created_at < \$1::timestamptz AND \(t\.created_at, t\.ctid\) > \(\$2::timestamptz, \$3::tid\)/);
  assert.match(sql, /AND \(t\.status IN \('settled','cancelled'\)\)/);
  assert.match(sql, /ORDER BY t\.created_at, t\.ctid LIMIT \$4 FOR UPDATE OF t SKIP LOCKED$/);
  assert.equal(ident('twoFactor'), '"twoFactor"');
  assert.equal(ident('a"b'), '"a""b"');
});

test('expansion, pruning and deletion follow the foreign-key graph', () => {
  const targets: RetentionTarget[] = [
    { table: 'receipt', accountColumns: ['user_id'], eligibleWhen: "t.status='settled'", retainsReferencingRows: true },
    { table: 'quote', accountColumns: ['user_id'] },
    { table: 'run', accountColumns: ['user_id'] },
    { table: 'step', accountColumns: [], parent: 'run' },
  ];
  const keys: RetentionForeignKey[] = [
    { child: 'run', childColumns: ['id', 'workspace_id'], parent: 'receipt', parentColumns: ['id', 'workspace_id'] },
    { child: 'run', childColumns: ['quote_id'], parent: 'quote', parentColumns: ['id'] },
    { child: 'step', childColumns: ['run_id'], parent: 'run', parentColumns: ['id'] },
    { child: 'live_note', childColumns: ['source_run_id'], parent: 'run', parentColumns: ['id'] },
    { child: 'quote', childColumns: ['workspace_id'], parent: 'workspace', parentColumns: ['id'] },
  ];
  const expand = expandSql(targets, keys);
  // Up and down each foreign key between aged-out tables; none to tables outside the set.
  assert.equal(expand.length, 6);
  assert.ok(expand.every(sql => sql.includes('FOR UPDATE OF t SKIP LOCKED') && sql.includes('ON CONFLICT DO NOTHING') && sql.includes('$1::timestamptz')));
  assert.ok(expand.some(sql => /INSERT INTO pg_temp\.closure_retention_candidate\(tbl,row_id\) SELECT 'receipt'/.test(sql) && sql.includes(`t."id"=f."id" AND t."workspace_id"=f."workspace_id"`)));
  assert.ok(!expand.some(sql => sql.includes('"workspace"') || sql.includes('"live_note"')));
  const prune = pruneSql(targets, keys);
  // Referenced rows: receipt<-run, quote<-run, run<-step, run<-live_note. Together: run->receipt (receipt), step->run (parent).
  assert.equal(prune.length, 6);
  const live = prune.find(sql => sql.includes('"live_note"'))!;
  assert.match(live, /x\.tbl='run'/);
  assert.doesNotMatch(live, /k\.tbl='live_note'/, 'A table outside the set always keeps the row it references.');
  assert.match(prune.find(sql => sql.includes(`USING "step" p`) || sql.includes(`FROM "step" c`))!, /NOT EXISTS \(SELECT 1 FROM pg_temp\.closure_retention_candidate k WHERE k\.tbl='step'/);
  assert.ok(prune.some(sql => sql.includes(`x.tbl='run' AND x.row_id=c.ctid`) && sql.includes(`FROM "receipt" p`)), 'Work referencing a retained receipt stays.');
  assert.ok(!prune.some(sql => sql.includes(`x.tbl='run' AND x.row_id=c.ctid`) && sql.includes(`FROM "quote" p`)), 'A quote is not a together parent.');
  const remove = deleteSql(targets);
  assert.match(remove, /^WITH d0 AS \(DELETE FROM "receipt" t USING pg_temp\.closure_retention_candidate k WHERE k\.tbl='receipt' AND t\.ctid=k\.row_id RETURNING 1\)/);
  assert.match(remove, /\(SELECT count\(\*\) FROM d3\)::int AS "step"$/);
});

test('a tombstone goes only when no foreign key or declared account column references it', () => {
  const references = accountReferences([
    { child: 'session', childColumns: ['userId'], parent: 'user', parentColumns: ['id'] },
    { child: 'provider_request', childColumns: ['user_id'], parent: 'user', parentColumns: ['id'] },
    { child: 'run', childColumns: ['quote_id'], parent: 'quote', parentColumns: ['id'] },
  ]);
  const has = (table: string, column: string) => references.some(ref => ref.table === table && ref.column === column);
  assert.ok(has('session', 'userId') && has('provider_request', 'user_id'));
  assert.ok(!references.some(ref => ref.table === 'run'));
  // Columns without a foreign key still count, for every class.
  for (const [table, column] of [['instance_operator_audit', 'user_id'], ['context_section', 'updated_by'], ['board_share_request', 'actor_id'], ['prompt_comparison', 'user_id']]) assert.ok(has(table, column), `${table}.${column}`);
  assert.equal(references.filter(ref => ref.table === 'provider_request' && ref.column === 'user_id').length, 1);
  const sql = tombstoneSql(references);
  assert.match(sql, /^DELETE FROM "user" u WHERE u\.id IN \(SELECT v\.id FROM "user" v WHERE v\.closed_at IS NOT NULL/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "session" r WHERE r\."userId"=v\.id\)/);
  assert.match(sql, /ORDER BY v\.closed_at, v\.id LIMIT \$1 FOR UPDATE SKIP LOCKED\)$/);
});
