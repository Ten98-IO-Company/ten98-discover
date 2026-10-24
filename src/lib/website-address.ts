// Turns what people type for "your website" into the origin a project stores. A bare domain gets https://, and a
// pasted page link keeps only its origin; credentials and non-web schemes are refused. www. is kept, because the
// tracker matches the exact host the site serves.
export function parseWebsiteAddress(raw: string): { origin?: string; error?: string } {
  const input = raw.trim()
  if (input === '') return { error: 'Enter your website address, for example example.com.' }
  let u: URL
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`) } catch { return { error: 'Enter a valid website address, for example example.com.' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'The website address must start with http:// or https://.' }
  if (u.username !== '' || u.password !== '') return { error: 'The website address must not include a username or password.' }
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') return { error: 'Enter the full website address, for example example.com.' }
  return { origin: u.origin }
}

