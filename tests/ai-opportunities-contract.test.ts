import assert from 'node:assert/strict';
import test from 'node:test';
import {opportunitiesScopeSchema,opportunitiesPrepareInputSchema,opportunitiesStartInputSchema,opportunitiesActionInputSchema,opportunitiesProposalSchema,opportunitiesReportSchema,opportunitiesContract,opportunitiesSubjectsSchema,type OpportunitiesSubject} from '../src/lib/ai-opportunities.ts';
import type {PromptInsightsReport} from '../src/server/prompt-insights.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope=()=>({from:'2026-10-01',to:'2026-10-30',timeZone:'Asia/Dubai',model:null,promptId:null,tag:null,matcher:'unicode-boundary-v1'});
const source=()=>({projectId:id(1),scope:scope(),contextRevision:1,profileHash:'a'.repeat(64),insightSelectionRevision:'b'.repeat(64),citationSelectionRevision:'c'.repeat(64),retentionRevision:1,rawDays:90,derivedDays:365,rawAnchorAt:'2026-10-10T12:00:00.000001Z',derivedAnchorAt:'2026-10-10T12:00:00.000001Z'});
const proposal=()=>({version:1,summary:[],opportunities:[{category:'creation',priority:1,title:'Explain the comparison',why:'The supplied prompt asks how these options differ.',promptIds:[id(2)],evidenceIds:[],targetEvidenceId:null}],risks:[]});

test('opportunity preparation accepts only explicit source identity and generation inputs',()=>{
 const input={requestId:id(3),connectionId:id(4),model:'vendor/model',expectedSource:source()};
 assert.deepEqual(opportunitiesPrepareInputSchema.parse(input),input);
 for(const patch of [{messages:[]},{snapshot:{}},{budget:1},{userId:id(8)},{model:'openrouter/auto'},{model:'vendor/model:online'}])assert.equal(opportunitiesPrepareInputSchema.safeParse({...input,...patch}).success,false);
 assert.equal(opportunitiesPrepareInputSchema.safeParse({...input,expectedSource:{...source(),sourceKind:'chatgpt-capture'}}).success,false);
 assert.equal(opportunitiesStartInputSchema.safeParse({preparationId:id(3),requestId:id(5)}).success,true);
 assert.equal(opportunitiesStartInputSchema.safeParse({preparationId:id(3),requestId:id(5),force:true}).success,false);
 assert.equal(opportunitiesActionInputSchema.safeParse({requestId:id(5),replay:true}).success,false);
});

test('scope retains date/timezone/model/prompt/tag/matcher and rejects invalid boundaries',()=>{
 assert.deepEqual(opportunitiesScopeSchema.parse(scope()),scope());
 for(const patch of [{from:'2026-02-30'},{to:'2026-09-30'},{to:'2026-12-01'},{timeZone:'Not/AZone'},{matcher:'sentiment'},{tag:' padded '},{promptId:'foreign'},{tag:'\ud800'}])assert.equal(opportunitiesScopeSchema.safeParse({...scope(),...patch}).success,false);
});

test('proposal is a strict ordered action contract with no model-supplied link authority',()=>{
 assert.deepEqual(opportunitiesProposalSchema.parse(proposal()),proposal());
 for(const patch of [{priority:2},{url:'https://invented.org'},{title:'See https://invented.org'},{why:'Email invented@example.org'},{promptIds:[]},{promptIds:[id(2),id(2)]},{evidenceIds:['a'.repeat(64)+'\n']},{title:'\ud800'},{why:'x'.repeat(561)}]){
  const value=proposal();Object.assign(value.opportunities[0],patch);assert.equal(opportunitiesProposalSchema.safeParse(value).success,false);
 }
 const duplicate=proposal();duplicate.opportunities.push({...duplicate.opportunities[0],priority:2,title:' EXPLAIN THE COMPARISON '});assert.equal(opportunitiesProposalSchema.safeParse(duplicate).success,false);
});

test('public report explicitly identifies API-answer coverage and unverified recommendations',()=>{
 const value={...proposal(),sourceKind:opportunitiesContract.sourceKind,evidenceHash:'d'.repeat(64),semanticConclusions:'unverified',evidenceValidation:'supplied-api-evidence-ids-v1'};
 assert.deepEqual(opportunitiesReportSchema.parse(value),value);
 for(const patch of [{sourceKind:'chatgpt-capture'},{semanticConclusions:'verified'},{evidenceValidation:'audited-page-spans'}])assert.equal(opportunitiesReportSchema.safeParse({...value,...patch}).success,false);
});

test('named subjects accept the native insights shape with bounded brand and competitor identities',()=>{
 const native:PromptInsightsReport['subjects']=[{id:'brand',name:'Solar Company',aliases:['Solar Co'],domains:['solar-company.com']},{id:id(5),name:'Solar Rival',aliases:[],domains:[]}];
 const accepted:OpportunitiesSubject[]=opportunitiesSubjectsSchema.parse(native);assert.deepEqual(accepted,native);
 for(const value of [[],native.slice(1),[native[0],native[0]],[...native,native[1]],[{...native[0],id:'not-a-competitor-id'}],[{...native[0],name:' '}],[{...native[0],name:'x'.repeat(513)}],[{...native[0],aliases:Array(21).fill('Alias')}],[{...native[0],domains:Array(21).fill('solar.com')}],[{...native[0],name:'Solar\ud800'}],[{...native[0],billing:1}]])assert.equal(opportunitiesSubjectsSchema.safeParse(value).success,false);
});
