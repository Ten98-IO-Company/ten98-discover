import type { PoolClient } from 'pg';

// The retention worker holds the workspace and project gates before calling.
// These are the same gates used by import publication and authorized report reads.
export async function expireGoogleImportPages(client: PoolClient, projectId: string, cutoff: Date) {
  const eligible = await client.query<{ id: string }>(`SELECT id FROM google_import
    WHERE project_id=$1 AND data_expired_at IS NULL AND completed_at<$2
      AND status IN ('completed','partial','failed','denied')
    ORDER BY completed_at,id LIMIT 20 FOR UPDATE`, [projectId, cutoff]);
  if (eligible.rows.length) {
    const ids = eligible.rows.map(row => row.id);
    await client.query('DELETE FROM google_import_page WHERE import_id=ANY($1::uuid[])', [ids]);
    await client.query(`UPDATE google_import SET data_expired_at=clock_timestamp(),
      quality='{"warnings":["Report data expired under this workspace’s retention policy. The original import outcome remains as a receipt."],"metadata":{}}'
      WHERE id=ANY($1::uuid[])`, [ids]);
  }
  const pending = await client.query(`SELECT EXISTS(SELECT 1 FROM google_import
    WHERE project_id=$1 AND data_expired_at IS NULL AND completed_at<$2
      AND status IN ('completed','partial','failed','denied')) AS pending`, [projectId, cutoff]);
  return { expiredImports: eligible.rows.length, pending: pending.rows[0].pending as boolean };
}
