import {workspaceRoles} from '@ten98/runtime';
import {z} from 'zod';
import {contentCoverageInputSchema,projectContentCoverageInputSchema} from './ai-content-coverage.ts';
import {openRouterModelId,openRouterProviderName,openRouterProviderTag,openRouterRouteIdentity,openRouterTextProfile} from './openrouter-models.ts';

export const contentSupportContract={purpose:'website-content-support',promptVersion:'closed-corpus-support-v1',schemaVersion:1,method:'closed-corpus-model-judgment-v1',derivationVersion:'immutable-prompt-trim-lower-v1'} as const;
const uuid=z.uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/),unique=(v:unknown[])=>new Set(v).size===v.length;
const exact=(max:number,min=0)=>z.string().min(min).max(max).refine(v=>!/[\p{Cs}\u0000]/u.test(v));
const model=z.string().refine(v=>openRouterModelId(v)&&!v.startsWith('openrouter/')&&!/:(online|nitro|floor)$/.test(v));
const role=z.enum(workspaceRoles),stamp=z.iso.datetime({precision:6}),count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const contentSupportSourceSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('capture'),selection:contentCoverageInputSchema}).strict(),
 z.object({kind:z.literal('project'),selection:projectContentCoverageInputSchema}).strict(),
]);
export const contentSupportPrepareInputSchema=z.object({requestId:uuid,connectionId:uuid,model,evaluation:z.literal(true),
 source:contentSupportSourceSchema,expectedQueryReceiptHash:hash,expectedCorpusReceiptHash:hash,selectedQueryIds:z.array(hash).min(1).max(5).refine(unique),selectedPageIds:z.array(uuid).min(1).max(20).refine(unique),
}).strict();
export const contentSupportStartInputSchema=z.object({preparationId:uuid,requestId:uuid}).strict();
export const contentSupportActionInputSchema=z.object({requestId:uuid}).strict();
export const contentSupportExportInputSchema=z.object({expectedPayloadHash:hash,expectedResultHash:hash,expectedQueryReceiptHash:hash,expectedCorpusReceiptHash:hash}).strict();
export type ContentSupportPrepareInput=z.infer<typeof contentSupportPrepareInputSchema>;

const capacity=z.number().int().positive().max(2_000_000);
export const contentSupportRouteSchema=z.object({model,tag:z.string().refine(openRouterProviderTag),providerName:z.string().refine(openRouterProviderName),profile:z.literal(openRouterTextProfile),
 contextLength:capacity,promptCapacity:capacity,completionCapacity:capacity,
}).strict().refine(v=>openRouterRouteIdentity(v)&&v.completionCapacity>=2048&&v.promptCapacity<=v.contextLength&&v.contextLength>2048);
export const contentSupportDependenciesSchema=z.array(z.discriminatedUnion('kind',[
 z.object({kind:z.literal('query'),captureId:uuid,quoteId:uuid,quoteCreatedAt:stamp,inputHash:hash,inputFingerprint:hash,resultHash:hash}).strict(),
 z.object({kind:z.literal('body'),pageId:uuid,auditRunId:uuid,auditCompletedAt:stamp,observedAt:stamp,bodySha256:hash}).strict(),
])).min(2).max(1020).refine(v=>{const q=v.filter(x=>x.kind==='query'),p=v.filter(x=>x.kind==='body');return q.length>=1&&q.length<=1000&&p.length>=1&&p.length<=20&&unique(q.map(x=>x.captureId))&&unique(q.map(x=>x.quoteId))&&unique(p.map(x=>x.pageId));});

