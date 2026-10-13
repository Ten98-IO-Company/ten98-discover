// Bounded input parser leaf for rank keyword requests (issue #41).
// Runtime trust boundary: every rejection throws one fixed InputError,
// no input bytes are echoed, and getters/valueOf/toJSON are never invoked.

import { toUSVString, types } from 'node:util';
import { z } from 'zod';
import { InputError } from './validation.ts';

export interface RankKeywordAdd {
  requestId: string;
  revision: number;
  keywords: string[];
  matchCase: boolean;
}

export interface RankKeywordRemove {
  requestId: string;
  revision: number;
  keywordIds: string[];
}

export interface RankKeywordPin extends RankKeywordRemove {
  pinned: boolean;
}

const MESSAGE = 'Check the rank keyword fields and try again.';
const CONTROL = /[\u0000-\u001F\u007F]/;
const uuid = z.uuid();

const ADD_KEYS = ['requestId', 'revision', 'keywords', 'matchCase'] as const;
const REMOVE_KEYS = ['requestId', 'revision', 'keywordIds'] as const;
const PIN_KEYS = ['requestId', 'revision', 'keywordIds', 'pinned'] as const;

function fail(): never {
  throw new InputError(400, MESSAGE);
}

// Convert any stray throw (e.g. revoked-proxy TypeError) into the common error.
function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof InputError) throw err;
    fail();
  }
}

// Plain data object: exactly Object.prototype, own enumerable data props only.
function asRecord(raw: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || types.isProxy(raw)) fail();
  if (Object.getPrototypeOf(raw) !== Object.prototype) fail();
  if (Object.getOwnPropertySymbols(raw).length > 0) fail();
  const keys = Object.keys(raw);
  if (Object.getOwnPropertyNames(raw).length !== keys.length) fail();
  for (const key of keys) {
    if (!allowed.includes(key)) fail();
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (desc === undefined || !('value' in desc) || desc.value === undefined) fail();
  }
  for (const key of required) if (!keys.includes(key)) fail();
  return raw as Record<string, unknown>;
}

// Plain dense array: exactly Array.prototype, no holes, extras, hidden or accessor elements.
function asBoundedList(raw: unknown): unknown[] {
  if (typeof raw !== 'object' || raw === null || types.isProxy(raw)) fail();
  if (!Array.isArray(raw)) fail();
  if (raw.length < 1 || raw.length > 2000) fail();
  if (Object.getPrototypeOf(raw) !== Array.prototype) fail();
  if (Object.getOwnPropertySymbols(raw).length > 0) fail();
  if (Object.getOwnPropertyNames(raw).length !== raw.length + 1) fail();
  for (let index = 0; index < raw.length; index++) {
    const desc = Object.getOwnPropertyDescriptor(raw, String(index));
    if (desc === undefined || !desc.enumerable || !('value' in desc) || desc.value === undefined) fail();
  }
  return raw;
}

function asUuid(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length !== 36 || !uuid.safeParse(raw).success) fail();
  return raw.toLowerCase();
}

function asRevision(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > 2147483646) fail();
  return raw;
}

function asBoolean(raw: unknown): boolean {
  if (typeof raw !== 'boolean') fail();
  return raw;
}

export function normalizeRankKeyword(raw: unknown, matchCase: boolean = false): string {
  return guard(() => {
    if (typeof matchCase !== 'boolean') fail();
    if (typeof raw !== 'string') fail();
    if (raw.length < 1 || raw.length > 200) fail();
    if (toUSVString(raw) !== raw) fail();
    if (CONTROL.test(raw)) fail();
    const keyword = matchCase ? raw.trim() : raw.trim().toLowerCase();
    if (keyword.length < 1 || keyword.length > 200) fail();
    return keyword;
  });
}

export function parseRankKeywordAdd(raw: unknown): RankKeywordAdd {
  return guard(() => {
    const rec = asRecord(raw, ADD_KEYS, ['requestId', 'revision', 'keywords']);
    const matchCase = Object.hasOwn(rec, 'matchCase') ? asBoolean(rec.matchCase) : false;
    const seen = new Set<string>();
    const keywords: string[] = [];
    for (const entry of asBoundedList(rec.keywords)) {
      const keyword = normalizeRankKeyword(entry, matchCase);
      if (!seen.has(keyword)) {
        seen.add(keyword);
        keywords.push(keyword);
      }
    }
    return { requestId: asUuid(rec.requestId), revision: asRevision(rec.revision), keywords, matchCase };
  });
}

export function parseRankKeywordRemove(raw: unknown): RankKeywordRemove {
  return guard(() => {
    const rec = asRecord(raw, REMOVE_KEYS, REMOVE_KEYS);
    return { requestId: asUuid(rec.requestId), revision: asRevision(rec.revision), keywordIds: asIdList(rec.keywordIds) };
  });
}

export function parseRankKeywordPin(raw: unknown): RankKeywordPin {
  return guard(() => {
    const rec = asRecord(raw, PIN_KEYS, PIN_KEYS);
    return {
      requestId: asUuid(rec.requestId),
      revision: asRevision(rec.revision),
      keywordIds: asIdList(rec.keywordIds),
      pinned: asBoolean(rec.pinned),
    };
  });
}

function asIdList(raw: unknown): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of asBoundedList(raw)) {
    const id = asUuid(entry);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
