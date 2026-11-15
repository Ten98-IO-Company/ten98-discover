import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { FoundationError } from '../src/server/auth.ts';
import { getGoogleApp, saveGoogleApp } from '../src/server/google.ts';
import { InputError } from '../src/server/validation.ts';

// Synthetic configuration only: the fake pool below answers every query and no database connection is opened.
Object.assign(process.env, { APP_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:9/unused_google_app_unit', AUTH_SECRET: 'google-app-unit-auth-only-'.repeat(3), BOOTSTRAP_TOKEN: 'google-app-unit-bootstrap-only-'.repeat(3), ANALYTICS_NETWORK_MODE: 'off' });
for (const name of ['AUTH_SECRET_FILE', 'BOOTSTRAP_TOKEN_FILE', 'DATABASE_URL_FILE', 'CREDENTIAL_KEYS', 'CREDENTIAL_KEYS_FILE', 'CREDENTIAL_ACTIVE_KEY']) delete process.env[name];

const databaseKey = Symbol.for('ten98-discover.database');
const globals = globalThis as typeof globalThis & { [databaseKey]?: unknown };
// Workspace roles carry no Google app authority, so the owner, viewer and unassigned users differ only by not being the operator.
const operator = randomUUID(), owner = randomUUID(), viewer = randomUUID(), unassigned = randomUUID();
let prior: unknown, appQueries: number, app: Record<string, unknown> | undefined;
const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
const pool = { async query(sql: string, values: unknown[] = []) {
  if (sql.includes('FROM instance_operator')) return result(values[0] === operator ? [{ user_id: operator }] : []);
  if (sql.includes('FROM google_app')) { appQueries++; return result(app ? [app] : []); }
  throw new Error(`Unexpected query: ${sql}`);
} };

beforeEach(() => { prior = globals[databaseKey]; globals[databaseKey] = { pool }; appQueries = 0; app = { id: 'instance', revision: 3, client_id: '123-fixture.apps.googleusercontent.com', encrypted_secret: 'sealed', enabled: true, testing: false }; });
afterEach(() => { if (prior === undefined) delete globals[databaseKey]; else globals[databaseKey] = prior; });

test('the instance operator reads the full Google app settings', async () => {
  assert.deepEqual(await getGoogleApp(operator), { configured: true, enabled: true, testing: false, vaultConfigured: false, redirectUri: 'http://localhost:3000/api/google/callback', operator: true, revision: 3, clientId: '123-fixture.apps.googleusercontent.com' });
  app = undefined;
  assert.deepEqual(await getGoogleApp(operator), { configured: false, enabled: false, testing: true, vaultConfigured: false, redirectUri: 'http://localhost:3000/api/google/callback', operator: true, revision: 0 });
});

test('workspace owners, members without rights and users with no workspace are refused before the settings are read', async () => {
  for (const userId of [owner, viewer, unassigned]) {
    await assert.rejects(getGoogleApp(userId), (error: unknown) => error instanceof FoundationError && error.status === 403, userId);
  }
  assert.equal(appQueries, 0);
});

test('a non-operator gets the same 403 for an invalid or a valid Google app body, before the body is read', async () => {
  const bodies: Record<string, () => Promise<unknown>> = {
    valid: async () => ({ revision: 3, clientId: '123-fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret', enabled: true, testing: false }),
    invalid: async () => ({ revision: -1, clientId: 'not-a-client-id', extra: true }),
    unreadable: async () => { throw new InputError(415, 'content-type must be application/json'); },
  };
  for (const userId of [owner, viewer, unassigned]) {
    const answers = new Set<string>();
    for (const [name, body] of Object.entries(bodies)) {
      let read = false;
      const error = await saveGoogleApp(userId, () => { read = true; return body(); }).then(() => undefined, (failure: unknown) => failure);
      assert.ok(error instanceof FoundationError && error.status === 403, `${userId} ${name}`);
      assert.equal(read, false, `${userId} ${name}`);
      answers.add(`${error.status} ${error.message}`);
    }
    assert.equal(answers.size, 1);
  }
  // Control: the operator's invalid body still reaches field validation.
  await assert.rejects(saveGoogleApp(operator, bodies.invalid), (error: unknown) => error instanceof FoundationError && error.status === 400);
  assert.equal(appQueries, 0);
});
