import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api, ApiError, errMsg } from '../lib/api'
import { AnalyticsPanel } from '../components/AnalyticsPanel'
import { ExplorerPanel } from '../components/ExplorerPanel'
import { AnalyticsSettingsPanel } from '../components/AnalyticsSettingsPanel'
import { DomainsPanel } from '../components/DomainsPanel'
import { ContextPanel } from '../components/ContextPanel'
import { PromptsPanel } from '../components/PromptsPanel'
import ReportsPanel from '../components/ReportsPanel'
import { TeamPanel, CreateWorkspaceForm } from '../components/TeamPanel'
import { InvitePanel } from '../components/InvitePanel'
import { AccountSecurityPanel } from '../components/AccountSecurityPanel'
import { ApiKeysPanel } from '../components/ApiKeysPanel'
import { ProviderPanel } from '../components/ProviderPanel'
import { RetentionPanel } from '../components/RetentionPanel'
import { DestinationsPanel } from '../components/DestinationsPanel'
import { OidcPanel } from '../components/OidcPanel'
import { OidcSignIn } from '../components/OidcSignIn'
import { OidcRecoveryPanel } from '../components/OidcRecoveryPanel'
import { GoogleReportsPanel } from '../components/GoogleReportsPanel'
import { GoogleAppPanel } from '../components/GoogleAppPanel'
import { KeywordResearchPanel } from '../components/KeywordResearchPanel'
import { SiteAuditPanel } from '../components/SiteAuditPanel'
import { allowedView, canonicalNavigation, navigationKey, parseCallback, parseNavigation, projectView as isProjectView } from '../lib/navigation'
import type { AppView, CallbackIntent, NavigationSearch } from '../lib/navigation'

export const Route = createFileRoute('/')({ validateSearch: parseNavigation, component: App })

