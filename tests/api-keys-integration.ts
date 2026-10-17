import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { FoundationError } from '../src/server/auth.ts';
import { handleApi } from '../src/server/api.ts';
import { apiKeyScopes, authenticateApiKey, authorizeApiKey, createApiKey, listApiKeys, revokeApiKey } from '../src/server/api-keys.ts';
import { getConfig } from '../src/server/config.ts';
import { getDatabase } from '../src/server/db.ts';
import { changeRole, createWorkspace, removeMember } from '../src/server/teams.ts';

type Options = { baseUrl: string; appUrl: string; ownerCookie: string; ownerId: string; workspaceId: string };
async function rejects(promise: Promise<unknown>, status: number, message: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof FoundationError && error.status === status, message);
}

export async function runApiKeyChecks(options: Options): Promise<void> {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'API-key checks require the isolated integration-test opt-in.');
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  assert.ok(local.has(new URL(options.baseUrl).hostname) && local.has(new URL(options.appUrl).hostname), 'API-key HTTP targets must be local.');
  assert.ok(local.has(new URL(getConfig().databaseUrl).hostname), 'API-key checks require isolated local PostgreSQL.');
  const { pool } = getDatabase();
  const owner = await pool.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'", [options.workspaceId, options.ownerId]);
  assert.equal(owner.rowCount, 1, 'The preceding foundation test must supply its existing owner.');
  const workspace = await createWorkspace(options.ownerId, { name: 'API-key authorization checks' });
  const workspaceId = workspace.workspace.id;
  const created = await createApiKey(workspaceId, options.ownerId, { name: '  Deployment reader  ', scopes: ['projects:read'] });
  assert.equal(created.key.name, 'Deployment reader');
  assert.match(created.token, /^t98k_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(created.token.slice(5), 'base64url').length, 32);
  const lifetime = created.key.expiresAt.getTime() - created.key.createdAt.getTime();
  assert.ok(Math.abs(lifetime - 90 * 86_400_000) < 1000, 'Default keys must expire after 90 days.');
  const dtoFields = ['id', 'workspaceId', 'issuerUserId', 'name', 'scopes', 'createdAt', 'expiresAt', 'revokedAt'].sort();
  assert.deepEqual(Object.keys(created.key).sort(), dtoFields, 'Creation must not expose a digest.');
  const stored = await pool.query('SELECT token_hash FROM api_key WHERE id=$1', [created.key.id]);
  assert.equal(stored.rows[0].token_hash, createHash('sha256').update(created.token).digest('hex'), 'Only the digest is stored.');
  const listed = await listApiKeys(workspaceId, options.ownerId);
  assert.equal(listed.keys.length, 1);
  assert.deepEqual(Object.keys(listed.keys[0]).sort(), dtoFields, 'Listing must not repeat the token or digest.');
  assert.equal(JSON.stringify(listed).includes(created.token), false);
  assert.equal((await authorizeApiKey(created.token, workspaceId, 'projects:read')).userId, options.ownerId);
  await rejects(authorizeApiKey(created.token, workspaceId, 'projects:write'), 403, 'Explicit scope limits must apply to owners too.');
  await rejects(authorizeApiKey(created.token, options.workspaceId, 'projects:read'), 404, 'Keys cannot cross workspaces.');
  await rejects(authenticateApiKey(`t98k_${randomBytes(32).toString('base64url')}`), 401, 'Unknown keys must fail closed.');

  const input = { name: 'Input check', scopes: ['projects:read'] };
  for (const invalid of [null, {}, { ...input, name: ' ' }, { ...input, name: 'x'.repeat(81) }, { ...input, extra: true },
    { ...input, scopes: [] }, { ...input, scopes: ['projects:read', 'projects:read'] }, { ...input, scopes: ['paid:run'] }, { ...input, scopes: ['audits:read'] }, { ...input, scopes: ['domains:read'] },
    { ...input, expiresInDays: 0 }, { ...input, expiresInDays: 366 }, { ...input, expiresInDays: 1.5 }, { ...input, expiresInDays: null }]) {
    await rejects(createApiKey(workspaceId, options.ownerId, invalid), 400, 'Invalid key fields must be rejected.');
  }
  assert.equal((await listApiKeys(workspaceId, options.ownerId)).keys.length, 1, 'Rejected inputs must not create keys.');
  const longest = await createApiKey(workspaceId, options.ownerId, { ...input, expiresInDays: 365 });
  assert.ok(Math.abs(longest.key.expiresAt.getTime() - longest.key.createdAt.getTime() - 365 * 86_400_000) < 1000);
  await pool.query("UPDATE api_key SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1", [longest.key.id]);
  await rejects(authenticateApiKey(longest.token), 401, 'Expired keys must fail closed.');

  const memberId = randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [memberId, 'API-key member', `${randomUUID()}@keys.integration.test`]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')", [workspaceId, memberId]);
  const memberKey = await createApiKey(workspaceId, memberId, { name: 'Role changes', scopes: ['projects:read', 'projects:write', 'analytics:read', 'events:write', 'team:read'] });
  await changeRole(workspaceId, options.ownerId, memberId, { role: 'editor' });
  assert.deepEqual((await authenticateApiKey(memberKey.token)).scopes, ['projects:read', 'projects:write', 'analytics:read', 'events:write']);
  await rejects(authorizeApiKey(memberKey.token, workspaceId, 'team:read'), 403, 'Demotion must remove team access immediately.');
  await authorizeApiKey(memberKey.token, workspaceId, 'projects:write');
  await rejects(createApiKey(workspaceId, memberId, input), 404, 'Editors cannot create keys.');
  await rejects(listApiKeys(workspaceId, memberId), 404, 'Editors cannot list keys.');
  await rejects(revokeApiKey(workspaceId, memberId, created.key.id), 404, 'Editors cannot revoke keys.');
  await changeRole(workspaceId, options.ownerId, memberId, { role: 'viewer' });
  assert.deepEqual((await authenticateApiKey(memberKey.token)).scopes, ['projects:read', 'analytics:read']);
  await rejects(authorizeApiKey(memberKey.token, workspaceId, 'events:write'), 403, 'Viewers cannot keep write scopes.');
  await rejects(createApiKey(workspaceId, memberId, input), 404, 'Viewers cannot create keys.');
  await removeMember(workspaceId, options.ownerId, memberId);
  await rejects(authenticateApiKey(memberKey.token), 401, 'Removed members must lose key access.');
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')", [workspaceId, memberId]);
  await rejects(authenticateApiKey(memberKey.token), 401, 'Rejoining must not reactivate previously issued keys.');

  await rejects(revokeApiKey(options.workspaceId, options.ownerId, created.key.id), 404, 'Revocation must enforce the selected workspace.');
  await authorizeApiKey(created.token, workspaceId, 'projects:read');
  const lock = await pool.connect();
  let revoke: Promise<void> | undefined;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspaceId]);
    revoke = revokeApiKey(workspaceId, options.ownerId, created.key.id);
    // Observe PostgreSQL blocking rather than guessing whether revocation started.
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (!blocked && Date.now() < deadline) {
      await lock.query('SELECT pg_stat_clear_snapshot()');
      const waiting = await lock.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pg_backend_pid()=ANY(pg_blocking_pids(pid)) AND query='SELECT id FROM workspace WHERE id=$1 FOR UPDATE'");
      blocked = waiting.rowCount !== 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(blocked, 'Revocation must acquire the same workspace lock as protected writes.');
    await authorizeApiKey(created.token, workspaceId, 'projects:read', lock);
    await lock.query('COMMIT');
    await revoke;
  } finally {
    await lock.query('ROLLBACK').catch(() => undefined);
    lock.release();
    await revoke;
  }
  await rejects(authenticateApiKey(created.token), 401, 'Revocation must invalidate subsequent requests.');
  const firstRevocation = (await listApiKeys(workspaceId, options.ownerId)).keys.find((key) => key.id === created.key.id)!.revokedAt;
  await revokeApiKey(workspaceId, options.ownerId, created.key.id);
  const nextRevocation = (await listApiKeys(workspaceId, options.ownerId)).keys.find((key) => key.id === created.key.id)!.revokedAt;
  assert.deepEqual(nextRevocation, firstRevocation, 'Repeated revocation must preserve the original time.');
  console.log('PASS API-key digest-only storage, scope/tenant limits, expiry, live roles, removal/rejoin and serialized revocation');

  async function http(path: string, expected: number, credentials: { token?: string; cookie?: string }, body?: unknown) {
    const headers = new Headers();
    if (credentials.token) headers.set('authorization', `Bearer ${credentials.token}`);
    if (credentials.cookie) headers.set('cookie', credentials.cookie);
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      if (credentials.cookie) headers.set('origin', options.appUrl);
    }
    const response = await fetch(new URL(path, options.baseUrl), {
      method: body === undefined ? 'GET' : 'POST', headers, signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, expected, `API-key HTTP contract failed at ${path}.`);
    return { body: await response.json(), headers: response.headers };
  }
  const managementPath = `/api/workspaces/${workspaceId}/api-keys`;
  const cookie = { cookie: options.ownerCookie };
  const httpKey = await http(managementPath, 201, cookie, { name: 'HTTP automation', scopes: [...apiKeyScopes] });
  const bearer = { token: httpKey.body.token as string };
  assert.ok(bearer.token, 'Creation must return a token once.');
  assert.equal(httpKey.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(httpKey.body.key).sort(), dtoFields);
  const httpList = await http(managementPath, 200, cookie);
  assert.ok(httpList.body.keys.some((key: { id: string }) => key.id === httpKey.body.key.id));
  assert.equal(JSON.stringify(httpList.body).includes(bearer.token), false);
  await http(managementPath, 400, cookie, { name: 'Invalid', scopes: ['projects:read'], unknown: true });
  await http(managementPath, 403, bearer);
  await http(managementPath, 403, bearer, { name: 'Cannot delegate', scopes: ['projects:read'] });
  await http(`/api/workspaces/${workspaceId}/projects`, 200, bearer);
  await http(`/api/workspaces/${options.workspaceId}/projects`, 404, bearer);
  const projectOrigin = `https://${randomUUID()}.keys.integration.test`;
  const projectResult = await http(`/api/workspaces/${workspaceId}/projects`, 201, bearer, { name: 'API-created project', origin: projectOrigin });
  const project = projectResult.body.project;
  const reader = await createApiKey(workspaceId, options.ownerId, { name: 'Read only', scopes: ['projects:read'] });
  await http(`/api/workspaces/${workspaceId}/projects`, 200, { token: reader.token });
  await http(`/api/workspaces/${workspaceId}/projects`, 403, { token: reader.token }, { name: 'Denied', origin: 'https://denied.keys.integration.test' });
  await http(`/api/projects/${project.id}/analytics`, 403, { token: reader.token });
  await http(`/api/projects/${project.id}/events`, 403, { token: reader.token });
  const apiEvent = { eventId: randomUUID(), name: 'automation.completed', url: `${projectOrigin}/done?private=yes#secret` };
  await http(`/api/projects/${project.id}/events`, 202, bearer, apiEvent);
  await http(`/api/projects/${project.id}/events`, 202, bearer, apiEvent);
  await http(`/api/projects/${project.id}/events`, 403, { token: reader.token }, { ...apiEvent, eventId: randomUUID() });
  await http(`/api/projects/${project.id}/events`, 400, bearer, { ...apiEvent, eventId: randomUUID(), url: 'https://foreign.keys.integration.test/done' });
  const events = await http(`/api/projects/${project.id}/events`, 200, bearer);
  assert.equal(events.body.total, 1, 'Authenticated ingestion must retain event idempotency.');
  assert.equal(events.body.events[0].path, '/done', 'Authenticated ingestion must discard URL query and fragment.');
  const report = await http(`/api/projects/${project.id}/analytics`, 200, bearer);
  assert.equal(report.body.totals.customEvents, 1);
  await http(`/api/workspaces/${workspaceId}/team`, 200, bearer);
  await http(`/api/projects/${project.id}/context`, 403, { token: reader.token });
  const segmentsKey = await createApiKey(workspaceId, options.ownerId, { name: 'Saved filter reader', scopes: ['segments:read'] });
  await http(`/api/projects/${project.id}/segments`, 200, { token: segmentsKey.token });
  await http(`/api/projects/${project.id}/segments`, 200, bearer);
  await http(`/api/projects/${project.id}/analytics`, 403, { token: segmentsKey.token });
  await http(`/api/projects/${project.id}/segments`, 403, bearer, { requestId: randomUUID(), definition: { schemaVersion: 1, name: 'Never saved', query: '' } });
  await http(`/api/projects/${project.id}/saved-keywords/list`, 403, bearer);
  for (const path of ['/api/me', '/api/account/sessions', `/api/workspaces/${workspaceId}/providers`, `/api/projects/${project.id}/jobs`]) {
    await http(path, 403, bearer);
  }
  await http('/api/auth/sign-out', 403, bearer, {});
  await http('/api/workspaces', 403, bearer, { name: 'Denied workspace' });
  await http(`/api/projects/${project.id}/check-worker`, 403, bearer, { requestId: randomUUID() });
  await http(`/api/workspaces/${workspaceId}/invitations`, 403, bearer, { email: 'blocked@keys.integration.test', role: 'viewer' });
  await http(`/api/workspaces/${workspaceId}/projects`, 400, { ...bearer, ...cookie });
  const duplicate = await fetch(new URL(`/api/workspaces/${workspaceId}/projects`, options.baseUrl), {
    headers: { authorization: `Bearer ${bearer.token}, Bearer ${bearer.token}` }, signal: AbortSignal.timeout(15_000),
  });
  assert.equal(duplicate.status, 401, 'Duplicate credentials must not reach resource authorization.');

  let beginBody!: () => void;
  let releaseBody!: () => void;
  const bodyStarted = new Promise<void>((resolve) => { beginBody = resolve; });
  const bodyReleased = new Promise<void>((resolve) => { releaseBody = resolve; });
  const delayedOrigin = `https://${randomUUID()}.revoked.keys.integration.test`;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      beginBody();
      await bodyReleased;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ name: 'Revoked during upload', origin: delayedOrigin })));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const inFlight = handleApi(new Request(`${options.appUrl}/api/workspaces/${workspaceId}/projects`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer.token}`, 'content-type': 'application/json' },
    body: stream, duplex: 'half',
  } as RequestInit & { duplex: 'half' }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([bodyStarted, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The delayed API-key request did not read its body.')), 10_000); })]);
    await http(`${managementPath}/${httpKey.body.key.id}/revoke`, 200, cookie, {});
  } finally { if (timer) clearTimeout(timer); releaseBody(); }
  assert.equal((await inFlight).status, 401, 'A token revoked while a request body is pending must not authorize a write.');
  assert.equal((await pool.query('SELECT 1 FROM project WHERE workspace_id=$1 AND origin=$2', [workspaceId, delayedOrigin])).rowCount, 0);
  await http(`/api/workspaces/${workspaceId}/projects`, 401, bearer);
  console.log('PASS API-key HTTP management, private event ingestion, forbidden routes, credential ambiguity and in-flight revocation');
}
