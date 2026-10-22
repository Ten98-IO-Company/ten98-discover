import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import type {PgBoss} from 'pg-boss';
import {bossOptions,jobPolling,jobQueues,workJobs} from '../src/server/jobs.ts';
import {rankPollQueue} from '../src/server/rank-worker.ts';

test('idle job polling uses NOTIFY with a slow backstop and keeps the previous fallback latency',()=>{
 assert.deepEqual(jobPolling,{pollingIntervalSeconds:2,notifyPollingIntervalSeconds:30});
 assert.equal(bossOptions('postgres://unused',true).useListenNotify,true,'The worker holds the LISTEN connection.');
 assert.equal(bossOptions('postgres://unused',false).useListenNotify,false,'Producers only emit NOTIFY.');
 const queues=jobQueues();assert.equal(queues.length,12);assert.equal(new Set(queues.map(q=>q.name)).size,12);
 // Rank polls are deferred with startAfter, which an insert NOTIFY cannot announce.
 assert.deepEqual(queues.filter(q=>!q.notify).map(q=>q.name),[rankPollQueue]);
 const perMinute=queues.reduce((sum,q)=>sum+60/(q.notify?jobPolling.notifyPollingIntervalSeconds:jobPolling.pollingIntervalSeconds),0);
 assert.equal(perMinute,52,'Idle fetches per minute with LISTEN established (previously 450).');
});
test('workers wake themselves after a non-empty batch and keep failures visible',async()=>{
 const calls:{name:string;options:Record<string,unknown>}[]=[],woken:string[]=[];let handler:((jobs:unknown[])=>Promise<void>)|undefined;
 const boss={work:async(name:string,options:Record<string,unknown>,h:(jobs:unknown[])=>Promise<void>)=>{calls.push({name,options});handler=h;return 'worker-1';},notifyWorker:(id:string)=>{woken.push(id);}} as unknown as PgBoss;
 const seen:unknown[]=[];assert.equal(await workJobs(boss,'queue',{batchSize:1,pollingIntervalSeconds:0.5},async jobs=>{seen.push(...jobs);if(jobs.some(j=>(j as {fail?:boolean}).fail))throw new Error('handler failed');}),'worker-1');
 assert.deepEqual(calls,[{name:'queue',options:{pollingIntervalSeconds:0.5,notifyPollingIntervalSeconds:30,batchSize:1}}]);
 await handler!([]);assert.deepEqual(woken,[],'An empty fetch waits out the poll interval.');
 await handler!([{id:'a'}]);assert.deepEqual(woken,['worker-1'],'A processed job re-fetches at once so a backlog drains.');
 await assert.rejects(handler!([{fail:true}]),/handler failed/);assert.deepEqual(woken,['worker-1','worker-1']);
});
test('every pg-boss worker registers through workJobs',()=>{
 const direct=readdirSync('src/server').filter(f=>f.endsWith('.ts')).filter(f=>/\bboss!?\.work\s*</.test(readFileSync(`src/server/${f}`,'utf8')));
 assert.deepEqual(direct,['jobs.ts']);assert.equal(readFileSync('src/server/jobs.ts','utf8').match(/\bboss\.work\s*</g)?.length,1);
});
