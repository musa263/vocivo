import assert from 'node:assert/strict';
import test from 'node:test';
import { tenantSnapshots } from './telemetry.js';
import { telemetryFresh } from './telemetry-store.js';
const now = Date.now();
const directory: any = [{ id: 'a', organizationId: 'one', sipUsername: 'user-a' }, { id: 'b', organizationId: 'two', sipUsername: 'user-b' }];
const base = { version: 1, observedAt: new Date(now).toISOString(), registrations: [{ username: 'user-a', contacts: 2, expiresAt: new Date(now + 60000).toISOString(), password: 'must-not-leak' }], calls: [] };
test('complete snapshots isolate users, clear empty tenants and strip sensitive fields', () => {
  const [one, two] = tenantSnapshots(base, ['one', 'two'], directory, now);
  assert.equal(one.registrations[0].extensionId, 'a'); assert.equal(two.registrations.length, 0);
  assert.ok(!JSON.stringify(one).includes('password')); assert.ok(!JSON.stringify(one).includes('user-a'));
  assert.equal(telemetryFresh(one, now + 45000), false); assert.equal(telemetryFresh(null), false);
});
test('cross-tenant call evidence and stale samples cannot populate a tenant', () => {
  const calls = [{ id: 'c', direction: 'internal', state: 'active', usernames: ['user-a', 'user-b'], organizationId: '', queueId: '', startedAt: new Date(now).toISOString() }];
  assert.ok(tenantSnapshots({ ...base, calls }, ['one', 'two'], directory, now).every(s => s.calls.length === 0));
  assert.throws(() => tenantSnapshots(base, ['one'], directory, now + 60000));
  assert.throws(() => tenantSnapshots({ ...base, calls: [{ ...calls[0], state: 'made-up' }] }, ['one'], directory, now));
});
