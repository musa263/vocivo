import assert from 'node:assert/strict';
import test from 'node:test';
import { reportCalls, analyzeCalls } from './call-report.js';
import type { StoredCallEvent } from '../calling/call-event-store.js';
const directory = [{ id: 'a', extension: '2000', name: 'Mousa', sipUsername: 'gencred-secret' }, { id: 'b', extension: '2001', name: 'Sam', sipUsername: 'gencred-other' }];
const start = Date.parse('2026-09-12T10:00:00Z');
function event(name: string, seconds: number, extra: Partial<StoredCallEvent> = {}): StoredCallEvent {
  return { id: `${name}-${seconds}`, name, type: 'webhook', event_timestamp: new Date(start + seconds * 1000).toISOString(), organizationId: 'company', call_session_id: 's', call_leg_id: 'a', flow: 'internal', from: 'sip:gencred-secret@example.test', to: 'sip:gencred-other@example.test', ...extra };
}
const report = (events: StoredCallEvent[]) => reportCalls(events, 'company', directory, start - 1, start + 86400_000);
test('deduplicates callbacks, excludes other tenants and resolves SIP identities', () => {
  const first = event('call.initiated', 0);
  const calls = report([event('call.hangup', 30), first, event('call.answered', 10), first, event('call.initiated', 2, { organizationId: 'other' })]);
  assert.equal(calls.length, 1); assert.equal(calls[0].durationSeconds, 20);
  assert.equal(calls[0].from, 'Mousa · Extension 2000'); assert.equal(calls[0].to, 'Sam · Extension 2001');
  assert.equal(calls[0].cost, null);
});
test('losing fork answer cannot make the caller answered; missing terminal is incomplete', () => {
  const calls = report([event('call.initiated', 0, { flow: 'inbound_root', direction: 'incoming' }), event('call.answered', 4, { flow: 'agent', call_leg_id: 'loser' }), event('call.hangup', 9, { hangup_cause: 'USER_BUSY' })]);
  assert.equal(calls[0].status, 'busy'); assert.equal(calls[0].answeredAt, null);
  assert.equal(report([event('call.initiated', 0), event('call.answered', 5)])[0].status, 'incomplete');
});
test('FreeSWITCH reciprocal parent/bridge IDs group into one inbound call', () => {
  const calls = report([event('call.initiated', 0, { flow: 'inbound_root', direction: 'incoming', call_session_id: 'b', call_leg_id: 'a' }),
    event('call.initiated', 1, { flow: 'outbound_destination', direction: 'outgoing', call_session_id: 'a', call_leg_id: 'b' })]);
  assert.equal(calls.length, 1); assert.equal(calls[0].direction, 'inbound');
});
test('parked internal answer is not destination answer and analytics honors chart timezone', () => {
  const calls = report([event('call.initiated', 0), event('call.answered', 1), event('call.initiated', 2, { flow: 'outbound_destination', call_leg_id: 'b' }), event('call.hangup', 20, { flow: 'outbound_destination', call_leg_id: 'b', hangup_cause: 'NO_ANSWER' })]);
  assert.equal(calls[0].status, 'no_answer'); assert.equal(calls[0].durationSeconds, 0);
  const stats = analyzeCalls(calls, 'Asia/Dubai', directory);
  assert.equal(stats.hours[14].calls, 1); assert.equal(stats.directions.internal, 1); assert.equal(stats.billing.unpricedCalls, 1);
});
test('invalid timestamps and uncorrelated terminal events cannot manufacture calls', () => {
  assert.deepEqual(report([event('call.initiated', 0, { event_timestamp: 'bad' }), event('call.hangup', 5)]), []);
});
test('a ringing loser does not replace the answering colleague in reports', () => {
  const calls = report([event('call.initiated', 0, { flow: 'inbound_root', direction: 'incoming', from: '+15551234567', to: '+15557654321' }),
    event('call.initiated', 1, { flow: 'agent', call_leg_id: 'loser', destinationExtensionId: 'a' }),
    event('call.answered', 2), event('call.answered', 4, { flow: 'agent', call_leg_id: 'winner', destinationExtensionId: 'b' }), event('call.hangup', 30)]);
  assert.equal(calls[0].destinationExtensionId, 'b');
  assert.equal(calls[0].from, '+15551234567');
  assert.equal(calls[0].to, 'Sam · Extension 2001');
});
