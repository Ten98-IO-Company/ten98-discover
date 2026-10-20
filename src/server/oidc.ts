import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { oidcEndpoint, readResponseText } from '@ten98/runtime';
import { addressKey, publicNetworkAddress } from './public-network.ts';
import { authorizationCodeRequest, createAuthorizationURL, verifyProviderIdToken } from 'better-auth/oauth2';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getSessionCookie, parseCookies } from 'better-auth/cookies';
import { hashPassword } from 'better-auth/crypto';
import { FoundationError, getAuth } from './auth.ts';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { credentialKeys, decryptCredentials, encryptCredentials } from './credential-vault.ts';
import { applyOidcAccountSecurity, localIdentityProofInput, oidcSecurityActionInput, requireLocalIdentityProof } from './account-security.ts';
import { requireInstanceOperator } from './instance-operators.ts';
import { acceptVerifiedOidcInvitation, inspectInvitation } from './teams.ts';
import { readJson } from './validation.ts';

const origins = z.array(z.string().max(2048)).max(8).default([]);
const oidcSettingsInput = z.object({
  name: z.string().trim().min(1).max(120),
  issuer: z.string().trim().min(1).max(2048),
  clientId: z.string().trim().min(1).max(512),
  authentication: z.enum(['basic', 'post']).default('basic'),
  allowedOrigins: origins,
  allowedAddresses: z.array(z.string().max(64)).max(16).default([]),
  trustVerifiedEmail: z.boolean().default(false),
}).strict();
export type OidcSettings = z.infer<typeof oidcSettingsInput>;
type Metadata = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string; id_token_signing_alg_values_supported: string[] };
type DiscoveredSettings = OidcSettings & { metadata: Metadata };
type Claims = { issuer: string; subject: string; email: string | null; emailVerified: boolean; name: string; authTime: number | null };
const algorithms = ['RS256', 'PS256', 'ES256'] as const;

function input<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new FoundationError(400, 'Check the identity provider settings and try again.');
  return result.data;
}

function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
function unavailable(message = 'The identity provider could not be verified. Check its settings and availability.'): never {
  throw new FoundationError(400, message);
}

export function permittedOidcAddress(address: string, explicitlyAllowed: readonly string[]): boolean {
  const canonical = addressKey(address);
  if (!canonical) return false;
  if (explicitlyAllowed.some((allowed) => addressKey(allowed) === canonical)) return true;
  return publicNetworkAddress(address);
}

function endpoint(raw: string, settings: OidcSettings): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return unavailable('The identity provider endpoint is invalid.'); }
  const testHttp = process.env.TEN98_INTEGRATION_TEST === '1' && url.protocol === 'http:'
    && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && settings.allowedAddresses.some((address) => addressKey(address) === addressKey(url.hostname.replace(/^\[|\]$/g, '')));
  try { oidcEndpoint(url, { allowHttp: testHttp, issuer: raw === settings.issuer }); }
  catch { unavailable('Identity provider endpoints require HTTPS without credentials or fragments, and issuers cannot contain a query.'); }
  const allowed = [new URL(settings.issuer).origin, ...settings.allowedOrigins];
  if (!allowed.includes(url.origin)) unavailable('This endpoint origin is outside the operator-approved identity provider origins.');
  return url;
}

export function validateOidcSettings(value: unknown): OidcSettings {
  const settings = input(oidcSettingsInput, value);
  for (const address of settings.allowedAddresses) if (!addressKey(address)) unavailable('Approved network addresses must be individual IPv4 or IPv6 addresses.');
  for (const origin of settings.allowedOrigins) {
    let url: URL;
    try { url = new URL(origin); } catch { return unavailable('Approved endpoint origins are invalid.'); }
    if (url.origin !== origin || url.username || url.password) unavailable('Approved endpoints must be exact origins.');
  }
  endpoint(settings.issuer, settings);
  return settings;
}

/** Bounded, DNS-pinned transport. Only operator-approved endpoints reach this function. */
export async function requestOidcJson(raw: string, settings: OidcSettings, post?: { body: URLSearchParams; headers: Record<string, string> }): Promise<unknown> {
  const url = endpoint(raw, settings);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[];
  let dnsDeadline: ReturnType<typeof setTimeout> | undefined;
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_, reject) => { dnsDeadline = setTimeout(() => reject(new Error()), 5000); }),
  ]); }
  catch { return unavailable('The identity provider address could not be resolved.'); }
  finally { clearTimeout(dnsDeadline); }
  if (!addresses.length || addresses.some(({ address }) => !permittedOidcAddress(address, settings.allowedAddresses))) unavailable('The identity provider resolved outside the approved network addresses.');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const fail = () => reject(new FoundationError(502, 'The identity provider request failed. Check its settings and availability.'));
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: post ? 'POST' : 'GET', headers: post?.headers ?? { accept: 'application/json' },
      agent: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      },
    }, (response) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) { response.destroy(); fail(); return; }
      const body = new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>);
      readResponseText(body, { maxBytes: 1_048_576, preserveBOM: true }).then(text => resolve(JSON.parse(text))).catch(fail);
    });
    const deadline = setTimeout(() => { request.destroy(); fail(); }, 10_000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', fail);
    request.end(post?.body.toString());
  });
}

