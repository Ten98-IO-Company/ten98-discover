import {z} from 'zod';
import {opportunitiesScopeSchema,opportunitiesEvidenceSchema,opportunitiesReportSchema} from './ai-opportunities.ts';

const stamp=z.iso.datetime({precision:6});
const route=z.object({model:z.string().max(200),provider:z.string().max(200)}).strict();
export const opportunitiesPreparationDtoSchema=z.object({id:z.uuid(),requestId:z.uuid(),createdAt:stamp,expiresAt:stamp,expired:z.boolean(),available:z.boolean(),route,replayed:z.boolean()}).strict();
export const opportunitiesRunDtoSchema=z.object({id:z.uuid(),preparationId:z.uuid(),status:z.enum(['queued','running','completed','failed','uncertain','cancelled']),createdAt:stamp,dispatchedAt:stamp.nullable(),completedAt:stamp.nullable(),route,
 promptTokens:z.number().int().nonnegative().max(2000000).nullable(),completionTokens:z.number().int().nonnegative().max(2000000).nullable(),diagnostic:z.string().max(1000).nullable(),canRecover:z.boolean(),available:z.boolean(),
 savedEvidence:z.object({scope:opportunitiesScopeSchema,subjects:opportunitiesEvidenceSchema.shape.subjects,prompts:opportunitiesEvidenceSchema.shape.prompts,citations:opportunitiesEvidenceSchema.shape.citations}).strict().nullable(),report:opportunitiesReportSchema.nullable(),
}).strict();
export const opportunitiesHistorySummarySchema=opportunitiesRunDtoSchema.omit({savedEvidence:true,report:true});
export type OpportunitiesPreparationDto=z.infer<typeof opportunitiesPreparationDtoSchema>;
export type OpportunitiesRunDto=z.infer<typeof opportunitiesRunDtoSchema>;
export type OpportunitiesHistorySummary=z.infer<typeof opportunitiesHistorySummarySchema>;
