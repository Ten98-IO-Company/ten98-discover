import { environmentFields, isEnvironmentFilter } from './analytics-environment.ts';
import {aiQueryFilters,type AiQueryFilters} from './ai-search-analysis.ts';
import {normalizeAuditPageFields,type AuditPageFields} from './site-audit-pages.ts'
import type {AnalyticsComparisonMode} from './analytics-comparison.ts'
import {geographyFields,geographyFiltersValid,parseGeographyKey,serializeGeographyKey,type GeoField,type GeographyKey} from './analytics-geography.ts'
import {journeysLimits} from './journeys.ts'
import {attributionLimits} from './attribution.ts'
import {analyticsDimensions,type AnalyticsDimension} from './analytics-dimensions.ts'

export const views = ['project', 'realtime', 'compare', 'new-project', 'team', 'workspace', 'security', 'preferences', 'providers', 'keys', 'destinations', 'identity', 'collection', 'domains', 'reports', 'installation', 'events', 'retention', 'visitor-retention', 'context', 'prompts', 'ai-search', 'ai-insights', 'explore', 'sessions', 'journeys', 'revenue', 'attribution', 'google', 'google-app', 'meta', 'meta-app', 'meta-reports', 'keywords', 'domain-seo', 'ranks', 'audits', 'conversions'] as const
export type AppView = typeof views[number]
export type SessionNavigation = {from?:string;to?:string;timeZone?:string;visitorKey?:string;activity?:'identified';cohortId?:string;cohortRevision?:string;segmentId?:string;segmentRevision?:string;sessionInvalid?:'1'}
export type RevenueNavigation={revenueQuery?:string;revenueKey?:string;revenueCalendar?:'months';revenueInvalid?:'1'};
export type AISearchNavigation={aiSearchQuery?:string;aiSearchInvalid?:'1'};
export type AISearchIntent={section:'analysis'|'captures';tab:'prompts'|'top'|'words';filters:AiQueryFilters;captureId:string|null;create:boolean};
export function readAISearchIntent(query?:string):AISearchIntent|null{
 try{
  if(query!==undefined&&(typeof query!=='string'||!query.length||query.length>6144||query.includes('\0')||new TextDecoder().decode(new TextEncoder().encode(query))!==query))return null;
  const p=new URLSearchParams(query),section=p.get('section')??'analysis',tab=p.get('tab')??'prompts',captureId=p.get('captureId'),create=p.get('create');
  if([...p.keys()].some(k=>p.getAll(k).length!==1)||!['analysis','captures'].includes(section)||!['prompts','top','words'].includes(tab)||captureId!==null&&!navigationId(captureId)||create!==null&&create!=='1'||section==='analysis'&&(captureId!==null||create!==null)||captureId!==null&&create!==null)return null;
  for(const k of ['section','tab','captureId','create'])p.delete(k);const filters=aiQueryFilters(p);
  if(filters.promptId&&tab==='top')return null;
  return{section:section as AISearchIntent['section'],tab:tab as AISearchIntent['tab'],filters,captureId:captureId?.toLowerCase()??null,create:create==='1'};
 }catch{return null;}
}
export function aiSearchIntentQuery(intent:AISearchIntent):string{
 const p=new URLSearchParams({section:intent.section,tab:intent.tab,lookback:intent.filters.lookback,timeZone:intent.filters.timeZone,matcher:intent.filters.matcher});
 for(const k of ['promptId','versionId','tag'] as const)if(intent.filters[k]!==null)p.set(k,intent.filters[k]);
 if(intent.filters.reportedModel)p.set('reportedModel',JSON.stringify(intent.filters.reportedModel));if(intent.captureId)p.set('captureId',intent.captureId);if(intent.create)p.set('create','1');return p.toString();
}
export function aiSearchNavigation(raw:Record<string,unknown>):AISearchNavigation{
 if(!navigationId(raw.workspace)||!navigationId(raw.project)||raw.aiSearchInvalid!==undefined||Object.keys(raw).some(key=>!['workspace','project','view','aiSearchQuery','aiSearchInvalid'].includes(key))||raw.aiSearchQuery!==undefined&&typeof raw.aiSearchQuery!=='string'||!readAISearchIntent(raw.aiSearchQuery as string|undefined))return{aiSearchInvalid:'1'};
 return raw.aiSearchQuery===undefined?{}:{aiSearchQuery:raw.aiSearchQuery as string};
}
export function revenueNavigation(raw:Record<string,unknown>):RevenueNavigation{
 if(!navigationId(raw.workspace)||!navigationId(raw.project)||raw.revenueInvalid!==undefined||Object.keys(raw).some(key=>!['workspace','project','view','revenueQuery','revenueKey','revenueCalendar','revenueInvalid'].includes(key))||raw.revenueCalendar!==undefined&&raw.revenueCalendar!=='months')return{revenueInvalid:'1'};
 const query=raw.revenueQuery,key=raw.revenueKey;if(query===undefined)return key===undefined&&raw.revenueCalendar===undefined?{}:{revenueInvalid:'1'};
 if(typeof query!=='string'||!query.length||query.length>65536||/[\u0000\ud800-\udfff]/u.test(query)||key!==undefined&&(typeof key!=='string'||key.length!==64||!/^[a-f0-9]{64}$/.test(key)))return{revenueInvalid:'1'};
 return{revenueQuery:query,...key!==undefined?{revenueKey:key as string}:{},...raw.revenueCalendar==='months'?{revenueCalendar:'months' as const}:{}};
}
export type AttributionNavigation={attributionQuery?:string;attributionInvalid?:'1'};
export type JourneysNavigation={journeyQuery?:string;journeyInvalid?:'1'};
export const auditIssueCodes = 'blocked-page,rate-limited-page,server-error,broken-page,slow-response,noindex-page,canonical-conflict,canonicalized-page,deep-page,javascript-rendering-suspected,missing-title,title-too-long,title-too-short,missing-meta-description,meta-description-too-long,meta-description-too-short,missing-h1,multiple-h1,heading-order-skip,thin-content,images-missing-alt,no-outgoing-links,duplicate-title,duplicate-meta-description,duplicate-content,redirect-chain,redirect-loop,broken-internal-link,orphan-page'.split(',')
export const auditCoverages = ['analyzed','partial','shell','redirect','non_html','http_error','blocked','rate_limited','robots_disallowed','not_fetched','unavailable'] as const
export type AuditNavigation = {auditRun?:string;auditPage?:string;auditTab?:'pages';auditSeverity?:'critical'|'warning'|'info';auditCode?:string;auditAffectedPage?:string;auditCoverage?:typeof auditCoverages[number];auditResource?:'robots'|'sitemap';auditSearch?:string;auditSearchIn?:'url';auditSort?:Exclude<AuditPageFields['sort'],'url'>;auditOrder?:'desc';auditDirection?:'in';auditInvalid?:'1'}
export type AnalyticsNavigation = { analyticsFrom?: string; analyticsTo?: string; analyticsBrowser?: string; analyticsOs?: string; analyticsDevice?: string; analyticsCountry?:string;analyticsRegion?:string;analyticsCity?:string;analyticsCompare?: AnalyticsComparisonMode;analyticsDimension?:AnalyticsDimension;analyticsSelection?:string; analyticsInvalid?: '1' }
export const analyticsNavigationNames = { browser: 'analyticsBrowser', os: 'analyticsOs', device: 'analyticsDevice' } as const;
export const geographyNavigationNames={country:'analyticsCountry',region:'analyticsRegion',city:'analyticsCity'} as const;

