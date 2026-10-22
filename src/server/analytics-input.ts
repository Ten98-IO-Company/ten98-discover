import { InputError } from './validation.ts';
import { toUSVString, types } from 'node:util';
import { paidAdsClickIds } from '../lib/attribution.ts';
import { analyticsTag } from '../lib/analytics-tag.ts';

export type PropertyPrimitive = string | number | boolean | null;
export type NormalizedProperty =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'date'; value: string }
  | { type: 'array'; value: PropertyPrimitive[] }
  | { type: 'null'; value: null };
export type NormalizedProperties = Record<string, NormalizedProperty>;
export type NormalizedDimensions = {
  referrerHost?: string;
  language?: string;
  screenWidth?: number;
  screenHeight?: number;
  campaign?: {
    source?: string;
    medium?: string;
    campaign?: string;
    term?: string;
    content?: string;
  };
  clickIds?: Partial<Record<typeof paidAdsClickIds[number][0], string>>;
  distinctId?: string;
  tag?: string;
};

const utf8 = new TextEncoder();
const CTRL = /[\x00-\x1F\x7F]/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

// Generic message only: never echo values, keys, URLs or nested errors.
function bad(): never {
  throw new InputError(400, 'invalid analytics input');
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || types.isProxy(v) || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

// PostgreSQL JSONB cannot store NUL bytes or unpaired surrogates.
const cleanText = (s: string): boolean => toUSVString(s) === s && !s.includes('\x00');

// Inspect every own property before reading or serializing. JSON ignores hidden
// fields and array extras, but their toJSON/accessor hooks can still execute.
function dataKeys(value: object): string[] {
  return Reflect.ownKeys(value).map(key => {
    if (typeof key !== 'string') bad();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) bad();
    return key;
  });
}

// Normalized UTC timestamp, or null when s is not a strictly valid RFC3339
// timestamp (invalid date-looking strings stay strings, never reject).
const asDate = (s: string): string | null => {
  const m = DATE_RE.exec(s);
  if (!m || m[0] !== s) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = Number(m[6]);
  const frac = m[7];
  const off = m[8]!;
  if (h > 23 || mi > 59 || sec > 59) return null; // leap seconds stay strings
  let offMin = 0;
  if (off !== 'Z' && off !== 'z') {
    const oh = Number(off.slice(1, 3));
    const om = Number(off.slice(4, 6));
    if (oh > 23 || om > 59 || off === '-00:00') return null; // -00:00 = unknown offset
    offMin = (oh * 60 + om) * (off.startsWith('-') ? -1 : 1);
  }
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d); // setUTCFullYear avoids the Date.UTC 0-99 quirk
  t.setUTCHours(h, mi, sec, 0);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  t.setUTCMinutes(t.getUTCMinutes() - offMin); // minute-granular, so fraction passes through
  const uy = t.getUTCFullYear();
  if (uy < 0 || uy > 9999) return null; // keep four-digit years
  const f = frac === undefined ? '000' : frac.length >= 3 ? frac : frac.padEnd(3, '0');
  return `${t.toISOString().slice(0, 19)}.${f}Z`;
};

// Scalar validation shared by leaf values and array elements.
const scalar = (v: unknown): PropertyPrimitive => {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Math.abs(v) > 1e15) bad();
    return v;
  }
  if (typeof v === 'string') {
    if (v.length > 1000 || !cleanText(v)) bad();
    return v;
  }
  return bad();
};

const arrayLeaf = (arr: unknown[]): NormalizedProperty => {
  if (Object.getPrototypeOf(arr) !== Array.prototype || arr.length > 50) bad();
  for (const key of Reflect.ownKeys(arr)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= arr.length) bad();
    const descriptor = Object.getOwnPropertyDescriptor(arr, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) bad();
  }
  const value: PropertyPrimitive[] = [];
  for (let i = 0; i < arr.length; i++) {
    const desc = Object.getOwnPropertyDescriptor(arr, String(i));
    if (!desc || !('value' in desc)) bad(); // sparse hole or accessor
    value.push(scalar(desc.value)); // array strings stay plain strings, no date typing
  }
  if (utf8.encode(JSON.stringify(value)).length > 4096) bad();
  return { type: 'array', value };
};

const leaf = (v: unknown): NormalizedProperty => {
  if (types.isProxy(v)) bad();
  if (Array.isArray(v)) return arrayLeaf(v);
  const p = scalar(v);
  if (typeof p === 'string') {
    const dt = asDate(p);
    return dt === null ? { type: 'string', value: p } : { type: 'date', value: dt };
  }
  if (typeof p === 'number') return { type: 'number', value: p };
  if (typeof p === 'boolean') return { type: 'boolean', value: p };
  return { type: 'null', value: null };
};

