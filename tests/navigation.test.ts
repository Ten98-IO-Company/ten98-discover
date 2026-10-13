import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedView, canonicalNavigation, navigationKey, parseCallback, parseNavigation, projectView } from '../src/lib/navigation.ts'

const workspace = 'a0000000-0000-4000-8000-000000000001', project = 'b0000000-0000-4000-8000-000000000002'

test('URL navigation accepts only scalar identifiers and known sections, never capabilities', () => {
  assert.deepEqual(parseNavigation({ workspace: workspace.toUpperCase(), project, view: 'events', invite: 'secret', returnTo: 'https://example.test' }), { workspace, project, view: 'events' })
  for (const bad of [[workspace, workspace], { id: workspace }, true, null, workspace + '\n', '__proto__']) {
    assert.deepEqual(parseNavigation({ workspace: bad, project, view: ['security', 'providers'] }), { view: 'project' })
  }
  assert.deepEqual(parseNavigation({ project, view: 'new-project' }), { view: 'new-project' })
  assert.deepEqual(parseNavigation({ workspace, project: [project], view: 'constructor' }), { workspace, view: 'project' })
  assert.notEqual(navigationKey({ workspace, project, view: 'events' }), navigationKey({ workspace, project, view: 'security' }))
  assert.equal(canonicalNavigation(`?project=${project}&view=events&workspace=${workspace}`, { workspace, project, view: 'events' }), true)
  assert.equal(canonicalNavigation(`?workspace=${workspace}&project=${project}&view=events&token=secret`, { workspace, project, view: 'events' }), false)
  assert.equal(canonicalNavigation('?view=security&view=security', { view: 'security' }), false)
})

test('page guards distinguish account access, membership and administrative privileges', () => {
  assert.equal(allowedView('identity', undefined, false), true)
  assert.equal(allowedView('retention', 'viewer', false), true)
  assert.equal(allowedView('collection', 'viewer', false), true)
  assert.equal(allowedView('team', 'viewer', false), false)
  assert.equal(allowedView('new-project', 'editor', false), true)
  assert.equal(allowedView('new-project', 'viewer', false), false)
  assert.equal(allowedView('providers', 'admin', false), false)
  assert.equal(allowedView('google-app', 'owner', false), false)
  assert.equal(allowedView('google-app', undefined, true), true)
  assert.equal(allowedView('meta-app', 'owner', false), false)
  assert.equal(allowedView('meta-app', undefined, true), true)
  assert.equal(allowedView('events', undefined, false), false)
  for (const view of ['keywords', 'ranks', 'audits', 'conversions', 'meta', 'meta-reports'] as const) {
    assert.deepEqual(parseNavigation({workspace, project, view}), {workspace, project, view})
    assert.equal(projectView(view), true)
    assert.equal(allowedView(view, 'viewer', false), true)
    assert.equal(allowedView(view, undefined, false), false)
  }
})

test('callbacks reject mixed families, duplicates and double-encoded capabilities', () => {
  const google = `#google=connected&google-project=${project}&google-workspace=${workspace}`
  assert.deepEqual(parseCallback(google), { kind: 'google', workspace, project })
  assert.deepEqual(parseCallback(`${google}&oidc-factor=1`), { kind: 'invalid' })
  assert.deepEqual(parseCallback(`${google}&google=connected`), { kind: 'invalid' })
  assert.deepEqual(parseCallback(`#oidc-proof=${project}`), { kind: 'proof', proof: project })
  assert.deepEqual(parseCallback('#oidc-factor=1'), { kind: 'factor' })
  assert.deepEqual(parseCallback('#oidc-factor=1&oidc-complete=1'), { kind: 'invalid' })
  assert.deepEqual(parseCallback('#invite=abc%2526oidc-factor%253D1'), { kind: 'invalid' })
  assert.deepEqual(parseCallback('#invite=first&invite=second'), { kind: 'invalid' })
  assert.deepEqual(parseCallback('#invite=' + 'a'.repeat(43)), { kind: 'invite', token: 'a'.repeat(43) })
  assert.deepEqual(parseCallback('#google=failed'), { kind: 'google-error' })
  assert.deepEqual(parseCallback('#' + 'x'.repeat(4096)), { kind: 'invalid' })
  assert.equal(parseCallback(''), null)
})

test('Meta returns accept only exact sanitized scope and fail without provider text', () => {
  const meta = `#meta=connected&meta-project=${project}&meta-workspace=${workspace}`
  assert.deepEqual(parseCallback(meta), { kind: 'meta', workspace, project })
  assert.deepEqual(parseCallback('#meta=failed'), { kind: 'meta-error' })
  for (const hash of [meta+'&google=connected', meta+'&oidc-factor=1', meta+'&invite='+'a'.repeat(43), meta+'&meta=connected', meta+'&return=https://example.test', '#meta=failed&error=private-value', '#meta=connected', '#meta=connected&meta-project='+project+'&meta-workspace=bad']) assert.deepEqual(parseCallback(hash), {kind:'invalid'})
})
