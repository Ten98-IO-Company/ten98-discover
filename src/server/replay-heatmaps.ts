import {retentionCoverage} from '../lib/analytics-comparison.ts';
import {createHash,createHmac,randomUUID,randomInt,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {getConfig} from './config.ts';
import {FoundationError} from './auth.ts';
import {contentCursor,readContentCursor,contentReceipt} from './project-context.ts';
import {readScope,summary,transaction,readToken as readReplayToken,readReplayReference} from './session-replay.ts';
import {replayChunkDto,readReplayChunk} from '../lib/session-replay.ts';
import {nativeCollectionPolicy,publicAnalyticsSettings,trackingConsentEpoch} from './native-analytics.ts';
import {eventPath} from './validation.ts';
import {heatmapBackgroundUpload,heatmapBackgroundPage,heatmapBackgroundReference,heatmapBegin,heatmapBatch,heatmapPlane,heatmapDepth,heatmapLimits,readHeatmapQuery,replayHeatmapParams,defaultHeatmapSettings,savedReplay,savedReplayWrite,savedReplayAck,savedReplayPoint,savedReplayList,heatmapPages,heatmapGeometries,heatmapClicks,heatmapScroll} from '../lib/replay-heatmaps.ts';

const invalid=()=>new FoundationError(400,'Check the saved replay or heatmap request.');
const absent=()=>new FoundationError(404,'Recording or project not found or unavailable.');
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function saved(row:{saved_name:string|null;saved_revision:number;saved_at:Date|null}){return savedReplay.parse({name:row.saved_name,revision:row.saved_revision,savedAt:row.saved_at?.toISOString()??null});}
export async function getSavedReplay(projectId:string,userId:string,recordingId:string){if(!z.uuid().safeParse(recordingId).success)throw invalid();return readScope(projectId,userId,async(client,scope)=>{
 const row=(await client.query('SELECT *,created_at<$3::timestamptz AS expired FROM session_recording WHERE project_id=$1 AND id=$2 AND sampled',[projectId,recordingId,scope.cutoff])).rows[0];if(!row)throw absent();return savedReplayPoint.parse({role:scope.role,asOf:scope.at,item:summary(row,row.expired),saved:saved(row)});
 });}
export async function listSavedReplays(projectId:string,userId:string,raw:URLSearchParams|string){let params:URLSearchParams;try{params=replayHeatmapParams(raw);}catch{throw invalid();}if(params.toString().length>2048||[...params.keys()].some(k=>!['cursor','search'].includes(k)||params.getAll(k).length!==1))throw invalid();const search=params.get('search')??'';if(search.length>100||/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(search))throw invalid();const bound={projectId,list:'saved-replays',search},cursor=readContentCursor(params.get('cursor'),bound);return readScope(projectId,userId,async(client,scope)=>{
 if(cursor){const anchor=(await client.query('SELECT created_at FROM session_recording WHERE project_id=$1 AND id=$2 AND sampled',[projectId,cursor.id])).rows[0];if(!anchor||anchor.created_at.toISOString()!==cursor.at)throw invalid();}
 const rows=(await client.query(`SELECT *,created_at<$2::timestamptz AS expired FROM session_recording WHERE project_id=$1 AND sampled AND saved_at IS NOT NULL AND position(lower($3) in lower(saved_name))>0
 AND($4::uuid IS NULL OR(created_at,id)<(SELECT created_at,id FROM session_recording WHERE project_id=$1 AND id=$4)) ORDER BY created_at DESC,id DESC LIMIT 21`,[projectId,scope.cutoff,search,cursor?.id??null])).rows;
 return savedReplayList.parse({role:scope.role,asOf:scope.at,retainedFrom:scope.cutoff,items:rows.slice(0,20).map(row=>({recording:summary(row,row.expired),saved:saved(row)})),nextCursor:rows.length>20?contentCursor({id:rows[19].id,createdAt:rows[19].created_at},bound):null});
 });}
export async function saveReplay(projectId:string,userId:string,recordingId:string,raw:unknown){if(!z.uuid().safeParse(projectId).success||!z.uuid().safeParse(recordingId).success)throw invalid();const parsed=savedReplayWrite.safeParse(raw);if(!parsed.success)throw invalid();const input=parsed.data;return transaction(async client=>{
 const target=(await client.query('SELECT workspace_id FROM project WHERE id=$1',[projectId])).rows[0];if(!target)throw absent();await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[target.workspace_id]);await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[projectId]);
 const authority=(await client.query(`SELECT m.role,to_char(GREATEST(p.replay_retained_from,clock_timestamp()-w.replay_days*interval '24 hours')AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff FROM project p JOIN workspace w ON w.id=p.workspace_id JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1`,[projectId,userId])).rows[0];if(!authority||!['owner','admin','editor'].includes(authority.role))throw absent();
 const request={...input,recordingId},receipt=await contentReceipt(client,projectId,input.requestId,'replay.saved',{actorId:userId,...request});if(receipt.replayed)return savedReplayAck.parse({role:authority.role,request,appliedRevision:receipt.result.appliedRevision,replayed:true});
 const row=(await client.query('SELECT *,created_at<$3::timestamptz AS expired FROM session_recording WHERE project_id=$1 AND id=$2 AND sampled FOR UPDATE',[projectId,recordingId,authority.cutoff])).rows[0];if(!row)throw absent();if(row.saved_revision!==input.revision||row.saved_revision===2147483647)throw new FoundationError(409,'The saved replay changed. Reload before saving.');
 if(input.action!=='unsave'&&(row.expired||row.entry_path===null))throw new FoundationError(409,'Expired recordings cannot be saved or renamed.');
 if(input.action==='save'&&row.saved_at!==null||input.action!=='save'&&row.saved_at===null)throw new FoundationError(409,'The saved replay state changed. Reload before saving.');
 const revision=row.saved_revision+1;await client.query(`UPDATE session_recording SET saved_revision=$3,saved_name=$4,saved_at=CASE WHEN $4::text IS NULL THEN NULL ELSE COALESCE(saved_at,clock_timestamp()) END WHERE project_id=$1 AND id=$2`,[projectId,recordingId,revision,input.name]);await receipt.save({recordingId,appliedRevision:revision});return savedReplayAck.parse({role:authority.role,request,appliedRevision:revision,replayed:false});
 });}

