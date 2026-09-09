import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBusinessVoiceSettings } from './voiceSettings.js';

function refusal(status) {
  const error = new Error('An active company account is required.');
  error.status = status;
  return error;
}

test('a customer without company voice settings loads as nothing, not as a failure', async () => {
  // What a superadmin gets for every individual customer, and for a company
  // whose subscription has lapsed.
  const api = async () => { throw refusal(403); };
  assert.equal(await loadBusinessVoiceSettings(api, true), null);
});

test('the request is not made at all when the feature is not entitled', async () => {
  let calls = 0;
  await loadBusinessVoiceSettings(async () => { calls += 1; return { config: {} }; }, false);
  assert.equal(calls, 0);
});

test('a business customer gets its saved configuration', async () => {
  const paths = [];
  const api = async (path) => { paths.push(path); return { config: { enabled: true, companyName: 'Company A' } }; };
  assert.deepEqual(await loadBusinessVoiceSettings(api, true), { enabled: true, companyName: 'Company A' });
  assert.deepEqual(paths, ['/api/voice/settings']);
});
