import assert from 'node:assert/strict'
import test from 'node:test'
import { analyticsDay, applyGeographyFilter, geographyNavigationNames, auditCoverages, auditIssueCodes, views, allowedView, canonicalNavigation, navigationKey, parseCallback, parseNavigation, projectView, explorerNavigation } from '../src/lib/navigation.ts'
import {geographyFields,serializeGeographyKey} from '../src/lib/analytics-geography.ts'
import {environmentCatalog,environmentFields} from '../src/lib/analytics-environment.ts'
import {defaultParseSearch,defaultStringifySearch} from '@tanstack/react-router'
import {readAISearchIntent,aiSearchIntentQuery} from '../src/lib/navigation.ts'

const workspace = 'a0000000-0000-4000-8000-000000000001', project = 'b0000000-0000-4000-8000-000000000002'

test('provider setup links preselect only a known provider on Settings › Connections',()=>{
 const target={workspace,project,view:'providers',provider:'dataforseo'} as const;
 assert.deepEqual(parseNavigation(defaultParseSearch(defaultStringifySearch(target))),target);
 assert.equal(parseNavigation({...target,provider:'openrouter'}).provider,'openrouter');
 for(const provider of ['ahrefs','DataForSEO','',['dataforseo'],1])assert.deepEqual(parseNavigation({...target,provider}),{workspace,project,view:'providers'});
 assert.equal(parseNavigation({...target,view:'keywords'}).provider,undefined);
});

test('performance routes retain their exact applied scope across copies and reject unrelated or duplicate capabilities',()=>{
 const target={workspace,project,view:'performance',performanceQuery:'from=2026-10-01&to=2026-10-07&metric=cls&percentile=95&breakdown=path&path=%2Fcheckout'} as const;
 const wire=defaultStringifySearch(target);assert.deepEqual(parseNavigation(defaultParseSearch(wire)),target);assert.equal(canonicalNavigation(wire,target),true);assert.equal(projectView('performance'),true);
 for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('performance',role,false),true);
 assert.equal(allowedView('performance',undefined,false),false);
 for(const raw of [{...target,analyticsBrowser:'Chrome'},{...target,project:undefined},{...target,performanceQuery:[]},{...target,performanceQuery:'a\0b'},{...target,performanceInvalid:'1'}])assert.equal(parseNavigation(raw).performanceInvalid,'1');
 assert.equal(canonicalNavigation(wire+'&performanceQuery=other',target),false);assert.notEqual(navigationKey(target),navigationKey({...target,performanceQuery:'metric=inp'}));
 for(const performanceQuery of ['path=%2F%ED%A0%80','path=%2F%GG','path=%2F%FF','path=%2F%'])assert.equal(parseNavigation({...target,performanceQuery}).performanceInvalid,'1');
 for(const performanceQuery of ['path=%2F100%25','path=%2F%EF%BF%BD'])assert.equal(parseNavigation({...target,performanceQuery}).performanceQuery,performanceQuery);
 const invalid={workspace,project,view:'performance',performanceInvalid:'1'} as const;assert.deepEqual(parseNavigation(defaultParseSearch(defaultStringifySearch(invalid))),invalid);
});

test('returned Analytics population uses the existing scalar serializer without Explore or Compare presentation',()=>{
 const predicates={version:1,match:'all',fields:[{field:'path',operator:'eq',value:''},{field:'eventName',operator:'exists'},{field:'campaignName',operator:'eq',value:'null'}],properties:[]},analyticsSelection=new URLSearchParams({predicates:JSON.stringify(predicates)}).toString();
 const target={workspace,project,view:'project',analyticsFrom:'2026-10-01',analyticsTo:'2026-10-07',analyticsBrowser:'not-recorded',analyticsSelection} as const;
 const wire=defaultStringifySearch(target);assert.deepEqual(parseNavigation(defaultParseSearch(wire)),target);assert.equal(canonicalNavigation(wire,target),true);assert.equal(Object.hasOwn(parseNavigation(target),'analyticsCompare'),false);assert.equal(Object.hasOwn(parseNavigation(target),'analyticsDimension'),false);assert.equal(Object.hasOwn(parseNavigation(target),'exploreQuery'),false);
 assert.equal(parseNavigation({...target,analyticsCompare:'prev'}).analyticsInvalid,'1');assert.equal(parseNavigation({...target,analyticsDimension:'path'}).analyticsInvalid,'1');assert.equal(canonicalNavigation(wire+'&analyticsSelection=x',target),false);
});

