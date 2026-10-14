import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, errMsg } from '../lib/api';
import { environmentCatalog, environmentFields, environmentVersion, isEnvironmentFilter, type AnalyticsEnvironment, type EnvironmentField, type EnvironmentFilters, type EnvironmentRow } from '../lib/analytics-environment';
import { analyticsDay as parseDay, analyticsNavigation, analyticsNavigationNames, type AnalyticsNavigation, type NavigationSearch } from '../lib/navigation';
import { useAnnotations } from './AnnotationsPanel';
import './analytics.css';

export type AnalyticsPanelProps = {
  projectId: string;
  userId: string;
  onUnauthorized: () => void;
  search?: NavigationSearch;
  onNavigate?: (value: AnalyticsNavigation) => void;
};

type Daily = { date: string; pageViews: number | null; customEvents: number | null; coverage: 'complete' | 'partial' | 'unavailable' };
type Analytics = {
  range: { from: string; to: string; timeZone: 'UTC' };
  totals: { pageViews: number | null; customEvents: number | null };
  coverage: { status: 'complete' | 'partial' | 'unavailable'; retainedFrom: string | null };
  collection?: {mode:'consent-first'|'cookieless';captureCoverage:'unknown';pageViews:{cookieless:number|null;consent:number|null;unknown:number|null}};
  measurement: {
    identifiedPageViews: number | null; unidentifiedPageViews: number | null;
    visitors: number | null; visits: number | null;
    bounceRate: number | null; averageVisitSeconds: number | null;
  };
  daily: Daily[];
  pages: { path: string; pageViews: number }[];
  events: { name: string; count: number }[];
  lastReceivedAt: string | null;
  environment?: AnalyticsEnvironment;
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

function validReport(value: unknown, range: Range, filters: EnvironmentFilters): value is Analytics {
  if (!record(value) || !record(value.range) || value.range.from !== range.from || value.range.to !== range.to || value.range.timeZone !== 'UTC' || !record(value.coverage) || !['complete','partial','unavailable'].includes(value.coverage.status as string) || value.coverage.retainedFrom !== null && !stamp(value.coverage.retainedFrom) || !record(value.totals) || ![value.totals.pageViews,value.totals.customEvents].every(nullableCount) || !record(value.measurement) || !['identifiedPageViews','unidentifiedPageViews','visitors','visits'].every(k=>nullableCount((value.measurement as Record<string,unknown>)[k])) || !metric(value.measurement.bounceRate,100) || !metric(value.measurement.averageVisitSeconds) || value.lastReceivedAt !== null && !stamp(value.lastReceivedAt)) return false;
  if (!Array.isArray(value.daily) || value.daily.length > MAX_DAYS || !value.daily.every(day=>record(day) && typeof day.date==='string' && parseDay(day.date)!==null && day.date>=range.from && day.date<=range.to && ['complete','partial','unavailable'].includes(day.coverage as string) && nullableCount(day.pageViews) && nullableCount(day.customEvents)) || !Array.isArray(value.pages) || value.pages.length>20 || !value.pages.every(row=>record(row) && typeof row.path==='string' && row.path.length<=2048 && count(row.pageViews)) || !Array.isArray(value.events) || value.events.length>20 || !value.events.every(row=>record(row) && typeof row.name==='string' && row.name.length<=320 && count(row.count))) return false;
  if (value.coverage.status==='unavailable' && ([value.totals.pageViews,value.totals.customEvents,...['identifiedPageViews','unidentifiedPageViews','visitors','visits','bounceRate','averageVisitSeconds'].map(k=>(value.measurement as Record<string,unknown>)[k])].some(n=>n!==null) || value.pages.length || value.events.length || value.daily.some(day=>day.pageViews!==null || day.customEvents!==null))) return false;
  if(value.collection!==undefined&&(!record(value.collection)||!['consent-first','cookieless'].includes(value.collection.mode as string)||value.collection.captureCoverage!=='unknown'||!record(value.collection.pageViews)||!['cookieless','consent','unknown'].every(k=>nullableCount((value.collection as {pageViews:Record<string,unknown>}).pageViews[k]))))return false;
  return value.environment === undefined ? !Object.keys(filters).length : validEnvironment(value.environment,filters,value.totals.pageViews as number|null,value.measurement.identifiedPageViews as number|null,value.coverage.status==='unavailable');
}

// Same spreadsheet escaping as explorer-input.csvCell, without importing its Node-only parser into the browser.
function csvCell(value: unknown): string {
  let cell=value===null||value===undefined?'Unavailable':typeof value==='object'?JSON.stringify(value):String(value);
  if (/^[\s\uFEFF]*[=+@-]/u.test(cell) || /^[\t\r\n]/.test(cell)) cell=`'${cell}`;
  return `"${cell.replaceAll('"','""')}"`;
}

function EnvironmentCard({data,busy,field,onFieldChange,onFilter}:{data:Analytics;busy:boolean;field:EnvironmentField;onFieldChange:(field:EnvironmentField)=>void;onFilter:(field:EnvironmentField,value:string|null)=>void}) {
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
    <h2 id={`${uid}-heading`}>Environment</h2>{environment&&data.coverage.status!=='unavailable'&&tabs('list')}
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
      <div className="row between analytics-environment-dialog-heading"><h2 id={`${uid}-dialog-heading`}>Environment details</h2><button type="button" className="btn" autoFocus onClick={()=>dialog.current?.close()}>Close details</button></div>
      <p className="hint">{data.range.from} to {data.range.to} (UTC) · {data.coverage.status==='complete'?'Retained date range':`${data.coverage.status} retained date range`}</p>{tabs('details')}
      <div className="analytics-environment-tools"><div><label htmlFor={`${uid}-search`}>Find a category</label><input id={`${uid}-search`} type="search" maxLength={100} value={search} onChange={e=>{setSearch(e.target.value);setNotice('');}}/></div><button type="button" className="btn" disabled={busy||!visible.length} onClick={download}>Download CSV</button></div>
      <p className="hint">Showing {visible.length} of {rows.length} stored categories. CSV uses these same rows and this snapshot.</p>
      <div id={`${uid}-details`} className="table-wrap" tabIndex={0} role="tabpanel" aria-labelledby={`${uid}-details-${field}`}><table><thead><tr><th scope="col">{environmentLabels[field]}</th>{['Estimated visitors','Visits','Recorded pageviews','Pageviews with visitor estimate','Bounce rate','Average observed visit'].map(label=><th scope="col" className="analytics-num" key={label}>{label}</th>)}</tr></thead><tbody>{visible.map(row=><tr key={row.value??'not-recorded'}><th scope="row"><button className="analytics-environment-label" type="button" disabled={busy} onClick={()=>filter(row)} aria-label={`Filter ${environmentLabels[field]}: ${environmentValue(field,row.value)}`}>{environmentValue(field,row.value)}</button></th><td className="analytics-num">{fmtNum(row.visitors)}</td><td className="analytics-num">{fmtNum(row.visits)}</td><td className="analytics-num">{fmtNum(row.pageViews)}</td><td className="analytics-num">{fmtNum(row.identifiedPageViews)}</td><td className="analytics-num">{row.bounceRate===null?'Unavailable':`${row.bounceRate.toFixed(1)}%`}</td><td className="analytics-num">{row.averageVisitSeconds===null?'Unavailable':`${row.averageVisitSeconds.toFixed(1)} s`}</td></tr>)}</tbody></table>{!visible.length&&<p className="dim">No categories match this search. Clear it to see the stored categories.</p>}</div>
      {notice&&<p className="hint" role="status">{notice}</p>}<p className="hint">Scroll the table horizontally to see all metrics. Unknown means classification was attempted; Not recorded means the observation lacks this evidence.</p><p className="hint">Visitor estimates and visits exclude pageviews without an estimate. Estimates may overlap between categories and are not unique people.</p>
    </dialog>
  </section>;
}

function DailyChart({ daily }: { daily: Daily[] }) {
  if (daily.length === 0) return <p className="dim">No daily breakdown available for this range.</p>;
  const max = Math.max(1, ...daily.flatMap((d) => [d.pageViews ?? 0, d.customEvents ?? 0]));
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
        aria-label={`Bar chart of daily page views and custom events in UTC, from ${first} to ${last}. Full numbers in the daily data table below.`}
      >
        {daily.map((d, i) => {
          if (d.coverage === 'unavailable') return <rect key={d.date} x={i * slot + 1} y={10} width={10} height={height} fill="currentColor" opacity={0.12}><title>{d.date}: unavailable after retention</title></rect>;
          const pvH = ((d.pageViews ?? 0) / max) * height;
          const ceH = ((d.customEvents ?? 0) / max) * height;
          const x = i * slot;
          return (
            <g key={d.date}>
              <rect className="analytics-bar-pv" x={x + 1} y={base - pvH} width={4.5} height={pvH}>
                <title>{`${d.date}: ${d.pageViews} page views${d.coverage === 'partial' ? ' (partial day)' : ''}`}</title>
              </rect>
              <rect className="analytics-bar-ce" x={x + 6.5} y={base - ceH} width={4.5} height={ceH}>
                <title>{`${d.date}: ${d.customEvents} custom events${d.coverage === 'partial' ? ' (partial day)' : ''}`}</title>
              </rect>
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
        <span className="analytics-key">
          <span className="analytics-swatch analytics-swatch-pv" aria-hidden="true" /> Page views
        </span>
        <span className="analytics-key">
          <span className="analytics-swatch analytics-swatch-ce" aria-hidden="true" /> Custom events
        </span>
      </p>
      {daily.some(day => day.coverage !== 'complete') && <p className="hint">Shaded days are unavailable after retention. Partial days include only the retained portion; see the daily table.</p>}
    </>
  );
}

export function AnalyticsPanel(props: AnalyticsPanelProps) {
  return <AnalyticsInner key={`${props.userId}:${props.projectId}`} {...props} />;
}
function AnalyticsInner({ projectId, userId, onUnauthorized, search, onNavigate }: AnalyticsPanelProps) {
  const uid = useId();
  const [localIntent,setLocalIntent]=useState<AnalyticsNavigation>({});
  const [environmentField,setEnvironmentField]=useState<EnvironmentField>('browser');
  const intent=search?analyticsNavigation(search):localIntent, queryKey=JSON.stringify(intent);
  const filters:EnvironmentFilters={};
  for(const field of environmentFields){const value=intent[analyticsNavigationNames[field]];if(value!==undefined)filters[field]=value;}
  const filterKey=JSON.stringify(filters), invalid=Boolean(intent.analyticsInvalid);
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
  const nonce = view.nonce;
  useEffect(() => {
    const id = ++reqRef.current;
    const ctrl = new AbortController();
    if(invalid)return ()=>ctrl.abort();
    const params=new URLSearchParams({from,to,...filters});
    api<Analytics>(
      `/api/projects/${encodeURIComponent(projectId)}/analytics?${params}`,
      { signal: ctrl.signal },
    ).then(
      (data) => {
        if (id !== reqRef.current || ctrl.signal.aborted || projectRef.current !== projectId || queryRef.current!==queryKey) return;
        if(!validReport(data,{from,to},filters)){
          setView(v=>v.key===projectId&&v.queryKey===queryKey?{...v,data:null,loading:false,error:'The analytics response did not match the requested range, filters or measurement evidence. Retry to read a fresh snapshot.'}:v);return;
        }
        setView((v) => (v.key === projectId ? { ...v, data, loading: false, error: null, denied: false } : v));
      },
      (err: unknown) => {
        if (id !== reqRef.current || ctrl.signal.aborted || projectRef.current !== projectId || queryRef.current!==queryKey) return;
        if (err instanceof ApiError && err.status === 401) {
          setView(v=>({...v,data:null,loading:false,denied:true}));
          unauthRef.current();
          return;
        }
        setView((v) => (v.key === projectId ? { ...v, data: null, loading: false, error: errMsg(err), denied: err instanceof ApiError && [403,404].includes(err.status) } : v));
      },
    );
    return () => ctrl.abort();
  }, [projectId, from, to, nonce, filterKey, queryKey, invalid]);

  const navigate=(value:AnalyticsNavigation)=>onNavigate?onNavigate(value):setLocalIntent(value);
  const applyRange = (range: Range) => {
    const next={...intent,analyticsFrom:range.from,analyticsTo:range.to};
    if(JSON.stringify(next)===queryKey)setView(v=>({...v,draft:range,draftErr:null,data:null,loading:true,error:null,nonce:v.nonce+1}));
    else navigate(next);
  };
  const applyFilter=(field:EnvironmentField,value:string|null)=>navigate({...intent,analyticsFrom:view.range.from,analyticsTo:view.range.to,[analyticsNavigationNames[field]]:value??'not-recorded'});

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
    if (msg) {
      setView((v) => ({ ...v, draftErr: msg }));
      return;
    }
    applyRange({ from: view.draft.from, to: view.draft.to });
  };

  const busy = !invalid&&(view.loading||view.queryKey!==queryKey);
  const data = invalid||view.queryKey!==queryKey?null:view.data;
  const today = todayUtc();
  const hasData = data !== null && (data.totals.pageViews ?? 0) + (data.totals.customEvents ?? 0) > 0;
  const annotations = useAnnotations({projectId,userId,range:invalid||view.denied?null:{from,to,timeZone:'UTC'},onUnauthorized,onAccessLost:()=>{
    reqRef.current++;
    setView(v=>({...v,data:null,loading:false,denied:true,error:'Project access could not be verified. Retry to check current access.'}));
  }});

  return (
    <div className="analytics" aria-busy={busy}>
      {invalid&&<div className="alert" role="alert"><p>This analytics link has invalid or ambiguous dates or environment filters. Reset the view to choose a valid range.</p><button type="button" className="btn" onClick={()=>navigate({})}>Reset analytics view</button></div>}
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
      </section>
      {!invalid&&Object.keys(filters).length>0&&<section className="card analytics-environment-filters" aria-label="Applied environment filters"><strong>Applied to all analytics</strong><div className="row">{environmentFields.filter(field=>filters[field]!==undefined).map(field=><button type="button" className="btn" key={field} disabled={busy} aria-label={`Remove ${environmentLabels[field]} filter: ${environmentValue(field,filters[field]!)}`} onClick={()=>{const next={...intent};delete next[analyticsNavigationNames[field]];navigate(next);}}>{environmentLabels[field]}: {environmentValue(field,filters[field]!)} <span aria-hidden="true">×</span></button>)}<button type="button" className="btn ghost" disabled={busy} onClick={()=>navigate({...(intent.analyticsFrom?{analyticsFrom:intent.analyticsFrom,analyticsTo:intent.analyticsTo}:{})})}>Clear environment filters</button></div><p className="hint">Overview, daily activity, top pages, custom events and environment use these same required filters.</p></section>}

      {view.error && (
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

      {data && (
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
          <section className="card analytics-activity">
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
          </section>
      {data && (
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

          <EnvironmentCard data={data} busy={busy} field={environmentField} onFieldChange={setEnvironmentField} onFilter={applyFilter}/>
        </>
      )}
    </div>
  );
}
