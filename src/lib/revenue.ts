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
