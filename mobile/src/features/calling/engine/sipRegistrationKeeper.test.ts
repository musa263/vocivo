import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrationKeeper, reconnectDelayMs } from './sipRegistrationKeeper';

class PendingError extends Error {}

function harness() {
  const state = { connected: true, registered: false };
  const log: string[] = [];
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  let reconnectFails = 0;
  let registerFails: Error | null = null;

  const keeper = createRegistrationKeeper({
    isConnected: () => state.connected,
    isRegistered: () => state.registered,
    reconnect: async () => {
      log.push('reconnect');
      if (reconnectFails > 0) {
        reconnectFails -= 1;
        throw new Error('network unreachable');
      }
      state.connected = true;
      // The transport reports the connect, as SIP.js does.
      keeper.onConnect();
    },
    register: async () => {
      log.push('register');
      if (registerFails) throw registerFails;
      state.registered = true;
    },
    notify: (registration, reason) => log.push(`${registration}: ${reason}`),
    schedule: (callback, delayMs) => { const entry = { callback, delayMs }; timers.push(entry); return entry; },
    cancelSchedule: (handle) => { const index = timers.findIndex((entry) => entry === handle); if (index >= 0) timers.splice(index, 1); },
    isPending: (error) => error instanceof PendingError,
  });

  const fire = () => {
    const next = timers.shift();
    if (!next) throw new Error('no timer armed');
    next.callback();
    return next.delayMs;
  };

  return {
    keeper,
    state,
    log,
    timers,
    fire,
    failReconnects: (times: number) => { reconnectFails = times; },
    failRegister: (error: Error | null) => { registerFails = error; },
  };
}

test('back-off doubles from one second and settles at thirty', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map(reconnectDelayMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('start registers once the transport is up, and a drop is reconnected and re-registered', async () => {
  const h = harness();
  await h.keeper.start();
  assert.deepEqual(h.log, ['register']);
  assert.equal(h.state.registered, true);

  // The socket dies the way a network change kills it.
  h.state.connected = false;
  h.state.registered = false;
  h.keeper.onDisconnect(new Error('socket closed'));
  assert.equal(h.log[1], 'Reconnecting: connection lost: socket closed', 'the UI is told at once, as reconnecting rather than lost');
  assert.equal(h.timers.length, 1);
  assert.equal(h.fire(), 1000, 'first retry after a second');
  await Promise.resolve();
  assert.deepEqual(h.log.slice(2), ['reconnect', 'register']);
  assert.equal(h.state.registered, true);
});

test('failed reconnects back off and keep trying; a later success registers', async () => {
  const h = harness();
  await h.keeper.start();
  h.state.connected = false;
  h.state.registered = false;
  h.failReconnects(3);
  h.keeper.onDisconnect(new Error('gone'));

  const delays: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    delays.push(h.fire());
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.equal(h.log.filter((entry) => entry === 'reconnect').length, 3);
  assert.equal(h.timers.length, 1, 'another attempt is armed after each failure');

  delays.push(h.fire());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delays[3], 8000);
  assert.equal(h.state.registered, true);
  assert.equal(h.timers.length, 0, 'nothing more to do once registered');
});

test('a second disconnect while a retry is armed does not stack timers', async () => {
  const h = harness();
  await h.keeper.start();
  h.state.connected = false;
  h.keeper.onDisconnect(new Error('a'));
  h.keeper.onDisconnect(new Error('b'));
  assert.equal(h.timers.length, 1);
});

test('after stop, a dropped socket stays dropped', async () => {
  const h = harness();
  await h.keeper.start();
  h.keeper.stop();
  h.state.connected = false;
  h.keeper.onDisconnect(new Error('closed by us'));
  assert.equal(h.timers.length, 0);
  assert.equal(h.log.length, 1, 'no unregistered notice after sign-out');
  await h.keeper.refresh();
  assert.equal(h.log.length, 1);
});

test('refresh reconnects immediately when the socket is down and re-registers when only the registration lapsed', async () => {
  const h = harness();
  await h.keeper.start();

  h.state.connected = false;
  h.state.registered = false;
  await h.keeper.refresh();
  assert.deepEqual(h.log.slice(1), ['reconnect', 'register'], 'no waiting for a timer when the person is looking at the app');

  h.state.registered = false;
  await h.keeper.refresh();
  assert.equal(h.log.at(-1), 'register');

  const before = h.log.length;
  await h.keeper.refresh();
  assert.equal(h.log.length, before + 1, 'explicit refresh checks the server even when local flags look live');
});

test('refresh that cannot reconnect reports it and falls back to the timer', async () => {
  const h = harness();
  await h.keeper.start();
  h.state.connected = false;
  h.failReconnects(1);
  await h.keeper.refresh();
  assert.equal(h.log.at(-1), 'Reconnecting: refresh: network unreachable');
  assert.equal(h.timers.length, 1);
});

test('a REGISTER already in flight is not an error; a refused one is reported', async () => {
  const h = harness();
  h.failRegister(new PendingError('pending'));
  await h.keeper.start();
  assert.deepEqual(h.log, ['register'], 'pending is silent: the registerer will report the outcome');

  h.failRegister(new Error('403 Forbidden'));
  h.state.registered = false;
  await h.keeper.refresh();
  assert.equal(h.log.at(-1), 'Reconnecting: refresh: 403 Forbidden');
});

test('onConnect while already registered does nothing', async () => {
  const h = harness();
  await h.keeper.start();
  h.keeper.onConnect();
  assert.deepEqual(h.log, ['register']);
});
test('a failed REGISTER retries even while its WebSocket is connected', async () => {
  const h = harness();
  h.failRegister(new Error('503'));
  await h.keeper.start();
  assert.equal(h.state.connected, true);
  assert.equal(h.timers.length, 1);
  h.failRegister(null);
  h.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.registered, true);
  assert.equal(h.log.filter((line) => line === 'register').length, 2);
});

