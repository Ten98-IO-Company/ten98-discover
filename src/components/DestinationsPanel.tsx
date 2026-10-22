import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useConfirmDialog } from '@ten98/ui'
import { api, ApiError, errMsg } from '../lib/api';
import {useBlocker} from '@tanstack/react-router';
import {z} from 'zod';
import type { Environment, Provider, CanonicalEvent, Destination, Configuration, Consent } from '../server/destinations';

interface CatalogEvent {
  event: CanonicalEvent;
  target: string | null;
  targetRequired: boolean;
  targetLabel?: string;
}
interface CatalogEntry {
  provider: Provider;
  label: string;
  assetLabel: string;
  assetPattern: string;
  events: CatalogEvent[];
  purposes: string[];
  notes: string;
}
interface HistoryEntry {
  id: string;
  number: number;
  createdAt: string;
  rollbackOf: string | null;
}
interface ManagementDTO {
  project: { id: string; origin: string };
  environment: Environment;
  draftVersion: number;
  draft: Configuration;
  active: {
    id: string;
    number: number;
    consentEpoch: string;
    configuration: Configuration;
    createdAt: string;
  } | null;
  history: HistoryEntry[];
  catalog: CatalogEntry[];
}
type RouteStatus = 'disabled' | 'external' | 'consent_blocked' | 'unsupported' | 'would_invoke';
interface PreviewRoute {
  provider: Provider;
  assetId: string;
  target: string | null;
  status: RouteStatus;
  reason: string;
  fields: string[];
}
interface PreviewResult {
  dryRun: boolean;
  event: string;
  routes: PreviewRoute[];
}

const EVENTS: CanonicalEvent[] = [
  'page_view',
  'sign_up',
  'generate_lead',
  'view_item',
  'add_to_cart',
  'begin_checkout',
  'purchase',
  'refund',
];

const providerSchema = z.enum(['meta', 'ga4', 'google_ads', 'cloudflare', 'tiktok', 'linkedin', 'microsoft_ads', 'pinterest', 'snapchat', 'x']);
const eventSchema = z.enum(EVENTS);
const unique = (values: string[]) => new Set(values).size === values.length;
const configurationSchema = z.object({destinations: z.array(z.object({
  provider: providerSchema, assetId: z.string().min(1).max(64), enabled: z.boolean(), owner: z.enum(['managed', 'external']), ownershipConfirmed: z.boolean(),
  mappings: z.array(z.object({event: eventSchema, target: z.string().min(1).max(128).optional()}).strict()).max(8).refine(values => unique(values.map(value => value.event))),
}).strict()).max(10).refine(values => unique(values.map(value => value.provider)))}).strict();
const timestampSchema = z.iso.datetime();
const managementSchema = z.object({
  project: z.object({id: z.uuid(), origin: z.url()}), environment: z.enum(['live', 'test']), draftVersion: z.number().int().nonnegative(), draft: configurationSchema,
  active: z.object({id: z.uuid(), number: z.number().int().positive(), consentEpoch: z.uuid(), configuration: configurationSchema, createdAt: timestampSchema}).nullable(),
  history: z.array(z.object({id: z.uuid(), number: z.number().int().positive(), createdAt: timestampSchema, rollbackOf: z.uuid().nullable()})).max(20).refine(values => unique(values.map(value => value.id))),
  catalog: z.array(z.object({provider: providerSchema, label: z.string(), assetLabel: z.string(), assetPattern: z.string(), notes: z.string(),
    events: z.array(z.object({event: eventSchema, target: z.string().nullable(), targetRequired: z.boolean(), targetLabel: z.string().optional()})).max(8).refine(values => unique(values.map(value => value.event))),
    purposes: z.array(z.enum(['analytics', 'advertising', 'adUserData', 'adPersonalization'])).max(4),
  })).max(10).refine(values => unique(values.map(value => value.provider))),
});
const previewSchema = z.object({dryRun: z.literal(true), event: eventSchema, routes: z.array(z.object({
  provider: providerSchema, assetId: z.string().min(1).max(64), target: z.string().nullable(), status: z.enum(['disabled', 'external', 'consent_blocked', 'unsupported', 'would_invoke']), reason: z.string(), fields: z.array(z.string()),
})).max(10).refine(values => unique(values.map(value => value.provider)))});

