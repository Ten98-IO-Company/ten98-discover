import {z} from 'zod';
import {analyticsDay} from './navigation.ts';
import {replaySummary,replayChunkDto} from './session-replay.ts';

const clean=(value:string)=>!/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
const name=z.string().trim().min(1).max(100).refine(clean),revision=z.number().int().min(0).max(2147483647);
export const savedReplay=z.object({name:name.nullable(),revision,savedAt:z.string().datetime().nullable()}).strict().refine(v=>(v.name===null)===(v.savedAt===null)&&(v.name===null||v.revision>0));
export const savedReplayWrite=z.object({requestId:z.uuid(),revision,action:z.enum(['save','rename','unsave']),name:name.nullable()}).strict().refine(v=>v.action==='unsave'?v.name===null:v.name!==null);
export type SavedReplayWrite=z.infer<typeof savedReplayWrite>;
const role=z.enum(['owner','admin','editor','viewer']);
export const savedReplayPoint=z.object({role,asOf:z.string().datetime(),item:replaySummary,saved:savedReplay}).strict();
export const savedReplayAck=z.object({role,request:savedReplayWrite.safeExtend({recordingId:z.uuid()}),appliedRevision:revision,replayed:z.boolean()}).strict();
export const savedReplayList=z.object({role,asOf:z.string().datetime(),retainedFrom:z.string().datetime(),items:z.array(z.object({recording:replaySummary,saved:savedReplay}).strict()).max(20),nextCursor:z.string().max(512).nullable()}).strict();
export const heatmapSettings=z.object({enabled:z.boolean(),sampleRate:z.number().finite().min(0).max(1)}).strict();
export const defaultHeatmapSettings={enabled:false,sampleRate:0.15} as const;
export const heatmapLimits=Object.freeze({batchBytes:32768,observations:20,captureBatches:256,captureBytes:8388608,captureMs:300000,drainMs:60000,extent:10000000,viewport:20000,pageSize:20,points:5000});
const extent=z.number().finite().positive().max(heatmapLimits.extent),position=z.number().finite().nonnegative().max(heatmapLimits.extent);
export const heatmapGeometry=z.object({basis:z.literal('document-css-v1'),direction:z.enum(['ltr','rtl']),pageWidth:extent,pageHeight:extent,viewportWidth:z.number().finite().positive().max(heatmapLimits.viewport),viewportHeight:z.number().finite().positive().max(heatmapLimits.viewport)}).strict();
const offsetMs=z.number().finite().nonnegative().max(heatmapLimits.captureMs);
const rawPosition=z.number().finite().min(-heatmapLimits.extent).max(heatmapLimits.extent);
// Native raw CSS measurements accompany each point. The collector's transform
// must be calibrated at RTL/zoom; direction alone is not a coordinate transform.
export const heatmapObservation=z.discriminatedUnion('kind',[z.object({kind:z.literal('click'),x:position,y:position,clientX:rawPosition,clientY:rawPosition,scrollX:rawPosition,scrollY:position,offsetMs}).strict(),z.object({kind:z.literal('scroll'),scrollX:rawPosition,scrollY:position,offsetMs}).strict()]);
const path=z.string().min(1).max(2048).startsWith('/').refine(v=>clean(v)&&!/[?#]/.test(v)&&(()=>{try{decodeURIComponent(v);return true;}catch{return false;}})());
const origin=z.string().max(2048).refine(v=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&u.origin===v;}catch{return false;}});
export const heatmapBegin=z.object({siteKey:z.uuid(),requestId:z.uuid(),url:z.string().max(4096).url().refine(v=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!/[?#]/.test(v)&&clean(v)&&path.safeParse(u.pathname).success;}catch{return false;}}),consent:z.object({analytics:z.literal(true),epoch:z.uuid()}).strict()}).strict();
export const heatmapBatch=heatmapBegin.extend({captureId:z.uuid(),token:z.string().min(1).max(4096),geometry:heatmapGeometry,observations:z.array(heatmapObservation).min(1).max(heatmapLimits.observations)}).strict().superRefine((v,c)=>{let previous=0;for(const p of v.observations){if(p.offsetMs<previous)c.addIssue({code:'custom',message:'Observation offsets must be monotonic.'});previous=p.offsetMs;if(p.scrollY>Math.max(0,v.geometry.pageHeight-v.geometry.viewportHeight)+1)c.addIssue({code:'custom',message:'Scroll coordinates must use the declared document plane.'});if(p.kind==='click'&&(p.x>v.geometry.pageWidth||p.y>v.geometry.pageHeight))c.addIssue({code:'custom',message:'Click coordinates must use the declared document plane.'});}if(new TextEncoder().encode(JSON.stringify(v)).length>heatmapLimits.batchBytes)c.addIssue({code:'custom',message:'Heatmap batch exceeds its disclosed byte limit.'});});
// References only: DOM remains in the original replay chunks and has its own retention.
export const replayEventLocator=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('event'),sequence:z.number().int().min(0).max(1023),index:z.number().int().min(0).max(199),chunkSha256:z.string().regex(/^[a-f0-9]{64}$/),eventSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 z.object({kind:z.literal('fragment'),fragmentId:z.uuid(),eventSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
]);
export type ReplayEventLocator=z.infer<typeof replayEventLocator>;
export const heatmapBackgroundUpload=heatmapBegin.extend({
 consent:z.object({analytics:z.literal(true),replay:z.literal(true),epoch:z.uuid()}).strict(),
 captureId:z.uuid(),heatmapToken:z.string().min(1).max(4096),recordingId:z.uuid(),replayToken:z.string().min(1).max(4096),
 batchRequestId:z.uuid(),geometryKey:z.string().regex(/^[a-f0-9]{64}$/),geometry:heatmapGeometry,
 heatmapOffsetMs:offsetMs,meta:replayEventLocator,snapshot:replayEventLocator
}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).length<=4096);
export const heatmapBackgroundReference=z.object({captureId:z.uuid(),recordingId:z.uuid(),geometryKey:z.string().regex(/^[a-f0-9]{64}$/),geometry:heatmapGeometry,
 heatmapOffsetMs:offsetMs,replayOffsetMs:z.number().int().min(0).max(1200000),meta:replayEventLocator,snapshot:replayEventLocator,
 observedAt:z.string().datetime(),sequences:z.array(z.number().int().min(0).max(1023)).min(1).max(128)
}).strict().refine(v=>v.sequences.every((n,i)=>i===0||n>v.sequences[i-1]));
export function heatmapPlane(g:z.infer<typeof heatmapGeometry>){return{basis:g.basis,direction:g.direction,pageWidth:g.pageWidth,pageHeight:g.pageHeight,viewportWidth:g.viewportWidth,viewportHeight:g.viewportHeight};}
export function heatmapDepth(g:z.infer<typeof heatmapGeometry>,scrollY:number){return Math.min(100,100*(scrollY+g.viewportHeight)/g.pageHeight);}
export type HeatmapQuery={from:string;to:string;mode:'pages'|'geometries'|'click'|'scroll';origin?:string;path?:string;geometry?:string;cursor?:string};
export function replayHeatmapParams(raw:URLSearchParams|string):URLSearchParams{
 if(typeof raw!=='string')return raw;
 if(raw.length>6144)throw Error('The replay or heatmap link is too long.');
 try{decodeURIComponent(raw.replace(/\+/g,' '));}catch{throw Error('The replay or heatmap link has invalid encoding.');}
 return new URLSearchParams(raw);
}
export function readHeatmapQuery(raw:URLSearchParams|string,now=new Date()):HeatmapQuery{
 const params=replayHeatmapParams(raw);
 const allowed=['from','to','mode','origin','path','geometry','cursor'];if(params.toString().length>6144||[...params.keys()].some(k=>!allowed.includes(k)||params.getAll(k).length!==1)||params.has('from')!==params.has('to'))throw Error('Use each supported heatmap filter once.');
 const to=params.get('to')??now.toISOString().slice(0,10),from=params.get('from')??new Date((analyticsDay(to)??NaN)-6*86400000).toISOString().slice(0,10),a=analyticsDay(from),b=analyticsDay(to);if(a===null||b===null||a>b||(b-a)/86400000>=366)throw Error('Choose1 to366 valid UTC days.');
 const mode=z.enum(['pages','geometries','click','scroll']).parse(params.get('mode')??'pages'),o=params.get('origin'),p=params.get('path'),g=params.get('geometry'),cursor=params.get('cursor');
 if(mode==='pages'?(o!==null||p!==null||g!==null):(o===null||p===null||!origin.safeParse(o).success||!path.safeParse(p).success))throw Error('Choose the exact captured page.');
 if(['click','scroll'].includes(mode)?g===null||!/^[a-f0-9]{64}$/.test(g)||cursor!==null:g!==null)throw Error('Choose one captured geometry.');if(cursor!==null&&(!/^[A-Za-z0-9_-]+$/.test(cursor)||cursor.length>512))throw Error('Use a valid heatmap page cursor.');
 return{from,to,mode,...o===null?{}:{origin:o},...p===null?{}:{path:p},...g===null?{}:{geometry:g},...cursor===null?{}:{cursor}};
}
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),key=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime();
const queryShape=z.object({from:z.string(),to:z.string(),mode:z.enum(['pages','geometries','click','scroll']),origin:origin.optional(),path:path.optional(),geometry:key.optional(),cursor:z.string().max(512).optional()}).strict();
const reportBase={version:z.literal(1),projectId:z.uuid(),role,enabled:z.boolean(),query:queryShape,asOf:instant,retainedFrom:instant,coverage:z.enum(['complete','partial','unavailable'])};
export const heatmapPages=z.object({...reportBase,items:z.array(z.object({key,origin,path,captures:count}).strict()).max(20),nextCursor:z.string().max(512).nullable()}).strict().refine(v=>v.query.mode==='pages'&&(v.nextCursor===null||v.items.length===20)&&new Set(v.items.map(i=>i.key)).size===v.items.length);
export const heatmapGeometries=z.object({...reportBase,items:z.array(z.object({key,geometry:heatmapGeometry,captures:count}).strict()).max(20),nextCursor:z.string().max(512).nullable()}).strict().refine(v=>v.query.mode==='geometries'&&(v.nextCursor===null||v.items.length===20)&&new Set(v.items.map(i=>i.key)).size===v.items.length);
export const heatmapClicks=z.object({...reportBase,geometry:heatmapGeometry.nullable(),points:z.array(z.object({x:position,y:position,count}).strict()).max(5000),totals:z.object({observations:count.nullable(),captures:count.nullable(),groups:count.nullable(),returnedGroups:count.nullable(),omittedGroups:count.nullable(),limited:z.boolean()}).strict()}).strict().superRefine((v,c)=>{
 const t=v.totals,g=v.geometry,unavailable=g===null||v.coverage==='unavailable';if(v.query.mode!=='click'||(unavailable?[t.observations,t.captures,t.groups,t.returnedGroups,t.omittedGroups].some(n=>n!==null)||v.points.length!==0||t.limited:[t.observations,t.captures,t.groups,t.returnedGroups,t.omittedGroups].some(n=>n===null)||t.returnedGroups!==v.points.length||t.groups!==(t.returnedGroups??0)+(t.omittedGroups??0)||t.limited!==((t.omittedGroups??0)>0)))c.addIssue({code:'custom',message:'Heatmap counts must preserve exact omission and unavailable states.'});
 if(g&&v.points.some(p=>p.x>g.pageWidth||p.y>g.pageHeight||p.count===0)||new Set(v.points.map(p=>JSON.stringify([p.x,p.y]))).size!==v.points.length||t.observations!==null&&(t.observations<v.points.reduce((n,p)=>n+p.count,0)||!t.limited&&t.observations!==v.points.reduce((n,p)=>n+p.count,0)))c.addIssue({code:'custom',message:'Invalid grouped heatmap points.'});
});
export const heatmapScroll=z.object({...reportBase,geometry:heatmapGeometry.nullable(),captures:count.nullable(),bands:z.array(z.object({depth:z.number().int().min(10).max(100),captures:count.nullable()}).strict()).length(10)}).strict().refine(v=>v.query.mode==='scroll'&&v.bands.every((b,i)=>b.depth===(i+1)*10&&(v.geometry===null||v.coverage==='unavailable'?v.captures===null&&b.captures===null:v.captures!==null&&b.captures!==null&&b.captures<=v.captures&&(i===0||b.captures<=(v.bands[i-1].captures??-1)))));

export const heatmapBackgroundPage=z.object({version:z.literal(1),projectId:z.uuid(),role,query:queryShape,asOf:instant,
 state:z.enum(['available','missing','expired','incomplete','unsupported']),
 reference:heatmapBackgroundReference.nullable(),item:replaySummary.nullable(),
 chunks:z.array(replayChunkDto).max(4),nextAfter:z.number().int().min(0).max(1023).nullable()
}).strict().superRefine((v,c)=>{
 if(!['click','scroll'].includes(v.query.mode)||v.query.cursor!==undefined)c.addIssue({code:'custom',message:'Choose one exact geometry.'});
 if(v.state!=='available'){
  if(v.reference!==null||v.item!==null||v.chunks.length||v.nextAfter!==null)c.addIssue({code:'custom',message:'Unavailable backgrounds cannot reveal content references.'});
  return;
 }
 const r=v.reference,item=v.item;
 if(!r||!item||item.resultExpired||item.id!==r.recordingId||item.origin!==v.query.origin||item.entryPath===null||r.geometryKey!==v.query.geometry||
   v.chunks.some((chunk,i)=>!r.sequences.includes(chunk.sequence)||i>0&&chunk.sequence<=v.chunks[i-1].sequence)||
   v.nextAfter!==null&&(v.chunks.length!==4||v.nextAfter!==v.chunks.at(-1)?.sequence))c.addIssue({code:'custom',message:'Background pages must bind one retained recording and geometry.'});
});

export type HeatmapOverlay={geometry:z.infer<typeof heatmapGeometry>} & (
 {mode:'click';points:{x:number;y:number;count:number}[]} |
 {mode:'scroll';captures:number;bands:{depth:number;captures:number}[]}
);
