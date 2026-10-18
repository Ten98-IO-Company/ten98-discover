import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {decryptCredentials} from './credential-vault.ts';
import {canonicalHash,contextHost,parse} from './context-input.ts';
import {contentReceipt,contentCursor,readContentCursor,contentProfile} from './project-context.ts';
import {moneyInput,usd} from './providers.ts';
import {reserveSpendInTransaction,dispatchSpend,settleSpend} from './spending.ts';
import {getProviderAccountIdentityKey} from './provider-account-identity.ts';
import {dataforseoJson} from './dataforseo-transport.ts';
import {parseAiSearchAccount,parseAiSearchCountries,parseAiSearchLanguages,assertAiSearchMarket,requestAiSearch,parseAiSearchReconciliation,type AiSearchOutcome,type AiSearchCapturedResult} from './dataforseo-ai-search.ts';
import {readSearchEvidence} from './ai-search-evidence.ts';
import {matchAnswer,type MentionSubject} from './answer-mentions.ts';
import {aggregateAiSearchQueries,AiQueryCapacityError,AiQueryDataError,type AiQueryInput} from './ai-search-analysis.ts';
import {aiQueryFilters,aiQueryRange,aiQueryReportSchema,type AiQueryReport} from '../lib/ai-search-analysis.ts';
import {aiSearchActionInput,aiSearchEndpoints,aiSearchPayload,aiSearchPriceEvidence,aiSearchProfileId,aiSearchQuoteInput,aiSearchReconcileInput,aiSearchRefreshInput,aiSearchRequestSchema,aiSearchSnapshotSchema,aiSearchStartInput,type AiSearchQuoteDto,type AiSearchRunDto,type AiSearchSnapshot} from '../lib/ai-search.ts';

export const aiSearchQueue='ai-search';
type Project={id:string;workspace_id:string;role:'owner'|'admin'|'editor'|'viewer'};
const unavailable=()=>new FoundationError(404,'Search capture not found or unavailable.');
const changed=()=>new FoundationError(409,'Search capture authority, input or quote changed. Refresh and prepare a new quote.');
const deadline=(e:unknown)=>{if(['57014','55P03'].includes((e as {code?:string})?.code??''))throw Object.assign(new FoundationError(503,'Search capture is busy. Retry the same request ID.'),{code:'AI_SEARCH_DEADLINE'});throw e;};
function bounded<T>(value:T):T{if(Buffer.byteLength(JSON.stringify(value))>2*1024*1024)throw new FoundationError(413,'This search capture exceeds the complete response limit.');return value;}
const iso=(v:Date|string|null)=>v===null?null:new Date(v).toISOString();
async function projectGate<T>(projectId:string,userId:string,write:boolean,work:(c:PoolClient,p:Project)=>Promise<T>):Promise<T>{
 parse(z.uuid(),projectId);parse(z.uuid(),userId);const client=await getDatabase().pool.connect();
 try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");
  const hint=(await client.query('SELECT p.workspace_id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id WHERE p.id=$1 AND m.user_id=$2',[projectId,userId])).rows[0];if(!hint)throw unavailable();
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[hint.workspace_id]);
  const row=(await client.query('SELECT p.id,p.workspace_id,m.role FROM project p JOIN membership m ON m.workspace_id=p.workspace_id WHERE p.id=$1 AND p.workspace_id=$2 AND m.user_id=$3 FOR UPDATE OF p',[projectId,hint.workspace_id,userId])).rows[0] as Project|undefined;
  if(!row)throw unavailable();if(write&&!['owner','admin','editor'].includes(row.role))throw new FoundationError(403,'This action requires workspace write access.');
  await latchAiSearchExpiry(client,[projectId]);const value=bounded(await work(client,row));await client.query('COMMIT');return value;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});return deadline(error);}finally{client.release();}
}
async function connection(client:PoolClient,workspaceId:string,id:string,revision?:number){
 const row=(await client.query("SELECT * FROM provider_connection WHERE id=$1 AND workspace_id=$2 AND provider='dataforseo' AND revoked_at IS NULL",[id,workspaceId])).rows[0];
 if(!row)throw unavailable();if(row.check_status!=='ok'||!row.encrypted_credentials||revision!==undefined&&row.revision!==revision)throw changed();return row;
}
function credentials(row:any){return decryptCredentials(row.encrypted_credentials,{id:row.id,workspaceId:row.workspace_id,provider:'dataforseo',revision:row.revision});}
async function prompt(client:PoolClient,pid:string,promptId:string,versionId:string){
 const row=(await client.query(`SELECT v.text FROM project_prompt p JOIN prompt_text_version v ON v.project_id=p.project_id AND v.prompt_id=p.id WHERE p.project_id=$1 AND p.id=$2 AND v.id=$3 AND p.archived_at IS NULL`,[pid,promptId,versionId])).rows[0];if(!row)throw unavailable();return row.text as string;
}
// ponytail: one catalogue preflight per process bounds64MiB response overlap;
// measured streaming/catalogue persistence only if this ceiling becomes material.
let preflightBusy=false;
const preflightUnavailable=()=>Object.assign(new FoundationError(503,'Another catalogue preflight is active. Retry shortly.'),{code:'AI_SEARCH_BUSY'});
async function preflight(projectId:string,conn:any,send:typeof fetch){
 if(preflightBusy)throw preflightUnavailable();preflightBusy=true;
 try{const key=await getProviderAccountIdentityKey(2),secret=credentials(conn);
  const account=parseAiSearchAccount(await dataforseoJson('https://api.dataforseo.com/v3/appendix/user_data',secret,'GET',undefined,send),{key,version:2});
  const countries=parseAiSearchCountries(await dataforseoJson(aiSearchEndpoints.locations,secret,'GET',undefined,send));
  const languages=parseAiSearchLanguages(await dataforseoJson(aiSearchEndpoints.languages,secret,'GET',undefined,send));
  const countriesHash=canonicalHash(countries),languagesHash=canonicalHash(languages),revision=canonicalHash({projectId,connectionId:conn.id,connectionRevision:conn.revision,account:account.fingerprint,countriesHash,languagesHash});
  return {fingerprint:account.fingerprint,countries,languages,countriesHash,languagesHash,revision,preparedAt:new Date().toISOString()};
 }finally{preflightBusy=false;}
}
function snapshot(raw:unknown,hash?:string):AiSearchSnapshot{const value=aiSearchSnapshotSchema.safeParse(raw);if(!value.success||hash&&canonicalHash(value.data)!==hash)throw changed();if(value.data.maxSpendUsd!==undefined)moneyInput.parse(value.data.maxSpendUsd);return value.data;}
async function quoteRow(c:PoolClient,pid:string,id:string){const row=(await c.query(`SELECT q.*,q.expires_at<=clock_timestamp() AS quote_expired FROM ai_search_quote q WHERE q.project_id=$1 AND q.id=$2 FOR UPDATE`,[pid,id])).rows[0];if(!row)throw unavailable();return row;}
function quoteDto(q:any):AiSearchQuoteDto{let input=null,state:AiSearchQuoteDto['rawState']=q.raw_expired_at||q.input_purged_at?'expired':'not_recorded';if(state!=='expired'&&q.input!==null)try{input=snapshot(q.input,q.input_hash);state='retained';}catch{state='invalid';}
 return {id:q.id,requestId:q.request_id,projectId:q.project_id,promptId:q.prompt_id,versionId:q.version_id,connectionId:q.connection_id,connectionRevision:q.connection_revision,createdAt:iso(q.created_at)!,expiresAt:iso(q.expires_at)!,inputHash:q.input_hash,rawState:state,input,price:aiSearchPriceEvidence()};}
