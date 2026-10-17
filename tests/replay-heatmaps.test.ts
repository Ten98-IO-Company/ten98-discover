import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {heatmapSettings,defaultHeatmapSettings,heatmapBegin,heatmapBatch,heatmapDepth,heatmapPlane,readHeatmapQuery,replayHeatmapParams,savedReplayWrite,savedReplayAck,heatmapClicks,heatmapBackgroundUpload,heatmapBackgroundPage,replayEventLocator} from '../src/lib/replay-heatmaps.ts';
const begin={siteKey:randomUUID(),requestId:randomUUID(),url:'https://example.test/page',consent:{analytics:true as const,epoch:randomUUID()}},geometry={basis:'document-css-v1' as const,direction:'rtl' as const,pageWidth:1600,pageHeight:2000,viewportWidth:320,viewportHeight:500};
const click={kind:'click' as const,x:1500,y:900,clientX:220,clientY:400,scrollX:-0,scrollY:500,offsetMs:100};
const batch={...begin,captureId:randomUUID(),token:'server-signed',geometry,observations:[click,{kind:'scroll' as const,scrollX:-100,scrollY:1000,offsetMs:200}]};
test('heatmaps require independent enabled settings and strict Analytics proof, never replay or basic proof',()=>{
 assert.deepEqual(heatmapSettings.parse(defaultHeatmapSettings),{enabled:false,sampleRate:0.15});assert.equal(heatmapSettings.parse({enabled:true,sampleRate:0}).sampleRate,0);assert.deepEqual(heatmapBegin.parse(begin),begin);
 for(const patch of [{consent:{analytics:false,epoch:begin.consent.epoch}},{consent:{...begin.consent,replay:true}},{collection:{mode:'cookieless',epoch:begin.consent.epoch}},{url:begin.url+'?'},{url:begin.url+'#'},{url:'https://user:pass@example.test/'},{distinctId:'private'}])assert.equal(heatmapBegin.safeParse({...begin,...patch}).success,false);
 for(const patch of [{sampleRate:Infinity},{sampleRate:-1},{sampleRate:1.01},{enabled:1},{extra:true}])assert.equal(heatmapSettings.safeParse({...defaultHeatmapSettings,...patch}).success,false);
});
test('one bounded geometry cohort retains event-time scroll origins and monotonic offsets',()=>{
 assert.deepEqual(heatmapBatch.parse(batch),batch);assert.deepEqual(heatmapPlane(geometry),geometry);assert.equal(heatmapDepth(geometry,0),25);assert.equal(heatmapDepth(geometry,1000),75);assert.equal(heatmapDepth({...geometry,pageHeight:100},0),100);
 for(const patch of [{observations:[]},{observations:Array.from({length:21},()=>click)},{observations:[{...click,x:1601}]},{observations:[{...click,scrollY:1502}]},{observations:[{...click,offsetMs:300001}]},{observations:[click,{...click,offsetMs:99}]},{observations:[{kind:'scroll',scrollX:0,scrollY:Infinity,offsetMs:1}]},{geometry:{...geometry,pageWidth:0}},{geometry:{...geometry,viewportTop:1}},{token:undefined},{selector:'private'}])assert.equal(heatmapBatch.safeParse({...batch,...patch}).success,false);
});
test('saved replay mutations carry exact action/revision/name and contextual receipt identity',()=>{
 const body={requestId:randomUUID(),revision:0,action:'save' as const,name:' Saved recording '};assert.equal(savedReplayWrite.parse(body).name,'Saved recording');for(const patch of [{revision:-1},{revision:2147483648},{name:'\0'},{name:' '},{action:'unsave'},{extra:true}])assert.equal(savedReplayWrite.safeParse({...body,...patch}).success,false);
 assert.equal(savedReplayWrite.safeParse({...body,action:'unsave',name:null}).success,true);assert.equal(savedReplayAck.safeParse({role:'editor',request:{...savedReplayWrite.parse(body),recordingId:randomUUID()},appliedRevision:1,replayed:false}).success,true);assert.equal(savedReplayAck.safeParse({role:'editor',request:body,appliedRevision:1,replayed:false}).success,false);
});
test('heatmap queries bind one page/geometry with bounded UTC range, counts retain unavailable versus zero',()=>{
 for(const raw of ['search=%','search=%GG','search=%FF','search=%ED%A0%80'])assert.throws(()=>replayHeatmapParams(raw));
 assert.equal(replayHeatmapParams('search=Saved+recording%20%F0%9F%8C%8D').get('search'),'Saved recording 🌍');
 assert.deepEqual(readHeatmapQuery('mode=pages&from=2026-01-01&to=2026-01-02'),{mode:'pages',from:'2026-01-01',to:'2026-01-02'});
 assert.deepEqual(readHeatmapQuery(new URLSearchParams('mode=pages&from=2026-01-01&to=2026-01-02')),{mode:'pages',from:'2026-01-01',to:'2026-01-02'});
 for(const query of ['mode=click','mode=pages&path=/','mode=pages&mode=pages','from=2026-01-01','from=2026-01-01&to=2027-01-02','from=2026-02-30&to=2026-03-01','unknown=1','mode=geometries&origin=https://example.test&path=/x?secret','mode=click&origin=https://example.test&path=/x&geometry='+ 'a'.repeat(64)+'&cursor=YQ'])assert.throws(()=>readHeatmapQuery(new URLSearchParams(query)));
 const report={version:1,projectId:randomUUID(),role:'viewer',enabled:false,query:readHeatmapQuery(new URLSearchParams('mode=click&origin=https://example.test&path=/page&geometry='+'a'.repeat(64))),asOf:'2026-01-03T00:00:00.000Z',retainedFrom:'2026-01-01T00:00:00.000Z',coverage:'complete',geometry,points:[],totals:{observations:0,captures:1,groups:0,returnedGroups:0,omittedGroups:0,limited:false}};assert.equal(heatmapClicks.parse(report).totals.observations,0);assert.equal(heatmapClicks.parse({...report,geometry:null,totals:{...report.totals,observations:null,captures:null,groups:null,returnedGroups:null,omittedGroups:null}}).totals.observations,null);
});

