import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceSubject } from './observable';
import { SipVoiceClient } from './sipCallEngine';
import { toVoiceCallState, type NativeSipBridge, type SipEventMap, type SipEventName, type SipEventSource } from './voiceEngine';

type Listener = (payload: unknown) => void;

function fakeEvents() {
  const listeners = new Map<SipEventName, Set<Listener>>();
  const source: SipEventSource = {
    addListener(event, listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener as Listener);
      listeners.set(event, set);
      return { remove: () => set.delete(listener as Listener) };
    },
  };
  const emit = <K extends SipEventName>(event: K, payload: SipEventMap[K]) => {
    [...(listeners.get(event) ?? [])].forEach((listener) => listener(payload));
  };
  return { source, emit, count: (event: SipEventName) => listeners.get(event)?.size ?? 0 };
}

function fakeBridge(overrides: Partial<NativeSipBridge> = {}) {
  const calls: string[] = [];
  const bridge: NativeSipBridge = {
    register: async () => { calls.push('register'); },
    unregister: async () => { calls.push('unregister'); },
    invite: async () => { calls.push('invite'); return 'call-out-1'; },
    answer: async (id) => { calls.push(`answer:${id}`); },
    hangup: async (id) => { calls.push(`hangup:${id}`); },
    hold: async (id, on) => { calls.push(`hold:${id}:${on}`); },
    mute: async (id, on) => { calls.push(`mute:${id}:${on}`); },
    sendDtmf: async (id, digit) => { calls.push(`dtmf:${id}:${digit}`); },
    setSpeaker: async (on) => { calls.push(`speaker:${on}`); },
    ...overrides,
  };
  return { bridge, calls };
}

test('a subscriber is handed the current value immediately, like the SDK BehaviorSubject', () => {
  const subject = new VoiceSubject('first');
  const seen: string[] = [];
  subject.subscribe((value) => seen.push(value));
  subject.next('second');
  assert.deepEqual(seen, ['first', 'second']);
});

test('repeating a value emits nothing, so no phantom self-transition reaches the lifecycle registry', () => {
  const subject = new VoiceSubject('ACTIVE');
  const seen: string[] = [];
  subject.subscribe((value) => seen.push(value));
  subject.next('ACTIVE');
  subject.next('HELD');
  assert.deepEqual(seen, ['ACTIVE', 'HELD']);
});

test('an observer that unsubscribes itself mid-notification does not break the rest', () => {
  const subject = new VoiceSubject(0);
  const seen: number[] = [];
  const first = subject.subscribe(() => first?.unsubscribe());
  subject.subscribe((value) => seen.push(value));
  subject.next(1);
  assert.deepEqual(seen, [0, 1]);
});

test('an incoming call appears in calls$ and becomes the active call', () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  events.emit('incoming', { callId: 'c1', callerName: 'Ada', callerNumber: '+15551230000', sipUsername: 'ext-100' });
  assert.equal(client.currentCalls.length, 1);
  const call = client.currentActiveCall;
  assert.ok(call);
  assert.equal(call.callId, 'c1');
  assert.equal(call.isIncoming, true);
  assert.equal(call.callerName, 'Ada');
  assert.equal(call.currentState, 'RINGING');
});

test('a duplicate incoming event for the same call is ignored', () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  events.emit('incoming', { callId: 'c1' });
  events.emit('incoming', { callId: 'c1' });
  assert.equal(client.currentCalls.length, 1);
});

test('invite headers survive onto the call so the edge still sees X-Vocivo-*', async () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  const headers = [{ name: 'X-Vocivo-Caller-ID', value: '+15550001111' }, { name: 'X-Vocivo-Flow', value: 'outbound' }];
  const call = await client.newCall('+15551230000', 'Vocivo', '+15550001111', headers);
  assert.deepEqual(call.inviteCustomHeaders, headers);
  assert.equal(call.currentState, 'CONNECTING');
  assert.equal(client.currentActiveCall?.callId, call.callId);
});

test('a native module that returns no call id fails loudly instead of creating a ghost call', async () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge({ invite: async () => '' });
  const client = new SipVoiceClient({ bridge, events: events.source });
  await assert.rejects(() => client.newCall('+15551230000', 'Vocivo', undefined, []), /did not return a call id/);
  assert.equal(client.currentCalls.length, 0);
});

test('a terminal state removes the call and clears it from active', () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  events.emit('incoming', { callId: 'c1' });
  events.emit('callState', { callId: 'c1', state: 'ENDED' });
  assert.equal(client.currentCalls.length, 0);
  assert.equal(client.currentActiveCall, null);
});

test('a terminal state never regresses, even if native sends a later transition', () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  events.emit('incoming', { callId: 'c1' });
  const call = client.currentActiveCall!;
  const seen: string[] = [];
  call.callState$.subscribe((state) => seen.push(state));
  events.emit('callState', { callId: 'c1', state: 'ENDED' });
  events.emit('callState', { callId: 'c1', state: 'ACTIVE' });
  assert.deepEqual(seen, ['RINGING', 'ENDED']);
});

