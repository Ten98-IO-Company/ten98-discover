import {z} from 'zod';
import {shareToken} from './boards.ts';
import {environmentCatalog} from './analytics-environment.ts';
import {geographyName,serializeGeographyKey,type GeoField,type GeographyKey,type GeoCountryKey} from './analytics-geography.ts';
import type {AnalyticsReport} from './analytics-comparison.ts';

// Website (project analytics) public share contract; docs/website-shares.md. Pure: server, browser and offline tests import it.
export const websiteShareSections=['overview','events','locations'] as const;
export type WebsiteShareSection=typeof websiteShareSections[number];
export const websiteShareLimits=Object.freeze({bodyBytes:4096,readBodyBytes:1024,responseBytes:2097152,pageSize:20,refreshMs:300000,minLifetimeMs:3600000,maxLifetimeMs:365*86400000});
const uuid=z.uuid().transform(value=>value.toLowerCase());
const clean=(value:string)=>!/[\u0000\uD800-\uDFFF]/u.test(value);
const text=(max:number,min=0)=>z.string().min(min).max(max).refine(clean);
const sections=z.array(z.enum(websiteShareSections)).min(1).max(3).refine(values=>new Set(values).size===values.length).transform(values=>[...values].sort());
export const websiteShareCreate=z.object({requestId:uuid,label:z.string().trim().min(1).max(120).refine(clean),sections,expiresAt:z.iso.datetime({precision:3}),token:shareToken}).strict();
export const websiteShareRevoke=z.object({requestId:uuid}).strict();
export const websiteShareRead=z.object({from:z.iso.date(),to:z.iso.date()}).strict();
export type WebsiteShareCreate=z.infer<typeof websiteShareCreate>;

const stamp=z.iso.datetime();
export const websiteShareItemSchema=z.object({id:z.uuid(),label:text(120,1),sections:z.array(z.enum(websiteShareSections)).min(1).max(3),createdAt:stamp,expiresAt:stamp,revokedAt:stamp.nullable(),state:z.enum(['active','expired','revoked']),
 creator:z.object({name:z.string(),email:z.string(),member:z.boolean()}).strict().nullable()}).strict();
export const websiteShareListSchema=z.object({projectId:z.uuid(),role:z.enum(['owner','admin']),items:z.array(websiteShareItemSchema).max(websiteShareLimits.pageSize),nextCursor:z.string().max(512).nullable()}).strict();
export const websiteShareWriteSchema=z.object({projectId:z.uuid(),ack:z.object({requestId:z.uuid(),operation:z.enum(['create','revoke']),shareId:z.uuid()}).strict(),item:websiteShareItemSchema.nullable(),replayed:z.boolean()}).strict();
export type WebsiteShareItem=z.infer<typeof websiteShareItemSchema>;
export type WebsiteShareList=z.infer<typeof websiteShareListSchema>;
export type WebsiteShareWrite=z.infer<typeof websiteShareWriteSchema>;

// Closed recipient DTO: display fields only, each section present exactly when granted. Never a passthrough private report.
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),nullable=count.nullable(),state=z.enum(['complete','partial','unavailable']);
const geo=<K extends GeographyKey>(field:GeoField)=>z.custom<K>(value=>serializeGeographyKey(field,value)!==null);
const environment=(field:keyof typeof environmentCatalog)=>z.array(z.object({value:z.enum(environmentCatalog[field]).nullable(),pageViews:count,visitors:nullable}).strict()).max(environmentCatalog[field].length+1);
const place=(field:'region'|'city')=>z.array(z.object({key:geo(field),regionName:z.string().refine(value=>geographyName(value)===value).nullable(),pageViews:count,visitors:nullable}).strict()).max(100);
export const publicWebsiteShareSchema=z.object({version:z.literal('public-website-share-v1'),shareId:z.uuid(),label:text(120,1),sections:z.array(z.enum(websiteShareSections)).min(1).max(3),expiresAt:stamp,
 range:z.object({from:z.iso.date(),to:z.iso.date(),timeZone:z.literal('UTC')}).strict(),coverage:z.object({status:state,retainedFrom:stamp.nullable()}).strict(),
 overview:z.object({pageViews:nullable,visitors:nullable,visits:nullable,bounceRate:z.number().min(0).max(100).nullable(),averageVisitSeconds:z.number().finite().nonnegative().nullable(),
  daily:z.array(z.object({date:z.iso.date(),pageViews:nullable,coverage:state}).strict()).max(366),pages:z.array(z.object({path:text(2048),pageViews:count}).strict()).max(20),
  referrers:z.array(z.object({host:text(2048,1),pageViews:count,visitors:nullable}).strict()).max(20),browsers:environment('browser'),operatingSystems:environment('os'),devices:environment('device'),
  countries:z.array(z.object({key:geo<GeoCountryKey>('country'),pageViews:count,visitors:nullable}).strict()).max(678)}).strict().optional(),
 events:z.object({customEvents:nullable,daily:z.array(z.object({date:z.iso.date(),customEvents:nullable,coverage:state}).strict()).max(366),names:z.array(z.object({name:text(320,1),count}).strict()).max(20)}).strict().optional(),
 locations:z.object({regions:place('region'),cities:place('city')}).strict().optional(),
}).strict();
export type PublicWebsiteShare=z.infer<typeof publicWebsiteShareSchema>;
export type WebsiteShareGrant={id:string;label:string;sections:readonly WebsiteShareSection[];expiresAt:string};

