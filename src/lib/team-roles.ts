import { mayGrantWorkspaceRole, workspaceRoles, type WorkspaceRole } from '@ten98/runtime';

/** Roles the actor may assign to an existing member. */
export function assignableRoles(actor: unknown): WorkspaceRole[] {
  return workspaceRoles.filter(role => mayGrantWorkspaceRole(actor, role));
}

/** Discover invitations never grant ownership; ownership arrives only by transfer. */
export function invitableRoles(actor: unknown): WorkspaceRole[] {
  return assignableRoles(actor).filter(role => role !== 'owner');
}

/** The least-privileged role, preselected for a new invitation. */
export const defaultInviteRole = 'viewer' satisfies WorkspaceRole;

const roleLabels: Record<WorkspaceRole, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };
const roleDescriptions: Record<Exclude<WorkspaceRole, 'owner'>, string> = {
  admin: 'Manage members, projects and connections.',
  editor: 'Change project settings and run research.',
  viewer: 'View dashboards and reports.',
};

/** Sentence-case display name; the wire value stays lowercase. */
export function roleLabel(role: string): string {
  return roleLabels[role as WorkspaceRole] ?? role;
}

/** Invitation role choices the actor may grant, each with its one-line description. */
export function inviteRoleOptions(actor: unknown) {
  return invitableRoles(actor).map(role => {
    const value = role as Exclude<WorkspaceRole, 'owner'>;
    return { value, label: roleLabels[value], description: roleDescriptions[value] };
  });
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/** "Expires in 2 days" style label for a pending invitation; an unparseable value is shown as sent. */
export function invitationExpiry(expiresAt: string, now = Date.now()): string {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return expiresAt;
  const left = at - now, hour = 3_600_000, day = 24 * hour;
  if (left <= 0) return 'Expired';
  const phrase = left >= day ? relative.format(Math.round(left / day), 'day')
    : left >= hour ? relative.format(Math.round(left / hour), 'hour')
    : relative.format(Math.max(1, Math.ceil(left / 60_000)), 'minute');
  return `Expires ${phrase}`;
}

export type InviteResult = { kind: 'create' | 'resend' | 'new-link'; delivery: 'accepted' | 'failed' | 'disabled'; email: string };

/** Delivery-state copy for a just-issued link: accepted is provider acceptance, never confirmed delivery. */
export function inviteResultText({ kind, delivery, email }: InviteResult): string {
  if (kind === 'new-link') return `New invitation link for ${email}. The previous link no longer works. Copy the link below and share it yourself — no email was sent.`;
  if (kind === 'resend') {
    return delivery === 'accepted'
      ? `Invitation emailed again to ${email}. The email provider accepted the message; delivery is not confirmed. The previous link no longer works.`
      : `The invitation email to ${email} could not be sent. The previous link no longer works. Copy the new link below and share it yourself.`;
  }
  if (delivery === 'accepted') return `Invitation emailed to ${email}. The email provider accepted the message; delivery is not confirmed. You can also copy the link below.`;
  if (delivery === 'failed') return `The invitation email to ${email} could not be sent, so share this link yourself.`;
  return 'Email isn’t set up, so share this link yourself.';
}
