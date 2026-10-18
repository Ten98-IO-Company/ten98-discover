import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {withDomainProject,withDomainRead} from './domains.ts';
import {observeDomainRedirect,type RedirectTransport} from './domain-redirect-network.ts';

export const domainRedirectQueue='domain-redirect-check';
const unavailable=()=>new FoundationError(404,'Domain not found or unavailable.');
function parse<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{const result=schema.safeParse(value);if(!result.success)throw new FoundationError(400,'Check the redirect fields and try again.');return result.data;}
function dto(row:any){return {id:row.id,status:row.status,createdAt:row.created_at,startedAt:row.started_at,completedAt:row.completed_at,
  expected:{hostname:row.hostname,targetHostname:row.expected_target_host,verifiedAt:row.verified_at,revision:row.domain_revision},
  diagnostic:row.diagnostic,observation:row.observation,evidenceExpired:row.observation_expired_at!==null};}
async function domain(client:PoolClient,projectId:string,domainId:string){
  const row=(await client.query('SELECT * FROM project_domain WHERE id=$1 AND project_id=$2',[domainId,projectId])).rows[0];
  if(!row)throw unavailable();return row;
}
function eligible(row:any){return row?.role==='redirect_alias'&&row.verified_at&&!row.revoked_at;}
async function state(client:PoolClient,projectId:string,domainId:string){
  const row=await domain(client,projectId,domainId);
  const checks=(await client.query('SELECT * FROM domain_redirect_check WHERE project_id=$1 AND domain_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20',[projectId,domainId])).rows;
  return {domainId,eligible:!!eligible(row),checks:checks.map(check=>({...dto(check),currentConfiguration:!!eligible(row)&&check.domain_revision===row.redirect_revision})),nextAllowedAt:checks[0]?new Date(checks[0].created_at.getTime()+300_000).toISOString():null};
}
export async function getDomainRedirectChecks(projectId:unknown,userId:unknown,domainId:unknown,apiToken?:string){
  const id=parse(z.uuid(),domainId),read=async(client:PoolClient,project:{id:string})=>state(client,project.id,id);
  return apiToken===undefined?withDomainProject(projectId,userId,read):withDomainRead(projectId,userId,apiToken,read);
}
export async function startDomainRedirectCheck(projectId:unknown,userId:unknown,domainId:unknown,input:unknown){
  const id=parse(z.uuid(),domainId),{requestId}=parse(z.object({requestId:z.uuid()}).strict(),input),boss=await getBoss();
  return withDomainProject(projectId,userId,async(client,project)=>{
    const prior=(await client.query('SELECT * FROM domain_redirect_check WHERE project_id=$1 AND user_id=$2 AND request_id=$3',[project.id,userId,requestId])).rows[0];
    if(prior){if(prior.domain_id!==id)throw new FoundationError(409,'This request already identifies a different redirect check.');return {check:dto(prior),state:await state(client,project.id,id)};}
    const row=await domain(client,project.id,id);
    if(!eligible(row))throw new FoundationError(409,'Verify this redirect alias before checking its HTTP redirects.');
    const recent=(await client.query(`SELECT 1 FROM domain_redirect_check WHERE domain_id=$1 AND
      (status IN('queued','running') OR created_at>clock_timestamp()-interval '5 minutes') LIMIT 1`,[id])).rowCount;
    if(recent)throw new FoundationError(409,'A redirect check is active or was started within five minutes. Refresh its history before trying again.');
    const checkId=randomUUID();
    const saved=(await client.query(`INSERT INTO domain_redirect_check(id,workspace_id,project_id,domain_id,user_id,request_id,domain_revision,hostname,expected_target_host,verified_at,status)
      SELECT $1,p.workspace_id,p.id,d.id,$3,$4,d.redirect_revision,d.hostname,d.expected_target_host,d.verified_at,'queued'
      FROM project p JOIN project_domain d ON d.project_id=p.id WHERE p.id=$5 AND d.id=$2 RETURNING *`,
      [checkId,id,userId,requestId,project.id])).rows[0];
    if(!await boss.send(domainRedirectQueue,{checkId},{id:checkId,retryLimit:0,expireInSeconds:60,db:{executeSql:(text,values)=>client.query(text,values)}}))throw new Error('Redirect check could not be queued.');
    return {check:dto(saved),state:await state(client,project.id,id)};
  });
}

async function lockedCheck<T>(id:string,action:(client:PoolClient,row:any)=>Promise<T>){
  const client=await getDatabase().pool.connect();
  try{
    await client.query('BEGIN');
    const hint=(await client.query('SELECT workspace_id,project_id FROM domain_redirect_check WHERE id=$1',[id])).rows[0];
    if(!hint){await client.query('COMMIT');return null;}
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[hint.workspace_id]);
    await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[hint.project_id,hint.workspace_id]);
    const row=(await client.query('SELECT * FROM domain_redirect_check WHERE id=$1 FOR UPDATE',[id])).rows[0];
    const value=row?await action(client,row):null;await client.query('COMMIT');return value;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
