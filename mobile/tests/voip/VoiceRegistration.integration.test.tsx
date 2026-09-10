import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// The mock has to carry everything the modules under test reach for at import
// time, not merely what the assertions use. This suite had been failing to load
// at all — silently costing the registration path its only integration cover,
// which is exactly the path push wake-ups and credential renewal run through —
// because AuthContext builds a StyleSheet as a module-level constant and the
// mock stopped at AppState.
jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  NativeModules: { VocivoSip: {} },
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, flatten: (style: unknown) => style },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
}));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true, default: { addEventListener: jest.fn(() => jest.fn()) },
}));
jest.mock('@telnyx/react-voice-commons-sdk', () => ({
  createTokenConfig: jest.fn(),
  TelnyxVoipClient: { isLaunchedFromPushNotification: jest.fn(async () => false) },
}));
jest.mock('../../src/shared/api', () => ({ api: {
  get: jest.fn(), post: jest.fn(), getSessionToken: jest.fn(async () => 'signed-session'),
  clearSessionToken: jest.fn(async () => undefined),
} }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined) }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null) }));
jest.mock('../../src/features/auth/sessionSnapshot', () => ({
  readSessionSnapshot: jest.fn(), saveSessionSnapshot: jest.fn(async () => undefined), clearSessionSnapshot: jest.fn(async () => undefined),
}));
jest.mock('../../src/features/calling/media/ringtone', () => ({
  defaultRingtone: 'vocivo_classic',
  applyIncomingRingtone: jest.fn(async () => undefined),
  loadIncomingRingtone: jest.fn(async () => 'system'),
}));
jest.mock('../../src/features/calling/runtime/voipClient', () => ({
  getVoicePushToken: jest.fn(async () => 'device-token'),
  loadVoiceSession: jest.fn(async () => null),
  persistVoiceSession: jest.fn(async () => undefined),
  setVoiceSignedIn: jest.fn(async () => undefined),
  signOutVoiceDevice: jest.fn(async () => undefined),
  voicePushDeviceId: jest.fn(async () => null),
  rememberVoicePushDeviceId: jest.fn(async () => undefined),
  voipClient: { loginWithToken: jest.fn() },
}));
jest.mock('../../src/features/calling/runtime/sipNative', () => ({
  unregisterVocivoSip: jest.fn(async () => undefined),
  onSipRegistration: jest.fn(() => ({ remove: jest.fn() })),
  onVocivoPushToken: jest.fn(() => ({ remove: jest.fn() })),
  refreshVocivoSip: jest.fn(async () => undefined),
  ensureSipRegistration: jest.fn(async () => 3600),
}));
jest.mock('../../src/features/calling/engine/engines', () => ({
  sipEngine: () => ({ name: 'sip', client: {}, platform: {} }),
  telnyxEngine: () => ({ name: 'telnyx', client: {}, platform: {} }),
}));
jest.mock('../../src/features/calling/engine/voiceClientFacade', () => ({
  voice: { use: jest.fn(), logout: jest.fn(async () => undefined) },
}));

import { api } from '../../src/shared/api';
import { TelnyxVoipClient } from '@telnyx/react-voice-commons-sdk';
import { ensureSipRegistration, unregisterVocivoSip } from '../../src/features/calling/runtime/sipNative';
import { getVoicePushToken, loadVoiceSession, persistVoiceSession, setVoiceSignedIn, voipClient } from '../../src/features/calling/runtime/voipClient';
import { applyIncomingRingtone, loadIncomingRingtone } from '../../src/features/calling/media/ringtone';
import { voice } from '../../src/features/calling/engine/voiceClientFacade';
import { useVoiceRegistration } from '../../src/features/calling/engine/useVoiceRegistration';
import { AuthProvider, useAuth } from '../../src/features/auth/AuthContext';
import { readSessionSnapshot, clearSessionSnapshot } from '../../src/features/auth/sessionSnapshot';

const iceServers = [{ urls: 'turn:relay.example:3478', username: 'temporary', credential: 'test' }];
const sipCredentials = { username: 'extension-user', password: 'test', domain: 'sip.example', wsUri: 'wss://sip.example', expires_in: 3600, ice_servers: iceServers };
let tree: TestRenderer.ReactTestRenderer | undefined;
let inputs: Parameters<typeof useVoiceRegistration>[0];

function Probe() { useVoiceRegistration(inputs); return null; }

