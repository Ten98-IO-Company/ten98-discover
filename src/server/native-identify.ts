import {createHmac} from 'node:crypto';
import {FoundationError} from './auth.ts';
import {getConfig} from './config.ts';
import {canonicalHash} from './context-input.ts';
import {getDatabase} from './db.ts';
import type {IdentifyInput} from './identify-input.ts';
import {analyticsIdentity,nativeCollectionPolicy} from './native-analytics.ts';
import {resolveAnalyticsNetwork} from './analytics-network.ts';
import {latchSessionPropertyRetention} from './session-property-retention.ts';
import {recordIdentityLink} from './identity-links.ts';

export type IdentifyResult={accepted:true;duplicate:false;context:string}|{accepted:true;duplicate:true}|
  {accepted:false;reason:'collection_disabled'|'consent_required'|'identity_unavailable'};
export class IdentifyRequestExpired extends FoundationError{constructor(){super(400,'The identify request has expired.');}}

// Input has already crossed parseIdentifyInput: do not re-normalize typed values.
export async function collectIdentify(request:Request,input:IdentifyInput,peerAddress?:string):Promise<IdentifyResult>{
  const client=await getDatabase().pool.connect();
  try{
    await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'");
    await client.query('SELECT w.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.public_key=$1 FOR SHARE OF w',[input.siteKey]);
    // ponytail: identify serializes writes per project using the existing gate.
    // Split this gate only after measured contention justifies more lock state.
    await client.query('SELECT id FROM project WHERE public_key=$1 FOR UPDATE',[input.siteKey]);
    const {project,userAgent,reason}=await nativeCollectionPolicy(client,request,input.siteKey,input);
    if(reason){await client.query('COMMIT');return {accepted:false,reason};}
    const state=(await client.query(project.analytics_settings.linkIdentities===true?
      `SELECT c.instant AS now,w.raw_analytics_days AS days,to_char(c.instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS accepted_at
       FROM workspace w JOIN project p ON p.workspace_id=w.id CROSS JOIN (SELECT clock_timestamp() AS instant) c WHERE p.id=$1`:
      'SELECT clock_timestamp() AS now,w.raw_analytics_days AS days FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.id=$1',[project.id])).rows[0];
    const now=state.now as Date,sentAt=new Date(input.sentAt),expiresAt=new Date(sentAt.getTime()+86_400_000);
    if(sentAt.getTime()>now.getTime()+300_000)throw new FoundationError(400,'Check the identify request timestamp.');
    if(now>=expiresAt)throw new IdentifyRequestExpired();
    const identity=analyticsIdentity({projectId:project.id,ip:resolveAnalyticsNetwork(request,peerAddress),userAgent,distinctId:input.dimensions?.distinctId,context:input.context,now});
    if(!identity){await client.query('COMMIT');return {accepted:false,reason:'identity_unavailable'};}
    const {dimensions:_,...operation}=input;
    const operationHash=createHmac('sha256',getConfig().authSecret).update(JSON.stringify(['ten98.identify.receipt.v1',identity.visitor,canonicalHash(operation)])).digest('hex');
    const receipt=(await client.query('SELECT visitor_key,operation_hash FROM analytics_identify_receipt WHERE project_id=$1 AND request_id=$2',[project.id,input.requestId])).rows[0];
    if(receipt){
      if(receipt.visitor_key!==identity.visitor||receipt.operation_hash!==operationHash)throw new FoundationError(409,'This identify request ID was already used for another operation.');
      await client.query('COMMIT');return {accepted:true,duplicate:true};
    }
    if(input.dimensions?.distinctId!==undefined&&project.analytics_settings.linkIdentities===true)
      await recordIdentityLink(client,project.id,identity.visitor,input.dimensions.distinctId,state.accepted_at);
    const [{cutoff}]=await latchSessionPropertyRetention(client,[project.id],new Date(now.getTime()-state.days*86_400_000),now);
    const keys=Object.keys(input.properties);
    const count=(await client.query(`SELECT count(*)::int AS keys FROM (
      SELECT property_key FROM analytics_session_property WHERE project_id=$1 AND visitor_key=$2 AND updated_at>=$3
      UNION SELECT unnest($4::text[])
    ) retained`,[project.id,identity.visitor,cutoff,keys])).rows[0].keys;
    if(count>50)throw new FoundationError(400,'A visitor key can retain at most 50 session properties.');
    await client.query(`INSERT INTO analytics_session_property(project_id,visitor_key,property_key,property,updated_at)
      SELECT $1,$2,key,value,$4 FROM jsonb_each($3::jsonb)
      ON CONFLICT(project_id,visitor_key,property_key) DO UPDATE SET property=excluded.property,updated_at=excluded.updated_at`,[project.id,identity.visitor,JSON.stringify(input.properties),now]);
    await client.query(`INSERT INTO analytics_identify_receipt(project_id,request_id,visitor_key,operation_hash,sent_at,expires_at,accepted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[project.id,input.requestId,identity.visitor,operationHash,sentAt,expiresAt,now]);
    await client.query('COMMIT');return {accepted:true,duplicate:false,context:identity.context};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});if((error as {code?:string})?.code==='57014')throw new FoundationError(503,'Identify processing took too long. The outcome may be unknown.');throw error;}
  finally{client.release();}
}
