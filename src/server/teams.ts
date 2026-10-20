import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mayGrantWorkspaceRole as mayGrant, workspaceRoles, type WorkspaceRole as Role } from '@ten98/runtime';
import type { PoolClient } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';

type Workspace = { id: string; name: string };
type Invitation = { id: string; email: string; role: Exclude<Role, 'owner'>; expiresAt: Date };
const idInput = z.uuid();
const nameInput = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const emailInput = z.string().trim().toLowerCase().max(254).email();
const tokenInput = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const roleInput = z.enum(workspaceRoles);
const invitationInput = z.object({ email: emailInput, role: roleInput.exclude(['owner']) }).strict();

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new FoundationError(400, 'Check the submitted fields and try again.');
  return result.data;
}

function unavailable(): never {
  throw new FoundationError(410, 'This invitation is unavailable or expired. Ask for a new invitation.');
}

function tokenDigest(token: string) { return createHash('sha256').update(token).digest('hex'); }

async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function lockWorkspace(client: PoolClient, workspaceId: string): Promise<Workspace> {
  const result = await client.query<Workspace>('SELECT id,name FROM workspace WHERE id=$1 FOR UPDATE', [workspaceId]);
  if (!result.rows[0]) throw new FoundationError(404, 'Workspace not found or unavailable.');
  return result.rows[0];
}

async function managerRole(client: PoolClient, workspaceId: string, userId: string): Promise<'owner' | 'admin'> {
  const result = await client.query<{ role: Role }>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
  const role = result.rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw new FoundationError(404, 'Workspace not found or unavailable.');
  return role;
}

function requireGrant(actor: Role, role: Role) {
  if (!mayGrant(actor, role)) throw new FoundationError(403, 'Only an owner can manage owners and administrators.');
}

async function preserveOwner(client: PoolClient, workspaceId: string, previous: Role, next?: Role) {
  if (previous !== 'owner' || next === 'owner') return;
  const result = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM membership WHERE workspace_id=$1 AND role='owner'", [workspaceId]);
  if (result.rows[0].count <= 1) throw new FoundationError(409, 'Assign another owner before removing or changing the last owner.');
}

export async function createWorkspace(userId: string, input: unknown) {
  parse(idInput, userId);
  const { name } = parse(nameInput, input);
  return transaction(async (client) => {
    const user = await client.query('SELECT id FROM "user" WHERE id=$1', [userId]);
    if (!user.rowCount) throw new FoundationError(401, 'Sign in to continue.');
    const workspace = { id: randomUUID(), name };
    await client.query('INSERT INTO workspace(id,name) VALUES($1,$2)', [workspace.id, workspace.name]);
    await client.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspace.id, userId]);
    return { workspace, role: 'owner' as const };
  });
}

export async function renameWorkspace(workspaceId: string, userId: string, input: unknown) {
  parse(idInput, workspaceId); parse(idInput, userId);
  const { name } = parse(nameInput, input);
  return transaction(async (client) => {
    await lockWorkspace(client, workspaceId);
    const role = await managerRole(client, workspaceId, userId);
    await client.query('UPDATE workspace SET name=$1 WHERE id=$2', [name, workspaceId]);
    return { workspace: { id: workspaceId, name }, role };
  });
}

export async function getTeam(workspaceId: string, userId: string) {
  parse(idInput, workspaceId); parse(idInput, userId);
  return transaction(async (client) => {
    const workspace = await lockWorkspace(client, workspaceId);
    const role = await managerRole(client, workspaceId, userId);
    const members = await client.query<{ userId: string; name: string; email: string; role: Role }>(
      `SELECT u.id AS "userId",u.name,u.email,m.role FROM membership m JOIN "user" u ON u.id=m.user_id
       WHERE m.workspace_id=$1 ORDER BY u.name,u.id`, [workspaceId],
    );
    const invitations = await client.query<Invitation>(
      `SELECT i.id,i.email,i.role,i.expires_at AS "expiresAt" FROM workspace_invitation i
       JOIN membership m ON m.workspace_id=i.workspace_id AND m.user_id=i.inviter_id
       WHERE i.workspace_id=$1 AND i.expires_at>clock_timestamp()
       AND (m.role='owner' OR (m.role='admin' AND i.role IN ('editor','viewer')))
       ORDER BY i.created_at,i.id`, [workspaceId],
    );
    const required = await client.query('SELECT 1 FROM workspace_two_factor_requirement WHERE workspace_id=$1', [workspaceId]);
    return { workspace: { ...workspace, twoFactorRequired: required.rowCount === 1 }, role, members: members.rows, invitations: invitations.rows };
  });
}

