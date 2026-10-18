import type { ReactNode } from 'react'

export function AuthLayout({ children }: { children: ReactNode }) {
  return <main className='auth-shell'>
    <section className='auth-story' aria-label='ten98 Discover'>
      <p className='brand'><span className='brand-mark' aria-hidden='true'>98</span><span>ten98<span className='brand-product'>Discover</span></span></p>
      <div>
        <span className='eyebrow'>SEO, AEO and GEO intelligence</span>
        <p className='auth-story-title'>Understand how<br />you get <em>discovered.</em></p>
        <p className='auth-story-copy'>Bring your website analytics, search research and AI visibility into one workspace.</p>
        <div className='auth-channels' aria-hidden='true'><span>SEO</span><span>AEO</span><span>GEO</span></div>
      </div>
      <p className='hint auth-story-foot'>Your websites. Your data. Your workspace.</p>
    </section>
    <section className='auth-form' aria-label='Account access'>{children}</section>
  </main>
}
