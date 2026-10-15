import type {NormalizedProperties} from '../server/analytics-input.ts';

export const revenueVersion='native-revenue-event-v1' as const;
export const revenuePropertyNames=['ten98_revenue_version','ten98_revenue_kind','ten98_revenue_amount','ten98_revenue_currency'] as const;
// Pinned from Node24.19.0 / ICU78.3 Intl.supportedValuesOf('currency').
// Browser/server runtime upgrades cannot silently change the accepted catalog.
export const revenueCurrencyCatalogVersion='node24.19.0-icu78.3-currency-v1' as const;
export const revenueCurrencies=Object.freeze('AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XDR XOF XPF XSU YER ZAR ZMW ZWG ZWL'.split(' '));
const currencies=new Set(revenueCurrencies),reserved=new Set<string>(revenuePropertyNames);
const invalid=():never=>{throw new TypeError('Invalid native revenue event.');};

/** Called only after the existing generic property normalizer; ordinary properties stay unchanged. */
export function normalizeRevenueProperties(eventName:string,properties:NormalizedProperties):NormalizedProperties{
 const declared=Object.keys(properties).filter(key=>key.startsWith('ten98_revenue_'));
 if(!declared.length)return properties;
 if(eventName==='page_view'||declared.length!==revenuePropertyNames.length||declared.some(key=>!reserved.has(key)))return invalid();
 const values=revenuePropertyNames.map(key=>{const property=properties[key];return property?.type==='string'?property.value:invalid();});
 const[version,kind,amount,currency]=values;
 if(version!=='1'||!['sale','refund'].includes(kind)||!/^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,4})?$(?![\s\S])/.test(amount)||!/^[A-Z]{3}$(?![\s\S])/.test(currency)||currency==='XXX'||currency==='XTS'||!currencies.has(currency))return invalid();
 const[whole,fraction='']=amount.split('.'),fixed=whole+'.'+fraction.padEnd(4,'0');
 if(BigInt(whole+fraction.padEnd(4,'0'))===0n)return invalid();
 return{...properties,ten98_revenue_amount:{type:'string',value:fixed}};
}

// Report arithmetic never passes a monetary value through Number.
export const revenueReportVersion='native-revenue-report-v1' as const;
export const revenueReportLimits={responseBytes:2*1024*1024,queryCharacters:65536,pageSize:100} as const;
export function revenueUnits(value:string):bigint{
 if(!/^-?(?:0|[1-9][0-9]{0,39})\.[0-9]{4}$(?![\s\S])/.test(value)||value==='-0.0000')throw new TypeError('Invalid exact revenue amount.');
 return BigInt(value.replace('.',''));
}
export function revenueDecimal(value:bigint):string{
 const negative=value<0n,raw=(negative?-value:value).toString().padStart(5,'0');
 const result=(negative?'-':'')+raw.slice(0,-4)+'.'+raw.slice(-4);revenueUnits(result);return result;
}
export function revenueAverage(amount:string,denominator:number):string|null{
 if(!Number.isSafeInteger(denominator)||denominator<0)throw new TypeError('Invalid revenue denominator.');if(!denominator)return null;
 const units=revenueUnits(amount),n=BigInt(denominator),absolute=units<0n?-units:units;
 return revenueDecimal((units<0n?-1n:1n)*(absolute/n+(absolute%n*2n>=n?1n:0n)));
}
export const revenueChannels=['tagged_paid','tagged_email','tagged_sms','tagged_affiliate','tagged_social','tagged_referral','tagged_organic','tagged_video','tagged_shopping','other_tagged','referrer_only','not_recorded'] as const;
export function revenueChannel(medium:string|null,source:string|null,referrer:string|null):typeof revenueChannels[number]{
 const token=medium?.toLowerCase();
 for(const[channel,tokens]of revenueChannelRules)if(token!==undefined&&(tokens as readonly string[]).includes(token))return channel;
 return medium||source?'other_tagged':referrer?'referrer_only':'not_recorded';
}
export const revenueChannelRules=[
  ['tagged_paid',['cpc','ppc','paid','paid_social','paid-social','paid_search','paid-search','retargeting','cpm']],['tagged_email',['email','e-mail','e_mail','e mail']],['tagged_sms',['sms']],['tagged_affiliate',['affiliate']],['tagged_social',['social','social-network','social-media','sm','social network','social media']],['tagged_referral',['referral','app','link']],['tagged_organic',['organic']],['tagged_video',['video']],['tagged_shopping',['shopping']],
 ] as const;
