import {createHmac} from 'node:crypto';
import type {PoolClient} from 'pg';
import {getConfig} from './config.ts';
import {FoundationError} from './auth.ts';
import {normalizeDimensions} from './analytics-input.ts';

// Explicit caller assertions only. Neither reference authenticates a person.
export function explicitIdentityReference(projectId:string,distinctId:string,secret=getConfig().authSecret){
  const exact=normalizeDimensions({distinctId}).distinctId!;
  const digest=(parts:string[])=>createHmac('sha256',secret).update(JSON.stringify(parts)).digest('hex');
  return {identityVersion:1 as const,keyGeneration:digest(['ten98.analytics.explicit-generation.v1',projectId]),
    identityToken:digest(['ten98.analytics.explicit-identity.v1',projectId,exact])};
}

// All callers hold workspace then project gates. Separate from profile/event
// evidence: a policy extension cannot revive a previously expired link interval.
export async function latchIdentityLinkRetention(client:PoolClient,projectIds:string[],cutoff:Date|string,asOf:Date|string){
  return (await client.query<{id:string;cutoff:string}>(`WITH targets AS MATERIALIZED (
    SELECT id,GREATEST(identity_links_retained_from,$2::timestamptz) AS cutoff FROM project WHERE id=ANY($1::text[])
  ) UPDATE project p SET identity_links_retained_from=t.cutoff,
    identity_links_evidence_lost_at=COALESCE(p.identity_links_evidence_lost_at,CASE WHEN EXISTS(
      SELECT 1 FROM analytics_identity_link l WHERE l.project_id=p.id AND l.last_accepted_at<t.cutoff) THEN $3::timestamptz END)
    FROM targets t WHERE p.id=t.id RETURNING p.id,to_char(p.identity_links_retained_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff`,[projectIds,cutoff,asOf])).rows;
}

// Call only for new accepted explicit-ID evidence, never receipt/event replay.
// ponytail: project UPDATE serializes assignments; split only after measured contention.
export async function recordIdentityLink(client:PoolClient,projectId:string,visitorKey:string,distinctId:string,acceptedAt:string){
  const reference=explicitIdentityReference(projectId,distinctId);
  const state=(await client.query(`SELECT to_char(($2::timestamptz-w.raw_analytics_days*interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff
    FROM project p JOIN workspace w ON w.id=p.workspace_id WHERE p.id=$1`,[projectId,acceptedAt])).rows[0];
  const [{cutoff}]=await latchIdentityLinkRetention(client,[projectId],state.cutoff,acceptedAt);
  const result=await client.query(`INSERT INTO analytics_identity_link(project_id,visitor_key,identity_version,key_generation,identity_token,first_accepted_at,last_accepted_at)
    VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(project_id,visitor_key) DO UPDATE SET
      first_accepted_at=CASE WHEN analytics_identity_link.last_accepted_at<$7::timestamptz THEN excluded.first_accepted_at ELSE analytics_identity_link.first_accepted_at END,
      last_accepted_at=CASE WHEN analytics_identity_link.last_accepted_at<$7::timestamptz THEN excluded.last_accepted_at ELSE GREATEST(analytics_identity_link.last_accepted_at,excluded.last_accepted_at) END
    WHERE analytics_identity_link.identity_version=excluded.identity_version AND analytics_identity_link.key_generation=excluded.key_generation
      AND analytics_identity_link.identity_token=excluded.identity_token RETURNING visitor_key`,
    [projectId,visitorKey,reference.identityVersion,reference.keyGeneration,reference.identityToken,acceptedAt,cutoff]);
  if(!result.rowCount)throw new FoundationError(409,'The identity assignment conflicts with retained evidence.');
}

export async function expireIdentityLinks(client:PoolClient,projectId:string,rawCutoff:Date|string,asOf:Date|string){
  const [{cutoff}]=await latchIdentityLinkRetention(client,[projectId],rawCutoff,asOf);
  const removed=await client.query(`WITH expired AS (SELECT visitor_key FROM analytics_identity_link WHERE project_id=$1 AND last_accepted_at<$2
    ORDER BY last_accepted_at,visitor_key LIMIT 1000 FOR UPDATE)
    DELETE FROM analytics_identity_link l USING expired e WHERE l.project_id=$1 AND l.visitor_key=e.visitor_key`,[projectId,cutoff]);
  const pending=(await client.query('SELECT EXISTS(SELECT 1 FROM analytics_identity_link WHERE project_id=$1 AND last_accepted_at<$2) AS pending',[projectId,cutoff])).rows[0].pending as boolean;
  return {expiredIdentityLinks:removed.rowCount??0,pending};
}
