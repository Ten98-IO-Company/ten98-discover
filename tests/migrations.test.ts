import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import test from 'node:test';
import {migrationFiles} from '../src/server/db.ts';

test('the runtime migration registry includes every shipped SQL migration in order',()=>{
  const shipped=readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  assert.deepEqual([...migrationFiles],shipped,'Register each shipped migration in src/server/db.ts so startup and CLI migration apply it.');
});