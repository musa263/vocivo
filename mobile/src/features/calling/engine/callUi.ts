import type { SipEventBus } from './sipBridge';
import type { NativeSipBridge, SipEventSource, VoiceCallState } from './voiceEngine';
import { reportSipAnswerFailure, type SipAnswerFailure } from './sipCallDiagnostics';

/**
 * The system call UI — CallKit on iOS, ConnectionService on Android.
 *
 * This is all the native `VocivoSip` module does now. SIP itself runs in
 * JavaScript against Vocivo's own edge; native code exists for the two things
 * JavaScript cannot do: draw the incoming-call screen the operating system
 * owns, and be alive before JavaScript is, when a VoIP push arrives at a phone
 * whose app has been killed.
 */
export type NativeCallUi = {
  /**
   * Tell the OS a call is ringing. On iOS this MUST also have happened inside
   * the PushKit delegate before it returned, or iOS kills the app; the module
   * does that itself and replays the event here once JavaScript is running.
   */
  reportIncomingCall(input: { callId: string; callerName?: string; callerNumber?: string }): Promise<void>;
  reportOutgoingCall(input: { callId: string; handle: string }): Promise<void>;
  reportCallConnected(callId: string): Promise<void>;
  /** `reason` is one of the SIP-ish endings the UI can explain: ended, failed, declined, unanswered. */
  reportCallEnded(input: { callId: string; reason: 'ended' | 'failed' | 'declined' | 'unanswered' }): Promise<void>;
  reportMuted(input: { callId: string; muted: boolean }): Promise<void>;
  reportHeld(input: { callId: string; held: boolean }): Promise<void>;
  setSpeaker(on: boolean): Promise<void>;
  setRingback?(input: { callId: string; enabled: boolean }): Promise<void>;
  /** Whether this build has PushKit/ConnectionService wired at all. */
  isCallUiAvailable(): Promise<boolean>;
  completeAnswer?(input: { callId: string; success: boolean }): Promise<void>;
  startCallUiEvents?(): Promise<void>;
  stopCallUiEvents?(): Promise<void>;
};

/** What the user did on the system call screen, rather than in the app. */
export type CallUiEventMap = {
  callUiAnswer: { callId: string };
  callUiEnd: { callId: string };
  callUiMute: { callId: string; muted: boolean };
  callUiHold: { callId: string; held: boolean };
  callUiDtmf: { callId: string; digit: string };
  /**
   * A VoIP push arrived and the module has already put a call on screen. The
   * SIP stack has to get registered fast enough to receive the INVITE the
   * server is holding.
   */
  callUiPushWake: { callId: string; callerName?: string; callerNumber?: string; expiresAt?: string };
  /**
   * The OS moved the call audio itself: CallKit activating or deactivating the
   * session, or Android reporting the route a car kit or headset took. The two
   * platforms know different halves of it, so both are optional; whoever binds
   * this uses whichever half arrived.
   */
  callUiAudioSession: { callId?: string; active: boolean; route?: 'earpiece' | 'speaker' | 'bluetooth' | 'headset' };
  /** iOS: PushKit issued or rotated the VoIP token this device is reachable on. */
  callUiPushToken: { token: string };
};

export type CallUiEventName = keyof CallUiEventMap;

export type CallUiEventSource = {
  addListener<K extends CallUiEventName>(event: K, listener: (payload: CallUiEventMap[K]) => void): { remove: () => void };
};

const endingFor: Record<Extract<VoiceCallState, 'ENDED' | 'FAILED' | 'DROPPED'>, 'ended' | 'failed'> = {
  ENDED: 'ended',
  FAILED: 'failed',
  DROPPED: 'failed',
};

export type CallUiBinding = { remove: () => void };

/**
 * Keeps the system call screen and the SIP engine in step, in both directions.
 *
 * Without this the two drift apart in ways users notice immediately: the call
 * ends but the green banner stays, or they press the CallKit answer button and
 * nothing happens.
 */
