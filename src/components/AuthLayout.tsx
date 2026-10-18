import type { ReactNode } from 'react'
import { Brand, Icon } from './CampaignUI'

export function AuthLayout({ children }: { children: ReactNode }) {
 return <main className='auth-shell'>
  <section className='auth-story' aria-label='ten98 Discover'>
   <Brand />
   <div><span className='eyebrow'>SEO, AEO and GEO intelligence</span>
    <p className='auth-story-title'>Be seen. <br />Be found. <br /><em>Be discovered.</em></p>
    <p>From search results to AI answers.<br />Understand how your brand gets discovered.</p>
    <div className='auth-channels' aria-hidden='true'><span><Icon name='search'/>SEO</span><span><Icon name='agent'/>AEO</span><span><Icon name='globe'/>GEO</span></div>
   </div>
   <small>Built for the bigger picture.</small><div className='auth-orbit' aria-hidden='true'/>
  </section>
  <section className='auth-form' aria-label='Account access'><div className='auth-form-inner'>{children}<p className='auth-footnote'><Icon name='lock' size={13}/>Your websites. Your data. Your workspace.</p></div></section>
 </main>
}
