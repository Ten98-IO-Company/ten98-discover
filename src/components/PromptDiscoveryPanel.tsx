import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {z} from 'zod';
import {api, ApiError, errMsg} from '../lib/api';
import {buildPromptQuestions, promptDiscoveryIntents, type PromptDiscoveryIntent} from '../lib/prompt-discovery';
import {workspaceRoles} from '@ten98/runtime';
import {useConfirmDialog} from './useConfirmDialog';

type Props = {projectId: string; onUse: (questions: string[], topic: string) => void; onBack: () => void; onAccessLoss: (status: number, message: string) => void};
const text = (maximum: number) => z.string().max(maximum).refine(value => !value.includes('\0') && new TextDecoder().decode(new TextEncoder().encode(value)) === value);
const contextSchema = z.object({
  project: z.object({id: z.uuid()}),
  role: z.enum(workspaceRoles),
  profile: z.object({name: text(120).min(1)}),
  keyPages: z.array(z.object({topic: text(200).nullable()})).max(100),
  competitors: z.array(z.object({id: z.uuid(), name: text(120).nullable(), primaryDomain: text(253).min(1)})).max(100),
});
type Context = z.infer<typeof contextSchema>;
const intentNames: Record<PromptDiscoveryIntent, string> = {learn: 'Learn about a topic', compare: 'Compare options', choose: 'Choose a solution', use: 'Use a solution'};
const control = {minHeight: 44, width: '100%', minWidth: 0};
const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ');

