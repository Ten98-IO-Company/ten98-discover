import { mayGrantWorkspaceRole, workspaceRoles, type WorkspaceRole } from '@ten98/runtime';

/** Roles the actor may assign to an existing member. */
export function assignableRoles(actor: unknown): WorkspaceRole[] {
  return workspaceRoles.filter(role => mayGrantWorkspaceRole(actor, role));
}

/** Discover invitations never grant ownership; ownership arrives only by transfer. */
export function invitableRoles(actor: unknown): WorkspaceRole[] {
  return assignableRoles(actor).filter(role => role !== 'owner');
}
