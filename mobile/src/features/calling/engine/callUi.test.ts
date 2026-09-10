import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCallUi, type CallUiEventMap, type CallUiEventName, type CallUiEventSource, type NativeCallUi } from './callUi';
import { SipEventBus } from './sipBridge';
import type { NativeSipBridge } from './voiceEngine';

function fakeUi() {
  const listeners = new Map<CallUiEventName, Set<(payload: never) => void>>();
  const source: CallUiEventSource = {
    addListener(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (payload: never) => void);
      listeners.set(event, set);
      return { remove: () => { set.delete(listener as (payload: never) => void); } };
    },
  };
  const press = <K extends CallUiEventName>(event: K, payload: CallUiEventMap[K]) => {
    [...(listeners.get(event) ?? [])].forEach((listener) => (listener as (value: CallUiEventMap[K]) => void)(payload));
  };
  return { source, press };
}

function fakeNative() {
  const seen: string[] = [];
  const native: NativeCallUi = {
    reportIncomingCall: async ({ callId, callerName }) => { seen.push(`incoming:${callId}:${callerName ?? ''}`); },
    reportOutgoingCall: async ({ callId }) => { seen.push(`outgoing:${callId}`); },
    reportCallConnected: async (callId) => { seen.push(`connected:${callId}`); },
    reportCallEnded: async ({ callId, reason }) => { seen.push(`ended:${callId}:${reason}`); },
    reportMuted: async ({ callId, muted }) => { seen.push(`muted:${callId}:${muted}`); },
    reportHeld: async ({ callId, held }) => { seen.push(`held:${callId}:${held}`); },
    setSpeaker: async (on) => { seen.push(`speaker:${on}`); },
    isCallUiAvailable: async () => true,
    completeAnswer: async ({ callId, success }) => { seen.push(`answer-completed:${callId}:${success}`); },
  };
  return { native, seen };
}

function fakeBridge() {
  const seen: string[] = [];
  const bridge = {
    register: async () => {},
    unregister: async () => {},
    invite: async () => 'x',
    answer: async (id: string) => { seen.push(`answer:${id}`); },
    hangup: async (id?: string) => { seen.push(`hangup:${id}`); },
    hold: async (id: string, on: boolean) => { seen.push(`hold:${id}:${on}`); },
    mute: async (id: string, on: boolean) => { seen.push(`mute:${id}:${on}`); },
    sendDtmf: async (id: string, digit: string) => { seen.push(`dtmf:${id}:${digit}`); },
    setSpeaker: async () => {},
  } satisfies NativeSipBridge;
  return { bridge, seen };
}

function harness() {
  const events = new SipEventBus();
  const ui = fakeUi();
  const { native, seen: nativeSeen } = fakeNative();
  const { bridge, seen: bridgeSeen } = fakeBridge();
  const wakes: CallUiEventMap['callUiPushWake'][] = [];
  const timers = new Map<() => void, number>();
  const binding = bindCallUi({ events, bridge, native, ui: ui.source, onPushWake: (payload) => wakes.push(payload),
    schedule: (fn, ms) => { timers.set(fn, ms); return () => { timers.delete(fn); }; },
  });
  return { events, ui, native, nativeSeen, bridge, bridgeSeen, wakes, binding, timers };
}

test('an incoming call is put on the system call screen once', async () => {
  const { events, nativeSeen } = harness();
  events.emit('incoming', { callId: 'c1', callerName: 'Sam', callerNumber: '+15551230000' });
  events.emit('incoming', { callId: 'c1', callerName: 'Sam' });
  await Promise.resolve();
  assert.deepEqual(nativeSeen, ['incoming:c1:Sam']);
});

test('a call that was drawn from a push is not drawn again by the INVITE', async () => {
  const { events, ui, nativeSeen, wakes } = harness();
  ui.press('callUiPushWake', { callId: 'c1', callerName: 'Sam' });
  events.emit('incoming', { callId: 'c1', callerName: 'Sam' });
  await Promise.resolve();
  assert.deepEqual(nativeSeen, []);
  assert.deepEqual(wakes, [{ callId: 'c1', callerName: 'Sam' }]);
});

