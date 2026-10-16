import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'vite';
import {analyticsEnvironment} from '../src/server/analytics-environment.ts';
import {environmentVersion} from '../src/lib/analytics-environment.ts';

test('linked activity accepts a skipped local calendar day and still rejects reversed UTC bounds',async()=>{
  const server=await createServer({configFile:false,cacheDir:'private/linked-client-check-'+process.pid,appType:'custom',ssr:{external:true},server:{host:'127.0.0.1',middlewareMode:true,hmr:false,ws:false,watch:null}});
  try{
    const {readLinkedActivityResponse}=await server.ssrLoadModule('/src/lib/session-explorer.ts');
    const project='10000000-0000-4000-8000-000000000001',visitor='a'.repeat(64);
    const params=new URLSearchParams({from:'2011-12-30',to:'2011-12-30',timeZone:'Pacific/Apia'});
    const now='2026-10-14T12:00:00.000000Z',cutoff='2026-07-16T12:00:00.000000Z';
    // Apia skipped this local date: its inclusive calendar selection has equal UTC bounds.
    const response={projectId:project,baseVisitorKey:visitor,method:'explicit-identified-activity-v1',asOf:now,
      range:{from:'2011-12-30',to:'2011-12-30',timeZone:'Pacific/Apia',start:'2011-12-30T10:00:00.000Z',end:'2011-12-30T10:00:00.000Z'},
      selection:{status:'unavailable',reason:'event_history_unavailable'},summary:null,activity:null,
      coverage:{status:'unavailable',eventRetainedFrom:cutoff,linkRetainedFrom:cutoff,eventEvidenceStartedAt:cutoff,linksStartedAt:cutoff,
        linkEvidenceLostAt:null,linkingEnabled:true,unprovenEventsExcluded:0,legacyEvidence:'not_backfilled',historyComplete:false,
        historyScope:'retained_direct_explicit_observations_only',warnings:['retained_range_clipped']},
      paging:{mode:'current-page-with-fixed-event-bound',eventBefore:now,consistency:'current-per-page',nextCursor:null,limit:50,retentionEvidenceChanged:false}};
    const result=readLinkedActivityResponse(response,params,project,visitor);
    assert.equal(result.selection.reason,'event_history_unavailable');assert.equal(result.summary,null);assert.equal(result.activity,null);
    const reversed=structuredClone(response);reversed.range.start='2011-12-30T10:00:00.001Z';
    assert.throws(()=>readLinkedActivityResponse(reversed,params,project,visitor));
  }finally{await server.close();}
});