// A known child supplies its ancestors atomically; sentinel children supply no facts.
export function applyGeographyFilter(intent:AnalyticsNavigation,field:GeoField,key:GeographyKey):AnalyticsNavigation{
  const value=serializeGeographyKey(field,key);if(value===null)return intent;
  const next={...intent,[geographyNavigationNames[field]]:value};
  if(key.state==='known'){
    next.analyticsCountry=serializeGeographyKey('country',{state:'known',country:key.country})!;
    if(field==='city'&&'region'in key)next.analyticsRegion=serializeGeographyKey('region',key.region===null?{state:'unknown'}:{state:'known',country:key.country,region:key.region})!;
  }
  const filters=()=>Object.fromEntries(geographyFields.filter(name=>next[geographyNavigationNames[name]]!==undefined).map(name=>[name,next[geographyNavigationNames[name]]!]));
  if(field==='country')for(const child of ['region','city'] as const){const name=geographyNavigationNames[child];if(next[name]!==undefined&&!geographyFiltersValid({country:value,[child]:next[name]}))delete next[name];}
  if(field==='region'&&!geographyFiltersValid(filters()))delete next.analyticsCity;
  return next;
}
export type RetentionNavigation={retentionMonth?:string;retentionTimeZone?:string;retentionEntry?:string;retentionInvalid?:'1'}
export function retentionNavigation(raw:Record<string,unknown>):RetentionNavigation{
  const names=['retentionMonth','retentionTimeZone','retentionEntry','retentionInvalid'],invalid=()=>({retentionInvalid:'1'} as const);
  if(raw.retentionInvalid!==undefined||!navigationId(raw.workspace)||!navigationId(raw.project)||Object.keys(raw).some(key=>!['workspace','project','view',...names].includes(key)))return invalid();
  if(!names.some(key=>raw[key]!==undefined))return {};
  const month=raw.retentionMonth,zone=raw.retentionTimeZone,entry=raw.retentionEntry;
  if(typeof month!=='string'||!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)||month<'1970-01'||month>'9998-12'||typeof zone!=='string'||zone.length>80||!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(zone)||entry!==undefined&&(typeof entry!=='string'||entry.length>20000||entry.includes('\0')||new TextDecoder().decode(new TextEncoder().encode(entry))!==entry))return invalid();
  try{const format=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit'}),parts=format.formatToParts(new Date()),current=['year','month'].map(key=>parts.find(part=>part.type===key)!.value).join('-');if(month>current)return invalid();return {retentionMonth:month,retentionTimeZone:format.resolvedOptions().timeZone,...entry!==undefined?{retentionEntry:entry as string}:{}};}catch{return invalid();}
}
export type NavigationSearch = { workspace?: string; project?: string; view: AppView } & SessionNavigation & AuditNavigation & AnalyticsNavigation & JourneysNavigation & RetentionNavigation & AttributionNavigation & RevenueNavigation & AISearchNavigation

