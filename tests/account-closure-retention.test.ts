import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { accountClosureInventory, closedAccountLedgerDependents } from '../src/server/account-closure-inventory.ts';
import { archivedColumn, paidWorkArchiveTables } from '../src/server/paid-work-archive.ts';
import { parseMigrations, readMigrationSchema, type MigrationSchema } from './helpers/migration-schema.ts';

/**
 * Retention promise (https://github.com/Ten98-IO-Company/ten98-discover/wiki/Accounts-and-Data#account-closure, ten98-code-system#39): rows a closed account leaves behind are kept as long
 * as their workspace exists and go when it is deleted. Workspace deletion relies on ON DELETE CASCADE, so every kept table
 * that is workspace-scoped (a workspace_id or project_id column, or a parent that has one) must reach `workspace` through
 * cascading foreign keys, or be a listed exception. Paid-work rows are copied to the paid-work archive before website or
 * workspace deletion removes them (#292), and the archive outlives both.
 */

/** Kept tables that hold a workspace or website id but deliberately outlive the workspace. */
const outlivesWorkspace = new Set(['paid_work_archive']);

// TODO(#292): workspace deletion must delete these explicitly, as project deletion does, or a reviewed migration must
// make their links cascade. https://github.com/Ten98-IO-Company/ten98-discover/issues/292
const noActionChain = 'Reaches project only through NO ACTION foreign keys; project deletion (src/server/project-delete.ts) deletes it explicitly before the project row.';
/** Known gaps: kept tables a workspace cascade would not remove. Each must stay in the project-deletion delete list. */
const exceptions: ReadonlyMap<string, string> = new Map([
  'ai_suggestion_run', 'google_import', 'prompt_comparison', 'prompt_occurrence', 'prompt_tracker', 'rank_config', 'rank_run',
].map(table => [table, noActionChain]));

/** Foreign keys declared on a table, each once. */
const foreignKeys = (schema: MigrationSchema, table: string) => new Set([...schema.get(table)?.values() ?? []].flatMap(column => column.foreignKeys));

/** The ON DELETE CASCADE path from `table` to `workspace`, through any parent, or null when none exists. */
function cascadePath(schema: MigrationSchema, table: string, seen = new Set<string>()): string[] | null {
  if (table === 'workspace') return ['workspace'];
  if (seen.has(table)) return null;
  seen.add(table);
  for (const key of foreignKeys(schema, table)) {
    if (key.onDelete !== 'CASCADE') continue;
    const rest = cascadePath(schema, key.table, new Set(seen));
    if (rest) return [table, ...rest];
  }
  return null;
}

/** A table is workspace-scoped when it has a workspace_id or project_id column or references a workspace-scoped table. */
function workspaceScoped(schema: MigrationSchema, table: string, seen = new Set<string>()): boolean {
  if (table === 'workspace' || table === 'project') return true;
  const columns = schema.get(table);
  if (!columns || seen.has(table)) return false;
  seen.add(table);
  if (columns.has('workspace_id') || columns.has('project_id')) return true;
  return [...foreignKeys(schema, table)].some(key => key.table !== 'user' && workspaceScoped(schema, key.table, seen));
}

function workspaceScopedKeptTables(schema: MigrationSchema): string[] {
  return accountClosureInventory
    .filter(entry => entry.rule === 'keep' && entry.table !== 'workspace' && !outlivesWorkspace.has(entry.table) && workspaceScoped(schema, entry.table))
    .map(entry => entry.table)
    .sort();
}

test('every kept, workspace-scoped table is removed by a workspace delete cascade', () => {
  const schema = readMigrationSchema();
  const tables = workspaceScopedKeptTables(schema);
  assert.ok(tables.length >= 40, 'The kept workspace-scoped inventory should not shrink silently.');
  const gaps = tables.filter(table => !exceptions.has(table) && !cascadePath(schema, table));
  assert.deepEqual(gaps, [], 'These kept tables would outlive their workspace. Add ON DELETE CASCADE in a new migration or record a reviewed exception.');
  for (const table of exceptions.keys()) assert.ok(tables.includes(table) && !cascadePath(schema, table), `${table} is no longer an exception; remove it.`);
});

