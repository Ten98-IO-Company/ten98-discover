import type { PoolClient } from 'pg';
import { getDatabase } from './db.ts';
import { accountClosureInventory, closedAccountLedgerDependents, closedAccountRetentionInterval, type ClosedAccountRetention } from './account-closure-inventory.ts';

/**
 * Closed-account retention (https://github.com/Ten98-IO-Company/ten98-discover/wiki/Accounts-and-Data#closed-account-retention, owner decision ten98-code-system#39, closes #291).
 *
 * A daily job deletes financial and audit rows that name only closed accounts once they are 7 years past `created_at`,
 * then deletes closed `user` tombstones that nothing references any more. Rows of open accounts are never candidates.
 *
 * Each batch runs in one transaction: pick the oldest eligible rows per table (locked, SKIP LOCKED), pull in the rows of
 * the same ledger entry along foreign keys between the aged-out tables, drop every candidate that a retained row still
 * references (or, for receipts, that references a retained receipt) until the set is closed, then delete the whole set in
 * one statement so NO ACTION foreign keys, including the prompt occurrence/quote/comparison cycle, are checked once at
 * its end. The foreign-key graph comes from the live catalog, so a new reference keeps rows instead of failing.
 * ponytail: the candidate and reference lookups have no dedicated (account column, created_at) indexes; they scan
 * ledger tables once a day under a statement timeout. Upgrade path: an additive index migration if runs grow slow.
 */
export const accountClosureRetentionQueue = 'account-closure-retention';
/** Daily, 03:17 UTC; pg-boss sends one job per occurrence across workers. */
export const accountClosureRetentionCron = '17 3 * * *';
/**
 * `batchRows`: most rows picked per batch (it halves after a batch overflows and recovers after a successful one);
 * `runRows`: most rows deleted per run, pulled-in ledger rows and tombstones included; `batchMs` and `ledgerMs` bound
 * one batch and the whole ledger pass. The worst case (ledger pass, last batch, tombstone pass) stays well under the
 * job expiry below.
 */
export const accountClosureRetentionLimits = { batchRows: 1000, runRows: 20_000, batches: 200, batchMs: 120_000, ledgerMs: 20 * 60_000 } as const;
export type ClosedAccountRetentionLimits = { -readonly [K in keyof typeof accountClosureRetentionLimits]: number };
/** A slow run is never retried while it is still running: one attempt, expiring after an hour. */
export const accountClosureRetentionJobOptions = { tz: 'UTC', retryLimit: 0, expireInSeconds: 3600 } as const;

export type RetentionForeignKey = { child: string; childColumns: readonly string[]; parent: string; parentColumns: readonly string[] };
export type RetentionTarget = {
  table: string;
  /** Empty for ledger dependents, which age out only with `parent`. */
  accountColumns: readonly string[];
  eligibleWhen?: string;
  retainsReferencingRows?: boolean;
  parent?: string;
};
export type AccountReference = { table: string; column: string };
export type ClosedAccountRetentionSummary = {
  deleted: Record<string, number>; tombstones: number; batches: number;
  /** More eligible rows remain for a later run. */
  capped: boolean;
  /** Ledger entries passed over in this run because they alone overflowed the cap or the time bounds. */
  skipped: number;
  /** The ledger or tombstone pass stopped on an unexpected database error; the other pass still ran. */
  ledgerFailed: boolean; tombstonesFailed: boolean;
};

const candidates = 'pg_temp.closure_retention_candidate';
export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const join = (a: string, aColumns: readonly string[], b: string, bColumns: readonly string[]) =>
  aColumns.map((column, i) => `${a}.${ident(column)}=${b}.${ident(bColumns[i])}`).join(' AND ');
const isCandidate = (table: string, alias: string) => `EXISTS (SELECT 1 FROM ${candidates} k WHERE k.tbl=${literal(table)} AND k.row_id=${alias}.ctid)`;

/** Financial and audit tables in inventory order, then ledger dependents. */
export function retentionTargets(): RetentionTarget[] {
  const aged = (retention?: ClosedAccountRetention) => retention && retention.class !== 'workspace';
  return [
    ...accountClosureInventory.filter(entry => aged(entry.retention)).map(({ table, retention }) => ({
      // An audit row's closed subject alone decides; a financial row needs every account column closed.
      table, accountColumns: retention!.subjectColumn ? [retention!.subjectColumn] : retention!.accountColumns, eligibleWhen: retention!.eligibleWhen, retainsReferencingRows: retention!.retainsReferencingRows,
    })),
    ...closedAccountLedgerDependents.map(({ table, parent }) => ({ table, parent, accountColumns: [] })),
  ];
}

