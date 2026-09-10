import { managedCarrierSourceAllowed } from './carrier-runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCarrierTrunk, type CarrierTrunk } from './carrier-trunk-store.js';
import { carrierDeployments, carrierGateway, carrierReadiness, resolveCarrierOutbound, resolveInboundNumber } from './carrier-runtime.js';
import { renderCarrierGateway } from './carrier-gateway-config.js';
import { applyCarrierNumbers } from './carrier-number-service.js';
import { defaultPbxConfig } from '../organizations/pbx-config-store.js';

export function carrierFixture() {
  const trunk: CarrierTrunk = { ...normalizeCarrierTrunk({ id: '12345678-1234-1234-1234-123456789012', name: 'Example', provider: 'Carrier',
    server: '192.0.2.20', port: 5060, transport: 'UDP', publicIp: '198.51.100.10', authentication: 'ip',
    channelLimit: 5, inboundEnabled: true, outboundEnabled: true,
    numbers: [{ inboundNumber: '0135110000', callerId: '+966135110000', destinationType: 'main' }] }, 'primary'), revision: 1, updatedAt: '2026-09-08T00:00:00Z' };
  const base = defaultPbxConfig();
  const config = { ...base, ...applyCarrierNumbers(base, 'primary', trunk) };
  const deployment = renderCarrierGateway(trunk, '', trunk.publicIp, [trunk.server]).deployment;
  return { trunk, config, deployment, did: trunk.numbers[0].callerId };
}

test('carrier admission requires current ownership, deployment, caller ID and explicit direction', async () => {
  const { trunk, config, deployment, did } = carrierFixture();
  const resolve = (trunks = [trunk], deployments = [deployment]) => resolveCarrierOutbound(config, 'primary', did, trunks, deployments);
  assert.equal((await resolve())?.gateway, carrierGateway(trunk));
  await assert.rejects(resolve([trunk], []), /not been deployed/);
  await assert.rejects(resolve([{ ...trunk, revision: 2 }]), /current trunk numbers/);
  await assert.rejects(resolve([{ ...trunk, outboundEnabled: false }]), /disabled/);
  await assert.rejects(resolve([{ ...trunk, organizationId: 'other' }]), /current trunk/);
  await assert.rejects(resolveCarrierOutbound(config, 'other', did, [trunk], [deployment]), /not assigned/);
  config.numberAssignments[did].disabled = true;
  await assert.rejects(resolve(), /not assigned/);
});

test('national inbound aliases are scoped to carrier source and never select an unassigned DID', () => {
  const { trunk, config, deployment, did } = carrierFixture();
  assert.equal(resolveInboundNumber(config, '0135110000', trunk.server, [deployment]), did);
  assert.equal(resolveInboundNumber(config, did, trunk.server, [deployment]), did);
  assert.equal(resolveInboundNumber(config, did, '192.0.2.21', [deployment]), '');
  assert.equal(resolveInboundNumber(config, did, trunk.server, [{ ...deployment, organizationId: 'other' }]), '');
  delete config.numberAssignments[did].destinationType;
  assert.equal(resolveInboundNumber(config, did, trunk.server, [deployment]), '');
});

test('a tenant carrier cannot deliver a number that carrier does not serve', () => {
  const { trunk, config, deployment } = carrierFixture();
  // A number Vocivo assigned, belonging to a different company than the one
  // whose trunk this is. The edge admits every trusted source, so "it arrived
  // on 5060" says nothing about whose carrier sent it.
  config.organizations.push({ ...config.organizations[0], id: 'other', slug: 'other' });
  const platformDid = '+12025550123';
  config.numberAssignments[platformDid] = { organizationId: 'other', source: 'owned', destinationType: 'main' };

  assert.equal(resolveInboundNumber(config, platformDid, '198.51.100.99', [deployment]), '',
    'an unnamed platform carrier must not acquire authority from the edge allowlist');
  assert.equal(resolveInboundNumber(config, platformDid, trunk.server, [deployment]), '',
    'one company SIP trunk must never ring another company by dialling its Vocivo number');

  const expired = { ...deployment, expiresAt: new Date(Date.now() - 60_000).toISOString() };
  assert.equal(resolveInboundNumber(config, platformDid, trunk.server, [expired]), '',
    'an expired temporary deployment does not authorize a managed carrier');
});

