import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Final table/column shape replayed from the ordered SQL migrations, without a database.
 * Handles the DDL forms the migrations use: CREATE TABLE, ALTER TABLE ADD/DROP COLUMN,
 * ADD [CONSTRAINT] FOREIGN KEY, RENAME [COLUMN] and DROP TABLE. Function bodies are skipped.
 */
export type MigrationColumn = { name: string; referencesUser: boolean };
export type MigrationSchema = Map<string, Map<string, MigrationColumn>>;

function stripSql(source: string): string {
  return source
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** Split on a separator character at parenthesis depth zero, outside quoted text. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote: string | null = null, start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === separator && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}

const identifier = (raw: string) => raw.trim().replace(/^"|"$/g, '');
const name = String.raw`("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)`;
const referencesUser = /\bREFERENCES\s+"user"\s*\(/i;
const tableConstraint = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)\b/i;

function foreignKeyColumns(item: string): string[] {
  const match = item.match(/FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+"user"\s*\(/i);
  return match ? match[1].split(',').map(identifier) : [];
}

export function parseMigrations(sources: readonly string[]): MigrationSchema {
  const tables: MigrationSchema = new Map();
  for (const source of sources) {
    for (const statement of splitTopLevel(stripSql(source), ';')) {
      const create = statement.match(new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${name}\s*\(([\s\S]*)\)[^)]*$`, 'i'));
      if (create) {
        const columns = new Map<string, MigrationColumn>();
        const items = splitTopLevel(create[2], ',');
        for (const item of items) {
          if (tableConstraint.test(item)) continue;
          const column = identifier(item.match(new RegExp(`^${name}`))![1]);
          columns.set(column, { name: column, referencesUser: referencesUser.test(item) });
        }
        for (const item of items) for (const column of foreignKeyColumns(item)) columns.get(column)!.referencesUser = true;
        tables.set(identifier(create[1]), columns);
        continue;
      }
      const drop = statement.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?$/i);
      if (drop) { for (const table of drop[1].split(',')) tables.delete(identifier(table)); continue; }
      const alter = statement.match(new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${name}\s+([\s\S]*)$`, 'i'));
      if (!alter) continue;
      const tableName = identifier(alter[1]);
      const rename = alter[2].match(new RegExp(`^RENAME\\s+TO\\s+${name}$`, 'i'));
      if (rename) { tables.set(identifier(rename[1]), tables.get(tableName)!); tables.delete(tableName); continue; }
      const columns = tables.get(tableName);
      if (!columns) throw new Error(`Migration alters unknown table ${tableName}.`);
      for (const action of splitTopLevel(alter[2], ',')) {
        const added = action.match(new RegExp(`^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}`, 'i'));
        if (added && !tableConstraint.test(action.replace(/^ADD\s+/i, ''))) {
          const column = identifier(added[1]);
          columns.set(column, { name: column, referencesUser: referencesUser.test(action) });
          continue;
        }
        for (const column of foreignKeyColumns(action)) columns.get(column)!.referencesUser = true;
        const dropped = action.match(new RegExp(`^DROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?${name}`, 'i'));
        if (dropped) { columns.delete(identifier(dropped[1])); continue; }
        const renamed = action.match(new RegExp(`^RENAME\\s+(?:COLUMN\\s+)?${name}\\s+TO\\s+${name}$`, 'i'));
        if (renamed) {
          const previous = columns.get(identifier(renamed[1]))!;
          columns.delete(previous.name);
          columns.set(identifier(renamed[2]), { ...previous, name: identifier(renamed[2]) });
        }
      }
    }
  }
  return tables;
}

export function readMigrationSchema(directory = join(process.cwd(), 'migrations')): MigrationSchema {
  const files = readdirSync(directory).filter(file => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
  return parseMigrations(files.map(file => readFileSync(join(directory, file), 'utf8')));
}
