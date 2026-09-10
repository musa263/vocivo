import assert from 'node:assert/strict';
import test from 'node:test';
import { SipEventBus, SipStackBridge, SipRegistrationDeferredError, sessionStateToVoiceState } from './sipBridge';
import type { SipDisposition, SipSessionHandle, SipSessionState, SipStack, SipStackConfig } from './sipStack';
import type { SipEventMap, SipEventName, VoiceInviteHeader } from './voiceEngine';
import { bindCallUi, type NativeCallUi, type CallUiEventSource } from './callUi';

/** Narrows an optional lookup so the assertions below read as intent, not as null checks. */
function must<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, `expected ${what}`);
  return value;
}

const credentials: SipStackConfig = {
  username: '1001',
  password: 'secret',
  domain: 'sip.vocivo.app',
  wsUri: 'wss://sip.vocivo.app:7443',
};

for (const ending of ['answer', 'hangup', 'disconnect', 'unmount'] as const) {
  test(`native ringback follows provisional SIP responses and stops on ${ending}`, async () => {
    const { bridge, fake, events } = harness();
    const tones: boolean[] = [];
    const native: NativeCallUi = {
      reportIncomingCall: async () => {}, reportOutgoingCall: async () => {},
      reportCallConnected: async () => {}, reportCallEnded: async () => {},
      reportMuted: async () => {}, reportHeld: async () => {},
      setSpeaker: async () => {}, isCallUiAvailable: async () => true,
      setRingback: async ({ enabled }) => { tones.push(enabled); },
    };
    const binding = bindCallUi({ events, bridge, native, ui: { addListener: () => ({ remove() {} }) } });
    await bridge.register(credentials);
    const id = await bridge.invite('1002');
    const session = must(fake.outgoing[0], 'outgoing session');
    assert.deepEqual(tones, [], 'reserving/dialing a call must not simulate recipient ringing');
    session.progress(180);
    session.progress(180);
    session.progress(183);
    session.progress(180);
    assert.deepEqual(tones, [true, false, true], 'early media silences local ringback and duplicates do not restart it');
    if (ending === 'answer') session.move('Established');
    if (ending === 'hangup') await bridge.hangup(id);
    if (ending === 'disconnect') await bridge.unregister();
    if (ending === 'unmount') binding.remove();
    assert.equal(tones.at(-1), false);
    const stopped = tones.length;
    session.progress(180);
    events.emit('callProgress', { callId: id, statusCode: 180 });
    assert.equal(tones.length, stopped, 'late ringing cannot resurrect native playback');
    binding.remove();
    await bridge.unregister();
  });
}

