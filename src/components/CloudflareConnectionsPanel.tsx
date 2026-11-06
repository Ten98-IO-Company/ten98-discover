import {useEffect, useId, useRef, useState} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {Button, Field, Form, Heading, Inline, Input, Link, Stack, Text, Tooltip, useConfirmDialog} from '@ten98/ui';
import {api, ApiError} from '../lib/api';
import {cloudflareConnectionSave, cloudflareConnectionMutationResponse, cloudflareConnectionsResponse, cloudflareConnectionCheckResponse,
  type CloudflareConnectionMetadata, type CloudflareConnectionsResponse, type CloudflareConnectionCheckResponse} from '../lib/cloudflare-connections';

type Props = {projectId: string; userId: string; onUnauthorized: () => void};
type Attempt = {operation: 'save'; body: ReturnType<typeof cloudflareConnectionSave.parse>} |
  {operation: 'disconnect'; body: {requestId: string; connectionId: string; expectedRevision: number}};
export function CloudflareConnectionsPanel(props: Props) { return <Connections key={props.userId + ':' + props.projectId} {...props}/>; }
function Connections({projectId, onUnauthorized}: Props) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/cloudflare/connections`, uid = useId();
  const [data, setData] = useState<CloudflareConnectionsResponse | null>(null), [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState(''), [accountId, setAccountId] = useState(''), [token, setToken] = useState('');
  const [pending, setPending] = useState<Attempt | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false), [refreshFailed, setRefreshFailed] = useState(false);
  const [checks, setChecks] = useState<Record<string, CloudflareConnectionCheckResponse>>({}), [failedChecks, setFailedChecks] = useState<Record<string, number>>({});
  const [confirm, confirmDialog] = useConfirmDialog({danger: true});
  const mounted = useRef(true), operation = useRef<AbortController | null>(null), pendingRef = useRef<Attempt | null>(null), dataRef = useRef<CloudflareConnectionsResponse | null>(null);
  const callback = useRef(onUnauthorized); callback.current = onUnauthorized;
  const selected = data?.connections.find(row => row.id === editing), owner = data?.role === 'owner';
  const dirty = !!token || name !== (selected?.name ?? '') || accountId !== (selected?.accountId ?? '');
  const state = useRef({dirty, editing}); state.current = {dirty, editing};
  const blocked = busy || pending !== null || conflict || refreshFailed;
  function keep(value: Attempt | null) { pendingRef.current = value; setPending(value); }
  function clearForm() { setToken(''); setName(''); setAccountId(''); setEditing(null); }
  function purge() { operation.current?.abort(); operation.current = null; dataRef.current = null; keep(null); clearForm(); setData(null); setChecks({}); setFailedChecks({}); setBusy(false); setNotice(''); setConflict(false); }
  function denied(cause: unknown) {
    if (!(cause instanceof ApiError) || ![401, 403, 404].includes(cause.status)) return false;
    purge(); setError('Cloudflare connections are no longer available.'); if (cause.status === 401) callback.current(); return true;
  }
  function begin() { if (!mounted.current || operation.current) return null; const controller = new AbortController(); operation.current = controller; setBusy(true); setError(''); return controller; }
  function current(controller: AbortController) { return mounted.current && operation.current === controller && !controller.signal.aborted; }
  function finish(controller: AbortController) { if (current(controller)) { operation.current = null; setBusy(false); } }
  function validate(value: CloudflareConnectionsResponse) {
    if (value.projectId !== projectId || new Set(value.connections.map(row => row.id)).size !== value.connections.length || new Set(value.connections.map(row => row.accountId)).size !== value.connections.length) throw Error('Unmatched Cloudflare metadata');
  }
  function apply(value: CloudflareConnectionsResponse) {
    dataRef.current = value; setData(value); setRefreshFailed(false); setConflict(false);
    setChecks(previous => Object.fromEntries(Object.entries(previous).filter(([id, check]) => value.role === 'owner' && value.connections.some(row => row.id === id && row.revision === check.revision && row.accountId === check.accountId && row.state === 'configured'))));
    setFailedChecks(previous => Object.fromEntries(Object.entries(previous).filter(([id, revision]) => value.role === 'owner' && value.connections.some(row => row.id === id && row.revision === revision && row.state === 'configured'))));
    if (value.role !== 'owner') { keep(null); clearForm(); setNotice(''); }
  }
  async function load() {
    if (pendingRef.current) return; const controller = begin(); if (!controller) return;
    try { const value = cloudflareConnectionsResponse.parse(await api(base, {signal: controller.signal})); if (!current(controller)) return; validate(value); apply(value); clearForm(); }
    catch (cause) { if (current(controller) && !denied(cause)) { setRefreshFailed(true); setChecks({}); setFailedChecks({}); setError('Connections could not be refreshed. Retry refresh before making changes.'); } }
    finally { finish(controller); }
  }
  async function check(row: CloudflareConnectionMetadata, controller: AbortController) {
    setNotice('Checking access…'); setChecks(previous => { const next = {...previous}; delete next[row.id]; return next; });
    setFailedChecks(previous => { const next = {...previous}; delete next[row.id]; return next; });
    try {
      const result = cloudflareConnectionCheckResponse.parse(await api(base + '/check', {method: 'POST', body: {connectionId: row.id, expectedRevision: row.revision}, signal: controller.signal}));
      if (!current(controller)) return;
      const latest = dataRef.current?.connections.find(item => item.id === row.id);
      if (dataRef.current?.role !== 'owner' || result.projectId !== projectId || result.connectionId !== row.id || result.revision !== row.revision || result.accountId !== row.accountId || latest?.revision !== row.revision || latest.state !== 'configured') throw Error('Unmatched check');
      setChecks(previous => ({...previous, [row.id]: result})); setNotice('Access checked. Reporting data is not imported yet.');
    } catch (cause) {
      if (!current(controller) || denied(cause)) return;
      setNotice(''); setFailedChecks(previous => ({...previous, [row.id]: row.revision}));
      if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError('This connection changed. Reload the latest connection before checking again.'); }
      else setError('Access could not be checked. Your connection is saved. Review the token permissions and choose Check access to retry.');
    }
  }
  async function send(attempt: Attempt) {
    if (dataRef.current?.role !== 'owner' || pendingRef.current && pendingRef.current !== attempt) return;
    const controller = begin(); if (!controller) return; const captured = pendingRef.current ?? structuredClone(attempt); keep(captured); setToken(''); setNotice(captured.operation === 'save' ? 'Saving connection…' : 'Disconnecting…');
    try {
      const result = cloudflareConnectionMutationResponse.parse(await api(base + (captured.operation === 'disconnect' ? '/disconnect' : ''), {method: 'POST', body: captured.body, signal: controller.signal}));
      if (!current(controller)) return; validate(result);
      const ack = result.ack, row = result.connections.find(item => item.id === ack.connectionId);
      if (ack.requestId !== captured.body.requestId || ack.operation !== captured.operation || ack.revision !== captured.body.expectedRevision + 1 || captured.body.connectionId !== null && ack.connectionId !== captured.body.connectionId || !row || row.revision < ack.revision || captured.operation === 'save' && row.accountId !== captured.body.accountId) throw Error('Unmatched acknowledgement');
      if (row.revision === ack.revision && row.state !== (captured.operation === 'save' ? 'configured' : 'disconnected')) throw Error('Unmatched connection state');
      keep(null); apply(result); clearForm();
      if (result.role !== 'owner') return;
      setNotice(row.revision > ack.revision ? 'Original request confirmed. Showing the latest connection; check access explicitly.' : captured.operation === 'save' ? 'Connection saved.' : 'Connection disconnected.');
      if (captured.operation === 'save' && row.revision === ack.revision && row.state === 'configured') await check(row, controller);
    } catch (cause) {
      if (!current(controller) || denied(cause)) return; setNotice('');
      // A missing or mismatched acknowledgment is ambiguous; only its original request may be retried.
      if (!(cause instanceof ApiError) || cause.status === 0 || cause.status === 408 || cause.status === 429 || cause.status >= 500) setError('The response could not be confirmed. This action may already have succeeded. Retry the same request.');
      else { keep(null); if (cause.status === 409) { setConflict(true); setError('This connection changed. Reload and review it before continuing.'); } else setError('The connection could not be saved. Check the account details and enter the token again.'); }
    } finally { finish(controller); }
  }
  function save() {
    if (blocked || dataRef.current?.role !== 'owner' || !data?.vaultConfigured) return;
    const input = cloudflareConnectionSave.safeParse({requestId: crypto.randomUUID(), connectionId: selected?.id ?? null, expectedRevision: selected?.revision ?? 0, accountId: accountId.trim().toLowerCase(), name, apiToken: token});
    if (!input.success) { setError('Enter a name, a 32-character Account ID and an API token.'); return; } void send({operation: 'save', body: input.data});
  }
  async function disconnect(row: CloudflareConnectionMetadata) {
    if (blocked || dirty || dataRef.current?.role !== 'owner') return;
    if (!await confirm({title: 'Disconnect Cloudflare account?', description: 'The saved token will be removed. You can reconnect this account with a new token.', confirmLabel: 'Disconnect account'})) return;
    if (operation.current || pendingRef.current || dataRef.current?.role !== 'owner' || dataRef.current.connections.find(item => item.id === row.id)?.revision !== row.revision) return;
    void send({operation: 'disconnect', body: {requestId: crypto.randomUUID(), connectionId: row.id, expectedRevision: row.revision}});
  }
  async function edit(row: CloudflareConnectionMetadata) {
    if (blocked) return;
    if (state.current.dirty && !await confirm({title: 'Discard connection edits?', description: 'Your saved connection will stay as it is.', confirmLabel: 'Discard edits'})) return;
    setEditing(row.id); setName(row.name); setAccountId(row.accountId); setToken(''); setError(''); setNotice('');
  }
  async function refresh() {
    if (operation.current || pendingRef.current) return;
    if (state.current.dirty && !await confirm({title: 'Discard connection edits and refresh?', description: 'The latest saved connections will be shown.', confirmLabel: 'Refresh connections'})) return;
    setNotice(''); await load();
  }
  async function explicitCheck(row: CloudflareConnectionMetadata) { if (blocked || dirty || dataRef.current?.role !== 'owner') return; const controller = begin(); if (!controller) return; try { await check(row, controller); } finally { finish(controller); } }
  useBlocker({shouldBlockFn: () => pendingRef.current !== null || state.current.dirty && !window.confirm('Discard connection edits and leave?'), enableBeforeUnload: () => pendingRef.current !== null || state.current.dirty});
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; operation.current?.abort(); operation.current = null; pendingRef.current = null; dataRef.current = null; }; }, []);
  return <Stack gap={6}>
    <Stack gap={2}><Heading level={2}>Cloudflare Web Analytics</Heading><Text tone="muted">Connect an account to check Web Analytics access. Reporting data is not imported yet.</Text></Stack>
    <Inline wrap><Button variant="secondary" disabled={busy || pending !== null} onClick={() => void refresh()}>{conflict ? 'Reload latest connections' : refreshFailed ? 'Retry refresh' : 'Refresh connections'}</Button></Inline>
    {busy && !notice && <Text role="status">Loading connections…</Text>}{notice && <Text role="status">{notice}</Text>}{error && <Text role="alert">{error}</Text>}
    {pending && !busy && <Button onClick={() => void send(pending)}>Retry same request</Button>}
    {data && <Stack gap={5}>
      {!data.connections.length && <Text>Not connected</Text>}
      {data.connections.map(row => { const checked = checks[row.id], failed = failedChecks[row.id] === row.revision;
        return <Stack key={row.id} gap={2}>
          <Text weight="semibold">{row.name}</Text><Text size="sm">Account ID: {row.accountId}</Text>
          <Text>{row.state === 'disconnected' ? 'Disconnected' : checked ? 'Access checked' : failed ? 'Check failed. Connection saved.' : 'Configured. Access not checked.'}</Text>
          {checked && <Stack gap={1}><Text size="sm">Checked: {new Date(checked.checkedAt).toLocaleString()}</Text><Text>{checked.capabilities.enabled ? 'Analytics capability enabled.' : 'Analytics capability disabled for this account.'}</Text><Text>{checked.sites.length ? `${checked.sites.length} Web Analytics ${checked.sites.length === 1 ? 'site' : 'sites'} returned.` : 'No Web Analytics sites returned. This does not indicate zero traffic.'}</Text>
            {checked.sites.map(site => <Text key={site.site_tag} size="sm">{site.rules?.flatMap(rule => rule.host ? [rule.host] : []).join(', ') || `Site ${site.site_tag}`}</Text>)}
          </Stack>}
          {owner && <Inline wrap>{row.state === 'configured' && <Button variant="secondary" disabled={blocked || dirty} onClick={() => void explicitCheck(row)}>Check access</Button>}<Button variant="secondary" disabled={blocked} onClick={() => void edit(row)}>{row.state === 'disconnected' ? 'Reconnect account' : 'Replace token'}</Button>{row.state === 'configured' && <Button variant="ghost" disabled={blocked || dirty} onClick={() => void disconnect(row)}>Disconnect account</Button>}</Inline>}
        </Stack>;
      })}
      {owner ? <Stack gap={4}>
        <Heading level={3}>{selected ? selected.state === 'disconnected' ? 'Reconnect account' : 'Replace account token' : 'Connect account'}</Heading>
        {!data.vaultConfigured && <Text role="alert">Credential storage is unavailable. Contact your instance operator before connecting an account.</Text>}
        <Text size="sm">Create an API token restricted to this account with Account Analytics: Read and Account Settings: Read.</Text>
        <Inline wrap><Tooltip content="Account Analytics: Read reads the account’s available analytics fields. Account Settings: Read lists its Web Analytics sites."><Button variant="ghost">About required permissions</Button></Tooltip><Link href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">Create a Cloudflare API token</Link></Inline>
        <Form onSubmit={save} busy={busy} gap={4}>
        <Field label="Connection name" htmlFor={uid + '-name'}><Input id={uid + '-name'} value={name} disabled={blocked || !data.vaultConfigured} maxLength={120} onChange={event => setName(event.target.value)}/></Field>
        <Field label="Account ID" htmlFor={uid + '-account'}><Input id={uid + '-account'} value={accountId} disabled={blocked || !!selected || !data.vaultConfigured} maxLength={32} autoComplete="off" onChange={event => setAccountId(event.target.value)}/></Field>
        <Field label="API token" htmlFor={uid + '-token'} data-sensitive="true" data-rrweb-mask="true"><Input id={uid + '-token'} type="password" autoComplete="off" data-sensitive="true" data-rrweb-mask="true" value={token} disabled={blocked || !data.vaultConfigured} maxLength={4096} onChange={event => setToken(event.target.value)}/></Field>
        <Inline wrap><Button type="submit" disabled={blocked || !data.vaultConfigured}>{selected ? 'Save token and check access' : 'Connect account'}</Button>{selected && <Button type="button" variant="ghost" disabled={busy || pending !== null} onClick={clearForm}>Cancel edit</Button>}</Inline>
        </Form>
      </Stack> : <Text tone="muted">Only workspace owners can connect, check or disconnect Cloudflare accounts.</Text>}
    </Stack>}{confirmDialog}
  </Stack>;
}
