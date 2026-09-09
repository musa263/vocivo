import type { SipDisposition, SipRegistererState, SipSessionHandle, SipSessionState, SipStack, SipStackConfig, SipStackFactory } from './sipStack';
import type {
  NativeSipBridge,
  SipEventMap,
  SipEventName,
  SipEventSource,
  VoiceCallState,
  VoiceInviteHeader,
} from './voiceEngine';

/**
 * Implements `NativeSipBridge` on top of a SIP stack that speaks to Vocivo's
 * own Kamailio edge.
 *
 * `SipVoiceClient` already knows how to drive the React tree from a
 * `NativeSipBridge` plus an event source; this class is the other half of that
 * contract. Signalling and media never touch a carrier SDK: SIP goes over the
 * app's own WSS port and RTP goes to the app's own RTPEngine.
 *
 * Everything here is deliberately platform-free. The native module is left
 * with only what genuinely cannot live in JavaScript — CallKit, PushKit,
 * ConnectionService and the audio route — which is also the part that has to
 * work before JavaScript is even running.
 */

/** Minimal `NativeEventEmitter`-shaped bus, so the engine can subscribe to us. */
export class SipEventBus implements SipEventSource {
  private readonly listeners = new Map<SipEventName, Set<(payload: never) => void>>();

  addListener<K extends SipEventName>(event: K, listener: (payload: SipEventMap[K]) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (payload: never) => void);
    this.listeners.set(event, set);
    return { remove: () => { set.delete(listener as (payload: never) => void); } };
  }

  emit<K extends SipEventName>(event: K, payload: SipEventMap[K]) {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy first: a listener may unsubscribe itself while we are iterating.
    for (const listener of [...set]) {
      try {
        (listener as (value: SipEventMap[K]) => void)(payload);
      } catch (error) {
        console.warn('Vocivo SIP listener threw', error);
      }
    }
  }
}

/**
 * Maps a SIP.js session state onto the app's vocabulary.
 *
 * `Terminating` deliberately produces nothing: the call is still up until the
 * BYE completes, and emitting a terminal state early would let the lifecycle
 * registry tear the UI down while audio is still flowing.
 */
export function sessionStateToVoiceState(
  state: SipSessionState,
  context: { incoming: boolean; established: boolean; held: boolean; disposition?: SipDisposition },
): VoiceCallState | null {
  switch (state) {
    case 'Initial':
      return context.incoming ? 'RINGING' : 'CONNECTING';
    case 'Establishing':
      // Outgoing: we have sent the INVITE and are waiting on the far end.
      // Incoming: the user has accepted and we are negotiating media.
      return context.incoming ? 'CONNECTING' : 'RINGING';
    case 'Established':
      return context.held ? 'HELD' : 'ACTIVE';
    case 'Terminating':
      return null;
    case 'Terminated':
      return terminalState(context.established, context.disposition);
    default:
      return null;
  }
}

/**
 * A call that never connected only counts as FAILED when the far end actually
 * refused it for a technical reason. Busy, decline and cancel are ordinary
 * outcomes of a phone call and must not surface to the user as an error.
 */
function terminalState(established: boolean, disposition?: SipDisposition): VoiceCallState {
  if (established) return 'ENDED';
  const status = disposition?.statusCode ?? 0;
  if (status === 0) return 'ENDED';
  const expected = status === 408 || status === 480 || status === 486 || status === 487 || status === 600 || status === 603 || status < 400;
  return expected ? 'ENDED' : 'FAILED';
}

type TrackedSession = {
  handle: SipSessionHandle;
  established: boolean;
  held: boolean;
  muted: boolean;
  terminal: boolean;
  mediaUpdates?: Partial<Record<'held' | 'muted', Promise<void>>>;
};

export type SipStackBridgeOptions = {
  createStack: SipStackFactory;
  events: SipEventBus;
};

/** A late credential response must not dispose a call that started meanwhile. */
export class SipRegistrationDeferredError extends Error {
  constructor() {
    super('SIP credential replacement is deferred until current calls end.');
    this.name = 'SipRegistrationDeferredError';
  }
}

export class SipStackBridge implements NativeSipBridge {
  private readonly createStack: SipStackFactory;
  private readonly events: SipEventBus;
  private readonly sessions = new Map<string, TrackedSession>();
  private stack: SipStack | null = null;
  private speaker = false;
  private registrationGeneration = 0;

  constructor(options: SipStackBridgeOptions) {
    this.createStack = options.createStack;
    this.events = options.events;
  }

