import { readResponseText } from '@ten98/runtime';
import { ApiError } from './api.ts';

const failure = (status: number, message: string) => { const error = new ApiError(message); error.status = status; return error; };

/** Reads one explorer combination report: exact status and media type, a 2 MiB success and 8 KiB error ceiling, strict UTF-8 JSON. Aborts propagate unchanged. */
export async function readExploreJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
  if ([401, 403, 404].includes(response.status)) { void response.body?.cancel(); throw failure(response.status, response.status === 401 ? 'Your session has expired. Sign in again.' : 'This project is unavailable.'); }
  if (response.ok && response.status !== 200) { void response.body?.cancel(); throw failure(response.status, 'The combination response status could not be verified.'); }
  if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw failure(response.status, 'The combination response could not be verified. Refresh the applied report.');
  let text: string;
  try { text = await readResponseText(response, { maxBytes: response.ok ? 2097152 : 8192 }); }
  catch (error) {
    // A cancelled or timed-out read surfaces as itself, as it did before the runtime reader.
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
    throw failure(response.status, error instanceof RangeError ? 'The complete combination response is too large. Narrow the filters.' : 'The combination response was incomplete or malformed.');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw failure(response.status, 'The combination response was incomplete or malformed.'); }
  if (!response.ok) throw failure(response.status, typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string' ? (value as { error: string }).error : 'The combination report could not be loaded.');
  return value as T;
}
