import assert from 'node:assert/strict'
import test from 'node:test'
import { analyticsDay, applyGeographyFilter, geographyNavigationNames, auditCoverages, auditIssueCodes, allowedView, canonicalNavigation, navigationKey, parseCallback, parseNavigation, projectView } from '../src/lib/navigation.ts'
import {geographyFields,serializeGeographyKey} from '../src/lib/analytics-geography.ts'
import {environmentCatalog,environmentFields} from '../src/lib/analytics-environment.ts'
import {defaultParseSearch,defaultStringifySearch} from '@tanstack/react-router'

const workspace = 'a0000000-0000-4000-8000-000000000001', project = 'b0000000-0000-4000-8000-000000000002'

test('canonical wire values agree with the installed router for revisions, invalid flags and JSON-looking strings',()=>{
 const cases=[
  {workspace,project,view:'sessions',from:'2026-10-01',to:'2026-10-14',timeZone:'UTC',segmentId:workspace,segmentRevision:'2',cohortId:project,cohortRevision:'3'},
  {workspace,project,view:'sessions',sessionInvalid:'1'},
  {workspace,project,view:'journeys',journeyInvalid:'1'},
  {workspace,project,view:'events'},
  ...['ordinary text','true','false','null','42','[1,2]','{"name":"value"}','"quoted"'].map(auditSearch=>({workspace,project,view:'audits',auditRun:project,auditSearch})),
 ];
 for(const input of cases){const target=parseNavigation(input),wire=defaultStringifySearch(target),parsed=parseNavigation(defaultParseSearch(wire));assert.deepEqual(parsed,target);assert.equal(canonicalNavigation(wire,parsed),true,wire);const entries=Object.entries(target),[key,value]=entries.at(-1)!;assert.equal(canonicalNavigation(wire+'&'+new URLSearchParams({[key]:value}),parsed),false,'duplicate scalar');const wrong=new URLSearchParams(wire);wrong.set(key,'mismatched');assert.equal(canonicalNavigation('?'+wrong,parsed),false,'mismatched scalar');if(wire!==('?'+new URLSearchParams(target as Record<string,string>)))assert.equal(canonicalNavigation('?'+new URLSearchParams(target as Record<string,string>),parsed),false,'JSON-looking strings require router quoting');}
});

test('Journeys keeps a scalar nested applied scope only in its own project read view',()=>{
 const base={workspace,project,view:'journeys'} as const,journeyQuery=new URLSearchParams({from:'2026-10-01',to:'2026-10-10',timeZone:'UTC',steps:'3',startKind:'pageview',startValue:'/"true"'}).toString(),value={...base,journeyQuery};
 assert.deepEqual(parseNavigation(value),value);assert.deepEqual(parseNavigation(value),parseNavigation(parseNavigation(value)));assert.equal(canonicalNavigation('?'+new URLSearchParams(value),value),true);assert.notEqual(navigationKey(value),navigationKey(base));assert.equal(projectView('journeys'),true);
 for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('journeys',role,false),true);assert.equal(allowedView('journeys',undefined,false),false);
 for(const bad of [null,1,true,{},[journeyQuery],'',journeyQuery+'\0','x'.repeat(65537)])assert.equal(parseNavigation({...base,journeyQuery:bad}).journeyInvalid,'1');
 for(const patch of [{workspace:undefined},{project:undefined},{from:'2026-01-01'}])assert.equal(parseNavigation({...value,...patch}).journeyInvalid,'1');
 assert.deepEqual(parseNavigation({...value,view:'project'}),{workspace,project,view:'project'});assert.deepEqual(parseNavigation({...value,view:'explore'}),{workspace,project,view:'explore'});
});

