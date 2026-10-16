import {createHash,createHmac,randomInt,randomUUID,timingSafeEqual} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {getDatabase} from './db.ts';
import {getConfig} from './config.ts';
import {FoundationError} from './auth.ts';
import {analyticsPathExcluded,nativeCollectionPolicy,publicAnalyticsSettings,trackingConsentEpoch} from './native-analytics.ts';
import {contentCursor,readContentCursor} from './project-context.ts';
import {eventPath} from './validation.ts';
import {replayBegin,replayUpload,replaySettings,defaultReplaySettings,replayLimits,replaySummary,replayChunkDto,readReplayChunk,reassembleReplay,type ReplayBegin,type ReplayPart,type ReplaySettings} from '../lib/session-replay.ts';

const invalid=()=>new FoundationError(400,'Check the replay request and bounded chunk bytes.');
const absent=()=>new FoundationError(404,'Recording not found or unavailable.');
const changed=()=>new FoundationError(409,'The recording capability, sequence or current policy changed.');
const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const epochToken=z.object({version:z.literal(1),id:z.uuid(),projectId:z.uuid(),origin:z.string().max(2048),epoch:z.uuid(),settingsHash:z.string().regex(/^[a-f0-9]{64}$/),until:z.number().int().nonnegative()}).strict();
function sign(body:string){return createHmac('sha256',getConfig().authSecret).update('ten98.replay-upload.v1:'+body).digest('hex');}
function token(row:Row){const body=Buffer.from(JSON.stringify({version:1,id:row.id,projectId:row.project_id,origin:row.origin,epoch:row.epoch,settingsHash:row.settings_hash,until:row.upload_until.getTime()})).toString('base64url');return body+'.'+sign(body);}
function readToken(value:string){try{if(!/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value))throw changed();const[body,signature]=value.split('.');if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(sign(body),'hex')))throw changed();const raw=Buffer.from(body,'base64url');if(raw.toString('base64url')!==body)throw changed();return epochToken.parse(JSON.parse(raw.toString('utf8')));}catch{throw changed();}}
type Row={id:string;project_id:string;request_id:string;request_hash:string;origin:string;entry_path:string|null;epoch:string;settings:ReplaySettings;settings_hash:string;sampled:boolean;created_at:Date;deadline_at:Date;upload_until:Date;chunk_count:number;byte_count:number;last_sequence:number|null;first_event_timestamp:string|null;last_event_timestamp:string|null;complete:boolean;missing_fragments:number|null};
type Scope={role:'owner'|'admin'|'editor'|'viewer';cutoff:string;at:string};
export function summary(row:Row,expired=false){return replaySummary.parse({id:row.id,createdAt:row.created_at.toISOString(),deadlineAt:row.deadline_at.toISOString(),origin:row.origin,entryPath:expired?null:row.entry_path,settings:row.settings,chunkCount:expired?0:row.chunk_count,bytes:expired?0:row.byte_count,lastSequence:expired?null:row.last_sequence,complete:!expired&&row.complete,missingChunks:expired||row.last_sequence===null?null:row.last_sequence+1-row.chunk_count,missingFragments:expired?null:row.missing_fragments,resultExpired:expired});}
export async function transaction<T>(work:(client:PoolClient)=>Promise<T>){const client=await getDatabase().pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='5s'");const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'Replay is temporarily unavailable. Retry only the same recording or chunk.');throw error;}finally{client.release();}}
async function collection<T>(request:Request,input:ReplayBegin|z.infer<typeof replayUpload>,work:(client:PoolClient,projectId:string,settings:ReplaySettings,epoch:string,at:Date)=>Promise<T>){return transaction(async client=>{
 await client.query('SELECT id FROM project WHERE public_key=$1 FOR SHARE',[input.siteKey]);
 const policy=await nativeCollectionPolicy(client,request,input.siteKey,input,'replay'),settings=policy.project?publicAnalyticsSettings(policy.project.analytics_settings).replay??defaultReplaySettings:defaultReplaySettings;
 if(policy.reason||!settings.enabled)throw new FoundationError(403,'Current explicit replay permission and an enabled recorder are required.');
 const at=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
 return work(client,policy.project.id,settings,trackingConsentEpoch(policy.project.analytics_epoch,policy.project.destination_epoch),at);
 });}
export async function beginSessionReplay(request:Request,raw:unknown){const input=replayBegin.parse(raw);return collection(request,input,async(client,projectId,settings,epoch,at)=>{
 const requestHash=digest(JSON.stringify(input)),settingsHash=digest(JSON.stringify(settings));
 // The project gate serializes publication, while the unique request key resolves concurrent lost-ACK retries.
 const sampled=randomInt(1000000)<Math.floor(settings.sampleRate*1000000),deadline=new Date(at.getTime()+settings.maxDurationMs),until=new Date(deadline.getTime()+replayLimits.drainMs);
 await client.query(`INSERT INTO session_recording(id,project_id,request_id,request_hash,origin,entry_path,epoch,settings,settings_hash,sampled,created_at,deadline_at,upload_until)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(project_id,request_id) DO NOTHING`,[randomUUID(),projectId,input.requestId,requestHash,new URL(input.url).origin,eventPath(input.url),epoch,JSON.stringify(settings),settingsHash,sampled,at,deadline,until]);
 const row=(await client.query<Row>('SELECT * FROM session_recording WHERE project_id=$1 AND request_id=$2 FOR UPDATE',[projectId,input.requestId])).rows[0];
 const current=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
 if(row.request_hash!==requestHash||row.epoch!==epoch||row.settings_hash!==settingsHash||row.upload_until<=current)throw changed();
 return{accepted:row.sampled,reason:row.sampled?null:'not_sampled',recordingId:row.id,token:row.sampled?token(row):null,createdAt:row.created_at.toISOString(),deadlineAt:row.deadline_at.toISOString(),uploadUntil:row.upload_until.toISOString(),settings:row.settings,limits:replayLimits};
 });}
function checkMetadata(parts:readonly ReplayPart[],origin:string,excludedPaths:string[]){for(const part of parts)if(part.type===4){const url=new URL(String(part.data.href));if(url.origin!==origin||analyticsPathExcluded(url.pathname,excludedPaths))throw invalid();}}
export async function uploadSessionReplay(request:Request,raw:unknown){const input=replayUpload.parse(raw),capability=readToken(input.token);let chunk:ReturnType<typeof readReplayChunk>;try{chunk=readReplayChunk(input.data);}catch{throw invalid();}
 return collection(request,input,async(client,projectId,settings,epoch)=>{
 const row=(await client.query<Row>('SELECT * FROM session_recording WHERE id=$1 AND project_id=$2 FOR UPDATE',[capability.id,projectId])).rows[0];
 const at=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
 if(!row||!row.sampled||row.origin!==new URL(input.url).origin||capability.projectId!==projectId||capability.origin!==row.origin||capability.epoch!==epoch||row.epoch!==epoch||capability.settingsHash!==row.settings_hash||row.settings_hash!==digest(JSON.stringify(settings))||capability.until!==row.upload_until.getTime()||at.getTime()>=capability.until)throw changed();
 const policy=(await client.query('SELECT analytics_settings FROM project WHERE id=$1',[projectId])).rows[0];checkMetadata(chunk.parts,row.origin,publicAnalyticsSettings(policy.analytics_settings).excludedPaths);
 const sha256=digest(Buffer.concat([Buffer.from(input.sequence+':'+input.final+':'),chunk.bytes]));
 const prior=(await client.query('SELECT sha256 FROM session_recording_chunk WHERE recording_id=$1 AND sequence=$2',[row.id,input.sequence])).rows[0];
 if(prior){if(prior.sha256!==sha256)throw changed();return{accepted:true,duplicate:true,recordingId:row.id,sequence:input.sequence,sha256,complete:row.complete};}
 if(row.complete||row.last_sequence!==null&&input.sequence>row.last_sequence||input.final&&row.last_sequence!==null&&row.last_sequence!==input.sequence||input.final&&(await client.query('SELECT 1 FROM session_recording_chunk WHERE recording_id=$1 AND sequence>$2 LIMIT 1',[row.id,input.sequence])).rowCount)throw changed();
 if(row.chunk_count>=replayLimits.chunks||row.byte_count+chunk.bytes.length>replayLimits.recordingBytes)throw new FoundationError(413,'The recording reached its disclosed byte or chunk limit.');
 const fragmentIds=[...new Set(chunk.parts.flatMap(p=>p.type==='fragment'?[p.id]:[]))];
 await client.query('INSERT INTO session_recording_chunk(recording_id,sequence,final,sha256,payload,fragment_ids)VALUES($1,$2,$3,$4,$5,$6)',[row.id,input.sequence,input.final,sha256,Buffer.from(chunk.bytes),fragmentIds]);
 // Validate newly completed fragment groups before any partial recording is readable.
 let observed=chunk.parts.filter(p=>p.type!=='fragment');
 if(fragmentIds.length){const related=(await client.query<{payload:Buffer}>('SELECT payload FROM session_recording_chunk WHERE recording_id=$1 AND fragment_ids&&$2::uuid[] ORDER BY sequence',[row.id,fragmentIds])).rows;try{const assembled=reassembleReplay(related.flatMap(v=>readReplayChunk(v.payload.toString('base64url')).parts).filter(p=>p.type==='fragment'&&fragmentIds.includes(p.id)));checkMetadata(assembled.events,row.origin,publicAnalyticsSettings(policy.analytics_settings).excludedPaths);observed=[...observed,...assembled.events];}catch{throw invalid();}}
 const times=observed.map(p=>p.timestamp),minimum=Math.min(...times,...(row.first_event_timestamp===null?[]:[Number(row.first_event_timestamp)])),maximum=Math.max(...times,...(row.last_event_timestamp===null?[]:[Number(row.last_event_timestamp)]));
 if(times.length&&maximum-minimum>row.settings.maxDurationMs)throw invalid();
 const last=input.final?input.sequence:row.last_sequence,count=row.chunk_count+1;let complete=false,missing:number|null=null;
 if(last!==null&&count===last+1){
  const stored=(await client.query<{payload:Buffer}>('SELECT payload FROM session_recording_chunk WHERE recording_id=$1 ORDER BY sequence',[row.id])).rows;
  try{const assembled=reassembleReplay(stored.flatMap(v=>readReplayChunk(v.payload.toString('base64url')).parts));checkMetadata(assembled.events,row.origin,publicAnalyticsSettings(policy.analytics_settings).excludedPaths);complete=assembled.complete;missing=assembled.missingFragments.length;}catch{throw invalid();}
 }
 await client.query('UPDATE session_recording SET chunk_count=$2,byte_count=byte_count+$3,last_sequence=$4,complete=$5,missing_fragments=$6,first_event_timestamp=$7,last_event_timestamp=$8 WHERE id=$1',[row.id,count,chunk.bytes.length,last,complete,missing,Number.isFinite(minimum)?minimum:null,Number.isFinite(maximum)?maximum:null]);
 return{accepted:true,duplicate:false,recordingId:row.id,sequence:input.sequence,sha256,complete};
 });}
export async function readScope<T>(projectId:string,userId:string,work:(client:PoolClient,scope:Scope)=>Promise<T>){if(!z.uuid().safeParse(projectId).success)throw invalid();return transaction(async client=>{
 const hint=(await client.query('SELECT workspace_id FROM project WHERE id=$1',[projectId])).rows[0]?.workspace_id;if(!hint)throw absent();
 await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[hint]);
 const scope=(await client.query<Scope>(`WITH clock AS MATERIALIZED(SELECT clock_timestamp() AS at) SELECT m.role,
 to_char(c.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
 to_char(GREATEST(p.replay_retained_from,c.at-w.replay_days*interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff
 FROM project p JOIN workspace w ON w.id=p.workspace_id JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 CROSS JOIN clock c WHERE p.id=$1 AND m.role IN('owner','admin','editor','viewer')`,[projectId,userId])).rows[0];if(!scope)throw absent();
 const result=await work(client,scope);if(Buffer.byteLength(JSON.stringify(result),'utf8')>2097152)throw new FoundationError(503,'The replay page is too large.');return result;
 });}
