export const views = ['project', 'new-project', 'team', 'workspace', 'security', 'providers', 'keys', 'destinations', 'identity', 'collection', 'domains', 'reports', 'installation', 'events', 'retention', 'context', 'prompts', 'ai-insights', 'explore', 'google', 'google-app', 'meta', 'meta-app', 'meta-reports', 'keywords', 'ranks', 'audits', 'conversions'] as const
export type AppView = typeof views[number]
export type NavigationSearch = { workspace?: string; project?: string; view: AppView }

export function navigationId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

// Search values are untrusted: TanStack can parse JSON values and repeated keys.
export function parseNavigation(raw: Record<string, unknown>): NavigationSearch {
  const workspace = navigationId(raw.workspace) ? raw.workspace.toLowerCase() : undefined
  return {
    ...(workspace ? { workspace } : {}),
    ...(workspace && navigationId(raw.project) ? { project: raw.project.toLowerCase() } : {}),
    view: typeof raw.view === 'string' && (views as readonly string[]).includes(raw.view) ? raw.view as AppView : 'project',
  }
}

export function navigationKey(search: NavigationSearch): string {
  return `${search.workspace ?? ''}:${search.project ?? ''}:${search.view}`
}

export function canonicalNavigation(search: string, target: NavigationSearch): boolean {
  const params = new URLSearchParams(search)
  const entries = Object.entries(target).filter(([, value]) => value !== undefined)
  return [...params].length === entries.length && entries.every(([key, value]) => params.getAll(key).length === 1 && params.get(key) === value)
}

export function projectView(view: AppView): boolean {
  return ['project', 'destinations', 'collection', 'domains', 'reports', 'installation', 'events', 'context', 'prompts', 'ai-insights', 'explore', 'google', 'meta', 'meta-reports', 'keywords', 'ranks', 'audits', 'conversions'].includes(view)
}

export function allowedView(view: AppView, role: string | undefined, operator: boolean): boolean {
  if (view === 'google-app' || view === 'meta-app') return operator
  if (['security', 'identity', 'workspace', 'project'].includes(view)) return true
  if (!role) return false
  if (view === 'providers') return role === 'owner'
  if (['team', 'keys', 'domains', 'destinations'].includes(view)) return ['owner', 'admin'].includes(role)
  if (view === 'new-project') return ['owner', 'admin', 'editor'].includes(role)
  return true
}

export type CallbackIntent =
  | { kind: 'google'; workspace: string; project: string }
  | { kind: 'google-error' }
  | { kind: 'meta'; workspace: string; project: string }
  | { kind: 'meta-error' }
  | { kind: 'proof'; proof: string }
  | { kind: 'factor' | 'complete' | 'identity-error' }
  | { kind: 'invite'; token: string }
  | { kind: 'invalid' }

// Read the raw browser fragment once. Router location.hash is already decoded.
export function parseCallback(hash: string): CallbackIntent | null {
  if (!hash) return null
  if (hash.length > 4096) return { kind: 'invalid' }
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const keys = [...params.keys()]
  const google = keys.some(key => key === 'google' || key.startsWith('google-'))
  const meta = keys.some(key => key === 'meta' || key.startsWith('meta-'))
  const oidc = keys.some(key => key.startsWith('oidc-'))
  const invite = params.has('invite')
  if ([google, meta, oidc, invite].filter(Boolean).length !== 1 || keys.some(key => params.getAll(key).length !== 1)) return { kind: 'invalid' }
  if (meta) {
    const workspace = params.get('meta-workspace'), project = params.get('meta-project')
    if (params.get('meta') === 'connected' && keys.length === 3 && navigationId(workspace) && navigationId(project)) return { kind: 'meta', workspace: workspace.toLowerCase(), project: project.toLowerCase() }
    if (params.get('meta') === 'failed' && keys.length === 1) return { kind: 'meta-error' }
    return { kind: 'invalid' }
  }
  if (google) {
    const workspace = params.get('google-workspace'), project = params.get('google-project')
    if (params.get('google') === 'connected' && keys.length === 3 && navigationId(workspace) && navigationId(project)) return { kind: 'google', workspace: workspace.toLowerCase(), project: project.toLowerCase() }
    return { kind: 'google-error' }
  }
  if (oidc && keys.length === 1) {
    const proof = params.get('oidc-proof')
    if (navigationId(proof)) return { kind: 'proof', proof }
    if (params.get('oidc-factor') === '1') return { kind: 'factor' }
    if (params.get('oidc-complete') === '1') return { kind: 'complete' }
    return { kind: 'identity-error' }
  }
  const token = params.get('invite')
  if (invite && keys.length === 1 && token?.length === 43 && /^[A-Za-z0-9_-]+$/.test(token)) return { kind: 'invite', token }
  return { kind: 'invalid' }
}