const factorGatedPath = /^\/api\/(workspaces|projects)\/([0-9a-f-]{36})(?:\/|$)/i;
const lockedMember = `SELECT 1 FROM workspace_two_factor_requirement r JOIN membership m ON m.workspace_id=r.workspace_id AND m.user_id=$2
  JOIN "user" u ON u.id=m.user_id WHERE NOT u."twoFactorEnabled" AND r.workspace_id=`;

// ponytail: point-in-time check before each service transaction (the projectAccess class); a request already past it when the
// requirement turns on or the member disables their factor can finish. Soundness relies on verify/disable revoking other sessions
// (keepResponseSession in account-security.ts) and on no session being created without the factor challenge. Upgrade path:
// carry the predicate into each service's post-wait membership recheck.
/** Refuses a member without a verified factor on every workspace and website route of a workspace that requires one. */
export async function requireWorkspaceFactor(path: string, userId: string): Promise<void> {
  const match = factorGatedPath.exec(path);
  if (!match) return;
  // Non-members find no row and fall through to the service's own 404.
  const target = match[1].toLowerCase() === 'workspaces' ? '$1' : '(SELECT workspace_id FROM project WHERE id=$1)';
  const locked = await getDatabase().pool.query(lockedMember + target, [match[2].toLowerCase(), userId]);
  if (locked.rowCount) throw new FoundationError(403, 'This workspace requires two-factor authentication. Turn it on in Account security, then try again.');
}

/** Owner-only: require or stop requiring a verified second factor for every member of this workspace. */
export async function setTwoFactorRequirement(workspaceId: string, userId: string, input: unknown) {
  parse(idInput, workspaceId); parse(idInput, userId);
  const { required } = parse(z.object({ required: z.boolean() }).strict(), input);
  return transaction(async (client) => {
    await lockWorkspace(client, workspaceId);
    if (await managerRole(client, workspaceId, userId) !== 'owner') throw new FoundationError(403, 'Only a workspace owner can change the two-factor requirement.');
    if (required) {
      // FOR SHARE: the owner's own concurrent factor disable either commits first (409) or waits for this change.
      const actor = await client.query<{ twoFactorEnabled: boolean }>('SELECT "twoFactorEnabled" FROM "user" WHERE id=$1 FOR SHARE', [userId]);
      if (!actor.rows[0]?.twoFactorEnabled) throw new FoundationError(409, 'Turn on two-factor authentication for your own account before requiring it for this workspace.');
      await client.query('INSERT INTO workspace_two_factor_requirement(workspace_id) VALUES($1) ON CONFLICT DO NOTHING', [workspaceId]);
    } else await client.query('DELETE FROM workspace_two_factor_requirement WHERE workspace_id=$1', [workspaceId]);
    return { twoFactorRequired: required };
  });
}

export async function inviteMember(workspaceId: string, userId: string, input: unknown) {
  parse(idInput, workspaceId); parse(idInput, userId);
  const details = parse(invitationInput, input);
  return transaction(async (client) => {
    await lockWorkspace(client, workspaceId);
    const actor = await managerRole(client, workspaceId, userId);
    requireGrant(actor, details.role);
    const previous = await client.query<{ role: Role }>('SELECT role FROM workspace_invitation WHERE workspace_id=$1 AND email=$2', [workspaceId, details.email]);
    if (previous.rows[0]) requireGrant(actor, previous.rows[0].role);
    await client.query('DELETE FROM workspace_invitation WHERE workspace_id=$1 AND email=$2', [workspaceId, details.email]);
    const token = randomBytes(32).toString('base64url');
    const result = await client.query<Invitation>(
      `INSERT INTO workspace_invitation(id,workspace_id,inviter_id,email,role,token_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '7 days')
       RETURNING id,email,role,expires_at AS "expiresAt"`,
      [randomUUID(), workspaceId, userId, details.email, details.role, tokenDigest(token)],
    );
    return { invitation: result.rows[0], token };
  });
}

export async function revokeInvitation(workspaceId: string, userId: string, invitationId: string): Promise<void> {
  parse(idInput, workspaceId); parse(idInput, userId); parse(idInput, invitationId);
  await transaction(async (client) => {
    await lockWorkspace(client, workspaceId);
    const actor = await managerRole(client, workspaceId, userId);
    const invitation = await client.query<{ role: Role }>('SELECT role FROM workspace_invitation WHERE workspace_id=$1 AND id=$2', [workspaceId, invitationId]);
    if (!invitation.rows[0]) throw new FoundationError(404, 'Invitation not found or unavailable.');
    requireGrant(actor, invitation.rows[0].role);
    await client.query('DELETE FROM workspace_invitation WHERE workspace_id=$1 AND id=$2', [workspaceId, invitationId]);
  });
}

