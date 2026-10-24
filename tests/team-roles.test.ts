import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignableRoles, defaultInviteRole, invitableRoles, invitationExpiry, inviteResultText, inviteRoleOptions, roleLabel } from '../src/lib/team-roles.ts';

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

test('invite role options are sentence case with one-line descriptions, defaulting to the least-privileged role', () => {
  assert.equal(defaultInviteRole, 'viewer');
  assert.deepEqual(inviteRoleOptions('owner'), [
    { value: 'admin', label: 'Admin', description: 'Manage members, projects and connections.' },
    { value: 'editor', label: 'Editor', description: 'Change project settings and run research.' },
    { value: 'viewer', label: 'Viewer', description: 'View dashboards and reports.' },
  ]);
  assert.deepEqual(inviteRoleOptions('admin').map(option => option.value), ['editor', 'viewer']);
  for (const actor of ['editor', 'viewer', null]) assert.deepEqual(inviteRoleOptions(actor), []);
  assert.deepEqual(['owner', 'admin', 'editor', 'viewer'].map(role => roleLabel(role)), ['Owner', 'Admin', 'Editor', 'Viewer']);
});

test('pending invitation expiry is relative, and past or invalid dates read as expired or unchanged', () => {
  const now = Date.parse('2026-10-24T12:00:00Z'), day = 86_400_000;
  assert.equal(invitationExpiry(new Date(now + 2 * day).toISOString(), now), 'Expires in 2 days');
  assert.equal(invitationExpiry(new Date(now + 7 * day - 1000).toISOString(), now), 'Expires in 7 days');
  assert.equal(invitationExpiry(new Date(now + day).toISOString(), now), 'Expires in 1 day');
  assert.equal(invitationExpiry(new Date(now + 5 * 3_600_000).toISOString(), now), 'Expires in 5 hours');
  assert.equal(invitationExpiry(new Date(now + 90_000).toISOString(), now), 'Expires in 2 minutes');
  assert.equal(invitationExpiry(new Date(now).toISOString(), now), 'Expired');
  assert.equal(invitationExpiry(new Date(now - day).toISOString(), now), 'Expired');
  assert.equal(invitationExpiry('not a date', now), 'not a date');
});

test('invite results keep honest delivery states and offer the link once', () => {
  const email = 'alan@co.com';
  assert.equal(inviteResultText({ kind: 'create', delivery: 'accepted', email }), 'Invitation emailed to alan@co.com. The email provider accepted the message; delivery is not confirmed. You can also copy the link below.');
  assert.equal(inviteResultText({ kind: 'create', delivery: 'disabled', email }), 'Email isn’t set up, so share this link yourself.');
  assert.equal(inviteResultText({ kind: 'create', delivery: 'failed', email }), 'The invitation email to alan@co.com could not be sent, so share this link yourself.');
  assert.equal(inviteResultText({ kind: 'resend', delivery: 'accepted', email }), 'Invitation emailed again to alan@co.com. The email provider accepted the message; delivery is not confirmed. The previous link no longer works.');
  assert.equal(inviteResultText({ kind: 'resend', delivery: 'failed', email }), 'The invitation email to alan@co.com could not be sent. The previous link no longer works. Copy the new link below and share it yourself.');
  assert.equal(inviteResultText({ kind: 'new-link', delivery: 'disabled', email }), 'New invitation link for alan@co.com. The previous link no longer works. Copy the link below and share it yourself — no email was sent.');
});
