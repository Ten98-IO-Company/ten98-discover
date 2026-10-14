import { randomUUID } from 'node:crypto';
import { toUSVString } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';
import { credentialKeys, decryptCredentials, encryptCredentials } from './credential-vault.ts';

export const moneyInput = z.string().regex(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/).pipe(z.string().refine(value => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0')) <= 1_000_000_000_000n;
}, 'Use a USD amount from 0 to 1,000,000 with at most six decimal places.'));
export function usdMicros(value: string): bigint {
  const [whole, fraction = ''] = moneyInput.parse(value).split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
export function usd(value: string | bigint | number): string {
  const amount = BigInt(value);
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, '0')}`;
}
const providerInput = z.enum(['openrouter', 'dataforseo']);
const credentialsInput = {
  openrouter: z.object({ apiKey: z.string().min(1).max(4096).regex(/^[^\s]+$/) }).strict(),
  dataforseo: z.object({ login: z.string().trim().email().max(254), password: z.string().min(1).max(4096).refine(value=>toUSVString(value)===value&&!/[\x00-\x1f\x7f]/.test(value)) }).strict(),
};
const createInput = z.object({ name: z.string().trim().min(1).max(120), provider: providerInput, credentials: z.unknown(), monthlyLimitUsd: moneyInput }).strict();
const updateInput = createInput.omit({ provider: true }).extend({ monthlyLimitUsd: moneyInput.optional() });
const budgetInput = z.object({ monthlyLimitUsd: moneyInput.optional(), paused: z.boolean() }).strict();
const limitInput = z.object({ revision: z.number().int().min(1).max(2_147_483_647), expectedMonthlyLimitUsd: moneyInput, monthlyLimitUsd: moneyInput }).strict();

type Connection = { id: string; workspace_id: string; provider: 'openrouter' | 'dataforseo'; name: string; encrypted_credentials: unknown; revision: number; monthly_limit_micros: string; check_status: string; diagnostic: string | null; last_checked_at: Date | null; created_at: Date; updated_at: Date; revoked_at: Date | null };
function metadata(row: Connection) {
  return { id: row.id, name: row.name, provider: row.provider, revision: row.revision, monthlyLimitUsd: usd(row.monthly_limit_micros), checkStatus: row.check_status, diagnostic: row.diagnostic, lastCheckedAt: row.last_checked_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
function context(row: Pick<Connection, 'id' | 'workspace_id' | 'provider' | 'revision'>) {
  return { id: row.id, workspaceId: row.workspace_id, provider: row.provider, revision: row.revision };
}

// The workspace lock also serializes membership changes, key revocation and budget reservations.
export async function providerTransaction<T>(workspaceId: string, userId: string, roles: string[], run: (client: PoolClient, role: string) => Promise<T>) {
  z.uuid().parse(workspaceId); z.uuid().parse(userId);
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspaceId]);
    const access = await client.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
    const role = access.rows[0]?.role as string | undefined;
    if (!role || !roles.includes(role)) throw new FoundationError(404, 'Workspace not found or unavailable.');
    const result = await run(client, role);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function listProviders(workspaceId: string, userId: string) {
  return providerTransaction(workspaceId, userId, ['owner'], async client => {
    const connections = await client.query<Connection>('SELECT * FROM provider_connection WHERE workspace_id=$1 AND revoked_at IS NULL ORDER BY created_at,id', [workspaceId]);
    const budget = await client.query('SELECT monthly_limit_micros,paused FROM workspace_budget WHERE workspace_id=$1', [workspaceId]);
    const totals = await client.query(`SELECT COALESCE(sum(actual_micros) FILTER(WHERE status='settled'),0)::text AS spent,
      COALESCE(sum(estimate_micros) FILTER(WHERE status IN ('reserved','dispatched')),0)::text AS reserved,
      COALESCE(sum(estimate_micros) FILTER(WHERE status='uncertain'),0)::text AS uncertain,
      to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month
      FROM provider_request WHERE workspace_id=$1 AND (budget_month=date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC')::date OR status IN ('reserved','dispatched','uncertain'))`, [workspaceId]);
    const ledger = await client.query(`SELECT id,connection_id AS "connectionId",operation,status,estimate_micros,actual_micros,created_at AS "createdAt"
      FROM provider_request WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50`, [workspaceId]);
    return { vaultConfigured: credentialKeys() !== null, connections: connections.rows.map(metadata),
      budget: { monthlyLimitUsd: usd(budget.rows[0]?.monthly_limit_micros ?? '0'), monthlyLimitEnforced: false as const, paused: budget.rows[0]?.paused ?? true,
        month: totals.rows[0].month, spentUsd: usd(totals.rows[0].spent), reservedUsd: usd(totals.rows[0].reserved), uncertainUsd: usd(totals.rows[0].uncertain) },
      ledger: ledger.rows.map(({ estimate_micros, actual_micros, ...row }) => ({ ...row, estimateUsd: usd(estimate_micros), actualUsd: actual_micros === null ? null : usd(actual_micros) })) };
  });
}