const capability=z.object({version:z.literal(1),id:z.uuid(),projectId:z.uuid(),origin:z.string(),epoch:z.uuid(),settingsHash:z.string().regex(/^[a-f0-9]{64}$/),until:z.number().int().nonnegative()}).strict();
const sign=(body:string)=>createHmac('sha256',getConfig().authSecret).update('ten98.heatmap-upload.v1:'+body).digest('hex');
function token(row:{id:string;project_id:string;origin:string;epoch:string;settings_hash:string;upload_until:Date}){const body=Buffer.from(JSON.stringify({version:1,id:row.id,projectId:row.project_id,origin:row.origin,epoch:row.epoch,settingsHash:row.settings_hash,until:row.upload_until.getTime()})).toString('base64url');return body+'.'+sign(body);}
function readToken(value:string){try{if(!/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value))throw invalid();const[body,signature]=value.split('.');if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(sign(body),'hex')))throw invalid();const raw=Buffer.from(body,'base64url');if(raw.toString('base64url')!==body)throw invalid();return capability.parse(JSON.parse(raw.toString('utf8')));}catch{throw new FoundationError(409,'The heatmap capability expired or changed.');}}
export async function beginHeatmap(request:Request,raw:unknown){const parsed=heatmapBegin.safeParse(raw);if(!parsed.success)throw invalid();const input=parsed.data;return transaction(async client=>{
 await client.query('SELECT id FROM project WHERE public_key=$1 FOR SHARE',[input.siteKey]);const policy=await nativeCollectionPolicy(client,request,input.siteKey,input,'heatmap'),settings=policy.project?publicAnalyticsSettings(policy.project.analytics_settings).heatmap??defaultHeatmapSettings:defaultHeatmapSettings;
 if(policy.reason||policy.basis!=='consent'||!settings.enabled)throw new FoundationError(403,'Current Analytics permission and enabled heatmaps are required.');
 const epoch=trackingConsentEpoch(policy.project.analytics_epoch,policy.project.destination_epoch),settingsHash=hash(settings),requestHash=hash(input);
 await client.query(`WITH clock AS MATERIALIZED(SELECT clock_timestamp() AS at)
 INSERT INTO heatmap_capture(id,project_id,request_id,request_hash,origin,path,epoch,settings_hash,settings,sampled,created_at,deadline_at,upload_until)
 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,c.at,c.at+interval '5 minutes',c.at+interval '6 minutes' FROM clock c
 ON CONFLICT(project_id,request_id)DO NOTHING`,[randomUUID(),policy.project.id,input.requestId,requestHash,new URL(input.url).origin,eventPath(input.url),epoch,settingsHash,JSON.stringify(settings),randomInt(1000000)<Math.floor(settings.sampleRate*1000000)]);
 const row=(await client.query('SELECT * FROM heatmap_capture WHERE project_id=$1 AND request_id=$2 FOR UPDATE',[policy.project.id,input.requestId])).rows[0],now=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
 if(row.request_hash!==requestHash||row.epoch!==epoch||row.settings_hash!==settingsHash||row.upload_until<=now||row.path===null)throw new FoundationError(409,'The heatmap Begin expired or changed.');return{accepted:row.sampled,reason:row.sampled?null:'not_sampled',captureId:row.id,token:row.sampled?token(row):null,createdAt:row.created_at.toISOString(),deadlineAt:row.deadline_at.toISOString(),uploadUntil:row.upload_until.toISOString(),settings:row.settings,limits:heatmapLimits};
 });}