let authState: ReturnType<typeof useAuth>;
function AuthenticatedProbe() {
  authState = useAuth();
  useVoiceRegistration({ ...inputs, loading: authState.loading, isAuthenticated: authState.isAuthenticated });
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  jest.clearAllMocks();
  inputs = {
    activeCallRef: { current: null }, loginConfigRef: { current: null },
    isAuthenticated: true, loading: false,
    reportVoiceError: jest.fn(), setError: jest.fn(), setPushRegistration: jest.fn(),
  };
  (api.get as jest.Mock).mockResolvedValue({ voice_edge: 'sip' });
  (api.post as jest.Mock).mockImplementation(async (path: string) => {
    if (path === '/api/voice/sip-credentials') return sipCredentials;
    if (path === '/api/voice/devices') return { ok: true };
    throw new Error(`Unexpected endpoint: ${path}`);
  });
});

afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

test('SIP startup shares the native bootstrap without requesting or persisting a Telnyx session', async () => {
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  expect(ensureSipRegistration).toHaveBeenCalledWith(false);
  expect(api.post).not.toHaveBeenCalledWith('/api/telnyx/token', expect.anything());
  expect(persistVoiceSession).not.toHaveBeenCalled();
  expect(voipClient.loginWithToken).not.toHaveBeenCalled();
  expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('registered');
});

test('configuration failure starts neither engine and retries instead of falling back to Telnyx', async () => {
  (api.get as jest.Mock).mockRejectedValue(new Error('offline'));
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  expect(api.post).not.toHaveBeenCalled();
  expect(ensureSipRegistration).not.toHaveBeenCalled();
  expect(inputs.reportVoiceError).toHaveBeenCalledWith('initialize configured voice engine', expect.any(Error));
  (api.get as jest.Mock).mockResolvedValue({ voice_edge: 'sip' });
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
});

test('failed push-token persistence is retried before registration is reported successful', async () => {
  (api.post as jest.Mock).mockRejectedValueOnce(new Error('temporary device store outage'));
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('unavailable');
  await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
  const deviceWrites = (api.post as jest.Mock).mock.calls.filter(([path]) => path === '/api/voice/devices');
  expect(deviceWrites).toHaveLength(2);
  expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('registered');
});

test('SIP startup does not wait for ringtone storage or push token delivery', async () => {
  const ringtone = deferred<'vocivo_classic'>();
  const push = deferred<string>();
  (loadIncomingRingtone as jest.Mock).mockReturnValueOnce(ringtone.promise);
  (getVoicePushToken as jest.Mock).mockReturnValueOnce(push.promise);
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
  expect(voice.use).toHaveBeenCalledWith('sip', expect.anything(), expect.anything());
  expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('registering');
  expect(api.post).not.toHaveBeenCalled();
  await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
  expect(getVoicePushToken).toHaveBeenCalledTimes(1);
  await act(async () => { ringtone.resolve('vocivo_classic'); push.resolve('device-token'); });
  expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('registered');
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
});

test('slow native ringtone setup and device persistence do not block SIP', async () => {
  const ringtone = deferred<void>();
  const deviceWrite = deferred<object>();
  (applyIncomingRingtone as jest.Mock).mockReturnValueOnce(ringtone.promise);
  (api.post as jest.Mock).mockReturnValueOnce(deviceWrite.promise);
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
  expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('registering');
  await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
  expect(api.post).toHaveBeenCalledTimes(1);
  await act(async () => { ringtone.resolve(); deviceWrite.resolve({ ok: true }); });
  expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('registered');
});

test('ringtone and push-token failures do not retry the signaling bootstrap', async () => {
  (applyIncomingRingtone as jest.Mock).mockRejectedValueOnce(new Error('native ringtone unavailable'));
  (getVoicePushToken as jest.Mock).mockRejectedValueOnce(new Error('push unavailable'));
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
  expect(inputs.setError).not.toHaveBeenCalled();
  expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('unavailable');
  expect(inputs.reportVoiceError).toHaveBeenCalledWith('prepare incoming ringtone', expect.any(Error));
  await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('registered');
});

test('late carrier bootstrap data does not fetch config or register SIP again', async () => {
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  inputs = { ...inputs, bootstrapSession: { token: 'carrier-token', expiresAt: Date.now() + 3600_000, ringtone: 'vocivo_classic' } };
  await act(async () => { tree!.update(<Probe />); });
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
  expect(voipClient.loginWithToken).not.toHaveBeenCalled();
});

