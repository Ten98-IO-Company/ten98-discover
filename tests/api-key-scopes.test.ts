import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {apiKeyScopes} from '../src/server/api-keys.ts';
import {apiKeyScopeGroups} from '../src/lib/api-key-presets.ts';

const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
const count=(text:string,needle:string)=>text.split(needle).length-1;
// No reserved name is deferred since 0067 admitted audits:read; a future reserved name goes here until its migration lands.
const deferred:string[]=[];
// The thirteen names migration 0062 admitted; 0066 appends google:read and domains:read, 0067 appends audits:read.
const scopes62=['projects:read','projects:write','analytics:read','events:write','team:read','prompts:read','prompts:write','context:read','context:write','segments:read','annotations:read','rank:read','keywords:read'];
const scopes66=[...scopes62,'google:read','domains:read'];

test('the scope catalog is the exact sixteen-name ordered list with one family:verb shape',()=>{
 assert.deepEqual([...apiKeyScopes],[...scopes66,'audits:read']);
 assert.equal(new Set(apiKeyScopes).size,16);
 for(const scope of apiKeyScopes)assert.match(scope,/^[a-z]+:(read|write)$/);
 for(const scope of deferred)assert.equal((apiKeyScopes as readonly string[]).includes(scope),false,scope);
});

test('the key panel hand copy names every catalog scope exactly once',()=>{
 // The panel's Custom rows come from src/lib/api-key-presets.ts, grouped by area rather than in catalog order.
 const listed=apiKeyScopeGroups.flatMap(group=>group.rows.flatMap(row=>[row.read,row.write].filter(scope=>scope!==undefined)));
 assert.deepEqual(listed,['projects:read','projects:write','analytics:read','events:write','segments:read','annotations:read','prompts:read','prompts:write','context:read','context:write','rank:read','keywords:read','google:read','domains:read','audits:read','team:read']);
 assert.equal(listed.length,apiKeyScopes.length);
 assert.deepEqual([...listed].sort(),[...apiKeyScopes].sort());
 // node --test cannot import .tsx; pin the panel by its source text: it renders the shared rows and hand-copies no scope ids.
 const source=read('../src/components/ApiKeysPanel.tsx');
 assert.match(source,/import \{[^}]*\bapiKeyScopeGroups\b[^}]*\} from '\.\.\/lib\/api-key-presets'/);
 assert.match(source,/apiKeyScopeGroups\.map\(/);
 assert.doesNotMatch(source,/['"`][a-z]+:(read|write)['"`]/);
});

test('migration 0062 names each of its thirteen scopes exactly once and no later or deferred scope',()=>{
 // The migration lane pins the bytes, the resulting constraint and row preservation; only the SQL-versus-catalog name match is pinned here.
 const sql=read('../migrations/0062_api_content_scopes.sql');
 for(const scope of scopes62)assert.equal(count(sql,`'${scope}'`),1,scope);
 for(const scope of [...apiKeyScopes.filter(scope=>!scopes62.includes(scope)),...deferred])assert.equal(sql.includes(scope),false,scope);
});

test('migration 0066 names each of its fifteen scopes exactly once and no later or deferred scope',()=>{
 const sql=read('../migrations/0066_google_domains_scopes.sql');
 for(const scope of scopes66)assert.equal(count(sql,`'${scope}'`),1,scope);
 for(const scope of [...apiKeyScopes.filter(scope=>!scopes66.includes(scope)),...deferred])assert.equal(sql.includes(scope),false,scope);
 assert.match(sql,new RegExp(`cardinality\\(scopes\\) BETWEEN 1 AND ${scopes66.length}\\b`));
});

test('migration 0067 names each catalog scope exactly once and no deferred scope',()=>{
 const sql=read('../migrations/0067_audits_read_scope.sql');
 for(const scope of apiKeyScopes)assert.equal(count(sql,`'${scope}'`),1,scope);
 for(const scope of deferred)assert.equal(sql.includes(scope),false,scope);
 assert.match(sql,new RegExp(`cardinality\\(scopes\\) BETWEEN 1 AND ${apiKeyScopes.length}\\b`));
});
