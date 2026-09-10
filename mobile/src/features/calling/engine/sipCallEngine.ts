import { VoiceSubject } from './observable';
import {
  isTerminalVoiceCallState,
  toVoiceCallState,
  type NativeSipBridge,
  type SipEventSource,
  type VoiceCall,
  type VoiceCallState,
  type VoiceClient,
  type VoiceConnectionState,
  type VoiceInviteHeader,
} from './voiceEngine';

/**
 * Drives calls on Vocivo's own SIP edge instead of the Telnyx platform.
 *
 * The native module owns the SIP stack and the system call UI (CallKit /
 * ConnectionService); this engine owns the state the React tree sees. It is
 * written against injected dependencies so the whole thing can be exercised in
 * tests with a fake bridge — the native halves cannot be unit-tested, so
 * everything that *can* live in JS does.
 */

class SipCall implements VoiceCall {
  readonly callState$: VoiceSubject<VoiceCallState>;
  readonly isMuted$ = new VoiceSubject<boolean>(false);
  readonly isHeld$ = new VoiceSubject<boolean>(false);

  private connectedAt: number | null = null;
  terminationCode?: number;

  constructor(
    private readonly bridge: NativeSipBridge,
    readonly callId: string,
    readonly isIncoming: boolean,
    readonly callerName: string,
    readonly callerNumber: string,
    readonly destination: string,
    readonly inviteCustomHeaders: VoiceInviteHeader[],
    initialState: VoiceCallState,
    private readonly now: () => number,
  ) {
    this.callState$ = new VoiceSubject<VoiceCallState>(initialState);
  }

  get currentState() {
    return this.callState$.value;
  }

  get peerConnection() {
    return this.bridge.peerConnection?.(this.callId);
  }

  async restartMedia() {
    if (!this.bridge.restartMedia) throw new Error('SIP media recovery is unavailable.');
    await this.bridge.restartMedia(this.callId);
  }

  get currentIsMuted() {
    return this.isMuted$.value;
  }

  get currentIsHeld() {
    return this.isHeld$.value;
  }

  /** Seconds of connected audio. Hold does not stop the clock, matching the SDK. */
  get currentDuration() {
    if (!this.connectedAt) return 0;
    return Math.max(0, Math.floor((this.now() - this.connectedAt) / 1000));
  }

  /** Called by the engine when the native side reports a transition. */
  applyState(state: VoiceCallState) {
    if (isTerminalVoiceCallState(this.currentState)) return; // terminal states never regress
    if (state === 'ACTIVE' && !this.connectedAt) this.connectedAt = this.now();
    this.callState$.next(state);
    if (isTerminalVoiceCallState(state)) {
      this.callState$.complete();
      this.isMuted$.complete();
      this.isHeld$.complete();
    }
  }

  applyMedia(input: { muted?: boolean; onHold?: boolean }) {
    if (typeof input.muted === 'boolean') this.isMuted$.next(input.muted);
    if (typeof input.onHold === 'boolean') this.isHeld$.next(input.onHold);
  }

  async answer() {
    await this.bridge.answer(this.callId);
  }

  async hangup() {
    await this.bridge.hangup(this.callId);
  }

  async emergencyDispose() {
    if (!this.bridge.emergencyDispose) throw new Error('SIP emergency disposal is unavailable.');
    await this.bridge.emergencyDispose(this.callId);
  }

  async hold() {
    await this.bridge.hold(this.callId, true);
    this.isHeld$.next(true);
  }

  async resume() {
    await this.bridge.hold(this.callId, false);
    this.isHeld$.next(false);
  }

  async toggleMute() {
    const next = !this.currentIsMuted;
    await this.bridge.mute(this.callId, next);
    this.isMuted$.next(next);
  }

  async dtmf(digit: string) {
    await this.bridge.sendDtmf(this.callId, digit);
  }
}

export type SipVoiceClientOptions = {
  bridge: NativeSipBridge;
  events: SipEventSource;
  /** Injected for tests; defaults to the wall clock. */
  now?: () => number;
  unregister?: () => Promise<void>;
};

export class SipVoiceClient implements VoiceClient {
  readonly connectionState$ = new VoiceSubject<VoiceConnectionState>('DISCONNECTED');
  readonly calls$ = new VoiceSubject<VoiceCall[]>([]);
  readonly activeCall$ = new VoiceSubject<VoiceCall | null>(null);

  private readonly calls = new Map<string, SipCall>();
  private readonly subscriptions: Array<{ remove: () => void }> = [];
  private readonly bridge: NativeSipBridge;
  private readonly now: () => number;
  private readonly unregister: () => Promise<void>;

