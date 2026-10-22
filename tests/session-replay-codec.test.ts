import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {replayBase64,readReplayChunk,readStoredReplayChunk,replayLimits} from '../src/lib/session-replay.ts';
import {assembleStoredReplay} from '../src/server/session-replay.ts';

// The previous decode-and-re-encode codec is the oracle for strict canonical behavior.
function reference(value:string,max:number=replayLimits.chunkBytes){if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Use canonical replay bytes.');const bytes=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));if(bytes.length>max)throw Error('Replay bytes exceed their limit.');let encoded='';for(let i=0;i<bytes.length;i+=16384)encoded+=String.fromCharCode(...bytes.subarray(i,i+16384));if(btoa(encoded).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')!==value)throw Error('Use canonical replay bytes.');return bytes;}
function outcome(decode:()=>Uint8Array){try{const bytes=decode();return{ok:true,type:Object.getPrototypeOf(bytes)===Uint8Array.prototype,bytes:[...bytes]};}catch(error){const e=error as Error;return{ok:false,name:e.name,message:e.message,dom:e instanceof DOMException};}}
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function inputs(){const values:Array<[string,number?]>=[];
 for(const a of alphabet)for(const b of alphabet)values.push([a+b]);
 for(const a of alphabet)for(const b of 'AQgw_-9z')for(const c of alphabet)values.push(['AAA'+a+b+c]);
 for(let n=0;n<=300;n++){const raw=randomBytes(n);values.push([raw.toString('base64url')],[raw.toString('base64')],[raw.toString('base64url'),Math.max(0,n-1)],[raw.toString('base64url'),n]);}
 values.push([''],['A'],['AAAAA'],['AA=='],['AA='],['A A'],['AA\n'],['ÀA'],['AAA\u0000'],['+/'],['AB'],['AAB'],['AAAAAAAAAAAAAAAAB'],['AAAA'.repeat(100)+'A'],['A'.repeat(8),5],['A'.repeat(7),5],['A'.repeat(7),4]);
 return values;}
// The production signature only admits its default limit; the oracle also exercises smaller limits.
const decodeWith=replayBase64 as (value:string,max?:number)=>Uint8Array;
function withoutBuffer<T>(work:()=>T){const host=globalThis as {Buffer?:unknown},saved=host.Buffer;delete host.Buffer;try{return work();}finally{host.Buffer=saved;}}

test('replay base64 decodes valid input byte-exactly and rejects invalid input identically on server and browser paths',()=>{
 let accepted=0,rejected=0;
 for(const[value,max]of inputs()){const expected=outcome(()=>reference(value,max));
  assert.deepEqual(outcome(()=>decodeWith(value,max)),expected,`Buffer path differs for ${JSON.stringify(value)} max=${max}`);
  assert.deepEqual(withoutBuffer(()=>outcome(()=>decodeWith(value,max))),expected,`atob path differs for ${JSON.stringify(value)} max=${max}`);
  if(expected.ok)accepted++;else rejected++;}
 assert.ok(accepted>1000&&rejected>1000);
 const raw=randomBytes(replayLimits.chunkBytes),wire=raw.toString('base64url');assert.deepEqual(Buffer.from(replayBase64(wire)),raw);assert.deepEqual(Buffer.from(withoutBuffer(()=>replayBase64(wire))),raw);
 assert.throws(()=>replayBase64(randomBytes(replayLimits.chunkBytes+1).toString('base64url')),/exceed their limit/);
 // Stored bytes skip the wire round trip but keep the same parsed parts and limits.
 const chunk=Buffer.from(JSON.stringify([{type:3,timestamp:1,data:{source:0}}]));assert.deepEqual(readStoredReplayChunk(chunk).parts,readReplayChunk(chunk.toString('base64url')).parts);
 assert.throws(()=>readStoredReplayChunk(new Uint8Array()),/canonical/);assert.throws(()=>readStoredReplayChunk(new Uint8Array(replayLimits.chunkBytes+1)),/exceed their limit/);
});

const fastest=(work:()=>unknown,runs:number)=>{let best=Infinity;for(let n=0;n<runs;n++){const start=performance.now();work();best=Math.min(best,performance.now()-start);}return best;};
test('256 KiB replay decoding stays within a generous time bound',()=>{
 const wire=randomBytes(replayLimits.chunkBytes).toString('base64url');replayBase64(wire);
 // The previous codec took about 60 ms per 256 KiB chunk; this one takes about 1 ms.
 assert.ok(fastest(()=>replayBase64(wire),5)<20,'256 KiB replay decoding exceeded 20 ms');
});
test('256-chunk whole-recording revalidation stays within a generous time bound',()=>{
 const origin='https://replay.performance.test',payloads=Array.from({length:256},(_,sequence)=>{const events:unknown[]=sequence?[]:[{type:4,timestamp:1,data:{href:origin+'/public',width:320,height:600}},{type:2,timestamp:2,data:{node:{type:0,childNodes:[]},initialOffset:{left:0,top:0}}}];
  while(events.length<replayLimits.eventsPerChunk)events.push({type:3,timestamp:10+sequence*200+events.length,data:{source:0,adds:[{parentId:1,nextId:null,node:{type:3,id:events.length,textContent:'x'.repeat(1100)}}],removes:[],texts:[],attributes:[]}});
  const bytes=Buffer.from(JSON.stringify(events));assert.ok(bytes.length>240000&&bytes.length<=replayLimits.chunkBytes);return bytes;});
 // Completion revalidates every stored chunk; the previous path took about 8.6 s for these 256 chunks.
 let result:ReturnType<typeof assembleStoredReplay>|undefined;const elapsed=fastest(()=>{result=assembleStoredReplay(payloads);},1);
 assert.deepEqual(result,{complete:true,missing:0,metadata:[{type:4,timestamp:1,data:{href:origin+'/public',width:320,height:600}}]});
 assert.ok(elapsed<2000,`256-chunk replay revalidation took ${Math.round(elapsed)} ms`);
});
