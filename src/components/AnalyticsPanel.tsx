import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, errMsg } from '../lib/api';
import { environmentCatalog, environmentFields, environmentVersion, isEnvironmentFilter, type AnalyticsEnvironment, type EnvironmentField, type EnvironmentFilters, type EnvironmentRow } from '../lib/analytics-environment';
import { analyticsDay as parseDay, analyticsNavigation, analyticsNavigationNames, geographyNavigationNames, applyGeographyFilter, canonicalNavigation, navigationKey, parseNavigation, type AnalyticsNavigation, type NavigationSearch } from '../lib/navigation';
import {useLocation} from '@tanstack/react-router';
import { useAnnotations } from './AnnotationsPanel';
import { deriveAnalyticsComparison, retentionCoverage, type AnalyticsComparison, type AnalyticsComparisonMode } from '../lib/analytics-comparison';
import {geographyFields,parseGeographyKey,type GeographyFilters,type GeographyReport,type GeoField,type GeographyKey,type GeographyDetail,type GeographyDetailIntent} from '../lib/analytics-geography';
import {GeographyCard,geographyLabel,geographyLabels,validGeography,validGeographyDetail} from './GeographyCard';
import {analyticsDimensions,analyticsSelectionFields,analyticsFieldLimit,type AnalyticsDimension,type AnalyticsDimensionComparison,type AnalyticsDimensionKey} from '../lib/analytics-dimensions';
import {emptyAdvanced,readAdvanced,buildAdvanced,clean,focusAdvanced,initialDraft,buildParams,ExactFilterControls,TIMEZONES,patchLocationFilters,type Draft} from './ExplorerFilters';
import './analytics.css';

export type AnalyticsPanelProps = {
  projectId: string;
  userId: string;
  onUnauthorized: () => void;
  search?: NavigationSearch;
  onNavigate?: (value: AnalyticsNavigation) => void;
  compareView?: boolean;
  onAppliedRange?: (userId:string,projectId:string,range:Range) => void;
  onReturnToExplorer?:()=>void;
};

type Daily = { date: string; pageViews: number | null; customEvents: number | null; coverage: 'complete' | 'partial' | 'unavailable' };
type Analytics = {
  range: { from: string; to: string; timeZone: 'UTC' };
  totals: { pageViews: number | null; customEvents: number | null };
  coverage: { status: 'complete' | 'partial' | 'unavailable'; retainedFrom: string | null };
  collection?: {mode:'consent-first'|'cookieless';captureCoverage:'unknown';pageViews:{cookieless:number|null;consent:number|null;unknown:number|null}};
  measurement: {
    version?: string;
    identifiedPageViews: number | null; unidentifiedPageViews: number | null;
    visitors: number | null; visits: number | null;
    bounceRate: number | null; averageVisitSeconds: number | null;
  };
  daily: Daily[];
  pages: { path: string; pageViews: number }[];
  referrers?: { host: string; pageViews: number; visitors: number | null }[];
  events: { name: string; count: number }[];
  lastReceivedAt: string | null;
  environment?: AnalyticsEnvironment;
  geography?: GeographyReport;
  geographyDetail?: GeographyDetail;
  comparison?: AnalyticsComparison;
  selection?: string;
  dimensionComparison?: AnalyticsDimensionComparison;
};
type Range = { from: string; to: string };

type View = {
  key: string; // projectId this state belongs to; stale data is never rendered
  queryKey: string;
  range: Range; // applied range (drives fetching)
  draft: Range; // custom date inputs (applied only via Apply)
  draftErr: string | null;
  data: Analytics | null;
  error: string | null;
  loading: boolean;
  nonce: number; // lets Apply/Retry refetch an unchanged range
  denied?: boolean;
  detail?: GeographyDetailIntent;
};

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
const PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function lastDays(n: number): Range {
  const to = todayUtc();
  return { from: shiftDays(to, -(n - 1)), to };
}

function fresh(projectId: string, intent: AnalyticsNavigation): View {
  const range = intent.analyticsFrom && intent.analyticsTo ? {from:intent.analyticsFrom,to:intent.analyticsTo} : lastDays(7);
  return { key: projectId, queryKey:JSON.stringify(intent), range, draft: range, draftErr: null, data: null, error: null, loading: !intent.analyticsInvalid, nonce: 0 };
}

function fmtUtc(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const fmtNum = (n: number | null) => n === null ? 'Unavailable' : n.toLocaleString('en-US');

const environmentLabels = { browser: 'Browser', os: 'OS', device: 'Device' } as const;
const environmentRows = { browser: 'browsers', os: 'operatingSystems', device: 'devices' } as const;
const browserLabels: Record<string,string> = {aol:'AOL',edge:'Edge', 'edge-ios':'Edge on iOS', yandexbrowser:'Yandex',kakaotalk:'KakaoTalk',samsung:'Samsung Internet',silk:'Amazon Silk',miui:'MIUI',beaker:'Beaker','edge-chromium':'Edge (Chromium)',chrome:'Chrome','chromium-webview':'Chromium WebView',phantomjs:'PhantomJS',crios:'Chrome on iOS',firefox:'Firefox',fxios:'Firefox on iOS','opera-mini':'Opera Mini',opera:'Opera',pie:'Pocket Internet Explorer',netfront:'NetFront',ie:'Internet Explorer',bb10:'BlackBerry',android:'Android browser',ios:'iOS browser',safari:'Safari',facebook:'Facebook',instagram:'Instagram','ios-webview':'iOS WebView',curl:'curl',searchbot:'Search bot',bot:'Bot'};
const environmentValue = (field: EnvironmentField, value: string | null) => value === null || value === 'not-recorded' ? 'Not recorded' : value === 'unknown' ? 'Unknown' : field === 'browser' ? browserLabels[value] : field === 'device' ? value === 'smarttv' ? 'Smart TV' : value[0].toUpperCase()+value.slice(1) : value;
const record = (value: unknown): value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: unknown, names: string[]): value is Record<string,unknown> => record(value) && Object.keys(value).length === names.length && names.every(name=>Object.hasOwn(value,name));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const nullableCount = (value: unknown) => value === null || count(value);
const stamp = (value: unknown): value is string => typeof value === 'string' && value.length<=64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && parseDay(value.slice(0,10))!==null && Number.isFinite(Date.parse(value));
const metric = (value: unknown, max = Infinity) => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

function validEnvironment(value: unknown, filters: EnvironmentFilters, total: number | null, identified: number | null, unavailable: boolean): value is AnalyticsEnvironment {
  if (!keys(value,['version','filters','browsers','operatingSystems','devices','coverage','method']) || value.version !== environmentVersion || !record(value.filters) || Object.keys(value.filters).length !== Object.keys(filters).length || environmentFields.some(field=>(value.filters as Record<string,unknown>)[field] !== filters[field]) || Object.keys(value.filters).some(field=>!environmentFields.includes(field as EnvironmentField)) || !keys(value.method,['source','device','rawUserAgentStored']) || value.method.source !== 'bounded-request-user-agent' || value.method.device !== 'ua-parser-v1-screen-if-enabled' || value.method.rawUserAgentStored !== false || !keys(value.coverage,['pageViews','recordedPageViews','notRecordedPageViews','firstRecordedAt'])) return false;
  const coverage=value.coverage;
  if (coverage.firstRecordedAt !== null && !stamp(coverage.firstRecordedAt) || coverage.pageViews !== total) return false;
  if(unavailable&&coverage.firstRecordedAt!==null||!unavailable&&(coverage.recordedPageViews===0?coverage.firstRecordedAt!==null:coverage.firstRecordedAt===null))return false;
  if (unavailable ? [coverage.pageViews,coverage.recordedPageViews,coverage.notRecordedPageViews].some(n=>n!==null) : ![coverage.pageViews,coverage.recordedPageViews,coverage.notRecordedPageViews].every(count) || (coverage.recordedPageViews as number)+(coverage.notRecordedPageViews as number)!==coverage.pageViews) return false;
  for (const field of environmentFields) {
    const rows=value[environmentRows[field]], seen=new Set();
    if (!Array.isArray(rows) || rows.length > environmentCatalog[field].length+1 || unavailable && rows.length) return false;
    let views=0, measured=0, missing=0;
    for (const row of rows) {
      if (!keys(row,['value','pageViews','identifiedPageViews','visitors','visits','bounceRate','averageVisitSeconds']) || row.value !== null && (!isEnvironmentFilter(field,row.value) || row.value === 'not-recorded') || seen.has(row.value) || !count(row.pageViews) || row.pageViews === 0 || !count(row.identifiedPageViews) || row.identifiedPageViews > row.pageViews || !nullableCount(row.visitors) || !nullableCount(row.visits) || !metric(row.bounceRate,100) || !metric(row.averageVisitSeconds)) return false;
      if (row.identifiedPageViews === 0 ? [row.visitors,row.visits,row.bounceRate,row.averageVisitSeconds].some(n=>n!==null) : row.visitors === null || row.visits === null || row.visitors < 1 || row.visitors > row.identifiedPageViews || row.visits < 1 || row.visits > row.identifiedPageViews || row.bounceRate === null || row.averageVisitSeconds === null) return false;
      seen.add(row.value); views+=row.pageViews; measured+=row.identifiedPageViews; if (row.value===null) missing+=row.pageViews;
    }
    if (!unavailable && (views !== total || measured !== identified || missing !== coverage.notRecordedPageViews)) return false;
  }
  return true;
}

export function validReport(value: unknown, range: Range, filters: EnvironmentFilters, maxDays = MAX_DAYS, geographyFilters:GeographyFilters={}): value is Analytics {
  if (!record(value) || !record(value.range) || value.range.from !== range.from || value.range.to !== range.to || value.range.timeZone !== 'UTC' || !record(value.coverage) || !['complete','partial','unavailable'].includes(value.coverage.status as string) || value.coverage.retainedFrom !== null && !stamp(value.coverage.retainedFrom) || !record(value.totals) || ![value.totals.pageViews,value.totals.customEvents].every(nullableCount) || !record(value.measurement) || !['identifiedPageViews','unidentifiedPageViews','visitors','visits'].every(k=>nullableCount((value.measurement as Record<string,unknown>)[k])) || !metric(value.measurement.bounceRate,100) || !metric(value.measurement.averageVisitSeconds) || value.lastReceivedAt !== null && !stamp(value.lastReceivedAt)) return false;
  if (!Array.isArray(value.daily) || value.daily.length > maxDays || !value.daily.every(day=>record(day) && typeof day.date==='string' && parseDay(day.date)!==null && day.date>=range.from && day.date<=range.to && ['complete','partial','unavailable'].includes(day.coverage as string) && nullableCount(day.pageViews) && nullableCount(day.customEvents)) || !Array.isArray(value.pages) || value.pages.length>20 || !value.pages.every(row=>record(row) && typeof row.path==='string' && row.path.length<=2048 && count(row.pageViews)) || !Array.isArray(value.events) || value.events.length>20 || !value.events.every(row=>record(row) && typeof row.name==='string' && row.name.length<=320 && count(row.count))) return false;
  // Optional so older snapshots and fixtures stay valid; when present: unique literal hosts, positive views, visitors within views.
  if (value.referrers !== undefined && (!Array.isArray(value.referrers) || value.referrers.length>20 || !value.referrers.every(row=>keys(row,['host','pageViews','visitors']) && typeof row.host==='string' && row.host.length>=1 && row.host.length<=2048 && count(row.pageViews) && row.pageViews>0 && (row.visitors===null || count(row.visitors) && row.visitors>=1 && row.visitors<=row.pageViews)) || new Set(value.referrers.map(row=>row.host)).size!==value.referrers.length)) return false;
  if (value.coverage.status==='unavailable' && ([value.totals.pageViews,value.totals.customEvents,...['identifiedPageViews','unidentifiedPageViews','visitors','visits','bounceRate','averageVisitSeconds'].map(k=>(value.measurement as Record<string,unknown>)[k])].some(n=>n!==null) || value.pages.length || value.referrers?.length || value.events.length || value.daily.some(day=>day.pageViews!==null || day.customEvents!==null))) return false;
  if(value.collection!==undefined&&(!record(value.collection)||!['consent-first','cookieless'].includes(value.collection.mode as string)||value.collection.captureCoverage!=='unknown'||!record(value.collection.pageViews)||!['cookieless','consent','unknown'].every(k=>nullableCount((value.collection as {pageViews:Record<string,unknown>}).pageViews[k]))))return false;
  if(value.geography===undefined?Object.keys(geographyFilters).length>0:!validGeography(value.geography,geographyFilters,value.totals.pageViews as number|null,value.measurement.identifiedPageViews as number|null,value.coverage.status as string))return false;
  return value.environment === undefined ? !Object.keys(filters).length : validEnvironment(value.environment,filters,value.totals.pageViews as number|null,value.measurement.identifiedPageViews as number|null,value.coverage.status==='unavailable');
}

