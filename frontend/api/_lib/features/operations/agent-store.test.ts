import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentStore, AgentConflict } from './agent-store.js';
test('agent changes are CAS-protected, tenant-scoped and never accept manual On Call', async () => {
  const rows = new Map<string, Buffer>(); let lock = Promise.resolve();
  const store = createAgentStore({ readObjects: async paths => new Map(paths.filter(p => rows.has(p)).map(p => [p, rows.get(p)!])),
    transactObject: (async (path: string, update: any) => { const task = lock.then(async () => { rows.set(path, await update(rows.get(path) || null)); }); lock = task.then(() => {}, () => {}); await task; }) as any });
  const updates = await Promise.allSettled([store.update('a', 'employee', 'on_break', 0, 'admin'), store.update('a', 'employee', 'available', 0, 'admin')]);
  assert.equal(updates.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await store.read('a', ['employee']))[0].state, 'on_break');
  assert.equal((await store.read('b', ['employee']))[0].state, 'available');
  await assert.rejects(store.update('a', 'employee', 'available', 0, 'admin'), AgentConflict);
  await assert.rejects(store.update('a', 'employee', 'on_call' as any, 1, 'admin'));
});