export async function saveProvider(workspaceId: string, userId: string, input: unknown, connectionId?: string) {
  const data = connectionId ? updateInput.parse(input) : createInput.parse(input);
  if (connectionId) z.uuid().parse(connectionId);
  return providerTransaction(workspaceId, userId, ['owner'], async client => {
    const previous = connectionId ? (await client.query<Connection>('SELECT * FROM provider_connection WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL FOR UPDATE', [connectionId, workspaceId])).rows[0] : undefined;
    if (connectionId && !previous) throw new FoundationError(404, 'Connection not found or unavailable.');
    if (previous && data.monthlyLimitUsd !== undefined && usdMicros(data.monthlyLimitUsd) !== BigInt(previous.monthly_limit_micros)) {
      throw new FoundationError(409, 'Reload the connection and edit its spending cap separately.');
    }
    const provider = previous?.provider ?? (data as z.infer<typeof createInput>).provider;
    const credentials = credentialsInput[provider].parse(data.credentials);
    const id = previous?.id ?? randomUUID();
    const revision = (previous?.revision ?? 0) + 1;
    const encrypted = encryptCredentials(credentials, { id, workspaceId, provider, revision });
    const result = previous
      ? await client.query<Connection>(`UPDATE provider_connection SET name=$3,encrypted_credentials=$4,revision=$5,check_status='untested',diagnostic=NULL,last_checked_at=NULL,updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *`, [id, workspaceId, data.name, encrypted, revision])
      : await client.query<Connection>('INSERT INTO provider_connection(id,workspace_id,provider,name,encrypted_credentials,monthly_limit_micros) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [id, workspaceId, provider, data.name, encrypted, usdMicros((data as z.infer<typeof createInput>).monthlyLimitUsd).toString()]);
    return { connection: metadata(result.rows[0]) };
  });
}

export async function saveProviderLimit(workspaceId: string, userId: string, connectionId: string, input: unknown) {
  z.uuid().parse(connectionId);
  const data = limitInput.parse(input);
  return providerTransaction(workspaceId, userId, ['owner'], async client => {
    const row = (await client.query<Connection>('SELECT * FROM provider_connection WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL', [connectionId, workspaceId])).rows[0];
    if (!row) throw new FoundationError(404, 'Connection not found or unavailable.');
    if (row.revision !== data.revision || BigInt(row.monthly_limit_micros) !== usdMicros(data.expectedMonthlyLimitUsd)) {
      throw new FoundationError(409, 'The connection or spending cap changed. Reload it before saving.');
    }
    const limit = usdMicros(data.monthlyLimitUsd).toString();
    if (limit === row.monthly_limit_micros) return { connection: metadata(row) };
    const result = await client.query<Connection>('UPDATE provider_connection SET monthly_limit_micros=$3,updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *', [connectionId, workspaceId, limit]);
    return { connection: metadata(result.rows[0]) };
  });
}

export async function revokeProvider(workspaceId: string, userId: string, connectionId: string) {
  z.uuid().parse(connectionId);
  return providerTransaction(workspaceId, userId, ['owner'], async client => {
    const result = await client.query(`UPDATE provider_connection SET revoked_at=now(),encrypted_credentials=NULL,revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL RETURNING id`, [connectionId, workspaceId]);
    if (!result.rowCount) throw new FoundationError(404, 'Connection not found or unavailable.');
    await client.query("UPDATE provider_request SET status='cancelled',updated_at=now() WHERE connection_id=$1 AND status='reserved'", [connectionId]);
  });
}

export async function saveBudget(workspaceId: string, userId: string, input: unknown) {
  const data = budgetInput.parse(input);
  if (!data.paused && !credentialKeys()) throw new FoundationError(503, 'Configure the credential encryption keyring before enabling provider spending.');
  return providerTransaction(workspaceId, userId, ['owner'], async client => {
    await client.query(`INSERT INTO workspace_budget(workspace_id,paused) VALUES($1,$2)
      ON CONFLICT(workspace_id) DO UPDATE SET paused=excluded.paused,updated_at=now()`, [workspaceId, data.paused]);
  });
}

async function boundedJson(response: Response) {
  if (!response.body) throw new Error('Missing provider response.');
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1_048_576) throw new Error('Response too large.'); parts.push(value); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

// These fixed read-only endpoints cannot become an arbitrary authenticated proxy.
export async function providerAccountCheck(provider: Connection['provider'], credentials: unknown, send: typeof fetch = fetch) {
  const parsed = credentialsInput[provider].parse(credentials);
  const url = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/key' : 'https://api.dataforseo.com/v3/appendix/user_data';
  const authorization = 'apiKey' in parsed ? `Bearer ${parsed.apiKey}` : `Basic ${Buffer.from(`${parsed.login}:${parsed.password}`).toString('base64')}`;
  try {
    const response = await send(url, { headers: { authorization, accept: 'application/json' }, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); return { checkStatus: 'error', diagnostic: response.status === 401 || response.status === 403 ? 'Provider rejected the credentials or account permissions.' : response.status === 429 ? 'Provider rate limit reached. Wait before checking again.' : 'Provider account check failed. Try again later.' }; }
    const body = await boundedJson(response);
    const valid = provider === 'openrouter'
      ? body?.data && typeof body.data === 'object' && !Array.isArray(body.data) && typeof body.data.is_free_tier === 'boolean'
      : body?.status_code === 20000 && body?.tasks?.length === 1 && body.tasks[0]?.status_code === 20000 && Array.isArray(body.tasks[0]?.result) && body.tasks[0].result.length > 0;
    return valid ? { checkStatus: 'ok', diagnostic: 'Account credentials accepted. This does not verify every paid endpoint or available credit.' }
      : { checkStatus: 'error', diagnostic: 'Provider returned an unsupported or unsuccessful account response.' };
  } catch { return { checkStatus: 'error', diagnostic: 'Provider could not be reached or returned an invalid response. Credentials were not changed.' }; }
}

export async function checkProvider(workspaceId: string, userId: string, connectionId: string) {
  z.uuid().parse(connectionId);
  const saved = await providerTransaction(workspaceId, userId, ['owner'], async client => {
    const result = await client.query<Connection>('SELECT * FROM provider_connection WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL', [connectionId, workspaceId]);
    if (!result.rows[0]) throw new FoundationError(404, 'Connection not found or unavailable.');
    const row = result.rows[0];
    return { provider: row.provider, revision: row.revision, credentials: decryptCredentials(row.encrypted_credentials, context(row)) };
  });
  const result = await providerAccountCheck(saved.provider, saved.credentials);
  return providerTransaction(workspaceId, userId, ['owner'], async client => {
    const updated = await client.query<Connection>(`UPDATE provider_connection SET check_status=$4,diagnostic=$5,last_checked_at=now()
      WHERE id=$1 AND workspace_id=$2 AND revision=$3 AND revoked_at IS NULL RETURNING *`, [connectionId, workspaceId, saved.revision, result.checkStatus, result.diagnostic]);
    if (!updated.rowCount) throw new FoundationError(409, 'Connection changed during the check. Check the current credentials again.');
    return { connection: metadata(updated.rows[0]) };
  });
}

export async function assertCredentialKeys() {
  const rows = await getDatabase().pool.query<Connection>('SELECT * FROM provider_connection WHERE encrypted_credentials IS NOT NULL');
  const ring = credentialKeys();
  for (const row of rows.rows) decryptCredentials(row.encrypted_credentials, context(row), ring);
}

export async function rotateCredentialEncryption() {
  const ring = credentialKeys();
  if (!ring) throw new FoundationError(503, 'Configure a credential keyring first.');
  const client = await getDatabase().pool.connect(); let count = 0;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workspace ORDER BY id FOR UPDATE');
    const rows = await client.query<Connection>('SELECT * FROM provider_connection WHERE encrypted_credentials IS NOT NULL ORDER BY workspace_id,id FOR UPDATE');
    for (const row of rows.rows) {
      const value = decryptCredentials(row.encrypted_credentials, context(row), ring);
      const sealed = encryptCredentials(value, context(row), ring);
      await client.query('UPDATE provider_connection SET encrypted_credentials=$2 WHERE id=$1', [row.id, sealed]); count++;
    }
    await client.query('COMMIT'); return count;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
