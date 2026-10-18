import {z} from 'zod';
// Pure in both the browser and Node; bounds count UTF-16 code units, without trimming.
const safeGoogleString=(max:number)=>z.string().max(max).refine(value=>!value.includes('\0')&&!/[\uD800-\uDFFF]/u.test(value));

/** Inspected URLs are sent only to Google's fixed API, never fetched by this server. */
function httpUrl(value:string){
  try{const url=new URL(value);return !/[\s\\#]/u.test(value)&&['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}
  catch{return false;}
}
const url=safeGoogleString(4096).min(1).refine(httpUrl,'Use an absolute HTTP or HTTPS URL without credentials or a fragment.');
export const googleInspectionInput=z.strictObject({
  urls:z.array(url.transform(value=>new URL(value).href).pipe(url)).min(1).max(10).refine(values=>new Set(values).size===values.length,'Remove duplicate URLs.'),
  languageCode:safeGoogleString(80).min(1).refine(value=>{try{return Intl.getCanonicalLocales(value).length===1;}catch{return false;}}).transform(value=>Intl.getCanonicalLocales(value)[0]).default('en-US'),
});

/** Match the saved property; a sibling host/path must never inherit its access. */
export function inspectionUrlInProperty(value:string,property:string){
  if(!httpUrl(value))return false;
  const inspected=new URL(value);
  if(property.startsWith('sc-domain:')){
    const domain=property.slice(10);
    if(!domain||/[\s\\/@:?#%]/u.test(domain))return false;
    try{const host=new URL('https://'+domain).hostname,actual=inspected.hostname;return actual===host||actual.endsWith('.'+host);}catch{return false;}
  }
  if(!httpUrl(property)||!property.endsWith('/'))return false;
  const prefix=new URL(property);
  return !prefix.search&&inspected.origin===prefix.origin&&inspected.pathname.startsWith(prefix.pathname);
}

const text=safeGoogleString(4096),state=safeGoogleString(120),verdict=state.optional();
const issue=z.object({issueMessage:text.optional(),severity:state.optional()});
const crawl={robotsTxtState:state.optional(),indexingState:state.optional(),lastCrawlTime:safeGoogleString(80).refine(value=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value.slice(0,10)).optional(),pageFetchState:state.optional()};
export const googleInspectionResponse=z.object({inspectionResult:z.object({
  inspectionResultLink:url.refine(value=>{const parsed=new URL(value);return parsed.protocol==='https:'&&parsed.hostname==='search.google.com'&&!parsed.port;}).optional(),
  indexStatusResult:z.object({...crawl,verdict,coverageState:text.optional(),googleCanonical:url.optional(),userCanonical:url.optional(),crawledAs:state.optional(),sitemap:z.array(url).max(1000).optional(),referringUrls:z.array(url).max(1000).optional()}).optional(),
  ampResult:z.object({...crawl,verdict,ampUrl:url.optional(),ampIndexStatusVerdict:state.optional(),issues:z.array(issue).max(1000).optional()}).optional(),
  mobileUsabilityResult:z.object({verdict,issues:z.array(z.object({issueType:state.optional(),severity:state.optional(),message:text.optional()})).max(1000).optional()}).optional(),
  richResultsResult:z.object({verdict,detectedItems:z.array(z.object({richResultType:text.optional(),items:z.array(z.object({name:text.optional(),issues:z.array(issue).max(1000).optional()})).max(1000).optional()})).max(1000).optional()}).optional(),
})});

export const googleInspectionBatch=z.strictObject({
  projectId:z.uuid(),connectionId:z.uuid(),revision:z.number().int().positive(),propertyId:safeGoogleString(2048).min(1),languageCode:safeGoogleString(80).min(1),
  checkedAt:z.iso.datetime(),indexedVersion:z.literal(true),
  results:z.array(z.union([
    z.strictObject({url,attempted:z.literal(true),result:googleInspectionResponse.shape.inspectionResult,error:z.null()}),
    z.strictObject({url,attempted:z.boolean(),result:z.null(),error:safeGoogleString(512).min(1)}),
  ])).min(1).max(10),
});
export type GoogleInspectionBatch=z.output<typeof googleInspectionBatch>;
