import type { IconName, SettingsGroupId } from '@ten98/ui'
import type { AppView } from './navigation.ts'

// The app's information architecture: six report sections in the sidebar, each one page with a strip of sibling
// tabs, plus grouped settings. Every tab keeps its own `view` id, so existing URLs, shares and history stay valid.
export type SectionId = 'overview' | 'behaviour' | 'conversions' | 'search' | 'ai' | 'reports'
export interface SectionTab { view: AppView; label: string; keywords?: readonly string[] }
export interface AppSection { id: SectionId; label: string; icon: IconName; tabs: readonly SectionTab[] }

export const appSections: readonly AppSection[] = [
  { id: 'overview', label: 'Overview', icon: 'home', tabs: [
    { view: 'project', label: 'Dashboard', keywords: ['analytics', 'traffic'] }, { view: 'realtime', label: 'Live', keywords: ['realtime'] },
    { view: 'explore', label: 'Explore', keywords: ['traffic explorer'] }, { view: 'events', label: 'Latest events', keywords: ['recent events'] },
    { view: 'performance', label: 'Page speed', keywords: ['web performance', 'core web vitals'] }] },
  { id: 'behaviour', label: 'Behaviour', icon: 'users', tabs: [
    { view: 'sessions', label: 'Visitors', keywords: ['visitor activity', 'sessions'] }, { view: 'journeys', label: 'Journeys', keywords: ['paths'] },
    { view: 'visitor-retention', label: 'Returning visitors', keywords: ['retention'] }, { view: 'replays', label: 'Recordings', keywords: ['session replay'] }, { view: 'heatmaps', label: 'Heatmaps' }] },
  { id: 'conversions', label: 'Conversions', icon: 'target', tabs: [
    { view: 'conversions', label: 'Goals', keywords: ['funnels'] }, { view: 'revenue', label: 'Revenue' },
    { view: 'attribution', label: 'Channels', keywords: ['attribution'] }, { view: 'campaigns', label: 'Campaigns', keywords: ['utm campaigns'] }] },
  { id: 'search', label: 'Search', icon: 'search', tabs: [
    { view: 'keywords', label: 'Keywords', keywords: ['seo', 'keyword research'] }, { view: 'ranks', label: 'Rankings', keywords: ['seo', 'rank tracking'] },
    { view: 'domain-seo', label: 'Domain overview', keywords: ['seo', 'domain seo', 'backlinks'] }, { view: 'audits', label: 'Site health', keywords: ['seo', 'site audits'] },
    { view: 'google', label: 'Google', keywords: ['seo', 'search console', 'google analytics', 'ga4', 'google reports'] }] },
  { id: 'ai', label: 'AI visibility', icon: 'compass', tabs: [
    { view: 'prompts', label: 'Prompts', keywords: ['saved prompts'] },
    { view: 'ai-insights', label: 'Answers', keywords: ['ai insights', 'answer analysis', 'citations', 'aeo', 'geo'] }] },
  { id: 'reports', label: 'Reports', icon: 'grid', tabs: [
    { view: 'boards', label: 'Boards', keywords: ['dashboards', 'share'] }, { view: 'reports', label: 'Saved reports', keywords: ['share', 'templates'] }] },
]

// Some tabs hold a second strip of modes or tools: the Dashboard's period comparison and the campaign tools.
export const subTabs: Partial<Record<AppView, readonly SectionTab[]>> = {
  project: [{ view: 'project', label: 'Summary' }, { view: 'compare', label: 'Compare periods' }],
  // Answers from API models and from the ChatGPT app are measured separately and never pooled.
  'ai-insights': [{ view: 'ai-insights', label: 'API models' }, { view: 'ai-search', label: 'ChatGPT app', keywords: ['ai search', 'chatgpt answers'] }],
  campaigns: [{ view: 'campaigns', label: 'Campaign tags' }, { view: 'links', label: 'Tracked links' }, { view: 'pixels', label: 'Tracking images', keywords: ['pixels'] }],
}
const tabOf: Partial<Record<AppView, AppView>> = Object.fromEntries(Object.entries(subTabs).flatMap(([tab, entries]) => entries!.map(entry => [entry.view, tab])))

export interface SettingsEntry { view: AppView; label: string; group: SettingsGroupId; keywords?: readonly string[] }
// The library's Account, Workspace and Project labels stay; only the operator group is renamed, as in Campaign.
export const settingsGroupLabels: Partial<Record<SettingsGroupId, string>> = { operator: 'Advanced' }
export const settingsEntries: readonly SettingsEntry[] = [
  { view: 'installation', label: 'Tracking code', group: 'project', keywords: ['install tracker', 'tracking snippet'] }, { view: 'domains', label: 'Domains', group: 'project' },
  { view: 'collection', label: 'Privacy', group: 'project', keywords: ['collection and privacy', 'consent'] }, { view: 'destinations', label: 'Forwarding', group: 'project', keywords: ['destinations'] },
  { view: 'context', label: 'Brand and competitors', group: 'project', keywords: ['project context', 'business brief'] }, { view: 'imports', label: 'Imports', group: 'project', keywords: ['google search console', 'ga4 import'] },
  { view: 'cloudflare', label: 'Cloudflare', group: 'project', keywords: ['web analytics', 'account connection'] },
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
