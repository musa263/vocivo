import assert from 'node:assert/strict';
import test from 'node:test';
import { callHistoryFromEvents } from '../calling/call-history.js';
import type { ExtensionUser } from '../organizations/pbx.js';
import { kamailioCdrEvents, parseKamailioCdr, parseSipCdr, sipCdrEvents } from './sip-cdr.js';
import type { VoiceRouteAuthorization } from '../calling/voice-route-token.js';

const alice: ExtensionUser = { id: 'e1', extension: '2001', name: 'Alice', email: '', mobile: '', organizationId: 'acme', department: 'Sales', role: 'user', sipUsername: 'alice', status: 'active' };
const bob: ExtensionUser = { id: 'e2', extension: '2002', name: 'Bob', email: '', mobile: '', organizationId: 'acme', department: 'Support', role: 'user', sipUsername: 'bob', status: 'active' };
const extensions = [alice, bob];

function record(variables: Record<string, string>) {
  return { core_uuid: 'core', channel_data: { state: 'CS_REPORTING' }, variables, app_log: {}, callflow: [] };
}

test('a carrier leg into a DID becomes an incoming call in the tenant that owns the number', () => {
  const leg = parseSipCdr(record({
    uuid: 'a-leg', direction: 'inbound', sip_from_user: '+15559876543', sip_to_user: '+18447161777',
    'sip_h_X-Vocivo-Flow': 'inbound', vocivo_org: 'acme', vocivo_did: '+18447161777', vocivo_from: '+15559876543',
    start_epoch: '1756900000', answer_epoch: '1756900002', end_epoch: '1756900032', hangup_cause: 'NORMAL_CLEARING', billsec: '30',
  }));
  assert.ok(leg);
  const events = sipCdrEvents(leg!, { extensions, route: null });
  assert.deepEqual(events.map((event) => event.name), ['call.initiated', 'call.answered', 'call.hangup']);
  assert.equal(events[0].organizationId, 'acme');
  assert.equal(events[0].flow, 'inbound_root');
  assert.equal(events[0].direction, 'incoming');
  assert.equal(events[0].from, '+15559876543');
  assert.equal(events[0].to, '+18447161777');
  assert.equal(events[0].call_session_id, 'a-leg');
  assert.equal(events[2].hangup_cause, 'NORMAL_CLEARING');
  assert.equal(events[0].event_timestamp, '2025-09-03T11:46:40.000Z');

  const history = callHistoryFromEvents(events, 'acme');
  assert.equal(history.length, 1);
  assert.equal(history[0].direction, 'incoming');
  assert.equal(history[0].destination_number, '+15559876543');
  assert.equal(history[0].status, 'completed');
  assert.equal(history[0].duration_seconds, 30);
});

test('the leg FreeSWITCH places to ring an extension joins the inbound call and names the extension', () => {
  const leg = parseSipCdr(record({
    uuid: 'b-leg', direction: 'outbound', originating_leg_uuid: 'a-leg', sip_from_user: '+15559876543', sip_to_user: 'alice',
    start_epoch: '1756900001', end_epoch: '1756900032', hangup_cause: 'NORMAL_CLEARING',
  }))!;
  const events = sipCdrEvents(leg, { extensions, route: null });
  assert.equal(events[0].organizationId, 'acme', 'the extension it rang says whose call it is');
  assert.equal(events[0].flow, 'agent');
  assert.equal(events[0].call_session_id, 'a-leg');
  assert.equal(events[0].destinationExtensionId, 'e1');
  assert.equal(events[0].destinationName, 'Alice');
  assert.equal(events.length, 2, 'unanswered: no answered event');
});

test('an outbound call from an app is an outgoing call anchored on the carrier leg, attributed to the caller', () => {
  const route: VoiceRouteAuthorization = {
    routeId: 'vc_1', organizationId: 'acme', destination: '+14155550100', callerId: '+18447161777', callerName: 'Alice',
    callerExtension: '2001', sourceExtensionId: 'e1', flow: 'outbound', expiresAt: 1,
  };
  const client = parseSipCdr(record({
    uuid: 'a-leg', direction: 'inbound', sip_from_user: 'alice', sip_to_user: '+14155550100',
    'sip_h_X-Vocivo-Flow': 'outbound', 'sip_h_X-Vocivo-Route-Token': 'token', 'sip_h_X-Vocivo-Destination': '+14155550100',
    start_epoch: '1756900100', answer_epoch: '1756900108', end_epoch: '1756900160', hangup_cause: 'NORMAL_CLEARING',
  }))!;
  const carrier = parseSipCdr(record({
    uuid: 'b-leg', direction: 'outbound', originating_leg_uuid: 'a-leg', sip_gateway_name: 'telnyx', vocivo_route_token: 'token',
    sip_from_user: '+18447161777', sip_to_user: '+14155550100', destination_number: '+14155550100', effective_caller_id_number: '+18447161777',
    start_epoch: '1756900100', answer_epoch: '1756900108', end_epoch: '1756900160', hangup_cause: 'NORMAL_CLEARING',
  }))!;
  assert.equal(carrier.routeToken, 'token', 'the dialplan exports the route token to the carrier leg');
  const events = [...sipCdrEvents(client, { extensions, route }), ...sipCdrEvents(carrier, { extensions, route })];
  assert.equal(events[0].flow, 'outbound_client');
  assert.equal(events[0].sourceExtensionId, 'e1');
  assert.equal(events[0].routeId, 'vc_1');
  const destination = events.find((event) => event.flow === 'outbound_destination')!;
  assert.equal(destination.to, '+14155550100');
  assert.equal(destination.direction, 'outgoing');
  assert.equal(destination.call_session_id, 'a-leg');

  const history = callHistoryFromEvents(events, 'acme', 100, { extensionId: 'e1', directory: [{ id: 'e1', extension: '2001', name: 'Alice', sipUsername: 'alice' }] });
  assert.equal(history.length, 1);
  assert.equal(history[0].direction, 'outgoing');
  assert.equal(history[0].destination_number, '+14155550100');
  assert.equal(history[0].duration_seconds, 52);
  const bobsView = callHistoryFromEvents(events, 'acme', 100, { extensionId: 'e2', directory: [{ id: 'e2', extension: '2002', name: 'Bob', sipUsername: 'bob' }] });
  assert.equal(bobsView.length, 0, "Bob did not take part in Alice's call");
});

