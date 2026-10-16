import {z} from 'zod';
import {openRouterModelId} from './openrouter-models.ts';

const text=(max:number)=>z.string().min(1).max(max).refine(v=>v.trim()===v&&!/[\u0000\uD800-\uDFFF]/u.test(v));
export const promptCalendar=z.object({interval:z.enum(['daily','weekly','monthly']),timezone:text(100).refine(v=>/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(v)),hour:z.number().int().min(0).max(23),minute:z.number().int().min(0).max(59),weekday:z.number().int().min(0).max(6).nullable()}).strict().refine(v=>v.interval==='weekly'?v.weekday!==null:v.weekday===null);
export const recurringCeiling=z.string().refine(v=>{if(!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?(?![\s\S])/.test(v))return false;const[a,b='']=v.split('.'),n=BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));return n>0n&&n<=1000000000000n;});
export const createPromptTrackerInput=z.object({requestId:z.uuid(),quoteId:z.uuid(),name:text(120),calendar:promptCalendar,maximumUsd:recurringCeiling,approve:z.boolean().default(false)}).strict();
export const approvePromptTrackerInput=z.object({requestId:z.uuid(),revision:z.number().int().positive().max(2147483646),quoteId:z.uuid(),calendar:promptCalendar,maximumUsd:recurringCeiling}).strict();
export const changePromptTrackerInput=z.object({requestId:z.uuid(),revision:z.number().int().positive().max(2147483646)}).strict();
const stamp=z.string().datetime({offset:true});
export const promptOccurrenceSchema=z.object({id:z.uuid(),scheduledFor:stamp,trigger:z.enum(['calendar','now']),status:z.enum(['quoted','started','skipped']),quoteId:z.uuid().nullable(),comparisonId:z.uuid().nullable(),reason:z.string().max(500).nullable()}).strict().refine(v=>v.status==='started'?v.quoteId!==null&&v.comparisonId===v.id:v.comparisonId===null&&(v.status==='skipped'||v.quoteId!==null));
export const promptTrackerSchema=z.object({id:z.uuid(),createdRequestId:z.uuid(),name:text(120),revision:z.number().int().positive(),enabled:z.boolean(),calendar:promptCalendar,maximumUsd:recurringCeiling,nextDueAt:stamp.nullable(),definition:z.object({promptId:z.uuid(),versionId:z.uuid(),models:z.array(z.string().refine(openRouterModelId)).min(1).max(4).refine(v=>new Set(v).size===v.length),systemText:z.string().max(4000).refine(v=>!/[\u0000\u000b\u000c\uD800-\uDFFF]/u.test(v)),maxCompletionTokens:z.number().int().min(16).max(4096)}).strict(),approval:z.object({id:z.uuid(),userId:z.string().min(1).max(100),approvedAt:stamp,connectionId:z.uuid(),connectionRevision:z.number().int().positive()}).strict().nullable(),lastStatus:z.string().max(500).nullable(),occurrences:z.array(promptOccurrenceSchema).max(10)}).strict().refine(v=>v.enabled?v.approval!==null&&v.nextDueAt!==null:v.nextDueAt===null);
export const promptTrackerAck=z.object({requestId:z.uuid(),trackerId:z.uuid(),action:z.enum(['create','approve','pause','run']),quoteId:z.uuid().nullable(),occurrenceId:z.uuid().nullable()}).strict();
export const promptTrackersResponse=z.object({projectId:z.uuid(),role:z.enum(['owner','admin','editor','viewer']),items:z.array(promptTrackerSchema).max(20),ack:promptTrackerAck.optional()}).strict();
export type PromptCalendar=z.infer<typeof promptCalendar>;
export type PromptTracker=z.infer<typeof promptTrackerSchema>;
