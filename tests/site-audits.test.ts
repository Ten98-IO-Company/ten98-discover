import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {parseSiteAuditStart,parseAuditListQuery,auditRunDto,type AuditRunRow} from '../src/server/site-audits.ts';

const input={requestId:randomUUID(),domainId:null,startPath:'/',mode:'static'};
test('manual audit intent is bounded, query-free and normalized without domain authority',()=>{
 assert.equal(parseSiteAuditStart(input).maxPages,50);
 assert.equal(parseSiteAuditStart({...input,startPath:'/a/../Page/%2F'}).startPath,'/Page/%2F');
 assert.equal(parseSiteAuditStart({...input,startPath:'/中文'}).startPath,'/%E4%B8%AD%E6%96%87');
 for(const startPath of ['https://evil.example/','//evil.example/','/page?token=secret','/page#fragment','/bad\\path','/bad\0','/bad\ud800','/%00','/%5c','/%zz','/%c0%af','/'+ 'a'.repeat(2048)])assert.throws(()=>parseSiteAuditStart({...input,startPath}),{status:400});
 for(const change of [{domainId:undefined},{domainId:'bad'},{maxPages:0},{maxPages:1001},{maxPages:'50'},{mode:'rendered'},{requestId:input.requestId+'\n'},{origin:'https://evil.example'},{cookies:'private'}])assert.throws(()=>parseSiteAuditStart({...input,...change}),{status:400});
});
test('audit filters reject duplicate, unknown, malformed and cross-list parameters',()=>{
 assert.equal(parseAuditListQuery(new URLSearchParams(),'runs').limit,50);
 assert.equal(parseAuditListQuery(new URLSearchParams('limit=100&coverage=shell'),'pages').coverage,'shell');
 for(const raw of ['limit=0','limit=101','limit=01','limit=1%0a','limit=1&limit=2','limit=NaN','limit=1.2','cursor=a&cursor=b','origin=https%3A%2F%2Fevil.example'])assert.throws(()=>parseAuditListQuery(new URLSearchParams(raw),'runs'),{status:400});
 for(const [kind,raw] of [['runs','coverage=analyzed'],['pages','coverage=complete'],['pages','resourceKind=javascript'],['issues','code=anything'],['issues','severity=critical%0a'],['issues','pageId=not-a-uuid'],['links','direction=sideways']] as const)assert.throws(()=>parseAuditListQuery(new URLSearchParams(raw),kind),{status:400});
 assert.equal(parseAuditListQuery(new URLSearchParams('code=missing-title&severity=critical'),'issues').code,'missing-title');
});
const at=new Date('2026-10-13T00:00:00Z');
function row():AuditRunRow{return {workspace_id:randomUUID(),user_id:randomUUID(),request_id:randomUUID(),domain_hostname:null,domain_verified_at:null,domain_revision:null,rule_version:'static-html-v1',queue_job_id:randomUUID(),generation:'1',lease_expires_at:null,heartbeat_at:null,cancel_requested_at:null,next_request_at:null,robots_state:'pending',robots_digest:null,robots_fetched_at:null,raw_cleanup_completed_at:null,data_cleanup_completed_at:null,id:randomUUID(),project_id:randomUUID(),domain_id:null,origin:'https://audit.example.com',config:{mode:'static',startPath:'/',startUrl:'https://audit.example.com/',maxPages:50,requestLimit:250,bodyCapacityBytes:524288000,frontierLimit:10000,edgeLimit:100000,sitemapDocuments:20,sitemapDepth:3,minIntervalMs:1000,maxAttempts:2,userAgent:'TenMonitorBot/1.0',robotsProductToken:'TenMonitorBot'},status:'queued',phase:null,created_at:at,started_at:null,completed_at:null,deadline_at:new Date(at.getTime()+1800000),stop_reason:null,coverage:{reasons:[],discoveryComplete:false,linksComplete:false,scopeExclusions:0,rawEvidenceRecorded:false},summary:null,request_count:0,html_pages_started:0,sitemap_documents_started:0,frontier_count:2,edge_count:0,budget_charged_bytes:'0',wire_bytes:'0',http_decoded_bytes:'0',decoded_bytes:'0',raw_expired_at:null,data_expired_at:null,deleted_at:null,request_hash:'DO_NOT_EXPOSE',lease_owner:'DO_NOT_EXPOSE',robots_body:Buffer.from('DO_NOT_EXPOSE')};}
test('audit DTO keeps live role and expiry distinct from measurements and private worker state',()=>{
 const source=row();const queued=auditRunDto(source,'owner');assert.equal(queued.canCancel,true);assert.equal(queued.canDelete,false);assert.equal(queued.summary,null);assert.equal(queued.rawEvidenceStatus,'not_recorded');assert.ok(!JSON.stringify(queued).includes('DO_NOT_EXPOSE'));
 assert.equal(auditRunDto(source,'viewer').canCancel,false);
 source.status='completed';source.completed_at=at;source.request_count=3;source.wire_bytes='42';source.raw_expired_at=at;source.data_expired_at=at;
 const expired=auditRunDto(source,'admin');assert.equal(expired.dataStatus,'expired');assert.equal(expired.rawEvidenceStatus,'expired');assert.equal(expired.progress.requests,3);assert.equal(expired.progress.observedWireBytes,42);assert.equal(expired.canDelete,true);assert.equal(expired.canCancel,false);
 source.deleted_at=at;assert.throws(()=>auditRunDto(source,'owner'),{status:410});
});
test('unsafe persisted counter cannot silently lose integer precision in a public report',()=>{
 const source=row();source.wire_bytes='9007199254740993';assert.throws(()=>auditRunDto(source,'owner'),/Invalid audit counter/);
});