/** Every column that can name an account: catalog foreign keys to "user" plus the inventory's declared account columns. */
export function accountReferences(foreignKeys: readonly RetentionForeignKey[]): AccountReference[] {
  const seen = new Map<string, AccountReference>();
  for (const key of foreignKeys) if (key.parent === 'user' && key.childColumns.length === 1) seen.set(`${key.child}.${key.childColumns[0]}`, { table: key.child, column: key.childColumns[0] });
  for (const entry of accountClosureInventory) for (const column of entry.retention?.accountColumns ?? []) seen.set(`${entry.table}.${column}`, { table: entry.table, column });
  return [...seen.values()];
}

/** True when the row `t` names a closed account in at least one account column and an open account in none. */
export function closedOnlySql(columns: readonly string[]): string {
  const closed = (column: string) => `EXISTS (SELECT 1 FROM "user" u WHERE u.id=t.${ident(column)} AND u.closed_at IS NOT NULL)`;
  return `(${columns.map(column => `t.${ident(column)} IS NOT NULL`).join(' OR ')}) AND ${columns.map(column => `(t.${ident(column)} IS NULL OR ${closed(column)})`).join(' AND ')}`;
}

/** Aged, closed-only rows of a financial or audit table after the keyset cursor. $1 cutoff, $2/$3 cursor, $4 limit. */
export function selectRootsSql(target: RetentionTarget): string {
  return `SELECT t.ctid::text AS row_id, t.created_at::text AS created_at FROM ${ident(target.table)} t
    WHERE t.created_at < $1::timestamptz AND (t.created_at, t.ctid) > ($2::timestamptz, $3::tid) AND ${closedOnlySql(target.accountColumns)}${target.eligibleWhen ? ` AND (${target.eligibleWhen})` : ''}
    ORDER BY t.created_at, t.ctid LIMIT $4 FOR UPDATE OF t SKIP LOCKED`;
}

function eligibleSql(target: RetentionTarget): string {
  // Dependents follow their parent; $1 stays referenced so every expansion statement binds the same parameter.
  if (!target.accountColumns.length) return '$1::timestamptz IS NOT NULL';
  return `t.created_at < $1::timestamptz AND ${closedOnlySql(target.accountColumns)}${target.eligibleWhen ? ` AND (${target.eligibleWhen})` : ''}`;
}

/** Foreign keys whose child and parent are both aged-out tables. */
const internalKeys = (targets: readonly RetentionTarget[], keys: readonly RetentionForeignKey[]) => {
  const names = new Set(targets.map(target => target.table));
  return keys.filter(key => names.has(key.child) && names.has(key.parent) && key.child !== key.parent);
};

/**
 * Pull in eligible rows of the same ledger entry, both up and down each internal foreign key. $1 cutoff, $2 the most
 * rows one statement may add (what is left of the cap plus one, so an overflow is detected without fetching it all).
 */
export function expandSql(targets: readonly RetentionTarget[], keys: readonly RetentionForeignKey[]): string[] {
  const byName = new Map(targets.map(target => [target.table, target]));
  return internalKeys(targets, keys).flatMap(key => {
    const step = (add: RetentionTarget, from: string, addColumns: readonly string[], fromColumns: readonly string[]) =>
      `WITH added AS (SELECT t.ctid AS row_id FROM ${ident(add.table)} t JOIN ${ident(from)} f ON ${join('t', addColumns, 'f', fromColumns)}
        WHERE ${isCandidate(from, 'f')} AND NOT ${isCandidate(add.table, 't')} AND ${eligibleSql(add)} LIMIT $2::int FOR UPDATE OF t SKIP LOCKED)
      INSERT INTO ${candidates}(tbl,row_id) SELECT ${literal(add.table)}, row_id FROM added ON CONFLICT DO NOTHING`;
    return [step(byName.get(key.parent)!, key.child, key.parentColumns, key.childColumns), step(byName.get(key.child)!, key.parent, key.childColumns, key.parentColumns)];
  });
}

/**
 * Remove candidates that must stay: a row still referenced by any retained row (any table, any foreign key), and a row
 * referencing a retained receipt or, for a dependent, its retained parent. Repeated until nothing changes.
 */
export function pruneSql(targets: readonly RetentionTarget[], keys: readonly RetentionForeignKey[]): string[] {
  const byName = new Map(targets.map(target => [target.table, target]));
  const referenced = keys.filter(key => byName.has(key.parent)).map(key =>
    `DELETE FROM ${candidates} x USING ${ident(key.parent)} p WHERE x.tbl=${literal(key.parent)} AND x.row_id=p.ctid
      AND EXISTS (SELECT 1 FROM ${ident(key.child)} c WHERE ${join('c', key.childColumns, 'p', key.parentColumns)}${byName.has(key.child) ? ` AND NOT ${isCandidate(key.child, 'c')}` : ''})`);
  const together = internalKeys(targets, keys)
    .filter(key => byName.get(key.parent)!.retainsReferencingRows || byName.get(key.child)!.parent === key.parent)
    .map(key => `DELETE FROM ${candidates} x USING ${ident(key.child)} c WHERE x.tbl=${literal(key.child)} AND x.row_id=c.ctid
      AND EXISTS (SELECT 1 FROM ${ident(key.parent)} p WHERE ${join('c', key.childColumns, 'p', key.parentColumns)} AND NOT ${isCandidate(key.parent, 'p')})`);
  return [...referenced, ...together];
}

