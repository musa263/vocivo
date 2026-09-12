import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceApi } from './workspace-api.js';

test('every workspace request captures its own tab and preserves other query parameters', async () => {
  const paths = [];
  const request = async (path, options) => { paths.push([path, options]); return {}; };
  const a = workspaceApi(request, 'company-a');
  const b = workspaceApi(request, 'company-b');
  for (const path of ['/api/admin/pbx', '/api/admin/ai', '/api/admin/extensions', '/api/admin/overview', '/api/admin/events', '/api/admin/api-keys', '/api/admin/numbers', '/api/admin/trunks', '/api/admin/carrier-trunks', '/api/admin/background', '/api/voice/settings']) {
    await a(`${path}?id=123`, { method: 'PUT', body: { greeting: 'A' } });
    await b(path);
    assert.equal(new URL(paths.at(-2)[0], 'https://local').searchParams.get('organizationId'), 'company-a');
    assert.equal(new URL(paths.at(-2)[0], 'https://local').searchParams.get('id'), '123');
    assert.equal(new URL(paths.at(-1)[0], 'https://local').searchParams.get('organizationId'), 'company-b');
  }
  await a('/api/admin/wallets', { method: 'PUT', body: { organizationId: 'company-b' } });
  assert.equal(paths.at(-1)[0], '/api/admin/wallets', 'platform operations retain their explicit target');
});

test('stale callbacks neither submit old forms nor publish delayed responses', async () => {
  let current = true, complete, calls = 0;
  const api = workspaceApi(() => { calls++; return new Promise(resolve => { complete = resolve; }); }, 'a', () => current);
  const pending = api('/api/voice/settings');
  current = false;
  complete({ config: { companyName: 'A' } });
  await assert.rejects(pending, /workspace changed/);
  await assert.rejects(api('/api/admin/ai', { method: 'PUT' }), /workspace changed/);
  assert.equal(calls, 1);
  await assert.rejects(workspaceApi(() => assert.fail('must not send'), '')('/api/admin/pbx'), /workspace changed/);
});

test('operations and reports retain explicit tenant binding and date filters', async () => {
  const paths = [];
  const api = workspaceApi(async path => { paths.push(path); return {}; }, 'company-two');
  await api('/api/admin/operations', { method: 'PATCH', body: { extensionId: 'member', state: 'on_break', version: 1 } });
  await api('/api/admin/reports?from=2026-09-01&timezone=UTC');
  assert.equal(new URL(paths[0], 'https://local').searchParams.get('organizationId'), 'company-two');
  const report = new URL(paths[1], 'https://local');
  assert.equal(report.searchParams.get('organizationId'), 'company-two');
  assert.equal(report.searchParams.get('from'), '2026-09-01');
});