test('an internal call between two extensions is recorded as internal with both parties', () => {
  const leg = parseSipCdr(record({
    uuid: 'a-leg', direction: 'inbound', sip_from_user: 'alice', sip_to_user: 'bob',
    'sip_h_X-Vocivo-Flow': 'internal', 'sip_h_X-Vocivo-Destination-Extension': '2002', 'sip_h_X-Vocivo-Destination-Name': 'Bob',
    start_epoch: '1756900200', answer_epoch: '1756900203', end_epoch: '1756900260', hangup_cause: 'NORMAL_CLEARING',
  }))!;
  const events = sipCdrEvents(leg, { extensions, route: null });
  assert.equal(events[0].flow, 'internal');
  assert.equal(events[0].sourceExtensionId, 'e1');
  assert.equal(events[0].destinationExtensionId, 'e2');
  const forBob = callHistoryFromEvents(events, 'acme', 100, { extensionId: 'e2', directory: [{ id: 'e2', extension: '2002', name: 'Bob', sipUsername: 'bob' }] });
  assert.equal(forBob.length, 1);
  assert.equal(forBob[0].direction, 'incoming');
  assert.equal(forBob[0].destination_name, 'Alice');
  assert.equal(forBob[0].internal, true);
});

test('records that are not calls, or belong to nobody, produce nothing', () => {
  assert.equal(parseSipCdr({}), null);
  assert.equal(parseSipCdr({ variables: { direction: 'inbound' } }), null, 'no uuid');
  assert.equal(parseSipCdr({ variables: { uuid: 'x' } }), null, 'no start time');
  const stranger = parseSipCdr(record({ uuid: 's', direction: 'inbound', sip_from_user: 'scanner', sip_to_user: '100', start_epoch: '1756900300', end_epoch: '1756900300', hangup_cause: 'CALL_REJECTED' }))!;
  assert.deepEqual(sipCdrEvents(stranger, { extensions, route: null }), []);
});

test('percent-encoded values are decoded and microsecond epochs are preferred', () => {
  const leg = parseSipCdr(record({
    uuid: 'a', direction: 'inbound', sip_from_user: '%2B15559876543', sip_to_user: '%2B18447161777', vocivo_org: 'acme',
    vocivo_did: '%2B18447161777', 'sip_h_X-Vocivo-Flow': 'inbound', start_uepoch: '1756900000123456', end_uepoch: '1756900001123456',
  }))!;
  assert.equal(leg.did, '+18447161777');
  assert.equal(leg.startedAt, '2025-09-03T11:46:40.123Z');
  assert.equal(leg.endedAt, '2025-09-03T11:46:41.123Z');
  assert.equal(leg.answeredAt, '');
});