test('unsupported return sentinel is reload-stable and history return addresses never become query capabilities',()=>{
 const target={workspace,project,view:'project',analyticsInvalid:'1'} as const,wire=defaultStringifySearch(target);
 assert.deepEqual(parseNavigation(defaultParseSearch(wire)),target);assert.equal(canonicalNavigation(wire,target),true);
 const applied={workspace,project,view:'project',analyticsFrom:'2026-10-01',analyticsTo:'2026-10-07'} as const;
 for(const extra of [{analyticsReturn:'https://outside.example.org/'},{analyticsReturn:{userId:'someone'}},{exploreQuery:'kind=all'},{cohortId:workspace},{propertyKey:'private'}])assert.equal(parseNavigation({...applied,...extra}).analyticsInvalid,'1');
 assert.deepEqual(parseNavigation({...applied,view:'explore'}),{workspace,project,view:'explore',exploreInvalid:'1'});
});

test('Explore keeps one bounded project-scoped query through router reload and history',()=>{
 const base={workspace,project,view:'explore'} as const,query=new URLSearchParams({from:'2026-10-01',to:'2026-10-07',timeZone:'Asia/Dubai',kind:'all',groupBy:'event',path:'/مرحبا?literal=true',browser:'not-recorded'}).toString();
 for(const exploreQuery of [query,'from=2026-10-01&to=2026-10-07&timeZone=UTC&kind=all&fields=%5B%22campaignSource%22%2C%22campaignMedium%22%5D']){
  const target={...base,exploreQuery},wire=defaultStringifySearch(target);assert.deepEqual(parseNavigation(defaultParseSearch(wire)),target);assert.equal(canonicalNavigation(wire,target),true);assert.notEqual(navigationKey(target),navigationKey(base));assert.equal(canonicalNavigation(wire+'&exploreQuery=x',target),false);assert.deepEqual(parseNavigation({...target,view:'project'}),{workspace,project,view:'project'});
 }
 assert.deepEqual(explorerNavigation(base),{});for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('explore',role,false),true);assert.equal(allowedView('explore',undefined,false),false);
});

test('invalid or legacy Explore scope becomes an explicit stable sentinel instead of a broader report',()=>{
 const base={workspace,project,view:'explore'} as const,invalid={...base,exploreInvalid:'1'} as const;
 for(const exploreQuery of ['',null,1,true,{},['kind=all'],'x'.repeat(20001),'x\0','x\ud800'])assert.deepEqual(parseNavigation({...base,exploreQuery}),invalid);
 for(const extra of [{from:'2026-10-01'},{analyticsFrom:'2026-10-01'},{analyticsSelection:'path=x'},{propertyCursor:'old-snapshot'},{unknown:'x'}])assert.deepEqual(parseNavigation({...base,...extra}),invalid);
 assert.deepEqual(parseNavigation(invalid),invalid);const wire=defaultStringifySearch(invalid);assert.deepEqual(parseNavigation(defaultParseSearch(wire)),invalid);assert.equal(canonicalNavigation(wire,invalid),true);
 assert.equal(parseNavigation({...base,project:undefined,exploreQuery:'kind=all'}).exploreInvalid,'1');assert.equal(parseNavigation({...base,workspace:undefined,exploreQuery:'kind=all'}).exploreInvalid,'1');
 assert.deepEqual(parseNavigation({...base,exploreQuery:'x'.repeat(20000)}),{...base,exploreQuery:'x'.repeat(20000)},'nested semantics are checked by the existing Explorer controls before a report read');
});

