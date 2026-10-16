import {useEffect, useId, useRef, useState} from 'react';
import {api, ApiError, errMsg} from '../lib/api';
import {AnalyticsResetPanel} from './AnalyticsResetPanel';
import {ProjectDeletePanel} from './ProjectDeletePanel';
import type {ProjectDeleteInput} from '../lib/project-delete';
import type {AnalyticsResetInput} from '../lib/analytics-reset';
import type {GeographyReadiness} from '../lib/analytics-geography';
import {defaultReplaySettings,replaySettings,type ReplaySettings} from '../lib/session-replay';
import {defaultHeatmapSettings,heatmapSettings} from '../lib/replay-heatmaps';

type Role = 'owner' | 'admin' | 'editor' | 'viewer';
type NetworkMode = 'off' | 'direct' | 'proxy';

interface Settings {
  enabled: boolean;
  collectionMode: 'consent-first' | 'cookieless';
  consentMode: 'builtin' | 'external';
  captureReferrer: boolean;
  captureCampaigns: boolean;
  captureScreen: boolean;
  captureGeography?: boolean;
  capturePerformance?: boolean;
  replay?: ReplaySettings;
  heatmap?: ReturnType<typeof heatmapSettings.parse>;
  excludeBots: boolean;
  linkIdentities?: boolean;
  excludedPaths: string[];
}

interface Loaded {
  settings: Settings;
  revision: number;
  role: Role;
  networkMode: NetworkMode;
  geography?: GeographyReadiness;
}

interface Props {
  projectId: string;
  userId: string;
  onUnauthorized: () => void;
  workspaceId?:string;
  onDeleted?:()=>void;
  readOwner?:string;
  readEnabled?:boolean;
  isCurrent?:()=>boolean;
}

const MAX_PATHS = 50;
const MAX_PATH_LEN = 256;

// Blank lines are ignored; meaningful whitespace is kept, never trimmed.
function parsePaths(text: string): string[] {
  const lines = text.split('\n').filter((l) => l.length > 0);
  return Array.from(new Set(lines));
}

