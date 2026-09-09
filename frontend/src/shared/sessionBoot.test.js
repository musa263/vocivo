import assert from 'node:assert/strict';
import test from 'node:test';
import { showsOpeningScreen } from './sessionBoot.js';

test('the opening screen covers the first load only', () => {
  assert.equal(showsOpeningScreen(true, null), true, 'nothing to show until the session resolves');
  assert.equal(showsOpeningScreen(false, null), false);
  assert.equal(showsOpeningScreen(false, { id: 'user-1' }), false);
});

test('a session refresh behind a running call keeps the shell mounted', () => {
  const profile = { id: 'user-1', organization_id: 'company-a' };
  // What the eight-second retry does: a new session object, so the effect
  // re-runs and sets loading again while the phone is on a call.
  assert.equal(showsOpeningScreen(true, profile), false,
    'the call audio element and the call overlays must survive a refresh');
});
