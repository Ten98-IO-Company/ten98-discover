import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {handleApi} from '../src/server/api.ts';
import {normalizeProperties,type NormalizedProperties} from '../src/server/analytics-input.ts';
import {deleteAnalysis,getAnalysis,listAnalyses,runAnalysis,saveAnalysis,type AnalysisItem,type AnalysisWitnessResult} from '../src/server/funnels.ts';
import {removeMember} from '../src/server/teams.ts';

const match=(value:string,type:'path'|'event'='event',operation='exact')=>({type,match:operation,value});
const definition=(steps:unknown[]=[match('A'),match('B'),match('C')],extra:Record<string,unknown>={})=>({kind:'funnel',name:'Observed sequence',windowMinutes:5,steps,...extra});
const goal=(condition:unknown)=>({kind:'goal',name:'Observed goal',condition});
const key=(label:string)=>createHash('sha256').update(label).digest('hex');
const at=(minutes:number)=>new Date(Date.parse('2026-01-31T12:00:00Z')+minutes*60_000).toISOString();
const fail=(status:number)=>(error:unknown)=>error instanceof Error&&'status' in error&&error.status===status;
const query=(revision=1,extra:Record<string,string>={})=>new URLSearchParams({revision:String(revision),from:'2026-01-31',to:'2026-02-01',timeZone:'UTC',...extra});

