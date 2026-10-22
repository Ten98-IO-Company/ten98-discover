import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sesOrigin } from '@ten98/runtime';
import { EmailDeliveryError, getEmailStatus, sendTransactionalEmail, withEmailTransportsForTests } from '../src/server/email.ts';
import { emailAddressDigest } from '../src/server/email-suppression.ts';
import { handleSesFeedback, sesFeedbackPath, sesFeedbackTopics } from '../src/server/ses-feedback.ts';
import { signSnsTestMessage, snsTestCertificate, snsTestCertificateUrl, snsTestTopic } from './fixtures/sns-test-signer.ts';

// Synthetic credentials in the documented AWS example format; no request leaves the process.
const ses = { EMAIL_TRANSPORT: 'ses', EMAIL_FROM: 'sender@example.com', EMAIL_SES_REGION: 'eu-west-1', EMAIL_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', EMAIL_SES_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const message = { to: 'recipient@example.com', subject: 'Reset your password', text: 'Use this link once:\nhttps://app.example.com/reset?token=private-token' };
const notSuppressed = async () => false;
const unconfirmed = { name: 'EmailDeliveryError', message: 'Email acceptance could not be confirmed. No automatic retry was made.' };

test('SES readiness is configuration only and refuses regions outside the runtime allowlist and malformed credentials', () => {
  assert.deepEqual(getEmailStatus(ses), { configured: true, transport: 'ses' });
  assert.deepEqual(getEmailStatus({ ...ses, EMAIL_SES_CONFIGURATION_SET: 'transactional-1' }), { configured: true, transport: 'ses' });
  for (const env of [{ ...ses, EMAIL_SES_REGION: 'eu-west-9' }, { ...ses, EMAIL_SES_REGION: 'email.eu-west-1.amazonaws.com' }, { ...ses, EMAIL_SES_REGION: '' },
    { ...ses, EMAIL_SES_ACCESS_KEY_ID: 'not a key' }, { ...ses, EMAIL_SES_SECRET_ACCESS_KEY: '' }, { ...ses, EMAIL_SES_SECRET_ACCESS_KEY: 'short' },
    { ...ses, EMAIL_SES_CONFIGURATION_SET: 'bad set' }, { ...ses, EMAIL_FROM: 'Name <sender@example.com>' },
    { ...ses, EMAIL_SES_ACCESS_KEY_ID: '', EMAIL_SES_ACCESS_KEY_ID_FILE: 'also-set' }]) assert.deepEqual(getEmailStatus(env), { configured: false, transport: 'disabled' });
});

test('SES sends one SigV4-signed SendEmail to the fixed regional origin through the shared runtime and reports acceptance as unconfirmed', async () => {
  let calls = 0;
  const accepted = await withEmailTransportsForTests({ isSuppressed: notSuppressed, fetch: async (url, init) => {
    calls++;
    assert.equal(url, sesOrigin('eu-west-1') + '/v2/email/outbound-emails');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.match(headers.get('authorization') ?? '', /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
    const body = JSON.parse(String(init.body));
    assert.equal(body.FromEmailAddress, 'sender@example.com'); assert.deepEqual(body.Destination, { ToAddresses: [message.to] });
    assert.equal(body.ConfigurationSetName, 'transactional-1');
    assert.equal(body.Content.Simple.Subject.Data, message.subject); assert.equal(body.Content.Simple.Body.Text.Data, message.text);
    assert.ok(!String(init.body).includes(ses.EMAIL_SES_SECRET_ACCESS_KEY), 'The secret never leaves the signer.');
    return new Response(JSON.stringify({ MessageId: 'synthetic-message-id' }), { headers: { 'content-type': 'application/json' } });
  } }, () => sendTransactionalEmail(message, { ...ses, EMAIL_SES_CONFIGURATION_SET: 'transactional-1' }));
  assert.deepEqual(accepted, { accepted: true, delivery: 'unconfirmed' }); assert.equal(calls, 1);
});

test('SES uncertain, throttled and rejected outcomes are the same single-attempt error and never leak provider content', async () => {
  const replies: (() => Response)[] = [
    () => new Response('private-token ' + message.to, { status: 500 }),
    () => new Response(JSON.stringify({ __type: 'ThrottlingException', message: message.text }), { status: 429, headers: { 'content-type': 'application/json' } }),
    () => new Response(JSON.stringify({ __type: 'MessageRejected', message: message.to }), { status: 400, headers: { 'content-type': 'application/json' } }),
    () => { throw new Error('socket hang up ' + ses.EMAIL_SES_SECRET_ACCESS_KEY); },
  ];
  for (const reply of replies) {
    let calls = 0;
    await assert.rejects(withEmailTransportsForTests({ isSuppressed: notSuppressed, fetch: async () => { calls++; return reply(); } }, () => sendTransactionalEmail(message, ses)), unconfirmed);
    assert.equal(calls, 1, 'One attempt; no automatic retry.');
  }
});

test('a suppressed SES recipient is refused before any request; a failed suppression lookup refuses too', async () => {
  let calls = 0, looked = '';
  const fetchSpy = async () => { calls++; return new Response('{}'); };
  await assert.rejects(withEmailTransportsForTests({ isSuppressed: async address => { looked = address; return true; }, fetch: fetchSpy }, () => sendTransactionalEmail(message, ses)), EmailDeliveryError);
  assert.equal(looked, message.to);
  await assert.rejects(withEmailTransportsForTests({ isSuppressed: async () => { throw new Error('database unavailable'); }, fetch: fetchSpy }, () => sendTransactionalEmail(message, ses)), EmailDeliveryError);
  assert.equal(calls, 0);
  assert.equal(emailAddressDigest(' Recipient@Example.COM '), emailAddressDigest('recipient@example.com'));
  assert.match(emailAddressDigest(message.to), /^[0-9a-f]{64}$/);
});

// ---- SNS feedback webhook --------------------------------------------------------------------------------------------
const topic = snsTestTopic, certificateUrl = snsTestCertificateUrl, signed = signSnsTestMessage;
const feedbackEnv = { ...ses, EMAIL_SES_SNS_TOPIC_ARNS: topic };
const notification = (event: unknown) => signed('Notification', { Message: JSON.stringify(event) });
const mail = { timestamp: new Date().toISOString(), messageId: 'synthetic', source: 'sender@example.com', destination: ['a@example.com'] };
// Recorded-shape SES notifications (https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html) with synthetic addresses.
const bounce = (bounceType: string, bounceSubType: string, recipients: Record<string, string>[]) => ({ notificationType: 'Bounce', mail, bounce: { bounceType, bounceSubType, bouncedRecipients: recipients, timestamp: new Date().toISOString(), feedbackId: 'synthetic' } });
const complaint = (complaintFeedbackType?: string) => ({ notificationType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: 'complainer@example.com' }], timestamp: new Date().toISOString(), feedbackId: 'synthetic', ...(complaintFeedbackType ? { complaintFeedbackType } : {}) } });

