import {z} from 'zod';
import {workspaceRoles} from '@ten98/runtime/browser';
import {promptCalendar} from './prompt-recurring.ts';
import {siteAuditAccessBinding} from './site-audit-access.ts';

const stamp=z.string().datetime({offset:true});
const revision=z.number().int().min(1).max(2147483646);
export const siteAuditScheduleDefinition=z.object({
 crawlerAccess:siteAuditAccessBinding.nullish(),mode:z.literal('static'),domainId:z.uuid().nullable(),startPath:z.string().min(1).max(2048),
 maxPages:z.number().int().min(1).max(1000),retainBodyText:z.boolean(),includeQueryUrls:z.boolean().optional(),
}).strict();
const mutation={requestId:z.uuid(),expectedRevision:z.number().int().min(0).max(2147483645)};
export const siteAuditScheduleSave=z.object({...mutation,calendar:promptCalendar,definition:siteAuditScheduleDefinition}).strict();
export const siteAuditSchedulePause=z.object(mutation).strict();
export const siteAuditScheduleAck=z.object({requestId:z.uuid(),operation:z.enum(['save','pause']),revision,crawlerAccess:siteAuditAccessBinding.nullish()}).strict();
const occurrence=z.object({
 id:z.uuid(),scheduledFor:stamp,status:z.enum(['queued','running','cancelling','completed','partial','failed','cancelled','skipped','unavailable']),
 runId:z.uuid().nullable(),reason:z.string().max(500).nullable(),
}).strict().refine(value=>['skipped','unavailable'].includes(value.status)?value.runId===null:value.runId!==null);
const schedule=z.object({
 revision,enabled:z.boolean(),calendar:promptCalendar,definition:siteAuditScheduleDefinition,origin:z.string().url(),
 nextDueAt:stamp.nullable(),approvedAt:stamp,lastStatus:z.string().max(500).nullable(),occurrences:z.array(occurrence).max(20),
}).strict().refine(value=>value.enabled===(value.nextDueAt!==null));
export const siteAuditScheduleResponse=z.object({projectId:z.uuid(),role:z.enum(workspaceRoles),schedule:schedule.nullable()}).strict();
export const siteAuditScheduleMutationResponse=siteAuditScheduleResponse.extend({ack:siteAuditScheduleAck}).strict();
export type SiteAuditSchedule=z.infer<typeof schedule>;
export type SiteAuditScheduleDefinition=z.infer<typeof siteAuditScheduleDefinition>;
export type SiteAuditScheduleResponse=z.infer<typeof siteAuditScheduleResponse>;
export type SiteAuditScheduleMutationResponse=z.infer<typeof siteAuditScheduleMutationResponse>;
