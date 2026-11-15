import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

// A member's role decides who may do what in the workspace. Changing it must be a deliberate, confirmed act, like
// removing a member: the role control never saves on its own change event.
test('a member role change is confirmed before it is saved', async () => {
  const code = await readFile('src/components/TeamPanel.tsx', 'utf8');
  const start = code.indexOf('async function changeRole(');
  assert.ok(start >= 0, 'changeRole is an async function so it can wait for the confirmation');
  const body = code.slice(start, code.indexOf('\n  }\n', start));
  const confirmAt = body.indexOf('await confirm({');
  const saveAt = body.indexOf('runMutation(');
  assert.ok(confirmAt > 0, 'changeRole asks for confirmation');
  assert.ok(saveAt > confirmAt, 'the role is saved only after the confirmation');
  assert.match(body, /if \(!await confirm\(\{[^]*?\}\)\) return;/, 'a declined confirmation saves nothing');
  // The shared hook in this panel is danger:true, so the question opens on Cancel (see tests/confirm-focus.test.ts).
  assert.match(code, /useConfirmDialog\(\{ danger: true \}\)/);
});
