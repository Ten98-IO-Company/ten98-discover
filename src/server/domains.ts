import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';

const DOMAIN_LIMIT = 50;
const specialSuffixes = ['localhost', 'local', 'internal', 'invalid', 'test', 'example', 'onion', 'home.arpa'];

/** Accept a DNS host, never a URL, address, wildcard or DNS-provider record-name shortcut. */
export function normalizePublicHostname(input: unknown): string {
  const invalid = () => new FoundationError(400, 'Enter a public hostname only, without a scheme, path, port or wildcard.');
  if (typeof input !== 'string' || !input || input.length > 1024 || /[\s\u0000-\u001f\u007f%/\\:@?#*]/u.test(input)) throw invalid();
  const raw = input.endsWith('.') ? input.slice(0, -1) : input;
  const ascii = domainToASCII(raw).toLowerCase();
  if (!ascii || ascii.length > 253 || isIP(ascii) || specialSuffixes.some(suffix => ascii === suffix || ascii.endsWith(`.${suffix}`))) throw invalid();
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+$/.test(labels.at(-1)!)) throw invalid();
  // WHATWG URL normalization also catches nonstandard IPv4 spellings (integer, hex, octal).
  try {
    const parsed = new URL(`https://${ascii}`);
    if (parsed.hostname !== ascii || isIP(parsed.hostname) || parsed.port || parsed.username || parsed.password) throw invalid();
  } catch { throw invalid(); }
  return ascii;
}

/** Registry hosts also need space for their ownership-proof record. */
export function normalizeDomainHost(input: unknown): string {
  const ascii = normalizePublicHostname(input);
  // The challenge prefix must also fit within the DNS name limit.
  if (`_ten98-challenge.${ascii}`.length > 253) throw new FoundationError(400, 'This hostname is too long for the DNS proof record.');
  return ascii;
}

type Project = { id: string; origin: string; canonicalHost: string; canonicalVerifiable: boolean };
type DomainRow = {
  id: string; hostname: string; role: 'canonical' | 'serving' | 'redirect_alias'; expected_target_host: string | null;
  created_at: Date; verified_at: Date | null; revoked_at: Date | null; challenge_hash: string | null; challenge_expires_at: Date | null;
};
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new FoundationError(400, 'Invalid domain settings.');
  return result.data;
}
const idSchema = z.uuid();
const detailsSchema = z.object({ role: z.enum(['serving', 'redirect_alias']), expectedTargetHost: z.string().max(1024).optional() }).strict();
const addSchema = detailsSchema.extend({ hostname: z.string().min(1).max(1024) }).strict();
const emptySchema = z.object({}).strict();

function projectDto(row: { id: string; origin: string }): Project {
  const hostname = new URL(row.origin).hostname;
  try { return { ...row, canonicalHost: normalizeDomainHost(hostname), canonicalVerifiable: true }; }
  catch { return { ...row, canonicalHost: hostname, canonicalVerifiable: false }; }
}

export async function withDomainProject<T>(projectId: unknown, userId: unknown, operation: (client: PoolClient, project: Project) => Promise<T>): Promise<T> {
  const pid = parse(idSchema, projectId), uid = parse(idSchema, userId);
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT workspace_id FROM project WHERE id=$1', [pid]);
    if (!found.rowCount) throw new FoundationError(404, 'Project not found or unavailable.');
    // All domain writes and role changes share this lock; re-read membership after acquiring it.
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [found.rows[0].workspace_id]);
    const authorized = await client.query(`SELECT p.id,p.origin FROM project p JOIN membership m ON m.workspace_id=p.workspace_id
      WHERE p.id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin') FOR UPDATE OF p`, [pid, uid]);
    if (!authorized.rowCount) throw new FoundationError(404, 'Project not found or unavailable.');
    const project = projectDto(authorized.rows[0]);
    if (project.canonicalVerifiable) await client.query(`INSERT INTO project_domain(id,project_id,hostname,role)
      VALUES($1,$2,$3,'canonical') ON CONFLICT(project_id,hostname) DO NOTHING`, [randomUUID(), pid, project.canonicalHost]);
    const result = await operation(client, project);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function stateDto(client: PoolClient, project: Project) {
  const result = await client.query<DomainRow>('SELECT * FROM project_domain WHERE project_id=$1 ORDER BY (role=\'canonical\') DESC,hostname', [project.id]);
  return { project, domains: result.rows.map(row => ({
    id: row.id, hostname: row.hostname, role: row.role, expectedTargetHost: row.expected_target_host,
    status: row.revoked_at ? 'revoked' as const : row.verified_at ? 'verified' as const : row.challenge_expires_at
      ? row.challenge_expires_at.getTime() > Date.now() ? 'pending' as const : 'expired' as const : 'unverified' as const,
    createdAt: row.created_at.toISOString(), verifiedAt: row.verified_at?.toISOString() ?? null,
    challengeExpiresAt: row.challenge_expires_at?.toISOString() ?? null,
  })), limit: DOMAIN_LIMIT };
}

