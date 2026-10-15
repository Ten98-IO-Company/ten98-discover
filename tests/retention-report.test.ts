import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {retentionReportQuery} from '../src/server/retention-report-input.ts';
import {analyticsPopulation} from '../src/server/analytics-population.ts';
import {analyticsIdentity} from '../src/server/native-analytics.ts';
import {retentionOffsets,retentionCell,retentionCalendar,type RetentionSelection} from '../src/lib/retention-report.ts';

const now=new Date('2026-10-01T00:15:00Z'),parse=(query:string)=>retentionReportQuery(new URLSearchParams(query),now);
test('retention entry reuses closed literal/typed Explorer predicates and a local calendar month',()=>{
  const leap=parse('month=2024-02&timeZone=UTC&path=%2Fsign%25up&propertyKey=done&propertyType=boolean&propertyValue=true');
  assert.equal(leap.scope.from,'2024-02-01');assert.equal(leap.scope.to,'2024-02-29');assert.equal(leap.scope.groupBy,'event');assert.deepEqual(leap.query.filters,{path:'/sign%up'});assert.deepEqual(leap.query.property,{key:'done',type:'boolean',value:true});
  assert.equal(parse('month=2026-09&timeZone=America%2FLos_Angeles').query.month,'2026-09');assert.throws(()=>parse('month=2026-10&timeZone=America%2FLos_Angeles'),{status:400});
  for(const query of ['month=2026-10','timeZone=UTC','month=2026-13&timeZone=UTC','month=1969-12&timeZone=UTC','month=2026-1&timeZone=UTC','month=2026-11&timeZone=UTC','month=2026-10&timeZone=','month=2026-10&timeZone=Bad','month=2026-10&month=2026-09&timeZone=UTC','month=2026-10&timeZone=UTC&from=2026-10-01','month=2026-10&timeZone=UTC&groupBy=path','month=2026-10&timeZone=UTC&limit=10000','month=2026-10&timeZone=UTC&propertyKey=done&propertyType=boolean&propertyValue=%22true%22','month=2026-10&timeZone=UTC&browser=not-a-category','month=2026-10&timeZone=UTC&path='+('a'.repeat(20001))])assert.throws(()=>parse(query),{status:400},query.slice(0,90));
});
test('existing null eventBefore seam supplies one raw clock and fences entry plus saved qualification',()=>{
  const entry=parse('month=2026-09&timeZone=UTC').scope,qualification=parse('month=2026-08&timeZone=UTC&eventName=signup').scope;
  for(const q of [null,qualification]){const sql=analyticsPopulation('project','user',entry,q,false,null);assert.equal(sql.population,'filtered_report');assert.ok(sql.sessionAware);assert.match(sql.ctes,/session_clock AS MATERIALIZED \(SELECT clock_timestamp\(\) AS as_of\)/);assert.doesNotMatch(sql.ctes,/date_trunc\('milliseconds'/);assert.match(sql.ctes,/COALESCE\(\$\d+::timestamptz,as_of\) AS event_before/);assert.equal((sql.ctes.match(/s\.received_at<\(SELECT event_before FROM session_page\)/g)||[]).length,q?2:1);}
});
test('exact-day cells preserve zero, empty, incomplete assignment, expiry and future/skipped/outside distinctions',()=>{
  const selection:RetentionSelection={status:'available',reason:null,assignment:'complete'},row={date:'2026-09-01',cohortKeys:4,calendar:'complete' as const,coverage:'complete' as const},target={start:'2026-09-02T00:00:00.000Z',end:'2026-09-03T00:00:00.000Z',coverage:'complete' as const},at='2026-09-03T00:00:00.000000Z';
  assert.deepEqual(retentionOffsets,[1,2,3,4,5,6,7,14,21,28]);assert.equal(retentionCell(row,1,target,at,selection,0).percentage,0);assert.equal(retentionCell(row,1,target,at,selection,1).percentage,25);assert.equal(retentionCell({...row,cohortKeys:0},1,target,at,selection,0).status,'empty-cohort');
  const partial=retentionCell(row,1,target,at,{...selection,assignment:'retained-only'},2);assert.equal(partial.status,'assignment-incomplete');assert.equal(partial.returnedKeys,2);assert.equal(partial.denominator,4);assert.equal(partial.percentage,null);
  for(const [changed,status]of [[undefined,'outside-month'],[{...target,start:target.end,end:target.end},'skipped'],[{...target,start:at,end:'2026-09-04T00:00:00.000Z'},'not-started'],[{...target,coverage:'unavailable'},'history-unavailable']]as const){const cell=retentionCell(row,1,changed,at,selection,0);assert.equal(cell.status,status);assert.equal(cell.returnedKeys,null);assert.equal(cell.percentage,null);}
  assert.equal(retentionCell(row,1,target,'2026-09-02T12:00:00Z',selection,0).status,'provisional');assert.equal(retentionCell({...row,cohortKeys:null},1,target,at,selection,0).status,'identity-unavailable');assert.equal(retentionCalendar(target.start,target.end,at),'complete');
  const lostEntry=retentionCell({...row,coverage:'unavailable',cohortKeys:null},1,target,at,{...selection,assignment:'retained-only'},0);assert.equal(lostEntry.status,'history-unavailable');assert.equal(lostEntry.denominator,null);assert.equal(retentionCell({...row,calendar:'skipped',cohortKeys:null},1,target,at,selection,0).status,'skipped');assert.equal(retentionCell({...row,calendar:'skipped',cohortKeys:null},1,undefined,at,selection,0).status,'outside-month','Outside-window precedence remains unchanged.');
});
test('observed-key return identity does not merge consent namespaces, UTC-month rotation or explicit identity changes',()=>{
  const base={projectId:randomUUID(),ip:'192.0.2.1',userAgent:'Retention fixture',secret:'synthetic-retention-secret'.repeat(2)},key=(time:string,basis:'consent'|'cookieless',id?:string)=>analyticsIdentity({...base,now:new Date(time),collectionBasis:basis,...id===undefined?{}:{distinctId:id}})!.visitor;
  assert.notEqual(key('2026-09-30T23:59:59Z','consent'),key('2026-10-01T00:00:00Z','consent'));assert.notEqual(key('2026-10-01T00:00:00Z','consent'),key('2026-10-01T00:00:00Z','cookieless'));assert.notEqual(key('2026-10-01T00:00:00Z','consent'),key('2026-10-01T00:00:00Z','consent','synthetic-user'));
});
