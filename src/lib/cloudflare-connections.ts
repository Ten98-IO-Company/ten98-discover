import {workspaceRoles} from '@ten98/runtime/browser';
import {z} from 'zod';

const revision = z.number().int().min(1).max(2147483646);
const accountId = z.string().regex(/^[a-f0-9]{32}$/);
const label = z.string().trim().min(1).max(120).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const mutation = {requestId: z.uuid(), expectedRevision: z.number().int().min(0).max(2147483645)};
export const cloudflareConnectionSave = z.object({...mutation, connectionId: z.uuid().nullable(), accountId, name: label,
  apiToken: z.string().min(1).max(4096).regex(/^[A-Za-z0-9._~-]+$/)}).strict()
  .refine(value => value.connectionId === null ? value.expectedRevision === 0 : value.expectedRevision > 0);
export const cloudflareConnectionDisconnect = z.object({...mutation, connectionId: z.uuid(), expectedRevision: revision.max(2147483645)}).strict();
export const cloudflareConnectionMetadata = z.object({id: z.uuid(), accountId, name: label, revision,
  state: z.enum(['configured', 'disconnected']), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), revokedAt: z.iso.datetime().nullable()}).strict()
  .refine(value => (value.state === 'disconnected') === (value.revokedAt !== null));
export const cloudflareConnectionsResponse = z.object({projectId: z.uuid(), role: z.enum(workspaceRoles), vaultConfigured: z.boolean(),
  connections: z.array(cloudflareConnectionMetadata).max(100)}).strict();
export const cloudflareConnectionAck = z.object({requestId: z.uuid(), operation: z.enum(['save', 'disconnect']), connectionId: z.uuid(), revision}).strict();
export const cloudflareConnectionMutationResponse = cloudflareConnectionsResponse.extend({ack: cloudflareConnectionAck}).strict();
export const cloudflareConnectionCheck = z.object({connectionId: z.uuid(), expectedRevision: revision}).strict();
const identifier = z.string().regex(/^[a-fA-F0-9]{32}$/);
const providerText = z.string().max(4096).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const providerInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const cloudflareConnectionCheckResponse = z.object({projectId: z.uuid(), connectionId: z.uuid(), accountId, revision, checkedAt: z.iso.datetime(),
  sites: z.array(z.object({site_tag: identifier,
    rules: z.array(z.object({host: providerText.optional(), inclusive: z.boolean().optional(), is_paused: z.boolean().optional(), paths: z.array(providerText).max(100).optional()}).strict()).max(100).optional(),
    ruleset: z.object({enabled: z.boolean().optional(), zone_name: providerText.optional(), zone_tag: identifier.optional()}).strict().optional(),
  }).strict()).max(1000),
  capabilities: z.object({enabled: z.boolean(), availableFields: z.array(z.string().max(256).regex(/^[_A-Za-z][_0-9A-Za-z]*$/)).max(2048),
    maxPageSize: providerInteger, maxNumberOfFields: providerInteger, notOlderThan: providerInteger, maxDuration: providerInteger}).strict(),
}).strict();
export type CloudflareConnectionMetadata = z.infer<typeof cloudflareConnectionMetadata>;
export type CloudflareConnectionsResponse = z.infer<typeof cloudflareConnectionsResponse>;
export type CloudflareConnectionMutationResponse = z.infer<typeof cloudflareConnectionMutationResponse>;
export type CloudflareConnectionCheckResponse = z.infer<typeof cloudflareConnectionCheckResponse>;
