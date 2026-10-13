import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {FoundationError} from './auth.ts';
import {getConfig} from './config.ts';
import {getDatabase} from './db.ts';
import {decryptCredentials,encryptCredentials} from './credential-vault.ts';
import {metaDeletionContext,metaSubjectHash,withMetaRegistration} from './meta-auth.ts';
import {verifyMetaSignedRequest} from './meta-signed-request.ts';

type DeletionStatus='queued'|'cleaning'|'local_deleted';
type Receipt={id:string;registration_id:string;payload_digest:string;subject_hash:string;fence_epoch:string;status:DeletionStatus;confirmation_hash:string;encrypted_confirmation:unknown};
const hash=(value:string)=>createHash('sha256').update(value,'ascii').digest('hex');
function validCode(value:unknown):value is string {
  return typeof value==='string'&&value.length===43&&!/[^A-Za-z0-9_-]/.test(value)&&Buffer.from(value,'base64url').toString('base64url')===value;
}
function confirmation(row:Receipt){
  const data=decryptCredentials(row.encrypted_confirmation,metaDeletionContext(row));
  if(!data||typeof data!=='object'||!Object.hasOwn(data,'code')||!validCode((data as {code:unknown}).code))throw new FoundationError(503,'The stored deletion receipt is unavailable. Ask the operator to check the encryption keyring.');
  const code=(data as {code:string}).code;
  if(hash(code)!==row.confirmation_hash)throw new FoundationError(503,'The stored deletion receipt is unavailable. Ask the operator to check the encryption keyring.');
  return {url:getConfig().appUrl+'/api/meta/deletion-status/'+code,confirmation_code:code};
}

