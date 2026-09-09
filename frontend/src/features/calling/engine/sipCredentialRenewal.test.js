import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialRenewalDelayMs } from './sipCredentialRenewal.js';

test('an idle phone renews its password immediately', () => {
  assert.equal(credentialRenewalDelayMs({ onCall: false, connectionPending: false }), null);
});

test('a call in progress is waited out rather than cut off', () => {
  assert.equal(credentialRenewalDelayMs({ onCall: true, connectionPending: false }), 60_000);
  assert.equal(credentialRenewalDelayMs({ onCall: true, connectionPending: true }), 60_000);
});

test('a renewal that comes due before the phone finishes connecting comes back', () => {
  // A short credential whose renewal falls due mid-connect. Returning nothing
  // here left no timer armed, and the password expired under a live phone.
  const delay = credentialRenewalDelayMs({ onCall: false, connectionPending: true });
  assert.ok(typeof delay === 'number' && delay > 0 && delay <= 10_000, 'the chain has to survive a slow connect');
});
