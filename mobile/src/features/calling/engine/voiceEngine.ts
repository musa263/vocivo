import type { VoiceObservable } from './observable';

/**
 * Engine-neutral vocabulary for a call.
 *
 * These are deliberately the same strings as `TelnyxCallState` and
 * `TelnyxConnectionState`, which are string enums whose values equal their
 * names. That means an engine built on Vocivo's own SIP edge can drive the
 * existing `VoiceContext`, `callState.ts` and `CallLifecycleRegistry` without
 * translating at every boundary — and without the app depending on the Telnyx
 * SDK for its own vocabulary.
 */
export type VoiceCallState = 'CONNECTING' | 'RINGING' | 'ACTIVE' | 'HELD' | 'ENDED' | 'FAILED' | 'DROPPED';

export type VoiceConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'ERROR';

export type VoiceInviteHeader = { name: string; value: string };

/**
 * The surface `VoiceContext` uses on a call. Kept to exactly what the app
 * touches, so an engine cannot be "nearly" compatible.
 */
export type VoiceCall = {
  readonly callId: string;
  readonly isIncoming: boolean;
  readonly callerName: string;
  readonly callerNumber: string;
  readonly destination: string;
  readonly inviteCustomHeaders: VoiceInviteHeader[];

  readonly currentState: VoiceCallState;
  readonly currentIsMuted: boolean;
  readonly currentIsHeld: boolean;
  readonly currentDuration: number;
  readonly terminationCode?: number;

  /**
   * The call's peer connection, when the engine has one to offer.
   *
   * `voiceRecovery` uses it to notice ICE failure and restart media, which is
   * what keeps a call alive when a phone moves from wifi to cellular — the
   * normal case for this app, not an edge case.
   */
  readonly peerConnection?: unknown;
  restartMedia?(): Promise<void>;
  /** Irrecoverable transport loss: force local cleanup even if signaling fails. */
  emergencyDispose?(): Promise<void>;

  readonly callState$: VoiceObservable<VoiceCallState>;
  readonly isMuted$: VoiceObservable<boolean>;
  readonly isHeld$: VoiceObservable<boolean>;

  answer(): Promise<void>;
  hangup(): Promise<void>;
  hold(): Promise<void>;
  resume(): Promise<void>;
  toggleMute(): Promise<void>;
  dtmf(digit: string): Promise<void>;
};

export type VoiceClient = {
  readonly connectionState$: VoiceObservable<VoiceConnectionState>;
  readonly calls$: VoiceObservable<VoiceCall[]>;
  readonly activeCall$: VoiceObservable<VoiceCall | null>;

  readonly currentConnectionState: VoiceConnectionState;
  readonly currentCalls: VoiceCall[];
  readonly currentActiveCall: VoiceCall | null;

  newCall(destination: string, callerName: string, callerNumber: string | undefined, headers: VoiceInviteHeader[]): Promise<VoiceCall>;
  getCall(callId: string): VoiceCall | undefined;
  setActiveCall(callId: string): void;
  logout(): Promise<void>;
};

/**
 * What the native `VocivoSip` module must implement. Everything is a promise so
 * the JS side never assumes a synchronous native bridge, and the engine below
 * can be tested against a fake.
 */
export type NativeSipBridge = {
  register(config: { username: string; password: string; domain: string; wsUri?: string; displayName?: string }): Promise<void>;
  unregister(): Promise<void>;
  invite(target: string, headers?: VoiceInviteHeader[]): Promise<string>;
  answer(callId: string): Promise<void>;
  hangup(callId?: string): Promise<void>;
  emergencyDispose?(callId: string): Promise<void>;
  hold(callId: string, on: boolean): Promise<void>;
  mute(callId: string, on: boolean): Promise<void>;
  sendDtmf(callId: string, digit: string): Promise<void>;
  setSpeaker(on: boolean): Promise<void>;
  peerConnection?(callId: string): unknown;
  restartMedia?(callId: string): Promise<void>;
  /**
   * iOS only, and the single most important call in the integration: PushKit
   * terminates an app that receives a VoIP push and does not report an incoming
   * call before returning from the delegate.
   */
  reportPushCall?(input: { callId: string; callerName?: string; callerNumber?: string }): Promise<void>;
};

/** Events the native module emits through `NativeEventEmitter`. */
/**
 * `requested` marks a stop this app asked for — a sign-out, a disposal — as
 * opposed to one the registrar or the network imposed. The two are the same
 * state on the wire and very different to the person holding the phone.
 */
export type SipRegistrationEvent = { state: 'none' | 'progress' | 'ok' | 'failed' | 'reconnecting'; reason?: string; requested?: boolean };
export type SipIncomingEvent = {
  callId: string;
  callerName?: string;
  callerNumber?: string;
  sipUsername?: string;
  headers?: VoiceInviteHeader[];
};
export type SipCallStateEvent = { callId: string; state: VoiceCallState; cause?: string; statusCode?: number };
export type SipMediaStateEvent = { callId: string; muted?: boolean; onHold?: boolean; speaker?: boolean };

export type SipEventName = 'registration' | 'incoming' | 'outgoing' | 'callState' | 'mediaState' | 'callProgress';
/** A call this phone placed: the system call screen has to be told about these too. */
export type SipOutgoingEvent = { callId: string; target: string };

export type SipEventMap = {
  registration: SipRegistrationEvent;
  incoming: SipIncomingEvent;
  outgoing: SipOutgoingEvent;
  callState: SipCallStateEvent;
  callProgress: { callId: string; statusCode: number };
  mediaState: SipMediaStateEvent;
};

/** Minimal shape of `NativeEventEmitter`, so the engine can be tested without React Native. */
export type SipEventSource = {
  addListener<K extends SipEventName>(event: K, listener: (payload: SipEventMap[K]) => void): { remove: () => void };
};

/**
 * Named constants for the two vocabularies.
 *
 * The app used the carrier SDK's enums for these, which meant every file that
 * reasoned about a call state imported the carrier SDK — including files that
 * now run against Vocivo's own edge and never touch it. The values are
 * unchanged, so this is a change of dependency, not of behaviour.
 */
export const CallState = {
  CONNECTING: 'CONNECTING',
  RINGING: 'RINGING',
  ACTIVE: 'ACTIVE',
  HELD: 'HELD',
  ENDED: 'ENDED',
  FAILED: 'FAILED',
  DROPPED: 'DROPPED',
} as const satisfies Record<string, VoiceCallState>;

export const ConnectionState = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  ERROR: 'ERROR',
} as const satisfies Record<string, VoiceConnectionState>;

const callStates: VoiceCallState[] = ['CONNECTING', 'RINGING', 'ACTIVE', 'HELD', 'ENDED', 'FAILED', 'DROPPED'];

/**
 * Native code is the least trustworthy input in the app: a typo in a Swift or
 * Kotlin string would otherwise drive the lifecycle registry into a state it
 * cannot leave. Unknown states are treated as a failure, never silently kept.
 */
export function toVoiceCallState(value: unknown): VoiceCallState | null {
  return typeof value === 'string' && (callStates as string[]).includes(value) ? (value as VoiceCallState) : null;
}

export function isTerminalVoiceCallState(state: VoiceCallState) {
  return state === 'ENDED' || state === 'FAILED';
}