// The panel verifies the closed nested scope with the existing Explorer controls
// before fetching; this boundary keeps its URL value scalar and project-scoped.
export function journeysNavigation(raw:Record<string,unknown>):JourneysNavigation{
 if(!navigationId(raw.workspace)||!navigationId(raw.project)||raw.journeyInvalid!==undefined||Object.keys(raw).some(key=>!['workspace','project','view','journeyQuery','journeyInvalid'].includes(key)))return{journeyInvalid:'1'};
 if(raw.journeyQuery===undefined)return{};
 return typeof raw.journeyQuery==='string'&&raw.journeyQuery.length>0&&raw.journeyQuery.length<=journeysLimits.queryCharacters&&!/[\u0000\ud800-\udfff]/u.test(raw.journeyQuery)?{journeyQuery:raw.journeyQuery}:{journeyInvalid:'1'};
}

export function attributionNavigation(raw:Record<string,unknown>):AttributionNavigation{
 if(!navigationId(raw.workspace)||!navigationId(raw.project)||raw.attributionInvalid!==undefined||Object.keys(raw).some(key=>!['workspace','project','view','attributionQuery','attributionInvalid'].includes(key)))return{attributionInvalid:'1'};
 if(raw.attributionQuery===undefined)return{};
 return typeof raw.attributionQuery==='string'&&raw.attributionQuery.length>0&&raw.attributionQuery.length<=attributionLimits.queryCharacters&&!/[\u0000\ud800-\udfff]/u.test(raw.attributionQuery)?{attributionQuery:raw.attributionQuery}:{attributionInvalid:'1'};
}

