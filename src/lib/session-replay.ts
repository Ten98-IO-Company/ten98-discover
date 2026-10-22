import {z} from 'zod';

export const replayLimits=Object.freeze({chunkBytes:262144,eventsPerChunk:200,chunks:1024,recordingBytes:67108864,eventBytes:4194304,fragmentParts:64,depth:64,nodes:20000,drainMs:60000,pageSize:20,chunkPageSize:4});
const text=(max:number)=>z.string().max(max).refine(v=>!/\u0000|[\uD800-\uDFFF]/u.test(v));
export const replaySettings=z.object({enabled:z.boolean(),sampleRate:z.number().finite().min(0).max(1),maskLevel:z.enum(['strict','moderate']),maxDurationMs:z.union([z.literal(300000),z.literal(600000),z.literal(900000),z.literal(1200000)]),blockSelector:text(1024)}).strict();
export const defaultReplaySettings={enabled:false,sampleRate:0.15,maskLevel:'strict',maxDurationMs:300000,blockSelector:''} as const;
export type ReplaySettings=z.infer<typeof replaySettings>;
const url=text(4096).url().refine(v=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!/[?#]/.test(v)&&u.pathname.length<=2048;}catch{return false;}});
const consent=z.object({analytics:z.literal(true),replay:z.literal(true),epoch:z.uuid()}).strict();
export const replayBegin=z.object({siteKey:z.uuid(),requestId:z.uuid(),url,consent}).strict();
export const replayUpload=replayBegin.omit({requestId:true}).extend({token:z.string().min(1).max(4096),sequence:z.number().int().min(0).max(replayLimits.chunks-1),final:z.boolean(),data:z.string().min(1).max(Math.ceil(replayLimits.chunkBytes*4/3))}).strict();
export type ReplayBegin=z.infer<typeof replayBegin>;
const data=z.record(z.string(),z.unknown());
export const replayEvent=z.object({type:z.number().int().min(0).max(4),timestamp:z.number().finite().int().nonnegative().max(8640000000000000),data}).strict().superRefine((v,c)=>{
 if(v.type===4&&!z.object({href:url,width:z.number().int().min(1).max(20000),height:z.number().int().min(1).max(20000)}).strict().safeParse(v.data).success)c.addIssue({code:'custom',message:'Invalid replay viewport metadata.'});
 if(v.type===2&&(!v.data.node||typeof v.data.node!=='object'||Array.isArray(v.data.node)))c.addIssue({code:'custom',message:'A full snapshot requires serialized nodes.'});
 if(v.type===3&&(!Number.isInteger(v.data.source)||Number(v.data.source)<0||Number(v.data.source)>16))c.addIssue({code:'custom',message:'Unknown replay mutation source.'});
});
const fragment=z.object({type:z.literal('fragment'),id:z.uuid(),index:z.number().int().min(0).max(replayLimits.fragmentParts-1),total:z.number().int().min(1).max(replayLimits.fragmentParts),data:z.string().min(1).max(Math.ceil(replayLimits.chunkBytes*4/3))}).strict().refine(v=>v.index<v.total);
export const replayPart=z.union([replayEvent,fragment]);
export type ReplayEvent=z.infer<typeof replayEvent>;
export type ReplayPart=z.infer<typeof replayPart>;

/** Validate the complete JSON tree before recursive consumers touch untrusted rrweb data. */
export function boundedTree(value:unknown){const pending=[{value,depth:0}];let nodes=0;while(pending.length){const item=pending.pop()!;if(++nodes>replayLimits.nodes||item.depth>replayLimits.depth)throw Error('Replay JSON exceeds its structural limits.');const v=item.value;if(v===null||typeof v==='boolean')continue;if(typeof v==='number'){if(!Number.isFinite(v))throw Error('Nonfinite replay number.');continue;}if(typeof v==='string'){if(/\u0000|[\uD800-\uDFFF]/u.test(v))throw Error('Invalid replay text.');continue;}if(typeof v!=='object')throw Error('Invalid replay value.');for(const [key,child]of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(key))throw Error('Unsafe replay key.');pending.push({value:child,depth:item.depth+1});}}}
const base64urlAlphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
type HostBase64={Buffer?:{from(value:string,encoding:'base64url'):Uint8Array}};
type ProposedBase64={fromBase64?:(value:string,options:{alphabet:'base64url'})=>Uint8Array};
/**
 * Decode unpadded canonical base64url without a re-encoding round trip. Canonical form is proven
 * directly from the alphabet, a length that is not 1 mod 4 and zero unused bits in the last character.
 * The server decodes with Buffer; browsers use Uint8Array.fromBase64 where available, otherwise atob.
 */
export function replayBase64(value:string,max=replayLimits.chunkBytes){if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Use canonical replay bytes.');
 const tail=value.length%4;
 // An impossible length keeps atob's own InvalidCharacterError, as before.
 if(tail===1){atob(value.replaceAll('-','+').replaceAll('_','/'));throw Error('Use canonical replay bytes.');}
 if(Math.floor(value.length*3/4)>max)throw Error('Replay bytes exceed their limit.');
 if(tail&&base64urlAlphabet.indexOf(value[value.length-1])&(tail===2?15:3))throw Error('Use canonical replay bytes.');
 const host=(globalThis as HostBase64).Buffer;if(host){const bytes=host.from(value,'base64url');return new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);}
 const proposed=(Uint8Array as ProposedBase64).fromBase64;if(proposed)return proposed(value,{alphabet:'base64url'});
 const binary=atob(value.replaceAll('-','+').replaceAll('_','/')),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;}
