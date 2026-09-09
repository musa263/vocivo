import assert from 'node:assert/strict';
import test from 'node:test';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createSipWakeupHandler } from './routes/voice-sip-wakeup.js';

test('SIP wakeup replies before directory and push I/O finish and preserves the call ID', async () => {
  const oldSecret = process.env.SIP_EDGE_SECRET;
  process.env.SIP_EDGE_SECRET = 'test-edge-secret';
  let release!: (rows: never[]) => void;
  const directory = new Promise<never[]>((resolve) => { release = resolve; });
  let background: Promise<unknown> | undefined;
  let mobileStarted = false;
  let status = 0;
  let body: unknown;
  const handler = createSipWakeupHandler({
    listExtensions: async () => directory,
    afterResponse: (_label, task) => { background = task; },
    sendIncomingCallWebPush: async () => ({ sent: 0, unavailable: false }),
    wakeMobileDevices: async () => {
      mobileStarted = true;
      return { attempted: 0, sent: 0, pruned: 0, unavailable: { ios: false, android: false }, failures: [] };
    },
  });
  const res = {
    setHeader() {},
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as VercelResponse;
  try {
    await handler({ method: 'POST', headers: { authorization: 'Bearer test-edge-secret' }, body: { username: 'ext-alice', callId: 'sip-call@edge' } } as VercelRequest, res);
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, uuid: 'sip-call@edge', queued: true });
    assert.equal(mobileStarted, false);
    assert.ok(background);
    release([]);
    await background;
    assert.equal(mobileStarted, true);
  } finally {
    release([]);
    if (oldSecret === undefined) delete process.env.SIP_EDGE_SECRET;
    else process.env.SIP_EDGE_SECRET = oldSecret;
  }
});

test('the handset rings to the caller deadline the edge sent, not to its own clock', async () => {
  const oldSecret = process.env.SIP_EDGE_SECRET;
  process.env.SIP_EDGE_SECRET = 'test-edge-secret';
  const calls: { ttlSeconds?: number }[] = [];
  let status = 0;
  let body: unknown;
  const handler = createSipWakeupHandler({
    listExtensions: async () => [],
    afterResponse: (_label, task) => { void task; },
    sendIncomingCallWebPush: async () => ({ sent: 0, unavailable: false }),
    wakeMobileDevices: async (input: { call: { ttlSeconds?: number } }) => {
      calls.push(input.call);
      return { attempted: 0, sent: 0, pruned: 0, unavailable: { ios: false, android: false }, failures: [] };
    },
  });
  const res = {
    setHeader() {},
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as VercelResponse;
  const post = async (extra: Record<string, unknown>) => {
    let background: Promise<unknown> | undefined;
    const capture = createSipWakeupHandler({
      listExtensions: async () => [],
      afterResponse: (_label, task) => { background = task; },
      sendIncomingCallWebPush: async () => ({ sent: 0, unavailable: false }),
      wakeMobileDevices: async (input: { call: { ttlSeconds?: number } }) => {
        calls.push(input.call);
        return { attempted: 0, sent: 0, pruned: 0, unavailable: { ios: false, android: false }, failures: [] };
      },
    });
    await capture({ method: 'POST', headers: { authorization: 'Bearer test-edge-secret' }, body: { username: 'ext-alice', callId: 'c@edge', ...extra } } as VercelRequest, res);
    if (background) await background;
  };
  try {
    // The edge says the caller gives up in twelve seconds. Ringing for the full
    // forty-five would leave the handset ringing a call nobody is waiting on.
    await post({ ringUntil: Math.floor(Date.now() / 1000) + 12 });
    assert.equal(calls.at(-1)?.ttlSeconds, 12);

    // No deadline from an older edge: fall back to the platform maximum.
    await post({});
    assert.equal(calls.at(-1)?.ttlSeconds, 45);

    // Never longer than the maximum, however far off the supplied deadline is.
    await post({ ringUntil: Math.floor(Date.now() / 1000) + 6000 });
    assert.equal(calls.at(-1)?.ttlSeconds, 45);

    // Already over: do not wake the phone at all.
    const before = calls.length;
    await handler({ method: 'POST', headers: { authorization: 'Bearer test-edge-secret' }, body: { username: 'ext-alice', callId: 'c@edge', ringUntil: Math.floor(Date.now() / 1000) - 1 } } as VercelRequest, res);
    assert.equal(status, 200);
    assert.deepEqual(body, { woken: false, reason: 'the caller is no longer waiting' });
    assert.equal(calls.length, before, 'a caller who has already gone must not ring a phone');
  } finally {
    if (oldSecret === undefined) delete process.env.SIP_EDGE_SECRET;
    else process.env.SIP_EDGE_SECRET = oldSecret;
  }
});