function validComparison(data: Analytics, range: Range, filters: EnvironmentFilters, mode: AnalyticsComparisonMode, geographyFilters:GeographyFilters={}): boolean {
  const value:unknown=data.comparison, derived=deriveAnalyticsComparison(range,mode);
  if(!derived||!keys(value,['version','mode','asOf','report','change','alignment','calendar'])||value.version!=='analytics-comparison-v1'||value.mode!==mode||!stamp(value.asOf)||new Date(value.asOf).toISOString()!==value.asOf||!validReport(value.report,derived.range,filters,367,geographyFilters)||value.report.comparison!==undefined||!keys(value.alignment,['method','currentDays','comparisonDays','slots','overlapDays'])||Object.entries(derived.alignment).some(([key,item])=>(value.alignment as Record<string,unknown>)[key]!==item)||!keys(value.calendar,['current','comparison'])||!keys(value.change,['pageViews','customEvents','visitors','visits','averageVisitSeconds','bounceRate']))return false;
  const prior=value.report;
  function period(report:Analytics,days:number){
    const start=parseDay(report.range.from)!,end=parseDay(report.range.to)!+DAY_MS,retention=(from:number,to:number)=>retentionCoverage(new Date(from).toISOString(),new Date(to).toISOString(),report.coverage.retainedFrom).status;
    if(!report.environment||!report.collection||report.measurement.version!=='umami-3.4-hour-cache-v1'||report.coverage.status!==retention(start,end)||report.daily.length!==days||report.daily.some((day,index)=>day.date!==shiftDays(report.range.from,index)||day.coverage!==retention(start+index*DAY_MS,start+(index+1)*DAY_MS)||(day.coverage==='unavailable'?[day.pageViews,day.customEvents].some(n=>n!==null):![day.pageViews,day.customEvents].every(count))))return false;
    const {measurement:m,totals:t,collection:c}=report, unavailable=report.coverage.status==='unavailable';
    if(!unavailable&&(report.daily.reduce((sum,day)=>sum+(day.pageViews??0),0)!==t.pageViews||report.daily.reduce((sum,day)=>sum+(day.customEvents??0),0)!==t.customEvents||m.identifiedPageViews!+m.unidentifiedPageViews! !== t.pageViews||c.pageViews.cookieless!+c.pageViews.consent!+c.pageViews.unknown! !== t.pageViews))return false;
    if(m.identifiedPageViews===0?[m.visitors,m.visits,m.bounceRate,m.averageVisitSeconds].some(n=>n!==null):!unavailable&&(m.visitors===null||m.visits===null||m.visitors<1||m.visits<1||m.visitors>m.identifiedPageViews!||m.visits>m.identifiedPageViews!||m.bounceRate===null||m.averageVisitSeconds===null))return false;
    return [report.lastReceivedAt,report.environment.coverage.firstRecordedAt].every(value=>value===null||Date.parse(value)>=start&&Date.parse(value)<end)&&new Set(report.pages.map(row=>row.path)).size===report.pages.length&&new Set(report.events.map(row=>row.name)).size===report.events.length&&report.pages.every(row=>row.pageViews>0)&&report.events.every(row=>row.count>0)&&report.pages.reduce((sum,row)=>sum+row.pageViews,0)<=(t.pageViews??0)&&report.events.reduce((sum,row)=>sum+row.count,0)<=(t.customEvents??0);
  }
  if(!period(data,derived.alignment.currentDays)||!period(prior,derived.alignment.comparisonDays)||data.collection!.mode!==prior.collection!.mode)return false;
  const calendar=(dates:Range)=>Date.parse(value.asOf as string)<=parseDay(dates.from)!?'future':Date.parse(value.asOf as string)<parseDay(dates.to)!+DAY_MS?'partial':'complete';
  if(value.calendar.current!==calendar(range)||value.calendar.comparison!==calendar(derived.range))return false;
  const available=data.coverage.status==='complete'&&prior.coverage.status==='complete';
  const close=(actual:unknown,expected:number|null)=>expected===null?actual===null:typeof actual==='number'&&Number.isFinite(actual)&&Math.abs(actual-expected)<=1e-9*Math.max(1,Math.abs(expected));
  for(const name of ['pageViews','customEvents','visitors','visits','averageVisitSeconds'] as const){
    const current=name==='pageViews'||name==='customEvents'?data.totals[name]:data.measurement[name],previous=name==='pageViews'||name==='customEvents'?prior.totals[name]:prior.measurement[name],absolute=available&&current!==null&&previous!==null?current-previous:null,percent=absolute!==null&&previous!==null&&previous>0?100*absolute/previous:null,row=value.change[name];
    if(!keys(row,['absolute','percent'])||!close(row.absolute,absolute)||!close(row.percent,percent!==null&&Number.isFinite(percent)?percent:null))return false;
  }
  return keys(value.change.bounceRate,['percentagePoints'])&&close(value.change.bounceRate.percentagePoints,available&&data.measurement.bounceRate!==null&&prior.measurement.bounceRate!==null?data.measurement.bounceRate-prior.measurement.bounceRate:null);
}

function ComparisonSummary({data}:{data:Analytics&{comparison:AnalyticsComparison}}){
  const comparison=data.comparison,prior=comparison.report,provisional=Object.values(comparison.calendar).includes('partial'),future=Object.values(comparison.calendar).includes('future');
  const values=[{name:'Recorded pageviews',current:data.totals.pageViews,previous:prior.totals.pageViews,change:comparison.change.pageViews},{name:'Custom events',current:data.totals.customEvents,previous:prior.totals.customEvents,change:comparison.change.customEvents},{name:'Estimated visitors',current:data.measurement.visitors,previous:prior.measurement.visitors,change:comparison.change.visitors},{name:'Visits',current:data.measurement.visits,previous:prior.measurement.visits,change:comparison.change.visits},{name:'Bounce rate',current:data.measurement.bounceRate,previous:prior.measurement.bounceRate,change:{absolute:comparison.change.bounceRate.percentagePoints,percent:null},unit:'pp'},{name:'Average observed visit',current:data.measurement.averageVisitSeconds,previous:prior.measurement.averageVisitSeconds,change:comparison.change.averageVisitSeconds,unit:'s'}];
  const format=(value:number|null,name:string)=>value===null?'Unavailable':name==='Bounce rate'?`${value.toFixed(1)}%`:name==='Average observed visit'?`${value.toFixed(1)} s`:fmtNum(value);
  function change(row:typeof values[number]){
    const absolute=row.change.absolute;
    if(future)return 'Change unavailable — period not started';
    if(absolute===null)return 'Change unavailable';
    if(absolute===0)return `${provisional?'Provisional: ':''}No change`;
    const amount=row.unit?`${Math.abs(absolute).toFixed(1)} ${row.unit}`:fmtNum(Math.abs(absolute));
    return `${provisional?'Provisional: ':''}${absolute>0?'Up':'Down'} by ${amount}${!row.unit&&row.previous===0?' from 0':!row.unit&&row.change.percent!==null?` (${absolute>0?'+':'−'}${Math.abs(row.change.percent).toFixed(1)}%)`:''}`;
  }
  return <section className="card analytics-comparison-overview" aria-label="Comparison overview"><h2>Comparison overview</h2>
    <p className="hint">Report generated {fmtUtc(comparison.asOf)}. Each period uses its whole selected UTC dates; this is not a comparison of matching elapsed hours.</p>
    {(provisional||future)&&<p className="notice" role="status">{future?'A selected period has not started. Changes are unavailable.':'Period in progress — comparison is provisional. Today is unfinished.'}</p>}
    {[['Current period',data],['Previous period',prior]] .map(([label,report])=>{const period=report as Analytics;return <p className={period.coverage.status==='complete'?'hint':'notice'} key={label as string}><strong>{label as string}:</strong> {period.coverage.status==='complete'?'Complete retained range':period.coverage.status==='partial'?'Partial retained range; values cover retained observations only':'History unavailable after retention'}. Visitor estimates cover {fmtNum(period.measurement.identifiedPageViews)} of {fmtNum(period.totals.pageViews)} retained pageviews. Recorded basis: {fmtNum(period.collection!.pageViews.cookieless)} cookieless, {fmtNum(period.collection!.pageViews.consent)} consent, {fmtNum(period.collection!.pageViews.unknown)} not recorded.{period.coverage.retainedFrom&&` Retained from ${fmtUtc(period.coverage.retainedFrom)}.`}</p>;})}
    {(data.coverage.status!=='complete'||prior.coverage.status!=='complete')&&<p className="hint">Changes are unavailable because one or both periods lack complete retained history. Extending retention cannot restore deleted observations.</p>}
    <div className="analytics-comparison-stats">{values.map(row=><section className="analytics-comparison-stat" key={row.name} aria-label={row.name}><h3>{row.name}</h3><dl><div><dt>Current</dt><dd>{format(row.current,row.name)}</dd></div><div><dt>Previous</dt><dd>{format(row.previous,row.name)}</dd></div></dl><p className="analytics-change">{change(row)}</p></section>)}</div>
    <p className="hint">Current collection setting: {data.collection!.mode==='cookieless'?'cookieless basic analytics':'consent-first analytics'}. Traffic coverage is unknown; complete retention is not complete website capture. Refusals, privacy signals, blockers and failed requests can leave visits unrecorded.</p>
    <details className="analytics-details"><summary>How to interpret comparisons</summary><p>Visitor estimates use monthly project keys, not unique people. Cookieless and consented activity use separate estimates. Different months can split the same person into separate estimates. Pageviews without estimates remain in traffic totals.</p><p>Visits use hourly keys and the existing page context. Bounce rate is the share of observed visits with one pageview and no custom events in that selected period. Its change is percentage points (pp). Average observed visit is first-to-last pageview duration, not engagement or time after the final pageview. An increase is not automatically an improvement.</p><p>A percentage change is unavailable when the previous value is zero. Counts still show the absolute change. Retention describes saved history; report generation time does not certify that a retention worker has already deleted everything due for removal.</p></details>
  </section>;
}

