import {z} from 'zod';
import {contentCoverageInputSchema,projectContentCoverageInputSchema} from './ai-content-coverage.ts';
import {usdText} from './ai-search.ts';
import {openRouterModelId,openRouterProviderName,openRouterProviderTag,openRouterRouteIdentity,openRouterTextProfile} from './openrouter-models.ts';

export const contentSupportContract={purpose:'website-content-support',promptVersion:'closed-corpus-support-v1',schemaVersion:1,method:'closed-corpus-model-judgment-v1',derivationVersion:'immutable-prompt-trim-lower-v1'} as const;
const uuid=z.uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/),unique=(v:unknown[])=>new Set(v).size===v.length;
const exact=(max:number,min=0)=>z.string().min(min).max(max).refine(v=>!/[\p{Cs}\u0000]/u.test(v));
const micros=(v:string)=>{const [whole,fraction='']=v.split('.');return BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'));};
// Reuse the existing client-side money grammar, then bound/require positivity.
const money=usdText.pipe(z.string().refine(v=>micros(v)<=1_000_000_000_000n)),positiveMoney=money.pipe(z.string().refine(v=>micros(v)>0n));
const model=z.string().refine(v=>openRouterModelId(v)&&!v.startsWith('openrouter/')&&!/:(online|nitro|floor)$/.test(v));
const role=z.enum(['owner','admin','editor','viewer']),stamp=z.iso.datetime({precision:6}),count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const contentSupportSourceSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('capture'),selection:contentCoverageInputSchema}).strict(),
 z.object({kind:z.literal('project'),selection:projectContentCoverageInputSchema}).strict(),
]);
export const contentSupportQuoteInputSchema=z.object({requestId:uuid,connectionId:uuid,model,fundedCredits:z.literal(true),evaluation:z.literal(true),
 source:contentSupportSourceSchema,expectedQueryReceiptHash:hash,expectedCorpusReceiptHash:hash,selectedQueryIds:z.array(hash).min(1).max(5).refine(unique),selectedPageIds:z.array(uuid).min(1).max(20).refine(unique),
}).strict();
// The stored quote input keeps its pre-D3 shape so payload and identity hashes stay verifiable; since D3 maxSpendUsd records the estimate.
export const contentSupportStoredInputSchema=contentSupportQuoteInputSchema.extend({maxSpendUsd:positiveMoney}).strict();
export const contentSupportStartInputSchema=z.object({quoteId:uuid,requestId:uuid}).strict();
export const contentSupportActionInputSchema=z.object({requestId:uuid}).strict();
export const contentSupportExportInputSchema=z.object({expectedPayloadHash:hash,expectedResultHash:hash,expectedQueryReceiptHash:hash,expectedCorpusReceiptHash:hash}).strict();
export type ContentSupportQuoteInput=z.infer<typeof contentSupportQuoteInputSchema>;