export async function discoverOidc(value: unknown): Promise<DiscoveredSettings> {
  const settings = validateOidcSettings(value);
  const result = await requestOidcJson(`${settings.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, settings);
  const { end_session_endpoint: endSession, ...metadata } = input(z.object({
    issuer: z.string(), authorization_endpoint: z.string(), token_endpoint: z.string(), jwks_uri: z.string(),
    end_session_endpoint: z.unknown().optional(),
    id_token_signing_alg_values_supported: z.array(z.string()).min(1).max(32),
  }), result);
  if (metadata.issuer !== settings.issuer) unavailable('Discovery returned a different issuer.');
  for (const url of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) endpoint(url, settings);
  if (!metadata.id_token_signing_alg_values_supported.some((algorithm) => algorithms.includes(algorithm as typeof algorithms[number]))) unavailable('This provider does not advertise a supported asymmetric ID-token signature algorithm.');
  // Optional RP-initiated sign-out: an end-session endpoint outside the approved HTTPS origins is ignored, never a reason to refuse the provider.
  let signOut: string | undefined;
  try { if (typeof endSession === 'string') signOut = endpoint(endSession, settings).href; } catch { signOut = undefined; }
  return { ...settings, metadata: { ...metadata, ...(signOut ? { end_session_endpoint: signOut } : {}) } };
}

export async function verifyOidcIdentity(settings: DiscoveredSettings, idToken: string, nonce: string): Promise<Claims> {
  if (!nonce || nonce.length > 256) unavailable('The identity sign-in nonce is unavailable. Start again.');
  const jwks = input(z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(32) }), await requestOidcJson(settings.metadata.jwks_uri, settings));
  let verifiedClaims: Claims | undefined;
  const valid = await verifyProviderIdToken({ idToken: {
    issuer: settings.issuer, audience: settings.clientId, algorithms: [...algorithms], maxTokenAge: '10m',
    jwks: async (header) => {
      const matching = jwks.keys.filter((key) => (!header.kid || key.kid === header.kid) && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig'));
      if (matching.length !== 1) throw new Error('Ambiguous signing key.');
      const key = matching[0];
      const algorithm = header.alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' }
        : { name: header.alg === 'PS256' ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
      return webcrypto.subtle.importKey('jwk', key as JsonWebKey, algorithm, false, ['verify']);
    },
    verifyClaims: (claims) => {
      // JOSE maxTokenAge owns age validation; the app enforces required OIDC claims and azp rules.
      if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 512
        || typeof claims.exp !== 'number' || typeof claims.iat !== 'number'
        || (claims.azp !== undefined && claims.azp !== settings.clientId)
        || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== settings.clientId)) return false;
      const email = z.string().trim().toLowerCase().email().max(254).safeParse(claims.email);
      verifiedClaims = {
        issuer: settings.issuer, subject: claims.sub, email: email.success ? email.data : null,
        emailVerified: claims.email_verified === true,
        authTime: typeof claims.auth_time === 'number' && Number.isFinite(claims.auth_time) ? claims.auth_time : null,
        name: typeof claims.name === 'string' ? claims.name.trim().slice(0, 120) || 'OIDC member' : 'OIDC member',
      };
      return true;
    },
  } }, idToken, nonce);
  if (!valid || !verifiedClaims) unavailable('The provider identity, audience, signature or sign-in nonce could not be verified.');
  return verifiedClaims;
}

export async function exchangeOidcCode(settings: DiscoveredSettings, clientSecret: string, code: string, verifier: string, callbackUrl: string, nonce: string): Promise<Claims> {
  const request = await authorizationCodeRequest({ code, codeVerifier: verifier, redirectURI: callbackUrl,
    options: { clientId: settings.clientId, clientSecret }, authentication: settings.authentication, tokenEndpoint: settings.metadata.token_endpoint });
  const tokens = input(z.object({ id_token: z.string().min(1).max(32_000) }), await requestOidcJson(settings.metadata.token_endpoint, settings, request));
  return verifyOidcIdentity(settings, tokens.id_token, nonce);
}

/**
 * RP-initiated sign-out target for a session that an enabled provider's sign-in created: its advertised
 * end-session endpoint with client_id only. ponytail: no ID token is kept, so there is no id_token_hint and
 * no post_logout_redirect_uri (Authentik honours a return address only with the hint) and the browser stays on
 * the provider's signed-out page; the upgrade path is storing the ID token encrypted with the session.
 */
export async function oidcSignOutUrl(request: Request): Promise<string | null> {
  const current = await getAuth().api.getSession({ headers: request.headers, query: { disableRefresh: true } });
  if (!current) return null;
  const active = (await getDatabase().pool.query<{ active: DiscoveredSettings | null }>('SELECT p.active FROM session s JOIN oidc_provider p ON p.id=s."oidcProviderId" WHERE s.id=$1 AND p.enabled', [current.session.id])).rows[0]?.active;
  if (!active?.metadata?.end_session_endpoint) return null;
  const url = new URL(active.metadata.end_session_endpoint);
  url.searchParams.set('client_id', active.clientId);
  return url.href;
}

type Provider = {
  id: string; revision: number; draft: OidcSettings | DiscoveredSettings; credential: unknown;
  active_revision: number | null; active: DiscoveredSettings | null; active_credential: unknown;
  tested_revision: number | null; tested_at: Date | null; enabled: boolean;
};
type Flow = {
  id: string; provider_id: string; provider_revision: number; purpose: 'test' | 'link' | 'login' | 'invite' | 'account';
  state_hash: string; browser_hash: string; user_id: string | null; session_id: string | null;
  credential: unknown; status: 'pending' | 'exchanging' | 'verified'; expires_at: Date; created_at: Date;
};
type FlowPayload = { nonce: string; verifier: string; invitation?: { token: string; name?: string; passwordHash?: string }; identityId?: string; claims?: Claims };
const tokenInput = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const proofInput = z.object({ proofId: z.uuid() }).strict();
function vaultContext(id: string, revision: number, provider = 'oidc-provider') { return { workspaceId: 'instance', id, provider, revision }; }
function providerInfo(provider: Provider) {
  return { id: provider.id, revision: provider.revision, settings: oidcSettingsInput.strip().parse(provider.draft), enabled: provider.enabled,
    activeRevision: provider.active_revision, testedRevision: provider.tested_revision, testedAt: provider.tested_at };
}
function json(value: unknown, status = 200, cookies: string[] = []) {
  const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return Response.json(value, { status, headers });
}
function redirect(fragment: string, cookies: string[] = []) {
  const headers = new Headers({ location: `${getConfig().appUrl}/#${fragment}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}
function bindingName(id: string) { return `${getConfig().appUrl.startsWith('https:') ? '__Host-' : ''}ten98_oidc_${id}`; }
function bindingCookie(id: string, value: string, maxAge = 600) {
  return `${bindingName(id)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${getConfig().appUrl.startsWith('https:') ? '; Secure' : ''}`;
}
async function limit(key: string, maximum: number) {
  const result = await getDatabase().pool.query(`INSERT INTO request_limit(key,minute,count)
    VALUES($1,floor(extract(epoch FROM now())/60),1) ON CONFLICT(key,minute)
    DO UPDATE SET count=LEAST(request_limit.count+1,$2::integer+1) RETURNING count`, [key, maximum]);
  if (result.rows[0].count > maximum) throw new FoundationError(429, 'Too many identity requests. Wait a minute and try again.');
}
async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw new FoundationError(503, 'Identity settings could not be saved. Try again.');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
async function identity(request: Request, client?: PoolClient) {
  const current = await getAuth(client).api.getSession({ headers: request.headers, query: { disableRefresh: true } });
  if (!current) throw new FoundationError(401, 'Sign in to continue.');
  return current;
}
async function lockedIdentity(request: Request, client: PoolClient) {
  const previous = await identity(request, client);
  await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [previous.user.id]);
  return identity(request, client);
}
async function providerRow(client: PoolClient, id: string): Promise<Provider> {
  const row = (await client.query<Provider>('SELECT * FROM oidc_provider WHERE id=$1 FOR UPDATE', [input(z.uuid(), id)])).rows[0];
  if (!row) throw new FoundationError(404, 'Identity provider not found.');
  return row;
}
function flowPayload(flow: Flow): FlowPayload {
  return decryptCredentials(flow.credential, vaultContext(flow.id, flow.provider_revision, 'oidc-transaction')) as FlowPayload;
}
function providerSecret(provider: Provider, draft: boolean): string {
  return (decryptCredentials(draft ? provider.credential : provider.active_credential,
    vaultContext(provider.id, draft ? provider.revision : provider.active_revision!)) as { clientSecret: string }).clientSecret;
}
function validFlow(flow: Flow | undefined, provider: Provider, status: Flow['status']) {
  if (!flow || flow.status !== status || flow.expires_at.getTime() <= Date.now()
    || (flow.purpose === 'test' ? provider.revision : provider.active_revision) !== flow.provider_revision
    || (flow.purpose !== 'test' && !provider.enabled)) throw new FoundationError(410, 'This identity request expired or changed. Start again.');
  return flow;
}
async function sessionBound(flow: Flow, request: Request, client: PoolClient) {
  const current = await lockedIdentity(request, client);
  if (current.user.id !== flow.user_id || current.session.id !== flow.session_id) throw new FoundationError(403, 'Complete this identity request in the account and browser that started it.');
  if (flow.purpose === 'test') await requireInstanceOperator(client, current.user.id);
  return current;
}

async function beginFlow(request: Request, providerId: string, purpose: Flow['purpose'], proof?: unknown, invitation?: FlowPayload['invitation'], identityId?: string) {
  return transaction(async client => {
    const provider = await providerRow(client, providerId);
    let current: Awaited<ReturnType<typeof identity>> | undefined;
    if (purpose === 'test' || purpose === 'link') {
      current = await requireLocalIdentityProof(client, request, proof);
      if (purpose === 'test') await requireInstanceOperator(client, current.user.id);
    } else if (purpose === 'account') {
      current = await lockedIdentity(request, client);
      if ((await client.query("SELECT 1 FROM account WHERE \"userId\"=$1 AND \"providerId\"='credential' AND password IS NOT NULL", [current.user.id])).rowCount) throw new FoundationError(409, 'Use your local password for account security changes.');
      if (!(await client.query('SELECT 1 FROM oidc_identity WHERE id=$1 AND user_id=$2 AND provider_id=$3', [identityId, current.user.id, providerId])).rowCount) throw new FoundationError(404, 'Linked identity unavailable.');
    } else if (await getAuth(client).api.getSession({ headers: request.headers, query: { disableRefresh: true } })) {
      throw new FoundationError(409, 'Sign out before starting another identity sign-in. Link identities from account settings.');
    }
    if (purpose !== 'test' && !provider.enabled) throw new FoundationError(404, 'Identity provider is unavailable.');
    const settings = purpose === 'test' ? await discoverOidc(oidcSettingsInput.strip().parse(provider.draft)) : provider.active!;
    if (purpose === 'test') await client.query('UPDATE oidc_provider SET draft=$2 WHERE id=$1', [provider.id, settings]);
    const revision = purpose === 'test' ? provider.revision : provider.active_revision!;
    const id = randomUUID(), state = randomBytes(32).toString('base64url'), browser = randomBytes(32).toString('base64url');
    const payload: FlowPayload = { nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'), ...(invitation ? { invitation } : {}), ...(identityId ? { identityId } : {}) };
    const authorization = await createAuthorizationURL({ id: provider.id, options: { clientId: settings.clientId },
      authorizationEndpoint: settings.metadata.authorization_endpoint, redirectURI: `${getConfig().appUrl}/api/auth/oidc/callback`,
      state, codeVerifier: payload.verifier, nonce: payload.nonce, scopes: ['openid', 'email', 'profile'], prompt: 'login',
      ...(purpose === 'account' ? { additionalParams: { max_age: '0' } } : {}) });
    await client.query('DELETE FROM oidc_transaction WHERE expires_at<=clock_timestamp()');
    await client.query(`INSERT INTO oidc_transaction(id,provider_id,provider_revision,purpose,state_hash,browser_hash,user_id,session_id,credential,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '10 minutes')`,
    [id, provider.id, revision, purpose, digest(state), digest(browser), current?.user.id ?? null, current?.session.id ?? null,
      encryptCredentials(payload, vaultContext(id, revision, 'oidc-transaction'))]);
    return json({ authorizationUrl: authorization.href }, 200, [bindingCookie(id, browser)]);
  });
}

async function proofRow(client: PoolClient, request: Request, proofId: string) {
  const hint = (await client.query<Flow>('SELECT * FROM oidc_transaction WHERE id=$1', [proofId])).rows[0];
  if (!hint) throw new FoundationError(410, 'This identity proof is unavailable or expired.');
  const provider = await providerRow(client, hint.provider_id);
  const flow = validFlow((await client.query<Flow>('SELECT * FROM oidc_transaction WHERE id=$1 FOR UPDATE', [proofId])).rows[0], provider, 'verified');
  if (flow.purpose !== 'test' && flow.purpose !== 'link' && flow.purpose !== 'account') throw new FoundationError(410, 'This identity proof is unavailable.');
  const current = await sessionBound(flow, request, client);
  const claims = flowPayload(flow).claims;
  if (!claims) throw new FoundationError(410, 'This identity proof is unavailable.');
  if (flow.purpose === 'account') await validateAccountProof(client, flow, claims);
  return { provider, flow, current, claims };
}

async function validateAccountProof(client: PoolClient, flow: Flow, claims: Claims) {
  const payload = flowPayload(flow);
  if (claims.authTime === null || claims.authTime < flow.created_at.getTime() / 1000 - 60 || claims.authTime > Date.now() / 1000 + 30) throw new FoundationError(403, 'The provider must confirm a fresh sign-in before changing account security.');
  const linked = await client.query('SELECT 1 FROM oidc_identity WHERE id=$1 AND user_id=$2 AND provider_id=$3 AND issuer=$4 AND subject=$5', [payload.identityId, flow.user_id, flow.provider_id, claims.issuer, claims.subject]);
  if (!linked.rowCount) throw new FoundationError(403, 'The provider sign-in did not match the linked account identity.');
}

async function revokeProviderSessions(client: PoolClient, providerId: string) {
  await client.query('DELETE FROM session WHERE "oidcProviderId"=$1', [providerId]);
  await client.query(`WITH bound AS (DELETE FROM verification WHERE identifier LIKE 'oidc-challenge:%' AND value=$1 RETURNING substring(identifier from 16) AS challenge)
    DELETE FROM verification WHERE identifier IN (SELECT challenge FROM bound) OR identifier IN (SELECT '2fa-attempts-' || challenge FROM bound)`, [providerId]);
}

async function callback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let flowId: string | undefined;
  let ownsExchange = false;
  try {
    await limit('oidc:callback', 120);
    if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')) throw new FoundationError(400, 'Identity sign-in was not completed.');
    const state = input(tokenInput, url.searchParams.get('state'));
    const code = input(z.string().min(1).max(8192), url.searchParams.get('code'));
    const hint = (await getDatabase().pool.query<Flow>('SELECT * FROM oidc_transaction WHERE state_hash=$1', [digest(state)])).rows[0];
    if (!hint) throw new FoundationError(410, 'Identity request unavailable.');
    flowId = hint.id;
    const browser = parseCookies(request.headers.get('cookie') ?? '').get(bindingName(hint.id)) ?? '';
    if (!tokenInput.safeParse(browser).success || digest(browser) !== hint.browser_hash) throw new FoundationError(403, 'Identity browser binding not accepted.');
    const prepared = await transaction(async client => {
      const provider = await providerRow(client, hint.provider_id);
      const flow = validFlow((await client.query<Flow>('SELECT * FROM oidc_transaction WHERE id=$1 FOR UPDATE', [hint.id])).rows[0], provider, 'pending');
      if (flow.purpose === 'test' || flow.purpose === 'link' || flow.purpose === 'account') await sessionBound(flow, request, client);
      await client.query("UPDATE oidc_transaction SET status='exchanging' WHERE id=$1", [flow.id]);
      return { flow, payload: flowPayload(flow), settings: (flow.purpose === 'test' ? provider.draft : provider.active) as DiscoveredSettings,
        secret: providerSecret(provider, flow.purpose === 'test') };
    });
    ownsExchange = true;
    const claims = await exchangeOidcCode(prepared.settings, prepared.secret, code, prepared.payload.verifier, `${getConfig().appUrl}/api/auth/oidc/callback`, prepared.payload.nonce);
    return await transaction(async client => {
      const provider = await providerRow(client, hint.provider_id);
      const flow = validFlow((await client.query<Flow>('SELECT * FROM oidc_transaction WHERE id=$1 FOR UPDATE', [hint.id])).rows[0], provider, 'exchanging');
      const cookies = [bindingCookie(flow.id, '', 0)];
      if (flow.purpose === 'test' || flow.purpose === 'link' || flow.purpose === 'account') {
        await sessionBound(flow, request, client);
        if (flow.purpose === 'account') await validateAccountProof(client, flow, claims);
        await client.query("UPDATE oidc_transaction SET status='verified',credential=$2 WHERE id=$1", [flow.id,
          encryptCredentials({ ...prepared.payload, claims }, vaultContext(flow.id, flow.provider_revision, 'oidc-transaction'))]);
        if (flow.purpose === 'test') await client.query('UPDATE oidc_provider SET tested_revision=$2,tested_at=clock_timestamp() WHERE id=$1', [provider.id, provider.revision]);
        return redirect(`oidc-proof=${flow.id}`, cookies);
      }
      if (await getAuth(client).api.getSession({ headers: request.headers, query: { disableRefresh: true } })) throw new FoundationError(409, 'Sign out before completing another identity sign-in.');
      const linked = await client.query<{ user_id: string }>('SELECT user_id FROM oidc_identity WHERE issuer=$1 AND subject=$2 AND provider_id=$3', [claims.issuer, claims.subject, provider.id]);
      let userId = linked.rows[0]?.user_id;
      if (flow.purpose === 'invite') {
        // An invitation is never silently added to an existing identity or account.
        // Existing users first finish sign-in (including MFA), then accept normally.
        if (userId) throw new FoundationError(409, 'Sign in first, then accept the invitation.');
        if (!provider.active?.trustVerifiedEmail || !claims.emailVerified || !claims.email || !prepared.payload.invitation) throw new FoundationError(403, 'This provider cannot verify the invitation recipient.');
        const created = await acceptVerifiedOidcInvitation(client, prepared.payload.invitation.token, { email: claims.email, name: prepared.payload.invitation.name ?? claims.name }, prepared.payload.invitation.passwordHash);
        userId = created.userId;
        await client.query('INSERT INTO oidc_identity(id,provider_id,user_id,issuer,subject) VALUES($1,$2,$3,$4,$5)', [randomUUID(), provider.id, userId, claims.issuer, claims.subject]);
      }
      if (!userId) throw new FoundationError(403, 'This provider identity has no linked account. Use local sign-in to link it, or start from an invitation.');
      await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]);
      // Recheck after the account lock: removal can invalidate the link while a callback waits.
      if (!(await client.query('SELECT 1 FROM oidc_identity WHERE user_id=$1 AND provider_id=$2 AND issuer=$3 AND subject=$4', [userId, provider.id, claims.issuer, claims.subject])).rowCount) throw new FoundationError(403, 'The linked identity is unavailable.');
      const response = await getAuth(client).api.completeOidcSession({ body: { oidcUserId: userId }, headers: request.headers, asResponse: true });
      if (!response.ok) throw new FoundationError(503, 'Identity sign-in could not be completed.');
      const data = await response.json();
      const returnedCookies = response.headers.getSetCookie();
      const cookieHeaders = new Headers({ cookie: returnedCookies.map(value => value.split(';', 1)[0]).join('; ') });
      if (data.twoFactorRedirect === true) {
        const challenge = getSessionCookie(cookieHeaders, { cookieName: 'two_factor' })?.split('.')[0];
        if (!challenge) throw new FoundationError(503, 'The second-factor challenge could not be created.');
        await client.query(`INSERT INTO verification(id,identifier,value,"expiresAt") VALUES($1,$2,$3,clock_timestamp()+interval '10 minutes')`, [randomUUID(), `oidc-challenge:${challenge}`, provider.id]);
      } else {
        const session = await getAuth(client).api.getSession({ headers: cookieHeaders, query: { disableRefresh: true } });
        if (!session || session.user.id !== userId) throw new FoundationError(503, 'Identity session could not be verified.');
        await client.query('UPDATE session SET "oidcProviderId"=$2 WHERE id=$1', [session.session.id, provider.id]);
      }
      await client.query('DELETE FROM oidc_transaction WHERE id=$1', [flow.id]);
      return redirect(data.twoFactorRedirect === true ? 'oidc-factor=1' : 'oidc-complete=1', [...cookies, ...returnedCookies]);
    });
  } catch {
    // Never put authorization codes, claims, state or upstream errors in redirects/logs.
    if (flowId && ownsExchange) await getDatabase().pool.query('DELETE FROM oidc_transaction WHERE id=$1', [flowId]).catch(() => undefined);
    return redirect('oidc-error=1', flowId ? [bindingCookie(flowId, '', 0)] : []);
  }
}

