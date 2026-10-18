import {z} from 'zod';
import type {GeographyKey} from './analytics-geography.ts';

export const trackedAssetVersion='native-tracked-assets-v1' as const;
export const trackedAssetLimits=Object.freeze({bodyBytes:16384,responseBytes:2097152,pageSize:20,groups:100});
export const trackedAssetDimensions=['referrer','channel','browser','os','device','country','region','city'] as const;
export const trackedShareSections=['summary','trend','breakdown'] as const;
const text=(max:number,min=0)=>z.string().trim().min(min).max(max).refine(v=>!/[\u0000\uD800-\uDFFF]/u.test(v));
export const trackedUuid=z.uuid().transform(v=>v.toLowerCase());
export const trackedRevision=z.number().int().positive().max(2147483647);
const common={name:text(120,1),active:z.boolean(),collection:z.object({enabled:z.boolean(),captureReferrer:z.boolean(),captureGeography:z.boolean(),excludeBots:z.boolean()}).strict()};
export const trackedAssetInput=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('link'),destination:z.string().min(1).max(2048)}).strict(),
 z.object({...common,kind:z.literal('pixel')}).strict(),
]);
export const trackedShareInput=z.object({requestId:trackedUuid,assetRevision:trackedRevision,label:text(120,1),scope:z.string().min(1).max(20000),
 sections:z.array(z.enum(trackedShareSections)).min(1).max(3).refine(v=>new Set(v).size===v.length),expiresAt:z.iso.datetime({offset:true}),
 token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
export type TrackedAssetFields=z.infer<typeof trackedAssetInput>;
export type TrackedAssetRole='owner'|'admin'|'editor'|'viewer';
export type TrackedAssetItem=TrackedAssetFields&{id:string;workspaceId:string;publicUrl:string;revision:number;createdAt:string;updatedAt:string};
export type TrackedAssetAck={requestId:string;operation:'create'|'update'|'delete'|'share-create'|'share-revoke';assetId:string;appliedRevision:number;shareId?:string};
export type TrackedAssetWrite={workspaceId:string;role:TrackedAssetRole;ack:TrackedAssetAck;item:TrackedAssetItem|null;deleted:boolean;replayed:boolean;share?:TrackedAssetShare|null};
export type TrackedAssetShare={id:string;label:string;scope:string;sections:typeof trackedShareSections[number][];revision:number;createdAt:string;expiresAt:string;revokedAt:string|null};
export type TrackedAssetCounts={requests:number|null;identifiedRequests:number|null;unidentifiedRequests:number|null;estimatedVisitors:number|null;estimatedVisits:number|null};
export type TrackedAssetReport={version:typeof trackedAssetVersion;asset:{id:string;kind:'link'|'pixel';name:string;revision:number};scope:string;asOf:string;
 range:{from:string;to:string;timeZone:string;start:string;end:string};coverage:{status:'complete'|'partial'|'unavailable';retainedFrom:string|null};
 retention:{policyRevision:number;watermark:string|null};method:{measurement:'accepted-http-requests';identity:'monthly-asset-key-hour-visits';channel:'recorded-channel-tags-v1';visitorCountsAdditive:false;captureCoverage:'unknown';delivery:'not-measured';limitation:string};
 summary?:TrackedAssetCounts;daily?:({date:string;start:string;end:string;skipped:boolean;provisional:boolean;coverage:'complete'|'partial'|'unavailable'}&TrackedAssetCounts)[];
 breakdown?:{dimension:typeof trackedAssetDimensions[number];metric:'requests';rows:({key:string|GeographyKey|null}&TrackedAssetCounts)[];totalGroups:number|null;limit:number;returnedRequests:number|null;omittedRequests:number|null;truncated:boolean};
};
