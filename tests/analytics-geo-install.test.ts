import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
const {installGeography}=await import(new URL('../scripts/analytics-geo.mjs',import.meta.url).href);
const release='2026-10',artifact='https://download.db-ip.com/free/dbip-city-lite-2026-10.mmdb.gz';

test('geography installer rejects arbitrary URLs and non-regular managed destinations before fetching',async t=>{
 let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw Error('Unexpected request');});
 await assert.rejects(()=>installGeography('https://untrusted.example/geo'),/Choose a named geography release/);
 const directory=await mkdtemp(join(tmpdir(),'ten98-geo-install-'));await mkdir(join(directory,'city.mmdb'));
 await assert.rejects(()=>installGeography(release,directory),/regular file/);assert.equal(requests,0);
});

test('geography installer cancels unread error bodies before returning',async t=>{
 let cancelled=0;const directory=await mkdtemp(join(tmpdir(),'ten98-geo-install-'));
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{status:404}));
 await assert.rejects(()=>installGeography(release,directory),/unavailable/);assert.equal(cancelled,1);assert.deepEqual(await readdir(directory),[]);
});

test('geography installer accepts uppercase published checksum spelling before validating the MMDB',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ten98-geo-install-')),bytes=Buffer.from('Invalid City Lite fixture'),sha1=createHash('sha1').update(bytes).digest('hex').toUpperCase();
 t.mock.method(globalThis,'fetch',async(url:string)=>String(url)===artifact?new Response(gzipSync(bytes)):new Response(`MMDB SHA1SUM ${sha1} <a href="${artifact}">Download</a>`));
 await assert.rejects(()=>installGeography(release,directory),/not a valid matching/);assert.deepEqual(await readdir(directory),[]);
});

test('geography installer bounds actual page bytes without trusting declared length',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ten98-geo-install-'));await writeFile(join(directory,'city.mmdb'),'saved database');
 t.mock.method(globalThis,'fetch',async()=>new Response('x'.repeat(2*1024*1024+1),{headers:{'content-length':'1'}}));
 await assert.rejects(()=>installGeography(release,directory),/byte limit/);
 assert.equal(await readFile(join(directory,'city.mmdb'),'utf8'),'saved database');assert.deepEqual(await readdir(directory),['city.mmdb']);
});

test('geography checksum and real-reader failures preserve the installed file and remove only owned temporary files',async t=>{
 for(const checksumMatches of[false,true]){
  const directory=await mkdtemp(join(tmpdir(),'ten98-geo-install-')),bytes=Buffer.from('Not a City Lite database'),sha1=createHash('sha1').update(bytes).digest('hex'),calls:string[]=[];
  await writeFile(join(directory,'city.mmdb'),'saved database');await writeFile(join(directory,'city.json'),'saved receipt');
  const mock=t.mock.method(globalThis,'fetch',async(url:string,options:RequestInit)=>{
   calls.push(String(url));assert.equal(options.redirect,'error');assert.ok(options.signal);
   return String(url)===artifact?new Response(gzipSync(bytes)):new Response(`MMDB SHA1SUM ${checksumMatches?sha1:'a'.repeat(40)} <a href="${artifact}">Download</a>`);
  });
  await assert.rejects(()=>installGeography(release,directory),checksumMatches?/not a valid matching/:/checksum does not match/);
  assert.deepEqual(calls,['https://db-ip.com/db/download/ip-to-city-lite',artifact]);assert.equal(await readFile(join(directory,'city.mmdb'),'utf8'),'saved database');assert.equal(await readFile(join(directory,'city.json'),'utf8'),'saved receipt');assert.deepEqual((await readdir(directory)).sort(),['city.json','city.mmdb']);mock.mock.restore();
 }
});
