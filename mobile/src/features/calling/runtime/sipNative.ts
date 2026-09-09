import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { api } from '../../../shared/api';
import type { SipStackConfig } from '../engine/sipStack';
import { bindCallUi, type CallUiEventSource, type NativeCallUi } from '../engine/callUi';
import { SipEventBus, SipStackBridge, SipRegistrationDeferredError } from '../engine/sipBridge';
import { SipVoiceClient } from '../engine/sipCallEngine';

/**
 * The React Native binding for Vocivo's own voice stack.
 *
 * This file is the only place that touches `NativeModules`. SIP signalling and
 * media live in JavaScript (`../voice/sipStackSipJs`) and talk to Vocivo's own
 * Kamailio and RTPEngine; the native `VocivoSip` module supplies only the
 * system call UI and the VoIP-push wake-up, which cannot be done from JS.
 */

export type VocivoSipModule = NativeCallUi;

export function vocivoSipModule(): VocivoSipModule | null {
  const native = NativeModules.VocivoSip as VocivoSipModule | undefined;
  return native || null;
}

function requireModule(): VocivoSipModule {
  const native = vocivoSipModule();
  if (!native) {
    throw new Error(Platform.OS === 'ios'
      ? 'Vocivo CallKit is not linked in this build. Telnyx remains the voice client.'
      : 'Vocivo call handling is not available on this platform.');
  }
  return native;
}

let bus: SipEventBus | null = null;
let bridge: SipStackBridge | null = null;
let client: SipVoiceClient | null = null;
let binding: { remove: () => void } | null = null;
let registrationRequest: Promise<number> | null = null;
let registrationOperation: { renewed: boolean } | null = null;
let queuedRenewal: Promise<number> | null = null;
let registeredConfig: SipStackConfig | null = null;
let registrationEpoch = 0;
const pushTokenListeners = new Set<(token: string) => void>();
let issuedPushToken: string | null = null;
const sipSessionKey = 'vocivo.secure.sip-session.v1';
const sipDeviceKey = 'vocivo.secure.sip-device.v1';
type CachedSipSession = { sessionToken: string; config: SipStackConfig; expiresAt: number; deviceId: string; credentialId: string };

async function revokeCredential(credential: Pick<CachedSipSession, 'deviceId' | 'credentialId'>) {
  if (!credential.deviceId || !credential.credentialId) return;
  await api.delete(`/api/voice/sip-credentials?deviceId=${encodeURIComponent(credential.deviceId)}&credentialId=${encodeURIComponent(credential.credentialId)}`);
}