  async register(config: SipStackConfig) {
    // Check at the mutation boundary, after any caller's asynchronous fetch.
    // Foreground-only checks cannot protect calls arriving during that fetch.
    if ([...this.sessions.values()].some(session => !session.terminal)) {
      throw new SipRegistrationDeferredError();
    }
    const generation = ++this.registrationGeneration;
    // Tear down without announcing a disconnection: re-registering must not
    // flash the UI through "signed out" on its way to "connected".
    await this.teardown();
    const stack = await this.createStack(config);
    if (generation !== this.registrationGeneration) {
      await stack.stop();
      throw new Error('SIP registration was canceled.');
    }
    this.stack = stack;

    stack.onRegistrationChange((state, reason) => {
      if (generation !== this.registrationGeneration) return;
      this.events.emit('registration', { state: registrationState(state), reason });
    });
    stack.onInvitation((handle) => {
      if (generation === this.registrationGeneration) this.adoptIncoming(handle);
      else handle.terminate().catch((error) => console.warn('Stale SIP invitation cleanup failed', describe(error)));
    });

    this.events.emit('registration', { state: 'progress' });
    try {
      await stack.start();
      if (generation !== this.registrationGeneration) {
        await stack.stop();
        throw new Error('SIP registration was canceled.');
      }
    } catch (error) {
      if (this.stack === stack) this.stack = null;
      try { await stack.stop(); }
      catch (cleanupError) { console.warn('Vocivo SIP failed-start cleanup', describe(cleanupError)); }
      if (generation === this.registrationGeneration) this.events.emit('registration', { state: 'failed', reason: describe(error) });
      throw error;
    }
  }

  async unregister() {
    this.registrationGeneration += 1;
    await this.teardown();
    // Flagged as ours: an unregister the app asked for used to reach the UI as
    // a bare disconnection, so signing out ended with "the calling connection
    // was lost" over a sign-out the person had just tapped.
    this.events.emit('registration', { state: 'none', requested: true });
  }

  /**
   * After the app comes to the front or the network changes: get the socket
   * and the registration back if either was lost. Nothing to do when there is
   * no registration wanted.
   */
  async refresh() {
    if (!this.stack) return;
    try {
      await this.stack.refresh();
    } catch (error) {
      console.warn('Vocivo SIP refresh failed', describe(error));
      throw error;
    }
  }

  async updateCredentials(config: SipStackConfig) {
    const stack = this.requireStack();
    if (!stack.updateCredentials) throw new Error('Live SIP credential renewal is unavailable.');
    await stack.updateCredentials(config);
  }

  private async teardown() {
    const stack = this.stack;
    this.stack = null;
    await Promise.all([...this.sessions.keys()].map((id) => this.disposeSession(id, 'ENDED').catch((error) => {
      console.warn('Vocivo SIP call disposal failed', error);
    })));
    if (stack) {
      try {
        await stack.stop();
      } catch (error) {
        console.warn('Vocivo SIP stop failed', describe(error));
      }
    }
  }

  async invite(target: string, headers?: VoiceInviteHeader[]) {
    const stack = this.requireStack();
    const handle = await stack.invite(target, headers ?? []);
    this.track(handle);
    this.events.emit('outgoing', { callId: handle.id, target });
    handle.onProgress?.((statusCode) => {
      const session = this.sessions.get(handle.id);
      if (session && !session.terminal && !session.established) this.events.emit('callProgress', { callId: handle.id, statusCode });
    });
    return handle.id;
  }

  async answer(callId: string) {
    await this.requireSession(callId).handle.accept();
  }

  peerConnection(callId: string) {
    return this.sessions.get(callId)?.handle.peerConnection();
  }

  async restartMedia(callId: string) {
    const session = this.requireSession(callId);
    if (!session.established || !session.handle.restartMedia) throw new Error('SIP media recovery requires an established call.');
    await this.stack?.refresh();
    await session.handle.restartMedia();
  }

  async hangup(callId?: string) {
    if (callId) {
      const session = this.sessions.get(callId);
      if (!session || session.terminal) return;
      this.events.emit('callProgress', { callId, statusCode: 0 });
      await session.handle.terminate();
      return;
    }
    for (const session of [...this.sessions.values()]) {
      if (session.terminal) continue;
      this.events.emit('callProgress', { callId: session.handle.id, statusCode: 0 });
      try {
        await session.handle.terminate();
      } catch (error) {
        console.warn('Vocivo SIP hangup failed', describe(error));
      }
    }
  }

  async emergencyDispose(callId: string) {
    await this.disposeSession(callId, 'FAILED');
  }

  private async disposeSession(callId: string, state: 'ENDED' | 'FAILED') {
    const session = this.sessions.get(callId);
    if (!session || session.terminal) return;
    // Retire the handle before invoking SIP: disposal can synchronously emit
    // events, and no late ACTIVE/HELD update may recreate this call.
    session.terminal = true;
    this.sessions.delete(callId);
    this.releaseSpeakerWhenIdle();
    let disposal: Promise<void>;
    try {
      disposal = session.handle.dispose();
    } finally {
      this.emitState(callId, state);
    }
    await disposal;
  }

