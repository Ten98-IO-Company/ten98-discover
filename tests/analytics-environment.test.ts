import assert from 'node:assert/strict';
import test from 'node:test';
import {analyticsEnvironment} from '../src/server/analytics-environment.ts';
import {environmentCatalog,environmentFields,environmentVersion,isEnvironmentFilter} from '../src/lib/analytics-environment.ts';
import {normalizeDimensions} from '../src/server/analytics-input.ts';
import {analyticsQuery} from '../src/server/analytics.ts';
import {explorerQuery} from '../src/server/explorer-input.ts';
import {parseAdvancedPredicates} from '../src/server/advanced-predicate-input.ts';
import {analyticsPopulation} from '../src/server/analytics-population.ts';

export const environmentChromeUA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
test('server environment uses bounded families and device classes without retaining UA versions or hardware',()=>{
  const fixtures:[string,string,string,string][]=[
    [environmentChromeUA,'chrome','Windows 10','desktop'],
    [environmentChromeUA+' Edg/130.0.0.0','edge-chromium','Windows 10','desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0','firefox','Linux','desktop'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1','ios','iOS','mobile'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1','ios','iOS','tablet'],
    ['Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36','chrome','Android OS','mobile'],
    ['Example observer','unknown','unknown','unknown'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)','bot','unknown','unknown'],
  ];
  for(const [ua,browser,os,device] of fixtures){
    const result=analyticsEnvironment(ua);
    assert.deepEqual(result,{browser,os,device,environmentVersion});
    assert.deepEqual(Object.keys(result),['browser','os','device','environmentVersion']);
    assert.equal(JSON.stringify(result).includes(ua),false);
  }
  for(const ua of ['', 'x'.repeat(1025), environmentChromeUA+'\0', environmentChromeUA+'\n', '\ud800'])assert.deepEqual(analyticsEnvironment(ua),{browser:'unknown',os:'unknown',device:'unknown',environmentVersion});
  assert.equal(analyticsEnvironment(environmentChromeUA.padEnd(501,' '),1024).device,'unknown','The v1 parser truncation must not invent a desktop/laptop.');
});

test('laptop is only a bounded enabled-screen heuristic and unknown never becomes desktop',()=>{
  for(const width of [1,1024,1920])assert.equal(analyticsEnvironment(environmentChromeUA,width).device,'laptop');
  for(const width of [undefined,0,1921,10000,NaN,1.5])assert.equal(analyticsEnvironment(environmentChromeUA,width).device,'desktop');
  assert.equal(analyticsEnvironment('Unknown agent',1024).device,'unknown');
  for(const ua of ['curl/8.0.1 (Linux)','Custom client (Windows NT 10.0)',environmentChromeUA.replace('Windows NT 10.0','QNX'),'Mozilla/5.0 (X11; Linux x86_64) PhantomJS/2.1.1'])assert.equal(analyticsEnvironment(ua,1024).device,'unknown','A desktop OS alone or a bot/tool family cannot invent a desktop.');
});

test('public dimensions cannot spoof internal environment or retain raw user-agent evidence',()=>{
  for(const key of ['browser','os','device','environmentVersion','envVersion','userAgent']){
    assert.throws(()=>normalizeDimensions({[key]:'chrome'}),{status:400});
    assert.throws(()=>normalizeDimensions({language:'en',screen:{width:1024,height:768},[key]:'unknown'}),{status:400});
  }
  assert.deepEqual(normalizeDimensions({language:'en-us',screen:{width:1024,height:768}}),{language:'en-US',screenWidth:1024,screenHeight:768});
});

test('overview and Explorer exact environment filters use one fixed catalogue and distinguish missing from unknown',()=>{
  for(const field of environmentFields)for(const value of [...environmentCatalog[field],'not-recorded']){
    assert.equal(isEnvironmentFilter(field,value),true);
    assert.deepEqual(analyticsQuery(new URLSearchParams({[field]:value})).filters,{[field]:value});
    assert.equal(explorerQuery(new URLSearchParams({[field]:value,groupBy:field})).filters[field],value);
  }
  for(const field of environmentFields)for(const value of ['', 'not recorded',' Chrome','Chrome','x'.repeat(1025),'\n','\0','__proto__']){
    assert.equal(isEnvironmentFilter(field,value),false);
    assert.throws(()=>analyticsQuery(new URLSearchParams({[field]:value})),{status:400});
    assert.throws(()=>explorerQuery(new URLSearchParams({[field]:value})),{status:400});
  }
  for(const query of ['browser=chrome&browser=firefox','os=Linux&os=Linux','device=desktop&device=mobile','userAgent=raw'])assert.throws(()=>analyticsQuery(new URLSearchParams(query)),{status:400});
  assert.deepEqual(analyticsQuery(new URLSearchParams('browser=chrome&os=Windows+10&device=laptop')).filters,{browser:'chrome',os:'Windows 10',device:'laptop'});
});

test('environment exact/advanced cohort qualification retains shared SQL binding slots and missing operators',()=>{
  const predicates=parseAdvancedPredicates({version:1,match:'all',fields:[{field:'browser',operator:'missing'},{field:'os',operator:'eq',value:'Linux'},{field:'device',operator:'regex',value:'^desktop$'}],properties:[]});
  const query=explorerQuery(new URLSearchParams({browser:'unknown',groupBy:'device',predicates:JSON.stringify(predicates)}));
  const qualification=explorerQuery(new URLSearchParams({os:'not-recorded',groupBy:'browser',predicates:JSON.stringify(predicates)}));
  const sql=analyticsPopulation('project','user',query,qualification,false);
  assert.equal(sql.values[6],JSON.stringify({browser:'unknown'}));
  assert.equal(sql.values[16+2],JSON.stringify({os:'not-recorded'}));
  assert.equal(sql.values[10],'device');assert.equal(sql.values[11],null);
  assert.ok(sql.ctes.includes("$19::jsonb->>'device'"),'Shifted cohort exact filters share the unchanged qualification JSON slot.');
  assert.ok(sql.ctes.includes("s.dimensions->>'browser' IS NULL"));
  assert.ok(sql.ctes.includes("s.dimensions->>'device' ~*"));
});
