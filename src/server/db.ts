import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';
import { getConfig } from './config.ts';
import { registerResourceCleanup } from './resource-cleanup.ts';

let database: { pool: pg.Pool; db: ReturnType<typeof drizzle<typeof schema>> } | undefined;
export function getDatabase() {
  if (!database) {
    const pool = new pg.Pool({ connectionString: getConfig().databaseUrl, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 10000 });
    pool.on('error', () => console.error('Database connection failed; check database availability.'));
    database = { pool, db: drizzle(pool, { schema }) };
    registerResourceCleanup('database', closeDatabase);
  }
  return database;
}
export async function closeDatabase() { if (database) { await database.pool.end(); database = undefined; } }

const migrationFiles = ['0001_foundation.sql', '0002_teams.sql', '0003_analytics.sql', '0004_account_security.sql', '0005_provider_core.sql', '0006_api_keys.sql', '0007_oidc.sql', '0008_destinations.sql', '0009_oidc_account_security.sql', '0010_reports.sql', '0011_domains.sql', '0012_native_analytics.sql', '0013_retention.sql', '0014_project_context.sql', '0015_google_imports.sql', '0016_keyword_research.sql', '0017_prompt_execution.sql', '0018_domain_redirect_checks.sql', '0019_site_audits.sql', '0020_funnels.sql', '0021_saved_keywords.sql', '0022_provider_account_identity.sql', '0023_rank_tracking.sql', '0024_rank_authored_revision.sql', '0025_meta_auth.sql', '0026_meta_imports.sql', '0027_meta_report_profiles.sql', '0028_meta_campaign_inventory.sql', '0029_meta_observed_cooldowns.sql', '0030_citation_context.sql', '0031_ai_suggestions.sql', '0032_site_audit_body.sql', '0033_analytics_segments.sql'] as const;
type Migration = Readonly<{ version: string; filename: string; sql: string; checksum: string }>;
type AppliedMigration = Readonly<{ version: string; checksum: string }>;
let migrations: Promise<readonly Migration[]> | undefined;

export function migrationSources(): Promise<readonly Migration[]> {
  if (!migrations) migrations = Promise.all(migrationFiles.map(async (filename) => {
    // Git line-ending conversion must not change a migration's identity across host operating systems.
    const sql = (await readFile(join(process.cwd(), 'migrations', filename), 'utf8')).replace(/\r\n?/g, '\n');
    return Object.freeze({ version: filename.slice(0, 4), filename, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  })).then((sources) => Object.freeze(sources)).catch((error) => { migrations = undefined; throw error; });
  return migrations;
}

// Preserve the original foundation checksum contract used by existing integration checks.
export async function migrationSource() { return (await migrationSources())[0]; }

function schemaMismatch() {
  return Object.assign(new Error('Database schema is incompatible with this application. Use the matching image and migrations.'), { code: 'SCHEMA_MISMATCH' });
}

export async function pendingMigrations(applied: readonly AppliedMigration[]): Promise<readonly Migration[]> {
  const sources = await migrationSources();
  if (applied.length > sources.length || applied.some((row, index) => row.version !== sources[index].version || row.checksum !== sources[index].checksum)) {
    throw schemaMismatch();
  }
  return sources.slice(applied.length);
}

export async function assertSchema() {
  const { rows } = await getDatabase().pool.query<AppliedMigration>('SELECT version, checksum FROM schema_version ORDER BY version');
  if ((await pendingMigrations(rows)).length !== 0) throw schemaMismatch();
}
