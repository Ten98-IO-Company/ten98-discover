import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { getConfig } from '../server/config.ts';
import stylesheet from '../styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'ten98 Discover' }],
    links: [{ rel: 'stylesheet', href: stylesheet }, { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
  }),
  // Server-rendered documents only: the nonce exists in production SSR (src/router.tsx), server routes answer with
  // their own Response, and the client build deletes this option together with the getConfig import.
  headers: ({ ssr }) => ssr?.nonce ? {
    'content-security-policy': `default-src 'none'; script-src 'self' 'nonce-${ssr.nonce}'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' data: about:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cache-control': 'no-store',
    // ponytail: no includeSubDomains/preload because setup admits apex APP_URLs that may own plain-HTTP subdomains; adding them is an owner decision.
    ...(getConfig().appUrl.startsWith('https:') ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  } : {},
  component: () => <html lang="en"><head><HeadContent /></head><body><Outlet /><Scripts /></body></html>,
});
