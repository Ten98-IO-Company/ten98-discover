import assert from 'node:assert/strict';
import test from 'node:test';
import { accountClosureInventory } from '../src/server/account-closure-inventory.ts';
import { parseMigrations, readMigrationSchema, type MigrationSchema } from './helpers/migration-schema.ts';

// A column "like" account personal data or credentials. A user foreign key always counts.
const personalColumn = /email|(^|_)ip(_|$)|ip_?address|user_?agent|name|token|user_?id|_by$|actor|inviter/i;
// Rules applied by account-closure.ts in code rather than by an inventory statement.
const appliedInCode = new Set(['user', 'import_probe', 'pgboss.job']);

function uncovered(schema: MigrationSchema, inventory = accountClosureInventory): string[] {
  const missing: string[] = [];
  for (const [table, columns] of schema) for (const column of columns.values()) {
    if (!column.referencesUser && !personalColumn.test(column.name)) continue;
    if (!inventory.some(entry => entry.table === table && entry.columns.includes(column.name))) missing.push(`${table}.${column.name}`);
  }
  return missing.sort();
}

test('every migrated table with an account reference or personal-data column has a closure rule', () => {
  assert.deepEqual(uncovered(readMigrationSchema()), [], 'Add each listed column to src/server/account-closure-inventory.ts with a delete, scrub, cancel, tombstone or keep rule.');
});

test('the inventory names existing tables and columns, each table once', () => {
  const schema = readMigrationSchema(), seen = new Set<string>();
  for (const entry of accountClosureInventory) {
    assert.ok(!seen.has(entry.table), `${entry.table} appears twice.`); seen.add(entry.table);
    assert.ok(entry.reason.length >= 20, `${entry.table} needs a stated reason.`);
    if (entry.table === 'pgboss.job') continue;
    const columns = schema.get(entry.table);
    assert.ok(columns, `${entry.table} is not a migrated table.`);
    for (const column of entry.columns) assert.ok(columns.has(column), `${entry.table}.${column} is not a migrated column.`);
  }
});

test('each rule is implemented: statements for delete and scrub, code for cancel and tombstone, nothing for keep', () => {
  for (const entry of accountClosureInventory) {
    if (entry.rule === 'keep') { assert.equal(entry.sql, undefined, `${entry.table} is kept and must not be changed.`); continue; }
    if (appliedInCode.has(entry.table)) { assert.equal(entry.sql, undefined); assert.ok(entry.rule === 'cancel' || entry.rule === 'tombstone'); continue; }
    assert.ok(entry.sql && entry.params?.length, `${entry.table} has rule ${entry.rule} without a statement.`);
    const quoted = /[A-Z]/.test(entry.table) ? `"${entry.table}"` : entry.table;
    assert.ok(new RegExp(String.raw`\b(DELETE FROM|UPDATE)\s+${quoted.replace(/"/g, '"?')}\b`).test(entry.sql), `${entry.table}'s statement must target its own table.`);
    const highest = Math.max(...[...entry.sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
    assert.equal(highest, entry.params.length, `${entry.table} binds ${entry.params.length} parameters but uses $${highest}.`);
  }
});

test('the agreed council rules: credentials go, actor and financial rows stay unchanged', () => {
  const rule = (table: string) => accountClosureInventory.find(entry => entry.table === table)?.rule;
  for (const table of ['account', 'session', 'twoFactor', 'verification', 'api_key', 'oidc_identity', 'oidc_transaction', 'user_preference', 'membership', 'workspace_invitation', 'request_limit', 'instance_operator'])
    assert.equal(rule(table), 'delete', table);
  assert.equal(rule('user'), 'tombstone');
  assert.equal(rule('pgboss.job'), 'cancel');
  for (const table of ['provider_request', 'keyword_quote', 'prompt_execution_quote', 'ai_search_quote', 'domain_research_quote', 'rank_run', 'project_share', 'instance_operator_audit', 'account_closure_audit'])
    assert.equal(rule(table), 'keep', table);
  // Statements receive only the account id, its previous email and derived limit keys; none persists them.
  for (const entry of accountClosureInventory) assert.ok(!/INSERT|UPDATE/i.test(entry.sql ?? ''), `${entry.table} must not write new data.`);
});

test('a new personal-data table without a rule fails the coverage check', () => {
  const schema = parseMigrations([
    'CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL);',
    `CREATE TABLE note (id uuid PRIMARY KEY, author text REFERENCES "user"(id), body text, CHECK (length(body) < 10));
     CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN CREATE TABLE ignored (email text); END $$;`,
    'ALTER TABLE note ADD COLUMN contact_email text, ADD COLUMN reviewer text; ALTER TABLE note ADD CONSTRAINT note_reviewer FOREIGN KEY (reviewer) REFERENCES "user"(id);',
    'CREATE TABLE gone (user_agent text); DROP TABLE gone; ALTER TABLE note DROP COLUMN body;',
  ]);
  assert.deepEqual([...schema.keys()].sort(), ['note', 'user']);
  assert.deepEqual([...schema.get('note')!.keys()], ['id', 'author', 'contact_email', 'reviewer']);
  assert.deepEqual(uncovered(schema, [{ table: 'user', rule: 'tombstone', columns: ['name', 'email'], reason: 'The account row itself becomes the tombstone.' }]),
    ['note.author', 'note.contact_email', 'note.reviewer']);
});