test('each known gap is still deleted explicitly by project deletion', () => {
  const source = readFileSync(join(process.cwd(), 'src/server/project-delete.ts'), 'utf8');
  const explicit = source.match(/for\s*\(\s*const table of \[([^\]]*)\]/)?.[1].match(/'([a-z_]+)'/g)?.map(quoted => quoted.slice(1, -1)) ?? [];
  for (const table of exceptions.keys()) assert.ok(explicit.includes(table), `${table} is no longer deleted before its project; it would block or outlive deletion.`);
});

test('kept tables without a workspace or project column are the reviewed instance-level set', () => {
  const schema = readMigrationSchema();
  const scoped = workspaceScopedKeptTables(schema);
  const unscoped = accountClosureInventory
    .filter(entry => entry.rule === 'keep' && entry.table !== 'workspace' && !outlivesWorkspace.has(entry.table) && !scoped.includes(entry.table))
    .map(entry => entry.table).sort();
  // Instance configuration, instance rate limits and account-id audits; they are not removed with a workspace (#291).
  assert.deepEqual(unscoped, ['account_closure_audit', 'google_app', 'instance_operator_audit', 'oidc_provider', 'rateLimit']);
});

/**
 * Owner decision (ten98-code-system#39, "Financial: full 7 years", and the #292 manager decision): financial rows survive
 * website and workspace deletion for 7 years. Deletion copies them to the paid-work archive in the deleting transaction,
 * then removes them with the website or workspace as before.
 */
test('every financial table and ledger dependent is archived, with its own or its parent ledger entry age', () => {
  const schema = readMigrationSchema();
  const financial = accountClosureInventory.filter(entry => entry.retention?.class === 'financial').map(entry => entry.table);
  assert.ok(accountClosureInventory.every(entry => entry.retention?.class !== 'financial' || entry.retention.survivesWorkspaceDeletion));
  assert.deepEqual([...paidWorkArchiveTables].sort(), [...financial, ...closedAccountLedgerDependents.map(dependent => dependent.table)].sort());
  for (const table of paidWorkArchiveTables) {
    const columns = schema.get(table)!;
    assert.equal(columns.get('id')?.type, 'uuid', `${table} needs a uuid id to key its archive row.`);
    assert.ok(columns.has('workspace_id'), `${table} needs a workspace_id to scope its archive row.`);
    if (columns.has('created_at')) continue;
    const parent = closedAccountLedgerDependents.find(dependent => dependent.table === table)?.parent;
    assert.ok(parent && schema.get(parent)!.has('created_at') && [...foreignKeys(schema, table)].some(key => key.table === parent), `${table} has no created_at and no parent to age with.`);
  }
});

// The closure inventory's personal-data heuristic, plus provider-account fingerprints.
const personalOrSecret = /email|(^|_)ip(_|$)|ip_?address|user_?agent|name|token|user_?id|_by$|actor|inviter|image|subject|issuer|password|credential|claims|^value$|secret|fingerprint/i;
/** Opaque ids the archive keeps on purpose: the account ids the row names and its own scope. */
const opaqueIds = new Set(['user_id', 'requested_by', 'workspace_id', 'project_id']);
const enumeratedText = /^(status|operation|method|trigger|phase|purpose|provider_reference|generation_id|provider_task_id|result_status|price_mode|price_source|price_version)$/;

