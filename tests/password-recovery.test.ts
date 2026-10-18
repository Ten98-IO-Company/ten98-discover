import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCallback, parsePasswordResetFragment } from '../src/lib/navigation.ts';

const token = 'aB0123456789aB0123456789';

test('recovery accepts only the exact one-use fragment representation', () => {
  assert.deepEqual(parsePasswordResetFragment(`#password-reset=${token}`), { token });
  for (const hash of [
    '#password-reset=', `#password-reset=${token.slice(1)}`, `#password-reset=${token}x`,
    `#password-reset=${token}\n`, `#password-reset=${token}\r`, `#password-reset=${token}\0`,
    `#password-reset=${token.slice(0, 23)}\n`, `#password-reset=${token}&password-reset=${token}`,
    `#password-reset=${token}&invite=other`, `#invite=other&password-reset=${token}`,
    `#password-reset=${token}&oidc-complete=1`, `#password-reset=%61${token.slice(1)}`,
    `#password%2dreset=${token}`, '#password-reset=%ED%A0%80', '#password-reset=%GG',
    `#password-reset=${'x'.repeat(4096)}`, `password-reset=${token}`,
  ]) assert.deepEqual(parsePasswordResetFragment(hash), { token: null }, 'Malformed recovery wire must never become a usable capability.');
});

test('ordinary callbacks remain owned by their existing parser', () => {
  for (const hash of ['', '#invite=opaque-invitation', '#oidc-complete=1', '#google=failed', '#meta=failed', '#section']) {
    assert.equal(parsePasswordResetFragment(hash), null);
  }
  assert.deepEqual(parseCallback('#oidc-complete=1'), { kind: 'complete' });
  assert.deepEqual(parseCallback('#google=failed'), { kind: 'google-error' });
  assert.deepEqual(parseCallback(`#password-reset=${token}`), { kind: 'invalid' });
});
