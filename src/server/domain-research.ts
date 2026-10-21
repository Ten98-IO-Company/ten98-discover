import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {credentialKeys} from './credential-vault.ts';
import {usd} from './providers.ts';
import {reserveSpend,dispatchSpend,settleSpend,requestHash} from './spending.ts';
import {withKeywordProject,keywordConnection,keywordCredentials,refreshKeywordMarkets} from './keyword-research.ts';
import {readKeywordAccount} from './dataforseo-keywords.ts';
import {microUsd,type KeywordMarket} from './keyword-research-input.ts';
import {type DomainOrganicMetrics} from './domain-research-input.ts';
import {parseDomainResearchRequest,domainResearchPriceMode,isBacklinkRequest,type DomainResearchRequest,type DomainResearchResult} from './backlink-research-input.ts';
import {requestBacklinkResearch,reconcileBacklinkCharge,type BacklinkOutcome} from './dataforseo-backlinks.ts';
import {csvCell} from './explorer-input.ts';
import {requestDomainResearch,reconcileDomainCharge,type DomainOutcome} from './dataforseo-domains.ts';
import {workspaceRoles} from '@ten98/runtime';

export const domainResearchQueue='domain-research';
const readers=[...workspaceRoles],writers=['owner','admin','editor'];
const runSelect=`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at)
 SELECT r.*,q.request,q.connection_id,q.connection_revision,q.account_fingerprint,q.expires_at,q.estimate_micros,p.actual_micros,p.status AS charge_status,p.provider_reference,
 CASE WHEN r.completed_at>=read_clock.at-make_interval(days=>w.derived_history_days) AND r.result_purged_at IS NULL THEN r.result END AS result,
 (r.result_purged_at IS NOT NULL OR r.completed_at<read_clock.at-make_interval(days=>w.derived_history_days) AND r.result IS NOT NULL) AS result_expired
 FROM domain_research_run r JOIN domain_research_quote q ON q.id=r.quote_id JOIN provider_request p ON p.id=r.id JOIN workspace w ON w.id=r.workspace_id CROSS JOIN read_clock`;