/** Shared by foreground registration and a native killed-state wake. */
export function ensureSipRegistration(forceRenew = false): Promise<number> {
  if (registrationRequest) {
    if (!forceRenew || registrationOperation?.renewed) return registrationRequest;
    if (queuedRenewal) return queuedRenewal;
    const operation = registrationOperation;
    const epoch = registrationEpoch;
    queuedRenewal = registrationRequest.then(lifetime => {
      if (epoch !== registrationEpoch) throw new Error('Calling session changed.');
      return operation?.renewed ? lifetime : ensureSipRegistration(true);
    }).finally(() => { queuedRenewal = null; });
    return queuedRenewal;
  }
  const epoch = registrationEpoch;
  const operation = { renewed: false };
  registrationOperation = operation;
  registrationRequest = (async () => {
    const [sessionToken, raw] = await Promise.all([
      api.getSessionToken(),
      SecureStore.getItemAsync(sipSessionKey),
    ]);
    if (!sessionToken) throw new Error('Sign in before receiving calls.');
    let cached: CachedSipSession | null = null;
    try { cached = raw ? JSON.parse(raw) : null; }
    catch { console.warn('[Vocivo SIP] Ignoring invalid secure session cache'); }
    // Older releases cached a seven-day SIP password with a one-hour TURN grant.
    // Honor the embedded coturn REST deadline even for those existing caches.
    if (cached && Number.isFinite(cached.expiresAt)) {
      for (const server of cached.config?.iceServers || []) {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        if (urls.some(url => /^turns?:/i.test(url)) && /^\d+:/.test(server.username || '')) {
          cached.expiresAt = Math.min(cached.expiresAt, Number(server.username!.split(':')[0]) * 1000);
        }
      }
    }
    if (forceRenew || cached?.sessionToken !== sessionToken || !cached?.deviceId || !cached?.credentialId || !cached?.config?.password || !Number.isFinite(cached?.expiresAt) || Date.now() >= cached!.expiresAt - 30_000) cached = null;
    if (!cached) {
      const deviceId = await SecureStore.getItemAsync(sipDeviceKey);
      operation.renewed = true;
      const sip = await api.post<{ username: string; password: string; domain: string; wsUri: string; expires_in: number; deviceId: string; credentialId: string; ice_servers?: SipStackConfig['iceServers'] }>('/api/voice/sip-credentials', { client: Platform.OS, ...(deviceId ? { deviceId } : {}) });
      if (!sip.username || !sip.password || !sip.wsUri || !sip.deviceId || !sip.credentialId || !(sip.expires_in > 0)) throw new Error('Incomplete SIP credentials.');
      if (epoch !== registrationEpoch || await api.getSessionToken() !== sessionToken) {
        await revokeCredential(sip);
        throw new Error('Calling session changed.');
      }
      await SecureStore.setItemAsync(sipDeviceKey, sip.deviceId, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
      cached = { sessionToken, deviceId: sip.deviceId, credentialId: sip.credentialId, expiresAt: Date.now() + sip.expires_in * 1000, config: {
        username: sip.username, password: sip.password, domain: sip.domain, wsUri: sip.wsUri, iceServers: sip.ice_servers,
      } };
    }
    if (epoch !== registrationEpoch || await api.getSessionToken() !== sessionToken) throw new Error('Calling session changed.');
    await SecureStore.setItemAsync(sipSessionKey, JSON.stringify(cached), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
    if (epoch !== registrationEpoch) {
      await SecureStore.deleteItemAsync(sipSessionKey);
      throw new Error('Calling session changed.');
    }
    const applied = await registerVocivoSip(cached.config);
    if (epoch !== registrationEpoch) throw new Error('Calling session changed.');
    const lifetime = Math.max(0, (cached.expiresAt - Date.now()) / 1000);
    // Keep the issued generation cached, but retry its application soon once
    // calls end instead of treating its full lifetime as already installed.
    return applied ? lifetime : Math.min(30, lifetime);
  })().finally(() => { registrationRequest = null; });
  return registrationRequest;
}

function ensureBridge() {
  if (bridge && bus) return { bridge, bus };
  const native = vocivoSipModule();
  const events = new SipEventBus();
  const created = new SipStackBridge({
    events,
    createStack: async (config) => {
      // Imported here rather than at the top of the file: this pulls in SIP.js
      // and react-native-webrtc, and a build still running on the carrier edge
      // should never load them — react-native-webrtc cannot even be imported
      // where the native module is absent.
      const { createSipJsStack } = await import('../engine/sipStackSipJs');
      return createSipJsStack(config, {
        // Routing to the loudspeaker is an audio-session change, so it stays
        // with the platform module even though the rest of this is JavaScript.
        setSpeaker: native ? (on: boolean) => native.setSpeaker(on) : undefined,
      });
    },
  });
  bus = events;
  bridge = created;
  return { bridge: created, bus: events };
}

/**
 * Says when PushKit has issued or rotated this device's VoIP token.
 *
 * The token is minted by the OS at its own pace, and there is no asking for it
 * again — so the only alternatives are being told, or polling until it appears.
 * A late subscriber is given the token already in hand.
 */
export function onVocivoPushToken(listener: (token: string) => void) {
  pushTokenListeners.add(listener);
  if (issuedPushToken) listener(issuedPushToken);
  return { remove: () => { pushTokenListeners.delete(listener); } };
}

/** Final registration outcomes, including rejection codes, for credential recovery. */
export function onSipRegistration(listener: (state: string, reason?: string) => void) {
  return ensureBridge().bus.addListener('registration', payload => listener(payload.state, payload.reason));
}

export async function registerVocivoSip(config: {
  username: string;
  password: string;
  domain: string;
  wsUri?: string;
  displayName?: string;
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
}) {
  if (registeredConfig && registeredConfig.username === config.username && registeredConfig.domain === config.domain && registeredConfig.wsUri === config.wsUri) {
    // PushKit may already be ringing before the INVITE is tracked. Replacing
    // an apparently idle stack here can invalidate the contact being called.
    // Update auth and future-call ICE on the existing UA even while idle.
    await ensureBridge().bridge.updateCredentials(config);
    registeredConfig = config;
    return true;
  }
  const sipBridge = ensureBridge().bridge;
  try {
    await sipBridge.register(config);
  } catch (error) {
    if (!(error instanceof SipRegistrationDeferredError)) throw error;
    // The server has replaced this device's password already. Renew auth on
    // the existing engine, retaining its dialog/media until full replacement
    // (including any new ICE settings) is safe after the call ends.
    await sipBridge.updateCredentials(config);
    return false;
  }
  registeredConfig = config;
  return true;
}

export async function unregisterVocivoSip() {
  registrationEpoch += 1;
  registeredConfig = null;
  // Invalidate first, then drain a boot already in flight before the final stop.
  const pending = registrationRequest;
  if (bridge) await bridge.unregister();
  if (pending) await pending.catch((error) => console.warn('[Vocivo SIP] Canceled registration', error));
  if (bridge) await bridge.unregister();
  registeredConfig = null;
  const raw = await SecureStore.getItemAsync(sipSessionKey);
  let cached: CachedSipSession | null = null;
  try { cached = raw ? JSON.parse(raw) : null; }
  catch (error) { console.warn('[Vocivo SIP] Invalid secure session during sign-out', error); }
  if (cached && cached.sessionToken === await api.getSessionToken()) await revokeCredential(cached);
  await SecureStore.deleteItemAsync(sipSessionKey);
}

/** Reconnects and re-registers if the app was away or the network moved. */
export async function refreshVocivoSip() {
  if (!bridge) return;
  await bridge.refresh();
}

/**
 * After a VoIP push: get registered again, quickly, trying a few times —
 * the radio may still be coming up when the first attempt is made.
 */
async function wakeRegistration() {
  const epoch = registrationEpoch;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (epoch !== registrationEpoch) throw new Error('Calling session changed.');
    try {
      await ensureSipRegistration();
      return;
    } catch (error) {
      console.warn('Vocivo SIP: re-registration after push failed', error instanceof Error ? error.message : error);
      if (attempt === 3 || epoch !== registrationEpoch) throw error;
      await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
}

export async function inviteVocivoSip(target: string, headers?: Array<{ name: string; value: string }>) {
  return ensureBridge().bridge.invite(target, headers);
}

export async function hangupVocivoSip(callId?: string) {
  if (!bridge) return;
  await bridge.hangup(callId);
}

export async function setVocivoSipSpeaker(on: boolean) {
  await ensureBridge().bridge.setSpeaker(on);
  // Keep the system call screen's own speaker button in step when it is there.
  await vocivoSipModule()?.setSpeaker(on).catch(() => undefined);
}

/**
 * Flips the audio route and reports where it ended up.
 *
 * The bridge is the one that knows the current route, because the native
 * module's own speaker state is only meaningful while a call is up.
 */
export async function toggleVocivoSipSpeaker() {
  const next = !ensureBridge().bridge.speakerOn;
  await setVocivoSipSpeaker(next);
  return next;
}

/** Takes a call off the system call screen when the engine no longer can. */
export async function endVocivoSipCallUi(callId: string) {
  await vocivoSipModule()?.reportCallEnded({ callId, reason: 'ended' });
}

/** True when this build can show a native incoming-call screen. */
export async function callUiAvailable() {
  const native = vocivoSipModule();
  if (!native) return false;
  return native.isCallUiAvailable().catch(() => false);
}

/**
 * Builds the voice client that replaces the Telnyx one when the edge is `sip`.
 *
 * Returns a client whether or not the native module is linked: the SIP stack
 * itself is pure JavaScript, so calls work in the foreground on any build. What
 * the native module adds is the OS call screen and the ability to ring a phone
 * whose app has been killed.
 */
export function createSipVoiceClient(): SipVoiceClient {
  if (client) return client;
  const { bridge: sipBridge, bus: events } = ensureBridge();
  client = new SipVoiceClient({ bridge: sipBridge, events, unregister: unregisterVocivoSip });
  const native = vocivoSipModule();
  if (native) {
    binding?.remove();
    binding = bindCallUi({
      events,
      bridge: sipBridge,
      native,
      ui: new NativeEventEmitter(NativeModules.VocivoSip) as unknown as CallUiEventSource,
      onPushToken: (token: string) => {
        issuedPushToken = token;
        pushTokenListeners.forEach(listener => listener(token));
      },
      onPushWake: async () => {
        // The native signed-in gate already ran; the API/cache is still bound
        // to this device's current authenticated session, never to push fields.
        const { voice } = await import('../engine/voiceClientFacade');
        const { sipEngine } = await import('../engine/engines');
        const engine = sipEngine();
        voice.use(engine.name, engine.client, engine.platform);
        await wakeRegistration();
      },
    });
  }
  return client;
}

/** Drops the client and its listeners. Used on sign-out and in tests. */
export function disposeSipVoiceClient() {
  registrationEpoch += 1;
  registeredConfig = null;
  binding?.remove();
  binding = null;
  client?.dispose();
  bridge?.unregister().catch((error) => console.warn('[Vocivo SIP] Disposed client cleanup failed', error));
  client = null;
  bridge = null;
  bus = null;
}

export { requireModule as requireVocivoSipModule };
