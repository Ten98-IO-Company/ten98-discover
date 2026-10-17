import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {apiKeyScopes} from '../src/server/api-keys.ts';

const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
const count=(text:string,needle:string)=>text.split(needle).length-1;
const deferred=['audits:read','domains:read','google:read'];

test('the scope catalog is the exact thirteen-name ordered list with one family:verb shape',()=>{
 assert.deepEqual([...apiKeyScopes],['projects:read','projects:write','analytics:read','events:write','team:read','prompts:read','prompts:write','context:read','context:write','segments:read','annotations:read','rank:read','keywords:read']);
 assert.equal(new Set(apiKeyScopes).size,13);
 for(const scope of apiKeyScopes)assert.match(scope,/^[a-z]+:(read|write)$/);
 for(const scope of deferred)assert.equal((apiKeyScopes as readonly string[]).includes(scope),false,scope);
});

test('the key panel hand copy equals the catalog in catalog order',()=>{
 // node --test cannot import .tsx; pin the SCOPES array by its source text instead.
 const source=read('../src/components/ApiKeysPanel.tsx'),block=/const SCOPES[^=]*=\s*\[([\s\S]*?)\n\]/.exec(source);
 assert.ok(block,'SCOPES array present');
 assert.deepEqual([...block![1].matchAll(/value:\s*'([^']+)'/g)].map(match=>match[1]),[...apiKeyScopes]);
});

test('migration 0062 names each catalog scope exactly once and no deferred scope',()=>{
 // The migration lane pins the bytes, the resulting constraint and row preservation; only the SQL-versus-catalog name match is pinned here.
 const sql=read('../migrations/0062_api_content_scopes.sql');
 for(const scope of apiKeyScopes)assert.equal(count(sql,`'${scope}'`),1,scope);
 for(const scope of deferred)assert.equal(sql.includes(scope),false,scope);
});
