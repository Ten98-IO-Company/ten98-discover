import {geographyFields,serializeGeographyKey,type GeographyKey} from './analytics-geography.ts';
import {z} from 'zod';
import {revenueCurrencies} from './revenue.ts';
import type {AnalyticsPeriodReport} from './analytics-comparison.ts';

export const boardLimits=Object.freeze({cards:40,rows:40,columns:4,bodyBytes:196608,previewBodyBytes:51200,responseBytes:2097152,pageSize:20});
export const boardCardTypes=['WebsiteMetricsBar','EventsMetricsBar','Goal','Funnel','WebsiteChart','UTM','RealtimeHeader','RealtimeChart','RealtimeActiveUsers','RevenueMetricsBar','RevenueChart','RevenueMetricsTable','MetricsTable','WorldMap','WeeklyTraffic','EventsChart','TextBlock'] as const;
export const boardMetricFields=['path','fullPath','entry','exit','title','query','referrer','channel','country','region','city','browser','os','device','language','screen','utmSource','utmMedium','utmCampaign','utmContent','utmTerm','event','hostname'] as const;
export const boardWebsiteOnly=['EventsMetricsBar','EventsChart','Funnel','Goal','RealtimeActiveUsers','RealtimeHeader','RealtimeChart','RevenueMetricsBar','RevenueChart','RevenueMetricsTable','UTM','WeeklyTraffic'] as const;
const uuid=z.uuid().transform(v=>v.toLowerCase());
const text=(max:number,min=0)=>z.string().min(min).max(max).refine(v=>!/[\u0000\uD800-\uDFFF]/u.test(v));
export const boardRevision=z.number().int().positive().max(2147483647);
export const boardEntity=z.object({kind:z.enum(['website','link','pixel']),id:uuid}).strict();
export type BoardEntity=z.infer<typeof boardEntity>;
const presentation={title:text(120,1).refine(v=>v.trim()===v).optional(),description:text(1000).optional()};
const common={id:uuid,...presentation,entity:boardEntity.nullable()};
const limit=z.union([z.literal(5),z.literal(10),z.literal(20)]);
const currency=z.string().refine(v=>revenueCurrencies.includes(v));
export const boardCard=z.discriminatedUnion('type',[
 z.object({...common,type:z.literal('WebsiteMetricsBar')}).strict(),
 z.object({...common,type:z.literal('EventsMetricsBar')}).strict(),
 z.object({...common,type:z.literal('Goal'),analysisId:uuid,analysisRevision:boardRevision}).strict(),
 z.object({...common,type:z.literal('Funnel'),analysisId:uuid,analysisRevision:boardRevision}).strict(),
 z.object({...common,type:z.literal('WebsiteChart')}).strict(),
 z.object({...common,type:z.literal('UTM'),parameter:z.enum(['campaignSource','campaignMedium','campaignName','campaignContent','campaignTerm']),limit}).strict(),
 z.object({...common,type:z.literal('RealtimeHeader')}).strict(),
 z.object({...common,type:z.literal('RealtimeChart')}).strict(),
 z.object({...common,type:z.literal('RealtimeActiveUsers')}).strict(),
 z.object({...common,type:z.literal('RevenueMetricsBar'),currency}).strict(),
 z.object({...common,type:z.literal('RevenueChart'),currency}).strict(),
 z.object({...common,type:z.literal('RevenueMetricsTable'),currency,dimension:z.enum(['referrer','channel','country','region'])}).strict(),
 z.object({...common,type:z.literal('MetricsTable'),dimension:z.enum(boardMetricFields),limit}).strict(),
 z.object({...common,type:z.literal('WorldMap')}).strict(),
 z.object({...common,type:z.literal('WeeklyTraffic')}).strict(),
 z.object({...common,type:z.literal('EventsChart'),limit}).strict(),
 z.object({id:uuid,...presentation,type:z.literal('TextBlock'),text:text(4000)}).strict(),
]);
export type BoardCard=z.infer<typeof boardCard>;
function checkCardEntity(card:BoardCard,defaultEntity:BoardEntity|null,ctx:z.RefinementCtx){
 if(card.type==='TextBlock')return;const entity=card.entity??defaultEntity;
 if(!entity)ctx.addIssue({code:'custom',message:'Choose an entity for each data card.'});
 if(entity&&entity.kind!=='website'&&((boardWebsiteOnly as readonly string[]).includes(card.type)||card.type==='MetricsTable'&&!['referrer','channel','browser','os','device','country','region','city'].includes(card.dimension)))ctx.addIssue({code:'custom',message:'This card requires a website.'});
}
export const boardPreviewInput=z.object({previewId:uuid,card:boardCard,defaultEntity:boardEntity.nullable(),scope:text(20000,1)}).strict().superRefine((input,ctx)=>checkCardEntity(input.card,input.defaultEntity,ctx));
export type BoardPreviewInput=z.infer<typeof boardPreviewInput>;
export const boardDefinition=z.object({schemaVersion:z.literal(1),name:text(120,1).refine(v=>v.trim()===v),description:text(1000),defaultEntity:boardEntity.nullable(),scope:text(20000,1),
 rows:z.array(z.object({id:uuid,minHeight:z.number().int().min(150).max(600),cards:z.array(boardCard.nullable()).min(1).max(boardLimits.columns),widths:z.array(z.number().int().min(1).max(100)).min(1).max(boardLimits.columns).optional()}).strict().superRefine((row,ctx)=>{if(row.widths&&(row.widths.length!==row.cards.length||row.widths.reduce((sum,width)=>sum+width,0)!==100))ctx.addIssue({code:'custom',message:'Use one positive percentage per column, totalling100.'});})).max(boardLimits.rows)
}).strict().superRefine((value,ctx)=>{
 const ids=new Set<string>();let count=0;
 for(const row of value.rows){if(ids.has(row.id))ctx.addIssue({code:'custom',message:'Use unique row and card IDs.'});ids.add(row.id);
  for(const card of row.cards){if(!card)continue;count++;if(ids.has(card.id))ctx.addIssue({code:'custom',message:'Use unique row and card IDs.'});ids.add(card.id);
   checkCardEntity(card,value.defaultEntity,ctx);
  }
 }
 if(count>boardLimits.cards)ctx.addIssue({code:'custom',message:'A board supports at most40 cards.'});
});
export type BoardDefinition=z.infer<typeof boardDefinition>;
export type BoardRole='owner'|'admin'|'editor'|'viewer';
export type BoardItem={id:string;workspaceId:string;revision:number;definition:BoardDefinition;createdAt:string;updatedAt:string};
export type BoardAck={requestId:string;operation:'create'|'update'|'clone'|'delete';boardId:string;appliedRevision:number};
export type BoardWriteResult={workspaceId:string;role:BoardRole;ack:BoardAck;item:BoardItem|null;deleted:boolean;replayed:boolean};
export type BoardCoverage={status:'complete'|'partial'|'unavailable';retainedFrom:string|null};
export type BoardActivityResult={version:'native-board-activity-v1';profile:'visitors'|'weekly'|'events';projectId:string;scope:string;
 range:{from:string;to:string;timeZone:string;start:string;end:string};coverage:BoardCoverage;
 method:{identity:'rotating-project-key';population:'matching-pageviews'|'matching-custom-events';visitorCountsAdditive:false;weeklyRepeatedHours:'combined';eventRanking:'whole-filtered-range-count-then-name'};
 totals:{events:number|null;identifiedEvents:number|null;unidentifiedEvents:number|null;estimatedVisitors:number|null};
 daily:{date:string;start:string;end:string;skipped:boolean;coverage:BoardCoverage['status'];events:number|null;identifiedEvents:number|null;unidentifiedEvents:number|null;estimatedVisitors:number|null}[];
 weekly:{weekday:number;hour:number;events:number|null;identifiedEvents:number|null;unidentifiedEvents:number|null;estimatedVisitors:number|null;coverage:BoardCoverage['status']}[];
 series:{name:string;events:number|null;daily:{date:string;events:number|null}[]}[];
 eventNames:{total:number|null;returned:number;omitted:number|null;otherEvents:number|null;otherDaily:{date:string;events:number|null}[]}|null;
};