/** One statement deletes every remaining candidate and returns the count per table. */
export function deleteSql(targets: readonly RetentionTarget[]): string {
  const steps = targets.map((target, i) => `d${i} AS (DELETE FROM ${ident(target.table)} t USING ${candidates} k WHERE k.tbl=${literal(target.table)} AND t.ctid=k.row_id RETURNING 1)`);
  return `WITH ${steps.join(',\n  ')}\n  SELECT ${targets.map((target, i) => `(SELECT count(*) FROM d${i})::int AS ${ident(target.table)}`).join(', ')}`;
}

/** Closed tombstones no row references any more, oldest closure first. $1 limit. */
export function tombstoneSql(references: readonly AccountReference[]): string {
  const unreferenced = references.map(ref => `NOT EXISTS (SELECT 1 FROM ${ident(ref.table)} r WHERE r.${ident(ref.column)}=v.id)`).join('\n      AND ');
  return `DELETE FROM "user" u WHERE u.id IN (SELECT v.id FROM "user" v WHERE v.closed_at IS NOT NULL
      AND ${unreferenced}
    ORDER BY v.closed_at, v.id LIMIT $1 FOR UPDATE SKIP LOCKED)`;
}

async function readForeignKeys(client: PoolClient): Promise<RetentionForeignKey[]> {
  const columns = (key: string, relation: string) => `ARRAY(SELECT a.attname::text FROM unnest(k.${key}) WITH ORDINALITY o(n,i)
    JOIN pg_attribute a ON a.attrelid=k.${relation} AND a.attnum=o.n ORDER BY o.i)`;
  return (await client.query<{ child: string; parent: string; child_columns: string[]; parent_columns: string[] }>(
    `SELECT cc.relname::text AS child, pc.relname::text AS parent, ${columns('conkey', 'conrelid')} AS child_columns, ${columns('confkey', 'confrelid')} AS parent_columns
     FROM pg_constraint k JOIN pg_class cc ON cc.oid=k.conrelid JOIN pg_class pc ON pc.oid=k.confrelid
     WHERE k.contype='f' AND k.conparentid=0 AND cc.relnamespace=current_schema()::text::regnamespace AND pc.relnamespace=current_schema()::text::regnamespace`))
    .rows.map(row => ({ child: row.child, parent: row.parent, childColumns: row.child_columns, parentColumns: row.parent_columns }));
}

type Cursor = { createdAt: string; rowId: string };

/** A batch that would exceed the cap or its time bound: retried smaller, or its single entry skipped for this run. */
class BatchOverflow extends Error {}
/** Statement timeout and lock timeout are bounded-work signals, not failures of the job. */
const overflowed = (error: unknown) => error instanceof BatchOverflow || ['57014', '55P03'].includes((error as { code?: string })?.code ?? '');

/**
 * Runs one bounded pass. At most `runRows` rows (ledger, audit and tombstones together) are deleted per run and at most
 * `batchRows` rows are picked per batch; whatever remains waits for the next daily run. The tombstone pass runs even
 * when the ledger pass fails. Returns counts and flags only.
 */
export async function runClosedAccountRetention(options: Partial<ClosedAccountRetentionLimits> = {}): Promise<ClosedAccountRetentionSummary> {
  const limits: ClosedAccountRetentionLimits = { ...accountClosureRetentionLimits, ...options };
  const targets = retentionTargets();
  const summary: ClosedAccountRetentionSummary = {
    deleted: Object.fromEntries(targets.map(target => [target.table, 0])), tombstones: 0, batches: 0, capped: false, skipped: 0, ledgerFailed: false, tombstonesFailed: false,
  };
  const client = await getDatabase().pool.connect();
  try {
    const keys = await readForeignKeys(client);
    const missing = await client.query('SELECT 1 FROM unnest($1::text[]) t WHERE to_regclass(quote_ident(t)) IS NULL', [targets.map(target => target.table)]);
    if (missing.rowCount) throw new Error('Closed-account retention schema is incomplete.');
    let remaining = limits.runRows;
    try { remaining = await ledgerPass(client, limits, targets, keys, summary); }
    catch { summary.ledgerFailed = true; }
    const tombstones = tombstoneSql(accountReferences(keys));
    while (remaining > 0) {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='1s'");
        const limit = Math.min(limits.batchRows, remaining);
        const removed = (await client.query(tombstones, [limit])).rowCount ?? 0;
        await client.query('COMMIT');
        summary.tombstones += removed;
        remaining -= removed;
        if (removed < limit) break;
      } catch {
        await client.query('ROLLBACK').catch(() => undefined);
        summary.tombstonesFailed = true;
        break;
      }
    }
    if (remaining <= 0) summary.capped = true;
    return summary;
  } finally {
    client.release();
  }
}

