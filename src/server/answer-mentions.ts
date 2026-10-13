import { toUSVString } from 'node:util';

export type MentionSubject = {
  id: string; name: string; aliases: string[]; domains: string[];
};
export type MentionMethod = 'elmo-substring-v1' | 'unicode-boundary-v1';
export type AnswerMention = {
  id: string; mentioned: boolean; matchedTerm: string | null;
  cited: boolean; citationIndexes: number[];
};
export class AnswerMentionError extends Error {}

const MSG = 'The answer matching input is invalid or exceeds its limit.';
const ASCII_CONTROL = /[\x00-\x1f\x7f]/;
const DOMAIN_FORBIDDEN = /[:@\/\\?#%\s]/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const URL_SPAN = /(?:https?:\/\/|www\.)[^\s<>]*/g;
// A failed address must not retry every suffix of a long local-part run.
const EMAIL_SPAN = /(?<![a-z0-9._%+-])[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g;
const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const BOUNDARY = '[\\p{L}\\p{M}\\p{N}_]';
const WS_RUN = /\s+/g;

function fail(): never {
  throw new AnswerMentionError(MSG);
}

function strOk(v: unknown): v is string {
  return typeof v === 'string' && toUSVString(v) === v;
}

function dense(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail();
  for (let i = 0; i < v.length; i++) if (!(i in v)) fail();
  return v;
}

function word(v: unknown, max: number): string {
  if (!strOk(v) || v.length === 0 || v.length > max) fail();
  if (ASCII_CONTROL.test(v) || v !== v.trim()) fail();
  return v;
}

function stripHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  const noDot = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  return noDot.startsWith('www.') ? noDot.slice(4) : noDot;
}

function validHost(host: string): boolean {
  const labels = host.split('.');
  return host.length <= 253 && labels.length >= 2 && !IPV4.test(host) && labels.every((l) => DNS_LABEL.test(l));
}

function subjectDomain(v: unknown): string {
  if (!strOk(v) || v.length === 0 || v.length > 253 || DOMAIN_FORBIDDEN.test(v)) fail();
  let host: string;
  try {
    host = new URL('https://' + v).hostname;
  } catch {
    fail();
  }
  const stripped = stripHost(host);
  if (!validHost(stripped)) fail();
  return stripped;
}

function citationHost(s: string): string | null {
  if (s === '') return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  const host = stripHost(u.hostname);
  return validHost(host) ? host : null;
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}

function citedIndexes(hosts: Array<string | null>, domains: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i];
    if (h !== null && domains.some((d) => hostMatches(h, d))) out.push(i);
  }
  return out;
}

function boundaryRe(key: string): RegExp {
  const body = key
    .split(' ')
    .map((p) => p.replace(REGEX_META, '\\$&'))
    .join('\\s+');
  return new RegExp('(?<!' + BOUNDARY + ')' + body + '(?!' + BOUNDARY + ')', 'u');
}

export function matchAnswer(input: {
  text: string; subjects: MentionSubject[]; citationUrls: string[];
  method: MentionMethod;
}): AnswerMention[] {
  if (typeof input !== 'object' || input === null) fail();
  const o = input as Record<string, unknown>;
  const method = o.method;
  if (method !== 'elmo-substring-v1' && method !== 'unicode-boundary-v1') fail();
  const text = o.text;
  if (!strOk(text) || text.length > 250000) fail();

  const citations = dense(o.citationUrls, 100).map((c) => {
    if (!strOk(c) || c.length > 8192) fail();
    return c;
  });

  const ids = new Set<string>();
  const subjects = dense(o.subjects, 101).map((v) => {
    if (typeof v !== 'object' || v === null) fail();
    const s = v as Record<string, unknown>;
    const id = word(s.id, 100);
    if (ids.has(id)) fail();
    ids.add(id);
    return {
      id,
      name: word(s.name, 512),
      aliases: dense(s.aliases, 20).map((a) => word(a, 512)),
      domains: dense(s.domains, 20).map(subjectDomain),
    };
  });

  const unicode = method === 'unicode-boundary-v1';
  const keyed = subjects.map((s) => {
    const seen = new Set<string>();
    const terms: Array<{ display: string; key: string }> = [];
    const ordered = unicode ? [s.name, ...s.aliases] : [s.name, ...s.aliases, ...s.domains];
    for (const display of ordered) {
      const key = unicode
        ? display.normalize('NFC').toLowerCase().replace(WS_RUN, ' ')
        : display.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push({ display, key });
    }
    return { s, terms };
  });

  let total = 0;
  for (const k of keyed) total += k.terms.length;
  if (text.length * Math.max(1, total) > 20000000) fail();

  const hosts = citations.map(citationHost);
  const finish = (
    s: { id: string; domains: string[] },
    hit: { display: string } | undefined,
  ): AnswerMention => {
    const citationIndexes = citedIndexes(hosts, s.domains);
    return {
      id: s.id,
      mentioned: hit !== undefined,
      matchedTerm: hit ? hit.display : null,
      cited: citationIndexes.length > 0,
      citationIndexes,
    };
  };

  if (!unicode) {
    const hay = text.toLowerCase();
    return keyed.map(({ s, terms }) => finish(s, terms.find((t) => hay.includes(t.key))));
  }

  const blank = (m: string) => ' '.repeat(m.length);
  const masked = text.normalize('NFC').toLowerCase().replace(URL_SPAN, blank).replace(EMAIL_SPAN, blank);
  return keyed.map(({ s, terms }) => finish(s, terms.find((t) => boundaryRe(t.key).test(masked))));
}
