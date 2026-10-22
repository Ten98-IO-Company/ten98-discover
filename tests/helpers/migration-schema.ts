import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Final table/column shape replayed from the ordered SQL migrations, without a database.
 * Handles the DDL forms the migrations use: CREATE TABLE, ALTER TABLE ADD/DROP COLUMN,
 * ADD [CONSTRAINT] FOREIGN KEY, RENAME [COLUMN] and DROP TABLE. Function bodies are skipped.
 * Foreign keys are recorded with their ON DELETE action; the migrations never drop a foreign key constraint by name.
 */
/** A foreign key, shared by each of its referencing columns. `onDelete` is uppercase, `NO ACTION` when omitted. */
export type MigrationForeignKey = { columns: string[]; table: string; onDelete: string };
/** `type` is the declared type's leading words, lowercase (for example `text`, `jsonb`, `timestamptz`). */
export type MigrationColumn = { name: string; type: string; referencesUser: boolean; foreignKeys: MigrationForeignKey[] };
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
// Schema-qualified and column-less references count: REFERENCES "user", public."user"(id), "public"."user".
const userTable = String.raw`(?:"?public"?\.)?"user"(?=\s*\(|\s|,|$)`;
const referencesUser = new RegExp(String.raw`\bREFERENCES\s+${userTable}`, 'i');
/** Optional schema qualifier before a table name. */
const table = String.raw`(?:"?public"?\.)?${name}`;
const columnType = (definition: string) => definition.replace(new RegExp(String.raw`^${name}\s+`), '').match(/^[A-Za-z_][A-Za-z0-9_ ]*?(?=\(|\[|\s|$)/)?.[0].toLowerCase() ?? '';
const tableConstraint = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)\b/i;

/** The REFERENCES clause of one column definition, table constraint or ALTER action, if any. */
function foreignKey(item: string, inlineColumn?: string): MigrationForeignKey | null {
  const columns = item.match(/FOREIGN\s+KEY\s*\(([^)]*)\)/i)?.[1].split(',').map(identifier) ?? (inlineColumn ? [inlineColumn] : null);
  const target = item.match(new RegExp(String.raw`\bREFERENCES\s+${table}`, 'i'));
  if (!columns || !target) return null;
  const onDelete = item.match(/\bON\s+DELETE\s+(CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT)\b/i)?.[1].replace(/\s+/, ' ').toUpperCase() ?? 'NO ACTION';
  return { columns, table: identifier(target[1]), onDelete };
}

function addForeignKey(columns: Map<string, MigrationColumn>, key: MigrationForeignKey | null): void {
  if (key) for (const column of key.columns) columns.get(column)!.foreignKeys.push(key);
}

function foreignKeyColumns(item: string): string[] {
  const match = item.match(new RegExp(String.raw`FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+${userTable}`, 'i'));
  return match ? match[1].split(',').map(identifier) : [];
}

export function parseMigrations(sources: readonly string[]): MigrationSchema {
  const tables: MigrationSchema = new Map();
  for (const source of sources) {
    for (const statement of splitTopLevel(stripSql(source), ';')) {
      const create = statement.match(new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${table}\s*\(([\s\S]*)\)[^)]*$`, 'i'));
      if (create) {
        const columns = new Map<string, MigrationColumn>();
        const items = splitTopLevel(create[2], ',');
        for (const item of items) {
          if (tableConstraint.test(item)) continue;
          const column = identifier(item.match(new RegExp(`^${name}`))![1]);
          columns.set(column, { name: column, type: columnType(item), referencesUser: referencesUser.test(item), foreignKeys: [] });
          addForeignKey(columns, foreignKey(item, column));
        }
        for (const item of items) {
          for (const column of foreignKeyColumns(item)) columns.get(column)!.referencesUser = true;
          if (tableConstraint.test(item)) addForeignKey(columns, foreignKey(item));
        }
        tables.set(identifier(create[1]), columns);
        continue;
      }
      const drop = statement.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?$/i);
      if (drop) { for (const dropped of drop[1].split(',')) tables.delete(identifier(dropped.replace(/^\s*"?public"?\./i, ''))); continue; }
      const alter = statement.match(new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${table}\s+([\s\S]*)$`, 'i'));
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
          columns.set(column, { name: column, type: columnType(action.replace(/^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i, '')), referencesUser: referencesUser.test(action), foreignKeys: [] });
          addForeignKey(columns, foreignKey(action, column));
          continue;
        }
        for (const column of foreignKeyColumns(action)) columns.get(column)!.referencesUser = true;
        if (/^ADD\s/i.test(action)) addForeignKey(columns, foreignKey(action));
        const dropped = action.match(new RegExp(`^DROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?${name}`, 'i'));
        if (dropped) {
          // Dropping a column drops every constraint that uses it.
          const column = identifier(dropped[1]);
          columns.delete(column);
          for (const remaining of columns.values()) remaining.foreignKeys = remaining.foreignKeys.filter(key => !key.columns.includes(column));
          continue;
        }
        const renamed = action.match(new RegExp(`^RENAME\\s+(?:COLUMN\\s+)?${name}\\s+TO\\s+${name}$`, 'i'));
        if (renamed) {
          const previous = columns.get(identifier(renamed[1]))!;
          columns.delete(previous.name);
          columns.set(identifier(renamed[2]), { ...previous, name: identifier(renamed[2]) });
          for (const key of new Set([...columns.values()].flatMap(column => column.foreignKeys))) key.columns = key.columns.map(column => column === previous.name ? identifier(renamed[2]) : column);
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
