import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin } from '../../auth/auth.js';
import { allowMobile, writeAuthError } from '../../../shared/http.js';
import { readPbxConfig, pbxForOrganization } from '../../organizations/pbx-config-store.js';
import { requestOrganizationId, writeTenantScopeError } from '../../organizations/request-organization.js';
import { requireFeature } from '../../organizations/saas-access.js';
import { listExtensions } from '../../organizations/pbx.js';
import { voiceEdge } from '../../calling/voice-provider.js';
import { agentStore, AgentConflict } from '../agent-store.js';
import { telemetryStore, telemetryFresh } from '../telemetry-store.js';

const dependencies = { requireAdmin, readPbxConfig, requireFeature, listExtensions, voiceEdge, agentStore, telemetryStore };
export function createOperationsHandler(overrides: Partial<typeof dependencies> = {}) {
const { requireAdmin, readPbxConfig, requireFeature, listExtensions, voiceEdge, agentStore, telemetryStore } = { ...dependencies, ...overrides };
return async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'PATCH'].includes(req.method || '')) return res.status(405).json({ error: 'GET or PATCH required' });
  try {
    const { session } = await requireAdmin(req);
    const config = await readPbxConfig();
    const org = requestOrganizationId(req, session, config);
    await requireFeature(session, req.method === 'PATCH' ? 'queues' : 'analytics', config);
    const directory = await listExtensions(org);
    if (req.method === 'PATCH') {
      const { extensionId, state, version } = req.body || {};
      if (!directory.some(d => d.id === extensionId && d.status === 'active')) return res.status(404).json({ error: 'Active company user not found' });
      if (!['available', 'on_break'].includes(state) || !Number.isSafeInteger(version) || version < 0) return res.status(400).json({ error: 'Invalid agent state or version' });
      await agentStore.update(org, extensionId, state, version, session.sub || '');
      return res.status(200).json({ saved: true });
    }
    const [snapshot, preferences] = await Promise.all([voiceEdge() === 'sip' ? telemetryStore.read(org) : Promise.resolve(null), agentStore.read(org, directory.map(d => d.id))]);
    const fresh = telemetryFresh(snapshot);
    const calls = fresh ? snapshot!.calls : [];
    const agents = directory.map(user => {
      const preference = preferences.find(p => p.extensionId === user.id)!;
      const registration = fresh ? snapshot!.registrations.find(r => r.extensionId === user.id && Date.parse(r.expiresAt) > Date.now()) : undefined;
      const onCall = calls.some(c => c.state === 'active' && c.extensionIds.includes(user.id));
      return { id: user.id, extension: user.extension, name: user.name, enabled: user.status === 'active', preference,
        registration: fresh ? registration ? 'active' : 'inactive' : 'unknown', contacts: fresh ? registration?.contacts || 0 : null,
        expiresAt: registration?.expiresAt || null, state: onCall ? 'on_call' : preference.state === 'on_break' ? 'on_break' : !fresh ? 'unknown' : registration && user.status === 'active' ? 'available' : 'offline' };
    });
    const queues = pbxForOrganization(config, org).callHandling.queues.map(q => ({ id: q.id, name: q.name, extension: q.extension,
      waiting: fresh ? calls.filter(c => c.queueId === q.id && c.state !== 'active').length : null,
      onCall: fresh ? calls.filter(c => c.queueId === q.id && c.state === 'active').length : null,
      available: fresh ? agents.filter(a => q.members.includes(a.id) && a.state === 'available').length : null,
      onBreak: agents.filter(a => q.members.includes(a.id) && a.preference.state === 'on_break').length }));
    return res.status(200).json({ organizationId: org, observedAt: snapshot?.observedAt || null, fresh, source: voiceEdge() === 'sip' ? 'sip-edge' : 'unsupported-edge', agents, calls, queues,
      counters: fresh ? { inbound: calls.filter(c => c.direction === 'inbound').length, outbound: calls.filter(c => c.direction === 'outbound').length, internal: calls.filter(c => c.direction === 'internal').length,
        activeRegistrations: agents.filter(a => a.registration === 'active').length, inactiveRegistrations: agents.filter(a => a.registration === 'inactive').length } : null });
  } catch (error) {
    if (error instanceof AgentConflict) return res.status(409).json({ error: error.message });
    if (writeTenantScopeError(res, error) || writeAuthError(res, error)) return;
    if (error instanceof Error && /Feature not enabled|Subscription inactive|Organization inactive/.test(error.message)) return res.status(403).json({ error: 'Operations access is not enabled' });
    console.error('operations.request.failed', { type: error instanceof Error ? error.name : 'unknown' });
    return res.status(503).json({ error: 'Operations data is unavailable. Please retry.' });
  }
};
}
export default createOperationsHandler();