test('CallKit mute and hold echoes cause exactly one native transaction per app action', async () => {
  const events = new SipEventBus();
  const fake = fakeStack();
  const bridge = new SipStackBridge({ createStack: () => fake.stack, events });
  const listeners = new Map<string, (payload: any) => void>();
  const ui: CallUiEventSource = { addListener: (name, listener) => {
    listeners.set(name, listener);
    return { remove: () => { listeners.delete(name); } };
  } };
  const transactions: string[] = [];
  const native: NativeCallUi = {
    reportIncomingCall: async () => {}, reportOutgoingCall: async () => {},
    reportCallConnected: async () => {}, reportCallEnded: async () => {},
    setSpeaker: async () => {}, isCallUiAvailable: async () => true,
    reportMuted: async payload => {
      transactions.push(`mute:${payload.muted}`);
      // Model the old native delegate too: JS must defend against that echo.
      if (transactions.length < 12) listeners.get('callUiMute')?.(payload);
    },
    reportHeld: async payload => {
      transactions.push(`hold:${payload.held}`);
      if (transactions.length < 12) listeners.get('callUiHold')?.(payload);
    },
  };
  const binding = bindCallUi({ events, bridge, native, ui });
  await bridge.register(credentials);
  const id = await bridge.invite('1002');
  const session = must(fake.outgoing[0], 'outgoing session');
  session.move('Established');
  await bridge.mute(id, true);
  await bridge.mute(id, true);
  await bridge.hold(id, true);
  await bridge.hold(id, true);
  await bridge.hold(id, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(transactions, ['mute:true', 'hold:true', 'hold:false']);
  assert.deepEqual(session.actions, ['mute:true', 'hold:true', 'hold:false']);
  listeners.get('callUiMute')?.({ callId: id, muted: false });
  listeners.get('callUiHold')?.({ callId: id, held: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transactions.length, 3, 'native user commands are not mirrored back as transactions');
  assert.deepEqual(session.actions, ['mute:true', 'hold:true', 'hold:false', 'mute:false', 'hold:true']);
  session.move('Terminated');
  events.emit('mediaState', { callId: id, muted: true, onHold: false });
  assert.equal(transactions.length, 3, 'late state cannot recreate a finished native call');
  binding.remove();
  assert.equal(listeners.size, 0);
  await bridge.unregister();
});

test('racing hold commands serialize, deduplicate and allow retry after failure', async () => {
  const { bridge, fake } = harness();
  await bridge.register(credentials);
  const id = await bridge.invite('1002');
  const session = must(fake.outgoing[0], 'outgoing session');
  session.move('Established');
  let finish!: () => void;
  const seen: boolean[] = [];
  session.setHold = async on => { seen.push(on); if (on) await new Promise<void>(resolve => { finish = resolve; }); };
  const first = bridge.hold(id, true), duplicate = bridge.hold(id, true), resume = bridge.hold(id, false);
  assert.deepEqual(seen, [true]);
  finish();
  await Promise.all([first, duplicate, resume]);
  assert.deepEqual(seen, [true, false]);
  session.setHold = async () => { throw new Error('re-INVITE refused'); };
  await assert.rejects(bridge.hold(id, true), /refused/);
  session.setHold = async on => { seen.push(on); };
  await bridge.hold(id, true);
  assert.deepEqual(seen, [true, false, true]);
  await bridge.unregister();
});

class FakeSession implements SipSessionHandle {
  private listener: ((state: SipSessionState) => void) | null = null;
  private progressListener: ((statusCode: number) => void) | null = null;
  private ended: SipDisposition = {};
  readonly actions: string[] = [];

  constructor(
    readonly id: string,
    readonly incoming: boolean,
    readonly remoteDisplayName = 'Sam Tailor',
    readonly remoteUser = '+15551230000',
    readonly remoteTarget = 'sip:1001@sip.vocivo.app',
    readonly headers: VoiceInviteHeader[] = [],
  ) {}

  onStateChange(listener: (state: SipSessionState) => void) {
    this.listener = listener;
  }
  onProgress(listener: (statusCode: number) => void) { this.progressListener = listener; }
  progress(statusCode: number) { this.progressListener?.(statusCode); }

  disposition() {
    return this.ended;
  }

  /** Drives the session the way SIP.js would. */
  move(state: SipSessionState, disposition: SipDisposition = {}) {
    if (state === 'Terminated') this.ended = disposition;
    this.listener?.(state);
  }

  peerConnection() { return null; }
  async accept() { this.actions.push('accept'); }
  async terminate() { this.actions.push('terminate'); }
  async dispose() { this.actions.push('dispose'); this.listener = null; this.progressListener = null; }
  async setHold(on: boolean) { this.actions.push(`hold:${on}`); }
  async setMuted(on: boolean) { this.actions.push(`mute:${on}`); }
  async sendDtmf(digit: string) { this.actions.push(`dtmf:${digit}`); }
  async restartMedia() { this.actions.push('restart-media'); }
}

function fakeStack() {
  let registration: ((state: 'Initial' | 'Registered' | 'Unregistered' | 'Terminated', reason?: string) => void) | null = null;
  let invitation: ((session: SipSessionHandle) => void) | null = null;
  const outgoing: FakeSession[] = [];
  const state = { started: false, stopped: false, speaker: false, refreshed: 0 as number, startError: null as Error | null, lastTarget: '', lastHeaders: [] as VoiceInviteHeader[] };

  const stack: SipStack = {
    onRegistrationChange: (listener) => { registration = listener; },
    onInvitation: (listener) => { invitation = listener; },
    start: async () => {
      if (state.startError) throw state.startError;
      state.started = true;
      registration?.('Registered');
    },
    stop: async () => { state.stopped = true; },
    refresh: async () => { state.refreshed = (state.refreshed ?? 0) + 1; },
    invite: async (target, headers) => {
      state.lastTarget = target;
      state.lastHeaders = headers;
      const session = new FakeSession(`out-${outgoing.length + 1}`, false, '', target);
      outgoing.push(session);
      return session;
    },
    setSpeaker: async (on) => { state.speaker = on; },
  };

  return {
    stack,
    state,
    outgoing,
    ring: (session: FakeSession) => invitation?.(session),
    registrationChange: (value: 'Initial' | 'Registered' | 'Unregistered' | 'Terminated', reason?: string) => registration?.(value, reason),
  };
}

function harness() {
  const events = new SipEventBus();
  const recorded: Array<{ event: SipEventName; payload: unknown }> = [];
  (['registration', 'incoming', 'callState', 'mediaState'] as SipEventName[]).forEach((event) => {
    events.addListener(event, (payload) => recorded.push({ event, payload }));
  });
  const fake = fakeStack();
  const bridge = new SipStackBridge({ createStack: () => fake.stack, events });
  const of = <K extends SipEventName>(event: K) => recorded.filter((entry) => entry.event === event).map((entry) => entry.payload as SipEventMap[K]);
  return { events, bridge, fake, recorded, of };
}

test('registration reports progress then success', async () => {
  const { bridge, of } = harness();
  await bridge.register(credentials);
  assert.deepEqual(of('registration').map((entry) => entry.state), ['progress', 'ok']);
});

test('ICE recovery refreshes signaling and renegotiates the same established SIP dialog', async () => {
  const { bridge, fake } = harness();
  await bridge.register(credentials);
  const id = await bridge.invite('2001');
  await assert.rejects(bridge.restartMedia(id), /established/);
  const session = must(fake.outgoing[0], 'the outgoing session');
  session.move('Established');
  await bridge.restartMedia(id);
  assert.equal(fake.state.refreshed, 1);
  assert.deepEqual(session.actions, ['restart-media']);
  assert.equal(fake.outgoing.length, 1);
});

test('a failed start reports the failure and leaves nothing registered', async () => {
  const { bridge, fake, of } = harness();
  fake.state.startError = new Error('websocket refused');
  await assert.rejects(() => bridge.register(credentials));
  assert.equal(fake.state.stopped, true, 'failed startup must stop the transport and registration keeper');
  assert.deepEqual(of('registration').map((entry) => entry.state), ['progress', 'failed']);
  assert.equal(of('registration').at(-1)?.reason, 'websocket refused');
  await assert.rejects(() => bridge.invite('1002'), /not registered/);
});

test('an incoming INVITE surfaces the caller and its custom headers', async () => {
  const { bridge, fake, of } = harness();
  await bridge.register(credentials);
  const session = new FakeSession('in-1', true, 'Sam Tailor', '+15551230000', 'sip:1001@sip.vocivo.app', [
    { name: 'X-Vocivo-Call-UUID', value: 'abc-123' },
  ]);
  fake.ring(session);
  const incoming = must(of('incoming')[0], 'an incoming event');
  assert.equal(incoming.callId, 'in-1');
  assert.equal(incoming.callerName, 'Sam Tailor');
  assert.equal(incoming.callerNumber, '+15551230000');
  assert.deepEqual(incoming.headers, [{ name: 'X-Vocivo-Call-UUID', value: 'abc-123' }]);
});

test('an outgoing call rings then goes active', async () => {
  const { bridge, fake, of } = harness();
  await bridge.register(credentials);
  const callId = await bridge.invite('1002', [{ name: 'X-Vocivo-Tenant', value: 't1' }]);
  assert.equal(fake.state.lastTarget, '1002');
  assert.deepEqual(fake.state.lastHeaders, [{ name: 'X-Vocivo-Tenant', value: 't1' }]);

  const session = must(fake.outgoing[0], 'the outgoing session');
  session.move('Establishing');
  session.move('Established');
  assert.deepEqual(of('callState').filter((entry) => entry.callId === callId).map((entry) => entry.state), ['RINGING', 'ACTIVE']);
});

test('terminating does not end the call early', async () => {
  const { bridge, fake, of } = harness();
  await bridge.register(credentials);
  await bridge.invite('1002');
  const session = must(fake.outgoing[0], 'the outgoing session');
  session.move('Established');
  session.move('Terminating');
  assert.deepEqual(of('callState').map((entry) => entry.state), ['ACTIVE']);
});

test('a busy far end is an ordinary ending, a server error is a failure', () => {
  assert.equal(sessionStateToVoiceState('Terminated', { incoming: false, established: false, held: false, disposition: { statusCode: 486 } }), 'ENDED');
  assert.equal(sessionStateToVoiceState('Terminated', { incoming: false, established: false, held: false, disposition: { statusCode: 603 } }), 'ENDED');
  assert.equal(sessionStateToVoiceState('Terminated', { incoming: false, established: false, held: false, disposition: { statusCode: 487 } }), 'ENDED');
  assert.equal(sessionStateToVoiceState('Terminated', { incoming: false, established: false, held: false, disposition: { statusCode: 480 } }), 'ENDED');
  assert.equal(sessionStateToVoiceState('Terminated', { incoming: false, established: false, held: false, disposition: { statusCode: 408 } }), 'ENDED');
  assert.equal(sessionStateToVoiceState('Terminated', { incoming: false, established: false, held: false, disposition: { statusCode: 503 } }), 'FAILED');
  assert.equal(sessionStateToVoiceState('Terminated', { incoming: false, established: false, held: false, disposition: { statusCode: 403 } }), 'FAILED');
  // A call that was up and then hung up is never a failure, whatever the code.
  assert.equal(sessionStateToVoiceState('Terminated', { incoming: false, established: true, held: false, disposition: { statusCode: 503 } }), 'ENDED');
});

test('an incoming call that is never answered ends rather than fails', async () => {
  const { bridge, fake, of } = harness();
  await bridge.register(credentials);
  const session = new FakeSession('in-1', true);
  fake.ring(session);
  session.move('Terminated', { statusCode: 487, reason: 'Request Terminated' });
  const state = must(of('callState')[0], 'a call state event');
  assert.equal(state.state, 'ENDED');
  assert.equal(state.cause, 'Request Terminated');
});

test('hold republishes the call state, because the re-INVITE does not', async () => {
  const { bridge, fake, of } = harness();
  await bridge.register(credentials);
  const callId = await bridge.invite('1002');
  const session = must(fake.outgoing[0], 'the outgoing session');
  session.move('Established');
  await bridge.hold(callId, true);
  await bridge.hold(callId, false);
  assert.deepEqual(of('callState').map((entry) => entry.state), ['ACTIVE', 'HELD', 'ACTIVE']);
  assert.deepEqual(of('mediaState').map((entry) => entry.onHold), [true, false]);
  assert.deepEqual(session.actions, ['hold:true', 'hold:false']);
});

test('hold before the call is up does not publish a state it cannot be in', async () => {
  const { bridge, fake, of } = harness();
  await bridge.register(credentials);
  const callId = await bridge.invite('1002');
  await bridge.hold(callId, true);
  assert.deepEqual(of('callState').map((entry) => entry.state), []);
});

test('mute and DTMF reach the session', async () => {
  const { bridge, fake, of } = harness();
  await bridge.register(credentials);
  const callId = await bridge.invite('1002');
  const session = must(fake.outgoing[0], 'the outgoing session');
  await bridge.mute(callId, true);
  await bridge.sendDtmf(callId, '5');
  assert.deepEqual(session.actions, ['mute:true', 'dtmf:5']);
  assert.deepEqual(of('mediaState').map((entry) => entry.muted), [true]);
});

test('a terminated session is forgotten so its peer connection cannot leak', async () => {
  const { bridge, fake } = harness();
  await bridge.register(credentials);
  const callId = await bridge.invite('1002');
  must(fake.outgoing[0], 'the outgoing session').move('Terminated', { statusCode: 200 });
  await assert.rejects(() => bridge.mute(callId, true), /Unknown Vocivo SIP call/);
  // Hanging up a call that has already gone is a no-op, not a crash: the user
  // can always press the red button after the far end has hung up.
  await bridge.hangup(callId);
});

test('unregister ends live calls, stops the stack and reports disconnection', async () => {
  const { bridge, fake, of } = harness();
  await bridge.register(credentials);
  await bridge.invite('1002');
  const session = must(fake.outgoing[0], 'the outgoing session');
  session.move('Established');
  await bridge.unregister();
  assert.deepEqual(session.actions, ['dispose']);
  assert.equal(fake.state.stopped, true);
  assert.equal(of('callState').at(-1)?.state, 'ENDED');
  assert.equal(of('registration').at(-1)?.state, 'none');
});

test('registering twice tears the first stack down first', async () => {
  const events = new SipEventBus();
  const stacks: ReturnType<typeof fakeStack>[] = [];
  const bridge = new SipStackBridge({
    createStack: () => {
      const next = fakeStack();
      stacks.push(next);
      return next.stack;
    },
    events,
  });
  await bridge.register(credentials);
  await bridge.register(credentials);
  assert.equal(stacks.length, 2);
  assert.equal(must(stacks[0], 'the first stack').state.stopped, true);
  assert.equal(must(stacks[1], 'the second stack').state.started, true);
});

test('the speaker route is remembered and forwarded', async () => {
  const { bridge, fake } = harness();
  await bridge.register(credentials);
  await bridge.setSpeaker(true);
  assert.equal(fake.state.speaker, true);
  assert.equal(bridge.speakerOn, true);
});

test('a listener that throws does not stop the others', () => {
  const events = new SipEventBus();
  const seen: string[] = [];
  events.addListener('callState', () => { throw new Error('boom'); });
  events.addListener('callState', (payload) => seen.push(payload.state));
  events.emit('callState', { callId: 'x', state: 'ACTIVE' });
  assert.deepEqual(seen, ['ACTIVE']);
});

test('removing a listener during emit does not skip the next one', () => {
  const events = new SipEventBus();
  const seen: string[] = [];
  const first = events.addListener('callState', () => { first.remove(); seen.push('first'); });
  events.addListener('callState', () => seen.push('second'));
  events.emit('callState', { callId: 'x', state: 'ACTIVE' });
  assert.deepEqual(seen, ['first', 'second']);
});

test('refresh reaches the stack while registered and is a no-op after sign-out', async () => {
  const { stack, state } = fakeStack();
  const events = new SipEventBus();
  const bridge = new SipStackBridge({ events, createStack: async () => stack });
  await bridge.refresh();
  assert.equal(state.refreshed, 0, 'nothing to refresh before a registration');
  await bridge.register({ username: 'u', password: 'p', domain: 'sip.vocivo.app' });
  await bridge.refresh();
  assert.equal(state.refreshed, 1);
  await bridge.unregister();
  await bridge.refresh();
  assert.equal(state.refreshed, 1, 'a signed-out phone is not brought back');
});

for (const phase of ['ringing', 'active', 'held'] as const) {
  test(`credential replacement preserves a ${phase} call and remains possible after hangup`, async () => {
    const { bridge, fake } = harness();
    await bridge.register(credentials);
    const call = new FakeSession('renewal-protected', true);
    fake.ring(call);
    if (phase !== 'ringing') call.move('Established');
    if (phase === 'held') await bridge.hold(call.id, true);
    const priorActions = [...call.actions];
    await assert.rejects(bridge.register({ ...credentials, password: 'next' }), SipRegistrationDeferredError);
    assert.deepEqual(call.actions, priorActions);
    assert.equal(fake.state.stopped, false);
    await bridge.hangup(call.id);
    call.move('Terminated');
    await bridge.register({ ...credentials, password: 'next' });
    assert.equal(fake.state.stopped, true);
    await bridge.unregister();
  });
}

test('the loudspeaker one call ended on does not follow the next one', async () => {
  const { bridge, fake, of } = harness();
  await bridge.register(credentials);
  await bridge.invite('1002');
  const dialled = must(fake.outgoing[0], 'the dialled session');
  dialled.move('Established');
  await bridge.setSpeaker(true);
  assert.equal(bridge.speakerOn, true);

  const waiting = new FakeSession('in-1', true);
  fake.ring(waiting);
  dialled.move('Terminated');
  assert.equal(bridge.speakerOn, true, 'a call still up keeps the route it is speaking on');

  waiting.move('Terminated');
  assert.equal(bridge.speakerOn, false, 'the system gives the next call an earpiece session, whatever this said last');
  assert.equal(of('mediaState').at(-1)?.speaker, false, 'the call screen is told, or its Speaker button starts inverted');
  assert.equal(fake.state.speaker, true, 'the platform is not touched: the OS has already taken the route back');

  fake.ring(new FakeSession('in-2', true));
  assert.equal(bridge.speakerOn, false);
});