test('historical background ingress has two explicit purposes, exact locators and no DOM copy or caller clock origin',()=>{
 const locator={kind:'event' as const,sequence:0,index:0,chunkSha256:'a'.repeat(64),eventSha256:'b'.repeat(64)};
 const input={...begin,consent:{...begin.consent,replay:true as const},captureId:randomUUID(),heatmapToken:'h',recordingId:randomUUID(),replayToken:'r',batchRequestId:randomUUID(),geometryKey:'c'.repeat(64),geometry,heatmapOffsetMs:1,meta:locator,snapshot:{...locator,index:1}};
 assert.deepEqual(heatmapBackgroundUpload.parse(input),input);
 for(const patch of [{consent:begin.consent},{consent:{...input.consent,epoch:randomUUID(),advertising:true}},{heatmapOffsetMs:300001},{replayOffsetMs:0},{data:{node:{}}},{meta:{...locator,index:200}},{geometryKey:'bad'},{heatmapToken:'x'.repeat(4096)}])assert.equal(heatmapBackgroundUpload.safeParse({...input,...patch}).success,false);
 assert.equal(replayEventLocator.safeParse({kind:'fragment',fragmentId:randomUUID(),eventSha256:'d'.repeat(64)}).success,true);
 for(const extra of [{sequence:1},{index:0},{data:'private'}])assert.equal(replayEventLocator.safeParse({kind:'fragment',fragmentId:randomUUID(),eventSha256:'d'.repeat(64),...extra}).success,false);
});

test('unavailable historical backgrounds never carry chunk bytes or usable references',()=>{
 const q={from:'2026-10-10',to:'2026-10-11',mode:'click' as const,origin:'https://example.test',path:'/page',geometry:'a'.repeat(64)};
 const body={version:1,projectId:randomUUID(),role:'viewer',query:q,asOf:'2026-10-16T00:00:00Z',state:'expired',reference:null,item:null,chunks:[],nextAfter:null};
 assert.equal(heatmapBackgroundPage.safeParse(body).success,true);
 for(const patch of [{query:{...q,mode:'pages'}},{nextAfter:0},{reference:{}},{item:{}},{chunks:[{}]},{state:'available'}])assert.equal(heatmapBackgroundPage.safeParse({...body,...patch}).success,false);
});