export async function listSessionReplays(projectId:string,userId:string,params:URLSearchParams){if([...params.keys()].some(k=>k!=='cursor')||params.getAll('cursor').length>1||params.toString().length>2048)throw invalid();const bound={projectId,list:'replays'},cursor=readContentCursor(params.get('cursor'),bound);return readScope(projectId,userId,async(client,scope)=>{
 // The shared wire cursor rounds to milliseconds; keyset against its native retained anchor.
 if(cursor){const anchor=(await client.query('SELECT created_at FROM session_recording WHERE project_id=$1 AND id=$2 AND sampled AND created_at>=$3',[projectId,cursor.id,scope.cutoff])).rows[0];if(!anchor||anchor.created_at.toISOString()!==cursor.at)throw invalid();}
 const {rows}=await client.query<Row>(`SELECT * FROM session_recording WHERE project_id=$1 AND sampled AND created_at>=$2 AND created_at<$3
 AND ($4::uuid IS NULL OR(created_at,id)<(SELECT created_at,id FROM session_recording WHERE project_id=$1 AND id=$4)) ORDER BY created_at DESC,id DESC LIMIT 21`,[projectId,scope.cutoff,scope.at,cursor?.id??null]);
 return{role:scope.role,asOf:scope.at,retainedFrom:scope.cutoff,items:rows.slice(0,20).map(row=>summary(row)),nextCursor:rows.length>20?contentCursor({id:rows[19].id,createdAt:rows[19].created_at},bound):null};
 });}
