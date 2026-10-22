import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {defaultReplaySettings,replaySettings,replayBegin,replayUpload,readReplayChunk,reassembleReplay,replayLimits,replayPlaybackOption,replayRates,type ReplayPart} from '../src/lib/session-replay.ts';
const wire=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const base={siteKey:randomUUID(),requestId:randomUUID(),url:'https://example.test/path',consent:{analytics:true as const,replay:true as const,epoch:randomUUID()}};
const meta={type:4,timestamp:1,data:{href:base.url,width:320,height:600}},snapshot={type:2,timestamp:2,data:{node:{type:0,childNodes:[]},initialOffset:{left:0,top:0}}};

test('replay opt-in is separate, closed, bounded and preserves explicit zero sampling',()=>{
 assert.equal(replaySettings.parse(defaultReplaySettings).enabled,false);assert.equal(replaySettings.parse({...defaultReplaySettings,sampleRate:0}).sampleRate,0);for(const maxDurationMs of [300000,600000,900000,1200000])assert.equal(replaySettings.safeParse({...defaultReplaySettings,maxDurationMs}).success,true);
 for(const patch of [{sampleRate:-1},{sampleRate:1.1},{sampleRate:Infinity},{maxDurationMs:300001},{maskLevel:'none'},{blockSelector:'\0'},{blockSelector:'x'.repeat(1025)},{future:true}])assert.equal(replaySettings.safeParse({...defaultReplaySettings,...patch}).success,false);
 assert.equal(replayBegin.safeParse(base).success,true);for(const patch of [{consent:{analytics:true,epoch:base.consent.epoch}},{collection:{mode:'cookieless',epoch:base.consent.epoch}},{distinctId:'private'},{url:base.url+'?'},{url:base.url+'#'},{url:'https://name:secret@example.test/path'}])assert.equal(replayBegin.safeParse({...base,...patch}).success,false);
 const upload={siteKey:base.siteKey,url:base.url,consent:base.consent,token:'bounded',sequence:0,final:false,data:wire([])};assert.equal(replayUpload.safeParse(upload).success,true);for(const patch of [{sequence:-1},{sequence:1024},{token:'x'.repeat(4097)},{final:0},{requestId:base.requestId}])assert.equal(replayUpload.safeParse({...upload,...patch}).success,false);
});
test('canonical UTF8 chunks preserve bytes and reject malformed event envelopes and hostile trees',()=>{
 const encoded=wire([meta,snapshot]),chunk=readReplayChunk(encoded);assert.equal(Buffer.from(chunk.bytes).toString('base64url'),encoded);assert.deepEqual(reassembleReplay(chunk.parts),{events:[meta,snapshot],missingFragments:[],complete:true});
 for(const value of [encoded+'=',encoded+'\n','AA',Buffer.from([0xff]).toString('base64url'),wire([{...meta,future:true}]),wire([{...meta,data:{...meta.data,href:base.url+'?secret=1'}}]),wire([{type:6,timestamp:1,data:{}}]),wire([{type:3,timestamp:1,data:{source:99}}]),wire(Array.from({length:201},()=>meta))])assert.throws(()=>readReplayChunk(value));
 let nested:unknown={};for(let n=0;n<70;n++)nested={next:nested};assert.throws(()=>readReplayChunk(wire([{type:3,timestamp:1,data:{source:0,nested}}])));assert.throws(()=>readReplayChunk(wire([{type:3,timestamp:1,data:JSON.parse('{"source":0,"__proto__":{"private":true}}')}])));
});
test('large Unicode snapshots reassemble in original order; missing and conflicting parts stay explicit',()=>{
 const large={...snapshot,data:{node:{type:0,childNodes:[{type:3,textContent:'字'.repeat(180000)}]},initialOffset:{left:0,top:0}}},bytes=Buffer.from(JSON.stringify(large)),id=randomUUID(),pieces:ReplayPart[]=[];
 const size=100003,total=Math.ceil(bytes.length/size);for(let index=0;index<total;index++)pieces.push({type:'fragment',id,index,total,data:bytes.subarray(index*size,(index+1)*size).toString('base64url')});
 const accepted=pieces.map(p=>readReplayChunk(wire([p])).parts[0]);assert.deepEqual(reassembleReplay([meta,...accepted]).events,[meta,large]);assert.equal(reassembleReplay([meta,...accepted]).complete,true);const incomplete=reassembleReplay([meta,...accepted.slice(0,-1)]);assert.equal(incomplete.complete,false);assert.deepEqual(incomplete.missingFragments,[id]);
 assert.deepEqual(reassembleReplay([meta,...accepted,accepted[0]]).events,[meta,large]);const first=accepted[0];assert.equal(first.type,'fragment');if(first.type==='fragment')assert.throws(()=>reassembleReplay([first,{...first,data:wire('different')}]),/Conflicting/);
});
test('player playback options are closed: speeds 1/2/4/8 and a boolean inactivity skip only',()=>{
 assert.deepEqual([...replayRates],[1,2,4,8]);for(const value of replayRates)assert.deepEqual(replayPlaybackOption.parse({type:'speed',value}),{type:'speed',value});for(const value of [true,false])assert.deepEqual(replayPlaybackOption.parse({type:'skip-inactive',value}),{type:'skip-inactive',value});
 for(const candidate of [{type:'speed',value:0.5},{type:'speed',value:1.5},{type:'speed',value:16},{type:'speed',value:'8'},{type:'speed',value:NaN},{type:'speed'},{type:'speed',value:8,offset:0},{type:'skip-inactive',value:1},{type:'skip-inactive',value:'true'},{type:'skip-inactive',value:true,speed:8},{type:'skipInactive',value:true},{type:'play',offset:0},null,[],'speed'])assert.equal(replayPlaybackOption.safeParse(candidate).success,false,JSON.stringify(candidate));
});
test('fragment totals, event bytes, snapshot presence and unknown completeness remain bounded',()=>{
 const id=randomUUID();assert.throws(()=>readReplayChunk(wire([{type:'fragment',id,index:0,total:65,data:wire({})}])));assert.throws(()=>reassembleReplay([{type:'fragment',id,index:0,total:2,data:wire({})},{type:'fragment',id,index:1,total:3,data:wire({})}]));
 const piece=Buffer.alloc(replayLimits.chunkBytes,65).toString('base64url'),fragments:ReplayPart[]=Array.from({length:17},(_,index)=>({type:'fragment',id,index,total:17,data:piece}));assert.throws(()=>reassembleReplay(fragments),/event exceeds/);assert.equal(reassembleReplay([meta]).complete,false);assert.equal(reassembleReplay([snapshot]).complete,false);
});