function harness() {
  const recorded: [string, string][] = [], requests: string[] = [];
  return { recorded, requests, adapters: {
    store: { async record(address: string, reason: string) { recorded.push([address, reason]); } },
    fetch: async (url: string, init: RequestInit) => {
      requests.push(url); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
      return url === certificateUrl ? new Response(snsTestCertificate) : new Response('<ConfirmSubscriptionResponse/>');
    },
  } };
}
const post = (body: string, headers: Record<string, string> = {}) => new Request('https://discover.example' + sesFeedbackPath, { method: 'POST', body, headers: { 'content-type': 'text/plain; charset=UTF-8', 'x-amz-sns-message-type': 'Notification', ...headers } });

test('the SES feedback route exists only for the ses transport with valid topic ARNs', async () => {
  assert.equal(sesFeedbackTopics(ses), null);
  assert.equal(sesFeedbackTopics({ ...feedbackEnv, EMAIL_TRANSPORT: 'smtp' }), null);
  assert.equal(sesFeedbackTopics({ ...feedbackEnv, EMAIL_SES_SNS_TOPIC_ARNS: 'https://sns.us-east-1.amazonaws.com/' }), null);
  assert.deepEqual(sesFeedbackTopics({ ...feedbackEnv, EMAIL_SES_SNS_TOPIC_ARNS: `${topic}, ${topic}` }), [topic]);
  const { adapters, requests } = harness();
  assert.equal((await handleSesFeedback(post(notification(bounce('Permanent', 'General', [{ emailAddress: 'gone@example.com' }]))), ses, adapters)).status, 404);
  assert.deepEqual(requests, []);
});