export async function getSessionReplay(projectId:string,userId:string,recordingId:string,params:URLSearchParams,chunks=false){if(!z.uuid().safeParse(recordingId).success||[...params.keys()].some(k=>!chunks||k!=='after')||params.getAll('after').length>1)throw invalid();const after=params.get('after');if(after!==null&&!/^(0|[1-9]\d{0,3})$/.test(after)||after!==null&&Number(after)>=replayLimits.chunks)throw invalid();return readScope(projectId,userId,async(client,scope)=>{
 // Metadata and chunk page use one MVCC statement: concurrent upload cannot mix their generations.
 type Stored={sequence:number;final:boolean;sha256:string;data:string};
 const row=(await client.query<Row&{page:Stored[];result_expired:boolean}>(`SELECT r.*,r.created_at<$4::timestamptz AS result_expired,COALESCE((SELECT json_agg(c ORDER BY c.sequence) FROM(
 SELECT sequence,final,sha256,encode(payload,'base64') AS data FROM session_recording_chunk WHERE recording_id=r.id AND sequence>$3 ORDER BY sequence LIMIT 5)c),'[]') AS page
 FROM session_recording r WHERE project_id=$1 AND id=$2 AND sampled`,[projectId,recordingId,chunks&&after!==null?Number(after):chunks?-1:replayLimits.chunks,scope.cutoff])).rows[0];if(!row)throw absent();const item=summary(row,row.result_expired);if(!chunks)return{role:scope.role,asOf:scope.at,item};
 if(item.resultExpired)return{role:scope.role,asOf:scope.at,item,chunks:[],nextAfter:null};
 const stored=row.page.map(v=>({...v,payload:Buffer.from(v.data,'base64')}));
 const visible=stored.slice(0,4).map(v=>replayChunkDto.parse({sequence:v.sequence,final:v.final,sha256:v.sha256,bytes:v.payload.length,parts:readReplayChunk(v.payload.toString('base64url')).parts}));
 return{role:scope.role,asOf:scope.at,item,chunks:visible,nextAfter:stored.length>4?visible.at(-1)!.sequence:null};
 });}
