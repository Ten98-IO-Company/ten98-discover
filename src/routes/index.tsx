import { AppBrand, AppIcon } from '@ten98/ui/app'
import { Alert, AppStateScreen, DataTable, ProjectCreateFlow, WorkspaceCreateFlow, WorkspaceOnboarding, AuthErrorBoundary, Banner, Button, PageHeader, SettingsLayout, SidebarStatus, Text, Stack, FirstUserSetupFlow, SignInFlow, TwoFactorChallengeFlow, ResourceCard, SearchField, SidebarNav, SectionNav, StatusLine, TrackerStatus, WorkspaceProjectSwitcher, AccountMenu, SidebarFooter, AppShell, AppTopbar } from '@ten98/ui'
import type { FirstUserSetupValues, WorkspaceCreateValues, SignInValues, TwoFactorMode, TwoFactorValues, NavLinkComponent, SettingsNavItem, SidebarNavGroup, SidebarNavItem } from '@ten98/ui'
import { authStory } from '../components/AuthLayout'
import { version as appVersion } from '../../package.json'
import { createFileRoute, Link, useRouter, useLocation } from '@tanstack/react-router'
import type { HistoryState } from '@tanstack/react-router'
import { createContext, lazy, Suspense, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { api, ApiError, errMsg } from '../lib/api'
import { parseWebsiteAddress } from '../lib/website-address'
import { appSections, projectSettingsViews, sectionOf, settingsEntries, settingsEntry, settingsGroupLabels } from '../lib/app-sections'
import { formatReportInstant } from '../lib/report-time'
import { AnalyticsPanel, analyticsExplorerQuery } from '../components/AnalyticsPanel'
import { RealtimePanel } from '../components/RealtimePanel'
import { WebsiteQuickShare } from '../components/WebsiteSharePanel'
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
import ReportsPanel from '../components/ReportsPanel'
import { TeamPanel } from '../components/TeamPanel'
import { navigableHttpUrl } from '../lib/oidc-authorization'
import { InvitePanel } from '../components/InvitePanel'
import { AccountSecurityPanel } from '../components/AccountSecurityPanel'
import { AccountClosurePanel } from '../components/AccountClosurePanel'
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
      <p>Rankings couldn’t load. Reload this page to try again.</p>
      <button className="btn" type="button" style={{ minHeight: 44 }} onClick={() => window.location.reload()}>Reload page</button>
    </div>
  )
}
import { SiteAuditPanel } from '../components/SiteAuditPanel'
import { ConversionsPanel } from '../components/ConversionsPanel'
import { aiSearchIntentQuery, readAISearchIntent, analyticsNavigation, explorerNavigation, auditNavigation, retentionNavigation, allowedView, canonicalNavigation, navigationKey, parseCallback, parsePasswordResetFragment, parseNavigation, resolveNavigation, projectView as isProjectView } from '../lib/navigation'
import type { AppView, CallbackIntent, NavigationSearch } from '../lib/navigation'

export const Route = createFileRoute('/')({ validateSearch: parseNavigation, component: RouteEntry })

function RouteEntry(){
  const location=useLocation(),raw=new URLSearchParams(location.searchStr)
  // Router normalizes duplicate/JSON view values; public-share intent must never boot private APIs.
  const shared=raw.getAll('view').some(value=>value.includes('tracked-share'))
  return <AuthErrorBoundary fallback={{ brand: <AppBrand product='Discover' /> }}>{shared?<SharedTrackedAssetPanel search={location.searchStr} fragment={location.hash} entry={location.state.__TSR_key??location.href}/>:<App/>}</AuthErrorBoundary>
}

type Status = { configured: boolean; appUrl: string; trackerScript?: string; collectPath?: string | null }
type Workspace = { id: string; name: string; role: string; twoFactorLocked?: boolean }
type Me = { user: { id: string; name: string; email: string }; instanceOperator: boolean; workspaces: Workspace[] }
type Project = { id: string; name: string; origin: string; publicKey: string; eventCount: number; lastEventAt: string | null; retainedFrom: string | null }
type EventsData = { events: { id: string; eventName: string; path: string; origin: string; receivedAt: string }[]; total: number; retainedFrom: string | null }
type Job = { id: string; status: string; createdAt: string; completedAt: string | null; error: string | null }
type SetupValues = { token: string; name: string; email: string; password: string; workspaceName: string }

function fmt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function pillClass(status: string): string {
  const s = status.toLowerCase()
  if (s.includes('fail') || s.includes('error') || s.includes('denied')) return 'pill bad'
  if (s.includes('success') || s.includes('complete') || s.includes('done')) return 'pill good'
  return 'pill'
}

