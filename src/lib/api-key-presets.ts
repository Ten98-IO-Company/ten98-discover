import type {ApiKeyScope} from '../server/api-keys.ts';

// Presets only choose which scopes a new key requests; the server still validates every scope against the issuer's role.
// tests/api-key-presets.test.ts derives the MCP sets from the live MCP tool catalog, so a new tool scope fails there first.
export type ApiKeyPresetId = 'reports-read' | 'mcp-read' | 'mcp-edit' | 'send-events' | 'custom';
export interface ApiKeyPreset { id: ApiKeyPresetId; label: string; description: string; scopes: readonly ApiKeyScope[] | null }

const mcpReadScopes: readonly ApiKeyScope[] = ['analytics:read', 'prompts:read', 'context:read', 'segments:read', 'annotations:read', 'rank:read', 'keywords:read', 'google:read', 'domains:read', 'audits:read'];

export const apiKeyPresets: readonly ApiKeyPreset[] = [
  { id: 'reports-read', label: 'Read-only reports', description: 'Read every report, project, prompt, context and team list. Cannot change anything.',
    scopes: ['projects:read', 'analytics:read', 'team:read', 'prompts:read', 'context:read', 'segments:read', 'annotations:read', 'rank:read', 'keywords:read', 'google:read', 'domains:read', 'audits:read'] },
  { id: 'mcp-read', label: 'MCP read-only', description: 'Lets an AI tool read what the MCP tools offer. Cannot change anything.', scopes: mcpReadScopes },
  { id: 'mcp-edit', label: 'MCP with prompt and context edits', description: 'MCP read-only, plus saving prompts and editing project context. Saving a prompt never runs it.',
    scopes: [...mcpReadScopes, 'prompts:write', 'context:write'] },
  { id: 'send-events', label: 'Send events', description: 'Send analytics events from a server. Cannot read anything.', scopes: ['events:write'] },
  { id: 'custom', label: 'Custom', description: 'Choose no, read or write access for each area.', scopes: null },
];

export type AccessLevel = 'none' | 'read' | 'write';
export interface ApiKeyScopeRow { id: string; label: string; read?: ApiKeyScope; write?: ApiKeyScope }
export interface ApiKeyScopeGroup { label: string; rows: readonly ApiKeyScopeRow[] }

export const apiKeyScopeGroups: readonly ApiKeyScopeGroup[] = [
  { label: 'Projects', rows: [{ id: 'projects', label: 'Projects', read: 'projects:read', write: 'projects:write' }] },
  { label: 'Analytics', rows: [
    { id: 'analytics', label: 'Analytics reports', read: 'analytics:read' },
    { id: 'events', label: 'Send events', write: 'events:write' },
    { id: 'segments', label: 'Saved filters and cohorts', read: 'segments:read' },
    { id: 'annotations', label: 'Annotations', read: 'annotations:read' },
  ] },
  { label: 'Prompts', rows: [{ id: 'prompts', label: 'Authored prompts', read: 'prompts:read', write: 'prompts:write' }] },
  { label: 'Context', rows: [{ id: 'context', label: 'Project context', read: 'context:read', write: 'context:write' }] },
  { label: 'Search data', rows: [
    { id: 'rank', label: 'Rank trackers and reports', read: 'rank:read' },
    { id: 'keywords', label: 'Saved keywords', read: 'keywords:read' },
    { id: 'google', label: 'Google sources and saved snapshots', read: 'google:read' },
    { id: 'domains', label: 'Domains and redirect checks', read: 'domains:read' },
    { id: 'audits', label: 'Site audit history and issues', read: 'audits:read' },
  ] },
  { label: 'Team', rows: [{ id: 'team', label: 'Team members', read: 'team:read' }] },
];
const scopeRows = apiKeyScopeGroups.flatMap(group => group.rows);

export function customLevelOptions(row: ApiKeyScopeRow): { value: AccessLevel; label: string }[] {
  return [{ value: 'none', label: 'None' }, ...(row.read ? [{ value: 'read' as const, label: 'Read' }] : []), ...(row.write ? [{ value: 'write' as const, label: row.read ? 'Write' : 'Send' }] : [])];
}

/** Write includes read where the row has both, so a custom key never writes data it cannot read back. */
export function scopesFromLevels(levels: Readonly<Record<string, AccessLevel>>): ApiKeyScope[] {
  return scopeRows.flatMap(row => {
    const level = levels[row.id] ?? 'none';
    if (level === 'write' && row.write) return row.read ? [row.read, row.write] : [row.write];
    return level === 'read' && row.read ? [row.read] : [];
  });
}

export function levelsFromScopes(scopes: readonly string[]): Record<string, AccessLevel> {
  return Object.fromEntries(scopeRows.map(row => [row.id, row.write && scopes.includes(row.write) ? 'write' : row.read && scopes.includes(row.read) ? 'read' : 'none']));
}

export function presetForScopes(scopes: readonly string[]): ApiKeyPreset | null {
  const wanted = new Set(scopes);
  return apiKeyPresets.find(preset => preset.scopes !== null && preset.scopes.length === wanted.size && preset.scopes.every(scope => wanted.has(scope))) ?? null;
}

export function accessLabel(scopes: readonly string[]): string {
  return presetForScopes(scopes)?.label ?? `Custom · ${scopes.length}`;
}

/** The placeholder every MCP snippet uses. Keys cannot be re-read, so a snippet never embeds a real one. */
export const mcpKeyPlaceholder = '<your-key>';
export interface McpClientSnippet { id: string; label: string; hint: string; language: string; code: string }

export function mcpClientSnippets(serverUrl: string): McpClientSnippet[] {
  const bearer = `Bearer ${mcpKeyPlaceholder}`, json = (value: unknown) => JSON.stringify(value, null, 2);
  return [
    { id: 'claude-code', label: 'Claude Code', hint: 'Run in a terminal.', language: 'shell',
      code: `claude mcp add --transport http ten98 ${serverUrl} --header "Authorization: ${bearer}"` },
    { id: 'claude-desktop', label: 'Claude Desktop', hint: 'Add to claude_desktop_config.json, then restart Claude Desktop. Needs Node.js for the mcp-remote bridge.', language: 'json',
      code: json({ mcpServers: { ten98: { command: 'npx', args: ['-y', 'mcp-remote', serverUrl, '--header', `Authorization: ${bearer}`] } } }) },
    { id: 'cursor', label: 'Cursor', hint: 'Add to .cursor/mcp.json.', language: 'json',
      code: json({ mcpServers: { ten98: { url: serverUrl, headers: { Authorization: bearer } } } }) },
    { id: 'vscode', label: 'VS Code', hint: 'Add to .vscode/mcp.json.', language: 'json',
      code: json({ servers: { ten98: { type: 'http', url: serverUrl, headers: { Authorization: bearer } } } }) },
    { id: 'other', label: 'Other', hint: 'Any client that supports streamable HTTP. Send JSON-RPC with POST only, without cookies or URL parameters.', language: 'http',
      code: `POST ${serverUrl}\nAuthorization: ${bearer}\nContent-Type: application/json\nAccept: application/json, text/event-stream` },
  ];
}
