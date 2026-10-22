import { classifyEmailFeedback, readResponseText, verifySnsMessage, type EmailFeedbackOutcome, type SnsVerification } from '@ten98/runtime';
import { recordEmailSuppression, type EmailSuppressionReason } from './email-suppression.ts';

/**
 * Public Amazon SNS endpoint for SES bounce and complaint notifications (#304). It is matched before any session or API key
 * lookup and trusts nothing until @ten98/runtime has verified the SNS signature, signing-certificate origin, topic and age.
 * Only hard bounces and complaints are recorded; transient and undetermined bounces never block a transactional send.
 *
 * Admission has two budgets so forged traffic cannot starve real deliveries: unverified work (uncached certificate fetches
 * and refused messages) spends a small bucket, and a full bucket only stops new certificate fetches; verified deliveries
 * spend their own budget after verification. A message signed with an already-cached certificate is never refused by the
 * unverified bucket.
 */
export const sesFeedbackPath = '/api/email/ses-feedback';
// SES notifications are a few KiB; the runtime refuses anything over 1 MiB in any case.
const maxBodyBytes = 262_144;
const bodyReadMs = 10_000;
const certificateBytes = 16_384;
const failedCertificateMs = 60_000;
const blocking = new Set<EmailFeedbackOutcome['reason']>(['permanent-bounce', 'complaint']);
const topicArn = /^arn:aws(?:-us-gov)?:sns:[a-z]{2}(?:-gov)?-[a-z]+-\d:\d{12}:[A-Za-z0-9_-]{1,256}$/;

type Store = { record(address: string, reason: EmailSuppressionReason): Promise<void> };
/** Each call spends one unit of that budget and resolves false once it is exhausted. */
export type SesFeedbackAdmission = { unverified(): Promise<boolean>; verified(): Promise<boolean> };
export type SesFeedbackAdapters = { fetch?: (url: string, init: RequestInit) => Promise<Response>; store?: Store; admission?: SesFeedbackAdmission };
const unlimited: SesFeedbackAdmission = { unverified: async () => true, verified: async () => true };

/** Enabled only with EMAIL_TRANSPORT=ses and at least one subscribed topic ARN; otherwise the route does not exist. */
export function sesFeedbackTopics(env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (env.EMAIL_TRANSPORT !== 'ses' || !env.EMAIL_SES_SNS_TOPIC_ARNS?.trim()) return null;
  const topics = env.EMAIL_SES_SNS_TOPIC_ARNS.split(',').map(value => value.trim());
  return topics.length <= 8 && topics.every(value => topicArn.test(value)) ? [...new Set(topics)] : null;
}

// Per-process state, all bounded. Signing certificates rotate rarely, so bursts reuse them; a failed fetch is not retried
// for a minute, so forged certificate URLs cannot drive repeated AWS requests.
const certificates = new Map<string, string>();
const failedCertificates = new Map<string, number>();
// SNS delivers at least once. Recording is idempotent anyway; this skips the classifier and store for recent redeliveries.
const recentMessages = new Set<string>();
function remember(messageId: string) {
  recentMessages.delete(messageId); recentMessages.add(messageId);
  if (recentMessages.size > 1024) recentMessages.delete(recentMessages.values().next().value!);
}

async function fetchBounded(send: NonNullable<SesFeedbackAdapters['fetch']>, url: string): Promise<string> {
  const signal = AbortSignal.timeout(5000);
  const response = await send(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal });
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error('SNS request failed.'); }
  return readResponseText(response, { maxBytes: certificateBytes, signal });
}

function reply(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** Never logs or echoes the body, addresses, certificate or SNS URLs; a refusal logs only the runtime's fixed reason code. */
export async function handleSesFeedback(request: Request, env: NodeJS.ProcessEnv = process.env, adapters: SesFeedbackAdapters = {}): Promise<Response> {
  const topics = sesFeedbackTopics(env);
  if (!topics) return reply(404, { error: 'Not found.' });
  if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' }, { allow: 'POST' });
  if (new URL(request.url).search) return reply(400, { error: 'Query parameters are not accepted.' });
  if (request.headers.has('authorization') || request.headers.has('x-api-key')) return reply(403, { error: 'Credentials are not accepted here.' });
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,9}$/.test(declared.trim()) || Number(declared.trim()) > maxBodyBytes)) return reply(413, { error: 'Body too large.' });
  let raw: string;
  try { raw = await readResponseText(new Response(request.body), { maxBytes: maxBodyBytes, signal: AbortSignal.timeout(bodyReadMs) }); }
  catch { return reply(400, { error: 'Unreadable body.' }); }

  const send = adapters.fetch ?? fetch, admission = adapters.admission ?? unlimited;
  let verified: SnsVerification;
  // SNS_CONFIG (a topic region outside the runtime's SNS allowlist) is an operator error, never a verified message.
  try {
    verified = await verifySnsMessage(raw, {
      // arn:<partition>:sns:<region>:<account>:<topic>; the runtime also requires the certificate origin to match the topic's region.
      allowedRegions: [...new Set(topics.map(topic => topic.split(':')[3]))], topicArns: topics,
      async fetchCertificate(url) {
        const cached = certificates.get(url);
        if (cached) return cached;
        if ((failedCertificates.get(url) ?? 0) > Date.now()) throw new Error('Recently failed.');
        if (!await admission.unverified()) throw new Error('Unverified budget exhausted.');
        try {
          const pem = await fetchBounded(send, url);
          if (certificates.size >= 16) certificates.clear();
          certificates.set(url, pem);
          return pem;
        } catch (error) {
          if (failedCertificates.size >= 256) failedCertificates.clear();
          failedCertificates.set(url, Date.now() + failedCertificateMs);
          throw error;
        }
      },
      isDuplicate: messageId => recentMessages.has(messageId),
    });
  } catch { return reply(503, { error: 'SES feedback is not configured correctly.' }); }
  if (!verified.ok) {
    console.warn(`SES feedback refused: ${verified.reason}.`);
    // An unavailable certificate may be a genuine delivery during an outage or a full unverified budget: SNS retries a 5xx.
    if (verified.reason === 'certificate-unavailable') return reply(503, { error: 'Notification not verified yet. SNS will retry.' });
    await admission.unverified();
    return reply(403, { error: 'Notification refused.' });
  }
  if (verified.duplicate) return reply(200, { ok: true });
  if (!await admission.verified()) return reply(503, { error: 'Busy. SNS will retry.' });

  if (verified.type === 'SubscriptionConfirmation') {
    // The runtime rebuilt this URL on the constant SNS origin for an allowlisted topic, so confirming reaches only AWS SNS.
    try { await fetchBounded(send, verified.subscribeUrl!); }
    catch { return reply(503, { error: 'Subscription confirmation failed. SNS will retry.' }); }
    remember(verified.messageId);
    return reply(200, { ok: true });
  }
  if (verified.type !== 'Notification') { remember(verified.messageId); return reply(200, { ok: true }); }

  // #304: transient and undetermined bounces never block, so no history is kept and the repeat threshold is unreachable.
  const outcomes = classifyEmailFeedback(verified.message, { transient: { threshold: Number.MAX_SAFE_INTEGER, windowMs: 1 } });
  const store = adapters.store ?? { record: recordEmailSuppression };
  let recorded = 0;
  for (const outcome of outcomes) {
    if (outcome.action !== 'suppress' || !blocking.has(outcome.reason)) continue;
    await store.record(outcome.recipient, outcome.reason as EmailSuppressionReason);
    recorded++;
  }
  remember(verified.messageId);
  return reply(200, { ok: true, recorded });
}
