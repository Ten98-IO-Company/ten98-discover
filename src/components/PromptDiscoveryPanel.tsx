import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import {Alert, Button, Card, Checkbox, Disclosure, Field, Grid, Heading, Inline, Input, Option, Select, Stack, StatusLine, Text, useConfirmDialog} from '@ten98/ui'
import {useBlocker} from '@tanstack/react-router';
import {z} from 'zod';
import {api, ApiError, errMsg} from '../lib/api';
import {buildPromptQuestions, promptDiscoveryIntents, type PromptDiscoveryIntent} from '../lib/prompt-discovery';
import {workspaceRoles} from '@ten98/runtime/browser';

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
const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ');

export function PromptDiscoveryPanel(props: Props) {
  return <DiscoveryPanel key={props.projectId} {...props}/>;
}
function DiscoveryPanel({projectId, onUse, onBack, onAccessLoss}: Props) {
  const id = useId(), heading = useRef<HTMLHeadingElement>(null), errorFocus = useRef<HTMLElement>(null);
  const [confirm, confirmDialog] = useConfirmDialog({ danger: true });
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
  // Alert takes no ref yet (design-system issue), so focus moves to the alert element itself through its wrapper.
  useEffect(() => { if (error) errorFocus.current?.querySelector<HTMLElement>('[role="alert"]')?.focus(); }, [error]);

  async function build(event: FormEvent) {
    event.preventDefault();
    try {
      const next = buildPromptQuestions({topic, audience, intent, brand, competitor: competitorName});
      if (questions.length && !await confirm({title: 'Replace the current starter questions?', description: 'Your selections will reset.', confirmLabel: 'Replace questions', danger: false, initialFocus: 'cancel'})) return;
      setQuestions(next); setSelected(next.map((_, index) => index)); setGenerated({signature, topic: normalize(topic)}); setError('');
    } catch (cause) { setError(errMsg(cause)); }
  }
  function review() {
    if (!generated || stale || !selected.length || lost) return;
    leaving.current = true;
    onUse(questions.filter((_, index) => selected.includes(index)), generated.topic);
  }

  return <Card as="section" aria-label="Prompt discovery">
    <Stack>
      <Inline justify="between"><Heading level={2} ref={heading} tabIndex={-1}>Discover prompts</Heading><Button variant="ghost" type="button" onClick={() => { if (confirmLeave()) { leaving.current = true; onBack(); } }}>Back to saved prompts</Button></Inline>
      <Text>Create starter questions in English, then review and save them. Free to use; these questions do not represent measured search demand.</Text>
      {loading && <StatusLine busy>Loading saved topics and competitors…</StatusLine>}
      {readError && <Stack><Alert tone="danger" variant="banner">{readError}</Alert>{!lost && <Inline><Button variant="ghost" type="button" disabled={loading} onClick={() => void loadContext()}>Reload saved topics</Button></Inline>}</Stack>}
      {!lost && <>
        <Stack as="form" noValidate onSubmit={build}>
          <Field label="Topic" htmlFor={id + '-topic'} description="Product, service or subject. Up to 100 characters.">
            <Input id={id + '-topic'} value={topic} maxLength={100} required onChange={event => setTopic(event.target.value)} placeholder="For example, customer support software"/>
          </Field>
          {topic.trim().length > 100 && <Alert tone="danger" variant="inline">Shorten this saved topic to 100 characters before building questions.</Alert>}
          {!!topics.length && <Field label="Saved page topics" htmlFor={id + '-saved-topic'} description="Replaces the Topic field.">
            <Select id={id + '-saved-topic'} value="" onChange={event => setTopic(event.target.value)}><Option value="">Choose a saved topic</Option>{topics.map(value => <Option key={value} value={value}>{value}</Option>)}</Select>
          </Field>}
          <Grid columns="auto" minItemWidth="md">
            <Field label="Audience (optional)" htmlFor={id + '-audience'}><Input id={id + '-audience'} value={audience} maxLength={100} onChange={event => setAudience(event.target.value)} placeholder="For example, small businesses"/></Field>
            <Field label="Question intent" htmlFor={id + '-intent'}><Select id={id + '-intent'} value={intent} onChange={event => setIntent(event.target.value as PromptDiscoveryIntent)}>{promptDiscoveryIntents.map(value => <Option key={value} value={value}>{intentNames[value]}</Option>)}</Select></Field>
          </Grid>
          {context && <Disclosure summary="Optional saved context" variant="plain"><Stack><Checkbox checked={includeBrand} onChange={event => setIncludeBrand(event.target.checked)} label={`Include saved brand: ${context.profile.name}`}/>{!!context.competitors.length && <Field label="Competitor (optional)" htmlFor={id + '-competitor'}><Select id={id + '-competitor'} value={competitorId} onChange={event => setCompetitorId(event.target.value)}><Option value="">No competitor</Option>{context.competitors.map(value => <Option key={value.id} value={value.id}>{value.name || value.primaryDomain}</Option>)}</Select></Field>}<Text tone="muted" size="sm">Selected names are added to the questions.</Text></Stack></Disclosure>}
          {error && <Stack ref={errorFocus}><Alert tone="danger" tabIndex={-1}>{error}</Alert></Stack>}
          <Inline><Button type="submit" variant="primary">Build starter questions</Button></Inline>
        </Stack>
        {generated && <Card aria-label="Starter questions">
          <Stack>
            <Heading level={3}>Choose starter questions</Heading>
            <Text>Edit selected questions before saving. Saving does not run them or start tracking.</Text>
            {stale && <Alert tone="warning" variant="inline" role="status">Inputs changed. Rebuild the questions to continue.</Alert>}
            <Inline><Button variant="ghost" type="button" onClick={() => setSelected(questions.map((_, index) => index))}>Select all</Button><Button variant="ghost" type="button" onClick={() => setSelected([])}>Clear selection</Button></Inline>
            {questions.map((question, index) => <Checkbox key={index} label={question} checked={selected.includes(index)} onChange={event => setSelected(previous => event.target.checked ? [...previous, index] : previous.filter(value => value !== index))}/>)}
            <Inline><Button variant="primary" type="button" disabled={stale || selected.length === 0} onClick={review}>Review selected prompts</Button><Text as="span" tone="muted" size="sm">{selected.length} selected</Text></Inline>
          </Stack>
        </Card>}
      </>}
      {confirmDialog}
    </Stack>
  </Card>;
}
