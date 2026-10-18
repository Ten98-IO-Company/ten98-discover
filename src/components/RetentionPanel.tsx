import {Fragment, useCallback, useEffect, useId, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {api, ApiError, errMsg} from '../lib/api';

type Role = 'owner' | 'admin' | 'editor' | 'viewer';
type CategoryKey = 'rawAnalytics' | 'replay' | 'rawProviderEvidence' | 'derivedHistory';
type CategoryMap = Record<CategoryKey, string>;

interface RetentionSettings {
  rawAnalyticsDays: number;
  replayDays: number;
  rawProviderEvidenceDays: number;
  derivedHistoryDays: number;
}

interface RetentionDto {
  workspaceId: string;
  role: Role;
  revision: number;
  settings: RetentionSettings;
  updatedAt: string;
  failedProjects: number;
  lastCompletedAt: string | null;
  categories: CategoryMap;
}

interface PreviewDto {
  revision: number;
  settings: RetentionSettings;
  asOf: string;
  cutoff: string;
  derivedCutoff: string;
  derivedEstimate: { status: 'available' | 'unavailable'; imports: number | null; atLeast: boolean };
  rawEvidenceCutoff:string;
  promptEstimate: { status:'available'|'unavailable';results:number|null;inputs:number|null;atLeast:boolean };
  redirectEstimate?:{status:'available'|'unavailable';checks:number|null;atLeast:boolean};
  keywordEstimate: { status: 'available' | 'unavailable'; results: number | null; atLeast: boolean };
  domainResearchEstimate?: {status:'available'|'unavailable';results:number|null;atLeast:boolean};
  savedKeywordEstimate: { status: 'available' | 'unavailable'; metrics: number | null; atLeast: boolean };
  estimate: {
    status: 'available' | 'unavailable';
    rows: number | null;
    atLeast: boolean;
    logicalBytes: number | null;
  };
  replayEstimate?: {status:'available'|'unavailable';recordings:number|null;chunks:number|null;atLeast:boolean;logicalBytes:number|null};
  profileEstimate?: {status: 'available' | 'unavailable'; properties: number | null; atLeast: boolean};
  identityLinkEstimate?: {status: 'available' | 'unavailable'; links: number | null; atLeast: boolean};
  categories: CategoryMap;
  previewToken: string;
}

interface Props {
  workspaceId: string;
  userId: string;
  onUnauthorized: () => void;
}

type Draft = Record<keyof RetentionSettings, string>;
type Phase = 'loading' | 'ready' | 'unavailable' | 'error';

const NOT_IMPLEMENTED = 'Not implemented yet — policy saved for future storage';
const BTN = {minHeight: 44} as const;

const FIELDS: ReadonlyArray<{
  key: keyof RetentionSettings;
  cat: CategoryKey;
  label: string;
  helper: string;
}> = [
  {key: 'rawAnalyticsDays', cat: 'rawAnalytics', label: 'Raw analytics', helper: 'Days to keep events, performance observations, session properties and explicit identity links. Each property uses its latest update; each link uses its latest accepted evidence (default 90).'},
  {key: 'replayDays', cat: 'replay', label: 'Replay', helper: 'Days to keep recording content and recorded paths (default 7). Expired content becomes unreadable immediately; bounded cleanup removes it afterward.'},
  {key: 'rawProviderEvidenceDays', cat: 'rawProviderEvidence', label: 'Raw provider evidence', helper: 'Days to keep generated answers, copied execution input and observed redirect chains (default 90). Receipts and authored prompts remain.'},
  {key: 'derivedHistoryDays', cat: 'derivedHistory', label: 'Derived history', helper: 'Days to keep Google reports, keyword and domain SEO research results and saved keyword metrics from their original observation (default 365). Authored lists, tags, receipts and charges remain.'},
];

function toDraft(s: RetentionSettings): Draft {
  return {
    rawAnalyticsDays: String(s.rawAnalyticsDays),
    replayDays: String(s.replayDays),
    rawProviderEvidenceDays: String(s.rawProviderEvidenceDays),
    derivedHistoryDays: String(s.derivedHistoryDays),
  };
}

function parseDays(v: string): number | null {
  const t = v.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 3650 ? n : null;
}

function fmtUtc(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toUTCString();
}

function fmtBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function RetentionPanel({workspaceId, userId, onUnauthorized}: Props) {
  const uid = useId();
  const identity = `${workspaceId}:${userId}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [dto, setDto] = useState<RetentionDto | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<PreviewDto | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [conflict, setConflict] = useState(false);

  const genRef = useRef(0);
  const pendingRef = useRef(false);
  const acRef = useRef<AbortController | null>(null);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/retention`;

  const load = useCallback(
    (doneNotice?: string) => {
      const gen = ++genRef.current;
      acRef.current?.abort();
      const ac = new AbortController();
      acRef.current = ac;
      pendingRef.current = false;
      setLoadedIdentity('');
      setDto(null);
      setDraft(null);
      setPreview(null);
      setActionError(null);
      setConflict(false);
      setBusy(null);
      setLoadError(null);
      setPhase('loading');
      setNotice('Loading saved settings…');
      api<RetentionDto>(`/api/workspaces/${encodeURIComponent(workspaceId)}/retention`, {signal: ac.signal})
        .then(d => {
          if (genRef.current !== gen || identityRef.current !== identity || ac.signal.aborted) return;
          setNotice(null);
          if (!d || d.workspaceId !== workspaceId) {
            setPhase('unavailable');
            return;
          }
          setDto(d);
          setLoadedIdentity(identity);
          setDraft(toDraft(d.settings));
          setPhase('ready');
          if (doneNotice) setNotice(doneNotice);
        })
        .catch((e: unknown) => {
          if (genRef.current !== gen || identityRef.current !== identity || ac.signal.aborted) return;
          setNotice(null);
          if (e instanceof ApiError) {
            if (e.status === 401) {
              setPhase('error');
              setLoadError(errMsg(e));
              unauthorizedRef.current();
              return;
            }
            if (e.status === 403 || e.status === 404) {
              setPhase('unavailable');
              return;
            }
          }
          setPhase('error');
          setLoadError(errMsg(e));
        });
    },
    [workspaceId, identity],
  );

  useEffect(() => {
    load();
    return () => {
      genRef.current += 1;
      acRef.current?.abort();
    };
  }, [load, userId]);

  function handleActionError(e: unknown) {
    setNotice(null);
    if (e instanceof ApiError) {
      if (e.status === 401) {
        setDto(null);
        setDraft(null);
        setPreview(null);
        setPhase('error');
        setLoadError(errMsg(e));
        unauthorizedRef.current();
        return;
      }
      if (e.status === 403) {
        setPreview(null);
        load('Current policy reloaded after an access change.');
        return;
      }
      if (e.status === 404) {
        setDto(null);
        setDraft(null);
        setPreview(null);
        setPhase('unavailable');
        return;
      }
      if (e.status === 409) {
        setPreview(null);
        setConflict(true);
        setActionError('The saved settings changed or this preview expired. Your entries are still here — reload the saved settings, then preview again.');
        return;
      }
    }
    setActionError(errMsg(e));
  }

  const validSettings = ((): RetentionSettings | null => {
    if (!draft) return null;
    const out = {} as RetentionSettings;
    for (const f of FIELDS) {
      const n = parseDays(draft[f.key]);
      if (n === null) return null;
      out[f.key] = n;
    }
    return out;
  })();

  async function onPreview() {
    if (!dto || dto.role !== 'owner' || !validSettings || busy || pendingRef.current || conflict || phase !== 'ready' || loadedIdentity !== identity) return;
    const gen = genRef.current;
    pendingRef.current = true;
    setBusy('preview');
    setActionError(null);
    setNotice('Checking what would be deleted…');
    try {
      const p = await api<PreviewDto>(`${base}/preview`, {
        method: 'POST',
        body: {revision: dto.revision, settings: validSettings},
        signal: acRef.current?.signal ?? undefined,
      });
      if (genRef.current !== gen || identityRef.current !== identity) return;
      setPreview(p);
      setConflict(false);
      setNotice('Preview ready — review it below, then save or cancel.');
    } catch (e) {
      if (genRef.current !== gen || identityRef.current !== identity) return;
      handleActionError(e);
    } finally {
      if (genRef.current === gen && identityRef.current === identity) { pendingRef.current = false; setBusy(null); }
    }
  }

  async function onSave() {
    if (!preview || dto?.role !== 'owner' || busy || pendingRef.current || phase !== 'ready' || loadedIdentity !== identity) return;
    const gen = genRef.current;
    pendingRef.current = true;
    setBusy('save');
    setActionError(null);
    setNotice('Saving retention settings…');
    try {
      const d = await api<RetentionDto>(`${base}/save`, {
        method: 'POST',
        body: {previewToken: preview.previewToken},
        signal: acRef.current?.signal ?? undefined,
      });
      if (genRef.current !== gen || identityRef.current !== identity) return;
      if (!d || d.workspaceId !== workspaceId) {
        setDto(null); setDraft(null); setPreview(null); setNotice(null); setPhase('unavailable');
        return;
      }
      setDto(d);
      setDraft(toDraft(d.settings));
      setPreview(null);
      setConflict(false);
      setNotice('Retention settings saved.');
    } catch (e) {
      if (genRef.current !== gen || identityRef.current !== identity) return;
      handleActionError(e);
    } finally {
      if (genRef.current === gen && identityRef.current === identity) { pendingRef.current = false; setBusy(null); }
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void onPreview();
  }

  const isOwner = dto?.role === 'owner';

  return (
    <section className="card" aria-labelledby="retention-title">
      <div className="row between" style={{flexWrap: 'wrap', gap: 8}}>
        <h2 id="retention-title" style={{margin: 0}}>Retention</h2>
        <button
          type="button"
          className="btn"
          style={BTN}
          onClick={() => load()}
          disabled={busy !== null || phase === 'loading'}
        >
          Reload saved settings
        </button>
      </div>
      <p className="dim">How many days each category is kept. Cleanup deletes older data automatically.</p>

      <p className="hint" aria-live="polite">{notice ?? ''}</p>

      {actionError && (
        <div className="alert err-text" role="alert">
          <p style={{margin: 0}}>{actionError}</p>
        </div>
      )}

      {phase === 'loading' && <p className="dim">Loading…</p>}

      {phase === 'unavailable' && (
        <div className="alert" role="alert">Retention settings aren’t available for this workspace.</div>
      )}

      {phase === 'error' && (
        <div className="alert err-text" role="alert">
          <p style={{margin: 0}}>{loadError ?? 'Could not load the retention settings.'}</p>
          <button type="button" className="btn" style={{...BTN, marginTop: 8}} onClick={() => load()}>
            Retry
          </button>
        </div>
      )}

      {phase === 'ready' && dto && draft && loadedIdentity === identity && (
        <Fragment>
          {!isOwner && (
            <div>
              <p className="hint">Only a workspace owner can change retention.</p>
              {FIELDS.map(f => (
                <div key={f.key} style={{marginBottom: 12}}>
                  <div className="row between" style={{flexWrap: 'wrap', gap: 8}}>
                    <span>{f.label}</span>
                    <span>{dto.settings[f.key]} days</span>
                  </div>
                  <p className="hint" style={{margin: '4px 0 0'}}>{f.helper}</p>
                  {dto.categories[f.cat] !== 'active' && (
                    <p className="dim" style={{margin: '4px 0 0'}}>{NOT_IMPLEMENTED}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {isOwner && (
            <form onSubmit={onSubmit}>
              <p className="hint">Whole days from 1 to 3650. Nothing is saved until you preview and confirm.</p>
              {FIELDS.map(f => {
                const invalid = parseDays(draft[f.key]) === null;
                const ni = dto.categories[f.cat] !== 'active';
                const ids = [`${uid}-${f.key}-help`];
                if (ni) ids.push(`${uid}-${f.key}-ni`);
                if (invalid) ids.push(`${uid}-${f.key}-err`);
                return (
                  <div key={f.key} style={{marginBottom: 12}}>
                    <label htmlFor={`${uid}-${f.key}`}>{f.label} (days)</label>
                    <input
                      id={`${uid}-${f.key}`}
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={draft[f.key]}
                      disabled={busy !== null}
                      aria-invalid={invalid || undefined}
                      aria-describedby={ids.join(' ')}
                      onChange={e => {
                        const v = e.target.value;
                        setDraft(d => (d ? {...d, [f.key]: v} : d));
                        setPreview(null);
                        setNotice(null);
                        if (!conflict) setActionError(null);
                      }}
                      style={{display: 'block', width: '100%', minHeight: 44, boxSizing: 'border-box'}}
                    />
                    <p id={`${uid}-${f.key}-help`} className="hint" style={{margin: '4px 0 0'}}>{f.helper}</p>
                    {ni && (
                      <p id={`${uid}-${f.key}-ni`} className="dim" style={{margin: '4px 0 0'}}>{NOT_IMPLEMENTED}</p>
                    )}
                    {invalid && (
                      <p id={`${uid}-${f.key}-err`} className="err-text" style={{margin: '4px 0 0'}}>
                        Enter a whole number from 1 to 3650.
                      </p>
                    )}
                  </div>
                );
              })}
              <button type="submit" className="btn primary" style={BTN} disabled={busy !== null || !validSettings || conflict}>
                {busy === 'preview' ? 'Checking…' : 'Preview cleanup'}
              </button>
            </form>
          )}

          {isOwner && preview && (
            <div className="card" style={{marginTop: 16}} aria-labelledby="retention-review-title">
              <h3 id="retention-review-title" style={{marginTop: 0}}>Review cleanup</h3>
              <ul style={{paddingLeft: 20, margin: '8px 0'}}>
                {FIELDS.map(f => (
                  <li key={f.key}>{f.label}: {preview.settings[f.key]} days</li>
                ))}
              </ul>
              <h4>Analytics and identities</h4>
              <p style={{margin: '8px 0'}}>
                Cutoff (UTC): {fmtUtc(preview.cutoff)}
                <br />
                <span className="hint">Raw analytics older than this time are eligible for deletion.</span>
              </p>
              <p style={{margin: '8px 0'}}>Preview as of (UTC): {fmtUtc(preview.asOf)}</p>
              {preview.estimate.status === 'available' && preview.estimate.rows !== null ? (
                <p style={{margin: '8px 0'}}>
                  Eligible rows: {preview.estimate.atLeast ? 'At least ' : ''}
                  {preview.estimate.rows.toLocaleString()}
                </p>
              ) : (
                <p style={{margin: '8px 0'}}>Estimate unavailable</p>
              )}
              {preview.estimate.status === 'available' && preview.estimate.logicalBytes !== null && (
                <p className="hint" style={{margin: '8px 0'}}>
                  About {fmtBytes(preview.estimate.logicalBytes)} in sampled raw analytics row bytes — an approximation, not guaranteed disk savings.
                </p>
              )}
              <p style={{margin: '8px 0'}}>{preview.profileEstimate?.status === 'available' && preview.profileEstimate.properties !== null
                ? `${preview.profileEstimate.atLeast ? 'At least ' : ''}${preview.profileEstimate.properties.toLocaleString()} session ${preview.profileEstimate.properties === 1 ? 'property' : 'properties'} eligible for cleanup.`
                : 'Session-property estimate unavailable. Try previewing again; retention still applies.'}</p>
              <p className="hint" style={{margin: '8px 0'}}>Saving a shorter session-property retention period immediately hides expired values; increasing it later does not restore them.</p>
              <p style={{margin:'8px 0'}}>{preview.identityLinkEstimate?.status==='available'&&preview.identityLinkEstimate.links!==null
                ? `${preview.identityLinkEstimate.atLeast?'At least ':''}${preview.identityLinkEstimate.links.toLocaleString()} explicit identity links eligible for cleanup.`
                : 'Identity link estimate unavailable.'} Shortening retention hides expired link evidence immediately; extending it does not restore that evidence.</p>
              <h4>Session replay</h4>
              <p style={{margin:'8px 0'}}>{preview.replayEstimate?.status==='available'&&preview.replayEstimate.recordings!==null&&preview.replayEstimate.chunks!==null?`${preview.replayEstimate.atLeast?'At least ':''}${preview.replayEstimate.recordings.toLocaleString()} recording records or expired request tombstones and ${preview.replayEstimate.chunks.toLocaleString()} stored replay chunks eligible for cleanup.`:'Replay estimate unavailable. Recording content still follows the replay retention period.'}{preview.replayEstimate?.status==='available'&&preview.replayEstimate.logicalBytes!==null?` About ${fmtBytes(preview.replayEstimate.logicalBytes)} in sampled logical row bytes, not guaranteed disk savings.`:''}</p>
              <h4>Imported reports and research</h4>
              <p style={{margin: '8px 0'}}>Derived data cutoff (UTC): {fmtUtc(preview.derivedCutoff)}. {preview.derivedEstimate.status === 'available' && preview.derivedEstimate.imports !== null ? `${preview.derivedEstimate.atLeast ? 'At least ' : ''}${preview.derivedEstimate.imports.toLocaleString()} finished Google imports eligible.` : 'Import estimate unavailable.'}</p>
              <p style={{margin: '8px 0'}}>{preview.keywordEstimate.status === 'available' && preview.keywordEstimate.results !== null ? `${preview.keywordEstimate.atLeast ? 'At least ' : ''}${preview.keywordEstimate.results.toLocaleString()} keyword results eligible.` : 'Keyword result estimate unavailable.'}</p>
              <p style={{margin: '8px 0'}}>{preview.domainResearchEstimate?.status==='available'&&preview.domainResearchEstimate.results!==null?`${preview.domainResearchEstimate.atLeast?'At least ':''}${preview.domainResearchEstimate.results.toLocaleString()} domain SEO reports eligible. Their used quotes and charges remain.`:'Domain SEO report estimate unavailable. Reports still follow derived history retention.'}</p>
              <p style={{margin: '8px 0'}}>{preview.savedKeywordEstimate.status === 'available' && preview.savedKeywordEstimate.metrics !== null ? `${preview.savedKeywordEstimate.atLeast ? 'At least ' : ''}${preview.savedKeywordEstimate.metrics.toLocaleString()} saved keyword metric snapshots eligible. Authored keywords and tags remain.` : 'Saved keyword metric estimate unavailable. Authored keywords and tags remain.'}</p>
              <h4>AI answers and other evidence</h4>
              <p style={{margin:'8px 0'}}>Raw provider evidence cutoff (UTC): {fmtUtc(preview.rawEvidenceCutoff)}</p>
              <p style={{margin:'8px 0'}}>{preview.promptEstimate.status==='available'&&preview.promptEstimate.results!==null?`${preview.promptEstimate.atLeast?'At least ':''}${preview.promptEstimate.results.toLocaleString()} generated prompt answers and ${preview.promptEstimate.inputs?.toLocaleString() ?? "unknown"} copied execution inputs eligible under raw provider evidence retention.`:'Prompt answer estimate unavailable.'}</p>
              <p style={{margin:'8px 0'}}>{preview.redirectEstimate?.status==='available'&&preview.redirectEstimate.checks!==null?`${preview.redirectEstimate.atLeast?'At least ':''}${preview.redirectEstimate.checks.toLocaleString()} redirect observations eligible. Their check receipts remain.`:'Redirect observation estimate unavailable.'}</p>
              <details><summary>What stays and how expiry works</summary>
              <p className="hint" style={{margin: '8px 0'}}>Google report rows, Google quality metadata, keyword results and saved keyword metrics expire after the derived-history period. Saving or refreshing a list does not extend an older observation's expiry. Authored keywords, tags and prompt versions remain. Generated prompt answers and copied execution input follow raw provider evidence retention. Outcomes, recorded counts, used quote metadata and charge evidence remain as receipts. Active imports are preserved. Expired replay paths and content are hidden immediately and purged in bounded passes. Safe request tombstones keep retries from recreating expired recordings until derived-history retention removes them; they contain no recorded path or events.</p>
              <p className="hint" style={{margin: '8px 0'}}>
                Kept as-is: authored reports, templates, shared snapshots, account data, credentials, configuration and all spending ledger records. Deleting live data does not erase operator backups.
              </p>
              </details>
              <div className="alert" style={{margin: '8px 0'}}>
                Older analytics, finished Google reports, keyword results, saved keyword metrics, generated prompt answers and copied execution input will be deleted automatically. Authored keyword lists and tags remain. Increasing these periods later cannot restore deleted data.
              </div>
              <div className="row" style={{flexWrap: 'wrap', gap: 8}}>
                <button type="button" className="btn primary" style={BTN} onClick={() => void onSave()} disabled={busy !== null}>
                  {busy === 'save' ? 'Saving…' : 'Save retention'}
                </button>
                <button
                  type="button"
                  className="btn"
                  style={BTN}
                  disabled={busy !== null}
                  onClick={() => {
                    setPreview(null);
                    setNotice('Preview canceled — nothing was saved.');
                  }}
                >
                  Cancel preview
                </button>
              </div>
            </div>
          )}

          <div style={{marginTop: 16}}>
            <h3 style={{margin: '0 0 8px'}}>Cleanup status</h3>
            <p style={{margin: '4px 0'}}>
              <span className="dim">Latest completed project cleanup: </span>
              {dto.lastCompletedAt ? fmtUtc(dto.lastCompletedAt) : 'No cleanup completed yet'}
            </p>
            <p className="hint" style={{margin: '4px 0'}}>The latest finish of one project — not proof every project is caught up.</p>
            {dto.failedProjects > 0 && (
              <p className="alert" style={{margin: '8px 0'}}>
                The last cleanup failed for {dto.failedProjects} {dto.failedProjects === 1 ? 'project' : 'projects'}.
              </p>
            )}
          </div>
        </Fragment>
      )}
    </section>
  );
}
