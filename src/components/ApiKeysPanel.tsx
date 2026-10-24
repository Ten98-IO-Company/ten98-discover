import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, CodeBlock, CopyButton, Dialog, Disclosure, EmptyState, Field, Fieldset, Heading, InlineCode, Input, RadioGroup, SecretField, Select, Stack, Tabs, Text, useConfirmDialog } from '@ten98/ui'
import type { ReactNode } from 'react'
import { api, ApiError, errMsg } from '../lib/api'
import { formatRelativeInstant } from '../lib/report-time'
import { accessLabel, apiKeyPresets, apiKeyScopeGroups, customLevelOptions, levelsFromScopes, mcpClientSnippets, scopesFromLevels } from '../lib/api-key-presets'
import type { AccessLevel, ApiKeyPresetId } from '../lib/api-key-presets'

interface ApiKey {
  id: string
  workspaceId: string
  issuerUserId: string
  name: string
  scopes: string[]
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  displayPrefix: string | null
  lastUsedAt: string | null
}

interface CreatedKey {
  key: ApiKey
  token: string
}

const expiryOptions = [{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '365 days' }]

/** `appUrl` is the installation's configured, trailing-slash-free public URL; the MCP endpoint is derived from it. */
export function ApiKeysPanel({ workspaceId, appUrl, onUnauthorized }: { workspaceId: string; appUrl: string; onUnauthorized: () => void }) {
  // key discards previous workspace state and one-time secrets synchronously on switch
  return <ApiKeysInner key={workspaceId} workspaceId={workspaceId} appUrl={appUrl} onUnauthorized={onUnauthorized} />
}

