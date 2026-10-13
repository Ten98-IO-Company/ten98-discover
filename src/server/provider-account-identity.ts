import {randomBytes} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getConfig} from './config.ts';
import {getDatabase} from './db.ts';
import {credentialKeys,decryptCredentials,encryptCredentials} from './credential-vault.ts';

const context={workspaceId:'instance',id:'provider-account-identity',provider:'dataforseo-account',revision:1};
const payloadInput=z.object({version:z.literal(1),legacyV1:z.string().min(32).max(16000),stableV2:z.string().length(44)}).strict();
type Payload=z.infer<typeof payloadInput>;
function unavailable():never {throw new FoundationError(503,'Provider account recovery keys are unavailable. Restore the matching credential encryption keyring and database backup.');}
function open(envelope:unknown):Payload {
  try {
    const value=payloadInput.parse(decryptCredentials(envelope,context));
    const bytes=Buffer.from(value.stableV2,'base64');
    if(bytes.length!==32||bytes.toString('base64')!==value.stableV2)unavailable();
    return value;
  } catch {return unavailable();}
}
async function quoteState(client:Pick<PoolClient,'query'>) {
  return (await client.query(`SELECT
    EXISTS(SELECT 1 FROM keyword_quote) OR EXISTS(SELECT 1 FROM saved_keyword_refresh_plan) AS present,
    EXISTS(SELECT 1 FROM keyword_quote WHERE account_fingerprint_version=2)
      OR EXISTS(SELECT 1 FROM saved_keyword_refresh_plan WHERE account_fingerprint_version=2) AS modern`)).rows[0] as {present:boolean;modern:boolean};
}

// Only the explicit 0022 migration may capture the current login secret for
// pre-existing fingerprints. Later missing state must never guess a replacement.
// The caller owns a transaction; initialization serializes on the installation row.
export async function initializeProviderAccountIdentity(client:PoolClient,allowLegacyCapture=false):Promise<Payload|null> {
  const row=(await client.query("SELECT provider_account_identity FROM installation WHERE id='instance' FOR UPDATE")).rows[0];
  if(!row)unavailable();
  if(row.provider_account_identity!==null)return open(row.provider_account_identity);
  const quotes=await quoteState(client);
  if(quotes.modern||(quotes.present&&!allowLegacyCapture))unavailable();
  if(!credentialKeys()){if(quotes.present)unavailable();return null;}
  const value:Payload={version:1,legacyV1:getConfig().authSecret,stableV2:randomBytes(32).toString('base64')};
  if(!payloadInput.safeParse(value).success)unavailable();
  await client.query("UPDATE installation SET provider_account_identity=$1 WHERE id='instance'",[encryptCredentials(value,context)]);
  return value;
}

// Called outside workspace/project transactions by the free account verification.
// A row lock covers only key loading/initialization, never a provider request.
export async function getProviderAccountIdentityKey(version:1|2):Promise<string> {
  if(version!==1&&version!==2)unavailable();
  const client=await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const value=await initializeProviderAccountIdentity(client);
    if(!value)unavailable();
    await client.query('COMMIT');
    return version===1?value.legacyV1:value.stableV2;
  } catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}

export async function assertProviderAccountIdentityReadable():Promise<void> {
  const {pool}=getDatabase();
  const row=(await pool.query(`SELECT provider_account_identity,
    EXISTS(SELECT 1 FROM keyword_quote) OR EXISTS(SELECT 1 FROM saved_keyword_refresh_plan) AS present
    FROM installation WHERE id='instance'`)).rows[0];
  if(!row)unavailable();
  if(row.provider_account_identity!==null){open(row.provider_account_identity);return;}
  if(row.present)unavailable();
}

export async function rotateProviderAccountIdentityEncryption():Promise<void> {
  const client=await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const row=(await client.query("SELECT provider_account_identity FROM installation WHERE id='instance' FOR UPDATE")).rows[0];
    if(!row)unavailable();
    if(row.provider_account_identity!==null){
      const value=open(row.provider_account_identity);
      await client.query("UPDATE installation SET provider_account_identity=$1 WHERE id='instance'",[encryptCredentials(value,context)]);
    }else if((await quoteState(client)).present)unavailable();
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
