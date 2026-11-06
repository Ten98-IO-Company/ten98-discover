import {useEffect, useId, useRef, useState} from 'react';
import {Alert, Button, Disclosure, Field, Select} from '@ten98/ui';
import {workspaceRoles} from '@ten98/runtime/browser';
import {z} from 'zod';
import {ApiError, errMsg} from '../lib/api';
import type {AIRecommendationsCategory} from '../lib/navigation';
import {opportunitiesActionDtoSchema, opportunitiesDetailDtoSchema, opportunitiesListDtoSchema, opportunitiesSourceDtoSchema, type OpportunitiesDetailDto, type OpportunitiesListDto, type OpportunitiesSourceDto} from '../lib/ai-opportunities-api';
import {opportunitiesPreparationDtoSchema} from '../lib/ai-opportunities-run';
import {opportunitiesPrepareInputSchema, opportunitiesScopeSchema, opportunitiesStartInputSchema, opportunitiesActionInputSchema, type OpportunitiesScope} from '../lib/ai-opportunities';
import type {OpenRouterCatalog} from '../lib/openrouter-models';
import {OpenRouterModelPicker, modelApi, readModelCatalog, modelUnavailableReason} from './OpenRouterModelPicker';
import {AIRecommendationsView} from './AIRecommendationsView';

export type AIRecommendationsPanelProps = {
  userId: string; workspaceId: string; projectId: string; scope: OpportunitiesScope;
  selectedRunId: string | null; category: AIRecommendationsCategory;
  onSelectionChange: (selection: {runId: string | null; category: AIRecommendationsCategory}) => void;
  onUnauthorized: () => void; onOpenConnections?: () => void;
};
type ReadKind = 'history' | 'source' | 'models' | 'detail';
type Attempt = {kind: 'prepare' | 'start' | 'cancel' | 'recover'; path: string; body: Record<string, unknown>; runId?: string; model?: string};
const catalogSchema = z.object({role: z.enum(workspaceRoles), catalog: z.unknown()}).strict();
const emptyErrors = {history: '', source: '', models: '', detail: '', action: ''};
const emptyLoading = {history: false, source: false, models: false, detail: false, action: false};

export function AIRecommendationsPanel(props: AIRecommendationsPanelProps) {
  return <RecommendationsController key={JSON.stringify([props.userId, props.workspaceId, props.projectId])} {...props}/>;
}