export function bindCallUi(options: {
  events: SipEventBus;
  bridge: NativeSipBridge;
  native: NativeCallUi;
  ui: CallUiEventSource;
  onPushWake?: (payload: CallUiEventMap['callUiPushWake']) => unknown;
  /** Where a freshly issued VoIP token goes, so the server can be told at once. */
  onPushToken?: (token: string) => unknown;
  schedule?: (callback: () => void, ms: number) => () => void;
}): CallUiBinding {
  const { events, bridge, native, ui, onPushToken, onPushWake } = options;
  const subscriptions: Array<{ remove: () => void }> = [];
  const reported = new Set<string>();
  const invitations = new Set<string>();
  const accepted = new Set<string>();
  const outgoing = new Set<string>();
  const ringback = new Map<string, boolean>();
  const cancelledRingback = new Set<string>();
  const answers = new Map<string, { started: boolean; cancelTimer: () => void }>();
  const wakeTimers = new Map<string, () => void>();
  const nativeMedia = new Map<string, { muted?: { value: boolean }; onHold?: { value: boolean } }>();
  // A delayed/replayed push or INVITE must not resurrect a cancelled call.
  const ended = new Set<string>();
  let disposed = false;
  const schedule = options.schedule ?? ((callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  });

  const swallow = (what: string) => (error: unknown) => {
    // Never let a call-UI hiccup take the call down with it.
    console.warn(`Vocivo call UI: ${what} failed`, error instanceof Error ? error.message : error);
  };
  const completeAnswer = (callId: string, success: boolean) => native.completeAnswer?.({ callId, success }).catch(swallow('complete answer'));
  const setRingback = (callId: string, enabled: boolean) => {
    if (ringback.get(callId) === enabled) return;
    ringback.set(callId, enabled);
    native.setRingback?.({ callId, enabled }).catch(swallow('ringback'));
  };
  const finish = (callId: string) => {
    if (outgoing.has(callId)) setRingback(callId, false);
    outgoing.delete(callId);
    ringback.delete(callId);
    cancelledRingback.delete(callId);
    answers.get(callId)?.cancelTimer();
    answers.delete(callId);
    wakeTimers.get(callId)?.();
    wakeTimers.delete(callId);
    invitations.delete(callId);
    accepted.delete(callId);
    reported.delete(callId);
    nativeMedia.delete(callId);
    ended.add(callId);
    if (ended.size > 128) ended.delete(ended.values().next().value!);
  };
  const diagnoseAnswer = (callId: string, phase: SipAnswerFailure) => {
    reportSipAnswerFailure(callId, phase, invitations.has(callId), answers.get(callId)?.started ?? false);
  };
  const failAnswer = (callId: string, phase: SipAnswerFailure) => {
    if (disposed || ended.has(callId)) return;
    diagnoseAnswer(callId, phase);
    finish(callId);
    completeAnswer(callId, false);
    native.reportCallEnded({ callId, reason: 'failed' }).catch(swallow('end unanswered native action'));
    bridge.hangup(callId).catch(swallow('cancel failed answer'));
  };
  const answerWhenInvited = (callId: string) => {
    const pending = answers.get(callId);
    if (disposed || ended.has(callId) || !pending || pending.started || !invitations.has(callId)) return;
    pending.started = true;
    bridge.answer(callId).then(() => {
      if (disposed || ended.has(callId) || answers.get(callId) !== pending) return;
      pending.cancelTimer();
      answers.delete(callId);
      accepted.add(callId);
      completeAnswer(callId, true);
    }).catch((failure) => {
      swallow('answer from call UI')(failure);
      if (!disposed && answers.get(callId) === pending) failAnswer(callId, 'accept_rejected');
    });
  };

  // Engine -> system call screen.
  subscriptions.push(events.addListener('incoming', (payload) => {
    if (ended.has(payload.callId)) {
      bridge.hangup(payload.callId).catch(swallow('reject late INVITE'));
      return;
    }
    invitations.add(payload.callId);
    wakeTimers.get(payload.callId)?.();
    wakeTimers.delete(payload.callId);
    answerWhenInvited(payload.callId);
    if (reported.has(payload.callId)) return;
    reported.add(payload.callId);
    native.reportIncomingCall({
      callId: payload.callId,
      callerName: payload.callerName,
      callerNumber: payload.callerNumber,
    }).catch(swallow('report incoming'));
  }));

  // Outbound calls were never reported: no in-call status bar, nothing in
  // Recents, Bluetooth and CarPlay buttons dead, and the voice-chat audio
  // session — configured on the incoming path — never applied to a dialled
  // call, so headset routing was whatever WebRTC happened to pick.
  subscriptions.push(events.addListener('outgoing', (payload) => {
    if (ended.has(payload.callId) || reported.has(payload.callId)) return;
    reported.add(payload.callId);
    outgoing.add(payload.callId);
    const handle = payload.target.replace(/^sips?:/i, '').split('@')[0] || payload.target;
    native.reportOutgoingCall({ callId: payload.callId, handle }).catch(swallow('report outgoing'));
  }));

  subscriptions.push(events.addListener('callProgress', ({ callId, statusCode }) => {
    if (disposed || ended.has(callId) || accepted.has(callId) || !outgoing.has(callId)) return;
    if (statusCode === 0) cancelledRingback.add(callId);
    // Only 180 means the recipient is ringing. 183 may carry early media.
    setRingback(callId, statusCode === 180 && !cancelledRingback.has(callId));
  }));

  subscriptions.push(events.addListener('callState', (payload) => {
    if (payload.state === 'ACTIVE') {
      if (ended.has(payload.callId)) return;
      accepted.add(payload.callId);
      if (outgoing.has(payload.callId)) setRingback(payload.callId, false);
      native.reportCallConnected(payload.callId).catch(swallow('report connected'));
      return;
    }
    if (payload.state === 'ENDED' || payload.state === 'FAILED' || payload.state === 'DROPPED') {
      if (answers.has(payload.callId)) {
        diagnoseAnswer(payload.callId, 'ended_during_answer');
        completeAnswer(payload.callId, false);
      }
      finish(payload.callId);
      native.reportCallEnded({ callId: payload.callId, reason: endingFor[payload.state] }).catch(swallow('report ended'));
    }
  }));

  const reportMedia = (callId: string, key: 'muted' | 'onHold', value: boolean) => {
    if (disposed || ended.has(callId)) return;
    const current = nativeMedia.get(callId) || {};
    if (current[key]?.value === value) return;
    const change = { value };
    const next = { ...current, [key]: change };
    // Set before crossing the bridge: CallKit can echo the action immediately.
    nativeMedia.set(callId, next);
    const update = key === 'muted' ? native.reportMuted({ callId, muted: value }) : native.reportHeld({ callId, held: value });
    update.catch((error) => {
      const latest = nativeMedia.get(callId);
      if (latest?.[key] === change) delete latest[key];
      swallow(`report ${key}`)(error);
    });
  };
  subscriptions.push(events.addListener('mediaState', (payload) => {
    if (!payload.callId) return;
    if (typeof payload.muted === 'boolean') reportMedia(payload.callId, 'muted', payload.muted);
    if (typeof payload.onHold === 'boolean') reportMedia(payload.callId, 'onHold', payload.onHold);
  }));

  const applyNativeMedia = (callId: string, key: 'muted' | 'onHold', value: boolean) => {
    if (disposed || ended.has(callId)) return;
    const previous = nativeMedia.get(callId) || {};
    if (previous[key]?.value === value) return; // Acknowledgment of our own transaction.
    const change = { value };
    const next = { ...previous, [key]: change };
    nativeMedia.set(callId, next);
    const update = key === 'muted' ? bridge.mute(callId, value) : bridge.hold(callId, value);
    update.catch((error) => {
      const latest = nativeMedia.get(callId);
      if (latest?.[key] === change) {
        const old = previous[key];
        if (old) reportMedia(callId, key, old.value);
        else delete latest[key];
      }
      swallow(`${key} from call UI`)(error);
    });
  };

  // System call screen -> engine.
  subscriptions.push(ui.addListener('callUiAnswer', (payload) => {
    if (ended.has(payload.callId)) { completeAnswer(payload.callId, false); return; }
    if (accepted.has(payload.callId)) { completeAnswer(payload.callId, true); return; }
    if (!answers.has(payload.callId)) answers.set(payload.callId, {
      started: false, cancelTimer: schedule(() => failAnswer(payload.callId, 'answer_timeout'), 12_000),
    });
    answerWhenInvited(payload.callId);
  }));

  subscriptions.push(ui.addListener('callUiEnd', (payload) => {
    if (answers.has(payload.callId)) {
      diagnoseAnswer(payload.callId, 'native_end_during_answer');
      completeAnswer(payload.callId, false);
    }
    finish(payload.callId);
    bridge.hangup(payload.callId).catch(swallow('hang up from call UI'));
  }));

  subscriptions.push(ui.addListener('callUiMute', (payload) => {
    applyNativeMedia(payload.callId, 'muted', payload.muted);
  }));

  subscriptions.push(ui.addListener('callUiHold', (payload) => {
    applyNativeMedia(payload.callId, 'onHold', payload.held);
  }));

  subscriptions.push(ui.addListener('callUiDtmf', (payload) => {
    bridge.sendDtmf(payload.callId, payload.digit).catch(swallow('DTMF from call UI'));
  }));

  subscriptions.push(ui.addListener('callUiPushWake', (payload) => {
    // The module has already drawn the call. Remember it so the INVITE that
    // follows does not draw a second one on top.
    if (ended.has(payload.callId)) {
      native.reportCallEnded({ callId: payload.callId, reason: 'ended' }).catch(swallow('end stale push'));
      return;
    }
    reported.add(payload.callId);
    if (!invitations.has(payload.callId) && !wakeTimers.has(payload.callId)) {
      const expiry = payload.expiresAt ? Date.parse(payload.expiresAt) : Date.now() + 45_000;
      const delay = Math.max(0, Math.min(45_000, Number.isFinite(expiry) ? expiry - Date.now() : 0));
      wakeTimers.set(payload.callId, schedule(() => failAnswer(payload.callId, 'invite_timeout'), delay));
    }
    Promise.resolve().then(() => onPushWake?.(payload)).catch((failure) => {
      swallow('register after push')(failure);
      if (!disposed && !invitations.has(payload.callId)) failAnswer(payload.callId, 'wake_failed');
    });
  }));
  subscriptions.push(ui.addListener('callUiAudioSession', (payload) => {
    if (disposed || !payload.route) return;
    // The system call screen moves the audio on its own — a car kit connecting,
    // the speaker button on the CallKit screen. The engine's speaker flag is
    // what the in-app button negates, so leaving it stale made the next tap
    // look like it had done nothing at all.
    bridge.setSpeaker(payload.route === 'speaker').catch(swallow('follow the system audio route'));
  }));

  subscriptions.push(ui.addListener('callUiPushToken', (payload) => {
    if (disposed || !payload.token) return;
    Promise.resolve().then(() => onPushToken?.(payload.token)).catch(swallow('publish a refreshed VoIP token'));
  }));

  // Flush native launch events only after every JS listener is installed.
  native.startCallUiEvents?.().catch(swallow('start native event delivery'));

  return {
    remove: () => {
      disposed = true;
      outgoing.forEach((callId) => setRingback(callId, false));
      outgoing.clear();
      ringback.clear();
      cancelledRingback.clear();
      answers.forEach((pending, callId) => { pending.cancelTimer(); completeAnswer(callId, false); });
      wakeTimers.forEach((cancel) => cancel());
      answers.clear();
      wakeTimers.clear();
      invitations.clear();
      accepted.clear();
      ended.clear();
      nativeMedia.clear();
      native.stopCallUiEvents?.().catch(swallow('stop native event delivery'));
      subscriptions.forEach((subscription) => subscription.remove());
      subscriptions.length = 0;
      reported.clear();
    },
  };
}

/** Narrow view of the native module, so tests never need React Native. */
export type SipEventSourceLike = SipEventSource;