/** Provider-signed admission only; the HTTP boundary owns bounded form decoding. */
export async function acceptMetaDeletion(registrationId:string,signedRequest:string):Promise<{url:string;confirmation_code:string}>{
  return withMetaRegistration(registrationId,async(client,app,secrets)=>{
    const verified=verifyMetaSignedRequest(signedRequest,secrets.appSecret);
    const previous=(await client.query<Receipt>('SELECT * FROM meta_deletion_request WHERE registration_id=$1 AND payload_digest=$2',[app.id,verified.digest])).rows[0];
    if(previous)return confirmation(previous);
    const subjectHash=metaSubjectHash(secrets,verified.userId),id=randomUUID(),code=randomBytes(32).toString('base64url');
    const encrypted=encryptCredentials({code},metaDeletionContext({id,registration_id:app.id}));
    const epoch=(await client.query<{lifecycle_epoch:string}>('UPDATE meta_app_registration SET lifecycle_epoch=lifecycle_epoch+1 WHERE id=$1 RETURNING lifecycle_epoch',[app.id])).rows[0].lifecycle_epoch;
    await client.query(`INSERT INTO meta_deletion_request(id,registration_id,payload_digest,subject_hash,fence_epoch,confirmation_hash,encrypted_confirmation,issued_at_seconds,expires_seconds)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,app.id,verified.digest,subjectHash,epoch,hash(code),encrypted,verified.issuedAt,verified.expires]);
    return {url:getConfig().appUrl+'/api/meta/deletion-status/'+code,confirmation_code:code};
  });
}

export async function getMetaDeletionStatus(code:string):Promise<{status:DeletionStatus;scope:'local_application';message:string}>{
  const unavailable=()=>new FoundationError(404,'Deletion status not found or unavailable.');
  if(!validCode(code))throw unavailable();
  const row=(await getDatabase().pool.query<{status:DeletionStatus}>('SELECT status FROM meta_deletion_request WHERE confirmation_hash=$1',[hash(code)])).rows[0];
  if(!row)throw unavailable();
  const messages:Record<DeletionStatus,string>={
    queued:'The signed request was received. Covered Meta connections are blocked while local cleanup is queued. Operator backups are managed separately.',
    cleaning:'Local cleanup is in progress. Covered Meta connections remain blocked. Operator backups are managed separately.',
    local_deleted:'Deletion from this application’s current Meta connection storage is complete. Operator backups are managed separately.',
  };
  return {status:row.status,scope:'local_application',message:messages[row.status]};
}

// Invalidated grants can still contain personal metadata; don't mistake an earlier
// access fence for completed erasure. Only a covered CURRENT grant owns its token.
const needsCleanup=`f.phase='completed' AND f.registration_id=$1 AND f.subject_hash=$2 AND f.start_epoch<$3::bigint
  AND (f.invalidated_at IS NULL OR f.scopes IS NOT NULL OR f.token_type IS NOT NULL OR f.access_expires_at IS NOT NULL OR f.data_access_expires_at IS NOT NULL
    OR (c.current_grant_id=f.id AND (c.status<>'deleted' OR c.encrypted_token IS NOT NULL OR c.account_id IS NOT NULL OR c.account_name IS NOT NULL
      OR c.currency IS NOT NULL OR c.time_zone IS NOT NULL OR c.account_status IS NOT NULL OR c.validated_at IS NOT NULL)))`;

/** One restart-safe local batch. No token/key reads, provider traffic or user session.
 * Before report imports are enabled, extend this completion gate to their retained
 * grant-scoped payloads; local_deleted currently covers connection storage only. */
export async function runMetaDeletionBatch():Promise<{processedRequests:number;cleanedGrants:number;cleanedConnections:number;pending:boolean}>{
  const client=await getDatabase().pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='5s'");
    // The registration gate precedes workspace → project → connection everywhere.
    // SKIP LOCKED applies only to admission: never call skipped payload rows done.
    const app=(await client.query<{id:string}>(`SELECT a.id FROM meta_app_registration a JOIN LATERAL
      (SELECT received_at,id FROM meta_deletion_request WHERE registration_id=a.id AND status<>'local_deleted' ORDER BY received_at,id LIMIT 1) d ON true
      ORDER BY d.received_at,d.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`)).rows[0];
    let processedRequests=0,cleanedGrants=0,cleanedConnections=0;
    if(app){
      const receipt=(await client.query<Receipt>("SELECT * FROM meta_deletion_request WHERE registration_id=$1 AND status<>'local_deleted' ORDER BY received_at,id LIMIT 1",[app.id])).rows[0];
      if(receipt){
        const args=[app.id,receipt.subject_hash,receipt.fence_epoch];
        const project=(await client.query<{project_id:string;workspace_id:string}>(`SELECT f.project_id,f.workspace_id FROM meta_oauth_flow f
          JOIN meta_connection c ON c.id=f.connection_id AND c.project_id=f.project_id AND c.workspace_id=f.workspace_id
          WHERE ${needsCleanup} ORDER BY f.workspace_id,f.project_id,f.id LIMIT 1`,args)).rows[0];
        if(project){
          await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[project.workspace_id]);
          await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[project.project_id,project.workspace_id]);
          const grants=(await client.query<{id:string}>(`SELECT f.id FROM meta_oauth_flow f
            JOIN meta_connection c ON c.id=f.connection_id AND c.project_id=f.project_id AND c.workspace_id=f.workspace_id
            WHERE ${needsCleanup} AND f.project_id=$4 ORDER BY f.id LIMIT 50`,[...args,project.project_id])).rows.map(row=>row.id);
          if(grants.length){
            const erased=await client.query(`UPDATE meta_connection c SET revision=LEAST(revision::bigint+1,2147483647)::integer,status='deleted',encrypted_token=NULL,account_id=NULL,account_name=NULL,
              currency=NULL,time_zone=NULL,account_status=NULL,validated_at=NULL,deleted_at=COALESCE(deleted_at,clock_timestamp()),updated_at=clock_timestamp()
              WHERE c.project_id=$1 AND c.workspace_id=$2 AND c.current_grant_id=ANY($3::uuid[])
                AND (c.status<>'deleted' OR c.encrypted_token IS NOT NULL OR c.account_id IS NOT NULL OR c.account_name IS NOT NULL OR c.currency IS NOT NULL
                  OR c.time_zone IS NOT NULL OR c.account_status IS NOT NULL OR c.validated_at IS NOT NULL)`,[project.project_id,project.workspace_id,grants]);
            cleanedConnections=erased.rowCount??0;
            const erasedGrants=await client.query(`UPDATE meta_oauth_flow SET scopes=NULL,token_type=NULL,access_expires_at=NULL,data_access_expires_at=NULL,
              invalidated_at=COALESCE(invalidated_at,clock_timestamp()) WHERE id=ANY($1::uuid[]) AND project_id=$2`,[grants,project.project_id]);
            cleanedGrants=erasedGrants.rowCount??0;
          }
        }
        const remaining=!!(await client.query(`SELECT 1 FROM meta_oauth_flow f JOIN meta_connection c
          ON c.id=f.connection_id AND c.project_id=f.project_id AND c.workspace_id=f.workspace_id WHERE ${needsCleanup} LIMIT 1`,args)).rowCount;
        await client.query(`UPDATE meta_deletion_request SET status=$2,cleaned_connections=cleaned_connections+$3,
          local_deleted_at=CASE WHEN $2='local_deleted' THEN clock_timestamp() ELSE NULL END WHERE id=$1`,[receipt.id,remaining?'cleaning':'local_deleted',cleanedConnections]);
        processedRequests=1;
      }
    }
    const pending=!!(await client.query("SELECT 1 FROM meta_deletion_request WHERE status<>'local_deleted' LIMIT 1")).rowCount;
    await client.query('COMMIT');
    return {processedRequests,cleanedGrants,cleanedConnections,pending};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
