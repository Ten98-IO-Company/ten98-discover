import {aiQueryReportSchema,type AiQueryRow,type AiQueryTotals} from './ai-search-analysis.ts';
const ceiling=8*1024*1024;
const csvCell=(value:string)=>{const safe=/^\s*[=+\-@\t\r\n]/u.test(value)?"'"+value:value;return /[",\r\n]/.test(safe)?'"'+safe.replaceAll('"','""')+'"':safe;};
/** Human-readable table sections contain every returned observation, never answer bodies. */
export function aiSearchAnalysisCsv(value:unknown):string{
 const report=aiQueryReportSchema.parse(value),lines:string[]=[],encoder=new TextEncoder();let bytes=0;
 const row=(cells:(string|number|boolean|null)[])=>{const line=cells.map(v=>csvCell(v===null?'Unavailable':String(v))).join(',')+'\r\n';bytes+=encoder.encode(line).byteLength;if(bytes>ceiling)throw Error('The complete analysis CSV exceeds 8 MiB. Narrow the applied filters and retry.');lines.push(line);};
 row(['section','field','type','value']);
 const append=(section:string,path:string,value:unknown):void=>{if(value===null){row([section,path,'unavailable','Unavailable']);return;}if(Array.isArray(value)){row([section,path+'.returned','number',value.length]);value.forEach((item,index)=>append(section,path+'['+index+']',item));return;}if(typeof value==='object'){for(const [key,item]of Object.entries(value as Record<string,unknown>))append(section,path?path+'.'+key:key,item);return;}row([section,path,typeof value,String(value)]);};
 row(['export','scope','string','Applied returned report; local prompt search, ranking and word display controls do not narrow this export.']);
 row(['export','limits','string','Returned lists only; full populations and denominators precede display caps. No sampling.']);
 for(const key of ['role','projectId','profileId','asOf','resolvedRange','filters','contextRevision','profileHash','selectionRevision','versions','label','warnings','brand','coverageBeforeModel','coverage','totals','websiteContentCoverage'] as const)append(key,'',report[key]);
 row(['List limits','List','Total unique queries','Returned','Cap']);
 for(const [list,rows,cap]of [['topQueries',report.topQueries,report.filters.promptId?2000:25],['topByPrompts',report.topByPrompts,20],['topByRuns',report.topByRuns,20]] as const)row(['List limits',list,report.totals.uniqueQueries,rows.length,cap]);
 row(['Returned queries','List','Prompt ID','Version ID','Query','Captures','Distinct prompts','Versions','Available associated answers','Mentions','Mention rate','Mention numerator','Mention denominator','Capture IDs','Prompt/version observations']);
 const queries=(list:string,rows:AiQueryRow[],promptId:string|null=null,versionId:string|null=null)=>{for(const q of rows)row(['Returned queries',list,promptId,versionId,q.key,q.observations,q.distinctPromptCount,q.versionCount,q.eligibleAnswers,q.mentions,q.rate.value,q.rate.numerator,q.rate.denominator,JSON.stringify(q.runIds),JSON.stringify(q.promptRefs)]);};
 queries('topQueries',report.topQueries);queries('topByPrompts',report.topByPrompts);queries('topByRuns',report.topByRuns);
 row(['Prompt versions','Prompt ID','Version ID','Captured wording state','Captured wording','Total unique variations','Returned variations','Variation cap']);
 for(const p of report.byPromptVersion)row(['Prompt versions',p.promptId,p.versionId,p.capturedTextState,p.capturedText,p.totals.uniqueQueries,p.returned,report.filters.promptId?2000:10]);
 for(const p of report.byPromptVersion)queries('prompt variations',p.variations,p.promptId,p.versionId);
 row(['Group totals','Group','Identity','Metric','Numerator / count','Denominator','Value']);
 const totals=(group:string,identity:string,t:AiQueryTotals)=>{for(const [key,n]of Object.entries(t))if(typeof n==='number')row(['Group totals',group,identity,key,n,null,n]);else row(['Group totals',group,identity,key,n.numerator,n.denominator,n.value]);};
 for(const p of report.byPromptVersion)totals('prompt/version',p.promptId+'/'+p.versionId,p.totals);
 for(const m of report.byModel){append('Model coverage',m.reportedModel===null?'Model not recorded':JSON.stringify(m.reportedModel),m.coverage);totals('reported model',m.reportedModel===null?'Model not recorded':JSON.stringify(m.reportedModel),m.totals);}
 row(['Capture states','Capture ID','Prompt ID','Version ID','Requested at','Lifecycle','Raw evidence','Reported model','Query state','Answer state','Brand mentioned']);
 for(const c of report.captures)row(['Capture states',c.runId,c.promptId,c.versionId,c.requestedAt,c.status,c.rawState,c.reportedModel,c.queryState,c.answerState,c.brandMention]);
 row(['Word limits','Category','Total distinct','Returned','Cap','Query-instance denominator','Counting unit']);
 for(const kind of ['cloud','added','preserved','dropped'] as const){const w=report.words[kind];row(['Word limits',kind,w.totalDistinct,w.returned,60,report.words.denominator,kind==='cloud'?'Token occurrences':'Once per query instance']);}
 row(['Returned words','Category','Word','Count','Stopword','Query-instance denominator']);
 for(const kind of ['cloud','added','preserved','dropped'] as const)for(const w of report.words[kind].rows)row(['Returned words',kind,w.word,w.count,w.isStop,report.words.denominator]);
 return lines.join('');
}
