import assert from 'node:assert/strict';
import test from 'node:test';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createOverviewHandler } from './admin-overview.js';
import { carrierFixture } from '../../numbers/carrier-runtime.test.js';
import type { VocivoSession } from '../../auth/auth.js';

test('SIP/BYOC overview reports tenant inventory without contacting Telnyx or claiming live health', async () => {
  const { trunk, config, did } = carrierFixture();
  let code = 0;
  let result: any;
  const response = { setHeader() {}, status(value: number) { code = value; return this; }, json(value: unknown) { result = value; return this; } };
  const handler = createOverviewHandler({
    requireAdmin: async () => ({ superadmin: true, organizationId: undefined, session: { sub: 'vocivo-owner', role: 'owner' } as VocivoSession }),
    readPbxConfig: async () => config,
    listExtensions: async () => [],
    readBusinessVoiceConfig: async () => ({}) as any,
    data: async () => { throw new Error('SIP/BYOC must not request a managed carrier'); },
    listTrunks: async () => [trunk], voiceEdge: () => 'sip', sipDomain: () => 'sip.example.test',
    apnsConfig: () => null, fcmConfig: () => null,
  });
  const req = { method: 'GET', headers: {}, query: { organizationId: 'primary' } } as unknown as VercelRequest;
  await handler(req, response as unknown as VercelResponse);
  assert.equal(code, 200);
  assert.equal(result.metrics.phoneNumbers, 1);
  assert.equal(result.phoneNumbers[0].phone_number, did);
  assert.equal(result.connection.provider, 'sip');
  assert.equal(result.connection.active, null);
  assert.equal(result.metrics.balance, null);
  config.numberAssignments[did].disabled = true;
  await handler(req, response as unknown as VercelResponse);
  assert.equal(result.metrics.phoneNumbers, 0);
});