function decode(value:Uint8Array){const parsed:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(value));boundedTree(parsed);return parsed;}
function readParts(bytes:Uint8Array){const parts=z.array(replayPart).max(replayLimits.eventsPerChunk).parse(decode(bytes));for(const part of parts)if(part.type==='fragment')replayBase64(part.data);return parts;}
export function readReplayChunk(value:string){const bytes=replayBase64(value);return{bytes,parts:readParts(bytes)};}
/** Revalidate stored chunk bytes directly, under the same limits as their canonical wire form. */
export function readStoredReplayChunk(bytes:Uint8Array){if(!bytes.length)throw Error('Use canonical replay bytes.');if(bytes.length>replayLimits.chunkBytes)throw Error('Replay bytes exceed their limit.');return{bytes,parts:readParts(bytes)};}
/** Missing fragment groups remain explicit; callers must not label the result complete. */
export function reassembleReplay(parts:readonly ReplayPart[]){const pending=new Map<string,{total:number;parts:Map<number,Uint8Array>;bytes:number}>(),order:Array<ReplayEvent|string>=[];
 for(const part of parts){if(part.type!=='fragment'){order.push(part);continue;}let group=pending.get(part.id);if(!group){group={total:part.total,parts:new Map(),bytes:0};pending.set(part.id,group);order.push(part.id);}if(group.total!==part.total)throw Error('Conflicting replay fragments.');const bytes=replayBase64(part.data),prior=group.parts.get(part.index);if(prior){if(prior.length!==bytes.length||prior.some((v,i)=>v!==bytes[i]))throw Error('Conflicting replay fragments.');continue;}group.bytes+=bytes.length;if(group.bytes>replayLimits.eventBytes)throw Error('Replay event exceeds its limit.');group.parts.set(part.index,bytes);}
 const events:ReplayEvent[]=[],missing:string[]=[];for(const item of order){if(typeof item!=='string'){events.push(item);continue;}const group=pending.get(item)!;if(group.parts.size!==group.total){missing.push(item);continue;}const bytes=new Uint8Array(group.bytes);let at=0;for(let i=0;i<group.total;i++){const part=group.parts.get(i)!;bytes.set(part,at);at+=part.length;}events.push(replayEvent.parse(decode(bytes)));}
 return{events,missingFragments:missing,complete:missing.length===0&&events.some(e=>e.type===2)&&events.some(e=>e.type===4)};
}
export const replaySummary=z.object({id:z.uuid(),createdAt:z.string().datetime(),deadlineAt:z.string().datetime(),origin:z.string(),entryPath:z.string().nullable(),settings:replaySettings,chunkCount:z.number().int().nonnegative().max(replayLimits.chunks),bytes:z.number().int().nonnegative().max(replayLimits.recordingBytes),lastSequence:z.number().int().nonnegative().max(replayLimits.chunks-1).nullable(),complete:z.boolean(),missingChunks:z.number().int().nonnegative().nullable(),missingFragments:z.number().int().nonnegative().nullable(),resultExpired:z.boolean()}).strict();
export type ReplaySummary=z.infer<typeof replaySummary>;
export const replayChunkDto=z.object({sequence:z.number().int().nonnegative().max(replayLimits.chunks-1),final:z.boolean(),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative().max(replayLimits.chunkBytes),parts:z.array(replayPart).max(replayLimits.eventsPerChunk)}).strict();
// Playback options posted to the isolated player; public/replay.js repeats this closed check on its side of the MessagePort.
export const replayRates=[1,2,4,8] as const;
export const replayPlaybackOption=z.discriminatedUnion('type',[z.object({type:z.literal('speed'),value:z.literal(replayRates)}).strict(),z.object({type:z.literal('skip-inactive'),value:z.boolean()}).strict()]);
export type ReplayPlaybackOption=z.infer<typeof replayPlaybackOption>;
