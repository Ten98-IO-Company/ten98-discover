import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {realtimeProject} from '../src/server/realtime.ts';

test('realtime is a fixed closed read, not a caller-controlled date/filter/sample query',()=>{
 const project=randomUUID();assert.equal(realtimeProject(project.toUpperCase(),new URLSearchParams()),project);
 for(const id of ['',project+'\n','invalid',project.replaceAll('-','')])assert.throws(()=>realtimeProject(id,new URLSearchParams()),{status:400});
 for(const query of ['from=2026-10-15','to=2026-10-15','timeZone=UTC','limit=1000','cursor=abc','window=30','browser=chrome','projectId='+project,'x=1&x=2','search=','unit=minute'])assert.throws(()=>realtimeProject(project,new URLSearchParams(query)),{status:400});
});