test('verified hard bounces and complaints are recorded; transient, undetermined, policy and not-spam feedback never block', async () => {
  const { adapters, recorded, requests } = harness();
  const cases: [unknown, [string, string][]][] = [
    [bounce('Permanent', 'General', [{ emailAddress: 'gone@example.com', status: '5.1.1', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }]), [['gone@example.com', 'permanent-bounce']]],
    [bounce('Permanent', 'NoEmail', [{ emailAddress: 'none@example.com' }]), [['none@example.com', 'permanent-bounce']]],
    [complaint('abuse'), [['complainer@example.com', 'complaint']]],
    [complaint(), [['complainer@example.com', 'complaint']]],
    [bounce('Transient', 'MailboxFull', [{ emailAddress: 'full@example.com', status: '4.2.2' }]), []],
    [bounce('Transient', 'General', [{ emailAddress: 'full@example.com', status: '4.4.7' }]), []],
    [bounce('Undetermined', 'Undetermined', [{ emailAddress: 'unknown@example.com' }]), []],
    [bounce('Permanent', 'General', [{ emailAddress: 'policy@example.com', status: '5.7.1', diagnosticCode: 'smtp; 550 5.7.1 rejected by policy' }]), []],
    [bounce('Permanent', 'OnAccountSuppressionList', [{ emailAddress: 'listed@example.com' }]), []],
    [complaint('not-spam'), []],
    [{ notificationType: 'Delivery', mail, delivery: { recipients: ['ok@example.com'] } }, []],
  ];
  for (const [event, expected] of cases) {
    recorded.length = 0;
    const response = await handleSesFeedback(post(notification(event)), feedbackEnv, adapters);
    assert.equal(response.status, 200); assert.deepEqual(recorded, expected, JSON.stringify(event));
  }
  assert.ok(requests.every(url => url === certificateUrl), 'Only the signing certificate is fetched, from the constant SNS origin.');
  assert.ok(requests.length <= 1, 'The certificate is cached per process.');
});

test('nothing is trusted before verification: bad signature, other topic, stale or unsigned bodies are refused without a write', async t => {
  const { adapters, recorded } = harness();
  const valid = JSON.parse(notification(bounce('Permanent', 'General', [{ emailAddress: 'gone@example.com' }])));
  const logged: string[] = [], warn = console.warn;
  console.warn = (line: string) => { logged.push(line); };
  t.after(() => { console.warn = warn; });
  const refused: [string, string][] = [
    [JSON.stringify({ ...valid, Message: valid.Message.replace('gone@', 'victim@') }), 'signature'],
    [JSON.stringify({ ...valid, SignatureVersion: '1' }), 'unsupported-signature-version'],
    [JSON.stringify({ ...valid, SigningCertURL: 'https://attacker.example/SimpleNotificationService-test.pem' }), 'certificate-url'],
    [JSON.stringify({ ...valid, TopicArn: 'arn:aws:sns:us-east-1:123456789012:other' }), 'topic'],
    [JSON.stringify({ ...valid, Timestamp: '2020-01-01T00:00:00.000Z' }), 'stale'],
    ['{"Type":"Notification"', 'malformed'],
  ];
  for (const [body, reason] of refused) {
    const response = await handleSesFeedback(post(body), feedbackEnv, adapters);
    assert.equal(response.status, 403, reason);
    assert.deepEqual(await response.json(), { error: 'Notification refused.' }, 'A generic body: no reason, topic or address is returned.');
  }
  assert.deepEqual(logged.splice(0), refused.map(([, reason]) => `SES feedback refused: ${reason}.`), 'Only the fixed reason code is logged.');
  assert.deepEqual(recorded, []);
});

test('the route is bounded and credential-free: POST only, no query, no Authorization/API key, bounded body', async () => {
  const { adapters, recorded, requests } = harness();
  const body = notification(bounce('Permanent', 'General', [{ emailAddress: 'gone@example.com' }]));
  assert.equal((await handleSesFeedback(new Request('https://discover.example' + sesFeedbackPath), feedbackEnv, adapters)).status, 405);
  assert.equal((await handleSesFeedback(new Request('https://discover.example' + sesFeedbackPath + '?x=1', { method: 'POST', body }), feedbackEnv, adapters)).status, 400);
  assert.equal((await handleSesFeedback(post(body, { authorization: 'Bearer token' }), feedbackEnv, adapters)).status, 403);
  assert.equal((await handleSesFeedback(post(body, { 'x-api-key': 'key' }), feedbackEnv, adapters)).status, 403);
  assert.equal((await handleSesFeedback(post(body, { 'content-length': '262145' }), feedbackEnv, adapters)).status, 413);
  assert.equal((await handleSesFeedback(post(' '.repeat(262_145)), feedbackEnv, adapters)).status, 400);
  assert.deepEqual(recorded, []); assert.deepEqual(requests, []);
});

