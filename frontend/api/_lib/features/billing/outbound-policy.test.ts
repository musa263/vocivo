import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPbxConfig } from '../organizations/pbx-config-store.js';
import { authorizeOutboundCall } from './outbound-policy.js';

test('allows the default international route', () => {
  const rule = authorizeOutboundCall(defaultPbxConfig(), { extension: '2001', department: 'Sales', internationalAllowed: true }, '+2348189200000', '+18447161777');
  assert.equal(rule.id, 'international');
});

test('blocks international calls when the user permission is disabled', () => {
  assert.throws(
    () => authorizeOutboundCall(defaultPbxConfig(), { extension: '2001', department: 'Sales', internationalAllowed: false }, '+2348189200000', '+18447161777'),
    /International calling is disabled/,
  );
});

test('allows a domestic call when international permission is disabled', () => {
  const rule = authorizeOutboundCall(defaultPbxConfig(), { extension: '2001', department: 'Sales', internationalAllowed: false }, '+15168889967', '+18447161777');
  assert.equal(rule.id, 'international');
});

test('matches extension range, number length and department', () => {
  const config = defaultPbxConfig();
  config.outboundRules = [{ id: 'sales', name: 'Sales', prefix: '+966', extensionRange: '2000-2020', numberLength: '12', department: 'Sales', routes: ['Primary'], enabled: true }];
  assert.equal(authorizeOutboundCall(config, { extension: '2002', department: 'Sales', internationalAllowed: true }, '+966535548337', '+18447161777').id, 'sales');
  assert.throws(() => authorizeOutboundCall(config, { extension: '2021', department: 'Sales', internationalAllowed: true }, '+966535548337', '+18447161777'), /No enabled outbound rule/);
});

test('unknown numbering regions cannot bypass disabled international permission', () => {
  assert.throws(() => authorizeOutboundCall(defaultPbxConfig(), { extension: '2001', internationalAllowed: false }, '+442079460018', '+15551230000'), /International calling is disabled/);
});
