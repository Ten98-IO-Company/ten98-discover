import assert from 'node:assert/strict';
import test from 'node:test';
import {closeRuntimeResources,registerResourceCleanup} from '../src/server/resource-cleanup.ts';

test('separate bundle instances await actual queue closures before pools, once, with safe failure output',async()=>{
  // A second module instance reproduces Nitro/TanStack's separate compiled graphs.
  const second=await import(new URL('../src/server/resource-cleanup.ts?second-bundle',import.meta.url).href);
  const order:string[]=[],messages:unknown[][]=[];
  const originalError=console.error,originalExitCode=process.exitCode;
  let release!:()=>void;
  const ready=new Promise<void>(resolve=>{release=resolve;});
  const stopQueue=async()=>{await ready;order.push('queue');};
  registerResourceCleanup('jobs',stopQueue);
  second.registerResourceCleanup('jobs',stopQueue);
  second.registerResourceCleanup('jobs',async()=>{throw new Error('private synthetic credential');});
  second.registerResourceCleanup('database',async()=>{assert.deepEqual(order,['queue']);order.push('database');});
  try {
    console.error=(...values)=>{messages.push(values);};
    const first=closeRuntimeResources(),again=second.closeRuntimeResources();
    assert.equal(first,again);assert.deepEqual(order,[]);
    release();await first;
    assert.deepEqual(order,['queue','database']);
    assert.deepEqual(messages,[['Job shutdown failed.']]);assert.equal(process.exitCode,1);
    await closeRuntimeResources();assert.deepEqual(order,['queue','database']);
  } finally {console.error=originalError;process.exitCode=originalExitCode;release();}
});
