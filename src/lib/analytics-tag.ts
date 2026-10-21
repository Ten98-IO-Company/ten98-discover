/** Adapted from Umami 3.4.0's FIELD_LENGTH.tag (50). Tags are free-form labels, so Discover adds an anti-identifier check. */
export const analyticsTagMaxLength=50;
/** At most this many distinct tag values per project in its retained events; later values are stored as no tag. */
export const analyticsTagLimit=100;

const allowed=/^[A-Za-z0-9 _.:/-]+$/;
const uuid=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const longHex=/[0-9a-f]{16,}/i;
const digitRun=/\d{8,}/;
const separators=/[ _.:/-]/g;
const separatedDigits=/\d{10,}/;

/**
 * Normalized tag label, or null when the value is not a label. A rejected tag never rejects the event: the caller drops the tag.
 * Rules, in order: string; trimmed, 1-50 characters; only A-Z a-z 0-9 space _ . : / -; no "@"; no UUID, no 16+ hex run, no
 * 8+ consecutive digits and no 10+ digits once separators are removed (phone- and account-number-like). Anything with a query
 * string or fragment (? # = &) fails the character set. A date such as 2026-10-21 (8 digits split by separators) stays valid.
 */
export function analyticsTag(value:unknown):string|null{
 if(typeof value!=='string')return null;
 const tag=value.trim();
 if(tag.length<1||tag.length>analyticsTagMaxLength||!allowed.test(tag)||tag.includes('@'))return null;
 if(uuid.test(tag)||longHex.test(tag)||digitRun.test(tag)||separatedDigits.test(tag.replace(separators,'')))return null;
 return tag;
}
