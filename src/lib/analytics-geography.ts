import {z} from 'zod';

export const geographyVersion='dbip-city-lite-v1' as const;
export const geographyFields=['country','region','city'] as const;
export type GeoField=typeof geographyFields[number];
const encoder=new TextEncoder(),country=z.string().regex(/^[A-Z]{2}$/),code=z.string().max(32).regex(/^[A-Z]{2}-[A-Z0-9-]+$/);
export function geographyName(value:unknown):string|null{
 if(typeof value!=='string'||/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value))return null;
 const text=value.trim().normalize('NFC');return text&&Array.from(text).length<=128&&encoder.encode(text).length<=512?text:null;
}
const name=z.string().refine(value=>geographyName(value)===value),epoch=z.number().int().min(1).max(253402300799);
const region=z.object({code:code.nullable(),name:name.nullable()}).strict().refine(value=>value.code!==null||value.name!==null);
export const geographyObservationSchema=z.object({version:z.literal(geographyVersion),databaseBuild:epoch,databaseSha256:z.string().regex(/^[a-f0-9]{64}$/),country:country.nullable(),region:region.nullable(),city:name.nullable()}).strict().refine(value=>value.country===null?value.region===null&&value.city===null:value.region?.code==null||value.region.code.startsWith(value.country+'-'));
export type GeographyObservation=z.infer<typeof geographyObservationSchema>;
export type GeoAbsentKey={state:'not-recorded'}|{state:'unknown'};
export type GeoRegionIdentity={kind:'code'|'name';value:string};
export type GeoCountryKey=GeoAbsentKey|{state:'known';country:string};
export type GeoRegionKey=GeoAbsentKey|{state:'known';country:string;region:GeoRegionIdentity};
export type GeoCityKey=GeoAbsentKey|{state:'known';country:string;region:GeoRegionIdentity|null;city:string};
export type GeographyKey=GeoCountryKey|GeoRegionKey|GeoCityKey;
export type GeographyFilters=Partial<Record<GeoField,string>>;
const regionIdentity=z.discriminatedUnion('kind',[z.object({kind:z.literal('code'),value:code}).strict(),z.object({kind:z.literal('name'),value:name}).strict()]);
const absent=z.discriminatedUnion('state',[z.object({state:z.literal('not-recorded')}).strict(),z.object({state:z.literal('unknown')}).strict()]);
const known={state:z.literal('known'),country},keySchemas={country:z.union([absent,z.object(known).strict()]),region:z.union([absent,z.object({...known,region:regionIdentity}).strict()]),city:z.union([absent,z.object({...known,region:regionIdentity.nullable(),city:name}).strict()])};
export function serializeGeographyKey(field:GeoField,value:unknown):string|null{
 if(!geographyFields.includes(field))return null;const schema=keySchemas[field],result=schema.safeParse(value);if(!result.success)return null;const key=result.data as GeographyKey;
 if(key.state!=='known')return JSON.stringify({state:key.state});
 if('region'in key&&key.region?.kind==='code'&&!key.region.value.startsWith(key.country+'-'))return null;
 const canonical={state:key.state,country:key.country,...'region'in key?{region:key.region===null?null:{kind:key.region.kind,value:key.region.value}}:{},...'city'in key?{city:key.city}:{}};
 const encoded=JSON.stringify(canonical);return encoder.encode(encoded).length<=2048?encoded:null;
}
export function parseGeographyKey(field:GeoField,value:unknown):GeographyKey|null{
 if(typeof value!=='string'||encoder.encode(value).length>2048)return null;let key:unknown;try{key=JSON.parse(value);}catch{return null;}return serializeGeographyKey(field,key)===value?key as GeographyKey:null;
}
export function geographyFiltersValid(filters:GeographyFilters):boolean{
 const keys:Partial<Record<GeoField,GeographyKey>>={};for(const[field,value]of Object.entries(filters)){if(!geographyFields.includes(field as GeoField))return false;const key=parseGeographyKey(field as GeoField,value);if(!key)return false;keys[field as GeoField]=key;}
 const country=keys.country,region=keys.region,city=keys.city;
 for(const child of [region,city])if(country&&child?.state==='known'&&(country.state!=='known'||child.country!==country.country))return false;
 if(region&&region.state!=='known'&&city?.state==='known'&&'city'in city&&(region.state==='not-recorded'||city.region!==null))return false;
 return !(region?.state==='known'&&'region'in region&&city?.state==='known'&&'city'in city&&(region.country!==city.country||JSON.stringify(region.region)!==JSON.stringify(city.region)));
}
export function projectGeography(value:unknown):GeographyObservation|null{const parsed=geographyObservationSchema.safeParse(value);return parsed.success?parsed.data:null;}
export function geographyKey(field:GeoField,value:GeographyObservation|null):GeographyKey{
 if(value===null)return{state:'not-recorded'};if(value.country===null)return{state:'unknown'};
 if(field==='country')return{state:'known',country:value.country};
 const identity=value.region?.code?{kind:'code' as const,value:value.region.code}:value.region?.name?{kind:'name' as const,value:value.region.name}:null;
 if(field==='region')return identity?{state:'known',country:value.country,region:identity}:{state:'unknown'};
 return value.city===null?{state:'unknown'}:{state:'known',country:value.country,region:identity,city:value.city};
}
export type GeographyRow={key:GeographyKey;regionName:string|null;pageViews:number;identifiedPageViews:number;visitors:number|null;visits:number|null;bounceRate:number|null;averageVisitSeconds:number|null};
export type GeographyBreakdown={rows:GeographyRow[];limit:100|678;totalGroups:number|null;returnedPageViews:number|null;truncated:boolean};
export type GeographyCoverage={status:'complete'|'partial'|'unavailable';pageViews:number|null;recordedPageViews:number|null;notRecordedPageViews:number|null;knownCountryPageViews:number|null;knownRegionPageViews:number|null;knownCityPageViews:number|null;firstRecordedAt:string|null};
export type GeographyProvenance={source:'db-ip-city-lite';databaseCount:number|null;oldestDatabaseBuild:number|null;newestDatabaseBuild:number|null};
export type GeographyReport={version:'native-geography-report-v1';filters:GeographyFilters;countries:GeographyBreakdown;regions:GeographyBreakdown;cities:GeographyBreakdown;coverage:GeographyCoverage;provenance:GeographyProvenance;method:{approximate:true;rawIpStored:false;coordinatesStored:false}};
export type RealtimeGeography={version:'native-geography-report-v1';countries:{rows:{key:GeoCountryKey;pageViews:number;identifiedPageViews:number;visitors:number|null}[];limit:678;totalGroups:number|null;returnedPageViews:number|null;truncated:false};coverage:GeographyCoverage;provenance:GeographyProvenance;method:{approximate:true;rawIpStored:false;coordinatesStored:false}};
export type GeographyReadiness={status:'ready'|'disabled'|'network-off'|'database-unavailable';database:{status:'ready';databaseBuild:number;databaseSha256:string;bytes:number}|{status:'unavailable';reason:'not-configured'|'missing'|'unreadable'|'too-large'|'invalid'|'lookup-failed'}};
