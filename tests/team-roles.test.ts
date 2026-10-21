import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignableRoles, invitableRoles } from '../src/lib/team-roles.ts';

test('team role options keep owner-only ownership and exclude owner invitations', () => {
  assert.deepEqual(assignableRoles('owner'), ['owner', 'admin', 'editor', 'viewer']);
  assert.deepEqual(invitableRoles('owner'), ['admin', 'editor', 'viewer']);
  assert.deepEqual(assignableRoles('admin'), ['editor', 'viewer']);
  assert.deepEqual(invitableRoles('admin'), ['editor', 'viewer']);
  for (const actor of ['editor', 'viewer', null, 'unknown']) {
    assert.deepEqual(assignableRoles(actor), []);
    assert.deepEqual(invitableRoles(actor), []);
  }
});
