import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { EmailDeliveryError, getEmailStatus, sendTransactionalEmail, withEmailTransportsForTests } from '../src/server/email.ts';
import { secret } from '../src/server/config.ts';

const smtp = { EMAIL_TRANSPORT: 'smtp', EMAIL_FROM: 'sender@example.com', EMAIL_SMTP_HOST: 'smtp.example.com', EMAIL_SMTP_USER: 'login', EMAIL_SMTP_PASSWORD: 'short-password' };
const cloudflare = { EMAIL_TRANSPORT: 'cloudflare', EMAIL_FROM: 'sender@example.com', EMAIL_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), EMAIL_CLOUDFLARE_API_TOKEN: 'test-token' };
const message = { to: 'recipient@example.com', subject: 'Reset your password', text: 'Use this link once:\nhttps://app.example.com/reset?token=private-token' };
const receipt = (delivered: string[] = [], queued = [message.to], permanent_bounces: string[] = [], suppressed_recipients: string[] = []) => ({ success: true, errors: [], messages: [], result: { delivered, queued, permanent_bounces, suppressed_recipients } });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('mail readiness is configuration only; disabled and malformed optional config never break unrelated configuration', async () => {
  assert.deepEqual(getEmailStatus({}), { configured: false, transport: 'disabled' });
  assert.deepEqual(getEmailStatus(smtp), { configured: true, transport: 'smtp' });
  assert.deepEqual(getEmailStatus(cloudflare), { configured: true, transport: 'cloudflare' });
  for (const env of [{ EMAIL_TRANSPORT: 'other' }, { ...smtp, EMAIL_SMTP_TLS: 'plaintext' }, { ...smtp, EMAIL_SMTP_HOST: 'https://smtp.example.com' }, { ...smtp, EMAIL_SMTP_HOST: '127.0.0.1' }, { ...smtp, EMAIL_SMTP_PASSWORD: '' }, { ...smtp, EMAIL_FROM: 'Name <sender@example.com>' }, { ...cloudflare, EMAIL_CLOUDFLARE_ACCOUNT_ID: 'wrong' }]) assert.deepEqual(getEmailStatus(env), { configured: false, transport: 'disabled' });
  await assert.rejects(sendTransactionalEmail(message, {}), EmailDeliveryError);
});

test('mail env-or-FILE reuses exclusive secret loading without imposing or relaxing the existing32-character auth minimum', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ten98-email-pure-')), file = join(directory, 'synthetic-password');
  try {
    writeFileSync(file, 'short-password\n');
    assert.equal(getEmailStatus({ ...smtp, EMAIL_SMTP_PASSWORD: '', EMAIL_SMTP_PASSWORD_FILE: file }).configured, true);
    assert.equal(getEmailStatus({ ...smtp, EMAIL_SMTP_PASSWORD_FILE: file }).configured, false);
    assert.equal(getEmailStatus({ ...smtp, EMAIL_SMTP_PASSWORD: '', EMAIL_SMTP_PASSWORD_FILE: join(directory, 'absent') }).configured, false);
    assert.throws(() => secret('AUTH_SECRET', { AUTH_SECRET: 'x'.repeat(31) }));
    assert.equal(secret('AUTH_SECRET', { AUTH_SECRET: 'x'.repeat(32) }), 'x'.repeat(32));
    assert.throws(() => secret('AUTH_SECRET', { AUTH_SECRET: 'x'.repeat(32), AUTH_SECRET_FILE: file }));
    writeFileSync(file, 'x'.repeat(32) + '\n'); assert.equal(secret('AUTH_SECRET', { AUTH_SECRET_FILE: file }), 'x'.repeat(32));
  } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true }); }
});

test('one bare mailbox, safe subject, complete bounded Unicode text and no extra HTML are checked before either adapter', async () => {
  let calls = 0;
  await withEmailTransportsForTests({ fetch: async () => { calls++; return json(receipt()); } }, async () => {
    for (const to of ['recipient@example.com,other@example.com', 'Name <recipient@example.com>', 'recipient@example.com\r\nBcc:other@example.com', ' recipient@example.com']) await assert.rejects(sendTransactionalEmail({ ...message, to }, cloudflare), EmailDeliveryError);
    for (const subject of ['', 'x\r\nBcc:other@example.com', 'bad\0subject', 'bad\u2028subject', 'bad\u202esubject', 'x'.repeat(201), '\ud800']) await assert.rejects(sendTransactionalEmail({ ...message, subject }, cloudflare), EmailDeliveryError);
    for (const text of ['', '\udfff', 'bad\0text', '😀'.repeat(16_385)]) await assert.rejects(sendTransactionalEmail({ ...message, text }, cloudflare), EmailDeliveryError);
    // @ts-expect-error An untrusted caller cannot add a raw HTML source.
    await assert.rejects(sendTransactionalEmail({ ...message, html: '<img src="https://outside.example/">' }, cloudflare), EmailDeliveryError);
  });
  assert.equal(calls, 0);
});