function bounded(value:unknown){return new TextEncoder().encode(JSON.stringify(value)).length<=websiteShareLimits.responseBytes;}
function consistent(value:PublicWebsiteShare){return new Set(value.sections).size===value.sections.length&&websiteShareSections.every(section=>value.sections.includes(section)===(value[section]!==undefined));}
/** Copies only the declared display fields of the granted sections; null when the result cannot be verified. */
export function projectWebsiteShare(grant:WebsiteShareGrant,report:AnalyticsReport):PublicWebsiteShare|null{
 const has=(section:WebsiteShareSection)=>grant.sections.includes(section),geography=report.geography;
 const environment=(rows:readonly {value:string|null;pageViews:number;visitors:number|null}[])=>rows.map(row=>({value:row.value,pageViews:row.pageViews,visitors:row.visitors}));
 const places=(rows:typeof geography.regions.rows)=>rows.map(row=>({key:row.key,regionName:row.regionName,pageViews:row.pageViews,visitors:row.visitors}));
 const value={version:'public-website-share-v1',shareId:grant.id,label:grant.label,sections:[...grant.sections],expiresAt:grant.expiresAt,
  range:{from:report.range.from,to:report.range.to,timeZone:report.range.timeZone},coverage:{status:report.coverage.status,retainedFrom:report.coverage.retainedFrom},
  ...has('overview')?{overview:{pageViews:report.totals.pageViews,visitors:report.measurement.visitors,visits:report.measurement.visits,bounceRate:report.measurement.bounceRate,averageVisitSeconds:report.measurement.averageVisitSeconds,
   daily:report.daily.map(day=>({date:day.date,pageViews:day.pageViews,coverage:day.coverage})),pages:report.pages.map(row=>({path:row.path,pageViews:row.pageViews})),
   referrers:report.referrers.map(row=>({host:row.host,pageViews:row.pageViews,visitors:row.visitors})),browsers:environment(report.environment.browsers),operatingSystems:environment(report.environment.operatingSystems),devices:environment(report.environment.devices),
   countries:geography.countries.rows.map(row=>({key:row.key,pageViews:row.pageViews,visitors:row.visitors}))}}:{},
  ...has('events')?{events:{customEvents:report.totals.customEvents,daily:report.daily.map(day=>({date:day.date,customEvents:day.customEvents,coverage:day.coverage})),names:report.events.map(row=>({name:row.name,count:row.count}))}}:{},
  ...has('locations')?{locations:{regions:places(geography.regions.rows),cities:places(geography.cities.rows)}}:{}};
 const parsed=publicWebsiteShareSchema.safeParse(value);
 return parsed.success&&consistent(parsed.data)&&bounded(parsed.data)?parsed.data:null;
}
/** Recipient decoder: refuses undeclared keys, section mismatches, a foreign share, another range, expiry and oversize payloads. */
export function decodePublicWebsiteShare(raw:unknown,shareId:string,range:{from:string;to:string},now=Date.now()):PublicWebsiteShare|null{
 try{
  if(!bounded(raw))return null;const parsed=publicWebsiteShareSchema.safeParse(raw);if(!parsed.success)return null;const value=parsed.data;
  if(value.shareId!==shareId||value.range.from!==range.from||value.range.to!==range.to||Date.parse(value.expiresAt)<=now||!consistent(value))return null;
  return value;
 }catch{return null;}
}
