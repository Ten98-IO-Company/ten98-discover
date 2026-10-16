import {z} from 'zod';
import {revenueCurrencies} from './revenue.ts';

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