export async function collectHeatmap(request:Request,raw:unknown){const parsed=heatmapBatch.safeParse(raw);if(!parsed.success)throw invalid();const input=parsed.data,cap=readToken(input.token);return transaction(async client=>{
 await client.query('SELECT id FROM project WHERE public_key=$1 FOR SHARE',[input.siteKey]);const policy=await nativeCollectionPolicy(client,request,input.siteKey,input,'heatmap'),settings=policy.project?publicAnalyticsSettings(policy.project.analytics_settings).heatmap??defaultHeatmapSettings:defaultHeatmapSettings;
 if(policy.reason||policy.basis!=='consent'||!settings.enabled)throw new FoundationError(403,'Current Analytics permission and enabled heatmaps are required.');
 const url=new URL(input.url),path=eventPath(input.url),pageKey=hash([url.origin,path]),plane=heatmapPlane(input.geometry),geometryKey=hash(plane),payloadHash=hash(input),bytes=Buffer.byteLength(JSON.stringify(input));
 const capture=(await client.query('SELECT * FROM heatmap_capture WHERE project_id=$1 AND id=$2 FOR UPDATE',[policy.project.id,input.captureId])).rows[0],now=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date,epoch=trackingConsentEpoch(policy.project.analytics_epoch,policy.project.destination_epoch);
 if(!capture||!capture.sampled||cap.id!==capture.id||cap.projectId!==policy.project.id||cap.origin!==url.origin||capture.origin!==url.origin||capture.path!==path||cap.epoch!==epoch||capture.epoch!==epoch||cap.settingsHash!==capture.settings_hash||capture.settings_hash!==hash(settings)||cap.until!==capture.upload_until.getTime()||now.getTime()>=cap.until)throw new FoundationError(409,'The heatmap capability expired or changed.');
 const prior=(await client.query('SELECT payload_hash FROM heatmap_batch WHERE project_id=$1 AND request_id=$2',[policy.project.id,input.requestId])).rows[0];if(prior){if(prior.payload_hash!==payloadHash)throw new FoundationError(409,'This heatmap request ID was used for different observations.');return{accepted:true,duplicate:true,requestId:input.requestId};}
 if(capture.batch_count>=heatmapLimits.captureBatches||capture.byte_count+bytes>heatmapLimits.captureBytes)throw new FoundationError(413,'The heatmap capture reached its disclosed batch or byte limit.');if(input.observations[0].offsetMs<capture.last_offset_ms)throw new FoundationError(409,'Heatmap offsets cannot move backwards.');
 const observations=input.observations.map(o=>o.kind==='scroll'?{...o,depth:heatmapDepth(input.geometry,o.scrollY)}:o);
 const result=await client.query(`INSERT INTO heatmap_batch(project_id,request_id,payload_hash,capture_id,origin,path,page_key,geometry_key,geometry,observations)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)ON CONFLICT(project_id,request_id)DO NOTHING`,[policy.project.id,input.requestId,payloadHash,input.captureId,url.origin,path,pageKey,geometryKey,JSON.stringify(plane),JSON.stringify(observations)]);
 if(!result.rowCount){const row=(await client.query('SELECT payload_hash FROM heatmap_batch WHERE project_id=$1 AND request_id=$2',[policy.project.id,input.requestId])).rows[0];if(row.payload_hash!==payloadHash)throw new FoundationError(409,'This heatmap request ID was used for different observations.');}
 if(result.rowCount)await client.query('UPDATE heatmap_capture SET batch_count=batch_count+1,byte_count=byte_count+$3,last_offset_ms=$4 WHERE project_id=$1 AND id=$2',[policy.project.id,input.captureId,bytes,input.observations.at(-1)!.offsetMs]);
 return{accepted:true,duplicate:!result.rowCount,requestId:input.requestId};
 });}

