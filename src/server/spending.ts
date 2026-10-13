import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { providerTransaction, usdMicros, moneyInput } from './providers.ts';

const reservationInput = z.object({ connectionId: z.uuid(), requestKey: z.uuid(), operation: z.string().regex(/^[a-z][a-z0-9_.:-]{0,119}$/),
  estimateUsd: moneyInput.refine(value => usdMicros(value) > 0n), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const actualInput = z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/);
export function requestHash(canonicalInput: string) { return createHash('sha256').update(canonicalInput).digest('hex'); }

type LedgerRow = { id: string; workspace_id: string; connection_id: string; connection_revision: number; user_id: string; operation: string; input_hash: string; estimate_micros: string; actual_micros: string | null; status: 'reserved'|'dispatched'|'uncertain'|'settled'|'cancelled'; budget_month: string; provider_reference: string | null };

async function checkBudget(client: PoolClient, workspaceId: string, connectionId: string, amount: bigint, except?: string) {
  // Capture the month after acquiring the workspace lock, not at transaction start before a possible wait.
  const budget = (await client.query("SELECT *,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-01') AS month FROM workspace_budget WHERE workspace_id=$1", [workspaceId])).rows[0];
  const connection = (await client.query('SELECT monthly_limit_micros,revoked_at,revision FROM provider_connection WHERE id=$1 AND workspace_id=$2', [connectionId, workspaceId])).rows[0];
  if (!connection || connection.revoked_at) throw new FoundationError(404, 'Provider connection is unavailable.');
  if (!budget || budget.paused) throw new FoundationError(409, 'Provider spending is paused. An owner must configure and enable limits.');
  const totals = (await client.query(`SELECT
    COALESCE(sum(CASE WHEN status='settled' THEN actual_micros ELSE estimate_micros END),0)::text AS workspace,
    COALESCE(sum(CASE WHEN status='settled' THEN actual_micros ELSE estimate_micros END) FILTER(WHERE connection_id=$2),0)::text AS connection,
    count(*) FILTER(WHERE status='uncertain')::int AS uncertain
    FROM provider_request WHERE workspace_id=$1 AND status<>'cancelled' AND ($3::uuid IS NULL OR id<>$3)
      AND (budget_month=$4::date OR status IN ('reserved','dispatched','uncertain'))`, [workspaceId, connectionId, except ?? null, budget.month])).rows[0];
  if (totals.uncertain) throw new FoundationError(409, 'An earlier request has an uncertain charge. Reconcile it before spending again.');
  if (BigInt(totals.workspace) + amount > BigInt(budget.monthly_limit_micros) || BigInt(totals.connection) + amount > BigInt(connection.monthly_limit_micros)) {
    throw new FoundationError(409, 'The estimated cost exceeds a workspace or connection budget.');
  }
  return { revision: connection.revision as number, month: budget.month as string };
}

// Internal server contract only: callers quote a conservative ceiling under the provider's verified
// billing contract and enqueue work in the same transaction. Reported overruns still pause spending.
// No browser/API endpoint accepts a caller-supplied estimate as authorization to spend.
export async function reserveSpend(workspaceId: string, userId: string, input: unknown, enqueue?: (client: PoolClient, requestId: string) => Promise<void>) {
  const data = reservationInput.parse(input);
  return providerTransaction(workspaceId, userId, ['owner','admin','editor'], client => reserveSpendInTransaction(client, workspaceId, userId, data, enqueue));
}

// Caller must already hold the workspace mutation gate and recheck the live user's write role.
// This lets a comparison reserve every child atomically without nested transactions.
export async function reserveSpendInTransaction(client: PoolClient, workspaceId: string, userId: string, input: unknown, enqueue?: (client: PoolClient, requestId: string) => Promise<void>) {
  const data = reservationInput.parse(input);
  const existing = (await client.query<LedgerRow>('SELECT * FROM provider_request WHERE workspace_id=$1 AND request_key=$2', [workspaceId, data.requestKey])).rows[0];
  if (existing) {
    if (existing.connection_id !== data.connectionId || existing.user_id !== userId || existing.operation !== data.operation || existing.input_hash !== data.inputHash || existing.estimate_micros !== usdMicros(data.estimateUsd).toString()) throw new FoundationError(409, 'This request key was already used for different work.');
    return { id: existing.id, status: existing.status, created: false };
  }
  const { revision, month } = await checkBudget(client, workspaceId, data.connectionId, usdMicros(data.estimateUsd));
  const id = randomUUID();
  await client.query(`INSERT INTO provider_request(id,workspace_id,connection_id,user_id,request_key,operation,input_hash,estimate_micros,connection_revision,status,budget_month)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',$10::date)`, [id, workspaceId, data.connectionId, userId, data.requestKey, data.operation, data.inputHash, usdMicros(data.estimateUsd).toString(), revision, month]);
  if (enqueue) await enqueue(client, id);
  return { id, status: 'reserved' as const, created: true };
}

export async function dispatchSpend(workspaceId: string, userId: string, requestId: string, prepare?: (client: PoolClient, row: LedgerRow) => Promise<void>) {
  z.uuid().parse(requestId);
  return providerTransaction(workspaceId, userId, ['owner','admin','editor'], async client => {
    const row = (await client.query<LedgerRow>('SELECT * FROM provider_request WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [requestId, workspaceId])).rows[0];
    if (!row || row.user_id !== userId) throw new FoundationError(404, 'Provider request is unavailable.');
    if (row.status !== 'reserved') throw new FoundationError(409, 'This request has already been dispatched or cancelled. Reconcile it before retrying.');
    const { revision, month } = await checkBudget(client, workspaceId, row.connection_id, BigInt(row.estimate_micros), row.id);
    if (revision !== row.connection_revision) throw new FoundationError(409, 'Provider credentials changed. Cancel this reservation and request a new quote.');
    // Optional execution-specific validation shares this authorization/budget transaction.
    if (prepare) await prepare(client, row);
    // Persist dispatch BEFORE the network call. An interrupted dispatch must never be replayed automatically.
    await client.query("UPDATE provider_request SET status='dispatched',budget_month=$2::date,updated_at=now() WHERE id=$1", [requestId, month]);
    return row;
  });
}

// Requires an open transaction so job results and charges commit together. Worker settlement is independent
// of the initiating user's later role, so revocation cannot hide an incurred charge.
export async function settleSpend(client: PoolClient, workspaceId: string, requestId: string, actualUsd: string | null, providerReference: string | null = null) {
  z.uuid().parse(workspaceId); z.uuid().parse(requestId);
  if (providerReference !== null) z.string().min(1).max(512).parse(providerReference);
  const [whole, fraction = ''] = actualUsd === null ? [] : actualInput.parse(actualUsd).split('.');
  const reported = whole === undefined ? null : BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  // The current ledger stores at most $1M per charge. Keep larger reports uncertain and block spending;
  // callers must persist provider evidence and inspect this outcome before treating a job as settled.
  const actual = reported === null || reported > 1_000_000_000_000n ? null : reported.toString();
  const outcome = { status: actual === null ? 'uncertain' as const : 'settled' as const, reconciliationRequired: actual === null, reportedAmount: actualUsd };
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspaceId]);
  const row = (await client.query<LedgerRow>('SELECT * FROM provider_request WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [requestId, workspaceId])).rows[0];
  if (!row) throw new FoundationError(404, 'Provider request is unavailable.');
  const reference = providerReference ?? row.provider_reference;
  if (row.status === 'settled') {
    if (row.actual_micros !== actual || row.provider_reference !== reference) throw new FoundationError(409, 'The recorded charge differs from this settlement.');
    return outcome;
  }
  if (!['dispatched','uncertain'].includes(row.status)) throw new FoundationError(409, 'Only a dispatched request can be settled.');
  await client.query('UPDATE provider_request SET actual_micros=$2,status=$3,provider_reference=$4,updated_at=now() WHERE id=$1', [requestId, actual, outcome.status, reference]);
  if (actual === null || BigInt(actual) > BigInt(row.estimate_micros)) await client.query('UPDATE workspace_budget SET paused=true,updated_at=now() WHERE workspace_id=$1', [workspaceId]);
  return outcome;
}

export async function cancelReservation(workspaceId: string, userId: string, requestId: string) {
  z.uuid().parse(requestId);
  return providerTransaction(workspaceId, userId, ['owner','admin','editor'], async (client, role) => {
    const result = await client.query("UPDATE provider_request SET status='cancelled',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND (user_id=$3 OR $4::boolean) AND status='reserved' RETURNING id", [requestId, workspaceId, userId, role === 'owner']);
    if (!result.rowCount) throw new FoundationError(409, 'Only an undispatched request can be cancelled without reconciliation.');
  });
}
