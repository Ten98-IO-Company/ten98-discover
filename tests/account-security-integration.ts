import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { getConfig } from '../src/server/config.ts';
import { getDatabase } from '../src/server/db.ts';
import { getAuth } from '../src/server/auth.ts';
import { acceptInvitation, inviteMember } from '../src/server/teams.ts';

type Options = { baseUrl: string; appUrl: string; ownerCookie: string; ownerId: string; workspaceId: string };
type Browser = { cookies: Map<string, string> };
const browser = (): Browser => ({ cookies: new Map() });

// Independent RFC 6238 calculation against the authenticator URI returned by the app.
export function authenticatorCode(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of secret.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    assert.ok(index >= 0, 'Authenticator URI must contain a valid base32 secret.');
    bits += index.toString(2).padStart(5, '0');
  }
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, index) => parseInt(bits.slice(index * 8, index * 8 + 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export async function runAccountSecurityChecks(options: Options): Promise<void> {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Account checks require the isolated integration-test opt-in.');
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  assert.ok(local.has(new URL(options.baseUrl).hostname) && local.has(new URL(options.appUrl).hostname));
  assert.ok(local.has(new URL(getConfig().databaseUrl).hostname), 'Account tests require a local test database.');
  const { pool } = getDatabase();
  const own = await pool.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'", [options.workspaceId, options.ownerId]);
  assert.equal(own.rowCount, 1, 'Foundation test must supply its owner and workspace.');
  const email = `${randomUUID()}@account.integration.test`;
  const firstPassword = randomBytes(24).toString('base64url');
  const nextPassword = randomBytes(24).toString('base64url');
  const invitation = await inviteMember(options.workspaceId, options.ownerId, { email, role: 'viewer' });
  await acceptInvitation({ token: invitation.token, name: 'Account security check', password: firstPassword });
  const user = await pool.query('SELECT id FROM "user" WHERE email=$1', [email]);
  const userId = user.rows[0].id as string;

  async function call(path: string, actor: Browser, input?: unknown, origin = options.appUrl) {
    const headers = new Headers({ cookie: [...actor.cookies].map(([name, value]) => `${name}=${value}`).join('; ') });
    if (input !== undefined) { headers.set('content-type', 'application/json'); headers.set('origin', origin); }
    const response = await fetch(new URL(path, options.baseUrl), {
      method: input === undefined ? 'GET' : 'POST', headers,
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(20_000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const split = pair.indexOf('=');
      if (/max-age=0(?:;|$)/i.test(cookie)) actor.cookies.delete(pair.slice(0, split));
      else actor.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return { status: response.status, body: await response.json() };
  }
  async function expect(path: string, actor: Browser, status: number, input?: unknown, origin?: string) {
    const result = await call(path, actor, input, origin);
    assert.equal(result.status, status, `Account HTTP contract failed at ${path}.`);
    return result.body;
  }
  const signIn = (actor: Browser, password = nextPassword) => expect('/api/auth/sign-in/email', actor, 200, { email, password });
  // Test phases reset only this synthetic account's counters; separate rate-limit cases remain enforced.
  const resetBudget = () => pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])', [[`signin:${createHash('sha256').update(email).digest('hex')}`, `account-security:write:${userId}`, `account-security:read:${userId}`]]);
  const primary = browser();
  const secondary = browser();
  await expect('/api/account/security', browser(), 401);
  await expect('/api/auth/sign-in/email', primary, 403, { email, password: firstPassword }, 'https://untrusted.integration.test');
  await expect('/api/auth/sign-in/email', primary, 400, { email, password: firstPassword, trustDevice: true });
  await signIn(primary, firstPassword);
  const initial = await expect('/api/account/security', primary, 200);
  assert.equal(initial.user.twoFactorEnabled, false);
  assert.equal(initial.hasPassword, true);
  assert.ok(initial.sessions.some((session: { current: boolean }) => session.current));
  assert.ok(initial.sessions.every((session: Record<string, unknown>) => !('token' in session) && !('ipAddress' in session)), 'Session list must not reveal bearer credentials.');
  await signIn(secondary, firstPassword);
  const secondaryStatus = await expect('/api/account/security', secondary, 200);
  const secondaryId = secondaryStatus.sessions.find((session: { current: boolean }) => session.current).id;
  const foreign = await pool.query('SELECT id FROM session WHERE "userId"=$1 LIMIT 1', [options.ownerId]);
  assert.ok(foreign.rowCount);
  await expect('/api/account/sessions/revoke', primary, 404, { sessionId: foreign.rows[0].id });
  await expect('/api/account/sessions/revoke', primary, 200, { sessionId: secondaryId });
  await expect('/api/me', secondary, 401);
  await expect('/api/account/password', primary, 400, { currentPassword: 'incorrect password', newPassword: nextPassword });
  await expect('/api/account/password', primary, 400, { currentPassword: firstPassword, newPassword: 'short' });

  // Inject a late session-creation failure: password and earlier session deletions must roll back.
  const before = await pool.query("SELECT password FROM account WHERE \"userId\"=$1 AND \"providerId\"='credential'", [userId]);
  const constraint = `test_account_security_${randomUUID().replaceAll('-', '')}`;
  try {
    await pool.query(`ALTER TABLE session ADD CONSTRAINT ${constraint} CHECK ("userId" <> '${userId}') NOT VALID`);
    const isolated = await pool.connect();
    const originalError = console.error, originalWarn = console.warn;
    let logged = false;
    try {
      await isolated.query('BEGIN');
      console.error = () => { logged = true; }; console.warn = () => { logged = true; };
      const failure = await getAuth(isolated).handler(new Request(`${options.appUrl}/api/auth/change-password`, {
        method: 'POST', headers: { origin: options.appUrl, 'content-type': 'application/json', cookie: [...primary.cookies].map(([key, value]) => `${key}=${value}`).join('; ') },
        body: JSON.stringify({ currentPassword: firstPassword, newPassword: nextPassword, revokeOtherSessions: true }),
      }));
      assert.equal(failure.status, 500, 'Unexpected database errors must become a generic auth response.');
      const publicError = await failure.text();
      assert.ok(!publicError.includes(firstPassword) && !publicError.includes(nextPassword) && !publicError.includes('insert into'), 'Unexpected auth failures must not disclose credentials or SQL.');
      assert.equal(logged, false, 'The upstream router must not log raw authentication database errors.');
    } finally {
      console.error = originalError; console.warn = originalWarn;
      await isolated.query('ROLLBACK').catch(() => undefined); isolated.release();
    }
    const failed = await call('/api/account/password', primary, { currentPassword: firstPassword, newPassword: nextPassword });
    assert.ok(failed.status >= 500, 'Injected account write failure must reject the change.');
    const after = await pool.query("SELECT password FROM account WHERE \"userId\"=$1 AND \"providerId\"='credential'", [userId]);
    assert.ok(after.rows[0].password === before.rows[0].password, 'Failed security change must preserve the prior password hash.');
    await expect('/api/me', primary, 200);
  } finally { await pool.query(`ALTER TABLE session DROP CONSTRAINT IF EXISTS ${constraint}`); }
  await signIn(secondary, firstPassword);
  await expect('/api/account/password', primary, 200, { currentPassword: firstPassword, newPassword: nextPassword });
  await expect('/api/me', secondary, 401);
  await expect('/api/me', primary, 200);
  await expect('/api/auth/sign-in/email', browser(), 401, { email, password: firstPassword });
  await resetBudget();
  await signIn(secondary);

  await expect('/api/account/two-factor/enable', primary, 400, { password: 'incorrect password' });
  const enrollment = await expect('/api/account/two-factor/enable', primary, 200, { password: nextPassword });
  assert.ok(typeof enrollment.totpURI === 'string' && enrollment.totpURI.startsWith('otpauth://totp/'));
  assert.ok(Array.isArray(enrollment.backupCodes) && enrollment.backupCodes.length === 10 && new Set(enrollment.backupCodes).size === 10);
  const secret = new URL(enrollment.totpURI).searchParams.get('secret');
  assert.ok(secret, 'Enrollment must supply an authenticator secret.');
  const encrypted = await pool.query('SELECT secret,"backupCodes",verified FROM "twoFactor" WHERE "userId"=$1', [userId]);
  assert.ok(!encrypted.rows[0].secret.includes(secret) && !enrollment.backupCodes.some((code: string) => encrypted.rows[0].backupCodes.includes(code)), 'Factor secrets and recovery codes must be encrypted at rest.');
  assert.equal(encrypted.rows[0].verified, false);
  assert.equal((await expect('/api/account/security', primary, 200)).user.twoFactorEnabled, false);
  const step = Math.floor(Date.now() / 30_000);
  const adjacentCodes = new Set([-1, 0, 1].map((offset) => authenticatorCode(secret, step + offset)));
  let wrongCode = '000000';
  while (adjacentCodes.has(wrongCode)) wrongCode = String(Number(wrongCode) + 1).padStart(6, '0');
  await expect('/api/account/two-factor/verify', primary, 400, { code: wrongCode });
  await expect('/api/me', primary, 200);
  const enrollmentCode = authenticatorCode(secret);
  await expect('/api/account/two-factor/verify', primary, 200, { code: enrollmentCode });
  assert.equal((await expect('/api/account/security', primary, 200)).user.twoFactorEnabled, true);
  await expect('/api/me', secondary, 401);
  await expect('/api/account/two-factor/enable', primary, 400, { password: nextPassword });

  const oidcClient = await pool.connect();
  try {
    await oidcClient.query('BEGIN');
    await oidcClient.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]);
    const beforeSessions = await oidcClient.query('SELECT count(*)::int AS count FROM session WHERE "userId"=$1', [userId]);
    const oidcSession = await getAuth(oidcClient).api.completeOidcSession({ body: { oidcUserId: userId }, asResponse: true });
    assert.equal(oidcSession.status, 200);
    assert.equal((await oidcSession.json()).twoFactorRedirect, true, 'Verified OIDC sign-in must still challenge a locally enrolled second factor.');
    const afterSessions = await oidcClient.query('SELECT count(*)::int AS count FROM session WHERE "userId"=$1', [userId]);
    assert.equal(afterSessions.rows[0].count, beforeSessions.rows[0].count, 'Pending OIDC factor proof must not issue a usable session.');
    await oidcClient.query('ROLLBACK');
  } finally { await oidcClient.query('ROLLBACK').catch(() => undefined); oidcClient.release(); }
  await expect('/api/auth/complete-oidc-session', browser(), 404, { oidcUserId: userId });
  await expect('/api/auth/rotate-verified-session', browser(), 404, { verifiedUserId: userId });

  const challenged = browser();
  assert.equal((await signIn(challenged)).twoFactorRedirect, true);
  await expect('/api/me', challenged, 401);
  await expect('/api/account/security', challenged, 401);
  // The pending factor is a challenge, not a session: workspace and website reads stay closed, before and after a wrong code.
  const project = (await pool.query('SELECT id FROM project WHERE workspace_id=$1 ORDER BY created_at LIMIT 1', [options.workspaceId])).rows[0]?.id as string | undefined;
  assert.ok(project, 'Foundation test must leave a website in the owner workspace.');
  assert.deepEqual([...challenged.cookies.keys()], ['better-auth.two_factor'], 'The password step must leave only the two_factor cookie.');
  const pendingReads = [`/api/workspaces/${options.workspaceId}/projects`, `/api/projects/${project}/events`, `/api/projects/${project}/realtime`];
  const closed = async () => { for (const path of pendingReads) assert.deepEqual(Object.keys(await expect(path, challenged, 401)), ['error'], `A pending second factor must not read ${path}.`); };
  await closed();
  const pendingCookie = challenged.cookies.get('better-auth.two_factor');
  await expect('/api/auth/two-factor/verify-totp', challenged, 401, { code: wrongCode });
  assert.equal(challenged.cookies.get('better-auth.two_factor'), pendingCookie, 'A wrong code must leave the same pending cookie, still without a session.');
  await closed();
  await expect('/api/auth/two-factor/verify-totp', challenged, 400, { code: enrollmentCode, trustDevice: true });
  await expect('/api/auth/two-factor/verify-backup-code', challenged, 400, { code: enrollment.backupCodes[0], disableSession: true });
  await expect('/api/auth/two-factor/verify-totp', challenged, 409, { code: enrollmentCode });
  const consumedChallenge = { cookies: new Map(challenged.cookies) };
  const completed = await expect('/api/auth/two-factor/verify-backup-code', challenged, 200, { code: enrollment.backupCodes[0] });
  assert.ok(!('token' in completed) && !('session' in completed));
  await expect('/api/me', challenged, 200);
  for (const path of pendingReads) await expect(path, challenged, 200);
  console.log('PASS pending second-factor cookie alone reads no workspace or website data, before and after a wrong code');
  await expect('/api/auth/two-factor/verify-backup-code', consumedChallenge, 401, { code: enrollment.backupCodes[1] });
  const reused = browser();
  await signIn(reused);
  await expect('/api/auth/two-factor/verify-backup-code', reused, 401, { code: enrollment.backupCodes[0] });
  await expect('/api/me', reused, 401);
  await resetBudget();

  const racing = [browser(), browser()];
  for (const actor of racing) await signIn(actor);
  const attempts = await Promise.all(racing.map((actor) => call('/api/auth/two-factor/verify-backup-code', actor, { code: enrollment.backupCodes[1] })));
  assert.equal(attempts.filter((attempt) => attempt.status === 200).length, 1, 'Only one concurrent use of a recovery code may succeed.');
  assert.equal(attempts.filter((attempt) => attempt.status === 401 || attempt.status === 409).length, 1);
  await expect('/api/me', racing[attempts.findIndex((attempt) => attempt.status !== 200)], 401);

  // Wait at most one 30-second period so a real, unused authenticator code completes sign-in.
  if (authenticatorCode(secret) === enrollmentCode) await new Promise((resolve) => setTimeout(resolve, 30_100 - (Date.now() % 30_000)));
  const totpLogin = browser();
  await signIn(totpLogin);
  const freshCode = authenticatorCode(secret);
  await expect('/api/auth/two-factor/verify-totp', totpLogin, 200, { code: freshCode });
  await expect('/api/me', totpLogin, 200);
  const replay = browser();
  await signIn(replay);
  await expect('/api/auth/two-factor/verify-totp', replay, 409, { code: freshCode });
  await expect('/api/me', replay, 401);
  await resetBudget();

  const replaced = await expect('/api/account/two-factor/recovery-codes', primary, 200, { password: nextPassword });
  assert.ok(replaced.backupCodes.length === 10 && !replaced.backupCodes.some((code: string) => enrollment.backupCodes.includes(code)));
  await expect('/api/me', totpLogin, 401);
  await expect('/api/auth/two-factor/verify-backup-code', replay, 401, { code: replaced.backupCodes[0] });
  const recovered = browser();
  await signIn(recovered);
  await expect('/api/auth/two-factor/verify-backup-code', recovered, 401, { code: enrollment.backupCodes[2] });
  await expect('/api/auth/two-factor/verify-backup-code', recovered, 200, { code: replaced.backupCodes[0] });
  const pendingPassword = browser();
  await signIn(pendingPassword);
  const finalPassword = randomBytes(24).toString('base64url');
  await expect('/api/account/password', primary, 200, { currentPassword: nextPassword, newPassword: finalPassword });
  await expect('/api/me', recovered, 401);
  await expect('/api/auth/two-factor/verify-backup-code', pendingPassword, 401, { code: replaced.backupCodes[1] });
  await expect('/api/account/two-factor/disable', primary, 400, { password: 'incorrect password' });
  await expect('/api/account/two-factor/disable', primary, 200, { password: finalPassword });
  assert.equal((await expect('/api/account/security', primary, 200)).user.twoFactorEnabled, false);
  assert.equal((await pool.query('SELECT 1 FROM "twoFactor" WHERE "userId"=$1', [userId])).rowCount, 0);
  const normal = browser();
  assert.equal((await signIn(normal, finalPassword)).ok, true);
  await expect('/api/account/sessions/revoke-others', primary, 200, {});
  await expect('/api/me', normal, 401);
  const last = await expect('/api/account/security', primary, 200);
  const currentId = last.sessions.find((session: { current: boolean }) => session.current).id;
  assert.equal((await expect('/api/account/sessions/revoke', primary, 200, { sessionId: currentId })).signedOut, true);
  await expect('/api/me', primary, 401);
}