test("Kamailio's records of an extension-to-extension call join into one internal call", () => {
  const invite = parseKamailioCdr({ source: 'kamailio', event: 'invite', callId: 'abc@ws', from: 'alice', to: 'bob', requestUser: 'bob', flow: 'internal', routeToken: '<null>', destinationExtension: '2002', destinationName: 'Bob', at: 1756900500 })!;
  const answered = parseKamailioCdr({ source: 'kamailio', event: 'answered', callId: 'abc@ws', from: 'alice', to: 'bob', requestUser: 'bob', flow: '<null>', routeToken: '<null>', destinationExtension: '<null>', destinationName: '<null>', at: 1756900504 })!;
  const bye = parseKamailioCdr({ source: 'kamailio', event: 'bye', callId: 'abc@ws', from: 'bob', to: 'alice', requestUser: 'alice', flow: '<null>', routeToken: '<null>', destinationExtension: '<null>', destinationName: '<null>', at: 1756900564 })!;
  assert.equal(invite.routeToken, '', 'Kamailio prints a missing header as <null>');
  const context = { extensions, route: null };
  const events = [...kamailioCdrEvents(invite, context), ...kamailioCdrEvents(answered, context), ...kamailioCdrEvents(bye, context)];
  assert.deepEqual(events.map((event) => event.name), ['call.initiated', 'call.answered', 'call.hangup']);
  assert.ok(events.every((event) => event.organizationId === 'acme' && event.call_session_id === 'abc@ws'));
  assert.equal(events[0].sourceExtensionId, 'e1');
  assert.equal(events[0].destinationExtensionId, 'e2');
  assert.equal(events[0].destinationName, 'Bob');

  const alicesView = callHistoryFromEvents(events, 'acme', 100, { extensionId: 'e1', directory: [{ id: 'e1', extension: '2001', name: 'Alice', sipUsername: 'alice' }] });
  assert.equal(alicesView.length, 1);
  assert.equal(alicesView[0].direction, 'outgoing');
  assert.equal(alicesView[0].destination_name, 'Bob');
  assert.equal(alicesView[0].duration_seconds, 60);
  assert.equal(alicesView[0].status, 'completed');
  const bobsView = callHistoryFromEvents(events, 'acme', 100, { extensionId: 'e2', directory: [{ id: 'e2', extension: '2002', name: 'Bob', sipUsername: 'bob' }] });
  assert.equal(bobsView[0].direction, 'incoming');
  assert.equal(bobsView[0].destination_name, 'Alice');
});

test('a cancelled or unanswered relayed call is a missed call, and junk is ignored', () => {
  const invite = parseKamailioCdr({ source: 'kamailio', event: 'invite', callId: 'c1', from: 'alice', to: 'bob', requestUser: 'bob', flow: 'internal', at: 1756900600 })!;
  const cancel = parseKamailioCdr({ source: 'kamailio', event: 'cancel', callId: 'c1', from: 'alice', to: 'bob', requestUser: 'bob', at: 1756900610 })!;
  const events = [...kamailioCdrEvents(invite, { extensions, route: null }), ...kamailioCdrEvents(cancel, { extensions, route: null })];
  assert.equal(events[1].hangup_cause, 'ORIGINATOR_CANCEL');
  const bobsView = callHistoryFromEvents(events, 'acme', 100, { extensionId: 'e2', directory: [{ id: 'e2', extension: '2002', name: 'Bob', sipUsername: 'bob' }] });
  assert.equal(bobsView[0].status, 'missed');

  assert.equal(parseKamailioCdr({ source: 'kamailio', event: 'dance', callId: 'c1', at: 1 }), null);
  assert.equal(parseKamailioCdr({ source: 'kamailio', event: 'bye', callId: '', at: 1 }), null);
  assert.equal(parseKamailioCdr({ source: 'kamailio', event: 'bye', callId: 'c', at: 'soon' }), null);
  assert.equal(parseKamailioCdr({ variables: { uuid: 'x' } }), null, 'a FreeSWITCH record is not a Kamailio one');
});

test('out-of-range CDR timestamps are unreadable records, not endlessly retried exceptions', () => {
  for (const at of ['1e100', '8640000000001', 'Infinity']) {
    assert.equal(parseKamailioCdr({ source: 'kamailio', event: 'invite', callId: 'bad-time', at }), null);
    assert.equal(parseSipCdr(record({ uuid: 'bad-time', start_epoch: at })), null);
  }
  const fallback = parseSipCdr(record({ uuid: 'fallback', start_uepoch: '1e100', start_epoch: '1756900000', end_epoch: '1e100' }));
  assert.equal(fallback?.startedAt, '2025-09-03T11:46:40.000Z');
  assert.equal(fallback?.endedAt, fallback?.startedAt);
});

test('CDR tenant evidence and route participants must agree', () => {
  const event = parseKamailioCdr({ source: 'kamailio', event: 'invite', callId: 'isolated', from: 'alice', to: 'bob', requestUser: 'bob', at: 1756900500 })!;
  const route: VoiceRouteAuthorization = { routeId: 'route-fixture', organizationId: 'acme', destination: 'sip:bob@vocivo', callerId: '', callerName: 'Alice', callerExtension: '2001', sourceExtensionId: 'e1', destinationExtensionId: 'e2', flow: 'internal', expiresAt: 1 };
  assert.equal(kamailioCdrEvents(event, { extensions, route }).length, 1);
  for (const invalid of [{ ...route, organizationId: 'other' }, { ...route, sourceExtensionId: 'unrelated' }, { ...route, destinationExtensionId: 'unrelated' }]) {
    assert.deepEqual(kamailioCdrEvents(event, { extensions, route: invalid }), []);
  }
  assert.deepEqual(kamailioCdrEvents(event, { extensions: [alice, { ...bob, organizationId: 'other' }], route: null }), []);
  const leg = parseSipCdr(record({ uuid: 'conflict', sip_from_user: 'alice', sip_to_user: 'bob', vocivo_org: 'other', start_epoch: '1756900500' }))!;
  assert.deepEqual(sipCdrEvents(leg, { extensions, route: null }), []);
});
