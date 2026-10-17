import {z} from 'zod';

const revision=z.number().int().min(1).max(2147483647);
// SQL emits six fractional digits; never compare this irreversible boundary as a JS Date.
const instant=z.iso.datetime({precision:6});
export const analyticsResetInput=z.object({requestId:z.uuid(),revision:revision.max(2147483646),confirmation:z.literal('RESET')}).strict();
export type AnalyticsResetInput=z.infer<typeof analyticsResetInput>;
export const analyticsResetState=z.object({projectId:z.uuid(),name:z.string().min(1).max(120),role:z.enum(['owner','admin']),revision,
 retainedFrom:instant.nullable(),cleanup:z.enum(['pending','complete'])}).strict();
export const analyticsResetAck=z.object({projectId:z.uuid(),requestId:z.uuid(),appliedRevision:revision,cutoff:instant}).strict();
export const analyticsResetResult=z.object({state:analyticsResetState,ack:analyticsResetAck,replayed:z.boolean()}).strict()
 .refine(v=>v.state.projectId===v.ack.projectId&&v.state.revision>=v.ack.appliedRevision&&v.state.retainedFrom!==null&&v.state.retainedFrom>=v.ack.cutoff);
export type AnalyticsResetState=z.infer<typeof analyticsResetState>;
export type AnalyticsResetResult=z.infer<typeof analyticsResetResult>;
