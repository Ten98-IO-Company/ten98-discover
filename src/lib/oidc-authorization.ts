// Identity-provider authorization redirects, checked where the server builds them and again before the browser navigates.
// Plain http is accepted for loopback only, for local integration tests; the server decides which endpoints are usable.
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Canonical href of an http(s) URL without credentials or a fragment; null otherwise. */
export function navigableHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHosts.has(url.hostname))) return null;
  // An empty fragment leaves url.hash empty, so look for the separator itself.
  if (url.username || url.password || url.href.includes('#')) return null;
  return url.href;
}

/** As navigableHttpUrl, and only on the configured provider's authorization endpoint origin. */
export function authorizationRedirect(raw: unknown, expectedOrigin: unknown): string | null {
  const href = navigableHttpUrl(raw);
  if (href === null || typeof expectedOrigin !== 'string' || new URL(href).origin !== expectedOrigin) return null;
  return href;
}
