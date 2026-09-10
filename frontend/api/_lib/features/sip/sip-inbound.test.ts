import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPbxConfig, type PbxConfig } from '../organizations/pbx-config-store.js';
import type { ExtensionUser } from '../organizations/pbx.js';
import { lookupSipInbound, type SipInboundDirectory } from './sip-inbound.js';

function extension(overrides: Partial<ExtensionUser> = {}): ExtensionUser {
  return {
    id: 'u1', extension: '1001', name: 'Sam Tailor', email: 'sam@example.com', mobile: '',
    organizationId: 'primary', department: '', role: 'user', sipUsername: 'sam-1001',
    status: 'active', ...overrides,
  };
}

/** Stands in for the extension directory, which otherwise needs a database. */
function directory(extensions: ExtensionUser[] = []): SipInboundDirectory {
  return {
    extensionsFor: async () => extensions,
    usernamesForDestination: async () => extensions.map((entry) => entry.sipUsername).filter(Boolean),
  };
}

/** Runs a lookup with the SIP inbound flag set, and restores it afterwards. */
async function withSipInbound<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.VOCIVO_SIP_INBOUND;
  process.env.VOCIVO_SIP_INBOUND = '1';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.VOCIVO_SIP_INBOUND;
    else process.env.VOCIVO_SIP_INBOUND = previous;
  }
}

function openAllHours(config: PbxConfig) {
  Object.keys(config.officeHours.weekdays).forEach((day) => {
    config.officeHours.weekdays[day] = { enabled: true, start: '00:00', end: '23:59' };
  });
  return config;
}

function closedAllHours(config: PbxConfig) {
  Object.keys(config.officeHours.weekdays).forEach((day) => {
    config.officeHours.weekdays[day] = { enabled: false, start: '09:00', end: '17:00' };
  });
  return config;
}

const staff = [extension()];
const testTime = new Date('2026-09-07T09:00:00Z');

function assigned(config: PbxConfig, destinationType = 'main') {
  config.numberAssignments['+15551212'] = { organizationId: 'primary', destinationType } as never;
  return config;
}

test('keeps inbound DID lookup on Call Control until the SIP inbound flag is set', async () => {
  delete process.env.VOCIVO_SIP_INBOUND;
  const lookup = await lookupSipInbound('+15551212', assigned(defaultPbxConfig()), testTime, directory());
  assert.equal(lookup.enabled, false);
  assert.equal(lookup.reason, 'call_control');
  assert.equal(lookup.bridge, '');
  // No action at all: the edge must not answer a call the carrier's webhook is
  // already handling.
  assert.equal(lookup.action, undefined);
});

test('a number nobody owns is refused rather than routed somewhere', async () => {
  const lookup = await withSipInbound(() => lookupSipInbound('+15559999', defaultPbxConfig(), testTime, directory()));
  assert.equal(lookup.enabled, false);
  assert.equal(lookup.reason, 'unassigned');
});

test('a closed business is told so rather than ringing somebody at midnight', async () => {
  const config = closedAllHours(assigned(defaultPbxConfig()));
  config.company.name = 'Vocivo';
  const lookup = await withSipInbound(() => lookupSipInbound('+15551212', config, testTime, directory(staff)));
  assert.equal(lookup.action, 'closed');
  assert.equal(lookup.enabled, true);
  assert.match(lookup.prompt ?? '', /Vocivo/);
  assert.match(lookup.prompt ?? '', /closed/i);
});

test('the receptionist answers even when the office is closed', async () => {
  // After hours is exactly when a receptionist earns its keep: it tells the
  // caller the office is shut and takes a message. (The API's receptionist
  // profile drops the transfer targets meanwhile, so it never offers to put
  // people through to nobody.)
  const config = closedAllHours(assigned(defaultPbxConfig()));
  config.ai.enabled = true;
  const lookup = await withSipInbound(() => lookupSipInbound('+15551212', config, testTime, directory(staff)));
  assert.equal(lookup.action, 'ai');
});

test("the receptionist answers when the tenant has one switched on", async () => {
  const config = openAllHours(assigned(defaultPbxConfig()));
  config.ai.enabled = true;
  const lookup = await withSipInbound(() => lookupSipInbound('+15551212', config, testTime, directory(staff)));
  assert.equal(lookup.action, 'ai');
  assert.equal(lookup.enabled, true);
});

test('a number with nobody to ring and no receptionist is refused', async () => {
  const config = openAllHours(assigned(defaultPbxConfig()));
  const lookup = await withSipInbound(() => lookupSipInbound('+15551212', config, testTime, directory()));
  assert.equal(lookup.enabled, false);
  assert.equal(lookup.reason, 'no_contacts');
  assert.equal(lookup.action, undefined);
});

test('the office-hours decision is taken in the tenant’s own timezone', async () => {
  const config = assigned(defaultPbxConfig());
  config.officeHours.timezone = 'Asia/Riyadh';
  Object.keys(config.officeHours.weekdays).forEach((day) => {
    config.officeHours.weekdays[day] = { enabled: true, start: '09:00', end: '17:00' };
  });
  // 06:00 UTC is 09:00 in Riyadh — open there, still the small hours in London.
  const open = await withSipInbound(() => lookupSipInbound('+15551212', config, new Date('2026-09-07T06:30:00Z'), directory(staff)));
  assert.notEqual(open.action, 'closed');
  const closed = await withSipInbound(() => lookupSipInbound('+15551212', config, new Date('2026-09-07T20:00:00Z'), directory(staff)));
  assert.equal(closed.action, 'closed');
});

test('legacy fallback cannot broaden explicit destinations or override them with AI', async () => {
  const config = openAllHours(assigned(defaultPbxConfig()));
  config.ai.enabled = true;
  for (const destinationType of ['ring_group', 'queue', 'ivr'] as const) {
    config.numberAssignments['+15551212'] = { organizationId: 'primary', destinationType, destinationId: 'group' };
    const result = await withSipInbound(() => lookupSipInbound('+15551212', config, testTime, directory(staff)));
    assert.equal(result.enabled, false);
    assert.equal(result.bridge, '');
  }
  config.numberAssignments['+15551212'] = { organizationId: 'primary', destinationType: 'extension', destinationId: 'u1' };
  const result = await withSipInbound(() => lookupSipInbound('+15551212', config, testTime, directory([...staff, extension({ id: 'foreign', organizationId: 'other', sipUsername: 'foreign' })])));
  assert.equal(result.action, 'bridge');
  assert.deepEqual(result.usernames, ['sam-1001']);
});
