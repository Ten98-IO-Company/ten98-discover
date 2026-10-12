import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, errMsg } from '../lib/api';

type InspectInfo = { workspaceName: string; email: string; role: string; expiresAt: string };
type AcceptResult = { workspaceId: string; created: boolean; email: string };

function is401(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

type InvitePanelProps = {
  token: string;
  signedInEmail: string | null;
  onAccepted: (email: string, created: boolean, workspaceId: string) => Promise<void>;
  onSignIn: () => void;
  onCancel: () => void;
  onUnauthorized: () => void;
};

export function InvitePanel(props: InvitePanelProps) {
  return <InvitePanelContent key={`${props.token}:${props.signedInEmail ?? ''}`} {...props} />;
}

function InvitePanelContent(props: InvitePanelProps) {
  const { token, signedInEmail, onSignIn, onCancel } = props;
  const [info, setInfo] = useState<InspectInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  const reqRef = useRef(0);
  const acRef = useRef<AbortController | null>(null);
  const unauthRef = useRef(props.onUnauthorized);
  useEffect(() => {
    unauthRef.current = props.onUnauthorized;
  });
  // Abort an in-flight accept submission on unmount.
  useEffect(() => () => acRef.current?.abort(), []);

  // Inspect the invitation; aborted and superseded on token change. The token is
  // only ever sent in a POST body — never stored, logged, or put in a URL.
  useEffect(() => {
    const id = ++reqRef.current;
    const ac = new AbortController();
    setInfo(null);
    setError(null);
    setPassword('');
    setNeedsSignIn(false);
    setLoading(true);
    api<InspectInfo>('/api/invitations/inspect', { method: 'POST', body: { token }, signal: ac.signal })
      .then(d => {
        if (id !== reqRef.current || ac.signal.aborted) return;
        setInfo(d);
        setLoading(false);
      })
      .catch(e => {
        if (id !== reqRef.current || ac.signal.aborted) return;
        setLoading(false);
        if (is401(e)) {
          unauthRef.current();
          return;
        }
        setError(errMsg(e));
      });
    return () => ac.abort();
  }, [token, reload]);

  const matched = !!info && !!signedInEmail && signedInEmail.toLowerCase() === info.email.toLowerCase();
  const mismatch = !!info && !!signedInEmail && !matched;

  function submitAccept(e: FormEvent) {
    e.preventDefault();
    if (busy || acRef.current || !info || mismatch || needsSignIn) return;
    const trimmedName = name.trim();
    if (!signedInEmail) {
      if (trimmedName.length < 1 || trimmedName.length > 120) {
        setError('Enter your name (1–120 characters).');
        return;
      }
      if (password.length < 12 || password.length > 128) {
        setError('Choose a password between 12 and 128 characters.');
        return;
      }
    }
    const ac = new AbortController();
    acRef.current = ac;
    setBusy(true);
    setError(null);
    const body = signedInEmail ? { token } : { token, name: trimmedName, password };
    api<AcceptResult>('/api/invitations/accept', { method: 'POST', body, signal: ac.signal })
      .then(res => {
        if (ac.signal.aborted) return;
        return props.onAccepted(res.email, res.created, res.workspaceId);
      })
      .catch(err => {
        if (ac.signal.aborted) return;
        if (is401(err)) {
          unauthRef.current();
          return;
        }
        if (err instanceof ApiError && err.status === 409) setNeedsSignIn(true);
        setError(`Could not accept the invitation: ${errMsg(err)}`);
      })
      .finally(() => {
        if (acRef.current === ac) {
          acRef.current = null;
          if (!ac.signal.aborted) setBusy(false);
        }
      });
  }

  if (loading) {
    return (
      <p role='status' className='dim'>
        Checking your invitation…
      </p>
    );
  }

  if (!info) {
    return (
      <div>
        <div className='alert' role='alert'>
          <p>
            <strong>This invitation link does not work.</strong> {error}
          </p>
          <p className='hint'>
            The link may have expired or already been used. Ask the person who invited you for a new one.
          </p>
        </div>
        <div className='row'>
          <button type='button' className='btn' onClick={() => setReload(k => k + 1)}>
            Try again
          </button>
          <button type='button' className='btn ghost' onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1>You’re invited to join {info.workspaceName}</h1>
      <p>
        This invitation is for <strong>{info.email}</strong> as <strong>{info.role}</strong> and expires on{' '}
        {formatDate(info.expiresAt)}.
      </p>

      {error && (
        <div className='alert' role='alert'>
          {error}
        </div>
      )}

      {mismatch || needsSignIn ? (
        <div>
          <div className='banner'>
            <p>
              {needsSignIn ? (
                <>Sign in as <strong>{info.email}</strong> to accept this invitation.</>
              ) : (
                <>You’re signed in as <strong>{signedInEmail}</strong>, but this invitation is for{' '}
                  <strong>{info.email}</strong>. Switch to the invited account to accept it.</>
              )}
            </p>
          </div>
          <div className='row'>
            <button type='button' className='btn primary' onClick={onSignIn}>
              {needsSignIn ? 'Sign in instead' : 'Switch account'}
            </button>
            <button type='button' className='btn' onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submitAccept} aria-busy={busy}>
          {signedInEmail ? (
            <p className='dim'>Signed in as {signedInEmail}.</p>
          ) : (
            <>
              <p>
                Create an account for <strong>{info.email}</strong> to accept this invitation.
              </p>
              <div className='field'>
                <label htmlFor='invite-name'>Your name</label>
                <input
                  id='invite-name'
                  value={name}
                  onChange={e => setName(e.target.value)}
                  autoComplete='name'
                  maxLength={120}
                  required
                  disabled={busy}
                />
                <p className='hint'>1–120 characters.</p>
              </div>
              <div className='field'>
                <label htmlFor='invite-password'>Password</label>
                <input
                  id='invite-password'
                  type='password'
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete='new-password'
                  minLength={12}
                  maxLength={128}
                  required
                  disabled={busy}
                />
                <p className='hint'>12–128 characters.</p>
              </div>
            </>
          )}
          <div className='row'>
            <button type='submit' className='btn primary' disabled={busy}>
              {busy
                ? signedInEmail
                  ? 'Joining…'
                  : 'Creating account…'
                : signedInEmail
                  ? 'Join workspace'
                  : 'Create account and join'}
            </button>
            <button type='button' className='btn' onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
          {!signedInEmail && (
            <p className='footnote'>
              Already have an account?{' '}
              <button type='button' className='btn ghost' onClick={onSignIn} disabled={busy}>
                Sign in instead
              </button>
            </p>
          )}
        </form>
      )}
    </div>
  );
}
