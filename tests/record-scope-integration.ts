import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {getDatabase} from '../src/server/db.ts';
import {boardCard, boardShareCreate, boardSharePublish, boardShareRevoke, type BoardDefinition} from '../src/lib/boards.ts';
import {createBoardShare, saveBoard} from '../src/server/boards.ts';
import {createWebsiteShare} from '../src/server/website-shares.ts';
import {createTrackedAssetShare, saveTrackedAsset} from '../src/server/tracked-assets.ts';
import {createReportShare, saveReport} from '../src/server/reports.ts';
import {saveAnnotation} from '../src/server/annotations.ts';
import {saveCohort} from '../src/server/cohorts.ts';
import {saveSegment} from '../src/server/segments.ts';
import {saveAnalysis} from '../src/server/funnels.ts';
import {createPrompts} from '../src/server/prompts.ts';
import {promptAction, promptPatch} from '../src/server/context-input.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {inviteMember} from '../src/server/teams.ts';
import {getProjectDeletion} from '../src/server/project-delete.ts';
import {projectDeleteInput} from '../src/lib/project-delete.ts';
import {recordCollection, recordRoutes, recordScopeGaps, routeTokens} from './helpers/workspace-routes.ts';

type Identity = {id: string; cookie: string};
type Options = {baseUrl: string; appUrl: string; createIdentity: (workspaceId: string, role: 'owner' | 'viewer') => Promise<Identity>};
// status: the refusal the route gives a made-up id, when that is not 404.
type Call = {method: 'GET' | 'POST'; query?: string; body?: unknown; status?: number};
/** Valid requests per route suffix (the path after the collection), and the record ids that fill its id slots. */
type Collection = {ids: string[]; slots?: Record<string, string[]>; calls: Record<string, Call[]>};

/**
 * Record routes refuse another workspace's records. Workspace A holds one real record per covered collection; an owner of
 * workspace B calls every record route under B's workspace or website id with A's record ids and a valid body, and must
 * get the exact answer a made-up id gets (404, unless the call names another refusal) while every A record stays unchanged. Routes come from tests/helpers/workspace-routes.ts.
 */
