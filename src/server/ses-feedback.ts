import { classifyEmailFeedback, readResponseText, verifySnsMessage, type EmailFeedbackOutcome } from '@ten98/runtime';
import { recordEmailSuppression, type EmailSuppressionReason } from './email-suppression.ts';

/**
 * Public Amazon SNS endpoint for SES bounce and complaint notifications (#304). It is matched before any session or API key
 * lookup and trusts nothing until @ten98/runtime has verified the SNS signature, signing-certificate origin, topic and age.
 * Only hard bounces and complaints are recorded; transient and undetermined bounces never block a transactional send.
 */
export const sesFeedbackPath = '/api/email/ses-feedback';
// SES notifications are a few KiB; the runtime refuses anything over 1 MiB in any case.
const maxBodyBytes = 262_144;
const certificateBytes = 16_384;
const blocking = new Set<EmailFeedbackOutcome['reason']>(['permanent-bounce', 'complaint']);
const topicArn = /^arn:aws(?:-us-gov)?:sns:[a-z]{2}(?:-gov)?-[a-z]+-\d:\d{12}:[A-Za-z0-9_-]{1,256}$/;

type Store = { record(address: string, reason: EmailSuppressionReason): Promise<void> };
export type SesFeedbackAdapters = { fetch?: (url: string, init: RequestInit) => Promise<Response>; store?: Store };

/** Enabled only with EMAIL_TRANSPORT=ses and at least one subscribed topic ARN; otherwise the route does not exist. */
export function sesFeedbackTopics(env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (env.EMAIL_TRANSPORT !== 'ses' || !env.EMAIL_SES_SNS_TOPIC_ARNS?.trim()) return null;
  const topics = env.EMAIL_SES_SNS_TOPIC_ARNS.split(',').map(value => value.trim());
  return topics.length <= 8 && topics.every(value => topicArn.test(value)) ? [...new Set(topics)] : null;
}

// Signing certificates rotate rarely; a small per-process cache keeps notification bursts from refetching them.
const certificates = new Map<string, string>();
async function fetchBounded(send: NonNullable<SesFeedbackAdapters['fetch']>, url: string): Promise<string> {
  const signal = AbortSignal.timeout(5000);
  const response = await send(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal });
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error('SNS request failed.'); }
  return readResponseText(response, { maxBytes: certificateBytes, signal });
}

function reply(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** Never logs or echoes the body, addresses, certificate or SNS URLs. */
export async function handleSesFeedback(request: Request, env: NodeJS.ProcessEnv = process.env, adapters: SesFeedbackAdapters = {}): Promise<Response> {
  const topics = sesFeedbackTopics(env);
  if (!topics) return reply(404, { error: 'Not found.' });
  if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' }, { allow: 'POST' });
  if (new URL(request.url).search) return reply(400, { error: 'Query parameters are not accepted.' });
  if (request.headers.has('authorization') || request.headers.has('x-api-key')) return reply(403, { error: 'Credentials are not accepted here.' });
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,9}$/.test(declared.trim()) || Number(declared.trim()) > maxBodyBytes)) return reply(413, { error: 'Body too large.' });
  let raw: string;
  try { raw = await readResponseText(new Response(request.body), { maxBytes: maxBodyBytes }); }
  catch { return reply(400, { error: 'Unreadable body.' }); }

  const send = adapters.fetch ?? fetch;
  let verified: Awaited<ReturnType<typeof verifySnsMessage>>;
  // SNS_CONFIG (a topic region outside the runtime's SNS allowlist) is an operator error, never a verified message.
  try { verified = await verifySnsMessage(raw, {
    // arn:<partition>:sns:<region>:<account>:<topic>; the runtime also requires the certificate origin to match the topic's region.
    allowedRegions: [...new Set(topics.map(topic => topic.split(':')[3]))], topicArns: topics,
    async fetchCertificate(url) {
      const cached = certificates.get(url);
      if (cached) return cached;
      const pem = await fetchBounded(send, url);
      if (certificates.size >= 16) certificates.clear();
      certificates.set(url, pem);
      return pem;
    },
  }); } catch { return reply(503, { error: 'SES feedback is not configured correctly.' }); }
  if (!verified.ok) return reply(403, { error: 'Notification refused.', reason: verified.reason });
  if (verified.duplicate) return reply(200, { ok: true });

  if (verified.type === 'SubscriptionConfirmation') {
    // The runtime rebuilt this URL on the constant SNS origin for an allowlisted topic, so confirming reaches only AWS SNS.
    try { await fetchBounded(send, verified.subscribeUrl!); }
    catch { return reply(503, { error: 'Subscription confirmation failed. SNS will retry.' }); }
    return reply(200, { ok: true });
  }
  if (verified.type !== 'Notification') return reply(200, { ok: true });

  // #304: transient and undetermined bounces never block, so no history is kept and the repeat threshold is unreachable.
  const outcomes = classifyEmailFeedback(verified.message, { transient: { threshold: Number.MAX_SAFE_INTEGER, windowMs: 1 } });
  const store = adapters.store ?? { record: recordEmailSuppression };
  let recorded = 0;
  for (const outcome of outcomes) {
    if (outcome.action !== 'suppress' || !blocking.has(outcome.reason)) continue;
    await store.record(outcome.recipient, outcome.reason as EmailSuppressionReason);
    recorded++;
  }
  return reply(200, { ok: true, recorded });
}
