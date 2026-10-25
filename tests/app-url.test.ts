import assert from 'node:assert/strict';
import test from 'node:test';
import { getConfig } from '../src/server/config.ts';

const env = { AUTH_SECRET: 'a'.repeat(32), DATABASE_URL: 'postgresql://synthetic@localhost:5432/synthetic' };
const appUrl = (APP_URL?: string) => getConfig(APP_URL === undefined ? env : { ...env, APP_URL }).appUrl;

test('APP_URL accepts an https origin, or http on loopback, and is reduced to its origin', () => {
  assert.equal(appUrl(), 'http://localhost:3000');
  for (const [raw, origin] of [
    ['https://discover.example.com', 'https://discover.example.com'],
    ['https://Discover.Example.com:8443/', 'https://discover.example.com:8443'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:3000/', 'http://127.0.0.1:3000'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
  ]) assert.equal(appUrl(raw), origin, raw);
});

test('APP_URL refuses anything other than an http(s) origin, keeping the existing messages', () => {
  for (const raw of ['not a url', '', 'ftp://discover.example.com', 'https://user:pass@discover.example.com', 'https://discover.example.com/?a=1',
    'https://discover.example.com/app', 'https://discover.example.com/#top', 'https://discover.example.com/#', 'https://discover.example.com//']) {
    assert.throws(() => appUrl(raw), { message: 'APP_URL must be an HTTP(S) origin' }, raw);
  }
  for (const raw of ['http://discover.example.com', 'http://10.0.0.1:3000', 'http://localhost.example.com']) {
    assert.throws(() => appUrl(raw), { message: 'Non-local APP_URL requires HTTPS' }, raw);
  }
});
