import type { ExtensionUser } from '../organizations/pbx.js';
import type { LiveCall, Telemetry } from './telemetry-store.js';

/** An authenticated edge submits complete samples; no SIP identities reach the browser. */
export function tenantSnapshots(body: unknown, organizations: string[], directory: ExtensionUser[], now = Date.now()): Telemetry[] {
  const input = body as any;
  if (!input || input.version !== 1 || !Array.isArray(input.registrations) || !Array.isArray(input.calls)
    || input.registrations.length > 20_000 || input.calls.length > 5000 || !Number.isFinite(Date.parse(input.observedAt))
    || Date.parse(input.observedAt) > now + 5000 || now - Date.parse(input.observedAt) > 45_000) throw new Error('Invalid telemetry snapshot');
  const byOrg = new Map(organizations.map(org => [org, { organizationId: org, observedAt: input.observedAt, registrations: [], calls: [] } as Telemetry]));
  for (const item of input.registrations) {
    if (!item || typeof item.username !== 'string' || !Number.isInteger(item.contacts) || item.contacts < 1 || item.contacts > 100
      || !Number.isFinite(Date.parse(item.expiresAt))) throw new Error('Invalid registration snapshot');
    const users = directory.filter(d => d.sipUsername === item.username);
    if (users.length !== 1) continue;
    const user = users[0]; const target = byOrg.get(user.organizationId);
    if (target && Date.parse(item.expiresAt) > now) target.registrations.push({ extensionId: user.id, contacts: item.contacts, expiresAt: item.expiresAt });
  }
  for (const item of input.calls) {
    if (!item || typeof item.id !== 'string' || item.id.length > 200 || !item.id || !Array.isArray(item.usernames)
      || item.usernames.length > 100 || item.usernames.some((v: unknown) => typeof v !== 'string')
      || !['internal', 'inbound', 'outbound'].includes(item.direction) || !['ringing', 'active', 'waiting'].includes(item.state)
      || !Number.isFinite(Date.parse(item.startedAt)) || typeof item.queueId !== 'string' || item.queueId.length > 128) throw new Error('Invalid live call');
    const users = directory.filter(d => item.usernames.includes(d.sipUsername));
    if (item.direction === 'internal' && (item.usernames.length < 2 || item.usernames.some((name: string) => !users.some(d => d.sipUsername === name)))) continue;
    const owners = new Set(users.map(d => d.organizationId));
    if (item.organizationId) owners.add(item.organizationId);
    if (owners.size !== 1) continue;
    const target = byOrg.get([...owners][0]); if (!target) continue;
    const call: LiveCall = { id: item.id, direction: item.direction, state: item.state, queueId: item.queueId,
      extensionIds: [...new Set(users.map(d => d.id))], startedAt: item.startedAt };
    if (!target.calls.some(c => c.id === call.id)) target.calls.push(call);
  }
  return [...byOrg.values()];
}
