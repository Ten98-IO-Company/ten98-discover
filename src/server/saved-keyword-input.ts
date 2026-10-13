// src/server/saved-keyword-input.ts
// Strict input parsers for the saved-keyword surface. Inputs are unknown and
// untrusted; every invalid input throws the same InputError(400) without
// echoing values. No I/O, config, auth, DB or environment access at import.

import { types, toUSVString } from 'node:util';
import { z } from 'zod';
import { normalizeKeyword } from './keyword-research-input.ts';
import { InputError } from './validation.ts';

const MESSAGE = 'Check the saved keyword fields and try again.';

function bad(): never {
  throw new InputError(400, MESSAGE);
}

// ---------------------------------------------------------------------------
// Structural guards: plain objects and dense arrays only. No proxies, no
// accessors (never invoke getters), no symbol keys, no non-enumerable hidden
// data, no custom prototypes, no holes, no extra array keys, no explicit
// undefined. Values are read from own data descriptors, so no toJSON/valueOf
// or getter hooks can execute.
// ---------------------------------------------------------------------------

function asObject(raw: unknown, allowed: readonly string[]): Map<string, unknown> {
  if (typeof raw !== 'object' || raw === null || types.isProxy(raw) || Array.isArray(raw)) bad();
  const proto: unknown = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype) bad();
  if (Object.getOwnPropertySymbols(raw).length !== 0) bad();
  const out = new Map<string, unknown>();
  for (const name of Object.getOwnPropertyNames(raw)) {
    const desc = Object.getOwnPropertyDescriptor(raw, name);
    if (desc === undefined || !('value' in desc) || !desc.enumerable) bad();
    if (desc.value === undefined) bad();
    if (!allowed.includes(name)) bad();
    out.set(name, desc.value);
  }
  return out;
}

function asArray(raw: unknown, min: number, max: number): unknown[] {
  if (types.isProxy(raw) || !Array.isArray(raw)) bad();
  if (Object.getPrototypeOf(raw) !== Array.prototype) bad();
  if (raw.length < min || raw.length > max) bad();
  const names = Object.getOwnPropertyNames(raw);
  // Exactly the indices 0..len-1 plus the built-in 'length'. Catches holes,
  // extra string keys and the hole-plus-extra-key disguise.
  if (names.length !== raw.length + 1 || names[raw.length] !== 'length') bad();
  if (Object.getOwnPropertySymbols(raw).length !== 0) bad();
  const out: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (names[i] !== String(i)) bad();
    const desc = Object.getOwnPropertyDescriptor(raw, names[i]);
    if (desc === undefined || !('value' in desc) || !desc.enumerable) bad();
    if (desc.value === undefined) bad();
    out.push(desc.value);
  }
  return out;
}

function required(m: Map<string, unknown>, key: string): unknown {
  if (!m.has(key)) bad();
  return m.get(key);
}

// ---------------------------------------------------------------------------
// Scalar primitives. No number/string coercion anywhere.
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  if (typeof v !== 'string') bad();
  if (v !== toUSVString(v)) bad();
  return v;
}

// Free-text fields additionally reject C0 controls and DEL (NUL included).
function asText(v: unknown): string {
  const s = asString(v);
  if (/[\x00-\x1F\x7F]/.test(s)) bad();
  return s;
}

function asInt(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) bad();
  return v;
}

const uuidSchema = z.uuid();

function asUuid(v: unknown): string {
  if (typeof v !== 'string' || v.length !== 36) bad();
  if (!uuidSchema.safeParse(v).success) bad();
  return v.toLowerCase();
}

const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Z]{2})?(?![\s\S])/;

function asLanguageCode(v: unknown): string {
  if (typeof v !== 'string' || !LANGUAGE_CODE.test(v)) bad();
  return v;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) bad();
  return v as T;
}

const WHITESPACE = /\s+/gu;