  async hold(callId: string, on: boolean) {
    await this.changeMediaControl(callId, 'held', on);
  }

  async mute(callId: string, on: boolean) {
    await this.changeMediaControl(callId, 'muted', on);
  }

  private changeMediaControl(callId: string, control: 'held' | 'muted', on: boolean) {
    const session = this.requireSession(callId);
    const apply = async () => {
      if (session.terminal || session[control] === on) return;
      if (control === 'held') await session.handle.setHold(on);
      else await session.handle.setMuted(on);
      if (session.terminal) return;
      session[control] = on;
      this.events.emit('mediaState', { callId, ...(control === 'held' ? { onHold: on } : { muted: on }) });
      // Re-INVITE does not emit Established again, so publish the hold change.
      if (control === 'held' && session.established) this.emitState(callId, on ? 'HELD' : 'ACTIVE');
    };
    session.mediaUpdates ||= {};
    const previous = session.mediaUpdates[control];
    // Queue conflicting commands; failed commands remain retryable. Duplicate
    // callbacks observe the confirmed value before touching SIP a second time.
    const update = previous ? previous.then(apply, apply) : apply();
    session.mediaUpdates[control] = update;
    return update;
  }

  async sendDtmf(callId: string, digit: string) {
    await this.requireSession(callId).handle.sendDtmf(digit);
  }

  async setSpeaker(on: boolean) {
    this.speaker = on;
    if (this.stack) await this.stack.setSpeaker(on);
    this.events.emit('mediaState', { callId: '', speaker: on });
  }

  /** Exposed for the call UI, which needs to render the current route. */
  get speakerOn() {
    return this.speaker;
  }

  /**
   * The audio route belongs to the call, not to the app.
   *
   * CallKit and Android's telecom stack both configure a fresh session for each
   * call, and neither carries a loudspeaker override into the next one. This
   * flag is what the in-app Speaker button negates and what the call screen
   * draws, so a call that ended on speaker left the following one insisting on
   * a route it did not have: the phone was held away from the ear while the
   * audio came out of the earpiece, and the first tap of Speaker turned the
   * loudspeaker off. Nothing is pushed to the platform here on purpose —
   * Android's `setSpeaker` claims the communication audio mode, which is
   * exactly what the end of a call has just handed back.
   */
  private releaseSpeakerWhenIdle() {
    if (!this.speaker || this.sessions.size > 0) return;
    this.speaker = false;
    this.events.emit('mediaState', { callId: '', speaker: false });
  }

  private adoptIncoming(handle: SipSessionHandle) {
    this.track(handle);
    this.events.emit('incoming', {
      callId: handle.id,
      callerName: handle.remoteDisplayName || undefined,
      callerNumber: handle.remoteUser || undefined,
      sipUsername: handle.remoteTarget || undefined,
      headers: handle.headers,
    });
  }

  private track(handle: SipSessionHandle) {
    const session: TrackedSession = { handle, established: false, held: false, muted: false, terminal: false };
    this.sessions.set(handle.id, session);
    handle.onStateChange((state) => {
      if (session.terminal) return;
      if (state === 'Established') session.established = true;
      const disposition = state === 'Terminated' ? handle.disposition() : undefined;
      const next = sessionStateToVoiceState(state, {
        incoming: handle.incoming,
        established: session.established,
        held: session.held,
        disposition,
      });
      if (state === 'Terminated') {
        session.terminal = true;
        // Keep nothing: the engine holds its own record of finished calls, and
        // a stale handle here would leak a peer connection per call.
        this.sessions.delete(handle.id);
        this.releaseSpeakerWhenIdle();
      }
      if (next) this.emitState(handle.id, next, disposition?.reason, disposition?.statusCode);
    });
  }

  private emitState(callId: string, state: VoiceCallState, cause?: string, statusCode?: number) {
    this.events.emit('callState', { callId, state, cause, ...(statusCode ? { statusCode } : {}) });
  }

  private requireStack() {
    if (!this.stack) throw new Error('Vocivo SIP is not registered.');
    return this.stack;
  }

  private requireSession(callId: string) {
    const session = this.sessions.get(callId);
    if (!session) throw new Error(`Unknown Vocivo SIP call ${callId}.`);
    return session;
  }
}

function registrationState(state: SipRegistererState): SipEventMap['registration']['state'] {
  switch (state) {
    case 'Registered':
      return 'ok';
    case 'Initial':
      return 'progress';
    case 'Reconnecting':
      return 'reconnecting';
    case 'Unregistered':
    case 'Terminated':
      return 'none';
    default:
      return 'none';
  }
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