export async function projectHeatmaps(projectId:string,userId:string,params:URLSearchParams|string){if(!z.uuid().safeParse(projectId).success)throw invalid();let query:ReturnType<typeof readHeatmapQuery>;try{query=readHeatmapQuery(params);}catch{throw invalid();}return transaction(async client=>{
 const target=(await client.query('SELECT workspace_id FROM project WHERE id=$1',[projectId])).rows[0];if(!target)throw absent();await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[target.workspace_id]);
 const scope=(await client.query(`WITH clock AS MATERIALIZED(SELECT clock_timestamp()AS at)SELECT m.role,p.analytics_settings,to_char(GREATEST(p.analytics_retained_from,c.at-w.raw_analytics_days*interval '24 hours')AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')AS cutoff,to_char(c.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')AS at FROM project p JOIN workspace w ON w.id=p.workspace_id JOIN membership m ON m.workspace_id=w.id AND m.user_id=$2 CROSS JOIN clock c WHERE p.id=$1 AND m.role IN('owner','admin','editor','viewer')`,[projectId,userId])).rows[0];if(!scope)throw absent();
 const start=query.from+'T00:00:00Z',end=new Date(Date.parse(query.to+'T00:00:00Z')+86400000).toISOString(),bound={projectId,query:{...query,cursor:undefined}},cursor=readContentCursor(query.cursor??null,bound);let anchor:string|null=null;
 if(cursor){const row=(await client.query('SELECT received_at,page_key,geometry_key,origin,path FROM heatmap_batch WHERE project_id=$1 AND request_id=$2 AND received_at>=GREATEST($3::timestamptz,$4::timestamptz) AND received_at<$5',[projectId,cursor.id,start,scope.cutoff,end])).rows[0];if(!row||row.received_at.toISOString()!==cursor.at||query.mode==='geometries'&&(row.origin!==query.origin||row.path!==query.path))throw invalid();anchor=query.mode==='pages'?row.page_key:row.geometry_key;}
 const common={version:1 as const,projectId,role:scope.role,enabled:publicAnalyticsSettings(scope.analytics_settings).heatmap?.enabled??false,query,asOf:scope.at,retainedFrom:scope.cutoff,coverage:retentionCoverage(start,end,scope.cutoff).status};
 const base=`SELECT * FROM heatmap_batch WHERE project_id=$1 AND received_at>=GREATEST($2::timestamptz,$4::timestamptz)AND received_at<LEAST($3::timestamptz,$5::timestamptz)`;
 const values=[projectId,start,end,scope.cutoff,scope.at];let result:unknown;
 if(query.mode==='pages'||query.mode==='geometries'){
 const pages=query.mode==='pages',key=pages?'page_key':'geometry_key',rows=(await client.query(`WITH data AS(${base}${pages?'':' AND origin=$7 AND path=$8'}),counts AS(SELECT ${key},count(DISTINCT capture_id)::text AS captures FROM data GROUP BY ${key}),first AS(SELECT DISTINCT ON(${key})* FROM data ORDER BY ${key},received_at,request_id)SELECT first.*,counts.captures FROM first JOIN counts USING(${key}) WHERE($6::text IS NULL OR ${key}>$6)ORDER BY ${key} LIMIT 21`,[...values,anchor,...pages?[]:[query.origin,query.path]])).rows;
 result={...common,items:rows.slice(0,20).map(row=>pages?{key:row.page_key,origin:row.origin,path:row.path,captures:Number(row.captures)}:{key:row.geometry_key,geometry:row.geometry,captures:Number(row.captures)}),nextCursor:rows.length>20?contentCursor({id:rows[19].request_id,createdAt:rows[19].received_at},bound):null};
 }else{
 const row=(await client.query(`WITH data AS(${base} AND origin=$6 AND path=$7 AND geometry_key=$8),observed AS(SELECT capture_id,o FROM data CROSS JOIN LATERAL jsonb_array_elements(observations)o),clicks AS(SELECT(o->>'x')::double precision AS x,(o->>'y')::double precision AS y,count(*)::text AS count FROM observed WHERE o->>'kind'='click'GROUP BY 1,2),top AS(SELECT * FROM clicks ORDER BY count::bigint DESC,x,y LIMIT 5000),depths AS(SELECT capture_id,max((o->>'depth')::double precision)AS depth FROM observed WHERE o->>'kind'='scroll'GROUP BY capture_id)SELECT(SELECT geometry FROM data LIMIT 1)AS geometry,(SELECT count(DISTINCT capture_id)::text FROM data)AS captures,(SELECT count(*)::text FROM observed WHERE o->>'kind'='click')AS observations,(SELECT count(*)::text FROM clicks)AS groups,COALESCE((SELECT json_agg(top ORDER BY count::bigint DESC,x,y)FROM top),'[]')AS points,(SELECT count(*)::text FROM depths)AS scroll_captures,(SELECT json_agg(json_build_object('depth',n,'captures',(SELECT count(*)::text FROM depths WHERE depth>=n))ORDER BY n)FROM generate_series(10,100,10)n)AS bands`,[...values,query.origin,query.path,query.geometry])).rows[0];
 const available=common.coverage!=='unavailable'&&row.geometry!==null,groups=Number(row.groups),points=row.points.map((p:{x:number;y:number;count:string})=>({...p,count:Number(p.count)}));result=query.mode==='click'?{...common,geometry:row.geometry??null,points,totals:{observations:available?Number(row.observations):null,captures:available?Number(row.captures):null,groups:available?groups:null,returnedGroups:available?points.length:null,omittedGroups:available?groups-points.length:null,limited:groups>5000}}:{...common,geometry:row.geometry??null,captures:available?Number(row.scroll_captures):null,bands:row.bands.map((b:{depth:number;captures:string})=>({depth:b.depth,captures:available?Number(b.captures):null}))};
 }
 const checked=({pages:heatmapPages,geometries:heatmapGeometries,click:heatmapClicks,scroll:heatmapScroll}[query.mode]).parse(result);if(Buffer.byteLength(JSON.stringify(checked))>2097152)throw new FoundationError(503,'The heatmap response is too large.');return checked;
 });}

