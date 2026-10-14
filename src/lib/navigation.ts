export const views = ['project', 'new-project', 'team', 'workspace', 'security', 'providers', 'keys', 'destinations', 'identity', 'collection', 'domains', 'reports', 'installation', 'events', 'retention', 'context', 'prompts', 'ai-insights', 'explore', 'sessions', 'google', 'google-app', 'meta', 'meta-app', 'meta-reports', 'keywords', 'ranks', 'audits', 'conversions'] as const
export type AppView = typeof views[number]
export type SessionNavigation = {from?:string;to?:string;timeZone?:string;visitorKey?:string;cohortId?:string;cohortRevision?:string;segmentId?:string;segmentRevision?:string;sessionInvalid?:'1'}
export type NavigationSearch = { workspace?: string; project?: string; view: AppView } & SessionNavigation

export function sessionNavigation(raw:Record<string,unknown>):SessionNavigation {
  const out:SessionNavigation={}, names=['from','to','timeZone','visitorKey','cohortId','cohortRevision','segmentId','segmentRevision','sessionInvalid'];
  const invalid=()=>({sessionInvalid:'1'} as const);
  if(raw.sessionInvalid!==undefined)return invalid();
  if(Object.keys(raw).some(key=>!['workspace','project','view',...names].includes(key)))return invalid();
  if(['from','to','timeZone'].some(key=>raw[key]!==undefined)){
    const day=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&value>='1970-01-01'&&value<='9998-12-31'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
    if(!day(raw.from)||!day(raw.to)||raw.from>raw.to||(Date.parse(raw.to)-Date.parse(raw.from))/864e5>=366||typeof raw.timeZone!=='string'||raw.timeZone.length>80||!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(raw.timeZone))return invalid();
    try{out.timeZone=new Intl.DateTimeFormat('en-US',{timeZone:raw.timeZone}).resolvedOptions().timeZone;}catch{return invalid();}
    out.from=raw.from;out.to=raw.to;
  }
  if(raw.visitorKey!==undefined){if(typeof raw.visitorKey!=='string'||raw.visitorKey.length!==64||!/^[a-f0-9]{64}$/.test(raw.visitorKey)||!out.from)return invalid();out.visitorKey=raw.visitorKey;}
  for(const kind of ['cohort','segment'] as const){const id=raw[`${kind}Id`],revision=raw[`${kind}Revision`];if(id===undefined&&revision===undefined)continue;
    if(!navigationId(id)||!['string','number'].includes(typeof revision)||! /^[1-9][0-9]{0,9}$/.test(String(revision))||Number(revision)>2147483647)return invalid();
    out[`${kind}Id`]=id.toLowerCase();out[`${kind}Revision`]=String(revision);
  }
  return out;
}

export function navigationId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

// Search values are untrusted: TanStack can parse JSON values and repeated keys.
export function parseNavigation(raw: Record<string, unknown>): NavigationSearch {
  const workspace = navigationId(raw.workspace) ? raw.workspace.toLowerCase() : undefined
  const view = typeof raw.view === 'string' && (views as readonly string[]).includes(raw.view) ? raw.view as AppView : 'project'
  return {
    ...(workspace ? { workspace } : {}),
    ...(workspace && navigationId(raw.project) ? { project: raw.project.toLowerCase() } : {}),
    view,
    ...(view==='sessions'&&workspace&&navigationId(raw.project)?sessionNavigation(raw):{}),
  }
}

export function navigationKey(search: NavigationSearch): string {
  return `${search.workspace ?? ''}:${search.project ?? ''}:${search.view}${search.view==='sessions'?':'+JSON.stringify(sessionNavigation(search)):''}`
}

export function canonicalNavigation(search: string, target: NavigationSearch): boolean {
  const params = new URLSearchParams(search)
  const entries = Object.entries(target).filter(([, value]) => value !== undefined)
  return [...params].length === entries.length && entries.every(([key, value]) => params.getAll(key).length === 1 && params.get(key) === value)
}

export function projectView(view: AppView): boolean {
  return ['project', 'destinations', 'collection', 'domains', 'reports', 'installation', 'events', 'context', 'prompts', 'ai-insights', 'explore', 'sessions', 'google', 'meta', 'meta-reports', 'keywords', 'ranks', 'audits', 'conversions'].includes(view)
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