export function PromptDiscoveryPanel(props: Props) {
  return <DiscoveryPanel key={props.projectId} {...props}/>;
}
function DiscoveryPanel({projectId, onUse, onBack, onAccessLoss}: Props) {
  const id = useId(), heading = useRef<HTMLHeadingElement>(null), errorFocus = useRef<HTMLParagraphElement>(null);
  const [confirm, confirmDialog] = useConfirmDialog();
  const [topic, setTopic] = useState(''), [audience, setAudience] = useState(''), [intent, setIntent] = useState<PromptDiscoveryIntent>('learn');
  const [context, setContext] = useState<Context | null>(null), [loading, setLoading] = useState(true), [readError, setReadError] = useState(''), [lost, setLost] = useState(false);
  const [includeBrand, setIncludeBrand] = useState(false), [competitorId, setCompetitorId] = useState('');
  const [questions, setQuestions] = useState<string[]>([]), [selected, setSelected] = useState<number[]>([]), [generated, setGenerated] = useState<{signature: string; topic: string} | null>(null), [error, setError] = useState('');
  const mounted = useRef(false), generation = useRef(0), request = useRef<AbortController | null>(null), leaving = useRef(false), accessLoss = useRef(onAccessLoss);
  accessLoss.current = onAccessLoss;
  const brand = includeBrand ? context?.profile.name ?? '' : '';
  const competitor = context?.competitors.find(value => value.id === competitorId);
  const competitorName = competitor ? competitor.name || competitor.primaryDomain : '';
  const signature = JSON.stringify([topic, audience, intent, brand, competitorName]);
  const stale = generated !== null && generated.signature !== signature;
  const topics = [...new Set(context?.keyPages.map(page => normalize(page.topic ?? '')).filter(Boolean) ?? [])];
  const dirty = () => !lost && !!(topic.trim() || audience.trim() || intent !== 'learn' || includeBrand || competitorId || questions.length);
  const confirmLeave = () => leaving.current || !dirty() || window.confirm('Discard your unsaved prompt discovery draft?');
  useBlocker({shouldBlockFn: () => !confirmLeave(), enableBeforeUnload: () => !leaving.current && dirty()});

  function loseAccess(status: number, message: string) {
    leaving.current = true;
    setContext(null); setTopic(''); setAudience(''); setIncludeBrand(false); setCompetitorId(''); setQuestions([]); setSelected([]); setGenerated(null); setError(''); setReadError(message); setLost(true);
    accessLoss.current(status, message);
  }
  async function loadContext() {
    request.current?.abort();
    const ownGeneration = ++generation.current, controller = new AbortController();
    request.current = controller;
    setContext(null); setIncludeBrand(false); setCompetitorId(''); setReadError(''); setLoading(true);
    try {
      const value = await api<unknown>(`/api/projects/${encodeURIComponent(projectId)}/context`, {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])});
      if (!mounted.current || ownGeneration !== generation.current || controller.signal.aborted) return;
      const parsed = contextSchema.safeParse(value);
      if (!parsed.success || parsed.data.project.id !== projectId || new Set(parsed.data.competitors.map(item => item.id)).size !== parsed.data.competitors.length) throw new Error('Could not load saved project details.');
      if (parsed.data.role === 'viewer') { loseAccess(403, 'You no longer have permission to save prompts in this project.'); return; }
      setContext(parsed.data);
    } catch (cause) {
      if (!mounted.current || ownGeneration !== generation.current || controller.signal.aborted) return;
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
        loseAccess(cause.status, cause.status === 401 ? 'Your session expired. Sign in again.' : 'Project access is unavailable.');
      } else setReadError(`${errMsg(cause)} You can still enter a topic manually.`);
    } finally {
      if (mounted.current && ownGeneration === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    void loadContext();
    return () => { mounted.current = false; generation.current++; request.current?.abort(); };
    // Project changes remount the keyed panel and discard its scoped state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (error) errorFocus.current?.focus(); }, [error]);

  async function build(event: FormEvent) {
    event.preventDefault();
    try {
      const next = buildPromptQuestions({topic, audience, intent, brand, competitor: competitorName});
      if (questions.length && !await confirm({title: 'Replace the current starter questions?', description: 'Your selections will reset.', confirmLabel: 'Replace questions', danger: false})) return;
      setQuestions(next); setSelected(next.map((_, index) => index)); setGenerated({signature, topic: normalize(topic)}); setError('');
    } catch (cause) { setError(errMsg(cause)); }
  }
  function review() {
    if (!generated || stale || !selected.length || lost) return;
    leaving.current = true;
    onUse(questions.filter((_, index) => selected.includes(index)), generated.topic);
  }

  return <section className="card stack" aria-label="Prompt discovery">
    <div className="row between"><div><h2 ref={heading} tabIndex={-1}>Discover prompts</h2></div><button className="btn ghost" style={{minHeight: 44}} type="button" onClick={() => { if (confirmLeave()) { leaving.current = true; onBack(); } }}>Back to saved prompts</button></div>
    <p>Create starter questions in English, then review and save them. Free to use; these questions do not represent measured search demand.</p>
    {loading && <p role="status">Loading saved topics and competitors…</p>}
    {readError && <div className="banner"><p role="alert">{readError}</p>{!lost && <button className="btn ghost" type="button" style={{minHeight: 44}} disabled={loading} onClick={() => void loadContext()}>Reload saved topics</button>}</div>}
    {!lost && <>
      <form className="stack" noValidate onSubmit={build}>
        <div className="field"><label htmlFor={id + '-topic'}>Topic</label><input id={id + '-topic'} value={topic} maxLength={100} required style={control} onChange={event => setTopic(event.target.value)} placeholder="For example, customer support software"/><p className="hint">Product, service or subject. Up to 100 characters.</p>{topic.trim().length > 100 && <p role="alert">Shorten this saved topic to 100 characters before building questions.</p>}</div>
        {!!topics.length && <div className="field"><label htmlFor={id + '-saved-topic'}>Saved page topics</label><select id={id + '-saved-topic'} value="" style={control} onChange={event => setTopic(event.target.value)}><option value="">Choose a saved topic</option>{topics.map(value => <option key={value} value={value}>{value}</option>)}</select><p className="hint">Replaces the Topic field.</p></div>}
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,240px),1fr))', gap: 'var(--space-3, 12px)'}}>
          <div className="field"><label htmlFor={id + '-audience'}>Audience (optional)</label><input id={id + '-audience'} value={audience} maxLength={100} style={control} onChange={event => setAudience(event.target.value)} placeholder="For example, small businesses"/></div>
          <div className="field"><label htmlFor={id + '-intent'}>Question intent</label><select id={id + '-intent'} value={intent} style={control} onChange={event => setIntent(event.target.value as PromptDiscoveryIntent)}>{promptDiscoveryIntents.map(value => <option key={value} value={value}>{intentNames[value]}</option>)}</select></div>
        </div>
        {context && <details><summary>Optional saved context</summary><div className="stack"><label style={{display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, overflowWrap: 'anywhere'}}><input type="checkbox" checked={includeBrand} onChange={event => setIncludeBrand(event.target.checked)}/>Include saved brand: {context.profile.name}</label>{!!context.competitors.length && <div className="field"><label htmlFor={id + '-competitor'}>Competitor (optional)</label><select id={id + '-competitor'} value={competitorId} style={control} onChange={event => setCompetitorId(event.target.value)}><option value="">No competitor</option>{context.competitors.map(value => <option key={value.id} value={value.id}>{value.name || value.primaryDomain}</option>)}</select></div>}<p className="hint">Selected names are added to the questions.</p></div></details>}
        {error && <p className="alert" role="alert" ref={errorFocus} tabIndex={-1}>{error}</p>}
        <div className="row"><button type="submit" className="btn primary" style={{minHeight: 44}}>Build starter questions</button></div>
      </form>
      {generated && <div className="card stack" aria-label="Starter questions"><h3>Choose starter questions</h3><p>Edit selected questions before saving. Saving does not run them or start tracking.</p>{stale && <p className="banner" role="status">Inputs changed. Rebuild the questions to continue.</p>}<div className="row"><button className="btn ghost" type="button" style={{minHeight: 44}} onClick={() => setSelected(questions.map((_, index) => index))}>Select all</button><button className="btn ghost" type="button" style={{minHeight: 44}} onClick={() => setSelected([])}>Clear selection</button></div>{questions.map((question, index) => <label key={index} className="card" style={{display: 'flex', alignItems: 'flex-start', gap: 12, minHeight: 44, padding: 'var(--space-3, 12px)', overflowWrap: 'anywhere'}}><input type="checkbox" checked={selected.includes(index)} onChange={event => setSelected(previous => event.target.checked ? [...previous, index] : previous.filter(value => value !== index))}/><span>{question}</span></label>)}<div className="row"><button className="btn primary" type="button" style={{minHeight: 44}} disabled={stale || selected.length === 0} onClick={review}>Review selected prompts</button><span className="hint">{selected.length} selected</span></div></div>}
    </>}
    {confirmDialog}
  </section>;
}
