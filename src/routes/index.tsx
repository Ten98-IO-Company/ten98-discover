import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

export const Route = createFileRoute('/')({ component: App })

type Status = { configured: boolean; appUrl: string }
type Workspace = { id: string; name: string; role: string }
type Me = { user: { id: string; name: string; email: string }; workspaces: Workspace[] }
type Project = { id: string; name: string; origin: string; publicKey: string; eventCount: number; lastEventAt: string | null }
type EventsData = { events: { id: string; eventName: string; path: string; receivedAt: string }[]; total: number }
type Job = { id: string; status: string; createdAt: string; completedAt: string | null; error: string | null }
type SetupValues = { token: string; name: string; email: string; password: string; workspaceName: string }

class ApiError extends Error { status = 0 }

async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e
    throw new ApiError('Network error. Check your connection, then try again.')
  }
  const text = await res.text()
  let data: unknown = null
  if (text !== '') { try { data = JSON.parse(text) } catch { data = null } }
  if (!res.ok) {
    const d = data as { error?: unknown; message?: unknown } | null
    const fromBody = d !== null ? (typeof d.error === 'string' ? d.error : typeof d.message === 'string' ? d.message : '') : ''
    const err = new ApiError(fromBody !== '' ? fromBody : res.status === 401 ? 'Your session has expired. Sign in again.' : `Request failed with status ${res.status}.`)
    err.status = res.status
    throw err
  }
  return data as T
}

function errMsg(e: unknown): string {
  return e instanceof Error && e.name !== 'AbortError' ? e.message : 'Something went wrong. Try again.'
}