function validatePaths(paths: string[]): string[] {
  const errors: string[] = [];
  if (paths.length > MAX_PATHS) {
    errors.push(`Keep at most ${MAX_PATHS} prefixes (currently ${paths.length}). Remove extra lines to save.`);
  }
  paths.forEach((p, i) => {
    const line = `Line ${i + 1}`;
    if (!p.startsWith('/')) {
      errors.push(`${line} must start with /. Spaces are kept, so remove any leading space yourself.`);
    } else if (/[?#]/.test(p)) {
      errors.push(`${line} must not contain a query (?) or fragment (#).`);
    } else if (/[\u0000-\u001f\u007f]/.test(p)) {
      errors.push(`${line} must not contain control characters.`);
    }
    if (p.length > MAX_PATH_LEN) {
      errors.push(`${line} is longer than ${MAX_PATH_LEN} characters. Shorten it to save.`);
    }
  });
  return errors;
}

const bounded = (e: unknown) => errMsg(e).slice(0, 300);
function locationReadiness(value:unknown):GeographyReadiness|undefined{
  if(value===undefined)return undefined;
  const valid=value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
  const db=valid?.database!==null&&typeof valid?.database==='object'&&!Array.isArray(valid.database)?valid.database as Record<string,unknown>:null;
  if(!valid||!db||Object.keys(valid).length!==2||!['ready','disabled','network-off','database-unavailable'].includes(String(valid.status))||(db.status==='ready'?Object.keys(db).length!==4||!Number.isSafeInteger(db.databaseBuild)||Number(db.databaseBuild)<1||Number(db.databaseBuild)>253402300799||typeof db.databaseSha256!=='string'||!/^[a-f0-9]{64}$/.test(db.databaseSha256)||!Number.isSafeInteger(db.bytes)||Number(db.bytes)<1||Number(db.bytes)>256*1024*1024:db.status!=='unavailable'||Object.keys(db).length!==2||!['not-configured','missing','unreadable','too-large','invalid','lookup-failed'].includes(String(db.reason)))||valid.status==='ready'&&db.status!=='ready')throw new Error('Location setup status could not be verified. Reload settings to read a fresh status.');
  return value as GeographyReadiness;
}

const NETWORK_COPY: Record<NetworkMode, string> = {
  off: 'Off: page and event counts remain available, but visitor and visit estimates are unavailable until an operator configures a verified network path. Installing behind a proxy does not verify it on its own.',
  direct: 'Direct: visitor estimates use the Node transport peer.',
  proxy: 'Proxy: visitor estimates use a configured trusted proxy chain.',
};

export function AnalyticsSettingsPanel({projectId,userId,onUnauthorized,workspaceId,onDeleted,readOwner='',readEnabled=true,isCurrent}:Props){
  const identity=JSON.stringify([workspaceId??'',projectId,userId]),owner=JSON.stringify([identity,readOwner]),lease=useRef({owner,identity,enabled:readEnabled,epoch:0}),resetRequest=useRef<AnalyticsResetInput|null>(null),deleteRequest=useRef<ProjectDeleteInput|null>(null);
  if(lease.current.identity!==identity){resetRequest.current=null;deleteRequest.current=null;}
  if(lease.current.owner!==owner||lease.current.enabled!==readEnabled)lease.current={owner,identity,enabled:readEnabled,epoch:lease.current.epoch+1};
  const epoch=lease.current.epoch,current=()=>lease.current.epoch===epoch&&lease.current.owner===owner&&lease.current.enabled&&(isCurrent?.()??true);
  return <PanelInner key={identity} projectId={projectId} userId={userId} onUnauthorized={onUnauthorized} authorityOwner={String(epoch)+':'+owner} isCurrent={current} resetRequest={resetRequest} deleteRequest={deleteRequest} workspaceId={workspaceId} onDeleted={onDeleted}/>;
}

function PanelInner({projectId,userId,onUnauthorized,authorityOwner,isCurrent,resetRequest,deleteRequest,workspaceId,onDeleted}: {projectId:string;userId:string;onUnauthorized:()=>void;authorityOwner:string;isCurrent:()=>boolean;resetRequest:{current:AnalyticsResetInput|null};deleteRequest:{current:ProjectDeleteInput|null};workspaceId?:string;onDeleted?:()=>void}) {
  const uid = useId();
  const [data, setData] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [pathsText, setPathsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [resetBusy,setResetBusy]=useState(false);
  const [resetAccepted,setResetAccepted]=useState<string|null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const genRef = useRef(0);
  const lockRef = useRef(false);
  const readBusyRef = useRef(true);
  const mountedRef = useRef(true);
  const saveCtrlRef = useRef<AbortController | null>(null);
  const unauthorizedRef = useRef(onUnauthorized);
  const verifiedOwner=useRef(authorityOwner);

  unauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveCtrlRef.current?.abort();
    };
  }, []);

  const url = `/api/projects/${encodeURIComponent(projectId)}/analytics-settings`;

  // Initial GET and explicit Reload only; no background polling.
  useEffect(() => {
    if(!isCurrent())return;
    let alive = true;
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    readBusyRef.current = true;
    setLoading(true);
    setError(null);
    setConflict(false);
    setConfirming(false);
    setSavedOk(false);
    api<Loaded>(url, {signal: ctrl.signal})
      .then((d) => {
        if (!alive || ctrl.signal.aborted || gen !== genRef.current || !isCurrent()) return;
        if(d.settings.replay!==undefined)replaySettings.parse(d.settings.replay);
        if(d.settings.heatmap!==undefined)heatmapSettings.parse(d.settings.heatmap);
        verifiedOwner.current=authorityOwner;setData({...d,geography:locationReadiness(d.geography)});
        setDraft(d.settings);
        setPathsText(d.settings.excludedPaths.join('\n'));
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive || gen !== genRef.current || ctrl.signal.aborted || !isCurrent()) return;
        setLoading(false);
        if (e instanceof ApiError) {
          if (e.status === 401) {
            setData(null); setDraft(null);
            unauthorizedRef.current();
            return;
          }
          if (e.status === 403 || e.status === 404) {
            setData(null);
            setDraft(null);
            setHidden(true);
            return;
          }
        }
        setError(bounded(e));
      }).finally(() => { if (alive && gen === genRef.current) readBusyRef.current = false; });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [url, reloadTick,authorityOwner]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (!lockRef.current && !readBusyRef.current) setDraft((d) => (d ? {...d, [key]: value} : d));
  };
  const reload = () => {
    if (lockRef.current || readBusyRef.current) return;
    readBusyRef.current = true; setLoading(true); setReloadTick(t => t + 1);
  };

  const draftPaths = parsePaths(pathsText);
  const pathErrors = validatePaths(draftPaths);
  const replay = draft?.replay ?? defaultReplaySettings;
  let replayError='';
  if(draft?.replay){if(!replaySettings.safeParse(draft.replay).success)replayError='Choose valid replay settings.';else if(replay.blockSelector)try{document.querySelector(replay.blockSelector);}catch{replayError='Enter a valid CSS selector for blocked sections.';}}
  const setReplay=(patch:Partial<ReplaySettings>)=>set('replay',{...replay,...patch});
  const heatmap=draft?.heatmap??defaultHeatmapSettings,heatmapError=draft?.heatmap&&!heatmapSettings.safeParse(draft.heatmap).success?'Choose valid heatmap settings.':'';
  const setHeatmap=(patch:Partial<NonNullable<Settings['heatmap']>>)=>set('heatmap',{...heatmap,...patch});
  const current: Settings | null = draft ? {...draft, excludedPaths: draftPaths} : null;
  // ponytail: JSON.stringify dirty check; swap for a structural compare if settings ever grow nesting.
  const dirty = !!data && !!current && JSON.stringify(current) !== JSON.stringify(data.settings);
  const canEdit = data?.role === 'owner' || data?.role === 'admin';
  const unresolved=resetRequest.current!==null||deleteRequest.current!==null;
  const inputsDisabled = pending || resetBusy || loading || !canEdit || unresolved;
  const canSave = canEdit && dirty && pathErrors.length === 0 && !replayError && !heatmapError && !pending && !resetBusy && !loading && !unresolved;

  const deletion=workspaceId&&onDeleted?<ProjectDeletePanel key={authorityOwner} workspaceId={workspaceId} projectId={projectId} userId={userId} authorityOwner={authorityOwner} isCurrent={isCurrent} pendingRequest={deleteRequest} disabled={pending||loading||dirty||resetBusy||resetRequest.current!==null} onBusy={setResetBusy} onUnauthorized={()=>unauthorizedRef.current()} onDeleted={()=>{if(isCurrent())onDeleted();}}/>:null;
  const cancel = () => {
    if (!data || lockRef.current || readBusyRef.current) return;
    setDraft(data.settings);
    setPathsText(data.settings.excludedPaths.join('\n'));
    setConfirming(false);
    setError(null);
  };

  const save = async () => {
    if (lockRef.current || readBusyRef.current || !canSave || !data || !current || !isCurrent()) return;
    lockRef.current = true; // synchronous mutation lock, held through state application
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    saveCtrlRef.current = ctrl;
    setPending(true);
    setConfirming(false);
    setError(null);
    setConflict(false);
    setSavedOk(false);
    try {
      const res = await api<{settings: Settings; revision: number;geography?:GeographyReadiness}>(url, {
        method: 'POST',
        body: {revision: data.revision, settings: current},
        signal: ctrl.signal,
      });
      if (!mountedRef.current || ctrl.signal.aborted || gen !== genRef.current || !isCurrent()) return;
      if(res.settings.replay!==undefined)replaySettings.parse(res.settings.replay);
      if(res.settings.heatmap!==undefined)heatmapSettings.parse(res.settings.heatmap);
      // Retain the last confirmed role/networkMode; no refetch after save.
      setData({settings: res.settings, revision: res.revision, role: data.role, networkMode: data.networkMode,geography:locationReadiness(res.geography)});
      setDraft(res.settings);
      setPathsText(res.settings.excludedPaths.join('\n'));
      setSavedOk(true);
    } catch (e) {
      if (!mountedRef.current || gen !== genRef.current || ctrl.signal.aborted || !isCurrent()) return;
      if (e instanceof ApiError) {
        if (e.status === 401) {
          setData(null); setDraft(null);
          unauthorizedRef.current();
          return;
        }
        if (e.status === 403 || e.status === 404) {
          setData(null);
          setDraft(null);
          setHidden(true);
          return;
        }
        if (e.status === 409) {
          setConflict(true); // competing edit: typed draft is preserved
          return;
        }
      }
      setError(bounded(e)); // ordinary 400 and others: typed draft is preserved
    } finally {
      if (mountedRef.current && gen === genRef.current) setPending(false);
      lockRef.current = false;
    }
  };

  if(!isCurrent()||verifiedOwner.current!==authorityOwner)return <section className="card"><h2>Collection and privacy</h2><p>Loading current project access…</p>{isCurrent()&&deleteRequest.current&&deletion}</section>;
  if (hidden) {
    return (
      <section className="card">
        <h2>Collection and privacy</h2>
        <p className="dim">Analytics settings are not available for this project.</p>
        {deleteRequest.current&&deletion}
      </section>
    );
  }

  if (!data || !draft || !current) {
    return (
      <section className="card">
        <h2>Collection and privacy</h2>
        {error ? (
          <div className="alert" role="alert">
            <p>{error}</p>
            <p>The settings could not be loaded. Load them again to continue.</p>
            <button type="button" className="btn ghost" disabled={pending || loading} onClick={reload}>
              Reload settings
            </button>
          </div>
        ) : (
          <p className="dim">Loading settings…</p>
        )}
      </section>
    );
  }

  return (
    <section className="card" aria-busy={pending}>
      <h2>Collection and privacy</h2>
      <p className="hint">
        Basic analytics can start without a consent choice. Explicit refusals, Do Not Track and Global Privacy Control stop collection.
      </p>

      {error && (
        <div className="alert" role="alert">
          <p>{error}</p>
          <p>Your current draft is still here. Check the message, then try again.</p>
        </div>
      )}

      {conflict && (
        <div className="alert" role="alert">
          <p>These settings were changed elsewhere, so your draft was not saved. Your edits are still here.</p>
          <p>Reload the saved settings to continue. This replaces your current draft.</p>
          <button
            type="button"
            className="btn ghost"
            disabled={pending || loading}
            onClick={reload}
          >
            Reload saved settings
          </button>
        </div>
      )}

      {savedOk && !dirty && <div className="banner">Settings saved.</div>}

      <div className="field">
        <label className="row" htmlFor={`${uid}-enabled`}>
          <input
            id={`${uid}-enabled`}
            type="checkbox" style={{width: 'auto', flexShrink: 0}}
            checked={draft.enabled}
            disabled={inputsDisabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          Enable native analytics
        </label>
      </div>

      <fieldset className="field" disabled={inputsDisabled}>
        <legend>Analytics collection</legend>
        <label className="row">
          <input type="radio" style={{width:'auto',flexShrink:0}} name={`${uid}-collection`}
            checked={draft.collectionMode==='cookieless'} onChange={()=>set('collectionMode','cookieless')}/>
          Cookieless basic analytics
        </label>
        <p className="hint">Counts pageviews and developer-defined events without a consent grant; no cookies or stored browser identity are used.</p>
        <label className="row">
          <input type="radio" style={{width:'auto',flexShrink:0}} name={`${uid}-collection`}
            checked={draft.collectionMode==='consent-first'} onChange={()=>set('collectionMode','consent-first')}/>
          Consent-first analytics
        </label>
        <p className="hint">Waits for an explicit analytics grant before sending any native pageviews or events.</p>
        <p className="hint">Visitor identification, replay and advertising pixels still require their own consent; this setting does not grant it.</p>
      </fieldset>

      <fieldset className="field" disabled={inputsDisabled}>
        <legend>Consent interface</legend>
        <label className="row">
          <input
            type="radio" style={{width: 'auto', flexShrink: 0}}
            name={`${uid}-consent`}
            checked={draft.consentMode === 'builtin'}
            onChange={() => set('consentMode', 'builtin')}
          />
          Built-in preferences
        </label>
        <p className="hint">Adds a consent preferences button to the monitored website.</p>
        <label className="row">
          <input
            type="radio" style={{width: 'auto', flexShrink: 0}}
            name={`${uid}-consent`}
            checked={draft.consentMode === 'external'}
            onChange={() => set('consentMode', 'external')}
          />
          Existing consent platform
        </label>
        <p className="hint">
          Your integration calls the documented consent API; no consent platform is connected automatically.
        </p>
      </fieldset>

      <fieldset className="field" disabled={inputsDisabled}>
        <legend>Optional metadata</legend>
        <label className="row">
          <input
            type="checkbox" style={{width: 'auto', flexShrink: 0}}
            checked={draft.captureReferrer}
            onChange={(e) => set('captureReferrer', e.target.checked)}
          />
          Referrer hostname
        </label>
        <p className="hint">Stores the referrer hostname only, never the path, query, or fragment.</p>
        <label className="row">
          <input
            type="checkbox" style={{width: 'auto', flexShrink: 0}}
            checked={draft.captureCampaigns}
            onChange={(e) => set('captureCampaigns', e.target.checked)}
          />
          Campaign parameters
        </label>
        <p className="hint">Stores only the UTM parameters source, medium, campaign, term, and content.</p>
        <label className="row">
          <input
            type="checkbox" style={{width: 'auto', flexShrink: 0}}
            checked={draft.captureScreen}
            onChange={(e) => set('captureScreen', e.target.checked)}
          />
          Screen dimensions
        </label>
        <label className="row">
          <input type="checkbox" style={{width:'auto',flexShrink:0}} checked={draft.capturePerformance===true} onChange={e=>set('capturePerformance',e.target.checked)}/>
          Page loading and interaction performance
        </label>
        <p className="hint">Measures loading speed, responsiveness and layout stability while collection is allowed. Browser timings can describe the start of the current page load, before permission was granted. Privacy choices and excluded paths apply. Screen and input contents are not recorded.</p>
        <label className="row">
          <input type="checkbox" style={{width:'auto',flexShrink:0}} checked={draft.captureGeography===true} onChange={e=>set('captureGeography',e.target.checked)}/>
          Approximate country, region and city
        </label>
        <p className="hint">Derives approximate location locally from an accepted connection address. Raw addresses and coordinates are not stored. Existing history is not backfilled, and accepted pageviews remain available when location lookup is unavailable.</p>
        <p className="hint" role="status">Current location setup: {data.geography?.status==='ready'?'Ready for future accepted events.':data.geography?.status==='disabled'?'Disabled for this project.':data.geography?.status==='network-off'?'An operator must configure a verified network path.':data.geography?.status==='database-unavailable'?'An operator must install the optional local DB-IP City Lite database and restart the web service.':'Setup status was not returned. Reload settings to check.'}{data.geography?.database.status==='ready'?` Database build: ${new Date(data.geography.database.databaseBuild*1000).toISOString().slice(0,10)}.`:''} This describes the current setup, not historical lookup coverage.</p>
        <p className="hint">
          Language is included with accepted events. Third-party vendor SDKs have their own data collection behavior,
          which these settings do not change.
        </p>
      </fieldset>

      <fieldset disabled={inputsDisabled} className="stack" aria-describedby={`${uid}-heatmap-help`}>
        <legend>Heatmaps</legend>
        <label className="row"><input type="checkbox" style={{width:'auto',flexShrink:0}} checked={heatmap.enabled} onChange={e=>setHeatmap({enabled:e.target.checked})}/>Enable click and scroll heatmaps after analytics consent</label>
        <p className="hint" id={`${uid}-heatmap-help`}>Heatmaps use analytics permission, independently of session replay. Enabling one never enables the other. Do Not Track, Global Privacy Control, configured bot exclusion and excluded paths apply. Only numeric click and scroll observations are collected, not page text or form values.</p>
        <label htmlFor={`${uid}-heatmap-sample`}>Sample {new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(heatmap.sampleRate*100)}% of eligible documents</label>
        <input id={`${uid}-heatmap-sample`} type="range" min="0" max="100" step="1" value={heatmap.sampleRate*100} onChange={e=>setHeatmap({sampleRate:Number(e.target.value)/100})}/>
        <p className="hint">The decision is made once per document. A sample rate of 0% collects nothing. Each capture ends after its original five-minute limit; later activity needs a new document capture.</p>
        {heatmapError&&<p className="alert" role="alert">{heatmapError}</p>}
      </fieldset>

      <fieldset disabled={inputsDisabled} className="stack" aria-describedby={`${uid}-replay-help`}>
        <legend>Session replay</legend>
        <label className="row"><input type="checkbox" style={{width:'auto',flexShrink:0}} checked={replay.enabled} onChange={e=>setReplay({enabled:e.target.checked})}/>Enable recordings after separate replay consent</label>
        <p className="hint" id={`${uid}-replay-help`}>Basic analytics and analytics consent alone never start a recording. Visitors must also allow replay. Do Not Track, Global Privacy Control and excluded paths apply.</p>
        <label htmlFor={`${uid}-replay-sample`}>Record {new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(replay.sampleRate*100)}% of eligible sessions</label>
        <input id={`${uid}-replay-sample`} type="range" min="0" max="100" step="1" value={replay.sampleRate*100} onChange={e=>setReplay({sampleRate:Number(e.target.value)/100})}/>
        <p className="hint">The sampling decision is made once per recording. A rate of 0% records nothing.</p>
        <label htmlFor={`${uid}-replay-mask`}>Masking</label>
        <select id={`${uid}-replay-mask`} value={replay.maskLevel} onChange={e=>setReplay({maskLevel:e.target.value as ReplaySettings['maskLevel']})}><option value="strict">Strict — mask form values and visible text</option><option value="moderate">Moderate — mask form values, keep visible text</option></select>
        {replay.maskLevel==='moderate'&&<p className="alert">Visible page text can contain personal information. Review blocked sections and excluded pages before enabling this mode.</p>}
        <label htmlFor={`${uid}-replay-duration`}>Maximum recording length</label>
        <select id={`${uid}-replay-duration`} value={replay.maxDurationMs} onChange={e=>setReplay({maxDurationMs:Number(e.target.value) as ReplaySettings['maxDurationMs']})}>{[5,10,15,20].map(minutes=><option key={minutes} value={minutes*60000}>{minutes} minutes</option>)}</select>
        <label htmlFor={`${uid}-replay-block`}>Block additional sections with a CSS selector</label>
        <input id={`${uid}-replay-block`} maxLength={1024} value={replay.blockSelector} placeholder=".private-area, [data-sensitive]" onChange={e=>setReplay({blockSelector:e.target.value})}/>
        {replayError&&<p className="alert" role="alert">{replayError}</p>}
        <p className="hint">Form values are masked in both modes. Some URLs and structural attributes remain; exclude sensitive pages and block private sections. Embedded frames, canvas and media are not recorded. Recordings continue across allowed pages in the same tab until their original time limit.</p>
      </fieldset>

      <div className="field">
        <label className="row" htmlFor={`${uid}-link-identities`}>
          <input id={`${uid}-link-identities`} type="checkbox" style={{width:'auto',flexShrink:0}}
            checked={draft.linkIdentities===true} disabled={inputsDisabled} onChange={e=>set('linkIdentities',e.target.checked)}/>
          Link future identified activity across devices and months
        </label>
        <p className="hint">After fresh analytics consent, matching identifiers supplied by this website can link future activity within this project. Raw identifiers are not stored, and earlier anonymous activity stays separate. Disabling stops new link evidence; retained links remain until retention removes them. This does not verify a customer&apos;s identity.</p>
      </div>

      <div className="field">
        <label className="row" htmlFor={`${uid}-bots`}>
          <input
            id={`${uid}-bots`}
            type="checkbox" style={{width: 'auto', flexShrink: 0}}
            checked={draft.excludeBots}
            disabled={inputsDisabled}
            onChange={(e) => set('excludeBots', e.target.checked)}
          />
          Exclude recognized bots
        </label>
        <p className="hint">Uses a conservative heuristic to filter obvious bots; it is not full bot detection.</p>
      </div>

      <div className="field">
        <label htmlFor={`${uid}-paths`}>Excluded path prefixes</label>
        <textarea
          id={`${uid}-paths`}
          rows={6}
          maxLength={MAX_PATHS * (MAX_PATH_LEN + 1)}
          style={{width: '100%', resize: 'vertical', font: 'inherit'}}
          value={pathsText}
          disabled={inputsDisabled}
          aria-invalid={pathErrors.length > 0}
          aria-describedby={`${uid}-paths-hint`}
          onChange={(e) => { if (!lockRef.current && !readBusyRef.current) setPathsText(e.target.value); }}
        />
        <p className="hint" id={`${uid}-paths-hint`}>
          One prefix per line, starting with / and without a query or fragment. A prefix like /private also excludes
          /private-area, and encoded equivalents are matched. Up to 50 prefixes, 256 characters each. Blank lines are
          ignored. The server performs the final validation.
        </p>
        {pathErrors.length > 0 && (
          <div className="alert" role="alert">
            {pathErrors.map((m) => (
              <p key={m}>{m}</p>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <span className="dim">Visitor estimation</span>
        <p className="hint">{NETWORK_COPY[data.networkMode]}</p>
        <p className="hint">Visitor identifiers are rotating estimates, not unique people.</p>
      </div>

      {!canEdit && <p className="hint">You can view these settings; only owners and admins can change them.</p>}

      {confirming ? (
        <div className="alert">
          <p>
            Saving updates the website&apos;s collection policy. Previous consent grants expire; explicit basic-analytics opt-outs remain.
            {current.collectionMode==='cookieless'?' Basic analytics resumes when the website loads the current policy.':' Native collection waits for a fresh analytics grant.'}
            {' '}Data already sent is not retracted.
          </p>
          <div className="row">
            <button type="button" className="btn primary" disabled={!canSave} onClick={save}>
              Save changes
            </button>
            <button type="button" className="btn ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Keep editing
            </button>
          </div>
        </div>
      ) : (
        <div className="row between">
          <div className="row">
            <button type="button" className="btn primary" disabled={!canSave} onClick={() => setConfirming(true)}>
              Save changes
            </button>
            <button type="button" className="btn ghost" disabled={!dirty || pending || loading} onClick={cancel}>
              Cancel changes
            </button>
          </div>
          <div className="row">
            {dirty && <span className="hint">Unsaved changes</span>}
            <button
              type="button"
              className="btn ghost"
              disabled={pending || loading}
              onClick={reload}
            >
              Reload settings
            </button>
          </div>
        </div>
      )}
      {canEdit&&deletion}
      {resetAccepted===authorityOwner&&<p role="status">Reset accepted. Earlier analytics is unavailable. Any remaining stored-data cleanup continues in bounded background batches.</p>}
      {canEdit&&<AnalyticsResetPanel key={authorityOwner} projectId={projectId} userId={userId} authorityOwner={authorityOwner} isCurrent={isCurrent} pendingRequest={resetRequest} disabled={pending||loading||dirty||resetBusy||deleteRequest.current!==null} onBusy={setResetBusy} onUnauthorized={()=>unauthorizedRef.current()} onReset={()=>{if(isCurrent()){setResetAccepted(authorityOwner);reload();}}}/>}
    </section>
  );
}
