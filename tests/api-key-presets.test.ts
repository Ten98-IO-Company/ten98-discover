import test from 'node:test';
import assert from 'node:assert/strict';
import {apiKeyScopes} from '../src/server/api-keys.ts';
import {mcpTools} from '../src/server/mcp-tools.ts';
import {apiKeyPresets,apiKeyScopeGroups,presetForScopes,accessLabel,levelsFromScopes,scopesFromLevels,customLevelOptions,mcpClientSnippets,mcpKeyPlaceholder} from '../src/lib/api-key-presets.ts';

const sorted=(scopes:readonly string[])=>[...scopes].sort();
const preset=(id:string)=>{const found=apiKeyPresets.find(item=>item.id===id);assert.ok(found,id);return found!;};
// Derived from the live MCP catalog so a new tool scope changes the expected MCP presets.
const mcpScopes=[...new Set(mcpTools.flatMap(tool=>tool.scope===null?[]:[tool.scope]))];
const mcpRead=mcpScopes.filter(scope=>scope.endsWith(':read')),mcpWrite=mcpScopes.filter(scope=>scope.endsWith(':write'));

test('the five presets are the issue #353 list in order, with Custom last and carrying no fixed scopes',()=>{
 assert.deepEqual(apiKeyPresets.map(item=>item.label),['Read-only reports','MCP read-only','MCP with prompt and context edits','Send events','Custom']);
 assert.equal(preset('custom').scopes,null);
});

test('each preset grants exactly its specified scope set, and every scope is a valid server scope',()=>{
 assert.deepEqual(sorted(preset('reports-read').scopes!),sorted(apiKeyScopes.filter(scope=>scope.endsWith(':read'))));
 assert.equal(mcpRead.length,10);
 assert.deepEqual(sorted(preset('mcp-read').scopes!),sorted(mcpRead));
 assert.deepEqual(sorted(mcpWrite),['context:write','prompts:write']);
 assert.deepEqual(sorted(preset('mcp-edit').scopes!),sorted([...mcpRead,'prompts:write','context:write']));
 assert.deepEqual(preset('send-events').scopes,['events:write']);
 for(const item of apiKeyPresets){
  if(item.scopes===null)continue;
  assert.equal(new Set(item.scopes).size,item.scopes.length,item.id);
  for(const scope of item.scopes)assert.ok((apiKeyScopes as readonly string[]).includes(scope),`${item.id}: ${scope}`);
 }
});

test('custom groups cover every server scope exactly once under the six issue headings',()=>{
 assert.deepEqual(apiKeyScopeGroups.map(group=>group.label),['Projects','Analytics','Prompts','Context','Search data','Team']);
 const listed=apiKeyScopeGroups.flatMap(group=>group.rows.flatMap(row=>[row.read,row.write].filter((scope):scope is NonNullable<typeof scope>=>scope!==undefined)));
 assert.equal(new Set(listed).size,listed.length);
 assert.deepEqual(sorted(listed),sorted(apiKeyScopes));
 for(const row of apiKeyScopeGroups.flatMap(group=>group.rows)){
  assert.doesNotMatch(row.label,/[a-z]+:(read|write)/,'no raw scope ids in labels');
  assert.deepEqual(customLevelOptions(row).map(option=>option.value),['none',...(row.read?['read']:[]),...(row.write?['write']:[])]);
 }
});

test('every fixed preset round-trips through the custom none/read/write rows',()=>{
 for(const item of apiKeyPresets)if(item.scopes)assert.deepEqual(sorted(scopesFromLevels(levelsFromScopes(item.scopes))),sorted(item.scopes),item.id);
 assert.deepEqual(scopesFromLevels(levelsFromScopes([])),[]);
});

test('access labels name a matching preset regardless of order and otherwise count the custom scopes',()=>{
 assert.equal(presetForScopes([...preset('mcp-read').scopes!].reverse())?.id,'mcp-read');
 assert.equal(accessLabel(['events:write']),'Send events');
 assert.equal(accessLabel(['analytics:read','prompts:read','team:read','rank:read','domains:read']),'Custom · 5');
 assert.equal(presetForScopes(['analytics:read']),null);
});

test('every MCP client snippet targets the given server URL with the key placeholder, never a key',()=>{
 const url='https://discover.example/api/mcp',snippets=mcpClientSnippets(url);
 assert.deepEqual(snippets.map(item=>item.label),['Claude Code','Claude Desktop','Cursor','VS Code','Other']);
 for(const item of snippets){
  assert.ok(item.code.includes(url),item.id);
  assert.ok(item.code.includes(`Bearer ${mcpKeyPlaceholder}`),item.id);
  assert.doesNotMatch(item.code,/t98k_/,item.id);
  if(item.language==='json')assert.doesNotThrow(()=>JSON.parse(item.code),item.id);
 }
});
