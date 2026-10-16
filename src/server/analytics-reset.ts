import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {contentReceipt} from './project-context.ts';
import {analyticsResetInput,analyticsResetState,analyticsResetResult,type AnalyticsResetState} from '../lib/analytics-reset.ts';

const absent=()=>new FoundationError(404,'Analytics reset is not available for this project.');
const stamp=(value:string)=>`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
async function state(client:PoolClient,projectId:string,userId:string):Promise<AnalyticsResetState>{
 const row=(await client.query(`SELECT p.id AS "projectId",p.name,m.role,p.analytics_revision AS revision,${stamp('p.analytics_retained_from')} AS "retainedFrom",
  CASE WHEN EXISTS(SELECT 1 FROM event e WHERE e.project_id=p.id AND e.received_at<p.analytics_retained_from)
   OR EXISTS(SELECT 1 FROM web_performance v WHERE v.project_id=p.id AND v.created_at<p.analytics_retained_from)
   OR EXISTS(SELECT 1 FROM analytics_visitor v WHERE v.project_id=p.id AND v.last_seen_at<p.analytics_retained_from AND NOT EXISTS(SELECT 1 FROM event e WHERE e.project_id=v.project_id AND e.visitor_id=v.id))
   OR EXISTS(SELECT 1 FROM analytics_session_property s WHERE s.project_id=p.id AND s.updated_at<p.session_properties_retained_from)
   OR EXISTS(SELECT 1 FROM analytics_identity_link l WHERE l.project_id=p.id AND l.last_accepted_at<p.identity_links_retained_from)
   OR EXISTS(SELECT 1 FROM session_recording r WHERE r.project_id=p.id AND r.created_at<p.replay_retained_from AND(r.entry_path IS NOT NULL OR r.chunk_count<>0 OR r.byte_count<>0))
   OR EXISTS(SELECT 1 FROM heatmap_batch h WHERE h.project_id=p.id AND h.received_at<p.analytics_retained_from)
   OR EXISTS(SELECT 1 FROM heatmap_capture h WHERE h.project_id=p.id AND h.created_at<p.analytics_retained_from AND h.path IS NOT NULL)
   OR EXISTS(SELECT 1 FROM heatmap_background b JOIN heatmap_capture h ON h.project_id=b.project_id AND h.id=b.capture_id JOIN session_recording r ON r.project_id=b.project_id AND r.id=b.recording_id
    WHERE b.project_id=p.id AND(h.created_at<p.analytics_retained_from OR r.created_at<p.replay_retained_from))
   THEN 'pending' ELSE 'complete' END AS cleanup
  FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1 AND m.role IN('owner','admin')`,[projectId,userId])).rows[0];
 if(!row)throw absent();return analyticsResetState.parse(row);
}
async function gate<T>(projectId:string,userId:string,write:boolean,work:(client:PoolClient)=>Promise<T>):Promise<T>{
 if(!z.uuid().safeParse(projectId).success||!z.uuid().safeParse(userId).success)throw absent();
 const client=await getDatabase().pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='2s';SET LOCAL transaction_timeout='15s'");
  const target=(await client.query('SELECT workspace_id FROM project WHERE id=$1',[projectId])).rows[0];if(!target)throw absent();
  await client.query(`SELECT id FROM workspace WHERE id=$1 FOR ${write?'UPDATE':'SHARE'}`,[target.workspace_id]);
  if(!(await client.query(`SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR ${write?'UPDATE':'SHARE'}`,[projectId,target.workspace_id])).rowCount)throw absent();
  // Authority is fresh after every possible gate wait, including receipt replay.
  await state(client,projectId,userId);const result=await work(client);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03','25P04'].includes((error as {code?:string})?.code??''))throw new FoundationError(503,'Analytics reset is busy. Retry only the same request ID and confirmation.');throw error;}
 finally{client.release();}
}
export async function getAnalyticsReset(projectId:string,userId:string){return gate(projectId,userId,false,client=>state(client,projectId,userId));}
export async function resetAnalytics(projectId:string,userId:string,raw:unknown){
 const parsed=analyticsResetInput.safeParse(raw);if(!parsed.success)throw new FoundationError(400,'Type RESET exactly and reload the current project revision.');const input=parsed.data;
 return gate(projectId,userId,true,async client=>{
  const receipt=await contentReceipt(client,projectId,input.requestId,'analytics.reset.v1',{actor:userId,...input});
  if(receipt.replayed)return analyticsResetResult.parse({state:await state(client,projectId,userId),ack:receipt.result,replayed:true});
  const current=await state(client,projectId,userId);if(current.revision!==input.revision)throw new FoundationError(409,'Collection settings or analytics changed. Reload before confirming a new reset.');
  const cutoff=(await client.query<{cutoff:string}>(`SELECT ${stamp('clock_timestamp()')} AS cutoff`)).rows[0].cutoff;
  const updated=(await client.query(`UPDATE project SET analytics_revision=analytics_revision+1,analytics_epoch=$3,
   analytics_retained_from=GREATEST(analytics_retained_from,$2::timestamptz),replay_retained_from=GREATEST(replay_retained_from,$2::timestamptz),
   session_properties_retained_from=GREATEST(session_properties_retained_from,$2::timestamptz),session_properties_evidence_lost_at=COALESCE(session_properties_evidence_lost_at,$2::timestamptz),
   identity_links_retained_from=GREATEST(identity_links_retained_from,$2::timestamptz),identity_links_evidence_lost_at=COALESCE(identity_links_evidence_lost_at,$2::timestamptz),
   retention_next_run_at=LEAST(retention_next_run_at,clock_timestamp()) WHERE id=$1 RETURNING analytics_revision AS revision`,[projectId,cutoff,randomUUID()])).rows[0];
  const ack={projectId,requestId:input.requestId,appliedRevision:updated.revision,cutoff};await receipt.save(ack);
  // ACK means the irreversible cutoff committed, not that bounded disk cleanup completed.
  return analyticsResetResult.parse({state:await state(client,projectId,userId),ack,replayed:false});
 });
}
