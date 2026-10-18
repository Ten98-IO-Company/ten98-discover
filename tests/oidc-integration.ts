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
  // Signed local issuer shaped like Authentik 2025.10 in its default per-application issuer mode: the issuer and
  // discovery document, JWKS and end-session endpoint sit under /application/o/<slug>/ (issuer with its trailing
  // slash), while authorize and token are global; see authentik/providers/oauth2/views/provider.py and
  // https://docs.goauthentik.io/add-secure-apps/providers/oauth2/. Fixture success is not vendor certification.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ format: 'der', type: 'spki' }), kid = createHash('sha256').update(der).digest('hex').slice(0, 32);
  // Authentik publishes x5c/x5t members beside the RSA key; the relying party must ignore them.
  const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid, x5c: [der.toString('base64')], x5t: createHash('sha1').update(der).digest('base64url'), 'x5t#S256': createHash('sha256').update(der).digest('base64url') };
  const fixtureSecret = randomBytes(24).toString('base64url');
  const codes = new Map<string, { nonce: string; challenge: string; claims: Record<string, unknown>; callback: string }>();
  const endSessions: URLSearchParams[] = [];
  // Default "hashed user ID" subject mode, and the email and profile scope mappings including groups.
  const subjectOf = (user: string) => createHash('sha256').update(`authentik-user:${user}`).digest('hex');
  const profile = (address: string, verified: boolean, name: string) => ({ email: address, email_verified: verified, name, given_name: name,
    preferred_username: address.split('@')[0], nickname: address.split('@')[0], groups: ['authentik Admins', 'ten98 owners'] });
  const operatorSubject = subjectOf('operator');
  let authentik = '', issuer = '', nextClaims: Record<string, unknown> = { sub: operatorSubject, ...profile(email, true, 'OIDC operator fixture') };
  const discovery = (slug: string, signing: string) => {
    const base = `${authentik}/application/o/${slug}/`, global = `${authentik}/application/o/`;
    return { issuer: base, authorization_endpoint: `${global}authorize/`, token_endpoint: `${global}token/`, userinfo_endpoint: `${global}userinfo/`,
      end_session_endpoint: `${base}end-session/`, introspection_endpoint: `${global}introspect/`, revocation_endpoint: `${global}revoke/`,
      device_authorization_endpoint: `${global}device/`, backchannel_logout_supported: true, backchannel_logout_session_supported: true,
      frontchannel_logout_supported: true, frontchannel_logout_session_supported: true,
      response_types_supported: ['code', 'id_token', 'id_token token', 'code token', 'code id_token', 'code id_token token'],
      response_modes_supported: ['query', 'fragment', 'form_post'], jwks_uri: `${base}jwks/`,
      grant_types_supported: ['authorization_code', 'refresh_token', 'implicit', 'client_credentials', 'password', 'urn:ietf:params:oauth:grant-type:device_code'],
      id_token_signing_alg_values_supported: [signing], subject_types_supported: ['public'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      acr_values_supported: ['goauthentik.io/providers/oauth2/default'], scopes_supported: ['openid', 'email', 'profile'], request_parameter_supported: false,
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'acr', 'amr', 'nonce', 'email', 'email_verified', 'name', 'given_name', 'preferred_username', 'nickname', 'groups'],
      claims_parameter_supported: false, code_challenge_methods_supported: ['plain', 'S256'], dpop_signing_alg_values_supported: ['ES256', 'RS256'] };
  };
  const fixture = createServer(async (request, response) => {
    const url = new URL(request.url!, authentik);
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/application/o/ten98-monitor/.well-known/openid-configuration') response.end(JSON.stringify(discovery('ten98-monitor', 'RS256')));
    // Without a selected signing key Authentik signs with HS256 and the client secret and advertises only that.
    else if (url.pathname === '/application/o/no-signing-key/.well-known/openid-configuration') response.end(JSON.stringify(discovery('no-signing-key', 'HS256')));
    else if (url.pathname === '/application/o/ten98-monitor/jwks/') response.end(JSON.stringify({ keys: [jwk] }));
    else if (url.pathname === '/application/o/ten98-monitor/end-session/') {
      // Authentik refuses a return address without id_token_hint; otherwise it runs the provider's invalidation flow.
      endSessions.push(url.searchParams);
      if (url.searchParams.has('post_logout_redirect_uri') && !url.searchParams.has('id_token_hint')) { response.writeHead(400); response.end('{}'); return; }
      response.writeHead(302, { location: `${authentik}/if/flow/default-provider-invalidation-flow/` }); response.end('{}');
    } else if (url.pathname === '/application/o/authorize/') {
      const code = randomBytes(24).toString('base64url');
      const callback = url.searchParams.get('redirect_uri')!;
      codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, claims: { ...nextClaims }, callback });
      const target = new URL(callback); target.searchParams.set('state', url.searchParams.get('state')!); target.searchParams.set('code', code);
      response.writeHead(302, { location: target.href }); response.end('{}');
    } else if (url.pathname === '/application/o/token/') {
      let body = ''; for await (const chunk of request) body += chunk;
      const submitted = new URLSearchParams(body), code = submitted.get('code') ?? '';
      const pending = codes.get(code); codes.delete(code);
      if (!pending || submitted.get('grant_type') !== 'authorization_code' || request.headers.authorization !== `Basic ${Buffer.from(`fixture-client:${fixtureSecret}`).toString('base64')}`
        || createHash('sha256').update(submitted.get('code_verifier') ?? '').digest('base64url') !== pending.challenge
        || submitted.get('redirect_uri') !== pending.callback) { response.writeHead(400); response.end('{}'); return; }
      const now = Math.floor(Date.now() / 1000);
      const unsigned = [Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ iss: issuer, aud: 'fixture-client', exp: now + 300, iat: now, auth_time: now, acr: 'goauthentik.io/providers/oauth2/default',
          amr: ['pwd'], nonce: pending.nonce, sid: randomBytes(32).toString('hex'), ...pending.claims })).toString('base64url')].join('.');
      response.end(JSON.stringify({ access_token: randomBytes(32).toString('base64url'), token_type: 'Bearer', scope: 'openid email profile', expires_in: 300,
        id_token: `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}` }));
    } else { response.writeHead(404); response.end('{}'); }
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address(); assert.ok(address && typeof address !== 'string');
  authentik = `http://127.0.0.1:${address.port}`; issuer = `${authentik}/application/o/ten98-monitor/`;

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
    const requested = new URL(url), query = requested.searchParams;
    assert.equal(requested.origin + requested.pathname, `${authentik}/application/o/authorize/`);
    // Authorization code with S256 PKCE (Authentik also offers plain), a nonce and the three scopes Authentik maps to claims.
    assert.equal(query.get('response_type'), 'code'); assert.equal(query.get('client_id'), 'fixture-client');
    assert.equal(query.get('code_challenge_method'), 'S256'); assert.match(query.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(query.get('scope')?.split(' ').sort(), ['email', 'openid', 'profile']);
    assert.ok(query.get('nonce') && query.get('state') && query.get('redirect_uri') === `${options.appUrl}/api/auth/oidc/callback`);
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
    const settings = { name: 'Synthetic Authentik', issuer, clientId: 'fixture-client', authentication: 'basic', allowedOrigins: [], allowedAddresses: ['127.0.0.1'], trustVerifiedEmail: true };
    // The issuer must be entered exactly as Authentik shows it, trailing slash included, and a provider without a
    // signing key (HS256 only) is refused; both fail at test time and the corrected draft replaces them.
    const draft = await call('/api/identity/oidc/providers', actor, { settings: { ...settings, issuer: issuer.slice(0, -1) }, clientSecret: fixtureSecret });
    assert.equal((await call(`/api/identity/oidc/providers/${draft.provider.id}/test`, actor, { proof: { password } }, 400)).error, 'Discovery returned a different issuer.');
    await call('/api/identity/oidc/providers', actor, { id: draft.provider.id, settings: { ...settings, issuer: `${authentik}/application/o/no-signing-key/` }, clientSecret: fixtureSecret });
    assert.equal((await call(`/api/identity/oidc/providers/${draft.provider.id}/test`, actor, { proof: { password } }, 400)).error, 'This provider does not advertise a supported asymmetric ID-token signature algorithm.');
    await resetActorLimit();
    const saved = await call('/api/identity/oidc/providers', actor, { id: draft.provider.id, settings, clientSecret: fixtureSecret });
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
    assert.equal(proof.proof.purpose, 'test'); assert.equal(proof.proof.subject, operatorSubject);
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
    // RP-initiated sign-out: a provider session ends here, then at the advertised end-session endpoint with the
    // client ID only; no ID token, claim or return address leaves the app, so Authentik shows its own signed-out page.
    const leaving: Browser = new Map();
    await finish(await call('/api/auth/oidc/start', leaving, { providerId }), leaving, '#oidc-complete=1');
    assert.equal([...leaving.keys()].some(name => name.endsWith('session_token')), true);
    const leavingOut = await call('/api/auth/sign-out', leaving, {});
    assert.equal(typeof leavingOut.providerSignOutUrl, 'string', 'A provider session must also sign out at the provider.');
    const endSession = new URL(leavingOut.providerSignOutUrl);
    assert.equal(endSession.origin + endSession.pathname, `${issuer}end-session/`);
    assert.deepEqual([...endSession.searchParams], [['client_id', 'fixture-client']]);
    assert.equal([...leaving.keys()].some(name => name.endsWith('session_token')), false, 'The rewritten sign-out response must still clear the session cookie.');
    await call('/api/me', leaving, undefined, 401);
    const ended = await fetch(endSession, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    assert.equal(ended.status, 302); assert.equal(ended.headers.get('location'), `${authentik}/if/flow/default-provider-invalidation-flow/`);
    assert.deepEqual([...endSessions.at(-1)!], [['client_id', 'fixture-client']]);
    // A provider enabled before discovery kept the end-session endpoint signs out locally only, until it is tested and enabled again.
    await pool.query("UPDATE oidc_provider SET active=active #- '{metadata,end_session_endpoint}' WHERE id=$1", [providerId]);
    const legacy: Browser = new Map();
    await finish(await call('/api/auth/oidc/start', legacy, { providerId }), legacy, '#oidc-complete=1');
    assert.equal(Object.hasOwn(await call('/api/auth/sign-out', legacy, {}), 'providerSignOutUrl'), false);
    await call('/api/me', legacy, undefined, 401);
    assert.equal((await call('/api/me', login)).user.id, userId, 'Signing out one provider session must leave the others alone.');
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
    // Authentik 2025.10 sends email_verified false unless the operator maps verification, which refuses the invitation.
    nextClaims = { sub: subjectOf(newEmail), ...profile(newEmail, false, 'New invited OIDC member') };
    const unverified: Browser = new Map();
    await finish(await call('/api/auth/oidc/start', unverified, { providerId, invitationToken: newInvitation.token }), unverified, '#oidc-error=1');
    assert.equal((await pool.query('SELECT 1 FROM "user" WHERE email=$1', [newEmail])).rowCount, 0);
    nextClaims.email_verified = true;
    const newBrowser: Browser = new Map();
    await finish(await call('/api/auth/oidc/start', newBrowser, { providerId, invitationToken: newInvitation.token }), newBrowser, '#oidc-complete=1');
    const newUserId = (await call('/api/me', newBrowser)).user.id as string;
    assert.equal((await pool.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [options.workspaceId, newUserId])).rows[0].role, 'editor');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM membership WHERE user_id=$1', [newUserId])).rows[0].count, 1, 'Provider groups grant no role or workspace: membership comes from the invitation alone.');
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
    // A workspace two-factor requirement locks this OIDC-only member until they enrol the app's authenticator through Identity;
    // the provider's own sign-in (amr/acr) does not satisfy it.
    const requiredWorkspace = randomUUID();
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'OIDC two-factor required fixture')", [requiredWorkspace]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'viewer')", [requiredWorkspace, newUserId]);
    await pool.query('INSERT INTO workspace_two_factor_requirement(workspace_id) VALUES($1)', [requiredWorkspace]);
    assert.equal((await call(`/api/workspaces/${requiredWorkspace}/projects`, newBrowser, undefined, 403)).error, 'This workspace requires two-factor authentication. Turn it on in Account security, then try again.');
    const enrollProof = await accountProof();
    await call(`/api/account/oidc/proofs/${enrollProof}`, actor, undefined, 403);
    const oidcEnroll = await call('/api/account/oidc/reauth/confirm', newBrowser, { proofId: enrollProof, action: 'enable-two-factor' });
    assert.equal(oidcEnroll.backupCodes.length, 10);
    await call('/api/account/oidc/reauth/confirm', newBrowser, { proofId: enrollProof, action: 'enable-two-factor' }, 410);
    await call('/api/account/two-factor/verify', newBrowser, { code: authenticatorCode(new URL(oidcEnroll.totpURI).searchParams.get('secret')!) });
    assert.equal((await call('/api/account/security', newBrowser)).user.twoFactorEnabled, true);
    await call(`/api/workspaces/${requiredWorkspace}/projects`, newBrowser);
    console.log('PASS an OIDC-only member of a workspace requiring two-factor authentication is refused until enrolling the app authenticator through Identity, then reads it');
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
    assert.equal(Object.hasOwn(await call('/api/auth/sign-out', localRecovery, {}), 'providerSignOutUrl'), false, 'A local session of a linked account never signs out at the provider.');
    await call('/api/me', localRecovery, undefined, 401);

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
    console.log('PASS OIDC lifecycle against an Authentik-shaped issuer: discovery, S256 PKCE, standard claims without group mapping, invitations, linking, factors, revocation and RP-initiated sign-out');
  } finally {
    fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
}
