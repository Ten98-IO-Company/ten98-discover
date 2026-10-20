import type { ReactNode } from 'react'
import { AuthLayout as SharedAuthLayout } from '@ten98/ui'
import { Brand, Icon } from './CampaignUI'

export function AuthLayout({ children }: { children: ReactNode }) {
 return <main aria-label='Account access'><SharedAuthLayout brand={<Brand />} aside={<>
   <div aria-label='ten98 Discover'><span className='eyebrow'>SEO, AEO and GEO</span>
    <p className='auth-story-title'>Website analytics<br /> and search<br /> <em>research.</em></p>
    <p>Track visits, research keywords and review AI answers.</p>
    <div className='auth-channels' aria-hidden='true'><span><Icon name='search'/>SEO</span><span><Icon name='agent'/>AEO</span><span><Icon name='globe'/>GEO</span></div>
   </div>
   <small>Workspace access required.</small>
  </>}>{children}</SharedAuthLayout></main>
}