const selectedQuery=z.object({id:hash,key:exact(4000,1).refine(v=>v===v.trim().toLowerCase())}).strict();
const pageRef=z.object({id:uuid,auditRunId:uuid,url:exact(2048,1).refine(v=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}),bodySha256:hash,bodyLength:count.max(65536),observedAt:stamp,extractionVersion:z.literal('static-dom-body-v1')}).strict();
export const contentSupportSelectionSchema=z.object({queries:z.array(selectedQuery).min(1).max(5),pages:z.array(pageRef).min(1).max(20),exclusions:z.object({queries:count,pages:count}).strict()}).strict().refine(v=>unique(v.queries.map(q=>q.id))&&unique(v.queries.map(q=>q.key))&&unique(v.pages.map(p=>p.id)));
const citation=z.object({pageId:uuid,bodySha256:hash,start:count.max(65536),end:count.max(65536),quote:exact(280,1)}).strict().refine(v=>v.start<v.end&&v.end-v.start===v.quote.length);
export const contentSupportProposalSchema=z.object({version:z.literal(1),rows:z.array(z.object({queryId:hash,state:z.enum(['supported','partly_supported','not_supported_in_supplied_text','insufficient_evidence']),rationale:exact(280,1).refine(v=>v.trim()!==''),citations:z.array(citation).max(3)}).strict()).min(1).max(5),semanticConclusions:z.literal('unverified'),evidenceValidation:z.literal('exact-supplied-spans-v1')}).strict().refine(v=>unique(v.rows.map(r=>r.queryId))&&v.rows.every(r=>!['supported','partly_supported'].includes(r.state)||r.citations.length>0));
const versions={purpose:z.literal(contentSupportContract.purpose),promptVersion:z.literal(contentSupportContract.promptVersion),schemaVersion:z.literal(contentSupportContract.schemaVersion),method:z.literal(contentSupportContract.method),derivationVersion:z.literal(contentSupportContract.derivationVersion)};
export const contentSupportPreparationDtoSchema=z.object({version:z.literal('ai-content-support-preparation-v1'),role,projectId:uuid,preparation:z.object({...versions,id:uuid,requestId:uuid,createdAt:stamp,expiresAt:stamp,inputHash:hash,payloadHash:hash,schemaHash:hash,queryReceiptHash:hash,corpusReceiptHash:hash,
 route:contentSupportRouteSchema,inputExpired:z.boolean(),input:contentSupportPrepareInputSchema.nullable(),selection:contentSupportSelectionSchema.nullable(),
}).strict()}).strict().superRefine(({preparation:q},ctx)=>{
 const fail=()=>ctx.addIssue({code:'custom',message:'Inconsistent content-support preparation.'});
 if(q.createdAt.slice(20)!==q.expiresAt.slice(20)||Date.parse(q.expiresAt)-Date.parse(q.createdAt)!==300000||q.inputExpired!==(q.input===null)||q.inputExpired!==(q.selection===null))fail();
 if(q.input&&q.selection&&(q.input.model!==q.route.model||q.input.expectedQueryReceiptHash!==q.queryReceiptHash||q.input.expectedCorpusReceiptHash!==q.corpusReceiptHash||JSON.stringify(q.input.selectedQueryIds)!==JSON.stringify(q.selection.queries.map(r=>r.id))||JSON.stringify(q.input.selectedPageIds)!==JSON.stringify(q.selection.pages.map(r=>r.id))||q.selection.pages.some(p=>p.auditRunId!==q.input!.source.selection.auditRunId)))fail();
});
export const contentSupportRunDtoSchema=z.object({version:z.literal('ai-content-support-run-v1'),role,projectId:uuid,run:z.object({...versions,id:uuid,preparationId:uuid,requestId:uuid,inputHash:hash,payloadHash:hash,queryReceiptHash:hash,corpusReceiptHash:hash,resultHash:hash.nullable(),route:contentSupportRouteSchema,status:z.enum(['queued','running','completed','failed','uncertain','cancelled']),requestStatus:z.enum(['reserved','dispatched','settled','uncertain','cancelled']),
 usage:z.object({promptTokens:count.max(2_000_000).nullable(),completionTokens:count.max(2_000_000).nullable()}).strict(),createdAt:stamp,dispatchedAt:stamp.nullable(),completedAt:stamp.nullable(),generationId:z.string().regex(/^gen-[0-9A-Za-z-]{1,124}$/).nullable(),diagnostic:exact(1000).nullable(),inputExpired:z.boolean(),resultExpired:z.boolean(),selection:contentSupportSelectionSchema.nullable(),proposal:contentSupportProposalSchema.nullable(),canCancel:z.boolean(),canRecover:z.boolean(),
}).strict()}).strict().superRefine(({role,run:r},ctx)=>{
 const fail=()=>ctx.addIssue({code:'custom',message:'Inconsistent content-support run.'});
 if(r.inputExpired!==(r.selection===null)||r.inputExpired&&!r.resultExpired||r.resultExpired&&(r.proposal!==null||r.resultHash!==null)||(r.proposal!==null)!==(r.resultHash!==null)||r.proposal!==null&&(r.status!=='completed'||r.requestStatus!=='settled')||(r.status==='completed'&&!r.resultExpired&&r.proposal===null))fail();
 if((r.status==='queued'&&(r.dispatchedAt!==null||r.completedAt!==null||!['reserved','cancelled'].includes(r.requestStatus)))||(r.status==='running'&&(r.dispatchedAt===null||r.completedAt!==null||r.requestStatus!=='dispatched'))||(['completed','failed','uncertain'].includes(r.status)&&(r.dispatchedAt===null||r.completedAt===null))||(r.status==='cancelled'&&(r.dispatchedAt!==null||r.completedAt===null||r.requestStatus!=='cancelled'))||(r.status==='uncertain'&&r.requestStatus!=='uncertain')||(['completed','failed'].includes(r.status)&&r.requestStatus!=='settled'))fail();
 if(r.dispatchedAt!==null&&r.dispatchedAt<r.createdAt||r.completedAt!==null&&(r.completedAt<r.createdAt||r.dispatchedAt!==null&&r.completedAt<r.dispatchedAt))fail();
 if(r.canCancel&&(role!=='owner'||r.status!=='queued'||r.requestStatus!=='reserved')||r.canRecover&&(role!=='owner'||r.requestStatus!=='uncertain'||r.generationId===null))fail();
 if(r.selection&&r.proposal){const queries=new Set(r.selection.queries.map(q=>q.id)),pages=new Map(r.selection.pages.map(p=>[p.id,p]));if(r.proposal.rows.length!==queries.size)fail();for(const row of r.proposal.rows){if(!queries.delete(row.queryId))fail();for(const c of row.citations){const p=pages.get(c.pageId);if(!p||p.bodySha256!==c.bodySha256||c.end>p.bodyLength)fail();}}}
});
export type ContentSupportPreparationDto=z.infer<typeof contentSupportPreparationDtoSchema>;
export type ContentSupportRunDto=z.infer<typeof contentSupportRunDtoSchema>;

export function projectContentSupportRoute(value:unknown,legacy=false){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Unsupported saved model route.');
 const raw=value as Record<string,unknown>,route=Object.fromEntries(['model','tag','providerName','profile','contextLength','promptCapacity','completionCapacity'].map(k=>[k,raw[k]]));
 // The original v1 route remains in the legacy integrity hash; only its public representation changes.
 if(legacy&&route.profile==='openrouter-api-text-no-search-v1')route.profile=openRouterTextProfile;
 return contentSupportRouteSchema.parse(route);
}
export function projectContentSupportInput(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Unsupported saved assessment input.');
 const {fundedCredits,maxSpendUsd,...input}=value as Record<string,unknown>;return contentSupportPrepareInputSchema.parse(input);
}
export function contentSupportDiagnostic(value:string|null){return value!==null&&/cost|charge|credit|fund|budget|balance|pric|spend|invoice|USD|\$/i.test(value)?'Check the original provider request outcome.':value;}