test('Cloudflare sends one fixed credential-isolated request and escapes the default HTML without rewriting text or case', async () => {
  let calls = 0;
  const text = '<script>"private" & \'link\'</script>\n😀';
  const accepted = await withEmailTransportsForTests({ fetch: async (url, init) => {
    calls++; assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/email/sending/send');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(init.headers, { authorization: 'Bearer test-token', 'content-type': 'application/json', accept: 'application/json' });
    assert.deepEqual(JSON.parse(String(init.body)), { from: 'sender@example.com', to: [message.to], subject: '😀', text, html: '<div>&lt;script&gt;&quot;private&quot; &amp; &#39;link&#39;&lt;/script&gt;<br>😀</div>' });
    return json(receipt());
  } }, () => sendTransactionalEmail({ ...message, subject: '😀', text }, cloudflare));
  assert.deepEqual(accepted, { accepted: true, delivery: 'unconfirmed' }); assert.equal(calls, 1);
});

test('Cloudflare requires the sole reported recipient and distinguishes queued from provider-reported delivery', async () => {
  assert.deepEqual(await withEmailTransportsForTests({ fetch: async () => json(receipt([message.to], [])) }, () => sendTransactionalEmail(message, cloudflare)), { accepted: true, delivery: 'provider-reported-delivered' });
  // @ten98/runtime sendCloudflareEmail: recipients match case-insensitively, and neither an empty errors array nor the JSON
  // content type is part of the receipt contract. Queued stays unconfirmed.
  for (const [reply, delivery] of [[receipt(['RECIPIENT@Example.com'], []), 'provider-reported-delivered'], [receipt([], ['Recipient@EXAMPLE.com']), 'unconfirmed'], [{ ...receipt(), errors: [{ message: message.text }] }, 'unconfirmed']] as const) {
    assert.deepEqual(await withEmailTransportsForTests({ fetch: async () => json(reply) }, () => sendTransactionalEmail(message, cloudflare)), { accepted: true, delivery }, JSON.stringify(reply));
  }
  assert.deepEqual(await withEmailTransportsForTests({ fetch: async () => new Response(JSON.stringify(receipt()), { headers: { 'content-type': 'text/html' } }) }, () => sendTransactionalEmail(message, cloudflare)), { accepted: true, delivery: 'unconfirmed' });
  for (const reply of [receipt([], []), receipt(['other@example.com'], []), receipt([message.to], [message.to]), receipt([], [message.to], [message.to]), receipt([], [], [message.to]), receipt([], [], [], [message.to]), receipt([], [message.to], [], [message.to]), receipt([], [message.to, message.to]), { ...receipt(), success: false }, { ...receipt(), result: null }, { ...receipt(), result: { ...receipt().result, message_id: 'bad id' } }]) await assert.rejects(withEmailTransportsForTests({ fetch: async () => json(reply) }, () => sendTransactionalEmail(message, cloudflare)), { name: 'EmailDeliveryError', message: 'Email acceptance could not be confirmed. No automatic retry was made.' });
});

test('Cloudflare whole response is fatal UTF8/JSON and bounded to 64KiB; status, shape and transport errors never leak provider content', async () => {
  let calls = 0;
  for (const response of [new Response('private-token\n' + message.to, { status: 403 }), new Response('{bad}', { headers: { 'content-type': 'application/json' } }), new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }), new Response(JSON.stringify(receipt()) + ' '.repeat(65_536), { headers: { 'content-type': 'application/json' } }), new Response(JSON.stringify({ success: false, errors: [{ code: 10001, message: message.text }] }), { status: 400, headers: { 'content-type': 'application/json' } }), new Response('', { status: 429 }), new Response('', { status: 500 }), new Response('', { status: 302, headers: { location: 'https://outside.example' } })]) await assert.rejects(withEmailTransportsForTests({ fetch: async () => { calls++; return response; } }, () => sendTransactionalEmail(message, cloudflare)), { name: 'EmailDeliveryError', message: 'Email acceptance could not be confirmed. No automatic retry was made.' });
  assert.equal(calls, 8);
  await assert.rejects(withEmailTransportsForTests({ fetch: async () => { throw Error('Bearer private-token ' + message.text); } }, () => sendTransactionalEmail(message, cloudflare)), { name: 'EmailDeliveryError', message: 'Email acceptance could not be confirmed. No automatic retry was made.' });
});