test('the managed edge retains its token, persistence and login sequence', async () => {
  (api.get as jest.Mock).mockResolvedValue({ voice_edge: 'telnyx' });
  (api.post as jest.Mock).mockImplementation(async path => path === '/api/telnyx/token'
    ? { token: 'carrier-token', expires_in: 3600, ice_servers: iceServers }
    : { ok: true });
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  expect(ensureSipRegistration).not.toHaveBeenCalled();
  expect(voice.use).toHaveBeenCalledWith('telnyx', expect.anything(), expect.anything());
  expect(persistVoiceSession).toHaveBeenCalledTimes(1);
  expect(voipClient.loginWithToken).toHaveBeenCalledTimes(1);
  expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('registered');
});

test('pending auxiliary work cannot write device tokens or update status after cleanup', async () => {
  const ringtone = deferred<'vocivo_classic'>();
  const push = deferred<string>();
  (loadIncomingRingtone as jest.Mock).mockReturnValueOnce(ringtone.promise);
  (getVoicePushToken as jest.Mock).mockReturnValueOnce(push.promise);
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  (inputs.setPushRegistration as jest.Mock).mockClear();
  await act(async () => { ringtone.resolve('vocivo_classic'); push.resolve('device-token'); });
  expect(applyIncomingRingtone).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
  expect(inputs.setPushRegistration).not.toHaveBeenCalled();
});

test.each([{ loading: true, isAuthenticated: true }, { loading: false, isAuthenticated: false }])('startup still waits for verified authentication: %s', async (auth) => {
  inputs = { ...inputs, ...auth };
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  expect(api.get).not.toHaveBeenCalled();
  expect(ensureSipRegistration).not.toHaveBeenCalled();
});

const cachedProfile = { id: 'employee-a', email: 'employee@example.test', full_name: 'Employee A', extension: '2000' };
function prepareCachedAuth(snapshot: typeof cachedProfile | null = cachedProfile) {
  const session = deferred<{ profile: typeof cachedProfile }>();
  const account = deferred<object>();
  (readSessionSnapshot as jest.Mock).mockResolvedValue(snapshot);
  (api.get as jest.Mock).mockImplementation(path => {
    if (path === '/api/auth/session') return session.promise;
    if (path === '/api/mobile/bootstrap') return account.promise;
    if (path === '/api/voice/config') return Promise.resolve({ voice_edge: 'sip' });
    if (path === '/api/voice/history') return Promise.resolve({ calls: [] });
    throw new Error(`Unexpected endpoint: ${path}`);
  });
  return { session, account };
}

test('cached AuthContext starts SIP before HTTP validation and does not restart on fresh account data', async () => {
  const { session, account } = prepareCachedAuth();
  await act(async () => { tree = TestRenderer.create(<AuthProvider><AuthenticatedProbe /></AuthProvider>); });
  expect(readSessionSnapshot).toHaveBeenCalledWith('signed-session');
  expect(authState.loading).toBe(false);
  expect(authState.isAuthenticated).toBe(true);
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
  expect(setVoiceSignedIn).not.toHaveBeenCalledWith(false);
  expect(unregisterVocivoSip).not.toHaveBeenCalled();
  await act(async () => { session.resolve({ profile: { ...cachedProfile, full_name: 'Updated Employee' } }); });
  await act(async () => { account.resolve({ profile: cachedProfile, account: { balance: null, currency: 'USD' }, numbers: [], directory: [], calls: [] }); });
  expect((api.get as jest.Mock).mock.calls.filter(([path]) => path === '/api/voice/config')).toHaveLength(1);
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
});

test('initial loading preserves push bootstrap and an absent snapshot waits for the session response', async () => {
  const token = deferred<string>();
  (api.getSessionToken as jest.Mock).mockReturnValueOnce(token.promise);
  const { session } = prepareCachedAuth(null);
  await act(async () => { tree = TestRenderer.create(<AuthProvider><AuthenticatedProbe /></AuthProvider>); });
  expect(authState.loading).toBe(true);
  expect(unregisterVocivoSip).not.toHaveBeenCalled();
  expect(voice.logout).not.toHaveBeenCalled();
  expect(setVoiceSignedIn).not.toHaveBeenCalled();
  await act(async () => { token.resolve('signed-session'); });
  expect(ensureSipRegistration).not.toHaveBeenCalled();
  expect(unregisterVocivoSip).not.toHaveBeenCalled();
  await act(async () => { session.resolve({ profile: cachedProfile }); });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
});