test('a verified subscription confirmation is confirmed only on the constant SNS origin; a failed confirmation asks SNS to retry', async () => {
  const { adapters, requests, recorded } = harness();
  const subscribeUrl = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topic)}&Token=synthetic-token`;
  const body = signed('SubscriptionConfirmation', { Message: 'You have chosen to subscribe.', SubscribeURL: subscribeUrl, Token: 'synthetic-token' });
  const response = await handleSesFeedback(post(body, { 'x-amz-sns-message-type': 'SubscriptionConfirmation' }), feedbackEnv, adapters);
  assert.equal(response.status, 200);
  const confirmations = requests.filter(url => url !== certificateUrl);
  assert.equal(confirmations.length, 1); assert.ok(confirmations[0].startsWith('https://sns.us-east-1.amazonaws.com/?'));
  assert.equal(new URL(confirmations[0]).searchParams.get('Action'), 'ConfirmSubscription');
  const failing = { ...adapters, fetch: async (url: string, init: RequestInit) => url === certificateUrl ? adapters.fetch(url, init) : new Response('', { status: 500 }) };
  const retry = signed('SubscriptionConfirmation', { Message: 'You have chosen to subscribe.', SubscribeURL: subscribeUrl, Token: 'synthetic-token' });
  assert.equal((await handleSesFeedback(post(retry), feedbackEnv, failing)).status, 503);
  assert.deepEqual(recorded, []);
});

/** A per-minute budget like api.ts limit(): each call spends one unit and answers false once exhausted. */
const budget = (maximum: number) => { let used = 0; return { spend: async () => ++used <= maximum, get used() { return used; } }; };

test('forged traffic exhausting the unverified budget cannot starve a validly signed delivery or drive certificate fetches', async t => {
  const warn = console.warn; console.warn = () => undefined; t.after(() => { console.warn = warn; });
  const { adapters, recorded, requests } = harness();
  const unverified = budget(3), verified = budget(600);
  const admitted = { ...adapters, admission: { unverified: unverified.spend, verified: verified.spend } };
  const deliver = (address: string) => handleSesFeedback(post(notification(bounce('Permanent', 'General', [{ emailAddress: address }]))), feedbackEnv, admitted);
  assert.equal((await deliver('first@example.com')).status, 200, 'SNS has delivered before, so its certificate is cached.');
  const valid = JSON.parse(notification(bounce('Permanent', 'General', [{ emailAddress: 'gone@example.com' }])));
  for (let index = 0; index < 50; index++) {
    // Half forge the signature on the cached certificate; half name fresh certificate URLs on the SNS origin.
    const forged = index % 2 ? { ...valid, Message: valid.Message.replace('gone@', `victim${index}@`) } : { ...valid, SigningCertURL: `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-forged${index}.pem` };
    assert.ok([403, 503].includes((await handleSesFeedback(post(JSON.stringify(forged)), feedbackEnv, admitted)).status));
  }
  assert.ok(unverified.used >= 50, 'Every forged request spent the unverified budget.');
  assert.ok(requests.filter(url => url.includes('forged')).length <= 3, 'An exhausted unverified budget stops new certificate fetches.');
  assert.equal(verified.used, 1, 'Forged traffic never spends the verified budget.');
  const response = await deliver('after-flood@example.com');
  assert.equal(response.status, 200);
  assert.deepEqual(recorded, [['first@example.com', 'permanent-bounce'], ['after-flood@example.com', 'permanent-bounce']]);
  assert.equal(verified.used, 2);
});

test('verified deliveries over their own budget are deferred to an SNS retry, and a redelivered MessageId is processed once', async () => {
  const { adapters, recorded } = harness();
  const body = notification(bounce('Permanent', 'General', [{ emailAddress: 'once@example.com' }]));
  assert.equal((await handleSesFeedback(post(body), feedbackEnv, { ...adapters, admission: { unverified: async () => true, verified: async () => false } })).status, 503);
  assert.deepEqual(recorded, [], 'A deferred delivery is not recorded or remembered.');
  assert.equal((await handleSesFeedback(post(body), feedbackEnv, adapters)).status, 200);
  assert.deepEqual(await (await handleSesFeedback(post(body), feedbackEnv, adapters)).json(), { ok: true });
  assert.deepEqual(recorded, [['once@example.com', 'permanent-bounce']]);
});

test('a failed certificate fetch is not retried for a minute', async t => {
  const warn = console.warn; console.warn = () => undefined; t.after(() => { console.warn = warn; });
  let fetches = 0;
  const failing = { fetch: async () => { fetches++; return new Response('', { status: 404 }); }, store: { async record() { assert.fail('Nothing is recorded.'); } } };
  const body = JSON.stringify({ ...JSON.parse(notification(bounce('Permanent', 'General', [{ emailAddress: 'gone@example.com' }]))), SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-missing.pem' });
  for (let index = 0; index < 5; index++) assert.equal((await handleSesFeedback(post(body), feedbackEnv, failing)).status, 503);
  assert.equal(fetches, 1);
});
