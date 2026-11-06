import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {cloudflareConnectionSave, cloudflareConnectionDisconnect, cloudflareConnectionsResponse, cloudflareConnectionMutationResponse, cloudflareConnectionCheck, cloudflareConnectionCheckResponse, type CloudflareConnectionMetadata, type CloudflareConnectionCheckResponse} from '../lib/cloudflare-connections.ts';
import {FoundationError} from './auth.ts';
import {parse} from './context-input.ts';
import {credentialKeys, decryptCredentials, encryptCredentials, type Keyring} from './credential-vault.ts';
import {getDatabase} from './db.ts';
import {contentReceipt, withContentProject, type ContentProject} from './project-context.ts';
import {CloudflareTransportError, inspectCloudflareCapabilities, listCloudflareSites, type CloudflareTransportOptions} from './cloudflare-http.ts';

type Connection = {id: string; project_id: string; workspace_id: string; account_id: string; name: string; revision: number;
  encrypted_credentials: unknown; created_by: string; created_at: Date; updated_at: Date; revoked_at: Date | null};
const provider = 'cloudflare';
const payload = z.object({projectId: z.uuid(), accountId: z.string().regex(/^[a-f0-9]{32}$/), apiToken: z.string().min(1).max(4096).regex(/^[A-Za-z0-9._~-]+$/)}).strict();
const missing = () => new FoundationError(404, 'Cloudflare connection not found or unavailable.');
const changed = () => new FoundationError(409, 'The Cloudflare connection changed. Reload its current revision.');
function context(row: Pick<Connection, 'id' | 'workspace_id' | 'revision'>) { return {workspaceId: row.workspace_id, id: row.id, provider, revision: row.revision}; }
function keys() { try { return credentialKeys(); } catch { throw new FoundationError(503, 'The Cloudflare credential keyring is unavailable.'); } }
function configured() { try { return keys() !== null; } catch { return false; } }
function metadata(row: Omit<Connection, 'encrypted_credentials' | 'created_by' | 'workspace_id' | 'project_id'>): CloudflareConnectionMetadata {
  return {id: row.id, accountId: row.account_id, name: row.name, revision: row.revision, state: row.revoked_at ? 'disconnected' : 'configured',
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null};
}
async function within<T>(projectId: string, userId: string, write: boolean, action: (client: PoolClient, project: ContentProject) => Promise<T>): Promise<T> {
  try {
    return await withContentProject(projectId, userId, write, async (client, project) => {
      if (write && project.role !== 'owner') throw missing();
      return action(client, project);
    }, undefined, true);
  } catch (error) {
    if (error instanceof FoundationError) throw error;
    throw new FoundationError(503, 'Cloudflare connection storage is unavailable. Retry a save only with its original request ID.');
  }
}
async function response(client: PoolClient, project: ContentProject) {
  // Metadata readers never select ciphertext. The extra row detects an oversized response instead of truncating it.
  const rows = await client.query<Omit<Connection, 'encrypted_credentials' | 'created_by' | 'workspace_id' | 'project_id'>>(
    'SELECT id,account_id,name,revision,created_at,updated_at,revoked_at FROM cloudflare_connection WHERE project_id=$1 ORDER BY created_at,id LIMIT 101', [project.id]);
  if (rows.rows.length > 100) throw new FoundationError(503, 'The complete Cloudflare connection list is unavailable.');
  return cloudflareConnectionsResponse.parse({projectId: project.id, role: project.role, vaultConfigured: configured(), connections: rows.rows.map(metadata)});
}
async function mutationResponse(client: PoolClient, project: ContentProject, ack: unknown) {
  return cloudflareConnectionMutationResponse.parse({...await response(client, project), ack});
}
export async function getCloudflareConnections(projectId: string, userId: string) { return within(projectId, userId, false, response); }

