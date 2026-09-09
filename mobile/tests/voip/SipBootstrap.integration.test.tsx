jest.mock('react-native', () => ({ NativeModules: {}, Platform: { OS: 'ios' }, NativeEventEmitter: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(), setItemAsync: jest.fn(async () => undefined), deleteItemAsync: jest.fn(async () => undefined),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-unlock-device-only',
}));
jest.mock('../../src/shared/api', () => ({ api: { getSessionToken: jest.fn(), post: jest.fn(), delete: jest.fn(async () => ({})) } }));
jest.mock('../../src/features/calling/engine/sipStackSipJs', () => ({ createSipJsStack: jest.fn() }));

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { api } from '../../src/shared/api';
import { createSipJsStack } from '../../src/features/calling/engine/sipStackSipJs';
import { createSipVoiceClient, disposeSipVoiceClient, ensureSipRegistration, unregisterVocivoSip } from '../../src/features/calling/runtime/sipNative';

const config = { username: 'employee-a', password: 'temporary', domain: 'sip.example', wsUri: 'wss://sip.example/ws', iceServers: [{ urls: 'turns:relay.example', username: 'ephemeral', credential: 'test' }] };
const device = { deviceId: 'iphone-installation-1234', credentialId: 'credential-generation-5678' };
const response = { ...config, ...device, expires_in: 3600, ice_servers: config.iceServers };
const secureValues = new Map<string, string>();
function cache(value: object) { secureValues.set('vocivo.secure.sip-session.v1', JSON.stringify({ ...device, ...value })); }
let stack: { updateCredentials: jest.Mock; start: jest.Mock; stop: jest.Mock; refresh: jest.Mock; onRegistrationChange: jest.Mock; onInvitation: jest.Mock };

/**
 * Registration decisions here are all about time: how much of a cached
 * credential's life is left, whether its TURN grant has run out, how long the
 * next refresh should wait. Read from the wall clock they drifted between the
 * moment a case was written and the moment it ran — the near-expiry case below
 * is only ten seconds from its deadline, and on a cold run it could be an
 * already-expired cache by the time it was checked, which is a different branch
 * and would have hidden a regression in the thirty-second freshness guard.
 */
const pinnedNow = Date.parse('2026-08-25T10:00:00.000Z');

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  jest.setSystemTime(pinnedNow);
  jest.clearAllMocks();
  (Platform as { OS: string }).OS = 'ios';
  stack = { updateCredentials: jest.fn(async () => undefined), start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), refresh: jest.fn(async () => undefined), onRegistrationChange: jest.fn(), onInvitation: jest.fn() };
  (api.getSessionToken as jest.Mock).mockResolvedValue('signed-session-a');
  (api.post as jest.Mock).mockResolvedValue(response);
  secureValues.clear();
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async key => secureValues.get(key) || null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key, value) => { secureValues.set(key, value); });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async key => { secureValues.delete(key); });
  (createSipJsStack as jest.Mock).mockResolvedValue(stack);
});

afterEach(async () => { await unregisterVocivoSip(); disposeSipVoiceClient(); jest.useRealTimers(); });

