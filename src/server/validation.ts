import { readResponseText } from '@ten98/runtime';
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
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$(?![\s\S])/),
    url: z.string().max(2048).refine(isHttpUrl),
    properties: z.unknown().optional(),
    dimensions: z.unknown().optional(),
    context: z.string().max(1024).optional(),
    consent: z.object({ analytics: z.literal(true), epoch: z.uuid() }).strict().optional(),
    collection: z.object({ mode: z.literal('cookieless'), epoch: z.uuid() }).strict().optional(),
  })
  .strict();

export async function readJson(request: Request, maxBytes = 8192): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
  const type = request.headers.get('content-type');
  if (type === null || type.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new InputError(415, 'content-type must be application/json');
  }
  const length = request.headers.get('content-length');
  let text: string;
  try {
    // contentLength 'limit' refuses a malformed or oversize declaration before reading, without demanding an exact count.
    text = await readResponseText(new Response(request.body, length === null ? {} : { headers: { 'content-length': length } }), { maxBytes, contentLength: 'limit' });
  } catch (error) {
    // The runtime marks its byte limit with RESPONSE_TOO_LARGE, a malformed declaration with CONTENT_LENGTH_INVALID and
    // malformed UTF-8 with RESPONSE_DECODE_INVALID. Anything else, including an error raised by the body stream itself, is a read failure.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (error instanceof RangeError && code === 'RESPONSE_TOO_LARGE') throw new InputError(413, 'body too large');
    if (code === 'CONTENT_LENGTH_INVALID') throw new InputError(400, 'invalid content-length');
    if (code === 'RESPONSE_DECODE_INVALID') throw new InputError(400, 'body is not valid utf-8');
    throw new InputError(400, 'failed to read request body');
  }
  if (text.trim() === '') throw new InputError(400, 'empty body');
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(400, 'body is not valid json');
  }
}
