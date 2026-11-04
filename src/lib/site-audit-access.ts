import {z} from 'zod';
import {workspaceRoles} from '@ten98/runtime/browser';

const stamp=z.string().datetime({offset:true});
const revision=z.number().int().min(1).max(2147483646);
const origin=z.string().url().max(512);
const mutation={requestId:z.uuid(),expectedRevision:z.number().int().min(0).max(2147483645)};
export const siteAuditAccessBinding=z.object({id:z.uuid(),revision}).strict();
export const siteAuditAccessSave=z.object({
 ...mutation,domainId:z.uuid().nullable(),signatureInput:z.string().min(1).max(4096),signature:z.string().min(1).max(4096),
}).strict();
export const siteAuditAccessRemove=z.object({...mutation,credentialId:z.uuid()}).strict();
export const siteAuditAccessAck=z.object({requestId:z.uuid(),operation:z.enum(['save','remove']),credentialId:z.uuid(),revision}).strict();
export const siteAuditAccessMetadata=z.object({
 id:z.uuid(),domainId:z.uuid().nullable(),origin,revision,expiresAt:stamp,verification:z.enum(['verified','unverified']),
 createdAt:stamp,updatedAt:stamp,revokedAt:stamp.nullable(),
}).strict();
export const siteAuditAccessResponse=z.object({
 projectId:z.uuid(),role:z.enum(workspaceRoles),vaultConfigured:z.boolean(),
 origins:z.array(z.object({domainId:z.uuid().nullable(),origin}).strict()).max(51),credentials:z.array(siteAuditAccessMetadata).max(51),
}).strict();
export const siteAuditAccessMutationResponse=siteAuditAccessResponse.extend({ack:siteAuditAccessAck}).strict();
export type SiteAuditAccessBinding=z.infer<typeof siteAuditAccessBinding>;
export type SiteAuditAccessMetadata=z.infer<typeof siteAuditAccessMetadata>;
export type SiteAuditAccessResponse=z.infer<typeof siteAuditAccessResponse>;
export type SiteAuditAccessMutationResponse=z.infer<typeof siteAuditAccessMutationResponse>;