test('AI search preserves exact nested analysis/capture scope through the installed router without leaking to sibling views',()=>{
 const intent=readAISearchIntent()!,base={workspace,project,view:'ai-search'} as const;
 for(const value of [intent,{...intent,tab:'words' as const,filters:{...intent.filters,lookback:'all' as const,promptId:project,versionId:workspace,tag:'true',reportedModel:{state:'reported' as const,value:'null'}}},{...intent,section:'captures' as const,captureId:workspace},{...intent,section:'captures' as const,create:true,filters:{...intent.filters,promptId:project,versionId:workspace}}]){
  const target={...base,aiSearchQuery:aiSearchIntentQuery(value)},wire=defaultStringifySearch(target);assert.deepEqual(parseNavigation(defaultParseSearch(wire)),target);assert.deepEqual(readAISearchIntent(target.aiSearchQuery),value);assert.equal(canonicalNavigation(wire,target),true);assert.notEqual(navigationKey(target),navigationKey(base));assert.deepEqual(parseNavigation({...target,view:'prompts'}),{workspace,project,view:'prompts'});assert.equal(canonicalNavigation(wire+'&aiSearchQuery=x',target),false);
 }
 for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('ai-search',role,false),true);assert.equal(allowedView('ai-search',undefined,false),false);assert.equal(projectView('ai-search'),true);
});
test('AI search rejects malformed, duplicated and contradictory nested intent instead of broadening it',()=>{
 const base={workspace,project,view:'ai-search'} as const;
 for(const aiSearchQuery of [null,{},[],true,1,'','x'.repeat(6145),'section=analysis&captureId='+project,'section=captures&captureId='+project+'&create=1','section=captures&create=true','section=other','tab=top&promptId='+project,'versionId='+project,'lookback=all&lookback=all','timeZone=Bad','tag=','reportedModel=null','reportedModel='+encodeURIComponent('{"value":"x","state":"reported"}'),'query=raw','lookback=all\0','\ud800'])assert.equal(parseNavigation({...base,aiSearchQuery}).aiSearchInvalid,'1',String(aiSearchQuery));
 for(const patch of [{workspace:undefined},{project:undefined},{from:'2026-01-01'},{aiSearchInvalid:'1'}])assert.equal(parseNavigation({...base,...patch}).aiSearchInvalid,'1');
 assert.deepEqual(readAISearchIntent('lookback=all&timeZone=US%2FEastern')?.filters.timeZone,'America/New_York');
});

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
test('visitor retention keeps an explicit applied month and nested typed entry scope separate from Data retention',()=>{
  const base={workspace,project,view:'visitor-retention'} as const,entry=new URLSearchParams({kind:'custom',path:'/café %_\\',propertyKey:'done',propertyType:'boolean',propertyValue:'false',city:serializeGeographyKey('city',{state:'known',country:'US',region:{kind:'code',value:'US-IL'},city:'Springfield'})!}).toString(),applied={...base,retentionMonth:'2024-03',retentionTimeZone:'UTC',retentionEntry:entry};
  assert.deepEqual(parseNavigation(base),base);assert.deepEqual(parseNavigation(applied),applied);assert.equal(canonicalNavigation('?'+new URLSearchParams(applied),applied),true);assert.deepEqual(parseNavigation(Object.fromEntries(new URLSearchParams(new URLSearchParams(applied).toString()))),applied);
  for(const [key,value]of [['retentionMonth','2024-02'],['retentionTimeZone','Asia/Dubai'],['retentionEntry','kind=all']] as const)assert.notEqual(navigationKey(applied),navigationKey({...applied,[key]:value}));
  for(const view of ['project','retention','explore'] as const)assert.deepEqual(parseNavigation({...applied,view}),{workspace,project,view,...view==='explore'?{exploreInvalid:'1'}:{}});assert.equal(projectView('visitor-retention'),true);assert.equal(projectView('retention'),false);for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('visitor-retention',role,false),true);
});
test('visitor retention navigation rejects unknown, partial, future and nonscalar intent without silently broadening it',()=>{
  const base={workspace,project,view:'visitor-retention',retentionMonth:'2024-03',retentionTimeZone:'UTC',retentionEntry:'kind=all'} as const,invalid={workspace,project,view:'visitor-retention',retentionInvalid:'1'};
  for(const patch of [{retentionMonth:undefined},{retentionTimeZone:undefined},{retentionMonth:'2024-13'},{retentionMonth:'1969-12'},{retentionMonth:'9999-01'},{retentionTimeZone:'Bad'},{retentionTimeZone:['UTC']},{retentionMonth:['2024-03','2024-03']},{retentionEntry:{kind:'all'}},{retentionEntry:'x'.repeat(20001)},{retentionEntry:'\ud800'},{retentionEntry:'x\0y'},{compare:'prev'},{from:'2024-03-01'},{retentionDraft:'private'}])assert.deepEqual(parseNavigation({...base,...patch}),invalid);
  assert.deepEqual(parseNavigation(invalid),invalid);assert.equal(canonicalNavigation('?'+new URLSearchParams(base)+'&retentionMonth=2024-03',base),false);assert.deepEqual(parseNavigation({...base,project:undefined}),{workspace,view:'visitor-retention',retentionInvalid:'1'});
});