function collapse(s: string): string {
  return s.trim().replace(WHITESPACE, ' ');
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function asUuidList(raw: unknown, min: number, max: number): string[] {
  return dedupe(asArray(raw, min, max).map(asUuid)); // raw bound applied before dedupe
}

function asRowIndexes(raw: unknown): number[] {
  return dedupe(asArray(raw, 1, 100).map((v) => asInt(v, 0, 99)));
}

function asIdentity(m: Map<string, unknown>): { requestId: string; revision: number } {
  return {
    requestId: asUuid(required(m, 'requestId')),
    revision: asInt(required(m, 'revision'), 1, 2147483646),
  };
}

// ---------------------------------------------------------------------------
// Keywords and tags
// ---------------------------------------------------------------------------

export function normalizeSavedKeyword(raw: unknown): string {
  const input = asText(raw);
  if (input.length < 1 || input.length > 500) bad();
  const normalized = collapse(input).toLowerCase();
  if (normalized.length < 1 || normalized.length > 500) bad();
  return normalized; // no decoding, no compatibility folding, no stemming
}

export function savedKeywordRefreshable(keyword: string): boolean {
  try {
    return normalizeKeyword(keyword) === keyword;
  } catch {
    return false;
  }
}

export interface SavedTagInput {
  name: string;
  normalizedName: string;
}

function asTag(v: unknown): SavedTagInput {
  const input = asText(v);
  if (input.length < 1 || input.length > 64) bad();
  const name = collapse(input);
  if (name.length < 1 || name.length > 64) bad(); // blank tags rejected, not dropped
  const normalizedName = name.toLowerCase();
  if (normalizedName.length > 64) bad();
  return { name, normalizedName };
}

export function normalizeSavedTags(raw: unknown): SavedTagInput[] {
  const items = asArray(raw, 0, 20);
  const seen = new Set<string>();
  const out: SavedTagInput[] = [];
  for (const item of items) {
    const tag = asTag(item);
    if (seen.has(tag.normalizedName)) continue; // first display spelling wins
    seen.add(tag.normalizedName);
    out.push(tag);
  }
  return out;
}

export const tagColors = ['slate', 'rose', 'amber', 'lime', 'emerald', 'sky', 'violet', 'fuchsia'] as const;
export type SavedTagColor = (typeof tagColors)[number];

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export interface SavedKeywordSave {
  requestId: string;
  revision: number;
  source:
    | { type: 'manual'; keywords: string[]; locationCode: number; languageCode: string }
    | { type: 'run'; runId: string; rowIndexes: number[] };
  tags: SavedTagInput[];
  tagMode: 'append' | 'replace';
}

function asSaveSource(raw: unknown): SavedKeywordSave['source'] {
  const m = asObject(raw, ['type', 'keywords', 'locationCode', 'languageCode', 'runId', 'rowIndexes']);
  const type = required(m, 'type');
  if (type === 'manual') {
    if (m.has('runId') || m.has('rowIndexes')) bad();
    return {
      type: 'manual',
      keywords: dedupe(asArray(required(m, 'keywords'), 1, 500).map(normalizeSavedKeyword)),
      locationCode: asInt(required(m, 'locationCode'), 1, 2147483647),
      languageCode: asLanguageCode(required(m, 'languageCode')),
    };
  }
  if (type === 'run') {
    // No client keyword/market/metrics/timestamp/source overrides: unknown
    // keys already rejected, and manual-only fields are forbidden here.
    if (m.has('keywords') || m.has('locationCode') || m.has('languageCode')) bad();
    return {
      type: 'run',
      runId: asUuid(required(m, 'runId')),
      rowIndexes: asRowIndexes(required(m, 'rowIndexes')),
    };
  }
  bad();
}

export function parseSavedKeywordSave(raw: unknown): SavedKeywordSave {
  const m = asObject(raw, ['requestId', 'revision', 'source', 'tags', 'tagMode']);
  const tags = m.has('tags') ? normalizeSavedTags(required(m, 'tags')) : [];
  const tagMode = m.has('tagMode') ? asEnum(required(m, 'tagMode'), ['append', 'replace']) : 'append';
  if (tagMode === 'replace' && tags.length === 0) bad();
  return { ...asIdentity(m), source: asSaveSource(required(m, 'source')), tags, tagMode };
}

// ---------------------------------------------------------------------------
// Bulk tags and deletion
// ---------------------------------------------------------------------------

export type SavedKeywordTagChange =
  | { requestId: string; revision: number; keywordIds: string[]; operation: 'add' | 'replace'; tags: SavedTagInput[] }
  | { requestId: string; revision: number; keywordIds: string[]; operation: 'remove'; tagIds: string[] }
  | { requestId: string; revision: number; keywordIds: string[]; operation: 'clear' };

export function parseSavedKeywordTagChange(raw: unknown): SavedKeywordTagChange {
  const m = asObject(raw, ['requestId', 'revision', 'keywordIds', 'operation', 'tags', 'tagIds']);
  const base = { ...asIdentity(m), keywordIds: asUuidList(required(m, 'keywordIds'), 1, 2000) };
  const operation = required(m, 'operation');
  if (operation === 'add' || operation === 'replace') {
    if (m.has('tagIds')) bad();
    const tags = normalizeSavedTags(required(m, 'tags'));
    if (tags.length === 0) bad();
    return { ...base, operation, tags };
  }
  if (operation === 'remove') {
    if (m.has('tags')) bad();
    return { ...base, operation, tagIds: asUuidList(required(m, 'tagIds'), 1, 50) };
  }
  if (operation === 'clear') {
    if (m.has('tags') || m.has('tagIds')) bad();
    return { ...base, operation };
  }
  bad();
}

export function parseSavedKeywordRemove(raw: unknown): { requestId: string; revision: number; keywordIds: string[] } {
  const m = asObject(raw, ['requestId', 'revision', 'keywordIds']);
  return { ...asIdentity(m), keywordIds: asUuidList(required(m, 'keywordIds'), 1, 2000) };
}

export function parseSavedTagUpdate(raw: unknown): {
  requestId: string;
  revision: number;
  name?: SavedTagInput;
  color?: SavedTagColor | null;
} {
  const m = asObject(raw, ['requestId', 'revision', 'name', 'color']);
  if (!m.has('name') && !m.has('color')) bad();
  const out: { requestId: string; revision: number; name?: SavedTagInput; color?: SavedTagColor | null } =
    asIdentity(m);
  if (m.has('name')) out.name = asTag(required(m, 'name'));
  if (m.has('color')) {
    const c = required(m, 'color');
    out.color = c === null ? null : asEnum(c, tagColors); // null only for color
  }
  return out;
}

export function parseSavedTagDelete(raw: unknown): { requestId: string; revision: number } {
  return asIdentity(asObject(raw, ['requestId', 'revision']));
}

// ---------------------------------------------------------------------------
// Shared filters
// ---------------------------------------------------------------------------

export interface SavedKeywordFilters {
  search: string;
  includeTerms: string[];
  excludeTerms: string[];
  locationCode: number | null;
  languageCode: string | null;
  tagIds: string[];
  minVolume: number | null;
  maxVolume: number | null;
  minDifficulty: number | null;
  maxDifficulty: number | null;
  minCpcUsd: string | null;
  maxCpcUsd: string | null;
  metrics: 'all' | 'available' | 'unavailable' | 'expired';
  sort: 'createdAt' | 'keyword' | 'searchVolume' | 'cpcUsd' | 'competition' | 'keywordDifficulty' | 'fetchedAt';
  order: 'asc' | 'desc';
}

function asSearch(v: unknown): string {
  const input = asText(v);
  if (input.length > 200) bad();
  const out = input.trim().toLowerCase(); // internal whitespace and % _ + \ kept literal
  if (out.length > 200) bad();
  return out;
}

function asTerms(raw: unknown): string[] {
  const items = asArray(raw, 0, 20);
  const out: string[] = [];
  for (const item of items) {
    const input = asText(item);
    if (input.length < 1 || input.length > 200) bad();
    const term = input.trim().toLowerCase();
    if (term.length < 1 || term.length > 200) bad();
    out.push(term);
  }
  return dedupe(out);
}

const CPC = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?(?![\s\S])/;
const MICROS_PER_USD = 1_000_000n;
const MAX_CPC_MICROS = 1_000_000n * MICROS_PER_USD; // 1,000,000 USD in integer micros

function asCpc(v: unknown): { text: string; micros: bigint } {
  if (typeof v !== 'string' || v.length > 14) bad();
  const match = CPC.exec(v);
  if (match === null) bad();
  const micros = BigInt(match[1]) * MICROS_PER_USD + BigInt((match[2] ?? '').padEnd(6, '0'));
  if (micros > MAX_CPC_MICROS) bad();
  const fraction = (micros % MICROS_PER_USD).toString().padStart(6, '0');
  return { text: `${micros / MICROS_PER_USD}.${fraction}`, micros }; // six decimal places
}

export function parseSavedKeywordFilters(raw: unknown): SavedKeywordFilters {
  const m = asObject(raw, [
    'search', 'includeTerms', 'excludeTerms', 'locationCode', 'languageCode', 'tagIds',
    'minVolume', 'maxVolume', 'minDifficulty', 'maxDifficulty', 'minCpcUsd', 'maxCpcUsd',
    'metrics', 'sort', 'order',
  ]);
  const minVolume = m.has('minVolume') ? asInt(required(m, 'minVolume'), 0, Number.MAX_SAFE_INTEGER) : null;
  const maxVolume = m.has('maxVolume') ? asInt(required(m, 'maxVolume'), 0, Number.MAX_SAFE_INTEGER) : null;
  if (minVolume !== null && maxVolume !== null && minVolume > maxVolume) bad();
  const minDifficulty = m.has('minDifficulty') ? asInt(required(m, 'minDifficulty'), 0, 100) : null;
  const maxDifficulty = m.has('maxDifficulty') ? asInt(required(m, 'maxDifficulty'), 0, 100) : null;
  if (minDifficulty !== null && maxDifficulty !== null && minDifficulty > maxDifficulty) bad();
  const minCpc = m.has('minCpcUsd') ? asCpc(required(m, 'minCpcUsd')) : null;
  const maxCpc = m.has('maxCpcUsd') ? asCpc(required(m, 'maxCpcUsd')) : null;
  if (minCpc !== null && maxCpc !== null && minCpc.micros > maxCpc.micros) bad(); // exact BigInt compare
  return {
    search: m.has('search') ? asSearch(required(m, 'search')) : '',
    includeTerms: m.has('includeTerms') ? asTerms(required(m, 'includeTerms')) : [],
    excludeTerms: m.has('excludeTerms') ? asTerms(required(m, 'excludeTerms')) : [],
    locationCode: m.has('locationCode') ? asInt(required(m, 'locationCode'), 1, 2147483647) : null,
    languageCode: m.has('languageCode') ? asLanguageCode(required(m, 'languageCode')) : null,
    tagIds: m.has('tagIds') ? asUuidList(required(m, 'tagIds'), 0, 50) : [],
    minVolume,
    maxVolume,
    minDifficulty,
    maxDifficulty,
    minCpcUsd: minCpc === null ? null : minCpc.text,
    maxCpcUsd: maxCpc === null ? null : maxCpc.text,
    metrics: m.has('metrics')
      ? asEnum(required(m, 'metrics'), ['all', 'available', 'unavailable', 'expired'])
      : 'all',
    sort: m.has('sort')
      ? asEnum(required(m, 'sort'), ['createdAt', 'keyword', 'searchVolume', 'cpcUsd', 'competition', 'keywordDifficulty', 'fetchedAt'])
      : 'createdAt',
    order: m.has('order') ? asEnum(required(m, 'order'), ['asc', 'desc']) : 'desc',
  };
}

const CURSOR = /^[A-Za-z0-9_-]{1,512}(?![\s\S])/;

export function parseSavedKeywordList(raw: unknown): {
  filters: SavedKeywordFilters;
  pageSize: 50 | 100 | 250;
  cursor: string | null;
} {
  const m = asObject(raw, ['filters', 'pageSize', 'cursor']);
  const pageSize = m.has('pageSize') ? required(m, 'pageSize') : 50;
  if (pageSize !== 50 && pageSize !== 100 && pageSize !== 250) bad();
  const cursor = m.has('cursor') ? required(m, 'cursor') : null;
  if (cursor !== null && (typeof cursor !== 'string' || !CURSOR.test(cursor))) bad();
  if (m.has('cursor') && cursor === null) bad();
  return {
    filters: parseSavedKeywordFilters(m.has('filters') ? required(m, 'filters') : {}),
    pageSize,
    cursor,
  };
}

// ---------------------------------------------------------------------------
// Export and refresh wrappers
// ---------------------------------------------------------------------------

export type SavedKeywordSelection =
  | { type: 'ids'; keywordIds: string[] }
  | { type: 'filtered'; filters: SavedKeywordFilters };

export function parseSavedKeywordSelection(raw: unknown): SavedKeywordSelection {
  const m = asObject(raw, ['type', 'keywordIds', 'filters']);
  const type = required(m, 'type');
  if (type === 'ids') {
    if (m.has('filters')) bad();
    return { type: 'ids', keywordIds: asUuidList(required(m, 'keywordIds'), 1, 2000) };
  }
  if (type === 'filtered') {
    if (m.has('keywordIds')) bad();
    return { type: 'filtered', filters: parseSavedKeywordFilters(required(m, 'filters')) };
  }
  bad();
}

export function parseSavedKeywordExport(raw: unknown): {
  selection: SavedKeywordSelection;
  format: 'csv' | 'tsv';
} {
  const m = asObject(raw, ['selection', 'format']);
  return {
    selection: parseSavedKeywordSelection(required(m, 'selection')),
    format: asEnum(required(m, 'format'), ['csv', 'tsv']),
  };
}

export function parseSavedKeywordRefreshQuote(raw: unknown): {
  connectionId: string;
  selection: SavedKeywordSelection;
} {
  const m = asObject(raw, ['connectionId', 'selection']);
  return {
    connectionId: asUuid(required(m, 'connectionId')),
    selection: parseSavedKeywordSelection(required(m, 'selection')),
  };
}

export function parseSavedKeywordRefreshStart(raw: unknown): { quoteId: string; requestKey: string } {
  const m = asObject(raw, ['quoteId', 'requestKey']);
  return { quoteId: asUuid(required(m, 'quoteId')), requestKey: asUuid(required(m, 'requestKey')) };
}