export async function changeRole(workspaceId: string, userId: string, targetUserId: string, input: unknown): Promise<void> {
  parse(idInput, workspaceId); parse(idInput, userId); parse(idInput, targetUserId);
  const { role } = parse(z.object({ role: roleInput }).strict(), input);
  await transaction(async (client) => {
    await lockWorkspace(client, workspaceId);
    const actor = await managerRole(client, workspaceId, userId);
    const target = await client.query<{ role: Role }>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, targetUserId]);
    if (!target.rows[0]) throw new FoundationError(404, 'Member not found or unavailable.');
    requireGrant(actor, target.rows[0].role); requireGrant(actor, role);
    await preserveOwner(client, workspaceId, target.rows[0].role, role);
    await client.query('UPDATE membership SET role=$1 WHERE workspace_id=$2 AND user_id=$3', [role, workspaceId, targetUserId]);
    await client.query(
      `DELETE FROM workspace_invitation WHERE workspace_id=$1 AND inviter_id=$2
       AND ($3::text NOT IN ('owner','admin') OR ($3='admin' AND role='admin'))`, [workspaceId, targetUserId, role],
    );
  });
}

/** Promote an existing member and demote this owner in the same workspace transaction. */
export async function transferOwnership(workspaceId: string, userId: string, input: unknown) {
  parse(idInput, workspaceId); parse(idInput, userId);
  const { targetUserId, confirmationEmail } = parse(z.object({ targetUserId: idInput, confirmationEmail: emailInput }).strict(), input);
  if (targetUserId === userId) throw new FoundationError(400, 'Choose another existing workspace member.');
  return transaction(async (client) => {
    await lockWorkspace(client, workspaceId);
    if (await managerRole(client, workspaceId, userId) !== 'owner') throw new FoundationError(403, 'Only a current owner can transfer ownership.');
    const target = await client.query<{ email: string }>(
      'SELECT u.email FROM membership m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2', [workspaceId, targetUserId],
    );
    if (!target.rows[0]) throw new FoundationError(404, 'Member not found or unavailable.');
    if (target.rows[0].email.toLowerCase() !== confirmationEmail) throw new FoundationError(409, 'The confirmation email does not match this member. Refresh the team and check the email.');
    const changed = await client.query(
      "UPDATE membership SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'admin' END WHERE workspace_id=$1 AND user_id IN ($2,$3)", [workspaceId, targetUserId, userId],
    );
    if (changed.rowCount !== 2) throw new FoundationError(409, 'Team membership changed. Refresh the team before trying again.');
    await client.query("DELETE FROM workspace_invitation WHERE workspace_id=$1 AND inviter_id=$2 AND role='admin'", [workspaceId, userId]);
    return { ok: true, role: 'admin' as const, ownerUserId: targetUserId };
  });
}

export async function removeMember(workspaceId: string, userId: string, targetUserId: string): Promise<void> {
  parse(idInput, workspaceId); parse(idInput, userId); parse(idInput, targetUserId);
  await transaction(async (client) => {
    await lockWorkspace(client, workspaceId);
    const actor = await managerRole(client, workspaceId, userId);
    const target = await client.query<{ role: Role }>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, targetUserId]);
    if (!target.rows[0]) throw new FoundationError(404, 'Member not found or unavailable.');
    requireGrant(actor, target.rows[0].role);
    await preserveOwner(client, workspaceId, target.rows[0].role);
    await client.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, targetUserId]);
    await client.query(
      `DELETE FROM workspace_invitation WHERE workspace_id=$1
       AND (inviter_id=$2 OR email=(SELECT lower(email) FROM "user" WHERE id=$2))`, [workspaceId, targetUserId],
    );
  });
}

export async function inspectInvitation(input: unknown) {
  const { token } = parse(z.object({ token: tokenInput }).strict(), input);
  const result = await getDatabase().pool.query<{ workspaceId: string; workspaceName: string; email: string; role: Invitation['role']; expiresAt: Date }>(
    `SELECT w.id AS "workspaceId",w.name AS "workspaceName",i.email,i.role,i.expires_at AS "expiresAt"
     FROM workspace_invitation i JOIN workspace w ON w.id=i.workspace_id
     JOIN membership m ON m.workspace_id=i.workspace_id AND m.user_id=i.inviter_id
     WHERE i.token_hash=$1 AND i.expires_at>clock_timestamp()
       AND (m.role='owner' OR (m.role='admin' AND i.role IN ('editor','viewer')))`, [tokenDigest(token)],
  );
  const invitation = result.rows[0];
  if (!invitation) unavailable();
  return { workspace: { id: invitation.workspaceId, name: invitation.workspaceName }, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt };
}

