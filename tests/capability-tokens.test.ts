import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';

const secret = 'capability-token-test-secret-'.padEnd(48, 'x');
Object.assign(process.env, { APP_URL: 'http://localhost:3000', AUTH_SECRET: secret, DATABASE_URL: 'postgresql://synthetic@localhost:5432/synthetic' });
const { readToken: readReplayToken } = await import('../src/server/session-replay.ts');
const { readToken: readHeatmapToken } = await import('../src/server/replay-heatmaps.ts');
const { readToken: readRetentionToken } = await import('../src/server/retention.ts');

// Verbatim minting from before @ten98/runtime capability tokens: base64url(JSON) + '.' + hex HMAC over `purpose:body`.
// Tokens issued by the previous release must keep verifying after deploy while they are within their lifetime.
function legacyToken(purpose: string, payload: unknown, key = secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(`${purpose}:${body}`).digest('hex')}`;
}

const upload = { version: 1, id: randomUUID(), projectId: randomUUID(), origin: 'https://site.example', epoch: randomUUID(), settingsHash: 'a'.repeat(64), until: Date.now() + 60_000 };
const preview = { revision: 3, settings: { rawAnalyticsDays: 395, replayDays: 30, rawProviderEvidenceDays: 90, derivedHistoryDays: 730 }, version: 1, workspaceId: randomUUID(), userId: 'user-1', issuedAt: Date.now() };
const readers = [
  { name: 'replay', purpose: 'ten98.replay-upload.v1', payload: upload, read: (token: string) => readReplayToken(token) },
  { name: 'heatmap', purpose: 'ten98.heatmap-upload.v1', payload: upload, read: (token: string) => readHeatmapToken(token) },
  { name: 'retention', purpose: 'ten98.retention.preview.v1', payload: preview, read: (token: string) => readRetentionToken({ previewToken: token }) },
];

test('tokens minted by the previous release still verify', () => {
  for (const { payload, ...reader } of readers) {
    assert.deepEqual(reader.read(legacyToken(reader.purpose, payload)), payload, reader.name);
  }
});

test('purposes stay separate, and a wrong secret or tampering is refused', () => {
  for (const { payload, ...reader } of readers) {
    const good = legacyToken(reader.purpose, payload);
    const [body, signature] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, version: 1, until: 1, issuedAt: 1 })).toString('base64url');
    const refused = [
      ...readers.filter(other => other.purpose !== reader.purpose).map(other => legacyToken(other.purpose, payload)),
      legacyToken(reader.purpose, payload, 'another-secret-of-sufficient-length-000000'),
      `${forged}.${signature}`,
      `${body}.${signature.toUpperCase()}`,
      `${body}.${signature.slice(0, -1)}${signature.at(-1) === '0' ? '1' : '0'}`,
      `${body}=.${signature}`,
      `${body}.${signature}.x`,
      `${body}.${signature}\n`,
    ];
    for (const token of refused) assert.throws(() => reader.read(token), `${reader.name}: ${token.slice(-24)}`);
  }
});