// Shared navigation passes an item key as `href`; this map resolves it to the one route's search object.
interface NavRoutes { search: (key: string) => NavigationSearch; analyticsState: (previous: HistoryState) => HistoryState }
const NavRoutesContext = createContext<NavRoutes | null>(null)
const ShellLink: NavLinkComponent = ({ href, ...props }) => {
  const routes = useContext(NavRoutesContext)!
  return <Link to='/' search={routes.search(href)} state={href === 'project' ? routes.analyticsState : undefined} {...props} />
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
  const [eventsReadAt, setEventsReadAt] = useState<string | null>(null)
  const [eventsBusy, setEventsBusy] = useState(false)
  const [eventsError, setEventsError] = useState('')
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [jobsBusy, setJobsBusy] = useState(false)
  const [checkBusy, setCheckBusy] = useState(false)
  const [jobError, setJobError] = useState('')
  const [appError, setAppError] = useState('')
  const [signOutBusy, setSignOutBusy] = useState(false)
  const signOutLock = useRef(false)
  const [view, updateView] = useState<AppView>('project')
  const [analyticsApplied,setAnalyticsApplied]=useState<{userId:string;projectId:string;from:string;to:string;explorerEntry?:string}|null>(null)
  const rememberAnalyticsRange=useCallback((userId:string,projectId:string,range:{from:string;to:string},explorerEntry?:string)=>setAnalyticsApplied(previous=>previous?.userId===userId&&previous.projectId===projectId&&previous.from===range.from&&previous.to===range.to&&previous.explorerEntry===explorerEntry?previous:{userId,projectId,...range,explorerEntry}),[])
  const [accountPreferences,setAccountPreferences]=useState<{data:AccountPreferencesDto|null;loading:boolean;error:string}>({data:null,loading:false,error:''})
  const preferencesRequest=useRef<AbortController|null>(null)
  const preferencesGeneration=useRef(0)
  const preferencesEntry=useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [toolSearch, setToolSearch] = useState('')
  useEffect(() => { const media=window.matchMedia('(max-width:960px)'); const clear=()=>{if(media.matches)setToolSearch('')};media.addEventListener('change',clear);return()=>media.removeEventListener('change',clear) }, [])
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
  const eventsRead = useRef(0)

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
      if (m.workspaces.some(workspace => workspace.id === value.workspace)) { go({ workspace: value.workspace, project: value.project, view: 'imports' }, true); return true }
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
      if (!(next.view==='audits' && previous.view==='audits' && next.workspace===previous.workspace && next.project===previous.project)) requestAnimationFrame(() => document.querySelector<HTMLElement>('main')?.focus({ preventScroll: true }))
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
    // Without an applied account preference (sign-in, recovery, state screens, unavailable preferences) the browser's own light or dark setting applies.
    document.documentElement.dataset.theme=phase==='app'&&accountPreferences.data!==null&&accountPreferences.data.user.id===me?.user.id?accountPreferences.data.preferences.theme:'system'
    return()=>{document.documentElement.dataset.theme='system'}
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
    setEvents(null); setEventsReadAt(null); setEventsError(''); setEventsBusy(false)
    setJobs(null); setJobError(''); setJobsBusy(false); setCheckBusy(false)
    setCopied('idle')
    if (id) void loadEvents(id)
  }

  useEffect(() => {
    if (phase === 'app' && view === 'installation' && projectId) void loadEvents(projectId)
    if (phase === 'app' && view === 'diagnostics' && projectId) void loadJobs(projectId)
    // Opening Recent events reads current history; a read already started by project activation is current.
    if (phase === 'app' && view === 'events' && projectId && !eventsBusy) void loadEvents(projectId)
  }, [phase, view, projectId])

  // While Install shows an empty history, poll for the first event every 3 s for up to 10 minutes (PostHog onboarding pattern),
  // skipping reads while the tab is hidden. Polling stops once an event arrives, on navigation or on unmount.
  const awaitingFirstEvent = phase === 'app' && view === 'installation' && projectId !== '' && events?.total === 0
  useEffect(() => {
    if (!awaitingFirstEvent) return
    const pid = projectId, deadline = Date.now() + 600_000
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (stopped || Date.now() > deadline) return
      if (document.visibilityState === 'visible') await loadEvents(pid, true)
      if (!stopped) timer = setTimeout(() => void tick(), 3000)
    }
    timer = setTimeout(() => void tick(), 3000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [awaitingFirstEvent, projectId])

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
    updateView(view)
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
    // Record the resolved scope before the canonical replace so the router event does not clear the error reported above.
    if (navigationKey(resolved) !== navigationKey(requested) || !canonicalNavigation(window.location.search, resolved)) { rememberIntent(resolved); go(resolved, true) }
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

  // A background read (first-event polling) leaves the busy state and any previous result alone and ignores transient failures.
  // It never supersedes a user-started read; a later user read supersedes it.
  async function loadEvents(pid: string, background = false) {
    const gen = projGen.current, read = background ? eventsRead.current : ++eventsRead.current
    const current = () => activeProject.current === pid && projGen.current === gen && eventsRead.current === read
    if (!background) { setEventsBusy(true); setEventsError('') }
    try {
      const d = await api<EventsData>(`/api/projects/${pid}/events`)
      if (current()) { setEvents(d); setEventsReadAt(new Date().toISOString()); if (background) setEventsError('') }
    } catch (e) { if (current() && !guardAuth(e) && !background) { if (e instanceof ApiError && [403,404].includes(e.status)) { setEvents(null); setEventsReadAt(null) } setEventsError(errMsg(e)) } }
    finally { if (current() && !background) setEventsBusy(false) }
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
      if (current() && intent.current.generation === navigation) go({ workspace: wsId, project: d.project.id, view: 'installation' })
    } catch (e) {
      if (!current() || guardAuth(e) || intent.current.generation !== navigation) return
      throw e
    }
  }

  async function createWorkspace(name: string) {
    const session = sessionGeneration.current, navigation = intent.current.generation
    try {
      const d = await api<{ workspace: { id: string } }>('/api/workspaces', { method: 'POST', body: { name } })
      if (sessionGeneration.current === session) await refreshMemberships(d.workspace.id, navigation)
    } catch (e) {
      if (sessionGeneration.current !== session || guardAuth(e)) return
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
    if (response.twoFactorRedirect) { setSignInEmail(email); setPhase('factor'); return }
    setSignInEmail(''); setPhase('loading'); setInviteSigningIn(false)
    await boot()
  }

  async function handleFactor(code: string, recovery: boolean) {
    const session = sessionGeneration.current
    await api(`/api/auth/two-factor/${recovery ? 'verify-backup-code' : 'verify-totp'}`, { method: 'POST', body: { code } })
    if (sessionGeneration.current !== session) return
    oidcFactor.current = false
    // A completed factor is single-use. Retry loading the session, never the consumed code.
    setSignInEmail(''); setPhase('loading'); setInviteSigningIn(false)
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

  // Resolves to the failure message, or null when signed out or already in progress.
  async function signOut(): Promise<string | null> {
    // Synchronous lock: the onboarding screen's sign-out button cannot be disabled, so a second click must not send again.
    if (signOutLock.current) return null
    signOutLock.current = true
    const session = sessionGeneration.current
    setSignOutBusy(true); setAppError('')
    try {
      const out = await api<{ providerSignOutUrl?: string } | null>('/api/auth/sign-out', { method: 'POST', body: {} })
      if (sessionGeneration.current !== session) return null
      // End the editor before redirecting: a stale draft blocker must never delay sign-out.
      flushSync(() => resetSession())
      // Provider sessions also end at the identity provider (RP-initiated sign-out); its page is the last stop.
      const providerSignOut = navigableHttpUrl(out?.providerSignOutUrl)
      if (providerSignOut) { window.location.assign(providerSignOut); return null }
      go({ view: 'project' }, true)
      return null
    } catch (e) {
      if (sessionGeneration.current !== session || guardAuth(e)) return null
      const message = `Could not sign out: ${errMsg(e)}`
      setAppError(message)
      return message
    }
    finally { signOutLock.current = false; setSignOutBusy(false) }
  }

  async function copySnippet(text: string) {
    const gen = projGen.current
    try { await navigator.clipboard.writeText(text); if (projGen.current === gen) setCopied('copied') }
    catch { if (projGen.current === gen) setCopied('failed') }
  }

  const renderedSession = sessionGeneration.current, renderedIntent = intent.current.generation
  const unauthorized = () => { if (sessionGeneration.current === renderedSession) resetSession() }
  // A verified or removed factor changes workspace two-factor locks; re-read memberships so the shell banner and projects follow.
  const factorChanged = () => { if (sessionGeneration.current === renderedSession) refreshMemberships().catch(e => setAppError(errMsg(e))) }
  // The server already ended every session of the closed account; only local state and the neutral notice remain.
  const accountClosed = () => {
    if (sessionGeneration.current !== renderedSession) return
    flushSync(() => resetSession())
    setAuthNotice({ kind: 'info', message: 'The account is closed. You have been signed out.' })
    go({ view: 'project' }, true)
  }

  if (phase === 'recovery') return recovery ? <PasswordRecoveryPanel key={recovery.generation} value={recovery.value} initialEmail={signInEmail}
    onRequest={() => { if (sessionGeneration.current === renderedSession) beginRecovery({ kind: 'request' }) }} onSignIn={changed => { if (sessionGeneration.current !== renderedSession) return; resetSession(); if (changed) setAuthNotice({ kind: 'info', message: 'Password changed. Sign in with your new password. Two-factor authentication is still required if enabled.' }) }} /> : <AppStateScreen state='loading' brand={<AppBrand product='Discover' />} message='Loading…' />

  if (phase === 'loading') return <AppStateScreen state='loading' brand={<AppBrand product='Discover' />} message='Loading…' />

  if (phase === 'error') return <AppStateScreen state='error' brand={<AppBrand product='Discover' />} title='Unable to load account access' message={pageError} onRetry={() => { setPhase('loading'); void boot() }} />

  if (phase === 'setup') return <OwnerForm onSetup={handleSetup} onSignInInstead={(email) => { setSignInEmail(email); setPhase('signin') }} />
  if (phase === 'factor') return <FactorForm onSubmit={handleFactor} onCancel={resetSession} />
  if (inviteToken && !inviteSigningIn) return <InvitePanel token={inviteToken} signedInEmail={me?.user.email ?? null}
    providers={me ? undefined : <OidcSignIn key={inviteToken} invitationToken={inviteToken} />}
    onAccepted={invitationAccepted} onSignIn={() => void invitationSignIn()} onCancel={() => setInviteToken('')} onUnauthorized={unauthorized} />
  if (phase === 'signin') return <SignInForm initialEmail={signInEmail} onSignIn={handleSignIn} notice={authNotice}
    onForgot={email => beginRecovery({ kind: 'request' }, email)}
    onCancel={inviteToken ? () => { sessionGeneration.current += 1; bootGeneration.current += 1; setInviteSigningIn(false) } : undefined} />

  const projectSettingsView = projectSettingsViews.includes(view)
  const settingsView = settingsEntry(view) !== undefined
  // An account without a workspace gets the onboarding screen; account and workspace settings keep the shell.
  if (me && me.workspaces.length === 0 && (!settingsView || projectSettingsView)) return <WorkspaceSetup email={me.user.email} onCreate={createWorkspace} onRefresh={() => { refreshMemberships().catch(e => { setPageError(errMsg(e)); setPhase('error') }) }}
    signOutBusy={signOutBusy} onSignOut={signOut} onAccount={() => go(target('preferences'))} />

  const workspace = me?.workspaces.find((w) => w.id === workspaceId)
  const canWrite = workspace !== undefined && ['owner', 'admin', 'editor'].includes(workspace.role)
  const project = projects?.find((p) => p.id === projectId) ?? null
  const lastReceived = events !== null ? events.events[0]?.receivedAt ?? null : eventsError ? null : project?.lastEventAt ?? null
  const appUrl = (status?.appUrl ?? '').replace(/\/+$/, '')
  const collectPath = status?.collectPath ? ` data-collect-path="${status.collectPath}"` : ''
  const snippet = project !== null ? `<script defer src="${appUrl}${status?.trackerScript ?? '/tracker.js'}" data-site-key="${project.publicKey}"${collectPath} referrerpolicy="no-referrer"></script>` : ''
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(appUrl)
  const projectView = isProjectView(view)
  const toolQuery = toolSearch.trim().toLowerCase()
  const accountView = ['preferences','security','identity'].includes(view)
  const workspaceTool = ['boards','links','pixels'].includes(view)
  const currentSection = sectionOf(view)
  // Page titles repeat the tab or settings label the user just chose; a few modes get a fuller name.
  const pageTitle = ({ compare: 'Compare periods', realtime: 'Live visitors', 'new-project': 'New project', 'tracked-share': 'Shared report' } as Partial<Record<AppView, string>>)[view]
    ?? settingsEntry(view)?.label ?? currentSection?.section.tabs.find(tab => tab.view === view)?.label ?? currentSection?.subTabs?.find(tab => tab.view === view)?.label ?? 'Discover'
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
  const pageScope = accountView || view === 'workspace' ? 'Your account' : settingsEntry(view)?.group === 'operator' ? 'Advanced settings' : projectSettingsView && project ? `Project · ${project.name}` : workspace ? `Workspace · ${workspace.name}` : 'Your workspace'

  const adminRole = workspace !== undefined && ['owner','admin'].includes(workspace.role)
  // One sidebar item per section; it opens the section's first tab and stays selected on every tab and mode within it.
  const sectionNavGroups: SidebarNavGroup[] = [{ id: 'sections', items: appSections.map((section): SidebarNavItem => ({ id: section.id, label: section.label, icon: section.icon, href: section.tabs[0].view,
    current: currentSection?.section.id === section.id, keywords: [...section.tabs.map(tab => tab.label), ...section.keywords] })) }]
  // Settings pages appear in the sidebar only as search results, so "Find a tool" still reaches them.
  const settingsAllowed = (entry: AppView) => entry === 'google-app' || entry === 'identity-providers' ? me!.instanceOperator : entry === 'diagnostics' ? project !== null : entry === 'providers' ? workspace?.role === 'owner' : ['team','keys'].includes(entry) ? adminRole
    : ['domains','destinations'].includes(entry) ? adminRole && project !== null : projectSettingsViews.includes(entry) ? project !== null : entry === 'retention' ? workspace !== undefined : true
  const settingsItems: SettingsNavItem[] = settingsEntries.map(entry => ({ id: entry.view, label: entry.label, group: entry.group, href: entry.view, allowed: settingsAllowed(entry.view) }))
  const settingsSearchGroups: SidebarNavGroup[] = [{ id: 'settings', label: 'Settings', items: settingsItems.filter(item => item.allowed !== false).map(item => ({ id: item.id, label: item.label, icon: 'settings', href: item.id, current: view === item.id, keywords: [...settingsEntry(item.id as AppView)?.keywords ?? []] })) }]
  const sectionTabs = currentSection && (projectView && project !== null || workspaceTool) ? currentSection.section.tabs.map(tab => ({ id: tab.view, label: tab.label, href: tab.view, current: tab.view === currentSection.tab })) : undefined
  const modeTabs = sectionTabs && currentSection?.subTabs?.map(tab => ({ id: tab.view, label: tab.label, href: tab.view, current: tab.view === view }))
  const settingsIntro = view === 'keys' ? 'Keys let your own scripts and AI assistants read this workspace through the ten98 API. Search and AI service accounts are added under Connections.' : view === 'providers' ? 'Connect the search and AI services Discover uses, and pause paid requests at any time.' : view === 'workspace' ? 'Keep each team’s websites and access separate.' : undefined
  const settingsFrame = (content: ReactNode) => <SettingsLayout title={view === 'workspace' ? 'Create workspace' : pageTitle} scope={pageScope} items={settingsItems} current={view} linkComponent={ShellLink} navigationLabel='Settings sections' groupLabels={settingsGroupLabels}>{content}</SettingsLayout>
  const navRoutes: NavRoutes = { search: key => key === 'boards' ? { workspace: workspaceId, view: 'boards' } : key === 'project' || key === 'compare' ? analyticsTarget(key) : key === 'explore' ? exploreTarget() : target(key as AppView),
    analyticsState: previous => ({ ...previous, analyticsReturn: explorerReturnState && me && project && readExplorerReturn(explorerReturnState, me.user.id, workspaceId, project.id) ? explorerReturnState : undefined }) }

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
    <AccountPresentationContext.Provider value={presentation}><NavRoutesContext.Provider value={navRoutes}><AppShell sidebarLabel='Application navigation' skipLinkLabel='Skip to main content' mainLabel='Main content' navigation={{open:menuOpen,onOpenChange:setMenuOpen}}
      sidebar={<>
        <Link to='/' search={target('project')} className='brand-link' aria-label='ten98 Discover home'><AppBrand product='Discover' /></Link>
        <div className='side-body sidebar-nav'><Stack gap={5}>
        <WorkspaceProjectSwitcher workspaces={me!.workspaces.map(item=>({id:item.id,name:item.name,initials:item.name.slice(0,2).toUpperCase(),roleLabel:`${item.role} workspace`}))} projects={workspace?projects:[]} workspaceId={workspaceId||null} projectId={projectId||null}
          onWorkspaceChange={changeWorkspace} onProjectChange={id=>{setMenuOpen(false);go(target('project',id))}} create={canWrite?{label:'Create project',href:'new-project'}:undefined} linkComponent={ShellLink} labels={{noWorkspaces:'No workspaces yet.'}} />
        {workspace&&<SidebarNav label='Sections' linkComponent={ShellLink} filter={toolSearch} groups={toolQuery?[...sectionNavGroups,...settingsSearchGroups]:sectionNavGroups} />}
        </Stack></div>
        <SidebarFooter version={appVersion}>
          {project&&<SidebarStatus tone={lastReceived&&!eventsError?'connected':'idle'} label={eventsError?'Visit history unavailable':lastReceived?'Receiving visits':'Waiting for the first visit'}/>}
          <Link className={`nav-item${settingsView?' selected':''}`} to='/' search={target(project?'installation':'preferences')}><AppIcon name='settings'/><span>Settings</span></Link>
        </SidebarFooter>
      </>}
      topbar={<AppTopbar wrap menuToggle menuLabel='Menu' breadcrumb={{icon:accountView?'users':'folder',scope:accountView?'Your account':projectView?project?.name??workspace?.name??'Your workspace':workspace?.name??'Your workspace',current:pageTitle}} search={<SearchField variant='topbar' label='Find a tool' hideLabel placeholder='Find a tool…' value={toolSearch} onValueChange={setToolSearch} onClear={()=>setToolSearch('')} clearLabel='Show all tools' status={toolQuery?`Tools matching “${toolSearch.trim()}”`:undefined} />} badge={{label:'Development preview',hideOnMobile:true}} actions={<AccountMenu name={me!.user.name||'Account'} email={me!.user.email} avatar={<span className='avatar'>{me!.user.name.trim().split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase()||'98'}</span>}><Link to='/' search={target('preferences')}>Profile</Link><Link to='/' search={target('security')}>Security</Link><Link to='/' search={target('identity')}>Sign-in methods</Link><button type='button' disabled={signOutBusy} aria-busy={signOutBusy||undefined} onClick={()=>void signOut()}>{signOutBusy?'Signing out…':'Sign out'}</button></AccountMenu>} />}>
        <div className='page-content content'><Stack gap={6}>

        {!projectView&&!settingsView&&!workspaceTool&&project&&<Banner tone='info' linkComponent={ShellLink} action={{label:`Return to ${project.name}`,icon:'arrow-right',href:'project'}}>Selected project</Banner>}
        {workspace?.twoFactorLocked&&<Banner tone='warning' icon='shield' title='Two-factor authentication required' linkComponent={ShellLink} action={{label:'Open security settings',href:'security'}}>This workspace requires two-factor authentication. Turn it on in Security settings to open its websites and reports.</Banner>}
        {authNotice && <Alert tone={authNotice.kind === 'error' ? 'danger' : 'info'} onDismiss={() => setAuthNotice(null)}>{authNotice.message}</Alert>}
        {appError !== '' && <Alert tone='danger'>{appError}</Alert>}
        {projectsError !== '' && <Alert tone='danger' actions={<Button variant='secondary' onClick={() => void loadProjects(activeWorkspace.current)}>Retry projects</Button>}>{projectsError}</Alert>}
        {navigationPending ? <p role='status'>Loading the selected project…</p> : <>
        {/* First-strong isolates keep a right-to-left project name from reordering the origin (same isolation as <bdi> without adding raw elements). */}
        {project && workspace && projectView && !settingsView && <PageHeader title={currentSection?.section.label ?? pageTitle} description={`⁨${project.name}⁩ · ⁨${project.origin}⁩`}
          actions={view === 'project' && adminRole ? <WebsiteQuickShare key={project.id} projectId={project.id} onUnauthorized={unauthorized} /> : undefined} />}
        {!projectView && !settingsView && view !== 'new-project' && <PageHeader eyebrow={pageScope} title={currentSection?.section.label ?? pageTitle} />}
        {sectionTabs && <SectionNav label={`${currentSection!.section.label} pages`} items={sectionTabs} linkComponent={ShellLink} />}
        {modeTabs && <SectionNav label={`${currentSection!.section.tabs.find(tab => tab.view === currentSection!.tab)!.label} views`} items={modeTabs} linkComponent={ShellLink} />}
        {settingsView && !projectSettingsView && settingsFrame(<>
        {settingsIntro && <Text tone='muted'>{settingsIntro}</Text>}
        {view === 'workspace' && <WorkspaceCreateSection onCreate={createWorkspace} />}
        {view === 'team' && workspace && me && ['owner','admin'].includes(workspace.role) && <TeamPanel key={workspaceId} workspaceId={workspaceId} userId={me.user.id} onChanged={refreshMemberships} onUnauthorized={unauthorized} />}
        {view === 'preferences' && me && <AccountPreferencesPanel key={me.user.id} expectedUserId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'security' && me && <><AccountSecurityPanel key={me.user.id} expectedUserId={me.user.id} onUnauthorized={unauthorized} onFactorChanged={factorChanged} /><AccountClosurePanel key={`closure:${me.user.id}`} userId={me.user.id} onClosed={accountClosed} onUnauthorized={unauthorized} onOpenTeam={id => go({ workspace: id, view: 'team' })} onOpenIdentity={() => go(target('identity'))} /><Link className='btn' to='/' search={target('identity')}>Manage identity sign-in and recovery</Link></>}
        {view === 'identity' && me && <>
          <OidcRecoveryPanel key={me.user.id} userId={me.user.id} proofId={oidcProofId} onUnauthorized={unauthorized} onClosed={accountClosed} onProofHandled={() => { oidcProof.current = undefined; setOidcProofId(undefined) }} />
          <OidcPanel key={`${me.user.id}:${me.instanceOperator}`} userId={me.user.id} instanceOperator={me.instanceOperator} proofId={oidcProofId} onUnauthorized={unauthorized} onProofHandled={() => { oidcProof.current = undefined; setOidcProofId(undefined) }}  part='account' />
        </>}
        {view === 'keys' && workspace && me && ['owner','admin'].includes(workspace.role) && <ApiKeysPanel key={`${me.user.id}:${workspaceId}`} workspaceId={workspaceId} onUnauthorized={unauthorized} />}
        {view === 'providers' && workspace?.role === 'owner' && me && <ProviderPanel key={`${me.user.id}:${workspaceId}`} workspaceId={workspaceId} onUnauthorized={unauthorized} />}
        {view === 'retention' && workspace && me && <RetentionPanel workspaceId={workspaceId} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'google-app' && me?.instanceOperator && <GoogleAppPanel userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'identity-providers' && me?.instanceOperator && <OidcPanel key={`${me.user.id}:operator`} userId={me.user.id} instanceOperator proofId={oidcProofId} onUnauthorized={unauthorized} onProofHandled={() => { oidcProof.current = undefined; setOidcProofId(undefined) }} part='operator' />}
        {view === 'diagnostics' && project && (
            <section className='card diagnostics' aria-labelledby='wc-h' aria-busy={checkBusy || jobsBusy}>
              <div className='row between'>
                <h2 id='wc-h'>Worker check</h2>
                <div className='row'>
                  {canWrite && <button className='btn primary' disabled={checkBusy} onClick={() => void runCheck(project.id)}>{checkBusy ? 'Starting…' : 'Run worker check'}</button>}
                  <button className='btn' disabled={jobsBusy} onClick={() => void loadJobs(project.id)}>{jobsBusy ? 'Refreshing…' : 'Refresh status'}</button>
                </div>
              </div>
              <p className='dim'>Checks whether the background worker can receive and complete a job. Choose Refresh status to see its result.</p>
              {jobError !== '' && <Alert tone='danger'>{jobError}</Alert>}
              {jobs === null && jobError === '' && <p role='status' className='dim'>Loading checks…</p>}
              {jobs !== null && jobs.length === 0 && <div className='empty'><p><strong>No checks yet.</strong> Run a check to verify that background processing is working.</p></div>}
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
        )}
        </>)}
        {(view==='links'||view==='pixels')&&workspace&&me&&<TrackedAssetsPanel workspaceId={workspaceId} userId={me.user.id} role={workspace.role} kind={view==='links'?'link':'pixel'} appUrl={appUrl} query={search.assetInvalid?'unsupported=1':search.assetQuery} readOwner={routeLocation.state.__TSR_key??routeLocation.href} readEnabled={search.workspace===workspaceId&&search.view===view&&navigationKey(parseNavigation(routeLocation.search))===navigationKey(search)&&canonicalNavigation(routeLocation.searchStr,search)} onNavigate={(query,kind)=>go({workspace:workspaceId,view:kind==='pixel'?'pixels':kind==='link'?'links':view,...query?{assetQuery:query}:{}})} onUnauthorized={unauthorized}/>}
        {view === 'collection' && project && workspace && me && settingsFrame(<AnalyticsSettingsPanel projectId={project.id} userId={me.user.id} workspaceId={workspace.id} onDeleted={()=>{if(activeWorkspace.current!==workspace.id||activeProject.current!==project.id||currentMe.current?.user.id!==me.user.id)return;activateProject('');loadedProjects.current=(loadedProjects.current??[]).filter(item=>item.id!==project.id);setProjects(loadedProjects.current);go({workspace:workspace.id,view:'project'},true);void loadProjects(workspace.id);}} readOwner={(routeLocation.state.__TSR_key??routeLocation.href)+':'+workspace?.role} readEnabled={!navigationPending&&search.workspace===workspaceId&&search.project===project.id&&search.view==='collection'&&canonicalNavigation(routeLocation.searchStr,search)} isCurrent={()=>sessionGeneration.current===renderedSession&&intent.current.generation===renderedIntent&&currentMe.current!==null&&currentMe.current.user.id===me.user.id&&activeWorkspace.current===workspaceId&&activeProject.current===project.id&&(router.state.location.state.__TSR_key??router.state.location.href)===(routeLocation.state.__TSR_key??routeLocation.href)&&navigationKey(parseNavigation(router.state.location.search))===navigationKey(search)&&currentMe.current.workspaces.some(w=>w.id===workspaceId&&w.role===workspace?.role)} onUnauthorized={unauthorized} />)}
        {view === 'campaigns' && project && me && <UtmPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'explore' && project && me && <ExplorerPanel projectId={project.id} userId={me.user.id} search={search} onAppliedRange={rememberAnalyticsRange} onNavigate={value=>go({...target('explore'),...value})} onUnauthorized={unauthorized} />}
        {view === 'compare' && project && me && <AnalyticsPanel projectId={project.id} userId={me.user.id} compareView onAppliedRange={rememberAnalyticsRange} search={{...target('compare'),...(search.workspace===workspaceId&&search.project===project.id?analyticsNavigation(search):{})}} onNavigate={value=>go({...target('compare'),...value})} onUnauthorized={unauthorized} />}
        {view === 'performance' && project && me && <WebPerformancePanel projectId={project.id} userId={me.user.id} query={search.performanceInvalid?'unsupported=1':search.performanceQuery} readOwner={routeLocation.state.__TSR_key??routeLocation.href} readEnabled={search.workspace===workspaceId&&search.project===project.id&&navigationKey(parseNavigation(routeLocation.search))===navigationKey(search)&&canonicalNavigation(routeLocation.searchStr,search)} onNavigate={query=>go({...target('performance'),performanceQuery:query})} onUnauthorized={unauthorized} onSettings={()=>go(target('collection'))}/>}
        {view === 'boards' && workspace && me && <BoardsPanel workspaceId={workspaceId} userId={me.user.id} projects={projects??[]} query={search.boardInvalid?'unsupported=1':search.boardQuery} readOwner={routeLocation.state.__TSR_key??routeLocation.href} readEnabled={!navigationPending&&search.workspace===workspaceId&&search.project===undefined&&navigationKey(parseNavigation(routeLocation.search))===navigationKey(search)&&canonicalNavigation(routeLocation.searchStr,search)} onNavigate={query=>go({workspace:workspaceId,view:'boards',...(query?{boardQuery:query}:{})})} onUnauthorized={unauthorized}/>}
        {view === 'replays' && project && me && <SessionReplayPanel projectId={project.id} userId={me.user.id} query={search.replayInvalid?'unsupported=1':search.replayQuery} readOwner={routeLocation.state.__TSR_key??routeLocation.href} readEnabled={search.workspace===workspaceId&&search.project===project.id&&navigationKey(parseNavigation(routeLocation.search))===navigationKey(search)&&canonicalNavigation(routeLocation.searchStr,search)} onNavigate={query=>go({...target('replays'),...(query?{replayQuery:query}:{})})} onUnauthorized={unauthorized} onSettings={()=>go(target('collection'))}/>}
        {view === 'heatmaps' && project && me && <HeatmapsPanel projectId={project.id} userId={me.user.id} query={search.heatmapInvalid?'unsupported=1':search.heatmapQuery} readOwner={routeLocation.state.__TSR_key??routeLocation.href} readEnabled={search.workspace===workspaceId&&search.project===project.id&&navigationKey(parseNavigation(routeLocation.search))===navigationKey(search)&&canonicalNavigation(routeLocation.searchStr,search)} onNavigate={query=>go({...target('heatmaps'),...(query?{heatmapQuery:query}:{})})} onUnauthorized={unauthorized} onSettings={()=>go(target('collection'))}/>}
        {view === 'realtime' && project && me && <RealtimePanel projectId={project.id} userId={me.user.id} origin={project.origin} onUnauthorized={unauthorized} onOpenSession={value=>go({...target('sessions'),...value})}/>}
        {view === 'conversions' && project && me && <ConversionsPanel projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'context' && project && me && settingsFrame(<ContextPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />)}
        {view === 'prompts' && project && me && <PromptsPanel key={`${me.user.id}:${project.id}`} workspaceId={workspaceId} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} onAISearch={(promptId,versionId,capture)=>{const intent=readAISearchIntent()!;go({...target('ai-search'),aiSearchQuery:aiSearchIntentQuery({...intent,section:capture?'captures':'analysis',create:capture,filters:{...intent.filters,promptId,versionId}})});}} />}
        {view === 'ai-search' && project && me && <AISearchPanel workspaceId={workspaceId} projectId={project.id} userId={me.user.id} search={search} onNavigate={value=>go({...target('ai-search'),...value})} onUnauthorized={unauthorized} onPrompts={()=>go(target('prompts'))} onProviders={()=>go(target('providers'))}/>}
        {view === 'ai-insights' && project && me && <AIInsightsSection key={`${me.user.id}:${workspaceId}:${project.id}`} workspaceId={workspaceId} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} onBack={() => go(target('prompts'))} />}
        {view === 'keywords' && project && me && <KeywordResearchPanel workspaceId={workspaceId} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'domain-seo' && project && me && <DomainResearchPanel workspaceId={workspaceId} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'ranks' && project && me && <Suspense fallback={<p role="status">Loading rank tracking…</p>}><RankTrackingPanel workspaceId={workspaceId} projectId={project.id} userId={me.user.id} origin={project.origin} onUnauthorized={unauthorized} onOpenProviders={() => go(target('providers'))} /></Suspense>}
        {view === 'audits' && project && me && <SiteAuditPanel projectId={project.id} userId={me.user.id} search={{...target('audits'),...(search.workspace===workspaceId&&search.project===project.id?auditNavigation(search):{})}} onNavigate={(value,replace) => go({...target('audits'),...value},replace)} onUnauthorized={unauthorized} onOpenDomains={() => go(target('domains'))} onOpenRetention={() => go(target('retention'))} />}
        {view === 'reports' && project && me && <ReportsPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />}
        {view === 'google' && project && me && <GoogleReportsPanel projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} onOpenSetup={me.instanceOperator ? () => go(target('google-app')) : undefined} part='reports' onManage={() => go(target('imports'))} />}
        {view === 'imports' && project && me && settingsFrame(<GoogleReportsPanel projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} onOpenSetup={me.instanceOperator ? () => go(target('google-app')) : undefined} part='setup' />)}
        {view === 'domains' && project && workspace && me && ['owner','admin'].includes(workspace.role) && settingsFrame(<DomainsPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} onInstallTracker={() => go(target('installation'))} />)}
        {view === 'destinations' && project && workspace && me && ['owner','admin'].includes(workspace.role) && settingsFrame(<>
          <DestinationsPanel key={`${me.user.id}:${project.id}`} projectId={project.id} userId={me.user.id} onUnauthorized={unauthorized} />
        </>)}
        {(view === 'new-project' || (projectView && projects !== null && project === null)) && workspace && canWrite && (
          <><PageHeader title={projects !== null && projects.length > 0 ? 'Add a website' : 'Add your website'} description='Next you add one line of tracking code to your site.' />
          <ProjectCreateSection key={workspaceId} onCreate={createProject} /></>
        )}
        {projectView && workspace && projects !== null && project === null && !canWrite && (
          <section className='card'>
            <h1>{projects.length ? 'Choose a project' : 'No project to show'}</h1>
            <p>{projects.length ? 'Select a project from the sidebar to view its analytics.' : 'Your role in this workspace is view-only. Ask a workspace admin to create a project or give you access to one.'}</p>
          </section>
        )}
        {view === 'project' && workspace && project !== null && (
          <>
            {events?.total === 0 && <section className='connection-callout'><div><strong>No retained events available.</strong><p>Add the tracking code to your site. Privacy settings choose when analytics starts.</p></div><Link className='btn primary' to='/' search={target('installation')}>Get tracking code</Link></section>}
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
                  {eventsReadAt !== null && <Text tone='muted' title={eventsReadAt}>Read {formatReportInstant(eventsReadAt,'UTC')}</Text>}
                </div>
                <button className='btn' disabled={eventsBusy} onClick={() => void loadEvents(project.id)}>{eventsBusy ? 'Refreshing…' : 'Refresh events'}</button>
              </div>
              {(events?.retainedFrom ?? project.retainedFrom) && <p className='hint' title={(events?.retainedFrom ?? project.retainedFrom)!}>History before {formatReportInstant((events?.retainedFrom ?? project.retainedFrom)!,'UTC')} is unavailable after retention. This is not a lifetime total.</p>}
              {lastReceived !== null && <p className='dim' title={lastReceived}>Last retained event received {formatReportInstant(lastReceived,'UTC')}</p>}
              {eventsError !== '' && <Alert tone='danger'>{eventsError}</Alert>}
              {events === null && eventsError === '' && <p role='status' className='dim'>Loading events…</p>}
              {events !== null && events.events.length === 0 && (
                <div className='empty'>
                  <p><strong>No retained events available.</strong></p>
                  <p>Install your tracker, allow analytics in Tracking preferences, then refresh this list. Counts include only retained events the collector has persisted.</p><Link className='btn' to='/' search={target('installation')}>Get tracking code</Link>
                </div>
              )}
              {events !== null && events.events.length > 0 && (
                <>
                  <DataTable caption='Retained event rows' captionHidden responsive='stack' searchable={false} sortable={false} pagination={false} rows={events.events} rowKey={ev => ev.id}
                    columns={[{ key: 'event', header: 'Event', rowHeader: true, wrap: true, render: ev => ev.eventName }, { key: 'origin', header: 'Origin', wrap: true, render: ev => <bdi dir='ltr'>{ev.origin}</bdi> },
                      { key: 'path', header: 'Path', wrap: true, render: ev => <bdi dir='ltr'>{ev.path}</bdi> }, { key: 'received', header: 'Received', render: ev => <time dateTime={ev.receivedAt} title={ev.receivedAt}>{formatReportInstant(ev.receivedAt,'UTC')}</time> }]} />
                  <p className='dim footnote'>Showing the latest {events.events.length} of {events.total} persisted events.</p>
                </>
              )}
            </section>
        )}
        {view === 'installation' && workspace && project !== null && settingsFrame(
          <>
            <section className='card installation-panel' aria-labelledby='snip-h'>
              <div className='row between installation-toolbar'>
                <h2 id='snip-h'>Tracking snippet</h2>
                <Button style={{minHeight:44,whiteSpace:'normal'}} variant={copied === 'copied' || (events?.total ?? 0) > 0 ? 'secondary' : 'primary'} onClick={() => void copySnippet(snippet)}>Copy snippet</Button>
              </div>
              <p>Add this tag inside the <code>&lt;head&gt;</code> of every page you want to measure on <strong>{project.origin}</strong>.</p>
              <pre className='snippet' role='region' aria-label='Tracking snippet' tabIndex={0}><code>{snippet}</code></pre>
              {copied === 'copied' && <p role='status' className='dim'>Copied to clipboard.</p>}
              {copied === 'failed' && <p role='alert' className='dim'>Copy failed — select the snippet text above and copy it manually.</p>}
              <p className='dim footnote'>Use <Link to='/' search={target('domains')}>Domains</Link> for other serving domains. <Link to='/' search={target('collection')}>Privacy settings</Link> control consent and optional data. Browser privacy signals and explicit refusals stop collection.{isLocal ? ' External websites cannot reach this localhost collector; deploy it at a public HTTPS address first.' : ''}</p>
              <details className='installation-help'>
                <summary>Custom events and collection details</summary>
                <p className='dim footnote'>When collection is allowed, page loads and SPA path changes are observed automatically. Call <code>window.ten98.track('signup', {'{'}plan: 'starter'{'}'})</code> for a custom event with optional properties. Use fixed event names and avoid personal data. Native page URLs omit queries and fragments; optional metadata follows Privacy settings. Advertising pixels and visitor identification still need explicit consent.</p>
                <p>For buttons and links, you can also declare an event in your HTML:</p>
                <pre className='snippet' tabIndex={0} aria-label='HTML custom event example'><code>{'<button type="button" data-ten98-event="signup" data-ten98-event-plan="starter">Sign up</button>'}</code></pre>
                <p className='dim footnote'>Only the nearest element with a declared event is tracked. Attribute properties are passed as strings; use the JavaScript call for numbers, arrays, nested properties or advertising conversion fields. Use fixed, non-personal values. Click tracking does not delay navigation, and delivery during navigation is best effort.</p>
              </details>
            </section>
            <section aria-label='Check website events' aria-busy={eventsBusy} style={{minWidth:0,overflowWrap:'anywhere'}}>
              <ResourceCard title='Check that events arrive' description='Open your website, visit a page, then check for an event received by this project.' icon='chart'
                actions={<><a className='btn' style={{minHeight:44,whiteSpace:'normal',maxWidth:'100%'}} href={project.origin} target='_blank' rel='noopener noreferrer'>Open website<AppIcon name='arrow' size={15}/><span className='sr-only'> (opens in a new tab)</span></a><Button style={{minHeight:44,whiteSpace:'normal'}} variant={copied === 'copied' && (events?.total ?? 0) === 0 ? 'primary' : 'secondary'} disabled={eventsBusy} onClick={() => void loadEvents(project.id)}>{eventsBusy ? 'Checking…' : 'Check for events'}</Button><Button style={{minHeight:44,whiteSpace:'normal'}} variant={events !== null && events.total > 0 ? 'primary' : 'secondary'} href='project' component={ShellLink}>View analytics</Button></>}>
                <TrackerStatus resource={project.origin}
                  installation={{state:'not-checked',reason:'This view does not inspect website installation. Manage serving domains in Domains.'}}
                  receipt={{state:eventsError ? 'unavailable' : events === null ? 'not-checked' : events.total > 0 ? 'received' : 'waiting',reason:eventsError ? 'Event history could not be checked. Any receipt below is from the previous successful check.' : eventsBusy ? 'Checking retained event history again. Any receipt below is from the previous successful check.' : events === null ? 'Check for events to read retained event history.' : 'Retained event history does not confirm the tracker is installed or currently collecting.'}}/>
                {eventsError && <Alert title='Could not check events' tone='danger'><p>{eventsError} Try checking again.{events !== null && ' Results below are from the previous successful check.'}</p></Alert>}
                {(events?.total ?? 0) > 0 && <><StatusLine tone='success'>Tracking works: visits are arriving from {project.origin}.</StatusLine><Button style={{minHeight:44,whiteSpace:'normal'}} href='project' component={ShellLink}>Go to dashboard</Button></>}
                {events !== null && events.events.length > 0 && <p>Latest retained event: <strong>{events.events[0].eventName}</strong> on <bdi>{events.events[0].path}</bdi>, received <time dateTime={events.events[0].receivedAt} title={events.events[0].receivedAt}>{formatReportInstant(events.events[0].receivedAt,'UTC')}</time>.</p>}
                {events !== null && events.total === 0 && <StatusLine>Waiting for the first visit. Open your website in another tab; this page checks again for 10 minutes. If your site asks visitors for consent, accept analytics first.</StatusLine>}
                {events === null && !eventsBusy && !eventsError && <p>Check for events to see whether the collector has received website activity.</p>}
                <Button style={{minHeight:44,whiteSpace:'normal'}} variant='ghost' href='events' component={ShellLink}>Inspect recent events</Button>
              </ResourceCard>
            </section>
          </>
        )}
        </>}

        </Stack></div>
    </AppShell></NavRoutesContext.Provider></AccountPresentationContext.Provider>
  )
}

