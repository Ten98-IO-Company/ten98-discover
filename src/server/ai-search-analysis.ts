import {deriveSearchQueries,SearchEvidenceError,searchEvidenceVersion,queryDerivationVersion,queryWordsVersion,type SearchDerivation} from './ai-search-evidence.ts';
import {matchAnswer,type MentionSubject} from './answer-mentions.ts';
import type {AiSearchCapturedResult} from './dataforseo-ai-search.ts';
import type {AiSearchRawState,AiSearchRunStatus} from '../lib/ai-search.ts';
import {aiQueryStatuses,aiQueryRawStates,aiQueryStates,aiQueryAnswerStates,type AiQueryFilters,type AiQueryCoverage,type AiQueryTotals,type AiQueryRow,type AiQueryCapture} from '../lib/ai-search-analysis.ts';

export class AiQueryCapacityError extends Error {}
export class AiQueryDataError extends Error {}
export type AiQueryInput={id:string;promptId:string;versionId:string;requestedAt:string;status:AiSearchRunStatus;rawState:AiSearchRawState;capturedPrompt:string|null;result:AiSearchCapturedResult|null};
const cap=()=>{throw new AiQueryCapacityError('Narrow the selection. Query analysis exceeds its complete-report capacity.');};
const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;
const fraction=(numerator:number,denominator:number)=>({numerator,denominator,value:denominator?numerator/denominator:null});
function coverage():AiQueryCoverage{return {attempted:0,lifecycle:Object.fromEntries(aiQueryStatuses.map(k=>[k,0])) as AiQueryCoverage['lifecycle'],raw:Object.fromEntries(aiQueryRawStates.map(k=>[k,0])) as AiQueryCoverage['raw'],queries:Object.fromEntries(aiQueryStates.map(k=>[k,0])) as AiQueryCoverage['queries'],answers:Object.fromEntries(aiQueryAnswerStates.map(k=>[k,0])) as AiQueryCoverage['answers']};}
function addCoverage(c:AiQueryCoverage,row:AiQueryInput){c.attempted++;c.lifecycle[row.status]++;c.raw[row.rawState]++;c.queries[row.result?.evidence.queries.state??'raw_unavailable']++;c.answers[row.result?.evidence.answer.state??'raw_unavailable']++;}
type Observation={row:AiQueryInput;derived:SearchDerivation|null;capture:AiQueryCapture};
function summary(observations:Observation[]):AiQueryTotals{
 const unique=new Set<string>();let queryInstances=0,fanoutRuns=0,reportedArrays=0,reportedWithoutFanout=0,blankEntries=0,echoEntries=0,eligible=0,mentions=0,weightedEligible=0,weightedMentions=0;
 for(const {derived:d,capture} of observations){const n=d?.queries?.length??0;queryInstances+=n;if(n)fanoutRuns++;if(d?.queries!==null&&d?.queries!==undefined){reportedArrays++;if(!n)reportedWithoutFanout++;}blankEntries+=d?.blankIndexes?.length??0;echoEntries+=d?.echoIndexes?.length??0;
  for(const q of d?.queries??[])unique.add(q.key);if(capture.brandMention!==null){eligible++;mentions+=Number(capture.brandMention);weightedEligible+=n;weightedMentions+=n*Number(capture.brandMention);}}
 return {attempted:observations.length,reportedArrays,fanoutRuns,queryInstances,uniqueQueries:unique.size,reportedWithoutFanout,blankEntries,echoEntries,averageFanout:fraction(queryInstances,fanoutRuns),queryWeightedMentions:fraction(weightedMentions,weightedEligible),answerMentions:fraction(mentions,eligible)};
}
function queries(observations:Observation[]):AiQueryRow[]{
 const map=new Map<string,{runs:string[];eligible:number;mentions:number;prompts:Map<string,{promptId:string;versionId:string;observations:number}>}>();
 for(const {row,derived,capture}of observations)for(const q of derived?.queries??[]){let value=map.get(q.key);if(!value){value={runs:[],eligible:0,mentions:0,prompts:new Map()};map.set(q.key,value);}value.runs.push(row.id);if(capture.brandMention!==null){value.eligible++;value.mentions+=Number(capture.brandMention);}
  const key=row.promptId+':'+row.versionId,ref=value.prompts.get(key)??{promptId:row.promptId,versionId:row.versionId,observations:0};ref.observations++;value.prompts.set(key,ref);}
 return [...map].map(([key,v])=>({key,observations:v.runs.length,distinctPromptCount:new Set([...v.prompts.values()].map(p=>p.promptId)).size,versionCount:v.prompts.size,eligibleAnswers:v.eligible,mentions:v.mentions,rate:fraction(v.mentions,v.eligible),runIds:v.runs,promptRefs:[...v.prompts.values()].sort((a,b)=>b.observations-a.observations||lexical(a.promptId,b.promptId)||lexical(a.versionId,b.versionId))})).sort((a,b)=>b.observations-a.observations||lexical(a.key,b.key));
}
/** ponytail: complete bounded in-memory analysis (1000 runs/100k query votes/20k
 * words); use measured streaming aggregation if these explicit ceilings must grow. */