test('SMTP uses one fresh owned socket, requiredSTARTTLS or verified implicitTLS and exact envelope acceptance without delivery claims', async () => {
  let calls = 0, closes = 0;
  for (const tls of ['starttls', 'tls']) {
    let ownedSocket: import('node:net').Socket | undefined;
    const result = await withEmailTransportsForTests({ smtp(options) {
      calls++; ownedSocket = options.socket; assert.ok(ownedSocket); assert.equal(ownedSocket.destroyed, false);
      assert.equal(options.host, 'smtp.example.com'); assert.equal(options.port, tls === 'tls' ? 465 : 587); assert.equal(options.secure, tls === 'tls');
      assert.equal(options.requireTLS, true); assert.equal(options.ignoreTLS, false); assert.equal(options.opportunisticTLS, false);
      assert.equal(options.forceAuth, true);
      assert.deepEqual(options.tls, { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp.example.com' });
      assert.deepEqual(options.auth, { user: 'login', pass: 'short-password' });
      assert.equal(options.connectionTimeout, 5000); assert.equal(options.greetingTimeout, 5000); assert.equal(options.dnsTimeout, 5000); assert.equal(options.socketTimeout, 10_000); assert.equal(options.maxResponseSize, 16_384);
      assert.equal(options.logger, false); assert.equal(options.debug, false); assert.equal(options.transactionLog, false); assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true); assert.equal(options.maxRecipients, 1);
      return { async sendMail(mail) { assert.equal(mail.to, message.to); assert.equal(mail.from, 'sender@example.com'); assert.equal(mail.text, message.text); return { accepted: [message.to], rejected: [] }; }, close() { closes++; } };
    } }, () => sendTransactionalEmail(message, { ...smtp, EMAIL_SMTP_TLS: tls }));
    assert.deepEqual(result, { accepted: true, delivery: 'unconfirmed' }); assert.equal(ownedSocket?.destroyed, true);
  }
  assert.equal(calls, 2); assert.equal(closes, 2);
});

test('SMTP rejected, mismatched or unknown acceptance remains one uncertain attempt and always closes its sender and socket', async () => {
  let calls = 0, closes = 0;
  for (const reply of [{ accepted: [], rejected: [] }, { accepted: ['other@example.com'], rejected: [] }, { accepted: [message.to], rejected: [message.to] }, { accepted: [message.to], rejected: [], pending: [message.to] }, null]) {
    let ownedSocket: import('node:net').Socket | undefined;
    await assert.rejects(withEmailTransportsForTests({ smtp(options) { calls++; ownedSocket = options.socket; return { async sendMail() { return reply; }, close() { closes++; } }; } }, () => sendTransactionalEmail(message, smtp)), EmailDeliveryError);
    assert.equal(ownedSocket?.destroyed, true);
  }
  let failedSocket: import('node:net').Socket | undefined;
  await assert.rejects(withEmailTransportsForTests({ smtp(options) { calls++; failedSocket = options.socket; return { async sendMail() { throw Error(message.text); }, close() { closes++; } }; } }, () => sendTransactionalEmail(message, smtp)), { name: 'EmailDeliveryError', message: 'Email acceptance could not be confirmed. No automatic retry was made.' });
  assert.equal(failedSocket?.destroyed, true); assert.equal(calls, 6); assert.equal(closes, 6);
});

test('SMTP absolute15-second deadline destroys only the owned socket and closes once with no resend', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0, closes = 0, ownedSocket: import('node:net').Socket | undefined, rejectLate: ((reason: Error) => void) | undefined;
  const pending = withEmailTransportsForTests({ smtp(options) { calls++; ownedSocket = options.socket; return { sendMail: () => new Promise((_, reject) => { rejectLate = reject; }), close() { closes++; } }; } }, () => sendTransactionalEmail(message, smtp));
  assert.equal(calls, 1); context.mock.timers.tick(15_000); await assert.rejects(pending, EmailDeliveryError);
  assert.equal(ownedSocket?.destroyed, true); assert.equal(closes, 1); assert.equal(calls, 1);
  const closedSocket = ownedSocket; assert.ok(closedSocket);
  const lateDnsCallback = () => closedSocket.connect(587, 'smtp.example.com');
  assert.throws(lateDnsCallback, EmailDeliveryError, 'The late callback cannot revive/dial the destroyed owned socket.');
  assert.ok(rejectLate); rejectLate(Error('Late private-token provider rejection'));
  await new Promise<void>(resolve => setImmediate(resolve)); // An unhandled late rejection fails the native test runner.
  assert.equal(calls, 1); assert.equal(closes, 1);
});

test('Cloudflare absolute deadline also covers a stalled response body and cancels its reader without a retry', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0, cancelled = 0;
  const response = new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } });
  const pending = withEmailTransportsForTests({ fetch: async () => { calls++; return response; } }, () => sendTransactionalEmail(message, cloudflare));
  for (let turn = 0; turn < 20 && !response.body?.locked; turn++) await Promise.resolve();
  assert.equal(response.body?.locked, true); context.mock.timers.tick(15_000); await assert.rejects(pending, EmailDeliveryError);
  assert.equal(cancelled, 1); assert.equal(calls, 1);
});