async function domainRow(client: PoolClient, projectId: string, domainId: unknown): Promise<DomainRow> {
  const id = parse(idSchema, domainId);
  const result = await client.query<DomainRow>('SELECT * FROM project_domain WHERE id=$1 AND project_id=$2 FOR UPDATE', [id, projectId]);
  if (!result.rowCount) throw new FoundationError(404, 'Domain not found or unavailable.');
  return result.rows[0];
}

async function rotateCollectionConsent(client: PoolClient, project: Project, row: DomainRow, change: Partial<DomainRow>) {
  const eligible = (domain: DomainRow) => domain.role === 'serving' && !!domain.verified_at && !domain.revoked_at && `https://${domain.hostname}` !== project.origin;
  if (eligible(row) !== eligible({ ...row, ...change })) await client.query('UPDATE project SET analytics_epoch=$2 WHERE id=$1', [project.id, randomUUID()]);
}

function expectedTarget(project: Project, hostname: string, details: z.infer<typeof detailsSchema>): string | null {
  if (details.role === 'serving') {
    if (details.expectedTargetHost !== undefined) throw new FoundationError(400, 'Only redirect aliases have an expected target.');
    return null;
  }
  const target = normalizePublicHostname(details.expectedTargetHost ?? project.canonicalHost);
  if (target === hostname) throw new FoundationError(400, 'A redirect alias must point to a different expected hostname.');
  return target;
}

export async function getDomains(projectId: unknown, userId: unknown) {
  return withDomainProject(projectId, userId, stateDto);
}

export async function addDomain(projectId: unknown, userId: unknown, input: unknown) {
  const details = parse(addSchema, input), hostname = normalizeDomainHost(details.hostname);
  return withDomainProject(projectId, userId, async (client, project) => {
    const target = expectedTarget(project, hostname, details);
    const count = await client.query('SELECT count(*)::int AS count FROM project_domain WHERE project_id=$1', [project.id]);
    if (count.rows[0].count >= DOMAIN_LIMIT) throw new FoundationError(409, 'This project has reached its 50-domain limit.');
    const inserted = await client.query(`INSERT INTO project_domain(id,project_id,hostname,role,expected_target_host)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,hostname) DO NOTHING RETURNING id`, [randomUUID(), project.id, hostname, details.role, target]);
    if (!inserted.rowCount) throw new FoundationError(409, 'This hostname is already in this project.');
    return stateDto(client, project);
  });
}

export async function updateDomain(projectId: unknown, userId: unknown, domainId: unknown, input: unknown) {
  const details = parse(detailsSchema, input);
  return withDomainProject(projectId, userId, async (client, project) => {
    const row = await domainRow(client, project.id, domainId);
    if (row.role === 'canonical') throw new FoundationError(409, 'The canonical domain is fixed by the project origin.');
    const target = expectedTarget(project, row.hostname, details);
    await client.query('UPDATE project_domain SET role=$1,expected_target_host=$2,redirect_revision=redirect_revision+CASE WHEN role IS DISTINCT FROM $1 OR expected_target_host IS DISTINCT FROM $2 THEN 1 ELSE 0 END WHERE id=$3 AND project_id=$4', [details.role, target, row.id, project.id]);
    await rotateCollectionConsent(client, project, row, { role: details.role });
    return stateDto(client, project);
  });
}

export async function issueDomainChallenge(projectId: unknown, userId: unknown, domainId: unknown, input: unknown) {
  parse(emptySchema, input);
  return withDomainProject(projectId, userId, async (client, project) => {
    const row = await domainRow(client, project.id, domainId);
    const value = `ten98-verification=${project.id}.${row.id}.${randomBytes(32).toString('base64url')}`;
    const result = await client.query(`UPDATE project_domain SET challenge_hash=$1,challenge_expires_at=clock_timestamp()+interval '24 hours',
      verified_at=NULL,revoked_at=NULL,redirect_revision=redirect_revision+1 WHERE id=$2 AND project_id=$3 RETURNING challenge_expires_at`, [createHash('sha256').update(value).digest('hex'), row.id, project.id]);
    await rotateCollectionConsent(client, project, row, { verified_at: null, revoked_at: null });
    return { state: await stateDto(client, project), challenge: { domainId: row.id, name: `_ten98-challenge.${row.hostname}`,
      type: 'TXT' as const, value, expiresAt: result.rows[0].challenge_expires_at.toISOString() as string } };
  });
}