test('location filters retain canonical composite identity, report intent and strict scalar scope',()=>{
  const base={workspace,project,view:'compare'} as const,scope={analyticsFrom:'2024-02-28',analyticsTo:'2024-02-29',analyticsCompare:'yoy' as const,analyticsBrowser:'chrome'};
  const city={state:'known' as const,country:'US',region:{kind:'code' as const,value:'US-IL'},city:'Springfield'};
  const chosen=applyGeographyFilter(scope,'city',city),parsed=parseNavigation({...base,...chosen});
  assert.deepEqual(parsed,{...base,...chosen});assert.deepEqual(parseNavigation(parsed),parsed);
  const wire=Object.fromEntries(Object.entries(parsed).map(([key,value])=>[key,(Object.values(geographyNavigationNames) as string[]).includes(key)?JSON.stringify(value):value]));
  assert.equal(canonicalNavigation('?'+new URLSearchParams(wire as Record<string,string>),parsed),true);
  assert.equal(canonicalNavigation('?'+new URLSearchParams(parsed as Record<string,string>),parsed),false);
  assert.equal(parsed.analyticsCountry,serializeGeographyKey('country',{state:'known',country:'US'}));
  assert.equal(parsed.analyticsRegion,serializeGeographyKey('region',{state:'known',country:'US',region:city.region}));
  for(const field of geographyFields){const name=geographyNavigationNames[field],value=chosen[name]!;for(const invalid of [[value],{value},JSON.stringify(JSON.parse(value),null,1),value.replace('"US"','"us"'),'not-recorded','{"state":"known","country":"US","extra":1}'])assert.equal(parseNavigation({...base,...scope,[name]:invalid}).analyticsInvalid,'1');}
  assert.deepEqual(parseNavigation({...parsed,view:'explore'}),{workspace,project,view:'explore'});
  assert.notEqual(navigationKey(parsed),navigationKey({...parsed,analyticsCity:undefined}));
  const unknown=applyGeographyFilter(chosen,'city',{state:'unknown'});assert.equal(unknown.analyticsCountry,chosen.analyticsCountry);assert.equal(unknown.analyticsRegion,chosen.analyticsRegion);
  const noRegion=applyGeographyFilter(chosen,'city',{...city,region:null});assert.equal(noRegion.analyticsRegion,'{"state":"unknown"}');
  assert.deepEqual(applyGeographyFilter(chosen,'country',{state:'known',country:'US'}),chosen);
  const unknownCountry=applyGeographyFilter(chosen,'country',{state:'unknown'});assert.equal(unknownCountry.analyticsRegion,undefined);assert.equal(unknownCountry.analyticsCity,undefined);
  const unknownRegion=applyGeographyFilter(chosen,'region',{state:'unknown'});assert.equal(unknownRegion.analyticsCountry,chosen.analyticsCountry);assert.equal(unknownRegion.analyticsCity,undefined);
  for(const country of [{state:'unknown'},{state:'not-recorded'}])assert.equal(parseNavigation({...base,analyticsCountry:serializeGeographyKey('country',country),analyticsCity:chosen.analyticsCity}).analyticsInvalid,'1');
  assert.equal(parseNavigation({...base,analyticsRegion:'{"state":"unknown"}',analyticsCity:chosen.analyticsCity}).analyticsInvalid,'1');
  assert.equal(parseNavigation({...base,analyticsRegion:'{"state":"not-recorded"}',analyticsCity:noRegion.analyticsCity}).analyticsInvalid,'1');
  assert.equal(parseNavigation({...base,...noRegion}).analyticsInvalid,undefined);
  for(const key of [{state:'unknown'},{state:'not-recorded'},{state:'known',country:'US',region:{kind:'name',value:'Unknown'},city:'Unknown'}]){const value=serializeGeographyKey('city',key)!;assert.equal(parseNavigation({...base,analyticsCity:value}).analyticsCity,value);}
});

test('Compare is a project read view with an optional strict mode and the same applied dates/filters',()=>{
  const base={workspace,project,view:'compare'} as const,values={analyticsFrom:'2024-02-28',analyticsTo:'2024-02-29',analyticsBrowser:'chrome',analyticsOs:'Mac OS',analyticsDevice:'desktop'};
  assert.deepEqual(parseNavigation(base),base);
  assert.equal(projectView('compare'),true);
  for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('compare',role,false),true);
  assert.equal(allowedView('compare',undefined,false),false);
  for(const analyticsCompare of ['prev','yoy'] as const){
    const search=parseNavigation({...base,...values,analyticsCompare});assert.deepEqual(search,{...base,...values,analyticsCompare});
    assert.deepEqual(parseNavigation(search),search);assert.equal(canonicalNavigation('?'+new URLSearchParams(search as Record<string,string>),search),true);
    assert.notEqual(navigationKey(search),navigationKey(parseNavigation({...base,...values})));
  }
  assert.notEqual(navigationKey({...base,analyticsCompare:'prev'}),navigationKey({...base,analyticsCompare:'yoy'}));
  assert.deepEqual(parseNavigation({...base,view:'explore',...values,analyticsCompare:'yoy'}),{workspace,project,view:'explore'});
});

