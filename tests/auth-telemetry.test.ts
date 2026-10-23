import assert from 'node:assert/strict';
import test from 'node:test';

// Self-hosted installs send no data to Ten98 or third parties: Better Auth telemetry stays pinned off, even if the
// library default or the BETTER_AUTH_TELEMETRY environment variable changes.
test('Better Auth telemetry is pinned off', async () => {
  Object.assign(process.env, { APP_URL: 'http://localhost:3000', AUTH_SECRET: 'a'.repeat(32), BOOTSTRAP_TOKEN: 'b'.repeat(32), DATABASE_URL: 'postgresql://synthetic@localhost:5432/synthetic' });
  const { getAuth } = await import('../src/server/auth.ts');
  const { closeDatabase } = await import('../src/server/db.ts');
  try {
    assert.deepEqual(getAuth().options.telemetry, { enabled: false });
  } finally {
    await closeDatabase();
  }
});