export async function handleOidc(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  if (!path.startsWith('/api/auth/oidc/') && !path.startsWith('/api/identity/oidc/') && !path.startsWith('/api/account/oidc/')) return null;
  if (path === '/api/auth/oidc/callback' && request.method === 'GET') return callback(request);
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (request.method === 'POST' && request.headers.get('origin') !== getConfig().appUrl) throw new FoundationError(403, 'This action must originate from the application.');
  if (path === '/api/auth/oidc/providers' && request.method === 'GET') {
    const providers = await getDatabase().pool.query("SELECT id,active->>'name' AS name FROM oidc_provider WHERE enabled ORDER BY created_at,id");
    return json({ providers: providers.rows });
  }
  if (path === '/api/auth/oidc/start' && request.method === 'POST') {
    const details = input(z.object({ providerId: z.uuid(), invitationToken: tokenInput.optional(), name: z.string().trim().min(1).max(120).optional(), password: z.string().min(12).max(128).optional() }).strict(), await readJson(request));
    await limit('oidc:start', 60);
    let invitation: FlowPayload['invitation'];
    if (details.invitationToken) {
      await inspectInvitation({ token: details.invitationToken });
      await limit(`oidc:invite:${digest(details.invitationToken)}`, 5);
      invitation = { token: details.invitationToken, name: details.name, ...(details.password ? { passwordHash: await hashPassword(details.password) } : {}) };
    } else if (details.name || details.password) throw new FoundationError(400, 'Account creation details require an invitation.');
    return beginFlow(request, details.providerId, details.invitationToken ? 'invite' : 'login', undefined, invitation);
  }
  const signedIn = await identity(request);
  await limit(`oidc:${request.method}:${signedIn.user.id}`, request.method === 'GET' ? 120 : 10);
  const body = request.method === 'POST' ? await readJson(request, 16_384) : undefined;
  if (path === '/api/identity/oidc/providers') {
    return transaction(async client => {
      // Serialize provider creation to enforce a small, operator-controlled instance limit.
      await client.query('SELECT pg_advisory_xact_lock(109860,1)');
      const details = request.method === 'POST' ? input(z.object({ id: z.uuid().optional(), settings: oidcSettingsInput, clientSecret: z.string().max(4096) }).strict(), body) : null;
      const previous = details?.id ? await providerRow(client, details.id) : undefined;
      const current = await lockedIdentity(request, client);
      await requireInstanceOperator(client, current.user.id);
      if (!details) {
        const providers = await client.query<Provider>('SELECT * FROM oidc_provider ORDER BY created_at,id');
        return json({ providers: providers.rows.map(providerInfo), callbackUrl: `${getConfig().appUrl}/api/auth/oidc/callback`, vaultConfigured: credentialKeys() !== null });
      }
      const settings = validateOidcSettings(details.settings);
      if (settings.authentication === 'basic' && !details.clientSecret) throw new FoundationError(400, 'HTTP Basic authentication requires a client secret. Use form-body authentication with an empty secret for a public client.');
      if (!previous && (await client.query('SELECT count(*)::int AS count FROM oidc_provider')).rows[0].count >= 20) throw new FoundationError(409, 'An instance supports up to 20 identity providers.');
      const id = previous?.id ?? randomUUID(), revision = (previous?.revision ?? 0) + 1;
      const credential = encryptCredentials({ clientSecret: details.clientSecret }, vaultContext(id, revision));
      const saved = previous
        ? await client.query<Provider>('UPDATE oidc_provider SET revision=$2,draft=$3,credential=$4,tested_revision=NULL,tested_at=NULL,updated_at=now() WHERE id=$1 RETURNING *', [id, revision, settings, credential])
        : await client.query<Provider>('INSERT INTO oidc_provider(id,draft,credential) VALUES($1,$2,$3) RETURNING *', [id, settings, credential]);
      return json({ provider: providerInfo(saved.rows[0]) });
    });
  }
  const providerAction = path.match(/^\/api\/identity\/oidc\/providers\/([0-9a-f-]+)\/(test|enable|disable)$/);
  if (providerAction && request.method === 'POST') {
    const providerId = input(z.uuid(), providerAction[1]);
    if (providerAction[2] === 'test') {
      const details = input(z.object({ proof: localIdentityProofInput }).strict(), body);
      return beginFlow(request, providerId, 'test', details.proof);
    }
    return transaction(async client => {
      if (providerAction[2] === 'enable') {
        const details = input(proofInput, body);
        const proof = await proofRow(client, request, details.proofId);
        if (proof.flow.purpose !== 'test' || proof.provider.id !== providerId || proof.provider.tested_revision !== proof.provider.revision) throw new FoundationError(409, 'Test this draft and review its identity proof before enabling it.');
        await revokeProviderSessions(client, providerId);
        await client.query('UPDATE oidc_provider SET active_revision=revision,active=draft,active_credential=credential,enabled=true,updated_at=now() WHERE id=$1', [providerId]);
        await client.query('DELETE FROM oidc_transaction WHERE provider_id=$1', [providerId]);
      } else {
        input(z.object({}).strict(), body);
        await providerRow(client, providerId);
        const current = await lockedIdentity(request, client);
        await requireInstanceOperator(client, current.user.id);
        await client.query('UPDATE oidc_provider SET enabled=false,updated_at=now() WHERE id=$1', [providerId]);
        await revokeProviderSessions(client, providerId);
        await client.query('DELETE FROM oidc_transaction WHERE provider_id=$1', [providerId]);
      }
      return json({ ok: true });
    });
  }
  if (path === '/api/account/oidc/link/start' && request.method === 'POST') {
    const details = input(z.object({ providerId: z.uuid(), proof: localIdentityProofInput }).strict(), body);
    return beginFlow(request, details.providerId, 'link', details.proof);
  }
  if (path === '/api/account/oidc/reauth/start' && request.method === 'POST') {
    const details = input(z.object({ identityId: z.uuid() }).strict(), body);
    const linked = (await getDatabase().pool.query('SELECT provider_id FROM oidc_identity WHERE id=$1 AND user_id=$2', [details.identityId, signedIn.user.id])).rows[0];
    if (!linked) throw new FoundationError(404, 'Linked identity unavailable.');
    return beginFlow(request, linked.provider_id, 'account', undefined, undefined, details.identityId);
  }
  if (path === '/api/account/oidc/reauth/confirm' && request.method === 'POST') return transaction(async client => {
    const details = input(oidcSecurityActionInput.extend({ proofId: z.uuid() }), body);
    const proof = await proofRow(client, request, details.proofId);
    if (proof.flow.purpose !== 'account') throw new FoundationError(409, 'Verify your linked identity before changing account security.');
    const { proofId, ...action } = details;
    // The proof is consumed together with the account mutation; neither can commit alone.
    await client.query('DELETE FROM oidc_transaction WHERE id=$1', [proofId]);
    return applyOidcAccountSecurity(client, request, action);
  });
  const proofPath = path.match(/^\/api\/account\/oidc\/proofs\/([0-9a-f-]+)$/);
  if (proofPath && request.method === 'GET') return transaction(async client => {
    const proof = await proofRow(client, request, input(z.uuid(), proofPath[1]));
    return json({ proof: { id: proof.flow.id, purpose: proof.flow.purpose, providerId: proof.provider.id,
      providerName: (proof.flow.purpose === 'test' ? proof.provider.draft : proof.provider.active)!.name,
      issuer: proof.claims.issuer, subject: proof.claims.subject, email: proof.claims.email, emailVerified: proof.claims.emailVerified, expiresAt: proof.flow.expires_at } });
  });
  if (path === '/api/account/oidc/link/confirm' && request.method === 'POST') return transaction(async client => {
    const details = input(proofInput, body);
    const proof = await proofRow(client, request, details.proofId);
    if (proof.flow.purpose !== 'link') throw new FoundationError(409, 'Start an account-link request before confirming it.');
    const existing = await client.query('SELECT user_id FROM oidc_identity WHERE issuer=$1 AND subject=$2', [proof.claims.issuer, proof.claims.subject]);
    if (existing.rowCount) throw new FoundationError(409, 'This provider identity is already linked.');
    await client.query('INSERT INTO oidc_identity(id,provider_id,user_id,issuer,subject) VALUES($1,$2,$3,$4,$5)', [randomUUID(), proof.provider.id, proof.current.user.id, proof.claims.issuer, proof.claims.subject]);
    await client.query('DELETE FROM oidc_transaction WHERE id=$1', [proof.flow.id]);
    return json({ ok: true });
  });
  if (path === '/api/account/oidc/identities' && request.method === 'GET') return transaction(async client => {
    const current = await lockedIdentity(request, client);
    const identities = await client.query(`SELECT i.id,i.issuer,i.subject,i.created_at AS "createdAt",p.id AS "providerId",p.active->>'name' AS "providerName",p.enabled
      FROM oidc_identity i JOIN oidc_provider p ON p.id=i.provider_id WHERE i.user_id=$1 ORDER BY i.created_at,i.id`, [current.user.id]);
    return json({ identities: identities.rows });
  });
  const removePath = path.match(/^\/api\/account\/oidc\/identities\/([0-9a-f-]+)\/remove$/);
  if (removePath && request.method === 'POST') return transaction(async client => {
    const id = input(z.uuid(), removePath[1]);
    const hint = (await client.query('SELECT provider_id FROM oidc_identity WHERE id=$1 AND user_id=$2', [id, signedIn.user.id])).rows[0];
    if (!hint) throw new FoundationError(404, 'Linked identity unavailable.');
    await providerRow(client, hint.provider_id);
    const details = input(z.object({ proof: localIdentityProofInput }).strict(), body);
    const current = await requireLocalIdentityProof(client, request, details.proof);
    const removed = await client.query('DELETE FROM oidc_identity WHERE id=$1 AND user_id=$2 RETURNING id', [id, current.user.id]);
    if (!removed.rowCount) throw new FoundationError(404, 'Linked identity unavailable.');
    await client.query('DELETE FROM session WHERE "userId"=$1 AND "oidcProviderId"=$2', [current.user.id, hint.provider_id]);
    await client.query(`WITH bound AS (DELETE FROM verification b WHERE b.identifier LIKE 'oidc-challenge:%' AND b.value=$2
      AND EXISTS(SELECT 1 FROM verification v WHERE v.identifier=substring(b.identifier from 16) AND v.value=$1) RETURNING substring(b.identifier from 16) AS challenge)
      DELETE FROM verification WHERE identifier IN(SELECT challenge FROM bound) OR identifier IN(SELECT '2fa-attempts-' || challenge FROM bound)`, [current.user.id, hint.provider_id]);
    await client.query('DELETE FROM oidc_transaction WHERE user_id=$1 AND provider_id=$2', [current.user.id, hint.provider_id]);
    return json({ ok: true });
  });
  return json({ error: 'Identity route not found.' }, 404);
}

