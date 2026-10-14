import assert from 'node:assert/strict'
import test from 'node:test'
import { auditCoverages, auditIssueCodes, allowedView, canonicalNavigation, navigationKey, parseCallback, parseNavigation, projectView } from '../src/lib/navigation.ts'

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
  for (const view of ['keywords', 'ranks', 'audits', 'conversions', 'meta', 'meta-reports', 'ai-insights'] as const) {
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

test('session deep links retain only bounded scope and definition references', () => {
  const visitorKey='a'.repeat(64),base={workspace,project,view:'sessions',from:'2026-10-01',to:'2026-10-14',timeZone:'Asia/Dubai'};
  const parsed=parseNavigation({...base,visitorKey,cohortId:project,cohortRevision:3,segmentId:workspace,segmentRevision:'2'});
  assert.deepEqual(parsed,{workspace,project,view:'sessions',timeZone:'Asia/Dubai',from:base.from,to:base.to,visitorKey,cohortId:project,cohortRevision:'3',segmentId:workspace,segmentRevision:'2'});
  assert.equal(canonicalNavigation('?'+new URLSearchParams(parsed as Record<string,string>),parsed),true);
  assert.equal(projectView('sessions'),true);
  assert.equal(allowedView('sessions','viewer',false),true);
  assert.equal(allowedView('sessions',undefined,false),false);
  assert.notEqual(navigationKey(parsed),navigationKey({...parsed,visitorKey:'b'.repeat(64)}));
  assert.notEqual(navigationKey(parsed),navigationKey({...parsed,to:'2026-10-13'}));
});

test('session navigation fails closed for malformed scope without retaining property values', () => {
  const base={workspace,project,view:'sessions',from:'2026-10-01',to:'2026-10-14',timeZone:'UTC'};
  for(const patch of [{from:'2026-02-30'},{to:'2026-09-01'},{from:['2026-10-01']},{timeZone:'Etc/Unknown'},{visitorKey:'A'.repeat(64)},{visitorKey:'a'.repeat(64)+'\n'},{cohortId:project},{cohortId:project,cohortRevision:'0'},{segmentId:workspace,segmentRevision:'2147483648'},{predicates:'private values'},{propertyValue:'private value'},{cursor:'private state'}]){
    const parsed=parseNavigation({...base,...patch});
    assert.deepEqual(parsed,{workspace,project,view:'sessions',sessionInvalid:'1'});
    assert.equal(JSON.stringify(parsed).includes('private'),false);
    assert.deepEqual(parseNavigation(parsed),parsed);
  }
  assert.deepEqual(parseNavigation({workspace,project,view:'sessions',visitorKey:'a'.repeat(64)}),{workspace,project,view:'sessions',sessionInvalid:'1'});
  assert.deepEqual(parseNavigation({...base,view:'events',visitorKey:'a'.repeat(64),cohortId:project,cohortRevision:'1'}),{workspace,project,view:'events'});
  assert.deepEqual(parseNavigation({view:'sessions',from:base.from,to:base.to,timeZone:'UTC'}),{view:'sessions'});
});

test('a skipped local calendar day remains a valid explicit session range', () => {
  // Apia skipped this date. The service may honestly return equal UTC bounds and zero events.
  const scope={workspace,project,view:'sessions',from:'2011-12-30',to:'2011-12-30',timeZone:'Pacific/Apia',visitorKey:'c'.repeat(64)};
  const parsed=parseNavigation(scope);
  assert.equal(parsed.sessionInvalid,undefined);
  assert.equal(parsed.from,'2011-12-30');assert.equal(parsed.to,'2011-12-30');assert.equal(parsed.timeZone,'Pacific/Apia');
  assert.equal(parsed.visitorKey,scope.visitorKey);
  assert.equal(canonicalNavigation('?'+new URLSearchParams(scope),parsed),true);
});

test('audit links retain only bounded applied scope and omit default values', () => {
  const base={workspace,project,view:'audits',auditRun:project} as const;
  const parsed=parseNavigation({...base,auditPage:workspace.toUpperCase(),auditTab:'pages',auditSeverity:'warning',auditCode:'missing-title',auditAffectedPage:workspace,auditCoverage:'analyzed',auditResource:'sitemap',auditDirection:'in'});
  assert.deepEqual(parsed,{...base,auditPage:workspace,auditAffectedPage:workspace,auditTab:'pages',auditSeverity:'warning',auditCode:'missing-title',auditCoverage:'analyzed',auditResource:'sitemap',auditDirection:'in'});
  assert.deepEqual(parseNavigation(parsed),parsed);
  assert.equal(canonicalNavigation('?'+new URLSearchParams(parsed as Record<string,string>),parsed),true);
  assert.notEqual(navigationKey(parsed),navigationKey({...parsed,auditPage:project}));
  assert.notEqual(navigationKey(parsed),navigationKey({...parsed,auditSeverity:'critical'}));
  assert.deepEqual(parseNavigation({...base,auditTab:'issues',auditResource:'html'}),base);
  assert.deepEqual(parseNavigation({...base,auditPage:workspace,auditDirection:'out'}),{...base,auditPage:workspace});
  for(const auditCode of auditIssueCodes)assert.equal(parseNavigation({...base,auditCode}).auditCode,auditCode);
  for(const auditCoverage of auditCoverages)assert.equal(parseNavigation({...base,auditCoverage}).auditCoverage,auditCoverage);
  assert.deepEqual(parseNavigation({...base,view:'events',auditPage:workspace}),{workspace,project,view:'events'});
});

test('audit links reject malformed, repeated, unknown and unscoped intent without retaining its values', () => {
  const base={workspace,project,view:'audits',auditRun:project} as const,invalid={workspace,project,view:'audits',auditInvalid:'1'};
  for(const patch of [{auditRun:[project,project]},{auditPage:{id:workspace}},{auditRun:project+'\n'},{auditSeverity:['warning']},{auditSeverity:'high'},{auditCode:'future-rule'},{auditCoverage:'all'},{auditResource:'script'},{auditDirection:'in'},{auditDirection:{value:'out'}},{auditTab:'performance'},{auditInvalid:'0'},{cursor:'private cursor'},{returnTo:'https://private.test'},{startPath:'/private'},{draft:'private draft'}]){
    const parsed=parseNavigation({...base,...patch});assert.deepEqual(parsed,invalid);assert.equal(JSON.stringify(parsed).includes('private'),false);assert.deepEqual(parseNavigation(parsed),parsed);
  }
  for(const patch of [{auditPage:project},{auditTab:'issues'},{auditResource:'html'},{auditSeverity:'warning'},{auditAffectedPage:workspace},{auditCoverage:'analyzed'}])assert.deepEqual(parseNavigation({workspace,project,view:'audits',...patch}),invalid);
  assert.deepEqual(parseNavigation({project,view:'audits',auditRun:project}),{view:'audits',auditInvalid:'1'});
  assert.deepEqual(parseNavigation({workspace,project:[project],view:'audits',auditRun:project}),{workspace,view:'audits',auditInvalid:'1'});
  assert.equal(canonicalNavigation(`?workspace=${workspace}&project=${project}&view=audits&auditRun=${project}&auditRun=${project}`,base),false);
});
