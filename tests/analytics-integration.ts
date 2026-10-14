import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../src/server/db.ts';

export async function runAnalyticsChecks(options: { baseUrl: string; appUrl: string; ownerCookie: string; workspaceId: string; foreignProjectId: string }) {
  const { pool } = getDatabase();
  async function request(path: string, method = 'GET', body?: unknown, origin = options.appUrl) {
    const response = await fetch(new URL(path, options.baseUrl), {
      method, headers: { origin, cookie: options.ownerCookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, data: await response.json() };
  }
  const origin = 'https://analytics.integration.test';
  const created = await request(`/api/workspaces/${options.workspaceId}/projects`, 'POST', { name: 'Analytics fixtures', origin });
  assert.equal(created.status, 201);
  const project = created.data.project;
  const samples = [
    ['page_view', '/before', '2024-02-27T23:59:59.999Z'],
    ['page_view', '/alpha', '2024-02-28T00:00:00Z'],
    ['signup', '/alpha', '2024-02-28T12:00:00Z'],
    ['page_view', '/alpha', '2024-03-01T00:00:00Z'],
    ['page_view', '/beta', '2024-03-01T23:59:59.999Z'],
    ['signup', '/beta', '2024-03-01T10:00:00Z'],
    ['purchase', '/beta', '2024-03-01T11:00:00Z'],
    ['page_view', '/after', '2024-03-02T00:00:00Z'],
  ];
  for (const [name, path, received] of samples) {
    await pool.query('INSERT INTO event(id,project_id,event_name,path,received_at) VALUES($1,$2,$3,$4,$5)', [randomUUID(), project.id, name, path, received]);
  }
  await pool.query('INSERT INTO event(id,project_id,event_name,path,received_at) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), options.foreignProjectId, 'page_view', '/foreign', '2024-02-28T00:00:00Z']);
  const report = await request(`/api/projects/${project.id}/analytics?from=2024-02-28&to=2024-03-01`);
  assert.equal(report.status, 200);
  assert.deepEqual(report.data.range, { from: '2024-02-28', to: '2024-03-01', timeZone: 'UTC' });
  assert.deepEqual(report.data.totals, { pageViews: 3, customEvents: 3 });
  assert.deepEqual(report.data.collection,{mode:'cookieless',captureCoverage:'unknown',pageViews:{cookieless:0,consent:0,unknown:3}});
  assert.equal(report.data.coverage.status, 'complete');
  assert.deepEqual(report.data.daily, [
    { date: '2024-02-28', pageViews: 1, customEvents: 1, coverage: 'complete' },
    { date: '2024-02-29', pageViews: 0, customEvents: 0, coverage: 'complete' },
    { date: '2024-03-01', pageViews: 2, customEvents: 2, coverage: 'complete' },
  ]);
  assert.deepEqual(report.data.pages, [{ path: '/alpha', pageViews: 2 }, { path: '/beta', pageViews: 1 }]);
  assert.deepEqual(report.data.events, [{ name: 'signup', count: 2 }, { name: 'purchase', count: 1 }]);
  assert.equal(new Date(report.data.lastReceivedAt).toISOString(), '2024-03-01T23:59:59.999Z');
  const empty = await request(`/api/projects/${project.id}/analytics?from=2024-02-29&to=2024-02-29`);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.coverage.status, 'complete');
  assert.deepEqual(empty.data.totals, { pageViews: 0, customEvents: 0 });
  assert.deepEqual(empty.data.pages, []);
  assert.equal(empty.data.lastReceivedAt, null);
  assert.equal((await request(`/api/projects/${project.id}/analytics?from=2026-02-29&to=2026-03-01`)).status, 400);
  assert.equal((await request(`/api/projects/${options.foreignProjectId}/analytics`)).status, 404);

  const tracking = await request('/api/tracking-config', 'POST', { siteKey: project.publicKey, environment: 'live' }, origin);
  assert.equal(tracking.status, 200);
  const event = { siteKey: project.publicKey, eventId: randomUUID(), name: 'checkout.success', url: `${origin}/checkout?private=yes#secret`, consent: { analytics: true, epoch: tracking.data.consentEpoch } };
  assert.equal((await request('/api/collect', 'POST', event, origin)).status, 202);
  assert.equal((await request('/api/collect', 'POST', event, origin)).status, 202);
  const custom = await pool.query('SELECT event_name,path FROM event WHERE project_id=$1 AND id=$2', [project.id, event.eventId]);
  assert.deepEqual(custom.rows, [{ event_name: 'checkout.success', path: '/checkout' }]);
  assert.equal((await request('/api/collect', 'POST', { ...event, name: 'invalid event' }, origin)).status, 400);
  // The selected range reports actual recorded basis, independently of the current mode.
  for(const basis of ['cookieless','consent']) {
    const page={siteKey:project.publicKey,eventId:randomUUID(),name:'page_view',url:origin+'/basis',
      ...(basis==='cookieless'?{collection:{mode:'cookieless',epoch:tracking.data.consentEpoch}}:{consent:{analytics:true,epoch:tracking.data.consentEpoch}})};
    const result=await request('/api/collect','POST',page,origin);
    assert.equal(result.status,202);assert.equal(result.data.accepted,true);
  }
  await pool.query("INSERT INTO event(id,project_id,event_name,path,source) VALUES($1,$2,'page_view','/api-basis','api')",[randomUUID(),project.id]);
  const today=new Date().toISOString().slice(0,10);
  const mixed=await request(`/api/projects/${project.id}/analytics?from=${today}&to=${today}`);
  assert.equal(mixed.status,200);
  assert.equal(mixed.data.totals.pageViews,3);
  assert.deepEqual(mixed.data.collection,{mode:'cookieless',captureCoverage:'unknown',pageViews:{cookieless:1,consent:1,unknown:1}});
  console.log('PASS analytics date boundaries, empty days, page/custom counts, tenant scope, custom event privacy and mixed collection basis');
}