test('naming the platform signalling addresses refuses a platform number from anywhere else', () => {
  const { config, deployment } = carrierFixture();
  const platformDid = '+12025550123';
  config.numberAssignments[platformDid] = { organizationId: 'primary', source: 'owned', destinationType: 'main' };
  const previous = process.env.VOCIVO_PLATFORM_TRUNK_SOURCES;
  process.env.VOCIVO_PLATFORM_TRUNK_SOURCES = '203.0.113.7, 203.0.113.8';
  try {
    assert.equal(resolveInboundNumber(config, platformDid, '203.0.113.8', [deployment]), platformDid);
    assert.equal(resolveInboundNumber(config, platformDid, '198.51.100.99', [deployment]), '');
  } finally {
    if (previous === undefined) delete process.env.VOCIVO_PLATFORM_TRUNK_SOURCES;
    else process.env.VOCIVO_PLATFORM_TRUNK_SOURCES = previous;
  }
});

test('operator gateway artifacts bind the real public IP and cannot activate a form or smuggle XML', () => {
  const { trunk, deployment } = carrierFixture();
  assert.equal(carrierReadiness(trunk, []).status, 'pending_activation');
  assert.equal(carrierReadiness(trunk, [deployment]).status, 'ready');
  assert.equal(carrierReadiness({ ...trunk, revision: 2, connectionRevision: 1 }, [deployment]).status, 'ready', 'destination-only edits keep the connection');
  assert.throws(() => renderCarrierGateway(trunk, '', '198.51.100.11', [trunk.server]), /does not match/);
  assert.throws(() => renderCarrierGateway(trunk, '', trunk.publicIp, ['0.0.0.0/0']), /Exact carrier/);
  const registration = { ...trunk, authentication: 'registration' as const, username: 'sip-user' };
  assert.throws(() => renderCarrierGateway(registration, '', trunk.publicIp, [trunk.server]), /missing/);
  const artifact = renderCarrierGateway(registration, 'abc&<>"123', trunk.publicIp, [trunk.server]);
  assert.match(artifact.xml, /abc&amp;&lt;&gt;&quot;123/);
  assert.throws(() => renderCarrierGateway(registration, '${system bad}', trunk.publicIp, [trunk.server]), /expansion/);
  assert.deepEqual(carrierDeployments(JSON.stringify([deployment])), [deployment]);
  assert.throws(() => carrierDeployments(JSON.stringify([{ ...deployment, gateway: 'telnyx' }])));
  assert.throws(() => carrierDeployments(JSON.stringify([deployment, deployment])));
});

test('temporary carrier deadlines stop both outbound grants and inbound resolution', async () => {
  const { trunk, config, deployment, did } = carrierFixture();
  const active = { ...deployment, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const expired = { ...deployment, expiresAt: new Date(Date.now() - 1).toISOString() };
  assert.equal(carrierReadiness(trunk, [active]).status, 'ready');
  assert.equal((await resolveCarrierOutbound(config, 'primary', did, [trunk], [active]))?.gateway, deployment.gateway);
  assert.equal(carrierReadiness(trunk, [expired]).status, 'pending_activation');
  await assert.rejects(resolveCarrierOutbound(config, 'primary', did, [trunk], [expired]), /temporary carrier test has ended/);
  assert.equal(resolveInboundNumber(config, did, trunk.server, [active]), did);
  assert.equal(resolveInboundNumber(config, did, trunk.server, [expired]), '');
  for (const expiresAt of [null, '', '2026-02-30T00:00:00.000Z', 'tomorrow', 123]) {
    assert.throws(() => carrierDeployments(JSON.stringify([{ ...deployment, expiresAt }])), /Invalid carrier deployment/);
  }
  assert.deepEqual(carrierDeployments(JSON.stringify([active])), [active]);
});

test('an outbound-only deployment admits outbound without claiming inbound activation', async () => {
  const { trunk, config, deployment, did } = carrierFixture();
  const outboundOnly = { ...deployment, inboundSources: [] };
  assert.match(carrierReadiness(trunk, [outboundOnly]).reason, /Inbound calling has not been deployed/);
  assert.equal((await resolveCarrierOutbound(config, 'primary', did, [trunk], [outboundOnly]))?.gateway, deployment.gateway);
  assert.equal(resolveInboundNumber(config, did, trunk.server, [outboundOnly]), '');
});


test('managed sources cannot inherit BYOC admission or accept unknown carrier origins', () => {
  assert.equal(managedCarrierSourceAllowed('192.0.2.1', ''), false);
  assert.equal(managedCarrierSourceAllowed('192.0.2.1', '192.0.2.0/24'), true);
  assert.equal(managedCarrierSourceAllowed('198.51.100.1', '192.0.2.0/24'), false);
  assert.throws(() => managedCarrierSourceAllowed('192.0.2.1', '192.0.2.0/99'), /Invalid managed/);
});