const CONSENT_FIELDS = [
  ['analytics', 'Analytics'],
  ['advertising', 'Advertising'],
  ['adUserData', 'Ad user data'],
  ['adPersonalization', 'Ad personalization'],
] as const;

const SNIPPET = `<button type="button" id="tracking-preferences" disabled>Tracking preferences</button>
<script>
  const site = { siteKey: 'your-public-site-key', environment: 'live' };
  const button = document.getElementById('tracking-preferences');
  function updateButton() {
    button.disabled = !window.ten98?.destinationStatus?.(site).ready;
  }
  button.addEventListener('click', () => window.ten98.consentPreferences(site));
  window.addEventListener('ten98:destinations-ready', updateButton);
  updateButton();
</script>`;

const checkboxStyle = { width: 'auto' } as const;

export function DestinationsPanel({
  projectId,
  userId,
  onUnauthorized,
}: {
  projectId: string;
  userId: string;
  onUnauthorized: () => void;
}) {
  const [environment, setEnvironment] = useState<Environment>('live');
  const confirmEnvironmentChange = useRef(() => true);
  return (
    <section aria-label="Destination management">
      <div className="card">
        <div className="row between">
          <div style={{ maxWidth: '46rem' }}>
            <h2>Destinations</h2>
            <p className="dim">
              Route website events to the providers you configure here through your existing ten98 snippet.
              Choose Live or Test. Test destinations still contact real providers after consent; use
              dedicated test asset IDs. The dry-run preview sends no provider traffic.
            </p>
          </div>
          <div className="field" style={{ minWidth: '9rem' }}>
            <label htmlFor="destinations-environment">Environment</label>
            <select
              id="destinations-environment"
              value={environment}
              onChange={(e) => { if (e.target.value !== environment && confirmEnvironmentChange.current()) setEnvironment(e.target.value as Environment); }}
            >
              <option value="live">Live</option>
              <option value="test">Test</option>
            </select>
          </div>
        </div>
      </div>
      <DestinationsInner
        key={`${projectId}:${userId}:${environment}`}
        projectId={projectId}
        environment={environment}
        confirmEnvironmentChange={confirmEnvironmentChange}
        onUnauthorized={onUnauthorized}
      />
    </section>
  );
}

