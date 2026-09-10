import type { StoredCallEvent } from '../calling/call-event-store.js';
import type { ExtensionUser } from '../organizations/pbx.js';
import { normalizeE164 } from '../organizations/tenancy.js';
import type { VoiceRouteAuthorization } from '../calling/voice-route-token.js';

/**
 * Turns a FreeSWITCH call record into the tenant's call events.
 *
 * mod_json_cdr posts one record per leg when the leg ends. Before inbound
 * moved to Vocivo's own edge the carrier's webhooks fed the call history and
 * the event log; on the edge nothing did, so Reports, the Event log and the
 * apps' Recents were empty for every call that went through it. Each leg
 * becomes the same three events the webhooks produced — initiated, answered
 * (when it was), hangup — with the same vocabulary `callHistoryFromEvents`
 * already reads, so nothing downstream had to learn a second shape.
 */

export type SipCdrRecord = {
  variables?: Record<string, unknown>;
  [key: string]: unknown;
};

export type SipCdrLeg = {
  uuid: string;
  /** The leg this one belongs with: its own uuid for an A-leg, the originating leg's for a B-leg. */
  sessionId: string;
  direction: 'inbound' | 'outbound';
  fromUser: string;
  toUser: string;
  callerNumber: string;
  destinationNumber: string;
  startedAt: string;
  answeredAt: string;
  endedAt: string;
  hangupCause: string;
  billSeconds: number;
  flow: string;
  organizationId: string;
  did: string;
  routeToken: string;
  destinationExtension: string;
  destinationName: string;
  gateway: string;
};