test('native session and linked activity preserve bounded server environment, sparse historical metadata and long referrer hosts',async()=>{
  const server=await createServer({configFile:false,cacheDir:'private/session-environment-client-'+process.pid,appType:'custom',ssr:{external:true},server:{host:'127.0.0.1',middlewareMode:true,hmr:false,ws:false,watch:null}});
  try{
    const {readSessionResponse,readLinkedActivityResponse}=await server.ssrLoadModule('/src/lib/session-explorer.ts');
    const project='10000000-0000-4000-8000-000000000001',visitor='a'.repeat(64),visit='b'.repeat(64),params=new URLSearchParams({from:'2026-10-14',to:'2026-10-14',timeZone:'UTC'});
    const now='2026-10-14T12:00:00.000Z',at='2026-10-14T11:00:00.000Z',cutoff='2026-07-16T12:00:00.000Z',precise=(value:string)=>value.replace('.000Z','.000000Z');
    const range={from:'2026-10-14',to:'2026-10-14',timeZone:'UTC',start:'2026-10-14T00:00:00.000Z',end:'2026-10-15T00:00:00.000Z'},paging={mode:'current-page-with-fixed-event-bound',eventBefore:now,consistency:'current-per-page',nextCursor:null,limit:50,retentionEvidenceChanged:false};
    const summary={events:1,pageViews:1,customEvents:0,visits:1,firstAt:at,lastAt:at,observedVisitSpanSeconds:'0',meanObservedVisitSpanSeconds:'0'};
    const activity={id:'20000000-0000-4000-8000-000000000001',receivedAt:at,visitKey:visit,kind:'pageview',eventName:'page_view',path:'/native',origin:'https://session.test',properties:{},dimensions:{origin:'https://session.test'},source:'browser',metricVersion:'umami-3.4-hour-cache-v1'};
    const detail={method:'observed-visitor-session-explorer-v1',asOf:now,range,coverage:{status:'complete',retainedFrom:cutoff},identity:{unit:'rotating-visitor-key',identifiedEvents:1,unidentifiedEvents:0,limitation:'Estimate'},selection:{status:'available',reason:null,countsAreLowerBounds:false},retention:{policy:{revision:1,rawAnalyticsDays:90},eventRetainedFrom:cutoff,profileEvidenceLostAt:null,profileEvidenceLost:false,fingerprint:'c'.repeat(64)},paging,visitorKey:visitor,activityScope:'all-key-activity-in-selected-dates',summary,activity:[activity],currentProperties:{method:'current-retained-session-properties-v1',asOf:now,retainedFrom:cutoff,evidence:{lost:false,lostAt:null,expiredValuesPresent:false},values:[],absence:'unobserved-without-known-loss',limitation:'Current values'},linkedIdentities:{status:'lookup-available',action:'open-linked-activity',limitation:'Explicit evidence'}};
    const linked={projectId:project,baseVisitorKey:visitor,method:'explicit-identified-activity-v1',asOf:precise(now),range,selection:{status:'available',reason:null,reference:{version:1,keyGeneration:'d'.repeat(64),token:'e'.repeat(64)},scope:'direct-marked-events-in-selected-dates'},summary:{...summary,observedKeys:1},activity:[{...activity,receivedAt:precise(at),visitorKey:visitor,identityEvidenceVersion:1}],coverage:{status:'partial',eventRetainedFrom:precise(cutoff),linkRetainedFrom:precise(cutoff),eventEvidenceStartedAt:precise(cutoff),linksStartedAt:precise(cutoff),linkEvidenceLostAt:null,linkingEnabled:true,unprovenEventsExcluded:0,legacyEvidence:'not_backfilled',historyComplete:false,historyScope:'retained_direct_explicit_observations_only',warnings:[]},paging:{...paging,eventBefore:precise(now)}};
    const readers=[{response:detail,read:(value:unknown)=>readSessionResponse(value,params,project,visitor)},{response:linked,read:(value:unknown)=>readLinkedActivityResponse(value,params,project,visitor)}];
    const native=analyticsEnvironment('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    for(const {response,read}of readers){
      assert.doesNotThrow(()=>read(response),'Historical plain dimensions remain valid.');
      for(const dimensions of [native,{environmentVersion,browser:'chrome'},{environmentVersion},analyticsEnvironment('Unknown session fixture')]){const enriched=structuredClone(response);Object.assign(enriched.activity[0].dimensions,dimensions);assert.deepEqual(read(enriched).activity[0].dimensions,enriched.activity[0].dimensions);}
      const long=structuredClone(response);Object.assign(long.activity[0].dimensions,native,{referrerHost:('a'.repeat(60)+'.').repeat(6)+'test'});assert.equal(read(long).activity[0].dimensions.referrerHost.length,370);
      for(const invalid of [{environmentVersion:'server-ua-environment-v2'}, {environmentVersion:null},{browser:'chrome'}, {environmentVersion,browser:'unsupported'}, {environmentVersion,os:'unsupported'},{environmentVersion,device:'unsupported'},{environmentVersion,browser:null},{environmentVersion,userAgent:'raw'},{environmentVersion,ip:'192.0.2.1'},{referrerHost:'a'.repeat(2049)}]){const malformed=structuredClone(response);Object.assign(malformed.activity[0].dimensions,invalid);assert.throws(()=>read(malformed),'Unsupported/unversioned/oversized metadata remains rejected.');}
    }
  }finally{await server.close();}
});
