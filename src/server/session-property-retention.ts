import type {PoolClient} from 'pg';

// Call under the workspace then project write gates. All property writers and
// cleanup share this latch; event retention and receipt expiry stay independent.
export async function latchSessionPropertyRetention(client:PoolClient,projectIds:string[],cutoff:Date,asOf:Date){
  return (await client.query<{id:string;cutoff:Date}>(`WITH targets AS MATERIALIZED (
    SELECT id,GREATEST(session_properties_retained_from,$2::timestamptz) AS cutoff FROM project WHERE id=ANY($1::text[])
  ) UPDATE project p SET session_properties_retained_from=t.cutoff,
    session_properties_evidence_lost_at=COALESCE(p.session_properties_evidence_lost_at,CASE WHEN EXISTS(
      SELECT 1 FROM analytics_session_property s WHERE s.project_id=p.id AND s.updated_at<t.cutoff) THEN $3::timestamptz END)
    FROM targets t WHERE p.id=t.id RETURNING p.id,p.session_properties_retained_from AS cutoff`,[projectIds,cutoff,asOf])).rows;
}

export async function expireSessionProperties(client:PoolClient,projectId:string,rawCutoff:Date,asOf:Date){
  const [{cutoff}]=await latchSessionPropertyRetention(client,[projectId],rawCutoff,asOf);
  const properties=await client.query(`WITH expired AS (
    SELECT visitor_key,property_key FROM analytics_session_property WHERE project_id=$1 AND updated_at<$2
    ORDER BY updated_at,visitor_key,property_key LIMIT 1000 FOR UPDATE
  ) DELETE FROM analytics_session_property s USING expired e WHERE s.project_id=$1 AND s.visitor_key=e.visitor_key AND s.property_key=e.property_key`,[projectId,cutoff]);
  const receipts=await client.query(`WITH expired AS (
    SELECT request_id FROM analytics_identify_receipt WHERE project_id=$1 AND expires_at<=$2 ORDER BY expires_at,request_id LIMIT 1000 FOR UPDATE
  ) DELETE FROM analytics_identify_receipt r USING expired e WHERE r.project_id=$1 AND r.request_id=e.request_id`,[projectId,asOf]);
  const {rows}=await client.query(`SELECT EXISTS(SELECT 1 FROM analytics_session_property WHERE project_id=$1 AND updated_at<$2)
    OR EXISTS(SELECT 1 FROM analytics_identify_receipt WHERE project_id=$1 AND expires_at<=$3) AS pending`,[projectId,cutoff,asOf]);
  return {expiredProperties:properties.rowCount??0,expiredReceipts:receipts.rowCount??0,pending:rows[0].pending as boolean};
}
