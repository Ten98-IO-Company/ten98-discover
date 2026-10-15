import { AsyncLocalStorage } from 'node:async_hooks';
import { FoundationError } from './auth.ts';
import { getConfig } from './config.ts';

type Transport = (url: string, init: RequestInit) => Promise<Response>;
const fixtureTransport = new AsyncLocalStorage<Transport>();
const hosts = new Set(['oauth2.googleapis.com', 'www.googleapis.com', 'analyticsadmin.googleapis.com', 'analyticsdata.googleapis.com', 'searchconsole.googleapis.com']);
export class GoogleRequestError extends FoundationError {
  retryable: boolean;
  reauthorize: boolean;
  constructor(status: number) {
    super(status === 401 || status === 403 ? 409 : status === 429 ? 429 : 502,
      status === 401 ? 'Google access has expired. Reconnect this report source.' : status === 403 ? 'Google denied access. Check consent, enabled APIs and property permissions.' : status === 429 ? 'Google quota is exhausted. Wait before retrying the import.' : 'Google is unavailable. Retry the import later.');
    this.retryable = status === 429 || status >= 500;
    this.reauthorize = status === 401;
  }
}

/** Fixed Google hosts only; redirects cannot forward bearer credentials. */
export async function googleRequest(url: string, token?: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname) || parsed.port || parsed.username || parsed.password || url.includes('#')) throw new Error('Invalid Google endpoint.');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json';
  let response: Response;
  try { response = await (fixtureTransport.getStore() ?? fetch)(url, { method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), ...(body === undefined ? {} : { body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body) }) }); }
  catch { throw new GoogleRequestError(502); }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new GoogleRequestError(response.status === 400 && parsed.hostname === 'oauth2.googleapis.com' && parsed.pathname === '/token' ? 401 : response.status); }
  const reader = response.body?.getReader();
  if (!reader) throw new GoogleRequestError(502);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2_097_152) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    return size === 0 ? {} : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new GoogleRequestError(502); }
  finally { reader.releaseLock(); }
}

/** In-process test injection only; no endpoint or environment can change provider URLs. */
export function withGoogleTransportForTests<T>(transport: Transport, action: () => Promise<T>): Promise<T> {
  const local = ['localhost', '127.0.0.1', '[::1]'];
  if (process.env.TEN98_INTEGRATION_TEST !== '1' || !local.includes(new URL(getConfig().appUrl).hostname) || !local.includes(new URL(getConfig().databaseUrl).hostname)) throw new Error('Google fixtures require an isolated local test environment.');
  return fixtureTransport.run(transport, action);
}
