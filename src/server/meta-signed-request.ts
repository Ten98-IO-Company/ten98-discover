import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { FoundationError } from './auth.ts';

export type MetaSignedRequest = { userId: string; issuedAt: number | null; expires: number | null; digest: string };
const invalid = () => new FoundationError(400, 'The Meta signed request is invalid.');
const decimalId = /^[1-9][0-9]{0,39}$(?![\s\S])/;

function decode(segment: string): Buffer {
  if (!segment || /[^A-Za-z0-9_-]/.test(segment)) throw invalid();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw invalid();
  return bytes;
}

// JSON.parse has already validated the grammar. Scan only root member names so
// duplicate (including escaped-equivalent) keys cannot silently select an identity.
function rootValues(text: string): Map<string, number> {
  const keys = new Map<string, number>();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      if (depth !== 1) continue;
      let next = i + 1;
      while (/[ \t\r\n]/.test(text[next] ?? 'x')) next++;
      if (text[next] !== ':') continue;
      const key: string = JSON.parse(text.slice(start, i + 1));
      if (keys.has(key)) throw invalid();
      next++;
      while (/[ \t\r\n]/.test(text[next] ?? 'x')) next++;
      keys.set(key, next);
    }
  }
  return keys;
}

export function verifyMetaSignedRequest(raw: string, appSecret: string): MetaSignedRequest {
  try {
    // Application resource bounds, not claims about Meta's provider-wide limits.
    if (typeof raw !== 'string' || raw.length > 24 * 1024 || typeof appSecret !== 'string' || !appSecret.length || appSecret.length > 512 || /[^\x21-\x7e]/.test(appSecret)) throw invalid();
    const parts = raw.split('.');
    if (parts.length !== 2) throw invalid();
    const signature = decode(parts[0]), payload = decode(parts[1]);
    if (signature.length !== 32 || payload.length > 16 * 1024) throw invalid();
    const expected = createHmac('sha256', appSecret).update(parts[1], 'ascii').digest();
    if (!timingSafeEqual(signature, expected)) throw invalid();
    // Keep an initial BOM visible to JSON.parse; JSON permits only its own whitespace.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
    const values = rootValues(text);
    const object = data as Record<string, unknown>;
    // Grammar is already valid. Preserve the original root numeric token instead
    // of trusting JSON.parse's rounded number (also for near-integer timestamps).
    const numericSource = (key: string) => text.slice(values.get(key)!).match(/^[^,}\] \t\r\n]+/)?.[0] ?? '';
    const userId = typeof object.user_id === 'number' ? numericSource('user_id') : object.user_id;
    if (!Object.hasOwn(object, 'algorithm') || !Object.hasOwn(object, 'user_id') || object.algorithm !== 'HMAC-SHA256' || typeof userId !== 'string' || !decimalId.test(userId)) throw invalid();
    const epoch = (key: string): number | null => {
      if (!Object.hasOwn(object, key)) return null;
      const value = object[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || !/^(0|[1-9][0-9]*)$(?![\s\S])/.test(numericSource(key))) throw invalid();
      return value;
    };
    // No delivery-age or clock rule: lifecycle policy separately fences the subject.
    // The signed payload (not its signature) identifies redelivery after secret
    // rotation; verification with the current secret always precedes this digest.
    return { userId, issuedAt: epoch('issued_at'), expires: epoch('expires'), digest: createHash('sha256').update(parts[1], 'ascii').digest('hex') };
  } catch {
    throw invalid();
  }
}
