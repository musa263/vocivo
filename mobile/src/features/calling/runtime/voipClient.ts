import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { VoicePnBridge, setNativeVoiceSignedIn } from './nativeVoiceBridge';
import { existingManagedVoiceClient, getManagedVoiceClient } from './managedVoiceRuntime';
import { api } from '../../../shared/api';
import { Platform } from 'react-native';

export { VoicePnBridge };

// Keep the existing adapter surface while deferring all client construction.
export const voipClient = new Proxy({} as ReturnType<typeof getManagedVoiceClient>, {
  get(_target, property) {
    const client = getManagedVoiceClient();
    const value = Reflect.get(client, property, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

const secureVoiceSessionKey = 'vocivo.secure.voice-session.v1';
const secureVoiceDeviceKey = 'vocivo.secure.voice-device.v1';

/** What `/api/voice/devices` answers a registration with. */
export type VoiceDeviceRegistration = { device?: { id?: string } };

/**
 * The id the server gave this installation's push registration.
 *
 * Sending it back on every registration is what keeps one handset to one row.
 * Without it the server minted a new id each time and sign-out had nothing to
 * delete: the previous account's phone went on being pushed, and iOS reported
 * then ended the call, writing a missed call into the Recents of an account
 * that had signed out.
 */
export async function voicePushDeviceId() {
  try {
    return await SecureStore.getItemAsync(secureVoiceDeviceKey);
  } catch (failure) {
    console.warn('[Vocivo Voice] stored push device id is unreadable', failure);
    return null;
  }
}

export async function rememberVoicePushDeviceId(deviceId?: string) {
  if (!deviceId) return;
  await SecureStore.setItemAsync(secureVoiceDeviceKey, deviceId, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

/** Stops this device being pushed for the account that is signing out. */
export async function deleteVoiceDevice() {
  const deviceId = await voicePushDeviceId();
  if (!deviceId) return;
  await api.delete(`/api/voice/devices?deviceId=${encodeURIComponent(deviceId)}`);
  await SecureStore.deleteItemAsync(secureVoiceDeviceKey);
}

export async function getVoicePushToken() {
  if (Platform.OS === 'ios') return (await VoicePnBridge.getVoipToken())?.trim() || undefined;
  return (await VoicePnBridge.getFirebaseToken())?.trim() || undefined;
}

export async function persistVoiceSession(session: {
  token: string;
  expiresAt?: number;
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
}) {
  await SecureStore.setItemAsync(secureVoiceSessionKey, JSON.stringify({
    token: session.token,
    expiresAt: session.expiresAt || 0,
    iceServers: session.iceServers || [],
  }), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
  // Remove legacy plaintext copies immediately after successful migration.
  await AsyncStorage.multiRemove(['@credential_token', '@credential_token_expires_at', '@ice_servers']);
}

export async function loadVoiceSession() {
  try {
    const raw = await SecureStore.getItemAsync(secureVoiceSessionKey);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { token?: string; expiresAt?: number; iceServers?: unknown };
    const token = stored.token?.trim();
    const expiresAt = Number(stored.expiresAt || 0);
    if (!token || !Number.isFinite(expiresAt)) return null;
    const parsed = stored.iceServers;
    return {
      token,
      expiresAt,
      iceServers: Array.isArray(parsed) && parsed.length ? parsed : undefined,
    };
  } catch (failure) {
    const normalized = failure instanceof Error ? failure : new Error(String(failure));
    console.error('[Vocivo Voice] stored ICE configuration is invalid', { message: normalized.message, stack: normalized.stack });
    return null;
  }
}

const telnyxStorageKeys = [
  '@telnyx_username',
  '@telnyx_password',
  '@credential_token',
  '@credential_token_expires_at',
  '@push_token',
  '@push_when_active',
  '@use_trickle_ice',
  '@ice_servers',
  '@enable_missed_call_notifications',
];

export async function signOutVoiceDevice() {
  // Every cleanup step must run even when an earlier one fails, otherwise a
  // single native or storage error would leave credentials and registrations behind.
  const steps: Array<[string, () => Promise<unknown>]> = [
    // First, while the session token still authenticates it: everything below
    // only affects this handset, but a push registration left on the server
    // keeps ringing a phone whose owner has signed out.
    ['delete this device push registration', () => deleteVoiceDevice()],
    ['disable native voice sign-in flag', () => setVoiceSignedIn(false)],
    ['unregister push notifications', async () => {
      const client = existingManagedVoiceClient();
      if (!client) return;
      client.disablePushNotifications();
      // Let the SDK send the unregister command before closing its socket.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }],
    ['clear voice storage', () => AsyncStorage.multiRemove(telnyxStorageKeys)],
    ['delete stored voice session', () => SecureStore.deleteItemAsync(secureVoiceSessionKey)],
    ['clear managed native actions', async () => { if (existingManagedVoiceClient()) await VoicePnBridge.clearManagedSession(); }],
    ['log out of the voice client', async () => { await existingManagedVoiceClient()?.logout(); }],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (failure) {
      const normalized = failure instanceof Error ? failure : new Error(String(failure));
      console.warn(`[Vocivo Voice] sign-out step failed: ${step}`, { message: normalized.message, stack: normalized.stack });
    }
  }
}

export async function setVoiceSignedIn(signedIn: boolean) {
  await AsyncStorage.setItem('@vocivo_voice_signed_in', signedIn ? '1' : '0');
  const updated = await setNativeVoiceSignedIn(signedIn);
  if (updated !== true) throw new Error('The native voice authentication bridge rejected the state change.');
}
