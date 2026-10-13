import { toUSVString, types } from 'node:util';
import { InputError } from './validation.ts';
import { normalizeProperties } from './analytics-input.ts';

export type Match = { type: 'path' | 'event'; match: 'exact' | 'prefix' | 'suffix' | 'contains'; value: string };
export type PropertyPredicate =
  | { key: string; operator: 'missing' }
  | { key: string; operator: 'eq' | 'neq'; type: 'string' | 'number' | 'boolean' | 'null' | 'date' | 'array'; value: unknown }
  | { key: string; operator: 'contains' | 'not_contains'; type: 'string'; value: string };
export type AnalysisStep = Match & { pageViewsOnly: boolean; properties: PropertyPredicate[] };
export type AnalysisDefinition =
  | { kind: 'funnel'; name: string; description: string; windowMinutes: number; steps: AnalysisStep[] }
  | { kind: 'goal'; name: string; description: string; condition: Match };

function bad(): never {
  throw new InputError(400, 'Check the funnel or goal definition and try again.');
}

function cleanString(v: unknown): string {
  if (typeof v !== 'string' || v.includes('\0') || toUSVString(v) !== v) bad();
  return v;
}

// Copies own enumerable data fields via descriptors; never invokes accessors, getters or hooks.
function asPlainObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || types.isProxy(v)) bad();
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) bad();
  const keys = Object.keys(v);
  if (Object.getOwnPropertyNames(v).length !== keys.length || Object.getOwnPropertySymbols(v).length !== 0) bad();
  const out: Record<string, unknown> = Object.create(null);
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    if (!d || !('value' in d)) bad();
    out[k] = d.value;
  }
  return out;
}

// Dense ordinary arrays only: no holes, accessors, extra or non-enumerable keys, subclasses or proxies.
function asArray(v: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(v) || types.isProxy(v)) bad();
  if (Object.getPrototypeOf(v) !== Array.prototype) bad();
  const n = v.length;
  if (Object.keys(v).length !== n) bad();
  if (Object.getOwnPropertyNames(v).length !== n + 1 || Object.getOwnPropertySymbols(v).length !== 0) bad();
  if (n < min || n > max) bad();
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i))!;
    if (!d || !('value' in d)) bad();
    out.push(d.value);
  }
  return out;
}

function onlyKeys(rec: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(rec)) if (!allowed.includes(k)) bad();
}

function parseNameDesc(rec: Record<string, unknown>): { name: string; description: string } {
  const name = cleanString(rec.name).trim();
  if (name.length === 0 || name.length > 200) bad();
  let description = '';
  if ('description' in rec) {
    description = cleanString(rec.description).trim();
    if (description.length > 500) bad();
  }
  return { name, description };
}

// Literal match criteria: never trimmed, case-folded, URL-normalized or wildcard-converted.
function parseMatchFields(rec: Record<string, unknown>): Match {
  const type = cleanString(rec.type) as Match['type'];
  if (type !== 'path' && type !== 'event') bad();
  const match = cleanString(rec.match) as Match['match'];
  if (match !== 'exact' && match !== 'prefix' && match !== 'suffix' && match !== 'contains') bad();
  const value = cleanString(rec.value);
  if (value.length === 0) bad();
  if (type === 'path') {
    if (value.length > 2048 || value.includes('?') || value.includes('#')) bad();
    if ((match === 'exact' || match === 'prefix') && !value.startsWith('/')) bad();
  } else if (value.length > 64) bad();
  return { type, match, value };
}

const VALUE_TYPES = ['string', 'number', 'boolean', 'null', 'date', 'array'] as const;
type PredicateType = (typeof VALUE_TYPES)[number];

// Delegates all scalar/array limits, Unicode, depth and typing rules to the existing normalizer.
function normalizedLeaf(value: unknown): { type: string; value: unknown } {
  let leaf: { type: string; value: unknown } | undefined;
  try {
    leaf = normalizeProperties({ value }).value as { type: string; value: unknown } | undefined;
  } catch {
    bad();
  }
  if (leaf === undefined || leaf === null || typeof leaf !== 'object') bad();
  return leaf;
}

function parsePredicate(v: unknown): PropertyPredicate {
  const rec = asPlainObject(v);
  const key = cleanString(rec.key);
  if (key.length === 0 || key.length > 320) bad();
  const operator = cleanString(rec.operator) as PropertyPredicate['operator'];
  if (operator === 'missing') {
    onlyKeys(rec, ['key', 'operator']);
    return { key, operator };
  }
  if (operator !== 'eq' && operator !== 'neq' && operator !== 'contains' && operator !== 'not_contains') bad();
  onlyKeys(rec, ['key', 'operator', 'type', 'value']);
  if (!('value' in rec)) bad();
  const declared = cleanString(rec.type) as PredicateType;
  if (!(VALUE_TYPES as readonly string[]).includes(declared)) bad();
  const raw = rec.value;
  const leaf = normalizedLeaf(raw);
  if (operator === 'contains' || operator === 'not_contains') {
    if (declared !== 'string' || typeof raw !== 'string') bad();
    return { key, operator, type: 'string', value: raw };
  }
  // Explicitly declared strings stay literal text even when the normalizer sees a date.
  if (declared === 'string' && typeof raw === 'string') return { key, operator, type: 'string', value: raw };
  if (leaf.type !== declared) bad();
  return { key, operator, type: declared, value: Array.isArray(leaf.value) ? leaf.value.slice() : leaf.value };
}

function parseStep(v: unknown): AnalysisStep {
  const rec = asPlainObject(v);
  onlyKeys(rec, ['type', 'match', 'value', 'pageViewsOnly', 'properties']);
  const base = parseMatchFields(rec);
  const pvo = rec.pageViewsOnly;
  if ('pageViewsOnly' in rec && typeof pvo !== 'boolean') bad();
  const pageViewsOnly = pvo === true;
  if (pageViewsOnly && base.type !== 'path') bad();
  const props = 'properties' in rec ? asArray(rec.properties, 0, 10) : [];
  if (base.type === 'path' && props.length > 0) bad();
  return { ...base, pageViewsOnly, properties: props.map(parsePredicate) };
}

export function parseAnalysisDefinition(raw: unknown): AnalysisDefinition {
  const rec = asPlainObject(raw);
  const kind = cleanString(rec.kind) as AnalysisDefinition['kind'];
  const { name, description } = parseNameDesc(rec);
  if (kind === 'goal') {
    onlyKeys(rec, ['kind', 'name', 'description', 'condition']);
    const cond = asPlainObject(rec.condition);
    onlyKeys(cond, ['type', 'match', 'value']);
    return { kind, name, description, condition: parseMatchFields(cond) };
  }
  if (kind !== 'funnel') bad();
  onlyKeys(rec, ['kind', 'name', 'description', 'windowMinutes', 'steps']);
  const windowMinutes = rec.windowMinutes;
  if (typeof windowMinutes !== 'number' || !Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) bad();
  return { kind, name, description, windowMinutes, steps: asArray(rec.steps, 2, 8).map(parseStep) };
}