test('a killed-state bootstrap can register directly from a fresh secure cache with TURN intact', async () => {
  cache({ sessionToken: 'signed-session-a', config, expiresAt: Date.now() + 3600_000 });
  await ensureSipRegistration();
  expect(api.post).not.toHaveBeenCalled();
  expect(createSipJsStack).toHaveBeenCalledWith(expect.objectContaining(config), expect.anything());
  expect(stack.start).toHaveBeenCalledTimes(1);
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(expect.any(String), expect.any(String), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
});

test.each([
  ['expired a millisecond ago', -1],
  ['ten seconds from expiry, inside the thirty-second guard', 10_000],
  ['without an expiry at all', null],
])('a cache %s is refreshed before connecting', async (_case, offsetMs) => {
  cache({ sessionToken: 'signed-session-a', config, expiresAt: offsetMs === null ? null : Date.now() + offsetMs });
  await ensureSipRegistration();
  expect(api.post).toHaveBeenCalledWith('/api/voice/sip-credentials', { client: 'ios' });
  expect(stack.start).toHaveBeenCalledTimes(1);
});

test('a cache from another signed-in session is never reused', async () => {
  cache({ sessionToken: 'other-session', config, expiresAt: Date.now() + 3600_000 });
  await ensureSipRegistration();
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('foreground and push boot share one in-flight registration', async () => {
  const first = ensureSipRegistration(); const second = ensureSipRegistration();
  expect(first).toBe(second); await first;
  expect(stack.start).toHaveBeenCalledTimes(1);
});

test('secure cache reads overlap session restoration but cannot register before authentication', async () => {
  cache({ sessionToken: 'signed-session-a', config, expiresAt: Date.now() + 3600_000 });
  let finish!: (token: string) => void;
  (api.getSessionToken as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const boot = ensureSipRegistration();
  expect(SecureStore.getItemAsync).toHaveBeenCalledWith('vocivo.secure.sip-session.v1');
  expect(stack.start).not.toHaveBeenCalled();
  finish('signed-session-a');
  await boot;
  expect(api.post).not.toHaveBeenCalled();
  expect(stack.start).toHaveBeenCalledTimes(1);
});

test('a fresh cached credential cannot start signaling without a signed-in session', async () => {
  cache({ sessionToken: 'signed-session-a', config, expiresAt: Date.now() + 3600_000 });
  (api.getSessionToken as jest.Mock).mockResolvedValueOnce(null);
  await expect(ensureSipRegistration()).rejects.toThrow('Sign in before receiving calls.');
  expect(api.post).not.toHaveBeenCalled();
  expect(stack.start).not.toHaveBeenCalled();
});

test('changing the session during secure bootstrap rejects the otherwise fresh cache', async () => {
  cache({ sessionToken: 'signed-session-a', config, expiresAt: Date.now() + 3600_000 });
  (api.getSessionToken as jest.Mock).mockResolvedValueOnce('signed-session-a').mockResolvedValueOnce('signed-session-b');
  await expect(ensureSipRegistration()).rejects.toThrow('Calling session changed.');
  expect(stack.start).not.toHaveBeenCalled();
});

test('logout invalidates a pending bootstrap before it can open a signaling socket', async () => {
  const client = createSipVoiceClient();
  let finish!: (value: typeof response) => void;
  (api.post as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const boot = ensureSipRegistration();
  const failure = expect(boot).rejects.toThrow('Calling session changed');
  while (!finish) await Promise.resolve();
  const logout = client.logout();
  finish(response); await failure; await logout;
  expect(stack.start).not.toHaveBeenCalled();
  expect(SecureStore.deleteItemAsync).toHaveBeenCalled();
  expect(api.delete).toHaveBeenCalledWith(expect.stringContaining(`credentialId=${device.credentialId}`));
});

test.each(['ios', 'android'])('%s registration persists its installation identity across rotations and logout', async (platform) => {
  (Platform as { OS: string }).OS = platform;
  await ensureSipRegistration();
  expect(secureValues.get('vocivo.secure.sip-device.v1')).toBe(device.deviceId);
  await ensureSipRegistration(true);
  expect(api.post).toHaveBeenLastCalledWith('/api/voice/sip-credentials', { client: platform, deviceId: device.deviceId });
  await unregisterVocivoSip();
  expect(api.delete).toHaveBeenCalledWith(`/api/voice/sip-credentials?deviceId=${device.deviceId}&credentialId=${device.credentialId}`);
  expect(secureValues.has('vocivo.secure.sip-session.v1')).toBe(false);
  expect(secureValues.get('vocivo.secure.sip-device.v1')).toBe(device.deviceId);
});

test('an old week-long SIP cache with expired TURN is renewed before bootstrap', async () => {
  const expiredIce = [{ urls: 'turn:relay.example:3478', username: `${Math.floor(Date.now() / 1000) - 1}:employee`, credential: 'old-turn' }];
  cache({ sessionToken: 'signed-session-a', config: { ...config, iceServers: expiredIce }, expiresAt: Date.now() + 7 * 86400_000 });
  await ensureSipRegistration();
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(createSipJsStack).toHaveBeenCalledWith(expect.objectContaining({ iceServers: config.iceServers }), expect.anything());
});

test('cached TURN expiry bounds the next scheduled configuration refresh', async () => {
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const iceServers = [{ urls: 'turn:relay.example:3478', username: `${expiry}:employee`, credential: 'turn' }];
  cache({ sessionToken: 'signed-session-a', config: { ...config, iceServers }, expiresAt: Date.now() + 7 * 86400_000 });
  const lifetime = await ensureSipRegistration();
  expect(api.post).not.toHaveBeenCalled();
  // Exactly the TURN grant, not the seven-day password: on a pinned clock this
  // is one number rather than a window wide enough to swallow a regression.
  expect(lifetime).toBe(120);
});


test('a forced network renewal is not lost behind cached foreground bootstrap', async () => {
  cache({sessionToken:'signed-session-a',config,expiresAt:Date.now()+3600_000});
  let started!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  stack.start.mockImplementationOnce(() => { started(); return new Promise<void>(resolve => { finish = resolve; }); });
  const boot = ensureSipRegistration();
  await starting;
  const renewal = ensureSipRegistration(true);
  const repeated = ensureSipRegistration(true);
  finish();
  await Promise.all([boot,renewal,repeated]);
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('renewal before a pushed call INVITE preserves its registered contact and can answer the late invitation', async () => {
  const client = createSipVoiceClient();
  cache({ sessionToken: 'signed-session-a', config, expiresAt: Date.now() + 3600_000 });
  await ensureSipRegistration();
  const incoming = stack.onInvitation.mock.calls[0][0];
  (api.post as jest.Mock).mockResolvedValueOnce({ ...response, password: 'renewed', credentialId: 'new-generation' });
  await ensureSipRegistration(true);
  expect(stack.stop).not.toHaveBeenCalled();
  expect(createSipJsStack).toHaveBeenCalledTimes(1);
  const accept = jest.fn(async () => undefined);
  const terminate = jest.fn(async () => undefined);
  incoming({
    id: 'push-before-invite', incoming: true, headers: [], remoteDisplayName: 'Colleague',
    remoteUser: '2000', remoteTarget: 'sip:2000@sip.example', onStateChange: jest.fn(),
    disposition: () => ({}), peerConnection: () => undefined, accept, terminate,
    dispose: jest.fn(async () => undefined),
  });
  const call = client.currentCalls[0];
  expect(call).toBeDefined();
  await call!.answer!();
  expect(accept).toHaveBeenCalledTimes(1);
  expect(terminate).not.toHaveBeenCalled();
});

test('a credential response arriving after an incoming call cannot replace its live stack', async () => {
  cache({ sessionToken: 'signed-session-a', config, expiresAt: Date.now() + 3600_000 });
  await ensureSipRegistration();
  let finish!: (value: typeof response) => void;
  (api.post as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const renewal = ensureSipRegistration(true);
  while (!finish) await Promise.resolve();

  let stateChanged!: (state: string) => void;
  const dispose = jest.fn(async () => undefined);
  const handle = {
    id: 'incoming-during-renewal', incoming: true, headers: [],
    remoteDisplayName: 'Colleague', remoteUser: '2000', remoteTarget: 'sip:2000@sip.example',
    onStateChange: (listener: typeof stateChanged) => { stateChanged = listener; },
    onProgress: jest.fn(), disposition: () => ({}), peerConnection: () => undefined,
    accept: jest.fn(), terminate: jest.fn(), dispose,
  };
  stack.onInvitation.mock.calls[0][0](handle);
  stateChanged('Established');
  finish({ ...response, password: 'rotated-password', credentialId: 'new-generation' });
  const retryLifetime = await renewal;

  expect(dispose).not.toHaveBeenCalled();
  expect(stack.stop).not.toHaveBeenCalled();
  expect(createSipJsStack).toHaveBeenCalledTimes(1);
  expect(stack.updateCredentials).toHaveBeenCalledWith(expect.objectContaining({ password: 'rotated-password' }));
  expect(retryLifetime).toBeGreaterThan(0);
  expect(retryLifetime).toBeGreaterThan(3500);

  stateChanged('Terminated');
  await ensureSipRegistration();
  expect(createSipJsStack).toHaveBeenCalledTimes(1);
  expect(stack.updateCredentials).toHaveBeenLastCalledWith(expect.objectContaining({ password: 'rotated-password' }));
  expect(api.post).toHaveBeenCalledTimes(1);
});
