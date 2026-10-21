import type {PoolClient} from 'pg';
import {analyticsTagLimit} from '../lib/analytics-tag.ts';

/**
 * True when the project may record this tag: it is already in the project's retained events, or fewer than analyticsTagLimit
 * distinct tags are. Past the cap the caller stores no tag and nothing about the refused value (no log, counter or table).
 * Retention deletes expired events, so "retained events" is the retention window and a tag frees its slot when its last event expires.
 *
 * ponytail: a bounded scan of the project's tagged events per tagged collection call, with no counter table and no new index. An
 * already-known tag exits on the first matching row. An unseen tag takes a per-project transaction lock so two collectors cannot
 * both claim the last slot, then counts distinct tags (index event_project_time_idx plus a jsonb filter). Upgrade path: a partial
 * expression index on (project_id, (dimensions->>'tag')) WHERE dimensions ? 'tag' if tagged projects grow large.
 */
export async function admitTag(client:PoolClient,projectId:string,tag:string):Promise<boolean>{
 const known=`SELECT 1 FROM event e JOIN project p ON p.id=e.project_id WHERE e.project_id=$1 AND e.dimensions->>'tag'=$2
  AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from) LIMIT 1`;
 if((await client.query(known,[projectId,tag])).rowCount)return true;
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`analytics-tag:${projectId}`]);
 if((await client.query(known,[projectId,tag])).rowCount)return true;
 const distinct=await client.query<{count:string}>(`SELECT count(DISTINCT e.dimensions->>'tag')::text AS count FROM event e JOIN project p ON p.id=e.project_id
  WHERE e.project_id=$1 AND e.dimensions ? 'tag' AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)`,[projectId]);
 return Number(distinct.rows[0]?.count??0)<analyticsTagLimit;
}