async function lockInvitation(client: PoolClient, digest: string) {
  // Discover the workspace without taking an invitation lock, then consistently
  // lock workspace -> invitation -> email across all acceptance operations.
  const found = await client.query<{ workspace_id: string }>('SELECT workspace_id FROM workspace_invitation WHERE token_hash=$1', [digest]);
  if (!found.rows[0]) unavailable();
    const workspaceId = found.rows[0].workspace_id;
    try { await lockWorkspace(client, workspaceId); }
    catch (error) {
      if (error instanceof FoundationError && error.status === 404) unavailable();
      throw error;
    }
    const result = await client.query<Invitation & { inviter_id: string }>(
      `SELECT id,email,role,expires_at AS "expiresAt",inviter_id FROM workspace_invitation
       WHERE token_hash=$1 AND workspace_id=$2 AND expires_at>clock_timestamp() FOR UPDATE`, [digest, workspaceId],
    );
    const invitation = result.rows[0];
    if (!invitation) unavailable();
    const inviter = await client.query<{ role: Role }>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, invitation.inviter_id]);
    if (!mayGrant(inviter.rows[0]?.role, invitation.role)) unavailable();
    // One normalized email can receive invitations to different workspaces.
    // Serialize its identity creation without locking another workspace.
    await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [109859, invitation.email]);
    return { workspaceId, invitation };
}

async function consumeInvitation(client: PoolClient, invitation: Invitation, workspaceId: string, userId: string) {
  // A link can add membership, never replace an existing member's privileges.
  await client.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO NOTHING', [workspaceId, userId, invitation.role]);
  const consumed = await client.query('DELETE FROM workspace_invitation WHERE id=$1 AND expires_at>clock_timestamp() RETURNING id', [invitation.id]);
  if (!consumed.rowCount) unavailable();
}

export async function acceptInvitation(input: unknown, signedInUser?: { id: string; email: string }) {
  const details = parse(z.object({ token: tokenInput, name: z.string().trim().min(1).max(120).optional(), password: z.string().min(12).max(128).optional() }).strict(), input);
  const signedIn = signedInUser === undefined ? undefined : parse(z.object({ id: idInput, email: emailInput }).strict(), signedInUser);
  return transaction(async (client) => {
    const { workspaceId, invitation } = await lockInvitation(client, tokenDigest(details.token));
    const existing = await client.query<{ id: string; email: string }>('SELECT id,email FROM "user" WHERE lower(email)=$1', [invitation.email]);
    let userId = existing.rows[0]?.id;
    if (signedIn && (signedIn.id !== userId || signedIn.email !== invitation.email)) {
      throw new FoundationError(403, 'Sign in with the email this invitation was sent to.');
    }
    const created = !userId;
    if (userId && !signedIn) throw new FoundationError(409, 'Sign in with the invited email to accept this invitation.');
    if (!userId) {
      if (!details.name || !details.password) throw new FoundationError(400, 'Enter your name and a password between 12 and 128 characters.');
      const password = await hashPassword(details.password);
      userId = randomUUID();
      await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [userId, details.name, invitation.email]);
      await client.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), userId, password]);
    }
    await consumeInvitation(client, invitation, workspaceId, userId);
    return { workspaceId, created, email: invitation.email };
  });
}

/** Server-only: caller must supply cryptographically verified, trusted OIDC email claims. */
export async function acceptVerifiedOidcInvitation(client: PoolClient, token: unknown, identity: { email: string; name: string }, passwordHash?: string) {
  const checked = parse(z.object({ email: emailInput, name: z.string().trim().min(1).max(120) }).strict(), identity);
  const { workspaceId, invitation } = await lockInvitation(client, tokenDigest(parse(tokenInput, token)));
  if (invitation.email !== checked.email) throw new FoundationError(403, 'The verified provider email does not match the invitation recipient.');
  const existing = await client.query('SELECT id FROM "user" WHERE lower(email)=$1', [checked.email]);
  if (existing.rowCount) throw new FoundationError(409, 'Sign in with the existing account before accepting this invitation. Link the provider explicitly in account settings.');
  const userId = randomUUID();
  await client.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)', [userId, checked.name, checked.email]);
  if (passwordHash) await client.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), userId, passwordHash]);
  await consumeInvitation(client, invitation, workspaceId, userId);
  return { userId, workspaceId };
}
