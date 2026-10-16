import type {PoolClient} from 'pg';

// Shared retention owns the workspace/project gates and supplies the fresh policy cutoff.
export async function expirePromptResults(client:PoolClient,projectId:string,cutoff:Date,derivedCutoff?:Date){
 const expired=await client.query(`WITH candidates AS (
   SELECT id FROM prompt_execution WHERE project_id=$1 AND result IS NOT NULL AND completed_at<$2
   ORDER BY completed_at,id LIMIT 100 FOR UPDATE
 ) UPDATE prompt_execution r SET result=NULL,result_purged_at=clock_timestamp() FROM candidates c WHERE r.id=c.id`,[projectId,cutoff]);
 // Thin financial/checkpoint identity never extends copied provider input retention.
 const unused=await client.query(`WITH candidates AS (SELECT q.id FROM prompt_execution_quote q
   WHERE q.project_id=$1 AND q.input_purged_at IS NULL AND q.expires_at<clock_timestamp()-interval '24 hours'
    AND EXISTS(SELECT 1 FROM prompt_occurrence o WHERE o.quote_id=q.id)
    AND NOT EXISTS(SELECT 1 FROM prompt_comparison c WHERE c.quote_id=q.id)
   ORDER BY q.expires_at,q.id LIMIT 100 FOR UPDATE OF q)
   UPDATE prompt_execution_quote q SET input=NULL,messages=NULL,input_purged_at=clock_timestamp() FROM candidates c WHERE q.id=c.id`,[projectId]);
 if(derivedCutoff){
  // Only terminal zero-financial skipped history is physically pruned. Manual
  // request receipts remain as non-replayable idempotency barriers.
  const old=(await client.query(`SELECT o.id FROM prompt_occurrence o WHERE o.project_id=$1 AND o.status='skipped' AND o.comparison_id IS NULL AND o.created_at<$2
   AND (o.trigger='calendar' OR EXISTS(SELECT 1 FROM project_content_request p WHERE p.project_id=o.project_id AND p.request_id=o.request_key AND p.operation='prompt.tracker.run:'||o.tracker_id::text AND p.result->>'id'=o.id::text))
   ORDER BY o.created_at,o.id LIMIT 100 FOR UPDATE OF o`,[projectId,derivedCutoff])).rows.map(row=>row.id);
  if(old.length){await client.query('UPDATE prompt_execution_quote SET recurring_occurrence_id=NULL,recurring_models_hash=NULL WHERE recurring_occurrence_id=ANY($1::uuid[])',[old]);await client.query('DELETE FROM prompt_occurrence WHERE id=ANY($1::uuid[])',[old]);}
 }
 await client.query(`DELETE FROM prompt_execution_quote WHERE id IN (
   SELECT q.id FROM prompt_execution_quote q WHERE q.project_id=$1 AND q.expires_at<clock_timestamp()-interval '24 hours'
     AND NOT EXISTS(SELECT 1 FROM prompt_comparison c WHERE c.quote_id=q.id) AND NOT EXISTS(SELECT 1 FROM prompt_occurrence o WHERE o.quote_id=q.id) ORDER BY q.expires_at,q.id LIMIT 100
 )`,[projectId]);
 // Copied execution input is raw provider payload. Authored prompt versions, hashes and receipts remain.
 const inputs=await client.query(`WITH candidates AS (
   SELECT q.id FROM prompt_execution_quote q JOIN prompt_comparison c ON c.quote_id=q.id
   WHERE q.project_id=$1 AND q.input_purged_at IS NULL
    AND EXISTS(SELECT 1 FROM prompt_comparison_item i WHERE i.comparison_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM prompt_comparison_item i JOIN prompt_execution r ON r.id=i.execution_id WHERE i.comparison_id=c.id
      AND (r.status IN('queued','running') OR r.completed_at IS NULL OR r.completed_at>=$2))
   ORDER BY q.created_at,q.id LIMIT 100 FOR UPDATE OF q
 ) UPDATE prompt_execution_quote q SET input=NULL,messages=NULL,input_purged_at=clock_timestamp()
 FROM candidates c WHERE q.id=c.id`,[projectId,cutoff]);
 const pending=await client.query(`SELECT
   EXISTS(SELECT 1 FROM prompt_execution WHERE project_id=$1 AND result IS NOT NULL AND completed_at<$2)
   OR EXISTS(SELECT 1 FROM prompt_execution_quote q JOIN prompt_comparison c ON c.quote_id=q.id
     WHERE q.project_id=$1 AND q.input_purged_at IS NULL
      AND EXISTS(SELECT 1 FROM prompt_comparison_item i WHERE i.comparison_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM prompt_comparison_item i JOIN prompt_execution r ON r.id=i.execution_id WHERE i.comparison_id=c.id
        AND (r.status IN('queued','running') OR r.completed_at IS NULL OR r.completed_at>=$2)))
   OR EXISTS(SELECT 1 FROM prompt_execution_quote q WHERE q.project_id=$1 AND q.expires_at<clock_timestamp()-interval '24 hours'
     AND NOT EXISTS(SELECT 1 FROM prompt_comparison c WHERE c.quote_id=q.id) AND (q.input_purged_at IS NULL OR NOT EXISTS(SELECT 1 FROM prompt_occurrence o WHERE o.quote_id=q.id)))
   OR EXISTS(SELECT 1 FROM prompt_occurrence o WHERE o.project_id=$1 AND o.status='skipped' AND o.comparison_id IS NULL AND o.created_at<$3
    AND (o.trigger='calendar' OR EXISTS(SELECT 1 FROM project_content_request p WHERE p.project_id=o.project_id AND p.request_id=o.request_key AND p.operation='prompt.tracker.run:'||o.tracker_id::text AND p.result->>'id'=o.id::text))) AS pending`,[projectId,cutoff,derivedCutoff??null]);
 return {expiredPromptResults:expired.rowCount??0,expiredPromptInputs:(inputs.rowCount??0)+(unused.rowCount??0),pending:pending.rows[0].pending as boolean};
}
