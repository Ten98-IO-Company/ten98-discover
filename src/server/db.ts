import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';
import { getConfig } from './config.ts';

let database: { pool: pg.Pool; db: ReturnType<typeof drizzle<typeof schema>> } | undefined;
export function getDatabase() {
  if (!database) {
    const pool = new pg.Pool({ connectionString: getConfig().databaseUrl, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 10000 });
    pool.on('error', () => console.error('Database connection failed; check database availability.'));
    database = { pool, db: drizzle(pool, { schema }) };
  }
  return database;
}
export async function closeDatabase() { if (database) { await database.pool.end(); database = undefined; } }

let migration: Promise<{ sql: string; checksum: string }> | undefined;
export function migrationSource() {
  if (!migration) migration = (async () => {
    // Git line-ending conversion must not change a migration's identity across host operating systems.
    const sql = (await readFile(join(process.cwd(), 'migrations', '0001_foundation.sql'), 'utf8')).replace(/\r\n?/g, '\n');
    return { sql, checksum: createHash('sha256').update(sql).digest('hex') };
  })().catch((error) => { migration = undefined; throw error; });
  return migration;
}

export async function assertSchema() {
  const { checksum } = await migrationSource();
  const { rows } = await getDatabase().pool.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_version');
  if (rows.length !== 1 || rows[0].version !== '0001' || rows[0].checksum !== checksum) {
    throw Object.assign(new Error('Database schema is incompatible with this application. Use the matching image and migrations.'), { code: 'SCHEMA_MISMATCH' });
  }
}