export async function runRecordScopeChecks(options: Options) {
  const {pool} = getDatabase();
  const workspaceA = randomUUID(), workspaceB = randomUUID();
  for (const [id, name] of [[workspaceA, 'Record scope records'], [workspaceB, 'Record scope caller']]) await pool.query('INSERT INTO workspace(id,name) VALUES($1,$2)', [id, name]);
  const owner = await options.createIdentity(workspaceA, 'owner'), member = await options.createIdentity(workspaceA, 'viewer'), caller = await options.createIdentity(workspaceB, 'owner');

  async function send(path: string, call: Call, cookie = caller.cookie) {
    const headers: Record<string, string> = {cookie};
    if (call.method === 'POST') { headers.origin = options.appUrl; headers['content-type'] = 'application/json'; }
    const response = await fetch(new URL(path + (call.query ? `?${call.query}` : ''), options.baseUrl), {
      method: call.method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      ...(call.method === 'POST' ? {body: JSON.stringify(call.body ?? {})} : {}),
    });
    const text = await response.text();
    // Hundreds of refused requests from one identity; per-user request budgets are not what this measures.
    await pool.query("DELETE FROM request_limit WHERE key LIKE '%'||$1||'%'", [caller.id]);
    return {status: response.status, text};
  }
  async function website(workspaceId: string, cookie: string, name: string) {
    const created = await send(`/api/workspaces/${workspaceId}/projects`, {method: 'POST', body: {name, origin: `https://${randomUUID()}.record-scope.integration.test`}}, cookie);
    assert.equal(created.status, 201, created.text);
    return (JSON.parse(created.text) as {project: {id: string}}).project.id;
  }
  const projectA = await website(workspaceA, owner.cookie, 'Record scope records'), projectB = await website(workspaceB, caller.cookie, 'Record scope caller');

  const later = () => new Date(Date.now() + 86_400_000).toISOString();
  const token = () => randomBytes(32).toString('base64url');
  const action = () => ({requestId: randomUUID(), revision: 1});
  const dates = 'from=2026-01-01&to=2026-01-02&timeZone=UTC';

  // Workspace A's records, each created through its own server function.
  const card = boardCard.parse({id: randomUUID(), type: 'TextBlock', text: 'Record scope'});
  const definition: BoardDefinition = {schemaVersion: 1, name: 'Record scope', description: 'Synthetic', defaultEntity: {kind: 'website', id: projectA}, scope: dates, rows: [{id: randomUUID(), minHeight: 150, cards: [card]}]};
  const board = (await saveBoard(workspaceA, owner.id, {requestId: randomUUID(), definition})).item!;
  const publication = {boardRevision: board.revision, label: 'Record scope', theme: 'light', selectedCardIds: [card.id], scope: dates, allowFilter: false, ongoingLive: false, expiresAt: later()};
  const boardShare = await createBoardShare(workspaceA, owner.id, board.id, boardShareCreate.parse({requestId: randomUUID(), ...publication, token: token()}));
  const websiteShare = await createWebsiteShare(projectA, owner.id, {requestId: randomUUID(), label: 'Record scope', sections: ['overview'], expiresAt: later(), token: token()});
  const assetFields = {kind: 'link', name: 'Record scope', destination: 'https://example.com/record-scope', active: true, collection: {enabled: true, captureReferrer: true, captureGeography: false, excludeBots: true}};
  const asset = (await saveTrackedAsset(workspaceA, owner.id, {requestId: randomUUID(), asset: assetFields})).item!;
  const assetShareInput = {assetRevision: 1, label: 'Record scope', scope: dates, sections: ['summary'], expiresAt: later()};
  const assetShare = await createTrackedAssetShare(workspaceA, owner.id, asset.id, {requestId: randomUUID(), ...assetShareInput, token: token()});
  const reportInput = {title: 'Record scope', html: '<p>Record scope</p>'}, templateInput = {name: 'Record scope', brief: 'Record scope brief'};
  const report = (await saveReport(projectA, owner.id, reportInput)).report as {id: string};
  const template = (await saveReport(projectA, owner.id, templateInput, undefined, true)).template as {id: string};
  const reportShareInput = {label: 'Record scope', revision: 1, expiresAt: later()};
  const reportShare = (await createReportShare(projectA, owner.id, report.id, reportShareInput)) as {share: {id: string}};
  const annotationDefinition = {date: '2026-01-01T12:00:00.000Z', allDay: true, note: 'Record scope'};
  const annotation = (await saveAnnotation(projectA, owner.id, {requestId: randomUUID(), definition: annotationDefinition})).item!;
  const cohortDefinition = {schemaVersion: 1, name: 'Record scope', query: `${dates}&path=%2Foffer`};
  const cohort = (await saveCohort(projectA, owner.id, {requestId: randomUUID(), definition: cohortDefinition})).item!;
  const segmentDefinition = {schemaVersion: 1, name: 'Record scope', query: 'path=%2Fone'};
  const segment = (await saveSegment(projectA, owner.id, {requestId: randomUUID(), definition: segmentDefinition})).item!;
  const goalDefinition = {kind: 'goal', name: 'Record scope', condition: {type: 'event', match: 'exact', value: 'event0'}};
  const goal = (await saveAnalysis(projectA, owner.id, 'goal', {requestId: randomUUID(), definition: goalDefinition})).item!;
  const funnelDefinition = {kind: 'funnel', name: 'Record scope', windowMinutes: 30, steps: [{type: 'event', match: 'exact', value: 'event0'}, {type: 'event', match: 'exact', value: 'event1'}]};
  const funnel = (await saveAnalysis(projectA, owner.id, 'funnel', {requestId: randomUUID(), definition: funnelDefinition})).item!;
  const prompt = (await createPrompts(projectA, owner.id, {requestId: randomUUID(), prompts: [{text: 'Which record scope tool should I choose?', enabled: false}]})).items[0] as {id: string};
  const apiKey = (await createApiKey(workspaceA, owner.id, {name: 'Record scope', scopes: ['analytics:read']})).key;
  const invitation = (await inviteMember(workspaceA, owner.id, {email: `${randomUUID()}@record-scope.integration.test`, role: 'viewer'})).invitation as {id: string};
  const deletion = await getProjectDeletion(workspaceA, projectA, owner.id);

  const analysis = (id: string, value: Record<string, unknown>, step: boolean): Collection => ({ids: [id], calls: {
    '/{uuid}': [{method: 'GET'}],
    '/{uuid}/update': [{method: 'POST', body: {...action(), definition: value}}],
    '/{uuid}/delete': [{method: 'POST', body: action()}],
    '/{uuid}/result': [{method: 'GET', query: `revision=1&${dates}`}],
    '/{uuid}/witnesses': [{method: 'GET', query: `revision=1&${dates}${step ? '&step=1' : ''}`}],
  }});
  const saved = (id: string, value: Record<string, unknown>): Collection => ({ids: [id], calls: {
    '/{uuid}': [{method: 'GET'}],
    '/{uuid}/update': [{method: 'POST', body: {...action(), definition: value}}],
    '/{uuid}/delete': [{method: 'POST', body: action()}],
  }});
  // Keyed like recordScopeGaps. A suffix not listed here is a combination the router accepts but no handler serves; it
  // must answer 404 or 405 to a GET and to a POST with an empty body.
  const covered: Record<string, Collection> = {
    'workspaces/boards': {ids: [board.id, boardShare.ack.shareId], slots: {'/{uuid}/cards/{uuid}': [board.id, card.id]}, calls: {
      '/{uuid}': [{method: 'GET'}],
      '/{uuid}/update': [{method: 'POST', body: {requestId: randomUUID(), revision: board.revision, definition}}],
      '/{uuid}/clone': [{method: 'POST', body: {requestId: randomUUID(), revision: board.revision, name: 'Record scope clone'}}],
      '/{uuid}/delete': [{method: 'POST', body: {requestId: randomUUID(), revision: board.revision}}],
      '/{uuid}/cards/{uuid}': [{method: 'GET', query: `revision=${board.revision}`}],
      '/{uuid}/shares': [{method: 'GET'}, {method: 'POST', body: boardShareCreate.parse({requestId: randomUUID(), ...publication, token: token()})}],
      '/{uuid}/shares/{uuid}': [{method: 'GET'}],
      '/{uuid}/shares/{uuid}/publish': [{method: 'POST', body: boardSharePublish.parse({requestId: randomUUID(), revision: 1, ...publication})}],
      '/{uuid}/shares/{uuid}/revoke': [{method: 'POST', body: boardShareRevoke.parse(action())}],
    }},
    'workspaces/tracked-assets': {ids: [asset.id, assetShare.share!.id], calls: {
      '/{uuid}': [{method: 'GET'}],
      '/{uuid}/update': [{method: 'POST', body: {...action(), asset: assetFields}}],
      '/{uuid}/delete': [{method: 'POST', body: action()}],
      '/{uuid}/report': [{method: 'GET', query: dates}],
      '/{uuid}/shares': [{method: 'GET'}, {method: 'POST', body: {requestId: randomUUID(), ...assetShareInput, token: token()}}],
      '/{uuid}/shares/{uuid}/revoke': [{method: 'POST', body: action()}],
    }},
    'workspaces/api-keys': {ids: [apiKey.id], calls: {'/{uuid}/revoke': [{method: 'POST', body: {}}]}},
    'workspaces/members': {ids: [member.id], calls: {'/{uuid}/role': [{method: 'POST', body: {role: 'admin'}}], '/{uuid}/remove': [{method: 'POST', body: {}}]}},
    'workspaces/invitations': {ids: [invitation.id], calls: {
      // The shared team controller answers a missing invitation like an expired one: 409 for any id it cannot find.
      '/{uuid}/revoke': [{method: 'POST', body: {}}], '/{uuid}/resend': [{method: 'POST', body: {}, status: 409}], '/{uuid}/new-link': [{method: 'POST', body: {}, status: 409}],
    }},
    'workspaces/projects': {ids: [projectA], calls: {
      '/{uuid}/delete': [{method: 'GET'}, {method: 'POST', body: projectDeleteInput.parse({requestId: randomUUID(), revision: deletion.item!.revision, confirmation: 'DELETE'})}],
    }},
    'projects/website-shares': {ids: [websiteShare.ack.shareId], calls: {'/{uuid}/revoke': [{method: 'POST', body: {requestId: randomUUID()}}]}},
    'projects/reports': {ids: [report.id, reportShare.share.id], calls: {
      '/{uuid}': [{method: 'GET'}, {method: 'POST', body: {...reportInput, revision: 1}}],
      '/{uuid}/delete': [{method: 'POST', body: {revision: 1}}],
      '/{uuid}/preview': [{method: 'GET'}],
      '/{uuid}/shares': [{method: 'GET'}, {method: 'POST', body: reportShareInput}],
      '/{uuid}/shares/{uuid}/revoke': [{method: 'POST', body: {}}],
    }},
    'projects/report-templates': {ids: [template.id], calls: {
      '/{uuid}': [{method: 'GET'}, {method: 'POST', body: {...templateInput, revision: 1}}],
      '/{uuid}/delete': [{method: 'POST', body: {revision: 1}}],
    }},
    'projects/annotations': saved(annotation.id, annotationDefinition),
    'projects/cohorts': saved(cohort.id, cohortDefinition),
    'projects/segments': saved(segment.id, segmentDefinition),
    'projects/goals': analysis(goal.id, goalDefinition, false),
    'projects/funnels': analysis(funnel.id, funnelDefinition, true),
    'projects/prompts': {ids: [prompt.id], calls: {
      '/{uuid}': [{method: 'GET'}],
      '/{uuid}/update': [{method: 'POST', body: promptPatch.parse({...action(), enabled: true})}],
      '/{uuid}/archive': [{method: 'POST', body: promptAction.parse(action())}],
      '/{uuid}/restore': [{method: 'POST', body: promptAction.parse(action())}],
      '/{uuid}/versions': [{method: 'GET'}],
    }},
  };

  const rows: [string, string, unknown[]][] = [
    ['board', 'SELECT to_jsonb(t)::text AS row FROM custom_board t WHERE id=$1', [board.id]],
    ['board share', 'SELECT to_jsonb(t)::text AS row FROM board_share t WHERE id=$1', [boardShare.ack.shareId]],
    ['website share', 'SELECT to_jsonb(t)::text AS row FROM project_share t WHERE id=$1', [websiteShare.ack.shareId]],
    ['tracked asset', 'SELECT to_jsonb(t)::text AS row FROM tracked_asset t WHERE id=$1', [asset.id]],
    ['tracked asset share', 'SELECT to_jsonb(t)::text AS row FROM tracked_asset_share t WHERE id=$1', [assetShare.share!.id]],
    ['report', 'SELECT to_jsonb(t)::text AS row FROM report t WHERE id=$1', [report.id]],
    ['report template', 'SELECT to_jsonb(t)::text AS row FROM report_template t WHERE id=$1', [template.id]],
    ['report share', 'SELECT to_jsonb(t)::text AS row FROM report_share t WHERE id=$1', [reportShare.share.id]],
    ['annotation', 'SELECT to_jsonb(t)::text AS row FROM analytics_annotation t WHERE id=$1', [annotation.id]],
    ['cohort', 'SELECT to_jsonb(t)::text AS row FROM analytics_cohort t WHERE id=$1', [cohort.id]],
    ['segment', 'SELECT to_jsonb(t)::text AS row FROM analytics_segment t WHERE id=$1', [segment.id]],
    ['goal and funnel', 'SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text AS row FROM analytics_definition t WHERE id=ANY($1::uuid[])', [[goal.id, funnel.id]]],
    ['prompt', 'SELECT to_jsonb(t)::text AS row FROM project_prompt t WHERE id=$1', [prompt.id]],
    ['API key', 'SELECT to_jsonb(t)::text AS row FROM api_key t WHERE id=$1', [apiKey.id]],
    ['invitation', 'SELECT to_jsonb(t)::text AS row FROM workspace_invitation t WHERE id=$1', [invitation.id]],
    ['membership', 'SELECT jsonb_agg(to_jsonb(t) ORDER BY t.user_id)::text AS row FROM membership t WHERE workspace_id=$1', [workspaceA]],
    ['website', 'SELECT to_jsonb(t)::text AS row FROM project t WHERE id=$1', [projectA]],
    ['workspace boards', 'SELECT count(*)::text AS row FROM custom_board WHERE workspace_id=$1', [workspaceA]],
    ['workspace B boards', 'SELECT count(*)::text AS row FROM custom_board WHERE workspace_id=$1', [workspaceB]],
  ];
  const snapshot = async () => Object.fromEntries(await Promise.all(rows.map(async ([name, sql, values]) => {
    const row = (await pool.query<{row: string | null}>(sql, values)).rows[0]?.row ?? null;
    assert.ok(row !== null, `${name} fixture exists`);
    return [name, row] as const;
  })));
  const before = await snapshot();

  const routes = recordRoutes();
  // The path after the collection, such as /{uuid}/shares/{uuid}/revoke.
  const suffixOf = (route: string) => route.slice(route.indexOf(routeTokens.uuid) + routeTokens.uuid.length).replace(/^\/[^/]+/, '');
  const collections = new Set(routes.map(recordCollection));
  for (const key of Object.keys(covered)) assert.ok(collections.has(key), `${key} is covered but no record route names it.`);
  for (const key of Object.keys(recordScopeGaps)) {
    assert.ok(collections.has(key), `${key} is listed as not feasible but no record route names it.`);
    assert.ok(!Object.hasOwn(covered, key), `${key} is both covered and listed as not feasible.`);
  }
  let coveredRoutes = 0, unserved = 0, listed = 0;
  for (const route of routes) {
    const key = recordCollection(route), collection = covered[key];
    if (!collection) {
      assert.ok(Object.hasOwn(recordScopeGaps, key), `${route} names a record but its collection ${key} is neither covered in tests/record-scope-integration.ts nor listed in recordScopeGaps.`);
      listed++;
      continue;
    }
    const suffix = suffixOf(route);
    const ids = [route.startsWith('/api/workspaces/') ? workspaceB : projectB, ...(collection.slots?.[suffix] ?? collection.ids)];
    let slot = 0;
    const path = route.replaceAll(routeTokens.uuid, () => ids[slot++] ?? randomUUID());
    let madeUpSlot = 0;
    const madeUpPath = route.replaceAll(routeTokens.uuid, () => madeUpSlot++ ? randomUUID() : ids[0]);
    const calls = collection.calls[suffix];
    if (calls) {
      for (const call of calls) {
        const foreign = await send(path, call), madeUp = await send(madeUpPath, call);
        assert.equal(foreign.status, call.status ?? 404, `${call.method} ${route}: another workspace's record answered ${foreign.status} ${foreign.text.slice(0, 200)}`);
        assert.deepEqual(foreign, madeUp, `${call.method} ${route}: another workspace's record answers like a made-up id`);
      }
      coveredRoutes++;
    } else {
      for (const call of [{method: 'GET'}, {method: 'POST', body: {}}] as const) {
        const {status, text} = await send(path, call);
        assert.ok([404, 405].includes(status), `${call.method} ${route}: a combination no handler serves answered ${status} ${text.slice(0, 200)}`);
      }
      unserved++;
    }
  }
  for (const key of Object.keys(covered)) for (const suffix of Object.keys(covered[key].calls)) {
    assert.ok(routes.some(route => recordCollection(route) === key && suffixOf(route) === suffix), `${key}${suffix} has requests but no matching record route.`);
  }
  assert.deepEqual(await snapshot(), before, 'Workspace A records are unchanged after the sweep.');
  assert.ok(coveredRoutes >= 40, `Expected at least 40 covered record routes, found ${coveredRoutes}.`);
  console.log(`PASS ${coveredRoutes} record routes (and ${unserved} router-only combinations) answer another workspace's records exactly like made-up ids; ${listed} routes in ${Object.keys(recordScopeGaps).length} collections are listed as not feasible`);
}
