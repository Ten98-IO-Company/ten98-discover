import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { FoundationError } from './auth.ts';

const keyName = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const envelopeInput = z.object({ keyId: keyName, iv: z.string().length(16), tag: z.string().length(24), ciphertext: z.string().min(1).max(24000) }).strict();
export type Envelope = z.infer<typeof envelopeInput>;
export type CredentialContext = { workspaceId: string; id: string; provider: string; revision: number };
export type Keyring = { active: string; keys: Map<string, Buffer> };

export function credentialKeys(env: NodeJS.ProcessEnv = process.env): Keyring | null {
  if (env.CREDENTIAL_KEYS && env.CREDENTIAL_KEYS_FILE) throw new Error('Set only CREDENTIAL_KEYS or CREDENTIAL_KEYS_FILE.');
  const raw = env.CREDENTIAL_KEYS_FILE ? readFileSync(env.CREDENTIAL_KEYS_FILE, 'utf8').trim() : env.CREDENTIAL_KEYS;
  if (!raw) {
    if (env.CREDENTIAL_ACTIVE_KEY) throw new Error('Credential keyring is missing.');
    return null;
  }
  try {
    const parsed = z.record(keyName, z.string().length(44)).parse(JSON.parse(raw));
    if (Object.keys(parsed).length < 1 || Object.keys(parsed).length > 8) throw new Error();
    const keys = new Map(Object.entries(parsed).map(([id, value]) => {
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length !== 32 || bytes.toString('base64') !== value) throw new Error();
      return [id, bytes] as const;
    }));
    const active = keyName.parse(env.CREDENTIAL_ACTIVE_KEY);
    if (!keys.has(active)) throw new Error();
    return { active, keys };
  } catch { throw new Error('Credential keyring is invalid. Check key names and 32-byte base64 values.'); }
}

function contextBytes(context: CredentialContext) {
  return Buffer.from(JSON.stringify(['ten98.credentials.v1', context.workspaceId, context.id, context.provider, context.revision]));
}

export function encryptCredentials(value: unknown, context: CredentialContext, ring = credentialKeys()): Envelope {
  if (!ring) throw new FoundationError(503, 'Ask the operator to configure the credential encryption keyring.');
  const plaintext = JSON.stringify(value);
  // GCM ciphertext has the plaintext's length; 18,000 bytes encode to at most 24,000 base64 characters.
  if (plaintext === undefined || Buffer.byteLength(plaintext, 'utf8') > 18_000) throw new FoundationError(400, 'Provider credentials are too large to store safely.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.keys.get(ring.active)!, iv, { authTagLength: 16 });
  cipher.setAAD(contextBytes(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { keyId: ring.active, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function decryptCredentials(value: unknown, context: CredentialContext, ring = credentialKeys()): unknown {
  try {
    const envelope = envelopeInput.parse(value);
    const key = ring?.keys.get(envelope.keyId);
    if (!key) throw new Error();
    const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64'), ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || iv.toString('base64') !== envelope.iv || tag.toString('base64') !== envelope.tag || ciphertext.toString('base64') !== envelope.ciphertext) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(contextBytes(context));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch { throw new FoundationError(503, 'Stored credentials cannot be opened. Ask the operator to restore the correct encryption keyring.'); }
}
