import type {ReactNode} from 'react';
import {Alert, Badge, Button, Card, Disclosure, Heading, Inline, Link, List, ListItem, Stack, Text, useDisplayFormat} from '@ten98/ui';
import type {OpportunitiesDetailDto, OpportunitiesListDto, OpportunitiesSourceDto} from '../lib/ai-opportunities-api.ts';
import type {OpportunitiesReport} from '../lib/ai-opportunities.ts';
import {citationSafeHref} from '../lib/citation-report.ts';

export type RecommendationCategory = 'all' | OpportunitiesReport['opportunities'][number]['category'];
export type AIRecommendationsViewProps = {
  prefix: string;
  history: OpportunitiesListDto | null;
  detail: OpportunitiesDetailDto | null;
  source: OpportunitiesSourceDto | null;
  selectedRunId: string | null;
  category: RecommendationCategory;
  readingHistory: boolean; readingDetail: boolean; readingSource: boolean;
  running: boolean; actionBusy: boolean; canRun: boolean;
  historyError: string | null; detailError: string | null;
  sourceError: string | null; runError: string | null;
  setupControls: ReactNode;
  actionFeedback?: ReactNode;
  onRun: () => void;
  onOpenSetup?: () => void;
  onSelectRun: (id: string) => void;
  onCategoryChange: (category: RecommendationCategory) => void;
  onReload: () => void;
  onMoreHistory?: () => void;
  onPreviousHistory?: () => void;
  onCancel?: (id: string) => void;
  onRecover?: (id: string) => void;
};

const categories = [
  ['all', 'All'], ['creation', 'Creation'], ['existing-content', 'Existing content'],
  ['outreach', 'Outreach'], ['social', 'Social'],
] as const;
const statusCopy = {
  queued: 'Queued. This request is waiting to start.',
  running: 'Running. Recommendations will appear when this request finishes.',
  failed: 'Failed. This request did not produce a completed report.',
  uncertain: 'Outcome unknown. This request will not be replayed automatically. Other work can continue.',
  cancelled: 'Cancelled. This request did not produce a completed report.',
};

