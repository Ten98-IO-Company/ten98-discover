import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {DisplayFormatProvider} from '@ten98/ui';
import {AIRecommendationsView, type AIRecommendationsViewProps} from '../src/components/AIRecommendationsView.tsx';
import '../src/styles.css';

type Data = Omit<AIRecommendationsViewProps, 'setupControls' | 'onRun' | 'onSelectRun' | 'onCategoryChange' | 'onReload' | 'onMoreHistory' | 'onCancel' | 'onRecover'>;
const projectId = '10000000-0000-4000-8000-000000000001';
const runId = '10000000-0000-4000-8000-000000000002';
const promptId = '10000000-0000-4000-8000-000000000003';
const versionId = '10000000-0000-4000-8000-000000000004';
const stamp = '2026-11-06T00:00:00.000000Z';
const scope = {from: '2026-11-01', to: '2026-11-06', timeZone: 'Asia/Dubai', model: null, promptId: null, tag: null, matcher: 'unicode-boundary-v1' as const};
const hostile = '<img src=x onerror=alert(1)> <script>window.fixtureExecuted=true</script>';
const run: NonNullable<Data['detail']>['run'] = {
  id: runId, preparationId: '10000000-0000-4000-8000-000000000005', status: 'completed', createdAt: stamp, dispatchedAt: stamp, completedAt: stamp,
  route: {model: 'example/model', provider: 'Synthetic provider'}, promptTokens: 10, completionTokens: 20, diagnostic: null, canRecover: false, available: true,
  savedEvidence: {scope, subjects: [{id: 'brand', name: 'Synthetic brand', aliases: [], domains: ['example.com']}],
    prompts: [{id: promptId, versionId, text: 'Original retained prompt', tags: []}],
    citations: [{id: 'a'.repeat(64), executionId: runId, promptId, retainedCitationIndex: 0, url: 'https://example.com/retained', title: 'Retained page', ownership: 'brand', publisherCategory: 'editorial', sourceType: 'publisher'}]},
  report: {version: 1, sourceKind: 'api-model-answer', evidenceHash: 'b'.repeat(64), semanticConclusions: 'unverified', evidenceValidation: 'supplied-api-evidence-ids-v1', summary: ['Synthetic retained-answer summary'], risks: ['The supplied answers are a limited sample.'],
    opportunities: (['creation', 'existing-content', 'outreach', 'social'] as const).map((category, i) => ({category, priority: i + 1, title: i === 0 ? hostile : `${category} recommendation`, why: 'Review this recommendation against the saved answer evidence.', promptIds: [promptId], evidenceIds: ['a'.repeat(64)], targetEvidenceId: null}))},
};
const {savedEvidence: _saved, report: _report, ...summary} = run;
const initial: Data = {prefix: 'recommendations-', history: {projectId, role: 'owner', canPrepare: true, connections: [], runs: [summary, {...summary, id: '10000000-0000-4000-8000-000000000006', createdAt: '2026-11-05T00:00:00.000000Z', route: {...summary.route, model: 'example/previous'}}], nextCursor: 'older'}, detail: {projectId, role: 'owner', run},
  source: {projectId, asOf: stamp, availability: 'available', expectedSource: {projectId, scope, contextRevision: 1, profileHash: 'b'.repeat(64), insightSelectionRevision: 'c'.repeat(64), citationSelectionRevision: 'd'.repeat(64), retentionRevision: 1, rawDays: 30, derivedDays: 30, rawAnchorAt: stamp, derivedAnchorAt: stamp}, coverage: {attempted: 2, eligible: 1, queued: 0, running: 0, no_answer: 0, empty: 0, truncated: 0, content_filtered: 0, expired: 1, invalid: 0}, prompts: 1, citations: 1, warnings: ['One answer is expired.']},
  selectedRunId: runId, category: 'all', readingHistory: false, readingDetail: false, readingSource: false, running: false, actionBusy: false, canRun: true, historyError: null, detailError: null, sourceError: null, runError: null};
let state = structuredClone(initial);
let calls: {action: string; value?: string}[] = [];
const root = createRoot(document.getElementById('root')!);
function draw() {
  flushSync(() => root.render(<DisplayFormatProvider locale="en-GB" timeZone="UTC"><main className="container"><AIRecommendationsView {...state} setupControls={<p>Model selection supplied by the controller.</p>}
    onRun={() => calls.push({action: 'run'})} onReload={() => calls.push({action: 'reload'})} onMoreHistory={() => calls.push({action: 'more'})}
    onSelectRun={id => {calls.push({action: 'select', value: id}); state = {...state, selectedRunId: id}; draw();}}
    onCategoryChange={category => {calls.push({action: 'category', value: category}); state = {...state, category}; draw();}}
    onCancel={id => calls.push({action: 'cancel', value: id})} onRecover={id => calls.push({action: 'recover', value: id})}/></main></DisplayFormatProvider>));
}
declare global {interface Window {aiRecommendationsFixture: {initial: Data; patch: (value: Partial<Data>) => void; reset: () => void; calls: () => typeof calls; clear: () => void}}}
window.aiRecommendationsFixture = {initial, patch(value) {state = {...state, ...value}; draw();}, reset() {state = structuredClone(initial); calls = []; draw();}, calls: () => calls, clear() {calls = [];}};
draw();
