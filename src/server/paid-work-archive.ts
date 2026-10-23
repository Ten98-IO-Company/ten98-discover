import type { PoolClient } from 'pg';
import { accountClosureInventory, closedAccountLedgerDependents } from './account-closure-inventory.ts';
import { ident, readForeignKeys } from './account-closure-retention.ts';

/**
 * Paid-work archive (#292, #291; owner decision ten98-code-system#39, https://github.com/Ten98-IO-Company/ten98-discover/wiki/Accounts-and-Data#closed-account-retention).
 *
 * Receipts and the paid-work and charge ledgers must survive website and workspace deletion for 7 years from creation.
 * The deleting transaction first copies every such row of the deleted scope into `paid_work_archive`, then deletes as
 * before, so a failed copy aborts the deletion. Live project and workspace rows are never kept as tombstones, so no
 * reader has to filter deleted websites. The daily retention job removes archive rows 7 years after `created_at`.
 *
 * Only accounting fields are copied: ids, amounts, counts, flags, timestamps, statuses and input hashes. Credentials,
 * provider-account fingerprints, actor bindings, names, free text and every JSON column are left out, so the archive holds
 * no secret and no personal data beyond the opaque account ids it names.
 */

/** Financial inventory tables, then the ledger dependents that belong to them. */
export const paidWorkArchiveTables: readonly string[] = [
  ...accountClosureInventory.filter(entry => entry.retention?.class === 'financial').map(entry => entry.table),
  ...closedAccountLedgerDependents.map(dependent => dependent.table),
];

/** PostgreSQL type names (catalog `udt_name` or the migrations' declared form) that hold only an id, number, flag or time. */
const scalarTypes = new Set(['uuid', 'int2', 'int4', 'int8', 'smallint', 'integer', 'bigint', 'numeric', 'bool', 'boolean', 'date', 'timestamptz']);
/** Text columns that hold an opaque id, an enumerated state or a provider charge reference. */
const archivedText = new Set(['workspace_id', 'project_id', 'user_id', 'requested_by', 'status', 'operation', 'method', 'trigger', 'phase', 'purpose',
  'provider_reference', 'generation_id', 'provider_task_id', 'result_status', 'price_mode', 'price_source', 'price_version']);
/** Never archived whatever their type: credential-derived bindings and anything that can name a person or place. */
const excluded = /fingerprint|actor|credential|secret|token|password|name|email|(^|_)ip(_|$)|address|agent/i;

/** True when an archive record may hold this column. */
export function archivedColumn(column: string, type: string): boolean {
  if (excluded.test(column)) return false;
  if (scalarTypes.has(type)) return true;
  return type === 'text' && (archivedText.has(column) || column.endsWith('_hash'));
}

export type PaidWorkScope = { workspaceId: string; projectId?: string };

/**
 * Copies the scope's paid-work rows into the archive and returns the count per table. Call it in the deleting
 * transaction, before the first delete. A website scope copies every table with a `project_id`; the workspace-level
 * `provider_request` ledger survives website deletion and is copied with its workspace. Idempotent per source row.
 */
export async function archivePaidWork(client: PoolClient, scope: PaidWorkScope): Promise<Record<string, number>> {
  const columns = (await client.query<{ table_name: string; column_name: string; udt_name: string }>(
    `SELECT table_name::text, column_name::text, udt_name::text FROM information_schema.columns
     WHERE table_schema=current_schema() AND table_name=ANY($1::text[]) ORDER BY table_name, ordinal_position`, [paidWorkArchiveTables])).rows;
  const byTable = new Map<string, { name: string; type: string }[]>();
  for (const row of columns) byTable.set(row.table_name, [...byTable.get(row.table_name) ?? [], { name: row.column_name, type: row.udt_name }]);
  const keys = await readForeignKeys(client);
  const counts: Record<string, number> = {};
  for (const table of paidWorkArchiveTables) {
    const shape = byTable.get(table);
    if (!shape) throw new Error('Paid-work archive schema is incomplete.');
    const has = (name: string) => shape.some(column => column.name === name);
    if (scope.projectId !== undefined && !has('project_id')) continue;
    const accounts = accountClosureInventory.find(entry => entry.table === table)?.retention?.accountColumns ?? [];
    // A dependent without its own created_at takes its parent's, so it ages out with the entry it belongs to.
    let created = 't.created_at';
    if (!has('created_at')) {
      const parent = closedAccountLedgerDependents.find(dependent => dependent.table === table)!.parent;
      const key = keys.find(k => k.child === table && k.parent === parent);
      if (!key) throw new Error('Paid-work archive schema is incomplete.');
      created = `(SELECT p.created_at FROM ${ident(parent)} p WHERE ${key.parentColumns.map((column, i) => `p.${ident(column)}=t.${ident(key.childColumns[i])}`).join(' AND ')})`;
    }
    const result = await client.query(
      `INSERT INTO paid_work_archive(source_table,source_id,workspace_id,project_id,account_ids,record,created_at)
       SELECT $3, t.id, t.workspace_id, ${has('project_id') ? 't.project_id' : 'NULL'},
         array_remove(ARRAY[${accounts.map(column => `t.${ident(column)}`).join(',')}]::text[], NULL),
         (SELECT jsonb_object_agg(f.key, f.value) FROM jsonb_each(to_jsonb(t)) f WHERE f.key=ANY($4::text[])), ${created}
       FROM ${ident(table)} t WHERE t.workspace_id=$1 AND ${has('project_id') ? '($2::text IS NULL OR t.project_id=$2)' : '$2::text IS NULL'}
       ON CONFLICT (source_table, source_id) DO NOTHING`,
      [scope.workspaceId, scope.projectId ?? null, table, shape.filter(column => archivedColumn(column.name, column.type)).map(column => column.name)]);
    counts[table] = result.rowCount ?? 0;
  }
  return counts;
}

export type PaidWorkArchiveRow = { sourceTable: string; sourceId: string; workspaceId: string; projectId: string | null; accountIds: string[]; createdAt: string; archivedAt: string; record: Record<string, unknown> };

/** Archived rows of a workspace, or of one of its deleted websites, oldest first, in pages of `pageRows`. */
export async function* exportPaidWorkArchive(client: PoolClient, scope: PaidWorkScope, pageRows = 1000): AsyncGenerator<PaidWorkArchiveRow> {
  let cursor: [string, string, string] = ['-infinity', '', '00000000-0000-0000-0000-000000000000'];
  for (;;) {
    const rows = (await client.query<{ source_table: string; source_id: string; workspace_id: string; project_id: string | null; account_ids: string[]; created_at: string; archived_at: string; record: Record<string, unknown> }>(
      // Text keeps the full microsecond precision of the keyset cursor.
      `SELECT source_table, source_id::text, workspace_id, project_id, account_ids, created_at::text, archived_at::text, record FROM paid_work_archive
       WHERE workspace_id=$1 AND ($2::text IS NULL OR project_id=$2) AND (created_at, source_table COLLATE "C", source_id) > ($3::timestamptz, $4 COLLATE "C", $5::uuid)
       ORDER BY created_at, source_table COLLATE "C", source_id LIMIT $6`, [scope.workspaceId, scope.projectId ?? null, ...cursor, pageRows])).rows;
    for (const row of rows) yield { sourceTable: row.source_table, sourceId: row.source_id, workspaceId: row.workspace_id, projectId: row.project_id, accountIds: row.account_ids, createdAt: row.created_at, archivedAt: row.archived_at, record: row.record };
    if (rows.length < pageRows) return;
    const last = rows.at(-1)!;
    cursor = [last.created_at, last.source_table, last.source_id];
  }
}