  constructor(options: SipVoiceClientOptions) {
    this.bridge = options.bridge;
    this.unregister = options.unregister ?? (() => this.bridge.unregister());
    this.now = options.now ?? (() => Date.now());
    const { events } = options;

    this.subscriptions.push(
      events.addListener('registration', (payload) => {
        const state: VoiceConnectionState =
          payload.state === 'ok' ? 'CONNECTED'
            : payload.state === 'progress' ? 'CONNECTING'
              : payload.state === 'reconnecting' ? 'RECONNECTING'
                : payload.state === 'failed' ? 'ERROR'
                  : 'DISCONNECTED';
        if (payload.state === 'reconnecting' && payload.reason) {
          console.warn('Vocivo SIP transport dropped; reconnecting', payload.reason);
        }
        if (payload.state === 'failed' && payload.reason) {
          console.warn('Vocivo SIP registration failed', payload.reason);
        }
        // A stop we asked for took its calls with it, so let go of them before
        // announcing the disconnection. Publishing the two the other way round
        // showed the UI a live call on a dead engine for long enough to report
        // a deliberate sign-out as a transport failure.
        if (payload.requested) {
          this.calls.clear();
          this.publishCalls();
          this.activeCall$.next(null);
        }
        this.connectionState$.next(state);
      }),
    );

    this.subscriptions.push(
      events.addListener('incoming', (payload) => {
        if (!payload?.callId || this.calls.has(payload.callId)) return;
        const call = new SipCall(
          this.bridge,
          payload.callId,
          true,
          payload.callerName || '',
          payload.callerNumber || '',
          payload.sipUsername || '',
          Array.isArray(payload.headers) ? payload.headers : [],
          'RINGING',
          this.now,
        );
        this.calls.set(call.callId, call);
        this.publishCalls();
        // An incoming call becomes active only when the user answers it; the
        // system call UI is already showing it, so do not steal focus here.
        if (!this.activeCall$.value) this.activeCall$.next(call);
      }),
    );

    this.subscriptions.push(
      events.addListener('callState', (payload) => {
        const call = payload?.callId ? this.calls.get(payload.callId) : undefined;
        if (!call) return;
        const state = toVoiceCallState(payload.state);
        call.terminationCode = payload.statusCode;
        if (!state) {
          // Never leave a call stuck because native sent something unknown.
          console.error('Vocivo SIP sent an unknown call state', payload.state);
          call.applyState('FAILED');
        } else {
          if (state === 'FAILED' && payload.cause) console.warn('Vocivo SIP call failed', payload.cause);
          call.applyState(state);
        }
        if (isTerminalVoiceCallState(call.currentState)) this.forget(call.callId);
        else this.publishCalls();
      }),
    );

    this.subscriptions.push(
      events.addListener('mediaState', (payload) => {
        const call = payload?.callId ? this.calls.get(payload.callId) : undefined;
        call?.applyMedia(payload);
      }),
    );
  }

  get currentConnectionState() {
    return this.connectionState$.value;
  }

  get currentCalls() {
    return this.calls$.value;
  }

  get currentActiveCall() {
    return this.activeCall$.value;
  }

  private publishCalls() {
    this.calls$.next([...this.calls.values()]);
  }

  private forget(callId: string) {
    const call = this.calls.get(callId);
    this.calls.delete(callId);
    this.publishCalls();
    if (this.activeCall$.value?.callId === callId) {
      // Promote whatever is left so the UI never points at a dead call.
      const next = [...this.calls.values()].find((item) => !isTerminalVoiceCallState(item.currentState)) ?? null;
      this.activeCall$.next(next);
    }
    return call;
  }

  async newCall(destination: string, callerName: string, callerNumber: string | undefined, headers: VoiceInviteHeader[]) {
    const callId = await this.bridge.invite(destination, headers);
    if (!callId) throw new Error('The Vocivo SIP module did not return a call id.');
    const existing = this.calls.get(callId);
    if (existing) return existing;
    const call = new SipCall(
      this.bridge,
      callId,
      false,
      callerName || '',
      callerNumber || '',
      destination,
      headers,
      'CONNECTING',
      this.now,
    );
    this.calls.set(callId, call);
    this.publishCalls();
    this.activeCall$.next(call);
    return call;
  }

  getCall(callId: string) {
    return this.calls.get(callId);
  }

  setActiveCall(callId: string) {
    const call = this.calls.get(callId);
    if (call) this.activeCall$.next(call);
  }

  async logout() {
    await Promise.allSettled([...this.calls.keys()].map((callId) => this.bridge.hangup(callId)));
    this.calls.clear();
    this.publishCalls();
    this.activeCall$.next(null);
    try { await this.unregister(); }
    finally { this.connectionState$.next('DISCONNECTED'); }
  }

  /** Removes native listeners. Call when the provider unmounts. */
  dispose() {
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.subscriptions.length = 0;
    this.connectionState$.complete();
    this.calls$.complete();
    this.activeCall$.complete();
  }
}