function ComparisonChart({data}:{data:Analytics&{comparison:AnalyticsComparison}}){
  const uid=useId(),[metricName,setMetricName]=useState<'pageViews'|'customEvents'>('pageViews'),comparison=data.comparison,prior=comparison.report;
  const days=Array.from({length:comparison.alignment.slots},(_,i)=>({current:data.daily[i],previous:prior.daily[i]})),max=Math.max(1,...days.flatMap(day=>[day.current?.[metricName]??0,day.previous?.[metricName]??0])),base=170,height=160,slot=12,width=days.length*slot;
  const label=metricName==='pageViews'?'Recorded pageviews':'Custom events';
  const cell=(day:Daily|undefined)=>day?`${fmtNum(day[metricName])} · ${day.coverage}`:'No matching day';
  return <section className="card analytics-comparison-activity"><div className="row between"><h2>Daily comparison (UTC)</h2><div className="analytics-comparison-metric"><label htmlFor={`${uid}-metric`}>Chart metric</label><select id={`${uid}-metric`} value={metricName} onChange={e=>setMetricName(e.target.value as typeof metricName)}><option value="pageViews">Recorded pageviews</option><option value="customEvents">Custom events</option></select></div></div>
    <p className="hint">Day of each period, aligned from its first UTC date. Missing counterparts are not zero. Visitor estimates are available in the period cards, not as a daily series.</p>
    {data.totals.pageViews===0&&data.totals.customEvents===0&&prior.totals.pageViews===0&&prior.totals.customEvents===0&&<p className="dim">No events recorded in either period.</p>}
    <svg className="analytics-chart analytics-comparison-chart" viewBox={`0 0 ${width} 180`} preserveAspectRatio="none" role="img" aria-label={`${label} by day of each period. Current solid, previous outlined. Exact dates and unavailable days are in the comparison data table.`}>{days.map((day,index)=><g key={index}>{(['current','previous'] as const).map((period,offset)=>{const observation=day[period],value=observation?.[metricName]??null,x=index*slot+1+offset*5.5;return value===null?<rect className="analytics-comparison-missing" key={period} x={x} y={10} width={4.5} height={height}><title>Day {index+1} · {period}: {observation?`${observation.date}, unavailable after retention`:'No matching day'}</title></rect>:<rect key={period} className={`analytics-comparison-bar-${period}`} x={x} y={base-value/max*height} width={4.5} height={value/max*height}><title>Day {index+1} · {period}: {observation!.date}, {value} {label.toLowerCase()} ({observation!.coverage})</title></rect>;})}</g>)}<line className="analytics-baseline" x1={0} y1={base} x2={width} y2={base}/></svg>
    <div className="analytics-axis analytics-comparison-axis" aria-hidden="true"><span>Day 1</span><span>Day {days.length}</span></div><p className="analytics-legend"><span className="analytics-key"><span className="analytics-swatch analytics-comparison-swatch-current" aria-hidden="true"/>Current · solid</span><span className="analytics-key"><span className="analytics-swatch analytics-comparison-swatch-previous" aria-hidden="true"/>Previous · outlined</span></p>
    <details className="analytics-details"><summary>Comparison data table</summary><div className="table-wrap" tabIndex={0} role="region" aria-label="Comparison daily data, scroll horizontally for dates and values"><table><thead><tr><th scope="col">Day of period</th><th scope="col">Current date (UTC)</th><th scope="col">Current {label.toLowerCase()} · retention</th><th scope="col">Previous date (UTC)</th><th scope="col">Previous {label.toLowerCase()} · retention</th></tr></thead><tbody>{days.map((day,i)=><tr key={i}><th scope="row">{i+1}</th><td>{day.current?.date??'No matching day'}</td><td>{cell(day.current)}</td><td>{day.previous?.date??'No matching day'}</td><td>{cell(day.previous)}</td></tr>)}</tbody></table></div></details>
  </section>;
}

const dimensionLabels:Record<AnalyticsDimension,string>={path:'Path',referrer:'Referrer',browser:'Browser',os:'OS',device:'Device',country:'Country',region:'Region',city:'City',language:'Language',event:'Event',campaignSource:'Campaign source',campaignMedium:'Campaign medium',campaignName:'Campaign name',campaignContent:'Campaign content',campaignTerm:'Campaign term',hostname:'Hostname',screen:'Recorded screen',channel:'Recorded channel'};
const selectionLabel=(field:string)=>field==='eventName'?'Event name':field==='origin'?'Origin':dimensionLabels[field as AnalyticsDimension];
function selectionFrom(query:string|undefined):{draft:ReturnType<typeof emptyAdvanced>;query?:string}|null{
  if(query===undefined)return {draft:emptyAdvanced()};
  if(!clean(query,20000)||!query)return null;
  try{
    const params=new URLSearchParams(query);
    for(const name of params.keys())if(![...analyticsSelectionFields,'predicates'].includes(name as never)||params.getAll(name).length!==1)return null;
    let raw:unknown=params.has('predicates')?JSON.parse(params.get('predicates')!):{version:1,match:'all',fields:[],properties:[]};
    if(!record(raw)||!Array.isArray(raw.fields))return null;
    raw={...raw,fields:[...raw.fields,...analyticsSelectionFields.filter(field=>params.has(field)).map(field=>({field,operator:'eq',value:params.get(field)!}))]};
    const draft=readAdvanced(raw);if(!draft||draft.match!=='all'||draft.properties.length||draft.sessionProperties.length||draft.fields.length>analyticsSelectionFields.length||new Set(draft.fields.map(row=>row.field)).size!==draft.fields.length||draft.fields.some(row=>!analyticsSelectionFields.includes(row.field as never)||!['eq','exists','missing'].includes(row.operator)))return null;
    const built=buildAdvanced(draft);return 'predicates'in built&&built.predicates?{draft,query:new URLSearchParams({predicates:JSON.stringify(built.predicates)}).toString()}:null;
  }catch{return null;}
}
/** Carry the applied population, not date/selection drafts or comparison presentation. */
export function analyticsExplorerQuery(search:NavigationSearch):string|null{
  const intent=analyticsNavigation(search),selection=selectionFrom(intent.analyticsSelection);
  if(intent.analyticsInvalid||!intent.analyticsFrom||!intent.analyticsTo||!selection)return null;
  const params=new URLSearchParams({from:intent.analyticsFrom,to:intent.analyticsTo,timeZone:'UTC',kind:'all',groupBy:'event'});
  for(const field of environmentFields){const value=intent[analyticsNavigationNames[field]];if(value!==undefined)params.set(field,value);}
  for(const field of geographyFields){const value=intent[geographyNavigationNames[field]];if(value!==undefined)params.set(field,value);}
  if(selection.query)params.set('predicates',new URLSearchParams(selection.query).get('predicates')!);
  return params.toString().length<=20000?params.toString():null;
}
const dimensionMetricNames=['pageViews','customEvents','identifiedPageViews','visitors','visits','bounceRate','averageVisitSeconds'] as const;
function validDimension(data:Analytics,field:AnalyticsDimension|undefined,selection:string|undefined):boolean{
  if(data.selection!==selection)return false;
  if(!field)return data.dimensionComparison===undefined;
  const value:unknown=data.dimensionComparison,prior=data.comparison?.report;
  if(!prior||!keys(value,['version','field','metric','selection','current','previous','method'])||value.version!=='native-dimension-comparison-v1'||value.field!==field||value.metric!==(field==='event'?'custom-events':'estimated-visitors')||value.selection!==(selection??null)||!keys(value.method,['population','ranking','missing','identity','changes'])||value.method.population!=='matching-retained-events'||value.method.ranking!=='visitors-pageviews-key-or-custom-events-key'||value.method.missing!=='explorer-typed-key'||value.method.identity!=='project-month-observed-key'||value.method.changes!=='complete-retention-current-minus-previous-previous-denominator'||'selection'in prior||'dimensionComparison'in prior)return false;
  const close=(actual:unknown,expected:number|null)=>expected===null?actual===null:typeof actual==='number'&&Number.isFinite(actual)&&Math.abs(actual-expected)<=1e-9*Math.max(1,Math.abs(expected));
  const metrics=(row:Record<string,unknown>,report:Analytics|typeof prior)=>{
    if(!['pageViews','customEvents','identifiedPageViews'].every(name=>count(row[name]))||!['visitors','visits'].every(name=>nullableCount(row[name]))||!metric(row.bounceRate,100)||!metric(row.averageVisitSeconds)||Number(row.identifiedPageViews)>Number(row.pageViews)||Number(row.pageViews)>(report.totals.pageViews??0)||Number(row.customEvents)>(report.totals.customEvents??0)||Number(row.identifiedPageViews)>(report.measurement.identifiedPageViews??0))return false;
    if(field==='event'&&(row.pageViews!==0||row.identifiedPageViews!==0||row.customEvents===0)||field!=='event'&&row.pageViews===0)return false;
    if(row.identifiedPageViews===0||field==='event')return ['visitors','visits','bounceRate','averageVisitSeconds'].every(name=>row[name]===null);
    return row.visitors!==null&&row.visits!==null&&Number(row.visitors)>0&&Number(row.visits)>0&&Number(row.visitors)<=Number(row.identifiedPageViews)&&Number(row.visits)<=Number(row.identifiedPageViews)&&Number(row.visitors)<=Number(report.measurement.visitors)&&Number(row.visits)<=Number(report.measurement.visits)&&Number(row.visitors)<=Number(row.visits)&&row.bounceRate!==null&&row.averageVisitSeconds!==null;
  };
  for(const side of ['current','previous'] as const){
    const period=value[side],report=side==='current'?data:prior,other=side==='current'?prior:data,unavailable=report.coverage.status==='unavailable';
    if(!keys(period,['range','coverage','identityCoverage','totalGroups','returnedGroups','returnedPageViews','truncated','rows'])||!keys(period.range,['from','to','timeZone'])||Object.entries(report.range).some(([key,item])=>(period.range as Record<string,unknown>)[key]!==item)||!keys(period.coverage,['status','retainedFrom'])||period.coverage.status!==report.coverage.status||period.coverage.retainedFrom!==report.coverage.retainedFrom||!keys(period.identityCoverage,['identifiedPageViews','unidentifiedPageViews'])||period.identityCoverage.identifiedPageViews!==report.measurement.identifiedPageViews||period.identityCoverage.unidentifiedPageViews!==report.measurement.unidentifiedPageViews||!Array.isArray(period.rows)||period.rows.length>20||period.returnedGroups!==period.rows.length)return false;
    if(unavailable){if(period.rows.length||period.totalGroups!==null||period.returnedPageViews!==null||period.truncated!==false)return false;continue;}
    if(!count(period.totalGroups)||period.rows.length!==Math.min(20,period.totalGroups)||period.truncated!==(period.totalGroups>20)||!count(period.returnedPageViews))return false;
    const seen=new Set<string>();let pageViews=0,customEvents=0,identified=0;
    for(const row of period.rows){
      if(!keys(row,[...dimensionMetricNames,'key','counterpart','change'])||!keys(row.key,['type','value'])||!(row.key.type==='missing'&&row.key.value===null||row.key.type==='string'&&clean(row.key.value,analyticsFieldLimit(field)))||geographyFields.includes(field as GeoField)&&(row.key.type!=='string'||!parseGeographyKey(field as GeoField,row.key.value))||!metrics(row,report)||!keys(row.counterpart,[...dimensionMetricNames,'present'])||!keys(row.change,['absolute','percent']))return false;
      const key=JSON.stringify(row.key);if(seen.has(key))return false;seen.add(key);pageViews+=Number(row.pageViews);customEvents+=Number(row.customEvents);identified+=Number(row.identifiedPageViews);
      const counterpart=row.counterpart;
      if(other.coverage.status==='unavailable'){if(counterpart.present!==null||dimensionMetricNames.some(name=>counterpart[name]!==null))return false;}
      else if(counterpart.present===false){const keyed=field!=='event'&&(other.measurement.identifiedPageViews??0)>0;for(const name of dimensionMetricNames){const expected=['pageViews','customEvents','identifiedPageViews'].includes(name)?0:['visitors','visits'].includes(name)&&keyed?0:null;if(counterpart[name]!==expected)return false;}}
      else if(counterpart.present!==true||!metrics(counterpart,other))return false;
      const here=field==='event'?row.customEvents:row.visitors,there=field==='event'?counterpart.customEvents:counterpart.visitors,current=side==='current'?here:there,previous=side==='current'?there:here;
      const absolute=report.coverage.status==='complete'&&other.coverage.status==='complete'&&current!==null&&previous!==null?Number(current)-Number(previous):null,percent=absolute!==null&&previous!==null&&Number(previous)>0?100*absolute/Number(previous):null;
      if(!close(row.change.absolute,absolute)||!close(row.change.percent,percent))return false;
    }
    if(period.returnedPageViews!==pageViews||pageViews>(report.totals.pageViews??0)||customEvents>(report.totals.customEvents??0)||identified>(report.measurement.identifiedPageViews??0)||period.totalGroups>(field==='event'?report.totals.customEvents??0:report.totals.pageViews??0)||!period.truncated&&(field==='event'?customEvents!==report.totals.customEvents:pageViews!==report.totals.pageViews||identified!==report.measurement.identifiedPageViews))return false;
  }
  // Visible counterparts must agree too; unseen counterparts are never inferred from a top list.
  const pair=value as unknown as AnalyticsDimensionComparison;
  for(const side of ['current','previous'] as const)for(const row of pair[side].rows){const opposite=pair[side==='current'?'previous':'current'],other=opposite.rows.find(item=>item.key.type===row.key.type&&item.key.value===row.key.value);if(other?(row.counterpart.present!==true||dimensionMetricNames.some(name=>!close(row.counterpart[name],other[name]))):opposite.coverage.status!=='unavailable'&&!opposite.truncated&&row.counterpart.present!==false)return false;}
  return true;
}
function SelectionControls({value,busy,onApply}:{value:ReturnType<typeof emptyAdvanced>;busy:boolean;onApply:(query:string|undefined)=>void}){
  const uid=useId(),[draft,setDraft]=useState(value),[error,setError]=useState('');
  function apply(event:FormEvent){event.preventDefault();const built=buildAdvanced(draft);if('error'in built){setError(built.error);focusAdvanced(uid,built);return;}const query=built.predicates?new URLSearchParams({predicates:JSON.stringify(built.predicates)}).toString():undefined;if(query!==undefined&&!selectionFrom(query)){setError('Use each supported field once with an exact or presence condition.');return;}setError('');onApply(query);}
  return <details id={uid} className="card analytics-selection"><summary>Report filters{value.fields.length?` (${value.fields.length})`:''}</summary><p className="hint">All conditions must match. Apply updates every report in both periods. Exact text is case-sensitive; an empty string is different from missing.</p><form onSubmit={apply}><fieldset disabled={busy}><legend className="sr-only">Exact and presence filters</legend>{draft.fields.map((row,index)=><div className="analytics-selection-row" key={row.id}><div><label htmlFor={`${uid}-${row.id}-field`}>Field {index+1}</label><select id={`${uid}-${row.id}-field`} value={row.field} onChange={e=>setDraft({...draft,fields:draft.fields.map((item,i)=>i===index?{...item,field:e.target.value}:item)})}>{analyticsSelectionFields.map(field=><option key={field} value={field} disabled={draft.fields.some((item,i)=>i!==index&&item.field===field)}>{selectionLabel(field)}</option>)}</select></div><div><label htmlFor={`${uid}-${row.id}-operator`}>Condition {index+1}</label><select id={`${uid}-${row.id}-operator`} value={row.operator} onChange={e=>setDraft({...draft,fields:draft.fields.map((item,i)=>i===index?{...item,operator:e.target.value}:item)})}><option value="eq">is</option><option value="exists">is recorded</option><option value="missing">is missing</option></select></div>{row.operator==='eq'&&<div><label htmlFor={`${uid}-${row.id}-value`}>Exact value {index+1}</label><input id={`${uid}-${row.id}-value`} value={row.value} maxLength={analyticsFieldLimit(row.field)} onChange={e=>setDraft({...draft,fields:draft.fields.map((item,i)=>i===index?{...item,value:e.target.value}:item)})}/></div>}<button type="button" className="btn ghost" aria-label={`Remove condition ${index+1}`} onClick={()=>setDraft({...draft,fields:draft.fields.filter((_,i)=>i!==index)})}>Remove</button></div>)}<div className="row"><button type="button" className="btn" disabled={draft.fields.length===analyticsSelectionFields.length} onClick={()=>setDraft({...draft,fields:[...draft.fields,{id:crypto.randomUUID(),field:analyticsSelectionFields.find(field=>!draft.fields.some(row=>row.field===field))!,operator:'eq',type:'',value:''}]})}>Add condition</button><button type="submit" className="btn primary">Apply report filters</button><button type="button" className="btn ghost" onClick={()=>{setDraft(emptyAdvanced());setError('');onApply(undefined);}}>Clear selection</button></div></fieldset>{error&&<p role="alert" className="alert">{error}</p>}</form></details>;
}
function dimensionLabel(field:AnalyticsDimension,key:AnalyticsDimensionKey){
  if(key.type==='missing')return 'Not recorded';
  if(geographyFields.includes(field as GeoField))return geographyLabel(parseGeographyKey(field as GeoField,key.value)!);
  if(environmentFields.includes(field as EnvironmentField)&&isEnvironmentFilter(field as EnvironmentField,key.value)&&key.value!=='not-recorded')return environmentValue(field as EnvironmentField,key.value);
  return key.value===''?'(empty string)':key.value==='not-recorded'?'"not-recorded" (literal)':key.value;
}
function ComparisonRankings({data,busy,onFilter}:{data:Analytics&{comparison:AnalyticsComparison};busy:boolean;onFilter:(field:AnalyticsDimension,key:AnalyticsDimensionKey)=>void}){
  const value=data.dimensionComparison!,field=value.field,provisional=Object.values(data.comparison.calendar).includes('partial'),future=Object.values(data.comparison.calendar).includes('future');
  return <div className="analytics-dimension-pair">{(['previous','current'] as const).map(side=>{const period=value[side],label=side==='previous'?'Previous period':'Current period';return <section className="card analytics-breakdown analytics-comparison-ranking" key={side}><h2>{label} · {dimensionLabels[field]}</h2><p className="hint"><bdi dir="ltr">{period.range.from}</bdi> to <bdi dir="ltr">{period.range.to}</bdi> (UTC) · {period.coverage.status} retained range.</p><p className="hint">{period.totalGroups===null?'Category history unavailable.':`Showing ${period.returnedGroups} of ${period.totalGroups} categories${period.truncated?' (top 20)':''}.`} Visitor estimates can overlap between categories. Selecting a row filters both periods.</p><p className="hint">Visitor estimates cover {fmtNum(period.identityCoverage.identifiedPageViews)} pageviews; {fmtNum(period.identityCoverage.unidentifiedPageViews)} pageviews lack estimates.</p><div className="table-wrap" tabIndex={0} role="region" aria-label={`${label} dimension rows`}><table><caption className="sr-only">{label} · {dimensionLabels[field]} · {period.range.from} to {period.range.to} UTC</caption><thead><tr><th scope="col">{dimensionLabels[field]}</th><th scope="col" className="analytics-num">{value.metric==='custom-events'?'Custom events':'Estimated visitors'}</th>{side==='current'&&<th scope="col">Change from previous</th>}</tr></thead><tbody>{period.rows.map(row=>{const filterable=!environmentFields.includes(field as EnvironmentField)||row.key.type==='missing'||row.key.value!=='not-recorded'&&isEnvironmentFilter(field as EnvironmentField,row.key.value),absolute=row.change.absolute,previous=value.metric==='custom-events'?row.counterpart.customEvents:row.counterpart.visitors;return <tr key={JSON.stringify(row.key)}><th scope="row" className="analytics-path"><button type="button" className="analytics-dimension-label" disabled={busy||!filterable} title={filterable?undefined:'This recorded value cannot be used by the current environment filter.'} onClick={()=>onFilter(field,row.key)} aria-label={`Filter ${dimensionLabels[field]}: ${dimensionLabel(field,row.key)}`}><bdi dir={field==='path'||field==='referrer'?'ltr':'auto'}>{dimensionLabel(field,row.key)}</bdi></button>{!filterable&&<span className="hint">Exact filter unavailable for this recorded value.</span>}</th><td className="analytics-num">{fmtNum(value.metric==='custom-events'?row.customEvents:row.visitors)}</td>{side==='current'&&<td className="analytics-dimension-change">{future||absolute===null?'Change unavailable':`${provisional?'Provisional: ':''}${absolute===0?'No change':`${absolute>0?'+':'−'}${fmtNum(Math.abs(absolute))}${previous===0?' from 0':row.change.percent===null?'':` (${row.change.percent>0?'+':'−'}${Math.abs(row.change.percent).toFixed(1)}%)`}`}`}</td>}</tr>;})}</tbody></table></div>{!period.rows.length&&<p className="dim">{period.coverage.status==='unavailable'?'History unavailable after retention.':'No rows in the retained portion of this period.'}</p>}<p className="hint">Counterparts use the full other period, including categories outside its top 20. No percentage of total traffic is implied. Category page views and duration use matching page views. Any retained custom event from the same visit in this date range suppresses its bounce, even when excluded by the report filters.</p></section>;})}</div>;
}

