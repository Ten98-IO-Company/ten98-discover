import type {ReactNode} from 'react';
import {Alert, Badge, Button, Card, Disclosure, useDisplayFormat} from '@ten98/ui';
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
  onRun: () => void;
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
  return <section className="research-panel stack" aria-labelledby={prefix + 'heading'} style={{minWidth: 0, overflowWrap: 'anywhere'}}>
    <div className="row between" style={{flexWrap: 'wrap'}}>
      <h2 id={prefix + 'heading'} tabIndex={-1}>Recommendations</h2>
      <Button type="button" disabled={!canRun} loading={props.running} onClick={() => {if (canRun) props.onRun();}}>Run recommendations</Button>
    </div>
    <p className="hint">Unverified AI suggestions from retained API answers. Review the evidence before acting.</p>
    {history && <div className="stack">{props.setupControls}</div>}
    {props.runError && <Alert tone="danger" title="Recommendations could not start">{props.runError}</Alert>}
    {props.sourceError && <Alert tone="warning" title="Current source unavailable">{props.sourceError} Saved reports remain available below.</Alert>}
    {props.readingSource && <p role="status">Checking retained answers…</p>}
    {source && <Disclosure summary="Current answer coverage" variant="plain">
      <p>{source.coverage.eligible} eligible of {source.coverage.attempted} attempted answers; {source.prompts} saved prompts and {source.citations} retained citations.</p>
      <p className="hint">Checked {format.dateTime(source.asOf)}. Coverage applies to the current selection.</p>
      {source.warnings.length > 0 && <ul>{source.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
    </Disclosure>}
    {!props.readingSource && !props.sourceError && source?.availability === 'insufficient-evidence' && <Alert tone="info" title="No eligible retained answers">Choose a selection with retained API answers before running recommendations.</Alert>}
    {history && !source && !props.readingSource && !props.sourceError && <Alert tone="info" title="Current answer source unavailable">Reload the answer selection to prepare a new report. Saved reports remain available.</Alert>}
    {props.historyError && <Alert tone="danger" title="Report history could not load">{props.historyError}</Alert>}
    {props.readingHistory && <p role="status">Loading report history…</p>}
    <Disclosure key={run ? 'selected-history' : 'open-history'} summary="Previous reports" variant="plain" defaultOpen={!run}>
      <div className="stack">
        <Button variant="ghost" disabled={props.readingHistory} onClick={() => {if (!props.readingHistory) props.onReload();}}>Refresh reports</Button>
      {history?.runs.length === 0 && !props.readingHistory && <p>No saved reports yet. Run recommendations when retained answers are available.</p>}
      {history && history.runs.length > 0 && <ul className="stack">{history.runs.map(item => <li key={item.id}>
        <Button variant="ghost" pressed={selectedRunId === item.id} onClick={() => props.onSelectRun(item.id)}>
          {format.dateTime(item.createdAt)} · {item.route.model || 'Model unavailable'} · {item.status}
        </Button>
      </li>)}</ul>}
      {history?.nextCursor && props.onMoreHistory && <Button variant="secondary" disabled={props.readingHistory} onClick={() => {if (!props.readingHistory) props.onMoreHistory?.();}}>More reports</Button>}
      {props.onPreviousHistory && <Button variant="secondary" disabled={props.readingHistory} onClick={() => {if (!props.readingHistory) props.onPreviousHistory?.();}}>Previous report page</Button>}
      </div>
    </Disclosure>
    {props.detailError && <Alert tone="danger" title="Selected report could not load">{props.detailError}</Alert>}
    {props.readingDetail && <p role="status">Loading selected report…</p>}
    {run && <section className="stack" aria-labelledby={prefix + 'selected'}>
      <div className="row between" style={{flexWrap: 'wrap'}}>
        <h3 id={prefix + 'selected'}>Selected report</h3>
        <Badge tone={run.status === 'completed' ? 'success' : run.status === 'failed' || run.status === 'uncertain' ? 'warning' : 'neutral'}>{run.status}</Badge>
      </div>
      <p className="hint">{run.route.model || 'Model unavailable'} · {run.route.provider || 'Provider unavailable'} · Requested {format.dateTime(run.createdAt)}{run.completedAt ? ` · Finished ${format.dateTime(run.completedAt)}` : ''}</p>
      {run.status !== 'completed' && <p role="status">{statusCopy[run.status]}</p>}
      {run.diagnostic && <p>{run.diagnostic}</p>}
      {(run.status === 'queued' && props.onCancel || run.canRecover && props.onRecover) && <div className="row" style={{flexWrap: 'wrap'}}>
        {run.status === 'queued' && props.onCancel && <Button variant="secondary" disabled={!canAct} onClick={() => {if (canAct) props.onCancel?.(run.id);}}>Cancel queued request</Button>}
        {run.canRecover && props.onRecover && <Button variant="secondary" disabled={!canAct} onClick={() => {if (canAct) props.onRecover?.(run.id);}}>Check original request</Button>}
      </div>}
      {run.status === 'completed' && !run.available && <Alert tone="warning" title="Report evidence unavailable or expired">This completed request remains in history, but its retained report evidence is no longer available.</Alert>}
      {run.available && run.status === 'completed' && (!saved || !run.report) && <Alert tone="warning" title="Report evidence unavailable">The saved report cannot be displayed without its retained evidence.</Alert>}
      {saved && <Disclosure summary="Saved report scope" variant="plain">
        <p>{saved.scope.from} to {saved.scope.to} · {saved.scope.timeZone} · {saved.scope.model || 'All source models'}</p>
        <p>Prompt: {saved.scope.promptId ? saved.prompts.find(prompt => prompt.id === saved.scope.promptId)?.text ?? 'Saved prompt unavailable' : 'All saved prompts'} · Tag: {saved.scope.tag || 'All tags'}</p>
        <p className="hint">{saved.scope.matcher === 'unicode-boundary-v1' ? 'Whole-word matching' : 'Substring matching'}. {saved.prompts.length} saved prompt versions; {saved.citations.length} retained citations.</p>
        <p className="hint">API answers do not measure consumer chats, search demand or website content. Recommendations use this saved selection.</p>
      </Disclosure>}
      {report && <>
        {report.summary.length > 0 && <section><h4>Summary</h4><ul>{report.summary.map((text, i) => <li key={i}>{text}</li>)}</ul></section>}
        <div className="row" role="group" aria-label="Recommendation categories" style={{flexWrap: 'wrap'}}>{categories.map(([value, label]) => <Button key={value} variant="secondary" pressed={category === value} onClick={() => props.onCategoryChange(value)}>{label} ({value === 'all' ? report.opportunities.length : report.opportunities.filter(item => item.category === value).length})</Button>)}</div>
        {report.opportunities.length === 0 ? <Alert title="No recommendations in this completed report">The model returned no recommendations for the supplied retained answers.</Alert> : recommendations.length === 0 ? <p>No recommendations in this category.</p> : recommendations.map(item => {
          const ids = [...new Set([...item.evidenceIds, ...item.targetEvidenceId ? [item.targetEvidenceId] : []])];
          const citations = ids.map(id => saved!.citations.find(citation => citation.id === id && item.promptIds.includes(citation.promptId)));
          return <Card as="article" headingLevel={4} key={item.priority} title={`${item.priority}. ${item.title}`} description={categories.find(([key]) => key === item.category)?.[1]}>
            <p><strong>Why this recommendation</strong></p><p>{item.why}</p>
            <Disclosure summary={`Related prompts (${item.promptIds.length})`} variant="plain"><ul>{item.promptIds.map(id => {
              const prompt = saved!.prompts.find(candidate => candidate.id === id);
              return <li key={id}>{prompt ? <><span>{prompt.text}</span><p className="hint">Saved prompt version</p></> : 'Related prompt evidence unavailable.'}</li>;
            })}</ul></Disclosure>
            {(['brand', 'competitor', 'other'] as const).map(owner => {
              const group = citations.filter(citation => owner === 'other' ? !citation || !['brand', 'competitor'].includes(citation.ownership) : citation?.ownership === owner);
              if (owner === 'other' && !group.length) return null;
              return <Disclosure key={owner} summary={`${owner === 'brand' ? 'Your citations' : owner === 'competitor' ? 'Competitor citations' : 'Other retained evidence'} (${group.length})`} variant="plain">
                {group.length === 0 ? <p>No retained citations linked in this group.</p> : <ul>{group.map((citation, i) => {
                  const href = citation && citationSafeHref(citation.url);
                  return <li key={citation?.id ?? `unavailable-${i}`}>{citation && href ? <><a href={href} target="_blank" rel="noopener noreferrer">{citation.title || citation.url}</a><p className="hint">{citation.ownership} · {citation.publisherCategory}{citation.id === item.targetEvidenceId ? ' · Suggested target' : ''}</p></> : 'Retained citation evidence unavailable.'}</li>;
                })}</ul>}
              </Disclosure>;
            })}
          </Card>;
        })}
        {report.risks.length > 0 && <Disclosure summary="Reality check" defaultOpen variant="plain"><ul>{report.risks.map((risk, i) => <li key={i}>{risk}</li>)}</ul></Disclosure>}
      </>}
    </section>}
  </section>;
}