function fmt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function parseOrigin(raw: string): { origin?: string; error?: string } {
  const input = raw.trim()
  if (input === '') return { error: 'Enter the website origin, for example https://example.com.' }
  let u: URL
  try { u = new URL(input) } catch { return { error: 'That is not a valid URL. Use an origin like https://example.com.' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Origin must use http:// or https://.' }
  if (u.username !== '' || u.password !== '') return { error: 'Origin must not include a username or password.' }
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '') return { error: 'Origin must be scheme, host and port only, with no path, query or fragment.' }
  return { origin: u.origin }
}

function pillClass(status: string): string {
  const s = status.toLowerCase()
  if (s.includes('fail') || s.includes('error') || s.includes('denied')) return 'pill bad'
  if (s.includes('success') || s.includes('complete') || s.includes('done')) return 'pill good'
  return 'pill'
}

function App() {
  const [phase, setPhase] = useState<'loading' | 'error' | 'setup' | 'signin' | 'app'>('loading')
  const [pageError, setPageError] = useState('')
  const [status, setStatus] = useState<Status | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [signInEmail, setSignInEmail] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [projectsError, setProjectsError] = useState('')
  const [projectId, setProjectId] = useState('')
  const [events, setEvents] = useState<EventsData | null>(null)
  const [eventsBusy, setEventsBusy] = useState(false)
  const [eventsError, setEventsError] = useState('')
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [jobsBusy, setJobsBusy] = useState(false)
  const [checkBusy, setCheckBusy] = useState(false)
  const [jobError, setJobError] = useState('')
  const [appError, setAppError] = useState('')
  const [signOutBusy, setSignOutBusy] = useState(false)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const activeWorkspace = useRef('')
  const activeProject = useRef('')
  const wsGen = useRef(0)
  const projGen = useRef(0)

  useEffect(() => {
    const ac = new AbortController()
    void boot(ac.signal)
    return () => ac.abort()
  }, [])

  async function boot(signal?: AbortSignal) {
    try {
      const s = await api<Status>('/api/status', { signal })
      if (signal?.aborted) return
      setStatus(s)
      if (!s.configured) { setPhase('setup'); return }
      try {
        const m = await api<Me>('/api/me', { signal })
        if (!signal?.aborted) enterApp(m)
      } catch (e) {
        if (signal?.aborted) return
        if (e instanceof ApiError && e.status === 401) setPhase('signin')
        else throw e
      }
    } catch (e) {
      if (signal?.aborted) return
      setPageError(errMsg(e))
      setPhase('error')
    }
  }

  function enterApp(m: Me) {
    setMe(m)
    const ws = m.workspaces[0]
    activeWorkspace.current = ws?.id ?? ''
    wsGen.current += 1
    setWorkspaceId(ws?.id ?? '')
    selectProject('')
    setProjects(null)
    setProjectsError('')
    setPhase('app')
    if (ws) void loadProjects(ws.id)
  }

  function selectProject(id: string) {
    activeProject.current = id
    projGen.current += 1
    setProjectId(id)
    setEvents(null); setEventsError(''); setEventsBusy(false)
    setJobs(null); setJobError(''); setJobsBusy(false); setCheckBusy(false)
    setCopied('idle')
  }

  function changeWorkspace(id: string) {
    activeWorkspace.current = id
    wsGen.current += 1
    setWorkspaceId(id)
    setProjects(null); setProjectsError('')
    selectProject('')
    void loadProjects(id)
  }

  function resetSession() {
    activeWorkspace.current = ''
    wsGen.current += 1
    selectProject('')
    setMe(null); setProjects(null); setWorkspaceId('')
    setPhase('signin')
  }

  function guardAuth(e: unknown): boolean {
    if (e instanceof ApiError && e.status === 401) { resetSession(); return true }
    return false
  }

  async function loadProjects(wsId: string) {
    const gen = wsGen.current
    setProjectsError('')
    try {
      const d = await api<{ projects: Project[] }>(`/api/workspaces/${wsId}/projects`)
      if (activeWorkspace.current === wsId && wsGen.current === gen) setProjects(d.projects)
    } catch (e) {
      if (activeWorkspace.current !== wsId || wsGen.current !== gen || guardAuth(e)) return
      setProjects([])
      setProjectsError(errMsg(e))
    }
  }

  async function loadEvents(pid: string) {
    const gen = projGen.current
    setEventsBusy(true); setEventsError('')
    try {
      const d = await api<EventsData>(`/api/projects/${pid}/events`)
      if (activeProject.current === pid && projGen.current === gen) setEvents(d)
    } catch (e) { if (activeProject.current === pid && projGen.current === gen && !guardAuth(e)) setEventsError(errMsg(e)) }
    finally { if (activeProject.current === pid && projGen.current === gen) setEventsBusy(false) }
  }

  async function loadJobs(pid: string) {
    const gen = projGen.current
    setJobsBusy(true); setJobError('')
    try {
      const d = await api<{ jobs: Job[] }>(`/api/projects/${pid}/jobs`)
      if (activeProject.current === pid && projGen.current === gen) setJobs(d.jobs)
    } catch (e) { if (activeProject.current === pid && projGen.current === gen && !guardAuth(e)) setJobError(errMsg(e)) }
    finally { if (activeProject.current === pid && projGen.current === gen) setJobsBusy(false) }
  }

  async function runCheck(pid: string) {
    const gen = projGen.current
    setCheckBusy(true); setJobError('')
    try {
      await api(`/api/projects/${pid}/check-worker`, { method: 'POST', body: { requestId: crypto.randomUUID() } })
      if (activeProject.current !== pid || projGen.current !== gen) return
      await loadJobs(pid)
    } catch (e) {
      if (activeProject.current !== pid || projGen.current !== gen || guardAuth(e)) return
      setJobError(errMsg(e))
    } finally { if (activeProject.current === pid && projGen.current === gen) setCheckBusy(false) }
  }

  async function createProject(name: string, origin: string) {
    const wsId = workspaceId
    const gen = wsGen.current
    try {
      const d = await api<{ project: Project }>(`/api/workspaces/${wsId}/projects`, { method: 'POST', body: { name, origin } })
      if (activeWorkspace.current !== wsId || wsGen.current !== gen) return
      await loadProjects(wsId)
      if (activeWorkspace.current !== wsId || wsGen.current !== gen) return
      selectProject(d.project.id)
      void loadEvents(d.project.id)
      void loadJobs(d.project.id)
    } catch (e) {
      if (guardAuth(e)) return
      if (activeWorkspace.current !== wsId || wsGen.current !== gen) return
      throw e
    }
  }

  async function handleSetup(v: SetupValues) {
    await api('/api/setup', { method: 'POST', body: v })
    enterApp(await api<Me>('/api/me'))
  }

  async function handleSignIn(email: string, password: string) {
    await api('/api/auth/sign-in/email', { method: 'POST', body: { email, password } })
    enterApp(await api<Me>('/api/me'))
  }

  async function signOut() {
    setSignOutBusy(true); setAppError('')
    try {
      await api('/api/auth/sign-out', { method: 'POST', body: {} })
      resetSession()
    } catch (e) { if (!guardAuth(e)) setAppError(`Could not sign out: ${errMsg(e)}`) }
    finally { setSignOutBusy(false) }
  }

  async function copySnippet(text: string) {
    const gen = projGen.current
    try { await navigator.clipboard.writeText(text); if (projGen.current === gen) setCopied('copied') }
    catch { if (projGen.current === gen) setCopied('failed') }
  }

  if (phase === 'loading') return <main className='center'><p role='status' className='dim'>Loading…</p></main>

  if (phase === 'error') {
    return (
      <main className='center'>
        <div className='card auth'>
          <div role='alert' className='alert'>{pageError}</div>
          <button className='btn primary' onClick={() => { setPhase('loading'); void boot() }}>Try again</button>
        </div>
      </main>
    )
  }

  if (phase === 'setup') return <OwnerForm onSetup={handleSetup} onSignInInstead={(email) => { setSignInEmail(email); setPhase('signin') }} />
  if (phase === 'signin') return <SignInForm initialEmail={signInEmail} onSignIn={handleSignIn} />

  const workspace = me?.workspaces.find((w) => w.id === workspaceId)
  const canWrite = workspace !== undefined && ['owner', 'admin', 'editor'].includes(workspace.role)
  const project = projects?.find((p) => p.id === projectId) ?? null
  const lastReceived = events !== null ? events.events[0]?.receivedAt ?? null : project?.lastEventAt ?? null
  const appUrl = (status?.appUrl ?? '').replace(/\/+$/, '')
  const snippet = project !== null ? `<script defer src="${appUrl}/tracker.js" data-site-key="${project.publicKey}"></script>` : ''
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(appUrl)

  return (
    <div className='shell'>
      <aside className='side'>
        <p className='brand'>ten98-monitor <span className='tag'>dev foundation</span></p>
        <div className='field'>
          <label htmlFor='ws'>Workspace</label>
          <select id='ws' value={workspaceId} onChange={(e) => changeWorkspace(e.target.value)}>
            {(me?.workspaces ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <nav aria-label='Projects'>
          <p className='side-label'>Projects</p>
          {projects === null && <p role='status' className='dim'>Loading…</p>}
          {projects !== null && projects.length === 0 && <p className='dim'>None yet.</p>}
          {projects !== null && projects.length > 0 && (
            <ul className='proj-list'>
              {projects.map((p) => (
                <li key={p.id}>
                  <button className={p.id === projectId ? 'proj active' : 'proj'} aria-current={p.id === projectId ? 'true' : undefined}
                    onClick={() => { selectProject(p.id); void loadEvents(p.id); void loadJobs(p.id) }}>{p.name}</button>
                </li>
              ))}
            </ul>
          )}
          {canWrite && <button className='btn ghost' onClick={() => selectProject('')}>+ New project</button>}
        </nav>
        <div className='side-foot'>
          <p className='dim'>{me?.user.email}</p>
          <button className='btn' disabled={signOutBusy} onClick={() => void signOut()}>{signOutBusy ? 'Signing out…' : 'Sign out'}</button>
        </div>
      </aside>
      <main className='main'>
        <p className='banner' role='note'><strong>Development foundation.</strong> SEO, AI insights, data imports and OIDC sign-in are planned but not available yet. Everything shown here works against live data.</p>
        {appError !== '' && <div role='alert' className='alert'>{appError}</div>}
        {projectsError !== '' && <div role='alert' className='alert'>{projectsError}</div>}
        {!workspace && <section className='card'><p>No workspace is linked to this account.</p></section>}
        {workspace && project === null && canWrite && (
          <section className='card' aria-labelledby='create-h'>
            <h1 id='create-h'>{projects !== null && projects.length > 0 ? 'New project' : 'Create your first project'}</h1>
            <CreateProjectForm key={workspaceId} onCreate={createProject} />
          </section>
        )}
        {workspace && project === null && !canWrite && (
          <section className='card'>
            <h1>No project to show</h1>
            <p>Your role in this workspace is view-only. Ask a workspace admin to create a project or give you access to one.</p>
          </section>
        )}
        {workspace && project !== null && (
          <>
            <header className='proj-head'>
              <h1>{project.name}</h1>
              <p className='dim mono'>{project.origin}</p>
            </header>
            <section className='card' aria-labelledby='ev-h' aria-busy={eventsBusy}>
              <div className='row between'>
                <div>
                  <h2 id='ev-h'>Page views</h2>
                  <p className='big-num'>{events !== null ? events.total : project.eventCount}</p>
                  <p className='dim'>{lastReceived !== null ? `Last received ${fmt(lastReceived)}` : 'Nothing received yet.'}</p>
                </div>
                <button className='btn' disabled={eventsBusy} onClick={() => void loadEvents(project.id)}>{eventsBusy ? 'Refreshing…' : 'Refresh events'}</button>
              </div>
              {eventsError !== '' && <div role='alert' className='alert'>{eventsError}</div>}
              {events === null && eventsError === '' && <p role='status' className='dim'>Loading events…</p>}
              {events !== null && events.events.length === 0 && (
                <div className='empty'>
                  <p><strong>No page views recorded yet.</strong></p>
                  <p>Install the snippet below on {project.origin}, open a page on that site, then choose Refresh events. Counts include only events the collector has persisted.</p>
                </div>
              )}
              {events !== null && events.events.length > 0 && (
                <>
                  <div className='table-wrap'>
                    <table>
                      <thead><tr><th scope='col'>Event</th><th scope='col'>Path</th><th scope='col'>Received</th></tr></thead>
                      <tbody>
                        {events.events.map((ev) => (
                          <tr key={ev.id}><td>{ev.eventName}</td><td className='mono'>{ev.path}</td><td className='mono'>{fmt(ev.receivedAt)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className='dim footnote'>Showing the latest {events.events.length} of {events.total} persisted events.</p>
                </>
              )}
            </section>
            <section className='card' aria-labelledby='snip-h'>
              <h2 id='snip-h'>Install the tracker</h2>
              <p>Add this tag to the pages served from <strong>{project.origin}</strong>:</p>
              <pre className='snippet'><code>{snippet}</code></pre>
              <div className='row'>
                <button className='btn' onClick={() => void copySnippet(snippet)}>Copy snippet</button>
                {copied === 'copied' && <p role='status' className='dim'>Copied to clipboard.</p>}
                {copied === 'failed' && <p role='alert' className='dim'>Copy failed — select the snippet text above and copy it manually.</p>}
              </div>
              <p className='dim footnote'>Install the snippet on {project.origin}, visit a page, then refresh events to confirm delivery.{isLocal ? ' This app is running on a localhost URL (including [::1]), so external websites cannot reach the collector until it is deployed at a public HTTPS address.' : ''}</p>
            </section>
            <section className='card' aria-labelledby='wc-h' aria-busy={checkBusy || jobsBusy}>
              <div className='row between'>
                <h2 id='wc-h'>Worker check</h2>
                <div className='row'>
                  {canWrite && <button className='btn primary' disabled={checkBusy} onClick={() => void runCheck(project.id)}>{checkBusy ? 'Starting…' : 'Run worker check'}</button>}
                  <button className='btn' disabled={jobsBusy} onClick={() => void loadJobs(project.id)}>{jobsBusy ? 'Refreshing…' : 'Refresh status'}</button>
                </div>
              </div>
              <p className='dim'>Checks whether the background worker can receive and complete a job. Choose Refresh status to see its result.</p>
              {jobError !== '' && <div role='alert' className='alert'>{jobError}</div>}
              {jobs === null && jobError === '' && <p role='status' className='dim'>Loading checks…</p>}
              {jobs !== null && jobs.length === 0 && <div className='empty'><p><strong>No checks yet.</strong> A worker check enqueues an internal job; once the separate worker finishes it, the result appears here.</p></div>}
              {jobs !== null && jobs.length > 0 && (
                <ul className='jobs'>
                  {jobs.slice(0, 5).map((j) => (
                    <li key={j.id}>
                      <span className={pillClass(j.status)}>{j.status}</span>
                      <span className='mono dim'>{fmt(j.createdAt)}</span>
                      {j.error !== null && j.error !== '' && <span className='err-text'>{j.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  )
}

function OwnerForm({ onSetup, onSignInInstead }: { onSetup: (v: SetupValues) => Promise<void>; onSignInInstead: (email: string) => void }) {
  const [token, setToken] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ownerExists, setOwnerExists] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setOwnerExists(false)
    try {
      await onSetup({ token: token.trim(), name: name.trim(), email: email.trim(), password, workspaceName: workspaceName.trim() })
      setToken(''); setPassword('')
    } catch (err) {
      const m = errMsg(err)
      if (err instanceof ApiError && err.status === 409) setOwnerExists(true)
      setError(m)
    } finally { setBusy(false) }
  }

  return (
    <main className='center'>
      <form className='card auth' onSubmit={(e) => void submit(e)}>
        <h1>Secure this installation</h1>
        <p className='dim'>Create the owner account and its default workspace. The setup token comes from your server configuration.</p>
        <div className='field'><label htmlFor='su-token'>Setup token</label>
          <input id='su-token' type='password' autoComplete='off' required value={token} onChange={(e) => setToken(e.target.value)} /></div>
        <div className='field'><label htmlFor='su-name'>Your name</label>
          <input id='su-name' autoComplete='name' required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className='field'><label htmlFor='su-email'>Email</label>
          <input id='su-email' type='email' autoComplete='email' required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className='field'><label htmlFor='su-pw'>Password</label>
          <input id='su-pw' type='password' autoComplete='new-password' minLength={12} maxLength={128} required value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className='hint'>At least 12 characters.</p></div>
        <div className='field'><label htmlFor='su-ws'>Workspace name</label>
          <input id='su-ws' autoComplete='organization' required maxLength={120} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} /></div>
        {error !== '' && <div role='alert' className='alert'>{error}</div>}
        {ownerExists && <p className='row'><button type='button' className='btn' onClick={() => onSignInInstead(email.trim())}>Sign in instead</button></p>}
        <button className='btn primary' disabled={busy}>{busy ? 'Creating…' : 'Create owner account'}</button>
      </form>
    </main>
  )
}

function SignInForm({ initialEmail, onSignIn }: { initialEmail: string; onSignIn: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await onSignIn(email.trim(), password)
      setPassword('')
    } catch (err) { setError(errMsg(err)) }
    finally { setBusy(false) }
  }

  return (
    <main className='center'>
      <form className='card auth' onSubmit={(e) => void submit(e)}>
        <h1>Sign in</h1>
        <div className='field'><label htmlFor='si-email'>Email</label>
          <input id='si-email' type='email' autoComplete='email' required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className='field'><label htmlFor='si-pw'>Password</label>
          <input id='si-pw' type='password' autoComplete='current-password' required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {error !== '' && <div role='alert' className='alert'>{error}</div>}
        <button className='btn primary' disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  )
}

function CreateProjectForm({ onCreate }: { onCreate: (name: string, origin: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [origin, setOrigin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    const n = name.trim()
    if (n === '') { setError('Enter a project name.'); return }
    const parsed = parseOrigin(origin)
    if (!parsed.origin) { setError(parsed.error ?? 'Enter a valid origin.'); return }
    setBusy(true); setError('')
    try {
      await onCreate(n, parsed.origin)
      setName(''); setOrigin('')
    } catch (err) { setError(errMsg(err)) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className='field'><label htmlFor='pn'>Project name</label>
        <input id='pn' autoComplete='off' required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className='field'><label htmlFor='po'>Website origin</label>
        <input id='po' inputMode='url' autoComplete='off' placeholder='https://example.com' required value={origin} onChange={(e) => setOrigin(e.target.value)} />
        <p className='hint'>Scheme and host only, no path. The collector matches incoming events against this origin.</p></div>
      {error !== '' && <div role='alert' className='alert'>{error}</div>}
      <button className='btn primary' disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button>
    </form>
  )
}