function text(variables: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    const value = variables[name];
    if (typeof value === 'string' && value.trim()) return decode(value.trim());
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** mod_json_cdr can percent-encode values; a value that decodes cleanly is used decoded. */
function decode(value: string) {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function millisecondsToIso(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function epochToIso(variables: Record<string, unknown>, microsName: string, secondsName: string) {
  return millisecondsToIso(Math.round(Number(text(variables, microsName)) / 1000))
    || millisecondsToIso(Number(text(variables, secondsName)) * 1000);
}

/** A number is what a phone dials; a SIP username is not. */
function asNumber(value: string) {
  const cleaned = value.replace(/^sip:/i, '').split('@')[0].replace(/[\s()-]/g, '');
  if (!/^\+?\d{6,15}$/.test(cleaned)) return '';
  return normalizeE164(cleaned.startsWith('+') ? cleaned : `+${cleaned}`);
}

/**
 * Kamailio's record of a call it relayed itself (extension to extension, which
 * never reaches FreeSWITCH): one small line per event, joined by Call-ID.
 * `invite` carries the X-Vocivo headers; the rest carry only the parties.
 */
export type KamailioCdrEvent = {
  event: 'invite' | 'answered' | 'bye' | 'cancel' | 'failed';
  callId: string;
  from: string;
  to: string;
  requestUser: string;
  flow: string;
  routeToken: string;
  destinationExtension: string;
  destinationName: string;
  at: string;
};

/** Kamailio prints a missing header as "<null>"; that is not a value. */
function kamailioText(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  return text === '<null>' ? '' : text;
}

export function parseKamailioCdr(body: unknown): KamailioCdrEvent | null {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  if (!record || record.source !== 'kamailio') return null;
  const event = kamailioText(record.event);
  const callId = kamailioText(record.callId);
  const at = millisecondsToIso(Number(kamailioText(record.at)) * 1000);
  if (!['invite', 'answered', 'bye', 'cancel', 'failed'].includes(event) || !callId || !at) return null;
  return {
    event: event as KamailioCdrEvent['event'],
    callId: callId.slice(0, 200),
    from: kamailioText(record.from).slice(0, 120),
    to: kamailioText(record.to).slice(0, 120),
    requestUser: kamailioText(record.requestUser).slice(0, 120),
    flow: kamailioText(record.flow).toLowerCase().slice(0, 40),
    routeToken: kamailioText(record.routeToken).slice(0, 2000),
    destinationExtension: kamailioText(record.destinationExtension).slice(0, 16),
    destinationName: kamailioText(record.destinationName).slice(0, 80),
    at,
  };
}

export function kamailioCdrEvents(record: KamailioCdrEvent, context: CdrContext): StoredCallEvent[] {
  const source = extensionBySip(context.extensions, record.from) || extensionBySip(context.extensions, record.to);
  const target = extensionBySip(context.extensions, record.requestUser) || extensionBySip(context.extensions, record.to);
  const route = record.event === 'invite' ? context.route : null;
  if (route && (route.flow !== 'internal'
    || route.sourceExtensionId && route.sourceExtensionId !== source?.id
    || route.destinationExtensionId && route.destinationExtensionId !== target?.id)) return [];
  const organizationId = route?.organizationId || source?.organizationId || target?.organizationId || '';
  // Tenant evidence must agree; a valid signature alone cannot move a call
  // between companies. Reject conflicting parties as well as route metadata.
  if (!organizationId || [source?.organizationId, target?.organizationId, route?.organizationId]
    .some((owner) => owner && owner !== organizationId)) return [];
  const base = {
    type: 'webhook' as const,
    call_session_id: record.callId,
    call_leg_id: record.callId,
    call_control_id: record.callId,
    direction: 'outgoing' as const,
    from: source ? `sip:${source.sipUsername}@vocivo` : record.from,
    to: target ? `sip:${target.sipUsername}@vocivo` : record.requestUser || record.to,
    organizationId,
    flow: record.flow || route?.flow || 'internal',
    routeId: route?.routeId,
    sourceExtensionId: route?.sourceExtensionId || (record.event === 'invite' ? source?.id : undefined),
    sourceExtension: route?.callerExtension || (record.event === 'invite' ? source?.extension : undefined),
    sourceName: route?.callerName || (record.event === 'invite' ? source?.name : undefined),
    destinationExtensionId: route?.destinationExtensionId || (record.event === 'invite' ? target?.id : undefined),
    destinationExtension: route?.destinationExtension || record.destinationExtension || (record.event === 'invite' ? target?.extension : undefined),
    destinationName: route?.destinationName || record.destinationName || (record.event === 'invite' ? target?.name : undefined),
  };
  switch (record.event) {
    case 'invite': return [{ ...base, id: `${record.callId}:initiated`, name: 'call.initiated', event_timestamp: record.at }];
    case 'answered': return [{ ...base, id: `${record.callId}:answered`, name: 'call.answered', event_timestamp: record.at }];
    case 'bye': return [{ ...base, id: `${record.callId}:hangup`, name: 'call.hangup', event_timestamp: record.at, hangup_cause: 'NORMAL_CLEARING' }];
    case 'cancel': return [{ ...base, id: `${record.callId}:hangup`, name: 'call.hangup', event_timestamp: record.at, hangup_cause: 'ORIGINATOR_CANCEL' }];
    default: return [{ ...base, id: `${record.callId}:hangup`, name: 'call.hangup', event_timestamp: record.at, hangup_cause: 'NO_ANSWER' }];
  }
}

export function parseSipCdr(body: unknown): SipCdrLeg | null {
  const record = body && typeof body === 'object' ? body as SipCdrRecord : null;
  const variables = record?.variables && typeof record.variables === 'object' ? record.variables as Record<string, unknown> : null;
  if (!variables) return null;
  const uuid = text(variables, 'uuid', 'call_uuid');
  if (!uuid) return null;
  const direction = text(variables, 'direction').toLowerCase() === 'outbound' ? 'outbound' : 'inbound';
  const fromUser = text(variables, 'sip_from_user', 'caller_id_number');
  const toUser = text(variables, 'sip_to_user', 'destination_number');
  const startedAt = epochToIso(variables, 'start_uepoch', 'start_epoch');
  if (!startedAt) return null;
  const gateway = text(variables, 'sip_gateway_name', 'sip_gateway');
  return {
    uuid,
    sessionId: text(variables, 'originating_leg_uuid', 'signal_bond', 'bridge_uuid') || uuid,
    direction,
    fromUser,
    toUser,
    callerNumber: asNumber(text(variables, 'vocivo_from', 'effective_caller_id_number', 'caller_id_number', 'sip_from_user')),
    destinationNumber: asNumber(text(variables, 'vocivo_did', 'sip_h_X-Vocivo-Destination', 'destination_number', 'sip_to_user')),
    startedAt,
    answeredAt: epochToIso(variables, 'answer_uepoch', 'answer_epoch'),
    endedAt: epochToIso(variables, 'end_uepoch', 'end_epoch') || startedAt,
    hangupCause: text(variables, 'hangup_cause').toUpperCase() || 'NORMAL_CLEARING',
    billSeconds: Math.max(0, Number(text(variables, 'billsec')) || 0),
    flow: text(variables, 'sip_h_X-Vocivo-Flow', 'vocivo_flow').toLowerCase(),
    organizationId: text(variables, 'vocivo_org'),
    did: asNumber(text(variables, 'vocivo_did')),
    routeToken: text(variables, 'sip_h_X-Vocivo-Route-Token', 'vocivo_route_token'),
    destinationExtension: text(variables, 'sip_h_X-Vocivo-Destination-Extension'),
    destinationName: text(variables, 'sip_h_X-Vocivo-Destination-Name'),
    gateway,
  };
}

export type CdrContext = {
  /** Every extension the platform knows, so a SIP username finds its owner. */
  extensions: ExtensionUser[];
  /** The route the app reserved for this call, when the leg carried its token. */
  route: VoiceRouteAuthorization | null;
};

function extensionBySip(extensions: ExtensionUser[], user: string) {
  const wanted = user.replace(/^sip:/i, '').split('@')[0].toLowerCase();
  return wanted ? extensions.find((entry) => entry.sipUsername?.toLowerCase() === wanted) : undefined;
}

/**
 * Which kind of leg this is and who it belongs to.
 *
 * - The carrier's leg into a DID carries `vocivo_org` and `X-Vocivo-Flow: inbound`.
 * - A leg FreeSWITCH placed to a phone (ringing an extension) has the
 *   extension's SIP username as its destination.
 * - A leg an app placed carries the route token the API issued for it, which
 *   names the tenant, the caller's extension and the destination.
 * - A leg to the carrier's gateway is the outbound destination leg.
 */
export function sipCdrEvents(leg: SipCdrLeg, context: CdrContext): StoredCallEvent[] {
  const source = extensionBySip(context.extensions, leg.fromUser);
  const target = extensionBySip(context.extensions, leg.toUser);
  const route = context.route;
  const organizationId = leg.organizationId || route?.organizationId || source?.organizationId || target?.organizationId || '';
  // Tenant evidence must agree; a valid signature alone cannot move a call
  // between companies. Reject conflicting parties as well as route metadata.
  if (!organizationId || [source?.organizationId, target?.organizationId, route?.organizationId]
    .some((owner) => owner && owner !== organizationId)) return [];

  let flow: string;
  let direction: 'incoming' | 'outgoing';
  let from: string;
  let to: string;
  if (leg.flow === 'inbound' || (leg.direction === 'inbound' && leg.did)) {
    flow = 'inbound_root';
    direction = 'incoming';
    from = leg.callerNumber || leg.fromUser;
    to = leg.did || leg.destinationNumber || leg.toUser;
  } else if (leg.gateway || (leg.direction === 'outbound' && leg.destinationNumber && !target)) {
    flow = 'outbound_destination';
    direction = 'outgoing';
    from = leg.callerNumber || route?.callerId || leg.fromUser;
    to = leg.destinationNumber || route?.destination || leg.toUser;
  } else if (leg.flow === 'internal' || route?.flow === 'internal') {
    flow = 'internal';
    direction = leg.direction === 'inbound' ? 'outgoing' : 'incoming';
    from = source ? `sip:${source.sipUsername}@vocivo` : leg.fromUser;
    to = target ? `sip:${target.sipUsername}@vocivo` : leg.toUser;
  } else if (leg.direction === 'outbound' && target) {
    // FreeSWITCH ringing a phone on behalf of an inbound call or a transfer.
    flow = 'agent';
    direction = 'outgoing';
    from = leg.callerNumber || leg.fromUser;
    to = `sip:${target.sipUsername}@vocivo`;
  } else if (leg.flow === 'outbound' || route?.flow === 'outbound') {
    // The app's own leg of an outbound call; the destination leg is the anchor.
    flow = 'outbound_client';
    direction = 'outgoing';
    from = source ? `sip:${source.sipUsername}@vocivo` : leg.fromUser;
    to = leg.destinationNumber || route?.destination || leg.toUser;
  } else {
    flow = leg.direction === 'inbound' ? 'inbound_root' : 'agent';
    direction = leg.direction === 'inbound' ? 'incoming' : 'outgoing';
    from = leg.callerNumber || leg.fromUser;
    to = leg.destinationNumber || leg.toUser;
  }

  const base = {
    type: 'webhook' as const,
    call_session_id: leg.sessionId,
    call_leg_id: leg.uuid,
    call_control_id: leg.uuid,
    direction,
    from,
    to,
    organizationId,
    flow,
    routeId: route?.routeId,
    sourceExtensionId: route?.sourceExtensionId || source?.id,
    sourceExtension: route?.callerExtension || source?.extension,
    sourceName: route?.callerName || source?.name,
    destinationExtensionId: route?.destinationExtensionId || target?.id,
    destinationExtension: route?.destinationExtension || leg.destinationExtension || target?.extension,
    destinationName: route?.destinationName || leg.destinationName || target?.name,
  };
  const events: StoredCallEvent[] = [
    { ...base, id: `${leg.uuid}:initiated`, name: 'call.initiated', event_timestamp: leg.startedAt },
  ];
  if (leg.answeredAt) events.push({ ...base, id: `${leg.uuid}:answered`, name: 'call.answered', event_timestamp: leg.answeredAt });
  events.push({ ...base, id: `${leg.uuid}:hangup`, name: 'call.hangup', event_timestamp: leg.endedAt, hangup_cause: leg.hangupCause });
  return events;
}
