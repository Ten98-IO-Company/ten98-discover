import type { ReactNode } from 'react'
import { Brand, Icon } from './CampaignUI'

export function AuthLayout({ children }: { children: ReactNode }) {
 return <main className='auth-shell'>
  <section className='auth-story' aria-label='ten98 Discover'>
   <Brand />
   <div><span className='eyebrow'>SEO, AEO and GEO</span>
    <p className='auth-story-title'>Website analytics<br /> and search<br /> <em>research.</em></p>
    <p>Track visits, research keywords and review AI answers.</p>
    <div className='auth-channels' aria-hidden='true'><span><Icon name='search'/>SEO</span><span><Icon name='agent'/>AEO</span><span><Icon name='globe'/>GEO</span></div>
   </div>
   <small>Workspace access required.</small><div className='auth-orbit' aria-hidden='true'/>
  </section>
  <section className='auth-form' aria-label='Account access'><div className='auth-form-inner'>{children}</div></section>
 </main>
}
