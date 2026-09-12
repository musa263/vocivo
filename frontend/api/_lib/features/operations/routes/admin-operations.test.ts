import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationsHandler } from './admin-operations.js';
const now = new Date().toISOString();
function fixture(role = 'company_admin') {
  let reads = 0; const writes: unknown[] = [];
  const org = { id: 'one', status: 'active' };
  const config: any = { organizations: [org, { id: 'two', status: 'active' }], activeOrganizationId: 'one', callHandling: { queues: [] }, organizationSettings: {}, numberAssignments: {} };
  const handler = createOperationsHandler({ requireAdmin: async () => ({ session: { sub: role === 'superadmin' ? 'vocivo-owner' : 'admin', role, organizationId: role === 'superadmin' ? undefined : 'one' } }) as any,
    readPbxConfig: async () => config, requireFeature: async () => ({ superadmin: true }) as any, voiceEdge: () => 'sip',
    listExtensions: async () => { reads++; return [{ id: 'a', extension: '2000', name: 'Colleague', status: 'active' }] as any; },
    agentStore: { read: async () => [{ extensionId: 'a', state: 'available', version: 0, updatedAt: '' }], update: async (...args) => { writes.push(args); } },
    telemetryStore: { read: async () => ({ organizationId: 'one', observedAt: new Date(Date.now() - 60000).toISOString(), registrations: [], calls: [] }), save: async () => {} } });
  async function request(method: string, query: any, body = {}) { let status = 0, payload: any; await handler({ method, headers: {}, query, body } as any, { setHeader() {}, status(code: number) { status = code; return this; }, json(data: any) { payload = data; return this; } } as any); return { status, payload }; }
  return { request, writes, reads: () => reads, now };
}
test('company administrator cannot read or change another tenant', async () => {
  const f = fixture();
  assert.equal((await f.request('GET', { organizationId: 'two' })).status, 403);
  assert.equal((await f.request('PATCH', { organizationId: 'two' }, { extensionId: 'a', state: 'on_break', version: 0 })).status, 403);
  assert.equal(f.reads(), 0); assert.equal(f.writes.length, 0);
});
test('platform owner must select a tenant; stale telemetry cannot claim inactive phones', async () => {
  const f = fixture('superadmin');
  assert.notEqual((await f.request('GET', {})).status, 200);
  const result = await f.request('GET', { organizationId: 'one' });
  assert.equal(result.status, 200); assert.equal(result.payload.counters, null);
  assert.equal(result.payload.agents[0].registration, 'unknown');
});
test('agent mutations validate member and state before writing', async () => {
  const f = fixture();
  assert.equal((await f.request('PATCH', {}, { extensionId: 'foreign', state: 'on_break', version: 0 })).status, 404);
  assert.equal((await f.request('PATCH', {}, { extensionId: 'a', state: 'on_call', version: 0 })).status, 400);
  assert.equal((await f.request('PATCH', {}, { extensionId: 'a', state: 'on_break', version: 0 })).status, 200);
  assert.equal(f.writes.length, 1); assert.equal((f.writes[0] as any)[0], 'one');
});