export type BoardDimensionResult={version:'native-board-dimension-v1';projectId:string;scope:string;dimension:'hostname'|'channel'|'entry'|'exit';
 range:BoardActivityResult['range'];coverage:BoardCoverage;query:{filters:Record<string,string>;property:{key:string;type:string;value?:unknown}|null};
 method:{metric:'pageviews'|'observed-visits';identity:'rotating-project-key-hour-visit';boundaries:'whole-window-retained-pageviews';hostname:'recorded-origin-only';channel:'recorded-channel-tags-v1';historyComplete:false;visitorCountsAdditive:false};
 totals:{units:number|null;identifiedUnits:number|null;unidentifiedUnits:number|null;estimatedVisitors:number|null};
 evidence:{matchingPageviews:number|null;anonymousPageviews:number|null;qualifiedVisits:number|null;retainedVisitPageviews:number|null;windowClippedVisits:number|null;orderingTieVisits:number|null;retentionClippedVisits:null};
 breakdown:{rows:{key:string|null;units:number;identifiedUnits:number;estimatedVisitors:number|null}[];totalGroups:number|null;returnedUnits:number|null;omittedUnits:number|null;limit:number;truncated:boolean};
};
export type BoardSummaryResult={version:'native-board-summary-v1';projectId:string;scope:string;
 range:BoardActivityResult['range'];coverage:BoardCoverage;
 method:{population:'selected-retained-observations';visits:'project-visitor-visit-pair';customSuppression:'whole-window-retained-custom-events';duration:'selected-pageview-span';historyComplete:false};
 totals:AnalyticsPeriodReport['totals'];measurement:AnalyticsPeriodReport['measurement'];
};

