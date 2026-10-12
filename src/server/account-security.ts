import { createHash, randomUUID } from 'node:crypto';
import { getSessionCookie, parseCookies } from 'better-auth/cookies';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError, getAuth } from './auth.ts';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { readJson } from './validation.ts';

type Auth = ReturnType<typeof getAuth>;
const currentPassword = z.string().min(1).max(128);
const passwordInput = z.object({ password: currentPassword }).strict();
const codeInput = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const backupInput = z.object({ code: z.string().regex(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{15}$/) }).strict();
const signInInput = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: currentPassword }).strict();
const accountInputs = {
  '/api/account/password': z.object({ currentPassword, newPassword: z.string().min(12).max(128) }).strict(),
  '/api/account/sessions/revoke': z.object({ sessionId: z.string().min(1).max(128) }).strict(),
  '/api/account/sessions/revoke-others': z.object({}).strict(),
  '/api/account/two-factor/enable': passwordInput,
  '/api/account/two-factor/verify': codeInput,
  '/api/account/two-factor/disable': passwordInput,
  '/api/account/two-factor/recovery-codes': passwordInput,
} as const;

function parsed<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new FoundationError(400, 'Check the submitted fields and try again.');
  return result.data;
}

function json(body: unknown, status = 200, source?: Response): Response {
  const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  for (const cookie of source?.headers.getSetCookie() ?? []) headers.append('set-cookie', cookie);
  return Response.json(body, { status, headers });
}

async function limit(key: string, maximum: number) {
  const { rows } = await getDatabase().pool.query(
    `WITH expired AS (DELETE FROM request_limit WHERE minute < floor(extract(epoch FROM now()) / 60) - 60)
     INSERT INTO request_limit(key,minute,count) VALUES($1,floor(extract(epoch FROM now()) / 60),1)
     ON CONFLICT(key,minute) DO UPDATE SET count=LEAST(request_limit.count+1,$2::integer+1) RETURNING count`, [key, maximum],
  );
  if (rows[0].count > maximum) throw new FoundationError(429, 'Too many requests. Wait a minute and try again.');
}