function DestinationsInner({
  projectId,
  environment,
  confirmEnvironmentChange,
  onUnauthorized,
}: {
  projectId: string;
  environment: Environment;
  confirmEnvironmentChange: {current: () => boolean};
  onUnauthorized: () => void;
}) {
  const [mgmt, setMgmt] = useState<ManagementDTO | null>(null);
  const [confirm, confirmDialog] = useConfirmDialog({ danger: true });
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingWrite, setPendingWrite] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const denied = useRef(false);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [addChoice, setAddChoice] = useState('');

  const [pEvent, setPEvent] = useState<CanonicalEvent>('page_view');
  const [pValue, setPValue] = useState('');
  const [pCurrency, setPCurrency] = useState('');
  const [pTxn, setPTxn] = useState('');
  const [pItem, setPItem] = useState('');
  const [consent, setConsent] = useState<Consent>({
    analytics: false,
    advertising: false,
    adUserData: false,
    adPersonalization: false,
  });
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [dryRunVersion, setDryRunVersion] = useState<number | null>(null);
  const [ack, setAck] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const opRef = useRef(0);
  const busyRef = useRef(false);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  const busy = loading || mutating || pendingWrite || conflicted;
  const hasChanges = () => !denied.current && !!mgmt && !!draft && (dirty || pendingWrite || conflicted);
  const confirmNavigation = () => !hasChanges() || window.confirm(pendingWrite
    ? 'This change may already be saved. Leave without checking the saved settings? No retry will be sent.'
    : 'Discard unsaved destination changes? Your edits have not been saved.');
  confirmEnvironmentChange.current = confirmNavigation;
  useBlocker({shouldBlockFn: () => !confirmNavigation(), enableBeforeUnload: hasChanges});

  const url = (suffix: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/destinations${suffix}?environment=${environment}`;

  const applyMgmt = (value: unknown, expectedVersion?: number) => {
    const parsed = managementSchema.safeParse(value);
    if (!parsed.success || parsed.data.project.id !== projectId || parsed.data.environment !== environment ||
        expectedVersion !== undefined && parsed.data.draftVersion !== expectedVersion + 1 ||
        parsed.data.draft.destinations.some(destination => !parsed.data.catalog.some(entry => entry.provider === destination.provider))) {
      throw new Error('The saved settings response could not be verified. Your local edits are kept. Reload saved settings before making another change.');
    }
    const m: ManagementDTO = parsed.data, nextDraft = structuredClone(m.draft);
    denied.current = false;
    setPendingWrite(false);
    setConflicted(false);
    setMgmt(m);
    setDraft(nextDraft);
    setDirty(false);
    setPreview(null);
    setDryRunVersion(null);
    setAck(false);
    setAddChoice('');
  };

  const showError = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.status === 401) {
        denied.current = true;
        unauthorizedRef.current();
        return;
      }
      if (e.status === 403 || e.status === 404) {
        denied.current = true;
        setPendingWrite(false);
        setConflicted(false);
        setGone(true);
        setMgmt(null);
        setDraft(null);
        setPreview(null);
        setDirty(false);
        setError(null);
        return;
      }
    }
    if (e instanceof ApiError && e.status === 409) {
      setConflicted(true); setPreview(null); setDryRunVersion(null); setAck(false);
      setError('Settings changed in another tab. Your edits are kept. Reload saved settings before saving or publishing.');
      return;
    }
    setError(errMsg(e));
  };

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const op = ++opRef.current;
    setLoading(true);
    try {
      const m = await api<unknown>(
        `/api/projects/${encodeURIComponent(projectId)}/destinations?environment=${environment}`,
        { signal: ac.signal },
      );
      if (ac.signal.aborted || op !== opRef.current) return;
      applyMgmt(m);
      setGone(false);
      setError(null);
    } catch (e) {
      if (ac.signal.aborted || op !== opRef.current) return;
      showError(e);
    } finally {
      if (!ac.signal.aborted && op === opRef.current) {
        setLoading(false);
        setMutating(false);
        busyRef.current = false;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyMgmt/showError only use stable setters and refs
  }, [projectId, environment]);

  useEffect(() => {
    void refresh();
    return () => {
      opRef.current++;
      abortRef.current?.abort();
    };
  }, [refresh]);

  const editDraft = (fn: (d: Configuration) => void) => {
    if (busyRef.current || loading || pendingWrite || conflicted) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
    setPreview(null);
    setDryRunVersion(null);
    setAck(false);
  };

  const runMutation = async (suffix: string, body: unknown) => {
    if (busyRef.current || loading || pendingWrite || conflicted || !mgmt) return;
    busyRef.current = true;
    setPendingWrite(true);
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    const op = ++opRef.current;
    setMutating(true);
    setError(null);
    try {
      const result = await api<unknown>(url(suffix), { method: 'POST', body, signal: ac.signal });
      if (ac.signal.aborted || op !== opRef.current) return;
      applyMgmt(result, mgmt.draftVersion);
    } catch (e) {
      if (ac.signal.aborted || op !== opRef.current) return;
      if (e instanceof ApiError && [400, 401, 403, 404, 409, 413, 429].includes(e.status)) setPendingWrite(false);
      showError(e);
    } finally {
      if (!ac.signal.aborted && op === opRef.current) {
        busyRef.current = false;
        setMutating(false);
      }
    }
  };

  const saveDraft = () => {
    if (!mgmt || !draft) return;
    void runMutation('/draft', { expectedVersion: mgmt.draftVersion, configuration: draft });
  };

  const publish = async () => {
    if (!mgmt) return;
    const target = environment === 'live' ? 'Live' : 'Test';
    if (
      !await confirm({
        title: `Publish this draft to ${target}?`,
        description: 'A new revision with a fresh consent epoch is created — every visitor must grant consent again before any vendor tag runs.',
        confirmLabel: `Publish to ${target}`,
        danger: false,
      })
    )
      return;
    if (busyRef.current) return;
    void runMutation('/publish', { expectedVersion: mgmt.draftVersion });
  };

  const rollback = async (h: HistoryEntry) => {
    if (!mgmt) return;
    if (
      !await confirm({
        title: `Roll back to revision v${h.number}?`,
        description: 'A new revision with a fresh consent epoch is created and the current draft is replaced.',
        confirmLabel: 'Roll back',
      })
    )
      return;
    if (busyRef.current) return;
    void runMutation('/rollback', { expectedVersion: mgmt.draftVersion, revisionId: h.id });
  };

  const runPreview = async (e: FormEvent) => {
    e.preventDefault();
    if (busyRef.current || loading || dirty || pendingWrite || conflicted || !mgmt) return;
    busyRef.current = true;
    setPreview(null); setDryRunVersion(null); setAck(false);
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    const op = ++opRef.current;
    setMutating(true);
    setError(null);
    try {
      const properties: Record<string, string> = {};
      if (pValue.trim()) properties.value = pValue.trim();
      if (pCurrency.trim()) properties.currency = pCurrency.trim().toUpperCase();
      if (pTxn.trim()) properties.transactionId = pTxn.trim();
      if (pItem.trim()) properties.itemId = pItem.trim();
      const value = await api<unknown>(url('/preview'), {
        method: 'POST',
        signal: ac.signal,
        body: {
          expectedVersion: mgmt.draftVersion,
          event: { name: pEvent, ...(Object.keys(properties).length > 0 ? { properties } : {}) },
          consent,
        },
      });
      if (ac.signal.aborted || op !== opRef.current) return;
      const parsed = previewSchema.safeParse(value);
      if (!parsed.success || parsed.data.event !== pEvent || parsed.data.routes.length !== mgmt.draft.destinations.length ||
          parsed.data.routes.some(route => !mgmt.draft.destinations.some(destination => destination.provider === route.provider && destination.assetId === route.assetId))) {
        throw new Error('The dry-run response could not be verified. Run the preview again before publishing.');
      }
      setPreview(parsed.data);
      setDryRunVersion(mgmt.draftVersion);
    } catch (err) {
      if (ac.signal.aborted || op !== opRef.current) return;
      showError(err);
    } finally {
      if (!ac.signal.aborted && op === opRef.current) {
        busyRef.current = false;
        setMutating(false);
      }
    }
  };

  const catalogOf = (p: Provider) => mgmt?.catalog.find((c) => c.provider === p);

  const addDestination = () => {
    const p = addChoice as Provider;
    if (!p) return;
    editDraft((d) => {
      if (d.destinations.length >= 10 || d.destinations.some((x) => x.provider === p)) return;
      d.destinations.push({
        provider: p,
        assetId: '',
        enabled: false,
        owner: 'managed',
        ownershipConfirmed: false,
        mappings: [],
      });
    });
    setAddChoice('');
  };

  const removeDestination = (p: Provider) =>
    editDraft((d) => {
      d.destinations = d.destinations.filter((x) => x.provider !== p);
    });

  const editDestination = (p: Provider, fn: (dest: Destination) => void) =>
    editDraft((d) => {
      const dest = d.destinations.find((x) => x.provider === p);
      if (dest) fn(dest);
    });

  const toggleMapping = (p: Provider, ce: CatalogEvent, on: boolean) =>
    editDestination(p, (dest) => {
      if (on) {
        if (dest.mappings.length < 8 && !dest.mappings.some((m) => m.event === ce.event)) {
          dest.mappings.push(ce.targetRequired ? { event: ce.event, target: '' } : { event: ce.event });
        }
      } else {
        dest.mappings = dest.mappings.filter((m) => m.event !== ce.event);
      }
    });

  const setMappingTarget = (p: Provider, evName: CanonicalEvent, target: string) =>
    editDestination(p, (dest) => {
      const m = dest.mappings.find((x) => x.event === evName);
      if (m) m.target = target;
    });

  if (gone) {
    return (
      <div className="card">
        <p className="empty">This project or environment is not available to your account.</p>
        <button type="button" className="btn primary" onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  }

  if (!mgmt || !draft) {
    return (
      <div className="card">
        {error ? (
          <>
            <div className="banner alert" role="alert">
              {error}
            </div>
            <button type="button" className="btn ghost" onClick={() => void refresh()}>
              Try again
            </button>
          </>
        ) : (
          <p className="dim" role="status" aria-live="polite">
            Loading destinations…
          </p>
        )}
      </div>
    );
  }

  const available = mgmt.catalog.filter((c) => !draft.destinations.some((d) => d.provider === c.provider));
  const enabledDests = draft.destinations.filter((d) => d.enabled);
  const unconfirmed = enabledDests.filter((d) => d.owner === 'managed' && !d.ownershipConfirmed);
  const managedCount = enabledDests.filter((d) => d.owner === 'managed').length;
  const purposes = Array.from(new Set(enabledDests.flatMap((d) => catalogOf(d.provider)?.purposes ?? [])));
  const ga4Owner = enabledDests.find((d) => d.provider === 'ga4')?.owner;
  const adsOwner = enabledDests.find((d) => d.provider === 'google_ads')?.owner;
  const googleMix = !!ga4Owner && !!adsOwner && ga4Owner !== adsOwner;
  const canPublish =
    !dirty && !busy && !googleMix && unconfirmed.length === 0 && dryRunVersion === mgmt.draftVersion && ack;

  const statusPill = (s: RouteStatus) =>
    s === 'would_invoke' ? 'pill good' : s === 'consent_blocked' || s === 'unsupported' ? 'pill bad' : 'pill';

  return (
    <div>
      {error && (
        <div className="banner alert" role="alert">
          {error}
        </div>
      )}

      <div className="card">
        <div className="row between">
          <h3>Configured destinations</h3>
          {(dirty || pendingWrite || conflicted) && <button type="button" className="btn" disabled={loading || mutating} onClick={() => void (async () => { if (await confirm({ title: 'Reload saved settings?', description: 'This replaces your local edits with the saved settings.', confirmLabel: 'Reload saved settings', danger: false })) void refresh(); })()}>Reload saved state</button>}
          <button type="button" className="btn primary" disabled={!dirty || busy} onClick={saveDraft}>
            Save draft
          </button>
        </div>
        {dirty && (
          <p className="hint">Unsaved changes. Save the draft before testing or publishing.</p>
        )}
        {pendingWrite && !mutating && <p className="hint" role="status">We could not confirm whether this change was saved. Reload saved settings before making another change.</p>}
        <div className="row">
          <div className="field" style={{ minWidth: '14rem', flex: 1 }}>
            <label htmlFor="add-destination">Add a provider</label>
            <select
              id="add-destination"
              value={addChoice}
              disabled={busy || available.length === 0 || draft.destinations.length >= 10}
              onChange={(e) => setAddChoice(e.target.value)}
            >
              <option value="">
                {available.length > 0 ? 'Choose a provider…' : 'All catalog providers are configured'}
              </option>
              {available.map((c) => (
                <option key={c.provider} value={c.provider}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn primary"
            style={{ alignSelf: 'flex-end' }}
            disabled={busy || !addChoice}
            onClick={addDestination}
          >
            Add destination
          </button>
        </div>
        <p className="hint">
          Up to 10 destinations, one asset per provider. Removing a destination only changes this local
          draft — nothing changes on the site until you save and publish.
        </p>
        {draft.destinations.length === 0 && (
          <p className="empty">No destinations yet. Add a provider above to start routing events.</p>
        )}
      </div>

      {draft.destinations.map((dest) => {
        const cat = catalogOf(dest.provider);
        return (
          <div className="card" key={dest.provider}>
            <div className="row between">
              <div className="row" style={{ alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>{cat?.label ?? dest.provider}</h3>
                <span className={dest.enabled ? 'pill good' : 'pill'}>
                  {dest.enabled ? 'Enabled' : 'Disabled'}
                </span>
                <span className="pill">{dest.owner === 'managed' ? 'Managed' : 'External'}</span>
              </div>
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                aria-label={`Remove ${cat?.label ?? dest.provider}`}
                onClick={() => removeDestination(dest.provider)}
              >
                Remove
              </button>
            </div>

            <div className="field">
              <label htmlFor={`asset-${dest.provider}`}>{cat?.assetLabel ?? 'Asset ID'}</label>
              <input
                id={`asset-${dest.provider}`}
                value={dest.assetId}
                maxLength={64}
                placeholder={cat?.assetPattern}
                disabled={busy}
                onChange={(e) => editDestination(dest.provider, (x) => void (x.assetId = e.target.value))}
              />
              <p className="hint">
                Public identifier only — never a secret. Format:{' '}
                <code className="mono">{cat?.assetPattern ?? '—'}</code>
              </p>
            </div>

            <div className="row" style={{ alignItems: 'center' }}>
              <label>
                <input
                  type="checkbox"
                  style={checkboxStyle}
                  checked={dest.enabled}
                  disabled={busy}
                  onChange={(e) => editDestination(dest.provider, (x) => void (x.enabled = e.target.checked))}
                />{' '}
                Enabled
              </label>
              <label htmlFor={`owner-${dest.provider}`} className="dim">
                Owner
              </label>
              <select
                id={`owner-${dest.provider}`}
                style={{ width: 'auto' }}
                value={dest.owner}
                disabled={busy}
                onChange={(e) =>
                  editDestination(dest.provider, (x) => void (x.owner = e.target.value as Destination['owner']))
                }
              >
                <option value="managed">Managed by ten98</option>
                <option value="external">External</option>
              </select>
            </div>

            {dest.owner === 'external' ? (
              <p className="hint">
                External owner: ten98 never injects or invokes this vendor. Its events are routed nowhere.
              </p>
            ) : (
              <>
                <label className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  <input
                    type="checkbox"
                    style={checkboxStyle}
                    checked={dest.ownershipConfirmed}
                    disabled={busy}
                    onChange={(e) =>
                      editDestination(dest.provider, (x) => void (x.ownershipConfirmed = e.target.checked))
                    }
                  />
                  <span>
                    I reviewed this vendor's setup in its dashboard (GTM, Zaraz, native tag or CAPI),
                    disabled the previous owner's tag, and turned off automatic advanced matching and
                    duplicate enhanced/SPA page-view events there.
                  </span>
                </label>
                <p className="hint">
                  This confirmation does not prove that no hidden tags remain. You can save the draft
                  without it, but publishing is blocked until ownership is confirmed.
                </p>
              </>
            )}

            {cat && (
              <p className="hint">
                Consent required: {cat.purposes.join(', ')}. {cat.notes}
              </p>
            )}

            <div className="field">
              <span className="dim">Event mappings</span>
              {EVENTS.map((evName) => {
                const ce = cat?.events.find((x) => x.event === evName);
                if (!ce) {
                  return (
                    <p key={evName} className="hint" style={{ margin: '0.25rem 0' }}>
                      <code className="mono">{evName}</code> — not supported by this provider yet
                    </p>
                  );
                }
                const mapping = dest.mappings.find((m) => m.event === evName);
                return (
                  <div className="row" key={evName} style={{ alignItems: 'center' }}>
                    <label style={{ minWidth: '11rem' }}>
                      <input
                        type="checkbox"
                        style={checkboxStyle}
                        checked={!!mapping}
                        disabled={busy}
                        onChange={(e) => toggleMapping(dest.provider, ce, e.target.checked)}
                      />{' '}
                      <code className="mono">{evName}</code>
                    </label>
                    {ce.targetRequired ? (
                      mapping && (
                        <input
                          style={{ maxWidth: '18rem' }}
                          aria-label={`${evName} ${ce.targetLabel ?? 'target'}`}
                          placeholder={ce.targetLabel ?? 'Target'}
                          value={mapping.target ?? ''}
                          maxLength={128}
                          disabled={busy}
                          onChange={(e) => setMappingTarget(dest.provider, evName, e.target.value)}
                        />
                      )
                    ) : (
                      <span className="dim">
                        sends <code className="mono">{ce.target}</code>
                      </span>
                    )}
                  </div>
                );
              })}
              <p className="hint">
                Custom events and custom targets are not supported yet. Fixed targets come from the
                provider catalog and cannot be changed here.
              </p>
            </div>
          </div>
        );
      })}

      <div className="card">
        <h3>Dry-run preview</h3>
        <p className="dim">
          Check which destinations would receive an event from the saved draft. No provider traffic is sent.
          Results show field names without payload values or visitor IDs; they do not confirm delivery.
        </p>
        <form onSubmit={(e) => void runPreview(e)}>
          <div className="row">
            <div className="field" style={{ minWidth: '12rem', flex: 1 }}>
              <label htmlFor="preview-event">Event</label>
              <select
                id="preview-event"
                value={pEvent}
                disabled={busy || dirty}
                onChange={(e) => setPEvent(e.target.value as CanonicalEvent)}
              >
                {EVENTS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ minWidth: '8rem', flex: 1 }}>
              <label htmlFor="preview-value">Value</label>
              <input
                id="preview-value"
                inputMode="decimal"
                maxLength={14}
                placeholder="99.99"
                value={pValue}
                disabled={busy || dirty}
                onChange={(e) => setPValue(e.target.value)}
              />
            </div>
            <div className="field" style={{ width: '8rem' }}>
              <label htmlFor="preview-currency">Currency</label>
              <input
                id="preview-currency"
                maxLength={3}
                placeholder="EUR"
                value={pCurrency}
                disabled={busy || dirty}
                onChange={(e) => setPCurrency(e.target.value)}
              />
            </div>
          </div>
          <div className="row">
            <div className="field" style={{ minWidth: '12rem', flex: 1 }}>
              <label htmlFor="preview-txn">Transaction ID</label>
              <input
                id="preview-txn"
                maxLength={128}
                value={pTxn}
                disabled={busy || dirty}
                onChange={(e) => setPTxn(e.target.value)}
              />
            </div>
            <div className="field" style={{ minWidth: '12rem', flex: 1 }}>
              <label htmlFor="preview-item">Item ID</label>
              <input
                id="preview-item"
                maxLength={128}
                value={pItem}
                disabled={busy || dirty}
                onChange={(e) => setPItem(e.target.value)}
              />
            </div>
          </div>
          <p className="hint">
            Empty fields are omitted. Enter value and currency together; purchase and refund also require
            a transaction ID.
          </p>
          <fieldset disabled={busy || dirty} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="dim">Consent for this simulation</legend>
            <div className="row">
              {CONSENT_FIELDS.map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    style={checkboxStyle}
                    checked={consent[key]}
                    onChange={(e) => setConsent((c) => ({ ...c, [key]: e.target.checked }))}
                  />{' '}
                  {label}
                </label>
              ))}
            </div>
            <p className="hint">
              Ad personalization is passed to Google independently and is never inferred from the other
              choices.
            </p>
          </fieldset>
          {dirty && (
            <p className="hint">Save the draft before running a dry-run — previews run against the saved draft.</p>
          )}
          <button className="btn primary" type="submit" disabled={busy || dirty}>
            Run dry-run
          </button>
        </form>
        {preview && (
          <>
            <p className="dim" style={{ marginTop: '1rem' }}>
              Result for <code className="mono">{preview.event}</code>:
            </p>
            {preview.routes.length === 0 ? (
              <p className="empty">No destinations in the saved draft — nothing would be routed.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Asset</th>
                      <th>Target</th>
                      <th>Status</th>
                      <th>Reason</th>
                      <th>Fields</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.routes.map((r) => (
                      <tr key={r.provider}>
                        <td>{r.provider}</td>
                        <td className="mono">{r.assetId}</td>
                        <td className="mono">{r.target ?? '—'}</td>
                        <td>
                          <span className={statusPill(r.status)}>{r.status.replace(/_/g, ' ')}</span>
                        </td>
                        <td>{r.reason}</td>
                        <td className="mono">{r.fields.length > 0 ? r.fields.join(', ') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="footnote">
              A completed preview can show all routes blocked by consent or configuration. Review each reason before publishing.
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h3>Review and publish</h3>
        <div className="row">
          <span className="pill">Active: {mgmt.active ? `v${mgmt.active.number}` : 'none'}</span>
          <span className="pill">Draft version {mgmt.draftVersion}</span>
          <span className="pill">
            {draft.destinations.length} configured · {enabledDests.length} enabled
          </span>
          <span className={unconfirmed.length > 0 ? 'pill bad' : 'pill good'}>
            Managed ownership confirmed {managedCount - unconfirmed.length}/{managedCount}
          </span>
        </div>
        <p className="dim">
          Consent purposes required by enabled destinations:{' '}
          {purposes.length > 0 ? purposes.join(', ') : 'none'}.
        </p>
        {googleMix && (
          <p className="hint">
            GA4 and Google Ads share one Google global — they cannot mix managed and external ownership
            while both are enabled.
          </p>
        )}
        {dirty && <p className="hint">• Save the draft first — publishing always uses the saved draft.</p>}
        {unconfirmed.length > 0 && (
          <p className="hint">• Confirm ownership for: {unconfirmed.map((d) => d.provider).join(', ')}.</p>
        )}
        {!dirty && dryRunVersion !== mgmt.draftVersion && (
          <p className="hint">
            • Run at least one successful dry-run against the current saved draft. A dry-run where every
            route is blocked still counts — it checks this routing simulation, not delivery.
          </p>
        )}
        {!ack && <p className="hint">• Acknowledge the third-party SDK behavior below.</p>}
        <label className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <input
            type="checkbox"
            style={checkboxStyle}
            checked={ack}
            disabled={busy}
            onChange={(e) => setAck(e.target.checked)}
          />
          <span>
            I understand that browser vendor SDKs contact third parties directly from the visitor's
            browser; that these SDKs can independently read the page URL, the referrer and their own
            automatic events; that ownership detection is incomplete and hidden vendor tags may still
            exist; and that changing consent may reload the visitor's page or close it if consent storage
            fails, losing unsaved work. Visitors must be warned before they grant consent.
          </span>
        </label>
        <p className="footnote">
          Publishing creates a new immutable revision with a fresh consent epoch: every visitor must grant
          consent again before any vendor tag runs, changes propagate within about 60 seconds, and no
          historical events are replayed.
        </p>
        <button type="button" className="btn primary" disabled={!canPublish} onClick={() => void publish()}>
          Publish to {environment === 'live' ? 'Live' : 'Test'}
        </button>
      </div>

      <div className="card">
        <h3>Revision history</h3>
        {mgmt.history.length === 0 ? (
          <p className="empty">No revisions published yet.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Revision</th>
                    <th>Created</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {mgmt.history.slice(0, 20).map((h) => (
                    <tr key={h.id}>
                      <td className="mono">v{h.number}</td>
                      <td>{new Date(h.createdAt).toLocaleString()}</td>
                      <td>
                        {mgmt.active?.id === h.id && <span className="pill good">Current</span>}
                        {h.rollbackOf && <span className="pill">Rollback</span>}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={busy || dirty}
                          onClick={() => void rollback(h)}
                        >
                          Roll back
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {dirty && (
              <p className="hint">
                Rollbacks are disabled while the draft has unsaved changes, because a rollback replaces
                the draft.
              </p>
            )}
          </>
        )}
        <p className="footnote">
          Rolling back creates a new revision with a fresh consent epoch. Publishing an empty
          configuration tells this loader to stop its vendor routing on the next config refresh. Already
          loaded vendor SDKs may require a page reload; this does not control separately installed tags.
        </p>
      </div>

      <div className="card">
        <h3>Consent API for developers</h3>
        <p className="dim">
          Example usage only — replace <code className="mono">your-public-site-key</code> with the site's
          public key; it is not exposed here. Native analytics use the same analytics-consent choice;
          configure native collection and optional metadata in Collection and privacy. This panel manages vendor tags.
        </p>
        <p className="hint">
          This preferences button becomes available after the loader validates the site configuration.
          The built-in dialog explains reload and storage-failure behavior before any grant. For a custom
          consent interface, pass all four explicit choices to <code>ten98.consent</code> with
          <code> acknowledgeReload: true</code> only after showing the same warning. Pre-consent events
          are discarded; a new grant does not replay them.
        </p>
        <textarea
          className="snippet"
          readOnly
          rows={10}
          value={SNIPPET.replace("environment: 'live'", `environment: '${environment}'`)}
          aria-label="Consent API usage example"
          style={{ width: '100%', resize: 'vertical' }}
        />
      </div>
      {confirmDialog}
    </div>
  );
}