function parse<T extends z.ZodType>(schema:T,value:unknown):z.output<T>{const result=schema.safeParse(value);if(!result.success)throw new FoundationError(400,'Check the domain research fields.');return result.data;}
function bounded<T>(value:T):T{if(Buffer.byteLength(JSON.stringify(value),'utf8')>2097152)throw new FoundationError(413,'This complete domain research response is too large. Choose a smaller result limit for a new quote.');return value;}
function summary(row:any){return {id:row.id,quoteId:row.quote_id,request:row.request,status:row.status,createdAt:row.created_at,completedAt:row.completed_at,estimateUsd:usd(row.estimate_micros),actualUsd:row.actual_micros===null?null:usd(row.actual_micros),chargeStatus:row.charge_status};}
function dto(row:any,userId:string,role:string){return {...summary(row),canCancel:row.status==='queued'&&row.charge_status==='reserved'&&(row.user_id===userId||role==='owner'),diagnostic:row.diagnostic,result:row.result,resultExpired:row.result_expired};}
function ack(row:any,userId:string,role:string){const {result,...receipt}=dto(row,userId,role);return receipt;}
async function runRow(client:PoolClient,projectId:string,id:string){const row=(await client.query(runSelect+' WHERE r.id=$1 AND r.project_id=$2',[id,projectId])).rows[0];if(!row)throw new FoundationError(404,'Domain research run not found or unavailable.');return row;}
export async function getDomainResearch(projectId:string,userId:string){return withKeywordProject(projectId,userId,readers,async(client,wid,role)=>{
 const connections=(await client.query(`SELECT id,name,check_status AS "checkStatus" FROM provider_connection WHERE workspace_id=$1 AND provider='dataforseo' AND revoked_at IS NULL ORDER BY created_at,id`,[wid])).rows;
 const catalog=(await client.query('SELECT updated_at AS "updatedAt",markets FROM keyword_market_catalog WHERE workspace_id=$1',[wid])).rows[0]??{updatedAt:null,markets:[]};
 const paused=(await client.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1',[wid])).rows[0]?.paused??false;
 const runs=(await client.query(runSelect+' WHERE r.project_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 20',[projectId])).rows.map(summary);
 return bounded({role,vaultConfigured:credentialKeys()!==null,spendingPaused:paused,connections,catalog,runs});
});}
export async function getDomainResearchRun(projectId:string,userId:string,id:string){parse(z.uuid(),id);return withKeywordProject(projectId,userId,readers,async(client,_wid,role)=>bounded({role,run:dto(await runRow(client,projectId,id),userId,role)}));}
export function domainReportCsv(result:DomainResearchResult){
 const lines:unknown[][]=[];
 if(result.source==='DataForSEO Backlinks'){
  lines.push(['Report',result.report],['Target',result.target],['Scope',result.scope],['Status filter',result.status],['Source',result.source],['Retrieved at',result.retrievedAt],['Returned',result.returnedCount],['Provider total',result.totalCount],['Partial',result.limited],['Rank meaning','DataForSEO rank, 0–100; not Ahrefs Domain Rating or Semrush Authority Score.'],['Unavailable', 'Missing metrics are unavailable, not zero. No alias consolidation.']);
  if(result.report==='backlinks_overview_v1')lines.push(['Population','Direct external backlinks; internal and indirect links excluded. Folder rank unavailable.'],['Backlinks','Referring domains (including subdomains)','Referring main domains','Referring pages','Referring IPs','Referring subnets','Broken backlinks','Backlink spam score','DataForSEO rank (0–100)','First seen','Lost at'],...result.rows.map(r=>[r.backlinks,r.referringDomains,r.referringMainDomains,r.referringPages,r.referringIps,r.referringSubnets,r.brokenBacklinks,r.spamScore,r.rank,r.firstSeen,r.lostAt]));
  else if(result.report==='backlinks_profile_v1')lines.push(['Population','Highest-ranked backlink per referring page; Links count retains page multiplicity.'],['Offset',result.offset],['Limit',result.limit],['Follow filter',result.follow],['Source host filter',result.sourceHost],['Order',result.order],['Source URL','Target URL','Source domain','Target domain','Link rank (0–100)','Source page rank (0–100)','Source domain rank (0–100)','Spam score','Dofollow','Lost','Broken','Anchor','First seen','Last seen','Links count'],...result.rows.map(r=>[r.sourceUrl,r.targetUrl,r.sourceDomain,r.targetDomain,r.rank,r.pageRank,r.domainRank,r.spamScore,r.dofollow,r.isLost,r.isBroken,r.anchor,r.firstSeen,r.lastSeen,r.linksCount]));
  else lines.push(['Population',result.report==='backlinks_referring_domains_v1'?'Provider main-domain groups; subdomains counted together. Counts are native grouped observations, not alias-deduplicated unique links.':'Provider exact anchor-text groups. Counts are native grouped observations, not alias-deduplicated unique links.'],['Offset',result.offset],['Limit',result.limit],['Initial backlink follow filter',result.follow],['Initial backlink source host filter',result.sourceHost],['Order',result.order],[result.report==='backlinks_referring_domains_v1'?'Referring main domain':'Anchor text','Backlinks','Referring domains (including subdomains)','Referring main domains','Referring pages','Referring pages with nofollow','Referring IPs','Referring subnets','Broken backlinks','Broken pages','DataForSEO rank (0–100)','Spam score','First seen','Last backlink lost at'],...result.rows.map(r=>['domain'in r?r.domain:r.anchor,r.backlinks,r.referringDomains,r.referringMainDomains,r.referringPages,r.referringPagesNofollow,r.referringIps,r.referringSubnets,r.brokenBacklinks,r.brokenPages,r.rank,r.spamScore,r.firstSeen,r.lostAt]));
 }else{
 const distribution=['Position 1','Positions 2–3','Positions 4–10','Positions 11–20','Positions 21–30','Positions 31–40','Positions 41–50','Positions 51–60','Positions 61–70','Positions 71–80','Positions 81–90','Positions 91–100'];
 const metricHeaders=['Ranking keywords','Estimated monthly organic traffic','Estimated equivalent ads value (USD)',...distribution];
 const values=(m:DomainOrganicMetrics)=>[m.rankedKeywords,m.estimatedTraffic,m.estimatedAdsValueUsd,...m.rankDistribution];
 lines.push(['Report',result.report??'ranked_keywords'],['Target',result.target],['Scope',result.scope],['Location code',result.locationCode],['Language code',result.languageCode],['Source',result.source],['Retrieved at',result.retrievedAt],['Returned',result.returnedCount],['Provider total',result.totalCount],['Partial',result.limited],['Metric meaning','Provider estimates, not measured visits. Equivalent ads value is not the research charge.']);
 if(result.report==='overview_v1')lines.push(metricHeaders,...result.rows.map(values));
 else if(result.report==='pages_v1')lines.push(['Page URL',...metricHeaders],...result.rows.map(r=>[r.url,...values(r.organic)]));
 else if(result.report==='competitors_v1')lines.push(['Competitor domain','Shared ranking keywords','Competitor average position on shared keywords',...metricHeaders.map(h=>'Competitor full domain: '+h),...metricHeaders.map(h=>'Target on shared keywords: '+h)],...result.rows.map(r=>[r.domain,r.sharedKeywords,r.averagePosition,...values(r.fullDomain),...values(r.targetOverlap)]));
 else lines.push(['Keyword','Absolute position','Search volume','Estimated traffic','CPC (USD)','Difficulty','Ranking URL','Metrics updated at'],...result.rows.map(r=>[r.keyword,r.position,r.searchVolume,r.estimatedTraffic,r.cpcUsd,r.keywordDifficulty,r.url,r.metricsUpdatedAt]));
 }
 const csv=lines.map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n';
 if(Buffer.byteLength(csv,'utf8')>2097152)throw new FoundationError(413,'The complete CSV exceeds 2 MiB.');return csv;
}
export async function exportDomainResearchRun(projectId:string,userId:string,id:string){parse(z.uuid(),id);return withKeywordProject(projectId,userId,readers,async(client,_wid,role)=>{
 const row=await runRow(client,projectId,id);if(row.result_expired||!row.result)throw new FoundationError(409,'This report has no currently retained rows to export. Reload its receipt.');
 const result=row.result as DomainResearchResult;return bounded({role,run:ack(row,userId,role),csv:domainReportCsv(result),rowCount:result.returnedCount});
});}
async function getDomainResearchAck(projectId:string,userId:string,id:string){return withKeywordProject(projectId,userId,readers,async(client,_wid,role)=>bounded({role,run:ack(await runRow(client,projectId,id),userId,role)}));}
export const refreshDomainResearchMarkets=refreshKeywordMarkets;
export async function quoteDomainResearch(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
 const request=parseDomainResearchRequest(raw);
 const saved=await withKeywordProject(projectId,userId,writers,async(client,wid)=>{
  if(!isBacklinkRequest(request)){
   const catalog=(await client.query("SELECT markets FROM keyword_market_catalog WHERE workspace_id=$1 AND updated_at>clock_timestamp()-interval '7 days'",[wid])).rows[0];
   if(!catalog||(catalog.markets as KeywordMarket[]).every(m=>m.locationCode!==request.locationCode||m.languageCode!==request.languageCode))throw new FoundationError(409,'Refresh markets and choose a supported location and language before preparing a quote.');
  }
  const conn=await keywordConnection(client,wid,request.connectionId);return {revision:conn.revision,name:conn.name,credentials:keywordCredentials(conn)};
 });
 const price=await readKeywordAccount(saved.credentials,domainResearchPriceMode(request),send),estimate=price.perTask+price.perItem*BigInt(request.limit);
 if(estimate<1n||estimate>1000000000000n)throw new FoundationError(502,'The provider price is outside supported budget limits.');
 return withKeywordProject(projectId,userId,writers,async(client,wid,role)=>{
  await keywordConnection(client,wid,request.connectionId,saved.revision);
  if(!isBacklinkRequest(request)){
   const catalog=(await client.query("SELECT markets FROM keyword_market_catalog WHERE workspace_id=$1 AND updated_at>clock_timestamp()-interval '7 days'",[wid])).rows[0];
   if(!catalog||(catalog.markets as KeywordMarket[]).every(m=>m.locationCode!==request.locationCode||m.languageCode!==request.languageCode))throw new FoundationError(409,'Supported markets changed while pricing. Refresh markets and prepare a new quote.');
  }
  const row=(await client.query(`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
   INSERT INTO domain_research_quote(id,workspace_id,project_id,user_id,connection_id,connection_revision,request,account_fingerprint,per_task_micros,per_item_micros,estimate_micros,price_as_of,expires_at,created_at)
   SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,at,at+interval '5 minutes',at FROM clock RETURNING id,expires_at,price_as_of`,[randomUUID(),wid,projectId,userId,request.connectionId,saved.revision,JSON.stringify(request),price.fingerprint,price.perTask.toString(),price.perItem.toString(),estimate.toString()])).rows[0];
  return {role,quote:{id:row.id,expiresAt:row.expires_at,priceAsOf:row.price_as_of,request,connectionName:saved.name,estimateUsd:microUsd(estimate),perTaskUsd:microUsd(price.perTask),perItemUsd:microUsd(price.perItem),upperItems:request.limit}};
 });
}
export async function startDomainResearch(projectId:string,userId:string,raw:unknown){
 const {quoteId,requestKey}=parse(z.object({quoteId:z.uuid(),requestKey:z.uuid()}).strict(),raw);
 const saved=await withKeywordProject(projectId,userId,writers,async(client,wid)=>{const q=(await client.query('SELECT * FROM domain_research_quote WHERE id=$1 AND project_id=$2 AND user_id=$3',[quoteId,projectId,userId])).rows[0];if(!q)throw new FoundationError(404,'Quote not found or unavailable.');return {quote:q,wid};});
 const boss=await getBoss();
 const reserved=await reserveSpend(saved.wid,userId,{connectionId:saved.quote.connection_id,requestKey,operation:'domain.'+domainResearchPriceMode(parseDomainResearchRequest(saved.quote.request)),inputHash:requestHash(JSON.stringify({projectId,quoteId,request:saved.quote.request})),estimateUsd:usd(saved.quote.estimate_micros)},async(client,id)=>{
  await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[projectId,saved.wid]);
  const q=(await client.query('SELECT * FROM domain_research_quote WHERE id=$1 AND workspace_id=$2 AND project_id=$3 AND user_id=$4 AND expires_at>clock_timestamp() FOR UPDATE',[quoteId,saved.wid,projectId,userId])).rows[0];
  if(!q)throw new FoundationError(409,'The quote expired. Prepare a new quote before starting.');
  await keywordConnection(client,saved.wid,q.connection_id,q.connection_revision);
  if((await client.query('SELECT 1 FROM domain_research_run WHERE quote_id=$1',[quoteId])).rowCount)throw new FoundationError(409,'This quote already has a run. Open that receipt or prepare a new quote.');
  await client.query("INSERT INTO domain_research_run(id,workspace_id,project_id,user_id,quote_id,status) VALUES($1,$2,$3,$4,$5,'queued')",[id,saved.wid,projectId,userId,quoteId]);
  // One free30s account check plus one paid30s request; no provider retry.
  if(!await boss.send(domainResearchQueue,{runId:id},{id,retryLimit:0,expireInSeconds:90,db:{executeSql:(text,values)=>client.query(text,values)}}))throw new Error('Domain research could not be queued.');
 });
 return getDomainResearchAck(projectId,userId,reserved.id);
}
export async function cancelDomainResearch(projectId:string,userId:string,id:string,raw:unknown){
 parse(z.uuid(),id);parse(z.object({}).strict(),raw);
 return withKeywordProject(projectId,userId,writers,async(client,wid,role)=>{
  const row=await runRow(client,projectId,id);if(row.user_id!==userId&&role!=='owner')throw new FoundationError(403,'Only the initiating user or owner can cancel this run.');
  if(row.status!=='queued'||row.charge_status!=='reserved')throw new FoundationError(409,'Only an undispatched run can be cancelled.');
  await client.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND status='reserved'",[id,wid]);
  await client.query("UPDATE domain_research_run SET status='cancelled',completed_at=clock_timestamp(),diagnostic='Cancelled before dispatch.' WHERE id=$1",[id]);
  return bounded({role,run:ack(await runRow(client,projectId,id),userId,role)});
 });
}
async function cancelUndispatched(id:string){
 const row=(await getDatabase().pool.query('SELECT project_id,user_id FROM domain_research_run WHERE id=$1',[id])).rows[0];if(!row)return;
 // Worker cleanup settles authorization loss even when the initiator no longer has access.
 const client=await getDatabase().pool.connect();try{await client.query('BEGIN');const found=(await client.query('SELECT workspace_id FROM domain_research_run WHERE id=$1',[id])).rows[0];if(found){await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[found.workspace_id]);await client.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND status='reserved'",[id]);await client.query(`UPDATE domain_research_run r SET status='cancelled',completed_at=clock_timestamp(),diagnostic='Quote, permissions, connection, account, the paid-work pause or an uncertain charge changed before dispatch.' WHERE r.id=$1 AND r.status='queued' AND EXISTS(SELECT 1 FROM provider_request p WHERE p.id=r.id AND p.status='cancelled')`,[id]);}await client.query('COMMIT');}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
async function finish(id:string,outcome:DomainOutcome|BacklinkOutcome,crashOnly=false){
 const client=await getDatabase().pool.connect();try{await client.query('BEGIN');const found=(await client.query('SELECT workspace_id FROM domain_research_run WHERE id=$1',[id])).rows[0];if(!found){await client.query('COMMIT');return;}
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[found.workspace_id]);
  const row=(await client.query(runSelect+' WHERE r.id=$1',[id])).rows[0];
  if(!row||!['running','uncertain'].includes(row.status)||crashOnly&&(row.status!=='running'||row.charge_status!=='dispatched'||!(await client.query("SELECT 1 FROM domain_research_run WHERE id=$1 AND dispatched_at<clock_timestamp()-interval '120 seconds'",[id])).rowCount)){await client.query('COMMIT');return;}
  const settled=await settleSpend(client,row.workspace_id,id,outcome.cost,outcome.reference),status=settled.reconciliationRequired?'uncertain':outcome.result?'completed':'failed';
  await client.query('UPDATE domain_research_run SET status=$2,diagnostic=$3,result=$4,reconciliation_evidence=$5,completed_at=COALESCE(completed_at,clock_timestamp()) WHERE id=$1',[id,status,outcome.diagnostic,outcome.result===null?null:JSON.stringify(outcome.result),JSON.stringify(outcome.evidence)]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function executeDomainResearch(id:string,send:typeof fetch=fetch){
 parse(z.uuid(),id);const initial=(await getDatabase().pool.query(runSelect+' WHERE r.id=$1',[id])).rows[0];if(!initial||initial.status!=='queued')return;
 let secret:unknown,request:DomainResearchRequest;
 try{
  const saved=await withKeywordProject(initial.project_id,initial.user_id,writers,async(client,wid)=>{const row=await runRow(client,initial.project_id,id);if(row.status!=='queued'||row.charge_status!=='reserved')throw new FoundationError(409,'Research is no longer queued.');return keywordCredentials(await keywordConnection(client,wid,row.connection_id,row.connection_revision));});
  const account=await readKeywordAccount(saved,domainResearchPriceMode(parseDomainResearchRequest(initial.request)),send);
  await dispatchSpend(initial.workspace_id,initial.user_id,id,async(client,ledger)=>{
   if(!(await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[initial.project_id,initial.workspace_id])).rowCount)throw new FoundationError(404,'Project unavailable.');
   const row=await runRow(client,initial.project_id,id);
   if(row.status!=='queued'||row.account_fingerprint!==account.fingerprint||!(await client.query('SELECT 1 FROM domain_research_quote WHERE id=$1 AND expires_at>clock_timestamp()',[row.quote_id])).rowCount)throw new FoundationError(409,'Research authorization expired or changed.');
   secret=keywordCredentials(await keywordConnection(client,initial.workspace_id,ledger.connection_id,ledger.connection_revision));request=parseDomainResearchRequest(row.request);
   if(account.perTask+account.perItem*BigInt(request.limit)>BigInt(row.estimate_micros))throw new FoundationError(409,'The current provider price exceeds this quote. Prepare a new quote.');
   await client.query("UPDATE domain_research_run SET status='running',dispatched_at=clock_timestamp() WHERE id=$1",[id]);
  });
 }catch(e){if(e instanceof FoundationError){await cancelUndispatched(id);return;}throw e;}
 const accepted=request!;await finish(id,isBacklinkRequest(accepted)?await requestBacklinkResearch(secret,accepted,id,send):await requestDomainResearch(secret,accepted,id,send));
}
export async function reconcileDomainResearch(projectId:string,userId:string,id:string,raw:unknown,send:typeof fetch=fetch){
 parse(z.uuid(),id);const {connectionId}=parse(z.object({connectionId:z.uuid()}).strict(),raw);
 const saved=await withKeywordProject(projectId,userId,['owner'],async(client,wid)=>{const row=await runRow(client,projectId,id);if(row.status!=='uncertain'||row.charge_status!=='uncertain'||!row.dispatched_at)throw new FoundationError(409,'This run does not need charge reconciliation.');const conn=await keywordConnection(client,wid,connectionId);return {row,revision:conn.revision,credentials:keywordCredentials(conn)};});
 let matched:{reference:string;cost:string;statusCode:number};
 try{const account=await readKeywordAccount(saved.credentials,undefined,send);if(account.fingerprint!==saved.row.account_fingerprint)throw new FoundationError(409,'Choose the original provider account to reconcile this receipt.');const request=parseDomainResearchRequest(saved.row.request);matched=isBacklinkRequest(request)?await reconcileBacklinkCharge(saved.credentials,request,id,saved.row.dispatched_at,send):await reconcileDomainCharge(saved.credentials,request,id,saved.row.dispatched_at,send);if(saved.row.provider_reference!==null&&matched.reference!==saved.row.provider_reference)throw new FoundationError(409,'The task differs from this receipt.');}
 catch(e){if(e instanceof FoundationError)return {...await getDomainResearchAck(projectId,userId,id),reconciliation:{status:'inconclusive',message:e.message}};throw e;}
 return withKeywordProject(projectId,userId,['owner'],async(client,wid,role)=>{
  await keywordConnection(client,wid,connectionId,saved.revision);const row=await runRow(client,projectId,id);
  if(row.charge_status!=='uncertain'||row.provider_reference!==null&&matched.reference!==row.provider_reference||!(await client.query("SELECT 1 FROM domain_research_run WHERE id=$1 AND dispatched_at>=clock_timestamp()-interval '28 days'",[id])).rowCount)throw new FoundationError(409,'The receipt changed or its lookup window expired. Reload it.');
  const settled=await settleSpend(client,wid,id,matched.cost,matched.reference);
  await client.query('UPDATE domain_research_run SET status=$2,diagnostic=$3,reconciliation_evidence=$4,completed_at=COALESCE(completed_at,clock_timestamp()) WHERE id=$1',[id,settled.reconciliationRequired?'uncertain':row.result?'completed':'reconciled',settled.reconciliationRequired?'The charge remains unresolved.':'Charge recovered; original unavailable content is not recreated.',JSON.stringify({source:isBacklinkRequest(parseDomainResearchRequest(row.request))?'backlinks/id_list':'dataforseo_labs/id_list',taskId:matched.reference,statusCode:matched.statusCode,actualUsd:matched.cost,checkedAt:new Date().toISOString()})]);
  return bounded({role,run:ack(await runRow(client,projectId,id),userId,role),reconciliation:{status:settled.reconciliationRequired?'inconclusive':'matched',message:'Review the recorded charge.'}});
 });
}
export async function reconcileDomainResearchJobs(){
 const rows=(await getDatabase().pool.query(`SELECT r.id,r.status FROM domain_research_run r JOIN domain_research_quote q ON q.id=r.quote_id LEFT JOIN pgboss.job j ON j.id=r.id AND j.name=$1
  WHERE (r.status='queued' AND (q.expires_at<=clock_timestamp() OR j.id IS NULL OR j.state IN('failed','cancelled','completed'))) OR (r.status='running' AND r.dispatched_at<clock_timestamp()-interval '120 seconds') ORDER BY r.created_at LIMIT 50`,[domainResearchQueue])).rows;
 for(const row of rows)if(row.status==='queued')await cancelUndispatched(row.id);else await finish(row.id,{cost:null,reference:null,result:null,diagnostic:'The worker stopped after dispatch. Reconcile the charge; this request will not be sent again.',evidence:{httpStatus:null,statusCode:null,taskStatus:null,reportedCost:null,taskCost:null}},true);
}
