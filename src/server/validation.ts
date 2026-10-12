import { z } from 'zod';

export class InputError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'InputError';
    this.status = status;
  }
}

function bad(message: string): never {
  throw new InputError(400, message);
}

export function normalizeOrigin(value: string): string {
  if (value.length === 0 || value.length > 2048) bad('invalid origin length');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    bad('malformed origin');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') bad('origin must be http(s)');
  if (url.username !== '' || url.password !== '') bad('origin must not carry credentials');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') bad('origin must not carry path/query/hash');
  return url.origin;
}

export function eventPath(url: string): string {
  const path = new URL(url).pathname;
  if (path.length > 2048) bad('path too long');
  return path;
}

export const projectInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    origin: z.string().transform(normalizeOrigin),
  })
  .strict();

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

export const eventInput = z
  .object({
    siteKey: z.uuid(),
    eventId: z.uuid(),
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/),
    url: z.string().max(2048).refine(isHttpUrl),
  })
  .strict();

export async function readJson(request: Request, maxBytes = 8192): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
  const type = request.headers.get('content-type');
  if (type === null || type.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new InputError(415, 'content-type must be application/json');
  }
  const length = request.headers.get('content-length');
  if (length !== null) {
    const trimmed = length.trim();
    if (!/^\d+$/.test(trimmed)) throw new InputError(400, 'invalid content-length');
    const declared = Number(trimmed);
    if (!Number.isSafeInteger(declared)) throw new InputError(400, 'invalid content-length');
    if (declared > maxBytes) throw new InputError(413, 'body too large');
  }
  if (request.body === null) throw new InputError(400, 'empty body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new InputError(413, 'body too large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(400, 'failed to read request body');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InputError(400, 'body is not valid utf-8');
  }
  if (text.trim() === '') throw new InputError(400, 'empty body');
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(400, 'body is not valid json');
  }
}