async function transaction(run: (client: PoolClient, auth: Auth) => Promise<Response>): Promise<Response> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const response = await run(client, getAuth(client));
    // Failed factor responses deliberately commit their attempt/lockout counters.
    // Unexpected failures roll back all account changes and no cookies escape.
    if (response.status >= 500) throw new FoundationError(503, 'Account security is temporarily unavailable. Try again.');
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw new FoundationError(503, 'Account security could not be saved. Try again.');
    return response;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function invoke(auth: Auth, request: Request, path: string, body: unknown): Promise<Response> {
  // Only these browser headers are needed; never accept forwarding headers as identity.
  const headers = new Headers({ 'content-type': 'application/json', origin: getConfig().appUrl });
  for (const name of ['cookie', 'user-agent']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return auth.handler(new Request(`${getConfig().appUrl}/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
}

function rejected(response: Response, message: string, status = response.status): Response {
  return json({ error: response.status === 429 ? 'Too many attempts. Wait before trying again.' : message }, status, response);
}

function responseHeaders(request: Request, response: Response): Headers {
  const cookies = parseCookies(request.headers.get('cookie') ?? '');
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.slice(0, cookie.indexOf(';') < 0 ? undefined : cookie.indexOf(';'));
    for (const [name, value] of parseCookies(pair)) cookies.set(name, value);
  }
  return new Headers({ cookie: [...cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ') });
}

async function revokeOtherSessions(client: PoolClient, userId: string, sessionId: string) {
  await client.query('DELETE FROM session WHERE "userId"=$1 AND id<>$2', [userId, sessionId]);
  await invalidateChallenges(client, userId);
}

async function invalidateChallenges(client: PoolClient, userId: string) {
  await client.query(
    `WITH removed AS (DELETE FROM verification WHERE value=$1
       AND (identifier LIKE '2fa-%' OR identifier LIKE 'trust-device-%') RETURNING identifier)
     DELETE FROM verification WHERE identifier IN (SELECT '2fa-attempts-' || identifier FROM removed)`, [userId],
  );
}

async function keepResponseSession(client: PoolClient, auth: Auth, request: Request, response: Response, userId: string, providerId?: string | null) {
  const current = await auth.api.getSession({ headers: responseHeaders(request, response), query: { disableRefresh: true } });
  if (!current || current.user.id !== userId) throw new FoundationError(503, 'Sign-in could not be updated. Try again.');
  if (providerId) await client.query('UPDATE session SET "oidcProviderId"=$2 WHERE id=$1', [current.session.id, providerId]);
  await revokeOtherSessions(client, userId, current.session.id);
}

async function isRepeatedCode(client: PoolClient, userId: string, code: string): Promise<boolean> {
  const key = `totp-used:${userId}:${createHash('sha256').update(code).digest('hex')}`;
  const found = await client.query('SELECT 1 FROM verification WHERE identifier=$1 AND "expiresAt">clock_timestamp()', [key]);
  return !!found.rowCount;
}

async function rememberCode(client: PoolClient, userId: string, code: string) {
  // The library validates TOTP. This ledger only prevents reusing an accepted
  // code across separate challenges in its adjacent 30-second time windows.
  await client.query("DELETE FROM verification WHERE identifier LIKE 'totp-used:%' AND \"expiresAt\"<=clock_timestamp()");
  await client.query('INSERT INTO verification(id,identifier,value,"expiresAt") VALUES($1,$2,\'used\',clock_timestamp()+interval \'90 seconds\')',
    [randomUUID(), `totp-used:${userId}:${createHash('sha256').update(code).digest('hex')}`]);
}

export const localIdentityProofInput = z.object({ password: currentPassword, code: codeInput.shape.code.optional(), backupCode: backupInput.shape.code.optional() }).strict();

async function requireFactorProof(client: PoolClient, request: Request, userId: string, details: { code?: string; backupCode?: string }) {
  if ((!details.code && !details.backupCode) || (details.code && details.backupCode)) throw new FoundationError(400, 'Enter an authenticator code or a recovery code to verify this action.');
  if (details.code && await isRepeatedCode(client, userId, details.code)) throw new FoundationError(409, 'Wait for the next authenticator code, then try again.');
  const response = await invoke(getAuth(client), request, details.code ? '/two-factor/verify-totp' : '/two-factor/verify-backup-code', { code: details.code ?? details.backupCode });
  if (!response.ok) throw new FoundationError(400, 'The verification code was not accepted.');
  if (details.code) await rememberCode(client, userId, details.code);
}

/** Server-only step-up proof for explicit identity linking and operator recovery tests. */
export async function requireLocalIdentityProof(client: PoolClient, request: Request, proof: unknown) {
  const details = parsed(localIdentityProofInput, proof);
  const auth = getAuth(client);
  const identity = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
  if (!identity) throw new FoundationError(401, 'Sign in to continue.');
  await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [identity.user.id]);
  const current = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
  if (!current) throw new FoundationError(401, 'Sign in to continue.');
  const credential = await client.query<{ password: string }>("SELECT password FROM account WHERE \"userId\"=$1 AND \"providerId\"='credential' AND password IS NOT NULL", [current.user.id]);
  if (!credential.rowCount || !await verifyPassword({ hash: credential.rows[0].password, password: details.password })) throw new FoundationError(400, 'The local account password was not accepted.');
  if (current.user.twoFactorEnabled) {
    await requireFactorProof(client, request, current.user.id, details);
  }
  return current;
}

export const oidcSecurityActionInput = z.object({
  action: z.enum(['set-password', 'enable-two-factor', 'disable-two-factor', 'replace-recovery']),
  newPassword: z.string().min(12).max(128).optional(), code: codeInput.shape.code.optional(), backupCode: backupInput.shape.code.optional(),
}).strict();

/** Server-only: caller has locked and consumed a fresh, matching OIDC account proof in this transaction. */
export async function applyOidcAccountSecurity(client: PoolClient, request: Request, value: unknown): Promise<Response> {
  const details = parsed(oidcSecurityActionInput, value), auth = getAuth(client);
  const current = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
  if (!current) throw new FoundationError(401, 'Sign in to continue.');
  await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [current.user.id]);
  if (!await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } })) throw new FoundationError(401, 'Sign in to continue.');
  if ((await client.query("SELECT 1 FROM account WHERE \"userId\"=$1 AND \"providerId\"='credential' AND password IS NOT NULL", [current.user.id])).rowCount) throw new FoundationError(409, 'Use your local account password for security changes.');
  if ((details.action === 'set-password') !== (details.newPassword !== undefined)) throw new FoundationError(400, 'Supply a new password only when adding local sign-in.');
  if (current.user.twoFactorEnabled) await requireFactorProof(client, request, current.user.id, details);
  const providerId = (await client.query('SELECT "oidcProviderId" FROM session WHERE id=$1', [current.session.id])).rows[0]?.oidcProviderId as string | null;
  if (details.action === 'set-password') {
    const password = await hashPassword(details.newPassword!);
    await client.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), current.user.id, password]);
    const response = await auth.api.rotateVerifiedSession({ body: { verifiedUserId: current.user.id }, headers: request.headers, asResponse: true });
    if (!response.ok) throw new FoundationError(503, 'Local recovery sign-in could not be created.');
    await keepResponseSession(client, auth, request, response, current.user.id);
    return json({ ok: true, hasPassword: true }, 200, response);
  }
  if (details.action === 'enable-two-factor') {
    const response = await invoke(auth, request, '/two-factor/enable', { method: 'totp' });
    if (!response.ok) throw new FoundationError(400, 'Authenticator setup is unavailable or already enabled.');
    const result = await response.json();
    return json({ totpURI: result.totpURI, backupCodes: result.backupCodes }, 200, response);
  }
  if (details.action === 'disable-two-factor') {
    const response = await invoke(auth, request, '/two-factor/disable', {});
    if (!response.ok) throw new FoundationError(400, 'Two-factor authentication could not be disabled.');
    await keepResponseSession(client, auth, request, response, current.user.id, providerId);
    return json({ ok: true, twoFactorEnabled: false }, 200, response);
  }
  const response = await invoke(auth, request, '/two-factor/generate-backup-codes', {});
  if (!response.ok) throw new FoundationError(400, 'Enable two-factor authentication before replacing recovery codes.');
  const result = await response.json();
  await revokeOtherSessions(client, current.user.id, current.session.id);
  return json({ backupCodes: result.backupCodes }, 200, response);
}

export async function handleAccountSecurity(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  const signIn = path === '/api/auth/sign-in/email';
  const challenge = path === '/api/auth/two-factor/verify-totp' || path === '/api/auth/two-factor/verify-backup-code';
  const status = path === '/api/account/security';
  const mutation = Object.hasOwn(accountInputs, path);
  if (!signIn && !challenge && !status && !mutation) return null;
  if (request.method !== (status ? 'GET' : 'POST')) return json({ error: 'Method not allowed.' }, 405);
  if (!status && request.headers.get('origin') !== getConfig().appUrl) throw new FoundationError(403, 'This action must originate from the application.');
  const input = status ? undefined : await readJson(request);

  if (signIn) {
    const details = parsed(signInInput, input);
    await limit('signin:global', 60);
    await limit(`signin:${createHash('sha256').update(details.email).digest('hex')}`, 5);
    return transaction(async (client, auth) => {
      await client.query('SELECT id FROM "user" WHERE lower(email)=$1 FOR UPDATE', [details.email]);
      const response = await invoke(auth, request, '/sign-in/email', details);
      if (!response.ok) return rejected(response, 'Email or password not accepted.');
      const data = await response.json();
      return json(data.twoFactorRedirect === true ? { twoFactorRedirect: true } : { ok: true }, 200, response);
    });
  }

  if (challenge) {
    const totp = path.endsWith('/verify-totp');
    const details = parsed(totp ? codeInput : backupInput, input);
    await limit('two-factor:global', 60);
    const cookie = getSessionCookie(request, { cookieName: 'two_factor' }) ?? '';
    await limit(`two-factor:${createHash('sha256').update(cookie).digest('hex')}`, 10);
    return transaction(async (client, auth) => {
      if (await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } })) {
        return json({ error: 'This sign-in is already complete.' }, 409);
      }
      // An untrusted cookie prefix is only a lock hint, never authentication.
      // Better Auth validates the signed cookie and consumes the challenge below.
      const identifier = cookie.split('.')[0];
      const oidcBinding = (await client.query<{ value: string }>('SELECT value FROM verification WHERE identifier=$1 AND "expiresAt">clock_timestamp()', [`oidc-challenge:${identifier}`])).rows[0];
      if (oidcBinding) {
        // Match callback/unlink/disable lock order: provider -> account -> session.
        const provider = await client.query('SELECT enabled FROM oidc_provider WHERE id=$1 FOR UPDATE', [oidcBinding.value]);
        if (!provider.rows[0]?.enabled) return json({ error: 'The identity provider is unavailable. Sign in again.' }, 410);
      }
      const pending = await client.query<{ value: string }>('SELECT value FROM verification WHERE identifier=$1 AND "expiresAt">clock_timestamp()', [identifier]);
      const userId = pending.rows[0]?.value;
      if (userId) await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]);
      if (totp && userId && await isRepeatedCode(client, userId, details.code)) return json({ error: 'Wait for the next authenticator code, then try again.' }, 409);
      const response = await invoke(auth, request, totp ? '/two-factor/verify-totp' : '/two-factor/verify-backup-code', details);
      if (!response.ok) return rejected(response, 'The code was not accepted. Try another code or sign in again.');
      if (totp && userId) await rememberCode(client, userId, details.code);
      if (oidcBinding) {
        const complete = await auth.api.getSession({ headers: responseHeaders(request, response), query: { disableRefresh: true } });
        if (!complete || complete.user.id !== userId) throw new FoundationError(503, 'Identity sign-in could not be verified.');
        await client.query('UPDATE session SET "oidcProviderId"=$2 WHERE id=$1', [complete.session.id, oidcBinding.value]);
        await client.query('DELETE FROM verification WHERE identifier=$1', [`oidc-challenge:${identifier}`]);
      }
      return json({ ok: true }, 200, response);
    });
  }

  if (mutation) parsed(accountInputs[path as keyof typeof accountInputs], input);
  const identity = await getAuth().api.getSession({ headers: request.headers, query: { disableRefresh: true } });
  if (!identity) throw new FoundationError(401, 'Sign in to continue.');
  await limit(`account-security:${status ? 'read' : 'write'}:${identity.user.id}`, status ? 120 : 30);
  return transaction(async (client, auth) => {
    // Preserve provider -> account order when a factor operation rotates an OIDC session.
    const boundProvider = (await client.query('SELECT "oidcProviderId" FROM session WHERE id=$1', [identity.session.id])).rows[0]?.oidcProviderId as string | null;
    if (boundProvider) await client.query('SELECT id FROM oidc_provider WHERE id=$1 FOR UPDATE', [boundProvider]);
    await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [identity.user.id]);
    const current = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
    if (!current || current.user.id !== identity.user.id) throw new FoundationError(401, 'Sign in to continue.');
    const userId = current.user.id;
    const providerId = (await client.query('SELECT "oidcProviderId" FROM session WHERE id=$1', [current.session.id])).rows[0]?.oidcProviderId as string | null;
    if (status) {
      const sessions = await client.query('SELECT id,"createdAt","expiresAt","userAgent" FROM session WHERE "userId"=$1 AND "expiresAt">clock_timestamp() ORDER BY "createdAt" DESC,id LIMIT 100', [userId]);
      const credential = await client.query("SELECT 1 FROM account WHERE \"userId\"=$1 AND \"providerId\"='credential' AND password IS NOT NULL", [userId]);
      return json({
        user: { id: userId, name: current.user.name, email: current.user.email, twoFactorEnabled: current.user.twoFactorEnabled === true },
        hasPassword: !!credential.rowCount,
        sessions: sessions.rows.map((session) => ({ ...session, current: session.id === current.session.id })),
      });
    }
    if (path === '/api/account/sessions/revoke') {
      const { sessionId } = parsed(accountInputs[path], input);
      const removed = await client.query('DELETE FROM session WHERE id=$1 AND "userId"=$2 RETURNING id', [sessionId, userId]);
      if (!removed.rowCount) throw new FoundationError(404, 'Session not found or unavailable.');
      const signedOut = sessionId === current.session.id;
      const response = signedOut ? await invoke(auth, request, '/sign-out', {}) : undefined;
      return json({ ok: true, signedOut }, 200, response);
    }
    if (path === '/api/account/sessions/revoke-others') {
      await revokeOtherSessions(client, userId, current.session.id);
      return json({ ok: true });
    }
    if (path === '/api/account/password') {
      const response = await invoke(auth, request, '/change-password', { ...parsed(accountInputs[path], input), revokeOtherSessions: true });
      if (!response.ok) return rejected(response, 'The current password was not accepted.');
      await keepResponseSession(client, auth, request, response, userId);
      return json({ ok: true }, 200, response);
    }
    if (path === '/api/account/two-factor/enable') {
      if (!(await client.query("SELECT 1 FROM account WHERE \"userId\"=$1 AND \"providerId\"='credential' AND password IS NOT NULL", [userId])).rowCount) throw new FoundationError(409, 'Verify your linked identity provider before changing account security.');
      const response = await invoke(auth, request, '/two-factor/enable', { ...parsed(passwordInput, input), method: 'totp' });
      if (!response.ok) return rejected(response, current.user.twoFactorEnabled ? 'Two-factor authentication is already enabled.' : 'The current password was not accepted.');
      const data = await response.json();
      return json({ totpURI: data.totpURI, backupCodes: data.backupCodes }, 200, response);
    }
    if (path === '/api/account/two-factor/verify') {
      const factor = await client.query('SELECT verified FROM "twoFactor" WHERE "userId"=$1', [userId]);
      if (!factor.rowCount || factor.rows[0].verified) throw new FoundationError(409, 'Start authenticator setup before confirming a code.');
      const details = parsed(codeInput, input);
      if (await isRepeatedCode(client, userId, details.code)) return json({ error: 'Wait for the next authenticator code, then try again.' }, 409);
      const response = await invoke(auth, request, '/two-factor/verify-totp', details);
      if (!response.ok) return rejected(response, 'The authenticator code was not accepted.', response.status === 401 ? 400 : response.status);
      await rememberCode(client, userId, details.code);
      await keepResponseSession(client, auth, request, response, userId, providerId);
      return json({ ok: true, twoFactorEnabled: true }, 200, response);
    }
    if (path === '/api/account/two-factor/disable') {
      if (!(await client.query("SELECT 1 FROM account WHERE \"userId\"=$1 AND \"providerId\"='credential' AND password IS NOT NULL", [userId])).rowCount) throw new FoundationError(409, 'Verify your linked identity provider before changing account security.');
      const response = await invoke(auth, request, '/two-factor/disable', parsed(passwordInput, input));
      if (!response.ok) return rejected(response, 'The current password was not accepted.');
      await keepResponseSession(client, auth, request, response, userId, providerId);
      return json({ ok: true, twoFactorEnabled: false }, 200, response);
    }
    if (!(await client.query("SELECT 1 FROM account WHERE \"userId\"=$1 AND \"providerId\"='credential' AND password IS NOT NULL", [userId])).rowCount) throw new FoundationError(409, 'Verify your linked identity provider before changing account security.');
    const response = await invoke(auth, request, '/two-factor/generate-backup-codes', parsed(passwordInput, input));
    if (!response.ok) return rejected(response, 'Check your password and enable two-factor authentication before replacing recovery codes.');
    const data = await response.json();
    await revokeOtherSessions(client, userId, current.session.id);
    return json({ backupCodes: data.backupCodes }, 200, response);
  });
}
