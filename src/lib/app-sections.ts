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
    keywords: ['seo', 'keyword research', 'rank tracking', 'domain seo', 'backlinks', 'site audits', 'search console', 'google analytics', 'google reports'] },
  { id: 'ai', label: 'AI visibility', icon: 'compass', tabs: [{ view: 'prompts', label: 'Prompts' }, { view: 'ai-insights', label: 'Answers' }, { view: 'ai-search', label: 'ChatGPT' }],
    keywords: ['ai search', 'saved prompts', 'answer analysis', 'chatgpt answers', 'citations', 'aeo', 'geo'] },
  { id: 'reports', label: 'Reports', icon: 'grid', tabs: [{ view: 'boards', label: 'Boards' }, { view: 'reports', label: 'Saved reports' }],
    keywords: ['boards', 'dashboards', 'share', 'templates'] },
]

// Campaign tools share the Campaigns tab: a second strip under it switches between them.
export const campaignTools: readonly SectionTab[] = [{ view: 'campaigns', label: 'Campaign tags' }, { view: 'links', label: 'Tracked links' }, { view: 'pixels', label: 'Tracking images' }]

// Views that are a mode of another tab rather than a tab of their own.
const tabOf: Partial<Record<AppView, AppView>> = { compare: 'project', links: 'campaigns', pixels: 'campaigns' }

export interface SettingsEntry { view: AppView; label: string; group: SettingsGroupId }
export const settingsGroupLabels: Record<SettingsGroupId, string> = { project: 'Project', workspace: 'Workspace', account: 'Account', operator: 'Advanced' }
export const settingsEntries: readonly SettingsEntry[] = [
  { view: 'installation', label: 'Tracking code', group: 'project' }, { view: 'domains', label: 'Domains', group: 'project' },
  { view: 'collection', label: 'Privacy', group: 'project' }, { view: 'destinations', label: 'Forwarding', group: 'project' },
  { view: 'context', label: 'Brand and competitors', group: 'project' },
  { view: 'team', label: 'Members', group: 'workspace' }, { view: 'keys', label: 'API keys', group: 'workspace' },
  { view: 'providers', label: 'Connections', group: 'workspace' }, { view: 'retention', label: 'Data retention', group: 'workspace' },
  { view: 'workspace', label: 'New workspace', group: 'workspace' },
  { view: 'preferences', label: 'Profile', group: 'account' }, { view: 'security', label: 'Security', group: 'account' },
  { view: 'identity', label: 'Sign-in methods', group: 'account' },
  { view: 'google-app', label: 'Google app', group: 'operator' },
]
export const projectSettingsViews: readonly AppView[] = settingsEntries.filter(entry => entry.group === 'project').map(entry => entry.view)

// Views reached from elsewhere: project creation from the project switcher, public shares by their link.
export const standaloneViews: readonly AppView[] = ['new-project', 'tracked-share']

export function sectionOf(view: AppView): { section: AppSection; tab: AppView } | undefined {
  const tab = tabOf[view] ?? view
  const section = appSections.find(item => item.tabs.some(entry => entry.view === tab))
  return section && { section, tab }
}

export function settingsEntry(view: AppView): SettingsEntry | undefined {
  return settingsEntries.find(entry => entry.view === view)
}