export function analyticsDay(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01' || value > '9998-12-31') return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

export function analyticsNavigation(raw: Record<string, unknown>): AnalyticsNavigation {
  const names = [...Object.values(analyticsNavigationNames),...Object.values(geographyNavigationNames), 'analyticsFrom', 'analyticsTo', 'analyticsCompare', 'analyticsDimension','analyticsSelection','analyticsInvalid'];
  if (!Object.keys(raw).some(key => key.startsWith('analytics'))) return {};
  const invalid = () => ({ analyticsInvalid: '1' } as const);
  if (raw.analyticsInvalid !== undefined || !navigationId(raw.workspace) || !navigationId(raw.project) || Object.keys(raw).some(key => !['workspace', 'project', 'view', ...names].includes(key))) return invalid();
  const out: AnalyticsNavigation = {};
  if(raw.analyticsDimension!==undefined){if(raw.view!=='compare'||!analyticsDimensions.includes(raw.analyticsDimension as AnalyticsDimension))return invalid();out.analyticsDimension=raw.analyticsDimension as AnalyticsDimension;}
  // The panel verifies the closed nested predicates before any analytics read.
  if(raw.analyticsSelection!==undefined){if(typeof raw.analyticsSelection!=='string'||!raw.analyticsSelection.length||raw.analyticsSelection.length>20000||raw.analyticsSelection.includes('\0')||new TextDecoder().decode(new TextEncoder().encode(raw.analyticsSelection))!==raw.analyticsSelection)return invalid();out.analyticsSelection=raw.analyticsSelection;}
  if (raw.analyticsCompare !== undefined) {
    if (raw.view !== 'compare' || typeof raw.analyticsCompare !== 'string' || !['prev','yoy'].includes(raw.analyticsCompare)) return invalid();
    out.analyticsCompare = raw.analyticsCompare as AnalyticsComparisonMode;
  }
  if (raw.analyticsFrom !== undefined || raw.analyticsTo !== undefined) {
    const from = analyticsDay(raw.analyticsFrom), to = analyticsDay(raw.analyticsTo);
    if (from === null || to === null || from > to || to > analyticsDay(new Date().toISOString().slice(0, 10))! || (to - from) / 864e5 >= 366) return invalid();
    out.analyticsFrom = raw.analyticsFrom as string; out.analyticsTo = raw.analyticsTo as string;
  }
  for (const field of environmentFields) {
    const name = analyticsNavigationNames[field], value = raw[name];
    if (value !== undefined) {
      if (!isEnvironmentFilter(field, value)) return invalid();
      out[name] = value;
    }
  }
  for(const field of geographyFields){const name=geographyNavigationNames[field],value=raw[name];if(value!==undefined){if(!parseGeographyKey(field,value))return invalid();out[name]=value as string;}}
  if(!geographyFiltersValid(Object.fromEntries(geographyFields.filter(field=>out[geographyNavigationNames[field]]!==undefined).map(field=>[field,out[geographyNavigationNames[field]]!]))))return invalid();
  return out;
}

export function auditNavigation(raw:Record<string,unknown>):AuditNavigation {
  const out:AuditNavigation={},names=['auditRun','auditPage','auditTab','auditSeverity','auditCode','auditAffectedPage','auditCoverage','auditResource','auditSearch','auditSearchIn','auditSort','auditOrder','auditDirection','auditInvalid'];
  const invalid=()=>({auditInvalid:'1'} as const);
  if(raw.auditInvalid!==undefined||Object.keys(raw).some(key=>!['workspace','project','view',...names].includes(key)))return invalid();
  for(const key of ['auditRun','auditPage','auditAffectedPage'] as const){if(raw[key]===undefined)continue;if(!navigationId(raw[key]))return invalid();out[key]=raw[key].toLowerCase();}
  for(const [key,values,fallback] of [['auditTab',['issues','pages'],'issues'],['auditSeverity',['critical','warning','info'],null],['auditCode',auditIssueCodes,null],['auditCoverage',auditCoverages,null],['auditResource',['html','robots','sitemap'],'html'],['auditDirection',['out','in'],'out']] as const){
    const value=raw[key];if(value===undefined)continue;if(typeof value!=='string'||!(values as readonly string[]).includes(value))return invalid();if(value!==fallback)Object.assign(out,{[key]:value});
  }
  const pages=normalizeAuditPageFields({search:raw.auditSearch,searchIn:raw.auditSearchIn,sort:raw.auditSort,order:raw.auditOrder});if(!pages)return invalid();
  if(pages.search)out.auditSearch=pages.search;
  if(pages.searchIn!=='url_title_meta')out.auditSearchIn=pages.searchIn;
  if(pages.sort!=='url')out.auditSort=pages.sort;
  if(pages.order!=='asc')out.auditOrder=pages.order;
  if(names.some(key=>raw[key]!==undefined)&&(!out.auditRun||!navigationId(raw.workspace)||!navigationId(raw.project))||raw.auditDirection!==undefined&&!out.auditPage)return invalid();
  return out;
}

export function sessionNavigation(raw:Record<string,unknown>):SessionNavigation {
  const out:SessionNavigation={}, names=['from','to','timeZone','visitorKey','activity','cohortId','cohortRevision','segmentId','segmentRevision','sessionInvalid'];
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
  if(raw.activity!==undefined){if(raw.activity!=='identified'||!out.visitorKey)return invalid();out.activity='identified';}
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
    ...(view==='journeys'?journeysNavigation(raw):{}),
    ...(view==='revenue'?revenueNavigation(raw):{}),
    ...(view==='ai-search'?aiSearchNavigation(raw):{}),
    ...(view==='attribution'?attributionNavigation(raw):{}),
    ...(view==='audits'?auditNavigation(raw):{}),
    ...(['project','compare'].includes(view)?analyticsNavigation(raw):{}),
    ...(view==='visitor-retention'?retentionNavigation(raw):{}),
  }
}

