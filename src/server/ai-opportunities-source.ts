import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse} from './context-input.ts';
import {withContentProject,type ContentProject} from './project-context.ts';
import {selectPromptInsights} from './prompt-insights.ts';
import {selectCitationEvidence,type CitationFilters} from './prompt-citations.ts';
import {classifierVersion,ownershipVersion,googleDomainsVersion} from './citation-classification.ts';
import {opportunitiesScopeSchema,opportunitiesLimits,type OpportunitiesScope,type OpportunitiesEvidence} from '../lib/ai-opportunities.ts';
import {createOpportunitiesSnapshot,opportunitiesEvidenceHash,opportunitiesBusinessIdentity,opportunitiesAvailability,opportunitiesMessages,type OpportunitiesSnapshot} from './ai-opportunities-input.ts';

export type OpportunitySourceDependency={executionId:string;comparisonId:string;quoteId:string;promptId:string;versionId:string;quoteCreatedAt:string;requestedAt:string;completedAt:string;resultHash:string;requestHash:string};
export type OpportunitiesSource={snapshot:OpportunitiesSnapshot;evidenceHash:string;businessInputHash:string;dependencies:OpportunitySourceDependency[];availability:'available'|'insufficient-evidence';asOf:string;warnings:string[]};
type Policy={retentionRevision:number;rawDays:number;derivedDays:number};
type Metadata={executionId:string;comparisonId:string;quoteId:string;promptId:string;versionId:string;quoteCreatedAt:string;requestedAt:string;completedAt:string|null;resultHash:string|null;inputPurged:boolean;expired:boolean};
const clock=(expression:string)=>`to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const changed=()=>new FoundationError(409,'The opportunity source population or saved request identity is inconsistent. Reload the source.');
const expired=()=>new FoundationError(410,'The selected opportunity source evidence expired or became unavailable. Reload the source.');
const cap=()=>new FoundationError(413,'The complete opportunity source exceeds its capacity. Narrow the date, model, prompt or tag filters.');
const priorWarning='Citation selection also checks the preceding equal-length period against native population limits. Only current-period evidence is included in these opportunities.';
const policySql='SELECT w.retention_revision AS "retentionRevision",w.raw_provider_evidence_days AS "rawDays",w.derived_history_days AS "derivedDays" FROM project p JOIN workspace w ON w.id=p.workspace_id WHERE p.id=$1';

/** Caller owns membership and workspace-before-project locks (SHARE for reads, UPDATE
 * for lifecycle work). Never starts a transaction or acquires another connection. */
export async function selectOpportunitiesSource(client:PoolClient,project:ContentProject,rawScope:OpportunitiesScope,check:()=>void):Promise<OpportunitiesSource>{
 check();const scope=parse(opportunitiesScopeSchema,rawScope);
 const policy=(await client.query<Policy>(policySql,[project.id])).rows[0];if(!policy)throw changed();check();
 const insights=await selectPromptInsights(client,project,scope,check,true,false);
 const filters:CitationFilters={from:scope.from,to:scope.to,timeZone:scope.timeZone,model:scope.model,promptId:scope.promptId,tag:scope.tag,urlGrouping:'retained-fragment-v1',query:null,publisherCategory:null,pageType:null,sourceType:null,ownership:null,entityId:null};
 let citations:Awaited<ReturnType<typeof selectCitationEvidence>>;
 try{citations=await selectCitationEvidence(client,project,filters,check);}catch(error){if(error instanceof FoundationError&&error.status===413)throw new FoundationError(413,priorWarning+' Narrow the source filters.');throw error;}
 const current=citations.selected.observations.filter(o=>o.date>=scope.from&&o.date<=scope.to);
 const identity=(rows:typeof current)=>rows.map(({matches:_,...row})=>row).sort((a,b)=>a.id.localeCompare(b.id));
 if(canonicalHash(identity(current))!==canonicalHash(identity(insights.observations))||insights.report.contextRevision!==citations.selected.report.contextRevision||canonicalHash(insights.report.subjects)!==canonicalHash(citations.selected.report.subjects)||canonicalHash(insights.citationCategoryOverrides)!==canonicalHash(citations.selected.citationCategoryOverrides))throw changed();
 const eligible=insights.observations.filter(o=>o.eligibility==='eligible'),ids=eligible.map(o=>o.id),currentCitations=citations.evidence.filter(c=>c.period==='current');
 if(eligible.length>opportunitiesLimits.executions||new Set(eligible.map(o=>o.versionId)).size>opportunitiesLimits.prompts||currentCitations.length>opportunitiesLimits.citations)throw cap();
 for(const row of eligible){const identity=insights.identities.get(row.id);if(identity?.state==='unavailable')throw expired();if(identity?.state!=='available'||!identity.requestHash||!row.matches)throw changed();}
 check();
 // Native readers bound and validate payloads. This query adds only immutable joins,
 // completion clocks and the same PostgreSQL jsonb hash; expired results are not hashed.
 const metadata=ids.length?(await client.query<Metadata>(`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at)
 SELECT e.id AS "executionId",c.id AS "comparisonId",q.id AS "quoteId",q.prompt_id AS "promptId",q.version_id AS "versionId",
 ${clock('q.created_at')} AS "quoteCreatedAt",${clock('c.created_at')} AS "requestedAt",${clock('e.completed_at')} AS "completedAt",
 q.input_purged_at IS NOT NULL AS "inputPurged",
 (e.result_purged_at IS NOT NULL OR e.completed_at<read_clock.at-w.raw_provider_evidence_days*interval '24 hours') AS expired,
 CASE WHEN e.result_purged_at IS NULL AND e.result IS NOT NULL AND e.completed_at IS NOT NULL AND e.completed_at<=read_clock.at AND e.completed_at>=read_clock.at-w.raw_provider_evidence_days*interval '24 hours'
 THEN encode(sha256(convert_to(e.result::text,'UTF8')),'hex') END AS "resultHash"
 FROM prompt_execution e JOIN prompt_comparison c ON c.id=e.comparison_id AND c.project_id=e.project_id AND c.workspace_id=e.workspace_id
 JOIN prompt_execution_quote q ON q.id=c.quote_id AND q.project_id=c.project_id AND q.workspace_id=c.workspace_id
 JOIN prompt_text_version v ON v.id=q.version_id AND v.prompt_id=q.prompt_id AND v.project_id=q.project_id
 JOIN project p ON p.id=e.project_id AND p.workspace_id=e.workspace_id JOIN workspace w ON w.id=p.workspace_id CROSS JOIN read_clock
 WHERE e.project_id=$1 AND e.id=ANY($2::uuid[])`,[project.id,ids])).rows:[];
 if(metadata.length!==ids.length||new Set(metadata.map(r=>r.executionId)).size!==ids.length)throw changed();
 const byId=new Map(metadata.map(r=>[r.executionId,r])),dependencies:OpportunitySourceDependency[]=[];
 const executions:OpportunitiesEvidence['executions']=eligible.map(o=>{
  check();const m=byId.get(o.id);if(!m||m.comparisonId!==o.comparisonId||m.promptId!==o.promptId||m.versionId!==o.versionId||m.requestedAt!==o.requestedAt)throw changed();
  if(m.expired||m.inputPurged)throw expired();if(!m.completedAt||!m.resultHash||m.completedAt<m.requestedAt)throw changed();
  const requestHash=insights.identities.get(o.id)!.requestHash!;
  dependencies.push({executionId:m.executionId,comparisonId:m.comparisonId,quoteId:m.quoteId,promptId:m.promptId,versionId:m.versionId,quoteCreatedAt:m.quoteCreatedAt,requestedAt:m.requestedAt,completedAt:m.completedAt,resultHash:m.resultHash,requestHash});
  return {id:o.id,promptId:o.promptId,versionId:o.versionId,requestedAt:o.requestedAt,completedAt:m.completedAt,resultHash:m.resultHash,requestHash,model:o.model,brandMentioned:o.matches!.find(s=>s.id==='brand')!.mentioned,competitorIds:o.matches!.filter(s=>s.id!=='brand'&&s.mentioned).map(s=>s.id)};
 });
 const versionIds=[...new Set(eligible.map(o=>o.versionId))];
 const prompts=versionIds.length?(await client.query<OpportunitiesEvidence['prompts'][number]>(`SELECT v.prompt_id AS id,v.id AS "versionId",v.text,p.user_tags AS tags FROM prompt_text_version v JOIN project_prompt p ON p.id=v.prompt_id AND p.project_id=v.project_id WHERE v.project_id=$1 AND v.id=ANY($2::uuid[])`,[project.id,versionIds])).rows:[];
 if(prompts.length!==versionIds.length)throw changed();if(prompts.some(p=>p.text.length>4000)||currentCitations.some(c=>(c.retainedTitle?.length??0)>4000))throw cap();
 const citationRows:OpportunitiesEvidence['citations']=currentCitations.map(c=>{
  const m=byId.get(c.executionId);if(!m||m.promptId!==c.promptId||m.versionId!==c.versionId||m.comparisonId!==c.comparisonId||m.requestedAt!==c.requestedAt)throw changed();
  const ownership=c.classification.ownership;
  return {id:c.id,executionId:c.executionId,promptId:c.promptId,retainedCitationIndex:c.retainedCitationIndex,url:c.retainedUrl,title:c.retainedTitle,ownership:ownership.ambiguous?'ambiguous':ownership.brand?'brand':ownership.competitorIds.length?'competitor':'untracked',publisherCategory:c.classification.publisherCategory,sourceType:c.classification.sourceType};
 });
 const rawAnchorAt=executions.length?executions.map(e=>e.completedAt).sort()[0]:null,derivedAnchorAt=executions.length?executions.map(e=>e.requestedAt).sort()[0]:null;
 const snapshot=createOpportunitiesSnapshot({source:{projectId:project.id,scope,contextRevision:insights.report.contextRevision,profileHash:insights.report.profileHash,insightSelectionRevision:insights.report.selectionRevision,citationSelectionRevision:'0'.repeat(64),...policy,rawAnchorAt,derivedAnchorAt},subjects:insights.report.subjects,coverage:insights.report.coverage,prompts,executions,citations:citationRows});
 const classification={classifierVersion,ownershipVersion,googleDomainsVersion,overrides:[...insights.citationCategoryOverrides].sort((a,b)=>a.domain.localeCompare(b.domain))};
 snapshot.source.profileHash=canonicalHash({subjects:snapshot.subjects,...classification});
 snapshot.source.citationSelectionRevision=canonicalHash({scope,contextRevision:insights.report.contextRevision,profileHash:snapshot.source.profileHash,citations:snapshot.citations});
 if(Buffer.byteLength(JSON.stringify(snapshot),'utf8')>opportunitiesLimits.messageSchemaBytes)throw cap();
 const availability=opportunitiesAvailability(snapshot);if(availability==='available')opportunitiesMessages(snapshot);
 check();
 const fresh=(await client.query<Policy&{at:string;expired:boolean}>(`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at)
 SELECT w.retention_revision AS "retentionRevision",w.raw_provider_evidence_days AS "rawDays",w.derived_history_days AS "derivedDays",${clock('read_clock.at')} AS at,
 COALESCE($2::timestamptz<read_clock.at-w.raw_provider_evidence_days*interval '24 hours' OR $3::timestamptz<read_clock.at-w.derived_history_days*interval '24 hours',false) AS expired
 FROM project p JOIN workspace w ON w.id=p.workspace_id CROSS JOIN read_clock WHERE p.id=$1`,[project.id,rawAnchorAt,derivedAnchorAt])).rows[0];
 if(!fresh||fresh.retentionRevision!==policy.retentionRevision||fresh.rawDays!==policy.rawDays||fresh.derivedDays!==policy.derivedDays)throw changed();if(fresh.expired)throw expired();check();
 return {snapshot,evidenceHash:opportunitiesEvidenceHash(snapshot),businessInputHash:opportunitiesBusinessIdentity(snapshot),dependencies:dependencies.sort((a,b)=>a.executionId.localeCompare(b.executionId)),availability,asOf:fresh.at,warnings:[...new Set([...insights.report.warnings,priorWarning])]};
}

export async function readOpportunitiesSource(projectId:string,userId:string,rawScope:unknown,signal?:AbortSignal):Promise<OpportunitiesSource>{
 const started=Date.now(),check=()=>{if(signal?.aborted)throw new FoundationError(499,'Opportunity source read cancelled.');if(Date.now()-started>30000)throw new FoundationError(503,'The opportunity source read took too long. Narrow the filters.');};
 check();const scope=parse(opportunitiesScopeSchema,rawScope);
 try{return await withContentProject(projectId,userId,false,(client,p)=>selectOpportunitiesSource(client,p,scope,check),undefined,true);}
 catch(error){if((error as {code?:string}).code==='57014'||(error as {code?:string}).code==='55P03')throw new FoundationError(503,'The opportunity source read timed out. Narrow the filters or try again.');throw error;}
}