const capacity=z.number().int().positive().max(2_000_000),price=z.string().max(140).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
export const contentSupportRouteSchema=z.object({model,tag:z.string().refine(openRouterProviderTag),providerName:z.string().refine(openRouterProviderName),profile:z.literal(openRouterTextProfile),
 contextLength:capacity,promptCapacity:capacity,completionCapacity:capacity,promptPrice:price,completionPrice:price,requestPrice:price,estimateMicros:z.string().regex(/^[1-9]\d{0,12}$/),
}).strict().refine(v=>openRouterRouteIdentity(v)&&v.completionCapacity>=2048&&v.contextLength>2048);
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
export const contentSupportQuoteDtoSchema=z.object({version:z.literal('ai-content-support-quote-v1'),role,projectId:uuid,quote:z.object({...versions,id:uuid,requestId:uuid,createdAt:stamp,expiresAt:stamp,inputHash:hash,payloadHash:hash,schemaHash:hash,queryReceiptHash:hash,corpusReceiptHash:hash,
 route:contentSupportRouteSchema,estimateUsd:positiveMoney,inputExpired:z.boolean(),input:contentSupportQuoteInputSchema.nullable(),selection:contentSupportSelectionSchema.nullable(),
}).strict()}).strict().superRefine(({quote:q},ctx)=>{
 const fail=()=>ctx.addIssue({code:'custom',message:'Inconsistent content-support quote.'});
 if(q.createdAt.slice(20)!==q.expiresAt.slice(20)||Date.parse(q.expiresAt)-Date.parse(q.createdAt)!==300000||q.inputExpired!==(q.input===null)||q.inputExpired!==(q.selection===null))fail();
 if(money.safeParse(q.estimateUsd).success&&contentSupportRouteSchema.safeParse(q.route).success&&micros(q.estimateUsd)!==BigInt(q.route.estimateMicros))fail();
 if(q.input&&q.selection&&(q.input.model!==q.route.model||q.input.expectedQueryReceiptHash!==q.queryReceiptHash||q.input.expectedCorpusReceiptHash!==q.corpusReceiptHash||JSON.stringify(q.input.selectedQueryIds)!==JSON.stringify(q.selection.queries.map(r=>r.id))||JSON.stringify(q.input.selectedPageIds)!==JSON.stringify(q.selection.pages.map(r=>r.id))||q.selection.pages.some(p=>p.auditRunId!==q.input!.source.selection.auditRunId)))fail();
});
export const contentSupportRunDtoSchema=z.object({version:z.literal('ai-content-support-run-v1'),role,projectId:uuid,run:z.object({...versions,id:uuid,quoteId:uuid,requestId:uuid,inputHash:hash,payloadHash:hash,queryReceiptHash:hash,corpusReceiptHash:hash,resultHash:hash.nullable(),route:contentSupportRouteSchema,status:z.enum(['queued','running','completed','failed','uncertain','cancelled']),chargeStatus:z.enum(['reserved','dispatched','settled','uncertain','cancelled']),
 estimateUsd:positiveMoney,actualUsd:money.nullable(),createdAt:stamp,dispatchedAt:stamp.nullable(),completedAt:stamp.nullable(),generationId:z.string().regex(/^gen-[0-9A-Za-z-]{1,124}$/).nullable(),diagnostic:exact(1000).nullable(),inputExpired:z.boolean(),resultExpired:z.boolean(),selection:contentSupportSelectionSchema.nullable(),proposal:contentSupportProposalSchema.nullable(),canCancel:z.boolean(),canReconcile:z.boolean(),
}).strict()}).strict().superRefine(({role,run:r},ctx)=>{
 const fail=()=>ctx.addIssue({code:'custom',message:'Inconsistent content-support run.'});
 if((r.chargeStatus==='settled')!==(r.actualUsd!==null)||r.inputExpired!==(r.selection===null)||r.inputExpired&&!r.resultExpired||r.resultExpired&&(r.proposal!==null||r.resultHash!==null)||(r.proposal!==null)!==(r.resultHash!==null)||r.proposal!==null&&(r.status!=='completed'||r.chargeStatus!=='settled')||(r.status==='completed'&&!r.resultExpired&&r.proposal===null))fail();
 if(money.safeParse(r.estimateUsd).success&&contentSupportRouteSchema.safeParse(r.route).success&&micros(r.estimateUsd)!==BigInt(r.route.estimateMicros))fail();
 if((r.status==='queued'&&(r.dispatchedAt!==null||r.completedAt!==null||!['reserved','cancelled'].includes(r.chargeStatus)))||(r.status==='running'&&(r.dispatchedAt===null||r.completedAt!==null||r.chargeStatus!=='dispatched'))||(['completed','failed','uncertain'].includes(r.status)&&(r.dispatchedAt===null||r.completedAt===null))||(r.status==='cancelled'&&(r.dispatchedAt!==null||r.completedAt===null||r.chargeStatus!=='cancelled'))||(r.status==='uncertain'&&r.chargeStatus!=='uncertain')||(['completed','failed'].includes(r.status)&&r.chargeStatus!=='settled'))fail();
 if(r.dispatchedAt!==null&&r.dispatchedAt<r.createdAt||r.completedAt!==null&&(r.completedAt<r.createdAt||r.dispatchedAt!==null&&r.completedAt<r.dispatchedAt))fail();
 if(r.canCancel&&(role!=='owner'||r.status!=='queued'||r.chargeStatus!=='reserved')||r.canReconcile&&(role!=='owner'||r.chargeStatus!=='uncertain'||r.generationId===null))fail();
 if(r.selection&&r.proposal){const queries=new Set(r.selection.queries.map(q=>q.id)),pages=new Map(r.selection.pages.map(p=>[p.id,p]));if(r.proposal.rows.length!==queries.size)fail();for(const row of r.proposal.rows){if(!queries.delete(row.queryId))fail();for(const c of row.citations){const p=pages.get(c.pageId);if(!p||p.bodySha256!==c.bodySha256||c.end>p.bodyLength)fail();}}}
});
export type ContentSupportQuoteDto=z.infer<typeof contentSupportQuoteDtoSchema>;
export type ContentSupportRunDto=z.infer<typeof contentSupportRunDtoSchema>;