export function aggregateAiSearchQueries(rows:AiQueryInput[],filters:AiQueryFilters,brand:MentionSubject){
 return aggregateAiSearchQueryPopulation(rows,filters,brand).report;
}
/** Internal complete population, before the public report's presentation cuts. */
export function aggregateAiSearchQueryPopulation(rows:AiQueryInput[],filters:AiQueryFilters,brand:MentionSubject,queryLimit?:number){
 if(rows.length>1000)cap();if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new AiQueryDataError('Duplicate capture.');
 if(queryLimit!==undefined&&(!Number.isInteger(queryLimit)||queryLimit<0||queryLimit>100000))throw new AiQueryDataError('Invalid query capacity.');
 const keys=queryLimit===undefined?null:new Set<string>();
 matchAnswer({text:'',subjects:[brand],citationUrls:[],method:filters.matcher});
 const coverageBeforeModel=coverage(),selected:Observation[]=[];let work=0,instances=0;
 const terms=Math.max(1,1+brand.aliases.length+(filters.matcher==='elmo-substring-v1'?brand.domains.length:0));
 const maps={cloud:new Map<string,{count:number;isStop:boolean}>(),added:new Map<string,{count:number;isStop:boolean}>(),preserved:new Map<string,{count:number;isStop:boolean}>(),dropped:new Map<string,{count:number;isStop:boolean}>()};let wordEntries=0;
 for(const row of rows){if((row.rawState==='retained')!==(row.result!==null)||row.result&&row.result.capturedPrompt!==row.capturedPrompt)throw new AiQueryDataError('Invalid retained capture state.');addCoverage(coverageBeforeModel,row);
  const model=row.result?.reportedModel??null,filter=filters.reportedModel;if(filter&&(filter.state==='not_recorded'?model!==null:model!==filter.value))continue;
  let derived:SearchDerivation|null=null;
  if(row.result){work+=(row.result.evidence.answer.text?.length??0)*terms;if(work>100_000_000)cap();try{derived=deriveSearchQueries({evidence:row.result.evidence,capturedPrompt:row.result.capturedPrompt,subjects:[brand],method:filters.matcher});}catch(error){if(error instanceof SearchEvidenceError)cap();throw error;}instances+=derived!.queries?.length??0;if(instances>100000)cap();}
  if(keys)for(const q of derived?.queries??[]){keys.add(q.key);if(keys.size>queryLimit!)cap();}
  if(derived?.words){for(const kind of ['cloud','added','preserved','dropped'] as const)for(const word of derived.words[kind]){const old=maps[kind].get(word.word);if(!old){if(++wordEntries>20000)cap();maps[kind].set(word.word,{count:word.count,isStop:word.isStop});}else old.count+=word.count;}derived.words=null;}
  selected.push({row,derived,capture:{runId:row.id,promptId:row.promptId,versionId:row.versionId,requestedAt:row.requestedAt,status:row.status,rawState:row.rawState,reportedModel:model,queryState:derived?.queryState??'raw_unavailable',answerState:derived?.answerState??'raw_unavailable',brandMention:derived?.answerMentions?.[0]?.mentioned??null}});
 }
 const selectedCoverage=coverage();for(const {row}of selected)addCoverage(selectedCoverage,row);
 const allQueries=queries(selected),byPrompt=new Map<string,Observation[]>(),byModel=new Map<string|null,Observation[]>();
 for(const o of selected){const p=o.row.promptId+':'+o.row.versionId;if(!byPrompt.has(p))byPrompt.set(p,[]);byPrompt.get(p)!.push(o);const m=o.row.result?.reportedModel??null;if(!byModel.has(m))byModel.set(m,[]);byModel.get(m)!.push(o);}
 const wordRows=(map:typeof maps.cloud)=>{const rows=[...map].map(([word,v])=>({word,...v})).sort((a,b)=>b.count-a.count||lexical(a.word,b.word)).slice(0,60);return {totalDistinct:map.size,returned:rows.length,rows};};
 const report={versions:{evidence:searchEvidenceVersion,derivation:queryDerivationVersion,words:queryWordsVersion},coverageBeforeModel,coverage:selectedCoverage,totals:summary(selected),captures:selected.map(o=>o.capture),
  byModel:[...byModel].map(([reportedModel,obs])=>{const c=coverage();for(const o of obs)addCoverage(c,o.row);return {reportedModel,coverage:c,totals:summary(obs)};}).sort((a,b)=>b.totals.queryInstances-a.totals.queryInstances||lexical(a.reportedModel??'',b.reportedModel??'')||Number(a.reportedModel!==null)-Number(b.reportedModel!==null)),
  byPromptVersion:[...byPrompt.values()].map(obs=>{const first=obs[0].row,texts=[...new Set(obs.map(o=>o.row.capturedPrompt).filter((v):v is string=>v!==null))];if(texts.length>1)throw new AiQueryDataError('Conflicting immutable prompt text.');const variations=queries(obs).slice(0,filters.promptId?2000:10);return {promptId:first.promptId,versionId:first.versionId,capturedTextState:texts.length?'retained' as const:obs.every(o=>o.row.rawState==='expired')?'expired' as const:obs.some(o=>o.row.rawState==='invalid')?'invalid' as const:'not_recorded' as const,capturedText:texts[0]??null,totals:summary(obs),variations,returned:variations.length};}).sort((a,b)=>b.totals.queryInstances-a.totals.queryInstances||lexical(a.promptId,b.promptId)||lexical(a.versionId,b.versionId)),
  topQueries:allQueries.slice(0,filters.promptId?2000:25),topByRuns:allQueries.slice(0,20),topByPrompts:[...allQueries].sort((a,b)=>b.distinctPromptCount-a.distinctPromptCount||b.observations-a.observations||lexical(a.key,b.key)).slice(0,20),
  words:{cloud:wordRows(maps.cloud),added:wordRows(maps.added),preserved:wordRows(maps.preserved),dropped:wordRows(maps.dropped),denominator:instances},websiteContentCoverage:{state:'unavailable' as const,reason:'body_corpus_not_recorded' as const}};
 return {report,completeQueries:allQueries};
}