test('Journeys keeps a scalar nested applied scope only in its own project read view',()=>{
 const base={workspace,project,view:'journeys'} as const,journeyQuery=new URLSearchParams({from:'2026-10-01',to:'2026-10-10',timeZone:'UTC',steps:'3',startKind:'pageview',startValue:'/"true"'}).toString(),value={...base,journeyQuery};
 assert.deepEqual(parseNavigation(value),value);assert.deepEqual(parseNavigation(value),parseNavigation(parseNavigation(value)));assert.equal(canonicalNavigation('?'+new URLSearchParams(value),value),true);assert.notEqual(navigationKey(value),navigationKey(base));assert.equal(projectView('journeys'),true);
 for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('journeys',role,false),true);assert.equal(allowedView('journeys',undefined,false),false);
 for(const bad of [null,1,true,{},[journeyQuery],'',journeyQuery+'\0','x'.repeat(65537)])assert.equal(parseNavigation({...base,journeyQuery:bad}).journeyInvalid,'1');
 for(const patch of [{workspace:undefined},{project:undefined},{from:'2026-01-01'}])assert.equal(parseNavigation({...value,...patch}).journeyInvalid,'1');
 assert.deepEqual(parseNavigation({...value,view:'project'}),{workspace,project,view:'project'});assert.deepEqual(parseNavigation({...value,view:'explore'}),{workspace,project,view:'explore',exploreInvalid:'1'});
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
  assert.deepEqual(parseNavigation({...parsed,view:'explore'}),{workspace,project,view:'explore',exploreInvalid:'1'});
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
  assert.deepEqual(parseNavigation({...base,view:'explore',...values,analyticsCompare:'yoy'}),{workspace,project,view:'explore',exploreInvalid:'1'});
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
  assert.equal(allowedView('events', undefined, false), false)
  // The removed Meta views are no longer routable; an old link opens the project overview.
  for (const view of ['meta', 'meta-app', 'meta-reports']) {
    assert.equal((views as readonly string[]).includes(view), false)
    assert.deepEqual(parseNavigation({workspace, project, view}), {workspace, project, view: 'project'})
  }
  for (const view of ['keywords', 'ranks', 'audits', 'conversions', 'ai-insights'] as const) {
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

test('Former Meta returns are no callback family and fail closed without provider text', () => {
  const meta = `#meta=connected&meta-project=${project}&meta-workspace=${workspace}`
  for (const hash of [meta, '#meta=failed', meta+'&oidc-factor=1', meta+'&invite='+'a'.repeat(43), '#meta=failed&error=private-value']) assert.deepEqual(parseCallback(hash), {kind:'invalid'})
  assert.deepEqual(parseCallback(meta+'&google=connected'), {kind:'google-error'}, 'Leftover Meta keys make a Google return fail like any unknown key.')
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
  assert.deepEqual(parseNavigation({...base,view:'explore',...values}),{...base,view:'explore',exploreInvalid:'1'});
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


test('Revenue keeps its closed scalar applied query and detail key in one project read view',()=>{
 const base={workspace,project,view:'revenue'} as const,revenueQuery=new URLSearchParams({from:'2026-10-10',to:'2026-10-12',timeZone:'UTC',currency:'USD'}).toString(),value={...base,revenueQuery,revenueKey:'a'.repeat(64)};assert.deepEqual(parseNavigation(value),value);assert.deepEqual(parseNavigation(parseNavigation(value)),value);assert.equal(canonicalNavigation('?'+new URLSearchParams(value),value),true);assert.notEqual(navigationKey(value),navigationKey({...base,revenueQuery}));assert.equal(projectView('revenue'),true);for(const role of['owner','admin','editor','viewer'])assert.equal(allowedView('revenue',role,false),true);
 for(const patch of[{revenueQuery:[revenueQuery]},{revenueQuery:''},{revenueKey:'A'.repeat(64)},{revenueKey:'a'.repeat(63)},{revenueQuery:undefined},{project:undefined},{workspace:undefined},{currency:'USD'}])assert.equal(parseNavigation({...value,...patch}).revenueInvalid,'1');assert.deepEqual(parseNavigation({...value,view:'project'}),{workspace,project,view:'project'});
});


test('Revenue detail keys round-trip the installed native router JSON string serializer',async()=>{
 const{defaultStringifySearch,defaultParseSearch}=await import('@tanstack/react-router');
 const base={workspace,project,view:'revenue',revenueQuery:new URLSearchParams({from:'2026-10-10',to:'2026-10-12',timeZone:'UTC',currency:'USD'}).toString()} as const;
 for(const revenueKey of['1'.repeat(64),'1'+'0'.repeat(60)+'e10','0'.repeat(64)]){const value={...base,revenueKey},wire=defaultStringifySearch(value);assert.deepEqual(parseNavigation(defaultParseSearch(wire)),value);assert.equal(canonicalNavigation(wire,value),true);}
});

test('Revenue calendar step is closed UI metadata, retained with query/detail and rejected without a query',async()=>{
 const {defaultStringifySearch,defaultParseSearch}=await import('@tanstack/react-router');
 const base={workspace,project,view:'revenue',revenueQuery:'from=2024-02-01&to=2024-02-29&timeZone=UTC&currency=USD'}as const,value={...base,revenueCalendar:'months' as const,revenueKey:'a'.repeat(64)},wire=defaultStringifySearch(value);
 assert.deepEqual(parseNavigation(defaultParseSearch(wire)),value);assert.equal(canonicalNavigation(wire,value),true);assert.notEqual(navigationKey(value),navigationKey({...base,revenueKey:value.revenueKey}));
 for(const bad of['days','month','',null,1,true,['months'],{unit:'months'}])assert.equal(parseNavigation({...value,revenueCalendar:bad}).revenueInvalid,'1');
 assert.equal(parseNavigation({...value,revenueQuery:undefined,revenueKey:undefined}).revenueInvalid,'1');assert.deepEqual(parseNavigation({...value,view:'project'}),{workspace,project,view:'project'});
});

test('Attribution keeps a scalar nested applied scope only in its own project read view',()=>{
 const base={workspace,project,view:'attribution'} as const,attributionQuery=new URLSearchParams({from:'2026-10-01',to:'2026-10-10',timeZone:'UTC',model:'first-click',conversionKind:'pageview',conversionValue:'/"true"'}).toString(),value={...base,attributionQuery};
 assert.deepEqual(parseNavigation(value),value);assert.deepEqual(parseNavigation(value),parseNavigation(parseNavigation(value)));assert.equal(canonicalNavigation('?'+new URLSearchParams(value),value),true);assert.notEqual(navigationKey(value),navigationKey(base));assert.equal(projectView('attribution'),true);
 for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('attribution',role,false),true);assert.equal(allowedView('attribution',undefined,false),false);
 for(const bad of [null,1,true,{},[attributionQuery],'',attributionQuery+'\0','x'.repeat(65537)])assert.equal(parseNavigation({...base,attributionQuery:bad}).attributionInvalid,'1');
 for(const patch of [{workspace:undefined},{project:undefined},{from:'2026-01-01'}])assert.equal(parseNavigation({...value,...patch}).attributionInvalid,'1');
 assert.deepEqual(parseNavigation({...value,view:'project'}),{workspace,project,view:'project'});assert.deepEqual(parseNavigation({...value,view:'explore'}),{workspace,project,view:'explore',exploreInvalid:'1'});
});
test('comparison dimension namespace and selection shape remain scope-bound',()=>{
 const base={workspace,project,view:'compare'} as const,selection=new URLSearchParams({path:'/pricing'}).toString();
 for(const analyticsDimension of ['path','referrer','browser','os','device','country','region','city','language','event','campaignSource','campaignMedium','campaignName','campaignContent','campaignTerm','hostname','screen','channel','tag'] as const){const value={...base,analyticsDimension,analyticsSelection:selection};assert.deepEqual(parseNavigation(value),value);assert.notEqual(navigationKey(value),navigationKey(base));}
 assert.deepEqual(parseNavigation({...base,view:'project',analyticsSelection:selection}),{...base,view:'project',analyticsSelection:selection});
 for(const analyticsDimension of ['distinctId','',null,['path'],{value:'path'}])assert.equal(parseNavigation({...base,analyticsDimension}).analyticsInvalid,'1');
 assert.equal(parseNavigation({...base,view:'project',analyticsDimension:'path'}).analyticsInvalid,'1');
 for(const analyticsSelection of ['',null,['path=x'],{path:'x'},'x'.repeat(20001),'x\0','x\ud800'])assert.equal(parseNavigation({...base,analyticsSelection}).analyticsInvalid,'1');
 for(const view of ['explore','sessions','realtime'])assert.equal(parseNavigation({...base,view,analyticsDimension:'path',analyticsSelection:selection}).analyticsSelection,undefined);
 const value=parseNavigation({...base,analyticsDimension:'path',analyticsSelection:selection});assert.equal(canonicalNavigation('?'+new URLSearchParams({...base,analyticsDimension:'path',analyticsSelection:selection})+'&analyticsSelection=x',value),false);
});


test('personal profile preferences are role-independent and preserve only native navigation scope',()=>{
  for(const role of [undefined,'owner','admin','editor','viewer'])assert.equal(allowedView('preferences',role,false),true);
  assert.equal(projectView('preferences'),false);
  for(const target of [{view:'preferences' as const},{workspace,project,view:'preferences' as const}]){
    const wire=defaultStringifySearch(target);assert.deepEqual(parseNavigation(defaultParseSearch(wire)),target);assert.equal(canonicalNavigation(wire,target),true);
    assert.equal(canonicalNavigation(wire+'&view=security',target),false);
  }
  assert.deepEqual(parseNavigation({workspace,project,view:'preferences',revenueQuery:'currency=USD',analyticsFrom:'2026-01-01',locale:'ar-SA',theme:'dark',userId:workspace}),{workspace,project,view:'preferences'});
  assert.notEqual(navigationKey({view:'preferences'}),navigationKey({view:'security'}));
});

test('Domain SEO is a project Research view distinct from serving-domain configuration',()=>{
 const target={workspace,project,view:'domain-seo'} as const,wire=defaultStringifySearch(target);
 assert.deepEqual(parseNavigation(defaultParseSearch(wire)),target);assert.equal(canonicalNavigation(wire,target),true);assert.equal(projectView('domain-seo'),true);
 for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('domain-seo',role,false),true);
 assert.equal(allowedView('domain-seo',undefined,false),false);assert.equal(allowedView('domains','viewer',false),false);
 assert.deepEqual(parseNavigation({...target,target:'example.com',scope:'domain',quoteId:workspace,requestKey:project}),target,'Paid drafts/quotes never become URL authority.');
 assert.notEqual(navigationKey(target),navigationKey({...target,view:'domains'}));
});

test('Replay navigation binds bounded scalar intent to one project without exposing upload capabilities',()=>{
 const base={workspace,project,view:'replays'} as const;
 for(const replayQuery of [undefined,'recording='+workspace,'cursor=Y3Vyc29y']){
  const value={...base,...replayQuery?{replayQuery}:{}};
  const wire=defaultStringifySearch(value);assert.deepEqual(parseNavigation(defaultParseSearch(wire)),value);assert.equal(canonicalNavigation(wire,value),true);
 }
 assert.equal(projectView('replays'),true);for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('replays',role,false),true);assert.equal(allowedView('replays',undefined,false),false);
 assert.notEqual(navigationKey(base),navigationKey({...base,replayQuery:'recording='+workspace}));
 for(const replayQuery of ['',null,1,true,{},['recording='+workspace],'x'.repeat(4097),'recording=%GG','cursor=%FF','cursor=%ED%A0%80','cursor=x\0'])assert.equal(parseNavigation({...base,replayQuery}).replayInvalid,'1');
 for(const patch of [{workspace:undefined},{project:undefined},{token:'upload-capability'},{recording:workspace},{replayInvalid:'1'}])assert.equal(parseNavigation({...base,...patch}).replayInvalid,'1');
 assert.deepEqual(parseNavigation({...base,view:'project',replayQuery:'recording='+workspace}),{workspace,project,view:'project'});
 assert.equal(canonicalNavigation(defaultStringifySearch(base)+'&view=replays',base),false);
});


test('Context fallback preserves invalid scoped links instead of reading another project',async()=>{
 const{resolveNavigation}=await import('../src/lib/navigation.ts');
 const performance={workspace,project,view:'performance' as const,performanceQuery:'metric=lcp'};
 assert.deepEqual(resolveNavigation(performance,workspace,project,'performance'),performance);
 for(const target of [{workspace,project:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},{workspace:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',project}])assert.equal(resolveNavigation(performance,target.workspace,target.project,'performance').performanceInvalid,'1');
 assert.equal(resolveNavigation(parseNavigation({view:'performance',performanceQuery:'metric=inp'}),workspace,project,'performance').performanceInvalid,'1');
 const replay=parseNavigation({workspace,project,view:'replays',replayQuery:'recording='+workspace});assert.equal(resolveNavigation(replay,workspace,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','replays').replayInvalid,'1');
 const analytics=parseNavigation({workspace,project,view:'project',analyticsFrom:'2026-10-01',analyticsTo:'2026-10-02'});assert.equal(resolveNavigation(analytics,workspace,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','project').analyticsInvalid,'1');
 const session=parseNavigation({workspace,project,view:'sessions',visitorKey:'a'.repeat(64)});assert.equal(resolveNavigation(session,workspace,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','sessions').sessionInvalid,'1');
 assert.deepEqual(resolveNavigation({view:'project'},workspace,project,'project'),{workspace,project,view:'project'});
});

test('workspace Links and Tracking images preserve their scoped intent without a website',async()=>{
 const {resolveNavigation}=await import('../src/lib/navigation.ts');
 const report=new URLSearchParams({from:'2026-10-01',to:'2026-10-07',timeZone:'Asia/Dubai',dimension:'country',limit:'10',country:serializeGeographyKey('country',{state:'known',country:'AE'})!}).toString();
 for(const view of ['links','pixels'] as const){
  const base={workspace,view},assetQuery=new URLSearchParams({asset:project,report,tab:'shares'}).toString(),target={...base,assetQuery},wire=defaultStringifySearch(target);
  assert.deepEqual(parseNavigation(defaultParseSearch(wire)),target);assert.deepEqual(parseNavigation(parseNavigation(target)),target);assert.equal(canonicalNavigation(wire,target),true);assert.equal(projectView(view),false);
  assert.deepEqual(resolveNavigation(target,workspace,undefined,view),target);assert.equal(resolveNavigation(target,'cccccccc-cccc-4ccc-8ccc-cccccccccccc',undefined,view).assetInvalid,'1');
  assert.notEqual(navigationKey(target),navigationKey(base));assert.notEqual(navigationKey(target),navigationKey({...target,view:view==='links'?'pixels':'links'}));
  for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView(view,role,false),true);assert.equal(allowedView(view,undefined,false),false);
  for(const assetQuery of ['',null,1,true,{},['new=1'],'x'.repeat(26001),'asset=%','asset=%GG','asset=%FF','asset=%ED%A0%80','asset=x\0','asset=x\ud800'])assert.equal(parseNavigation({...base,assetQuery}).assetInvalid,'1');
  for(const patch of [{workspace:undefined},{project},{token:'private-share-token'},{from:'2026-01-01'},{assetInvalid:'1'}]){const invalid=parseNavigation({...target,...patch});assert.equal(invalid.assetInvalid,'1');assert.equal(invalid.project,undefined);assert.equal(invalid.assetQuery,undefined);assert.deepEqual(parseNavigation(defaultParseSearch(defaultStringifySearch(invalid))),invalid);}
  assert.equal(canonicalNavigation(wire+'&assetQuery=new%3D1',target),false);assert.equal(canonicalNavigation(wire+'&project='+project,target),false);
  for(const assetQuery of ['report=literal%25','report=literal%EF%BF%BD'])assert.equal(parseNavigation({...base,assetQuery}).assetQuery,assetQuery);
  assert.deepEqual(parseNavigation({...target,view:'project',project}),{workspace,project,view:'project'});
 }
 assert.equal(projectView('tracked-share'),false);assert.deepEqual(parseNavigation({view:'tracked-share',project,token:'private'}),{view:'tracked-share'});
});
test('public shared-link intent stays rejected through initial router canonicalization instead of booting the private default',()=>{
 const invalid={view:'tracked-share',trackedShareInvalid:'1'} as const;
 for(const wire of ['?view=tracked-share&view=links','?view=links&view=tracked-share','?view='+encodeURIComponent('["tracked-share","links"]'),'?view='+encodeURIComponent('["links","tracked-share"]'),'?view='+encodeURIComponent('["tracked-share"]')+'&view=links','?view=tracked-share-invalid']){
  let raw=defaultParseSearch(wire);
  for(let pass=0;pass<2;pass++){
   const validated=parseNavigation(raw);assert.deepEqual(validated,invalid);
   // Installed Transitioner applies validateSearch over the original search before rendering RouteEntry.
   const canonical=defaultStringifySearch({...raw,...validated}),params=new URLSearchParams(canonical);
   assert.deepEqual(params.getAll('view'),['tracked-share']);assert.equal(params.get('trackedShareInvalid'),JSON.stringify('1'));assert.notEqual(params.size,1,'The existing closed public-share query must still reject this link');
   raw=defaultParseSearch(canonical);assert.deepEqual(parseNavigation(raw),invalid);
  }
 }
 const valid={view:'tracked-share'} as const;assert.deepEqual(parseNavigation(defaultParseSearch(defaultStringifySearch(valid))),valid);assert.equal(new URLSearchParams(defaultStringifySearch(valid)).size,1);
 assert.deepEqual(parseNavigation({...invalid,trackedShareInvalid:['1']}),invalid);
 for(const view of views.filter(view=>view!=='tracked-share')){const value=parseNavigation({workspace,project,view,trackedShareInvalid:'1'});assert.deepEqual(value,parseNavigation({workspace,project,view,unrelatedUnknown:'1'}),'An unrelated private view keeps its existing unknown-query policy');assert.equal(value.trackedShareInvalid,undefined);}
 assert.deepEqual(parseNavigation({view:['project','links']}),{view:'project'});
});
test('workspace Boards preserve applied scope without a fake anchor project and reject invalid ownership',async()=>{
 const {boardNavigation,resolveNavigation}=await import('../src/lib/navigation.ts');
 const id='c0000000-0000-4000-8000-000000000003',scope='from=2026-10-01&to=2026-10-07&timeZone=UTC&path=',boardQuery=new URLSearchParams({board:id,scope}).toString(),target={workspace,view:'boards',boardQuery} as const;
 const wire=defaultStringifySearch(target);assert.deepEqual(parseNavigation(defaultParseSearch(wire)),target);assert.equal(canonicalNavigation(wire,target),true);assert.equal(projectView('boards'),false);
 for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('boards',role,false),true);assert.equal(allowedView('boards',undefined,false),false);
 for(const raw of [{...target,project},{...target,workspace:undefined},{...target,boardQuery:[]},{...target,boardQuery:['board='+id,'new=1']},{...target,boardQuery:'bad=%ED%A0%80'},{...target,boardQuery:'bad=%GG'},{...target,boardQuery:'a'.repeat(24001)},{...target,boardInvalid:'1'},{...target,token:'not-a-board-capability'}])assert.equal(boardNavigation(raw).boardInvalid,'1');
 assert.notEqual(navigationKey(target),navigationKey({...target,boardQuery:'new=1'}));assert.equal(canonicalNavigation(wire+'&boardQuery=other',target),false);
 const fallback=resolveNavigation({...target,boardInvalid:'1'},'d0000000-0000-4000-8000-000000000004',undefined,'boards');assert.equal(fallback.boardInvalid,'1');assert.equal(fallback.project,undefined);assert.equal(fallback.boardQuery,undefined);
 assert.equal(parseNavigation({workspace,view:'preferences',boardQuery}).boardQuery,undefined);
});

test('Heatmap navigation preserves a bounded independent page/layout range and invalid ownership without collector capabilities',async()=>{
 const{resolveNavigation}=await import('../src/lib/navigation.ts');
 const base={workspace,project,view:'heatmaps'} as const;
 for(const heatmapQuery of [undefined,'from=2026-10-01&to=2026-10-07&mode=pages','mode=geometries&origin=https%3A%2F%2Fexample.org&path=%2Fcheckout','x'.repeat(6144)]){
  const target={...base,...heatmapQuery?{heatmapQuery}:{}};const wire=defaultStringifySearch(target);assert.deepEqual(parseNavigation(defaultParseSearch(wire)),target);assert.equal(canonicalNavigation(wire,target),true);
 }
 assert.equal(projectView('heatmaps'),true);for(const role of ['owner','admin','editor','viewer'])assert.equal(allowedView('heatmaps',role,false),true);assert.equal(allowedView('heatmaps',undefined,false),false);
 for(const heatmapQuery of ['',null,1,true,{},['mode=pages'],'x'.repeat(6145),'path=%GG','path=%FF','path=%ED%A0%80','path=x\0'])assert.equal(parseNavigation({...base,heatmapQuery}).heatmapInvalid,'1');
 for(const patch of [{workspace:undefined},{project:undefined},{token:'capture-capability'},{mode:'click'},{heatmapInvalid:'1'}])assert.equal(parseNavigation({...base,...patch}).heatmapInvalid,'1');
 assert.notEqual(navigationKey(base),navigationKey({...base,heatmapQuery:'mode=scroll'}));assert.equal(canonicalNavigation(defaultStringifySearch(base)+'&view=heatmaps',base),false);
 const scoped=parseNavigation({...base,heatmapQuery:'mode=pages'});assert.equal(resolveNavigation(scoped,workspace,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','heatmaps').heatmapInvalid,'1');
 assert.deepEqual(parseNavigation({...base,view:'project',heatmapQuery:'mode=pages'}),{workspace,project,view:'project'});
});
