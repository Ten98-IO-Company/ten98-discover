import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, getDatabase } from '../src/server/db.ts';
import { handleApi } from '../src/server/api.ts';
import { sendTransactionalEmail, withEmailTransportsForTests } from '../src/server/email.ts';
import { emailAddressDigest, isEmailSuppressed, recordEmailSuppression } from '../src/server/email-suppression.ts';
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
  console.log('PASS SES feedback records only verified hard bounces and complaints as address digests, refuses unsigned bodies through the public route, and suppressed addresses make no SES request');
}