function ApiKeysInner({ workspaceId, appUrl, onUnauthorized }: { workspaceId: string; appUrl: string; onUnauthorized: () => void }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [confirm, confirmDialog] = useConfirmDialog({ danger: true })
  const [listError, setListError] = useState('')
  const [created, setCreated] = useState<CreatedKey | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const [preset, setPreset] = useState<ApiKeyPresetId>('reports-read')
  const [levels, setLevels] = useState<Record<string, AccessLevel>>(() => levelsFromScopes([]))
  const [days, setDays] = useState('90')
  const [formError, setFormError] = useState('')
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [client, setClient] = useState('claude-code')

  const alive = useRef(true)
  const reqSeq = useRef(0)
  const getAbort = useRef<AbortController | null>(null)
  const controllers = useRef<Set<AbortController>>(new Set())
  const mutLock = useRef(false) // synchronous lock: blocks duplicate mutations before React state lands
  const createdId = useRef<string | null>(null)
  const revealHeading = useRef<HTMLHeadingElement>(null)
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized
  const busy = loading || creating || revokingId !== null

  function applyCreated(c: CreatedKey | null) {
    createdId.current = c ? c.key.id : null
    setCreated(c)
  }

  function track(ac: AbortController) {
    controllers.current.add(ac)
    return () => controllers.current.delete(ac)
  }

  async function load() {
    const seq = ++reqSeq.current
    getAbort.current?.abort()
    const ac = new AbortController()
    getAbort.current = ac
    setLoading(true)
    const untrack = track(ac)
    try {
      const data = await api<{ keys: ApiKey[] }>(`/api/workspaces/${workspaceId}/api-keys`, { signal: ac.signal })
      if (!alive.current || ac.signal.aborted || seq !== reqSeq.current) return
      setKeys(data.keys)
      setListError('')
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      if (!alive.current || ac.signal.aborted || seq !== reqSeq.current) return
      handleHttpError(e, 'load')
    } finally {
      untrack()
      if (alive.current && !ac.signal.aborted && seq === reqSeq.current) setLoading(false)
    }
  }

  // 401 hands off to the app; 403/404 wipes cached privileged data and one-time secrets
  function handleHttpError(e: unknown, context: 'load' | 'mutation') {
    if (e instanceof ApiError && e.status === 401) {
      applyCreated(null)
      setDialogOpen(false)
      setKeys(null)
      unauthorized.current()
      return
    }
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
      setKeys(null)
      applyCreated(null)
      setDialogOpen(false)
      ++reqSeq.current
      getAbort.current?.abort()
      setLoading(false)
      setListError('You no longer have permission to manage API keys for this workspace. Retry to check your access again.')
      return
    }
    const msg = errMsg(e)
    if (context === 'load') setListError(msg)
    else setFormError(msg)
  }

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
      reqSeq.current++
      getAbort.current?.abort()
      for (const ac of controllers.current) ac.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The create form is replaced by the reveal, so move focus to its warning rather than leave it on a removed control.
  useEffect(() => { if (created) revealHeading.current?.focus() }, [created])

  function openCreate(initial: ApiKeyPresetId) {
    if (busy) return
    applyCreated(null)
    setName('')
    setPreset(initial)
    setLevels(levelsFromScopes(apiKeyPresets.find((p) => p.id === initial)?.scopes ?? []))
    setDays('90')
    setFormError('')
    setDialogOpen(true)
  }

  // Closing by Done, Escape, the backdrop or the close button discards the one-time secret for good.
  function closeDialog() {
    if (creating) return
    applyCreated(null)
    setDialogOpen(false)
  }

  function choosePreset(value: string) {
    const next = apiKeyPresets.find((p) => p.id === value)
    if (!next) return
    // Custom starts from the access of the preset it replaces, so switching keeps what was already chosen.
    if (next.scopes === null) setLevels(levelsFromScopes(apiKeyPresets.find((p) => p.id === preset)?.scopes ?? []))
    setPreset(next.id)
  }

  const chosenScopes = apiKeyPresets.find((p) => p.id === preset)?.scopes ?? scopesFromLevels(levels)

  async function createKey() {
    if (mutLock.current || loading || !keys) return
    const trimmed = name.trim()
    const d = Number(days)
    if (trimmed.length < 1 || trimmed.length > 80) {
      setFormError('Give the key a name between 1 and 80 characters.')
      return
    }
    if (chosenScopes.length === 0) {
      setFormError('Choose read or write access for at least one area so the key can do something.')
      return
    }
    if (![30, 90, 365].includes(d)) {
      setFormError('Choose when the key expires.')
      return
    }
    mutLock.current = true
    ++reqSeq.current
    getAbort.current?.abort()
    setCreating(true)
    setFormError('')
    applyCreated(null) // discard any previous one-time token before starting a new creation
    const ac = new AbortController()
    const untrack = track(ac)
    try {
      const data = await api<CreatedKey>(`/api/workspaces/${workspaceId}/api-keys`, {
        method: 'POST',
        body: { name: trimmed, scopes: [...chosenScopes], expiresInDays: d },
        signal: ac.signal,
      })
      if (!alive.current || ac.signal.aborted) return
      applyCreated(data)
      await load()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      if (!alive.current || ac.signal.aborted) return
      handleHttpError(err, 'mutation')
    } finally {
      untrack()
      mutLock.current = false
      if (alive.current && !ac.signal.aborted) setCreating(false)
    }
  }

  async function revokeKey(k: ApiKey) {
    if (mutLock.current || loading || !keys) return
    if (!await confirm({ title: `Revoke "${k.name}"?`, description: 'Anything using this key loses access immediately. This cannot be undone.', confirmLabel: 'Revoke key', confirmationText: k.name })) return
    if (mutLock.current) return
    mutLock.current = true
    ++reqSeq.current
    getAbort.current?.abort()
    setRevokingId(k.id)
    setFormError('')
    setListError('')
    const ac = new AbortController()
    const untrack = track(ac)
    try {
      await api<unknown>(`/api/workspaces/${workspaceId}/api-keys/${k.id}/revoke`, { method: 'POST', body: {}, signal: ac.signal })
      if (!alive.current || ac.signal.aborted) return
      if (createdId.current === k.id) applyCreated(null) // never keep a dead one-time secret on screen
      await load()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      if (!alive.current || ac.signal.aborted) return
      handleHttpError(err, 'mutation')
    } finally {
      untrack()
      mutLock.current = false
      if (alive.current && !ac.signal.aborted) setRevokingId(null)
    }
  }

  const relativeTime = (iso: string) => <Text as="time" dateTime={iso} title={new Date(iso).toLocaleString()}>{formatRelativeInstant(iso)}</Text>
  const keyCells = (k: ApiKey) => <>
    <td style={{ minWidth: '8rem', maxWidth: '18rem', overflowWrap: 'anywhere' }}>{k.name}</td>
    <td>
      {k.displayPrefix
        ? <InlineCode>{k.displayPrefix}…</InlineCode>
        : <Text as="span" size="sm" tone="muted">Created before prefixes were recorded</Text>}
    </td>
    <td>{accessLabel(k.scopes)}</td>
    <td>{k.lastUsedAt ? relativeTime(k.lastUsedAt) : <Text as="span" tone="muted">Never used</Text>}</td>
  </>
  const keyTable = (rows: ApiKey[], last: { label: string; cell: (k: ApiKey) => ReactNode }, actions: boolean) => (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Access</th>
            <th>Last used</th>
            <th>{last.label}</th>
            {actions && <th aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((k) => (
            <tr key={k.id}>
              {keyCells(k)}
              <td>{last.cell(k)}</td>
              {actions && (
                <td>
                  <Button variant="ghost" disabled={busy} loading={revokingId === k.id} onClick={() => void revokeKey(k)}>
                    {revokingId === k.id ? 'Revoking…' : 'Revoke'}
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  if (keys === null) return loading
    ? <p className="dim" role="status">Loading API keys…</p>
    : <div className="alert" role="alert"><p>{listError || 'API keys are unavailable. Try again.'}</p><button type="button" className="btn" disabled={busy} onClick={() => void load()}>Retry</button></div>

  const current = keys.filter((k) => !k.revokedAt)
  const revoked = keys.filter((k) => k.revokedAt)
  const serverUrl = `${appUrl}/api/mcp`
  const snippets = mcpClientSnippets(serverUrl)

  const dialogFooter = created
    ? <Button variant="primary" onClick={closeDialog}>Done</Button>
    : <>
      <Button variant="secondary" disabled={creating} onClick={closeDialog}>Cancel</Button>
      <Button variant="primary" type="submit" disabled={busy} loading={creating}>{creating ? 'Creating key…' : 'Create key'}</Button>
    </>

  return (
    <Stack gap={4}>
      <div>
        <Button variant="primary" disabled={busy} onClick={() => openCreate('reports-read')}>Create key</Button>
      </div>

      {listError !== '' && (
        <Alert tone="danger" actions={<Button variant="secondary" disabled={busy} onClick={() => void load()}>Retry</Button>}>{listError}</Alert>
      )}

      {current.length === 0 && revoked.length === 0
        ? <EmptyState title="No API keys yet. Create one to use the API or connect an AI tool." />
        : current.length === 0
          ? <Text tone="muted">No usable keys. Create one to use the API or connect an AI tool.</Text>
          : keyTable(current, { label: 'Expires', cell: (k) => new Date(k.expiresAt).getTime() <= Date.now() ? <Text as="span" tone="muted">Expired</Text> : <Text as="span" title={new Date(k.expiresAt).toLocaleString()}>{formatRelativeInstant(k.expiresAt)}</Text> }, true)}

      {revoked.length > 0 && (
        <Disclosure summary={`Revoked (${revoked.length})`}>
          {keyTable(revoked, { label: 'Revoked', cell: (k) => <Text as="span" tone="muted" title={new Date(k.revokedAt!).toLocaleString()}>{formatRelativeInstant(k.revokedAt!)}</Text> }, false)}
        </Disclosure>
      )}

      <Card title="Connect an AI tool with MCP" headingLevel={2} description="Point an MCP client at this server and send a key in the Authorization header.">
        <Stack gap={3}>
          <CodeBlock code={serverUrl} label="MCP server URL" copy />
          <div>
            <Button variant="secondary" disabled={busy} onClick={() => openCreate('mcp-read')}>Create MCP key</Button>
          </div>
          <Tabs label="MCP client" value={client} onValueChange={setClient} items={snippets.map((s) => ({
            value: s.id,
            label: s.label,
            content: <Stack gap={2}><Text tone="muted">{s.hint} Replace {'<your-key>'} with a key you created; keys cannot be shown again.</Text><CodeBlock code={s.code} language={s.language} label={`${s.label} setup`} copy /></Stack>,
          }))} />
          <Alert tone="warning">AI tools act with this key's scopes. Prefer read-only.</Alert>
        </Stack>
      </Card>

      <Stack gap={1}>
        <Text size="sm" tone="muted">Keys work in this workspace only. Every request checks its expiry, scopes, current workspace access and two-factor requirement. Existing keys can never be re-read — only created, revoked or replaced.</Text>
        <Text size="sm"><a href="/api/openapi.json" target="_blank" rel="noopener noreferrer">Open native API specification (JSON)</a></Text>
      </Stack>

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => { if (!next) closeDialog() }}
        closeDisabled={creating}
        title={created ? 'Copy your new key' : 'Create key'}
        footer={dialogFooter}
        onSubmit={created ? undefined : () => createKey()}
      >
        {created
          ? (
            <Stack gap={3}>
              <Alert tone="warning"><Heading level={3} size="sm" ref={revealHeading} tabIndex={-1}>Copy this key now. You won't see it again.</Heading></Alert>
              <SecretField label={`API key for ${created.key.name}`} value={created.token} />
              <CopyButton value={created.token} label="Copy" />
            </Stack>
          )
          : (
            <Stack gap={3}>
              <Field label="Name" htmlFor="ak-name" description="So you remember what uses this key. 1–80 characters.">
                <Input id="ak-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="Weekly report script" autoComplete="off" />
              </Field>
              <RadioGroup
                legend="Access"
                name="ak-preset"
                value={preset}
                onValueChange={choosePreset}
                disabled={creating}
                options={apiKeyPresets.map((p) => ({ value: p.id, label: p.label, description: p.description }))}
              />
              {preset === 'custom' && apiKeyScopeGroups.map((group) => (
                <Fieldset key={group.label} legend={group.label} disabled={creating}>
                  {group.rows.map((row) => (
                    <RadioGroup
                      key={row.id}
                      legend={row.label}
                      name={`ak-level-${row.id}`}
                      orientation="horizontal"
                      value={levels[row.id] ?? 'none'}
                      onValueChange={(value) => setLevels((prev) => ({ ...prev, [row.id]: value as AccessLevel }))}
                      options={customLevelOptions(row)}
                    />
                  ))}
                </Fieldset>
              ))}
              {preset === 'custom' && <Text size="sm" tone="muted">Write includes read for the same area.</Text>}
              <Field label="Expires" htmlFor="ak-days">
                <Select id="ak-days" value={days} onChange={(e) => setDays(e.target.value)} options={expiryOptions} disabled={creating} />
              </Field>
              {formError !== '' && <Alert tone="danger">{formError}</Alert>}
            </Stack>
          )}
      </Dialog>
      {confirmDialog}
    </Stack>
  )
}
