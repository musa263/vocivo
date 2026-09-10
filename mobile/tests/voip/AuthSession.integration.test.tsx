import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * The account session, from the app's point of view: what leaves this device
 * when someone signs out, and what Recents shows once the server's own record
 * of the same calls arrives.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockStored.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { mockStored.set(key, value); }),
    multiRemove: jest.fn(async () => undefined),
  },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-unlock-device-only',
}));
jest.mock('../../src/shared/api', () => ({
  api: {
    get: jest.fn(), post: jest.fn(), put: jest.fn(),
    delete: jest.fn(async () => { mockOrder.push('delete device'); return {}; }),
    getSessionToken: jest.fn(async () => 'signed-session'),
    saveSessionToken: jest.fn(async () => undefined),
    clearSessionToken: jest.fn(async () => { mockOrder.push('clear token'); }),
  },
}));
jest.mock('../../src/features/calling/runtime/sipNative', () => ({
  unregisterVocivoSip: jest.fn(async () => { mockOrder.push('revoke SIP credentials'); }),
}));

const mockStored = new Map<string, string>();
const mockOrder: string[] = [];

import { Text } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { api } from '../../src/shared/api';
import { unregisterVocivoSip } from '../../src/features/calling/runtime/sipNative';
import { AuthProvider, useAuth } from '../../src/features/auth/AuthContext';

const profile = { id: 'employee-1', email: 'alex@example.test', full_name: 'Alex Morgan', currency: 'USD', extension: '2000' };
let auth: ReturnType<typeof useAuth> | undefined;
function Probe() { auth = useAuth(); return null; }

async function mount() {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<AuthProvider><Probe /></AuthProvider>); });
  return tree;
}

beforeEach(() => {
  // The provider schedules a background history refresh five seconds out; on
  // the wall clock that outlives the test and holds the runner open.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  jest.clearAllMocks();
  mockStored.clear();
  mockOrder.length = 0;
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(null);
  (api.getSessionToken as jest.Mock).mockResolvedValue('signed-session');
  (api.get as jest.Mock).mockImplementation(async (path: string) => {
    if (path === '/api/auth/session') return { profile };
    if (path === '/api/mobile/bootstrap') return { profile, account: { balance: 5, currency: 'USD', rates: [] }, numbers: [], directory: [], calls: [] };
    if (path === '/api/voice/history') return { calls: [] };
    throw new Error(`Unexpected endpoint: ${path}`);
  });
});

afterEach(() => { jest.useRealTimers(); });

test('sign-out revokes this device before the session token that authorizes it is cleared', async () => {
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('device-installation-1');
  const tree = await mount();
  try {
    await act(async () => { await auth!.signOut(); });
    expect(api.delete).toHaveBeenCalledWith('/api/voice/devices?deviceId=device-installation-1');
    expect(unregisterVocivoSip).toHaveBeenCalled();
    // Both revocations need the bearer token, so both have to happen first.
    expect(mockOrder).toEqual(['revoke SIP credentials', 'delete device', 'clear token']);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('vocivo.secure.voice-device.v1');
  } finally {
    await act(async () => tree.unmount());
  }
});

test('a device this handset never registered is not deleted, and sign-out still completes', async () => {
  const tree = await mount();
  try {
    await act(async () => { await auth!.signOut(); });
    expect(api.delete).not.toHaveBeenCalled();
    expect(mockOrder).toEqual(['revoke SIP credentials', 'clear token']);
    expect(auth!.isAuthenticated).toBe(false);
  } finally {
    await act(async () => tree.unmount());
  }
});

test('a locally logged call is not shown twice once the server sends its own row back', async () => {
  const startedAt = new Date('2026-08-25T10:00:00.000Z').toISOString();
  mockStored.set('vocivo.history.v3.employee-1', JSON.stringify([{
    // Written by the app before it knew to record a direction.
    id: 'local-call', destination_number: '+2348012345678', duration_seconds: 42,
    total_cost: 0.42, status: 'completed', started_at: startedAt,
  }]));
  (api.get as jest.Mock).mockImplementation(async (path: string) => {
    if (path === '/api/auth/session') return { profile };
    if (path === '/api/mobile/bootstrap') {
      return {
        profile, account: { balance: 5, currency: 'USD', rates: [] }, numbers: [], directory: [],
        calls: [{
          id: 'server-call', destination_number: '+234 801 234 5678', duration_seconds: 42,
          total_cost: 0.42, status: 'completed', started_at: new Date('2026-08-25T10:00:12.000Z').toISOString(),
          direction: 'outgoing',
        }],
      };
    }
    if (path === '/api/voice/history') return { calls: [] };
    throw new Error(`Unexpected endpoint: ${path}`);
  });
  const tree = await mount();
  try {
    expect(auth!.history).toHaveLength(1);
  } finally {
    await act(async () => tree.unmount());
  }
});

test('a native calling bridge that refuses is a dismissible banner, not the end of the app', async () => {
  // There is no `VocivoSip` module under test, so the native sign-in state
  // cannot be synchronized — the failure this used to throw from render, where
  // the launch boundary's "Try again" only re-rendered it into the same throw.
  const tree = await mount();
  try {
    expect(auth).toBeDefined();
    const buttons = (label: string) => tree.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function');
    expect(buttons('Retry calling setup').length).toBeGreaterThan(0);
    expect(tree.root.findAllByType(Text).some((node) => String(node.props.children).includes('Vocivo build'))).toBe(true);
    await act(async () => { buttons('Dismiss calling setup warning')[0]!.props.onPress(); });
    expect(buttons('Retry calling setup')).toHaveLength(0);
  } finally {
    await act(async () => tree.unmount());
  }
});