const runSelect=(detail=true)=>`SELECT r.id,r.quote_id,r.workspace_id,r.project_id,r.user_id,r.request_id,r.status,r.diagnostic,r.payload_hash,r.lease_owner,r.lease_expires_at,r.dispatched_at,r.completed_at,r.settled_at,r.result_purged_at,r.created_at,${detail?'r.result':'NULL::jsonb AS result'},r.result IS NOT NULL AS result_present,q.prompt_id,q.version_id,q.connection_id,q.connection_revision,q.account_fingerprint,q.account_fingerprint_version,q.input_hash,${detail?'q.input':'NULL::jsonb AS input'},q.raw_expired_at,q.input_purged_at,q.created_at AS captured_at,q.expires_at<=clock_timestamp() AS quote_expired,
 p.status AS charge_status,p.estimate_micros,p.actual_micros,p.provider_reference FROM ai_search_run r JOIN ai_search_quote q ON q.id=r.quote_id JOIN provider_request p ON p.id=r.id`;
async function runRow(c:PoolClient,pid:string,id:string){const row=(await c.query(runSelect()+' WHERE r.project_id=$1 AND r.id=$2',[pid,id])).rows[0];if(!row)throw unavailable();return row;}
function readResult(raw:unknown):AiSearchCapturedResult{
 const value=z.object({profileId:z.literal(aiSearchProfileId),source:z.literal('DataForSEO / ChatGPT consumer interface'),capturedPrompt:z.string(),locationCode:z.number().int(),languageCode:z.string(),forceWebSearch:z.literal(true),reportedModel:z.string().max(160).nullable(),providerObservedAt:z.iso.datetime().nullable(),receivedAt:z.iso.datetime(),evidence:z.unknown()}).strict().parse(raw);
 aiSearchRequestSchema.parse({profileId:value.profileId,capturedPrompt:value.capturedPrompt,locationCode:value.locationCode,languageCode:value.languageCode});
 return {...value,evidence:readSearchEvidence(value.evidence)};
}
function analysisInput(row:any):AiQueryInput{
 let rawState:AiQueryInput['rawState']=row.expired?'expired':'not_recorded',result:AiSearchCapturedResult|null=null,capturedPrompt:string|null=null;
 if(!row.expired)try{const input=snapshot(row.input,row.input_hash);if(input.promptId!==row.prompt_id||input.versionId!==row.version_id)throw new Error();capturedPrompt=input.request.capturedPrompt;
  if(row.result!==null){result=readResult(row.result);if(result.capturedPrompt!==capturedPrompt||result.locationCode!==input.request.locationCode||result.languageCode!==input.request.languageCode)throw new Error();rawState='retained';}
 }catch{rawState='invalid';result=null;capturedPrompt=null;}
 return {id:row.id,promptId:row.prompt_id,versionId:row.version_id,requestedAt:row.requested_at,status:row.status,rawState,capturedPrompt,result};
}
/** Internal read leaf: caller already holds authorized workspace/project locks. */
export async function readAiSearchCoverageSource(c:PoolClient,projectId:string,captureId:string,materialize=true){
 const ref=(await c.query('SELECT quote_id FROM ai_search_run WHERE project_id=$1 AND id=$2',[projectId,captureId])).rows[0];if(!ref)throw unavailable();
 await latchAiSearchExpiry(c,[projectId],undefined,[ref.quote_id]);
 const expired="(q.raw_expired_at IS NOT NULL OR q.input_purged_at IS NOT NULL OR r.result_purged_at IS NOT NULL OR q.created_at<clock_timestamp()-(SELECT raw_provider_evidence_days FROM workspace WHERE id=q.workspace_id)*interval '24 hours')";
 const bounds=(await c.query(`SELECT CASE WHEN ${expired} THEN 0 ELSE COALESCE(octet_length(q.input::text),0)+COALESCE(octet_length(r.result::text),0) END AS bytes
  FROM ai_search_run r JOIN ai_search_quote q ON q.id=r.quote_id AND q.project_id=r.project_id WHERE r.id=$1 AND r.project_id=$2`,[captureId,projectId])).rows[0];
 if(!bounds)throw unavailable();if(BigInt(bounds.bytes)>10n*1024n*1024n)return {coverageError:'source_capacity' as const};
 const row=(await c.query(`SELECT r.id,q.id AS quote_id,q.prompt_id,q.version_id,r.status,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at,
  to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at,q.input_hash,${expired} AS expired,
  CASE WHEN ${expired} OR NOT $3::boolean THEN NULL ELSE q.input END AS input,CASE WHEN ${expired} OR NOT $3::boolean THEN NULL ELSE r.result END AS result,
  CASE WHEN ${expired} THEN NULL ELSE encode(sha256(convert_to(q.input::text,'UTF8')),'hex') END AS input_fingerprint,
  CASE WHEN ${expired} THEN NULL ELSE encode(sha256(convert_to(r.result::text,'UTF8')),'hex') END AS result_hash,
  to_char(q.raw_expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS raw_expired_at,to_char(q.input_purged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS input_purged_at,to_char(r.result_purged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS result_purged_at
  FROM ai_search_run r JOIN ai_search_quote q ON q.id=r.quote_id AND q.project_id=r.project_id WHERE r.id=$1 AND r.project_id=$2`,[captureId,projectId,materialize])).rows[0];
 if(!row)throw unavailable();
 const {input,result,...receipt}=row;return {source:materialize?analysisInput(row):null,receipt};
}
function runDto(p:Project,row:any,userId:string,detail:boolean):AiSearchRunDto{
 let result:AiSearchCapturedResult|null=null,state:AiSearchRunDto['rawState']=row.raw_expired_at||row.input_purged_at||row.result_purged_at?'expired':'not_recorded';
 if(state!=='expired'&&row.result!==null)try{result=readResult(row.result);state='retained';}catch{state='invalid';}
 if(!detail&&state!=='expired'&&row.result_present)state='retained';
 return {id:row.id,quoteId:row.quote_id,projectId:row.project_id,promptId:row.prompt_id,versionId:row.version_id,profileId:aiSearchProfileId,status:row.status,chargeStatus:row.charge_status,estimateUsd:usd(row.estimate_micros),actualUsd:row.actual_micros===null?null:usd(row.actual_micros),createdAt:iso(row.created_at)!,dispatchedAt:iso(row.dispatched_at),completedAt:iso(row.completed_at),settledAt:iso(row.settled_at),reportedModel:result?.reportedModel??null,rawState:state,diagnostic:row.diagnostic,
  canCancel:['owner','admin','editor'].includes(p.role)&&(row.user_id===userId||p.role==='owner')&&row.charge_status==='reserved',canReconcile:p.role==='owner'&&row.charge_status==='uncertain'&&!!row.dispatched_at,...detail?{result}:{} };
}
export async function getAiSearch(projectId:string,userId:string,params=new URLSearchParams()){
 if([...params.keys()].some(k=>k!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one search capture cursor.');
 return projectGate(projectId,userId,false,async(c,p)=>{const scope={projectId:p.id,list:'ai-search'},cursor=readContentCursor(params.get('cursor'),scope),rows=(await c.query(runSelect(false)+` WHERE r.project_id=$1 AND($2::timestamptz IS NULL OR(r.created_at,r.id)<($2::timestamptz,$3::uuid))ORDER BY r.created_at DESC,r.id DESC LIMIT 51`,[p.id,cursor?.at??null,cursor?.id??null])).rows;
  const connections=(await c.query("SELECT id,name,revision,check_status AS \"checkStatus\" FROM provider_connection WHERE workspace_id=$1 AND provider='dataforseo'AND revoked_at IS NULL ORDER BY created_at,id",[p.workspace_id])).rows;
  return {role:p.role,profileId:aiSearchProfileId,price:aiSearchPriceEvidence(),catalog:null,connections,runs:rows.slice(0,50).map(row=>runDto(p,row,userId,false)),nextCursor:rows.length>50?contentCursor({id:rows[49].id,createdAt:rows[49].created_at},scope):null};
 });
}
export async function getAiSearchRun(projectId:string,userId:string,id:string){parse(z.uuid(),id);return projectGate(projectId,userId,false,async(c,p)=>({role:p.role,run:runDto(p,await runRow(c,p.id,id),userId,true)}));}
/** Internal read leaf: caller holds current authorized W/P locks and owns expiry
 * latching. No transaction, network, model filtering or report slicing occurs here. */
export async function readAiSearchAnalysisPopulation(c:PoolClient,p:Project,filters:ReturnType<typeof aiQueryFilters>,materialize=true){
  if(!(await c.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[filters.timeZone])).rowCount)throw new FoundationError(400,'Choose a supported IANA time zone.');
  if(filters.promptId&&!(await c.query('SELECT 1 FROM project_prompt p WHERE p.project_id=$1 AND p.id=$2 AND($3::uuid IS NULL OR EXISTS(SELECT 1 FROM prompt_text_version v WHERE v.project_id=p.project_id AND v.prompt_id=p.id AND v.id=$3))',[p.id,filters.promptId,filters.versionId])).rowCount)throw unavailable();
  const project=(await c.query('SELECT name,origin FROM project WHERE id=$1',[p.id])).rows[0],profile=await contentProfile(c,{...p,...project}),warnings:string[]=[];
  let origin:string[]=[];try{origin=[contextHost(new URL(project.origin).hostname)];}catch{warnings.push('The project origin is not a public brand domain. Brand name and aliases still apply.');}
  const brand:MentionSubject&{id:'brand'}={id:'brand',name:profile.name,aliases:profile.aliases,domains:[...new Set([...origin,...profile.citationDomains])]};
  try{matchAnswer({text:'',subjects:[brand],citationUrls:[],method:filters.matcher});}catch{throw new FoundationError(409,'Current brand identity cannot be analyzed. Review its name, aliases and domains.');}
  const asOf=(await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString() as string,range=aiQueryRange(filters,new Date(asOf));
  const values=[p.id,range.from,range.to,range.timeZone,filters.promptId,filters.versionId,filters.tag,asOf];
  const expired=`(q.raw_expired_at IS NOT NULL OR q.input_purged_at IS NOT NULL OR r.result_purged_at IS NOT NULL OR q.created_at<$8::timestamptz-w.raw_provider_evidence_days*interval '24 hours')`;
  const population=`FROM ai_search_run r JOIN ai_search_quote q ON q.id=r.quote_id AND q.project_id=r.project_id JOIN workspace w ON w.id=r.workspace_id JOIN project_prompt p ON p.id=q.prompt_id AND p.project_id=r.project_id
   WHERE r.project_id=$1 AND($2::date IS NULL OR r.created_at>=($2::date::timestamp AT TIME ZONE 'UTC')-interval '2 days') AND r.created_at<(($3::date+1)::timestamp AT TIME ZONE 'UTC')+interval '2 days'
   AND($2::date IS NULL OR(r.created_at AT TIME ZONE $4)::date>=$2::date) AND(r.created_at AT TIME ZONE $4)::date<=$3::date
   AND($5::uuid IS NULL OR q.prompt_id=$5) AND($6::uuid IS NULL OR q.version_id=$6) AND($7::text IS NULL OR p.user_tags?$7)`;
  // Count before loading payloads. These are complete-report ceilings, never samples.
  const bounds=(await c.query(`SELECT count(*)::int AS n,COALESCE(sum(bytes),0)::text AS bytes FROM(SELECT CASE WHEN ${expired} THEN 0 ELSE COALESCE(octet_length(q.input::text),0)+COALESCE(octet_length(r.result::text),0)END AS bytes ${population} LIMIT 1001) bounded`,values)).rows[0];
  if(bounds.n>1000||BigInt(bounds.bytes)>10n*1024n*1024n)throw new FoundationError(413,'Narrow the selection. Query analysis exceeds 1000 attempts or 10 MiB of retained evidence.');
  const stored=(await c.query(`SELECT r.id,q.id AS quote_id,q.prompt_id,q.version_id,r.status,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at,p.user_tags,q.input_hash,${expired} AS expired,
   to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS quote_created_at,
   to_char(q.raw_expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS raw_expired_at,to_char(q.input_purged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS input_purged_at,to_char(r.result_purged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS result_purged_at,
   CASE WHEN ${expired} OR NOT $9::boolean THEN NULL ELSE q.input END AS input,CASE WHEN ${expired} OR NOT $9::boolean THEN NULL ELSE r.result END AS result,
   CASE WHEN ${expired} THEN NULL ELSE encode(sha256(convert_to(r.result::text,'UTF8')),'hex') END AS result_hash,
   CASE WHEN ${expired} THEN NULL ELSE encode(sha256(convert_to(q.input::text,'UTF8')),'hex') END AS input_fingerprint ${population} ORDER BY r.created_at DESC,r.id DESC`,[...values,materialize])).rows;
  const rows:AiQueryInput[]|null=materialize?stored.map(analysisInput):null;
  const profileHash=canonicalHash(brand),selectionRevision=canonicalHash({projectId:p.id,filters,range,contextRevision:profile.revision,profileHash,rows:stored.map(r=>({id:r.id,promptId:r.prompt_id,versionId:r.version_id,status:r.status,requestedAt:r.requested_at,tags:r.user_tags,expired:r.expired,inputHash:r.input_hash,inputFingerprint:r.input_fingerprint,resultHash:r.result_hash}))});
  return {asOf,resolvedRange:range,filters,contextRevision:profile.revision,profileHash,selectionRevision,warnings,brand,rows,receipts:stored.map(({input,result,...receipt})=>receipt)};
}
export async function getAiSearchAnalysis(projectId:string,userId:string,params:URLSearchParams):Promise<AiQueryReport>{
 let filters:ReturnType<typeof aiQueryFilters>;try{filters=aiQueryFilters(params);}catch{throw new FoundationError(400,'Check the query analysis filters.');}
 return projectGate(projectId,userId,false,async(c,p)=>{
  const {rows,receipts,...population}=await readAiSearchAnalysisPopulation(c,p,filters);
  try{return aiQueryReportSchema.parse(bounded({role:p.role,projectId:p.id,profileId:aiSearchProfileId,...population,label:'Recomputed from retained captures using current brand context',...aggregateAiSearchQueries(rows!,filters,population.brand)}));}
  catch(error){if(error instanceof AiQueryCapacityError)throw new FoundationError(413,error.message);if(error instanceof AiQueryDataError||error instanceof z.ZodError)throw new FoundationError(503,'Stored query analysis evidence is inconsistent. Try a narrower selection.');throw error;}
 });
}
export async function refreshAiSearchCatalog(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
 const input=parse(aiSearchRefreshInput,raw),saved=await projectGate(projectId,userId,true,async(c,p)=>connection(c,p.workspace_id,input.connectionId)),catalog=await preflight(projectId,saved,send);
 return projectGate(projectId,userId,true,async(c,p)=>{await connection(c,p.workspace_id,input.connectionId,saved.revision);return {role:p.role,profileId:aiSearchProfileId,price:aiSearchPriceEvidence(),catalog:{connectionId:input.connectionId,connectionRevision:saved.revision,countries:catalog.countries,languages:catalog.languages,revision:catalog.revision,observedAt:catalog.preparedAt}};});
}
export async function quoteAiSearch(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
 const input=parse(aiSearchQuoteInput,raw);const receiptInput={actorUserId:userId,input};
 const first=await projectGate(projectId,userId,true,async(c,p)=>{const receipt=await contentReceipt(c,p.id,input.requestId,'ai-search.quote',receiptInput);if(receipt.replayed)return {replayed:true as const,role:p.role,quote:quoteDto(await quoteRow(c,p.id,receipt.result.quoteId))};return {replayed:false as const,connection:await connection(c,p.workspace_id,input.connectionId),text:await prompt(c,p.id,input.promptId,input.versionId)};});
 if(first.replayed)return first;
 const catalog=await preflight(projectId,first.connection,send);if(catalog.revision!==input.expectedCatalogRevision)throw changed();
 const request=assertAiSearchMarket({profileId:aiSearchProfileId,capturedPrompt:first.text,locationCode:input.locationCode,languageCode:input.languageCode},catalog.countries,catalog.languages),price=aiSearchPriceEvidence();
 const captured=snapshot({version:1,request,promptId:input.promptId,versionId:input.versionId,country:catalog.countries.find(v=>v.code===input.locationCode)!,language:catalog.languages.find(v=>v.code===input.languageCode)!,catalogRevision:catalog.revision,countriesHash:catalog.countriesHash,languagesHash:catalog.languagesHash,preparedAt:catalog.preparedAt,price});
 return projectGate(projectId,userId,true,async(c,p)=>{const receipt=await contentReceipt(c,p.id,input.requestId,'ai-search.quote',receiptInput);if(receipt.replayed)return {role:p.role,replayed:true,quote:quoteDto(await quoteRow(c,p.id,receipt.result.quoteId))};await connection(c,p.workspace_id,input.connectionId,first.connection.revision);if(await prompt(c,p.id,input.promptId,input.versionId)!==first.text)throw changed();
  const id=randomUUID();await c.query(`INSERT INTO ai_search_quote(id,workspace_id,project_id,user_id,request_id,prompt_id,version_id,connection_id,connection_revision,account_fingerprint,account_fingerprint_version,input_hash,profile_id,price_version,price_mode,price_source,price_checked_on,estimate_micros,input,expires_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,2,$11,$12,$13,$14,$15,$16,4000,$17,clock_timestamp()+interval '5 minutes')`,[id,p.workspace_id,p.id,userId,input.requestId,input.promptId,input.versionId,input.connectionId,first.connection.revision,catalog.fingerprint,canonicalHash(captured),aiSearchProfileId,price.version,price.mode,price.sourceUrl,price.checkedOn,JSON.stringify(captured)]);await receipt.save({actorUserId:userId,quoteId:id,operation:'quote'});return {role:p.role,replayed:false,quote:quoteDto(await quoteRow(c,p.id,id))};
 });
}
export async function startAiSearch(projectId:string,userId:string,raw:unknown){
 const input=parse(aiSearchStartInput,raw),boss=await getBoss();return projectGate(projectId,userId,true,async(c,p)=>{
  const receipt=await contentReceipt(c,p.id,input.requestId,'ai-search.start',{actorUserId:userId,input});if(receipt.replayed)return {role:p.role,replayed:true,run:runDto(p,await runRow(c,p.id,receipt.result.runId),userId,true)};
  const q=await quoteRow(c,p.id,input.quoteId);if(q.user_id!==userId||q.quote_expired||q.raw_expired_at||q.input_purged_at||q.price_version!==input.priceVersion)throw changed();const captured=snapshot(q.input,q.input_hash);if(await prompt(c,p.id,q.prompt_id,q.version_id)!==captured.request.capturedPrompt)throw changed();await connection(c,p.workspace_id,q.connection_id,q.connection_revision);
  if((await c.query("SELECT 1 FROM ai_search_run WHERE project_id=$1 AND(quote_id=$2 OR status IN('queued','running','uncertain'))",[p.id,q.id])).rowCount)throw changed();
  const reservation=await reserveSpendInTransaction(c,p.workspace_id,userId,{connectionId:q.connection_id,requestKey:input.requestId,operation:'ai.search.capture',inputHash:canonicalHash({quoteId:q.id,inputHash:q.input_hash,priceVersion:input.priceVersion}),estimateUsd:'0.004000'},async(tx,id)=>{
   await tx.query("INSERT INTO ai_search_run(id,quote_id,workspace_id,project_id,user_id,request_id,status,payload_hash)VALUES($1,$2,$3,$4,$5,$6,'queued',$7)",[id,q.id,p.workspace_id,p.id,userId,input.requestId,canonicalHash(aiSearchPayload(captured.request,id))]);
   if(!await boss.send(aiSearchQueue,{runId:id},{id,retryLimit:0,expireInSeconds:360,db:{executeSql:(text,values)=>tx.query(text,values)}}))throw new Error('Search capture could not be queued.');
  });await receipt.save({actorUserId:userId,runId:reservation.id,operation:'start'});return {role:p.role,replayed:false,run:runDto(p,await runRow(c,p.id,reservation.id),userId,true)};
 });
}
export async function cancelAiSearch(projectId:string,userId:string,id:string,raw:unknown){
 parse(z.uuid(),id);const input=parse(aiSearchActionInput,raw);return projectGate(projectId,userId,true,async(c,p)=>{const receipt=await contentReceipt(c,p.id,input.requestId,'ai-search.cancel',{actorUserId:userId,id,input}),row=await runRow(c,p.id,id);if(row.user_id!==userId&&p.role!=='owner')throw unavailable();
  if(!receipt.replayed){if(row.charge_status!=='reserved'&&row.charge_status!=='cancelled')throw changed();await cancelReserved(c,row,'Stopped before dispatch.');await receipt.save({actorUserId:userId,runId:id,operation:'cancel'});}return {role:p.role,replayed:receipt.replayed,run:runDto(p,await runRow(c,p.id,id),userId,true)};
 });
}

export async function latchAiSearchExpiry(c:PoolClient,projectIds:string[],cutoff?:Date|string,quoteIds?:string[]){
 if(!projectIds.length)return;await c.query(`UPDATE ai_search_quote q SET raw_expired_at=COALESCE(q.raw_expired_at,clock_timestamp()) FROM workspace w WHERE q.workspace_id=w.id AND q.project_id=ANY($1::text[]) AND($3::uuid[] IS NULL OR q.id=ANY($3::uuid[])) AND q.raw_expired_at IS NULL AND q.created_at<GREATEST($2::timestamptz,clock_timestamp()-w.raw_provider_evidence_days*interval '24 hours')`,[projectIds,cutoff??null,quoteIds??null]);
}
async function cancelReserved(c:PoolClient,row:any,message:string){if(row.status!=='queued'||!['reserved','cancelled'].includes(row.charge_status))return;await c.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp()WHERE id=$1 AND status='reserved'",[row.id]);await c.query("UPDATE ai_search_run SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,completed_at=COALESCE(completed_at,clock_timestamp()),diagnostic=$2 WHERE id=$1",[row.id,message]);}

async function withRun<T>(id:string,work:(c:PoolClient,row:any)=>Promise<T>):Promise<T>{
 parse(z.uuid(),id);const c=await getDatabase().pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");
  const ref=(await c.query('SELECT workspace_id,project_id FROM ai_search_run WHERE id=$1',[id])).rows[0];if(!ref)throw unavailable();
  await c.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[ref.workspace_id]);await c.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[ref.project_id,ref.workspace_id]);await c.query('SELECT id FROM ai_search_run WHERE id=$1 FOR UPDATE',[id]);await latchAiSearchExpiry(c,[ref.project_id]);
  const row=await runRow(c,ref.project_id,id);row.lease_expired=(await c.query('SELECT lease_expires_at<=clock_timestamp() AS expired FROM ai_search_run WHERE id=$1',[id])).rows[0].expired;
  const result=await work(c,row);await c.query('COMMIT');return result;
 }catch(error){await c.query('ROLLBACK').catch(()=>{});return deadline(error);}finally{c.release();}
}
export async function executeAiSearch(id:string,send:typeof fetch=fetch){
 const owner=randomUUID(),saved=await withRun(id,async(c,row)=>{
  if(row.status==='queued'&&row.charge_status==='cancelled'){await cancelReserved(c,row,'The reservation was cancelled before dispatch.');return null;}
  if(row.status!=='queued'||row.charge_status!=='reserved'||row.lease_owner)return null;
  await c.query("UPDATE ai_search_run SET lease_owner=$2,lease_expires_at=clock_timestamp()+interval '120 seconds'WHERE id=$1",[id,owner]);return row;
 });if(!saved)return;
 let secret:unknown,captured:AiSearchSnapshot;
 try{
  if(saved.quote_expired||saved.raw_expired_at||saved.input_purged_at)throw changed();captured=snapshot(saved.input,saved.input_hash);
  const conn=await projectGate(saved.project_id,saved.user_id,true,async(c,p)=>{if(await prompt(c,p.id,saved.prompt_id,saved.version_id)!==captured.request.capturedPrompt)throw changed();return connection(c,p.workspace_id,saved.connection_id,saved.connection_revision);});
  const fresh=await preflight(saved.project_id,conn,send);if(fresh.fingerprint!==saved.account_fingerprint||canonicalHash(fresh.countries.find(v=>v.code===captured.request.locationCode))!==canonicalHash(captured.country)||canonicalHash(fresh.languages.find(v=>v.code===captured.request.languageCode))!==canonicalHash(captured.language)||canonicalHash(aiSearchPriceEvidence())!==canonicalHash(captured.price))throw changed();
  await dispatchSpend(saved.workspace_id,saved.user_id,id,async(c)=>{
   await c.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[saved.project_id,saved.workspace_id]);await c.query('SELECT id FROM ai_search_run WHERE id=$1 FOR UPDATE',[id]);await latchAiSearchExpiry(c,[saved.project_id]);const row=await runRow(c,saved.project_id,id);
   const role=(await c.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[saved.workspace_id,saved.user_id])).rows[0]?.role;
   if(!['owner','admin','editor'].includes(role)||row.status!=='queued'||row.lease_owner!==owner||row.raw_expired_at||row.input_purged_at||row.quote_expired||row.account_fingerprint!==fresh.fingerprint||canonicalHash(snapshot(row.input,row.input_hash))!==canonicalHash(captured))throw changed();
   if(await prompt(c,row.project_id,row.prompt_id,row.version_id)!==captured.request.capturedPrompt)throw changed();secret=credentials(await connection(c,row.workspace_id,row.connection_id,row.connection_revision));
   const changedRow=await c.query(`UPDATE ai_search_run r SET status='running',dispatched_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '180 seconds',preflight_evidence=$3
    FROM ai_search_quote q JOIN workspace w ON w.id=q.workspace_id WHERE r.id=$1 AND r.quote_id=q.id AND r.lease_owner=$2 AND r.lease_expires_at>clock_timestamp() AND q.expires_at>clock_timestamp() AND q.raw_expired_at IS NULL AND q.input_purged_at IS NULL AND q.created_at>=clock_timestamp()-w.raw_provider_evidence_days*interval '24 hours' RETURNING r.id`,[id,owner,JSON.stringify({connectionRevision:row.connection_revision,accountFingerprint:fresh.fingerprint,accountFingerprintVersion:2,country:captured.country,language:captured.language,countriesHash:fresh.countriesHash,languagesHash:fresh.languagesHash,checkedAt:fresh.preparedAt,priceVersion:captured.price.version})]);
   if(!changedRow.rowCount)throw changed();
  },'5s');
 }catch(error){if(['AI_SEARCH_DEADLINE','57014','55P03'].includes((error as {code?:string})?.code??''))return deadline(error);await withRun(id,async(c,row)=>{if(row.lease_owner===owner)await cancelReserved(c,row,'Not sent: quote, permissions, credentials, catalogues or spending controls changed.');});return;}
 const outcome=await requestAiSearch(secret,captured!.request,id,send);
 await finishAiSearch(id,owner,outcome);
}
async function finishAiSearch(id:string,owner:string,outcome:AiSearchOutcome,crashOnly=false){return withRun(id,async(c,row)=>{
 if(row.lease_owner!==owner||row.status!=='running'||!['dispatched','uncertain'].includes(row.charge_status)||crashOnly&&!row.lease_expired)return;
 const reference=outcome.charge.providerTaskId??row.provider_reference;
 const settled=await settleSpend(c,row.workspace_id,id,outcome.charge.state==='known'?outcome.charge.costUsd:null,reference);
 let result:AiSearchCapturedResult|null=null;if(!row.raw_expired_at&&!row.input_purged_at&&outcome.content.state==='available')try{result=readResult(outcome.content.value);if(Buffer.byteLength(JSON.stringify(result))>2*1024*1024)result=null;}catch{result=null;}
 const expired=!!row.raw_expired_at||!!row.input_purged_at;
 await c.query(`WITH raw_state AS MATERIALIZED(SELECT q.raw_expired_at IS NOT NULL OR q.input_purged_at IS NOT NULL OR q.created_at<clock_timestamp()-w.raw_provider_evidence_days*interval '24 hours' AS expired FROM ai_search_quote q JOIN workspace w ON w.id=q.workspace_id WHERE q.id=$8)
 UPDATE ai_search_run r SET status=$2,result=CASE WHEN raw_state.expired THEN NULL ELSE $3::jsonb END,financial_evidence=$4,diagnostic=$5,completed_at=COALESCE(completed_at,clock_timestamp()),settled_at=CASE WHEN $6 THEN COALESCE(settled_at,clock_timestamp())ELSE settled_at END,lease_owner=NULL,lease_expires_at=NULL,result_purged_at=CASE WHEN $7 OR raw_state.expired THEN COALESCE(result_purged_at,clock_timestamp())ELSE result_purged_at END FROM raw_state WHERE r.id=$1`,[id,settled.reconciliationRequired?'uncertain':result?'completed':'failed',result===null?null:JSON.stringify(result),JSON.stringify(outcome.evidence),settled.reconciliationRequired?'The provider charge is uncertain. New paid work is blocked until an owner reconciles it.':result?null:(outcome.diagnostic??'The charge is recorded; retained answer evidence is unavailable.'),!settled.reconciliationRequired,expired,row.quote_id]);
 });}