test('archive records hold no credential, personal or free-text column', () => {
  const schema = readMigrationSchema();
  for (const table of paidWorkArchiveTables) {
    const kept = [...schema.get(table)!.values()].filter(column => archivedColumn(column.name, column.type));
    assert.ok(kept.some(column => column.name === 'id'), `${table} archives no id.`);
    for (const column of kept) {
      assert.ok(!personalOrSecret.test(column.name) || opaqueIds.has(column.name), `${table}.${column.name} can hold a credential or personal data.`);
      assert.notEqual(column.type, 'jsonb', `${table}.${column.name} is JSON content.`);
      if (column.type === 'text') assert.ok(opaqueIds.has(column.name) || column.name.endsWith('_hash') || enumeratedText.test(column.name), `${table}.${column.name} is free text.`);
    }
    // Money is what the archive is for: every amount column is kept.
    for (const column of schema.get(table)!.values()) if (column.name.endsWith('_micros')) assert.ok(kept.includes(column), `${table}.${column.name} is not archived.`);
  }
  for (const [name, type] of [['encrypted_credentials', 'jsonb'], ['key_fingerprint', 'text'], ['account_fingerprint', 'text'], ['request_actor', 'text'], ['connection_name', 'text'],
    ['diagnostic', 'text'], ['input', 'jsonb'], ['keyword', 'text'], ['ranking_url', 'text'], ['token_hash', 'text'], ['client_ip', 'text']] as const)
    assert.equal(archivedColumn(name, type), false, `${name} must never be archived.`);
});

test('website deletion archives paid work before its first delete, and no other path deletes a website or workspace', () => {
  const source = readFileSync(join(process.cwd(), 'src/server/project-delete.ts'), 'utf8');
  const archive = source.indexOf('await archivePaidWork(client,{workspaceId,projectId})'), firstDelete = source.search(/DELETE FROM|for\s*\(\s*const table of \[/);
  assert.ok(archive > 0 && archive < firstDelete, 'Website deletion must archive paid work before deleting anything.');
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
  for (const file of sources(join(process.cwd(), 'src'))) {
    const text = readFileSync(file, 'utf8');
    if (/DELETE FROM (workspace|project)\b(?!_)/.test(text)) assert.ok(text.includes('archivePaidWork('), `${file} deletes a website or workspace without archiving its paid work.`);
  }
});

test('the parser records ON DELETE actions for inline, table and ALTER foreign keys', () => {
  const schema = parseMigrations([
    'CREATE TABLE workspace (id uuid PRIMARY KEY);',
    'CREATE TABLE project (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE, UNIQUE (id, workspace_id));',
    `CREATE TABLE note (id uuid, project_id uuid, workspace_id uuid,
      CONSTRAINT note_project FOREIGN KEY (project_id, workspace_id) REFERENCES project(id, workspace_id) ON DELETE CASCADE);`,
    'CREATE TABLE receipt (id uuid, workspace_id uuid REFERENCES public."workspace"(id));',
    'CREATE TABLE tag (id uuid, workspace_id uuid);',
    'ALTER TABLE tag ADD CONSTRAINT tag_workspace FOREIGN KEY (workspace_id) REFERENCES workspace ON DELETE SET NULL;',
    'ALTER TABLE tag ADD COLUMN project_id uuid REFERENCES project(id) ON DELETE RESTRICT;',
  ]);
  const keys = (table: string, column: string) => schema.get(table)!.get(column)!.foreignKeys.map(key => `${key.table}:${key.onDelete}`);
  assert.deepEqual(keys('project', 'workspace_id'), ['workspace:CASCADE']);
  assert.deepEqual(keys('note', 'workspace_id'), ['project:CASCADE']);
  assert.deepEqual(keys('receipt', 'workspace_id'), ['workspace:NO ACTION']);
  assert.deepEqual(keys('tag', 'workspace_id'), ['workspace:SET NULL']);
  assert.deepEqual(keys('tag', 'project_id'), ['project:RESTRICT']);
  assert.deepEqual(cascadePath(schema, 'note'), ['note', 'project', 'workspace']);
  assert.equal(cascadePath(schema, 'receipt'), null);
  assert.equal(cascadePath(schema, 'tag'), null);
});