/** Health/rekey use the same authenticated envelopes as normal access; no plaintext leaves this module. */
export async function assertOidcCredentialsReadable(): Promise<void> {
  const providers = await getDatabase().pool.query<Provider>('SELECT * FROM oidc_provider');
  for (const provider of providers.rows) {
    providerSecret(provider, true);
    if (provider.active_credential) providerSecret(provider, false);
  }
  const flows = await getDatabase().pool.query<Flow>('SELECT * FROM oidc_transaction WHERE expires_at>clock_timestamp()');
  for (const flow of flows.rows) flowPayload(flow);
}
export async function rotateOidcCredentials(): Promise<number> {
  return transaction(async client => {
    const providers = await client.query<Provider>('SELECT * FROM oidc_provider ORDER BY id FOR UPDATE');
    let count = 0;
    for (const provider of providers.rows) {
      const credential = encryptCredentials({ clientSecret: providerSecret(provider, true) }, vaultContext(provider.id, provider.revision));
      const active = provider.active_credential ? encryptCredentials({ clientSecret: providerSecret(provider, false) }, vaultContext(provider.id, provider.active_revision!)) : null;
      await client.query('UPDATE oidc_provider SET credential=$2,active_credential=$3 WHERE id=$1', [provider.id, credential, active]);
      count++;
    }
    await client.query('DELETE FROM oidc_transaction WHERE expires_at<=clock_timestamp()');
    const flows = await client.query<Flow>('SELECT * FROM oidc_transaction ORDER BY id FOR UPDATE');
    for (const flow of flows.rows) await client.query('UPDATE oidc_transaction SET credential=$2 WHERE id=$1', [flow.id, encryptCredentials(flowPayload(flow), vaultContext(flow.id, flow.provider_revision, 'oidc-transaction'))]);
    return count;
  });
}
