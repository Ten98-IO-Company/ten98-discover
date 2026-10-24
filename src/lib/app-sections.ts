import type { IconName, SettingsGroupId } from '@ten98/ui'
import type { AppView } from './navigation.ts'

// The app's information architecture: six report sections in the sidebar, each one page with a strip of sibling
// tabs, plus grouped settings. Every tab keeps its own `view` id, so existing URLs, shares and history stay valid.
export type SectionId = 'overview' | 'behaviour' | 'conversions' | 'search' | 'ai' | 'reports'
export interface SectionTab { view: AppView; label: string }
export interface AppSection { id: SectionId; label: string; icon: IconName; tabs: readonly SectionTab[]; keywords: readonly string[] }

export const appSections: readonly AppSection[] = [
  { id: 'overview', label: 'Overview', icon: 'home', tabs: [{ view: 'project', label: 'Dashboard' }, { view: 'realtime', label: 'Live' }, { view: 'explore', label: 'Explore' }, { view: 'events', label: 'Latest events' }, { view: 'performance', label: 'Page speed' }],
    keywords: ['analytics', 'traffic', 'realtime', 'compare periods', 'traffic explorer', 'recent events', 'web performance', 'core web vitals'] },
  { id: 'behaviour', label: 'Behaviour', icon: 'users', tabs: [{ view: 'sessions', label: 'Visitors' }, { view: 'journeys', label: 'Journeys' }, { view: 'visitor-retention', label: 'Returning visitors' }, { view: 'replays', label: 'Recordings' }, { view: 'heatmaps', label: 'Heatmaps' }],
    keywords: ['visitor activity', 'sessions', 'retention', 'session replay', 'paths'] },
  { id: 'conversions', label: 'Conversions', icon: 'target', tabs: [{ view: 'conversions', label: 'Goals' }, { view: 'revenue', label: 'Revenue' }, { view: 'attribution', label: 'Channels' }, { view: 'campaigns', label: 'Campaigns' }],
    keywords: ['funnels', 'attribution', 'utm campaigns', 'tracked links', 'tracking images', 'pixels'] },
  { id: 'search', label: 'Search', icon: 'search', tabs: [{ view: 'keywords', label: 'Keywords' }, { view: 'ranks', label: 'Rankings' }, { view: 'domain-seo', label: 'Domain overview' }, { view: 'audits', label: 'Site health' }, { view: 'google', label: 'Google' }],
    keywords: ['seo', 'keyword research', 'rank tracking', 'domain seo', 'backlinks', 'site audits', 'search console', 'google analytics', 'ga4', 'google reports'] },
  { id: 'ai', label: 'AI visibility', icon: 'compass', tabs: [{ view: 'prompts', label: 'Prompts' }, { view: 'ai-insights', label: 'Answers' }, { view: 'ai-search', label: 'ChatGPT' }],
    keywords: ['ai search', 'ai insights', 'saved prompts', 'answer analysis', 'chatgpt answers', 'citations', 'aeo', 'geo'] },
  { id: 'reports', label: 'Reports', icon: 'grid', tabs: [{ view: 'boards', label: 'Boards' }, { view: 'reports', label: 'Saved reports' }],
    keywords: ['boards', 'dashboards', 'share', 'templates'] },
]

// Some tabs hold a second strip of modes or tools: the Dashboard's period comparison and the campaign tools.
export const subTabs: Partial<Record<AppView, readonly SectionTab[]>> = {
  project: [{ view: 'project', label: 'Summary' }, { view: 'compare', label: 'Compare periods' }],
  campaigns: [{ view: 'campaigns', label: 'Campaign tags' }, { view: 'links', label: 'Tracked links' }, { view: 'pixels', label: 'Tracking images' }],
}
const tabOf: Partial<Record<AppView, AppView>> = Object.fromEntries(Object.entries(subTabs).flatMap(([tab, entries]) => entries!.map(entry => [entry.view, tab])))

export interface SettingsEntry { view: AppView; label: string; group: SettingsGroupId; keywords?: readonly string[] }
// The library's Account, Workspace and Project labels stay; only the operator group is renamed, as in Campaign.
export const settingsGroupLabels: Partial<Record<SettingsGroupId, string>> = { operator: 'Advanced' }
export const settingsEntries: readonly SettingsEntry[] = [
  { view: 'installation', label: 'Tracking code', group: 'project', keywords: ['install tracker', 'tracking snippet'] }, { view: 'domains', label: 'Domains', group: 'project' },
  { view: 'collection', label: 'Privacy', group: 'project', keywords: ['collection and privacy', 'consent'] }, { view: 'destinations', label: 'Forwarding', group: 'project', keywords: ['destinations'] },
  { view: 'context', label: 'Brand and competitors', group: 'project', keywords: ['project context', 'business brief'] },
  { view: 'team', label: 'Members', group: 'workspace', keywords: ['team', 'invite'] }, { view: 'keys', label: 'API keys', group: 'workspace', keywords: ['ten98 api access', 'mcp'] },
  { view: 'providers', label: 'Connections', group: 'workspace', keywords: ['ai and search providers', 'integrations', 'dataforseo', 'openrouter'] }, { view: 'retention', label: 'Data retention', group: 'workspace' },
  { view: 'workspace', label: 'New workspace', group: 'workspace' },
  { view: 'preferences', label: 'Profile', group: 'account' }, { view: 'security', label: 'Security', group: 'account' },
  { view: 'identity', label: 'Sign-in methods', group: 'account', keywords: ['identity sign-in', 'sso'] },
  { view: 'identity-providers', label: 'Sign-in', group: 'operator', keywords: ['identity providers', 'oidc', 'single sign-on'] }, { view: 'google-app', label: 'Google app', group: 'operator' }, { view: 'diagnostics', label: 'Diagnostics', group: 'operator', keywords: ['worker check', 'background worker'] },
]
export const projectSettingsViews: readonly AppView[] = settingsEntries.filter(entry => entry.group === 'project').map(entry => entry.view)

// Views reached from elsewhere: project creation from the project switcher, public shares by their link.
export const standaloneViews: readonly AppView[] = ['new-project', 'tracked-share']

export function sectionOf(view: AppView): { section: AppSection; tab: AppView; subTabs?: readonly SectionTab[] } | undefined {
  const tab = tabOf[view] ?? view
  const section = appSections.find(item => item.tabs.some(entry => entry.view === tab))
  return section && { section, tab, subTabs: subTabs[tab] }
}

export function settingsEntry(view: AppView): SettingsEntry | undefined {
  return settingsEntries.find(entry => entry.view === view)
}