// Public sharing is a distinct capability/receipt contract; old BoardAck stays unchanged.
const sharePublication={label:text(120,1).refine(value=>value.trim()===value),theme:z.enum(['light','dark']),boardRevision,
 selectedCardIds:z.array(uuid).min(1).max(boardLimits.cards).refine(ids=>new Set(ids).size===ids.length).transform(ids=>ids.sort()),
 scope:text(20000,1),allowFilter:z.boolean(),ongoingLive:z.boolean(),expiresAt:z.iso.datetime({precision:3})};
export const shareToken=z.string().length(43).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
/** One fresh canonical 32-byte base64url capability secret, generated in the owner's browser once per create intent. */
export function newShareToken(){const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
export const boardShareCreate=z.object({requestId:uuid,...sharePublication,token:shareToken}).strict();
export const boardSharePublish=z.object({requestId:uuid,revision:boardRevision,...sharePublication}).strict();
export const boardShareRevoke=z.object({requestId:uuid,revision:boardRevision}).strict();
export const boardShareRead=z.object({grantRevision:boardRevision,boardRevision,scope:text(20000,1)}).strict();
export type BoardShareAck={requestId:string;operation:'create'|'publish'|'revoke';shareId:string;appliedGrantRevision:number;appliedBoardRevision:number};
export type BoardShareItem={id:string;boardId:string;label:string;theme:'light'|'dark';revision:number;boardRevision:number;selectedCardIds:string[];
 scope:string;allowFilter:boolean;ongoingLive:boolean;createdAt:string;updatedAt:string;expiresAt:string;revokedAt:string|null;slug:string};
export type BoardShareWriteResult={workspaceId:string;boardId:string;role:BoardRole;ack:BoardShareAck;item:BoardShareItem|null;replayed:boolean};
// Closed recipient DTOs contain display fields only; never a passthrough private report.
const shareCount=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),shareNullable=shareCount.nullable(),shareStamp=z.iso.datetime(),shareState=z.enum(['complete','partial','unavailable']);
const shareRange=z.object({from:z.iso.date(),to:z.iso.date(),timeZone:text(80,1),start:shareStamp,end:shareStamp}).strict(),shareCoverage=z.object({status:shareState,retainedFrom:shareStamp.nullable()}).strict();
const shareMoney=z.object({sales:z.string().regex(/^\d{1,40}\.\d{4}$/),refunds:z.string().regex(/^\d{1,40}\.\d{4}$/),net:z.string().regex(/^-?\d{1,40}\.\d{4}$/),saleObservations:shareCount,refundObservations:shareCount}).strict();
const shareGeo=z.custom<GeographyKey>(value=>geographyFields.some(field=>serializeGeographyKey(field,value)!==null));
const shareScalar=z.union([text(2048),z.number().finite(),z.boolean(),z.null()]),shareAtom=z.union([shareScalar,shareGeo,z.array(z.object({type:z.enum(['missing','string','number','boolean','null']),value:shareScalar}).strict()).length(2)]);
const shareBaseData={range:shareRange,coverage:shareCoverage},shareDaily=z.object({date:z.iso.date(),start:shareStamp,end:shareStamp,skipped:z.boolean(),coverage:shareState}).strict();
const shareRequestCounts={requests:shareNullable,identifiedRequests:shareNullable,unidentifiedRequests:shareNullable,estimatedVisitors:shareNullable,estimatedVisits:shareNullable};
const assetBase={...shareBaseData,measurement:z.literal('accepted-http-requests'),kind:z.enum(['link','pixel'])};
const assetSummary=z.object({...assetBase,summary:z.object(shareRequestCounts).strict()}).strict();
const assetTrend=z.object({...assetBase,daily:z.array(shareDaily.extend({provisional:z.boolean(),...shareRequestCounts}).strict()).max(366)}).strict();
const assetGroups=z.object({...assetBase,dimension:text(32,1),groups:z.array(z.object({key:shareAtom,...shareRequestCounts}).strict()).max(100),totalGroups:shareNullable,limit:shareCount,returnedRequests:shareNullable,omittedRequests:shareNullable,truncated:z.boolean()}).strict();
const shareProvenance=z.object({source:z.literal('db-ip-city-lite'),scope:z.literal('matching-report-events'),databaseCount:shareNullable,oldestDatabaseBuild:shareNullable,newestDatabaseBuild:shareNullable}).strict();
const explorerGroups=z.object({...shareBaseData,dimension:text(32,1),groups:z.array(z.object({type:text(12,1),value:shareAtom,events:shareCount,visitors:shareNullable}).strict()).max(100),totalGroups:shareNullable,returnedEvents:shareNullable,truncated:z.boolean(),geographyProvenance:shareProvenance.optional()}).strict();
const dimensionGroups=z.object({...shareBaseData,dimension:z.enum(['hostname','channel','entry','exit']),metric:z.enum(['pageviews','observed-visits']),rows:z.array(z.object({key:text(2048).nullable(),units:shareCount,estimatedVisitors:shareNullable}).strict()).max(20),totalGroups:shareNullable,returnedUnits:shareNullable,omittedUnits:shareNullable,limit:shareCount,truncated:z.boolean(),evidence:z.object({matchingPageviews:shareNullable,anonymousPageviews:shareNullable,retainedVisitPageviews:shareNullable,windowClippedVisits:shareNullable,orderingTieVisits:shareNullable,retentionClippedVisits:z.null()}).strict()}).strict();
const shareMatch=z.object({type:z.enum(['path','event']),match:z.enum(['exact','prefix','suffix','contains']),value:text(2048,1)}).strict();
const shareProperty=z.union([z.object({key:text(320,1),operator:z.literal('missing')}).strict(),z.object({key:text(320,1),operator:z.enum(['eq','neq','contains','not_contains']),type:z.enum(['string','number','boolean','null','date','array']),value:z.union([shareScalar,z.array(shareScalar).max(50)])}).strict()]).refine(value=>{
 if(value.operator==='missing')return true;if(value.operator==='contains'||value.operator==='not_contains')return value.type==='string'&&typeof value.value==='string';
 return value.type==='array'?Array.isArray(value.value):value.type==='null'?value.value===null:value.type==='date'?typeof value.value==='string'&&z.iso.datetime().safeParse(value.value).success:typeof value.value===value.type;
});
const shareAnalysis={...shareBaseData,analysisRevision:boardRevision};
const shareLiveRange=z.object({start:shareStamp,end:shareStamp,timeZone:z.literal('UTC'),seconds:z.literal(1800)}).strict();
const shareRevenue={...shareBaseData,currency:z.string().refine(v=>revenueCurrencies.includes(v)),evidenceIncomplete:z.boolean()};
const shareDecimal=z.string().regex(/^-?\d{1,40}\.\d{4}$/).nullable();
const recipientBase={version:z.literal('public-board-card-v1'),shareId:uuid,grantRevision:boardRevision,boardRevision,cardId:uuid,scope:text(20000,1),effectiveWindow:z.enum(['historical','fixed-live','none']),readAt:shareStamp};
const ready=<T extends typeof boardCardTypes[number],S extends z.ZodType>(type:T,data:S)=>z.object({...recipientBase,status:z.literal('ready'),cardType:z.literal(type),data}).strict();
export const publicBoardCardSchema=z.union([
 z.object({...recipientBase,cardType:z.enum(boardCardTypes),status:z.literal('unsupported'),reason:z.enum(['entity_dependency','scope','not_collected','reader_unavailable']),message:text(1000,1)}).strict(),
 ready('TextBlock',z.object({text:text(4000)}).strict()),
 ready('WebsiteMetricsBar',z.union([z.object({...shareBaseData,pageViews:shareNullable,visitors:shareNullable,visits:shareNullable,bounceRate:z.number().min(0).max(100).nullable(),averageVisitSeconds:z.number().finite().nonnegative().nullable()}).strict(),assetSummary])),
 ready('WebsiteChart',z.union([z.object({...shareBaseData,daily:z.array(shareDaily.extend({pageViews:shareNullable,estimatedVisitors:shareNullable}).strict()).max(366)}).strict(),assetTrend])),
 ready('EventsMetricsBar',z.object({...shareBaseData,customEvents:shareNullable,visitors:shareNullable,visits:shareNullable,eventNames:shareNullable}).strict()),
 ready('WeeklyTraffic',z.object({...shareBaseData,weekly:z.array(z.object({weekday:z.number().int().min(1).max(7),hour:z.number().int().min(0).max(23),coverage:shareState,estimatedVisitors:shareNullable}).strict()).length(168),method:z.object({weeklyRepeatedHours:z.literal('combined'),visitorCountsAdditive:z.literal(false)}).strict()}).strict()),
 ready('EventsChart',z.object({...shareBaseData,daily:z.array(shareDaily).max(366),series:z.array(z.object({name:text(320),events:shareNullable,daily:z.array(z.object({date:z.iso.date(),events:shareNullable}).strict()).max(366)}).strict()).max(20),eventNames:z.object({total:shareNullable,returned:shareCount,omitted:shareNullable,otherEvents:shareNullable,otherDaily:z.array(z.object({date:z.iso.date(),events:shareNullable}).strict()).max(366)}).strict().nullable()}).strict()),
 ready('UTM',explorerGroups),ready('MetricsTable',z.union([explorerGroups,dimensionGroups,assetGroups])),ready('WorldMap',z.union([explorerGroups,assetGroups])),
 ready('RealtimeHeader',z.object({asOf:shareStamp,range:shareLiveRange,coverage:shareCoverage,pageViews:shareNullable,customEvents:shareNullable,estimatedVisitors:shareNullable,knownCountryGroups:shareNullable}).strict()),
 ready('RealtimeChart',z.object({asOf:shareStamp,range:shareLiveRange,minutes:z.array(z.object({start:shareStamp,end:shareStamp,partial:z.boolean(),pageViews:shareNullable,customEvents:shareNullable,estimatedVisitors:shareNullable,coverage:shareState}).strict()).max(31)}).strict()),
 ready('RealtimeActiveUsers',z.object({asOf:shareStamp,window:z.object({start:shareStamp,end:shareStamp,seconds:z.literal(300)}).strict(),coverage:shareCoverage,estimatedVisitors:shareNullable}).strict()),
 ready('Goal',z.object({...shareAnalysis,definition:z.object({kind:z.literal('goal'),name:text(120,1),description:text(1000),condition:shareMatch}).strict(),goal:z.object({visitors:shareNullable,totalVisitors:shareNullable,rate:z.number().min(0).max(1).nullable()}).strict().nullable()}).strict()),
 ready('Funnel',z.object({...shareAnalysis,definition:z.object({kind:z.literal('funnel'),name:text(120,1),description:text(1000),windowMinutes:shareCount,steps:z.array(z.object({condition:shareMatch,pageViewsOnly:z.boolean(),properties:z.array(shareProperty).max(10)}).strict()).min(2).max(8)}).strict(),steps:z.array(z.object({step:shareCount,visitors:shareNullable,dropped:shareNullable,conversionRate:z.number().min(0).max(1).nullable(),remainingRate:z.number().min(0).max(1).nullable()}).strict()).min(2).max(8)}).strict()),
 ready('RevenueMetricsBar',z.object({...shareRevenue,net:shareDecimal,averageSale:shareDecimal,keyedNetPerQualifiedKey:shareDecimal,saleObservations:shareNullable,revenueKeys:shareNullable}).strict()),
 ready('RevenueChart',z.object({...shareRevenue,available:z.boolean(),daily:z.array(z.object({date:z.iso.date(),state:z.enum(['complete','partial','unavailable','skipped','future']),totals:shareMoney.nullable()}).strict()).max(366).nullable(),series:z.array(z.object({eventName:text(320).nullable(),daily:z.array(shareMoney.nullable()).max(366)}).strict()).max(21).nullable()}).strict()),
 ready('RevenueMetricsTable',z.object({...shareRevenue,dimension:z.enum(['referrer','channel','country','region']),sales:shareDecimal,breakdown:z.object({rows:z.array(z.object({key:shareAtom,totals:shareMoney,saleShare:z.string().max(100).nullable()}).strict()).max(678),totalGroups:shareCount,limit:shareCount,truncated:z.boolean(),displayed:shareMoney,omitted:shareMoney}).strict().nullable()}).strict().refine(value=>value.breakdown===null||value.breakdown.rows.length<=(value.dimension==='country'?678:100))),
]);
export type PublicBoardCard=z.infer<typeof publicBoardCardSchema>;
export type PublicBoardCardExpectation=Pick<PublicBoardCard,'shareId'|'grantRevision'|'boardRevision'|'cardId'|'cardType'|'scope'>&{entityKind:'website'|'link'|'pixel'|'none'};
export function decodePublicBoardCard(raw:unknown,expected:PublicBoardCardExpectation):PublicBoardCard|null{
 try{if(new TextEncoder().encode(JSON.stringify(raw)).length>boardLimits.responseBytes)return null;const result=publicBoardCardSchema.safeParse(raw);if(!result.success)return null;const d=result.data;
  for(const key of ['shareId','grantRevision','boardRevision','cardId','cardType','scope']as const)if(d[key]!==expected[key])return null;
  const expectedWindow=d.cardType==='TextBlock'?'none':d.cardType.startsWith('Realtime')?'fixed-live':'historical';if(d.effectiveWindow!==expectedWindow)return null;
  if(d.status==='ready'&&'range'in d.data&&'from'in d.data.range){const scope=new URLSearchParams(expected.scope);if(d.data.range.from!==scope.get('from')||d.data.range.to!==scope.get('to')||d.data.range.timeZone!==scope.get('timeZone'))return null;}
  if(d.status==='ready'&&d.cardType!=='TextBlock'){const asset='measurement'in d.data&&d.data.measurement==='accepted-http-requests';if(asset!==(expected.entityKind==='link'||expected.entityKind==='pixel'))return null;if(asset&&'kind'in d.data&&d.data.kind!==expected.entityKind)return null;}
  return d;
 }catch{return null;}
}
const manifestPresentation={id:uuid,title:text(120,1).optional(),description:text(1000).optional()};
const manifestEntity={entityKind:z.enum(['website','link','pixel']),entityLabel:text(120,1)};
const manifestData=<T extends typeof boardCardTypes[number],S extends Record<string,z.ZodType>>(type:T,fields:S)=>z.object({...manifestPresentation,type:z.literal(type),...manifestEntity,...fields}).strict();
const manifestCard=z.union([
 z.object({...manifestPresentation,type:z.literal('TextBlock'),text:text(4000)}).strict(),
 manifestData('WebsiteMetricsBar',{}),manifestData('WebsiteChart',{}),manifestData('EventsMetricsBar',{}),manifestData('Goal',{}),manifestData('Funnel',{}),
 manifestData('UTM',{parameter:z.enum(['campaignSource','campaignMedium','campaignName','campaignContent','campaignTerm']),limit}),
 manifestData('MetricsTable',{dimension:z.enum(boardMetricFields),limit}),manifestData('WorldMap',{}),manifestData('WeeklyTraffic',{}),manifestData('EventsChart',{limit}),
 manifestData('RealtimeHeader',{}),manifestData('RealtimeChart',{}),manifestData('RealtimeActiveUsers',{}),
 manifestData('RevenueMetricsBar',{currency}),manifestData('RevenueChart',{currency}),manifestData('RevenueMetricsTable',{currency,dimension:z.enum(['referrer','channel','country','region'])}),
]);
export const publicBoardManifestSchema=z.object({version:z.literal('public-board-share-v1'),shareId:uuid,grantRevision:boardRevision,boardRevision,label:text(120,1),theme:z.enum(['light','dark']),expiresAt:shareStamp,allowFilter:z.boolean(),ongoingLive:z.boolean(),scope:text(20000,1),readAt:shareStamp,
 rows:z.array(z.object({id:uuid,minHeight:z.number().int().min(150).max(600),widths:z.array(z.number().int().min(1).max(100)).min(1).max(4).optional(),cards:z.array(manifestCard.nullable()).min(1).max(4)}).strict()).max(40)}).strict();
