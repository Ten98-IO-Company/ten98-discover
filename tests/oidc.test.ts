import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { constants, generateKeyPairSync, sign } from 'node:crypto';
import { discoverOidc, exchangeOidcCode, permittedOidcAddress, requestOidcJson, validateOidcSettings, verifyOidcIdentity } from '../src/server/oidc.ts';

test('OIDC pins approved endpoints and verifies signed issuer, audience, nonce and time claims', async () => {
  const previous = process.env.TEN98_INTEGRATION_TEST;
  process.env.TEN98_INTEGRATION_TEST = '1';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' };
  let origin = '', redirectTargetCalls = 0, tokenBody = '';
  let tokenAuthorization: string | undefined, endSession: unknown;
  const jwt = (claims: Record<string, unknown> = {}, key = privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url'),
      Buffer.from(JSON.stringify({ iss: origin, aud: 'fixture-client', sub: 'fixture-subject', iat: now, exp: now + 300,
        nonce: 'fixture-nonce', email: 'MEMBER@EXAMPLE.TEST', email_verified: true, name: 'Fixture member', ...claims })).toString('base64url')].join('.');
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
  };
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/.well-known/openid-configuration') response.end(JSON.stringify({ issuer: origin,
      authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/keys`, id_token_signing_alg_values_supported: ['RS256'], end_session_endpoint: endSession }));
    else if (request.url === '/keys') response.end(JSON.stringify({ keys: [jwk] }));
    else if (request.url === '/token') {
      tokenBody = ''; tokenAuthorization = request.headers.authorization;
      for await (const chunk of request) tokenBody += chunk;
      response.end(JSON.stringify({ id_token: jwt() }));
    } else if (request.url === '/redirect') { response.writeHead(302, { location: `${origin}/target` }); response.end('{}'); }
    else if (request.url === '/large') response.end(JSON.stringify({ payload: 'x'.repeat(1_048_576) }));
    else if (request.url === '/bom-json') response.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]));
    else if (request.url === '/invalid-utf8') response.end(Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]));
    else { redirectTargetCalls++; response.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', '2002:7f00:1::']) assert.equal(permittedOidcAddress(address, []), false);
    assert.equal(permittedOidcAddress('1.1.1.1', []), true);
    assert.equal(permittedOidcAddress('2606:4700:4700::1111', []), true);
    assert.equal(permittedOidcAddress('127.0.0.1', ['127.0.0.1']), true);
    const raw = { name: 'Local fixture', issuer: origin, clientId: 'fixture-client', allowedAddresses: ['127.0.0.1'] };
    assert.throws(() => validateOidcSettings({ ...raw, allowedAddresses: [] }));
    const settings = await discoverOidc(raw);
    assert.equal(Object.hasOwn(settings.metadata, 'end_session_endpoint'), false, 'A provider without RP-initiated sign-out still discovers.');
    // An end-session endpoint is optional: kept only inside the approved origins, otherwise ignored rather than refusing the provider.
    for (const [value, kept] of [[`${origin}/logout`, true], ['https://elsewhere.example.test/logout', false], [`${origin}/logout#fragment`, false], [null, false], [7, false]] as const) {
      endSession = value; assert.equal((await discoverOidc(raw)).metadata.end_session_endpoint, kept ? value : undefined, String(value));
    }
    endSession = undefined;
    const claims = await verifyOidcIdentity(settings, jwt(), 'fixture-nonce');
    assert.equal(claims.subject, 'fixture-subject'); assert.equal(claims.email, 'member@example.test'); assert.equal(claims.emailVerified, true);
    for (const invalid of [{ iss: 'https://other.example.test' }, { aud: 'other-client' }, { nonce: 'other-nonce' },
      { exp: 1 }, { iat: 1 }, { iat: Math.floor(Date.now() / 1000) + 20 }, { iat: Math.floor(Date.now() / 1000) + 600 }, { sub: '' }, { azp: 'other' }, { aud: ['fixture-client', 'other'], azp: 'other' }]) {
      await assert.rejects(verifyOidcIdentity(settings, jwt(invalid), 'fixture-nonce'), 'Invalid identity claims must be rejected.');
    }
    await assert.rejects(verifyOidcIdentity(settings, jwt(), ''));
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await assert.rejects(verifyOidcIdentity(settings, jwt({}, other.privateKey), 'fixture-nonce'));
    const identity = await exchangeOidcCode(settings, 'synthetic-secret', 'synthetic-code', 'synthetic-verifier', 'https://app.example.test/callback', 'fixture-nonce');
    assert.equal(identity.subject, 'fixture-subject');
    const submitted = new URLSearchParams(tokenBody);
    assert.equal(submitted.get('code_verifier'), 'synthetic-verifier');
    assert.equal(submitted.get('grant_type'), 'authorization_code');
    await exchangeOidcCode({ ...settings, authentication: 'post' }, '', 'synthetic-code', 'synthetic-verifier', 'https://app.example.test/callback', 'fixture-nonce');
    const publicClient = new URLSearchParams(tokenBody);
    assert.equal(publicClient.get('client_id'), 'fixture-client'); assert.equal(publicClient.has('client_secret'), false);
    assert.equal(tokenAuthorization, undefined, 'Public PKCE clients must not send empty Basic credentials.');
    await assert.rejects(requestOidcJson(`${origin}/redirect`, settings));
    assert.equal(redirectTargetCalls, 0, 'Redirect targets must never be followed.');
    await assert.rejects(requestOidcJson(`${origin}/large`, settings));
    await assert.rejects(requestOidcJson(`${origin}/invalid-utf8`, settings), { status: 502 });
    await assert.rejects(requestOidcJson(`${origin}/bom-json`, settings), { status: 502 }, 'OIDC JSON with a leading BOM must retain the previous rejection contract.');
    for (const issuer of ['https://identity.example/?', 'https://identity.example/#', 'https://user:secret@identity.example/']) assert.throws(() => validateOidcSettings({ ...raw, issuer }));
    await assert.rejects(requestOidcJson('https://not-approved.example.test/keys', settings));
    delete process.env.TEN98_INTEGRATION_TEST;
    assert.throws(() => validateOidcSettings(raw), 'HTTP must remain unavailable outside synthetic integration mode.');
  } finally {
    if (previous === undefined) delete process.env.TEN98_INTEGRATION_TEST; else process.env.TEN98_INTEGRATION_TEST = previous;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('OIDC accepts native PS256 and ES256 signatures while refreshing bounded JWKS rotation and refusing ambiguity', { timeout: 10_000 }, async () => {
  const previous = process.env.TEN98_INTEGRATION_TEST;
  process.env.TEN98_INTEGRATION_TEST = '1';
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const replacement = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const oldKey = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-old', alg: 'PS256', use: 'sig' };
  const newKey = { ...replacement.publicKey.export({ format: 'jwk' }), kid: 'rsa-new', alg: 'PS256', use: 'sig' };
  const ecKey = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-current', alg: 'ES256', use: 'sig' };
  let keys: typeof oldKey[] = [oldKey, ecKey], origin = '', jwksRequests = 0, unexpectedRequests = 0;
  const token = (algorithm: 'PS256' | 'ES256' | 'RS384', kid: string, key: typeof rsa.privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [Buffer.from(JSON.stringify({ alg: algorithm, kid })).toString('base64url'),
      Buffer.from(JSON.stringify({ iss: origin, aud: 'standards-client', sub: 'standards-subject', iat: now, exp: now + 300, nonce: 'standards-nonce' })).toString('base64url')].join('.');
    // Independent native signing: PSS has a SHA-256-length salt; JOSE ES256 uses raw IEEE-P1363 r||s.
    const signature = algorithm === 'PS256'
      ? sign('sha256', Buffer.from(unsigned), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })
      : algorithm === 'ES256' ? sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' })
        : sign('sha384', Buffer.from(unsigned), key);
    return `${unsigned}.${signature.toString('base64url')}`;
  };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/.well-known/openid-configuration') response.end(JSON.stringify({ issuer: origin,
      authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/keys`,
      id_token_signing_alg_values_supported: ['RS256', 'PS256', 'ES256'] }));
    else if (request.url === '/keys') { jwksRequests++; response.end(JSON.stringify({ keys })); }
    else { unexpectedRequests++; response.writeHead(404); response.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const settings = await discoverOidc({ name: 'Native algorithm fixture', issuer: origin, clientId: 'standards-client', allowedAddresses: ['127.0.0.1'] });
    assert.deepEqual(settings.metadata.id_token_signing_alg_values_supported, ['RS256', 'PS256', 'ES256']);
    const verify = (jwt: string) => verifyOidcIdentity(settings, jwt, 'standards-nonce');
    const oldToken = token('PS256', oldKey.kid, rsa.privateKey), newToken = token('PS256', newKey.kid, replacement.privateKey);
    assert.equal((await verify(oldToken)).subject, 'standards-subject');
    assert.equal((await verify(token('ES256', ecKey.kid, ec.privateKey))).subject, 'standards-subject');
    keys = [oldKey, newKey, ecKey];
    assert.equal((await verify(newToken)).subject, 'standards-subject', 'An added kid is read from the current approved JWKS.');
    keys = [newKey, ecKey];
    await assert.rejects(verify(oldToken), 'A retired signing key must not survive a stale cached key set.');
    assert.equal((await verify(newToken)).subject, 'standards-subject');
    keys = [newKey, { ...oldKey, kid: newKey.kid }];
    await assert.rejects(verify(newToken), 'A valid signature does not excuse two matching kid/algorithm keys.');
    keys = [{ ...oldKey, alg: 'RS384' }];
    await assert.rejects(verify(token('RS384', oldKey.kid, rsa.privateKey)), 'A genuine unsupported signature algorithm remains outside the accepted profile.');
    keys = Array.from({ length: 33 }, (_, index) => ({ ...newKey, kid: index ? `extra-${index}` : newKey.kid }));
    await assert.rejects(verify(newToken), 'Even a valid first key cannot bypass the 32-key JWKS bound.');
    keys = [newKey];
    assert.equal((await verify(newToken)).subject, 'standards-subject', 'Rejected key sets must not poison later valid verification.');
    assert.equal(jwksRequests, 9, 'Every assertion used the bounded local JWKS transport.');
    assert.equal(unexpectedRequests, 0);
  } finally {
    if (previous === undefined) delete process.env.TEN98_INTEGRATION_TEST; else process.env.TEN98_INTEGRATION_TEST = previous;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