export function AIRecommendationsView(props: AIRecommendationsViewProps) {
  const format = useDisplayFormat();
  const {prefix, history, detail, selectedRunId, category} = props;
  const run = history && detail?.projectId === history.projectId && detail.run.id === selectedRunId ? detail.run : null;
  const source = history && props.source?.projectId === history.projectId ? props.source : null;
  const canRun = history?.canPrepare === true && props.canRun && !props.running && !props.actionBusy && !props.readingSource && source?.availability === 'available' && !props.sourceError;
  const canAct = history?.canPrepare === true && !props.actionBusy;
  const saved = run?.available ? run.savedEvidence : null;
  const report = run?.status === 'completed' && run.available && saved ? run.report : null;
  const recommendations = report?.opportunities.filter(item => category === 'all' || item.category === category) ?? [];
  return <Stack as="section" gap={3} aria-labelledby={prefix + 'heading'}>
    <Inline gap={2} justify="between">
      <Heading level={2} id={prefix + 'heading'} tabIndex={-1}>Recommendations</Heading>
      <Inline gap={2}>
        {history?.canPrepare && props.onOpenSetup && <Button variant="ghost" disabled={props.actionBusy} onClick={() => {if (!props.actionBusy) props.onOpenSetup?.();}}>Model and source</Button>}
        <Button type="button" disabled={!canRun} loading={props.running} onClick={() => {if (canRun) props.onRun();}}>Run recommendations</Button>
      </Inline>
    </Inline>
    <Text tone="muted" size="sm">Unverified AI suggestions from retained API answers. Review the evidence before acting.</Text>
    {history && props.actionFeedback}
    {props.runError && <Alert tone="danger" title="Recommendations could not start">{props.runError}</Alert>}
    {props.detailError && <Alert tone="danger" title="Selected report could not load">{props.detailError}</Alert>}
    {props.readingDetail && <Text role="status">Loading selected report…</Text>}
    {run && <Stack as="section" gap={3} aria-labelledby={prefix + 'selected'}>
      <Inline gap={2} justify="between">
        <Heading level={3} id={prefix + 'selected'}>Selected report</Heading>
        <Badge tone={run.status === 'completed' ? 'success' : run.status === 'failed' || run.status === 'uncertain' ? 'warning' : 'neutral'}>{run.status}</Badge>
      </Inline>
      {run.status !== 'completed' && <Text role="status">{statusCopy[run.status]}</Text>}
      {run.diagnostic && <Text>{run.diagnostic}</Text>}
      {(run.status === 'queued' && props.onCancel || run.canRecover && props.onRecover) && <Inline gap={2}>
        {run.status === 'queued' && props.onCancel && <Button variant="secondary" disabled={!canAct} onClick={() => {if (canAct) props.onCancel?.(run.id);}}>Cancel queued request</Button>}
        {run.canRecover && props.onRecover && <Button variant="secondary" disabled={!canAct} onClick={() => {if (canAct) props.onRecover?.(run.id);}}>Check original request</Button>}
      </Inline>}
      {run.status === 'completed' && !run.available && <Alert tone="warning" title="Report evidence unavailable or expired">This completed request remains in history, but its retained report evidence is no longer available.</Alert>}
      {run.available && run.status === 'completed' && (!saved || !run.report) && <Alert tone="warning" title="Report evidence unavailable">The saved report cannot be displayed without its retained evidence.</Alert>}
      {report && <>
        {report.opportunities.length === 0 && <Alert title="No recommendations in this completed report">The model returned no recommendations for the supplied retained answers.</Alert>}
        <Inline gap={2} role="group" aria-label="Recommendation categories">{categories.map(([value, label]) => <Button key={value} variant="secondary" pressed={category === value} onClick={() => props.onCategoryChange(value)}>{label} ({value === 'all' ? report.opportunities.length : report.opportunities.filter(item => item.category === value).length})</Button>)}</Inline>
        {report.opportunities.length > 0 && (recommendations.length === 0 ? <Text>No recommendations in this category.</Text> : recommendations.map(item => {
          const ids = [...new Set([...item.evidenceIds, ...item.targetEvidenceId ? [item.targetEvidenceId] : []])];
          const citations = ids.map(id => saved!.citations.find(citation => citation.id === id && item.promptIds.includes(citation.promptId)));
          return <Card as="article" headingLevel={4} key={item.priority} title={<Text as="span">{item.priority}. {item.title}</Text>} description={categories.find(([key]) => key === item.category)?.[1]}>
            <Text><Text as="strong" weight="semibold">Why this recommendation</Text></Text><Text>{item.why}</Text>
            <Disclosure summary={`Related prompts (${item.promptIds.length})`} variant="plain"><List gap={2}>{item.promptIds.map(id => {
              const prompt = saved!.prompts.find(candidate => candidate.id === id);
              return <ListItem key={id}>{prompt ? <><Text as="span">{prompt.text}</Text><Text tone="muted" size="sm">Saved prompt version</Text></> : 'Related prompt evidence unavailable.'}</ListItem>;
            })}</List></Disclosure>
            {(['brand', 'competitor', 'other'] as const).map(owner => {
              const group = citations.filter(citation => owner === 'other' ? !citation || !['brand', 'competitor'].includes(citation.ownership) : citation?.ownership === owner);
              if (owner === 'other' && !group.length) return null;
              return <Disclosure key={owner} summary={`${owner === 'brand' ? 'Your citations' : owner === 'competitor' ? 'Competitor citations' : 'Other retained evidence'} (${group.length})`} variant="plain">
                {group.length === 0 ? <Text>No retained citations linked in this group.</Text> : <List gap={2}>{group.map((citation, i) => {
                  const href = citation && citationSafeHref(citation.url);
                  return <ListItem key={citation?.id ?? `unavailable-${i}`}>{citation && href ? <><Link href={href} target="_blank" rel="noopener noreferrer">{citation.title || citation.url}</Link><Text tone="muted" size="sm">{citation.ownership} · {citation.publisherCategory}{citation.id === item.targetEvidenceId ? ' · Suggested target' : ''}</Text></> : 'Retained citation evidence unavailable.'}</ListItem>;
                })}</List>}
              </Disclosure>;
            })}
          </Card>;
        }))}
        {report.summary.length > 0 && <Stack as="section" gap={2}><Heading level={4}>Summary</Heading><List gap={2}>{report.summary.map((text, i) => <ListItem key={i}>{text}</ListItem>)}</List></Stack>}
        {report.risks.length > 0 && <Disclosure summary="Reality check" defaultOpen variant="plain"><List gap={2}>{report.risks.map((risk, i) => <ListItem key={i}>{risk}</ListItem>)}</List></Disclosure>}
      </>}
      <Text tone="muted" size="sm">{run.route.model || 'Model unavailable'} · {run.route.provider || 'Provider unavailable'} · Requested {format.dateTime(run.createdAt)}{run.completedAt ? ` · Finished ${format.dateTime(run.completedAt)}` : ''}</Text>
      {saved && <Disclosure summary="Saved report scope" variant="plain">
        <Text>{saved.scope.from} to {saved.scope.to} · {saved.scope.timeZone} · {saved.scope.model || 'All source models'}</Text>
        <Text>Prompt: {saved.scope.promptId ? saved.prompts.find(prompt => prompt.id === saved.scope.promptId)?.text ?? 'Saved prompt unavailable' : 'All saved prompts'} · Tag: {saved.scope.tag || 'All tags'}</Text>
        <Text tone="muted" size="sm">{saved.scope.matcher === 'unicode-boundary-v1' ? 'Whole-word matching' : 'Substring matching'}. {saved.prompts.length} saved prompt versions; {saved.citations.length} retained citations.</Text>
        <Text tone="muted" size="sm">API answers do not measure consumer chats, search demand or website content. Recommendations use this saved selection.</Text>
      </Disclosure>}
    </Stack>}
    {history && <Stack gap={3}>{props.setupControls}</Stack>}
    {props.sourceError && <Alert tone="warning" title="Current source unavailable">{props.sourceError} Saved reports remain available.</Alert>}
    {props.readingSource && <Text role="status">Checking retained answers…</Text>}
    {source && <Disclosure summary="Current answer coverage" variant="plain">
      <Text>{source.coverage.eligible} eligible of {source.coverage.attempted} attempted answers; {source.prompts} saved prompts and {source.citations} retained citations.</Text>
      <Text tone="muted" size="sm">Checked {format.dateTime(source.asOf)}. Coverage applies to the current selection.</Text>
      {source.warnings.length > 0 && <List gap={2}>{source.warnings.map((warning, i) => <ListItem key={i}>{warning}</ListItem>)}</List>}
    </Disclosure>}
    {!props.readingSource && !props.sourceError && source?.availability === 'insufficient-evidence' && <Alert tone="info" title="No eligible retained answers">Choose a selection with retained API answers before running recommendations.</Alert>}
    {history && !source && !props.readingSource && !props.sourceError && <Alert tone="info" title="Current answer source unavailable">Reload the answer selection to prepare a new report. Saved reports remain available.</Alert>}
    {props.historyError && <Alert tone="danger" title="Report history could not load">{props.historyError}</Alert>}
    {props.readingHistory && <Text role="status">Loading report history…</Text>}
    <Disclosure key={run ? 'selected-history' : 'open-history'} summary="Previous reports" variant="plain" defaultOpen={!run}>
      <Stack gap={3}>
        <Button variant="ghost" disabled={props.readingHistory} onClick={() => {if (!props.readingHistory) props.onReload();}}>Refresh reports</Button>
      {history?.runs.length === 0 && !props.readingHistory && <Text>No saved reports yet. Run recommendations when retained answers are available.</Text>}
      {history && history.runs.length > 0 && <List gap={3}>{history.runs.map(item => <ListItem key={item.id}>
        <Button variant="ghost" pressed={selectedRunId === item.id} onClick={() => props.onSelectRun(item.id)}>
          {format.dateTime(item.createdAt)} · {item.route.model || 'Model unavailable'} · {item.status}
        </Button>
      </ListItem>)}</List>}
      {history?.nextCursor && props.onMoreHistory && <Button variant="secondary" disabled={props.readingHistory} onClick={() => {if (!props.readingHistory) props.onMoreHistory?.();}}>More reports</Button>}
      {props.onPreviousHistory && <Button variant="secondary" disabled={props.readingHistory} onClick={() => {if (!props.readingHistory) props.onPreviousHistory?.();}}>Previous report page</Button>}
      </Stack>
    </Disclosure>
  </Stack>;
}
