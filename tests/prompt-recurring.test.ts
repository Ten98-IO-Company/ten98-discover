import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {promptCalendar,recurringCeiling,createPromptTrackerInput,approvePromptTrackerInput,promptTrackersResponse,promptOccurrenceSchema,promptTrackerSchema,promptTrackerResponse,promptTrackerMutationResponse} from '../src/lib/prompt-recurring.ts';

const calendar={interval:'daily',timezone:'America/New_York',hour:2,minute:30,weekday:null};
test('calendar is explicit and strict; weekly needs one weekday and monthly is month-end',()=>{
 assert.ok(promptCalendar.safeParse(calendar).success);assert.ok(promptCalendar.safeParse({...calendar,interval:'weekly',weekday:0}).success);assert.ok(promptCalendar.safeParse({...calendar,interval:'monthly'}).success);
 for(const delta of [{interval:'hourly'},{weekday:0},{hour:24},{minute:-1},{timezone:'+04:00'},{timezone:'America/\nNew_York'},{timezone:'UTC',cron:'* * * * *'}])assert.equal(promptCalendar.safeParse({...calendar,...delta}).success,false);
 assert.equal(promptCalendar.safeParse({...calendar,interval:'weekly'}).success,false);
});
test('positive micro-USD standing ceiling is bounded without floating point or hidden billable options',()=>{
 for(const value of ['0.000001','1','1000000.000000'])assert.ok(recurringCeiling.safeParse(value).success);
 for(const value of ['0','0.000000','1000000.000001','1e-6',' 1','1\n','0.0000001','NaN','-1'])assert.equal(recurringCeiling.safeParse(value).success,false);
 const body={requestId:randomUUID(),quoteId:randomUUID(),name:'Daily sample',calendar,maximumUsd:'0.050000'};assert.equal(createPromptTrackerInput.parse(body).approve,false);
 assert.equal(createPromptTrackerInput.safeParse({...body,route:{paid:true}}).success,false);assert.equal(approvePromptTrackerInput.safeParse({...body,revision:1,approve:true}).success,false);
});
test('wire rejects invented enabled grants, copied unknown keys and inconsistent occurrence identities',()=>{
 const id=randomUUID(),row={id,scheduledFor:'2026-10-16T04:55:51.447627Z',trigger:'calendar',status:'started',quoteId:randomUUID(),comparisonId:id,reason:null};assert.ok(promptOccurrenceSchema.safeParse(row).success);assert.equal(promptOccurrenceSchema.safeParse({...row,comparisonId:randomUUID()}).success,false);assert.equal(promptOccurrenceSchema.safeParse({...row,status:'quoted'}).success,false);
 const tracker={id:randomUUID(),createdRequestId:randomUUID(),name:'Sample',revision:1,enabled:false,archivedAt:null,calendar,maximumUsd:'0.050000',nextDueAt:null,definition:{promptId:randomUUID(),versionId:randomUUID(),models:['openai/gpt-4o-mini'],systemText:'',maxCompletionTokens:64},approval:null,lastStatus:null,occurrences:[row]};
 const body={projectId:randomUUID(),role:'viewer',status:'active',items:[tracker],nextCursor:null};assert.ok(promptTrackersResponse.safeParse(body).success);for(const invalid of [{...body,apiKey:'never'},{...body,role:'guest'},{...body,items:[{...tracker,enabled:true}]},{...body,items:[{...tracker,nextDueAt:'2026-10-17T00:00:00Z'}]},{...body,items:[{...tracker,definition:{...tracker.definition,models:['openai/gpt-4o-mini','openai/gpt-4o-mini']}}]}])assert.equal(promptTrackersResponse.safeParse(invalid).success,false);
});

test('tracker pages stay bounded while point acknowledgements preserve archived identity independently of a page',()=>{
 const item={id:randomUUID(),createdRequestId:randomUUID(),name:'Old tracker',revision:8,enabled:false,archivedAt:'2026-10-16T10:00:00Z',calendar,maximumUsd:'0.050000',nextDueAt:null,definition:{promptId:randomUUID(),versionId:randomUUID(),models:['openai/gpt-4o-mini'],systemText:'',maxCompletionTokens:64},approval:null,lastStatus:null,occurrences:[]},context={projectId:randomUUID(),role:'owner'};
 assert.ok(promptTrackerSchema.safeParse(item).success);assert.equal(promptTrackerSchema.safeParse({...item,enabled:true}).success,false);
 assert.ok(promptTrackerResponse.safeParse({...context,item}).success);
 const ack={requestId:randomUUID(),trackerId:item.id,action:'archive',quoteId:null,occurrenceId:null};assert.ok(promptTrackerMutationResponse.safeParse({...context,item,ack}).success);assert.equal(promptTrackerMutationResponse.safeParse({...context,item,ack:{...ack,trackerId:randomUUID()}}).success,false);
 const page={...context,status:'archived',items:Array.from({length:20},()=>({...item,id:randomUUID()})),nextCursor:'opaque'};assert.ok(promptTrackersResponse.safeParse(page).success);assert.equal(promptTrackersResponse.safeParse({...page,items:[...page.items,item]}).success,false);assert.equal(promptTrackersResponse.safeParse({...page,ack}).success,false);
 assert.equal(promptTrackerMutationResponse.safeParse({...context,item,ack:{...ack,action:'delete'}}).success,false);assert.equal(promptTrackerResponse.safeParse({...context,item,extra:true}).success,false);
});