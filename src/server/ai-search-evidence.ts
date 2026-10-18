// Tokenizer, stopword set and per-query word-vote behavior adapted from Elmo
// apps/web/src/lib/fanout-analysis.ts (pinned 3c673d0253d01ae030fa41519f62ad7e54f2281b,
// MIT, Copyright 2026 Blue Whale Software, LLC). Notice: THIRD_PARTY_NOTICES.md.

import {toUSVString} from 'node:util';
import {AnswerMentionError, matchAnswer} from './answer-mentions.ts';
import type {AnswerMention, MentionMethod, MentionSubject} from './answer-mentions.ts';

export const searchEvidenceVersion = 'dfs-chatgpt-reported-fields-v1' as const;
export const queryDerivationVersion = 'immutable-prompt-trim-lower-v1' as const;
export const queryWordsVersion = 'elmo-ascii-words-3c673d0-v1' as const;

export class SearchEvidenceError extends Error {}

export type QueryField =
 | {state:'reported'|'reported_empty'; values:string[]}
 | {state:'not_recorded'|'invalid'; values:null};
export type SearchAnswer =
 | {state:'available'|'empty';text:string;basis:'markdown'|'items'}
 | {state:'not_recorded'|'invalid';text:null;basis:null};
export type SearchEvidence = {
 version:typeof searchEvidenceVersion;
 answer:SearchAnswer;
 queries:QueryField;
};
export type DerivedQuery = {key:string;firstIndex:number;indexes:number[]};
export type QueryWord = {word:string;count:number;isStop:boolean};
export type SearchDerivation = {
 version:typeof queryDerivationVersion;
 wordsVersion:typeof queryWordsVersion;
 matcher:MentionMethod;
 queryState:QueryField['state'];
 rawQueryCount:number|null;
 blankIndexes:number[]|null;
 echoIndexes:number[]|null;
 queries:DerivedQuery[]|null;
 // Full bounded lists, not a top-N sample. Zero query population gives [].
 words:{cloud:QueryWord[];added:QueryWord[];dropped:QueryWord[];preserved:QueryWord[]}|null;
 answerState:SearchAnswer['state'];
 answerMentions:Pick<AnswerMention,'id'|'mentioned'|'matchedTerm'>[]|null;
 websiteContentCoverage:{state:'unavailable';reason:'body_corpus_not_recorded'};
};

const ERROR_MESSAGE = 'The search evidence is invalid or exceeds its limit.';
function fail():never { throw new SearchEvidenceError(ERROR_MESSAGE); }

// Application bounds, not provider maximums.
const MAX_RAW_QUERIES = 100;
const MAX_QUERY_CODEPOINTS = 2000;
const MAX_QUERY_UNITS = 4000;
const MAX_ANSWER_UNITS = 250000;
const MAX_ITEMS = 1000;
const MAX_PROMPT_UNITS = 2000;
const MAX_DERIVED_QUERIES = 100;
const MAX_DERIVED_UNITS = 400000;
const MAX_WORD_ENTRIES = 20000;

// Queries reject every C0 and DEL/C1. Answers additionally permit tab, CR, LF.
const QUERY_BAD_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const ANSWER_BAD_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function isRecord(v:unknown): v is Record<string,unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isDense(v:unknown[]): boolean {
  for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i)) return false;
  return true;
}
function hasExactKeys(o:Record<string,unknown>, keys:readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && own.every(k => keys.includes(k));
}
// Literal U+FFFD is well-formed; lone surrogates are not.
function wellFormed(s:string): boolean { return toUSVString(s) === s; }

function validQueryString(v:unknown): v is string {
  return typeof v === 'string' && wellFormed(v) && !QUERY_BAD_CONTROL.test(v);
}
function checkQueryCapacity(s:string): void {
  if (s.length > MAX_QUERY_UNITS || [...s].length > MAX_QUERY_CODEPOINTS) fail();
}
function validAnswerText(v:unknown): v is string {
  return typeof v === 'string' && wellFormed(v) && !ANSWER_BAD_CONTROL.test(v);
}

function readQueries(result:Record<string,unknown>): QueryField {
  if (!Object.hasOwn(result, 'fan_out_queries')) return {state:'not_recorded', values:null};
  const v = result.fan_out_queries;
  if (v === null || v === undefined) return {state:'not_recorded', values:null};
  if (!Array.isArray(v)) return {state:'invalid', values:null};
  if (v.length > MAX_RAW_QUERIES) fail();
  if (!isDense(v)) return {state:'invalid', values:null};
  const out:string[] = [];
  for (const e of v) {
    if (!validQueryString(e)) return {state:'invalid', values:null}; // whole field, no partial list
    checkQueryCapacity(e);
    out.push(e); // original string: order, case, whitespace, duplicates preserved
  }
  return out.length === 0 ? {state:'reported_empty', values:out} : {state:'reported', values:out};
}

