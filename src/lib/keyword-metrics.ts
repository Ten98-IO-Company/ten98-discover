import type {KeywordRow} from '../server/keyword-research-input.ts';

export function isKeywordMetricRow(value:unknown):value is KeywordRow{
  const r=value as KeywordRow|null;
  const metric=(v:unknown,max=Number.MAX_SAFE_INTEGER,integer=false)=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max&&(!integer||Number.isSafeInteger(v));
  const date=(v:unknown)=>v===null||typeof v==='string'&&Number.isFinite(Date.parse(v));
  return !!r&&typeof r.keyword==='string'&&r.keyword.length>0&&r.keyword.length<=500&&metric(r.searchVolume,Number.MAX_SAFE_INTEGER,true)&&(r.cpcUsd===null||typeof r.cpcUsd==='string'&&/^(?:0|[1-9][0-9]*)\.[0-9]{6}(?![\s\S])/.test(r.cpcUsd))&&metric(r.competition,1)&&(r.competitionLevel===null||['LOW','MEDIUM','HIGH'].includes(r.competitionLevel))&&metric(r.keywordDifficulty,100)&&(r.intent===null||typeof r.intent==='string')&&date(r.metricsUpdatedAt)&&date(r.intentUpdatedAt)&&Array.isArray(r.monthlySearches)&&r.monthlySearches.length<=120&&r.monthlySearches.every(m=>m&&Number.isInteger(m.year)&&m.year>=1970&&m.year<=9999&&Number.isInteger(m.month)&&m.month>=1&&m.month<=12&&metric(m.searchVolume,Number.MAX_SAFE_INTEGER,true));
}
