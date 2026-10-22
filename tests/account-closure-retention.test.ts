import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { accountClosureInventory } from '../src/server/account-closure-inventory.ts';
import { parseMigrations, readMigrationSchema, type MigrationSchema } from './helpers/migration-schema.ts';

/**
 * Retention promise (https://github.com/Ten98-IO-Company/ten98-discover/wiki/Account-Closure, ten98-code-system#39): rows a closed account leaves behind are kept as long
 * as their workspace exists and go when it is deleted. Workspace deletion relies on ON DELETE CASCADE, so every kept table
 * that is workspace-scoped (a workspace_id or project_id column, or a parent that has one) must reach `workspace` through
 * cascading foreign keys, or be a listed exception.
 */

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
    .filter(entry => entry.rule === 'keep' && entry.table !== 'workspace' && workspaceScoped(schema, entry.table))
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
    .filter(entry => entry.rule === 'keep' && entry.table !== 'workspace' && !scoped.includes(entry.table))
    .map(entry => entry.table).sort();
  // Instance configuration, instance rate limits and account-id audits; they are not removed with a workspace (#291).
  assert.deepEqual(unscoped, ['account_closure_audit', 'google_app', 'instance_operator_audit', 'oidc_provider', 'rateLimit']);
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