function readAnswer(result:Record<string,unknown>): SearchAnswer {
  const invalid:SearchAnswer = {state:'invalid', text:null, basis:null};
  const notRecorded:SearchAnswer = {state:'not_recorded', text:null, basis:null};
  let blankTop:string|null = null;
  if (Object.hasOwn(result, 'markdown')) {
    const m = result.markdown;
    if (m !== null && m !== undefined) {
      if (!validAnswerText(m)) return invalid; // no fallback masks bad markdown
      if (m.length > MAX_ANSWER_UNITS) fail();
      if (m.trim() !== '') return {state:'available', text:m, basis:'markdown'}; // exact, untrimmed
      blankTop = m;
    }
  }
  const topFallback = ():SearchAnswer =>
    blankTop !== null ? {state:'empty', text:blankTop, basis:'markdown'} : notRecorded;
  if (!Object.hasOwn(result, 'items')) return topFallback();
  const items = result.items;
  if (items === null || items === undefined) return topFallback();
  if (!Array.isArray(items)) return invalid;
  if (items.length > MAX_ITEMS) fail();
  if (!isDense(items)) return invalid;
  let sawMarkdown = false;
  const parts:string[] = [];
  let size = 0;
  for (const it of items) {
    if (!isRecord(it)) return invalid;
    if (!Object.hasOwn(it, 'markdown')) continue; // absent markdown and unrelated keys ignored
    const mv = it.markdown;
    if (mv === null || mv === undefined) continue;
    if (!validAnswerText(mv)) return invalid;
    sawMarkdown = true;
    const trimmed = mv.trim();
    if (trimmed === '') continue; // blank blocks discarded
    size += (parts.length === 0 ? 0 : 2) + trimmed.length;
    if (size > MAX_ANSWER_UNITS) fail(); // running joined size, before allocation
    parts.push(trimmed);
  }
  if (parts.length > 0) return {state:'available', text:parts.join('\n\n'), basis:'items'};
  if (sawMarkdown) return {state:'empty', text:'', basis:'items'};
  return topFallback(); // empty/no-markdown items prove nothing on their own
}

export function normalizeDfsChatgptSearchEvidence(result:unknown): SearchEvidence {
  if (!isRecord(result)) fail();
  // Provider extras ignored; fields fail independently.
  return {version:searchEvidenceVersion, answer:readAnswer(result), queries:readQueries(result)};
}

// Exact pinned Elmo stopword set.
const STOPWORDS = new Set(
  'the a an and or but of to in on for with by at from as is are was were be been being do does did has have had will would can could should may might must shall what which who whom whose how when where why that this these those it its you your yours i me my we our ours they them their he she his her about into over than then there here if so not no up out off all any some more most such own too very s t re ll ve d m'
    .split(' ')
);

// Intentionally English/ASCII: 'café' yields 'caf'; non-Latin-only text may yield no words.
function tokenize(text:string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(token => token.length >= 2);
}