export async function reconcileAiSearch(projectId:string,userId:string,id:string,raw:unknown,send:typeof fetch=fetch){
 parse(z.uuid(),id);const input=parse(aiSearchReconcileInput,raw),receiptBody={actorUserId:userId,id,input};
 const first=await projectGate(projectId,userId,true,async(c,p)=>{if(p.role!=='owner')throw new FoundationError(403,'Only an owner can reconcile a charge.');const receipt=await contentReceipt(c,p.id,input.requestId,'ai-search.reconcile',receiptBody);if(receipt.replayed)return {replayed:true as const,role:p.role,run:runDto(p,await runRow(c,p.id,id),userId,true)};
  const row=await runRow(c,p.id,id);if(row.charge_status!=='uncertain'||!row.dispatched_at)throw changed();return {replayed:false as const,row,conn:await connection(c,p.workspace_id,input.connectionId),clock:(await c.query('SELECT clock_timestamp() AS now')).rows[0].now as Date};
 });if(first.replayed)return first;
 if(preflightBusy)throw preflightUnavailable();preflightBusy=true;
 let recovered:ReturnType<typeof parseAiSearchReconciliation>|null=null,accountFingerprint:string;
 try{const key=await getProviderAccountIdentityKey(2),secret=credentials(first.conn),account=parseAiSearchAccount(await dataforseoJson('https://api.dataforseo.com/v3/appendix/user_data',secret,'GET',undefined,send),{key,version:2});accountFingerprint=account.fingerprint;if(accountFingerprint!==first.row.account_fingerprint)throw changed();
  const at=(first.row.dispatched_at as Date).getTime(),now=first.clock.getTime();if(now-at<150000||now-at>28*86400000)throw changed();
  const stamp=(v:number)=>new Date(v).toISOString().slice(0,19).replace('T',' ')+' +00:00';
  const response=await dataforseoJson(aiSearchEndpoints.reconciliation,secret,'POST',[{datetime_from:stamp(at-60000),datetime_to:stamp(at+150000),limit:1000,offset:0,sort:'asc',include_metadata:true}],send);
  try{recovered=parseAiSearchReconciliation(response,{profileId:aiSearchProfileId,runId:id,payloadHash:first.row.payload_hash,dispatchedAt:iso(first.row.dispatched_at)!,asOf:first.clock.toISOString(),providerTaskId:first.row.provider_reference});}catch{/* Inconclusive metadata is never proof of a zero charge. */}
 }finally{preflightBusy=false;}
 return projectGate(projectId,userId,true,async(c,p)=>{if(p.role!=='owner')throw changed();const receipt=await contentReceipt(c,p.id,input.requestId,'ai-search.reconcile',receiptBody);if(receipt.replayed)return {role:p.role,replayed:true,run:runDto(p,await runRow(c,p.id,id),userId,true)};
  await connection(c,p.workspace_id,input.connectionId,first.conn.revision);await c.query('SELECT id FROM ai_search_run WHERE id=$1 AND project_id=$2 FOR UPDATE',[id,p.id]);const row=await runRow(c,p.id,id);
  if(row.charge_status!=='uncertain'||row.payload_hash!==first.row.payload_hash||row.account_fingerprint!==accountFingerprint!)throw changed();
  const timely=(await c.query("SELECT dispatched_at>=clock_timestamp()-interval '28 days' AS timely FROM ai_search_run WHERE id=$1",[id])).rows[0].timely;if(!timely)throw changed();
  let code='inconclusive';if(recovered){const settled=await settleSpend(c,p.workspace_id,id,recovered.costUsd,recovered.providerTaskId);code=settled.reconciliationRequired?'inconclusive':'matched';await c.query("UPDATE ai_search_run SET status=$2,settled_at=CASE WHEN $3 THEN COALESCE(settled_at,clock_timestamp())ELSE settled_at END,completed_at=COALESCE(completed_at,clock_timestamp()),financial_evidence=$4,diagnostic='Charge reconciliation does not recover or renew answer evidence.'WHERE id=$1",[id,settled.reconciliationRequired?'uncertain':'reconciled',!settled.reconciliationRequired,JSON.stringify({statusCode:recovered.statusCode,costUsd:recovered.costUsd,providerTaskId:recovered.providerTaskId})]);}
  await receipt.save({actorUserId:userId,runId:id,operation:'reconcile',outcomeCode:code});return {role:p.role,replayed:false,outcome:code,run:runDto(p,await runRow(c,p.id,id),userId,true)};
 });
}
export async function reconcileAiSearchJobs(){
 const rows=(await getDatabase().pool.query(`SELECT r.id FROM ai_search_run r JOIN ai_search_quote q ON q.id=r.quote_id LEFT JOIN pgboss.job j ON j.id=r.id AND j.name=$1 WHERE r.status IN('queued','running')AND(r.lease_expires_at<=clock_timestamp()OR j.id IS NULL OR j.state IN('failed','cancelled','completed')OR q.expires_at<=clock_timestamp()OR EXISTS(SELECT 1 FROM provider_request p WHERE p.id=r.id AND p.status='cancelled'))ORDER BY r.created_at,r.id LIMIT 50`,[aiSearchQueue])).rows;
 for(const {id}of rows)await withRun(id,async(c,row)=>{
  if(row.status==='queued'){const stale=(await c.query(`SELECT 1 FROM ai_search_run r JOIN ai_search_quote q ON q.id=r.quote_id LEFT JOIN pgboss.job j ON j.id=r.id AND j.name=$2 WHERE r.id=$1 AND(r.lease_expires_at<=clock_timestamp()OR j.id IS NULL OR j.state IN('failed','cancelled','completed')OR q.expires_at<=clock_timestamp())`,[id,aiSearchQueue])).rowCount;if(stale||row.charge_status==='cancelled')await cancelReserved(c,row,'The queued capture ended before dispatch. No paid request was retried.');}
  else if(row.status==='running'&&row.lease_expired&&['dispatched','uncertain'].includes(row.charge_status)){await settleSpend(c,row.workspace_id,id,null,row.provider_reference);await c.query("UPDATE ai_search_run SET status='uncertain',lease_owner=NULL,lease_expires_at=NULL,completed_at=COALESCE(completed_at,clock_timestamp()),diagnostic='The worker stopped after dispatch. An owner must reconcile; no paid request will be retried.'WHERE id=$1",[id]);}
 });
}
export async function expireAiSearch(c:PoolClient,projectId:string,cutoff:Date){
 await latchAiSearchExpiry(c,[projectId],cutoff);
 const results=await c.query(`WITH candidates AS(SELECT r.id FROM ai_search_run r JOIN ai_search_quote q ON q.id=r.quote_id WHERE r.project_id=$1 AND q.raw_expired_at IS NOT NULL AND r.result IS NOT NULL ORDER BY r.created_at,r.id LIMIT 100 FOR UPDATE OF r)UPDATE ai_search_run r SET result=NULL,result_purged_at=COALESCE(result_purged_at,clock_timestamp())FROM candidates c WHERE r.id=c.id`,[projectId]);
 const inputs=await c.query(`WITH candidates AS(SELECT q.id FROM ai_search_quote q WHERE q.project_id=$1 AND q.raw_expired_at IS NOT NULL AND q.input IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_search_run r WHERE r.quote_id=q.id AND r.status IN('queued','running'))ORDER BY q.created_at,q.id LIMIT 100 FOR UPDATE OF q)UPDATE ai_search_quote q SET input=NULL,input_purged_at=COALESCE(input_purged_at,clock_timestamp())FROM candidates c WHERE q.id=c.id`,[projectId]);
 const quotes=await c.query(`WITH candidates AS(SELECT q.id FROM ai_search_quote q WHERE q.project_id=$1 AND q.created_at<clock_timestamp()-interval '24 hours'AND NOT EXISTS(SELECT 1 FROM ai_search_run r WHERE r.quote_id=q.id)ORDER BY q.created_at,q.id LIMIT 100)DELETE FROM ai_search_quote q USING candidates c WHERE q.id=c.id`,[projectId]);
 const pending=(await c.query(`SELECT EXISTS(SELECT 1 FROM ai_search_quote q WHERE q.project_id=$1 AND q.raw_expired_at IS NOT NULL AND(q.input IS NOT NULL OR EXISTS(SELECT 1 FROM ai_search_run r WHERE r.quote_id=q.id AND r.result IS NOT NULL)))OR EXISTS(SELECT 1 FROM ai_search_quote q WHERE q.project_id=$1 AND q.created_at<clock_timestamp()-interval '24 hours'AND NOT EXISTS(SELECT 1 FROM ai_search_run r WHERE r.quote_id=q.id))AS pending`,[projectId])).rows[0].pending as boolean;
 return {expiredAiSearchResults:results.rowCount??0,expiredAiSearchInputs:inputs.rowCount??0,expiredAiSearchQuotes:quotes.rowCount??0,pending};
}
export async function previewAiSearchRetention(c:PoolClient,workspaceId:string,cutoff:Date){
 const rows=(await c.query(`SELECT q.id,q.input IS NOT NULL AS input,EXISTS(SELECT 1 FROM ai_search_run r WHERE r.quote_id=q.id AND r.result IS NOT NULL)AS result,EXISTS(SELECT 1 FROM ai_search_run r WHERE r.quote_id=q.id AND r.status IN('queued','running'))AS protected FROM ai_search_quote q WHERE q.workspace_id=$1 AND(q.raw_expired_at IS NOT NULL OR q.created_at<$2)AND(q.input IS NOT NULL OR EXISTS(SELECT 1 FROM ai_search_run r WHERE r.quote_id=q.id AND r.result IS NOT NULL))ORDER BY q.created_at,q.id LIMIT 10001`,[workspaceId,cutoff])).rows;
 return {status:'available' as const,inputs:rows.slice(0,10000).filter(r=>r.input).length,results:rows.slice(0,10000).filter(r=>r.result).length,protected:rows.slice(0,10000).filter(r=>r.input&&r.protected).length,atLeast:rows.length>10000};
}
