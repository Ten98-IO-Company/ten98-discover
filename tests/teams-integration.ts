import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verifyPassword } from 'better-auth/crypto';
import { FoundationError } from '../src/server/auth.ts';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { getDatabase } from '../src/server/db.ts';
import { acceptInvitation, changeRole, createWorkspace, getTeam, inspectInvitation, inviteMember, removeMember, renameWorkspace, revokeInvitation } from '../src/server/teams.ts';

type Options = { baseUrl: string; appUrl: string; ownerCookie: string; ownerId: string; workspaceId: string };
async function rejects(promise: Promise<unknown>, status: number, message: string) {
  try { await promise; }
  catch (error) {
    assert.ok(error instanceof FoundationError && error.status === status, message);
    return;
  }
  assert.fail(message);
}

export async function runTeamsChecks(options: Options): Promise<void> {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Teams checks require the isolated integration-test opt-in.');
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  assert.ok(local.has(new URL(options.baseUrl).hostname) && local.has(new URL(options.appUrl).hostname), 'Teams HTTP targets must be local.');
  assert.ok(local.has(new URL(getConfig().databaseUrl).hostname), 'Teams checks require an isolated local PostgreSQL database.');
  const { pool } = getDatabase();
  const owner = await pool.query<{ id: string; email: string }>('SELECT u.id,u.email FROM "user" u JOIN membership m ON m.user_id=u.id WHERE u.id=$1 AND m.workspace_id=$2 AND m.role=\'owner\'', [options.ownerId, options.workspaceId]);
  assert.equal(owner.rowCount, 1, 'The preceding foundation test must supply its existing owner.');
  const ownerIdentity = owner.rows[0];
  const email = () => `${randomUUID()}@teams.integration.test`;
  const password = () => randomBytes(24).toString('base64url');

  async function http(path: string, expected: number, input?: unknown, cookie?: string, origin = options.appUrl) {
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    if (input !== undefined) { headers.set('content-type', 'application/json'); headers.set('origin', origin); }
    const response = await fetch(new URL(path, options.baseUrl), {
      method: input === undefined ? 'GET' : 'POST', headers, signal: AbortSignal.timeout(15_000),
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    assert.equal(response.status, expected, `Team HTTP contract failed at ${path}.`);
    const text = await response.text();
    return { body: text ? JSON.parse(text) : {}, cookie: response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') };
  }

  const apiWorkspace = await http('/api/workspaces', 201, { name: 'HTTP team checks' }, options.ownerCookie);
  const apiWorkspaceId = apiWorkspace.body.workspace.id as string;
  assert.equal(apiWorkspace.body.workspace.role, 'owner');
  await http(`/api/workspaces/${apiWorkspaceId}/rename`, 200, { name: 'HTTP team checks renamed' }, options.ownerCookie);
  const apiEmail = email();
  const apiPassword = password();
  const apiInvite = await http(`/api/workspaces/${apiWorkspaceId}/invitations`, 201, { email: apiEmail, role: 'viewer' }, options.ownerCookie);
  const inviteUrl = new URL(apiInvite.body.inviteUrl);
  assert.equal(inviteUrl.origin, options.appUrl);
  assert.equal(inviteUrl.search, '', 'Invitation URLs must never place capabilities in query strings.');
  const apiToken = new URLSearchParams(inviteUrl.hash.slice(1)).get('invite');
  assert.ok(apiToken && apiToken.length === 43, 'Invitation URL must carry the capability in its fragment.');
  const apiPreview = await http('/api/invitations/inspect', 200, { token: apiToken });
  assert.deepEqual(Object.keys(apiPreview.body).sort(), ['email', 'expiresAt', 'role', 'workspaceName']);
  assert.equal(apiPreview.body.email, apiEmail);
  await http('/api/invitations/accept', 403, { token: apiToken, name: 'HTTP member', password: apiPassword }, undefined, 'https://untrusted.integration.test');
  const joined = await http('/api/invitations/accept', 200, { token: apiToken, name: 'HTTP member', password: apiPassword });
  assert.equal(joined.body.created, true);
  assert.equal(joined.body.signedIn, true);
  assert.ok(joined.cookie, 'New invitation acceptance must issue working session cookies.');
  const apiMember = await http('/api/me', 200, undefined, joined.cookie);
  const apiMemberId = apiMember.body.user.id as string;
  assert.equal(apiMember.body.workspaces.find((workspace: { id: string }) => workspace.id === apiWorkspaceId)?.role, 'viewer');
  await http(`/api/workspaces/${apiWorkspaceId}/team`, 404, undefined, joined.cookie);
  const repeatInvite = await http(`/api/workspaces/${apiWorkspaceId}/invitations`, 201, { email: apiEmail, role: 'editor' }, options.ownerCookie);
  const repeatToken = new URLSearchParams(new URL(repeatInvite.body.inviteUrl).hash.slice(1)).get('invite');
  await http('/api/invitations/accept', 409, { token: repeatToken, name: 'Must not overwrite', password: password() });
  await http('/api/invitations/accept', 403, { token: repeatToken }, options.ownerCookie);
  const rejoined = await http('/api/invitations/accept', 200, { token: repeatToken }, joined.cookie);
  assert.equal(rejoined.body.created, false);
  const preserved = await http(`/api/workspaces/${apiWorkspaceId}/team`, 200, undefined, options.ownerCookie);
  assert.equal(preserved.body.members.find((member: { userId: string }) => member.userId === apiMemberId)?.role, 'viewer');
  await http(`/api/workspaces/${apiWorkspaceId}/members/${apiMemberId}/role`, 200, { role: 'editor' }, options.ownerCookie);

  // A slow request body must not preserve the editor's authorization across removal.
  let beginBody!: () => void;
  let releaseBody!: () => void;
  const bodyStarted = new Promise<void>((resolve) => { beginBody = resolve; });
  const bodyReleased = new Promise<void>((resolve) => { releaseBody = resolve; });
  const projectOrigin = `https://${randomUUID()}.teams.integration.test`;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      beginBody();
      await bodyReleased;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ name: 'Revoked in flight', origin: projectOrigin })));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const inFlight = handleApi(new Request(`${options.appUrl}/api/workspaces/${apiWorkspaceId}/projects`, {
    method: 'POST', headers: { cookie: joined.cookie, origin: options.appUrl, 'content-type': 'application/json' },
    body: stream, duplex: 'half',
  } as RequestInit & { duplex: 'half' }));
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([bodyStarted, new Promise<never>((_, reject) => {
      waitTimer = setTimeout(() => reject(new Error('The delayed request body was not read.')), 10_000);
    })]);
    if (waitTimer) clearTimeout(waitTimer);
    await removeMember(apiWorkspaceId, options.ownerId, apiMemberId);
    releaseBody();
    assert.equal((await inFlight).status, 404, 'A revoked editor must not create a project after releasing a delayed body.');
    const count = await pool.query('SELECT count(*)::int AS count FROM project WHERE workspace_id=$1 AND origin=$2', [apiWorkspaceId, projectOrigin]);
    assert.equal(count.rows[0].count, 0, 'The in-flight unauthorized write must leave no project.');
  } finally {
    if (waitTimer) clearTimeout(waitTimer);
    releaseBody();
    await inFlight.catch(() => undefined);
  }
  await http(`/api/workspaces/${apiWorkspaceId}/team`, 404, undefined, joined.cookie);
  console.log('PASS invitation HTTP cookies, existing-account rules and delayed-body revocation');

  const primary = await createWorkspace(options.ownerId, { name: ' Team checks ' });
  const secondary = await createWorkspace(options.ownerId, { name: 'Independent team checks' });
  assert.equal(primary.workspace.name, 'Team checks');
  assert.equal(primary.role, 'owner');
  const workspaceId = primary.workspace.id;
  const renamed = await renameWorkspace(workspaceId, options.ownerId, { name: ' Renamed team checks ' });
  assert.equal(renamed.workspace.name, 'Renamed team checks');
  await rejects(createWorkspace(options.ownerId, { name: ' ', role: 'owner' }), 400, 'Workspace creation must reject malformed input.');
  await rejects(getTeam(workspaceId, randomUUID()), 404, 'Unrelated users must not read the team.');

  const adminEmail = email();
  const adminPassword = password();
  const adminInvite = await inviteMember(workspaceId, options.ownerId, { email: ` ${adminEmail.toUpperCase()} `, role: 'admin' });
  assert.equal(adminInvite.token.length, 43, 'A 32-byte base64url token must have 43 characters.');
  assert.equal(adminInvite.invitation.email, adminEmail);
  const remaining = adminInvite.invitation.expiresAt.getTime() - Date.now();
  assert.ok(remaining > 6.9 * 86_400_000 && remaining <= 7 * 86_400_000, 'Invitation lifetime must be seven days.');
  const persistedInvite = await pool.query('SELECT token_hash FROM workspace_invitation WHERE id=$1', [adminInvite.invitation.id]);
  assert.ok(persistedInvite.rows[0].token_hash === createHash('sha256').update(adminInvite.token).digest('hex'), 'Only the token digest is stored.');
  const team = await getTeam(workspaceId, options.ownerId);
  assert.ok(!JSON.stringify(team).includes(adminInvite.token) && !JSON.stringify(team).includes('token_hash'), 'Team reads must not reveal token material.');
  const preview = await inspectInvitation({ token: adminInvite.token });
  assert.deepEqual(Object.keys(preview).sort(), ['email', 'expiresAt', 'role', 'workspace']);
  assert.equal(preview.role, 'admin');
  await rejects(acceptInvitation({ token: adminInvite.token, name: 'Role injection', password: adminPassword, role: 'owner' }), 400, 'Acceptance must not accept a client-selected role.');
  await rejects(acceptInvitation({ token: adminInvite.token }), 400, 'New identities need a name and password.');
  const acceptedAdmin = await acceptInvitation({ token: adminInvite.token, name: 'Team admin', password: adminPassword });
  assert.equal(acceptedAdmin.created, true);
  assert.equal(acceptedAdmin.email, adminEmail);
  const admin = (await pool.query<{ id: string; email: string }>('SELECT id,email FROM "user" WHERE email=$1', [adminEmail])).rows[0];
  const adminCredential = (await pool.query('SELECT password FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'', [admin.id])).rows[0].password;
  assert.ok(await verifyPassword({ hash: adminCredential, password: adminPassword }), 'Invitation-created credentials must work with Better Auth.');
  await rejects(acceptInvitation({ token: adminInvite.token, name: 'Reuse', password: password() }), 410, 'Consumed invitations must not be reusable.');
  await rejects(inviteMember(workspaceId, options.ownerId, { email: email(), role: 'owner' }), 400, 'Invitations must not grant ownership.');
  console.log('PASS workspace creation and invitation capability/credential handling');

  const viewerEmail = email();
  const viewerPassword = password();
  const viewerInvite = await inviteMember(workspaceId, admin.id, { email: viewerEmail, role: 'viewer' });
  await acceptInvitation({ token: viewerInvite.token, name: 'Team viewer', password: viewerPassword });
  const viewer = (await pool.query<{ id: string; email: string }>('SELECT id,email FROM "user" WHERE email=$1', [viewerEmail])).rows[0];
  await rejects(getTeam(workspaceId, viewer.id), 404, 'Viewers must not read the team directory.');
  await rejects(renameWorkspace(workspaceId, viewer.id, { name: 'Unauthorized rename' }), 404, 'Viewers must not rename workspaces.');
  await rejects(inviteMember(workspaceId, viewer.id, { email: email(), role: 'viewer' }), 404, 'Viewers must not invite members.');
  await rejects(inviteMember(workspaceId, admin.id, { email: email(), role: 'admin' }), 403, 'Admins must not invite admins.');
  await rejects(changeRole(workspaceId, admin.id, viewer.id, { role: 'admin' }), 403, 'Admins must not promote admins.');
  await rejects(changeRole(workspaceId, admin.id, options.ownerId, { role: 'viewer' }), 403, 'Admins must not change owners.');
  await rejects(removeMember(workspaceId, admin.id, options.ownerId), 403, 'Admins must not remove owners.');
  await rejects(changeRole(workspaceId, viewer.id, viewer.id, { role: 'owner' }), 404, 'Members must not promote themselves.');
  await rejects(inviteMember(secondary.workspace.id, admin.id, { email: email(), role: 'editor' }), 404, 'Management must stay within the actor workspace.');
  const protectedInvite = await inviteMember(workspaceId, options.ownerId, { email: email(), role: 'admin' });
  await rejects(revokeInvitation(workspaceId, admin.id, protectedInvite.invitation.id), 403, 'Admins must not revoke admin invitations.');
  await rejects(inviteMember(workspaceId, admin.id, { email: protectedInvite.invitation.email, role: 'viewer' }), 403, 'Admins must not replace an owner-issued admin invitation.');
  await changeRole(workspaceId, admin.id, viewer.id, { role: 'editor' });
  assert.equal((await getTeam(workspaceId, options.ownerId)).members.find((member) => member.userId === viewer.id)?.role, 'editor');
  const viewerWorkspace = await createWorkspace(viewer.id, { name: 'Member-owned workspace' });
  assert.equal(viewerWorkspace.role, 'owner', 'Every signed-in user may create an independent workspace.');
  console.log('PASS owner/admin role boundaries and workspace isolation');

  const unchangedCredential = (await pool.query('SELECT password FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'', [viewer.id])).rows[0].password;
  const existingInvite = await inviteMember(workspaceId, options.ownerId, { email: viewerEmail, role: 'viewer' });
  await rejects(acceptInvitation({ token: existingInvite.token, name: 'Overwrite attempt', password: password() }), 409, 'Existing accounts require authenticated acceptance.');
  await rejects(acceptInvitation({ token: existingInvite.token }, ownerIdentity), 403, 'A different signed-in account must not accept the invitation.');
  const acceptedExisting = await acceptInvitation({ token: existingInvite.token, name: 'Ignored replacement', password: password() }, viewer);
  assert.equal(acceptedExisting.created, false);
  const existingUser = (await pool.query('SELECT u.name,a.password,m.role FROM "user" u JOIN account a ON a."userId"=u.id JOIN membership m ON m.user_id=u.id WHERE u.id=$1 AND m.workspace_id=$2', [viewer.id, workspaceId])).rows[0];
  assert.equal(existingUser.name, 'Team viewer');
  assert.ok(existingUser.password === unchangedCredential, 'Invitation acceptance must never reset an existing password.');
  assert.equal(existingUser.role, 'editor', 'An invitation must not overwrite existing membership privileges.');

  const replacementEmail = email();
  const superseded = await inviteMember(workspaceId, options.ownerId, { email: replacementEmail, role: 'editor' });
  const replacement = await inviteMember(workspaceId, options.ownerId, { email: replacementEmail, role: 'viewer' });
  await rejects(inspectInvitation({ token: superseded.token }), 410, 'Replacing an invitation must invalidate its old token.');
  assert.equal((await inspectInvitation({ token: replacement.token })).role, 'viewer');
  await revokeInvitation(workspaceId, options.ownerId, replacement.invitation.id);
  await rejects(acceptInvitation({ token: replacement.token, name: 'Revoked', password: password() }), 410, 'Revoked invitations must not be accepted.');
  const expired = await inviteMember(workspaceId, options.ownerId, { email: email(), role: 'viewer' });
  await pool.query("UPDATE workspace_invitation SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.invitation.id]);
  await rejects(inspectInvitation({ token: expired.token }), 410, 'Expired invitations must not expose a live preview.');
  await rejects(acceptInvitation({ token: expired.token, name: 'Expired', password: password() }), 410, 'Expired invitations must not grant membership.');
  console.log('PASS existing-account safety, replacement, revocation and expiry');

  const staleInvite = await inviteMember(workspaceId, admin.id, { email: email(), role: 'viewer' });
  await changeRole(workspaceId, options.ownerId, admin.id, { role: 'editor' });
  await rejects(acceptInvitation({ token: staleInvite.token, name: 'Stale grant', password: password() }), 410, 'Demoting an inviter must invalidate outstanding authority.');
  await changeRole(workspaceId, options.ownerId, admin.id, { role: 'admin' });
  await rejects(inspectInvitation({ token: staleInvite.token }), 410, 'Re-promoting an inviter must not revive an old link.');
  const pendingReturn = await inviteMember(workspaceId, options.ownerId, { email: viewerEmail, role: 'viewer' });
  await removeMember(workspaceId, admin.id, viewer.id);
  await rejects(acceptInvitation({ token: pendingReturn.token }, viewer), 410, 'Removing a member must revoke an old link addressed to them.');
  assert.ok(!(await getTeam(workspaceId, options.ownerId)).members.some((member) => member.userId === viewer.id));

  const rollbackEmail = email();
  const rollbackInvite = await inviteMember(workspaceId, options.ownerId, { email: rollbackEmail, role: 'viewer' });
  await pool.query('ALTER TABLE account ADD CONSTRAINT teams_reject_credential CHECK("providerId" <> \'credential\') NOT VALID');
  let failed = false;
  try {
    try { await acceptInvitation({ token: rollbackInvite.token, name: 'Rollback user', password: password() }); }
    catch { failed = true; }
    assert.ok(failed, 'Injected credential write failure must reject invitation acceptance.');
    const identityCount = await pool.query('SELECT count(*)::int AS count FROM "user" WHERE email=$1', [rollbackEmail]);
    assert.equal(identityCount.rows[0].count, 0, 'Credential failure must roll back the new identity.');
    assert.equal((await inspectInvitation({ token: rollbackInvite.token })).email, rollbackEmail, 'Failed acceptance must retain a usable invitation.');
  } finally { await pool.query('ALTER TABLE account DROP CONSTRAINT teams_reject_credential'); }
  await acceptInvitation({ token: rollbackInvite.token, name: 'Rollback user', password: password() });
  console.log('PASS revoked inviter authority, removed-member links and atomic acceptance rollback');

  const raceEmail = email();
  const raceInvite = await inviteMember(workspaceId, options.ownerId, { email: raceEmail, role: 'viewer' });
  const race = await Promise.allSettled([
    acceptInvitation({ token: raceInvite.token, name: 'Race one', password: password() }),
    acceptInvitation({ token: raceInvite.token, name: 'Race two', password: password() }),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1, 'A capability may be consumed only once under concurrency.');
  const racedFailure = race.find((result) => result.status === 'rejected');
  assert.ok(racedFailure?.status === 'rejected' && racedFailure.reason instanceof FoundationError && racedFailure.reason.status === 410);
  const crossEmail = email();
  const firstWorkspaceInvite = await inviteMember(workspaceId, options.ownerId, { email: crossEmail, role: 'viewer' });
  const secondWorkspaceInvite = await inviteMember(secondary.workspace.id, options.ownerId, { email: crossEmail.toUpperCase(), role: 'editor' });
  const crossRace = await Promise.allSettled([
    acceptInvitation({ token: firstWorkspaceInvite.token, name: 'Cross one', password: password() }),
    acceptInvitation({ token: secondWorkspaceInvite.token, name: 'Cross two', password: password() }),
  ]);
  assert.equal(crossRace.filter((result) => result.status === 'fulfilled').length, 1, 'Concurrent invitations must create only one email identity.');
  const crossFailure = crossRace.find((result) => result.status === 'rejected');
  assert.ok(crossFailure?.status === 'rejected' && crossFailure.reason instanceof FoundationError && crossFailure.reason.status === 409, 'The second invitation must require login, not reset credentials.');
  const crossUser = await pool.query<{ id: string; email: string }>('SELECT id,email FROM "user" WHERE lower(email)=$1', [crossEmail]);
  assert.equal(crossUser.rowCount, 1);
  const remainingToken = crossRace[0].status === 'rejected' ? firstWorkspaceInvite.token : secondWorkspaceInvite.token;
  await acceptInvitation({ token: remainingToken }, crossUser.rows[0]);
  const crossMemberships = await pool.query('SELECT count(*)::int AS count FROM membership WHERE user_id=$1 AND workspace_id=ANY($2::text[])', [crossUser.rows[0].id, [workspaceId, secondary.workspace.id]]);
  assert.equal(crossMemberships.rows[0].count, 2);
  console.log('PASS single-use and cross-workspace identity races');

  await rejects(changeRole(secondary.workspace.id, options.ownerId, options.ownerId, { role: 'viewer' }), 409, 'The last owner cannot be demoted.');
  await rejects(removeMember(secondary.workspace.id, options.ownerId, options.ownerId), 409, 'The last owner cannot be removed.');
  await changeRole(secondary.workspace.id, options.ownerId, crossUser.rows[0].id, { role: 'owner' });
  const ownersRace = await Promise.allSettled([
    changeRole(secondary.workspace.id, options.ownerId, options.ownerId, { role: 'viewer' }),
    changeRole(secondary.workspace.id, crossUser.rows[0].id, crossUser.rows[0].id, { role: 'viewer' }),
  ]);
  assert.equal(ownersRace.filter((result) => result.status === 'fulfilled').length, 1, 'Concurrent self-demotions must preserve an owner.');
  const ownerFailure = ownersRace.find((result) => result.status === 'rejected');
  assert.ok(ownerFailure?.status === 'rejected' && ownerFailure.reason instanceof FoundationError && ownerFailure.reason.status === 409);
  const ownersRemaining = await pool.query("SELECT count(*)::int AS count FROM membership WHERE workspace_id=$1 AND role='owner'", [secondary.workspace.id]);
  assert.equal(ownersRemaining.rows[0].count, 1);
  console.log('PASS last-owner protection under concurrent mutation');
}
