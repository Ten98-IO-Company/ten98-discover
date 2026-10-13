import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
import { toUSVString } from 'node:util';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getConfig } from './config.ts';

const graph = 'https://graph.facebook.com/v26.0/';
const maximum = 4_194_304;
const decimalId = z.string().regex(/^[1-9][0-9]{0,39}$(?![\s\S])/);
const secret = (maximum: number) => z.string().min(1).max(maximum).regex(/^[\x21-\x7e]+$(?![\s\S])/);
const base = { appId: decimalId, appSecret: secret(512) };
const token = secret(4096);
const cursor = z.string().min(1).max(4096).refine(value => toUSVString(value) === value && !/[\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= 4096);
const report = z.enum(['account_daily', 'campaign_daily']);
const day = z.string().length(10).regex(/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$(?![\s\S])/).refine(value => {
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const commonReportFields = 'account_id,account_name,account_currency,date_start,date_stop,impressions,clicks,spend,actions,action_values';
const reportFields = { account_daily: commonReportFields, campaign_daily: commonReportFields + ',campaign_id,campaign_name' };
const input = z.discriminatedUnion('operation', [
  z.object({ ...base, operation: z.literal('exchangeCode'), code: secret(4096) }).strict(),
  z.object({ ...base, operation: z.literal('extendUserToken'), token }).strict(),
  z.object({ ...base, operation: z.literal('inspectToken'), token }).strict(),
  z.object({ ...base, operation: z.literal('permissions'), token }).strict(),
  z.object({ ...base, operation: z.literal('accounts'), token, after: cursor.optional() }).strict(),
  z.object({ ...base, operation: z.literal('account'), token, accountId: decimalId }).strict(),
  z.object({ ...base, operation: z.literal('campaigns'), token, accountId: decimalId, after: cursor.optional() }).strict(),
  z.object({ ...base, operation: z.literal('revoke'), token }).strict(),
  z.object({ ...base, operation: z.literal('submitReport'), token, accountId: decimalId, report, from: day, to: day }).strict()
    .refine(value => value.from <= value.to && Date.parse(value.to + 'T00:00:00Z') - Date.parse(value.from + 'T00:00:00Z') <= 30 * 86_400_000),
  z.object({ ...base, operation: z.literal('reportStatus'), token, reportRunId: decimalId }).strict(),
  z.object({ ...base, operation: z.literal('reportPage'), token, reportRunId: decimalId, report, after: cursor.optional() }).strict(),
]);
export type MetaRequest = z.infer<typeof input>;
export type MetaRateHints = { retryAfterSeconds: number | null; appUtilizationPercent: number | null; accountUtilizationPercent: number | null };
export type MetaResponse = { data: unknown; rate: MetaRateHints };
export type MetaFailure = 'invalid_request' | 'configuration' | 'aborted' | 'timeout' | 'invalid_response' | 'unauthorized' | 'access_denied' | 'throttled' | 'unavailable';
const emptyRate = (): MetaRateHints => ({ retryAfterSeconds: null, appUtilizationPercent: null, accountUtilizationPercent: null });
const messages: Record<MetaFailure, string> = {
  invalid_request: 'The Meta request is invalid.', configuration: 'Meta reporting requires a valid HTTPS application origin.',
  aborted: 'The Meta request was cancelled.', timeout: 'Meta did not respond within the request deadline.',
  invalid_response: 'Meta returned an unusable response.', unauthorized: 'Reconnect this Meta source to restore access.',
  access_denied: 'Meta denied access. Check the app approval and granted reporting permission.',
  throttled: 'Meta reporting is temporarily throttled. Wait before retrying.', unavailable: 'Meta is unavailable. Try again later.',
};
export class MetaRequestError extends FoundationError {
  readonly reason: MetaFailure;
  readonly retryable: boolean;
  readonly reauthorize: boolean;
  readonly providerCode: number | null;
  readonly providerSubcode: number | null;
  readonly rate: MetaRateHints;
  constructor(reason: MetaFailure, options: { retryable?: boolean; code?: number | null; subcode?: number | null; rate?: MetaRateHints } = {}) {
    super(reason === 'invalid_request' ? 400 : reason === 'configuration' ? 503 : reason === 'aborted' ? 499 : reason === 'unauthorized' || reason === 'access_denied' ? 409 : reason === 'throttled' ? 429 : 502, messages[reason]);
    this.name = 'MetaRequestError'; this.reason = reason;
    this.retryable = options.retryable ?? (reason === 'throttled' || reason === 'timeout');
    this.reauthorize = reason === 'unauthorized' || reason === 'access_denied';
    this.providerCode = options.code ?? null; this.providerSubcode = options.subcode ?? null; this.rate = options.rate ?? emptyRate();
  }
}
export type MetaTransport = (url: string, init: RequestInit) => Promise<Response>;
const fixture = new AsyncLocalStorage<MetaTransport>();
function build(raw: MetaRequest) {
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new MetaRequestError('invalid_request');
  const request = parsed.data, headers: Record<string, string> = { accept: 'application/json' };
  let origin: URL;
  try { origin = new URL(getConfig().appUrl); } catch { throw new MetaRequestError('configuration'); }
  if (origin.protocol !== 'https:' && !fixture.getStore()) throw new MetaRequestError('configuration');
  const query = new URLSearchParams(); let path: string, method = 'GET', body: string | undefined;
  switch (request.operation) {
    case 'exchangeCode':
      path = 'oauth/access_token'; query.set('client_id', request.appId); query.set('client_secret', request.appSecret);
      query.set('code', request.code); query.set('redirect_uri', origin.origin + '/api/meta/callback'); break;
    case 'extendUserToken':
      path = 'oauth/access_token'; query.set('grant_type', 'fb_exchange_token'); query.set('client_id', request.appId);
      query.set('client_secret', request.appSecret); query.set('fb_exchange_token', request.token); break;
    case 'inspectToken':
      path = 'debug_token'; query.set('input_token', request.token); query.set('access_token', request.appId + '|' + request.appSecret); break;
    default:
      headers.authorization = 'Bearer ' + request.token;
      query.set('appsecret_proof', createHmac('sha256', request.appSecret).update(request.token).digest('hex'));
      if (request.operation === 'permissions') path = 'me/permissions';
      else if (request.operation === 'revoke') { path = 'me/permissions'; method = 'DELETE'; }
      else if (request.operation === 'submitReport') {
        // Fixed read-report profile: callers cannot add filters, attribution overrides or ad mutations.
        path = 'act_' + request.accountId + '/insights'; method = 'POST';
        const form = new URLSearchParams({
          fields: reportFields[request.report], level: request.report === 'account_daily' ? 'account' : 'campaign',
          time_increment: '1', time_range: JSON.stringify({ since: request.from, until: request.to }),
          action_breakdowns: JSON.stringify(['action_type']), action_attribution_windows: JSON.stringify(['7d_click', '1d_view']),
        });
        headers['content-type'] = 'application/x-www-form-urlencoded'; body = form.toString();
      }
      else if (request.operation === 'reportStatus') {
        path = request.reportRunId; query.set('fields', 'id,account_id,async_status,async_percent_completion,date_start,date_stop');
      }
      else if (request.operation === 'reportPage') {
        path = request.reportRunId + '/insights'; query.set('fields', reportFields[request.report]); query.set('limit', '500');
        if (request.after) query.set('after', request.after);
      }
      else if (request.operation === 'campaigns') {
        path = 'act_' + request.accountId + '/campaigns';
        query.set('fields', 'id,account_id,name,status,effective_status'); query.set('limit', '100');
        query.set('effective_status', JSON.stringify(['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED', 'IN_PROCESS', 'WITH_ISSUES']));
        if (request.after) query.set('after', request.after);
      }
      else {
        path = request.operation === 'accounts' ? 'me/adaccounts' : 'act_' + request.accountId;
        query.set('fields', 'id,account_id,name,currency,timezone_name,account_status');
        if (request.operation === 'accounts') { query.set('limit', '100'); if (request.after) query.set('after', request.after); }
      }
  }
  return { url: graph + path + '?' + query.toString(), method, headers, body };
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function rateHints(headers: Headers): MetaRateHints {
  const result = emptyRate(), retry = headers.get('retry-after');
  if (retry && retry.length <= 128) {
    if (/^[0-9]+$(?![\s\S])/.test(retry)) { const n = Number(retry); if (Number.isSafeInteger(n) && n <= 86_400) result.retryAfterSeconds = n; }
    else {
      const date = new Date(retry);
      // Native round-trip rejects permissive Date.parse normalization and wrong weekdays.
      if (date.toUTCString() === retry) { const seconds = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000)); if (seconds <= 86_400) result.retryAfterSeconds = seconds; }
    }
  }
  const raw = headers.get('x-fb-ads-insights-throttle');
  if (raw && raw.length <= 2048) try {
    const data: unknown = JSON.parse(raw);
    if (object(data)) {
      const percent = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000 ? n : null;
      result.appUtilizationPercent = percent(data.app_id_util_pct); result.accountUtilizationPercent = percent(data.acc_id_util_pct);
    }
  } catch { /* A malformed usage hint cannot change report authority or invalidate valid data. */ }
  return result;
}
const idKeys = new Set(['id', 'account_id', 'app_id', 'user_id', 'report_run_id', 'campaign_id']);
function parseJson(text: string): unknown {
  let nodes = 0;
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (++nodes > 100_000 || ['__proto__', 'prototype', 'constructor'].includes(key) || toUSVString(key) !== key || key.includes('\0')) throw new MetaRequestError('invalid_response');
    if (typeof value === 'string' && (toUSVString(value) !== value || value.includes('\0'))) throw new MetaRequestError('invalid_response');
    if (idKeys.has(key) && typeof value === 'number') {
      // Node24 supplies the original JSON lexeme even when the number value rounded.
      if (!context?.source || !decimalId.safeParse(context.source).success) throw new MetaRequestError('invalid_response');
      return context.source;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new MetaRequestError('invalid_response');
    return value;
  });
}
function providerFailure(status: number, data: unknown, rate: MetaRateHints): MetaRequestError | null {
  const hasError = object(data) && Object.hasOwn(data, 'error');
  if (status >= 200 && status < 300 && !hasError) return null;
  const error = hasError && object(data.error) ? data.error : {};
  const integer = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
  const code = integer(error.code), subcode = integer(error.error_subcode), options = { code, subcode, rate };
  if (status === 401 || code === 190) return new MetaRequestError('unauthorized', options);
  if (status === 403 || code === 200) return new MetaRequestError('access_denied', options);
  if (status === 429 || code === 4 || code === 613) return new MetaRequestError('throttled', options);
  return new MetaRequestError('unavailable', { ...options, retryable: status >= 500 && status <= 599 });
}

/** One bounded attempt; this module never logs requests, retries, follows pagination or stores credentials. */
export async function metaRequest(raw: MetaRequest, callerSignal?: AbortSignal): Promise<MetaResponse> {
  if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) throw new MetaRequestError('invalid_request');
  let request: ReturnType<typeof build>;
  try { request = build(raw); } catch (error) { if (error instanceof MetaRequestError) throw error; throw new MetaRequestError('invalid_request'); }
  const timeout = AbortSignal.timeout(30_000), signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const abortError = () => new MetaRequestError(callerSignal?.aborted ? 'aborted' : 'timeout', request.method === 'POST' ? { retryable: false } : {});
  if (signal.aborted) throw abortError();
  let rejectAbort!: (reason: MetaRequestError) => void;
  const abort = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(abortError()); signal.addEventListener('abort', onAbort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const pending = (fixture.getStore() ?? fetch)(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: 'error', credentials: 'omit', cache: 'no-store', signal });
    // An injected or nonconforming transport may ignore abort; discard its eventual response.
    void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
    const response = await Promise.race([pending, abort]), rate = rateHints(response.headers);
    if (response.redirected || response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => undefined); throw new MetaRequestError('invalid_response', { rate }); }
    reader = response.body?.getReader();
    if (!reader) throw providerFailure(response.status, null, rate) ?? new MetaRequestError('invalid_response', { rate });
    const length = response.headers.get('content-length'), type = response.headers.get('content-type');
    if (length !== null && (!/^[0-9]+$(?![\s\S])/.test(length) || Number(length) > maximum)) throw new MetaRequestError('invalid_response', { rate });
    if (type && !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$(?![\s\S])/i.test(type)) throw providerFailure(response.status, null, rate) ?? new MetaRequestError('invalid_response', { rate });
    // ponytail: each auth/account/report page is capped at4MiB; a fixed buffer avoids tiny-chunk object amplification.
    const bytes = Buffer.alloc(maximum); let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), abort]); if (part.done) break;
      if (!(part.value instanceof Uint8Array) || size + part.value.byteLength > maximum) throw new MetaRequestError('invalid_response', { rate });
      bytes.set(part.value, size); size += part.value.byteLength;
    }
    let data: unknown;
    try { data = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
    catch { throw providerFailure(response.status, null, rate) ?? new MetaRequestError('invalid_response', { rate }); }
    if (signal.aborted) throw abortError();
    const failure = providerFailure(response.status, data, rate); if (failure) throw failure;
    if (!object(data)) throw new MetaRequestError('invalid_response', { rate });
    return { data, rate };
  } catch (error) {
    if (signal.aborted) throw abortError();
    const failure = error instanceof MetaRequestError ? error : new MetaRequestError('unavailable', { retryable: true });
    // A failed creation attempt may still have created a report. Only a new explicit import may resubmit.
    if (request.method === 'POST') throw new MetaRequestError(failure.reason, { retryable: false, code: failure.providerCode, subcode: failure.providerSubcode, rate: failure.rate });
    throw failure;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}

/** Test injection is process-local and cannot change the fixed provider request builder. */
export function withMetaTransportForTests<T>(transport: MetaTransport, action: () => Promise<T>): Promise<T> {
  const local = ['localhost', '127.0.0.1', '[::1]'];
  let valid = false;
  try { const config = getConfig(); valid = process.env.TEN98_INTEGRATION_TEST === '1' && local.includes(new URL(config.appUrl).hostname) && local.includes(new URL(config.databaseUrl).hostname); } catch { /* Redacted below. */ }
  if (!valid) throw new Error('Meta fixtures require an isolated local test environment.');
  return fixture.run(transport, action);
}
