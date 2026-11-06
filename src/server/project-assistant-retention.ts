import type {PoolClient} from 'pg';

export async function previewAssistantRetention(client:PoolClient,workspaceId:string,derivedDays:number){
 const rows=(await client.query(`SELECT b.event_id FROM assistant_event_payload b JOIN assistant_event e ON e.project_id=b.project_id AND e.id=b.event_id
  JOIN project p ON p.id=e.project_id JOIN workspace w ON w.id=p.workspace_id WHERE p.workspace_id=$1
  AND e.created_at<GREATEST(p.assistant_payload_retained_from,statement_timestamp()-LEAST(w.derived_history_days,$2::integer)*interval '24 hours') LIMIT 10001`,[workspaceId,derivedDays])).rows;
 return {status:'available' as const,payloads:Math.min(rows.length,10000),atLeast:rows.length>10000};
}

/** Caller owns the native workspace/project retention locks. Headers and receipts retain their original identity. */
export async function expireAssistantPayloads(client:PoolClient,projectId:string,derivedCutoff:Date){
 await client.query('UPDATE project SET assistant_payload_retained_from=GREATEST(assistant_payload_retained_from,$2::timestamptz) WHERE id=$1',[projectId,derivedCutoff]);
 const expired=await client.query(`WITH candidates AS(SELECT b.event_id FROM assistant_event_payload b JOIN assistant_event e ON e.project_id=b.project_id AND e.id=b.event_id
  JOIN project p ON p.id=e.project_id WHERE p.id=$1 AND e.created_at<p.assistant_payload_retained_from ORDER BY e.created_at,e.id LIMIT 100 FOR UPDATE OF b)
  DELETE FROM assistant_event_payload b USING candidates c WHERE b.project_id=$1 AND b.event_id=c.event_id`,[projectId]);
 const pending=(await client.query(`SELECT EXISTS(SELECT 1 FROM assistant_event_payload b JOIN assistant_event e ON e.project_id=b.project_id AND e.id=b.event_id
  JOIN project p ON p.id=e.project_id WHERE p.id=$1 AND e.created_at<p.assistant_payload_retained_from)AS pending`,[projectId])).rows[0].pending as boolean;
 return {expiredPayloads:expired.rowCount??0,pending};
}
