import type { ComponentProps } from 'react'
import { AuthLayout as SharedAuthLayout, AuthStory } from '@ten98/ui'
import { Brand } from './CampaignUI'

type AuthLayoutProps = Pick<ComponentProps<typeof SharedAuthLayout>, 'children' | 'title' | 'description' | 'footer'>

/** Discover's side panel for every shared authentication flow. */
export const authStory = <AuthStory label='ten98 Discover' eyebrow='SEO, AEO and GEO' title='Website analytics and search' emphasis='research.'
  lead='Track visits, research keywords and review AI answers.' footnote='Workspace access required.'
  channels={[{ icon: 'search', label: 'SEO' }, { icon: 'agent', label: 'AEO' }, { icon: 'globe', label: 'GEO' }]} />

/** Screens not yet on a shared flow; the shared layout supplies the single main landmark. */
export function AuthLayout({ children, ...props }: AuthLayoutProps) {
  return <SharedAuthLayout {...props} label='Account access' brand={<Brand />} aside={authStory}>{children}</SharedAuthLayout>
}
