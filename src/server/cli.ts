import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from './config.ts';
import { assertSchema, closeDatabase, getDatabase, migrationSources, pendingMigrations } from './db.ts';
import { startWorker, stopJobs } from './jobs.ts';
import { assertCredentialKeys, rotateCredentialEncryption } from './providers.ts';
import { assertOidcCredentialsReadable, rotateOidcCredentials } from './oidc.ts';
import { assertGoogleCredentialsReadable, rotateGoogleCredentials } from './google.ts';
import {initializeProviderAccountIdentity,assertProviderAccountIdentityReadable,rotateProviderAccountIdentityEncryption} from './provider-account-identity.ts';
import { setInstanceOperator } from './instance-operators.ts';
import { quarantineRestoredSpending } from './restore-quarantine.ts';

class CliError extends Error {}

async function setup() {
  const password = randomBytes(32).toString('hex');
  const contents = [
    '# Keep this file private. Never commit it or paste it into support requests.',
    'APP_URL=http://localhost:3000', 'APP_PORT=3000',
    `POSTGRES_PASSWORD=${password}`,
    `DATABASE_URL=postgres://ten98:${password}@postgres:5432/ten98`,
    `AUTH_SECRET=${randomBytes(32).toString('hex')}`,
    `BOOTSTRAP_TOKEN=${randomBytes(32).toString('hex')}`,
    `CREDENTIAL_KEYS=${JSON.stringify({ v1: randomBytes(32).toString('base64') })}`,
    'CREDENTIAL_ACTIVE_KEY=v1',
    'ARTIFACT_DIR=./data/artifacts', '',
  ].join('\n');
  try {
    await writeFile(join(process.cwd(), '.env'), contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('Setup stopped: .env already exists and was not changed.');
    throw new CliError('Setup could not create .env. Check directory permissions.');
  }
  console.log('Created .env with fresh credentials. Read it privately for the owner bootstrap token. No database was changed.');
}

async function migrate() {
  await migrationSources();
  const client = await getDatabase().pool.connect();
  const applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [109857, 1]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_version (version text PRIMARY KEY, checksum text NOT NULL)');
    const current = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_version ORDER BY version');
    for (const migration of await pendingMigrations(current.rows)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_version(version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
      applied.push(migration.version);
    }
    // Identity guards inspect every financial-reference table. Create all pending
    // tables first, but keep key capture and the entire upgrade in one transaction.
    if(applied.includes('0022')||applied.includes('0023'))await initializeProviderAccountIdentity(client,applied.includes('0022'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  console.log(applied.length ? `Database migrations applied: ${applied.join(', ')}.` : 'Database migrations already applied; all checksums verified.');
}

async function diagnose(checkWorker: boolean) {
  const config = getConfig();
  console.log('Configuration: valid (credentials redacted).');
  const checks: [string, () => Promise<unknown>][] = [
    ['Database connection', () => getDatabase().pool.query('SELECT 1')],
    ['Database schema', assertSchema],
    ['Provider credential keyring', assertCredentialKeys],
    ['Identity credential keyring', assertOidcCredentialsReadable],
    ['Google reporting credential keyring', assertGoogleCredentialsReadable],
    ['Provider account recovery keyring', assertProviderAccountIdentityReadable],
    ['Artifact directory', async () => {
      await mkdir(config.artifactDir, { recursive: true, mode: 0o700 });
      const path = join(config.artifactDir, `.write-check-${randomUUID()}`);
      await writeFile(path, '', { flag: 'wx', mode: 0o600 });
      await unlink(path);
    }],
  ];
  if (checkWorker) checks.push(['Worker heartbeat', async () => {
    const result = await getDatabase().pool.query(
      `SELECT 1 FROM worker_heartbeat WHERE id = 'foundation-worker'
       AND last_seen_at > now() - interval '30 seconds' AND last_seen_at <= now()`,
    );
    if (result.rows.length !== 1) throw new CliError('Worker has no recent heartbeat.');
  }]);
  for (const [label, check] of checks) {
    try {
      await check();
      console.log(`${label}: ready.`);
    } catch {
      console.error(`${label}: unavailable. Check configuration, permissions and service health.`);
      process.exitCode = 1;
    }
  }
}

async function worker() {
  await assertSchema();
  await assertCredentialKeys();
  await assertOidcCredentialsReadable();
  await assertGoogleCredentialsReadable();
  await assertProviderAccountIdentityReadable();
  await startWorker();
  console.log('Foundation worker ready. Explicit Google imports are enabled; no provider scheduler is active.');
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
}

try {
  const [command, option, ...extra] = process.argv.slice(2);
  const usage = 'Usage: cli.ts setup | migrate | rekey | restore-quarantine | worker | diagnose [worker] | operator grant|revoke <existing-account-email>';
  if (command === 'operator' ? !['grant', 'revoke'].includes(option) || extra.length !== 1 : extra.length || (option && !(command === 'diagnose' && option === 'worker'))) {
    throw new CliError(usage);
  }
  switch (command) {
    case 'setup': await setup(); break;
    case 'migrate': await migrate(); break;
    case 'restore-quarantine': {
      await assertSchema();
      const result = await quarantineRestoredSpending();
      console.log(`Restore spending quarantine applied: ${result.pausedBudgets} budgets paused, ${result.cancelledReservations} reservations cancelled, ${result.disabledSchedules} schedules disabled.`);
      console.log('Keep workers stopped until restored imports, crawls and provider receipts are reviewed. No provider requests were made.');
      break;
    }
    case 'rekey': {
      await assertSchema();
      const providers = await rotateCredentialEncryption();
      const identities = await rotateOidcCredentials();
      await rotateGoogleCredentials();
      await rotateProviderAccountIdentityEncryption();
      console.log(`Re-encrypted ${providers} provider connections and ${identities} identity records with the active key. Keep old keys for backups.`);
      console.log('Google reporting credentials re-encrypted with the active key.');
      console.log('Provider account recovery keys re-encrypted with the active key.');
      break;
    }
    case 'operator': await assertSchema(); await setInstanceOperator(extra[0], option === 'grant'); console.log('Instance operator role updated and audited.'); break;
    case 'worker': await worker(); break;
    case 'diagnose': await diagnose(option === 'worker'); break;
    default: throw new CliError(usage);
  }
} catch (error) {
  console.error(error instanceof CliError ? error.message
    : (error as { code?: string })?.code === 'SCHEMA_MISMATCH' ? 'Database schema is incompatible with this application. Use the matching image and migrations.'
    : 'Command failed. Check configuration, database availability, schema and filesystem permissions; credentials have been redacted.');
  process.exitCode = 1;
} finally {
  await stopJobs().catch(() => { console.error('Job shutdown failed.'); process.exitCode = 1; });
  await closeDatabase().catch(() => { console.error('Database shutdown failed.'); process.exitCode = 1; });
}
