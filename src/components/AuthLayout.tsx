import { AuthStory } from '@ten98/ui'

/** Discover's side panel, supplied once to every authentication screen through the root AuthFrameProvider. */
export const authStory = <AuthStory label='ten98 Discover' eyebrow='SEO, AEO and GEO' title='Website analytics and search' emphasis='research.'
  lead='Track visits, research keywords and review AI answers.' footnote='Workspace access required.'
  channels={[{ icon: 'search', label: 'SEO' }, { icon: 'agent', label: 'AEO' }, { icon: 'globe', label: 'GEO' }]} />
