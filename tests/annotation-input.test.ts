import assert from 'node:assert/strict';
import test from 'node:test';
import {annotationQuery,parseAnnotationDefinition} from '../src/server/annotation-input.ts';
const note='Launch';
const instant=(date='2026-10-14T14:23:00+04:00')=>({date,allDay:false,note});
const reject=(raw:unknown)=>assert.throws(()=>parseAnnotationDefinition(raw),{status:400});
test('annotation instants normalize offsets at millisecond precision without changing timed mode',()=>{
  assert.deepEqual(parseAnnotationDefinition(instant()),{date:'2026-10-14T10:23:00.000Z',allDay:false,note});
  assert.equal((parseAnnotationDefinition(instant('2026-10-14T01:02:03.1Z')) as {date:string}).date,'2026-10-14T01:02:03.100Z');
  assert.equal((parseAnnotationDefinition(instant('9998-12-31T23:59:59.999Z')) as {date:string}).date,'9998-12-31T23:59:59.999Z');
  for(const date of ['2026-01-01','2026-01-01T12:00:00','2026-02-30T12:00:00Z','2026-01-01T24:00:00Z','2026-01-01T12:00:00.0001Z','2026-01-01T12:00:60Z','1969-12-31T23:59:59Z','9999-01-01T00:00:00Z','2026-01-01T12:00:00+25:00','2026-01-01T12:00:00-00:00'])reject(instant(date));
});
test('all-day input keeps an explicit valid calendar and zone for transactional conversion',()=>{
  assert.deepEqual(parseAnnotationDefinition({day:'2099-02-28',timeZone:'Asia/Dubai',allDay:true,note:'  Launch \n note  '}),{day:'2099-02-28',timeZone:'Asia/Dubai',allDay:true,note:'Launch \n note'});
  for(const raw of [{day:'2026-02-30',timeZone:'UTC',allDay:true,note},{day:'2026-01-01',timeZone:'Mars/Olympus',allDay:true,note},{day:'2026-01-01',timeZone:'UTC',allDay:false,note},{...instant(),day:'2026-01-01',timeZone:'UTC'},{date:'2026-01-01T00:00:00Z',note},{...instant(),extra:true}])reject(raw);
});
test('notes preserve inert multiline Unicode and use trimmed500 UTF16 units',()=>{
  for(const input of [instant(),{day:'2026-10-14',timeZone:'Asia/Dubai',allDay:true}]){
    assert.equal(parseAnnotationDefinition({...input,note:'🐎'.repeat(250)}).note.length,500);
    assert.equal(parseAnnotationDefinition({...input,note:' <script>\n%_ =1+1 </script> '}).note,'<script>\n%_ =1+1 </script>');
    for(const value of [' ','x'.repeat(501),'🐎'.repeat(251),'a\0b','\ud800'])reject({...input,note:value});
  }
});
test('list ranges are paired, future-capable and bounded with literal note search only',()=>{
  assert.deepEqual(annotationQuery(new URLSearchParams()),{range:null,search:null,cursor:null});
  assert.deepEqual(annotationQuery(new URLSearchParams({from:'2099-01-01',to:'2099-01-02',timeZone:'Asia/Dubai',search:' %_ '})),{range:{from:'2099-01-01',to:'2099-01-02',timeZone:'Asia/Dubai'},search:'%_',cursor:null});
  for(const q of ['from=2026-01-01','to=2026-01-01','timeZone=UTC','kind=all','search=','search=x&search=y','from=2025-01-01&to=2026-01-02'])assert.throws(()=>annotationQuery(new URLSearchParams(q)),{status:400});
  assert.throws(()=>annotationQuery(new URLSearchParams(),true),{status:400});
  assert.throws(()=>annotationQuery(new URLSearchParams({from:'2026-01-01',to:'2026-01-01',search:'x'}),true),{status:400});
  assert.equal(annotationQuery(new URLSearchParams({from:'2026-01-01',to:'2026-01-01'}),true).range?.timeZone,'UTC');
});