async function stillAuthorized(client:PoolClient,row:any){
  return !!(await client.query(`SELECT 1 FROM project_domain d JOIN project p ON p.id=d.project_id JOIN domain_redirect_check c ON c.id=$8
    JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$3
    WHERE d.id=$1 AND d.project_id=$2 AND p.workspace_id=$4 AND m.role IN('owner','admin')
      AND d.role='redirect_alias' AND d.verified_at=c.verified_at AND d.revoked_at IS NULL AND d.redirect_revision=$5
      AND d.hostname=$6 AND d.expected_target_host=$7 AND c.project_id=$2 AND c.workspace_id=$4`,[row.domain_id,row.project_id,row.user_id,row.workspace_id,row.domain_revision,row.hostname,row.expected_target_host,row.id])).rowCount;
}
async function terminate(client:PoolClient,id:string,status:'stale'|'failed',diagnostic:string){
  await client.query("UPDATE domain_redirect_check SET status=$2,diagnostic=$3,observation=NULL,completed_at=clock_timestamp() WHERE id=$1 AND status IN('queued','running')",[id,status,diagnostic]);
}
export async function executeDomainRedirectCheck(id:unknown,transport?:RedirectTransport){
  const checkId=parse(z.uuid(),id);
  const saved=await lockedCheck(checkId,async(client,row)=>{
    if(row.status!=='queued')return null;
    if(!await stillAuthorized(client,row)){await terminate(client,checkId,'stale','The domain configuration, proof or initiating permission changed. Start a new check after reviewing access.');return null;}
    if(row.created_at.getTime()<Date.now()-300_000){await terminate(client,checkId,'failed','The check did not start within five minutes. Start a new check.');return null;}
    await client.query("UPDATE domain_redirect_check SET status='running',started_at=clock_timestamp() WHERE id=$1",[checkId]);return row;
  });
  if(!saved)return;
  const observation=await observeDomainRedirect(saved.hostname,saved.expected_target_host,transport);
  await lockedCheck(checkId,async(client,row)=>{
    if(row.status!=='running')return;
    if(!await stillAuthorized(client,row)){await terminate(client,checkId,'stale','The domain configuration, proof or initiating permission changed during this check. Its observation was not published.');return;}
    await client.query("UPDATE domain_redirect_check SET status='completed',observation=$2,completed_at=clock_timestamp() WHERE id=$1",[checkId,JSON.stringify(observation)]);
  });
}
export async function reconcileDomainRedirectChecks(){
  const rows=(await getDatabase().pool.query(`SELECT c.id FROM domain_redirect_check c LEFT JOIN pgboss.job j ON j.id=c.id AND j.name=$1
    WHERE c.status IN('queued','running') AND (j.id IS NULL OR j.state IN('failed','cancelled','completed')
      OR c.created_at<clock_timestamp()-interval '5 minutes' OR c.started_at<clock_timestamp()-interval '45 seconds')
    ORDER BY c.created_at LIMIT 50`,[domainRedirectQueue])).rows;
  for(const {id} of rows)await lockedCheck(id,async(client,row)=>{
    if(!['queued','running'].includes(row.status))return;
    if(!await stillAuthorized(client,row)){await terminate(client,id,'stale','The domain configuration, proof or initiating permission changed.');return;}
    const expired=(await client.query(`SELECT 1 FROM domain_redirect_check c LEFT JOIN pgboss.job j ON j.id=c.id AND j.name=$2
      WHERE c.id=$1 AND (j.id IS NULL OR j.state IN('failed','cancelled','completed') OR c.created_at<clock_timestamp()-interval '5 minutes'
      OR c.started_at<clock_timestamp()-interval '45 seconds')`,[id,domainRedirectQueue])).rowCount;
    if(expired)await terminate(client,id,'failed','The worker did not finish this check. No healthy redirect is inferred; start a new check.');
  });
}

// Shared retention owns the workspace/project locks; receipt/idempotency and configuration snapshots remain.
export async function expireDomainRedirectEvidence(client:PoolClient,projectId:string,cutoff:Date){
  const expired=await client.query(`WITH candidates AS (SELECT id FROM domain_redirect_check WHERE project_id=$1
    AND status='completed' AND observation IS NOT NULL AND completed_at<$2 ORDER BY completed_at,id LIMIT 100 FOR UPDATE)
    UPDATE domain_redirect_check c SET observation=NULL,observation_expired_at=clock_timestamp() FROM candidates x WHERE c.id=x.id`,[projectId,cutoff]);
  const pending=(await client.query("SELECT EXISTS(SELECT 1 FROM domain_redirect_check WHERE project_id=$1 AND status='completed' AND observation IS NOT NULL AND completed_at<$2) AS pending",[projectId,cutoff])).rows[0].pending;
  return {expiredDomainRedirects:expired.rowCount??0,pending:pending as boolean};
}
