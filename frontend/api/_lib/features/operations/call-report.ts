import type { StoredCallEvent } from '../calling/call-event-store.js';
import type { HistoryDirectoryEntry } from '../calling/call-history.js';

export type ReportCall = {
  id: string; startedAt: string; answeredAt: string | null; endedAt: string | null;
  direction: 'internal' | 'inbound' | 'outbound'; from: string; to: string;
  sourceExtensionId: string | null; destinationExtensionId: string | null;
  status: 'answered' | 'no_answer' | 'busy' | 'cancelled' | 'failed' | 'incomplete';
  durationSeconds: number | null; hangupCause: string; cost: null;
};
const legId = (e: StoredCallEvent) => e.call_leg_id || e.call_control_id || e.call_session_id || '';
const uriUser = (value: string) => value.match(/sips?:([^@;>\s]+)/i)?.[1] || value.trim();
const cleanName = (value: string) => /sips?:|@|^gencred|[\x00-\x1f]/i.test(value) ? '' : value.trim();

/** Aggregate admitted calls, never raw webhook totals or the answers of losing forks. */
export function reportCalls(events: StoredCallEvent[], organizationId: string, directory: HistoryDirectoryEntry[], from: number, to: number): ReportCall[] {
  const owned = [...new Map(events.filter(e => e.organizationId === organizationId && Number.isFinite(Date.parse(e.event_timestamp))).map(e => [e.id, e])).values()];
  // Route and session aliases join delayed events which carry only a leg ID.
  const parents = new Map<string, string>();
  const root = (id: string): string => { let current = id; while (parents.has(current)) current = parents.get(current)!; return current; };
  const aliases = (e: StoredCallEvent) => [e.routeId && `route:${e.routeId}`, e.call_session_id && `call:${e.call_session_id}`, e.call_leg_id && `call:${e.call_leg_id}`, e.call_control_id && `call:${e.call_control_id}`].filter(Boolean) as string[];
  for (const e of owned) { const ids = aliases(e); for (const id of ids.slice(1)) { const a = root(ids[0]); const b = root(id); if (a !== b) parents.set(b, a); } }
  const groups = new Map<string, StoredCallEvent[]>();
  for (const e of owned) { const id = aliases(e)[0]; if (id) { const key = root(id); groups.set(key, [...(groups.get(key) || []), e]); } }
  const calls: ReportCall[] = [];
  for (const [id, group] of groups) {
    const ordered = group.sort((a, b) => Date.parse(a.event_timestamp) - Date.parse(b.event_timestamp));
    const starts = ordered.filter(e => e.name === 'call.initiated');
    const internal = starts.find(e => e.flow === 'internal');
    const outbound = starts.find(e => e.flow === 'outbound_destination' || e.flow === 'outbound');
    const inbound = starts.find(e => e.direction === 'incoming' && !['agent', 'queue_agent', 'queue_wait', 'outbound_client', 'conference_guest'].includes(e.flow || ''));
    const start = internal || inbound || outbound;
    // A managed internal caller is parked/answered before the destination picks up.
    const anchor = internal ? outbound || internal : inbound || outbound;
    if (!anchor || !start || Date.parse(start.event_timestamp) < from || Date.parse(start.event_timestamp) >= to) continue;
    const direction = internal ? 'internal' : inbound ? 'inbound' : 'outbound';
    const anchorEvents = ordered.filter(e => legId(e) === legId(anchor));
    const answered = anchorEvents.find(e => e.name === 'call.answered' && Date.parse(e.event_timestamp) >= Date.parse(anchor.event_timestamp));
    const ended = anchorEvents.find(e => e.name === 'call.hangup' && Date.parse(e.event_timestamp) >= Date.parse(anchor.event_timestamp));
    const validAnswer = answered && (!ended || Date.parse(answered.event_timestamp) <= Date.parse(ended.event_timestamp)) ? answered : undefined;
    const agentAnswers = ordered.filter(e => e.name === 'call.answered' && ['agent', 'queue_agent'].includes(e.flow || ''));
    const answeredAgents = new Set(agentAnswers.map(e => e.destinationExtensionId).filter(Boolean));
    const confirmedDestination = ordered.find(e => e.name === 'call.bridged' && e.destinationExtensionId)
      || (answeredAgents.size === 1 ? agentAnswers.find(e => e.destinationExtensionId) : undefined);
    const party = (side: 'source' | 'destination') => {
      // Never borrow the first ringing fork's identity for the answered call.
      const evidence = side === 'source' ? [start, ...anchorEvents] : [confirmedDestination, anchor, ...anchorEvents].filter(Boolean) as StoredCallEvent[];
      const extensionId = evidence.find(e => e[`${side}ExtensionId`])?.[`${side}ExtensionId`];
      const raw = side === 'source' ? start.from || '' : confirmedDestination?.to || anchor.to || '';
      const entry = directory.find(d => d.id === extensionId) || directory.find(d => d.sipUsername === uriUser(raw));
      const extension = evidence.find(e => e[`${side}Extension`])?.[`${side}Extension`] || entry?.extension;
      const name = cleanName(evidence.find(e => e[`${side}Name`])?.[`${side}Name`] || entry?.name || '');
      return { id: entry?.id || extensionId || null, label: extension && /^\d{2,8}$/.test(extension) ? `${name ? `${name} · ` : ''}Extension ${extension}` : /^\+?[\d ().-]{2,30}$/.test(raw) ? raw : 'Unknown caller' };
    };
    const source = party('source'); const destination = party('destination');
    const cause = ended?.hangup_cause || '';
    const status = !ended ? 'incomplete' : validAnswer ? 'answered' : /busy/i.test(cause) ? 'busy' : /cancel/i.test(cause) ? 'cancelled' : /no_answer|timeout|temporarily_unavailable|normal_clearing/i.test(cause) ? 'no_answer' : 'failed';
    calls.push({ id, startedAt: start.event_timestamp, answeredAt: validAnswer?.event_timestamp || null, endedAt: ended?.event_timestamp || null,
      direction, from: source.label, to: destination.label, sourceExtensionId: source.id, destinationExtensionId: destination.id, status,
      durationSeconds: ended ? validAnswer ? Math.max(0, Math.floor((Date.parse(ended.event_timestamp) - Date.parse(validAnswer.event_timestamp)) / 1000)) : 0 : null,
      hangupCause: cause, cost: null });
  }
  return calls.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function analyzeCalls(calls: ReportCall[], timezone: string, directory: HistoryDirectoryEntry[]) {
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' });
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0 }));
  const directions = { inbound: 0, outbound: 0, internal: 0 };
  const counts = new Map<string, { calls: number; answered: number; seconds: number }>();
  for (const call of calls) {
    hours[Number(clock.format(new Date(call.startedAt)))].calls++;
    directions[call.direction]++;
    for (const id of new Set([call.sourceExtensionId, call.destinationExtensionId].filter(Boolean) as string[])) {
      const entry = counts.get(id) || { calls: 0, answered: 0, seconds: 0 };
      entry.calls++; if (call.answeredAt) entry.answered++; entry.seconds += call.durationSeconds || 0; counts.set(id, entry);
    }
  }
  return { total: calls.length, answered: calls.filter(c => c.answeredAt).length, incomplete: calls.filter(c => c.status === 'incomplete').length,
    durationSeconds: calls.reduce((sum, c) => sum + (c.durationSeconds || 0), 0), hours, directions,
    topExtensions: [...counts].map(([id, metrics]) => { const user = directory.find(d => d.id === id); return { id, extension: user?.extension || '', name: cleanName(user?.name || '') || 'Former colleague', ...metrics }; }).sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id)).slice(0, 20),
    billing: { reconciledCalls: 0, unpricedCalls: calls.length } };
}