test('Compare links reject ambiguous mode/scope and never enable comparison in the ordinary overview',()=>{
  const base={workspace,project,view:'compare'} as const,invalid={...base,analyticsInvalid:'1'};
  for(const analyticsCompare of ['',null,true,1,'previous','YOY','yoy\n',['prev'],['prev','prev'],{mode:'prev'}])assert.deepEqual(parseNavigation({...base,analyticsCompare}),invalid);
  for(const patch of [{workspace:undefined},{project:undefined},{project:[project]}])assert.equal(parseNavigation({...base,...patch,analyticsCompare:'prev'}).analyticsInvalid,'1');
  assert.deepEqual(parseNavigation({...base,analyticsCompare:'yoy',analyticsFrom:'2024-02-28',analyticsTo:'2025-02-28'}),invalid);
  assert.deepEqual(parseNavigation({...base,view:'project',analyticsCompare:'prev'}),{workspace,project,view:'project',analyticsInvalid:'1'});
  assert.equal(canonicalNavigation('?'+new URLSearchParams({...base,analyticsCompare:'prev'})+'&analyticsCompare=prev',parseNavigation({...base,analyticsCompare:'prev'})),false);
  assert.deepEqual(parseNavigation({...base,analyticsCompare:'prev',analyticsPriorFrom:'private'}),invalid);
});

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
  assert.equal(canonicalNavigation(defaultStringifySearch(parsed),parsed),true);
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