// Same spreadsheet escaping as explorer-input.csvCell, without importing its Node-only parser into the browser.
function csvCell(value: unknown): string {
  let cell=value===null||value===undefined?'Unavailable':typeof value==='object'?JSON.stringify(value):String(value);
  if (/^[\s\uFEFF]*[=+@-]/u.test(cell) || /^[\t\r\n]/.test(cell)) cell=`'${cell}`;
  return `"${cell.replaceAll('"','""')}"`;
}

function EnvironmentCard({data,busy,field,onFieldChange,onFilter,periodLabel}:{data:Analytics;busy:boolean;field:EnvironmentField;onFieldChange:(field:EnvironmentField)=>void;onFilter:(field:EnvironmentField,value:string|null)=>void;periodLabel?:string}) {
  const uid=useId(), [open,setOpen]=useState(false), [search,setSearch]=useState(''), [notice,setNotice]=useState('');
  const dialog=useRef<HTMLDialogElement>(null), blob=useRef<string|null>(null), timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const environment=data.environment, rows=environment?.[environmentRows[field]]??[], measured=rows.some(row=>row.visitors!==null), metricLabel=measured?'Estimated visitors':'Recorded pageviews';
  const visible=rows.filter(row=>environmentValue(field,row.value).toLowerCase().includes(search.trim().toLowerCase()));
  const max=Math.max(1,...rows.map(row=>measured?row.visitors??0:row.pageViews));
  const revoke=()=>{if(timer.current!==null)clearTimeout(timer.current);if(blob.current)URL.revokeObjectURL(blob.current);timer.current=null;blob.current=null;};
  useEffect(()=>()=>revoke(),[]);
  useEffect(()=>{const node=dialog.current;if(open&&node&&!node.open)node.showModal();if(!open&&node?.open)node.close();},[open]);
  function select(next:EnvironmentField){onFieldChange(next);setSearch('');setNotice('');}
  function filter(row:EnvironmentRow){dialog.current?.close();onFilter(field,row.value);}
  function download(){
    if(!environment||busy||!visible.length)return;
    const header=['From (UTC)','To (UTC)','Dimension','Category','Recorded pageviews','Pageviews with visitor estimate','Estimated visitors','Visits','Bounce rate (%)','Average observed visit (seconds)','Retention coverage','Environment pageviews','Environment recorded pageviews','Environment not-recorded pageviews','First environment observation','Applied filters','Parser version','Source','Device method','Raw User-Agent stored'];
    const lines=[header,...visible.map(row=>[data.range.from,data.range.to,environmentLabels[field],environmentValue(field,row.value),row.pageViews,row.identifiedPageViews,row.visitors,row.visits,row.bounceRate,row.averageVisitSeconds,data.coverage.status,environment.coverage.pageViews,environment.coverage.recordedPageViews,environment.coverage.notRecordedPageViews,environment.coverage.firstRecordedAt,environment.filters,environment.version,environment.method.source,environment.method.device,'false'])];
    revoke();blob.current=URL.createObjectURL(new Blob([lines.map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=blob.current;anchor.download=`analytics-${field}-${data.range.from}-${data.range.to}.csv`;anchor.click();timer.current=setTimeout(revoke,1000);setNotice(`Downloaded ${visible.length} ${visible.length===1?'category':'categories'} from this displayed snapshot.`);
  }
  const tabs=(suffix:string)=><div className="analytics-environment-tabs" role="tablist" aria-label="Environment dimensions">{environmentFields.map(next=><button key={next} id={`${uid}-${suffix}-${next}`} data-field={next} role="tab" type="button" className={'btn'+(next===field?' active':'')} aria-selected={next===field} tabIndex={next===field?0:-1} aria-controls={`${uid}-${suffix}`} disabled={busy} onClick={()=>select(next)} onKeyDown={event=>{const at=environmentFields.indexOf(next),rtl=getComputedStyle(event.currentTarget).direction==='rtl',step=event.key==='ArrowRight'?(rtl?-1:1):event.key==='ArrowLeft'?(rtl?1:-1):0,target=event.key==='Home'?0:event.key==='End'?environmentFields.length-1:step?(at+step+environmentFields.length)%environmentFields.length:null;if(target===null)return;event.preventDefault();const value=environmentFields[target];select(value);event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-field="${value}"]`)?.focus();}}>{environmentLabels[next]}</button>)}</div>;
  return <section className="card analytics-breakdown analytics-environment" aria-labelledby={`${uid}-heading`}>
    <h2 id={`${uid}-heading`}>{periodLabel?`${periodLabel} · Environment`:'Environment'}</h2>{periodLabel&&<p className="hint">{data.range.from} to {data.range.to} (UTC) · Selecting a category filters both periods.</p>}{environment&&data.coverage.status!=='unavailable'&&tabs('list')}
    {!environment?<p className="dim">Environment data was not returned. Reload analytics to check this feature.</p>:data.coverage.status==='unavailable'?<p className="dim">Environment history is unavailable after retention. Choose a more recent date range.</p>:<>
      <p className="hint">{measured?'Top 10 categories by estimated visitors. A visitor estimate can appear in more than one category.':'Visitor estimates are unavailable. Categories show recorded pageviews.'}</p>
      <div id={`${uid}-list`} className="analytics-environment-list" role="tabpanel" aria-labelledby={`${uid}-list-${field}`}>
        <div className="analytics-environment-list-heading"><strong>{environmentLabels[field]}</strong><strong>{metricLabel}</strong></div>
        {rows.length?rows.slice(0,10).map(row=><div className="analytics-environment-item" key={row.value??'not-recorded'}><button type="button" className="analytics-environment-row" disabled={busy} onClick={()=>filter(row)} aria-label={`Filter ${environmentLabels[field]}: ${environmentValue(field,row.value)}`}><span>{environmentValue(field,row.value)}</span><strong>{fmtNum(measured?row.visitors:row.pageViews)}</strong></button><meter aria-hidden="true" min={0} max={max} value={measured?row.visitors??0:row.pageViews}/></div>):<p className="dim">No recorded pageviews match this range and these filters.</p>}
      </div>
      <p className="hint">Environment recorded for {fmtNum(environment.coverage.recordedPageViews)} of {fmtNum(environment.coverage.pageViews)} retained pageviews. {fmtNum(environment.coverage.notRecordedPageViews)} not recorded.</p>
      <button type="button" className="btn ghost analytics-environment-more" disabled={busy||!rows.length} onClick={()=>{setSearch('');setNotice('');setOpen(true);}}>More <span className="sr-only">{environmentLabels[field]} details</span></button>
      <details className="analytics-details"><summary>How environment is recorded</summary><p>Browser and OS families come from a bounded request User-Agent. Device uses that family and, when screen collection is enabled, the observed screen width. These are estimates; spoofed or reduced browser information can change the result. Raw User-Agent, separate version fields and device models are not stored.</p><p>Unknown means classification was attempted but unrecognized. Not recorded means historical or API observations lack this evidence.{environment.coverage.firstRecordedAt?` First environment observation in this filtered range: ${fmtUtc(environment.coverage.firstRecordedAt)}.`:''} Counts cover stored observations, not all website visits.</p><p>Bars compare category counts with the largest category shown. Bounce and duration in More use only pageviews with a visitor estimate and the existing visit method.</p></details>
    </>}
    <dialog ref={dialog} className="analytics-environment-dialog" aria-labelledby={`${uid}-dialog-heading`} onKeyDownCapture={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();event.currentTarget.close();}}} onClose={()=>setOpen(false)}>
      <div className="row between analytics-environment-dialog-heading"><h2 id={`${uid}-dialog-heading`}>{periodLabel?`${periodLabel} · Environment details`:'Environment details'}</h2><button type="button" className="btn" autoFocus onClick={()=>dialog.current?.close()}>Close details</button></div>
      <p className="hint">{data.range.from} to {data.range.to} (UTC) · {data.coverage.status==='complete'?'Retained date range':`${data.coverage.status} retained date range`}</p>{tabs('details')}
      <div className="analytics-environment-tools"><div><label htmlFor={`${uid}-search`}>Find a category</label><input id={`${uid}-search`} type="search" maxLength={100} value={search} onChange={e=>{setSearch(e.target.value);setNotice('');}}/></div><button type="button" className="btn" disabled={busy||!visible.length} onClick={download}>Download CSV</button></div>
      <p className="hint">Showing {visible.length} of {rows.length} stored categories. CSV uses these same rows and this snapshot.</p>
      <div id={`${uid}-details`} className="table-wrap" tabIndex={0} role="tabpanel" aria-labelledby={`${uid}-details-${field}`}><table><thead><tr><th scope="col">{environmentLabels[field]}</th>{['Estimated visitors','Visits','Recorded pageviews','Pageviews with visitor estimate','Bounce rate','Average observed visit'].map(label=><th scope="col" className="analytics-num" key={label}>{label}</th>)}</tr></thead><tbody>{visible.map(row=><tr key={row.value??'not-recorded'}><th scope="row"><button className="analytics-environment-label" type="button" disabled={busy} onClick={()=>filter(row)} aria-label={`Filter ${environmentLabels[field]}: ${environmentValue(field,row.value)}`}>{environmentValue(field,row.value)}</button></th><td className="analytics-num">{fmtNum(row.visitors)}</td><td className="analytics-num">{fmtNum(row.visits)}</td><td className="analytics-num">{fmtNum(row.pageViews)}</td><td className="analytics-num">{fmtNum(row.identifiedPageViews)}</td><td className="analytics-num">{row.bounceRate===null?'Unavailable':`${row.bounceRate.toFixed(1)}%`}</td><td className="analytics-num">{row.averageVisitSeconds===null?'Unavailable':`${row.averageVisitSeconds.toFixed(1)} s`}</td></tr>)}</tbody></table>{!visible.length&&<p className="dim">No categories match this search. Clear it to see the stored categories.</p>}</div>
      {notice&&<p className="hint" role="status">{notice}</p>}<p className="hint">Scroll the table horizontally to see all metrics. Unknown means classification was attempted; Not recorded means the observation lacks this evidence.</p><p className="hint">Visitor estimates and visits exclude pageviews without an estimate. Estimates may overlap between categories and are not unique people.</p>
    </dialog>
  </section>;
}

export function DailyChart({ daily, metrics = ['pageViews', 'customEvents'] }: { daily: Daily[]; metrics?: readonly ('pageViews' | 'customEvents')[] }) {
  if (daily.length === 0) return <p className="dim">No daily breakdown available for this range.</p>;
  const pv = metrics.includes('pageViews'), ce = metrics.includes('customEvents');
  const max = Math.max(1, ...daily.flatMap((d) => [pv ? d.pageViews ?? 0 : 0, ce ? d.customEvents ?? 0 : 0]));
  const slot = 12;
  const height = 160;
  const base = 170;
  const width = daily.length * slot;
  const first = daily[0].date;
  const last = daily[daily.length - 1].date;
  return (
    <>
      <svg
        className="analytics-chart"
        viewBox={`0 0 ${width} 180`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Bar chart of daily ${[pv && 'page views', ce && 'custom events'].filter(Boolean).join(' and ')} in UTC, from ${first} to ${last}. Full numbers in the daily data table below.`}
      >
        {daily.map((d, i) => {
          if (d.coverage === 'unavailable') return <rect key={d.date} x={i * slot + 1} y={10} width={10} height={height} fill="currentColor" opacity={0.12}><title>{d.date}: unavailable after retention</title></rect>;
          const pvH = ((d.pageViews ?? 0) / max) * height;
          const ceH = ((d.customEvents ?? 0) / max) * height;
          const x = i * slot;
          return (
            <g key={d.date}>
              {pv && <rect className="analytics-bar-pv" x={x + 1} y={base - pvH} width={4.5} height={pvH}>
                <title>{`${d.date}: ${d.pageViews} page views${d.coverage === 'partial' ? ' (partial day)' : ''}`}</title>
              </rect>}
              {ce && <rect className="analytics-bar-ce" x={x + 6.5} y={base - ceH} width={4.5} height={ceH}>
                <title>{`${d.date}: ${d.customEvents} custom events${d.coverage === 'partial' ? ' (partial day)' : ''}`}</title>
              </rect>}
            </g>
          );
        })}
        <line className="analytics-baseline" x1={0} y1={base} x2={width} y2={base} />
      </svg>
      <div className="analytics-axis" aria-hidden="true">
        <span>{first}</span>
        <span>{last}</span>
      </div>
      <p className="analytics-legend">
        {pv && <span className="analytics-key">
          <span className="analytics-swatch analytics-swatch-pv" aria-hidden="true" /> Page views
        </span>}
        {ce && <span className="analytics-key">
          <span className="analytics-swatch analytics-swatch-ce" aria-hidden="true" /> Custom events
        </span>}
      </p>
      {daily.some(day => day.coverage !== 'complete') && <p className="hint">Shaded days are unavailable after retention. Partial days include only the retained portion; see the daily table.</p>}
    </>
  );
}

export function AnalyticsPanel(props: AnalyticsPanelProps) {
  return <AnalyticsInner key={`${props.userId}:${props.projectId}:${Boolean(props.compareView)}`} {...props} />;
}
function AnalyticsInner({ projectId, userId, onUnauthorized, search, onNavigate, compareView=false, onAppliedRange, onReturnToExplorer }: AnalyticsPanelProps) {
  const uid = useId();
  const [localIntent,setLocalIntent]=useState<AnalyticsNavigation>({});
  const [geographyField,setGeographyField]=useState<GeoField>('country');
  const [environmentField,setEnvironmentField]=useState<EnvironmentField>('browser');
  const intent=search?analyticsNavigation(search):localIntent, queryKey=JSON.stringify(intent),mode=compareView?intent.analyticsCompare??'prev':undefined;
  const location=useLocation(),controlled=!!search&&!!onNavigate,routeReady=!controlled||location.pathname==='/'&&!location.hash&&search!.view===(compareView?'compare':'project')&&search!.project===projectId&&navigationKey(parseNavigation(location.search))===navigationKey(search!)&&canonicalNavigation(location.searchStr,search!);
  const readOwner=controlled?location.state.__TSR_key+':'+location.href+':'+queryKey:'local',currentOwner=useRef(''),acceptedOwner=useRef('');currentOwner.current=routeReady?readOwner:'';
  const dimension=compareView?intent.analyticsDimension??'path':undefined,selection=selectionFrom(intent.analyticsSelection);
  const filters:EnvironmentFilters={};
  for(const field of environmentFields){const value=intent[analyticsNavigationNames[field]];if(value!==undefined)filters[field]=value;}
  const geographyFilters:GeographyFilters={};
  for(const field of geographyFields){const value=intent[geographyNavigationNames[field]];if(value!==undefined)geographyFilters[field]=value;}
  const filterKey=JSON.stringify([filters,geographyFilters]), invalid=Boolean(intent.analyticsInvalid)||selection===null;
  const [view, setView] = useState<View>(() => fresh(projectId,intent));
  // A changed URL or project must never display the previous population.
  if (view.key !== projectId || view.queryKey !== queryKey) setView(fresh(projectId,intent));

  const reqRef = useRef(0);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const queryRef=useRef(queryKey);queryRef.current=queryKey;
  const unauthRef = useRef(onUnauthorized);
  unauthRef.current = onUnauthorized;

  const { from, to } = view.range;
  useEffect(()=>{if(routeReady&&!invalid)onAppliedRange?.(userId,projectId,{from,to});},[userId,projectId,from,to,routeReady,invalid,onAppliedRange]);
  const derived=mode?deriveAnalyticsComparison(view.range,mode):null,unavailableRange=compareView&&!derived;
  const nonce = view.nonce;
  useEffect(() => {
    const id = ++reqRef.current;
    const ctrl = new AbortController();
    if(!routeReady||invalid||unavailableRange)return ()=>ctrl.abort();
    setView(v=>({...v,data:null,error:null,loading:true}));
    const detail=view.detail,params=new URLSearchParams({from,to,...filters,...geographyFilters,...mode?{compare:mode}:{},...dimension?{dimension}:{},...selection?.query?{selection:selection.query}:{},...detail?{geoDetail:detail.field,geoPeriod:detail.period,geoSearch:detail.search}:{}});
    if((dimension||selection?.query)&&params.toString().length>20000){setView(v=>({...v,data:null,loading:false,error:'These report filters are too large. Shorten values or remove conditions.'}));return ()=>ctrl.abort();}
    api<Analytics>(
      `/api/projects/${encodeURIComponent(projectId)}/analytics?${params}`,
      { signal: ctrl.signal },
    ).then(
      (data) => {
        if (id !== reqRef.current || ctrl.signal.aborted || projectRef.current !== projectId || queryRef.current!==queryKey || currentOwner.current!==readOwner) return;
        if(!validReport(data,{from,to},filters,MAX_DAYS,geographyFilters)||(mode?!validComparison(data,{from,to},filters,mode,geographyFilters):data.comparison!==undefined)||!validDimension(data,dimension,selection?.query)||(detail?!validGeographyDetail(data.geographyDetail,detail,detail.period==='comparison'?data.comparison!.report:data,data.comparison?.asOf):data.geographyDetail!==undefined)||data.comparison?.report&&'geographyDetail'in data.comparison.report){
          setView(v=>v.key===projectId&&v.queryKey===queryKey?{...v,data:null,loading:false,error:'The analytics response did not match the requested range, filters or measurement evidence. Retry to read a fresh snapshot.'}:v);return;
        }
        acceptedOwner.current=readOwner;setView((v) => (v.key === projectId ? { ...v, data, loading: false, error: null, denied: false } : v));
      },
      (err: unknown) => {
        if (id !== reqRef.current || ctrl.signal.aborted || projectRef.current !== projectId || queryRef.current!==queryKey || currentOwner.current!==readOwner) return;
        if (err instanceof ApiError && err.status === 401) {
          setView(v=>({...v,data:null,loading:false,denied:true}));
          unauthRef.current();
          return;
        }
        setView((v) => (v.key === projectId ? { ...v, data: null, loading: false, error: errMsg(err), denied: err instanceof ApiError && [403,404].includes(err.status) } : v));
      },
    );
    return () => ctrl.abort();
  }, [projectId, from, to, nonce, filterKey, queryKey, invalid, mode, unavailableRange,dimension,selection?.query,routeReady,readOwner]);

  const navigate=(value:AnalyticsNavigation)=>onNavigate?onNavigate(value):setLocalIntent(value);
  const applyRange = (range: Range) => {
    const next={...intent,analyticsFrom:range.from,analyticsTo:range.to};
    if(JSON.stringify(next)===queryKey)setView(v=>({...v,draft:range,draftErr:null,data:null,loading:true,error:null,nonce:v.nonce+1}));
    else navigate(next);
  };
  const applyFilter=(field:EnvironmentField,value:string|null)=>navigate({...intent,analyticsFrom:view.range.from,analyticsTo:view.range.to,[analyticsNavigationNames[field]]:value??'not-recorded'});

  const applyLocation=(field:GeoField,key:GeographyKey)=>navigate(applyGeographyFilter({...intent,analyticsFrom:view.range.from,analyticsTo:view.range.to},field,key));
  const applySelection=(query:string|undefined)=>{const next={...intent,analyticsFrom:view.range.from,analyticsTo:view.range.to};if(query===undefined)delete next.analyticsSelection;else next.analyticsSelection=query;navigate(next);};
  const applyDimensionRow=(field:AnalyticsDimension,key:AnalyticsDimensionKey)=>{
    if(geographyFields.includes(field as GeoField)){if(key.type==='string')applyLocation(field as GeoField,parseGeographyKey(field as GeoField,key.value)!);return;}
    if(environmentFields.includes(field as EnvironmentField)){applyFilter(field as EnvironmentField,key.value);return;}
    const name=field==='event'?'eventName':field,draft=selection?.draft??emptyAdvanced(),next={...draft,fields:[...draft.fields.filter(row=>row.field!==name),{id:'selected',field:name,operator:key.type==='missing'?'missing':'eq',type:'',value:key.value??''}]},built=buildAdvanced(next);
    if('predicates'in built&&built.predicates)applySelection(new URLSearchParams({predicates:JSON.stringify(built.predicates)}).toString());
  };
  const loadLocation=(detail:GeographyDetailIntent)=>setView(v=>({...v,detail,loading:true,error:null,nonce:v.nonce+1}));

  const retry = () => setView((v) => ({ ...v, data:null, loading: true, error: null, nonce: v.nonce + 1 }));

  const applyDraft = (e: FormEvent) => {
    e.preventDefault();
    const f = parseDay(view.draft.from);
    const t = parseDay(view.draft.to);
    let msg: string | null = null;
    if (f === null || t === null) msg = 'Enter valid dates in YYYY-MM-DD format.';
    else if (f > t) msg = 'The start date must be on or before the end date.';
    else if (view.draft.to > todayUtc()) msg = 'Dates cannot be in the future.';
    else if ((t - f) / DAY_MS >= MAX_DAYS) msg = `The range can span at most ${MAX_DAYS} days.`;
    else if(mode&&!deriveAnalyticsComparison(view.draft,mode))msg='Choose later dates so the previous period stays on or after 1970-01-01.';
    if (msg) {
      setView((v) => ({ ...v, draftErr: msg }));
      return;
    }
    applyRange({ from: view.draft.from, to: view.draft.to });
  };

  const busy = !invalid&&!unavailableRange&&(!routeReady||view.loading||view.queryKey!==queryKey);
  const data = !routeReady||invalid||unavailableRange||view.queryKey!==queryKey||acceptedOwner.current!==readOwner?null:view.data;
  const referrersMeasured=Boolean(data?.referrers?.some(row=>row.visitors!==null));
  const exportDraft=initialDraft();exportDraft.from=from;exportDraft.to=to;
  for(const[field,value]of Object.entries({...filters,...geographyFilters}))if(value!==undefined)exportDraft.filters[field]={on:true,value};
  let exportUnsupported=invalid?'This applied scope cannot be exported. Return to Explore or explicitly reset Analytics.':'';
  for(const field of selection?.draft.fields??[]){if(field.operator!=='eq'){exportUnsupported='This applied selection uses recorded or missing conditions that this archive cannot represent. Apply exact values before exporting.';break;}exportDraft.filters[field.field]={on:true,value:field.value};}  const comparisonData=data?.comparison?data as Analytics&{comparison:AnalyticsComparison}:null;
  const exportRead=reqRef.current,exportEnabled=Boolean(data)&&!busy&&!view.denied;
  const exportCurrent=()=>exportEnabled&&reqRef.current===exportRead&&currentOwner.current===readOwner&&acceptedOwner.current===readOwner&&projectRef.current===projectId&&queryRef.current===queryKey;
  const exportAccessLost=(status:number)=>{reqRef.current++;acceptedOwner.current='';setView(value=>({...value,data:null,loading:false,denied:true,error:'Project access could not be verified. Retry to check current access.'}));if(status===401)unauthRef.current();};
  const today = todayUtc();
  const hasData = data !== null && (data.totals.pageViews ?? 0) + (data.totals.customEvents ?? 0) > 0;
  const annotations = useAnnotations({projectId,userId,range:invalid||unavailableRange||view.denied?null:{from,to,timeZone:'UTC'},readOwner,readEnabled:routeReady&&!invalid&&!unavailableRange&&!view.denied,onUnauthorized:()=>exportAccessLost(401),onAccessLost:exportAccessLost});

  return (
    <div className={'analytics'+(compareView?' analytics-compare':'')} aria-busy={busy}>
      {invalid&&<div className="alert" role="alert"><p>This Analytics link has invalid or unsupported applied scope. No analytics report was loaded. Analytics supports UTC dates, environment, location and literal page, event or campaign selections; cohorts, properties, other event kinds and advanced selections stay in Explore.</p>{onReturnToExplorer?<button type="button" className="btn" onClick={onReturnToExplorer}>Return to Explorer</button>:<p>The exact previous Explore link is not available in this history entry. Use browser Back or open Explore to choose a scope.</p>}<p>Reset deliberately clears these filters and loads the default Analytics range.</p><button type="button" className="btn" onClick={()=>navigate({})}>Reset analytics view</button></div>}
      <section className="card analytics-toolbar">
        <form onSubmit={applyDraft}>
          <fieldset className="analytics-fieldset" disabled={busy||invalid}>
            <legend className="sr-only">Time range (UTC)</legend>
            <div className="analytics-presets">
              {PRESETS.map((p) => {
                const active = view.range.from === shiftDays(today, -(p.days - 1)) && view.range.to === today;
                return (
                  <button
                    key={p.days}
                    type="button"
                    className={active ? 'btn analytics-preset active' : 'btn analytics-preset'}
                    aria-pressed={active}
                    onClick={() => applyRange(lastDays(p.days))}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <details className="analytics-custom-range"><summary>Custom dates <span className="dim">· UTC</span></summary>
            <div className="analytics-dates">
              <div className="analytics-date">
                <label htmlFor={`${uid}-from`}>From (UTC)</label>
                <input
                  id={`${uid}-from`}
                  type="date"
                  value={view.draft.from}
                  max={today}
                  onChange={(e) => setView((v) => ({ ...v, draft: { ...v.draft, from: e.target.value } }))}
                />
              </div>
              <div className="analytics-date">
                <label htmlFor={`${uid}-to`}>To (UTC)</label>
                <input
                  id={`${uid}-to`}
                  type="date"
                  value={view.draft.to}
                  max={today}
                  onChange={(e) => setView((v) => ({ ...v, draft: { ...v.draft, to: e.target.value } }))}
                />
              </div>
              <button type="submit" className="btn primary analytics-apply">
                Apply
              </button>
            </div>
            </details>
          </fieldset>
          {view.draftErr && (
            <p className="err-text analytics-draft-err" role="alert">
              {view.draftErr}
            </p>
          )}
        </form>
        <AnalyticsExport key={queryKey+':'+readOwner} projectId={projectId} initial={exportDraft} unsupported={exportUnsupported} readOwner={readOwner+':'+String(reqRef.current)} readEnabled={exportEnabled} isParentCurrent={exportCurrent} onAccessLoss={exportAccessLost}/>        {compareView&&<div className="analytics-comparison-mode"><label htmlFor={`${uid}-compare`}>Compare with</label><select id={`${uid}-compare`} value={mode} disabled={busy||invalid} onChange={e=>navigate({...intent,analyticsFrom:from,analyticsTo:to,analyticsCompare:e.target.value as AnalyticsComparisonMode})}><option value="prev">Previous period</option><option value="yoy">Previous year</option></select></div>}
      </section>
      {!invalid&&(compareView||selection?.query)&&<SelectionControls key={queryKey} value={selection!.draft} busy={busy||Boolean(view.denied)} onApply={applySelection}/>}
      {!invalid&&Boolean(selection?.draft.fields.length)&&<section className="card analytics-environment-filters" aria-label="Applied report selection"><strong>{compareView?'Applied to both periods':'Applied to all analytics'}</strong><div className="row">{selection!.draft.fields.map(row=><button type="button" className="btn" key={row.field} disabled={busy} aria-label={`Remove ${selectionLabel(row.field)} selection`} onClick={()=>{const built=buildAdvanced({...selection!.draft,fields:selection!.draft.fields.filter(item=>item.field!==row.field)});if('error'in built)return;applySelection(built.predicates?new URLSearchParams({predicates:JSON.stringify(built.predicates)}).toString():undefined);}}>{selectionLabel(row.field)} {row.operator==='eq'?`is ${JSON.stringify(row.value)}`:row.operator==='exists'?'is recorded':'is missing'} <span aria-hidden="true">×</span></button>)}</div></section>}
      {compareView&&!invalid&&<section className="card analytics-dimension-selector"><label htmlFor={`${uid}-dimension`}>Compare dimension</label><select id={`${uid}-dimension`} value={dimension} disabled={busy||Boolean(view.denied)} onChange={e=>navigate({...intent,analyticsFrom:from,analyticsTo:to,analyticsDimension:e.target.value as AnalyticsDimension})}>{analyticsDimensions.map(field=><option key={field} value={field}>{dimensionLabels[field]}</option>)}</select><p className="hint">One dimension for both periods. Each list contains up to 20 categories. Recorded screen is physical screen size, not viewport. Recorded channel uses saved campaign tags and referrer presence; it is not a full first-channel-per-visit classifier.</p></section>}
      {compareView&&!invalid&&(derived?<section className="card analytics-comparison-ranges" aria-label="Applied comparison periods"><div><strong>Current period</strong><p>{from} to {to} (UTC) · {derived.alignment.currentDays} {derived.alignment.currentDays===1?'day':'days'}</p></div><div><strong>{mode==='yoy'?'Previous year':'Previous period'}</strong><p>{derived.range.from} to {derived.range.to} (UTC) · {derived.alignment.comparisonDays} {derived.alignment.comparisonDays===1?'day':'days'}</p></div>{derived.alignment.currentDays!==derived.alignment.comparisonDays&&<p className="notice">These periods have different day counts because calendar years differ. The chart keeps all {derived.alignment.slots} days and leaves unmatched days unavailable.</p>}{derived.alignment.overlapDays>0&&<p className="notice">The selected periods overlap by {derived.alignment.overlapDays} {derived.alignment.overlapDays===1?'day':'days'}. Some observations can occur in both periods.</p>}</section>:<div className="alert" role="alert"><p>Choose later dates or a different comparison mode so the previous period stays on or after 1970-01-01.</p><button type="button" className="btn" onClick={()=>applyRange(lastDays(7))}>Reset comparison dates</button></div>)}
      {!invalid&&Object.keys(filters).length>0&&<section className="card analytics-environment-filters" aria-label="Applied environment filters"><strong>{compareView?'Applied to both periods':'Applied to all analytics'}</strong><div className="row">{environmentFields.filter(field=>filters[field]!==undefined).map(field=><button type="button" className="btn" key={field} disabled={busy} aria-label={`Remove ${environmentLabels[field]} filter: ${environmentValue(field,filters[field]!)}`} onClick={()=>{const next={...intent};delete next[analyticsNavigationNames[field]];navigate(next);}}>{environmentLabels[field]}: {environmentValue(field,filters[field]!)} <span aria-hidden="true">×</span></button>)}<button type="button" className="btn ghost" disabled={busy} onClick={()=>{const next={...intent};for(const field of environmentFields)delete next[analyticsNavigationNames[field]];navigate(next);}}>Clear environment filters</button></div><p className="hint">{compareView?'Both period cards, daily comparison and period reports':'Overview, daily activity, top pages, custom events and environment'} use these same required filters.</p></section>}

      {!invalid&&Object.keys(geographyFilters).length>0&&<section className="card analytics-environment-filters" aria-label="Applied location filters"><strong>{compareView?'Applied to both periods':'Applied to all analytics'}</strong><div className="row">{geographyFields.filter(field=>geographyFilters[field]!==undefined).map(field=><button type="button" className="btn" key={field} disabled={busy} onClick={()=>{const next={...intent};delete next[geographyNavigationNames[field]];navigate(next);}}>{geographyLabels[field]}: <bdi>{geographyLabel(parseGeographyKey(field,geographyFilters[field])!)}</bdi> <span aria-hidden="true">×</span></button>)}<button type="button" className="btn ghost" disabled={busy} onClick={()=>{const next={...intent};for(const field of geographyFields)delete next[geographyNavigationNames[field]];navigate(next);}}>Clear location filters</button></div><p className="hint">All cards, daily data and reports use these same exact location filters.</p></section>}

      {routeReady&&view.error && (
        <div className="alert" role="alert">
          <p>Could not load analytics for this range: {view.error}</p>
          <button type="button" className="btn" onClick={retry} disabled={busy}>
            Retry
          </button>
        </div>
      )}

      {busy && !data && !view.error && (
        <section className="card">
          <p className="dim" role="status">
            Loading analytics…
          </p>
        </section>
      )}

      {data && !compareView && (
        <>
          <section className="card analytics-overview">
            <div className="row between">
              <h2>Overview</h2>
              <span className="dim analytics-range-label">
                {data.range.from} to {data.range.to} (UTC)
              </span>
            </div>
            {data.coverage.status !== 'complete' && <p className="alert" role="status">
              {data.coverage.status === 'unavailable' ? 'This date range is unavailable after retention.' : 'This date range is partial after retention. Counts and estimates cover only retained observations.'}
              {data.coverage.retainedFrom && ` History is retained from ${fmtUtc(data.coverage.retainedFrom)}. Extending retention cannot restore deleted data.`}
            </p>}
            <div className="analytics-stats">
              <div className="analytics-stat">
                <span className="analytics-stat-label">Recorded pageviews</span>
                <p className={data.totals.pageViews === null ? 'analytics-unavailable' : 'big-num'}>{fmtNum(data.totals.pageViews)}</p>
              </div>
              <div className="analytics-stat">
                <span className="analytics-stat-label">Custom events</span>
                <p className={data.totals.customEvents === null ? 'analytics-unavailable' : 'big-num'}>{fmtNum(data.totals.customEvents)}</p>
              </div>
              <div className="analytics-stat">
                <span className="analytics-stat-label">Estimated visitors</span>
                <p className={data.measurement.visitors === null ? 'analytics-unavailable' : 'big-num'}>{data.measurement.visitors === null ? 'Unavailable' : fmtNum(data.measurement.visitors)}</p>
              </div>
              <div className="analytics-stat">
                <span className="analytics-stat-label">Visits</span>
                <p className={data.measurement.visits === null ? 'analytics-unavailable' : 'big-num'}>{data.measurement.visits === null ? 'Unavailable' : fmtNum(data.measurement.visits)}</p>
              </div>
              <div className="analytics-stat">
                <span className="analytics-stat-label">Bounce rate</span>
                <p className={data.measurement.bounceRate === null ? 'analytics-unavailable' : 'big-num'}>{data.measurement.bounceRate === null ? 'Unavailable' : `${data.measurement.bounceRate.toFixed(1)}%`}</p>
              </div>
              <div className="analytics-stat">
                <span className="analytics-stat-label">Average observed visit</span>
                <p className={data.measurement.averageVisitSeconds === null ? 'analytics-unavailable' : 'big-num'}>{data.measurement.averageVisitSeconds === null ? 'Unavailable' : `${data.measurement.averageVisitSeconds.toFixed(1)} s`}</p>
              </div>
            </div>
            {data.coverage.status !== 'unavailable' && <p className="hint">Visitor and visit estimates cover {fmtNum(data.measurement.identifiedPageViews)} of {fmtNum(data.totals.pageViews)} retained page views. Page views without a visitor estimate remain in traffic totals.</p>}
            {data.collection && <p className="hint">
              Current collection: {data.collection.mode==='cookieless'?'cookieless basic analytics':'consent-first analytics'}.
              {' '}Recorded pageviews in this range: {fmtNum(data.collection.pageViews.cookieless)} cookieless,
              {' '}{fmtNum(data.collection.pageViews.consent)} with consent,
              {' '}{fmtNum(data.collection.pageViews.unknown)} with unrecorded basis (historical or API observations).
            </p>}
            <p className="hint">Traffic coverage is unknown. Refusals, browser privacy signals, blockers, excluded traffic and failed requests can leave visits unrecorded. Retention completeness describes stored history, not all visits to your website.</p>
            <details className="analytics-details">
              <summary>How these estimates work</summary>
              <p>Visitors use a monthly, project-specific estimate. They are not a count of unique people. Network measurement must be configured by the installation operator; otherwise visitor and visit estimates are unavailable.</p>
              <p>Cookieless and consented events use separate estimates. Changing consent may split one person into two estimates; basic activity is not attached to a later identified profile.</p>
              <p>Visits use hourly keys, with an existing page context retained for up to 30 minutes. A bounce has one page view and no custom events within this date range. Duration runs from the first to the last page view; it does not measure active engagement or time after the last page view.</p>
            </details>
            <p className="footnote dim">
              {data.lastReceivedAt
                ? `Last event received ${fmtUtc(data.lastReceivedAt)}.`
                : data.coverage.status === 'complete' ? 'No events in this date range.' : 'No events are available in the retained portion of this range.'}
            </p>
          </section>

        </>
      )}
          {!compareView&&<section className="card analytics-activity">
            <h2>Daily activity (UTC)</h2>
            {data && <>
            {!hasData && data.coverage.status === 'complete' ? (
              <div className="empty analytics-empty-chart">
                <p>
                  <strong>No events in this range.</strong>
                </p>
                <p>Try a wider range, or check back after the project receives traffic.</p>
              </div>
            ) : (
              <>
                <DailyChart daily={data.daily} />
                <details className="analytics-details">
                  <summary>Daily data table</summary>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Date (UTC)</th>
                          <th scope="col" className="analytics-num">
                            Page views
                          </th>
                          <th scope="col" className="analytics-num">
                            Custom events
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.daily.map((d) => (
                          <tr key={d.date}>
                            <td className="mono">{d.date}{d.coverage === 'partial' && <span className="dim"> (partial)</span>}</td>
                            <td className="analytics-num">{fmtNum(d.pageViews)}</td>
                            <td className="analytics-num">{fmtNum(d.customEvents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
            <div className="annotation-dates" tabIndex={0} role="region" aria-label="Notes by day, scroll for more dates">
              {data.daily.map(d=><div className="annotation-date" key={d.date}><span className="hint">{d.date}</span>{annotations.dayButton(d.date)}</div>)}
            </div>
            </>}
            {!invalid&&annotations.panel}
          </section>}
      {comparisonData&&<><ComparisonSummary data={comparisonData}/><ComparisonChart data={comparisonData}/><section className="card analytics-comparison-notes"><h2>Current period notes</h2><p className="hint">Notes belong to their actual current UTC dates, not the aligned previous days.</p><div className="annotation-dates" tabIndex={0} role="region" aria-label="Current notes by day, scroll for more dates">{comparisonData.daily.map(d=><div className="annotation-date" key={d.date}><span className="hint">{d.date}</span>{annotations.dayButton(d.date)}</div>)}</div>{annotations.panel}</section><ComparisonRankings data={comparisonData} busy={busy} onFilter={applyDimensionRow}/><GeographyCard key={queryKey+'current'} period="current" detail={data?.geographyDetail} onDetail={loadLocation} data={comparisonData.geography} range={comparisonData.range} busy={busy} environmentFilters={filters} field={geographyField} onFieldChange={setGeographyField} onFilter={applyLocation} periodLabel="Current period"/><GeographyCard key={queryKey+'comparison'} period="comparison" detail={data?.geographyDetail} onDetail={loadLocation} data={(comparisonData.comparison.report as Analytics).geography} range={comparisonData.comparison.report.range} busy={busy} environmentFilters={filters} field={geographyField} onFieldChange={setGeographyField} onFilter={applyLocation} periodLabel="Previous period"/><EnvironmentCard data={comparisonData} busy={busy} periodLabel="Current period" field={environmentField} onFieldChange={setEnvironmentField} onFilter={applyFilter}/><EnvironmentCard data={comparisonData.comparison.report} busy={busy} periodLabel="Previous period" field={environmentField} onFieldChange={setEnvironmentField} onFilter={applyFilter}/></>}
      {data && !compareView && (
        <>
          <section className="card analytics-breakdown">
            <h2>Top pages</h2>
            <p className="hint">Up to 20 paths in this date range.</p>
            {data.pages.length === 0 ? (
              <p className="dim">{data.coverage.status === 'complete' ? 'No page views in this range.' : 'No page views are available in the retained portion.'}</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Path</th>
                      <th scope="col" className="analytics-num">
                        Page views
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pages.slice(0, 20).map((p) => (
                      <tr key={p.path}>
                        <td className="mono analytics-path">{p.path}</td>
                        <td className="analytics-num">{fmtNum(p.pageViews)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card analytics-breakdown">
            <h2>Top custom events</h2>
            <p className="hint">Up to 20 event names in this date range.</p>
            {data.events.length === 0 ? (
              <p className="dim">{data.coverage.status === 'complete' ? 'No custom events in this range.' : 'No custom events are available in the retained portion.'}</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Event name</th>
                      <th scope="col" className="analytics-num">
                        Count
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.slice(0, 20).map((ev) => (
                      <tr key={ev.name}>
                        <td className="mono analytics-path">{ev.name}</td>
                        <td className="analytics-num">{fmtNum(ev.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <GeographyCard key={queryKey} period="current" detail={data.geographyDetail} onDetail={loadLocation} data={data.geography} range={data.range} busy={busy} environmentFilters={filters} field={geographyField} onFieldChange={setGeographyField} onFilter={applyLocation}/>
          {data.referrers&&<section className="card analytics-breakdown">
            <h2>Top referrers</h2>
            <p className="hint">Up to 20 external referrer hosts in this date range. In-site navigation and page views without a recorded referrer are not listed; referrer capture is off by default and is turned on in Collection and privacy. Selecting a host filters every report by that referrer, including in-site navigation from it.</p>
            {data.referrers.length === 0 ? (
              <p className="dim">{data.coverage.status === 'complete' ? 'No referrer hosts are recorded in this range.' : 'No referrer hosts are recorded in the retained portion.'}</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th scope="col">Referrer</th><th scope="col" className="analytics-num">{referrersMeasured?'Estimated visitors':'Page views'}</th></tr></thead>
                  <tbody>
                    {data.referrers.map(row=><tr key={row.host}>
                      <td className="analytics-path"><button type="button" className="analytics-dimension-label" disabled={busy} onClick={()=>applyDimensionRow('referrer',{type:'string',value:row.host})} aria-label={`Filter Referrer: ${row.host}`}><bdi dir="ltr">{row.host}</bdi></button></td>
                      <td className="analytics-num">{fmtNum(referrersMeasured?row.visitors:row.pageViews)}</td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            )}
          </section>}
          <EnvironmentCard data={data} busy={busy} field={environmentField} onFieldChange={setEnvironmentField} onFilter={applyFilter}/>
        </>
      )}
    </div>
  );
}

const exportMaxBytes=16*1024*1024;
function AnalyticsExport({projectId,initial,unsupported,readOwner,readEnabled,isParentCurrent,onAccessLoss}:{projectId:string;initial:Draft;unsupported:string;readOwner:string;readEnabled:boolean;isParentCurrent:()=>boolean;onAccessLoss:(status:number)=>void}){
 const uid=useId(),[draft,setDraft]=useState(()=>initial),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');const operation=useRef<AbortController|null>(null),serial=useRef(0),mounted=useRef(true),blob=useRef<string|null>(null),blobTimer=useRef<ReturnType<typeof setTimeout>|null>(null),callbacks=useRef({onAccessLoss,isParentCurrent});callbacks.current={onAccessLoss,isParentCurrent};
 const authority=projectId+':'+readOwner+':'+String(readEnabled),latest=useRef(authority);latest.current=authority;const revoke=()=>{if(blobTimer.current)clearTimeout(blobTimer.current);blobTimer.current=null;if(blob.current)URL.revokeObjectURL(blob.current);blob.current=null;};
 const cancel=()=>{serial.current++;operation.current?.abort();operation.current=null;revoke();setBusy(false);setNotice('Export cancelled. No download was started.');};
 const dialog=useRef<HTMLDialogElement>(null),close=()=>{cancel();dialog.current?.close();setOpen(false);document.getElementById(uid+'open')?.focus();};
 useEffect(()=>{const node=dialog.current;if(open&&node){if(!node.open)node.showModal();document.getElementById(uid+'title')?.focus();}else if(node?.open)node.close();},[open,uid]);
 useEffect(()=>{operation.current?.abort();serial.current++;setBusy(false);setNotice('');revoke();dialog.current?.close();setOpen(false);},[authority]);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;serial.current++;operation.current?.abort();revoke();};},[]);
 const built=buildParams(draft);let scope='',validation='error'in built?built.error:'';if(!validation&&'qs'in built){const params=new URLSearchParams(built.qs);params.delete('kind');params.delete('groupBy');scope=params.toString();try{for(const value of [draft.from,draft.to])if(parseDay(value)===null)throw Error();new Intl.DateTimeFormat('en',{timeZone:draft.timeZone.trim()}).format();if(!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(draft.timeZone.trim()))throw Error();}catch{validation='Choose valid dates and a named IANA timezone.';}}
 if(!clean(scope,20000)||new TextEncoder().encode(JSON.stringify({scope})).length>32768)validation='These filters are too large or invalid. Shorten the selection.';
 const enabled=readEnabled&&!unsupported,disabled=busy||!enabled;
 async function download(){if(disabled||validation||!scope||operation.current||!callbacks.current.isParentCurrent())return;const expected=authority,generation=++serial.current,ctrl=new AbortController();operation.current=ctrl;const current=()=>mounted.current&&latest.current===expected&&serial.current===generation&&!ctrl.signal.aborted&&callbacks.current.isParentCurrent();setBusy(true);setError('');setNotice('');revoke();let timedOut=false;const deadline=setTimeout(()=>{timedOut=true;ctrl.abort();},30000);
  try{const path='/api/projects/'+encodeURIComponent(projectId)+'/analytics/export',response=await fetch(path,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({scope}),signal:ctrl.signal});if(!current()){await response.body?.cancel();return;}if(!response.ok){await response.body?.cancel();throw Object.assign(new ApiError(response.status===413?'The complete archive is too large. Narrow the dates or filters.':response.status===429?'Too many export attempts. Try again after a minute.':response.status===409?'Retention changed. Review the range and export again.':response.status===400?'Check the export dates and filters.':'The export could not be prepared. Try again.'),{status:response.status});}
   const length=response.headers.get('content-length'),asOf=response.headers.get('x-export-as-of'),currentRole=response.headers.get('x-export-role');if(response.url!==new URL(path,location.origin).href||response.status!==200||response.headers.get('content-type')!=='application/zip'||response.headers.get('content-disposition')!=='attachment; filename="analytics.zip"'||response.headers.get('cache-control')!=='no-store, no-transform'||response.headers.get('x-content-type-options')!=='nosniff'||!['', 'identity'].includes(response.headers.get('content-encoding')??'')||!length||!/^\d{1,8}$/.test(length)||Number(length)<22||Number(length)>exportMaxBytes||!asOf||asOf.length>80||!Number.isFinite(Date.parse(asOf))||!currentRole||!['owner','admin','editor','viewer'].includes(currentRole)||!response.body){await response.body?.cancel();throw Error('Archive response invalid.');}
   const bytes=new Uint8Array(Number(length)),reader=response.body.getReader();let written=0;try{for(;;){const part=await reader.read();if(!current())throw new DOMException('Cancelled','AbortError');if(part.done)break;if(part.value.length>bytes.length-written)throw Error('Archive exceeded its declared size.');bytes.set(part.value,written);written+=part.value.length;}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}if(written!==bytes.length)throw Error('Archive incomplete.');if(bytes.length<22||new DataView(bytes.buffer).getUint32(0,true)!==0x04034b50||new DataView(bytes.buffer).getUint32(bytes.length-22,true)!==0x06054b50)throw Error('Archive signature invalid.');if(!current())return;blob.current=URL.createObjectURL(new Blob([bytes],{type:'application/zip'}));const link=document.createElement('a');link.href=blob.current;link.download='analytics.zip';document.body.append(link);link.click();link.remove();blobTimer.current=setTimeout(revoke,1000);setNotice('Archive download started: seven complete CSV files.');
  }catch(value){if(!mounted.current||latest.current!==expected||serial.current!==generation||!callbacks.current.isParentCurrent())return;if(value instanceof ApiError&&(value.status===401||value.status===403||value.status===404)){callbacks.current.onAccessLoss(value.status);return;}if(ctrl.signal.aborted){if(timedOut)setError('The export timed out. Try a narrower range.');return;}setError(value instanceof ApiError?value.message:'The complete archive could not be verified. No download was started.');}finally{clearTimeout(deadline);if(operation.current===ctrl)operation.current=null;if(mounted.current&&latest.current===expected&&serial.current===generation&&callbacks.current.isParentCurrent())setBusy(false);}
 }
 const filterCount=Object.values(draft.filters).filter(value=>value.on).length+Number(draft.prop.on);
 return <div><button id={uid+'open'} type="button" className="btn" disabled={!readEnabled||!!unsupported} onClick={()=>{setNotice('');setError('');setOpen(true);}} aria-haspopup="dialog" aria-expanded={open} aria-controls={uid+'dialog'}>Export analytics</button>{unsupported&&<p className="hint">{unsupported}</p>}
  <dialog ref={dialog} id={uid+'dialog'} className="analytics-export-dialog" aria-labelledby={uid+'title'} onCancel={event=>{event.preventDefault();close();}} onClose={()=>{if(!dialog.current?.open){cancel();setOpen(false);}}}>
   {open&&<section aria-labelledby={uid+'title'} className="analytics-export" aria-busy={busy}>
    <header className="row between analytics-export-heading"><h3 id={uid+'title'} tabIndex={-1}>Export analytics</h3><button type="button" className="btn ghost" onClick={close}>Close export</button></header>
    <p className="hint">Seven CSV files · {filterCount?filterCount+' exact '+(filterCount===1?'filter':'filters'):'No filters'}. Starts from the applied report; changes here affect only this download. The comparison period is excluded.</p>
    <fieldset disabled={disabled}><legend>Date range and filters</legend><div className="analytics-export-range">
     <label>From<input aria-label="Export start date" type="date" value={draft.from} onChange={e=>setDraft(value=>({...value,from:e.target.value}))}/></label>
     <label>To<input aria-label="Export end date" type="date" value={draft.to} onChange={e=>setDraft(value=>({...value,to:e.target.value}))}/></label>
     <label>Timezone<input aria-label="Export timezone" list={uid+'zones'} value={draft.timeZone} maxLength={80} onChange={e=>setDraft(value=>({...value,timeZone:e.target.value}))}/></label>
    </div><p className="hint">Dates include both days in this timezone. Changing it affects this download; Analytics stays in UTC.</p><datalist id={uid+'zones'}>{TIMEZONES.map(zone=><option key={zone} value={zone}/>)}</datalist>
    <ExactFilterControls uid={uid+'export'} draft={draft} patchFilter={(key,value)=>setDraft(old=>({...old,filters:patchLocationFilters(old.filters,key,value)}))} patchProp={value=>setDraft(old=>({...old,prop:{...old.prop,...value}}))}/></fieldset>
    <details className="analytics-details"><summary>What's included</summary><p>Events, pages, referrers, browsers, operating systems, devices and countries, in seven complete CSV files. Missing data stays unavailable.</p><p>Exports use current access and retention. Oversized archives are refused in full. No new collection or provider request.</p></details>
    {busy&&<p role="status">Preparing the complete archive…</p>}{validation&&<p role="alert">{validation}</p>}{error&&<p className="alert" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <div className="row analytics-export-actions"><button type="button" className="btn" disabled={disabled||!!validation} onClick={download}>Download analytics ZIP</button>{busy&&<button type="button" className="btn ghost" onClick={cancel}>Cancel export</button>}</div>
   </section>}
  </dialog>
 </div>;
}