function AIInsightsSection(props:{workspaceId:string;projectId:string;userId:string;onUnauthorized:()=>void;onBack:()=>void}) {
  return <AIInsightsPanel {...props} backLabel='Back to prompts' />
}

// A status-0 ApiError means the request may or may not have completed; every other failure is a definite error.
type AuthOutcome = { error: string; unconfirmed: string }
const noOutcome: AuthOutcome = { error: '', unconfirmed: '' }
function failureOutcome(e: unknown): AuthOutcome {
  const message = errMsg(e)
  return e instanceof ApiError && e.status === 0 ? { error: '', unconfirmed: message } : { error: message, unconfirmed: '' }
}

function OwnerForm({ onSetup, onSignInInstead }: { onSetup: (v: SetupValues) => Promise<void>; onSignInInstead: (email: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(noOutcome)
  const [ownerExists, setOwnerExists] = useState(false)
  // Remounting after success clears the setup token and password; the other entries are kept.
  const [form, setForm] = useState({ generation: 0, name: '', email: '', workspaceName: '' })

  async function submit(v: FirstUserSetupValues) {
    const values = { token: v.token.trim(), name: v.name.trim(), email: v.email.trim(), password: v.password, workspaceName: (v.workspaceName ?? '').trim() }
    setBusy(true); setOutcome(noOutcome); setOwnerExists(false)
    setForm(f => ({ ...f, name: values.name, email: values.email, workspaceName: values.workspaceName }))
    try {
      await onSetup(values)
      setForm(f => ({ ...f, generation: f.generation + 1 }))
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setOwnerExists(true)
      setOutcome(failureOutcome(err))
    } finally { setBusy(false) }
  }

  return <FirstUserSetupFlow key={form.generation} brand={<AppBrand product='Discover' />} aside={authStory} label='Account access' title='Create owner account'
    description='Create the owner account and its default workspace. The setup token comes from your server configuration.'
    workspaceName passwordPolicy={{ minLength: 12, maxLength: 128, hint: 'At least 12 characters.' }}
    defaultValues={{ name: form.name, email: form.email, workspaceName: form.workspaceName }}
    busy={busy} error={outcome.error || undefined} unconfirmed={outcome.unconfirmed || undefined}
    signInInstead={ownerExists ? { onClick: email => onSignInInstead(email.trim()) } : undefined} onSubmit={submit} />
}

function SignInForm({ initialEmail, onSignIn, onForgot, onCancel, notice }: { initialEmail: string; onSignIn: (email: string, password: string) => Promise<void>; onForgot: (email: string) => void; onCancel?: () => void; notice?: {message: string; kind: 'info' | 'error'} | null }) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(noOutcome)

  async function submit(v: SignInValues) {
    setBusy(true); setOutcome(noOutcome)
    try { await onSignIn(v.email.trim(), v.password) }
    catch (err) { setOutcome(failureOutcome(err)) }
    finally { setBusy(false) }
  }

  return <SignInFlow brand={<AppBrand product='Discover' />} aside={authStory} label='Account access' title='Sign in' defaultValues={{ email: initialEmail }}
    busy={busy} error={outcome.error || undefined} unconfirmed={outcome.unconfirmed || undefined}
    notice={notice ? { tone: notice.kind === 'error' ? 'danger' : 'info', text: notice.message } : undefined}
    forgotPassword={{ onClick: email => onForgot(email.trim()) }} cancel={onCancel ? { label: 'Back to invitation', onClick: onCancel } : undefined}
    providers={<OidcSignIn />} onSubmit={submit} />
}

function FactorForm({ onSubmit, onCancel }: { onSubmit: (code: string, recovery: boolean) => Promise<void>; onCancel: () => void }) {
  const [mode, setMode] = useState<TwoFactorMode>('authenticator')
  const [outcome, setOutcome] = useState(noOutcome)
  const [busy, setBusy] = useState(false)
  async function submit(v: TwoFactorValues) {
    setBusy(true); setOutcome(noOutcome)
    try { await onSubmit(v.code.trim(), v.mode === 'recovery') }
    catch (e) { setOutcome(failureOutcome(e)) }
    finally { setBusy(false) }
  }
  return <TwoFactorChallengeFlow brand={<AppBrand product='Discover' />} aside={authStory} label='Account access' title='Verify your sign-in' mode={mode}
    onModeChange={next => { setMode(next); setOutcome(noOutcome) }} busy={busy} error={outcome.error || undefined} unconfirmed={outcome.unconfirmed || undefined}
    messages={{ authenticatorLabel: 'Authenticator code', authenticatorDescription: 'Enter the six-digit code from your authenticator app.', recoveryDescription: 'Enter one unused recovery code. Each code can only be used once.', useAuthenticator: 'Use authenticator' }}
    cancel={{ label: 'Back to sign in', onClick: onCancel }} onSubmit={submit} />
}

// Values stay in the uncontrolled fields after an error; a successful create remounts the form empty.
function ProjectCreateSection({ onCreate }: { onCreate: (name: string, origin: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<{ generation: number; error: string; fieldErrors?: { name?: string; origin?: string } }>({ generation: 0, error: '' })

  async function submit(v: { name: string; origin?: string }) {
    const name = v.name.trim()
    if (name === '') { setState(s => ({ ...s, error: '', fieldErrors: { name: 'Enter a name for this website.' } })); return }
    const parsed = parseWebsiteAddress(v.origin ?? '')
    if (!parsed.origin) { setState(s => ({ ...s, error: '', fieldErrors: { origin: parsed.error ?? 'Enter a valid website address.' } })); return }
    setBusy(true); setState(s => ({ ...s, error: '', fieldErrors: undefined }))
    try { await onCreate(name, parsed.origin); setState(s => ({ generation: s.generation + 1, error: '' })) }
    catch (err) { setState(s => ({ ...s, error: errMsg(err) })) }
    finally { setBusy(false) }
  }

  return <ProjectCreateFlow key={state.generation} mode='create' hideTitle title='Add website' defaultValues={{ name: '', origin: '' }} busy={busy} busyLabel='Adding…'
    error={state.error || undefined} fieldErrors={state.fieldErrors} onSubmit={submit}
    messages={{ nameLabel: 'Website name', originLabel: 'Website address', originHint: 'For example https://example.com. You can paste any page of your site.', create: 'Add website' }} />
}

// Shared by the onboarding screen and the New workspace settings tab.
function useWorkspaceNameSubmit(onCreate: (name: string) => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<AuthOutcome & { field?: string }>(noOutcome)
  async function submit(v: WorkspaceCreateValues) {
    const name = v.name.trim()
    if (name === '') { setOutcome({ ...noOutcome, field: 'Enter a workspace name.' }); return }
    setBusy(true); setOutcome(noOutcome)
    try { await onCreate(name) }
    catch (e) { const failure = failureOutcome(e); setOutcome(failure.error ? { ...failure, error: `Could not create the workspace: ${failure.error}` } : failure) }
    finally { setBusy(false) }
  }
  return { busy, error: outcome.error || undefined, unconfirmed: outcome.unconfirmed || undefined, fieldErrors: outcome.field ? { name: outcome.field } : undefined, submit, clear: () => setOutcome(noOutcome) }
}

function WorkspaceCreateSection({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const { submit, clear: _clear, ...state } = useWorkspaceNameSubmit(onCreate)
  return <WorkspaceCreateFlow mode='create' hideTitle title='Create workspace' defaultValues={{ name: '' }} busyLabel='Creating…' {...state} onSubmit={submit}
    messages={{ nameLabel: 'Workspace name', create: 'Create workspace' }} />
}

// The screen shows its own most recent failure: starting a sign-out clears a create error and starting a create clears a sign-out error.
function WorkspaceSetup({ email, onCreate, onRefresh, onSignOut, signOutBusy, onAccount }: { email: string; onCreate: (name: string) => Promise<void>; onRefresh: () => void; onSignOut: () => Promise<string | null>; signOutBusy: boolean; onAccount: () => void }) {
  const [signOutError, setSignOutError] = useState('')
  const { submit, clear, ...state } = useWorkspaceNameSubmit(name => { setSignOutError(''); return onCreate(name) })
  const signOut = async () => { clear(); setSignOutError(''); const failure = await onSignOut(); if (failure) setSignOutError(failure) }
  return <WorkspaceOnboarding brand={<AppBrand product='Discover' />} aside={authStory} label='Account access' email={email} help='Keep each team’s projects and access separate.'
    {...state} error={signOutError || state.error} onSubmit={submit} onRefresh={onRefresh} signOut={{ label: signOutBusy ? 'Signing out…' : 'Sign out', onClick: () => void signOut() }} account={{ label: 'Account settings', onClick: onAccount }} />
}
