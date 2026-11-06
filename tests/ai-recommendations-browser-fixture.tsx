import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {DisplayFormatProvider} from '@ten98/ui';
import {AIRecommendationsPanel, type AIRecommendationsPanelProps} from '../src/components/AIRecommendationsPanel';
import {AIInsightsPanel} from '../src/components/AIInsightsPanel';
import {opportunitiesDetailDtoSchema, opportunitiesListDtoSchema, opportunitiesSourceDtoSchema} from '../src/lib/ai-opportunities-api';
import {opportunitiesPreparationDtoSchema} from '../src/lib/ai-opportunities-run';
import {readModelCatalog} from '../src/components/OpenRouterModelPicker';
import {parseNavigation, type AIInsightsNavigation} from '../src/lib/navigation';
import '../src/styles.css';

const projectId = '10000000-0000-4000-8000-000000000001', runId = '10000000-0000-4000-8000-000000000002', promptId = '10000000-0000-4000-8000-000000000003', connectionId = '10000000-0000-4000-8000-000000000004';
const stamp = '2026-11-06T00:00:00.000000Z', model = 'openai/gpt-4.1';
const scope = {from: '2026-11-01', to: '2026-11-06', timeZone: 'Asia/Dubai', model: null, promptId: null, tag: null, matcher: 'unicode-boundary-v1' as const};
const detail = opportunitiesDetailDtoSchema.parse({projectId, role: 'owner', run: {
  id: runId, preparationId: '10000000-0000-4000-8000-000000000005', status: 'completed', createdAt: stamp, dispatchedAt: stamp, completedAt: stamp, route: {model, provider: 'OpenAI'}, promptTokens: 10, completionTokens: 20, diagnostic: null, canRecover: false, available: true,
  savedEvidence: {scope, subjects: [{id: 'brand', name: 'Synthetic brand', aliases: [], domains: ['example.com']}], prompts: [{id: promptId, versionId: promptId, text: 'Saved original prompt', tags: []}], citations: []},
  report: {version: 1, sourceKind: 'api-model-answer', evidenceHash: 'a'.repeat(64), semanticConclusions: 'unverified', evidenceValidation: 'supplied-api-evidence-ids-v1', summary: ['Retained report stays readable.'], risks: [], opportunities: [{category: 'creation', priority: 1, title: 'Saved recommendation', why: 'Based on the original retained answer.', promptIds: [promptId], evidenceIds: [], targetEvidenceId: null}]},
}});
const {savedEvidence: _saved, report: _report, ...summary} = detail.run;
const history = opportunitiesListDtoSchema.parse({projectId, role: 'owner', canPrepare: true, connections: [{id: connectionId, name: 'Synthetic checked connection', revision: 1, checkStatus: 'ok'}], runs: window.recommendationsParentFixture ? [summary, {...summary, id: '10000000-0000-4000-8000-000000000007', createdAt: '2026-11-05T00:00:00.000000Z'}] : [summary], nextCursor: 'page-two'});
const source = opportunitiesSourceDtoSchema.parse({projectId, asOf: stamp, availability: 'available', expectedSource: {projectId, scope, contextRevision: 1, profileHash: 'a'.repeat(64), insightSelectionRevision: 'b'.repeat(64), citationSelectionRevision: 'c'.repeat(64), retentionRevision: 1, rawDays: 30, derivedDays: 30, rawAnchorAt: stamp, derivedAnchorAt: stamp}, coverage: {attempted: 1, eligible: 1, queued: 0, running: 0, no_answer: 0, empty: 0, truncated: 0, content_filtered: 0, expired: 0, invalid: 0}, prompts: 1, citations: 0, warnings: []});
const preparation = opportunitiesPreparationDtoSchema.parse({id: detail.run.preparationId, requestId: runId, createdAt: stamp, expiresAt: '2099-11-06T00:00:00.000000Z', expired: false, available: true, route: detail.run.route, replayed: false});
const catalog = readModelCatalog({version: 'openrouter-text-catalog-v1', status: 'fresh', fetchedAt: '2026-11-06T00:00:00.000Z', revision: 'd'.repeat(64), complete: true, models: [{id: model, canonicalSlug: model, name: 'Synthetic model', contextLength: 128000, maxCompletionTokens: 8192, structuredOutput: true, expirationDate: null, admission: 'candidate', reason: null}]});
type Mutable = Omit<AIRecommendationsPanelProps, 'onSelectionChange' | 'onUnauthorized' | 'onOpenConnections'>;
const initial: Mutable = {userId: 'synthetic-user', workspaceId: '10000000-0000-4000-8000-000000000009', projectId, scope, selectedRunId: runId, category: 'all'};
let props = structuredClone(initial), unauthorized = 0, selections: unknown[] = [];
let navigation: AIInsightsNavigation = {aiInsightsMode: 'recommendations', ...window.recommendationsDefaultScopeFixture ? {} : {aiInsightsQuery: new URLSearchParams({...scope, model: '', promptId: '', tag: ''}).toString()}, aiRecommendationsRun: runId};
if (window.recommendationsParentFixture) window.history.replaceState({}, '', '/?' + new URLSearchParams({workspace: props.workspaceId, project: props.projectId, view: 'ai-insights', ...navigation}));
const root = createRoot(document.getElementById('root')!);
function draw() {flushSync(() => root.render(<DisplayFormatProvider locale="en-GB" timeZone="UTC"><main>{window.recommendationsParentFixture ? <AIInsightsPanel userId={props.userId} workspaceId={props.workspaceId} projectId={props.projectId} navigation={navigation} onNavigate={value => {navigation = value; selections.push(value); window.history.replaceState({}, '', '/?' + new URLSearchParams({workspace: props.workspaceId, project: props.projectId, view: 'ai-insights', ...value})); draw();}} onUnauthorized={() => {unauthorized++;}} onBack={() => {}} backLabel="Back to project"/> : <AIRecommendationsPanel {...props} onUnauthorized={() => {unauthorized++;}} onSelectionChange={selection => {selections.push(selection); props = {...props, selectedRunId: selection.runId, category: selection.category}; draw();}}/>}</main></DisplayFormatProvider>));}
declare global {interface Window {recommendationsParentFixture?: boolean; recommendationsDefaultScopeFixture?: boolean; recommendationsControllerFixture: {data: {history: typeof history; source: typeof source; detail: typeof detail; preparation: typeof preparation; catalog: typeof catalog}; initial: Mutable; patch: (value: Partial<Mutable>) => void; unauthorized: () => number; selections: () => unknown[]; parseConnectionsHref: (href: string) => ReturnType<typeof parseNavigation>}}}
window.recommendationsControllerFixture = {data: {history, source, detail, preparation, catalog}, initial, patch(value) {props = {...props, ...value}; draw();}, unauthorized: () => unauthorized, selections: () => selections, parseConnectionsHref: href => parseNavigation(Object.fromEntries(new URL(href, location.origin).searchParams))};
draw();