test('connecting and ending are mirrored to the OS', async () => {
  const { events, nativeSeen } = harness();
  events.emit('callState', { callId: 'c1', state: 'ACTIVE' });
  events.emit('callState', { callId: 'c1', state: 'ENDED' });
  events.emit('callState', { callId: 'c2', state: 'FAILED' });
  events.emit('callState', { callId: 'c3', state: 'DROPPED' });
  await Promise.resolve();
  assert.deepEqual(nativeSeen, ['connected:c1', 'ended:c1:ended', 'ended:c2:failed', 'ended:c3:failed']);
});

test('a delayed INVITE cannot resurrect a terminated call ID', async () => {
  const { events, nativeSeen } = harness();
  events.emit('incoming', { callId: 'c1' });
  events.emit('callState', { callId: 'c1', state: 'ENDED' });
  events.emit('incoming', { callId: 'c1' });
  await Promise.resolve();
  assert.deepEqual(nativeSeen.filter((entry) => entry.startsWith('incoming')), ['incoming:c1:']);
});

test('ringing and intermediate states are not reported as endings', async () => {
  const { events, nativeSeen } = harness();
  events.emit('callState', { callId: 'c1', state: 'RINGING' });
  events.emit('callState', { callId: 'c1', state: 'CONNECTING' });
  events.emit('callState', { callId: 'c1', state: 'HELD' });
  await Promise.resolve();
  assert.deepEqual(nativeSeen, []);
});

test('media changes are mirrored, and the speaker event without a call is ignored', async () => {
  const { events, nativeSeen } = harness();
  events.emit('mediaState', { callId: 'c1', muted: true });
  events.emit('mediaState', { callId: 'c1', onHold: true });
  events.emit('mediaState', { callId: '', speaker: true });
  await Promise.resolve();
  assert.deepEqual(nativeSeen, ['muted:c1:true', 'held:c1:true']);
});

test('buttons on the system call screen drive the engine', async () => {
  const { ui, events, bridgeSeen } = harness();
  events.emit('incoming', { callId: 'c1' });
  ui.press('callUiAnswer', { callId: 'c1' });
  ui.press('callUiMute', { callId: 'c1', muted: true });
  ui.press('callUiHold', { callId: 'c1', held: true });
  ui.press('callUiDtmf', { callId: 'c1', digit: '7' });
  ui.press('callUiEnd', { callId: 'c1' });
  await Promise.resolve();
  assert.deepEqual(bridgeSeen, ['answer:c1', 'mute:c1:true', 'hold:c1:true', 'dtmf:c1:7', 'hangup:c1']);
});

test('Answer before INVITE is queued and completes only after SIP accept resolves', async () => {
  const h = harness();
  let accepted!: () => void;
  h.bridge.answer = async () => { h.bridgeSeen.push('answer:c1'); await new Promise<void>((resolve) => { accepted = resolve; }); };
  h.ui.press('callUiPushWake', { callId: 'c1' });
  h.ui.press('callUiAnswer', { callId: 'c1' });
  assert.deepEqual(h.bridgeSeen, []);
  h.events.emit('incoming', { callId: 'c1' });
  h.ui.press('callUiAnswer', { callId: 'c1' });
  assert.deepEqual(h.bridgeSeen, ['answer:c1']);
  assert.ok(!h.nativeSeen.some((value) => value.endsWith(':true')));
  accepted(); await Promise.resolve(); await Promise.resolve();
  assert.ok(h.nativeSeen.includes('answer-completed:c1:true'));
  assert.equal(h.timers.size, 0); h.binding.remove();
});

test('CANCEL racing Answer fails the native action and rejects a late INVITE', async () => {
  const h = harness();
  h.ui.press('callUiAnswer', { callId: 'c1' });
  h.events.emit('callState', { callId: 'c1', state: 'ENDED' });
  h.events.emit('incoming', { callId: 'c1' });
  await Promise.resolve();
  assert.deepEqual(h.bridgeSeen, ['hangup:c1']);
  assert.ok(h.nativeSeen.includes('answer-completed:c1:false'));
  assert.equal(h.timers.size, 0); h.binding.remove();
});