export async function associateHeatmapBackground(request:Request,raw:unknown){
 const parsed=heatmapBackgroundUpload.safeParse(raw);if(!parsed.success)throw invalid();const input=parsed.data,hcap=readToken(input.heatmapToken),rcap=readReplayToken(input.replayToken);
 const changed=()=>new FoundationError(409,'This historical background cannot be associated with the current retained captures.');
 return transaction(async client=>{
  await client.query('SELECT id FROM project WHERE public_key=$1 FOR SHARE',[input.siteKey]);
  const policy=await nativeCollectionPolicy(client,request,input.siteKey,input,'replay'),settings=policy.project?publicAnalyticsSettings(policy.project.analytics_settings):null;
  if(policy.reason||policy.basis!=='consent'||!settings?.heatmap?.enabled||!settings.replay?.enabled)throw new FoundationError(403,'Both current Analytics and replay permissions are required.');
  const projectId=policy.project.id,epoch=trackingConsentEpoch(policy.project.analytics_epoch,policy.project.destination_epoch),url=new URL(input.url),path=eventPath(input.url),plane=heatmapPlane(input.geometry);
  const capture=(await client.query('SELECT * FROM heatmap_capture WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,input.captureId])).rows[0];
  const recording=(await client.query('SELECT * FROM session_recording WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,input.recordingId])).rows[0];
  const clock=(await client.query(`WITH clock AS MATERIALIZED(SELECT clock_timestamp()AS at)SELECT c.at::text AS at,
   GREATEST(p.analytics_retained_from,c.at-w.raw_analytics_days*interval '24 hours')::text AS heatmap_cutoff,
   r.created_at<GREATEST(p.replay_retained_from,c.at-w.replay_days*interval '24 hours')AS replay_expired,
   c.at>=LEAST(h.upload_until,r.upload_until,timestamptz 'epoch'+LEAST($4::bigint,$5::bigint)*interval '1 millisecond')AS upload_expired
   FROM project p JOIN workspace w ON w.id=p.workspace_id
   JOIN heatmap_capture h ON h.project_id=p.id AND h.id=$2 JOIN session_recording r ON r.project_id=p.id AND r.id=$3
   CROSS JOIN clock c WHERE p.id=$1`,[projectId,input.captureId,input.recordingId,hcap.until,rcap.until])).rows[0];
  if(!capture||!recording||!capture.sampled||!recording.sampled||capture.path!==path||recording.entry_path===null||capture.origin!==url.origin||recording.origin!==url.origin||
   hcap.id!==capture.id||rcap.id!==recording.id||hcap.projectId!==projectId||rcap.projectId!==projectId||hcap.origin!==url.origin||rcap.origin!==url.origin||
   hcap.epoch!==epoch||rcap.epoch!==epoch||capture.epoch!==epoch||recording.epoch!==epoch||hcap.settingsHash!==capture.settings_hash||rcap.settingsHash!==recording.settings_hash||
   capture.settings_hash!==hash(settings.heatmap)||recording.settings_hash!==hash(settings.replay)||
   hcap.until!==capture.upload_until.getTime()||rcap.until!==recording.upload_until.getTime()||clock.upload_expired||
   clock.replay_expired||recording.first_event_timestamp===null||hash(plane)!==input.geometryKey)throw changed();
  const batch=(await client.query('SELECT * FROM heatmap_batch WHERE project_id=$1 AND request_id=$2 AND capture_id=$3 AND geometry_key=$4 AND received_at>=$5 AND received_at<$6',[projectId,input.batchRequestId,input.captureId,input.geometryKey,clock.heatmap_cutoff,clock.at])).rows[0];
  if(!batch||batch.origin!==url.origin||batch.path!==path||hash(heatmapPlane(batch.geometry))!==input.geometryKey)throw changed();
  const meta=await readReplayReference(client,recording.id,input.meta),snapshot=await readReplayReference(client,recording.id,input.snapshot);
  if(meta.event.type!==4||snapshot.event.type!==2||meta.event.data.href!==input.url||meta.event.timestamp>snapshot.event.timestamp||
   snapshot.event.timestamp<Number(recording.first_event_timestamp)||snapshot.event.timestamp-Number(recording.first_event_timestamp)>recording.settings.maxDurationMs||
   meta.event.data.width!==plane.viewportWidth||meta.event.data.height!==plane.viewportHeight)throw changed();
  const sequences=[...new Set([...meta.sequences,...snapshot.sequences])].sort((a,b)=>a-b),payloadHash=hash(input),observedAt=new Date(snapshot.event.timestamp);
  // One immutable sample per capture/layout, bounded by the existing256 actual batch geometries.
  const inserted=await client.query(`INSERT INTO heatmap_background(project_id,capture_id,geometry_key,request_id,request_hash,batch_request_id,recording_id,geometry,heatmap_offset_ms,replay_offset_ms,meta,snapshot,sequences,observed_at,accepted_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)ON CONFLICT DO NOTHING`,[projectId,input.captureId,input.geometryKey,input.requestId,payloadHash,input.batchRequestId,recording.id,JSON.stringify(plane),input.heatmapOffsetMs,snapshot.event.timestamp-Number(recording.first_event_timestamp),JSON.stringify(input.meta),JSON.stringify(input.snapshot),sequences,observedAt,clock.at]);
  const prior=(await client.query('SELECT request_hash FROM heatmap_background WHERE project_id=$1 AND request_id=$2',[projectId,input.requestId])).rows[0];
  if(!prior||prior.request_hash!==payloadHash)throw changed();
  return{accepted:true,duplicate:!inserted.rowCount,requestId:input.requestId};
 });
}

export async function getHeatmapBackground(projectId:string,userId:string,raw:URLSearchParams|string){
 let query:ReturnType<typeof readHeatmapQuery>,after=-1;
 try{const p=replayHeatmapParams(raw);if(p.has('after')){const a=p.get('after')!;if(p.getAll('after').length!==1||!/^(0|[1-9]\d{0,3})$/.test(a)||Number(a)>1023)throw invalid();after=Number(a);p.delete('after');}query=readHeatmapQuery(p);if(!['click','scroll'].includes(query.mode))throw invalid();}catch{throw invalid();}
 return readScope(projectId,userId,async(client,scope)=>{
  const blank={version:1 as const,projectId,role:scope.role,query,asOf:scope.at,reference:null,item:null,chunks:[],nextAfter:null};
  const start=query.from+'T00:00:00Z',end=new Date(Date.parse(query.to+'T00:00:00Z')+86400000).toISOString();
  const ref=(await client.query(`SELECT b.*,c.epoch AS capture_epoch FROM heatmap_background b JOIN heatmap_batch h ON h.project_id=b.project_id AND h.request_id=b.batch_request_id
   JOIN heatmap_capture c ON c.project_id=b.project_id AND c.id=b.capture_id
   WHERE b.project_id=$1 AND b.geometry_key=$2 AND h.origin=$3 AND h.path=$4 AND c.path=$4
   AND h.received_at>=GREATEST($5::timestamptz,$7::timestamptz)AND h.received_at<LEAST($6::timestamptz,$8::timestamptz)
   ORDER BY b.accepted_at DESC,b.capture_id LIMIT 1`,[projectId,query.geometry,query.origin,query.path,start,end,scope.heatmapCutoff,scope.at])).rows[0];
  if(!ref)return heatmapBackgroundPage.parse({...blank,state:'missing'});
  const recording=(await client.query('SELECT *,created_at<$3::timestamptz AS result_expired FROM session_recording WHERE project_id=$1 AND id=$2 AND sampled',[projectId,ref.recording_id,scope.cutoff])).rows[0];
  if(!recording||recording.result_expired||recording.entry_path===null)return heatmapBackgroundPage.parse({...blank,state:'expired'});
  if(recording.origin!==query.origin||recording.epoch!==ref.capture_epoch)throw invalid();
  const inventory=(await client.query<{sequence:number}>('SELECT sequence FROM session_recording_chunk WHERE recording_id=$1 AND sequence=ANY($2::integer[]) ORDER BY sequence',[recording.id,ref.sequences])).rows;
  if(inventory.length!==ref.sequences.length)return heatmapBackgroundPage.parse({...blank,state:'incomplete'});
  // Every page rechecks both current retentions; at most4 original chunks are read, never the whole recording.
  const visible=(await client.query<{sequence:number;final:boolean;sha256:string;payload:Buffer}>('SELECT sequence,final,sha256,payload FROM session_recording_chunk WHERE recording_id=$1 AND sequence=ANY($2::integer[]) AND sequence>$3 ORDER BY sequence LIMIT 5',[recording.id,ref.sequences,after])).rows;
  const chunks=visible.slice(0,4).map(c=>replayChunkDto.parse({sequence:c.sequence,final:c.final,sha256:c.sha256,bytes:c.payload.length,parts:readReplayChunk(c.payload.toString('base64url')).parts}));
  const reference=heatmapBackgroundReference.parse({captureId:ref.capture_id,recordingId:ref.recording_id,geometryKey:ref.geometry_key,geometry:ref.geometry,heatmapOffsetMs:ref.heatmap_offset_ms,replayOffsetMs:ref.observed_at.getTime()-Number(recording.first_event_timestamp),meta:ref.meta,snapshot:ref.snapshot,observedAt:ref.observed_at.toISOString(),sequences:ref.sequences});
  return heatmapBackgroundPage.parse({...blank,state:'available',reference,item:summary(recording),chunks,nextAfter:visible.length>4?chunks.at(-1)!.sequence:null});
 });
}
