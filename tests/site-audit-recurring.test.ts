import test from 'node:test';
import assert from 'node:assert/strict';
import {siteAuditScheduleDefinition,siteAuditScheduleSave,siteAuditSchedulePause,siteAuditScheduleAck,siteAuditScheduleResponse,siteAuditScheduleMutationResponse} from '../src/lib/site-audit-recurring.ts';
import {parseSiteAuditStart} from '../src/server/site-audits.ts';

const projectId='6cd9f1c6-0635-4402-a1c9-8113ca053d90';
const requestId='c6d5ad39-87b9-477f-95fd-84822a842a6e';
const runId='902cf0f6-d22d-437a-9cc0-5ad702103ac7';
const occurrenceId='53e0293f-95d7-4f1f-86ef-9bb508a6ae81';
const calendar={interval:'monthly' as const,timezone:'America/New_York',hour:9,minute:30,weekday:null};
const definition={mode:'static' as const,domainId:null,startPath:'/',maxPages:50,retainBodyText:false};
const save={requestId,expectedRevision:0,calendar,definition};
const schedule={revision:2,enabled:true,calendar,definition,origin:'https://example.com',nextDueAt:'2026-11-30T14:30:00.000000Z',approvedAt:'2026-11-03T10:00:00.000001Z',lastStatus:null,occurrences:[]};
const response={projectId,role:'owner',schedule};

test('schedule writes are strict explicit intent with bounded revision and complete static definition',()=>{
 assert.equal(siteAuditScheduleSave.safeParse(save).success,true);
 for(const patch of [{requestId:'new'},{expectedRevision:-1},{expectedRevision:2147483646},{approve:true}])assert.equal(siteAuditScheduleSave.safeParse({...save,...patch}).success,false);
 for(const patch of [{mode:'rendered'},{domainId:'untrusted'},{maxPages:0},{maxPages:1001},{retainBodyText:undefined},{startPath:''},{credentials:'private'}])assert.equal(siteAuditScheduleDefinition.safeParse({...definition,...patch}).success,false);
 assert.equal(siteAuditSchedulePause.safeParse({requestId,expectedRevision:2}).success,true);
 assert.equal(siteAuditSchedulePause.safeParse({...save}).success,false);
 assert.equal(siteAuditScheduleSave.safeParse({...save,expectedRevision:2147483645}).success,true);
});

test('schedules share the calendar contract, including last-day monthly and explicit weekly weekdays',()=>{
 assert.equal(siteAuditScheduleSave.safeParse({...save,calendar:{...calendar,interval:'weekly',weekday:0}}).success,true);
 for(const patch of [{interval:'weekly'},{interval:'monthly',weekday:3},{interval:'daily',weekday:0},{timezone:' America/New_York'},{hour:24},{minute:60},{day:31}])assert.equal(siteAuditScheduleSave.safeParse({...save,calendar:{...calendar,...patch}}).success,false);
});

test('schedule input retains native audit path validation and normalization',()=>{
 const input=siteAuditScheduleSave.parse({...save,definition:{...definition,startPath:'/section/../guides/'}});
 assert.equal(parseSiteAuditStart({...input.definition,requestId}).startPath,'/guides/');
 for(const startPath of ['//other.example/','/private?secret=1','/page#section','https://other.example/'])assert.throws(()=>parseSiteAuditStart({...definition,startPath,requestId}));
});

test('public schedule responses keep exact ISO timestamps, role and unavailable history separate from worker state',()=>{
 assert.equal(siteAuditScheduleResponse.safeParse({projectId,role:'viewer',schedule:null}).success,true);
 assert.equal(siteAuditScheduleResponse.safeParse(response).success,true);
 for(const privateField of ['approval_id','approval_user_id','domain_revision','generation','lease_owner'])assert.equal(siteAuditScheduleResponse.safeParse({...response,schedule:{...schedule,[privateField]:'private'}}).success,false);
 assert.equal(siteAuditScheduleResponse.safeParse({...response,schedule:{...schedule,enabled:false}}).success,false);
 assert.equal(siteAuditScheduleResponse.safeParse({...response,schedule:{...schedule,enabled:false,nextDueAt:null}}).success,true);
 assert.equal(siteAuditScheduleResponse.safeParse({...response,schedule:{...schedule,approvedAt:'yesterday'}}).success,false);
 const occurrence={id:occurrenceId,scheduledFor:'2026-11-02T14:30:00.123456Z',status:'completed',runId,reason:null};
 assert.equal(siteAuditScheduleResponse.safeParse({...response,schedule:{...schedule,occurrences:[occurrence]}}).success,true);
 assert.equal(siteAuditScheduleResponse.safeParse({...response,schedule:{...schedule,occurrences:[{...occurrence,status:'unavailable',runId:null}]}}).success,true);
 for(const value of [{...occurrence,status:'unavailable'},{...occurrence,status:'skipped'},{...occurrence,runId:null},{...occurrence,status:'unknown'}])assert.equal(siteAuditScheduleResponse.safeParse({...response,schedule:{...schedule,occurrences:[value]}}).success,false);
 assert.equal(siteAuditScheduleResponse.safeParse({...response,schedule:{...schedule,occurrences:Array.from({length:21},()=>occurrence)}}).success,false);
});

test('acknowledgements preserve their original applied revision while returning current schedule state',()=>{
 const ack={requestId,operation:'save',revision:1};
 assert.equal(siteAuditScheduleMutationResponse.safeParse({...response,ack}).success,true);
 assert.equal(siteAuditScheduleMutationResponse.safeParse({...response,schedule:{...schedule,enabled:false,nextDueAt:null},ack}).success,true);
 assert.equal(siteAuditScheduleAck.safeParse({...ack,revision:2147483646}).success,true);
 for(const patch of [{revision:0},{revision:2147483647},{operation:'run'},{approvalId:requestId}])assert.equal(siteAuditScheduleAck.safeParse({...ack,...patch}).success,false);
});


test('schedules preserve query policy without rewriting legacy definitions',()=>{
 assert.deepEqual(siteAuditScheduleDefinition.parse(definition),definition);
 assert.equal(parseSiteAuditStart({...definition,requestId}).includeQueryUrls,false);
 const savedDefinition={...definition,startPath:'/section/../guides/?b=2&a=1&a=3',includeQueryUrls:true};
 const saved=siteAuditScheduleSave.parse({...save,definition:savedDefinition});
 const parsed=parseSiteAuditStart({...saved.definition,requestId});
 assert.equal(parsed.startPath,'/guides/?b=2&a=1&a=3');assert.equal(parsed.includeQueryUrls,true);
 assert.deepEqual(siteAuditScheduleResponse.parse({...response,schedule:{...schedule,definition:savedDefinition}}).schedule?.definition,savedDefinition);
 for(const includeQueryUrls of [null,0,1,'true',{},[]])assert.equal(siteAuditScheduleDefinition.safeParse({...definition,includeQueryUrls}).success,false);
});