export function decodePublicBoardManifest(raw:unknown,shareId:string){
 try{if(new TextEncoder().encode(JSON.stringify(raw)).length>boardLimits.responseBytes)return null;const parsed=publicBoardManifestSchema.safeParse(raw);if(!parsed.success||parsed.data.shareId!==shareId)return null;const ids=new Set<string>();let count=0;for(const row of parsed.data.rows){if(ids.has(row.id)||row.widths&&(row.widths.length!==row.cards.length||row.widths.reduce((a,b)=>a+b,0)!==100))return null;ids.add(row.id);for(const card of row.cards)if(card){if(ids.has(card.id)||++count>40)return null;if(card.type!=='TextBlock'&&card.entityKind!=='website'&&((boardWebsiteOnly as readonly string[]).includes(card.type)||card.type==='MetricsTable'&&!['referrer','channel','browser','os','device','country','region','city'].includes(card.dimension)))return null;ids.add(card.id);}}return count?parsed.data:null;}catch{return null;}
}

// Hosted recipient capabilities are canonical fragment-only values; never recover from cookies or query strings.
export function parseHostedBoardShare(path:string,search:string,fragment:string):{shareId:string;token:string}|null{
 if(search!==''||path.length>150)return null;
 const match=/^\/share\/boards\/[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(path),token=fragment.startsWith('#')?fragment.slice(1):fragment;
 if(!match||!uuid.safeParse(match[1]).success||!shareToken.safeParse(token).success)return null;
 return{shareId:match[1],token};
}
// Website share links are /share/websites/{lowercase uuid}#{token}: no slug label, no query, same canonical fragment secret.
export function parseHostedWebsiteShare(path:string,search:string,fragment:string):{shareId:string;token:string}|null{
 if(search!=='')return null;
 const match=/^\/share\/websites\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(path),token=fragment.startsWith('#')?fragment.slice(1):fragment;
 if(!match||!uuid.safeParse(match[1]).success||!shareToken.safeParse(token).success)return null;
 return{shareId:match[1],token};
}
// Refuse malformed capability wire before initial router hash canonicalization; valid links stay untouched.
export function scrubMalformedHostedBoardShareFragment(location:Pick<Location,'pathname'|'search'|'hash'>,history:Pick<History,'state'|'replaceState'>):void{
 if(location.pathname.startsWith('/share/boards/')&&location.hash&&!parseHostedBoardShare(location.pathname,location.search,location.hash))history.replaceState(history.state,'',location.pathname+location.search);
 if(location.pathname.startsWith('/share/websites/')&&location.hash&&!parseHostedWebsiteShare(location.pathname,location.search,location.hash))history.replaceState(history.state,'',location.pathname+location.search);
}
