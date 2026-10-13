import { toUSVString } from "node:util";

export type MetaCampaign = {
  id: string;
  accountId: string;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
};

export class MetaCampaignRowsError extends Error {}

const MESSAGE = "Meta returned an unsupported campaign inventory.";
const ID_PATTERN = /^[1-9][0-9]{0,39}$/;
const STATUS_PATTERN = /^[A-Z_]{1,64}$/;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
const hasOwn = Object.prototype.hasOwnProperty;

function invalid(): never {
  throw new MetaCampaignRowsError(MESSAGE);
}

export function normalizeMetaCampaigns(value: unknown, accountId: string): MetaCampaign[] {
  if (typeof accountId !== "string" || !ID_PATTERN.test(accountId)) invalid();
  if (!Array.isArray(value) || value.length > 100) invalid();

  const seen = new Set<string>();
  const campaigns: MetaCampaign[] = [];
  for (const record of value) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) invalid();
    const source = record as Record<string, unknown>;

    const id = hasOwn.call(source, "id") ? source.id : undefined;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) invalid();
    if (!hasOwn.call(source, "account_id") || source.account_id !== accountId) invalid();
    if (seen.has(id)) invalid();
    seen.add(id);

    campaigns.push({
      id,
      accountId,
      name: readName(source),
      status: readStatus(source, "status"),
      effectiveStatus: readStatus(source, "effective_status"),
    });
  }
  return campaigns;
}

function readName(source: Record<string, unknown>): string | null {
  if (!hasOwn.call(source, "name")) return null;
  const name = source.name;
  if (name === undefined || name === null) return null;
  if (typeof name !== "string" || name.length > 512 || CONTROL_PATTERN.test(name) || toUSVString(name) !== name) invalid();
  return name;
}

function readStatus(source: Record<string, unknown>, key: "status" | "effective_status"): string | null {
  if (!hasOwn.call(source, key)) return null;
  const status = source[key];
  if (status === undefined || status === null) return null;
  if (typeof status !== "string" || !STATUS_PATTERN.test(status)) invalid();
  return status;
}