test('an asynchronous registrar rejection arms recovery', async () => {
  const h = harness();
  await h.keeper.start();
  h.state.registered = false;
  h.keeper.onUnregistered();
  assert.equal(h.timers.length, 1);
  h.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.registered, true);
});

test('a socket drop forces a REGISTER even if SIP.js still reports Registered', async () => {
  const h = harness();
  await h.keeper.start();
  h.state.connected = false;
  h.keeper.onDisconnect();
  h.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.log.filter((line) => line === 'register').length, 2);
});

test('stop removes a pending retry and invalidates an already queued callback', async () => {
  const h = harness();
  await h.keeper.start();
  h.state.connected = false;
  h.keeper.onDisconnect();
  const pending = h.timers[0];
  assert.ok(pending);
  const late = pending.callback;
  h.keeper.stop();
  assert.equal(h.timers.length, 0);
  late();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.log.filter((line) => line === 'reconnect').length, 0);
});


test('explicit foreground refresh validates a supposedly live registration', async () => {
  const h = harness();
  await h.keeper.start();
  await h.keeper.refresh();
  assert.equal(h.log.filter(line => line === 'register').length, 2,
    'OS migration can leave both local state flags true while the server contact is dead');
});

test('temporary REGISTER rejection after Unregistered preserves a call through recovery', async () => {
  const h = harness();
  await h.keeper.start();
  h.state.registered = false;
  h.keeper.onUnregistered(); // SIP.js emits this before onReject, even with WSS up.
  h.keeper.onRejected(503, 'Authentication service unavailable');
  assert.equal(h.log.some(line => line.startsWith('Unregistered:')), false);
  assert.equal(h.log.at(-1), 'Reconnecting: 503 Authentication service unavailable');
  assert.equal(h.timers.length, 1);
  h.fire();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.registered, true);
  assert.equal(h.timers.length, 0);
});

for (const status of [401, 403]) test(`final ${status} preserves bounded recovery while HTTPS credentials renew`, async () => {
  const h = harness();
  await h.keeper.start();
  h.state.registered = false;
  h.keeper.onUnregistered();
  h.keeper.onRejected(status, 'Forbidden');
  assert.equal(h.log.at(-1), `Reconnecting: ${status} Forbidden`);
  assert.equal(h.log.some(line => line.startsWith('Unregistered:')), false);
  assert.equal(h.timers.length, 1);
});

test('late registration callbacks after stop cannot restart recovery or notify the UI', async () => {
  const h = harness();
  await h.keeper.start();
  h.keeper.stop();
  h.keeper.onUnregistered();
  h.keeper.onRejected(503, 'Unavailable');
  assert.deepEqual(h.log, ['register']);
  assert.equal(h.timers.length, 0);
});
