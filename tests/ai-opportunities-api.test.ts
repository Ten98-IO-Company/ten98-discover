import assert from 'node:assert/strict';
import test from 'node:test';
import {opportunitiesSourceDto} from '../src/server/ai-opportunities-api.ts';
import {opportunitiesListDtoSchema,opportunitiesDetailDtoSchema,opportunitiesSourceDtoSchema} from '../src/lib/ai-opportunities-api.ts';
import type {OpportunitiesSource} from '../src/server/ai-opportunities-source.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const source={projectId:id(1),scope:{from:'2026-11-01',to:'2026-11-06',timeZone:'UTC',model:null,promptId:null,tag:null,matcher:'unicode-boundary-v1' as const},contextRevision:1,profileHash:'a'.repeat(64),insightSelectionRevision:'b'.repeat(64),citationSelectionRevision:'c'.repeat(64),retentionRevision:1,rawDays:90,derivedDays:365,rawAnchorAt:null,derivedAnchorAt:null};
const coverage={attempted:0,eligible:0,queued:0,running:0,no_answer:0,empty:0,truncated:0,content_filtered:0,expired:0,invalid:0};
const stamp='2026-11-06T01:00:00.000001Z';
const run={id:id(3),preparationId:id(4),status:'queued',createdAt:stamp,dispatchedAt:null,completedAt:null,route:{model:'vendor/model',provider:'Vendor'},promptTokens:null,completionTokens:null,diagnostic:null,canRecover:false,available:false};

test('source projection exposes only admission identity and meaningful coverage, preserving no evidence',()=>{
 const internal={snapshot:{source,coverage,prompts:[],citations:[],executions:[{internal:'private-answer-canary'}],messages:['private-prompt-canary']},availability:'insufficient-evidence',asOf:stamp,warnings:['No eligible retained answers.'],dependencies:[{requestHash:'private-request-canary'}],businessInputHash:'private-business-canary',evidenceHash:'private-hash-canary'} as unknown as OpportunitiesSource;
 const result=opportunitiesSourceDto(internal);
 assert.deepEqual(result,{projectId:id(1),asOf:stamp,availability:'insufficient-evidence',expectedSource:source,coverage,prompts:0,citations:0,warnings:internal.warnings});
 assert.doesNotMatch(JSON.stringify(result),/private-|executions|dependencies|messages|businessInputHash/);
 assert.equal(opportunitiesSourceDtoSchema.safeParse({...result,projectId:id(2)}).success,false);
 assert.equal(opportunitiesSourceDtoSchema.safeParse({...result,coverage:{...coverage,eligible:1}}).success,false);
});

test('history validates native connections and denies hidden full reports or role/permission contradictions',()=>{
 const list={projectId:id(1),role:'owner',canPrepare:true,connections:[{id:id(2),name:'Synthetic connection',revision:2,checkStatus:'ok'}],runs:[run],nextCursor:null};
 for(const checkStatus of ['untested','ok','error'])assert.ok(opportunitiesListDtoSchema.safeParse({...list,connections:[{...list.connections[0],checkStatus}]}).success);
 for(const bad of [{...list,role:'viewer'},{...list,canPrepare:false},{...list,runs:[{...run,savedEvidence:{}}]},{...list,runs:[run,run]},{...list,connections:[{...list.connections[0],credentials:'private-key'}]}])assert.equal(opportunitiesListDtoSchema.safeParse(bad).success,false);
 assert.ok(opportunitiesListDtoSchema.safeParse({...list,role:'viewer',canPrepare:false,connections:[]}).success);
 assert.ok(opportunitiesDetailDtoSchema.safeParse({projectId:id(1),role:'viewer',run:{...run,savedEvidence:null,report:null}}).success);
 assert.equal(opportunitiesDetailDtoSchema.safeParse({projectId:id(1),role:'viewer',run:{...run,savedEvidence:null,report:null,request_actor:'private-actor'}}).success,false);
});