function bump(map:Map<string,number>, key:string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function wordRows(map:Map<string,number>, cloud:boolean): QueryWord[] {
  const rows:QueryWord[] = [];
  for (const [word, count] of map) rows.push({word, count, isStop:cloud ? false : STOPWORDS.has(word)});
  rows.sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  return rows;
}

function buildWords(prompt:string, queries:DerivedQuery[]): NonNullable<SearchDerivation['words']> {
  const cloud = new Map<string,number>();
  const added = new Map<string,number>();
  const dropped = new Map<string,number>();
  const preserved = new Map<string,number>();
  const promptSet = new Set(tokenize(prompt));
  for (const q of queries) { // one vote per distinct derived query in this execution
    const tokens = tokenize(q.key);
    const querySet = new Set(tokens);
    for (const t of tokens) if (!STOPWORDS.has(t)) bump(cloud, t); // every occurrence counts
    for (const t of querySet) bump(promptSet.has(t) ? preserved : added, t); // once per query
    for (const t of promptSet) if (!querySet.has(t)) bump(dropped, t);
  }
  if (cloud.size + added.size + dropped.size + preserved.size > MAX_WORD_ENTRIES) fail();
  return {cloud:wordRows(cloud, true), added:wordRows(added, false), dropped:wordRows(dropped, false), preserved:wordRows(preserved, false)};
}

function checkQueriesField(q:unknown): QueryField {
  if (!isRecord(q) || !hasExactKeys(q, ['state', 'values'])) fail();
  const s = q.state, v = q.values;
  if (s === 'not_recorded' || s === 'invalid') {
    if (v !== null) fail();
    return {state:s, values:null};
  }
  if (s !== 'reported' && s !== 'reported_empty') fail();
  if (!Array.isArray(v) || v.length > MAX_RAW_QUERIES || !isDense(v)) fail();
  if (s === 'reported' ? v.length === 0 : v.length !== 0) fail(); // coherent discriminant
  for (const e of v) {
    if (!validQueryString(e)) fail();
    checkQueryCapacity(e);
  }
  return {state:s, values:[...v]};
}

function checkAnswerField(a:unknown): SearchAnswer {
  if (!isRecord(a) || !hasExactKeys(a, ['state', 'text', 'basis'])) fail();
  const s = a.state, t = a.text, b = a.basis;
  if (s === 'not_recorded' || s === 'invalid') {
    if (t !== null || b !== null) fail();
    return {state:s, text:null, basis:null};
  }
  if (s !== 'available' && s !== 'empty') fail();
  if (b !== 'markdown' && b !== 'items') fail();
  if (!validAnswerText(t)) fail();
  if (t.length > MAX_ANSWER_UNITS) fail();
  const blank = t.trim() === '';
  if (s === 'available' ? blank : !blank) fail(); // available/blank and empty/nonblank rejected
  return {state:s, text:t, basis:b};
}

export function readSearchEvidence(ev:unknown): SearchEvidence {
  if (!isRecord(ev) || !hasExactKeys(ev, ['version', 'answer', 'queries']) || ev.version !== searchEvidenceVersion) fail();
  return {version:searchEvidenceVersion, answer:checkAnswerField(ev.answer), queries:checkQueriesField(ev.queries)};
}

export function deriveSearchQueries(input:{
 evidence:SearchEvidence;
 capturedPrompt:string;
 subjects:MentionSubject[];
 method:MentionMethod;
}): SearchDerivation {
  if (!isRecord(input) || !hasExactKeys(input, ['evidence', 'capturedPrompt', 'subjects', 'method'])) fail();
  const method = input.method;
  if (method !== 'elmo-substring-v1' && method !== 'unicode-boundary-v1') fail();
  const prompt = input.capturedPrompt;
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_PROMPT_UNITS
      || !wellFormed(prompt) || prompt.includes('\u0000')) fail(); // validated even without queries
  const ev = readSearchEvidence(input.evidence); // retained normalized JSON re-validated

  // One match per execution on the answer axis, never per query; validates subjects/method even at ''.
  const ans = ev.answer;
  let matches:AnswerMention[];
  try {
    matches = matchAnswer({text:ans.state === 'available' ? ans.text : '', subjects:input.subjects, citationUrls:[], method});
  } catch (e) {
    if (e instanceof AnswerMentionError) fail();
    throw e;
  }
  const answerMentions = ans.state === 'available'
    ? matches.map(m => ({id:m.id, mentioned:m.mentioned, matchedTerm:m.matchedTerm}))
    : null;

  const qf = ev.queries;
  const queryState = qf.state;
  let rawQueryCount:number|null = null;
  let blankIndexes:number[]|null = null;
  let echoIndexes:number[]|null = null;
  let queries:DerivedQuery[]|null = null;
  let words:SearchDerivation['words'] = null;

  if (qf.state === 'reported' || qf.state === 'reported_empty') {
    const raw = qf.values;
    rawQueryCount = raw.length;
    const blank:number[] = [];
    const echo:number[] = [];
    const groups = new Map<string,DerivedQuery>();
    const promptKey = prompt.trim().toLowerCase(); // trim/lower only: no collapse, decode, stemming
    let units = 0;
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      units += s.length;
      const trimmed = s.trim();
      if (trimmed === '') { blank.push(i); continue; }
      const key = trimmed.toLowerCase();
      if (key === promptKey) { echo.push(i); continue; }
      let g = groups.get(key);
      if (!g) { g = {key, firstIndex:i, indexes:[]}; groups.set(key, g); }
      g.indexes.push(i);
    }
    queries = [...groups.values()]; // first-occurrence order, indexes ascending
    if (queries.length > MAX_DERIVED_QUERIES || units > MAX_DERIVED_UNITS) fail();
    blankIndexes = blank;
    echoIndexes = echo;
    words = buildWords(prompt, queries);
  }

  return {
    version:queryDerivationVersion,
    wordsVersion:queryWordsVersion,
    matcher:method,
    queryState,
    rawQueryCount,
    blankIndexes,
    echoIndexes,
    queries,
    words,
    answerState:ans.state,
    answerMentions,
    websiteContentCoverage:{state:'unavailable', reason:'body_corpus_not_recorded'},
  };
}
