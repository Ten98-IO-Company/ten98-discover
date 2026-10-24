import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { mayGrantWorkspaceRole, mayManageWorkspaceMember, type WorkspaceRole as Role } from '@ten98/runtime';
import { Alert, Banner, Button, Inline, useConfirmDialog } from '@ten98/ui';
import { assignableRoles, invitableRoles } from '../lib/team-roles';
import { api, ApiError, errMsg } from '../lib/api';

type Member = { userId: string; name: string; email: string; role: Role };
type Invitation = { id: string; email: string; role: Role; expiresAt: string };
type InviteDelivery = 'accepted' | 'failed' | 'disabled';
type InviteAction = { kind: 'resend' | 'new-link'; invitation: Invitation };
type InviteLink = { email: string; url: string; delivery: InviteDelivery; kind: 'create' | InviteAction['kind'] };
type TeamData = {
  workspace: { id: string; name: string; twoFactorRequired: boolean };
  role: Role;
  members: Member[];
  invitations: Invitation[];
};


function is401(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

type TeamPanelProps = {
  workspaceId: string;
  userId: string;
  onChanged: () => Promise<void>;
  onUnauthorized: () => void;
};

export function TeamPanel(props: TeamPanelProps) {
  return <TeamPanelContent key={`${props.workspaceId}:${props.userId}`} {...props} />;
}

function TeamPanelContent(props: TeamPanelProps) {
  const { workspaceId, userId, onChanged } = props;
  const [data, setData] = useState<TeamData | null>(null);
  const [confirm, confirmDialog] = useConfirmDialog({ danger: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setBusy] = useState(false);
  const busy = mutating || loading;
  const [reload, setReload] = useState(0);
  const [name, setName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('editor');
  const [inviteLink, setInviteLink] = useState<InviteLink | null>(null);
  // A resend or new link whose reply was lost; only that exact request is offered again.
  const [attempt, setAttempt] = useState<InviteAction | null>(null);
  const [copied, setCopied] = useState(false);
  const [transferTo, setTransferTo] = useState('');
  const [transferEmail, setTransferEmail] = useState('');

  const reqRef = useRef(0);
  const mutRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const linkRef = useRef(inviteLink);
  linkRef.current = inviteLink;
  const unauthRef = useRef(props.onUnauthorized);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  useEffect(() => {
    unauthRef.current = props.onUnauthorized;
  });
  // Abort any in-flight mutation on unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      mutRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const id = ++reqRef.current;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    api<TeamData>(`/api/workspaces/${encodeURIComponent(workspaceId)}/team`, { signal: ac.signal })
      .then(d => {
        if (id !== reqRef.current || ac.signal.aborted) return;
        setData(d);
        setLoading(false);
      })
      .catch(async e => {
        if (id !== reqRef.current || ac.signal.aborted) return;
        setLoading(false);
        if (is401(e)) {
          unauthRef.current();
          return;
        }
        if (await handleAccessLoss(e, ac.signal)) return;
        if (id !== reqRef.current || ac.signal.aborted) return;
        setError(`Could not load the team: ${errMsg(e)}`);
      });
    return () => ac.abort();
  }, [workspaceId, reload]);

  // Sync the rename field with the loaded name without clobbering in-progress typing.
  useEffect(() => {
    setName(data?.workspace.name ?? '');
  }, [data?.workspace.name]);

  const myRole = data?.role ?? null;
  const canManage = myRole === 'owner' || myRole === 'admin';
  const roleOptions = assignableRoles(myRole);
  const inviteRoles = invitableRoles(myRole);
  const transferTarget = data?.members.find(member => member.userId === transferTo && member.userId !== userId);

  function canManageMember(m: Member): boolean {
    return mayManageWorkspaceMember(data?.role, m.role);
  }

  function canManageInvite(inv: Invitation): boolean {
    return mayGrantWorkspaceRole(data?.role, inv.role);
  }

  async function handleAccessLoss(error: unknown, signal: AbortSignal): Promise<boolean> {
    if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) return false;
    if (signal.aborted) return true;
    const accessRequest = ++reqRef.current;
    setData(null);
    setInviteLink(null);
    linkRef.current = null;
    setLoading(false);
    setError(`Your workspace access changed. ${errMsg(error)}`);
    try {
      await changedRef.current();
    } catch (refreshError) {
      if (signal.aborted || accessRequest !== reqRef.current) return true;
      if (is401(refreshError)) unauthRef.current();
      else setError(`Could not refresh your workspace access: ${errMsg(refreshError)} Try again.`);
    }
    return true;
  }

  // Serializes all mutations behind one busy flag; fn may return a commit callback
  // that only runs when the request is still current (not aborted / not stale).
  async function runMutation(
    label: string,
    fn: (signal: AbortSignal) => Promise<void | (() => void)>,
  ) {
    if (busy || loading || mutRef.current) return;
    const ac = new AbortController();
    mutRef.current = ac;
    setBusy(true);
    setError(null);
    try {
      const commit = await fn(ac.signal);
      if (ac.signal.aborted) return;
      commit?.();
      setReload(k => k + 1);
      await changedRef.current();
    } catch (e) {
      if (ac.signal.aborted) return;
      if (is401(e)) {
        unauthRef.current();
        return;
      }
      if (await handleAccessLoss(e, ac.signal)) return;
      if (ac.signal.aborted) return;
      setError(`${label}: ${errMsg(e)}`);
    } finally {
      if (mutRef.current === ac) {
        mutRef.current = null;
        if (!ac.signal.aborted) setBusy(false);
      }
    }
  }

  function submitRename(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!data || !trimmed || trimmed.length > 120 || trimmed === data.workspace.name) return;
    void runMutation('Could not rename the workspace', async signal => {
      await api<unknown>(`/api/workspaces/${encodeURIComponent(workspaceId)}/rename`, {
        method: 'POST',
        body: { name: trimmed },
        signal,
      });
    });
  }

  function submitInvite(e: FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!data || !email || email.length > 254) return;
    void runMutation('Could not create the invitation', async signal => {
      const res = await api<{ invitation: Invitation; inviteUrl: string; email: InviteDelivery }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
        { method: 'POST', body: { email, role: inviteRoles.includes(inviteRole) ? inviteRole : 'editor' }, signal },
      );
      return () => {
        setInviteLink({ email: res.invitation.email, url: res.inviteUrl, delivery: res.email, kind: 'create' });
        setCopied(false);
        setInviteEmail('');
      };
    });
  }

  function revokeInvite(inv: Invitation) {
    void runMutation(`Could not revoke the invitation for ${inv.email}`, async signal => {
      await api<unknown>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(inv.id)}/revoke`,
        { method: 'POST', body: {}, signal },
      );
      return () => {
        if (linkRef.current?.email.toLowerCase() === inv.email.toLowerCase()) {
          linkRef.current = null;
          setInviteLink(null);
          setCopied(false);
        }
        setAttempt(current => current?.invitation.id === inv.id ? null : current);
      };
    });
  }

  function runInviteAction(action: InviteAction) {
    const { kind, invitation: inv } = action;
    void runMutation(kind === 'resend' ? `Could not resend the invitation to ${inv.email}` : `Could not issue a new link for ${inv.email}`, async signal => {
      let res: { invitation: Invitation; inviteUrl: string; email?: 'accepted' | 'failed' };
      try {
        res = await api(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(inv.id)}/${kind}`,
          { method: 'POST', body: {}, signal },
        );
      } catch (e) {
        // Network loss or a server error may follow a committed rotation, so the old link may already be gone.
        const unknown = !(e instanceof ApiError) || e.status === 0 || e.status >= 500;
        if (!signal.aborted) setAttempt(unknown ? action : null);
        throw e;
      }
      return () => {
        setAttempt(null);
        setInviteLink({ email: res.invitation.email, url: res.inviteUrl, delivery: res.email ?? 'disabled', kind });
        setCopied(false);
      };
    });
  }

  // Both actions replace the current link, so each is confirmed once; an exact retry of an unconfirmed outcome is not asked again.
  async function confirmInviteAction(action: InviteAction) {
    const { kind, invitation: inv } = action;
    const confirmed = kind === 'resend'
      ? await confirm({ title: `Resend the invitation to ${inv.email}?`, description: 'This sends a new invitation email and the previous link stops working.', confirmLabel: 'Resend email' })
      : await confirm({ title: `Issue a new invitation link for ${inv.email}?`, description: 'The current link stops working immediately. No email is sent; you copy and share the new link yourself.', confirmLabel: 'Issue new link' });
    if (!confirmed || mutRef.current) return;
    runInviteAction(action);
  }

  function changeRole(m: Member, role: Role) {
    if (role === m.role) return;
    void runMutation(`Could not change the role of ${m.name}`, async signal => {
      await api<unknown>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(m.userId)}/role`,
        { method: 'POST', body: { role }, signal },
      );
    });
  }

  async function removeMember(m: Member) {
    if (!await confirm({ title: `Remove ${m.name} (${m.email}) from this workspace?`, description: 'They will lose access immediately.', confirmLabel: 'Remove member', confirmationText: m.email })) {
      return;
    }
    if (mutRef.current) return;
    void runMutation(`Could not remove ${m.name}`, async signal => {
      await api<unknown>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(m.userId)}/remove`,
        { method: 'POST', body: {}, signal },
      );
    });
  }

  function submitTransfer(e: FormEvent) {
    e.preventDefault();
    if (myRole !== 'owner' || !transferTarget || transferEmail.trim().toLowerCase() !== transferTarget.email.toLowerCase()) return;
    void runMutation('Ownership transfer was not confirmed. Refresh the team to check the saved roles before trying again', async signal => {
      await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/transfer-ownership`, {
        method: 'POST', body: { targetUserId: transferTarget.userId, confirmationEmail: transferEmail.trim().toLowerCase() }, signal,
      });
      return () => { setTransferTo(''); setTransferEmail(''); setInviteLink(null); linkRef.current = null; setData(null); };
    });
  }

  async function toggleTwoFactor() {
    if (!data || myRole !== 'owner' || busy) return;
    const required = !data.workspace.twoFactorRequired;
    if (required && !await confirm({ title: 'Require two-factor authentication now?', description: 'Members without two-factor authentication will lose access to this workspace’s data, and API keys they created will stop working, until they turn it on.', confirmLabel: 'Require 2FA' })) return;
    if (mutRef.current) return;
    void runMutation('Could not change the two-factor requirement', async signal => {
      await api<unknown>(`/api/workspaces/${encodeURIComponent(workspaceId)}/two-factor`, { method: 'POST', body: { required }, signal });
    });
  }

  async function copyInvite() {
    if (!inviteLink) return;
    const link = inviteLink;
    try {
      await navigator.clipboard.writeText(link.url);
      if (mountedRef.current && linkRef.current === link) setCopied(true);
    } catch {
      if (mountedRef.current && linkRef.current === link) setCopied(false);
    }
  }

  if (!data) {
    if (loading) {
      return (
        <p role='status' className='dim'>
          Loading team…
        </p>
      );
    }
    return (
      <div className='alert' role='alert'>
        <p>{error}</p>
        <button type='button' className='btn' onClick={() => setReload(k => k + 1)}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div aria-busy={busy || loading}>
      {loading && <p className='dim' role='status'>Refreshing team…</p>}
      <div className='proj-head'>
        <h2>{data.workspace.name}</h2>
        <p className='dim'>Your role: {data.role}</p>
        <button type='button' className='btn' disabled={busy} onClick={() => setReload(value => value + 1)}>Refresh team</button>
      </div>

      {error && (
        <div className='alert' role='alert'>
          {error}
        </div>
      )}

      {canManage && (
        <section className='card'>
          <h2>Rename workspace</h2>
          <form onSubmit={submitRename}>
            <div className='field'>
              <label htmlFor='ws-rename'>Workspace name</label>
              <input
                id='ws-rename'
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={120}
                required
                disabled={busy}
              />
            </div>
            <button
              type='submit'
              className='btn primary'
              disabled={busy || !name.trim() || name.trim() === data.workspace.name}
            >
              Rename workspace
            </button>
          </form>
        </section>
      )}

      <section className='card'>
        <h2>Members</h2>
        {data.members.length === 0 ? (
          <div className='empty'>
            <p>
              <strong>No members found.</strong>
            </p>
            <p>People who join this workspace will appear here.</p>
          </div>
        ) : (
          <div className='table-wrap'>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  {canManage && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {data.members.map(m => (
                  <tr key={m.userId}>
                    <td>
                      {m.name}
                      {m.userId === userId && <span className='dim'> (you)</span>}
                    </td>
                    <td>{m.email}</td>
                    <td>
                      {canManage && canManageMember(m) ? (
                        <select
                          aria-label={`Role for ${m.name}`}
                          value={m.role}
                          disabled={busy}
                          onChange={e => changeRole(m, e.target.value as Role)}
                        >
                          {roleOptions.map(r => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        m.role
                      )}
                    </td>
                    {canManage && (
                      <td>
                        {canManageMember(m) && (
                          <button type='button' className='btn' disabled={busy} onClick={() => void removeMember(m)}>
                            Remove
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {myRole === 'owner' && (
        <section className='card' aria-labelledby='two-factor-heading'>
          <h2 id='two-factor-heading'>Two-factor requirement</h2>
          {data.workspace.twoFactorRequired
            ? <Banner tone='warning' icon='shield' live>Members must turn on two-factor authentication before opening this workspace’s data.</Banner>
            : <p id='two-factor-status' role='status'>Members can open this workspace without two-factor authentication.</p>}
          <button type='button' className='btn' style={{ minBlockSize: 'var(--control-touch)' }} aria-disabled={busy} aria-describedby={data.workspace.twoFactorRequired ? undefined : 'two-factor-status'} onClick={() => void toggleTwoFactor()}>
            {data.workspace.twoFactorRequired ? 'Stop requiring two-factor authentication' : 'Require two-factor authentication'}
          </button>
        </section>
      )}

      {myRole === 'owner' && (
        <section className='card' aria-labelledby='ownership-heading'>
          <h2 id='ownership-heading'>Transfer your ownership</h2>
          <p>Choose an existing member to become an owner. You will become an administrator and lose owner-only controls. Other owners keep their roles.</p>
          <form onSubmit={submitTransfer}>
            <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className='sr-only'>New workspace owner</legend>
              <div className='field'>
                <label htmlFor='transfer-owner'>New owner</label>
                <select id='transfer-owner' value={transferTo} required onChange={e => { setTransferTo(e.target.value); setTransferEmail(''); }}>
                  <option value=''>Choose a team member</option>
                  {data.members.filter(member => member.userId !== userId).map(member => <option key={member.userId} value={member.userId}>{member.name} ({member.email})</option>)}
                </select>
              </div>
              {transferTarget && <div className='field'>
                <label htmlFor='transfer-confirm'>Type {transferTarget.email} to confirm</label>
                <input id='transfer-confirm' type='email' value={transferEmail} onChange={e => setTransferEmail(e.target.value)} maxLength={254} autoComplete='off' required aria-describedby='transfer-effect'/>
                <p id='transfer-effect' className='hint'>{transferTarget.name} will control this workspace’s provider credentials, security and members. Your pending administrator invitations will be revoked.</p>
              </div>}
              <button className='btn' type='submit' disabled={busy || !transferTarget || transferEmail.trim().toLowerCase() !== transferTarget.email.toLowerCase()}>Transfer ownership and become administrator</button>
            </fieldset>
          </form>
        </section>
      )}

      <section className='card'>
        <h2>Pending invitations</h2>
        {data.invitations.length === 0 ? (
          <div className='empty'>
            <p>
              <strong>No pending invitations.</strong>
            </p>
            <p>
              {canManage
                ? 'Create an invitation link below to add someone to this workspace.'
                : 'Invitations that have not been accepted yet will appear here.'}
            </p>
          </div>
        ) : (
          <div className='table-wrap'>
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Expires</th>
                  {canManage && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {data.invitations.map(inv => (
                  <tr key={inv.id}>
                    <td>{inv.email}</td>
                    <td>{inv.role}</td>
                    <td>{formatDate(inv.expiresAt)}</td>
                    {canManage && (
                      <td>
                        {canManageInvite(inv) && (
                          <Inline gap={2}>
                            <Button type='button' variant='secondary' disabled={busy} aria-label={`Resend email to ${inv.email}`} onClick={() => void confirmInviteAction({ kind: 'resend', invitation: inv })}>
                              Resend email
                            </Button>
                            <Button type='button' variant='secondary' disabled={busy} aria-label={`New link for ${inv.email}`} onClick={() => void confirmInviteAction({ kind: 'new-link', invitation: inv })}>
                              New link
                            </Button>
                            <Button type='button' variant='secondary' disabled={busy} onClick={() => revokeInvite(inv)}>
                              Revoke
                            </Button>
                          </Inline>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {attempt && (
          <Alert tone='warning' title='Outcome not confirmed' actions={<Inline gap={2}>
            <Button type='button' variant='secondary' disabled={busy} onClick={() => runInviteAction(attempt)}>Retry same request</Button>
            <Button type='button' variant='ghost' disabled={busy} onClick={() => setAttempt(null)}>Dismiss</Button>
          </Inline>}>
            The {attempt.kind === 'resend' ? 'resend' : 'new link'} request for {attempt.invitation.email} was not confirmed. The
            previous link may already have stopped working. Retry the same request to get a working link.
          </Alert>
        )}
      </section>

      {canManage && (
        <section className='card'>
          <h2>Invite someone</h2>
          <p className='dim'>
            When this installation has email configured, the invitation is also emailed. You always get a link to copy
            and share yourself. It expires after 7 days.
          </p>
          <form onSubmit={submitInvite}>
            <div className='field'>
              <label htmlFor='invite-email'>Email address</label>
              <input
                id='invite-email'
                type='email'
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                placeholder='name@example.com'
                maxLength={254}
                required
                disabled={busy}
              />
            </div>
            <div className='field'>
              <label htmlFor='invite-role'>Role</label>
              <select
                id='invite-role'
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value as Role)}
                disabled={busy}
              >
                {inviteRoles.map(r => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <button type='submit' className='btn primary' disabled={busy || !inviteEmail.trim()}>
              Create invitation link
            </button>
          </form>
          {inviteLink && (
            <div className='banner' role='status'>
              <p>
                {inviteLink.kind === 'new-link' ? (
                  <>New invitation link for {inviteLink.email}. The previous link no longer works. Copy the link below and share it
                  yourself — no email was sent.</>
                ) : inviteLink.kind === 'resend' && inviteLink.delivery === 'accepted' ? (
                  <>Invitation emailed again to {inviteLink.email}. The email provider accepted the message; delivery is not confirmed. The previous link no longer works.</>
                ) : inviteLink.kind === 'resend' ? (
                  <>The invitation email to {inviteLink.email} could not be sent. The previous link no longer works. Copy the new
                  link below and share it yourself.</>
                ) : inviteLink.delivery === 'accepted' ? (
                  <><strong>Invitation created for {inviteLink.email}.</strong> The email provider accepted the message; delivery is not confirmed. You can also copy the link below.</>
                ) : inviteLink.delivery === 'failed' ? (
                  <><strong>Invitation created for {inviteLink.email}, but the email could not be sent.</strong> Copy the link
                  below and share it yourself.</>
                ) : (
                  <><strong>Invitation created for {inviteLink.email}.</strong> Copy the link below and share it with them
                  — no email was sent.</>
                )}{' '}It expires after 7 days.
              </p>
              <div className='row'>
                <button type='button' className='btn' onClick={() => void copyInvite()}>
                  {copied ? 'Copied' : 'Copy link'}
                </button>
                <button type='button' className='btn ghost' onClick={() => setInviteLink(null)}>
                  Dismiss
                </button>
              </div>
              <textarea
                className='snippet'
                style={{ width: '100%', resize: 'vertical' }}
                readOnly
                rows={3}
                value={inviteLink.url}
                aria-label='Invitation link'
                onFocus={e => e.currentTarget.select()}
              />
              <p className='hint'>
                If copying does not work, select the link and copy it manually. For security it is only shown here,
                once.
              </p>
            </div>
          )}
        </section>
      )}
      {confirmDialog}
    </div>
  );
}
