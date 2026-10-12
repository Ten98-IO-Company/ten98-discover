import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, errMsg } from '../lib/api';

type Role = 'owner' | 'admin' | 'editor' | 'viewer';

type Member = { userId: string; name: string; email: string; role: Role };
type Invitation = { id: string; email: string; role: Role; expiresAt: string };
type TeamData = {
  workspace: { id: string; name: string };
  role: Role;
  members: Member[];
  invitations: Invitation[];
};

const ALL_ROLES: readonly Role[] = ['owner', 'admin', 'editor', 'viewer'];
const INVITE_ROLES: readonly Role[] = ['admin', 'editor', 'viewer'];
const LIMITED_ROLES: readonly Role[] = ['editor', 'viewer'];

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setBusy] = useState(false);
  const busy = mutating || loading;
  const [reload, setReload] = useState(0);
  const [name, setName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('editor');
  const [inviteLink, setInviteLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

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
  const roleOptions = myRole === 'owner' ? ALL_ROLES : LIMITED_ROLES;
  const inviteRoles = myRole === 'owner' ? INVITE_ROLES : LIMITED_ROLES;

  function canManageMember(m: Member): boolean {
    if (!data) return false;
    if (data.role === 'owner') return true;
    return data.role === 'admin' && (m.role === 'editor' || m.role === 'viewer');
  }

  function canManageInvite(inv: Invitation): boolean {
    if (!data) return false;
    if (data.role === 'owner') return true;
    return data.role === 'admin' && (inv.role === 'editor' || inv.role === 'viewer');
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
      const res = await api<{ invitation: Invitation; inviteUrl: string }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
        { method: 'POST', body: { email, role: inviteRoles.includes(inviteRole) ? inviteRole : 'editor' }, signal },
      );
      return () => {
        setInviteLink({ email: res.invitation.email, url: res.inviteUrl });
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
      };
    });
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

  function removeMember(m: Member) {
    if (!window.confirm(`Remove ${m.name} (${m.email}) from this workspace? They will lose access immediately.`)) {
      return;
    }
    void runMutation(`Could not remove ${m.name}`, async signal => {
      await api<unknown>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(m.userId)}/remove`,
        { method: 'POST', body: {}, signal },
      );
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
        <h1>{data.workspace.name}</h1>
        <p className='dim'>Your role: {data.role}</p>
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
                          <button type='button' className='btn' disabled={busy} onClick={() => removeMember(m)}>
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
                          <button type='button' className='btn' disabled={busy} onClick={() => revokeInvite(inv)}>
                            Revoke
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

      {canManage && (
        <section className='card'>
          <h2>Invite someone</h2>
          <p className='dim'>
            No email is sent automatically — you will get a link to copy and share yourself. It expires after 7 days.
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
                <strong>Invitation created for {inviteLink.email}.</strong> Copy the link below and share it with them
                — no email was sent. It expires after 7 days.
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
    </div>
  );
}

export function CreateWorkspaceForm(props: {
  onCreated: (id: string) => Promise<void>;
  onUnauthorized: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acRef = useRef<AbortController | null>(null);
  const unauthRef = useRef(props.onUnauthorized);
  useEffect(() => {
    unauthRef.current = props.onUnauthorized;
  });
  useEffect(() => () => acRef.current?.abort(), []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (busy || acRef.current || trimmed.length < 1 || trimmed.length > 120) return;
    const ac = new AbortController();
    acRef.current = ac;
    setBusy(true);
    setError(null);
    api<{ workspace: { id: string; name: string; role: 'owner' } }>('/api/workspaces', {
      method: 'POST',
      body: { name: trimmed },
      signal: ac.signal,
    })
      .then(res => {
        if (ac.signal.aborted) return;
        return props.onCreated(res.workspace.id);
      })
      .catch(err => {
        if (ac.signal.aborted) return;
        if (is401(err)) {
          unauthRef.current();
          return;
        }
        setError(`Could not create the workspace: ${errMsg(err)}`);
      })
      .finally(() => {
        if (acRef.current === ac) {
          acRef.current = null;
          if (!ac.signal.aborted) setBusy(false);
        }
      });
  }

  const invalid = name.trim().length < 1 || name.trim().length > 120;

  return (
    <form onSubmit={submit} aria-busy={busy}>
      {error && (
        <div className='alert' role='alert'>
          {error}
        </div>
      )}
      <div className='field'>
        <label htmlFor='new-workspace-name'>Workspace name</label>
        <input
          id='new-workspace-name'
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={120}
          required
          disabled={busy}
          placeholder='e.g. Acme research'
        />
        <p className='hint'>1–120 characters.</p>
      </div>
      <button type='submit' className='btn primary' disabled={busy || invalid}>
        {busy ? 'Creating…' : 'Create workspace'}
      </button>
    </form>
  );
}
