import {z} from 'zod';

const revision=z.number().int().min(1).max(2147483647);
export const projectDeleteInput=z.object({requestId:z.uuid(),revision,confirmation:z.literal('DELETE')}).strict();
export type ProjectDeleteInput=z.infer<typeof projectDeleteInput>;
export const projectDeleteState=z.object({workspaceId:z.uuid(),projectId:z.uuid(),role:z.enum(['owner','admin']),item:z.object({name:z.string().min(1).max(120),revision}).strict().nullable()}).strict();
export const projectDeleteAck=z.object({workspaceId:z.uuid(),projectId:z.uuid(),requestId:z.uuid(),appliedRevision:revision,deletedAt:z.iso.datetime({precision:6})}).strict();
export const projectDeleteResult=z.object({workspaceId:z.uuid(),role:z.enum(['owner','admin']),ack:projectDeleteAck,deleted:z.literal(true),replayed:z.boolean()}).strict().refine(value=>value.workspaceId===value.ack.workspaceId);
export type ProjectDeleteState=z.infer<typeof projectDeleteState>;