test('identified activity navigation is a closed range and observed-key mode', () => {
  const base={workspace,project,view:'sessions',from:'2026-10-01',to:'2026-10-14',timeZone:'UTC',visitorKey:'a'.repeat(64)};
  const parsed=parseNavigation({...base,activity:'identified'});
  assert.equal(parsed.activity,'identified');assert.equal(parsed.sessionInvalid,undefined);
  assert.equal(canonicalNavigation('?'+new URLSearchParams({...base,activity:'identified'}),parsed),true);
  assert.notEqual(navigationKey(parsed),navigationKey(parseNavigation(base)));
  for(const patch of [{activity:'all'},{activity:['identified']},{activity:{mode:'identified'}},{visitorKey:undefined},{from:undefined},{identityToken:'private'},{keyGeneration:'private'},{rawId:'private'},{returnTo:'private'},{cursor:'private'}])assert.deepEqual(parseNavigation({...base,activity:'identified',...patch}),{workspace,project,view:'sessions',sessionInvalid:'1'});
  assert.equal(canonicalNavigation('?'+new URLSearchParams({...base,activity:'identified'})+'&activity=identified',parsed),false);
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

test('analytics links preserve the applied UTC range and all three closed environment filters', () => {
  const base={workspace,project,view:'project'} as const;
  const values={analyticsFrom:'2024-02-28',analyticsTo:'2024-02-29',analyticsBrowser:'chrome',analyticsOs:'Mac OS',analyticsDevice:'desktop'};
  const parsed=parseNavigation({...base,...values});
  assert.deepEqual(parsed,{...base,...values});assert.deepEqual(parseNavigation(parsed),parsed);
  assert.equal(canonicalNavigation('?'+new URLSearchParams(parsed as Record<string,string>),parsed),true);
  for(const key of Object.keys(values))assert.notEqual(navigationKey(parsed),navigationKey(parseNavigation({...base,...Object.fromEntries(Object.entries(values).filter(([name])=>name!==key))})));
  for(const field of environmentFields)for(const value of [...environmentCatalog[field],'not-recorded']){
    const name=field==='browser'?'analyticsBrowser':field==='os'?'analyticsOs':'analyticsDevice';
    assert.equal(parseNavigation({...base,[name]:value})[name],value);
  }
  assert.equal(analyticsDay('2024-02-29'),Date.parse('2024-02-29T00:00:00Z'));
  assert.equal(analyticsDay('2026-02-29'),null);
  assert.deepEqual(parseNavigation({...base,view:'explore',...values}),{...base,view:'explore'});
});

test('analytics links fail closed for ambiguous scope, unsupported families and malformed dates', () => {
  const base={workspace,project,view:'project'} as const,dates={analyticsFrom:'2024-02-28',analyticsTo:'2024-02-29'},invalid={...base,analyticsInvalid:'1'};
  for(const patch of [{analyticsBrowser:['chrome','chrome']},{analyticsBrowser:{value:'chrome'}},{analyticsBrowser:'Chrome'},{analyticsOs:'Windows 11'},{analyticsDevice:'phone'},{analyticsDevice:'unknown\n'},{analyticsFrom:['2024-02-28']},{analyticsFrom:'2024-02-30'},{analyticsTo:'2024-02-27'},{analyticsTo:undefined},{analyticsFrom:undefined},{analyticsFrom:'2023-01-01'},{analyticsTo:'9998-12-31'},{analyticsInvalid:'0'},{analyticsCursor:'private cursor'},{draft:'private draft'}]){
    const parsed=parseNavigation({...base,...dates,...patch});assert.deepEqual(parsed,invalid);assert.deepEqual(parseNavigation(parsed),parsed);assert.equal(JSON.stringify(parsed).includes('private'),false);
  }
  for(const patch of [{workspace:undefined},{project:undefined},{workspace:[workspace]},{project:[project]}])assert.equal(parseNavigation({...base,...patch,...dates}).analyticsInvalid,'1');
  assert.equal(canonicalNavigation('?'+new URLSearchParams({...base,...dates})+'&analyticsFrom=2024-02-28',parseNavigation({...base,...dates})),false);
  assert.deepEqual(parseNavigation({...base,unrelated:'private value'}),base);
});

test('realtime navigation is a fixed project view without retained report or activity drafts', () => {
  const base={workspace,project,view:'realtime'} as const;
  assert.equal(projectView('realtime'),true);assert.equal(allowedView('realtime','viewer',false),true);assert.equal(allowedView('realtime',undefined,false),false);
  assert.deepEqual(parseNavigation({...base,analyticsFrom:'2024-02-28',analyticsTo:'2024-02-29',analyticsBrowser:'chrome',visitorKey:'a'.repeat(64),from:'2026-10-15',search:'private draft',kind:'custom',cursor:'private cursor'}),base);
  assert.equal(canonicalNavigation('?'+new URLSearchParams(base),base),true);
  assert.notEqual(navigationKey(base),navigationKey({...base,view:'project'}));
});

test('audit Pages query round-trips applied search and ordering while defaults stay omitted', () => {
  const base={workspace,project,view:'audits',auditRun:project} as const;
  const defaults={auditSearch:'  ',auditSearchIn:'url_title_meta',auditSort:'url',auditOrder:'asc'};
  assert.deepEqual(parseNavigation({...base,...defaults}),base);
  assert.equal(navigationKey(parseNavigation({...base,...defaults})),navigationKey(base));
  assert.equal(canonicalNavigation('?'+new URLSearchParams({...base,...defaults}),base),false);
  const parsed=parseNavigation({...base,auditRun:project.toUpperCase(),auditTab:'pages',auditSearch:'  Price  café 🧪 %_\\  ',auditSearchIn:'url',auditSort:'images',auditOrder:'desc',auditPage:workspace,auditDirection:'in'});
  assert.deepEqual(parsed,{...base,auditPage:workspace,auditTab:'pages',auditDirection:'in',auditSearch:'Price  café 🧪 %_\\',auditSearchIn:'url',auditSort:'images',auditOrder:'desc'});
  const url='?'+new URLSearchParams(parsed as Record<string,string>);
  assert.deepEqual(parseNavigation(Object.fromEntries(new URLSearchParams(url))),parsed);
  assert.equal(canonicalNavigation(url,parsed),true);
  for(const [key,value] of [['auditSearch','different'],['auditSearchIn',undefined],['auditSort','title'],['auditOrder',undefined]] as const)assert.notEqual(navigationKey({...parsed,[key]:value}),navigationKey(parsed));
  for(const auditSort of ['httpStatus','title','h1','wordCount','images','responseTimeMs'])assert.equal(parseNavigation({...base,auditSort}).auditSort,auditSort);
  const issues=parseNavigation({...parsed,auditTab:'issues',auditSeverity:'warning',auditCode:'missing-title'});
  assert.equal(issues.auditTab,undefined);assert.equal(issues.auditSearch,parsed.auditSearch);assert.equal(issues.auditSort,parsed.auditSort);
  assert.equal(issues.auditSeverity,'warning');assert.equal(issues.auditCode,'missing-title');
  assert.deepEqual(parseNavigation({...issues,auditTab:'pages'}),{...issues,auditTab:'pages'});
  assert.deepEqual(parseNavigation({...parsed,view:'events'}),{workspace,project,view:'events'});
});

test('audit Pages search preserves Unicode and literal internal text within scalar and byte bounds', () => {
  const base={workspace,project,view:'audits',auditRun:project} as const;
  for(const auditSearch of ['🧪'.repeat(200),'é'.repeat(200),'e\u0301'.repeat(100),'x'.repeat(200),'Mixed  case %_\\'])assert.equal(parseNavigation({...base,auditSearch}).auditSearch,auditSearch);
  for(const auditSearch of ['🧪'.repeat(201),'e\u0301'.repeat(101),'x'.repeat(201),'\ud800','\udc00','x\ud800y','\udc00\ud800','\0search','\tsearch','search\n','search\r','search\u007f','search\u0085']){
    const parsed=parseNavigation({...base,auditSearch});assert.deepEqual(parsed,{workspace,project,view:'audits',auditInvalid:'1'});
    assert.deepEqual(parseNavigation(parsed),parsed);
  }
});

test('audit Pages query fails closed for repeated, malformed, unknown and unscoped values', () => {
  const base={workspace,project,view:'audits',auditRun:project} as const,invalid={workspace,project,view:'audits',auditInvalid:'1'};
  for(const [key,valid] of [['auditSearch','private query'],['auditSearchIn','url'],['auditSort','title'],['auditOrder','desc']] as const){
    for(const value of [[valid],[valid,valid],{value:valid},null,true,42])assert.deepEqual(parseNavigation({...base,[key]:value}),invalid);
    const parsed=parseNavigation({...base,[key]:valid});
    assert.equal(canonicalNavigation('?'+new URLSearchParams(parsed as Record<string,string>)+'&'+new URLSearchParams({[key]:valid}),parsed),false);
    assert.deepEqual(parseNavigation({workspace,project,view:'audits',[key]:valid}),invalid);
    assert.deepEqual(parseNavigation({view:'audits',auditRun:project,[key]:valid}),{view:'audits',auditInvalid:'1'});
  }
  for(const patch of [{auditSearchIn:''},{auditSearchIn:'URL'},{auditSearchIn:'title'},{auditSort:''},{auditSort:'url desc'},{auditSort:'constructor'},{auditOrder:''},{auditOrder:'DESC'},{auditOrder:'random'},{search:'private query'},{searchIn:'url'},{sort:'title'},{order:'desc'},{export:'json'},{format:'csv'},{limit:'50'},{cursor:'private cursor'},{auditCursor:'private cursor'},{auditDraft:'private draft'}]){
    const parsed=parseNavigation({...base,...patch});assert.deepEqual(parsed,invalid);assert.equal(JSON.stringify(parsed).includes('private'),false);
  }
  assert.deepEqual(parseNavigation({...base,auditSearch:'safe',auditDirection:'in'}),invalid);
  assert.deepEqual(parseNavigation({...base,auditSearch:'safe',project:[project]}),{workspace,view:'audits',auditInvalid:'1'});
  assert.deepEqual(parseNavigation({...base,auditSearch:'safe',workspace:undefined}),{view:'audits',auditInvalid:'1'});
});