export async function runFunnelChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1','Use the isolated integration-test opt-in.');
  const config=getConfig(),database=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  assert.ok(local.includes(database.hostname)&&local.includes(new URL(config.appUrl).hostname));
  assert.equal(database.search,'','Connection-string host overrides are forbidden in this fixture.');assert.equal(database.hash,'');
  assert.match(database.pathname,/^\/ten98_funnels_[a-z0-9_]+$/,'Use a dedicated externally provisioned funnels test database.');
  await assertSchema();const {pool}=getDatabase();
  const owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),workspace=randomUUID(),foreignWorkspace=randomUUID();
  const password=randomBytes(24).toString('base64url'),passwordHash=await hashPassword(password);
  const originalFetch=globalThis.fetch;let outgoing=0;
  globalThis.fetch=async()=>{outgoing++;throw new Error('Unexpected external request in native analytics acceptance.');};
  try {
    for(const uid of [owner,editor,viewer,outsider]){
      await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Conversion fixture\',$2)',[uid,`${uid}@funnels.integration.test`]);
      await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),uid,passwordHash]);
    }
    await pool.query("INSERT INTO workspace(id,name,raw_analytics_days) VALUES($1,'Conversions',3650),($2,'Foreign conversions',3650)",[workspace,foreignWorkspace]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor'),($1,$4,'viewer'),($5,$6,'owner')",[workspace,owner,editor,viewer,foreignWorkspace,outsider]);
    async function project(name:string,wid=workspace){
      const id=randomUUID();await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,$3,$4,$5,'infinity')",[id,wid,name,`https://${id}.funnels.integration.test`,randomUUID()]);return id;
    }
    type Recorded={id:string;projectId:string;visitor:string|null;eventName:string;path:string;at:string;origin:string};
    const evidence=new Map<string,Recorded>();
    async function add(pid:string,visitor:string|null,eventName:string,path:string,time:string,options:{visit?:string;properties?:NormalizedProperties;dimensions?:Record<string,unknown>}={}){
      const id=randomUUID(),vid=visitor===null?null:key(visitor),visit=visitor===null?null:key(options.visit??visitor+'-visit');
      if(vid)await pool.query('INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[pid,vid,time]);
      const dimensions=options.dimensions??{},origin=typeof dimensions.origin==='string'?dimensions.origin:`https://${pid}.funnels.integration.test`;
      await pool.query(`INSERT INTO event(id,project_id,event_name,path,received_at,properties,dimensions,visitor_id,visit_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,pid,eventName,path,time,JSON.stringify(options.properties??{}),JSON.stringify(dimensions),vid,visit]);
      evidence.set(id,{id,projectId:pid,visitor:vid,eventName,path,at:time,origin});return id;
    }
    async function saved(pid:string,raw:unknown,kind:'funnel'|'goal'='funnel',uid=owner){
      const reply=await saveAnalysis(pid,uid,kind,{requestId:randomUUID(),definition:raw});assert.ok(reply.item);return reply.item;
    }
    const report=(pid:string,item:AnalysisItem,extra:Record<string,string>={},uid=owner)=>runAnalysis(pid,uid,item.definition.kind,item.id,query(item.revision,extra));
    const witnesses=(pid:string,item:AnalysisItem,step:number,extra:Record<string,string>={})=>runAnalysis(pid,owner,item.definition.kind,item.id,query(item.revision,{step:String(step),...extra}),true);
    function validateChains(result:AnalysisWitnessResult,pid:string,names:string[]){
      const distinct=new Set<string>();
      for(const witness of result.witnesses){
        assert.equal(witness.events.length,names.length);const records=witness.events.map(item=>{const row=evidence.get(item.id);assert.ok(row,'Witness must name an inserted observation.');assert.equal(row.projectId,pid);assert.equal(item.eventName,row.eventName);assert.equal(item.path,row.path);assert.equal(item.origin,row.origin);return row;});
        assert.ok(records[0].visitor);assert.equal(new Set(records.map(row=>row.visitor)).size,1);assert.ok(!distinct.has(records[0].visitor!));distinct.add(records[0].visitor!);
        assert.deepEqual(records.map(row=>row.eventName),names);
        for(let i=1;i<records.length;i++){const gap=Date.parse(records[i].at)-Date.parse(records[i-1].at);assert.ok(gap>=0&&gap<=300_000,'Every witness must obey the inclusive adjacent window.');}
      }
      assert.ok(!JSON.stringify(result).includes('visitor_id'));for(const visitor of distinct)assert.ok(!JSON.stringify(result).includes(visitor),'Drilldown must not disclose visitor keys.');
      return distinct;
    }

    const golden=await project('Golden chains'),sibling=await project('Project isolation');
    const ids:Record<string,string>={};
    for(const [label,events] of [
      ['later-middle',[['A',0],['B',1],['B',4],['C',8]]],['later-start',[['A',0],['A',10],['B',11],['C',12]]],
      ['inclusive-gap',[['A',0],['B',5],['C',10]]],['just-over',[['A',0],['B',5+1/60_000],['C',6]]],
      ['equal-time',[['A',0],['B',0],['C',1]]],['drops-last',[['A',0],['B',1],['C',7]]],
      ['reversed',[['B',0],['A',1],['C',2]]],['no-start',[['B',0],['C',1]]],
    ] as const)for(const [name,minutes] of events)ids[`${label}:${name}:${minutes}`]=await add(golden,label,name,'/'+name,at(minutes));
    await add(golden,'cross-project','A','/A',at(0));await add(sibling,'cross-project','B','/B',at(1));await add(sibling,'cross-project','C','/C',at(2));
    await add(golden,'month-old','A','/A','2026-01-31T23:59:00Z');await add(golden,'month-new','B','/B','2026-02-01T00:00:00Z');await add(golden,'month-new','C','/C','2026-02-01T00:01:00Z');
    for(const [index,name] of ['A','B','C'].entries()){await add(golden,'cross-visit',name,'/'+name,at(index),{visit:'separate-'+index});await add(golden,null,name,'/'+name,at(index));}
    const sequence=await saved(golden,definition()),result=await report(golden,sequence);
    assert.deepEqual(result.steps.map(step=>step.visitors),[10,6,5]);assert.deepEqual(result.steps.map(step=>step.dropped),[null,4,1]);
    assert.deepEqual(result.steps.map(step=>step.conversionRate),[null,0.6,5/6]);assert.deepEqual(result.steps.map(step=>step.remainingRate),[1,0.6,0.5]);
    assert.equal(result.identity.visitors,12);assert.equal(result.identity.status,'partial');assert.equal(result.identity.unidentifiedEvents,3);
    for(let step=1;step<=3;step++){const rows=await witnesses(golden,sequence,step);assert.equal(rows.witnesses.length,result.steps[step-1].visitors);assert.equal(rows.nextCursor,null);validateChains(rows,golden,['A','B','C'].slice(0,step));}
    const final=await witnesses(golden,sequence,3),chains=final.witnesses.map(w=>w.events.map(e=>e.id));
    assert.ok(chains.some(chain=>chain.includes(ids['later-middle:B:4'])));assert.ok(chains.some(chain=>chain.includes(ids['later-start:A:10'])));
    assert.ok(!chains.some(chain=>chain.includes(ids['later-middle:B:1'])));assert.ok(!chains.some(chain=>chain.includes(ids['later-start:A:0'])));
    const unmatched=await saved(golden,definition([match('never'),match('also-never')]));assert.deepEqual((await report(golden,unmatched)).steps.map(s=>s.visitors),[0,0]);
    console.log('PASS conversions non-greedy golden chains, cross-visit and monthly identity, exact gaps and reconciled witnesses');

    const repeats=await project('Repeated steps');
    for(const [visitor,times] of [['single',[0]],['equal',[0,0]],['ordered',[0,1]]] as const)for(const time of times)await add(repeats,visitor,'A','/A',at(time));
    const repeated=await saved(repeats,definition([match('A'),match('A')]));assert.deepEqual((await report(repeats,repeated)).steps.map(s=>s.visitors),[3,3]);
    // Umami semantics: an event can satisfy every repeated step, so all eight levels
    // overlap for both visitors. Insertion order must not establish chronology.
    const deep=await project('Eight overlapping steps');
    for(let minute=7;minute>=0;minute--)for(const visitor of ['eight-instants','seven-instants']){
      if(visitor==='seven-instants'&&minute===7)continue;
      for(let copy=0;copy<2;copy++)await add(deep,visitor,'A','/A',at(minute),{visit:`${visitor}-${minute}-${copy}`});
    }
    const eight=await saved(deep,definition(Array.from({length:8},()=>match('A'))));
    assert.deepEqual((await report(deep,eight)).steps.map(s=>s.visitors),[2,2,2,2,2,2,2,2]);
    const deepRows=await witnesses(deep,eight,8);assert.equal(deepRows.witnesses.length,2);
    assert.deepEqual([...validateChains(deepRows,deep,Array.from({length:8},()=>'A'))].sort(),[key('eight-instants'),key('seven-instants')].sort());
    const micro=await project('Sub-millisecond order');await add(micro,'micro','A','/A','2026-01-31T12:00:00.000001Z');await add(micro,'micro','B','/B','2026-01-31T12:00:00.000002Z');
    const microDefinition=await saved(micro,definition([match('A'),match('B')]));assert.deepEqual((await report(micro,microDefinition)).steps.map(s=>s.visitors),[1,1]);
    const paths=await project('Literal matching');
    for(const [visitor,name,path] of [['literal','click','/literal%_\\tail'],['wildcard','click','/literalXYtail'],['case','click','/LITERAL%_\\tail'],['view','page_view','/literal%_\\tail']] as const){await add(paths,visitor,name,path,at(0));await add(paths,visitor,'done','/finish',at(1));}
    for(const [operation,value,count] of [['exact','/literal%_\\tail',2],['prefix','/literal%_',2],['suffix','%_\\tail',3],['contains','literal%_',2]] as const){
      const item=await saved(paths,definition([match(value,'path',operation),match('done')]));assert.deepEqual((await report(paths,item)).steps.map(s=>s.visitors),[count,count]);
    }
    const views=await saved(paths,definition([{...match('/literal%_\\tail','path'),pageViewsOnly:true},match('done')]));assert.deepEqual((await report(paths,views)).steps.map(s=>s.visitors),[1,1]);
    const customWildcard=await saved(paths,definition([match('_','event','contains'),match('done')]));assert.deepEqual((await report(paths,customWildcard)).steps.map(s=>s.visitors),[0,0],'Custom event predicates must never match page_view.');
    console.log('PASS conversions repeated steps, microsecond ordering, literal wildcard/case matching and page-view refinement');

    const typed=await project('Typed predicates');
    const values=[undefined,42,'42',false,null,'2024-02-29T12:00:00+04:00',[42,'42'],'literal%_\\end',0,'plain-date-string'];
    for(const [index,value] of values.entries()){
      const properties=value===undefined?{}:normalizeProperties({'a.b':value});
      if(index===9)properties['a\\.b']={type:'string',value:'2024-02-29T12:00:00+04:00'};
      await add(typed,'typed-'+index,'A','/A',at(0),{properties});await add(typed,'typed-'+index,'B','/B',at(1),{properties});
    }
    for(const predicate of [
      {key:'a\\.b',operator:'missing'}, {key:'a\\.b',operator:'eq',type:'number',value:42},
      {key:'a\\.b',operator:'eq',type:'string',value:'42'}, {key:'a\\.b',operator:'eq',type:'boolean',value:false},
      {key:'a\\.b',operator:'eq',type:'null',value:null}, {key:'a\\.b',operator:'eq',type:'date',value:'2024-02-29T08:00:00Z'},
      {key:'a\\.b',operator:'eq',type:'array',value:[42,'42']}, {key:'a\\.b',operator:'contains',type:'string',value:'%_\\'},
      {key:'a\\.b',operator:'neq',type:'number',value:42}, {key:'a\\.b',operator:'eq',type:'string',value:'2024-02-29T12:00:00+04:00'},
    ]){
      const item=await saved(typed,definition([match('A'),{...match('B'),properties:[predicate]}]));assert.deepEqual((await report(typed,item)).steps.map(s=>s.visitors),[10,1],JSON.stringify(predicate));
    }
    const negative=await saved(typed,definition([match('A'),{...match('B'),properties:[{key:'a\\.b',operator:'not_contains',type:'string',value:'42'}]}]));assert.deepEqual((await report(typed,negative)).steps.map(s=>s.visitors),[10,2]);
    const typedSequence=await saved(typed,definition([match('A'),match('B')]));
    assert.deepEqual((await report(typed,typedSequence,{propertyKey:'a\\.b',propertyType:'number',propertyValue:'42'})).steps.map(s=>s.visitors),[1,1]);
    const scoped=await project('Every-step scope');
    for(const [index,label] of ['match','wrong-language','wrong-origin','wrong-campaign','wrong-referrer','legacy-origin'].entries()){
      const dimensions:Record<string,unknown>={origin:`https://${scoped}.funnels.integration.test`,language:'en',referrerHost:'search.example',campaign:{source:'email'}};
      for(const [n,name] of ['A','B','C'].entries()){
        const own=structuredClone(dimensions);if(n===1){if(index===1)own.language='fr';if(index===2)own.origin='https://serving.integration.test';if(index===3)own.campaign={source:'other'};if(index===4)own.referrerHost='other.example';}if(index===5)delete own.origin;
        await add(scoped,label,name,'/'+name,at(n),{dimensions:own});
      }
    }
    const scopedSequence=await saved(scoped,definition());const scope={language:'en',origin:`https://${scoped}.funnels.integration.test`,campaignSource:'email',referrer:'search.example'};
    assert.deepEqual((await report(scoped,scopedSequence,scope)).steps.map(s=>s.visitors),[6,2,2]);
    assert.deepEqual((await report(scoped,scopedSequence,{path:'/A'})).steps.map(s=>s.visitors),[6,0,0]);
    assert.deepEqual((await report(scoped,scopedSequence,{path:"' OR true; --"})).steps.map(s=>s.visitors),[null,null,null]);
    console.log('PASS conversions typed positive/negative/missing properties and every-step common scope including origin provenance');

    const goals=await project('Goal denominator');
    await add(goals,'repeat','page_view','/thank-you',at(0));await add(goals,'repeat','page_view','/thank-you',at(1));
    await add(goals,'other','page_view','/elsewhere',at(0));await add(goals,'custom','purchase','/thank-you',at(0));
    await add(goals,null,'page_view','/thank-you',at(0));await add(goals,null,'page_view','/thank-you',at(1));
    const viewed=await saved(goals,goal(match('/thank-you','path')),'goal'),purchased=await saved(goals,goal(match('purchase')),'goal');
    const pageResult=await report(goals,viewed);assert.deepEqual(pageResult.goal,{visitors:1,totalVisitors:3,rate:1/3});assert.equal(pageResult.identity.identifiedEvents,4);assert.equal(pageResult.identity.unidentifiedEvents,2);
    assert.deepEqual((await report(goals,purchased)).goal,{visitors:1,totalVisitors:3,rate:1/3});
    const absentGoal=await saved(goals,goal(match('never')),'goal');assert.deepEqual((await report(goals,absentGoal)).goal,{visitors:0,totalVisitors:3,rate:0});
    const pageName=await saved(goals,goal(match('_','event','contains')),'goal');assert.equal((await report(goals,pageName)).goal?.visitors,0);
    assert.deepEqual((await report(goals,viewed,{path:'/thank-you'})).goal,{visitors:1,totalVisitors:2,rate:0.5});
    const goalRows=await runAnalysis(goals,owner,'goal',viewed.id,query(),true);assert.equal(goalRows.step,1);assert.equal(goalRows.witnesses.length,1);assert.equal(goalRows.witnesses[0].events[0].eventName,'page_view');
    const anonymous=await project('No visitor identity');await add(anonymous,null,'purchase','/thank-you',at(0));
    const anonymousGoal=await saved(anonymous,goal(match('purchase')),'goal');assert.deepEqual((await report(anonymous,anonymousGoal)).goal,{visitors:null,totalVisitors:null,rate:null});assert.equal((await report(anonymous,anonymousGoal)).identity.status,'unavailable');
    console.log('PASS goals unique conversions, full scoped denominator, repeated and anonymous observations, zero versus unavailable');

    const calendar=await project('Calendar and retention'),calendarGoal=await saved(calendar,goal(match('/target','path')),'goal');
    for(const [label,time] of [['before','2026-03-08T04:59:59.999Z'],['start','2026-03-08T05:00:00Z'],['last','2026-03-09T03:59:59.999Z'],['end','2026-03-09T04:00:00Z']] as const)await add(calendar,label,'page_view','/target',time);
    const spring=await report(calendar,calendarGoal,{from:'2026-03-08',to:'2026-03-08',timeZone:'America/New_York'});assert.equal(spring.goal?.visitors,2);assert.equal(Date.parse(spring.range.end)-Date.parse(spring.range.start),23*3600_000);
    const fall=await report(calendar,calendarGoal,{from:'2026-11-01',to:'2026-11-01',timeZone:'America/New_York'});assert.equal(Date.parse(fall.range.end)-Date.parse(fall.range.start),25*3600_000);
    const skipped=await report(calendar,calendarGoal,{from:'2011-12-30',to:'2011-12-30',timeZone:'Pacific/Apia'});assert.equal(skipped.range.start,skipped.range.end);assert.equal(skipped.goal?.visitors,null);
    await pool.query("UPDATE project SET analytics_retained_from='2026-01-31T12:01:00Z' WHERE id=$1",[golden]);
    const partial=await report(golden,sequence);assert.equal(partial.coverage.status,'partial');assert.equal(partial.coverage.countsAreLowerBounds,true);assert.deepEqual(partial.steps.map(s=>s.visitors),[3,1,1]);
    for(const step of partial.steps){assert.equal(step.dropped,null);assert.equal(step.conversionRate,null);assert.equal(step.remainingRate,null);}
    await pool.query("UPDATE project SET analytics_retained_from='2026-01-31T12:01:00Z' WHERE id=$1",[goals]);
    const partialGoal=await report(goals,viewed);assert.deepEqual(partialGoal.goal,{visitors:1,totalVisitors:1,rate:null});assert.equal(partialGoal.coverage.status,'partial');
    const expired=await report(golden,sequence,{from:'2026-01-30',to:'2026-01-30'});assert.equal(expired.coverage.status,'unavailable');assert.ok(expired.steps.every(s=>s.visitors===null));assert.equal(expired.identity.identifiedEvents,null);assert.equal((await getAnalysis(golden,viewer,'funnel',sequence.id)).item.id,sequence.id);
    const badQueries:Record<string,string>[]=[{revision:'0'},{revision:'1.0'},{revision:'1\n'},{revision:'2'},{from:'2026-02-30'},{from:'2025-01-01',to:'2026-02-01'},{timeZone:'GMT+4'},{kind:'custom'},{groupBy:'path'}];
    for(const extra of badQueries)await assert.rejects(runAnalysis(golden,owner,'funnel',sequence.id,query(1,extra)),fail(extra.revision==='2'?409:400));
    await assert.rejects(runAnalysis(golden,owner,'funnel',sequence.id,query(),true),fail(400));await assert.rejects(runAnalysis(golden,owner,'funnel',sequence.id,query(1,{step:'4'}),true),fail(400));
    await assert.rejects(runAnalysis(golden,owner,'funnel',sequence.id,query(1,{step:'2\n'}),true),fail(400));
    const duplicate=query();duplicate.append('from','2026-01-31');await assert.rejects(runAnalysis(golden,owner,'funnel',sequence.id,duplicate),fail(400));
    console.log('PASS conversion calendar boundaries, DST/skipped dates, retained lower bounds and stale/ambiguous query rejection');

    // Exercise the real statement deadline without generating a huge event table.
    // The exclusive lock is confined to this dedicated fixture database.
    const blocker=await pool.connect();
    try{await blocker.query('BEGIN');await blocker.query('LOCK TABLE event IN ACCESS EXCLUSIVE MODE');await assert.rejects(report(calendar,calendarGoal),fail(503));}
    finally{await blocker.query('ROLLBACK');blocker.release();}
    assert.equal((await report(calendar,calendarGoal,{from:'2026-03-08',to:'2026-03-08',timeZone:'America/New_York'})).goal?.visitors,2);
    console.log('PASS conversion real PostgreSQL statement timeout returns unavailable and the next evaluation recovers');

    const paging=await project('Witness pagination'),pagedDefinition=await saved(paging,definition([match('A'),match('B')]));
    for(let n=0;n<55;n++){await add(paging,'page-'+n,'A','/A',at(0));await add(paging,'page-'+n,'B','/B',at(1));}
    const first=await witnesses(paging,pagedDefinition,2);assert.equal(first.witnesses.length,50);assert.ok(first.nextCursor);
    const second=await witnesses(paging,pagedDefinition,2,{cursor:first.nextCursor!});assert.equal(second.witnesses.length,5);assert.equal(second.nextCursor,null);
    const combined=[...first.witnesses,...second.witnesses];assert.equal(new Set(combined.map(row=>row.events.at(-1)!.id)).size,55);assert.equal(first.steps[1].visitors,55);validateChains({...first,witnesses:combined},paging,['A','B']);
    const changedScopes:Record<string,string>[]=[{step:'1'},{from:'2026-02-01'},{path:'/B'}];
    for(const extra of changedScopes)await assert.rejects(witnesses(paging,pagedDefinition,2,{cursor:first.nextCursor!,...extra}),fail(400));
    const another=await saved(paging,definition([match('A'),match('B')]));await assert.rejects(witnesses(paging,another,2,{cursor:first.nextCursor!}),fail(400));
    await pool.query("UPDATE project SET analytics_retained_from='2026-01-31T00:00:00Z' WHERE id=$1",[paging]);await assert.rejects(witnesses(paging,pagedDefinition,2,{cursor:first.nextCursor!}),fail(400));
    await pool.query("UPDATE project SET analytics_retained_from='2026-01-31T00:00:00.000001Z' WHERE id=$1",[paging]);
    const microCursor=await witnesses(paging,pagedDefinition,2);assert.ok(microCursor.nextCursor);
    await pool.query("UPDATE project SET analytics_retained_from='2026-01-31T00:00:00.000002Z' WHERE id=$1",[paging]);
    await assert.rejects(witnesses(paging,pagedDefinition,2,{cursor:microCursor.nextCursor!}),fail(400),'A one-microsecond watermark advance must invalidate the cursor even within the same JS millisecond.');
    const refreshed=await witnesses(paging,pagedDefinition,2);assert.ok(refreshed.nextCursor);await pool.query('DELETE FROM event WHERE id=$1',[refreshed.witnesses.at(-1)!.events.at(-1)!.id]);
    await assert.rejects(witnesses(paging,pagedDefinition,2,{cursor:refreshed.nextCursor!}),fail(409));
    console.log('PASS conversion bounded witness reconciliation, scope/revision/retention cursor binding and vanished-anchor rejection');

    const managed=await project('Saved definition permissions'),foreign=await project('Foreign project',foreignWorkspace);
    const create={requestId:randomUUID(),definition:definition()},raced=await Promise.all([saveAnalysis(managed,editor,'funnel',create),saveAnalysis(managed,editor,'funnel',create)]);
    assert.equal(raced[0].item!.id,raced[1].item!.id);assert.equal(raced.filter(row=>row.replayed).length,1);let item=raced[0].item!;
    await assert.rejects(saveAnalysis(managed,owner,'funnel',create),fail(409));await assert.rejects(saveAnalysis(managed,editor,'funnel',{...create,definition:definition(undefined,{name:'Changed intent'})}),fail(409));
    assert.equal((await getAnalysis(managed,viewer,'funnel',item.id)).role,'viewer');
    for(const uid of [viewer,outsider])await assert.rejects(saveAnalysis(managed,uid,'funnel',{requestId:randomUUID(),definition:definition()}),fail(404));
    await assert.rejects(getAnalysis(foreign,owner,'funnel',item.id),fail(404));await assert.rejects(getAnalysis(sibling,owner,'funnel',item.id),fail(404));await assert.rejects(getAnalysis(managed,owner,'goal',item.id),fail(404));
    const edits=await Promise.allSettled(['First edit','Second edit'].map(name=>saveAnalysis(managed,editor,'funnel',{requestId:randomUUID(),revision:1,definition:definition(undefined,{name})},item.id)));
    assert.equal(edits.filter(row=>row.status==='fulfilled').length,1);assert.ok(edits.some(row=>row.status==='rejected'&&fail(409)(row.reason)));item=(await getAnalysis(managed,owner,'funnel',item.id)).item;
    assert.equal(item.revision,2);await assert.rejects(report(managed,{...item,revision:1}),fail(409));await assert.rejects(witnesses(managed,{...item,revision:1},3),fail(409));await assert.rejects(deleteAnalysis(managed,owner,'funnel',item.id,{requestId:randomUUID(),revision:1}),fail(409));
    const deletion={requestId:randomUUID(),revision:2};assert.equal((await deleteAnalysis(managed,editor,'funnel',item.id,deletion)).replayed,false);assert.equal((await deleteAnalysis(managed,editor,'funnel',item.id,deletion)).replayed,true);
    const oldRetry=await saveAnalysis(managed,editor,'funnel',create);assert.equal(oldRetry.item,null);assert.equal(oldRetry.deleted,true);assert.equal((await listAnalyses(managed,owner,'funnel',new URLSearchParams())).items.length,0);
    for(let n=0;n<51;n++)await saved(managed,definition(undefined,{name:'Saved '+n}));
    const list=await listAnalyses(managed,viewer,'funnel',new URLSearchParams());assert.equal(list.items.length,50);assert.ok(list.nextCursor);
    const tail=await listAnalyses(managed,viewer,'funnel',new URLSearchParams({cursor:list.nextCursor!}));assert.equal(tail.items.length,1);assert.equal(new Set([...list.items,...tail.items].map(i=>i.id)).size,51);
    await assert.rejects(listAnalyses(sibling,owner,'funnel',new URLSearchParams({cursor:list.nextCursor!})),fail(400));await assert.rejects(listAnalyses(managed,owner,'goal',new URLSearchParams({cursor:list.nextCursor!})),fail(400));
    console.log('PASS saved conversions tenant roles, concurrent revisions, actor-bound idempotency, deletion tombstones and bounded lists');

    async function login(uid:string){const response=await handleApi(new Request(`${config.appUrl}/api/auth/sign-in/email`,{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:`${uid}@funnels.integration.test`,password})}));assert.equal(response.status,200);return response.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');}
    const ownerCookie=await login(owner),editorCookie=await login(editor),viewerCookie=await login(viewer),base=`${config.appUrl}/api/projects/${managed}/funnels`;
    assert.equal((await handleApi(new Request(base))).status,401);assert.equal((await handleApi(new Request(base,{headers:{cookie:viewerCookie}}))).status,200);
    const post=(cookie:string,body:unknown,origin=config.appUrl)=>handleApi(new Request(base,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(body)}));
    assert.equal((await post(viewerCookie,{requestId:randomUUID(),definition:definition()})).status,404);assert.equal((await post(ownerCookie,{requestId:randomUUID(),definition:definition()},'https://foreign.integration.test')).status,403);
    const httpBody={requestId:randomUUID(),definition:definition(undefined,{name:'Actual HTTP saved'})},httpCreated=await post(ownerCookie,httpBody);assert.equal(httpCreated.status,200);
    const httpItem=(await httpCreated.json()).item as AnalysisItem;assert.equal((await post(ownerCookie,httpBody)).status,200);
    assert.equal((await handleApi(new Request(`${base}/${httpItem.id}/result?${query()}`,{headers:{cookie:viewerCookie}}))).status,200);
    let begin!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{begin=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
    const delayed={requestId:randomUUID(),definition:definition(undefined,{name:'Must never be saved'})};
    const body=new ReadableStream<Uint8Array>({async pull(controller){begin();await released;controller.enqueue(new TextEncoder().encode(JSON.stringify(delayed)));controller.close();}},{highWaterMark:0});
    const pending=handleApi(new Request(base,{method:'POST',headers:{cookie:editorCookie,origin:config.appUrl,'content-type':'application/json'},body,duplex:'half'} as RequestInit&{duplex:'half'}));
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([started,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Delayed body was not read.')),10_000);})]);if(timeout)clearTimeout(timeout);await removeMember(workspace,owner,editor);release();assert.equal((await pending).status,404);}
    finally{if(timeout)clearTimeout(timeout);release();await pending;}
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM project_content_request WHERE project_id=$1 AND request_id=$2',[managed,delayed.requestId])).rows[0].count,0);
    assert.equal((await handleApi(new Request(base,{headers:{cookie:editorCookie}}))).status,404);assert.equal(outgoing,0);
    console.log('PASS conversions actual HTTP login/origin gates and revoked authorization across a delayed request body; no external traffic');
  } finally {globalThis.fetch=originalFetch;}
}

if(import.meta.main){try{await runFunnelChecks();}finally{await closeDatabase();}}
