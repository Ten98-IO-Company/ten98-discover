import {useEffect, useMemo, useRef, useState} from 'react';
import {api, ApiError, errMsg} from '../lib/api';
import {useBlocker} from '@tanstack/react-router';
import {z} from 'zod';
import {PromptDiscoveryPanel} from './PromptDiscoveryPanel';
import {PromptExecutionsPanel} from './PromptExecutionsPanel';
import {AiSuggestionsPanel} from './AiSuggestionsPanel';
import type {ExecutionEntry} from './PromptExecutionsPanel';

type Role = 'owner' | 'admin' | 'editor' | 'viewer';

type Classification = {
  isBranded: boolean;
  systemIsBranded: boolean;
  isOverridden: boolean;
  version: string;
};

type Prompt = {
  id: string;
  revision: number;
  currentVersionId: string;
  text: string;
  topic: string;
  enabled: boolean;
  archivedAt: string | null;
  userTags: string[];
  systemTags: ('branded' | 'unbranded')[];
  classification: Classification;
  createdAt: string;
  updatedAt: string;
};

type ListResponse = {
  role: Role;
  items: Prompt[];
  nextCursor: string | null;
  execution: {available: true; schedulingAvailable: false; nextRunAt: null};
};

type PromptVersion = {
  id: string;
  number: number;
  text: string;
  createdAt: string;
  createdBy: string;
};

type VersionsResponse = {versions: PromptVersion[]; nextCursor: string | null};

type StatusFilter = 'active' | 'archived' | 'all';
type ClassFilter = '' | 'branded' | 'unbranded';
type Filters = {status: StatusFilter; q: string; tag: string; classification: ClassFilter};
const DEFAULT_FILTERS: Filters = {status: 'active', q: '', tag: '', classification: ''};

type BulkPrompt = {text: string; topic: string; tags: string[]; enabled: boolean};

// A mutation attempt keeps its requestId and exact payload so a network-uncertain
// failure can be retried explicitly with the identical request (never a new payload
// under an old id, never an automatic retry).
type Attempt =
  | {kind: 'create'; requestId: string; body: {requestId: string; prompts: BulkPrompt[]}}
  | {kind: 'update'; promptId: string; requestId: string; body: {requestId: string; revision: number; text: string; topic: string; tags: string[]; enabled: boolean}}
  | {kind: 'archive' | 'restore'; promptId: string; requestId: string; body: {requestId: string; revision: number}};