test('an unknown state from native fails the call rather than wedging it', () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  events.emit('incoming', { callId: 'c1' });
  const call = client.getCall('c1')!;
  events.emit('callState', { callId: 'c1', state: 'BANANA' as never });
  assert.equal(call.currentState, 'FAILED');
  assert.equal(client.currentCalls.length, 0);
});

test('ending the active call promotes a surviving call instead of leaving a dead pointer', () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  events.emit('incoming', { callId: 'c1' });
  events.emit('incoming', { callId: 'c2' });
  client.setActiveCall('c1');
  events.emit('callState', { callId: 'c1', state: 'ENDED' });
  assert.equal(client.currentActiveCall?.callId, 'c2');
});

test('duration starts when the call goes active and stays zero before that', () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  let clock = 1_000_000;
  const client = new SipVoiceClient({ bridge, events: events.source, now: () => clock });
  events.emit('incoming', { callId: 'c1' });
  const call = client.getCall('c1')!;
  assert.equal(call.currentDuration, 0);
  events.emit('callState', { callId: 'c1', state: 'ACTIVE' });
  clock += 4_500;
  assert.equal(call.currentDuration, 4);
  events.emit('callState', { callId: 'c1', state: 'HELD' });
  clock += 1_000;
  assert.equal(call.currentDuration, 5, 'hold does not stop the clock');
});

test('media events mirror mute and hold onto the observables the UI reads', () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  events.emit('incoming', { callId: 'c1' });
  const call = client.getCall('c1')!;
  events.emit('mediaState', { callId: 'c1', muted: true });
  assert.equal(call.currentIsMuted, true);
  assert.equal(call.currentIsHeld, false);
  events.emit('mediaState', { callId: 'c1', onHold: true });
  assert.equal(call.currentIsHeld, true);
});

test('call controls reach the native bridge with the call id', async () => {
  const events = fakeEvents();
  const { bridge, calls } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  events.emit('incoming', { callId: 'c1' });
  const call = client.getCall('c1')!;
  await call.answer();
  await call.toggleMute();
  await call.hold();
  await call.resume();
  await call.dtmf('5');
  await call.hangup();
  assert.deepEqual(calls, ['answer:c1', 'mute:c1:true', 'hold:c1:true', 'hold:c1:false', 'dtmf:c1:5', 'hangup:c1']);
  assert.equal(call.currentIsMuted, true);
  assert.equal(call.currentIsHeld, false);
});

test('registration events map onto the connection states VoiceContext already handles', () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  const seen: string[] = [];
  client.connectionState$.subscribe((state) => seen.push(state));
  events.emit('registration', { state: 'progress' });
  events.emit('registration', { state: 'ok' });
  events.emit('registration', { state: 'failed', reason: 'forbidden' });
  events.emit('registration', { state: 'none' });
  assert.deepEqual(seen, ['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'ERROR', 'DISCONNECTED']);
});

test('an unregister we asked for lets go of its calls before it reports the disconnection', () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  events.emit('registration', { state: 'ok' });
  events.emit('incoming', { callId: 'c1' });
  const seen: Array<{ state: string; calls: number }> = [];
  client.connectionState$.subscribe((state) => seen.push({ state, calls: client.currentCalls.length }));
  events.emit('registration', { state: 'none', requested: true });
  // The call has to be gone by the time the UI is told, or a sign-out reads as
  // a transport failure on a call the UI still believes in.
  assert.deepEqual(seen.at(-1), { state: 'DISCONNECTED', calls: 0 });
  assert.equal(client.currentActiveCall, null);
});

test('logout hangs up everything, unregisters, and reports disconnected', async () => {
  const events = fakeEvents();
  const { bridge, calls } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  events.emit('incoming', { callId: 'c1' });
  events.emit('registration', { state: 'ok' });
  await client.logout();
  assert.ok(calls.includes('hangup:c1'));
  assert.ok(calls.includes('unregister'));
  assert.equal(client.currentCalls.length, 0);
  assert.equal(client.currentActiveCall, null);
  assert.equal(client.currentConnectionState, 'DISCONNECTED');
});

test('a failing unregister surfaces the failure and leaves local UI disconnected', async () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge({ unregister: async () => { throw new Error('native gone'); } });
  const client = new SipVoiceClient({ bridge, events: events.source });
  await assert.rejects(client.logout(), /native gone/);
  assert.equal(client.currentConnectionState, 'DISCONNECTED');
});

test('dispose removes every native listener', () => {
  const events = fakeEvents();
  const { bridge } = fakeBridge();
  const client = new SipVoiceClient({ bridge, events: events.source });
  assert.equal(events.count('incoming'), 1);
  client.dispose();
  assert.equal(events.count('incoming'), 0);
  assert.equal(events.count('callState'), 0);
});

test('only the documented call states are accepted from native', () => {
  assert.equal(toVoiceCallState('ACTIVE'), 'ACTIVE');
  assert.equal(toVoiceCallState('DROPPED'), 'DROPPED');
  assert.equal(toVoiceCallState('NEW'), null, 'NEW is a lifecycle-only state, never a native one');
  assert.equal(toVoiceCallState('active'), null);
  assert.equal(toVoiceCallState(undefined), null);
});
