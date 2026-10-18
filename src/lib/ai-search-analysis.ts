import {z} from 'zod';
import {aiSearchProfileId} from './ai-search.ts';

const clean=(s:string)=>!/[\uD800-\uDFFF]/u.test(s)&&!s.includes('\0');
const text=(max:number)=>z.string().max(max).refine(clean);
export const aiQueryLookbacks=['1w','1m','3m','6m','1y','all'] as const;
export const aiQueryStatuses=['queued','running','completed','failed','uncertain','cancelled','reconciled'] as const;
export const aiQueryRawStates=['retained','not_recorded','invalid','expired'] as const;
export const aiQueryStates=['reported','reported_empty','not_recorded','invalid','raw_unavailable'] as const;
export const aiQueryAnswerStates=['available','empty','not_recorded','invalid','raw_unavailable'] as const;
const model=z.discriminatedUnion('state',[z.object({state:z.literal('reported'),value:text(160)}).strict(),z.object({state:z.literal('not_recorded')}).strict()]);
export const aiQueryFiltersSchema=z.object({lookback:z.enum(aiQueryLookbacks),timeZone:text(80),promptId:z.uuid().nullable(),versionId:z.uuid().nullable(),tag:text(80).nullable(),reportedModel:model.nullable(),matcher:z.enum(['unicode-boundary-v1','elmo-substring-v1'])}).strict();
export type AiQueryFilters=z.infer<typeof aiQueryFiltersSchema>;
export function aiQueryFilters(params:URLSearchParams):AiQueryFilters {
 const names=['lookback','timeZone','promptId','versionId','tag','reportedModel','matcher'];
 if(params.toString().length>4096||[...params.keys()].some(k=>!names.includes(k)||params.getAll(k).length!==1))throw Error('Invalid query filters.');
 const rawModel=params.get('reportedModel');let reportedModel:null|z.infer<typeof model>=null;
 if(rawModel!==null){reportedModel=model.parse(JSON.parse(rawModel));if(JSON.stringify(reportedModel)!==rawModel)throw Error('Use a canonical model filter.');}
 const zone=params.get('timeZone')??'UTC';if(!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(zone))throw Error('Invalid time zone.');
 const timeZone=new Intl.DateTimeFormat('en',{timeZone:zone}).resolvedOptions().timeZone;
 const value=aiQueryFiltersSchema.parse({lookback:params.get('lookback')??'1m',timeZone,promptId:params.get('promptId')?.toLowerCase()??null,versionId:params.get('versionId')?.toLowerCase()??null,tag:params.get('tag'),reportedModel,matcher:params.get('matcher')??'unicode-boundary-v1'});
 if(value.versionId&&!value.promptId||value.tag!==null&&(!value.tag||value.tag!==value.tag.trim()))throw Error('Invalid prompt scope.');return value;
}
export function aiQueryRange(filters:AiQueryFilters,now:Date):{from:string|null;to:string;timeZone:string}{
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:filters.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
 const to=`${parts.year}-${parts.month}-${parts.day}`;if(filters.lookback==='all')return {from:null,to,timeZone:filters.timeZone};
 const date=new Date(to+'T12:00:00Z');if(filters.lookback==='1w')date.setUTCDate(date.getUTCDate()-6);
 else{const day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-({'1m':1,'3m':3,'6m':6,'1y':12}[filters.lookback]));const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(day,last));}
 return {from:date.toISOString().slice(0,10),to,timeZone:filters.timeZone};
}
const count=z.number().int().min(0).max(100_000_000),attempts=count.max(1000);
const fraction=z.object({numerator:count,denominator:count,value:z.number().nonnegative().nullable()}).strict();
const counters=<T extends string>(keys:readonly T[])=>z.object(Object.fromEntries(keys.map(k=>[k,attempts])) as Record<T,typeof attempts>).strict();
export const aiQueryCoverageSchema=z.object({attempted:attempts,lifecycle:counters(aiQueryStatuses),raw:counters(aiQueryRawStates),queries:counters(aiQueryStates),answers:counters(aiQueryAnswerStates)}).strict();
export type AiQueryCoverage=z.infer<typeof aiQueryCoverageSchema>;
const totals=z.object({attempted:attempts,reportedArrays:attempts,fanoutRuns:attempts,queryInstances:count.max(100000),uniqueQueries:count.max(100000),reportedWithoutFanout:attempts,blankEntries:count,echoEntries:count,averageFanout:fraction,queryWeightedMentions:fraction,answerMentions:fraction}).strict();
export type AiQueryTotals=z.infer<typeof totals>;
const capture=z.object({runId:z.uuid(),promptId:z.uuid(),versionId:z.uuid(),requestedAt:z.iso.datetime(),status:z.enum(aiQueryStatuses),rawState:z.enum(aiQueryRawStates),reportedModel:text(160).nullable(),queryState:z.enum(aiQueryStates),answerState:z.enum(aiQueryAnswerStates),brandMention:z.boolean().nullable()}).strict();
export type AiQueryCapture=z.infer<typeof capture>;
const promptRef=z.object({promptId:z.uuid(),versionId:z.uuid(),observations:attempts}).strict();
const query=z.object({key:text(4000),observations:attempts,distinctPromptCount:attempts,versionCount:attempts,eligibleAnswers:attempts,mentions:attempts,rate:fraction,runIds:z.array(z.uuid()).max(1000),promptRefs:z.array(promptRef).max(1000)}).strict();
export type AiQueryRow=z.infer<typeof query>;
const words=z.object({totalDistinct:count.max(20000),returned:count.max(60),rows:z.array(z.object({word:text(4000),count,isStop:z.boolean()}).strict()).max(60)}).strict();
export const aiQueryReportSchema=z.object({role:z.enum(['owner','admin','editor','viewer']),projectId:z.uuid(),profileId:z.literal(aiSearchProfileId),asOf:z.iso.datetime(),resolvedRange:z.object({from:z.string().nullable(),to:z.string(),timeZone:z.string()}).strict(),filters:aiQueryFiltersSchema,
 contextRevision:z.number().int().positive(),profileHash:z.string().regex(/^[a-f0-9]{64}$/),selectionRevision:z.string().regex(/^[a-f0-9]{64}$/),
 versions:z.object({evidence:z.literal('dfs-chatgpt-reported-fields-v1'),derivation:z.literal('immutable-prompt-trim-lower-v1'),words:z.literal('elmo-ascii-words-3c673d0-v1')}).strict(),label:z.literal('Recomputed from retained captures using current brand context'),warnings:z.array(text(2048)).max(10),brand:z.object({id:z.literal('brand'),name:text(512),aliases:z.array(text(512)).max(20),domains:z.array(text(253)).max(20)}).strict(),
 coverageBeforeModel:aiQueryCoverageSchema,coverage:aiQueryCoverageSchema,totals,
 byModel:z.array(z.object({reportedModel:text(160).nullable(),coverage:aiQueryCoverageSchema,totals}).strict()).max(1001),
 byPromptVersion:z.array(z.object({promptId:z.uuid(),versionId:z.uuid(),capturedTextState:z.enum(aiQueryRawStates),capturedText:text(2000).nullable(),totals,variations:z.array(query).max(2000),returned:count.max(2000)}).strict()).max(1000),
 topQueries:z.array(query).max(2000),topByPrompts:z.array(query).max(20),topByRuns:z.array(query).max(20),captures:z.array(capture).max(1000),
 words:z.object({cloud:words,added:words,preserved:words,dropped:words,denominator:count.max(100000)}).strict(),websiteContentCoverage:z.object({state:z.literal('unavailable'),reason:z.literal('body_corpus_not_recorded')}).strict(),
}).strict().superRefine((r,ctx)=>{
 const issue=()=>ctx.addIssue({code:'custom',message:'Inconsistent query analysis counts or associations.'});
 const checkCoverage=(c:z.infer<typeof aiQueryCoverageSchema>)=>{for(const axis of [c.lifecycle,c.raw,c.queries,c.answers])if(Object.values(axis).reduce((a,b)=>a+b,0)!==c.attempted)issue();};
 const checkFraction=(f:z.infer<typeof fraction>)=>{if(f.value!==(f.denominator?f.numerator/f.denominator:null))issue();};
 const checkTotals=(t:AiQueryTotals)=>{for(const f of [t.averageFanout,t.queryWeightedMentions,t.answerMentions])checkFraction(f);if(t.averageFanout.numerator!==t.queryInstances||t.averageFanout.denominator!==t.fanoutRuns||t.fanoutRuns>t.attempted||t.reportedArrays>t.attempted||t.uniqueQueries>t.queryInstances||t.answerMentions.numerator>t.answerMentions.denominator||t.answerMentions.denominator>t.attempted||t.queryWeightedMentions.numerator>t.queryWeightedMentions.denominator||t.queryWeightedMentions.denominator>t.queryInstances)issue();};
 checkCoverage(r.coverage);checkCoverage(r.coverageBeforeModel);checkTotals(r.totals);
 if(r.coverage.attempted>r.coverageBeforeModel.attempted||r.totals.attempted!==r.coverage.attempted||r.totals.reportedArrays!==r.coverage.queries.reported+r.coverage.queries.reported_empty||r.words.denominator!==r.totals.queryInstances||r.captures.length!==r.coverage.attempted)issue();
 const captures=new Map(r.captures.map(c=>[c.runId,c]));if(captures.size!==r.captures.length)issue();
 for(const c of r.captures){if((c.answerState==='available')!==(c.brandMention!==null)||c.rawState!=='retained'&&(c.queryState!=='raw_unavailable'||c.answerState!=='raw_unavailable'))issue();}
 for(const [axis,field]of [['lifecycle','status'],['raw','rawState'],['queries','queryState'],['answers','answerState']] as const)for(const [key,n]of Object.entries(r.coverage[axis]))if(r.captures.filter(c=>c[field]===key).length!==n)issue();
 const checkQueries=(rows:z.infer<typeof query>[])=>{if(new Set(rows.map(q=>q.key)).size!==rows.length)issue();for(const q of rows){checkFraction(q.rate);const refs=q.runIds.map(id=>captures.get(id)),groups=new Map<string,number>();for(const c of refs)if(c){const k=c.promptId+':'+c.versionId;groups.set(k,(groups.get(k)??0)+1);}if(q.observations!==q.runIds.length||new Set(q.runIds).size!==q.runIds.length||refs.some(c=>!c||c.queryState!=='reported')||q.eligibleAnswers!==refs.filter(c=>c?.brandMention!==null&&c!==undefined).length||q.mentions!==refs.filter(c=>c?.brandMention===true).length||q.rate.numerator!==q.mentions||q.rate.denominator!==q.eligibleAnswers||q.distinctPromptCount!==new Set(refs.map(c=>c?.promptId)).size||q.versionCount!==q.promptRefs.length||groups.size!==q.promptRefs.length)issue();const keys=new Set<string>();for(const p of q.promptRefs){const key=p.promptId+':'+p.versionId;if(keys.has(key)||p.observations!==groups.get(key))issue();keys.add(key);}}};
 checkQueries(r.topQueries);checkQueries(r.topByPrompts);checkQueries(r.topByRuns);
 for(const p of r.byPromptVersion){checkTotals(p.totals);checkQueries(p.variations);if(p.variations.some(q=>q.promptRefs.some(ref=>ref.promptId!==p.promptId||ref.versionId!==p.versionId)))issue();if((p.capturedTextState==='retained')!==(p.capturedText!==null)||p.returned!==p.variations.length||p.totals.attempted!==r.captures.filter(c=>c.promptId===p.promptId&&c.versionId===p.versionId).length)issue();}
 if(new Set(r.byPromptVersion.map(p=>p.promptId+':'+p.versionId)).size!==r.byPromptVersion.length||r.byPromptVersion.reduce((n,p)=>n+p.totals.attempted,0)!==r.totals.attempted)issue();
 for(const m of r.byModel){checkCoverage(m.coverage);checkTotals(m.totals);if(m.coverage.attempted!==m.totals.attempted||m.totals.attempted!==r.captures.filter(c=>c.reportedModel===m.reportedModel).length)issue();}if(new Set(r.byModel.map(m=>m.reportedModel)).size!==r.byModel.length||r.byModel.reduce((n,m)=>n+m.totals.attempted,0)!==r.totals.attempted)issue();
 for(const kind of ['cloud','added','preserved','dropped'] as const){const w=r.words[kind];if(w.returned!==w.rows.length||w.returned> w.totalDistinct||new Set(w.rows.map(w=>w.word)).size!==w.rows.length||kind!=='cloud'&&w.rows.some(w=>w.count>r.words.denominator))issue();}
});
export type AiQueryReport=z.infer<typeof aiQueryReportSchema>;
