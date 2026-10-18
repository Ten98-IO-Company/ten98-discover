import { Brand, Icon } from '../components/CampaignUI'
import { AuthLayout } from '../components/AuthLayout'
import { createFileRoute, Link, useRouter, useLocation } from '@tanstack/react-router'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { api, ApiError, errMsg } from '../lib/api'
import { AnalyticsPanel, analyticsExplorerQuery } from '../components/AnalyticsPanel'
import { RealtimePanel } from '../components/RealtimePanel'
import { WebPerformancePanel } from '../components/WebPerformancePanel'
import { SessionReplayPanel } from '../components/SessionReplayPanel'
import {TrackedAssetsPanel,SharedTrackedAssetPanel} from '../components/TrackedAssetsPanel'
import { BoardsPanel } from '../components/BoardsPanel'
import { HeatmapsPanel } from '../components/HeatmapsPanel'
import { SessionExplorerPanel } from '../components/SessionExplorerPanel'
import { JourneysPanel } from '../components/JourneysPanel'
import { RevenuePanel } from '../components/RevenuePanel'
import { AISearchPanel } from '../components/AISearchPanel'
import { AttributionPanel } from '../components/AttributionPanel'
import { RetentionReportPanel } from '../components/RetentionReportPanel'
import { ExplorerPanel, explorerAnalyticsNavigation, readExplorerReturn } from '../components/ExplorerPanel'
import { UtmPanel } from '../components/UtmPanel'
import { AnalyticsSettingsPanel } from '../components/AnalyticsSettingsPanel'
import { DomainsPanel } from '../components/DomainsPanel'
import { ContextPanel } from '../components/ContextPanel'
import { PromptsPanel } from '../components/PromptsPanel'
import { AIInsightsPanel } from '../components/AIInsightsPanel'
import { PromptExecutionsPanel, type ExecutionEntry } from '../components/PromptExecutionsPanel'
import ReportsPanel from '../components/ReportsPanel'
import { TeamPanel, CreateWorkspaceForm } from '../components/TeamPanel'
import { InvitePanel } from '../components/InvitePanel'
import { AccountSecurityPanel } from '../components/AccountSecurityPanel'
import { PasswordRecoveryPanel, type PasswordRecovery } from '../components/PasswordRecoveryPanel'
import { AccountPreferencesPanel } from '../components/AccountPreferencesPanel'
import { AccountPresentationContext, requestAccountPreferences } from '../lib/account-presentation'
import type { AccountPreferencesDto } from '../lib/account-preferences'
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
import {DomainResearchPanel} from '../components/DomainResearchPanel'
const RankTrackingPanel = lazy(() =>
  import('../components/RankTrackingPanel')
    .then((module) => ({ default: module.RankTrackingPanel }))
    .catch(() => ({ default: RankTrackingLoadFailed }))
)

function RankTrackingLoadFailed() {
  return (
    <div role="alert">
      <p>Rank tracking couldn’t load. Reload this page to try again.</p>
      <button className="btn" type="button" style={{ minHeight: 44 }} onClick={() => window.location.reload()}>Reload page</button>
    </div>
  )
}
import { SiteAuditPanel } from '../components/SiteAuditPanel'
import { ConversionsPanel } from '../components/ConversionsPanel'
import { aiSearchIntentQuery, readAISearchIntent, analyticsNavigation, explorerNavigation, auditNavigation, retentionNavigation, allowedView, canonicalNavigation, navigationId, navigationKey, parseCallback, parsePasswordResetFragment, parseNavigation, resolveNavigation, projectView as isProjectView } from '../lib/navigation'
import type { AppView, CallbackIntent, NavigationSearch } from '../lib/navigation'

export const Route = createFileRoute('/')({ validateSearch: parseNavigation, component: RouteEntry })

