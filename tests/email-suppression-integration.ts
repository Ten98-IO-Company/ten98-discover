import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, getDatabase } from '../src/server/db.ts';
import { handleApi } from '../src/server/api.ts';
import { sendTransactionalEmail, withEmailTransportsForTests } from '../src/server/email.ts';
import { complaintSuppressionDays, emailAddressDigest, isEmailSuppressed, legacyEmailAddressDigest, recordEmailSuppression } from '../src/server/email-suppression.ts';
import { handleSesFeedback, sesFeedbackPath } from '../src/server/ses-feedback.ts';
import { signSnsTestMessage, snsTestCertificate, snsTestCertificateUrl, snsTestTopic } from './fixtures/sns-test-signer.ts';

// Needs an isolated synthetic PostgreSQL database; never a real installation. No request leaves the process: SES and SNS
// are stubbed, and the SNS signature comes from the test-only signer.
export async function runEmailSuppressionChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  const config = getConfig();
  for (const url of [config.appUrl, config.databaseUrl]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  const { pool } = getDatabase();
  const suffix = randomBytes(8).toString('hex');
  const bounced = `bounced-${suffix}@example.com`, complained = `complained-${suffix}@example.com`, transient = `transient-${suffix}@example.com`, open = `open-${suffix}@example.com`;
  const rows = async (address: string) => (await pool.query('SELECT address_hash,reason FROM email_suppression WHERE address_hash=$1', [emailAddressDigest(address)])).rows;

  // Storage: digest only, idempotent, case-insensitive lookup.
  await recordEmailSuppression(bounced, 'permanent-bounce');
  await recordEmailSuppression(bounced.toUpperCase(), 'complaint');
  assert.deepEqual(await rows(bounced), [{ address_hash: emailAddressDigest(bounced), reason: 'permanent-bounce' }], 'The first reason is kept and a redelivery adds no row.');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM email_suppression WHERE address_hash LIKE '%@%'")).rows[0].n, 0, 'No address text is stored.');
  assert.equal(await isEmailSuppressed(bounced.toUpperCase()), true);
  assert.equal(await isEmailSuppressed(open), false);

  const ses = { EMAIL_TRANSPORT: 'ses', EMAIL_FROM: 'sender@example.com', EMAIL_SES_REGION: 'eu-west-1', EMAIL_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', EMAIL_SES_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', EMAIL_SES_SNS_TOPIC_ARNS: snsTestTopic };
  const saved = Object.fromEntries(Object.keys(ses).map(key => [key, process.env[key]]));
  try {
    // The public route is matched before any session or API key lookup and refuses an unsigned body without a write.
    const before = (await pool.query('SELECT count(*)::int AS n FROM email_suppression')).rows[0].n;
    Object.assign(process.env, ses);
    const forged = await handleApi(new Request(config.appUrl + sesFeedbackPath, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ Type: 'Notification', Message: JSON.stringify({ notificationType: 'Bounce' }) }) }));
    assert.equal(forged.status, 403);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_suppression')).rows[0].n, before);

    // Verified feedback through the real store: hard bounce and complaint block, a transient bounce does not.
    const adapters = { fetch: async (url: string) => { assert.equal(url, snsTestCertificateUrl); return new Response(snsTestCertificate); } };
    const feedback = (event: unknown) => new Request(config.appUrl + sesFeedbackPath, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: signSnsTestMessage('Notification', { Message: JSON.stringify(event) }) });
    const at = new Date().toISOString(), mail = { timestamp: at, messageId: 'synthetic', source: 'sender@example.com', destination: [complained] };
    for (const event of [
      { notificationType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: complained }], timestamp: at, feedbackId: 'synthetic', complaintFeedbackType: 'abuse' } },
      { notificationType: 'Bounce', mail, bounce: { bounceType: 'Transient', bounceSubType: 'MailboxFull', bouncedRecipients: [{ emailAddress: transient, status: '4.2.2' }], timestamp: at, feedbackId: 'synthetic' } },
    ]) assert.equal((await handleSesFeedback(feedback(event), process.env, adapters)).status, 200);
    assert.deepEqual((await rows(complained)).map(row => row.reason), ['complaint']);
    assert.deepEqual(await rows(transient), []);

    // Sending consults the real store: a suppressed address makes no SES request; an open one makes exactly one.
    let calls = 0;
    const fetch = async () => { calls++; return new Response(JSON.stringify({ MessageId: 'synthetic' }), { headers: { 'content-type': 'application/json' } }); };
    const message = (to: string) => ({ to, subject: 'Your ten98 Discover workspace invitation', text: 'Synthetic integration message.' });
    for (const to of [bounced, complained]) await assert.rejects(withEmailTransportsForTests({ fetch }, () => sendTransactionalEmail(message(to), ses)), { name: 'EmailDeliveryError' });
    assert.equal(calls, 0);
    assert.deepEqual(await withEmailTransportsForTests({ fetch }, () => sendTransactionalEmail(message(transient), ses)), { accepted: true, delivery: 'unconfirmed' });
    assert.equal(calls, 1);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  // #310: rows are keyed HMAC digests; nothing derivable from the address alone is written.
  assert.deepEqual((await pool.query('SELECT keyed FROM email_suppression WHERE address_hash=$1', [emailAddressDigest(bounced)])).rows, [{ keyed: true }]);
  assert.equal((await pool.query('SELECT 1 FROM email_suppression WHERE address_hash=$1', [legacyEmailAddressDigest(bounced)])).rowCount, 0, 'No unkeyed digest is stored.');
  // A row recorded before #310 (unkeyed, keyed=false) still blocks, so no suppression is silently lost.
  const legacy = `legacy-${suffix}@example.com`, legacyComplaint = `legacy-complaint-${suffix}@example.com`;
  await pool.query('INSERT INTO email_suppression(address_hash,reason) VALUES($1,$2),($3,$4)', [legacyEmailAddressDigest(legacy), 'permanent-bounce', legacyEmailAddressDigest(legacyComplaint), 'complaint']);
  assert.equal(await isEmailSuppressed(legacy.toUpperCase()), true);
  assert.equal(await isEmailSuppressed(legacyComplaint), true);

  // Expiry: complaints stop blocking after complaintSuppressionDays; hard bounces never expire on their own.
  const stale = `stale-${suffix}@example.com`, oldBounce = `old-bounce-${suffix}@example.com`, upgraded = `upgraded-${suffix}@example.com`;
  await recordEmailSuppression(stale, 'complaint'); await recordEmailSuppression(oldBounce, 'permanent-bounce');
  const age = (digests: string[], days: number) => pool.query('UPDATE email_suppression SET created_at=clock_timestamp()-make_interval(days=>$2) WHERE address_hash=ANY($1)', [digests, days]);
  await age([emailAddressDigest(stale)], complaintSuppressionDays - 1);
  assert.equal(await isEmailSuppressed(stale), true, 'A complaint inside the period still blocks.');
  await age([emailAddressDigest(stale), emailAddressDigest(oldBounce), legacyEmailAddressDigest(legacy), legacyEmailAddressDigest(legacyComplaint)], complaintSuppressionDays + 1);
  assert.equal(await isEmailSuppressed(stale), false, 'An expired complaint no longer blocks.');
  assert.equal(await isEmailSuppressed(legacyComplaint), false, 'An expired legacy complaint no longer blocks.');
  assert.equal(await isEmailSuppressed(oldBounce), true, 'A hard bounce stays until cleared.');
  assert.equal(await isEmailSuppressed(legacy), true, 'A legacy hard bounce stays until cleared.');
  // A new complaint after expiry blocks again for a fresh period; the write also purges other expired complaints.
  await recordEmailSuppression(stale, 'complaint');
  assert.equal(await isEmailSuppressed(stale), true);
  assert.equal((await pool.query('SELECT 1 FROM email_suppression WHERE address_hash=$1', [legacyEmailAddressDigest(legacyComplaint)])).rowCount, 0, 'Expired complaints are purged, not kept as personal data.');
  // A hard bounce after a complaint makes the suppression permanent; a complaint never downgrades a hard bounce.
  await recordEmailSuppression(upgraded, 'complaint'); await recordEmailSuppression(upgraded, 'permanent-bounce');
  assert.deepEqual(await rows(upgraded), [{ address_hash: emailAddressDigest(upgraded), reason: 'permanent-bounce' }]);

  // Operator clear through the real CLI: only a named instance operator, audited, and the address is never printed.
  const account = async (label: string) => {
    const id = randomUUID(), email = `${label}-${suffix}@suppression.integration.test`;
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [id, `Suppression ${label}`, email]);
    return { id, email };
  };
  const operator = await account('operator'), member = await account('member');
  await pool.query("INSERT INTO instance_operator(user_id,source) VALUES($1,'host')", [operator.id]);
  const clears = async () => (await pool.query<{ user_id: string; scope: string | null }>("SELECT user_id,scope FROM instance_operator_audit WHERE action='email_suppression_clear' AND user_id=ANY($1) ORDER BY id", [[operator.id, member.id]])).rows;
  const cli = (...args: string[]) => {
    const block = 'data:text/javascript,' + encodeURIComponent("globalThis.fetch=async()=>{throw new Error('No network allowed in suppression clear acceptance');}");
    const result = spawnSync(process.execPath, ['--import', block, 'src/server/cli.ts', 'email-suppression', 'clear', ...args],
      { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 45_000, maxBuffer: 1_000_000, windowsHide: true });
    for (const secret of [config.databaseUrl, config.authSecret]) assert.ok(!(result.stdout + result.stderr).includes(secret), 'The CLI printed secret configuration.');
    for (const address of [bounced, legacy, oldBounce]) assert.ok(!(result.stdout + result.stderr).toLowerCase().includes(address.toLowerCase()), 'The CLI printed the suppressed address.');
    return result;
  };
  for (const [args, pattern] of [
    [[bounced], /^Usage: cli\.ts /], [[bounced, '--operator'], /^Usage: cli\.ts /], [['--operator', operator.email], /^Usage: cli\.ts /],
    [['not-an-address', '--operator', operator.email], /^Supply the suppressed email address\./],
    [[bounced, '--operator', member.email], /^This action requires an instance operator\./],
    [[bounced, '--operator', `unknown-${suffix}@suppression.integration.test`], /^This action requires an instance operator\./],
  ] as [string[], RegExp][]) {
    const result = cli(...args);
    assert.equal(result.status, 1, args.join(' ')); assert.match(result.stderr, pattern);
  }
  assert.deepEqual(await clears(), [], 'A refused clear writes no audit row.');
  assert.equal(await isEmailSuppressed(bounced), true, 'A refused clear removes nothing.');
  for (const address of [bounced.toUpperCase(), legacy, oldBounce]) {
    const result = cli(address, '--operator', operator.email.toUpperCase());
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /^Email suppression cleared and audited\./);
    assert.equal(await isEmailSuppressed(address), false);
  }
  const again = cli(bounced, '--operator', operator.email);
  assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /^No email suppression was recorded for that address\. The clear was audited\./);
  assert.deepEqual(await clears(), Array.from({ length: 4 }, () => ({ user_id: operator.id, scope: null })), 'Each clear is audited by operator id only; no address or digest is recorded.');
  console.log('PASS suppression digests are keyed, legacy unkeyed rows still block, complaints expire while hard bounces stay, and only an audited instance operator clears one address through the CLI without printing it');

  console.log('PASS SES feedback records only verified hard bounces and complaints as address digests, refuses unsigned bodies through the public route, and suppressed addresses make no SES request');
}
