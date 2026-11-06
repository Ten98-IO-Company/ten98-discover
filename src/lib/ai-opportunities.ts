import {z} from 'zod';
import {openRouterModelId} from './openrouter-models.ts';
import {citationOwners,citationPublishers,citationSources,citationSafeHref} from './citation-report.ts';

export const opportunitiesContract = {purpose:'ai-opportunities',promptVersion:'retained-api-opportunities-v1',schemaVersion:1,method:'evidence-linked-opportunities-v1',sourceKind:'api-model-answer'} as const;
export const opportunitiesLimits = {prompts:30,executions:1000,citations:200,opportunities:12,messageSchemaBytes:131072,resultBytes:65536,outputTokens:4096} as const;
const uuid=z.uuid().refine(v=>v===v.toLowerCase());
const hash=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const text=(max:number,min=0)=>z.string().min(min).max(max).refine(v=>!/[\p{Cs}\u0000]/u.test(v));
const nonempty=(max:number)=>text(max,1).refine(v=>v.trim().length>0);
const count=z.number().int().nonnegative().max(100000);
const stamp=z.iso.datetime({precision:6});
const unique=(v:readonly string[])=>new Set(v).size===v.length;
const model=text(200,1).refine(openRouterModelId);
export const opportunitiesScopeSchema=z.object({
 from:z.iso.date(),to:z.iso.date(),timeZone:text(120,1).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}}),
 model:model.nullable(),promptId:uuid.nullable(),tag:nonempty(80).refine(v=>v===v.trim()).nullable(),matcher:z.enum(['elmo-substring-v1','unicode-boundary-v1']),
}).strict().refine(v=>v.from<=v.to&&Date.parse(v.to)-Date.parse(v.from)<=30*86400000);
export const opportunitiesSourceIdentitySchema=z.object({projectId:uuid,scope:opportunitiesScopeSchema,contextRevision:z.number().int().positive(),profileHash:hash,insightSelectionRevision:hash,citationSelectionRevision:hash,
 retentionRevision:z.number().int().positive(),rawDays:z.number().int().min(1).max(3650),derivedDays:z.number().int().min(1).max(3650),rawAnchorAt:stamp.nullable(),derivedAnchorAt:stamp.nullable(),
}).strict();
export const opportunitiesPrepareInputSchema=z.object({requestId:uuid,connectionId:uuid,model:model.refine(v=>!v.startsWith('openrouter/')&&!/:(online|nitro|floor)$/.test(v)),expectedSource:opportunitiesSourceIdentitySchema}).strict();
export const opportunitiesStartInputSchema=z.object({preparationId:uuid,requestId:uuid}).strict();
export const opportunitiesActionInputSchema=z.object({requestId:uuid}).strict();
const coverage=z.object({attempted:count,eligible:count,queued:count,running:count,no_answer:count,empty:count,truncated:count,content_filtered:count,expired:count,invalid:count}).strict()
 .refine(v=>Object.entries(v).filter(([key])=>key!=='attempted').reduce((n,[,value])=>n+value,0)===v.attempted);
const subjectWord=(max:number)=>nonempty(max).refine(v=>v===v.trim()&&!/[\x00-\x1f\x7f]/u.test(v));
export const opportunitiesSubjectSchema=z.object({id:z.union([z.literal('brand'),uuid]),name:subjectWord(512),aliases:z.array(subjectWord(512)).max(20),domains:z.array(subjectWord(253)).max(20)}).strict();
export const opportunitiesSubjectsSchema=z.array(opportunitiesSubjectSchema).min(1).max(101).refine(v=>v.filter(s=>s.id==='brand').length===1&&unique(v.map(s=>s.id)));
const prompt=z.object({id:uuid,versionId:uuid,text:nonempty(4000),tags:z.array(nonempty(80)).max(100).refine(unique)}).strict();
const execution=z.object({id:uuid,promptId:uuid,versionId:uuid,requestedAt:stamp,completedAt:stamp,resultHash:hash,requestHash:hash,model,
 brandMentioned:z.boolean(),competitorIds:z.array(uuid).max(100).refine(unique),
}).strict().refine(v=>v.completedAt>=v.requestedAt);
const citation=z.object({id:hash,executionId:uuid,promptId:uuid,retainedCitationIndex:z.number().int().min(0).max(99),url:text(2048,1).refine(v=>citationSafeHref(v)!==null),title:text(4000).nullable(),ownership:z.enum(citationOwners),publisherCategory:z.enum(citationPublishers),sourceType:z.enum(citationSources)}).strict();
export const opportunitiesEvidenceSchema=z.object({source:opportunitiesSourceIdentitySchema,subjects:opportunitiesSubjectsSchema,coverage,prompts:z.array(prompt).max(opportunitiesLimits.prompts),executions:z.array(execution).max(opportunitiesLimits.executions),citations:z.array(citation).max(opportunitiesLimits.citations)}).strict();
export const opportunityCategories=['creation','existing-content','outreach','social'] as const;
// Links are resolved from evidence IDs; generated prose is never a link authority.
const prose=(max:number)=>nonempty(max).refine(v=>!/(?:https?:|www\.|mailto:|\]\s*\(|<\s*a\b|\b[\w.+-]+@[\w.-]+\.[a-z]{2,})/iu.test(v));
export const opportunitiesProposalSchema=z.object({version:z.literal(1),summary:z.array(prose(280)).max(5),opportunities:z.array(z.object({
 category:z.enum(opportunityCategories),priority:z.number().int().min(1).max(opportunitiesLimits.opportunities),title:prose(160),why:prose(560),
 promptIds:z.array(uuid).min(1).max(opportunitiesLimits.prompts).refine(unique),evidenceIds:z.array(hash).max(20).refine(unique),targetEvidenceId:hash.nullable(),
}).strict()).max(opportunitiesLimits.opportunities),risks:z.array(prose(280)).max(4)}).strict().refine(v=>v.opportunities.every((o,i)=>o.priority===i+1)&&unique(v.opportunities.map(o=>o.title.trim().toLowerCase())));
export const opportunitiesReportSchema=opportunitiesProposalSchema.safeExtend({sourceKind:z.literal(opportunitiesContract.sourceKind),evidenceHash:hash,semanticConclusions:z.literal('unverified'),evidenceValidation:z.literal('supplied-api-evidence-ids-v1')});
export type OpportunitiesScope=z.infer<typeof opportunitiesScopeSchema>;
export type OpportunitiesSourceIdentity=z.infer<typeof opportunitiesSourceIdentitySchema>;
export type OpportunitiesPrepareInput=z.infer<typeof opportunitiesPrepareInputSchema>;
export type OpportunitiesStartInput=z.infer<typeof opportunitiesStartInputSchema>;
export type OpportunitiesActionInput=z.infer<typeof opportunitiesActionInputSchema>;
export type OpportunitiesSubject=z.infer<typeof opportunitiesSubjectSchema>;
export type OpportunitiesEvidence=z.infer<typeof opportunitiesEvidenceSchema>;
export type OpportunitiesProposal=z.infer<typeof opportunitiesProposalSchema>;
export type OpportunitiesReport=z.infer<typeof opportunitiesReportSchema>;
