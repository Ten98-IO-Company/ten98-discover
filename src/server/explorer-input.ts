import { toUSVString } from 'node:util';
import { normalizeProperties } from './analytics-input.ts';
import { analyticsRange } from './analytics.ts';
import { InputError } from './validation.ts';

export const explorerGroups = ['event','path','referrer','language','campaignSource','campaignMedium','campaignName','campaignTerm','campaignContent','screenWidth','screenHeight','property'] as const;
export const explorerFilters = ['eventName','path','referrer','language','campaignSource','campaignMedium','campaignName','campaignTerm','campaignContent'] as const;
const parameterNames = new Set(['from','to','timeZone','kind','groupBy','groupProperty','propertyKey','propertyType','propertyValue',...explorerFilters]);
function bad(message = 'Check the exploration filters and try again.'): never { throw new InputError(400, message); }
function text(value: string, maximum: number, empty = false) {
  if ((!empty && !value.length) || value.length > maximum || toUSVString(value) !== value || value.includes('\0')) bad();
  return value;
}

export function explorerQuery(params: URLSearchParams, now = new Date()) {
  if (params.toString().length > 20000) bad('The exploration query is too large.');
  for (const key of params.keys()) if (!parameterNames.has(key) || params.getAll(key).length !== 1) bad('Use each supported filter only once.');
  const zone = params.get('timeZone') ?? 'UTC';
  if (zone.length > 80 || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(zone)) bad('Choose a named IANA timezone, such as Asia/Dubai.');
  let timeZone: string, today: string;
  try {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    timeZone = format.resolvedOptions().timeZone;
    const parts = Object.fromEntries(format.formatToParts(now).map(part => [part.type,part.value]));
    today = `${parts.year}-${parts.month}-${parts.day}`;
  } catch { return bad('Choose a supported IANA timezone.'); }
  const dates = new URLSearchParams();
  for (const key of ['from','to']) if (params.has(key)) dates.set(key, params.get(key)!);
  const range = analyticsRange(dates, new Date(`${today}T12:00:00Z`));
  const kind = params.get('kind') ?? 'all', groupBy = params.get('groupBy') ?? 'event';
  if (!['all','pageviews','custom'].includes(kind) || !explorerGroups.includes(groupBy as typeof explorerGroups[number])) bad();
  if (params.has('groupProperty') !== (groupBy === 'property')) bad('Choose a property key only when grouping by a property.');
  const groupProperty = groupBy === 'property' ? text(params.get('groupProperty')!,320) : null;
  const filters: Record<string,string> = {};
  for (const key of explorerFilters) if (params.has(key)) filters[key] = text(params.get(key)!,key === 'path' ? 2048 : 320,true);
  let property: {key:string;type:string;value:unknown} | null = null;
  if (['propertyKey','propertyType','propertyValue'].some(key => params.has(key))) {
    const key = text(params.get('propertyKey') ?? '',320), type = params.get('propertyType');
    if (!type || !['missing','string','number','boolean','null','date','array'].includes(type)) bad('Choose a property filter type.');
    if (type === 'missing') {
      if (params.has('propertyValue')) bad('A missing-property filter has no value.');
      property = {key,type,value:null};
    } else {
      if (!params.has('propertyValue')) bad('Enter a JSON value for the property filter.');
      let raw: unknown;
      try { raw = JSON.parse(text(params.get('propertyValue')!,8192)); }
      catch { return bad('Enter a valid JSON value for the property filter.'); }
      const normalized = normalizeProperties({value:raw}).value;
      if (normalized?.type !== type && !(type === 'string' && typeof raw === 'string')) bad('The property value does not match its selected type.');
      property = {key,type,value:type === 'string' ? raw : normalized.value};
    }
  }
  return {from:range.from,to:range.to,timeZone,kind,groupBy,groupProperty,filters,property};
}

// Quoting alone does not stop spreadsheets from executing a leading formula.
export function csvCell(value: unknown): string {
  let cell = value === null || value === undefined ? 'Unavailable' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[\s\uFEFF]*[=+@-]/u.test(cell) || /^[\t\r\n]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"','""')}"`;
}
