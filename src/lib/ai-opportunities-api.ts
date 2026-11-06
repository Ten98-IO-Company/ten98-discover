import {z} from 'zod';
import {workspaceRoles} from '@ten98/runtime/browser';
import {opportunitiesEvidenceSchema,opportunitiesSourceIdentitySchema} from './ai-opportunities.ts';
import {opportunitiesHistorySummarySchema,opportunitiesRunDtoSchema} from './ai-opportunities-run.ts';

const role=z.enum(workspaceRoles),projectId=z.uuid();
export const opportunitiesSourceDtoSchema=z.object({
 projectId,asOf:z.iso.datetime({precision:6}),availability:z.enum(['available','insufficient-evidence']),expectedSource:opportunitiesSourceIdentitySchema,
 coverage:opportunitiesEvidenceSchema.shape.coverage,prompts:z.number().int().min(0).max(30),citations:z.number().int().min(0).max(200),
 warnings:z.array(z.string().max(2048)).max(20),
}).strict().refine(v=>v.projectId===v.expectedSource.projectId);
export const opportunitiesListDtoSchema=z.object({projectId,role,canPrepare:z.boolean(),
 connections:z.array(z.object({id:z.uuid(),name:z.string().min(1).max(120),revision:z.number().int().positive(),checkStatus:z.enum(['untested','ok','error'])}).strict()).max(100),
 runs:z.array(opportunitiesHistorySummarySchema).max(20),nextCursor:z.string().max(4096).nullable(),
}).strict().refine(v=>v.canPrepare===(v.role==='owner')&&(v.role==='owner'||v.connections.length===0)&&new Set(v.runs.map(r=>r.id)).size===v.runs.length);
export const opportunitiesDetailDtoSchema=z.object({projectId,role,run:opportunitiesRunDtoSchema}).strict();
export const opportunitiesActionDtoSchema=z.object({runId:z.uuid(),replayed:z.boolean()}).strict();
export type OpportunitiesSourceDto=z.infer<typeof opportunitiesSourceDtoSchema>;
export type OpportunitiesListDto=z.infer<typeof opportunitiesListDtoSchema>;
export type OpportunitiesDetailDto=z.infer<typeof opportunitiesDetailDtoSchema>;