test('HTTP session rejection tears down cached voice startup and prevents a delayed config response from starting it', async () => {
  const { session } = prepareCachedAuth();
  const config = deferred<object>();
  (api.get as jest.Mock).mockImplementation(path => path === '/api/auth/session' ? session.promise
    : path === '/api/voice/config' ? config.promise : Promise.resolve({ calls: [] }));
  await act(async () => { tree = TestRenderer.create(<AuthProvider><AuthenticatedProbe /></AuthProvider>); });
  expect(authState.isAuthenticated).toBe(true);
  await act(async () => { session.reject(Object.assign(new Error('Unauthorized'), { status: 401 })); });
  expect(authState.isAuthenticated).toBe(false);
  expect(authState.profile).toBeNull();
  expect(api.clearSessionToken).toHaveBeenCalled();
  expect(clearSessionSnapshot).toHaveBeenCalled();
  expect(unregisterVocivoSip).toHaveBeenCalled();
  expect(voice.logout).toHaveBeenCalled();
  expect(setVoiceSignedIn).toHaveBeenLastCalledWith(false);
  await act(async () => { config.resolve({ voice_edge: 'sip' }); });
  expect(ensureSipRegistration).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test('session rejection during SIP bootstrap cannot schedule refresh or push work after teardown', async () => {
  const { session } = prepareCachedAuth();
  const registration = deferred<number>();
  (ensureSipRegistration as jest.Mock).mockReturnValueOnce(registration.promise);
  await act(async () => { tree = TestRenderer.create(<AuthProvider><AuthenticatedProbe /></AuthProvider>); });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
  await act(async () => { session.reject(Object.assign(new Error('Unauthorized'), { status: 401 })); });
  expect(unregisterVocivoSip).toHaveBeenCalled();
  await act(async () => { registration.resolve(3600); });
  expect(getVoicePushToken).not.toHaveBeenCalled();
  expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('unavailable');
  expect(jest.getTimerCount()).toBe(0);
});




test('managed push launch saves the validated cached session before mounting its runtime', async () => {
  (api.get as jest.Mock).mockResolvedValue({ voice_edge: 'telnyx' });
  jest.mocked(TelnyxVoipClient.isLaunchedFromPushNotification).mockResolvedValueOnce(true);
  const cached = { iceServers: undefined, token: 'cached-carrier-token', expiresAt: Date.now() + 3600_000, ringtone: 'system' as const };
  jest.mocked(loadVoiceSession).mockResolvedValueOnce(cached);
  const saved = deferred<void>();
  jest.mocked(persistVoiceSession).mockReturnValueOnce(saved.promise);
  inputs.onEngineSelected = jest.fn();
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  expect(persistVoiceSession).toHaveBeenCalledWith(cached);
  expect(inputs.onEngineSelected).not.toHaveBeenCalled();
  await act(async () => { saved.resolve(); });
  expect(inputs.onEngineSelected).toHaveBeenCalledWith('telnyx');
  expect(api.post).not.toHaveBeenCalledWith('/api/telnyx/token', expect.anything());
  expect(voipClient.loginWithToken).not.toHaveBeenCalled(); // The managed push runtime performs this login.
});

test('a handset that refuses notifications reports push unavailable and backs the poll off', async () => {
  // No token is ever coming: notifications were declined. The poll used to run
  // every two seconds for as long as the app lived, with the UI stuck on
  // "registering" the whole time.
  (getVoicePushToken as jest.Mock).mockResolvedValue(undefined);
  try {
    await act(async () => { tree = TestRenderer.create(<Probe />); });
    expect(api.post).not.toHaveBeenCalledWith('/api/voice/devices', expect.anything());
    await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
    expect(inputs.setPushRegistration).toHaveBeenLastCalledWith('unavailable');
    const asked = (getVoicePushToken as jest.Mock).mock.calls.length;
    // Five more minutes of an interval would be 150 further attempts.
    await act(async () => { await jest.advanceTimersByTimeAsync(300_000); });
    expect((getVoicePushToken as jest.Mock).mock.calls.length - asked).toBeLessThan(12);
  } finally {
    (getVoicePushToken as jest.Mock).mockResolvedValue('device-token');
  }
});
