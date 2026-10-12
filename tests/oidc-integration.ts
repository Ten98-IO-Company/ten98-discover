import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { getConfig } from '../src/server/config.ts';
import { getDatabase } from '../src/server/db.ts';
import { acceptInvitation, inviteMember, revokeInvitation } from '../src/server/teams.ts';
import { setInstanceOperator } from '../src/server/instance-operators.ts';
import { assertOidcCredentialsReadable } from '../src/server/oidc.ts';
import { authenticatorCode } from './account-security-integration.ts';

type Options = { baseUrl: string; appUrl: string; ownerCookie: string; ownerId: string; workspaceId: string };
type Browser = Map<string, string>;

export async function runOidcChecks(options: Options): Promise<void> {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'OIDC checks require the isolated integration-test opt-in.');
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const value of [options.baseUrl, options.appUrl, getConfig().databaseUrl]) assert.ok(local.has(new URL(value).hostname), 'OIDC integration must target isolated local services.');
  const { pool } = getDatabase();
  assert.equal((await pool.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'", [options.workspaceId, options.ownerId])).rowCount, 1);
  const email = `${randomUUID()}@oidc.integration.test`, password = randomBytes(24).toString('base64url');
  const invite = await inviteMember(options.workspaceId, options.ownerId, { email, role: 'viewer' });
  await acceptInvitation({ token: invite.token, name: 'OIDC operator fixture', password });
  const userId = (await pool.query('SELECT id FROM "user" WHERE email=$1', [email])).rows[0].id as string;
  const actor: Browser = new Map();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'integration', alg: 'RS256', use: 'sig' };
  const fixtureSecret = randomBytes(24).toString('base64url');
  const codes = new Map<string, { nonce: string; challenge: string; claims: Record<string, unknown>; callback: string }>();
  let issuer = '', nextClaims: Record<string, unknown> = { sub: 'operator-subject', email, email_verified: true, name: 'OIDC operator fixture' };
  const fixture = createServer(async (request, response) => {
    const url = new URL(request.url!, issuer);
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/.well-known/openid-configuration') response.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`, id_token_signing_alg_values_supported: ['RS256'] }));
    else if (url.pathname === '/keys') response.end(JSON.stringify({ keys: [jwk] }));
    else if (url.pathname === '/authorize') {
      const code = randomBytes(24).toString('base64url');
      const callback = url.searchParams.get('redirect_uri')!;
      codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, claims: { ...nextClaims }, callback });
      const target = new URL(callback); target.searchParams.set('state', url.searchParams.get('state')!); target.searchParams.set('code', code);
      response.writeHead(302, { location: target.href }); response.end('{}');
    } else if (url.pathname === '/token') {
      let body = ''; for await (const chunk of request) body += chunk;
      const submitted = new URLSearchParams(body), code = submitted.get('code') ?? '';
      const pending = codes.get(code); codes.delete(code);
      if (!pending || request.headers.authorization !== `Basic ${Buffer.from(`fixture-client:${fixtureSecret}`).toString('base64')}`
        || createHash('sha256').update(submitted.get('code_verifier') ?? '').digest('base64url') !== pending.challenge
        || submitted.get('redirect_uri') !== pending.callback) { response.writeHead(400); response.end('{}'); return; }
      const now = Math.floor(Date.now() / 1000);
      const unsigned = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'integration' })).toString('base64url'),
        Buffer.from(JSON.stringify({ iss: issuer, aud: 'fixture-client', iat: now, exp: now + 300, auth_time: now, nonce: pending.nonce, ...pending.claims })).toString('base64url')].join('.');
      response.end(JSON.stringify({ id_token: `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}` }));
    } else { response.writeHead(404); response.end('{}'); }
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address(); assert.ok(address && typeof address !== 'string'); issuer = `http://127.0.0.1:${address.port}`;

  async function call(path: string, browser: Browser, body?: unknown, expected = 200, origin = options.appUrl) {
    const headers = new Headers({ cookie: [...browser].map(([key, value]) => `${key}=${value}`).join('; ') });
    if (body !== undefined) { headers.set('content-type', 'application/json'); headers.set('origin', origin); }
    const response = await fetch(new URL(path, options.baseUrl), { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(25_000) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0], separator = pair.indexOf('=');
      if (/max-age=0(?:;|$)/i.test(cookie)) browser.delete(pair.slice(0, separator)); else browser.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const result = response.status === 303 ? { location: response.headers.get('location')! } : await response.json();
    assert.equal(response.status, expected, `Unexpected status for ${new URL(path, options.baseUrl).pathname}: ${typeof result.error === 'string' ? result.error : 'response contract mismatch'}.`);
    return result;
  }
  async function resetActorLimit() {
    await pool.query('DELETE FROM request_limit WHERE key=$1', [`oidc:POST:${userId}`]);
  }
  async function authorize(url: string): Promise<string> {
    assert.equal(new URL(url).origin, issuer);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 302); return response.headers.get('location')!;
  }
  async function finish(start: { authorizationUrl: string }, browser: Browser, expectedFragment: string) {
    const callback = await authorize(start.authorizationUrl);
    const response = await call(callback, browser, undefined, 303);
    assert.ok(new URL(response.location).hash.startsWith(expectedFragment), 'OIDC callback must return the expected fixed application fragment.');
    return { callback, proofId: new URL(response.location).hash.replace('#oidc-proof=', '') };
  }
  try {
    await call('/api/auth/sign-in/email', actor, { email, password });
    await call('/api/identity/oidc/providers', actor, undefined, 403);
    await setInstanceOperator(email, true);
    const settings = { name: 'Synthetic OIDC', issuer, clientId: 'fixture-client', authentication: 'basic', allowedOrigins: [], allowedAddresses: ['127.0.0.1'], trustVerifiedEmail: true };
    const saved = await call('/api/identity/oidc/providers', actor, { settings, clientSecret: fixtureSecret });
    const providerId = saved.provider.id as string;
    assert.equal(saved.provider.enabled, false);
    assert.ok(!JSON.stringify(saved).includes(fixtureSecret), 'Saved-provider DTO must not contain client credentials.');
    assert.equal((await call('/api/auth/oidc/providers', new Map())).providers.some((provider: { id: string }) => provider.id === providerId), false);
    await call(`/api/identity/oidc/providers/${providerId}/test`, actor, { proof: { password: 'wrong password' } }, 400);
    await call(`/api/identity/oidc/providers/${providerId}/test`, actor, { proof: { password } }, 403, 'https://other.example.test');
    const started = await call(`/api/identity/oidc/providers/${providerId}/test`, actor, { proof: { password } });
    const callback = await authorize(started.authorizationUrl);
    await call(callback, new Map(), undefined, 303); // Browser binding failure must not consume the legitimate request.
    const verified = await call(callback, actor, undefined, 303);
    const proofId = new URL(verified.location).hash.replace('#oidc-proof=', '');
    assert.match(proofId, /^[0-9a-f-]{36}$/);
    const proof = await call(`/api/account/oidc/proofs/${proofId}`, actor);
    assert.equal(proof.proof.purpose, 'test'); assert.equal(proof.proof.subject, 'operator-subject');
    assert.equal((await pool.query('SELECT 1 FROM oidc_identity WHERE provider_id=$1', [providerId])).rowCount, 0, 'Testing a draft must not create linked identities.');
    await call(`/api/identity/oidc/providers/${providerId}/enable`, actor, { proofId });
    await call(`/api/identity/oidc/providers/${providerId}/enable`, actor, { proofId }, 410);
    assert.equal((await call('/api/auth/oidc/providers', new Map())).providers.some((provider: { id: string }) => provider.id === providerId), true);
    await finish(await call('/api/auth/oidc/start', new Map(), { providerId }), new Map(), '#oidc-error=1'); // Missing binding is denied.
    const unknown: Browser = new Map();
    await finish(await call('/api/auth/oidc/start', unknown, { providerId }), unknown, '#oidc-error=1');
    assert.equal((await pool.query('SELECT 1 FROM oidc_identity WHERE provider_id=$1', [providerId])).rowCount, 0, 'Matching verified email must never auto-link accounts.');
    await resetActorLimit();
    const link = await finish(await call('/api/account/oidc/link/start', actor, { providerId, proof: { password } }), actor, '#oidc-proof=');
    await call('/api/account/oidc/link/confirm', actor, { proofId: link.proofId });
    const identities = await call('/api/account/oidc/identities', actor);
    assert.equal(identities.identities.length, 1); assert.ok(!JSON.stringify(identities).includes(fixtureSecret));
    const login: Browser = new Map();
    const completed = await finish(await call('/api/auth/oidc/start', login, { providerId }), login, '#oidc-complete=1');
    assert.equal((await call('/api/me', login)).user.id, userId);
    const beforeReplay = (await pool.query('SELECT count(*)::int AS count FROM session WHERE "userId"=$1', [userId])).rows[0].count;
    await call(completed.callback, login, undefined, 303);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM session WHERE "userId"=$1', [userId])).rows[0].count, beforeReplay);
    await call(`/api/identity/oidc/providers/${providerId}/disable`, actor, {});
    await call('/api/me', login, undefined, 401);
    assert.equal((await call('/api/me', actor)).user.id, userId, 'Disabling OIDC must retain local recovery sign-in.');

    await resetActorLimit();
    const testedAgain = await finish(await call(`/api/identity/oidc/providers/${providerId}/test`, actor, { proof: { password } }), actor, '#oidc-proof=');
    await call(`/api/identity/oidc/providers/${providerId}/enable`, actor, { proofId: testedAgain.proofId });
    const enroll = await call('/api/account/two-factor/enable', actor, { password });
    const secret = new URL(enroll.totpURI).searchParams.get('secret')!;
    await call('/api/account/two-factor/verify', actor, { code: authenticatorCode(secret) });
    const factorBrowser: Browser = new Map();
    await finish(await call('/api/auth/oidc/start', factorBrowser, { providerId }), factorBrowser, '#oidc-factor=1');
    await call('/api/me', factorBrowser, undefined, 401);
    await call('/api/auth/two-factor/verify-backup-code', factorBrowser, { code: enroll.backupCodes[0] });
    assert.equal((await call('/api/me', factorBrowser)).user.id, userId);
    assert.ok((await pool.query('SELECT 1 FROM session WHERE "userId"=$1 AND "oidcProviderId"=$2', [userId, providerId])).rowCount, 'Factor completion must retain the OIDC provider revocation binding.');
    const pendingFactor: Browser = new Map();
    await finish(await call('/api/auth/oidc/start', pendingFactor, { providerId }), pendingFactor, '#oidc-factor=1');
    await call(`/api/identity/oidc/providers/${providerId}/disable`, actor, {});
    await call('/api/me', factorBrowser, undefined, 401);
    await call('/api/auth/two-factor/verify-backup-code', pendingFactor, { code: enroll.backupCodes[1] }, 401);
    await resetActorLimit();
    const reenabled = await finish(await call(`/api/identity/oidc/providers/${providerId}/test`, actor, { proof: { password, backupCode: enroll.backupCodes[2] } }), actor, '#oidc-proof=');
    await call(`/api/identity/oidc/providers/${providerId}/enable`, actor, { proofId: reenabled.proofId });

    const newEmail = `${randomUUID()}@oidc.integration.test`;
    const newInvitation = await inviteMember(options.workspaceId, options.ownerId, { email: newEmail, role: 'editor' });
    nextClaims = { sub: randomUUID(), email: newEmail, email_verified: false, name: 'New invited OIDC member' };
    const unverified: Browser = new Map();
    await finish(await call('/api/auth/oidc/start', unverified, { providerId, invitationToken: newInvitation.token }), unverified, '#oidc-error=1');
    assert.equal((await pool.query('SELECT 1 FROM "user" WHERE email=$1', [newEmail])).rowCount, 0);
    nextClaims.email_verified = true;
    const newBrowser: Browser = new Map();
    await finish(await call('/api/auth/oidc/start', newBrowser, { providerId, invitationToken: newInvitation.token }), newBrowser, '#oidc-complete=1');
    const newUserId = (await call('/api/me', newBrowser)).user.id as string;
    assert.equal((await pool.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [options.workspaceId, newUserId])).rows[0].role, 'editor');
    assert.equal((await pool.query('SELECT 1 FROM account WHERE "userId"=$1', [newUserId])).rowCount, 0, 'Ordinary OIDC invitations must not force a local password.');
    await call('/api/identity/oidc/providers', newBrowser, undefined, 403);

    // Passwordless accounts must use a fresh exact-identity proof, never a dummy password.
    await call('/api/account/two-factor/enable', newBrowser, { password: 'dummy password' }, 409);
    await call('/api/auth/set-password', newBrowser, { newPassword: 'this endpoint is unavailable' }, 404);
    const newIdentityId = (await call('/api/account/oidc/identities', newBrowser)).identities[0].id as string;
    const invitedClaims = { ...nextClaims };
    nextClaims = { ...invitedClaims, sub: 'another-subject' };
    await finish(await call('/api/account/oidc/reauth/start', newBrowser, { identityId: newIdentityId }), newBrowser, '#oidc-error=1');
    nextClaims = { ...invitedClaims, auth_time: 1 };
    await finish(await call('/api/account/oidc/reauth/start', newBrowser, { identityId: newIdentityId }), newBrowser, '#oidc-error=1');
    nextClaims = invitedClaims;
    async function accountProof() {
      await pool.query('DELETE FROM request_limit WHERE key=$1', [`oidc:POST:${newUserId}`]);
      const start = await call('/api/account/oidc/reauth/start', newBrowser, { identityId: newIdentityId });
      const authorization = new URL(start.authorizationUrl);
      assert.equal(authorization.searchParams.get('max_age'), '0'); assert.equal(authorization.searchParams.get('prompt'), 'login');
      return (await finish(start, newBrowser, '#oidc-proof=')).proofId;
    }
    const enrollProof = await accountProof();
    await call(`/api/account/oidc/proofs/${enrollProof}`, actor, undefined, 403);
    const oidcEnroll = await call('/api/account/oidc/reauth/confirm', newBrowser, { proofId: enrollProof, action: 'enable-two-factor' });
    assert.equal(oidcEnroll.backupCodes.length, 10);
    await call('/api/account/oidc/reauth/confirm', newBrowser, { proofId: enrollProof, action: 'enable-two-factor' }, 410);
    await call('/api/account/two-factor/verify', newBrowser, { code: authenticatorCode(new URL(oidcEnroll.totpURI).searchParams.get('secret')!) });
    assert.equal((await call('/api/account/security', newBrowser)).user.twoFactorEnabled, true);
    assert.ok((await pool.query('SELECT 1 FROM session WHERE "userId"=$1 AND "oidcProviderId"=$2', [newUserId, providerId])).rowCount, 'OIDC-only factor enrollment must preserve provider-bound session revocation.');
    const replacementProof = await accountProof();
    await call('/api/account/oidc/reauth/confirm', newBrowser, { proofId: replacementProof, action: 'replace-recovery' }, 400);
    const replacement = await call('/api/account/oidc/reauth/confirm', newBrowser, { proofId: replacementProof, action: 'replace-recovery', backupCode: oidcEnroll.backupCodes[0] });
    assert.equal(replacement.backupCodes.length, 10);
    const disableProof = await accountProof();
    await call('/api/account/oidc/reauth/confirm', newBrowser, { proofId: disableProof, action: 'disable-two-factor', backupCode: replacement.backupCodes[0] });
    assert.equal((await call('/api/account/security', newBrowser)).user.twoFactorEnabled, false);
    const nextEnroll = await call('/api/account/oidc/reauth/confirm', newBrowser, { proofId: await accountProof(), action: 'enable-two-factor' });
    await call('/api/account/two-factor/verify', newBrowser, { code: authenticatorCode(new URL(nextEnroll.totpURI).searchParams.get('secret')!) });
    const passwordProof = await accountProof(), recoveryPassword = randomBytes(24).toString('base64url');
    await call('/api/account/oidc/reauth/confirm', newBrowser, { proofId: passwordProof, action: 'set-password', newPassword: recoveryPassword }, 400);
    await call('/api/account/oidc/reauth/confirm', newBrowser, { proofId: passwordProof, action: 'set-password', newPassword: recoveryPassword, backupCode: nextEnroll.backupCodes[0] });
    assert.equal((await call('/api/account/security', newBrowser)).hasPassword, true);
    assert.equal((await pool.query('SELECT 1 FROM session WHERE "userId"=$1 AND "oidcProviderId" IS NOT NULL', [newUserId])).rowCount, 0, 'New local recovery sign-in must rotate and revoke prior provider sessions.');
    await call('/api/account/oidc/reauth/start', newBrowser, { identityId: newIdentityId }, 409);
    const localRecovery: Browser = new Map();
    assert.equal((await call('/api/auth/sign-in/email', localRecovery, { email: newEmail, password: recoveryPassword })).twoFactorRedirect, true);
    await call('/api/auth/two-factor/verify-backup-code', localRecovery, { code: nextEnroll.backupCodes[1] });
    assert.equal((await call('/api/me', localRecovery)).user.id, newUserId);

    const collision = await inviteMember(options.workspaceId, options.ownerId, { email, role: 'editor' });
    nextClaims = { sub: randomUUID(), email, email_verified: true, name: 'Must not merge' };
    const collideBrowser: Browser = new Map();
    await finish(await call('/api/auth/oidc/start', collideBrowser, { providerId, invitationToken: collision.token }), collideBrowser, '#oidc-error=1');
    assert.equal((await pool.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [options.workspaceId, userId])).rows[0].role, 'viewer', 'Existing membership privileges must not change.');
    const revokedEmail = `${randomUUID()}@oidc.integration.test`;
    const revoked = await inviteMember(options.workspaceId, options.ownerId, { email: revokedEmail, role: 'viewer' });
    nextClaims = { sub: randomUUID(), email: revokedEmail, email_verified: true, name: 'Revoked fixture' };
    const revokedBrowser: Browser = new Map();
    const revokedStart = await call('/api/auth/oidc/start', revokedBrowser, { providerId, invitationToken: revoked.token });
    await revokeInvitation(options.workspaceId, options.ownerId, revoked.invitation.id);
    await finish(revokedStart, revokedBrowser, '#oidc-error=1');
    assert.equal((await pool.query('SELECT 1 FROM "user" WHERE email=$1', [revokedEmail])).rowCount, 0, 'Invitation revocation during provider sign-in must be atomic.');
    await assertOidcCredentialsReadable();
    await setInstanceOperator(email, false);
    await call('/api/identity/oidc/providers', actor, undefined, 403);
  } finally {
    fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
}
