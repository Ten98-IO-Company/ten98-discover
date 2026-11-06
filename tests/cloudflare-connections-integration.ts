import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getConfig} from '../src/server/config.ts';
import {assertSchema, closeDatabase, getDatabase} from '../src/server/db.ts';
import {getBoss, stopJobs} from '../src/server/jobs.ts';
import {closeAccount, type StepUpProof} from '../src/server/account-closure.ts';
import {runClosedAccountRetention} from '../src/server/account-closure-retention.ts';
import {runRetentionBatch} from '../src/server/retention.ts';
import {deleteProject} from '../src/server/project-delete.ts';
import {decryptCredentials, encryptCredentials} from '../src/server/credential-vault.ts';
import {assertCloudflareCredentialsReadable, disconnectCloudflareConnection, getCloudflareConnections, rotateCloudflareCredentials, saveCloudflareConnection} from '../src/server/cloudflare-connections.ts';
import {cloudflareConnectionMutationResponse} from '../src/lib/cloudflare-connections.ts';

export async function runCloudflareConnectionChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1'); assert.equal(process.env.TEN98_CLOUDFLARE_STORAGE_TEST, '1');
  const database = new URL(getConfig().databaseUrl);
  assert.equal(database.hostname, '127.0.0.1');
  const ci = process.env.GITHUB_ACTIONS === 'true' && process.env.TEN98_ISOLATED_CI_DATABASE === '1' && database.pathname === '/ten98_cloudflare_ci';
  assert.equal(database.port, ci ? '5432' : '55501'); if (!ci) assert.match(database.pathname, /^\/ten98_cloudflare_[a-f0-9]{12}$/);
  assert.equal(database.search, ''); assert.equal(database.hash, ''); assert.equal(process.env.ANALYTICS_NETWORK_MODE, 'off');
  for (const key of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'AUTH_SECRET_FILE', 'CREDENTIAL_KEYS_FILE']) assert.equal(process.env[key], undefined);
  await assertSchema(); const pool = getDatabase().pool;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n, 0);
  const originalFetch = globalThis.fetch, previousKeys = process.env.CREDENTIAL_KEYS, previousActive = process.env.CREDENTIAL_ACTIVE_KEY;
  let outbound = 0; globalThis.fetch = async () => { outbound++; throw Error('External requests are forbidden.'); };
  const firstKey = randomBytes(32).toString('base64'); process.env.CREDENTIAL_KEYS = JSON.stringify({fixture: firstKey}); process.env.CREDENTIAL_ACTIVE_KEY = 'fixture';
  const owner = randomUUID(), coowner = randomUUID(), admin = randomUUID(), editor = randomUUID(), viewer = randomUUID(), stranger = randomUUID(), creator = randomUUID();
  const secret = 'synthetic-cloudflare-token', accountId = 'a'.repeat(32);
  type Fixture = {workspace: string; project: string};
  const body = (connectionId: string | null = null, expectedRevision = 0) => ({requestId: randomUUID(), connectionId, expectedRevision, accountId, name: 'Fixture account', apiToken: secret});
  const save = async (f: Fixture, input = body(), actor = owner) => cloudflareConnectionMutationResponse.parse(await saveCloudflareConnection(f.project, actor, input));
  const row = async (id: string) => (await pool.query('SELECT * FROM cloudflare_connection WHERE id=$1', [id])).rows[0];
  const open = (record: Awaited<ReturnType<typeof row>>) => decryptCredentials(record.encrypted_credentials, {workspaceId: record.workspace_id, id: record.id, provider: 'cloudflare', revision: record.revision});
  async function fixture(): Promise<Fixture> {
    const workspace = randomUUID(), project = randomUUID();
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Cloudflare fixture')", [workspace]);
    for (const [user, role] of [[owner, 'owner'], [coowner, 'owner'], [admin, 'admin'], [editor, 'editor'], [viewer, 'viewer']]) await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, user, role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Cloudflare fixture','https://cloudflare.example',$3,'infinity')", [project, workspace, randomUUID()]);
    return {workspace, project};
  }
  try {
    for (const user of [owner, coowner, admin, editor, viewer, stranger, creator]) await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Cloudflare fixture\',$2)', [user, `${user}@cloudflare.integration.test`]);
    const f = await fixture(), foreign = await fixture();
    for (const actor of [admin, editor, viewer, stranger]) await assert.rejects(save(f, body(), actor), {status: 404});
    await assert.rejects(getCloudflareConnections(f.project, stranger), {status: 404});
    await assert.rejects(saveCloudflareConnection(f.project, owner, {...body(), budget: 1}), {status: 400});
    const input = body(), [saved, duplicate] = await Promise.all([save(f, input), save(f, input)]);
    assert.deepEqual(saved.ack, duplicate.ack); const id = saved.ack.connectionId;
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM cloudflare_connection')).rows[0].n, 1);
    assert.deepEqual(open(await row(id)), {projectId: f.project, accountId, apiToken: secret});
    assert.ok(!JSON.stringify(saved).includes(secret)); assert.ok(!JSON.stringify((await row(id)).encrypted_credentials).includes(secret));
    for (const actor of [owner, admin, editor, viewer]) assert.equal((await getCloudflareConnections(f.project, actor)).connections[0].state, 'configured');
    const receipt = (await pool.query('SELECT * FROM project_content_request WHERE project_id=$1 AND request_id=$2', [f.project, input.requestId])).rows[0];
    assert.ok(!JSON.stringify(receipt).includes(secret)); assert.deepEqual(receipt.result, saved.ack);
    await assert.rejects(save(f, {...input, name: 'Different'}), {status: 409}); await assert.rejects(save(f, input, coowner), {status: 409});
    await assert.rejects(save(f), {status: 409}); await assert.rejects(save(foreign, body(id, 1)), {status: 404});
    await assert.rejects(save(f, {...body(id, 1), accountId: 'b'.repeat(32)}), {status: 409});
    console.log('PASS owner authority, redacted current-member reads, account identity and actor-bound atomic request replay');

    const replacements = await Promise.allSettled([save(f, body(id, 1)), save(f, body(id, 1))]);
    assert.equal(replacements.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(replacements.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);
    assert.equal((await row(id)).revision, 2); assert.equal((await save(f, input)).ack.revision, 1); assert.equal((await save(f, input)).connections[0].revision, 2);
    const remove = {requestId: randomUUID(), connectionId: id, expectedRevision: 2};
    for (const actor of [admin, editor, viewer]) await assert.rejects(disconnectCloudflareConnection(f.project, actor, remove), {status: 404});
    const disconnected = await disconnectCloudflareConnection(f.project, owner, remove);
    assert.equal(disconnected.ack.revision, 3); assert.equal((await row(id)).encrypted_credentials, null);
    assert.deepEqual((await disconnectCloudflareConnection(f.project, owner, remove)).ack, disconnected.ack);
    await assert.rejects(save(f, body(id, 2)), {status: 409}); await save(f, body(id, 3)); assert.equal((await row(id)).revision, 4);
    const lateDisconnect = await disconnectCloudflareConnection(f.project, owner, remove);
    assert.equal(lateDisconnect.ack.revision, 3); assert.equal(lateDisconnect.connections[0].revision, 4); assert.equal(lateDisconnect.connections[0].state, 'configured');
    await assert.rejects(disconnectCloudflareConnection(foreign.project, owner, {...remove, requestId: randomUUID(), expectedRevision: 4}), {status: 404});
    const current = await row(id), context = {workspaceId: f.workspace, id, provider: 'cloudflare', revision: 4};
    for (const wrong of [{...context, revision: 3}, {...context, id: randomUUID()}, {...context, workspaceId: foreign.workspace}]) assert.throws(() => decryptCredentials(current.encrypted_credentials, wrong), {status: 503});
    for (const wrong of [{projectId: foreign.project, accountId, apiToken: secret}, {projectId: f.project, accountId: 'b'.repeat(32), apiToken: secret}]) {
      await pool.query('UPDATE cloudflare_connection SET encrypted_credentials=$2 WHERE id=$1', [id, encryptCredentials(wrong, context)]);
      await assert.rejects(assertCloudflareCredentialsReadable(), {status: 503});
    }
    await pool.query('UPDATE cloudflare_connection SET encrypted_credentials=$2 WHERE id=$1', [id, current.encrypted_credentials]);
    process.env.CREDENTIAL_KEYS = JSON.stringify({other: randomBytes(32).toString('base64')}); process.env.CREDENTIAL_ACTIVE_KEY = 'other';
    await assert.rejects(assertCloudflareCredentialsReadable(), {status: 503});
    process.env.CREDENTIAL_KEYS = JSON.stringify({fixture: firstKey, next: randomBytes(32).toString('base64')}); process.env.CREDENTIAL_ACTIVE_KEY = 'next';
    assert.equal(await rotateCloudflareCredentials(), 1); await assertCloudflareCredentialsReadable();
    const rotated = await row(id); assert.equal(rotated.revision, current.revision); assert.equal(rotated.updated_at.getTime(), current.updated_at.getTime()); assert.equal(rotated.encrypted_credentials.keyId, 'next');
    delete process.env.CREDENTIAL_KEYS; delete process.env.CREDENTIAL_ACTIVE_KEY;
    await assert.rejects(save(f, body(id, 4)), {status: 503}); assert.equal((await row(id)).revision, 4);
    process.env.CREDENTIAL_KEYS = JSON.stringify({fixture: firstKey}); process.env.CREDENTIAL_ACTIVE_KEY = 'fixture';
    await pool.query('UPDATE cloudflare_connection SET encrypted_credentials=$2 WHERE id=$1', [id, current.encrypted_credentials]);
    console.log('PASS replacement races, disconnect/restoration, payload binding, missing keys and non-mutating key rotation');

    const lock = await pool.connect(); let waiting: Promise<unknown> | undefined;
    try {
      await lock.query('BEGIN'); await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [f.workspace]);
      waiting = getCloudflareConnections(f.project, viewer); const denied = assert.rejects(waiting, {status: 404});
      await new Promise(resolve => setTimeout(resolve, 25)); await lock.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2', [f.workspace, viewer]);
      await lock.query('COMMIT'); await denied;
    } finally { await lock.query('ROLLBACK'); lock.release(); await waiting?.catch(() => undefined); }
    await assert.rejects(getCloudflareConnections(f.project, viewer), {status: 404});
    const originalAck = await save(f, input); await pool.query('UPDATE membership SET role=\'admin\' WHERE workspace_id=$1 AND user_id=$2', [f.workspace, owner]);
    await assert.rejects(save(f, input), {status: 404}); assert.equal(originalAck.ack.revision, 1);
    await pool.query('UPDATE membership SET role=\'owner\' WHERE workspace_id=$1 AND user_id=$2', [f.workspace, owner]);
    console.log('PASS revocation after a read lock wait and current authority before original receipt replay');

    const owned = await fixture(); await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [owned.workspace, creator]);
    const created = await save(owned, body(), creator); await getBoss();
    const closure = await pool.connect();
    try { await closure.query('BEGIN'); await closeAccount(closure, creator, {kind: 'self', userId: creator}, {userId: creator, method: 'password'} as StepUpProof); await closure.query('COMMIT'); }
    catch (error) { await closure.query('ROLLBACK'); throw error; } finally { closure.release(); }
    await assert.rejects(getCloudflareConnections(owned.project, creator), {status: 404});
    assert.equal((await row(created.ack.connectionId)).created_by, creator); await assertCloudflareCredentialsReadable();
    await pool.query("UPDATE cloudflare_connection SET created_at=clock_timestamp()-interval '8 years' WHERE id=$1", [created.ack.connectionId]);
    const retained = await runRetentionBatch(owned.project); assert.equal(retained?.projectId, owned.project); assert.equal(retained.complete, true);
    const closedRetention = await runClosedAccountRetention();
    assert.equal(closedRetention.ledgerFailed, false); assert.equal(closedRetention.archiveFailed, false); assert.equal(closedRetention.tombstonesFailed, false);
    assert.ok(await row(created.ack.connectionId)); assert.ok((await pool.query('SELECT closed_at FROM "user" WHERE id=$1', [creator])).rows[0].closed_at);
    await deleteProject(owned.workspace, owned.project, owner, {requestId: randomUUID(), revision: 1, confirmation: 'DELETE'});
    assert.equal(await row(created.ack.connectionId), undefined); assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE project_id=$1', [owned.project])).rowCount, 0);
    await pool.query('DELETE FROM workspace WHERE id=$1', [f.workspace]); assert.equal(await row(id), undefined);
    assert.equal(outbound, 0); console.log('PASS creator closure, retention/tombstone preservation and native project/workspace deletion; zero external requests');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKeys === undefined) delete process.env.CREDENTIAL_KEYS; else process.env.CREDENTIAL_KEYS = previousKeys;
    if (previousActive === undefined) delete process.env.CREDENTIAL_ACTIVE_KEY; else process.env.CREDENTIAL_ACTIVE_KEY = previousActive;
    await stopJobs(); await closeDatabase();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCloudflareConnectionChecks();
