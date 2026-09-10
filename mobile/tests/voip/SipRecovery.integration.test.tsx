import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  NativeModules: { VocivoSip: {} },
  Platform: { OS: 'ios' },
}));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true, default: { addEventListener: jest.fn(() => jest.fn()) },
}));
jest.mock('@telnyx/react-voice-commons-sdk', () => ({
  createTokenConfig: jest.fn(),
  TelnyxVoipClient: { isLaunchedFromPushNotification: jest.fn(async () => false) },
}));
jest.mock('../../src/shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../src/features/calling/media/ringtone', () => ({
  applyIncomingRingtone: jest.fn(async () => undefined),
  loadIncomingRingtone: jest.fn(async () => 'system'),
}));
jest.mock('../../src/features/calling/runtime/voipClient', () => ({
  getVoicePushToken: jest.fn(async () => 'device-token'),
  persistVoiceSession: jest.fn(async () => undefined),
  voicePushDeviceId: jest.fn(async () => null),
  rememberVoicePushDeviceId: jest.fn(async () => undefined),
  voipClient: { loginWithToken: jest.fn() },
}));
jest.mock('../../src/features/calling/runtime/sipNative', () => ({
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
import { ensureSipRegistration } from '../../src/features/calling/runtime/sipNative';
import { persistVoiceSession, voipClient } from '../../src/features/calling/runtime/voipClient';
import { useVoiceRegistration } from '../../src/features/calling/engine/useVoiceRegistration';

const iceServers = [{ urls: 'turn:relay.example:3478', username: 'temporary', credential: 'test' }];
const sipCredentials = { username: 'extension-user', password: 'test', domain: 'sip.example', wsUri: 'wss://sip.example', expires_in: 3600, ice_servers: iceServers };
let tree: TestRenderer.ReactTestRenderer | undefined;
let inputs: Parameters<typeof useVoiceRegistration>[0];

function Probe() { useVoiceRegistration(inputs); return null; }

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

test('foreground validates SIP cache after suspended expiry timers', async () => {
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  const { AppState } = require('react-native');
  const foreground = AppState.addEventListener.mock.calls.at(-1)[1];
  (ensureSipRegistration as jest.Mock).mockClear();
  await act(async () => { foreground('active'); await jest.advanceTimersByTimeAsync(250); });
  expect(ensureSipRegistration).toHaveBeenCalledWith(false);
});

test('Wi-Fi to cellular renews idle SIP configuration once after a burst', async () => {
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  const NetInfo = require('@react-native-community/netinfo').default;
  const network = NetInfo.addEventListener.mock.calls.at(-1)[0];
  (ensureSipRegistration as jest.Mock).mockClear();
  await act(async () => {
    network({type:'wifi',isConnected:true,isInternetReachable:true});
    network({type:'cellular',isConnected:true,isInternetReachable:true});
    network({type:'cellular',isConnected:true,isInternetReachable:true});
    await jest.advanceTimersByTimeAsync(1000);
  });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
  expect(ensureSipRegistration).toHaveBeenCalledWith(true);
});


test('a final Digest refusal renews credentials with one bounded retry', async () => {
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  const { onSipRegistration } = require('../../src/features/calling/runtime/sipNative');
  const outcome = onSipRegistration.mock.calls.at(-1)[0];
  (ensureSipRegistration as jest.Mock).mockClear();
  await act(async () => {
    outcome('failed','403 Forbidden'); outcome('failed','403 Forbidden');
    await jest.advanceTimersByTimeAsync(2999);
  });
  expect(ensureSipRegistration).not.toHaveBeenCalled();
  await act(async () => { await jest.advanceTimersByTimeAsync(1); });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
  expect(ensureSipRegistration).toHaveBeenCalledWith(true);
});

test('network migration does not replace a stack carrying a call', async () => {
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  inputs.activeCallRef.current = {callId:'live-call'} as never;
  const network = require('@react-native-community/netinfo').default.addEventListener.mock.calls.at(-1)[0];
  (ensureSipRegistration as jest.Mock).mockClear();
  await act(async () => {
    network({type:'wifi',isConnected:true}); network({type:'cellular',isConnected:true});
    await jest.advanceTimersByTimeAsync(1000);
  });
  expect(ensureSipRegistration).not.toHaveBeenCalled();
  expect(require('../../src/features/calling/runtime/sipNative').refreshVocivoSip).toHaveBeenCalled();
});

test('active-call Digest refusal single-flights fresh credentials instead of repeating the rejected password', async () => {
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  inputs.activeCallRef.current = { callId: 'live-call' } as never;
  const { onSipRegistration, refreshVocivoSip } = require('../../src/features/calling/runtime/sipNative');
  const outcome = onSipRegistration.mock.calls.at(-1)[0];
  (ensureSipRegistration as jest.Mock).mockClear();
  await act(async () => {
    outcome('reconnecting', '403 Forbidden');
    outcome('reconnecting', '403 Forbidden');
    await jest.advanceTimersByTimeAsync(3000);
  });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
  expect(ensureSipRegistration).toHaveBeenCalledWith(true);
  expect(refreshVocivoSip).not.toHaveBeenCalled();
  expect(inputs.activeCallRef.current).toEqual({ callId: 'live-call' });
});

test('network recovery retries a failed HTTPS bootstrap and stops after success', async () => {
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  const network = require('@react-native-community/netinfo').default.addEventListener.mock.calls.at(-1)[0];
  (ensureSipRegistration as jest.Mock).mockClear().mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue(3600);
  await act(async () => {
    network({type:'wifi',isConnected:true}); network({type:'cellular',isConnected:true});
    await jest.advanceTimersByTimeAsync(1000);
  });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(2);
  await act(async () => { await jest.advanceTimersByTimeAsync(10000); });
  expect(ensureSipRegistration).toHaveBeenCalledTimes(2);
});


test('confirmed registration clears the stale reconnecting banner without hiding call errors', async () => {
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  const outcome = require('../../src/features/calling/runtime/sipNative').onSipRegistration.mock.calls.at(-1)[0];
  await act(async () => { outcome('ok'); });
  const update = (inputs.setError as jest.Mock).mock.calls.at(-1)[0];
  expect(update('Calling service is reconnecting. Please try again in a moment.')).toBeNull();
  expect(update('Microphone permission denied.')).toBe('Microphone permission denied.');
});