export async function saveCloudflareConnection(projectId: string, userId: string, raw: unknown) {
  const input = parse(cloudflareConnectionSave, raw);
  return within(projectId, userId, true, async (client, project) => {
    const receipt = await contentReceipt(client, project.id, input.requestId, 'cloudflare.connection.save', {userId, ...input});
    if (receipt.replayed) return mutationResponse(client, project, receipt.result);
    const previous = input.connectionId ? (await client.query<Connection>('SELECT * FROM cloudflare_connection WHERE id=$1 AND project_id=$2 FOR UPDATE', [input.connectionId, project.id])).rows[0] : undefined;
    if (input.connectionId && !previous) throw missing();
    if ((previous?.revision ?? 0) !== input.expectedRevision || previous && previous.account_id !== input.accountId) throw changed();
    if (!previous) {
      const existing = await client.query('SELECT 1 FROM cloudflare_connection WHERE project_id=$1 AND account_id=$2', [project.id, input.accountId]);
      if (existing.rowCount) throw new FoundationError(409, 'This Cloudflare account already has a saved connection. Replace that connection instead.');
      const count = await client.query<{n: number}>('SELECT count(*)::int AS n FROM cloudflare_connection WHERE project_id=$1', [project.id]);
      if (count.rows[0].n >= 100) throw new FoundationError(409, 'This project already has the maximum number of saved Cloudflare connections.');
    }
    const workspaceId = (await client.query<{workspace_id: string}>('SELECT workspace_id FROM project WHERE id=$1', [project.id])).rows[0].workspace_id;
    const id = previous?.id ?? randomUUID(), revision = (previous?.revision ?? 0) + 1;
    const sealed = encryptCredentials({projectId: project.id, accountId: input.accountId, apiToken: input.apiToken}, {workspaceId, id, provider, revision}, keys());
    if (previous) await client.query('UPDATE cloudflare_connection SET name=$3,revision=$4,encrypted_credentials=$5,updated_at=clock_timestamp(),revoked_at=NULL WHERE id=$1 AND project_id=$2', [id, project.id, input.name, revision, sealed]);
    else await client.query('INSERT INTO cloudflare_connection(id,project_id,workspace_id,account_id,name,revision,encrypted_credentials,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, project.id, workspaceId, input.accountId, input.name, revision, sealed, userId]);
    const ack = {requestId: input.requestId, operation: 'save' as const, connectionId: id, revision};
    await receipt.save(ack); return mutationResponse(client, project, ack);
  });
}
export async function disconnectCloudflareConnection(projectId: string, userId: string, raw: unknown) {
  const input = parse(cloudflareConnectionDisconnect, raw);
  return within(projectId, userId, true, async (client, project) => {
    const receipt = await contentReceipt(client, project.id, input.requestId, 'cloudflare.connection.disconnect', {userId, ...input});
    if (receipt.replayed) return mutationResponse(client, project, receipt.result);
    const row = (await client.query<Connection>('SELECT * FROM cloudflare_connection WHERE id=$1 AND project_id=$2 FOR UPDATE', [input.connectionId, project.id])).rows[0];
    if (!row) throw missing();
    if (row.revision !== input.expectedRevision || row.revoked_at) throw changed();
    const revision = row.revision + 1;
    await client.query('UPDATE cloudflare_connection SET encrypted_credentials=NULL,revision=$3,revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND project_id=$2', [row.id, project.id, revision]);
    const ack = {requestId: input.requestId, operation: 'disconnect' as const, connectionId: row.id, revision};
    await receipt.save(ack); return mutationResponse(client, project, ack);
  });
}
function opened(row: Connection, ring: Keyring | null) {
  const value = payload.safeParse(decryptCredentials(row.encrypted_credentials, context(row), ring));
  if (!value.success || value.data.projectId !== row.project_id || value.data.accountId !== row.account_id) throw new FoundationError(503, 'Stored Cloudflare credentials do not match this connection.');
  return value.data;
}

/** Explicit read-only metadata inspection; no durable request receipt or automatic retry. */
export async function checkCloudflareConnection(projectId: string, userId: string, raw: unknown, options: CloudflareTransportOptions = {}) {
  const input = parse(cloudflareConnectionCheck, raw);
  const current = () => within(projectId, userId, false, async (client, project) => {
    if (project.role !== 'owner') throw missing();
    const row = (await client.query<Connection>('SELECT * FROM cloudflare_connection WHERE id=$1 AND project_id=$2 FOR SHARE', [input.connectionId, project.id])).rows[0];
    if (!row) throw missing();
    if (row.revision !== input.expectedRevision || row.revoked_at) throw changed();
    return {...opened(row, keys()), workspaceId: row.workspace_id, revision: row.revision};
  });
  const saved = await current();
  const deadline = AbortSignal.timeout(30000), signal = AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]);
  let result: CloudflareConnectionCheckResponse | undefined, failure: CloudflareTransportError | undefined;
  try {
    const capabilities = await inspectCloudflareCapabilities(saved.accountId, saved.apiToken, {...options, signal});
    const sites = await listCloudflareSites(saved.accountId, saved.apiToken, {...options, signal});
    result = cloudflareConnectionCheckResponse.parse({projectId: saved.projectId, connectionId: input.connectionId, accountId: saved.accountId,
      revision: saved.revision, checkedAt: new Date().toISOString(), sites, capabilities});
    const serialized = JSON.stringify(result);
    // Allowed provider fields are still untrusted: an echoed credential must never reach the browser.
    if (Buffer.byteLength(serialized, 'utf8') > 1048576 || serialized.includes(saved.apiToken)) throw new CloudflareTransportError('invalid_response');
  } catch (error) {
    failure = new CloudflareTransportError(deadline.aborted ? 'timeout' : error instanceof CloudflareTransportError ? error.code : 'unavailable');
  }
  // Recheck on both paths after external work, without holding any database lock during that work.
  const latest = await current();
  if (latest.projectId !== saved.projectId || latest.workspaceId !== saved.workspaceId || latest.accountId !== saved.accountId || latest.apiToken !== saved.apiToken) throw changed();
  if (failure) {
    const status = {input: 400, denied: 502, rate_limited: 429, unavailable: 503, timeout: 504, cancelled: 503, invalid_response: 502, incomplete: 502}[failure.code];
    throw new FoundationError(status, failure.message);
  }
  return result!;
}
async function visitCredentials(rotate: boolean): Promise<number> {
  const ring = keys();
  if (rotate && !ring) throw new FoundationError(503, 'Configure the credential keyring before rotating Cloudflare credentials.');
  const client = await getDatabase().pool.connect(); let count = 0;
  try {
    await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='5s'");
    const lock = rotate ? 'UPDATE' : 'SHARE';
    await client.query(`SELECT id FROM workspace ORDER BY id FOR ${lock}`);
    await client.query(`SELECT id FROM project ORDER BY workspace_id,id FOR ${lock}`);
    const rows = await client.query<Connection>(`SELECT * FROM cloudflare_connection WHERE encrypted_credentials IS NOT NULL ORDER BY workspace_id,project_id,id FOR ${lock}`);
    for (const row of rows.rows) {
      const value = opened(row, ring);
      if (rotate) { await client.query('UPDATE cloudflare_connection SET encrypted_credentials=$2 WHERE id=$1', [row.id, encryptCredentials(value, context(row), ring)]); count++; }
    }
    await client.query('COMMIT'); return count;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof FoundationError) throw error;
    throw new FoundationError(503, 'Cloudflare credential storage is unavailable.');
  } finally { client.release(); }
}
export async function assertCloudflareCredentialsReadable(): Promise<void> { await visitCredentials(false); }
export async function rotateCloudflareCredentials(): Promise<number> { return visitCredentials(true); }
