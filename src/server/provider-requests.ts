import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { providerTransaction } from './providers.ts';

const requestInput = z.object({ connectionId: z.uuid(), requestKey: z.uuid(), operation: z.string().regex(/^[a-z][a-z0-9_.:-]{0,119}$/), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const outcomeInput = z.object({ known: z.boolean(), providerReference: z.string().min(1).max(512).nullable().optional() }).strict();
export function requestHash(canonicalInput: string) { return createHash('sha256').update(canonicalInput).digest('hex'); }

type RequestRow = { id: string; workspace_id: string; connection_id: string; connection_revision: number; user_id: string; operation: string; input_hash: string; status: 'reserved' | 'dispatched' | 'uncertain' | 'settled' | 'cancelled'; provider_reference: string | null };
const requestColumns = 'id,workspace_id,connection_id,connection_revision,user_id,operation,input_hash,status,provider_reference';

async function requestGate(client: PoolClient, workspaceId: string, connectionId: string) {
  const connection = (await client.query('SELECT revoked_at,revision FROM provider_connection WHERE id=$1 AND workspace_id=$2', [connectionId, workspaceId])).rows[0];
  if (!connection || connection.revoked_at) throw new FoundationError(404, 'Provider connection is unavailable.');
  const control = (await client.query('SELECT COALESCE((SELECT paused FROM workspace_provider_control WHERE workspace_id=$1),false) AS paused', [workspaceId])).rows[0];
  if (control.paused) throw Object.assign(new FoundationError(409, 'Provider requests are paused. An owner can enable them in Connections.'), { code: 'PROVIDER_REQUESTS_PAUSED' });
  return connection.revision as number;
}

export async function reserveRequest(workspaceId: string, userId: string, input: unknown, enqueue?: (client: PoolClient, requestId: string) => Promise<void>) {
  const data = requestInput.parse(input);
  return providerTransaction(workspaceId, userId, ['owner', 'admin', 'editor'], client => reserveRequestInTransaction(client, workspaceId, userId, data, enqueue));
}

// The caller holds the workspace mutation lock and has checked the current actor's write role.
export async function reserveRequestInTransaction(client: PoolClient, workspaceId: string, userId: string, input: unknown, enqueue?: (client: PoolClient, requestId: string) => Promise<void>) {
  const data = requestInput.parse(input);
  const existing = (await client.query<RequestRow>(`SELECT ${requestColumns} FROM provider_request WHERE workspace_id=$1 AND request_key=$2`, [workspaceId, data.requestKey])).rows[0];
  if (existing) {
    if (existing.connection_id !== data.connectionId || existing.user_id !== userId || existing.operation !== data.operation || existing.input_hash !== data.inputHash) throw new FoundationError(409, 'This request key was already used for different work.');
    return { id: existing.id, status: existing.status, created: false };
  }
  const revision = await requestGate(client, workspaceId, data.connectionId), id = randomUUID();
  await client.query(`INSERT INTO provider_request(id,workspace_id,connection_id,user_id,request_key,operation,input_hash,connection_revision,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved')`, [id, workspaceId, data.connectionId, userId, data.requestKey, data.operation, data.inputHash, revision]);
  if (enqueue) await enqueue(client, id);
  return { id, status: 'reserved' as const, created: true };
}

export async function dispatchRequest(workspaceId: string, userId: string, requestId: string, prepare?: (client: PoolClient, row: RequestRow) => Promise<void>, deadline?: '5s') {
  z.uuid().parse(requestId);
  return providerTransaction(workspaceId, userId, ['owner', 'admin', 'editor'], async client => {
    const row = (await client.query<RequestRow>(`SELECT ${requestColumns} FROM provider_request WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [requestId, workspaceId])).rows[0];
    if (!row || row.user_id !== userId) throw new FoundationError(404, 'Provider request is unavailable.');
    if (row.status !== 'reserved') throw new FoundationError(409, 'This request has already been dispatched or cancelled. Recover the original request before retrying.');
    const revision = await requestGate(client, workspaceId, row.connection_id);
    if (revision !== row.connection_revision) throw new FoundationError(409, 'Provider credentials changed. Cancel this request and run again.');
    if (prepare) await prepare(client, row);
    // Commit the fence before network access: interruption must never resend an ambiguous request.
    await client.query("UPDATE provider_request SET status='dispatched',updated_at=now() WHERE id=$1", [requestId]);
    return row;
  }, deadline);
}

// Commit outcome state and feature results together, even if the initiating actor later loses access.
export async function settleRequest(client: PoolClient, workspaceId: string, requestId: string, input: { known: boolean; providerReference?: string | null }) {
  z.uuid().parse(workspaceId); z.uuid().parse(requestId);
  const data = outcomeInput.parse(input);
  const outcome = { status: data.known ? 'settled' as const : 'uncertain' as const, recoveryRequired: !data.known };
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspaceId]);
  const row = (await client.query<RequestRow>(`SELECT ${requestColumns} FROM provider_request WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [requestId, workspaceId])).rows[0];
  if (!row) throw new FoundationError(404, 'Provider request is unavailable.');
  const reference = data.providerReference ?? row.provider_reference;
  if (row.status === 'settled') {
    if (!data.known || row.provider_reference !== reference) throw new FoundationError(409, 'The recorded provider outcome differs from this update.');
    return outcome;
  }
  if (!['dispatched', 'uncertain'].includes(row.status)) throw new FoundationError(409, 'Only a dispatched request can record a provider outcome.');
  await client.query('UPDATE provider_request SET status=$2,provider_reference=$3,updated_at=now() WHERE id=$1', [requestId, outcome.status, reference]);
  return outcome;
}

export async function cancelRequest(workspaceId: string, userId: string, requestId: string) {
  z.uuid().parse(requestId);
  return providerTransaction(workspaceId, userId, ['owner', 'admin', 'editor'], async (client, role) => {
    const result = await client.query("UPDATE provider_request SET status='cancelled',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND (user_id=$3 OR $4::boolean) AND status='reserved' RETURNING id", [requestId, workspaceId, userId, role === 'owner']);
    if (!result.rowCount) throw new FoundationError(409, 'Only an undispatched request can be cancelled without recovery.');
  });
}