// Independent resolver: cancellation never affects another request's DNS lookups.
export async function lookupDomainTxt(name: string): Promise<string[][]> {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver.resolveTxt(name),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        resolver.cancel();
        reject(Object.assign(new Error('DNS lookup timed out.'), { code: 'ETIMEOUT' }));
      }, 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function hasDomainProof(records: string[][], hash: string): boolean {
  if (!Array.isArray(records) || records.length > 64 || hash.length !== 64 || !/^[0-9a-f]{64}$/.test(hash)) return false;
  let bytes = 0, found = false;
  for (const chunks of records) {
    if (!Array.isArray(chunks) || chunks.length > 256 || chunks.some(chunk => typeof chunk !== 'string')) return false;
    const value = chunks.join('');
    bytes += Buffer.byteLength(value);
    if (bytes > 65_536) return false;
    if (timingSafeEqual(createHash('sha256').update(value).digest(), Buffer.from(hash, 'hex'))) found = true;
  }
  return found;
}

export async function verifyDomain(projectId: unknown, userId: unknown, domainId: unknown, input: unknown,
  lookup: (name: string) => Promise<string[][]> = lookupDomainTxt) {
  parse(emptySchema, input);
  const snapshot = await withDomainProject(projectId, userId, async (client, project) => {
    const row = await domainRow(client, project.id, domainId);
    if (!row.challenge_hash || !row.challenge_expires_at || row.challenge_expires_at.getTime() <= Date.now()) {
      throw new FoundationError(409, 'Create a new DNS proof before verifying.');
    }
    return { hostname: row.hostname, hash: row.challenge_hash };
  });
  // Never hold a workspace transaction open across an external DNS request.
  let matched = false, unavailable = false;
  try { matched = hasDomainProof(await lookup(`_ten98-challenge.${snapshot.hostname}`), snapshot.hash); }
  catch (error) { unavailable = !['ENODATA', 'ENOTFOUND'].includes((error as { code?: string })?.code ?? ''); }
  return withDomainProject(projectId, userId, async (client, project) => {
    const row = await domainRow(client, project.id, domainId);
    if (row.challenge_hash !== snapshot.hash || !row.challenge_expires_at || row.challenge_expires_at.getTime() <= Date.now()) {
      throw new FoundationError(409, 'The DNS proof changed or expired. Refresh and create a new proof if needed.');
    }
    if (unavailable) throw new FoundationError(503, 'DNS could not be checked. Try again shortly.');
    if (!matched) throw new FoundationError(422, 'The exact TXT proof was not found. Check the record and allow time for DNS propagation.');
    const changed = await client.query(`UPDATE project_domain SET verified_at=clock_timestamp(),challenge_hash=NULL,challenge_expires_at=NULL,revoked_at=NULL,redirect_revision=redirect_revision+1
      WHERE id=$1 AND project_id=$2 AND challenge_hash=$3 AND challenge_expires_at>clock_timestamp() RETURNING id`, [row.id, project.id, snapshot.hash]);
    if (!changed.rowCount) throw new FoundationError(409, 'The DNS proof expired. Create a new proof.');
    await rotateCollectionConsent(client, project, row, { verified_at: new Date(), revoked_at: null });
    return stateDto(client, project);
  });
}

export async function revokeDomain(projectId: unknown, userId: unknown, domainId: unknown, input: unknown) {
  parse(emptySchema, input);
  return withDomainProject(projectId, userId, async (client, project) => {
    const row = await domainRow(client, project.id, domainId);
    await client.query(`UPDATE project_domain SET verified_at=NULL,challenge_hash=NULL,challenge_expires_at=NULL,revoked_at=clock_timestamp(),redirect_revision=redirect_revision+1
      WHERE id=$1 AND project_id=$2`, [row.id, project.id]);
    await rotateCollectionConsent(client, project, row, { verified_at: null, revoked_at: new Date() });
    return stateDto(client, project);
  });
}

export async function removeDomain(projectId: unknown, userId: unknown, domainId: unknown, input: unknown) {
  parse(emptySchema, input);
  return withDomainProject(projectId, userId, async (client, project) => {
    const row = await domainRow(client, project.id, domainId);
    if (row.role === 'canonical') throw new FoundationError(409, 'The canonical domain cannot be removed.');
    await client.query('DELETE FROM project_domain WHERE id=$1 AND project_id=$2', [row.id, project.id]);
    await rotateCollectionConsent(client, project, row, { verified_at: null });
    return stateDto(client, project);
  });
}