type Status = { configured: boolean; appUrl: string }
type Workspace = { id: string; name: string; role: string }
type Me = { user: { id: string; name: string; email: string }; instanceOperator: boolean; workspaces: Workspace[] }
type Project = { id: string; name: string; origin: string; publicKey: string; eventCount: number; lastEventAt: string | null; retainedFrom: string | null }
type EventsData = { events: { id: string; eventName: string; path: string; origin: string; receivedAt: string }[]; total: number; retainedFrom: string | null }
type Job = { id: string; status: string; createdAt: string; completedAt: string | null; error: string | null }
type SetupValues = { token: string; name: string; email: string; password: string; workspaceName: string }

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
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const intent = useRef({ search, generation: 0 })
  const sessionGeneration = useRef(0)
  const bootGeneration = useRef(0)
  const currentMe = useRef<Me | null>(null)
  const loadedProjects = useRef<Project[] | null>(null)
  const projectsRequest = useRef<{ workspace: string; controller: AbortController } | null>(null)
  const callback = useRef<{ value: CallbackIntent; generation: number } | null>(null)
  const [navigationPending, setNavigationPending] = useState(true)
  const [phase, setPhase] = useState<'loading' | 'error' | 'setup' | 'signin' | 'factor' | 'app'>('loading')
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
  const [view, updateView] = useState<AppView>('project')
  const [menuOpen, setMenuOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  function showView(next: AppView) {
    updateView(next)
  }
  const [oidcProofId, setOidcProofId] = useState<string>()
  const [authNotice, setAuthNotice] = useState<{message: string; kind: 'info' | 'error'} | null>(null)
  const oidcProof = useRef<string | undefined>(undefined)
  const oidcFactor = useRef(false)
  const [inviteToken, setInviteToken] = useState('')
  const [inviteSigningIn, setInviteSigningIn] = useState(false)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const activeWorkspace = useRef('')
  const activeProject = useRef('')
  const wsGen = useRef(0)
  const projGen = useRef(0)

  function rememberIntent(next: NavigationSearch) {
    if (navigationKey(next) !== navigationKey(intent.current.search)) intent.current = { search: next, generation: intent.current.generation + 1 }
  }

  function go(next: NavigationSearch, replace = false) {
    if (!replace) setAppError('')
    rememberIntent(next)
    void navigate({ search: next, hash: '', replace })
  }

  function target(view: AppView, project = activeProject.current): NavigationSearch {
    return { ...(activeWorkspace.current ? { workspace: activeWorkspace.current } : {}), ...(project && view !== 'new-project' ? { project } : {}), view }
  }

  function applyCallback(m: Me) {
    const pending = callback.current
    callback.current = null
    if (!pending || pending.generation !== intent.current.generation) return
    if (pending.value.kind === 'proof') go({ ...intent.current.search, view: 'identity' }, true)
    if (pending.value.kind === 'google') {
      const value = pending.value
      if (m.workspaces.some(workspace => workspace.id === value.workspace)) go({ workspace: value.workspace, project: value.project, view: 'google' }, true)
      else setAuthNotice({ kind: 'error', message: 'Google reporting returned, but that workspace is no longer available. Choose a current workspace.' })
    }
  }

  useEffect(() => {
    // Runs before router loading, including Back/Forward. A -> B -> A still
    // invalidates old navigation completions even when the final URL matches.
    const unsubscribe = router.subscribe('onBeforeNavigate', event => {
      setMenuOpen(false)
      requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }))
      const next = parseNavigation(event.toLocation.search)
      if (navigationKey(next) !== navigationKey(intent.current.search)) setAppError('')
      rememberIntent(next)
    })
    let alive = true
    async function captureInvitation() {
      const value = parseCallback(window.location.hash)
      if (!value) return
      const generation = intent.current.generation
      callback.current = { value, generation }
      oidcProof.current = undefined; setOidcProofId(undefined); oidcFactor.current = false
      setInviteToken(''); setInviteSigningIn(false)
      if (value.kind === 'proof') { oidcProof.current = value.proof; setOidcProofId(value.proof) }
      else if (value.kind === 'factor') oidcFactor.current = true
      else if (value.kind === 'invite') setInviteToken(value.token)
      else if (value.kind === 'google') setAuthNotice({ kind: 'info', message: 'Google authorization returned. Review your connection and choose a property to import reports.' })
      else if (value.kind === 'google-error') setAuthNotice({ kind: 'error', message: 'Google reporting could not be connected. Start the connection again and grant read access.' })
      else if (value.kind === 'invalid' || value.kind === 'identity-error') setAuthNotice({ kind: 'error', message: 'The return link is invalid or ambiguous. Start the connection again, or reopen the original invitation.' })
      // Capabilities live only in memory. Let the router own its history entry.
      await navigate({ search: intent.current.search, hash: '', replace: true })
      if (alive && currentMe.current) applyCallback(currentMe.current)
    }
    const capture = () => { void captureInvitation() }
    window.addEventListener('hashchange', capture)
    const ac = new AbortController()
    void captureInvitation().then(() => { if (alive) void boot(ac.signal) })
    return () => { alive = false; ac.abort(); projectsRequest.current?.controller.abort(); unsubscribe(); window.removeEventListener('hashchange', capture) }
  }, [])

  useEffect(() => {
    rememberIntent(search)
    if (currentMe.current) applyNavigation(currentMe.current)
  }, [navigationKey(search)])

  async function boot(signal?: AbortSignal) {
    const session = sessionGeneration.current, generation = ++bootGeneration.current
    const current = () => !signal?.aborted && sessionGeneration.current === session && bootGeneration.current === generation
    try {
      const s = await api<Status>('/api/status', { signal })
      if (!current()) return
      setStatus(s)
      if (!s.configured) { setPhase('setup'); return }
      try {
        const m = await api<Me>('/api/me', { signal })
        if (current()) enterApp(m)
      } catch (e) {
        if (!current()) return
        if (e instanceof ApiError && e.status === 401) {
          if (oidcProof.current) {
            oidcProof.current = undefined; setOidcProofId(undefined)
            setAuthNotice({kind: 'error', message: 'The account session for this identity verification ended. Sign in, then start the verification again.'})
          }
          setPhase(oidcFactor.current ? 'factor' : 'signin')
        }
        else throw e
      }
    } catch (e) {
      if (!current()) return
      setPageError(errMsg(e))
      setPhase('error')
    }
  }

  function enterApp(m: Me) {
    oidcFactor.current = false
    currentMe.current = m; setMe(m)
    applyCallback(m)
    setPhase('app')
    applyNavigation(m)
  }

  function activateProject(id: string) {
    if (activeProject.current === id) return
    activeProject.current = id
    projGen.current += 1
    setProjectId(id)
    setEvents(null); setEventsError(''); setEventsBusy(false)
    setJobs(null); setJobError(''); setJobsBusy(false); setCheckBusy(false)
    setCopied('idle')
    if (id) { void loadEvents(id); void loadJobs(id) }
  }

  function changeWorkspace(id: string) {
    go({ ...(id ? { workspace: id } : {}), view: 'project' })
  }

  function applyNavigation(m: Me) {
    const requested = intent.current.search
    const workspace = m.workspaces.find(w => w.id === requested.workspace) ?? m.workspaces[0]
    const workspaceId = workspace?.id ?? ''
    const view = allowedView(requested.view, workspace?.role, m.instanceOperator) ? requested.view : 'project'
    if (requested.workspace && requested.workspace !== workspaceId) setAppError('That workspace is no longer available. Showing an accessible workspace.')
    else if (view !== requested.view) setAppError('That page is not available with your current access. Showing analytics instead.')
    if (activeWorkspace.current !== workspaceId) {
      projectsRequest.current?.controller.abort(); projectsRequest.current = null
      activeWorkspace.current = workspaceId; wsGen.current += 1
      setWorkspaceId(workspaceId); loadedProjects.current = null; setProjects(null); setProjectsError('')
      activateProject('')
    }
    showView(view)
    if (workspaceId && loadedProjects.current === null) {
      setNavigationPending(isProjectView(view))
      if (!projectsRequest.current) void loadProjects(workspaceId)
      return
    }
    const available = loadedProjects.current ?? []
    const sameWorkspace = !requested.workspace || requested.workspace === workspaceId
    const requestedProject = sameWorkspace ? available.find(p => p.id === requested.project) : undefined
    const project = view === 'new-project' ? undefined : requestedProject ?? (isProjectView(view) ? available[0] : undefined)
    if (requested.project && sameWorkspace && !requestedProject && view !== 'new-project') setAppError('That project is no longer available in this workspace. Choose a current project.')
    activateProject(project?.id ?? '')
    setNavigationPending(false)
    const resolved: NavigationSearch = { ...(workspaceId ? { workspace: workspaceId } : {}), ...(project ? { project: project.id } : {}), view }
    if (navigationKey(resolved) !== navigationKey(requested) || !canonicalNavigation(window.location.search, resolved)) go(resolved, true)
  }

  function resetSession() {
    sessionGeneration.current += 1; bootGeneration.current += 1
    callback.current = null
    oidcFactor.current = false; oidcProof.current = undefined; setOidcProofId(undefined)
    activeWorkspace.current = ''
    wsGen.current += 1
    projectsRequest.current?.controller.abort(); projectsRequest.current = null
    activateProject('')
    currentMe.current = null; loadedProjects.current = null
    setMe(null); setProjects(null); setWorkspaceId(''); setNavigationPending(true)
    setPhase('signin')
  }

  function guardAuth(e: unknown): boolean {
    if (e instanceof ApiError && e.status === 401) { resetSession(); return true }
    return false
  }

  async function loadProjects(wsId: string) {
    const gen = wsGen.current
    const session = sessionGeneration.current
    const controller = new AbortController()
    projectsRequest.current?.controller.abort()
    projectsRequest.current = { workspace: wsId, controller }
    const current = () => !controller.signal.aborted && activeWorkspace.current === wsId && wsGen.current === gen && sessionGeneration.current === session
    setProjectsError('')
    try {
      const d = await api<{ projects: Project[] }>(`/api/workspaces/${wsId}/projects`, { signal: controller.signal })
      if (current()) {
        loadedProjects.current = d.projects; setProjects(d.projects)
        if (currentMe.current) applyNavigation(currentMe.current)
      }
    } catch (e) {
      if (!current() || guardAuth(e)) return
      setProjectsError(errMsg(e))
      setNavigationPending(false)
    } finally {
      if (projectsRequest.current?.controller === controller) projectsRequest.current = null
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
    const gen = wsGen.current, session = sessionGeneration.current, navigation = intent.current.generation
    const current = () => activeWorkspace.current === wsId && wsGen.current === gen && sessionGeneration.current === session
    try {
      const d = await api<{ project: Project }>(`/api/workspaces/${wsId}/projects`, { method: 'POST', body: { name, origin } })
      if (!current()) return
      await loadProjects(wsId)
      if (current() && intent.current.generation === navigation) go({ workspace: wsId, project: d.project.id, view: 'project' })
    } catch (e) {
      if (!current() || guardAuth(e) || intent.current.generation !== navigation) return
      throw e
    }
  }

  async function handleSetup(v: SetupValues) {
    const session = ++sessionGeneration.current
    await api('/api/setup', { method: 'POST', body: v })
    if (sessionGeneration.current === session) await boot()
  }

  async function handleSignIn(email: string, password: string) {
    const session = ++sessionGeneration.current
    setAuthNotice(null)
    const response = await api<{ twoFactorRedirect?: boolean }>('/api/auth/sign-in/email', { method: 'POST', body: { email, password } })
    if (sessionGeneration.current !== session) return
    if (response.twoFactorRedirect) { setPhase('factor'); return }
    setPhase('loading'); setInviteSigningIn(false)
    await boot()
  }

  async function handleFactor(code: string, recovery: boolean) {
    const session = sessionGeneration.current
    await api(`/api/auth/two-factor/${recovery ? 'verify-backup-code' : 'verify-totp'}`, { method: 'POST', body: { code } })
    if (sessionGeneration.current !== session) return
    oidcFactor.current = false
    // A completed factor is single-use. Retry loading the session, never the consumed code.
    setPhase('loading'); setInviteSigningIn(false)
    await boot()
  }

  async function refreshMemberships(preferredId?: string, navigation = intent.current.generation) {
    const session = sessionGeneration.current, expectedUser = currentMe.current?.user.id
    try {
      const m = await api<Me>('/api/me')
      if (sessionGeneration.current !== session) return
      if (m.user.id !== expectedUser) { resetSession(); return }
      currentMe.current = m; setMe(m)
      if (preferredId && intent.current.generation === navigation && m.workspaces.some(w => w.id === preferredId)) go({ workspace: preferredId, view: 'project' })
      applyNavigation(m)
    } catch (e) { if (sessionGeneration.current === session && !guardAuth(e) && intent.current.generation === navigation) throw e }
  }

  async function invitationAccepted(email: string, _created: boolean, workspace: string) {
    const session = sessionGeneration.current, navigation = intent.current.generation
    setInviteToken(''); setInviteSigningIn(false)
    try {
      const m = await api<Me>('/api/me')
      if (sessionGeneration.current !== session) return
      if (intent.current.generation === navigation && m.workspaces.some(w => w.id === workspace)) go({ workspace, view: 'project' }, true)
      enterApp(m)
    }
    catch (e) {
      if (sessionGeneration.current !== session || intent.current.generation !== navigation) return
      if (e instanceof ApiError && e.status === 401) { setSignInEmail(email); resetSession() }
      else { setPageError(errMsg(e)); setPhase('error') }
    }
  }

  async function invitationSignIn() {
    try {
      if (me) {
        try { await api('/api/auth/sign-out', { method: 'POST', body: {} }) }
        catch (e) { if (!(e instanceof ApiError && e.status === 401)) throw e }
      }
      resetSession(); setInviteSigningIn(true)
    } catch (e) { setPageError(errMsg(e)); setPhase('error') }
  }

  async function signOut() {
    const session = sessionGeneration.current
    setSignOutBusy(true); setAppError('')
    try {
      await api('/api/auth/sign-out', { method: 'POST', body: {} })
      if (sessionGeneration.current !== session) return
      resetSession()
      go({ view: 'project' }, true)
    } catch (e) { if (sessionGeneration.current === session && !guardAuth(e)) setAppError(`Could not sign out: ${errMsg(e)}`) }
    finally { setSignOutBusy(false) }
  }

  async function copySnippet(text: string) {
    const gen = projGen.current
    try { await navigator.clipboard.writeText(text); if (projGen.current === gen) setCopied('copied') }
    catch { if (projGen.current === gen) setCopied('failed') }
  }

  const renderedSession = sessionGeneration.current, renderedIntent = intent.current.generation
  const unauthorized = () => { if (sessionGeneration.current === renderedSession) resetSession() }

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
  if (phase === 'factor') return <FactorForm onSubmit={handleFactor} onCancel={resetSession} />
  if (inviteToken && !inviteSigningIn) return <main className='center'><section className='card auth'><InvitePanel token={inviteToken} signedInEmail={me?.user.email ?? null}
    onAccepted={invitationAccepted} onSignIn={() => void invitationSignIn()} onCancel={() => setInviteToken('')} onUnauthorized={unauthorized} />
    {!me && <OidcSignIn key={inviteToken} invitationToken={inviteToken} />}</section></main>
  if (phase === 'signin') return <SignInForm initialEmail={signInEmail} onSignIn={handleSignIn} notice={authNotice}
    onCancel={inviteToken ? () => { sessionGeneration.current += 1; bootGeneration.current += 1; setInviteSigningIn(false) } : undefined} />

  const workspace = me?.workspaces.find((w) => w.id === workspaceId)
  const canWrite = workspace !== undefined && ['owner', 'admin', 'editor'].includes(workspace.role)
  const project = projects?.find((p) => p.id === projectId) ?? null
  const lastReceived = events !== null ? events.events[0]?.receivedAt ?? null : project?.lastEventAt ?? null
  const appUrl = (status?.appUrl ?? '').replace(/\/+$/, '')
  const snippet = project !== null ? `<script defer src="${appUrl}/tracker.js" data-site-key="${project.publicKey}" referrerpolicy="no-referrer"></script>` : ''
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(appUrl)
  const projectView = isProjectView(view)
  const pageTitles: Record<AppView, string> = {project: 'Web analytics', 'new-project': 'New project', reports: 'Reports', collection: 'Collection and privacy', destinations: 'Destinations', domains: 'Domains', installation: 'Install tracker', events: 'Recent events', team: 'Team', workspace: 'New workspace', security: 'Account security', identity: 'Identity sign-in', keys: 'API keys', providers: 'Providers and spending', retention: 'Data retention', context: 'Project context', prompts: 'Prompt library', explore: 'Explore analytics', google: 'Google reports', 'google-app': 'Google app setup', keywords: 'Keyword research', audits: 'Site audits'}
  const projectDescriptions: Partial<Record<AppView, string>> = {project: 'Understand how people find and use your website.', reports: 'Create reports and share a saved snapshot with your team or clients.', collection: 'Choose what your native analytics collects.', destinations: 'Manage your advertising and analytics tags from one snippet.', domains: 'Keep your serving domains and redirect aliases together.', installation: 'Connect your website with one lightweight snippet.', events: 'Inspect the latest events received from your website.', context: 'Keep your brand knowledge, competitors, key pages and research together.', prompts: 'Organize saved questions, review run costs and inspect model answers.', google: 'Import Search Console and GA4 reports without changing browser tracking.', explore: 'Break down events by campaign, page or property in your time zone.', keywords: 'Research keyword demand and ideas in your chosen market.', audits: 'Inspect your site’s pages, technical findings and link coverage.'}

  return (
    <div className='shell'>
      <aside className='side' aria-label='Application navigation'>
        <div className='brand-row'><p className='brand'><span className='brand-mark' aria-hidden='true'>98</span><span>ten98<span className='brand-product'>monitor</span></span></p>
          <button type='button' className='btn mobile-nav-toggle' aria-expanded={menuOpen} aria-controls='app-navigation' onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? 'Close menu' : 'Menu'}</button>
        </div>
        <div id='app-navigation' className={`side-body${menuOpen ? ' is-open' : ''}`}>
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
                  <Link to='/' search={target('project', p.id)} className={p.id === projectId ? 'proj active' : 'proj'} aria-current={p.id === projectId ? 'page' : undefined}>{p.name}</Link>
                </li>
              ))}
            </ul>
          )}
          {canWrite && <Link to='/' search={target('new-project')} className='btn ghost'>+ New project</Link>}
        </nav>
        {project && workspace && <nav aria-label='Project sections' className='section-nav'>
          <p className='side-label'>Measure</p>
          <Link className={view === 'project' ? 'proj active' : 'proj'} aria-current={view === 'project' ? 'page' : undefined} to='/' search={target('project')}>Analytics</Link>
          <Link className={view === 'explore' ? 'proj active' : 'proj'} aria-current={view === 'explore' ? 'page' : undefined} to='/' search={target('explore')}>Explore</Link>
          <Link className={view === 'events' ? 'proj active' : 'proj'} aria-current={view === 'events' ? 'page' : undefined} to='/' search={target('events')}>Recent events</Link>
          <Link className={view === 'reports' ? 'proj active' : 'proj'} aria-current={view === 'reports' ? 'page' : undefined} to='/' search={target('reports')}>Reports</Link>
          <Link className={view === 'google' ? 'proj active' : 'proj'} aria-current={view === 'google' ? 'page' : undefined} to='/' search={target('google')}>Google reports</Link>
          <Link className={view === 'audits' ? 'proj active' : 'proj'} aria-current={view === 'audits' ? 'page' : undefined} to='/' search={target('audits')}>Site audits</Link>
          <p className='side-label section-label'>Research</p>
          <Link className={view === 'context' ? 'proj active' : 'proj'} aria-current={view === 'context' ? 'page' : undefined} to='/' search={target('context')}>Context</Link>
          <Link className={view === 'prompts' ? 'proj active' : 'proj'} aria-current={view === 'prompts' ? 'page' : undefined} to='/' search={target('prompts')}>Prompts</Link>
          <Link className={view === 'keywords' ? 'proj active' : 'proj'} aria-current={view === 'keywords' ? 'page' : undefined} to='/' search={target('keywords')}>Keywords</Link>
          <p className='side-label section-label'>Connect</p>
          <Link className={view === 'installation' ? 'proj active' : 'proj'} aria-current={view === 'installation' ? 'page' : undefined} to='/' search={target('installation')}>Install tracker</Link>
          {['owner','admin'].includes(workspace.role) && <Link className={view === 'destinations' ? 'proj active' : 'proj'} aria-current={view === 'destinations' ? 'page' : undefined} to='/' search={target('destinations')}>Destinations</Link>}
          <Link className={view === 'collection' ? 'proj active' : 'proj'} aria-current={view === 'collection' ? 'page' : undefined} to='/' search={target('collection')}>Collection and privacy</Link>
          {['owner','admin'].includes(workspace.role) && <Link className={view === 'domains' ? 'proj active' : 'proj'} aria-current={view === 'domains' ? 'page' : undefined} to='/' search={target('domains')}>Domains</Link>}
        </nav>}
        <details className='workspace-tools' open={!projectView || !project}>
          <summary>Workspace settings</summary>
          <nav aria-label='Workspace settings'>
            {workspace && ['owner', 'admin'].includes(workspace.role) && <Link className={view === 'team' ? 'proj active' : 'proj'} to='/' search={target('team')}>Manage team</Link>}
            {workspace && ['owner', 'admin'].includes(workspace.role) && <Link className={view === 'keys' ? 'proj active' : 'proj'} to='/' search={target('keys')}>API keys</Link>}
            {workspace?.role === 'owner' && <Link className={view === 'providers' ? 'proj active' : 'proj'} to='/' search={target('providers')}>Providers and spending</Link>}
            {workspace && <Link className={view === 'retention' ? 'proj active' : 'proj'} to='/' search={target('retention')}>Data retention</Link>}
            <Link className={view === 'security' ? 'proj active' : 'proj'} to='/' search={target('security')}>Account security</Link>
            <Link className={view === 'identity' ? 'proj active' : 'proj'} to='/' search={target('identity')}>Identity sign-in</Link>
            {me?.instanceOperator && <Link className={view === 'google-app' ? 'proj active' : 'proj'} to='/' search={target('google-app')}>Google app setup</Link>}
            <Link className={view === 'workspace' ? 'proj active' : 'proj'} to='/' search={target('workspace')}>Create workspace</Link>
          </nav>
        </details>
        <div className='side-foot'>
          <p className='dim'>{me?.user.email}</p>
          <button className='btn' disabled={signOutBusy} onClick={() => void signOut()}>{signOutBusy ? 'Signing out…' : 'Sign out'}</button>
        </div>
        </div>
      </aside>
      <main className='main' ref={mainRef} tabIndex={-1}>
        <header className='app-bar'><div className='breadcrumbs'><span>{workspace?.name ?? 'Your workspace'}</span>{project && <><span aria-hidden='true'>/</span><strong>{project.name}</strong></>}</div><span className='preview-badge'>Development preview</span></header>
        <div className='page-content'>
        {authNotice && <div role={authNotice.kind === 'error' ? 'alert' : 'status'} className={authNotice.kind === 'error' ? 'alert' : 'notice'}>{authNotice.message} <button className='btn ghost' onClick={() => setAuthNotice(null)}>Dismiss</button></div>}
        {appError !== '' && <div role='alert' className='alert'>{appError}</div>}
        {projectsError !== '' && <div role='alert' className='alert'>{projectsError} <button className='btn' onClick={() => void loadProjects(activeWorkspace.current)}>Retry projects</button></div>}
        {navigationPending ? <p role='status'>Loading the selected project…</p> : <>
        {project && workspace && projectView && <header className='proj-head'>
          <p className='project-origin'>{project.origin}</p>
          <h1>{pageTitles[view]}</h1>
          <p className='dim'>{projectDescriptions[view]}</p>
        </header>}
        {view === 'workspace' && <section className='card'><h1>Create workspace</h1><p className='dim'>Keep each team’s projects and access separate.</p><CreateWorkspaceForm onCreated={async (id) => { if (sessionGeneration.current === renderedSession) await refreshMemberships(id, renderedIntent) }} onUnauthorized={unauthorized} /></section>}
        {view === 'team' && workspace && me && ['owner','admin'].includes(workspace.role) && <TeamPanel key={workspaceId} workspaceId={workspaceId} userId={me.user.id} onChanged={refreshMemberships} onUnauthorized={unauthorized} />}
        {view === 'security' && me && <><AccountSecurityPanel key={me.user.id} expectedUserId={me.user.id} onUnauthorized={unauthorized} /><Link className='btn' to='/' search={target('identity')}>Manage identity sign-in and recovery</Link></>}
        {view === 'identity' && me && <>
          <OidcRecoveryPanel key={me.user.id} userId={me.user.id} proofId={oidcProofId} onUnauthorized={unauthorized} onProofHandled={() => { oidcProof.current = undefined; setOidcProofId(undefined) }} />
          <OidcPanel key={`${me.user.id}:${me.instanceOperator}`} userId={me.user.id} instanceOperator={me.instanceOperator} proofId={oidcProofId} onUnauthorized={unauthorized} onProofHandled={() => { oidcProof.current = undefined; setOidcProofId(undefined) }} />
        </>}
        {view === 'keys' && workspace && me && ['owner','admin'].includes(workspace.role) && <ApiKeysPanel key={`${me.user.id}:${workspaceId}`} workspaceId={workspaceId} onUnauthorized={unauthorized} />}
        {view === 'providers' && workspace?.role === 'owner' && me && <ProviderPanel key={`${me.user.id}:${workspaceId}`} workspaceId={workspaceId} onUnauthorized={unauthorized} />}
        {view === 'retention' && workspace && me && <RetentionPanel workspaceId={workspaceId} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'collection' && project && me && <AnalyticsSettingsPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'explore' && project && me && <ExplorerPanel projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'context' && project && me && <ContextPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'prompts' && project && me && <PromptsPanel key={`${me.user.id}:${project.id}`} workspaceId={workspaceId} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'keywords' && project && me && <KeywordResearchPanel workspaceId={workspaceId} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'audits' && project && me && <SiteAuditPanel projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} onOpenDomains={() => go(target('domains'))} onOpenRetention={() => go(target('retention'))} />}
        {view === 'reports' && project && me && <ReportsPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'google' && project && me && <GoogleReportsPanel projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'google-app' && me?.instanceOperator && <GoogleAppPanel userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'domains' && project && workspace && me && ['owner','admin'].includes(workspace.role) && <DomainsPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'destinations' && project && workspace && me && ['owner','admin'].includes(workspace.role) && <>
          <DestinationsPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />
        </>}
        {view === 'project' && !workspace && <section className='card'><p>No workspace is linked to this account.</p><Link className='btn primary' to='/' search={target('workspace')}>Create workspace</Link></section>}
        {(view === 'new-project' || (view === 'project' && projects !== null)) && workspace && project === null && canWrite && (
          <section className='card onboarding-card' aria-labelledby='create-h'>
            <span className='eyebrow'>Website setup</span>
            <h1 id='create-h'>{projects !== null && projects.length > 0 ? 'Create a new project' : 'Connect your first website'}</h1>
            <p className='dim'>Keep your website analytics, tracking tags and reports together. Start with a name and the website you want to measure.</p>
            <CreateProjectForm key={workspaceId} onCreate={createProject} />
          </section>
        )}
        {view === 'project' && workspace && projects !== null && project === null && !canWrite && (
          <section className='card'>
            <h1>{projects.length ? 'Choose a project' : 'No project to show'}</h1>
            <p>{projects.length ? 'Select a project from the sidebar to view its analytics.' : 'Your role in this workspace is view-only. Ask a workspace admin to create a project or give you access to one.'}</p>
          </section>
        )}
        {view === 'project' && workspace && project !== null && (
          <>
            {events?.total === 0 && <section className='connection-callout'><div><strong>Ready when your website is.</strong><p>Add the tracking snippet to start collecting consented visits.</p></div><Link className='btn primary' to='/' search={target('installation')}>Connect website</Link></section>}
            <AnalyticsPanel key={project.id} projectId={project.id} onUnauthorized={unauthorized} />
          </>
        )}
        {view === 'events' && workspace && project !== null && (
            <section className='card' aria-labelledby='ev-h' aria-busy={eventsBusy}>
              <div className='row between'>
                <div>
                  <h2 id='ev-h'>Recent events</h2>
                  <p className='big-num'>{events !== null ? events.total : project.eventCount}</p>
                  <p className='dim'>Events currently retained</p>
                  {(events?.retainedFrom ?? project.retainedFrom) && <p className='hint'>History before {fmt((events?.retainedFrom ?? project.retainedFrom)!)} is unavailable after retention. This is not a lifetime total.</p>}
                  <p className='dim'>{lastReceived !== null ? `Last retained event received ${fmt(lastReceived)}` : 'No retained events available.'}</p>
                </div>
                <button className='btn' disabled={eventsBusy} onClick={() => void loadEvents(project.id)}>{eventsBusy ? 'Refreshing…' : 'Refresh events'}</button>
              </div>
              {eventsError !== '' && <div role='alert' className='alert'>{eventsError}</div>}
              {events === null && eventsError === '' && <p role='status' className='dim'>Loading events…</p>}
              {events !== null && events.events.length === 0 && (
                <div className='empty'>
                  <p><strong>No retained events available.</strong></p>
                  <p>Install your tracker on {project.origin}, allow analytics in Tracking preferences, then refresh this list. Counts include only retained events the collector has persisted.</p><Link className='btn' to='/' search={target('installation')}>Install tracker</Link>
                </div>
              )}
              {events !== null && events.events.length > 0 && (
                <>
                  <div className='table-wrap'>
                    <table>
                      <thead><tr><th scope='col'>Event</th><th scope='col'>Origin</th><th scope='col'>Path</th><th scope='col'>Received</th></tr></thead>
                      <tbody>
                        {events.events.map((ev) => (
                          <tr key={ev.id}><td>{ev.eventName}</td><td className='mono'>{ev.origin}</td><td className='mono'>{ev.path}</td><td className='mono'>{fmt(ev.receivedAt)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className='dim footnote'>Showing the latest {events.events.length} of {events.total} persisted events.</p>
                </>
              )}
            </section>
        )}
        {view === 'installation' && workspace && project !== null && (
          <>
            <section className='card' aria-labelledby='snip-h'>
              <h2 id='snip-h'>Install the tracker</h2>
              <p>Add this tag to the pages served from <strong>{project.origin}</strong> or a verified HTTPS serving domain configured under Domains:</p>
              <pre className='snippet'><code>{snippet}</code></pre>
              <div className='row'>
                <button className='btn' onClick={() => void copySnippet(snippet)}>Copy snippet</button>
                {copied === 'copied' && <p role='status' className='dim'>Copied to clipboard.</p>}
                {copied === 'failed' && <p role='alert' className='dim'>Copy failed — select the snippet text above and copy it manually.</p>}
              </div>
              <p className='dim footnote'>Install the snippet on the canonical origin or a verified HTTPS serving domain, choose analytics consent in Tracking preferences, then refresh events to confirm delivery. Earlier activity is discarded.{isLocal ? ' This app is running on a localhost URL (including [::1]), so external websites cannot reach the collector until it is deployed at a public HTTPS address.' : ''}</p>
              <p className='dim footnote'>After consent, page loads and SPA path changes are observed automatically. Call <code>window.ten98.track('signup', {'{'}plan: 'starter'{'}'})</code> for a custom event with optional properties. Use fixed event names and avoid personal data. Native page URLs omit queries and fragments; optional metadata follows Collection and privacy settings. Vendor tags have their own collection behavior.</p>
            </section>
            <details className='card diagnostics' aria-busy={checkBusy || jobsBusy}><summary>Background worker diagnostics</summary>
            <section aria-labelledby='wc-h'>
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
            </details>
          </>
        )}
        </>}
        <footer className='app-footer'><span>ten98-monitor · Self-hosted and open source</span><span>SEO, AI insights and platform data imports are still being built.</span></footer>
        </div>
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

function SignInForm({ initialEmail, onSignIn, onCancel, notice }: { initialEmail: string; onSignIn: (email: string, password: string) => Promise<void>; onCancel?: () => void; notice?: {message: string; kind: 'info' | 'error'} | null }) {
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
        <p className='auth-brand'>ten98 / monitor</p>
        <h1>Sign in</h1>
        {notice && <p className={notice.kind === 'error' ? 'alert' : 'notice'} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.message}</p>}
        <div className='field'><label htmlFor='si-email'>Email</label>
          <input id='si-email' type='email' autoComplete='email' required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className='field'><label htmlFor='si-pw'>Password</label>
          <input id='si-pw' type='password' autoComplete='current-password' required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {error !== '' && <div role='alert' className='alert'>{error}</div>}
        <button className='btn primary' disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {onCancel && <button type='button' className='btn' onClick={onCancel}>Back to invitation</button>}
        <OidcSignIn />
      </form>
    </main>
  )
}

function FactorForm({ onSubmit, onCancel }: { onSubmit: (code: string, recovery: boolean) => Promise<void>; onCancel: () => void }) {
  const [recovery, setRecovery] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked.current) return
    locked.current = true; setBusy(true); setError('')
    try { await onSubmit(code.trim(), recovery); setCode('') }
    catch (e) { setError(errMsg(e)) }
    finally { locked.current = false; setBusy(false) }
  }
  return <main className='center'><form className='card auth' onSubmit={event => void submit(event)}>
    <h1>Verify your sign-in</h1><p>{recovery ? 'Enter one unused recovery code. Each code can only be used once.' : 'Enter the six-digit code from your authenticator app.'}</p>
    <div className='field'><label htmlFor='factor-code'>{recovery ? 'Recovery code' : 'Authenticator code'}</label>
      <input id='factor-code' autoComplete='one-time-code' inputMode={recovery ? 'text' : 'numeric'} value={code} onChange={event => setCode(event.target.value)} maxLength={recovery ? 21 : 6} required disabled={busy} /></div>
    {error && <div className='alert' role='alert'>{error}</div>}
    <div className='row'><button className='btn primary' disabled={busy}>{busy ? 'Verifying…' : 'Verify'}</button>
      <button type='button' className='btn' disabled={busy} onClick={() => { setRecovery(!recovery); setCode(''); setError('') }}>{recovery ? 'Use authenticator' : 'Use a recovery code'}</button>
      <button type='button' className='btn ghost' disabled={busy} onClick={onCancel}>Back to sign in</button></div>
  </form></main>
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
