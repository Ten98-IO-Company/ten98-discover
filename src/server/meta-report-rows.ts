// Pure normalizer for one decoded Meta Insights `data` page. No I/O, clock,
// randomness or shared state; every rejection throws the same redacted Error.
import {toUSVString} from 'node:util';

export type MetaReportKind = 'account_daily' | 'campaign_daily';

export type MetaReportScope = {
  report: MetaReportKind;
  accountId: string;
  currency: string;
  from: string;
  to: string;
};

export type MetaAction = {
  type: string;
  value: string | null;
  windows: Record<string, string | null>;
};

export type MetaDailyRow = {
  date: string;
  accountId: string;
  campaignId: string | null;
  campaignName: string | null;
  impressions: string | null;
  clicks: string | null;
  spend: string | null;
  actions: MetaAction[] | null;
  actionValues: MetaAction[] | null;
};

const MSG = 'Meta returned an invalid report page.';

function fail(): never {
  throw new Error(MSG);
}

const ID = /^[1-9]\d{0,39}$/; // positive canonical decimal, 1-40 digits
const CURRENCY = /^[A-Z]{3}$/;
const INT = /^(0|[1-9]\d{0,29})$/; // nonnegative canonical integer, <= 30 digits
const DECIMAL = /^(0|[1-9]\d{0,29})(\.\d{1,18})?$/; // nonnegative ordinary decimal
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL = /[\u0000-\u001F\u007F]/;
const DAY_MS = 86400000;

const SCOPE_KEYS = new Set(['report', 'accountId', 'currency', 'from', 'to']);
const ROW_KEYS = new Set([
  'account_id',
  'account_currency',
  'account_name',
  'date_start',
  'date_stop',
  'campaign_id',
  'campaign_name',
  'impressions',
  'clicks',
  'spend',
  'actions',
  'action_values',
]);
const WINDOWS = ['1d_click', '7d_click', '28d_click', '1d_view', '7d_view', '28d_view'] as const;
const ACTION_KEYS = new Set<string>(['action_type', 'value', ...WINDOWS]);

// Epoch ms for an exact YYYY-MM-DD Gregorian date with year 0001-9999, else null.
// setUTCFullYear avoids the Date.UTC year 0-99 => 1900+year trap; the UTC round
// trip rejects rolled-over dates such as 2023-02-29. No machine clock or timezone.
function dateMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = DATE.exec(value);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(year, month - 1, day);
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return dt.getTime();
}

// Nonempty, <= max UTF-16 code units, well-formed Unicode, no ASCII controls/DEL.
function isText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= max &&
    toUSVString(value) === value &&
    !CONTROL.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkKeys(rec: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) fail();
  }
}

// Optional/null canonical decimal string; an absent own key normalizes to null.
function decimalField(rec: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(rec, key)) return null;
  const v = rec[key];
  if (v === null) return null;
  if (typeof v === 'string' && DECIMAL.test(v)) return v;
  fail();
}

function normActions(value: unknown): MetaAction[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 200) fail();
  const out: MetaAction[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) fail();
    const item = value[i];
    if (!isRecord(item)) fail();
    checkKeys(item, ACTION_KEYS);
    if (!Object.hasOwn(item, 'action_type') || !isText(item.action_type, 200)) fail();
    const type = item.action_type;
    if (seen.has(type)) fail();
    seen.add(type);
    const windows: Record<string, string | null> = {};
    for (const w of WINDOWS) {
      if (!Object.hasOwn(item, w)) continue;
      const wv = item[w];
      if (wv === null) windows[w] = null;
      else if (typeof wv === 'string' && DECIMAL.test(wv)) windows[w] = wv;
      else fail();
    }
    out.push({ type, value: decimalField(item, 'value'), windows });
  }
  return out;
}

function normRow(raw: unknown, scope: MetaReportScope, fromMs: number, toMs: number): MetaDailyRow {
  if (!isRecord(raw)) fail();
  checkKeys(raw, ROW_KEYS);
  const has = (key: string): boolean => Object.hasOwn(raw, key);

  if (!has('account_id') || raw.account_id !== scope.accountId) fail();
  if (!has('account_currency') || raw.account_currency !== scope.currency) fail();

  const startMs = has('date_start') ? dateMs(raw.date_start) : null;
  const stopMs = has('date_stop') ? dateMs(raw.date_stop) : null;
  if (startMs === null || startMs !== stopMs || startMs < fromMs || startMs > toMs) fail();
  const date = raw.date_start as string;

  if (has('account_name') && raw.account_name !== null && !isText(raw.account_name, 512)) fail();

  let campaignId: string | null = null;
  let campaignName: string | null = null;
  if (scope.report === 'campaign_daily') {
    if (!has('campaign_id') || typeof raw.campaign_id !== 'string' || !ID.test(raw.campaign_id)) fail();
    campaignId = raw.campaign_id;
    if (has('campaign_name') && raw.campaign_name !== null) {
      if (!isText(raw.campaign_name, 512)) fail();
      campaignName = raw.campaign_name;
    }
  } else if (
    (has('campaign_id') && raw.campaign_id !== null) ||
    (has('campaign_name') && raw.campaign_name !== null)
  ) {
    fail();
  }

  let impressions: string | null = null;
  if (has('impressions') && raw.impressions !== null) {
    if (typeof raw.impressions !== 'string' || !INT.test(raw.impressions)) fail();
    impressions = raw.impressions;
  }
  let clicks: string | null = null;
  if (has('clicks') && raw.clicks !== null) {
    if (typeof raw.clicks !== 'string' || !INT.test(raw.clicks)) fail();
    clicks = raw.clicks;
  }

  return {
    date,
    accountId: scope.accountId,
    campaignId,
    campaignName,
    impressions,
    clicks,
    spend: decimalField(raw, 'spend'),
    actions: has('actions') ? normActions(raw.actions) : null,
    actionValues: has('action_values') ? normActions(raw.action_values) : null,
  };
}

export function normalizeMetaRows(value: unknown, scope: MetaReportScope): MetaDailyRow[] {
  if (!isRecord(scope)) fail();
  const scopeKeys = Object.keys(scope);
  if (scopeKeys.length !== SCOPE_KEYS.size) fail();
  for (const key of scopeKeys) {
    if (!SCOPE_KEYS.has(key)) fail();
  }
  if (scope.report !== 'account_daily' && scope.report !== 'campaign_daily') fail();
  if (typeof scope.accountId !== 'string' || !ID.test(scope.accountId)) fail();
  if (typeof scope.currency !== 'string' || !CURRENCY.test(scope.currency)) fail();
  const fromMs = dateMs(scope.from);
  const toMs = dateMs(scope.to);
  if (fromMs === null || toMs === null || fromMs > toMs || (toMs - fromMs) / DAY_MS >= 31) fail();

  if (!Array.isArray(value) || value.length > 500) fail();
  const out: MetaDailyRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) fail();
    const row = normRow(value[i], scope, fromMs, toMs);
    const key = row.date + '\u0000' + (row.campaignId ?? '');
    if (seen.has(key)) fail();
    seen.add(key);
    out.push(row);
  }
  return out;
}
