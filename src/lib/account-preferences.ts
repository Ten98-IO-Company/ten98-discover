import { z } from 'zod';

// Umami3.4.0 locale IDs/names/directions: ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/lib/lang.ts.
// Existing THIRD_PARTY_NOTICES retains its MIT notice. This inventory does not claim translated screens.
export const accountLocaleInventory = [
  ['ka-GE','ქართული','ltr'], ['ar-SA','العربية','rtl'], ['az-AZ','Azərbaycan','ltr'],
  ['be-BY','Беларуская','ltr'], ['bg-BG','български език','ltr'], ['bn-BD','বাংলা','ltr'],
  ['bs-BA','Bosanski','ltr'], ['ca-ES','Català','ltr'], ['cs-CZ','Čeština','ltr'],
  ['da-DK','Dansk','ltr'], ['de-CH','Schwiizerdütsch','ltr'], ['de-DE','Deutsch','ltr'],
  ['el-GR','Ελληνικά','ltr'], ['en-GB','English (UK)','ltr'], ['en-US','English (US)','ltr'],
  ['es-ES','Español','ltr'], ['fa-IR','فارسی','rtl'], ['fi-FI','Suomi','ltr'],
  ['fo-FO','Føroyskt','ltr'], ['fr-FR','Français','ltr'], ['ga-ES','Galician (Spain)','ltr'],
  ['he-IL','עברית','rtl'], ['hi-IN','हिन्दी','ltr'], ['hr-HR','Hrvatski','ltr'],
  ['hu-HU','Hungarian','ltr'], ['id-ID','Bahasa Indonesia','ltr'], ['it-IT','Italiano','ltr'],
  ['ja-JP','日本語','ltr'], ['km-KH','ភាសាខ្មែរ','ltr'], ['ko-KR','한국어','ltr'],
  ['lt-LT','Lietuvių','ltr'], ['mn-MN','Монгол','ltr'], ['ms-MY','Malay','ltr'],
  ['my-MM','မြန်မာဘာသာ','ltr'], ['nl-NL','Nederlands','ltr'], ['nb-NO','Norsk Bokmål','ltr'],
  ['pl-PL','Polski','ltr'], ['pt-BR','Português do Brasil','ltr'], ['pt-PT','Português','ltr'],
  ['ro-RO','Română','ltr'], ['ru-RU','Русский','ltr'], ['si-LK','සිංහල','ltr'],
  ['sk-SK','Slovenčina','ltr'], ['sl-SI','Slovenščina','ltr'], ['sv-SE','Svenska','ltr'],
  ['ta-IN','தமிழ்','ltr'], ['th-TH','ภาษาไทย','ltr'], ['tr-TR','Türkçe','ltr'],
  ['uk-UA','українська','ltr'], ['ur-PK','Urdu (Pakistan)','rtl'], ['uz-UZ','O‘zbekcha','ltr'],
  ['vi-VN','Tiếng Việt','ltr'], ['zh-CN','中文','ltr'], ['zh-TW','中文(繁體)','ltr'],
] as const;
export const accountLocales = accountLocaleInventory.map(([code])=>code);
export type AccountLocale = typeof accountLocales[number];
export const accountThemes = ['light','dark','system'] as const;
export const accountPreferencesDefaults = Object.freeze({ timeZone:'UTC', locale:'en-US' as AccountLocale, theme:'light' as typeof accountThemes[number] });
export const accountPreferencesMaxRevision = 2147483647;

export function accountLocaleMapping(locale:AccountLocale) {
  const [code,label,direction]=accountLocaleInventory.find(([code])=>code===locale)!;
  // Upstream's ga-ES entry is Galician. Retain its baseline ID; format with the correct language tag.
  return {code,label,direction,formatLocale:code==='ga-ES'?'gl-ES':code};
}

const clean=(value:string)=>!/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value);
export function canonicalAccountTimeZone(value:string):string|null {
  if(value.length>80||!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value))return null;
  try { return new Intl.DateTimeFormat('en-US',{timeZone:value}).resolvedOptions().timeZone; } catch { return null; }
}
const name=z.string().trim().min(1).max(120).refine(clean);
const timeZone=z.string().min(1).max(80).transform((value,context)=>{
  const zone=canonicalAccountTimeZone(value);if(zone!==null)return zone;
  context.addIssue({code:'custom',message:'Choose a recognized named time zone.'});return z.NEVER;
});
export const accountPreferencesInputSchema=z.object({
  expectedRevision:z.number().int().min(0).max(accountPreferencesMaxRevision),name,timeZone,
  locale:z.enum(accountLocales),theme:z.enum(accountThemes),
}).strict();
export type AccountPreferencesInput=z.output<typeof accountPreferencesInputSchema>;
export const accountPreferencesDtoSchema=z.object({
  version:z.literal('account-preferences-v1'),
  user:z.object({id:z.string().min(1).max(128).refine(clean),name,email:z.email().max(254)}).strict(),
  preferences:z.object({
    revision:z.number().int().min(0).max(accountPreferencesMaxRevision),
    timeZone:z.string().min(1).max(80).refine(value=>canonicalAccountTimeZone(value)!==null),
    locale:z.enum(accountLocales),theme:z.enum(accountThemes),updatedAt:z.iso.datetime().nullable(),
  }).strict(),
}).strict().refine(value=>(value.preferences.revision===0)===(value.preferences.updatedAt===null));
export type AccountPreferencesDto=z.output<typeof accountPreferencesDtoSchema>;

// Server/storage validation stays strict above. A client can have different IANA data;
// preserve the server's bounded identifier and check local formatting separately.
export const accountPreferencesWireDtoSchema=accountPreferencesDtoSchema.safeExtend({
  preferences:accountPreferencesDtoSchema.shape.preferences.safeExtend({
    timeZone:z.string().min(1).max(80).refine(clean).regex(/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/),
  }),
});

// Client input preserves named identifiers; the server still recognizes and canonicalizes explicit saves.
export const accountPreferencesWireInputSchema=accountPreferencesInputSchema.safeExtend({
  timeZone:accountPreferencesWireDtoSchema.shape.preferences.shape.timeZone,
});