export type RevenueTotals={sales:string;refunds:string;net:string;saleObservations:number;refundObservations:number};
export type RevenueDimensionRow={key:string|import('./analytics-geography.ts').GeographyKey|null;totals:RevenueTotals;saleShare:string|null};
export type RevenueBreakdown={rows:RevenueDimensionRow[];totalGroups:number;limit:number;truncated:boolean;displayed:RevenueTotals;omitted:RevenueTotals};
export type RevenueSource={referrer:string|null;campaignSource:string|null;campaignMedium:string|null;browser:string|null;os:string|null;device:string|null;geography:import('./analytics-geography.ts').GeographyObservation|null;channel:typeof revenueChannels[number]};
export type RevenueSessionRow={visitorKey:string;firstRevenueAt:string;lastRevenueAt:string;totals:RevenueTotals;source:RevenueSource};
export type RevenueActivity={id:string;receivedAt:string;eventName:string;path:string;kind:'sale'|'refund';amount:string;collectionBasis:'consent'|'cookieless'|null};
export type RevenueResult={version:typeof revenueReportVersion;currencyCatalogVersion:typeof revenueCurrencyCatalogVersion;projectId:string;route:'report'|'sessions'|'detail';asOf:string;eventBefore:string;
 range:{from:string;to:string;timeZone:string;start:string;end:string};calendar:{provisional:boolean};query:Omit<ReturnType<typeof import('../server/explorer-input.ts').explorerQuery>,'groupBy'|'groupProperty'>&{currency:string};
 method:{qualification:'matching-native-key-or-direct-unkeyed';dimension:'first-retained-observation-in-window';identityUnit:'rotating-native-visitor-key';historyComplete:false;captureCoverage:'unknown';channel:'recorded-channel-tags-v1';paidVerification:'unavailable'};
 coverage:ReturnType<typeof import('../server/retention.ts').retentionCoverage>;selection:{status:'available'|'unavailable';reason:string|null;evidenceIncomplete:boolean};
 identity:{status:'complete'|'partial'|'unavailable';qualifiedKeys:number|null;revenueKeys:number|null;unkeyedQualificationEvents:number|null};
 measurement:{qualifyingEvents:number|null;invalidDeclaredObservations:number|null;orderingTieKeys:number|null;keyed:RevenueTotals|null;unkeyed:RevenueTotals|null;collection:{consent:number|null;cookieless:number|null;unknown:number|null}};
 money:({currency:string;scale:4;averageSale:string|null;keyedNetPerQualifiedKey:string|null}&RevenueTotals)|null;
 daily:{date:string;state:'complete'|'partial'|'unavailable'|'skipped'|'future';totals:RevenueTotals|null}[]|null;
 series:{eventName:string|null;other:boolean;daily:(RevenueTotals|null)[]}[]|null;seriesGroups:number|null;
 dimensions:{referrers:RevenueBreakdown;channels:RevenueBreakdown;countries:RevenueBreakdown;regions:RevenueBreakdown}|null;
 dimensionGeographyProvenance:{source:'db-ip-city-lite';scope:'selected-first-dimension-observations-for-revenue-bearing-keys';databaseCount:number|null;oldestDatabaseBuild:number|null;newestDatabaseBuild:number|null};
 sessions:{search:string;totalRevenueKeys:number|null;matchingSearchKeys:number|null;rows:RevenueSessionRow[]|null};
 detail:{visitorKey:string;summary:RevenueTotals|null;activity:RevenueActivity[]|null}|null;
 paging:{consistency:'current-per-page';limit:number;nextCursor:string|null};retention:{policyHash:string;evidenceHash:string};
 cohort?:import('../server/analytics-population.ts').CohortReport;sessionProperties?:import('../server/analytics-population.ts').SessionPropertyScope;predicateMethod?:ReturnType<typeof import('../server/advanced-predicates.ts').advancedPredicateMethod>};