test('a duplicate native Answer after connection never accepts the SIP session twice', async () => {
  const h = harness(); h.events.emit('incoming', { callId: 'c1' });
  h.ui.press('callUiAnswer', { callId: 'c1' }); await Promise.resolve();
  h.events.emit('callState', { callId: 'c1', state: 'ACTIVE' });
  h.ui.press('callUiAnswer', { callId: 'c1' }); await Promise.resolve();
  assert.deepEqual(h.bridgeSeen, ['answer:c1']);
  assert.equal(h.timers.size, 0); h.binding.remove();
});

test('missing INVITE expires the queued Answer and leaves no native ringing UI', async () => {
  const h = harness(); h.ui.press('callUiAnswer', { callId: 'c1' });
  assert.deepEqual([...h.timers.values()], [12_000]);
  [...h.timers.keys()][0]!(); await Promise.resolve();
  assert.ok(h.nativeSeen.includes('ended:c1:failed'));
  assert.equal(h.timers.size, 0);
  h.events.emit('incoming', { callId: 'c1' });
  assert.ok(!h.bridgeSeen.includes('answer:c1')); h.binding.remove();
});

test('a late accept response cannot fulfill a native Answer after remote cancellation', async () => {
  const h = harness(); let resolveAnswer!: () => void;
  h.bridge.answer = async () => new Promise<void>((resolve) => { resolveAnswer = resolve; });
  h.events.emit('incoming', { callId: 'c1' });
  h.ui.press('callUiAnswer', { callId: 'c1' });
  h.events.emit('callState', { callId: 'c1', state: 'ENDED' });
  resolveAnswer(); await Promise.resolve(); await Promise.resolve();
  assert.ok(h.nativeSeen.includes('answer-completed:c1:false'));
  assert.ok(!h.nativeSeen.includes('answer-completed:c1:true'));
  h.binding.remove(); assert.equal(h.timers.size, 0);
});

test('a native call that rejects does not take the call down', async () => {
  const events = new SipEventBus();
  const ui = fakeUi();
  const { bridge } = fakeBridge();
  const native = { ...fakeNative().native, reportIncomingCall: async () => { throw new Error('CallKit refused'); } };
  bindCallUi({ events, bridge, native, ui: ui.source });
  events.emit('incoming', { callId: 'c1' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Reaching here without an unhandled rejection is the assertion.
  assert.ok(true);
});

test('removing the binding stops both directions', async () => {
  const { events, ui, binding, nativeSeen, bridgeSeen } = harness();
  binding.remove();
  events.emit('incoming', { callId: 'c1' });
  ui.press('callUiAnswer', { callId: 'c1' });
  await Promise.resolve();
  assert.deepEqual(nativeSeen, []);
  assert.deepEqual(bridgeSeen, []);
});

test('an Answer that beat the INVITE reports the call up before it completes the native action', async () => {
  const h = harness();
  // Model SIP.js faithfully: the 200 OK — and with it the peer connection and
  // its tracks — exists before accept() resolves. The order matters on iOS,
  // where CallKit has been showing this call since the push and the audio
  // session it activates is only useful once those tracks are there.
  h.bridge.answer = async (id: string) => {
    h.bridgeSeen.push(`answer:${id}`);
    h.events.emit('callState', { callId: id, state: 'ACTIVE' });
  };
  h.ui.press('callUiPushWake', { callId: 'c1' });
  h.ui.press('callUiAnswer', { callId: 'c1' });
  assert.deepEqual(h.bridgeSeen, [], 'there is no SIP session to accept until the INVITE arrives');
  assert.deepEqual(h.nativeSeen, []);
  h.events.emit('incoming', { callId: 'c1' });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(h.bridgeSeen, ['answer:c1']);
  assert.deepEqual(h.nativeSeen, ['connected:c1', 'answer-completed:c1:true']);
  assert.equal(h.timers.size, 0, 'both the INVITE deadline and the answer deadline are spent');
  h.binding.remove();
});