export function navigationKey(search: NavigationSearch): string {
  return `${search.workspace ?? ''}:${search.project ?? ''}:${search.view}${search.view==='sessions'?':'+JSON.stringify(sessionNavigation(search)):search.view==='ai-search'?':'+JSON.stringify(aiSearchNavigation(search)):search.view==='revenue'?':'+JSON.stringify(revenueNavigation(search)):search.view==='journeys'?':'+JSON.stringify(journeysNavigation(search)):search.view==='attribution'?':'+JSON.stringify(attributionNavigation(search)):search.view==='visitor-retention'?':'+JSON.stringify(retentionNavigation(search)):search.view==='audits'?':'+JSON.stringify(auditNavigation(search)):['project','compare'].includes(search.view)?':'+JSON.stringify(analyticsNavigation(search)):''}`
}

export function canonicalNavigation(search: string, target: NavigationSearch): boolean {
  const params = new URLSearchParams(search)
  const entries = Object.entries(target).filter(([, value]) => value !== undefined)
  // TanStack quotes JSON-looking strings so its parser preserves the string type.
  return [...params].length === entries.length && entries.every(([key, value]) => {
    let wire=value
    try { JSON.parse(value); wire=JSON.stringify(value) } catch {}
    return params.getAll(key).length===1 && params.get(key)===wire
  })
}

export function projectView(view: AppView): boolean {
  return ['project', 'realtime', 'compare', 'visitor-retention', 'destinations', 'collection', 'domains', 'reports', 'installation', 'events', 'context', 'prompts', 'ai-search', 'ai-insights', 'explore', 'sessions', 'journeys', 'revenue', 'attribution', 'google', 'meta', 'meta-reports', 'keywords', 'domain-seo', 'ranks', 'audits', 'conversions'].includes(view)
}

export function allowedView(view: AppView, role: string | undefined, operator: boolean): boolean {
  if (view === 'google-app' || view === 'meta-app') return operator
  if (['preferences', 'security', 'identity', 'workspace', 'project'].includes(view)) return true
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

// Recovery capabilities are consumed before the ordinary OAuth/invitation callbacks.
// Accept only the exact fragment emitted by the server; never reinterpret query values.
export function parsePasswordResetFragment(hash: string): { token: string | null } | null {
  if (!hash || hash.length > 4096) return hash.includes('password-reset') ? { token: null } : null
  if (!new URLSearchParams(hash.replace(/^#/, '')).has('password-reset')) return null
  const match = /^#password-reset=([A-Za-z0-9]{24})$/.exec(hash)
  return { token: match?.[0] === hash ? match[1] : null }
}

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
