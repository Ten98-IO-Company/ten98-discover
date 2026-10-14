import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'vite';

test('linked activity accepts a skipped local calendar day and still rejects reversed UTC bounds',async()=>{
  const server=await createServer({configFile:false,cacheDir:'private/linked-client-check-'+process.pid,appType:'custom',server:{middlewareMode:true,hmr:false,watch:null}});
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