const MAX_TEXT = 2000;
const MAX_TOPIC = 100;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 80;
const MAX_BATCH = 100;
const savedText = (maximum: number) => z.string().max(maximum).refine(value => !value.includes('\0') && new TextDecoder().decode(new TextEncoder().encode(value)) === value);
const promptSchema = z.object({
  id: z.uuid(), revision: z.number().int().positive(), currentVersionId: z.uuid(), text: savedText(MAX_TEXT).min(1), topic: savedText(MAX_TOPIC), enabled: z.boolean(), archivedAt: z.iso.datetime().nullable(),
  userTags: z.array(savedText(MAX_TAG_LEN).min(1)).max(MAX_TAGS), systemTags: z.array(z.enum(['branded', 'unbranded'])).length(1),
  classification: z.object({isBranded: z.boolean(), systemIsBranded: z.boolean(), isOverridden: z.boolean(), version: z.literal('elmo-substring-v1')}),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const bulkAcknowledgement = z.object({items: z.array(promptSchema).min(1).max(MAX_BATCH), replayed: z.boolean()});
const pointAcknowledgement = z.object({prompt: promptSchema, replayed: z.boolean()});
function confirmAcknowledgement(value: unknown, attempt: Attempt) {
  if (attempt.kind === 'create') {
    const parsed = bulkAcknowledgement.safeParse(value);
    if (parsed.success && parsed.data.items.length === attempt.body.prompts.length && new Set(parsed.data.items.map(item => item.id)).size === parsed.data.items.length) return;
  } else {
    const parsed = pointAcknowledgement.safeParse(value);
    if (parsed.success && parsed.data.prompt.id === attempt.promptId) return;
  }
  throw new ApiError('The save acknowledgement could not be verified. Check saved prompts before retrying.');
}

function parseTags(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

function validateText(text: string): string | null {
  if (text.length === 0) return 'Prompt text is required. Enter at least 1 character.';
  if (text.length > MAX_TEXT) return `Prompt text is ${text.length} characters; the limit is ${MAX_TEXT}. Shorten it, then save again.`;
  return null;
}

function validateTopic(topic: string): string | null {
  if (topic.length > MAX_TOPIC) return `Topic is ${topic.length} characters; the limit is ${MAX_TOPIC}. Shorten it, then save again.`;
  return null;
}

function validateTags(tags: string[]): string | null {
  if (tags.length > MAX_TAGS) return `You entered ${tags.length} tags; the limit is ${MAX_TAGS}. Remove ${tags.length - MAX_TAGS}, then save again.`;
  const tooLong = tags.find(t => t.length > MAX_TAG_LEN);
  if (tooLong) return `The tag "${tooLong.slice(0, 40)}…" is ${tooLong.length} characters; the limit is ${MAX_TAG_LEN}. Shorten it, then save again.`;
  return null;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

type Props={workspaceId:string;projectId:string;userId:string;onUnauthorized:()=>void;onAISearch?:(promptId:string,versionId:string|null,capture:boolean)=>void};
export function PromptsPanel(props: Props) {
  // Keyed on projectId + userId: switching either remounts everything, so no
  // stale items, drafts, errors or pagination can leak across contexts.
  return <PromptsPanelInner key={props.projectId + ':' + props.userId} {...props} />;
}

function PromptsPanelInner({workspaceId, projectId, userId, onUnauthorized,onAISearch}: Props) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/prompts`;

  const [execution, setExecution] = useState<{generation: number; entry: ExecutionEntry} | null>(null);
  const [suggestions, setSuggestions] = useState<number | null>(null);
  const [discovery, setDiscovery] = useState<number | null>(null);
  const [returning, setReturning] = useState(false);
  const entryGeneration = useRef(0);
  const returnFocus = useRef<string | null>(null);
  const libraryHeading = useRef<HTMLHeadingElement>(null);

  const [role, setRole] = useState<Role | null>(null);
  const [items, setItems] = useState<Prompt[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [draft, setDraft] = useState<Filters>(DEFAULT_FILTERS);
  const [applied, setApplied] = useState<Filters>(DEFAULT_FILTERS);

  const [showCreate, setShowCreate] = useState(false);
  const [mode, setMode] = useState<'single' | 'bulk'>('single');
  const [fText, setFText] = useState('');
  const [fTopic, setFTopic] = useState('');
  const [fTags, setFTags] = useState('');
  const [fEnabled, setFEnabled] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [baseline, setBaseline] = useState<{text: string; topic: string; tags: string; enabled: boolean} | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{id: string; server: Prompt | null} | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);

  const [versionsFor, setVersionsFor] = useState<Prompt | null>(null);
  const [verItems, setVerItems] = useState<PromptVersion[]>([]);
  const [verCursor, setVerCursor] = useState<string | null>(null);
  const [verLoading, setVerLoading] = useState(false);
  const [verErr, setVerErr] = useState<string | null>(null);

  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const aliveRef = useRef(true);
  const accessRef = useRef(0);
  const genRef = useRef(0);
  const acRef = useRef<AbortController | null>(null);
  const verGenRef = useRef(0);
  const verAcRef = useRef<AbortController | null>(null);
  const opAcRef = useRef<AbortController | null>(null);
  const opRef = useRef(false); // synchronous mutation lock

  const bulk = useMemo(() => {
    const lines: string[] = [];
    let blank = 0;
    for (const rawLine of bulkText.split('\n')) {
      const t = rawLine.trim();
      if (t.length > 0) lines.push(t);
      else blank += 1;
    }
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const l of lines) {
      if (seen.has(l)) dupes.add(l);
      seen.add(l);
    }
    return {lines, blank, dupes: Array.from(dupes), oversizeCount: lines.filter(l => l.length > MAX_TEXT).length};
  }, [bulkText]);

  function resetFields() {
    setFText('');
    setFTopic('');
    setFTags('');
    setFEnabled(false);
    setBulkText('');
  }

  function closeForm() {
    setEditing(null);
    setBaseline(null);
    setConflict(null);
    setFormError(null);
    setRetryAttempt(null);
    resetFields();
  }

  function closeVersions() {
    verGenRef.current += 1;
    verAcRef.current?.abort();
    setVersionsFor(null);
    setVerItems([]);
    setVerCursor(null);
    setVerErr(null);
    setVerLoading(false);
  }

  function purge() {
    // 401/403/404 invalidate every concurrent request before clearing content.
    accessRef.current += 1;
    genRef.current += 1;
    acRef.current?.abort();
    opAcRef.current?.abort();
    setLoading(false);
    setLoadingMore(false);
    setItems([]);
    setRole(null);
    setNextCursor(null);
    closeForm();
    setShowCreate(false);
    closeVersions();
    setNotice(null);
    setExecution(null);
    setSuggestions(null);
    setDiscovery(null);
  }

  async function load(cursor: string | null, filters: Filters, accessOnly = false, failClosed = false) {
    const gen = ++genRef.current;
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setErr(null);
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set('status', filters.status);
      if (filters.q.trim()) p.set('q', filters.q.trim());
      if (filters.tag.trim()) p.set('tag', filters.tag.trim());
      if (filters.classification) p.set('classification', filters.classification);
      if (cursor) p.set('cursor', cursor); // cursor only ever follows an unchanged filter set
      const r = await api<ListResponse>(`${base}?${p.toString()}`, {signal: ac.signal});
      if (!aliveRef.current || gen !== genRef.current) return;
      if ((accessOnly || failClosed) && (!r || !['owner','admin','editor','viewer'].includes(r.role) || !Array.isArray(r.items) || !(r.nextCursor === null || typeof r.nextCursor === 'string') || r.items.some(p => !p || typeof p.id !== 'string' || typeof p.text !== 'string' || typeof p.topic !== 'string' || typeof p.enabled !== 'boolean' || !Array.isArray(p.userTags) || !Array.isArray(p.systemTags) || !p.classification))) throw new Error('Prompt library access could not be verified. Reload the list.');
      setRole(r.role);
      if (!accessOnly) {
        setItems(prev => (cursor ? [...prev, ...r.items] : r.items));
        setNextCursor(r.nextCursor);
      }
    } catch (e) {
      if (!aliveRef.current || gen !== genRef.current) return; // stale/aborted
      if (e instanceof ApiError && e.status === 401) {
        purge();
        unauthorizedRef.current();
        return;
      }
      if (accessOnly || failClosed || e instanceof ApiError && (e.status === 403 || e.status === 404)) purge();
      setErr(errMsg(e));
    } finally {
      if (aliveRef.current && gen === genRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  async function loadVersions(p: Prompt, cursor: string | null) {
    const gen = ++verGenRef.current;
    verAcRef.current?.abort();
    const ac = new AbortController();
    verAcRef.current = ac;
    setVerLoading(true);
    setVerErr(null);
    try {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const r = await api<VersionsResponse>(`${base}/${encodeURIComponent(p.id)}/versions${qs}`, {signal: ac.signal});
      if (!aliveRef.current || gen !== verGenRef.current) return;
      setVerItems(prev => (cursor ? [...prev, ...r.versions] : r.versions));
      setVerCursor(r.nextCursor);
    } catch (e) {
      if (!aliveRef.current || gen !== verGenRef.current) return;
      if (e instanceof ApiError && e.status === 401) {
        purge();
        unauthorizedRef.current();
        return;
      }
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        purge();
        setErr(errMsg(e));
        return;
      }
      setVerErr(errMsg(e));
    } finally {
      if (aliveRef.current && gen === verGenRef.current) setVerLoading(false);
    }
  }

  async function openConflict(promptId: string, signal: AbortSignal) {
    const access = accessRef.current;
    try {
      const r = await api<{prompt: Prompt}>(`${base}/${encodeURIComponent(promptId)}`, {signal});
      if (aliveRef.current && access === accessRef.current && !signal.aborted) setConflict({id: promptId, server: r.prompt});
    } catch (e) {
      if (!aliveRef.current || access !== accessRef.current || signal.aborted) return;
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        purge();
        if (e.status === 401) unauthorizedRef.current(); else setErr(errMsg(e));
        return;
      }
      setConflict({id: promptId, server: null});
    }
  }

  async function runAttempt(a: Attempt) {
    if (opRef.current) return; // synchronous lock: no overlapping mutations
    opRef.current = true;
    setBusy(true);
    setFormError(null);
    setErr(null);
    setNotice(null);
    setRetryAttempt(null);
    const ac = new AbortController();
    opAcRef.current = ac;
    const access = accessRef.current;
    const fail = a.kind === 'create' || a.kind === 'update' ? setFormError : setErr;
    try {
      let acknowledgement: unknown;
      if (a.kind === 'create') {
        acknowledgement = await api<unknown>(`${base}/bulk`, {method: 'POST', body: a.body, signal: ac.signal});
      } else if (a.kind === 'update') {
        acknowledgement = await api<unknown>(`${base}/${encodeURIComponent(a.promptId)}/update`, {method: 'POST', body: a.body, signal: ac.signal});
      } else {
        acknowledgement = await api<unknown>(`${base}/${encodeURIComponent(a.promptId)}/${a.kind}`, {method: 'POST', body: a.body, signal: ac.signal});
      }
      if (!aliveRef.current || access !== accessRef.current || ac.signal.aborted) return;
      confirmAcknowledgement(acknowledgement, a);
      if (a.kind === 'create') resetFields();
      else if (a.kind === 'update') closeForm();
      setNotice(
        a.kind === 'create'
          ? 'Prompt saved. Saved prompts do not start tracking.'
          : a.kind === 'update'
            ? 'Changes saved. Text changes add a version; earlier versions are unchanged.'
            : a.kind === 'archive'
              ? 'Prompt archived. Its versions are kept and it can be restored.'
              : 'Prompt restored.',
      );
      await load(null, applied); // lock stays held through the refresh
    } catch (e) {
      if (!aliveRef.current || access !== accessRef.current || ac.signal.aborted) return;
      if (e instanceof ApiError && e.status > 0 && e.status < 500) {
        if (e.status === 401) {
          purge();
          unauthorizedRef.current();
          return;
        }
        if (e.status === 403 || e.status === 404) {
          purge();
          setErr(errMsg(e));
          return;
        }
        if (e.status === 409) {
          if (a.kind === 'create') { setFormError(errMsg(e)); return; }
          if (a.kind === 'update') {
            setFormError(errMsg(e));
            await openConflict(a.promptId, ac.signal); // draft text stays untouched
            return;
          }
          setErr('This prompt changed on the server, so the request was rejected. The list was reloaded — review it, then try again.');
          await load(null, applied);
          return;
        }
        fail(errMsg(e)); // validation errors keep the draft exactly as typed
        return;
      }
      // Network-uncertain: the server may or may not have applied it. Keep the
      // exact request (id + payload) for an explicit user retry; never auto-retry.
      setRetryAttempt(a);
      fail('We could not confirm the save. It may already be saved. Your draft is kept. Check saved prompts before retrying, or use the retry button to resend the identical request.');
    } finally {
      opRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }

  useEffect(() => {
    aliveRef.current = true;
    load(null, DEFAULT_FILTERS);
    return () => {
      aliveRef.current = false;
      genRef.current += 1;
      verGenRef.current += 1;
      acRef.current?.abort();
      verAcRef.current?.abort();
      opAcRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function formDirty(): boolean {
    if (editing && baseline) {
      return fText !== baseline.text || fTopic !== baseline.topic || fTags !== baseline.tags || fEnabled !== baseline.enabled;
    }
    if (showCreate) {
      return fText.trim() !== '' || bulkText.trim() !== '' || fTopic.trim() !== '' || fTags.trim() !== '' || fEnabled;
    }
    return false;
  }

  function confirmDiscard(): boolean {
    if (retryAttempt) return window.confirm('This save may already have completed. Discard the local draft? Check saved prompts before trying another save.');
    return !formDirty() || window.confirm('You have unsaved changes. Select OK to discard them, or Cancel to keep editing.');
  }

  function openExecution(entry: ExecutionEntry, triggerId: string) {
    if (opRef.current || returning || !confirmDiscard()) return;
    // Library state stays in memory; its outstanding reads cannot affect a run.
    genRef.current += 1;
    verGenRef.current += 1;
    acRef.current?.abort();
    verAcRef.current?.abort();
    setLoading(false);
    setLoadingMore(false);
    setVerLoading(false);
    closeForm();
    setShowCreate(false);
    returnFocus.current = triggerId;
    setExecution({generation: ++entryGeneration.current, entry});
  }

  async function backToLibrary() {
    setExecution(null);
    setReturning(true);
    // Recheck current access without discarding the loaded pages or filters.
    await load(null, applied, true);
    if (aliveRef.current) setReturning(false);
  }

  function openSuggestions(organic = false) {
    if (opRef.current || returning || !confirmDiscard()) return;
    genRef.current += 1;
    verGenRef.current += 1;
    acRef.current?.abort();
    verAcRef.current?.abort();
    setLoading(false);
    setLoadingMore(false);
    setVerLoading(false);
    closeForm();
    setShowCreate(false);
    returnFocus.current = organic ? 'pl-discover-prompts' : 'pl-suggest-prompts';
    if (organic) setDiscovery(++entryGeneration.current);
    else setSuggestions(++entryGeneration.current);
  }

  async function backFromSuggestions(saved: boolean) {
    setSuggestions(null);
    setReturning(true);
    const access = accessRef.current;
    await load(null, applied, !saved, true);
    if (saved && aliveRef.current && access === accessRef.current) setNotice('Suggested prompts were saved disabled. Current library filters still apply.');
    if (aliveRef.current) setReturning(false);
  }

  useEffect(() => {
    if (execution || suggestions !== null || discovery !== null || returning || !returnFocus.current) return;
    const trigger = document.getElementById(returnFocus.current);
    (trigger instanceof HTMLButtonElement && !trigger.disabled ? trigger : libraryHeading.current)?.focus();
    returnFocus.current = null;
  }, [execution, suggestions, discovery, returning]);

  const onApply = () => {
    if (!confirmDiscard()) return;
    closeForm();
    setShowCreate(false);
    setNotice(null);
    setApplied(draft);
    load(null, draft);
  };

  const onReset = () => {
    if (!confirmDiscard()) return;
    closeForm();
    setShowCreate(false);
    setNotice(null);
    setDraft(DEFAULT_FILTERS);
    setApplied(DEFAULT_FILTERS);
    load(null, DEFAULT_FILTERS);
  };

  const onRefresh = () => {
    if (!confirmDiscard()) return;
    closeForm();
    setNotice(null);
    load(null, applied);
  };

  const onNew = () => {
    if (!confirmDiscard()) return;
    closeForm();
    setShowCreate(true);
  };

  const onEdit = (p: Prompt) => {
    if (!confirmDiscard()) return;
    setShowCreate(false);
    setEditing(p);
    const b = {text: p.text, topic: p.topic, tags: p.userTags.join(', '), enabled: p.enabled};
    setBaseline(b);
    setFText(p.text);
    setFTopic(p.topic);
    setFTags(b.tags);
    setFEnabled(p.enabled);
    setFormError(null);
    setConflict(null);
    setRetryAttempt(null);
  };

  const onCancelForm = () => {
    if (!confirmDiscard()) return;
    closeForm();
    setShowCreate(false);
  };

  const onSaveSingle = () => {
    const text = fText.trim();
    const topic = fTopic.trim() || 'General';
    const tags = parseTags(fTags);
    const vErr = validateText(text) || validateTopic(topic) || validateTags(tags);
    if (vErr) {
      setFormError(vErr);
      return;
    }
    const requestId = crypto.randomUUID();
    runAttempt({kind: 'create', requestId, body: {requestId, prompts: [{text, topic, tags, enabled: fEnabled}]}});
  };

  const onSaveBulk = () => {
    const topic = fTopic.trim() || 'General';
    const tags = parseTags(fTags);
    let vErr = validateTopic(topic) || validateTags(tags);
    if (!vErr) {
      if (bulk.lines.length === 0) vErr = 'Add at least one prompt — one per line — then save.';
      else if (bulk.lines.length > MAX_BATCH) vErr = `This batch has ${bulk.lines.length} prompts; the limit is ${MAX_BATCH}. Split it into smaller batches.`;
      else if (bulk.dupes.length > 0) vErr = 'This batch contains duplicate lines. Remove the duplicates listed below — nothing is removed for you.';
      else if (bulk.oversizeCount > 0) vErr = `${bulk.oversizeCount} line${bulk.oversizeCount === 1 ? '' : 's'} exceed the ${MAX_TEXT}-character limit. Shorten them, then save.`;
    }
    if (vErr) {
      setFormError(vErr);
      return;
    }
    const requestId = crypto.randomUUID();
    runAttempt({kind: 'create', requestId, body: {requestId, prompts: bulk.lines.map(text => ({text, topic, tags, enabled: fEnabled}))}});
  };

  const onSaveUpdate = () => {
    if (!editing) return;
    const text = fText.trim();
    const topic = fTopic.trim() || 'General';
    const tags = parseTags(fTags);
    const vErr = validateText(text) || validateTopic(topic) || validateTags(tags);
    if (vErr) {
      setFormError(vErr);
      return;
    }
    const requestId = crypto.randomUUID();
    runAttempt({kind: 'update', promptId: editing.id, requestId, body: {requestId, revision: editing.revision, text, topic, tags, enabled: fEnabled}});
  };

  const onArchive = (p: Prompt) => {
    if (!window.confirm('Archive this prompt? Its versions stay in history and you can restore it anytime. Select OK to archive.')) return;
    const requestId = crypto.randomUUID();
    runAttempt({kind: 'archive', promptId: p.id, requestId, body: {requestId, revision: p.revision}});
  };

  const onRestore = (p: Prompt) => {
    const requestId = crypto.randomUUID();
    runAttempt({kind: 'restore', promptId: p.id, requestId, body: {requestId, revision: p.revision}});
  };

  const onVersions = (p: Prompt) => {
    setVersionsFor(p);
    setVerItems([]);
    setVerCursor(null);
    loadVersions(p, null);
  };

  const onConflictUseServer = () => {
    if (!conflict?.server) return;
    const s = conflict.server;
    if (s.archivedAt) { closeForm(); setNotice('This prompt was archived. Restore it before editing.'); void load(null, applied); return; }
    setEditing(s);
    const b = {text: s.text, topic: s.topic, tags: s.userTags.join(', '), enabled: s.enabled};
    setBaseline(b);
    setFText(s.text);
    setFTopic(s.topic);
    setFTags(b.tags);
    setFEnabled(s.enabled);
    setConflict(null);
    setFormError(null);
  };

  const onConflictKeepMine = () => {
    if (!conflict?.server) return;
    // Reviewed the server copy: adopt only its revision; my field values stay.
    setEditing(conflict.server);
    setConflict(null);
    setFormError(null);
  };

  const onConflictReload = () => {
    setConflict(null);
    closeForm();
    load(null, applied);
  };

  useBlocker({shouldBlockFn: () => execution || suggestions !== null || discovery !== null || role === null ? false : !confirmDiscard(), enableBeforeUnload: () => role !== null && (formDirty() || retryAttempt !== null)});

  const canEdit = role === 'owner' || role === 'admin' || role === 'editor';
  const hasFilter = applied.status !== 'active' || applied.q.trim() !== '' || applied.tag.trim() !== '' || applied.classification !== '';
  const formOpen = showCreate || editing !== null;

  if (discovery !== null) return <PromptDiscoveryPanel key={discovery} projectId={projectId}
    onBack={() => { setDiscovery(null); void backToLibrary(); }}
    onAccessLoss={(status, message) => { purge(); if (status === 401) unauthorizedRef.current(); else setErr(message); }}
    onUse={(questions, topic) => {
      setDiscovery(null); closeForm(); setMode('bulk'); setBulkText(questions.join('\n')); setFTopic(topic); setFEnabled(false); setShowCreate(true);
      setNotice('Review the questions, then save. Saving does not run them.');
      returnFocus.current = null; requestAnimationFrame(() => document.getElementById('pl-bulk')?.focus());
    }} />;
  if (execution) return <PromptExecutionsPanel key={execution.generation} workspaceId={workspaceId} projectId={projectId} userId={userId}
    entry={execution.entry} onBack={() => void backToLibrary()} onUnauthorized={() => { purge(); unauthorizedRef.current(); }} />;
  if (suggestions !== null) return <AiSuggestionsPanel key={suggestions} workspaceId={workspaceId} projectId={projectId} userId={userId}
    onBack={saved => void backFromSuggestions(saved)} onUnauthorized={() => { purge(); unauthorizedRef.current(); }} />;
  if (returning) return <section className="card"><p role="status">Checking access to the prompt library…</p></section>;

  return (
    <section className="card" aria-label="Prompt library">
      <div className="row between">
        <div>
          <h2 ref={libraryHeading} tabIndex={-1}>Prompt library</h2>
          <p className="footnote">Saved prompts stay idle until you start a run. Template discovery is free; model suggestions use provider credits.</p>
        </div>
        <div className="row">
          {canEdit && <button id="pl-discover-prompts" type="button" className="btn primary" onClick={() => openSuggestions(true)} disabled={busy || loading}>Discover prompts</button>}
          {role && <button style={{minHeight:44}} id="pl-suggest-prompts" type="button" className="btn ghost" onClick={() => openSuggestions()} disabled={busy || loading}>Suggest prompts</button>}
          {role && <button id="pl-recent-runs" type="button" className="btn ghost" onClick={() => openExecution({kind: 'history'}, 'pl-recent-runs')} disabled={busy || loading}>Recent runs</button>}
          <button type="button" className="btn ghost" onClick={onRefresh} disabled={busy || loading || loadingMore}>
            Refresh
          </button>
          {canEdit && !formOpen && (
            <button type="button" className="btn ghost" onClick={onNew} disabled={busy || loading}>
              Add prompt
            </button>
          )}
        </div>
      </div>

      {err && (
        <div className="alert" role="alert">
          <p>{err}</p>
          <div className="row">
            <button type="button" className="btn ghost" onClick={() => load(null, applied)} disabled={busy}>
              Reload list
            </button>
            {retryAttempt && (
              <button type="button" className="btn primary" onClick={() => runAttempt(retryAttempt)} disabled={busy}>
                Retry last request
              </button>
            )}
          </div>
        </div>
      )}
      {notice && <div className="banner">{notice}</div>}

      <div className="row">
        <div className="field">
          <label htmlFor="pl-status">Status</label>
          <select id="pl-status" style={{width: '100%'}} value={draft.status} onChange={e => setDraft({...draft, status: e.target.value as StatusFilter})}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="pl-q">Text contains</label>
          <input id="pl-q" maxLength={200} style={{width: '100%'}} value={draft.q} onChange={e => setDraft({...draft, q: e.target.value})} placeholder="Search prompt text" />
        </div>
        <div className="field">
          <label htmlFor="pl-tag">Tag</label>
          <input id="pl-tag" maxLength={80} style={{width: '100%'}} value={draft.tag} onChange={e => setDraft({...draft, tag: e.target.value})} placeholder="Filter by tag" />
        </div>
        <div className="field">
          <label htmlFor="pl-class">Classification</label>
          <select id="pl-class" style={{width: '100%'}} value={draft.classification} onChange={e => setDraft({...draft, classification: e.target.value as ClassFilter})}>
            <option value="">Any</option>
            <option value="branded">Branded</option>
            <option value="unbranded">Unbranded</option>
          </select>
        </div>
      </div>
      <div className="row">
        <button type="button" className="btn primary" onClick={onApply} disabled={busy || loading}>
          Apply filters
        </button>
        <button type="button" className="btn ghost" onClick={onReset} disabled={busy || loading}>
          Reset filters
        </button>
      </div>

      {formOpen && canEdit && (
        <div className="card">
          <h3>{editing ? `Edit prompt (revision ${editing.revision})` : 'New prompt'}</h3>
          {!editing && (
            <div className="row" role="group" aria-label="Entry mode">
              <button type="button" className={mode === 'single' ? 'btn primary' : 'btn ghost'} onClick={() => setMode('single')} disabled={busy || !!retryAttempt}>
                Single
              </button>
              <button type="button" className={mode === 'bulk' ? 'btn primary' : 'btn ghost'} onClick={() => setMode('bulk')} disabled={busy || !!retryAttempt}>
                Bulk
              </button>
            </div>
          )}

          {editing || mode === 'single' ? (
            <div className="field">
              <label htmlFor="pl-text">Prompt text</label>
              <textarea id="pl-text" disabled={busy || !!retryAttempt} style={{width: '100%', minHeight: 96, padding: 8}} value={fText} onChange={e => setFText(e.target.value)} />
              <p className="hint">1–2000 characters, saved with outer whitespace trimmed.</p>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="pl-bulk">Prompts — one per line</label>
              <textarea id="pl-bulk" disabled={busy || !!retryAttempt} style={{width: '100%', minHeight: 160, padding: 8}} value={bulkText} onChange={e => setBulkText(e.target.value)} />
              <p className="hint">Up to {MAX_BATCH} prompts per save. Each line is saved with outer whitespace trimmed.</p>
              {bulkText.trim() !== '' && (
                <div className="hint">
                  <p>
                    {bulk.lines.length} prompt{bulk.lines.length === 1 ? '' : 's'} ready to save
                    {bulk.blank > 0 ? ` (${bulk.blank} blank line${bulk.blank === 1 ? '' : 's'} ignored)` : ''}.
                  </p>
                  {bulk.lines.length > MAX_BATCH && (
                    <p className="alert">This batch has {bulk.lines.length} prompts; the limit is {MAX_BATCH}. Split it into smaller batches.</p>
                  )}
                  {bulk.dupes.length > 0 && (
                    <p className="alert">
                      Duplicate lines: {bulk.dupes.slice(0, 3).map(d => `"${d.length > 60 ? d.slice(0, 60) + '…' : d}"`).join(', ')}
                      {bulk.dupes.length > 3 ? ` and ${bulk.dupes.length - 3} more` : ''}. Remove duplicates — nothing is removed for you.
                    </p>
                  )}
                  {bulk.oversizeCount > 0 && (
                    <p className="alert">
                      {bulk.oversizeCount} line{bulk.oversizeCount === 1 ? '' : 's'} over the {MAX_TEXT}-character limit. Shorten them before saving.
                    </p>
                  )}
                  <ol className="mono">
                    {bulk.lines.slice(0, 10).map((l, i) => (
                      <li key={i}>{l.length > 120 ? l.slice(0, 120) + '…' : l}</li>
                    ))}
                  </ol>
                  {bulk.lines.length > 10 && <p>…and {bulk.lines.length - 10} more.</p>}
                </div>
              )}
            </div>
          )}

          <div className="field">
            <label htmlFor="pl-topic">Topic</label>
            <input id="pl-topic" disabled={busy || !!retryAttempt} style={{width: '100%'}} value={fTopic} onChange={e => setFTopic(e.target.value)} placeholder="General" />
            <p className="hint">Up to {MAX_TOPIC} characters. Leave blank to use General.</p>
          </div>
          <div className="field">
            <label htmlFor="pl-tags">Tags</label>
            <textarea id="pl-tags" disabled={busy || !!retryAttempt} style={{width: '100%', minHeight: 56, padding: 8}} value={fTags} onChange={e => setFTags(e.target.value)} placeholder="comma, separated, or one per line" />
            <p className="hint">
              Up to {MAX_TAGS} tags, each up to {MAX_TAG_LEN} characters.
              {!editing && mode === 'bulk' ? ' Applied to every prompt in this batch.' : ''}
            </p>
          </div>
          <div className="field">
            <label htmlFor="pl-enabled">
              <input style={{width: 'auto'}} id="pl-enabled" disabled={busy || !!retryAttempt} type="checkbox" checked={fEnabled} onChange={e => setFEnabled(e.target.checked)} /> Include when tracking is configured
            </label>
            <p className="hint">Saving prompts does not run them. Choose Review a run, then Recurring prompt tracking. Scheduling requires explicit owner approval.</p>
          </div>

          {conflict && (
            <div className="alert" role="alert">
              <p>Your save was rejected. Your edits above are unchanged. Review the saved copy and resolve the reported conflict before trying again.</p>
              {conflict.server ? (
                <>
                  <p className="dim">Saved version on the server (revision {conflict.server.revision}):</p>
                  <div className="mono" style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{conflict.server.text}</div>
                  <div className="row">
                    <button type="button" className="btn ghost" onClick={onConflictUseServer} disabled={busy}>
                      Use saved version (discard my edits)
                    </button>
                    <button type="button" className="btn primary" onClick={onConflictKeepMine} disabled={busy || !!conflict.server.archivedAt}>
                      Keep my text and continue editing
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="dim">The saved version could not be loaded for review.</p>
                  <div className="row">
                    <button type="button" className="btn ghost" onClick={onConflictReload} disabled={busy}>
                      Reload list (discard my edits)
                    </button>
                    <button type="button" className="btn primary" onClick={() => setConflict(null)} disabled={busy}>
                      Keep editing
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {formError && (
            <div className="alert" role="alert">
              <p>{formError}</p>
              {retryAttempt && (
                <button type="button" className="btn primary" onClick={() => runAttempt(retryAttempt)} disabled={busy}>
                  Retry save
                </button>
              )}
            </div>
          )}

          <div className="row">
            <button type="button" className="btn primary" onClick={editing ? onSaveUpdate : mode === 'single' ? onSaveSingle : onSaveBulk} disabled={busy || !!retryAttempt || !!conflict}>
              {busy ? 'Saving…' : editing ? 'Save changes' : mode === 'single' ? 'Save prompt' : 'Save prompts'}
            </button>
            <button type="button" className="btn ghost" onClick={onCancelForm} disabled={busy}>
              Cancel
            </button>
          </div>
          {editing && <p className="footnote">Saving a text change adds a new version. Earlier versions stay in history under View versions.</p>}
        </div>
      )}

      {loading ? (
        <p className="dim">Loading prompts…</p>
      ) : items.length === 0 && !err ? (
        <p className="dim">
          {hasFilter ? 'No prompts match these filters. Adjust them and apply again.' : canEdit ? 'No prompts yet. Use "Add prompt" to create the first one.' : 'No prompts yet.'}
        </p>
      ) : (
        <>
        <p id="pl-table-hint" className="hint">On narrow screens, scroll across for details and actions. Focus the table and use the arrow keys.</p>
        <div className="table-wrap prompt-table" role="region" aria-label="Prompt library table" aria-describedby="pl-table-hint" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th>Text</th>
                <th>Topic</th>
                <th>Tags</th>
                <th>Classification</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map(p => (
                <tr key={p.id}>
                  <td>
                    <div className="mono" style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>
                      {p.text.length > 160 ? p.text.slice(0, 160) + '…' : p.text}
                    </div>
                  </td>
                  <td>{p.topic}</td>
                  <td>
                    {p.userTags.length > 0 ? (
                      <span className="row">
                        {p.userTags.map(t => (
                          <span key={t} className="pill">
                            {t}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td>
                    <span className="pill">{p.classification.isBranded ? 'Branded' : 'Unbranded'}</span>
                    {p.classification.isOverridden && <div className="dim">overridden by your {p.classification.isBranded ? 'branded' : 'unbranded'} tag</div>}
                  </td>
                  <td>
                    <span className="pill">{p.archivedAt ? 'Archived' : 'Active'}</span>
                    {p.enabled && <div className="dim">tracking preference on</div>}
                  </td>
                  <td>
                    <div className="row">
                      {canEdit && !p.archivedAt && <button id={`pl-run-${p.id}`} type="button" className="btn ghost"
                        onClick={() => openExecution({kind: 'configure', promptId: p.id, versionId: p.currentVersionId, authoredText: p.text}, `pl-run-${p.id}`)} disabled={busy}>Review a run</button>}
                      <small>Model answers via OpenRouter</small>
                      {onAISearch&&<button type="button" className="btn ghost" disabled={busy} onClick={()=>onAISearch(p.id,null,false)}>View web queries</button>}
                      {onAISearch&&canEdit&&!p.archivedAt&&<button type="button" className="btn ghost" disabled={busy||!!retryAttempt} onClick={()=>onAISearch(p.id,p.currentVersionId,true)}>Capture AI search</button>}
                      <button type="button" className="btn ghost" onClick={() => onVersions(p)} disabled={busy}>
                        View versions
                      </button>
                      {canEdit && !p.archivedAt && (
                        <button type="button" className="btn ghost" onClick={() => onEdit(p)} disabled={busy || !!retryAttempt}>
                          Edit
                        </button>
                      )}
                      {canEdit &&
                        (p.archivedAt ? (
                          <button type="button" className="btn ghost" onClick={() => onRestore(p)} disabled={busy || !!retryAttempt}>
                            Restore
                          </button>
                        ) : (
                          <button type="button" className="btn ghost" onClick={() => onArchive(p)} disabled={busy || !!retryAttempt}>
                            Archive
                          </button>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      {!loading && nextCursor && (
        <button type="button" className="btn ghost" onClick={() => load(nextCursor, applied)} disabled={loadingMore || busy}>
          {loadingMore ? 'Loading…' : 'Load more prompts'}
        </button>
      )}
      <p className="footnote">
        Classification is automatic. Your own branded or unbranded tag overrides it — exactly one of the two wins; with both or neither, the automatic result
        applies.
      </p>

      {versionsFor && (
        <div className="card">
          <div className="row between">
            <h3>Version history — {versionsFor.topic}</h3>
            <button type="button" className="btn ghost" onClick={closeVersions}>
              Close
            </button>
          </div>
          <p className="hint">Read-only history. Every text change adds a version; none are overwritten or deleted. Archiving keeps this history.</p>
          {verErr && (
            <div className="alert" role="alert">
              <p>{verErr}</p>
              <button type="button" className="btn ghost" onClick={() => loadVersions(versionsFor, null)}>
                Reload versions
              </button>
            </div>
          )}
          {verLoading && verItems.length === 0 ? (
            <p className="dim">Loading versions…</p>
          ) : verItems.length === 0 && !verErr ? (
            <p className="dim">No versions found.</p>
          ) : (
            <ol>
              {verItems.map(v => (
                <li key={v.id}>
                  <div className="row between">
                    <strong>Version {v.number}</strong>
                    <span className="dim">{fmtDate(v.createdAt)}</span>
                  </div>
                  <div className="mono" style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>
                    {v.text}
                  </div>
                  {canEdit && !versionsFor.archivedAt && <button id={`pl-version-run-${v.id}`} type="button" className="btn ghost"
                    onClick={() => openExecution({kind: 'configure', promptId: versionsFor.id, versionId: v.id, authoredText: v.text}, `pl-version-run-${v.id}`)} disabled={busy}>Review this version</button>}
                  {onAISearch&&<button type="button" className="btn ghost" disabled={busy} onClick={()=>onAISearch(versionsFor.id,v.id,false)}>View this version’s web queries</button>}
                  {onAISearch&&canEdit&&!versionsFor.archivedAt&&<button type="button" className="btn ghost" disabled={busy||!!retryAttempt} onClick={()=>onAISearch(versionsFor.id,v.id,true)}>Capture this saved version</button>}
                </li>
              ))}
            </ol>
          )}
          {verCursor && (
            <button type="button" className="btn ghost" onClick={() => loadVersions(versionsFor, verCursor)} disabled={verLoading}>
              {verLoading ? 'Loading…' : 'Load more versions'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
