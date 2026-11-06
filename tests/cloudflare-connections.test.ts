import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {cloudflareConnectionSave, cloudflareConnectionDisconnect, cloudflareConnectionMetadata, cloudflareConnectionMutationResponse} from '../src/lib/cloudflare-connections.ts';

const input = {requestId: randomUUID(), connectionId: null, expectedRevision: 0, accountId: 'a'.repeat(32), name: 'Cloudflare', apiToken: 'synthetic-test-token'};
test('connection input rejects ambiguous creation, unsafe credentials, unknown controls and immutable-ID substitutions', () => {
  assert.ok(cloudflareConnectionSave.safeParse(input).success);
  for (const raw of [{...input, connectionId: randomUUID()}, {...input, expectedRevision: 1}, {...input, apiToken: ''}, {...input, apiToken: 'secret\n'},
    {...input, name: '\u0000'}, {...input, accountId: '../account'}, {...input, budget: 1}, {...input, apiToken: 'a'.repeat(4097)}]) assert.equal(cloudflareConnectionSave.safeParse(raw).success, false);
  assert.equal(cloudflareConnectionSave.parse({...input, name: ' Account '}).name, 'Account');
  assert.ok(cloudflareConnectionSave.safeParse({...input, connectionId: randomUUID(), expectedRevision: 1}).success);
  assert.equal(cloudflareConnectionDisconnect.safeParse({requestId: input.requestId, connectionId: randomUUID(), expectedRevision: 0}).success, false);
  assert.equal(cloudflareConnectionDisconnect.safeParse({requestId: input.requestId, connectionId: randomUUID(), expectedRevision: 2147483646}).success, false);
});
test('redacted response contracts reject secrets and distinguish original acknowledgments from current revisions', () => {
  const connection = {id: randomUUID(), accountId: input.accountId, name: input.name, revision: 3, state: 'configured', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revokedAt: null};
  assert.ok(cloudflareConnectionMetadata.safeParse(connection).success);
  for (const value of [{...connection, apiToken: input.apiToken}, {...connection, encrypted_credentials: {}}, {...connection, state: 'disconnected'}, {...connection, state: 'verified'}]) assert.equal(cloudflareConnectionMetadata.safeParse(value).success, false);
  const response = {projectId: randomUUID(), role: 'owner', vaultConfigured: true, connections: [connection], ack: {requestId: input.requestId, operation: 'save', connectionId: connection.id, revision: 1}};
  assert.ok(cloudflareConnectionMutationResponse.safeParse(response).success);
  assert.equal(cloudflareConnectionMutationResponse.safeParse({...response, ack: {...response.ack, apiToken: input.apiToken}}).success, false);
});
