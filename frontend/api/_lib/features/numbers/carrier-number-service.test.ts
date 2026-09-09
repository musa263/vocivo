import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { applyCarrierNumbers, carrierNumberInventory, detachCompanyNumber, withLiveNumberRoutes } from './carrier-number-service.js';
import { normalizeCarrierTrunk, type CarrierTrunk } from './carrier-trunk-store.js';
import { defaultPbxConfig, mergePbxConfig, pbxForOrganization } from '../organizations/pbx-config-store.js';

function trunk(organizationId = 'primary'): CarrierTrunk {
  return { ...normalizeCarrierTrunk({ id: randomUUID(), name: 'Example carrier', provider: 'Example',
    server: '192.0.2.20', port: 5060, transport: 'UDP', publicIp: '198.51.100.10', authentication: 'ip',
    mainNumber: '0135110000', numbers: [0, 1].map(i => ({ inboundNumber: `013511000${i}`,
      callerId: `96613511000${i}`, destinationType: 'unassigned' })) }, organizationId),
    revision: 1, updatedAt: '2026-09-08T00:00:00Z' };
}

test('publishes carrier DIDs with explicit ownership while leaving destinations unassigned', () => {
  const config = defaultPbxConfig(), saved = trunk();
  const next = mergePbxConfig({ ...config, ...applyCarrierNumbers(config, 'primary', saved) });
  assert.equal(next.numberAssignments['+966135110000'].source, 'carrier');
  assert.equal(next.numberAssignments['+966135110000'].destinationType, undefined);
  assert.equal(next.numberAssignments['+966135110000'].carrierTrunkRevision, 1);
  assert.equal(pbxForOrganization(next, 'primary').company.callingMode, 'carrier');
  assert.equal(pbxForOrganization(next, 'primary').company.defaultCallerId, '+966135110000');
  assert.deepEqual(config.numberAssignments, {}, 'does not mutate the snapshot before its transaction');
  assert.ok(carrierNumberInventory([saved]).every(item => item.status === 'pending_activation' && !item.receives_calls));
});

test('denies foreign trunks, cross-tenant claims and ambiguous trunks in one company', () => {
  const config = defaultPbxConfig(), saved = trunk();
  assert.throws(() => applyCarrierNumbers(config, 'primary', trunk('other')), /does not belong/);
  config.numberAssignments[saved.numbers[0].callerId] = { organizationId: 'other' };
  assert.throws(() => applyCarrierNumbers(config, 'primary', saved), /already assigned/);
  config.numberAssignments[saved.numbers[0].callerId] = { organizationId: 'primary', carrierTrunkId: randomUUID(), source: 'carrier' };
  assert.throws(() => applyCarrierNumbers(config, 'primary', saved), /already assigned/);
});

test('removing a number leaves a tombstone and clears only its company default', () => {
  const config = defaultPbxConfig();
  config.company.defaultCallerId = '+12025550123';
  config.numberAssignments = { '+12025550123': { organizationId: 'primary', source: 'carrier', destinationType: 'main' },
    '+442071230000': { organizationId: 'other', source: 'carrier' },
    '+12025550199': { organizationId: 'primary', source: 'owned', destinationType: 'main' } };
  config.organizations.push({ ...config.organizations[0], id: 'other', slug: 'other' });
  const beforeOther = pbxForOrganization(config, 'other').company;
  const next = mergePbxConfig({ ...config, ...detachCompanyNumber(config, 'primary', '+12025550123') });
  assert.equal(next.numberAssignments['+12025550123'].disabled, true);
  assert.equal(pbxForOrganization(next, 'primary').company.defaultCallerId, '');
  assert.deepEqual(pbxForOrganization(next, 'other').company, beforeOther);
  assert.throws(() => detachCompanyNumber(config, 'primary', '+442071230000'), /not found/);
  // The carrier trunk screen removes DIDs the company brought with its own
  // carrier. A number Vocivo provided is not one of those, and taking it off
  // the air from here left a company with no way to put its main line back.
  assert.throws(() => detachCompanyNumber(config, 'primary', '+12025550199', [], { carrierOnly: true }), /provided by Vocivo/);
  assert.ok(detachCompanyNumber(config, 'primary', '+12025550199'), 'the phone numbers screen may still retire a Vocivo number');
});

test('republishing an edited trunk disables removed DIDs without touching another trunk', () => {
  const saved = trunk(), config = defaultPbxConfig();
  const initial = mergePbxConfig({ ...config, ...applyCarrierNumbers(config, 'primary', saved) });
  initial.numberAssignments['+12025550123'] = { organizationId: 'primary', source: 'owned' };
  const next = applyCarrierNumbers(initial, 'primary', { ...saved, revision: 2, numbers: saved.numbers.slice(0, 1) });
  assert.equal(next.numberAssignments['+966135110001'].disabled, true);
  assert.equal(next.numberAssignments['+966135110000'].carrierTrunkRevision, 2);
  assert.deepEqual(next.numberAssignments['+12025550123'], initial.numberAssignments['+12025550123']);
});

test('trunk republication cannot overwrite destinations assigned through Users or Phone numbers', () => {
  const saved = trunk(), config = defaultPbxConfig();
  Object.assign(config, applyCarrierNumbers(config, 'primary', saved));
  const number = saved.numbers[0].callerId;
  config.numberAssignments[number] = { ...config.numberAssignments[number], destinationType: 'extension', destinationId: 'user-2001' };
  const next = applyCarrierNumbers(config, 'primary', { ...saved, revision: 2 });
  assert.equal(next.numberAssignments[number].destinationId, 'user-2001');
  assert.equal(next.numberAssignments[number].carrierTrunkRevision, 2);
  assert.equal(withLiveNumberRoutes(saved, config).numbers[0].destinationId, 'user-2001');
  assert.equal(saved.numbers[0].destinationType, 'unassigned', 'legacy inventory is not mutated');
});