export function normalizeProperties(raw: unknown): NormalizedProperties {
  if (!isPlainObject(raw)) bad();
  const out: NormalizedProperties = {};
  const stack = new Set<unknown>();
  let leaves = 0;
  const walk = (obj: Record<string, unknown>, path: string, depth: number): void => {
    if (stack.has(obj)) bad(); // cycle
    stack.add(obj);
    for (const key of dataKeys(obj)) {
      const desc = Object.getOwnPropertyDescriptor(obj, key)!;
      if (!('value' in desc)) bad(); // accessor: reject without invoking it
      if (key.length === 0 || key.length > 80 || FORBIDDEN_KEYS.has(key) || !cleanText(key)) bad();
      const p = (path ? `${path}.` : '') + key.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
      if (p.length > 320) bad();
      const v = desc.value;
      if (isPlainObject(v)) {
        if (depth >= 4) bad();
        walk(v, p, depth + 1);
      } else {
        if (++leaves > 50) bad();
        out[p] = leaf(v);
      }
    }
    stack.delete(obj);
  };
  walk(raw, '', 1);
  // Structure is fully validated above, so stringify cannot hit cycles,
  // accessors or toJSON callbacks.
  if (utf8.encode(JSON.stringify(raw)).length > 6144) bad();
  return out;
}

const referrerHost = (v: unknown): string => {
  if (typeof v !== 'string' || v.length > 2048 || v !== v.trim() || !cleanText(v) || CTRL.test(v)) bad();
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return bad();
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '') bad();
  return u.hostname; // platform-normalized host only: no port, path, query or fragment
};

const language = (v: unknown): string => {
  if (typeof v !== 'string' || v.length > 100 || !cleanText(v)) bad();
  try {
    return new Intl.Locale(v).toString();
  } catch {
    return bad(); // reject invalid BCP47 rather than trimming
  }
};

const screen = (v: unknown): { w: number; h: number } => {
  if (!isPlainObject(v)) bad();
  const dim = (k: string): number => {
    const desc = Object.getOwnPropertyDescriptor(v, k);
    if (!desc || !('value' in desc) || !Number.isInteger(desc.value) || desc.value < 1 || desc.value > 10000) bad();
    return desc.value as number;
  };
  const w = dim('width');
  const h = dim('height');
  for (const k of dataKeys(v)) if (k !== 'width' && k !== 'height') bad();
  return { w, h };
};

const CAMPAIGN_KEYS = new Set(['source', 'medium', 'campaign', 'term', 'content']);

const campaign = (v: unknown): NonNullable<NormalizedDimensions['campaign']> => {
  if (!isPlainObject(v)) bad();
  const out: Record<string, string> = {};
  for (const k of dataKeys(v)) {
    if (!CAMPAIGN_KEYS.has(k)) bad();
    const desc = Object.getOwnPropertyDescriptor(v, k)!;
    if (!('value' in desc) || typeof desc.value !== 'string' || desc.value.length > 200 || !cleanText(desc.value)) bad();
    out[k] = desc.value;
  }
  return out;
};

const CLICK_ID_KEYS = new Set<string>(paidAdsClickIds.map(([id]) => id));

// Pinned Umami keeps the value URLSearchParams read (empty included) and truncates it to VarChar(255). Truncating by
// code point before the JSONB-safety check never splits a surrogate pair, and PostgreSQL varchar counts code points.
const clickIds = (v: unknown): NonNullable<NormalizedDimensions['clickIds']> => {
  if (!isPlainObject(v)) bad();
  const out: Record<string, string> = {};
  for (const k of dataKeys(v)) {
    const desc = Object.getOwnPropertyDescriptor(v, k)!;
    if (!CLICK_ID_KEYS.has(k) || !('value' in desc) || typeof desc.value !== 'string') bad();
    const value = Array.from(desc.value).slice(0, 255).join('');
    if (!cleanText(value)) bad();
    out[k] = value;
  }
  return out;
};

const distinctId =(v: unknown): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > 256 || !cleanText(v) || CTRL.test(v)) bad();
  return v; // preserved exactly; the collector hashes and drops it before storage
};

export function normalizeDimensions(raw: unknown): NormalizedDimensions {
  if (!isPlainObject(raw)) bad();
  const out: NormalizedDimensions = {};
  for (const key of dataKeys(raw)) {
    const desc = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!('value' in desc)) bad();
    const v = desc.value; // explicit undefined fails every check below
    switch (key) {
      case 'referrer':
        out.referrerHost = referrerHost(v);
        break;
      case 'language':
        out.language = language(v);
        break;
      case 'screen': {
        const { w, h } = screen(v);
        out.screenWidth = w;
        out.screenHeight = h;
        break;
      }
      case 'campaign':
        out.campaign = campaign(v);
        break;
      case 'clickIds':
        out.clickIds = clickIds(v);
        break;
      case 'distinctId':
        out.distinctId = distinctId(v);
        break;
      case 'tag': {
        // A value that is not a clean label drops the tag, never the event (https://github.com/Ten98-IO-Company/ten98-discover/wiki/Tracking).
        const tag = analyticsTag(v);
        if (tag !== null) out.tag = tag;
        break;
      }
      default:
        bad(); // unknown fields rejected at every level
    }
  }
  return out;
}