function RouteEntry(){
  const location=useLocation(),raw=new URLSearchParams(location.searchStr)
  // Router normalizes duplicate/JSON view values; public-share intent must never boot private APIs.
  const shared=raw.getAll('view').some(value=>value.includes('tracked-share'))
  return shared?<SharedTrackedAssetPanel search={location.searchStr} fragment={location.hash} entry={location.state.__TSR_key??location.href}/>:<App/>
}

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
  const routeLocation = useLocation()
  const intent = useRef({ search, generation: 0 })
  const sessionGeneration = useRef(0)
  const bootGeneration = useRef(0)
  const currentMe = useRef<Me | null>(null)
  const loadedProjects = useRef<Project[] | null>(null)
  const projectsRequest = useRef<{ workspace: string; controller: AbortController } | null>(null)
  const callback = useRef<{ value: CallbackIntent; generation: number } | null>(null)
  const [navigationPending, setNavigationPending] = useState(true)
  const [phase, setPhase] = useState<'loading' | 'error' | 'setup' | 'signin' | 'factor' | 'recovery' | 'app'>('loading')
  const recoveryRef = useRef<PasswordRecovery | null>(null), recoveryGeneration = useRef(0)
  const [recovery, setRecovery] = useState<{ value: PasswordRecovery; generation: number } | null>(null)
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
  const [analyticsApplied,setAnalyticsApplied]=useState<{userId:string;projectId:string;from:string;to:string;explorerEntry?:string}|null>(null)
  const rememberAnalyticsRange=useCallback((userId:string,projectId:string,range:{from:string;to:string},explorerEntry?:string)=>setAnalyticsApplied(previous=>previous?.userId===userId&&previous.projectId===projectId&&previous.from===range.from&&previous.to===range.to&&previous.explorerEntry===explorerEntry?previous:{userId,projectId,...range,explorerEntry}),[])
  const [accountPreferences,setAccountPreferences]=useState<{data:AccountPreferencesDto|null;loading:boolean;error:string}>({data:null,loading:false,error:''})
  const preferencesRequest=useRef<AbortController|null>(null)
  const preferencesGeneration=useRef(0)
  const preferencesEntry=useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [toolSearch, setToolSearch] = useState('')
  const menuButton = useRef<HTMLButtonElement>(null)
  const menuWasOpen = useRef(false)
  useEffect(() => { const media=window.matchMedia('(min-width:761px)'), hiddenSearch=window.matchMedia('(max-width:960px)'); const close=()=>{if(media.matches)setMenuOpen(false);if(hiddenSearch.matches)setToolSearch('')};media.addEventListener('change',close);hiddenSearch.addEventListener('change',close);return()=>{media.removeEventListener('change',close);hiddenSearch.removeEventListener('change',close)} }, [])
  useEffect(() => { if(menuOpen)document.querySelector<HTMLElement>('.sidebar a, .sidebar select')?.focus();else if(menuWasOpen.current)menuButton.current?.focus();menuWasOpen.current=menuOpen }, [menuOpen])
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
    // The router commits intent after blockers accept; cancelled navigation keeps the current scope.
    void navigate({ search: next, hash: '', replace })
  }

  function target(view: AppView, project = activeProject.current): NavigationSearch {
    return { ...(activeWorkspace.current ? { workspace: activeWorkspace.current } : {}), ...(project && !['new-project','links','pixels','tracked-share'].includes(view) ? { project } : {}), view }
  }

  function applyCallback(m: Me) {
    const pending = callback.current
    callback.current = null
    if (!pending || pending.generation !== intent.current.generation) return
    if (pending.value.kind === 'proof') { go({ ...intent.current.search, view: 'identity' }, true); return true }
    if (pending.value.kind === 'google') {
      const value = pending.value
      if (m.workspaces.some(workspace => workspace.id === value.workspace)) { go({ workspace: value.workspace, project: value.project, view: value.kind }, true); return true }
      else setAuthNotice({ kind: 'error', message: 'Authorization returned, but that workspace is no longer available. Choose a current workspace.' })
    }
  }

  useEffect(() => {
    // Runs before router loading, including Back/Forward. A -> B -> A still
    // invalidates old navigation completions even when the final URL matches.
    const unsubscribe = router.subscribe('onBeforeNavigate', event => {
      setMenuOpen(false); setToolSearch('')
      const next = parseNavigation(event.toLocation.search)
      const previous = intent.current.search
      // The audit panel restores its drilldown trigger after the requested view commits.
      if (!(next.view==='audits' && previous.view==='audits' && next.workspace===previous.workspace && next.project===previous.project)) requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }))
      if (navigationKey(next) !== navigationKey(intent.current.search)) setAppError('')
      rememberIntent(next)
    })
    let alive = true
    async function captureInvitation() {
      const reset = parsePasswordResetFragment(window.location.hash)
      if (reset !== null) {
        beginRecovery({ kind: 'reset', token: reset.token })
        setInviteToken(''); setInviteSigningIn(false)
        // Scrub before boot or any API call; the capability remains only in this component's memory.
        await navigate({ search: intent.current.search, hash: '', replace: true, ignoreBlocker: true })
        return
      }
      const value = parseCallback(window.location.hash)
      if (!value) return
      const wasRecovery = recoveryRef.current !== null
      if (wasRecovery) resetSession()
      const session = sessionGeneration.current
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
      await navigate({ search: intent.current.search, hash: '', replace: true, ignoreBlocker: true })
      if (!alive || sessionGeneration.current !== session || recoveryRef.current !== null) return
      if (currentMe.current) applyCallback(currentMe.current)
      else if (wasRecovery) { setPhase('loading'); void boot() }
    }
    const capture = () => { void captureInvitation() }
    window.addEventListener('hashchange', capture)
    const ac = new AbortController()
    const initialSession = sessionGeneration.current
    void captureInvitation().then(() => { if (alive && sessionGeneration.current === initialSession && recoveryRef.current === null) void boot(ac.signal) })
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

  async function loadAccountPreferences(expectedUserId=currentMe.current?.user.id):Promise<void> {
    if(!expectedUserId)return
    const session=sessionGeneration.current,generation=++preferencesGeneration.current,controller=new AbortController()
    preferencesRequest.current?.abort();preferencesRequest.current=controller
    setAccountPreferences(previous=>({data:previous.data?.user.id===expectedUserId?previous.data:null,loading:true,error:''}))
    const current=()=>!controller.signal.aborted&&preferencesRequest.current===controller&&preferencesGeneration.current===generation&&sessionGeneration.current===session&&currentMe.current?.user.id===expectedUserId
    try {
      const data=await requestAccountPreferences(controller.signal)
      if(!current())return
      if(data.user.id!==expectedUserId){resetSession();return}
      setAccountPreferences({data,loading:false,error:''})
      const next={...currentMe.current!,user:{...currentMe.current!.user,name:data.user.name}}
      currentMe.current=next;setMe(next)
    }catch(error){
      if(!current())return
      if(error instanceof ApiError&&error.status===401){resetSession();return}
      const denied=error instanceof ApiError&&[403,404].includes(error.status)
      setAccountPreferences(previous=>({data:!denied&&previous.data?.user.id===expectedUserId?previous.data:null,loading:false,error:errMsg(error)}))
    }finally{if(current())preferencesRequest.current=null}
  }

  useEffect(()=>{
    const entering=view==='preferences'&&!preferencesEntry.current
    preferencesEntry.current=view==='preferences'
    if(entering&&phase==='app')void loadAccountPreferences()
  },[view,phase])
  useEffect(()=>{
    document.documentElement.dataset.theme=phase==='app'&&accountPreferences.data!==null&&accountPreferences.data.user.id===me?.user.id?accountPreferences.data.preferences.theme:'light'
    return()=>{document.documentElement.dataset.theme='light'}
  },[phase,me?.user.id,accountPreferences.data])
  useEffect(()=>()=>{preferencesGeneration.current++;preferencesRequest.current?.abort()},[])

  function enterApp(m: Me, destination?: NavigationSearch) {
    oidcFactor.current = false
    if (currentMe.current?.user.id === m.user.id) m.user.name = currentMe.current.user.name
    currentMe.current = m; setMe(m)
    preferencesEntry.current=intent.current.search.view==='preferences'
    void loadAccountPreferences(m.user.id)
    const callbackNavigation = applyCallback(m)
    setPhase('app')
    if (destination) go(destination, true)
    else if (!callbackNavigation) applyNavigation(m)
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
    // Workspace tools keep a website selected in the shell without narrowing their URL or API scope.
    const selectedProject = project ?? available.find(item => item.id === activeProject.current) ?? available[0]
    activateProject(selectedProject?.id ?? '')
    setNavigationPending(false)
    const resolved = resolveNavigation(requested, workspaceId || undefined, project?.id, view)
    if (navigationKey(resolved) !== navigationKey(requested) || !canonicalNavigation(window.location.search, resolved)) go(resolved, true)
  }

  function resetSession() {
    setMenuOpen(false); setToolSearch('')
    sessionGeneration.current += 1; bootGeneration.current += 1
    recoveryGeneration.current += 1; recoveryRef.current = null; setRecovery(null)
    preferencesGeneration.current++;preferencesRequest.current?.abort();preferencesRequest.current=null;preferencesEntry.current=false
    setAccountPreferences({data:null,loading:false,error:''})
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

  function beginRecovery(value: PasswordRecovery, email?: string) {
    resetSession()
    recoveryRef.current = value; setRecovery({ value, generation: recoveryGeneration.current })
    if (email !== undefined) setSignInEmail(email)
    setAuthNotice(null); setPhase('recovery')
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
      if (currentMe.current?.user.id === m.user.id) m.user.name = currentMe.current.user.name
      currentMe.current = m; setMe(m)
      if (preferredId && intent.current.generation === navigation && m.workspaces.some(w => w.id === preferredId)) { go({ workspace: preferredId, view: 'project' }); return }
      applyNavigation(m)
    } catch (e) { if (sessionGeneration.current === session && !guardAuth(e) && intent.current.generation === navigation) throw e }
  }

  async function invitationAccepted(email: string, _created: boolean, workspace: string) {
    const session = sessionGeneration.current, navigation = intent.current.generation
    setInviteToken(''); setInviteSigningIn(false)
    try {
      const m = await api<Me>('/api/me')
      if (sessionGeneration.current !== session) return
      const destination: NavigationSearch | undefined = intent.current.generation === navigation && m.workspaces.some(w => w.id === workspace) ? { workspace, view: 'project' } : undefined
      enterApp(m, destination)
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
      const out = await api<{ providerSignOutUrl?: string } | null>('/api/auth/sign-out', { method: 'POST', body: {} })
      if (sessionGeneration.current !== session) return
      // End the editor before redirecting: a stale draft blocker must never delay sign-out.
      flushSync(() => resetSession())
      // Provider sessions also end at the identity provider (RP-initiated sign-out); its page is the last stop.
      if (out?.providerSignOutUrl &&/^https?:\/\//.test(out.providerSignOutUrl)) { window.location.assign(out.providerSignOutUrl); return }
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

  if (phase === 'recovery') return recovery ? <PasswordRecoveryPanel key={recovery.generation} value={recovery.value} initialEmail={signInEmail}
    onRequest={() => { if (sessionGeneration.current === renderedSession) beginRecovery({ kind: 'request' }) }} onSignIn={changed => { if (sessionGeneration.current !== renderedSession) return; resetSession(); if (changed) setAuthNotice({ kind: 'info', message: 'Password changed. Sign in with your new password. Two-factor authentication is still required if enabled.' }) }} /> : <main className='center'><p role='status'>Loading…</p></main>

  if (phase === 'loading') return <main className='center'><p role='status' className='dim'>Loading…</p></main>

  if (phase === 'error') {
    return (
      <AuthLayout>
        <div className='card auth'>
          <div role='alert' className='alert'>{pageError}</div>
          <button className='btn primary' onClick={() => { setPhase('loading'); void boot() }}>Try again</button>
        </div>
      </AuthLayout>
    )
  }

  if (phase === 'setup') return <OwnerForm onSetup={handleSetup} onSignInInstead={(email) => { setSignInEmail(email); setPhase('signin') }} />
  if (phase === 'factor') return <FactorForm onSubmit={handleFactor} onCancel={resetSession} />
  if (inviteToken && !inviteSigningIn) return <AuthLayout><section className='card auth'><InvitePanel token={inviteToken} signedInEmail={me?.user.email ?? null}
    onAccepted={invitationAccepted} onSignIn={() => void invitationSignIn()} onCancel={() => setInviteToken('')} onUnauthorized={unauthorized} />
    {!me && <div className='auth-providers'><OidcSignIn key={inviteToken} invitationToken={inviteToken} /></div>}</section></AuthLayout>
  if (phase === 'signin') return <SignInForm initialEmail={signInEmail} onSignIn={handleSignIn} notice={authNotice}
    onForgot={email => beginRecovery({ kind: 'request' }, email)}
    onCancel={inviteToken ? () => { sessionGeneration.current += 1; bootGeneration.current += 1; setInviteSigningIn(false) } : undefined} />

  const workspace = me?.workspaces.find((w) => w.id === workspaceId)
  const canWrite = workspace !== undefined && ['owner', 'admin', 'editor'].includes(workspace.role)
  const project = projects?.find((p) => p.id === projectId) ?? null
  const lastReceived = events !== null ? events.events[0]?.receivedAt ?? null : project?.lastEventAt ?? null
  const appUrl = (status?.appUrl ?? '').replace(/\/+$/, '')
  const snippet = project !== null ? `<script defer src="${appUrl}/tracker.js" data-site-key="${project.publicKey}" referrerpolicy="no-referrer"></script>` : ''
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(appUrl)
  const projectView = isProjectView(view)
  const toolQuery = toolSearch.trim().toLowerCase()
  const accountView = ['preferences','security','identity'].includes(view)
  const workspaceTool = ['boards','links','pixels'].includes(view)
  const pageTitles: Record<AppView, string> = {links:'Links',pixels:'Tracking images','tracked-share':'Shared report',heatmaps:'Heatmaps',boards:'Boards',replays:'Session replay',performance:'Web performance',revenue:'Revenue',attribution: 'Attribution', journeys: 'Journeys', project: 'Web analytics', campaigns: 'UTM campaigns', realtime: 'Realtime', compare: 'Compare analytics', 'new-project': 'New project', reports: 'Reports', collection: 'Collection and privacy', destinations: 'Destinations', domains: 'Domains', installation: 'Install tracker', events: 'Recent events', team: 'Team', workspace: 'New workspace', security: 'Account security', preferences: 'Profile and appearance', identity: 'Identity sign-in', keys: 'ten98 API access', providers: 'AI and search providers', retention: 'Data retention', 'visitor-retention': 'Retention', context: 'Project context', prompts: 'Prompt library', 'ai-search': 'AI search', 'ai-insights': 'AI insights', sessions: 'Session explorer', explore: 'Explore analytics', google: 'Google reports', 'google-app': 'Google app setup', keywords: 'Keyword research', 'domain-seo':'Domain SEO', ranks: 'Rank tracking', audits: 'Site audits', conversions: 'Conversions'}
  // Carry only applied report intent between these two views of this same project.
  const analyticsTarget=(next:'project'|'compare'):NavigationSearch=>{
    if(next==='project'&&view==='explore'&&search.workspace===workspaceId&&search.project===project?.id)return {...target(next),...explorerAnalyticsNavigation(search,analyticsApplied!==null&&analyticsApplied.userId===me?.user.id&&analyticsApplied.projectId===project?.id&&analyticsApplied.explorerEntry===routeLocation.state.__TSR_key?analyticsApplied:undefined)};
    if(!['project','compare'].includes(view)||search.workspace!==workspaceId||search.project!==project?.id)return target(next);
    const {analyticsCompare,analyticsDimension,...report}=analyticsNavigation(search),applied=analyticsApplied?.userId===me?.user.id&&analyticsApplied?.projectId===project?.id?analyticsApplied:null,to=report.analyticsTo??applied?.to??new Date().toISOString().slice(0,10),from=report.analyticsFrom??applied?.from??new Date(Date.parse(`${to}T00:00:00Z`)-6*864e5).toISOString().slice(0,10);
    return {...target(next),...report,...report.analyticsInvalid?{}:{analyticsFrom:from,analyticsTo:to},...next==='compare'?{...(analyticsCompare?{analyticsCompare}:{}),...(analyticsDimension?{analyticsDimension}:{})}:{}};
  }
  const exploreTarget=():NavigationSearch=>{
    if(view==='explore'&&search.workspace===workspaceId&&search.project===project?.id)return {...target('explore'),...explorerNavigation(search)};
    if(!['project','compare'].includes(view)||search.workspace!==workspaceId||search.project!==project?.id)return target('explore');
    const query=analyticsExplorerQuery(analyticsTarget('project'));
    return {...target('explore'),...(query===null?{exploreInvalid:'1' as const}:{exploreQuery:query})};
  }
  const explorerReturnState=view==='explore'&&me&&project&&search.workspace===workspaceId&&search.project===project.id&&navigationKey(parseNavigation(routeLocation.search))===navigationKey(search)&&canonicalNavigation(routeLocation.searchStr,search)?{userId:me.user.id,workspace:workspaceId,project:project.id,href:routeLocation.href}:undefined
  const verifiedExplorerReturn=me&&project?readExplorerReturn('analyticsReturn'in routeLocation.state?routeLocation.state.analyticsReturn:null,me.user.id,workspaceId,project.id):null
  const pageScope = view === 'preferences' || view === 'security' || view === 'identity' || view === 'workspace' ? 'Your account' : view === 'google-app' ? 'Installation settings' : workspace ? `Workspace · ${workspace.name}` : 'Your workspace'
  const projectDescriptions: Partial<Record<AppView, string>> = {heatmaps:'Explore sampled clicks and scroll depth on one retained page layout.',boards:'Arrange saved workspace analytics in charts, tables and notes.',replays:'Review and organize consented recordings, with masking and explicit gaps.',performance:'Measure page loading, responsiveness and layout stability from observed samples.',revenue:'Review recorded sales and refunds in one currency.',attribution: 'Compare recorded sources for your chosen conversion.', journeys: 'See frequent matching steps in retained native visits.', project: 'Understand how people find and use your website.', 'visitor-retention': 'See whether observed visitor keys return on later days.', realtime: 'Watch recorded activity from the last 30 minutes.', reports: 'Create reports and share a saved snapshot with your team or clients.', collection: 'Choose what your native analytics collects.', destinations: 'Manage your advertising and analytics tags from one snippet.', domains: 'Keep your serving domains and redirect aliases together.', installation: 'Connect your website with one lightweight snippet.', events: 'Inspect the latest events received from your website.', context: 'Keep your brand knowledge, competitors, key pages and research together.', prompts: 'Organize saved questions, review run costs and inspect model answers.', 'ai-search': 'Inspect explicitly captured ChatGPT consumer-search answers and their reported queries.', 'ai-insights': 'Review mentions and citations in retained prompt answers using current project context.', google: 'Import Search Console and GA4 reports without changing browser tracking.', sessions: 'Explore retained activity grouped by observed visitor keys. These keys are estimates and can change over time.', explore: 'Break down events by campaign, page or property in your time zone.', keywords: 'Research keyword demand and ideas in your chosen market.', 'domain-seo':'Find organic keywords a domain or URL ranks for in one market.', ranks: 'Track your search visibility across markets and devices.', audits: 'Inspect your site’s pages, technical findings and link coverage.', conversions: 'Measure the steps and outcomes that matter to your project.'}

  const presentation={...accountPreferences,reload:()=>loadAccountPreferences(me!.user.id),accept:(data:AccountPreferencesDto)=>{
    if(sessionGeneration.current!==renderedSession||currentMe.current?.user.id!==me!.user.id||data.user.id!==me!.user.id)return false
    preferencesGeneration.current++;preferencesRequest.current?.abort();preferencesRequest.current=null
    setAccountPreferences({data,loading:false,error:''})
    const next={...currentMe.current,user:{...currentMe.current.user,name:data.user.name}};currentMe.current=next;setMe(next)
    return true
  },unavailable:(message:string)=>{
    if(sessionGeneration.current!==renderedSession||currentMe.current?.user.id!==me!.user.id)return
    preferencesGeneration.current++;preferencesRequest.current?.abort();preferencesRequest.current=null;setAccountPreferences({data:null,loading:false,error:message})
  }}
  return (
    <AccountPresentationContext.Provider value={presentation}><div className='shell' onKeyDown={event=>{if(!menuOpen)return;if(event.key==='Escape'){setMenuOpen(false)}else if(event.key==='Tab'){const controls=Array.from(document.querySelectorAll<HTMLElement>('.sidebar a[href],.sidebar button:not(:disabled),.sidebar select:not(:disabled),.sidebar summary')).filter(node=>node.getClientRects().length&&!node.hidden);const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}}}>
      <a className='skip-link' href='#main-content' onClick={(event) => { event.preventDefault(); mainRef.current?.focus() }}>Skip to main content</a>
      {menuOpen && <button type='button' className='sidebar-shade' aria-label='Close navigation' onClick={()=>{setMenuOpen(false)}}/>}
      <aside id='app-navigation' className={`side sidebar${menuOpen?' visible':''}`} aria-label='Application navigation' role={menuOpen?'dialog':undefined} aria-modal={menuOpen||undefined}>
        <Link to='/' search={target('project')} className='brand-link' aria-label='ten98 Discover home'><Brand /></Link>
        <div className='side-body sidebar-nav'>
        {me!.workspaces.length>0 ? <div className='workspace-switch'><span className='workspace-avatar'>{(workspace?.name??'Workspace').slice(0,2).toUpperCase()}</span><div><label className='sr-only' htmlFor='ws'>Workspace</label><select id='ws' value={workspaceId} onChange={event=>changeWorkspace(event.target.value)}>{me!.workspaces.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select><small>{workspace?.role??'Member'} workspace</small></div><Icon name='chevron' size={15}/></div> : <p className='hint workspace-empty'>No workspaces yet.</p>}
        <div className='project-switch'><Icon name='folder' size={16}/><label className='sr-only' htmlFor='active-project'>Project</label><select id='active-project' value={projectId} disabled={!projects?.length} onChange={event=>{setMenuOpen(false);go(target('project',event.target.value))}}>{!projectId&&<option value=''>{projects===null&&workspace?'Loading projects…':projects?.length?'Choose a project':'No projects yet'}</option>}{projects?.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select>{canWrite&&<Link to='/' search={target('new-project')} className='icon-button' aria-label='Create project'><Icon name='plus' size={15}/></Link>}</div>
        {toolQuery&&<div className='tool-search-status' role='status'><span>Tools matching “{toolSearch.trim()}”</span><button type='button' className='btn ghost' onClick={()=>setToolSearch('')}>Show all tools</button></div>}
        {workspace&&<nav aria-label='Workspace measurement'><p className='nav-group'>Workspace</p><Link hidden={toolQuery!==''&&!'boards'.includes(toolQuery)} className={view==='boards'?'proj nav-item selected':'proj nav-item'} aria-current={view==='boards'?'page':undefined} to='/' search={{workspace:workspaceId,view:'boards'}}><Icon name='grid'/><span>Boards</span></Link><Link hidden={toolQuery!==''&&!'links'.includes(toolQuery)} className={view==='links'?'proj nav-item selected':'proj nav-item'} aria-current={view==='links'?'page':undefined} to='/' search={target('links')}><Icon name='link'/><span>Links</span></Link><Link hidden={toolQuery!==''&&!'tracking images'.includes(toolQuery)} className={view==='pixels'?'proj nav-item selected':'proj nav-item'} aria-current={view==='pixels'?'page':undefined} to='/' search={target('pixels')}><Icon name='image'/><span>Tracking images</span></Link></nav>}
        {project && workspace && <nav aria-label='Project sections' className='section-nav'>
          <p className='nav-group'>Measure</p>
          <Link hidden={toolQuery!==''&&!'analytics'.includes(toolQuery)} className={view === 'project' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'project' ? 'page' : undefined} to='/' search={analyticsTarget('project')} state={previous=>({...previous,analyticsReturn:explorerReturnState&&readExplorerReturn(explorerReturnState,me!.user.id,workspaceId,project!.id)?explorerReturnState:undefined})}><Icon name='chart'/><span>Analytics</span></Link>
          <Link hidden={toolQuery!==''&&!'realtime'.includes(toolQuery)} className={view === 'realtime' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'realtime' ? 'page' : undefined} to='/' search={target('realtime')}><Icon name='eye'/><span>Realtime</span></Link>
          <Link hidden={toolQuery!==''&&!'performance'.includes(toolQuery)} className={view === 'performance' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'performance' ? 'page' : undefined} to='/' search={target('performance')}><Icon name='chart'/><span>Performance</span></Link>
          <Link hidden={toolQuery!==''&&!'session replay'.includes(toolQuery)} className={view === 'replays' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'replays' ? 'page' : undefined} to='/' search={target('replays')}><Icon name='eye'/><span>Session replay</span></Link>
          <Link hidden={toolQuery!==''&&!'heatmaps'.includes(toolQuery)} className={view === 'heatmaps' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'heatmaps' ? 'page' : undefined} to='/' search={target('heatmaps')}><Icon name='target'/><span>Heatmaps</span></Link>
          <Link hidden={toolQuery!==''&&!'compare'.includes(toolQuery)} className={view === 'compare' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'compare' ? 'page' : undefined} to='/' search={analyticsTarget('compare')}><Icon name='layers'/><span>Compare</span></Link>
          <Link hidden={toolQuery!==''&&!'utm campaigns'.includes(toolQuery)} className={view === 'campaigns' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'campaigns' ? 'page' : undefined} to='/' search={target('campaigns')}><Icon name='target'/><span>UTM campaigns</span></Link>
          <Link hidden={toolQuery!==''&&!'explore'.includes(toolQuery)} className={view === 'explore' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'explore' ? 'page' : undefined} to='/' search={exploreTarget()}><Icon name='search'/><span>Explore</span></Link>
          <Link hidden={toolQuery!==''&&!'sessions'.includes(toolQuery)} className={view === 'sessions' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'sessions' ? 'page' : undefined} to='/' search={target('sessions')}><Icon name='users'/><span>Sessions</span></Link>
          <Link hidden={toolQuery!==''&&!'attribution'.includes(toolQuery)} className={view === 'attribution' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'attribution' ? 'page' : undefined} to='/' search={target('attribution')}><Icon name='layers'/><span>Attribution</span></Link>
          <Link hidden={toolQuery!==''&&!'journeys'.includes(toolQuery)} className={view === 'journeys' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'journeys' ? 'page' : undefined} to='/' search={target('journeys')}><Icon name='arrow'/><span>Journeys</span></Link>
          <Link hidden={toolQuery!==''&&!'retention'.includes(toolQuery)} className={view === 'visitor-retention' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'visitor-retention' ? 'page' : undefined} to='/' search={target('visitor-retention')}><Icon name='calendar'/><span>Retention</span></Link>
          <Link hidden={toolQuery!==''&&!'revenue'.includes(toolQuery)} className={view === 'revenue' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'revenue' ? 'page' : undefined} to='/' search={target('revenue')}><Icon name='money'/><span>Revenue</span></Link>
          <Link hidden={toolQuery!==''&&!'conversions'.includes(toolQuery)} className={view === 'conversions' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'conversions' ? 'page' : undefined} to='/' search={target('conversions')}><Icon name='target'/><span>Conversions</span></Link>
          <Link hidden={toolQuery!==''&&!'recent events'.includes(toolQuery)} className={view === 'events' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'events' ? 'page' : undefined} to='/' search={target('events')}><Icon name='layers'/><span>Recent events</span></Link>
          <Link hidden={toolQuery!==''&&!'reports'.includes(toolQuery)} className={view === 'reports' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'reports' ? 'page' : undefined} to='/' search={target('reports')}><Icon name='folder'/><span>Reports</span></Link>
          <Link hidden={toolQuery!==''&&!'google reports'.includes(toolQuery)} className={view === 'google' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'google' ? 'page' : undefined} to='/' search={target('google')}><Icon name='chart'/><span>Google reports</span></Link>
          <Link hidden={toolQuery!==''&&!'site audits'.includes(toolQuery)} className={view === 'audits' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'audits' ? 'page' : undefined} to='/' search={target('audits')}><Icon name='shield'/><span>Site audits</span></Link>
          <p className='nav-group'>Research</p>
          <Link hidden={toolQuery!==''&&!'context'.includes(toolQuery)} className={view === 'context' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'context' ? 'page' : undefined} to='/' search={target('context')}><Icon name='folder'/><span>Context</span></Link>
          <Link hidden={toolQuery!==''&&!'prompts'.includes(toolQuery)} className={view === 'prompts' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'prompts' ? 'page' : undefined} to='/' search={target('prompts')}><Icon name='agent'/><span>Prompts</span></Link>
          <Link hidden={toolQuery!==''&&!'ai insights'.includes(toolQuery)} className={view === 'ai-insights' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'ai-insights' ? 'page' : undefined} to='/' search={target('ai-insights')}><Icon name='agent'/><span>AI insights</span></Link>
          <Link hidden={toolQuery!==''&&!'ai search'.includes(toolQuery)} className={view === 'ai-search' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'ai-search' ? 'page' : undefined} to='/' search={target('ai-search')}><Icon name='search'/><span>AI search</span></Link>
          <Link hidden={toolQuery!==''&&!'keywords'.includes(toolQuery)} className={view === 'keywords' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'keywords' ? 'page' : undefined} to='/' search={target('keywords')}><Icon name='search'/><span>Keywords</span></Link>
          <Link hidden={toolQuery!==''&&!'domain seo'.includes(toolQuery)} className={view === 'domain-seo' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'domain-seo' ? 'page' : undefined} to='/' search={target('domain-seo')}><Icon name='globe'/><span>Domain SEO</span></Link>
          <Link hidden={toolQuery!==''&&!'rank tracking'.includes(toolQuery)} className={view === 'ranks' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'ranks' ? 'page' : undefined} to='/' search={target('ranks')}><Icon name='chart'/><span>Rank tracking</span></Link>
          <p className='nav-group'>Connect</p>
          <Link hidden={toolQuery!==''&&!'install tracker'.includes(toolQuery)} className={view === 'installation' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'installation' ? 'page' : undefined} to='/' search={target('installation')}><Icon name='key'/><span>Install tracker</span></Link>
          {['owner','admin'].includes(workspace.role) && <Link hidden={toolQuery!==''&&!'destinations'.includes(toolQuery)} className={view === 'destinations' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'destinations' ? 'page' : undefined} to='/' search={target('destinations')}><Icon name='link'/><span>Destinations</span></Link>}
          <Link hidden={toolQuery!==''&&!'collection and privacy'.includes(toolQuery)} className={view === 'collection' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'collection' ? 'page' : undefined} to='/' search={target('collection')}><Icon name='shield'/><span>Collection and privacy</span></Link>
          {['owner','admin'].includes(workspace.role) && <Link hidden={toolQuery!==''&&!'domains'.includes(toolQuery)} className={view === 'domains' ? 'proj nav-item selected' : 'proj nav-item'} aria-current={view === 'domains' ? 'page' : undefined} to='/' search={target('domains')}><Icon name='globe'/><span>Domains</span></Link>}
        </nav>}
        </div>
        <div className='sidebar-bottom'>
          <Link className={`nav-item${['preferences','security','identity','team','workspace','keys','providers','retention','google-app'].includes(view)?' selected':''}`} to='/' search={target('preferences')}><Icon name='settings'/><span>Settings</span></Link>
          <div className='account'><span className='avatar'>{me!.user.name.trim().split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase()||'98'}</span><Link className='account-identity' to='/' search={target('preferences')}><strong>{me!.user.name||'Account'}</strong><small>{me!.user.email}</small></Link><button type='button' className='icon-button' aria-label='Sign out' title='Sign out' disabled={signOutBusy} onClick={()=>void signOut()}><Icon name='logout' size={16}/></button></div>
        </div>
      </aside>
      <main className='main workspace-main' inert={menuOpen} id='main-content' ref={mainRef} tabIndex={-1} aria-label='Main content'>
        <header className='app-bar topbar'><div className='breadcrumb'><button type='button' ref={menuButton} className='icon-button mobile-menu mobile-nav-toggle' aria-label={menuOpen?'Close menu':'Menu'} aria-expanded={menuOpen} aria-controls='app-navigation' onClick={()=>setMenuOpen(!menuOpen)}><Icon name='menu'/></button><Icon name={accountView?'users':'folder'} size={16}/><span>{accountView?'Your account':projectView?project?.name??workspace?.name??'Your workspace':workspace?.name??'Your workspace'}</span><span className='crumb-slash' aria-hidden='true'>/</span><strong>{pageTitles[view]}</strong></div><div className='topbar-tools'><label className='search'><Icon name='search' size={16}/><span className='sr-only'>Find a tool</span><input type='search' placeholder='Find a tool…' value={toolSearch} onChange={event=>setToolSearch(event.target.value)}/></label><span className='preview-badge'>Development preview</span><Link className='avatar' aria-label='Your profile' to='/' search={target('preferences')}>{me!.user.name.trim().split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase()||'98'}</Link></div></header>
        <div className='page-content content'>
        {['preferences','security','identity','team','workspace','keys','providers','retention','google-app'].includes(view)&&<nav className='tabs settings-navigation' aria-label='Settings sections'>
          <Link className={view==='preferences'?'active':''} to='/' search={target('preferences')}>Your account</Link>
          <Link className={view==='security'?'active':''} to='/' search={target('security')}>Security</Link>
          <Link className={view==='identity'?'active':''} to='/' search={target('identity')}>Identity & SSO</Link>
          {workspace&&['owner','admin'].includes(workspace.role)&&<Link className={view==='team'?'active':''} to='/' search={target('team')}>Workspace & access</Link>}
          {workspace&&['owner','admin'].includes(workspace.role)&&<Link className={view==='keys'?'active':''} to='/' search={target('keys')}>API access</Link>}
          {workspace?.role==='owner'&&<Link className={view==='providers'?'active':''} to='/' search={target('providers')}>Integrations</Link>}
          {workspace&&<Link className={view==='retention'?'active':''} to='/' search={target('retention')}>Retention</Link>}
          <Link className={view==='workspace'?'active':''} to='/' search={target('workspace')}>New workspace</Link>
          {me!.instanceOperator&&<><Link className={view==='google-app'?'active':''} to='/' search={target('google-app')}>Google setup</Link></>}
        </nav>}

        {!projectView&&project&&<div className='context-return'><span>{workspaceTool?'Workspace tools include all projects.':'Your project stays selected while you work here.'}</span><Link className='btn ghost' to='/' search={target('project')}><Icon name='arrow' size={15}/>Return to {project.name}</Link></div>}
        {authNotice && <div role={authNotice.kind === 'error' ? 'alert' : 'status'} className={authNotice.kind === 'error' ? 'alert' : 'notice'}>{authNotice.message} <button className='btn ghost' onClick={() => setAuthNotice(null)}>Dismiss</button></div>}
        {appError !== '' && <div role='alert' className='alert'>{appError}</div>}
        {projectsError !== '' && <div role='alert' className='alert'>{projectsError} <button className='btn' onClick={() => void loadProjects(activeWorkspace.current)}>Retry projects</button></div>}
        {navigationPending ? <p role='status'>Loading the selected project…</p> : <>
        {project && workspace && projectView && <header className='proj-head page-heading'>
          <span className='eyebrow'>{view==='project'?'Your website at a glance':'Your Discover workspace'}</span><h1>{pageTitles[view]}</h1>
          <p className='project-origin'>{project.origin}</p>
          {projectDescriptions[view] && view !== 'events' && view !== 'installation' && <p className='dim'>{projectDescriptions[view]}</p>}
        </header>}
        {!projectView && view !== 'workspace' && view !== 'new-project' && <header className='proj-head page-heading'><span className='eyebrow'>{pageScope}</span><h1>{pageTitles[view]}</h1>
          {view === 'keys' && <p className='dim'>Create access keys for the ten98 API. AI and search provider credentials are managed separately by a workspace owner.</p>}
          {view === 'providers' && <p className='dim'>Manage provider credentials and the paid-work pause for this workspace.</p>}
        </header>}
        {view === 'workspace' && <section className='card'><h1>Create workspace</h1><p className='dim'>Keep each team’s projects and access separate.</p><CreateWorkspaceForm onCreated={async (id) => { if (sessionGeneration.current === renderedSession) await refreshMemberships(id, renderedIntent) }} onUnauthorized={unauthorized} /></section>}
        {view === 'team' && workspace && me && ['owner','admin'].includes(workspace.role) && <TeamPanel key={workspaceId} workspaceId={workspaceId} userId={me.user.id} onChanged={refreshMemberships} onUnauthorized={unauthorized} />}
        {view === 'preferences' && me && <AccountPreferencesPanel key={me.user.id} expectedUserId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'security' && me && <><AccountSecurityPanel key={me.user.id} expectedUserId={me.user.id} onUnauthorized={unauthorized} /><Link className='btn' to='/' search={target('identity')}>Manage identity sign-in and recovery</Link></>}
        {view === 'identity' && me && <>
          <OidcRecoveryPanel key={me.user.id} userId={me.user.id} proofId={oidcProofId} onUnauthorized={unauthorized} onProofHandled={() => { oidcProof.current = undefined; setOidcProofId(undefined) }} />
          <OidcPanel key={`${me.user.id}:${me.instanceOperator}`} userId={me.user.id} instanceOperator={me.instanceOperator} proofId={oidcProofId} onUnauthorized={unauthorized} onProofHandled={() => { oidcProof.current = undefined; setOidcProofId(undefined) }} />
        </>}
        {view === 'keys' && workspace && me && ['owner','admin'].includes(workspace.role) && <ApiKeysPanel key={`${me.user.id}:${workspaceId}`} workspaceId={workspaceId} onUnauthorized={unauthorized} />}
        {view === 'providers' && workspace?.role === 'owner' && me && <ProviderPanel key={`${me.user.id}:${workspaceId}`} workspaceId={workspaceId} onUnauthorized={unauthorized} />}
        {view === 'retention' && workspace && me && <RetentionPanel workspaceId={workspaceId} userId={me.user.id} onUnauthorized={unauthorized} />}
        {(view==='links'||view==='pixels')&&workspace&&me&&<TrackedAssetsPanel workspaceId={workspaceId} userId={me.user.id} role={workspace.role} kind={view==='links'?'link':'pixel'} appUrl={appUrl} query={search.assetInvalid?'unsupported=1':search.assetQuery} readOwner={routeLocation.state.__TSR_key??routeLocation.href} readEnabled={search.workspace===workspaceId&&search.view===view&&navigationKey(parseNavigation(routeLocation.search))===navigationKey(search)&&canonicalNavigation(routeLocation.searchStr,search)} onNavigate={(query,kind)=>go({workspace:workspaceId,view:kind==='pixel'?'pixels':kind==='link'?'links':view,...query?{assetQuery:query}:{}})} onUnauthorized={unauthorized}/>}
        {view === 'collection' && project && workspace && me && <AnalyticsSettingsPanel projectId={project.id} userId={me.user.id} workspaceId={workspace.id} onDeleted={()=>{if(activeWorkspace.current!==workspace.id||activeProject.current!==project.id||currentMe.current?.user.id!==me.user.id)return;activateProject('');loadedProjects.current=(loadedProjects.current??[]).filter(item=>item.id!==project.id);setProjects(loadedProjects.current);go({workspace:workspace.id,view:'project'},true);void loadProjects(workspace.id);}} readOwner={(routeLocation.state.__TSR_key??routeLocation.href)+':'+workspace?.role} readEnabled={!navigationPending&&search.workspace===workspaceId&&search.project===project.id&&search.view==='collection'&&canonicalNavigation(routeLocation.searchStr,search)} isCurrent={()=>sessionGeneration.current===renderedSession&&intent.current.generation===renderedIntent&&currentMe.current!==null&&currentMe.current.user.id===me.user.id&&activeWorkspace.current===workspaceId&&activeProject.current===project.id&&(router.state.location.state.__TSR_key??router.state.location.href)===(routeLocation.state.__TSR_key??routeLocation.href)&&navigationKey(parseNavigation(router.state.location.search))===navigationKey(search)&&currentMe.current.workspaces.some(w=>w.id===workspaceId&&w.role===workspace?.role)} onUnauthorized={unauthorized} />}
        {view === 'campaigns' && project && me && <UtmPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'explore' && project && me && <ExplorerPanel projectId={project.id} userId={me.user.id} search={search} onAppliedRange={rememberAnalyticsRange} onNavigate={value=>go({...target('explore'),...value})} onUnauthorized={unauthorized} />}
        {view === 'compare' && project && me && <AnalyticsPanel projectId={project.id} userId={me.user.id} compareView onAppliedRange={rememberAnalyticsRange} search={{...target('compare'),...(search.workspace===workspaceId&&search.project===project.id?analyticsNavigation(search):{})}} onNavigate={value=>go({...target('compare'),...value})} onUnauthorized={unauthorized} />}
        {view === 'performance' && project && me && <WebPerformancePanel projectId={project.id} userId={me.user.id} query={search.performanceInvalid?'unsupported=1':search.performanceQuery} readOwner={routeLocation.state.__TSR_key??routeLocation.href} readEnabled={search.workspace===workspaceId&&search.project===project.id&&navigationKey(parseNavigation(routeLocation.search))===navigationKey(search)&&canonicalNavigation(routeLocation.searchStr,search)} onNavigate={query=>go({...target('performance'),performanceQuery:query})} onUnauthorized={unauthorized} onSettings={()=>go(target('collection'))}/>}
        {view === 'boards' && workspace && me && <BoardsPanel workspaceId={workspaceId} userId={me.user.id} projects={projects??[]} query={search.boardInvalid?'unsupported=1':search.boardQuery} readOwner={routeLocation.state.__TSR_key??routeLocation.href} readEnabled={!navigationPending&&search.workspace===workspaceId&&search.project===undefined&&navigationKey(parseNavigation(routeLocation.search))===navigationKey(search)&&canonicalNavigation(routeLocation.searchStr,search)} onNavigate={query=>go({workspace:workspaceId,view:'boards',...(query?{boardQuery:query}:{})})} onUnauthorized={unauthorized}/>}
        {view === 'replays' && project && me && <SessionReplayPanel projectId={project.id} userId={me.user.id} query={search.replayInvalid?'unsupported=1':search.replayQuery} readOwner={routeLocation.state.__TSR_key??routeLocation.href} readEnabled={search.workspace===workspaceId&&search.project===project.id&&navigationKey(parseNavigation(routeLocation.search))===navigationKey(search)&&canonicalNavigation(routeLocation.searchStr,search)} onNavigate={query=>go({...target('replays'),...(query?{replayQuery:query}:{})})} onUnauthorized={unauthorized} onSettings={()=>go(target('collection'))}/>}
        {view === 'heatmaps' && project && me && <HeatmapsPanel projectId={project.id} userId={me.user.id} query={search.heatmapInvalid?'unsupported=1':search.heatmapQuery} readOwner={routeLocation.state.__TSR_key??routeLocation.href} readEnabled={search.workspace===workspaceId&&search.project===project.id&&navigationKey(parseNavigation(routeLocation.search))===navigationKey(search)&&canonicalNavigation(routeLocation.searchStr,search)} onNavigate={query=>go({...target('heatmaps'),...(query?{heatmapQuery:query}:{})})} onUnauthorized={unauthorized} onSettings={()=>go(target('collection'))}/>}
        {view === 'realtime' && project && me && <RealtimePanel projectId={project.id} userId={me.user.id} origin={project.origin} onUnauthorized={unauthorized} onOpenSession={value=>go({...target('sessions'),...value})}/>}
        {view === 'conversions' && project && me && <ConversionsPanel projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'context' && project && me && <ContextPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'prompts' && project && me && <PromptsPanel key={`${me.user.id}:${project.id}`} workspaceId={workspaceId} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} onAISearch={(promptId,versionId,capture)=>{const intent=readAISearchIntent()!;go({...target('ai-search'),aiSearchQuery:aiSearchIntentQuery({...intent,section:capture?'captures':'analysis',create:capture,filters:{...intent.filters,promptId,versionId}})});}} />}
        {view === 'ai-search' && project && me && <AISearchPanel workspaceId={workspaceId} projectId={project.id} userId={me.user.id} search={search} onNavigate={value=>go({...target('ai-search'),...value})} onUnauthorized={unauthorized} onPrompts={()=>go(target('prompts'))} onProviders={()=>go(target('providers'))}/>}
        {view === 'ai-insights' && project && me && <AIInsightsSection key={`${me.user.id}:${workspaceId}:${project.id}`} workspaceId={workspaceId} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} onBack={() => go(target('prompts'))} />}
        {view === 'keywords' && project && me && <KeywordResearchPanel workspaceId={workspaceId} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'domain-seo' && project && me && <DomainResearchPanel workspaceId={workspaceId} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'ranks' && project && me && <Suspense fallback={<p role="status">Loading rank tracking…</p>}><RankTrackingPanel workspaceId={workspaceId} projectId={project.id} userId={me.user.id} origin={project.origin} onUnauthorized={unauthorized} onOpenProviders={() => go(target('providers'))} /></Suspense>}
        {view === 'audits' && project && me && <SiteAuditPanel projectId={project.id} userId={me.user.id} search={{...target('audits'),...(search.workspace===workspaceId&&search.project===project.id?auditNavigation(search):{})}} onNavigate={(value,replace) => go({...target('audits'),...value},replace)} onUnauthorized={unauthorized} onOpenDomains={() => go(target('domains'))} onOpenRetention={() => go(target('retention'))} />}
        {view === 'reports' && project && me && <ReportsPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'google' && project && me && <GoogleReportsPanel projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'google-app' && me?.instanceOperator && <GoogleAppPanel userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'domains' && project && workspace && me && ['owner','admin'].includes(workspace.role) && <DomainsPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} onInstallTracker={() => go(target('installation'))} />}
        {view === 'destinations' && project && workspace && me && ['owner','admin'].includes(workspace.role) && <>
          <DestinationsPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />
        </>}
        {projectView && !workspace && <section className='card'><p>No workspace is linked to this account.</p><Link className='btn primary' to='/' search={target('workspace')}>Create workspace</Link></section>}
        {(view === 'new-project' || (projectView && projects !== null && project === null)) && workspace && canWrite && (
          <section className='card onboarding-card' aria-labelledby='create-h'>
            <span className='eyebrow'>Website setup</span>
            <h1 id='create-h'>{projects !== null && projects.length > 0 ? 'Create a new project' : 'Connect your first website'}</h1>
            <p className='dim'>Keep your website analytics, tracking tags and reports together. Start with a name and the website you want to measure.</p>
            <CreateProjectForm key={workspaceId} onCreate={createProject} />
          </section>
        )}
        {projectView && workspace && projects !== null && project === null && !canWrite && (
          <section className='card'>
            <h1>{projects.length ? 'Choose a project' : 'No project to show'}</h1>
            <p>{projects.length ? 'Select a project from the sidebar to view its analytics.' : 'Your role in this workspace is view-only. Ask a workspace admin to create a project or give you access to one.'}</p>
          </section>
        )}
        {view === 'project' && workspace && project !== null && (
          <>
            {events?.total === 0 && <section className='connection-callout'><div><strong>Ready when your website is.</strong><p>Add the tracking snippet, then review Collection and privacy to choose when analytics starts.</p></div><Link className='btn primary' to='/' search={target('installation')}>Connect website</Link></section>}
            <AnalyticsPanel key={`${me!.user.id}:${project.id}`} projectId={project.id} userId={me!.user.id} onAppliedRange={rememberAnalyticsRange} onReturnToExplorer={verifiedExplorerReturn?()=>router.history.push(verifiedExplorerReturn):undefined} search={{...target('project'),...(search.workspace===workspaceId&&search.project===project.id?analyticsNavigation(search):{})}} onNavigate={value=>go({...target('project'),...value})} onUnauthorized={unauthorized} />
          </>
        )}
        {view === 'sessions' && workspace && project !== null && <SessionExplorerPanel key={`${me!.user.id}:${project.id}`} projectId={project.id} userId={me!.user.id} search={search} onNavigate={value=>go({...target('sessions'),...value})} onUnauthorized={unauthorized}/> }
        {view === 'revenue' && workspace && project !== null && <RevenuePanel projectId={project.id} userId={me!.user.id} search={search} onNavigate={value=>go({...target('revenue'),...value})} onOpenActivity={(visitorKey,from,to,timeZone)=>go({...target('sessions'),visitorKey,from,to,timeZone})} onUnauthorized={unauthorized}/> }
        {view === 'attribution' && workspace && project !== null && <AttributionPanel projectId={project.id} userId={me!.user.id} search={search} onNavigate={value=>go({...target('attribution'),...value})} onUnauthorized={unauthorized}/> }
        {view === 'journeys' && workspace && project !== null && <JourneysPanel projectId={project.id} userId={me!.user.id} search={search} onNavigate={value=>go({...target('journeys'),...value})} onUnauthorized={unauthorized}/> }
        {view === 'visitor-retention' && workspace && project !== null && <RetentionReportPanel key={`${me!.user.id}:${project.id}`} projectId={project.id} userId={me!.user.id} search={{...target('visitor-retention'),...retentionNavigation(search)}} onNavigate={(value,replace)=>go({...target('visitor-retention'),...value},replace)} onUnauthorized={unauthorized} onOpenExplore={()=>go(target('explore'))}/>}
        {view === 'events' && workspace && project !== null && (
            <section className='card events-panel' aria-labelledby='ev-h' aria-busy={eventsBusy}>
              <div className='row between events-toolbar'>
                <div>
                  <h2 id='ev-h'>Retained events</h2>
                  <p className='big-num'>{events !== null ? events.total : project.eventCount}</p>
                </div>
                <button className='btn' disabled={eventsBusy} onClick={() => void loadEvents(project.id)}>{eventsBusy ? 'Refreshing…' : 'Refresh events'}</button>
              </div>
              {(events?.retainedFrom ?? project.retainedFrom) && <p className='hint'>History before {fmt((events?.retainedFrom ?? project.retainedFrom)!)} is unavailable after retention. This is not a lifetime total.</p>}
              {lastReceived !== null && <p className='dim'>Last retained event received {fmt(lastReceived)}</p>}
              {eventsError !== '' && <div role='alert' className='alert'>{eventsError}</div>}
              {events === null && eventsError === '' && <p role='status' className='dim'>Loading events…</p>}
              {events !== null && events.events.length === 0 && (
                <div className='empty'>
                  <p><strong>No retained events available.</strong></p>
                  <p>Install your tracker, allow analytics in Tracking preferences, then refresh this list. Counts include only retained events the collector has persisted.</p><Link className='btn' to='/' search={target('installation')}>Install tracker</Link>
                </div>
              )}
              {events !== null && events.events.length > 0 && (
                <>
                  <div className='table-wrap' role='region' aria-label='Retained event rows' tabIndex={0}>
                    <table aria-labelledby='ev-h'>
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
            <section className='card installation-panel' aria-labelledby='snip-h'>
              <div className='row between installation-toolbar'>
                <h2 id='snip-h'>Tracking snippet</h2>
                <button className='btn primary' onClick={() => void copySnippet(snippet)}>Copy snippet</button>
              </div>
              <p>Add this tag to the pages served from <strong>{project.origin}</strong> or a verified HTTPS serving domain configured under Domains:</p>
              <pre className='snippet' role='region' aria-label='Tracking snippet' tabIndex={0}><code>{snippet}</code></pre>
              {copied === 'copied' && <p role='status' className='dim'>Copied to clipboard.</p>}
              {copied === 'failed' && <p role='alert' className='dim'>Copy failed — select the snippet text above and copy it manually.</p>}
              <p className='dim footnote'>Install the snippet on the canonical origin or a verified HTTPS serving domain. Cookieless basic analytics starts with the current policy; consent-first analytics waits for a grant in Tracking preferences. Refresh events to confirm delivery. Explicit refusals and browser privacy signals stop collection.{isLocal ? ' This app is running on a localhost URL (including [::1]), so external websites cannot reach the collector until it is deployed at a public HTTPS address.' : ''}</p>
              <Link className='btn' to='/' search={target('events')}>View recent events</Link>
              <details className='installation-help'>
                <summary>Custom events and collection details</summary>
                <p className='dim footnote'>When collection is allowed, page loads and SPA path changes are observed automatically. Call <code>window.ten98.track('signup', {'{'}plan: 'starter'{'}'})</code> for a custom event with optional properties. Use fixed event names and avoid personal data. Native page URLs omit queries and fragments; optional metadata follows Collection and privacy settings. Advertising pixels and visitor identification still need explicit consent.</p>
                <p>For buttons and links, you can also declare an event in your HTML:</p>
                <pre className='snippet' tabIndex={0} aria-label='HTML custom event example'><code>{'<button type="button" data-ten98-event="signup" data-ten98-event-plan="starter">Sign up</button>'}</code></pre>
                <p className='dim footnote'>Only the nearest element with a declared event is tracked. Attribute properties are passed as strings; use the JavaScript call for numbers, arrays, nested properties or advertising conversion fields. Use fixed, non-personal values. Click tracking does not delay navigation, and delivery during navigation is best effort.</p>
              </details>
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

        </div>
      </main>
    </div></AccountPresentationContext.Provider>
  )
}

function AIInsightsSection(props:{workspaceId:string;projectId:string;userId:string;onUnauthorized:()=>void;onBack:()=>void}) {
  const [entry,setEntry]=useState<Extract<ExecutionEntry,{kind:'receipt'}>|null>(null)
  return entry ? <PromptExecutionsPanel {...props} entry={entry} onBack={()=>setEntry(null)} backLabel='Back to AI insights' /> :
    <AIInsightsPanel {...props} backLabel='Back to prompts' onOpenComparison={(comparisonId,promptId)=>{if(navigationId(comparisonId)&&navigationId(promptId))setEntry({kind:'receipt',comparisonId,promptId})}} />
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
    <AuthLayout>
      <form className='card auth' onSubmit={(e) => void submit(e)}>
        <div className='eyebrow'>Your Discover workspace</div><h1>Make yourself at home.</h1>
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
    </AuthLayout>
  )
}

function SignInForm({ initialEmail, onSignIn, onForgot, onCancel, notice }: { initialEmail: string; onSignIn: (email: string, password: string) => Promise<void>; onForgot: (email: string) => void; onCancel?: () => void; notice?: {message: string; kind: 'info' | 'error'} | null }) {
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
    <AuthLayout>
      <form className='card auth' onSubmit={(e) => void submit(e)}>
        <div className='eyebrow'>Your Discover workspace</div><h1>Good to see you again.</h1><p className='auth-description'>Sign in to pick up where you left off.</p>
        {notice && <p className={notice.kind === 'error' ? 'alert' : 'notice'} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.message}</p>}
        <div className='field'><label htmlFor='si-email'>Email</label>
          <input id='si-email' type='email' autoComplete='email' required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className='field'><label htmlFor='si-pw'>Password</label>
          <input id='si-pw' type='password' autoComplete='current-password' required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {error !== '' && <div role='alert' className='alert'>{error}</div>}
        <button className='btn primary' disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<Icon name='arrow' size={16}/></button>
        <button type='button' className='btn' disabled={busy} onClick={() => onForgot(email.trim())}>Forgot password?</button>
        {onCancel && <button type='button' className='btn' onClick={onCancel}>Back to invitation</button>}
        <div className='auth-providers'><OidcSignIn /></div>
      </form>
    </AuthLayout>
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
  return <AuthLayout><form className='card auth' onSubmit={event => void submit(event)}>
    <p className='auth-brand'>Your Discover workspace</p><h1>Verify your sign-in</h1><p>{recovery ? 'Enter one unused recovery code. Each code can only be used once.' : 'Enter the six-digit code from your authenticator app.'}</p>
    <div className='field'><label htmlFor='factor-code'>{recovery ? 'Recovery code' : 'Authenticator code'}</label>
      <input id='factor-code' autoComplete='one-time-code' inputMode={recovery ? 'text' : 'numeric'} value={code} onChange={event => setCode(event.target.value)} maxLength={recovery ? 21 : 6} required disabled={busy} /></div>
    {error && <div className='alert' role='alert'>{error}</div>}
    <div className='row'><button className='btn primary' disabled={busy}>{busy ? 'Verifying…' : 'Verify'}</button>
      <button type='button' className='btn' disabled={busy} onClick={() => { setRecovery(!recovery); setCode(''); setError('') }}>{recovery ? 'Use authenticator' : 'Use a recovery code'}</button>
      <button type='button' className='btn ghost' disabled={busy} onClick={onCancel}>Back to sign in</button></div>
  </form></AuthLayout>
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