/** Ages out financial and audit rows; returns what is left of the run cap. */
async function ledgerPass(client: PoolClient, limits: ClosedAccountRetentionLimits, targets: RetentionTarget[], keys: RetentionForeignKey[], summary: ClosedAccountRetentionSummary): Promise<number> {
  const cutoff = (await client.query<{ cutoff: string }>(`SELECT (now() - interval ${literal(closedAccountRetentionInterval)})::text AS cutoff`)).rows[0].cutoff;
  const expand = expandSql(targets, keys), prune = pruneSql(targets, keys), remove = deleteSql(targets);
  const roots = targets.filter(target => target.accountColumns.length);
  const cursors = new Map<string, Cursor | null>(roots.map(target => [target.table, { createdAt: '-infinity', rowId: '(0,0)' }]));
  const ledgerDeadline = Date.now() + limits.ledgerMs;
  // `budget` bounds the rows picked per batch: it halves after an overflow and doubles back after a successful batch.
  let remaining = limits.runRows, budget = limits.batchRows;
  while (remaining > 0 && summary.batches < limits.batches && [...cursors.values()].some(Boolean)) {
    if (Date.now() > ledgerDeadline) { summary.capped = true; break; }
    const batchDeadline = Date.now() + limits.batchMs;
    const query = <R extends object = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (Date.now() > batchDeadline) throw new BatchOverflow();
      return client.query<R>(sql, params);
    };
    const next = new Map(cursors);
    let picked = 0, selecting: string | null = null;
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='1s'");
      await client.query(`CREATE TEMP TABLE ${candidates.slice('pg_temp.'.length)} (tbl text NOT NULL, row_id tid NOT NULL, PRIMARY KEY (tbl,row_id)) ON COMMIT DROP`);
      for (const target of roots) {
        const cursor = cursors.get(target.table);
        const limit = Math.min(budget, remaining) - picked;
        if (!cursor || limit <= 0) continue;
        selecting = target.table;
        // Text keeps the full microsecond precision of the keyset cursor.
        const rows = (await query<{ row_id: string; created_at: string }>(selectRootsSql(target), [cutoff, cursor.createdAt, cursor.rowId, limit])).rows;
        selecting = null;
        const last = rows.at(-1);
        next.set(target.table, rows.length < limit ? null : { createdAt: last!.created_at, rowId: last!.row_id });
        if (!rows.length) continue;
        picked += rows.length;
        await query(`INSERT INTO ${candidates}(tbl,row_id) SELECT $1, unnest($2::tid[]) ON CONFLICT DO NOTHING`, [target.table, rows.map(row => row.row_id)]);
      }
      // Pulled-in rows count against the cap as they arrive, so a huge ledger entry stops early instead of timing out.
      let count = picked;
      for (let pass = 0, added = 1; added && pass < 20; pass++) {
        added = 0;
        for (const sql of expand) {
          const n = (await query(sql, [cutoff, remaining - count + 1])).rowCount ?? 0;
          added += n; count += n;
          if (count > remaining) throw new BatchOverflow();
        }
      }
      for (let pass = 0, removed = 1; removed && pass < 50; pass++) {
        removed = 0;
        for (const sql of prune) removed += (await query(sql)).rowCount ?? 0;
      }
      count = Number((await query<{ count: string }>(`SELECT count(*) FROM ${candidates}`)).rows[0].count);
      const deleted = count ? (await query<Record<string, number>>(remove)).rows[0] : {};
      await client.query('COMMIT');
      summary.batches++;
      for (const [table, n] of Object.entries(deleted)) summary.deleted[table] += n;
      remaining -= count;
      for (const [table, cursor] of next) cursors.set(table, cursor);
      budget = Math.min(limits.batchRows, budget * 2);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (!overflowed(error)) throw error;
      summary.capped = true;
      summary.batches++;
      if (picked > 1) { budget = Math.max(1, Math.floor(picked / 2)); continue; }
      // ponytail: a single entry larger than what is left of the cap, or too slow for one batch, is passed over for this
      // run; one larger than the whole cap is never aged out. Upgrade path: delete its dependents across batches.
      summary.skipped++;
      for (const [table, cursor] of next) cursors.set(table, cursor);
      if (selecting) cursors.set(selecting, null);
    }
  }
  if (remaining <= 0 && [...cursors.values()].some(Boolean)) summary.capped = true;
  return remaining;
}
