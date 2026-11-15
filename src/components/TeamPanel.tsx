import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { mayGrantWorkspaceRole, mayManageWorkspaceMember, type WorkspaceRole as Role } from '@ten98/runtime/browser';
import { Alert, Banner, Button, Card, DataTable, EmptyState, Field, Heading, Inline, Input, Select, Stack, Text, Textarea, useConfirmDialog, type DataColumn } from '@ten98/ui';
import { assignableRoles, defaultInviteRole, invitationExpiry, inviteResultText, inviteRoleOptions, roleLabel } from '../lib/team-roles';
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
  /** Absent from an older server; Resend email is then not offered and New link still works. */
  emailConfigured?: boolean;
};


function is401(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
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
  const [inviteRole, setInviteRole] = useState<Role>(defaultInviteRole);
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
  const inviteRoles = inviteRoleOptions(myRole);
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
        { method: 'POST', body: { email, role: inviteRoles.some(option => option.value === inviteRole) ? inviteRole : defaultInviteRole }, signal },
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
        <Text as='p' role='status' tone='muted'>
          Loading team…
        </Text>
      );
    }
    return (
      <Alert tone='danger' role='alert' actions={<Button type='button' variant='secondary' onClick={() => setReload(k => k + 1)}>Try again</Button>}>
        {error}
      </Alert>
    );
  }

  const solo = data.members.length === 1 && data.members[0].userId === userId;
  const memberColumns: DataColumn<Member>[] = [
    {
      key: 'name',
      header: 'Name',
      render: m => (
        <>
          {m.name}
          {m.userId === userId && <Text as='span' tone='muted'> (you)</Text>}
        </>
      ),
    },
    { key: 'email', header: 'Email', wrap: true, render: m => m.email },
    {
      key: 'role',
      header: 'Role',
      render: m => canManage && canManageMember(m) ? (
        <Select
          aria-label={`Role for ${m.name}`}
          value={m.role}
          disabled={busy}
          width='auto'
          onChange={e => changeRole(m, e.target.value as Role)}
          options={roleOptions.map(r => ({ value: r, label: roleLabel(r) }))}
        />
      ) : roleLabel(m.role),
    },
    ...(canManage ? [{
      key: 'actions',
      header: 'Actions',
      render: (m: Member) => canManageMember(m) ? (
        <Button type='button' variant='secondary' disabled={busy} onClick={() => void removeMember(m)}>
          Remove
        </Button>
      ) : null,
    }] : []),
  ];
  const invitationColumns: DataColumn<Invitation>[] = [
    { key: 'email', header: 'Email', wrap: true, render: inv => inv.email },
    { key: 'role', header: 'Role', render: inv => roleLabel(inv.role) },
    {
      key: 'expires',
      header: 'Expires',
      render: inv => <Text as='time' dateTime={inv.expiresAt} title={formatDate(inv.expiresAt)}>{invitationExpiry(inv.expiresAt)}</Text>,
    },
    ...(canManage ? [{
      key: 'actions',
      header: 'Actions',
      render: (inv: Invitation) => canManageInvite(inv) ? (
        <Inline gap={2} wrap>
          {data.emailConfigured === true && (
            <Button type='button' variant='secondary' disabled={busy} aria-label={`Resend email to ${inv.email}`} onClick={() => void confirmInviteAction({ kind: 'resend', invitation: inv })}>
              Resend email
            </Button>
          )}
          <Button type='button' variant='secondary' disabled={busy} aria-label={`New link for ${inv.email}`} onClick={() => void confirmInviteAction({ kind: 'new-link', invitation: inv })}>
            New link
          </Button>
          <Button type='button' variant='secondary' disabled={busy} onClick={() => revokeInvite(inv)}>
            Revoke
          </Button>
        </Inline>
      ) : null,
    }] : []),
  ];

  return (
    <Stack gap={4} aria-busy={busy || loading}>
      {loading && <Text as='p' tone='muted' role='status'>Refreshing team…</Text>}
      <Inline gap={3} align='center' justify='between'>
        <Stack gap={1}>
          <Heading level={2}>{data.workspace.name}</Heading>
          <Text as='p' tone='muted'>Your role: {roleLabel(data.role)}</Text>
        </Stack>
        <Button type='button' variant='secondary' disabled={busy} onClick={() => setReload(value => value + 1)}>Refresh team</Button>
      </Inline>

      {error && (
        <Alert tone='danger' role='alert'>
          {error}
        </Alert>
      )}

      <Card as='section' title='Members' headingLevel={2}>
        <Stack gap={3}>
          {canManage && inviteRoles.length > 0 && (
            <Stack as='form' gap={2} onSubmit={submitInvite} aria-label='Invite a member'>
              <Inline gap={2} align='end' wrap>
                <Field label='Email address' htmlFor='invite-email'>
                  <Input
                    id='invite-email'
                    type='email'
                    value={inviteEmail}
                    onChange={e => setInviteEmail(e.target.value)}
                    placeholder='name@example.com'
                    maxLength={254}
                    autoComplete='off'
                    required
                    disabled={busy}
                  />
                </Field>
                <Field label='Role' htmlFor='invite-role'>
                  <Select
                    id='invite-role'
                    value={inviteRole}
                    onChange={e => setInviteRole(e.target.value as Role)}
                    disabled={busy}
                    options={inviteRoles.map(option => ({ value: option.value, label: `${option.label} — ${option.description}` }))}
                  />
                </Field>
                <Button type='submit' disabled={busy || !inviteEmail.trim()}>Invite</Button>
              </Inline>
              <Text as='p' size='sm' tone='muted'>Invitation links expire after 7 days.</Text>
            </Stack>
          )}
          {inviteLink && (
            <Alert tone='info' role='status'>
              <Stack gap={2}>
                <Text as='p'>{inviteResultText(inviteLink)}{inviteLink.kind === 'create' ? '' : ' It expires after 7 days.'}</Text>
                <Inline gap={2} wrap>
                  <Button type='button' variant='secondary' onClick={() => void copyInvite()}>
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                  <Button type='button' variant='ghost' onClick={() => setInviteLink(null)}>
                    Dismiss
                  </Button>
                </Inline>
                <Textarea
                  readOnly
                  rows={3}
                  value={inviteLink.url}
                  aria-label='Invitation link'
                  onFocus={e => e.currentTarget.select()}
                />
                <Text as='p' size='sm' tone='muted'>
                  If copying does not work, select the link and copy it manually. For security it is only shown here,
                  once.
                </Text>
              </Stack>
            </Alert>
          )}
          {data.members.length === 0 ? (
            <EmptyState title='No members found.' description='People who join this workspace will appear here.' />
          ) : (
            <DataTable ariaLabel='Members' columns={memberColumns} rows={data.members} rowKey={m => m.userId} />
          )}
          {solo && <Text as='p' tone='muted'>You’re the only member. Invite people to share dashboards and reports.</Text>}
        </Stack>
      </Card>

      <Card as='section' title='Pending invitations' headingLevel={2}>
        <Stack gap={3}>
          {data.invitations.length === 0 ? (
            <EmptyState
              title='No pending invitations.'
              description={canManage
                ? 'Invite someone above to add them to this workspace.'
                : 'Invitations that have not been accepted yet will appear here.'}
            />
          ) : (
            <DataTable ariaLabel='Pending invitations' columns={invitationColumns} rows={data.invitations} rowKey={inv => inv.id} />
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
        </Stack>
      </Card>

      {canManage && (
        <Card as='section' title='Rename workspace' headingLevel={2}>
          <Stack as='form' gap={3} onSubmit={submitRename}>
            <Field label='Workspace name' htmlFor='ws-rename'>
              <Input
                id='ws-rename'
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={120}
                required
                disabled={busy}
              />
            </Field>
            <Inline gap={2}>
              <Button
                type='submit'
                disabled={busy || !name.trim() || name.trim() === data.workspace.name}
              >
                Rename workspace
              </Button>
            </Inline>
          </Stack>
        </Card>
      )}

      {myRole === 'owner' && (
        <Card as='section' title='Two-factor requirement' headingLevel={2}>
          <Stack gap={3}>
            {data.workspace.twoFactorRequired
              ? <Banner tone='warning' icon='shield' live>Members must turn on two-factor authentication before opening this workspace’s data.</Banner>
              : <Text as='p' id='two-factor-status' role='status'>Members can open this workspace without two-factor authentication.</Text>}
            <Inline gap={2}>
              <Button type='button' variant='secondary' aria-disabled={busy} aria-describedby={data.workspace.twoFactorRequired ? undefined : 'two-factor-status'} onClick={() => void toggleTwoFactor()}>
                {data.workspace.twoFactorRequired ? 'Stop requiring two-factor authentication' : 'Require two-factor authentication'}
              </Button>
            </Inline>
          </Stack>
        </Card>
      )}

      {myRole === 'owner' && (
        <Card as='section' title='Transfer your ownership' headingLevel={2}>
          <Stack gap={3}>
            <Text as='p'>Choose an existing member to become an owner. You will become an administrator and lose owner-only controls. Other owners keep their roles.</Text>
            <Stack as='form' gap={3} onSubmit={submitTransfer}>
              <Stack as='fieldset' gap={3} disabled={busy} aria-label='New workspace owner'>
                <Field label='New owner' htmlFor='transfer-owner'>
                  <Select
                    id='transfer-owner'
                    value={transferTo}
                    required
                    onChange={e => { setTransferTo(e.target.value); setTransferEmail(''); }}
                    options={[
                      { value: '', label: 'Choose a team member' },
                      ...data.members.filter(member => member.userId !== userId).map(member => ({ value: member.userId, label: `${member.name} (${member.email})` })),
                    ]}
                  />
                </Field>
                {transferTarget && (
                  <Field label={`Type ${transferTarget.email} to confirm`} htmlFor='transfer-confirm'>
                    <Input id='transfer-confirm' type='email' value={transferEmail} onChange={e => setTransferEmail(e.target.value)} maxLength={254} autoComplete='off' required aria-describedby='transfer-effect' />
                    <Text as='p' id='transfer-effect' size='sm' tone='muted'>{transferTarget.name} will control this workspace’s provider credentials, security and members. Your pending administrator invitations will be revoked.</Text>
                  </Field>
                )}
                <Inline gap={2}>
                  <Button variant='secondary' type='submit' disabled={busy || !transferTarget || transferEmail.trim().toLowerCase() !== transferTarget.email.toLowerCase()}>Transfer ownership and become administrator</Button>
                </Inline>
              </Stack>
            </Stack>
          </Stack>
        </Card>
      )}
      {confirmDialog}
    </Stack>
  );
}