function RecommendationsController(props: AIRecommendationsPanelProps) {
  const prefix = useId(), base = `/api/projects/${props.projectId}/ai-opportunities`;
  const [history, setHistory] = useState<OpportunitiesListDto | null>(null), [detail, setDetail] = useState<OpportunitiesDetailDto | null>(null), [source, setSource] = useState<OpportunitiesSourceDto | null>(null);
  const [catalog, setCatalog] = useState<OpenRouterCatalog | null>(null), [connectionId, setConnectionId] = useState(''), [models, setModels] = useState<string[]>([]);
  const [errors, setErrors] = useState(emptyErrors), [loading, setLoading] = useState(emptyLoading), [attempt, setAttempt] = useState<Attempt | null>(null), [revoked, setRevoked] = useState(false), [refresh, setRefresh] = useState(0), [pages, setPages] = useState<(string | null)[]>([null]);
  const refs = useRef(props); refs.current = props;
  const state = useRef({mounted: false, revoked: false, locked: false, role: null as OpportunitiesListDto['role'] | null, requests: new Map<string, AbortController>(), attempt: null as Attempt | null, scope: '', epoch: 0});
  const scopeKey = JSON.stringify(props.scope);
  if (state.current.scope !== scopeKey) {state.current.scope = scopeKey; state.current.epoch++;}
  const cursor = pages.at(-1) ?? null;
  const cursorRef = useRef(cursor); cursorRef.current = cursor;
  function error(kind: keyof typeof emptyErrors, message: string) {setErrors(previous => ({...previous, [kind]: message}));}
  function purge(message: string, unauthorized = false) {
    const s = state.current; if (s.revoked) return;
    s.revoked = true; s.locked = false; s.attempt = null;
    for (const controller of s.requests.values()) controller.abort(); s.requests.clear();
    setRevoked(true); setHistory(null); setDetail(null); setSource(null); setCatalog(null); setModels([]); setConnectionId(''); setAttempt(null); setLoading(emptyLoading); setErrors({...emptyErrors, history: message});
    if (unauthorized) refs.current.onUnauthorized();
  }
  function acceptRole(role: OpportunitiesListDto['role']) {
    const previous = state.current.role;
    if (previous !== null && previous !== role) {purge('Your access changed. Reopen the project to continue.'); throw Error('Access changed.');}
    state.current.role = role;
  }
  function begin(kind: string) {
    const s = state.current; s.requests.get(kind)?.abort();
    const controller = new AbortController(), epoch = s.epoch;
    s.requests.set(kind, controller);
    return {signal: controller.signal, current: () => s.mounted && !s.revoked && !controller.signal.aborted && s.epoch === epoch && s.requests.get(kind) === controller};
  }
  function failed(kind: ReadKind | 'action', e: unknown, verifyingResponse = true) {
    if (e instanceof ApiError && ([401, 403].includes(e.status) || e.status === 404 && kind !== 'detail')) {purge(errMsg(e), e.status === 401); return;}
    if (verifyingResponse && !(e instanceof ApiError)) {purge('The response could not be verified. Reopen the project to continue.'); return;}
    error(kind, errMsg(e));
  }
  async function read(kind: ReadKind, refreshModels = false, requestedCursor: string | null = cursorRef.current): Promise<OpportunitiesDetailDto | null> {
    if (state.current.revoked || !state.current.mounted) return null;
    const {signal, current} = begin(kind), selectedId = refs.current.selectedRunId;
    setLoading(previous => ({...previous, [kind]: true})); error(kind, '');
    let verifyingResponse = true;
    try {
      if (kind === 'history') {
        verifyingResponse = false;
        const raw = await modelApi(base + (requestedCursor ? '?' + new URLSearchParams({cursor: requestedCursor}) : ''), {signal}); if (!current()) return null; verifyingResponse = true;
        const data = opportunitiesListDtoSchema.parse(raw); if (data.projectId !== props.projectId) throw Error('Foreign report history.'); acceptRole(data.role); if (!current()) return null;
        setHistory(data); setConnectionId(previous => data.connections.some(item => item.id === previous) ? previous : data.connections.find(item => item.checkStatus === 'ok')?.id ?? '');
      } else if (kind === 'source') {
        setSource(null);
        const requestedScope = opportunitiesScopeSchema.parse(refs.current.scope);
        verifyingResponse = false;
        const raw = await modelApi(base + '/source', {method: 'POST', body: requestedScope, signal}); if (!current()) return null; verifyingResponse = true;
        const data = opportunitiesSourceDtoSchema.parse(raw);
        if (data.projectId !== props.projectId || JSON.stringify(data.expectedSource.scope) !== JSON.stringify(requestedScope)) throw Error('Foreign source selection.'); setSource(data);
      } else if (kind === 'models') {
        verifyingResponse = false;
        const raw = await modelApi(`/api/projects/${props.projectId}/openrouter-models`, {signal, ...refreshModels ? {method: 'POST', body: {}} : {}}); if (!current()) return null; verifyingResponse = true;
        const data = catalogSchema.parse(raw); acceptRole(data.role); if (!current()) return null; setCatalog(readModelCatalog(data.catalog));
      } else if (selectedId) {
        verifyingResponse = false;
        const raw = await modelApi(base + '/runs/' + selectedId, {signal}); if (!current() || refs.current.selectedRunId !== selectedId) return null; verifyingResponse = true;
        const data = opportunitiesDetailDtoSchema.parse(raw); if (data.projectId !== props.projectId || data.run.id !== selectedId) throw Error('Foreign recommendation report.'); acceptRole(data.role); if (!current()) return null; setDetail(data); return data;
      }
    } catch (e) {
      if (!current()) return null;
      if (kind === 'detail') setDetail(null);
      if (kind === 'source') setSource(null);
      if (kind === 'models') setCatalog(null);
      if (kind === 'detail' && e instanceof ApiError && e.status === 404) {error('detail', 'The selected report was not found. Choose another saved report.'); void read('history');}
      else failed(kind, e, verifyingResponse);
    } finally {if (current()) setLoading(previous => ({...previous, [kind]: false}));}
    return null;
  }
  useEffect(() => {
    const s = state.current; s.mounted = true;
    return () => {s.mounted = false; for (const controller of s.requests.values()) controller.abort();};
  }, []);
  useEffect(() => {
    const s = state.current;
    for (const controller of s.requests.values()) controller.abort();
    s.locked = false; setLoading(emptyLoading); setSource(null);
    void read('history'); void read('source'); void read('models');
  }, [scopeKey, refresh]);
  useEffect(() => {void read('history', false, cursor);}, [cursor]);
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined, count = 0;
    setDetail(previous => previous?.run.id === props.selectedRunId ? previous : null);
    async function poll() {
      if (cancelled || !refs.current.selectedRunId) return;
      const value = await read('detail'); count++;
      if (!cancelled && value && ['queued', 'running'].includes(value.run.status)) {
        if (count < 30) timer = setTimeout(() => {void poll();}, 2000);
        else error('detail', 'Automatic status checks paused. Refresh reports to continue.');
      }
    }
    void poll();
    return () => {cancelled = true; if (timer) clearTimeout(timer); state.current.requests.get('detail')?.abort();};
  }, [props.selectedRunId, scopeKey, refresh]);
  const selectedConnection = history?.connections.find(item => item.id === connectionId), selectedModel = catalog?.models.find(item => item.id === models[0]);
  const ready = !revoked && history?.canPrepare === true && source?.availability === 'available' && !attempt && !loading.action && !loading.history && !loading.source && !loading.models && selectedConnection?.checkStatus === 'ok' && catalog?.status === 'fresh' && !!selectedModel && !modelUnavailableReason(selectedModel, true);
  async function mutate(initial: Attempt) {
    const s = state.current;
    if (s.locked || s.revoked || !s.mounted || s.role !== 'owner') return;
    s.locked = true; s.attempt = initial; setAttempt(initial); setLoading(previous => ({...previous, action: true})); error('action', '');
    const {signal, current} = begin('action'); let next = initial;
    try {
      for (;;) {
        const raw = await modelApi(next.path, {method: 'POST', body: next.body, signal}); if (!current()) return;
        if (next.kind === 'prepare') {
          const prepared = opportunitiesPreparationDtoSchema.parse(raw);
          if (prepared.requestId !== next.body.requestId || prepared.route.model !== next.model) throw Error('Preparation does not match this request.');
          if (prepared.expired || !prepared.available || Date.parse(prepared.expiresAt) <= Date.now()) throw Object.assign(new ApiError('The prepared selection expired. Refresh and run again.'), {status: 409});
          next = {kind: 'start', path: base + '/runs', body: opportunitiesStartInputSchema.parse({preparationId: prepared.id, requestId: crypto.randomUUID()})};
          s.attempt = next; setAttempt(next); continue;
        }
        const result = opportunitiesActionDtoSchema.parse(raw); if (next.runId && result.runId !== next.runId) throw Error('Action returned a different request.');
        if (next.kind === 'start') {
          const rawDetail = await modelApi(base + '/runs/' + result.runId, {signal}); if (!current()) return;
          const confirmed = opportunitiesDetailDtoSchema.parse(rawDetail);
          if (confirmed.projectId !== props.projectId || confirmed.run.id !== result.runId || confirmed.run.preparationId !== next.body.preparationId) throw Error('Started report does not match this preparation.');
          acceptRole(confirmed.role); if (!current()) return; setDetail(confirmed);
        }
        s.attempt = null; setAttempt(null); setPages([null]); void read('history', false, null);
        refs.current.onSelectionChange({runId: result.runId, category: refs.current.category});
        if (refs.current.selectedRunId === result.runId) setRefresh(value => value + 1);
        break;
      }
    } catch (e) {
      if (!current()) return;
      if (e instanceof ApiError && [400, 409, 410, 413, 422].includes(e.status)) {s.attempt = null; setAttempt(null); error('action', errMsg(e)); void read('source');}
      else if (e instanceof ApiError && [401, 403, 404].includes(e.status)) failed('action', e);
      else error('action', 'This action could not be confirmed. Check or retry the same request; its identity has been preserved.');
    } finally {if (current()) {s.locked = false; setLoading(previous => ({...previous, action: false}));}}
  }
  function run() {
    if (!ready || state.current.locked || state.current.attempt || !source) return;
    const body = opportunitiesPrepareInputSchema.parse({requestId: crypto.randomUUID(), connectionId, model: models[0], expectedSource: source.expectedSource});
    void mutate({kind: 'prepare', path: base + '/prepare', body, model: models[0]});
  }
  function act(kind: 'cancel' | 'recover', id: string) {
    if (state.current.attempt || !detail || detail.run.id !== id || (kind === 'cancel' ? detail.run.status !== 'queued' : !detail.run.canRecover)) return;
    void mutate({kind, path: base + '/runs/' + id + '/' + kind, runId: id, body: opportunitiesActionInputSchema.parse({requestId: crypto.randomUUID()})});
  }
  const setup = <>
    {errors.models && <Alert tone="warning" title="Model metadata unavailable">{errors.models}</Alert>}
    {attempt && <Alert tone="warning" title="Unconfirmed request"><p>The original request is retained. A retry uses the same request identity.</p><Button variant="secondary" disabled={loading.action || revoked} onClick={() => {if (state.current.attempt) void mutate(state.current.attempt);}}>Retry same request</Button></Alert>}
    {history?.canPrepare && <Disclosure summary="Recommendation model and connection" variant="plain" defaultOpen={!props.selectedRunId}>
      <Field label="OpenRouter connection" htmlFor={prefix + 'connection'}><Select id={prefix + 'connection'} value={connectionId} disabled={loading.action || !!attempt} onChange={event => {if (!state.current.locked && !state.current.attempt) setConnectionId(event.target.value);}}><option value="">Choose a checked connection</option>{history.connections.map(item => <option key={item.id} value={item.id}>{item.name}{item.checkStatus === 'ok' ? '' : ' — check required'}</option>)}</Select></Field>
      {props.onOpenConnections ? <Button variant="ghost" onClick={props.onOpenConnections}>Settings › Connections</Button> : <a href={'/?' + new URLSearchParams({workspace: props.workspaceId, project: props.projectId, view: 'providers', provider: 'openrouter'})}>Settings › Connections</a>}
      <OpenRouterModelPicker catalog={catalog} selected={models} maximum={1} structured disabled={loading.action || !!attempt} refreshing={loading.models} canRefresh={!revoked && history.canPrepare} onChange={value => {if (!state.current.locked && !state.current.attempt) setModels(value);}} onRefresh={() => {if (!loading.models && !state.current.locked && !state.current.attempt) void read('models', true);}}/>
    </Disclosure>}
  </>;
  return <AIRecommendationsView prefix={prefix} history={revoked ? null : history} detail={revoked ? null : detail} source={revoked ? null : source} selectedRunId={props.selectedRunId} category={props.category}
    readingHistory={loading.history} readingDetail={loading.detail} readingSource={loading.source} running={loading.action} actionBusy={loading.action || !!attempt} canRun={!!ready}
    historyError={errors.history} detailError={errors.detail} sourceError={errors.source} runError={errors.action} setupControls={setup}
    onRun={run} onSelectRun={runId => {if (!state.current.revoked) refs.current.onSelectionChange({runId, category: refs.current.category});}} onCategoryChange={category => {if (!state.current.revoked) refs.current.onSelectionChange({runId: refs.current.selectedRunId, category});}}
    onReload={() => {if (!state.current.locked && !state.current.revoked) setRefresh(value => value + 1);}}
    onMoreHistory={history?.nextCursor ? () => {if (!loading.history) setPages(value => [...value, history.nextCursor]);} : undefined}
    onPreviousHistory={pages.length > 1 ? () => {if (!loading.history) setPages(value => value.slice(0, -1));} : undefined}
    onCancel={id => act('cancel', id)} onRecover={id => act('recover', id)}/>;
}
