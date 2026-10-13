import type { Pool, PoolClient } from 'pg';

/** Browser-serialized HTTPS origin only: no wildcard, path, implicit subdomain or nondefault port. */
export function servingOriginHost(origin: unknown): string | null {
  if (typeof origin !== 'string' || origin.length > 2048) return null;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && !url.port && url.origin === origin ? url.hostname : null;
  } catch { return null; }
}

// A project-scoped call must run under the caller's project gate before accepting
// an observation or issuing configuration. The unscoped call is CORS preflight only.
export async function collectionOriginAllowed(db: Pool | PoolClient, origin: unknown, project?: { id: string; origin: string }) {
  if (typeof origin !== 'string' || origin.length > 2048) return false;
  if (project ? origin === project.origin : (await db.query('SELECT 1 FROM project WHERE origin=$1 LIMIT 1', [origin])).rowCount) return true;
  const hostname = servingOriginHost(origin);
  if (!hostname) return false;
  const result = await db.query(`SELECT 1 FROM project_domain WHERE ($1::text IS NULL OR project_id=$1)
    AND hostname=$2 AND role='serving' AND verified_at IS NOT NULL AND revoked_at IS NULL LIMIT 1`, [project?.id ?? null, hostname]);
  return !!result.rowCount;
}
