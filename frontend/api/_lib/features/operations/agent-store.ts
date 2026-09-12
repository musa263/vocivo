import { createHash } from 'node:crypto';
import { readObjects, transactObject } from '../../shared/object-store.js';

export type AgentPreference = { extensionId: string; state: 'available' | 'on_break'; version: number; updatedAt: string };
type Record = AgentPreference & { organizationId: string; updatedBy: string };
export class AgentConflict extends Error {}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function path(org: string, id: string) {
  if (!org || !id) throw new Error('Agent ownership required');
  return `vocivo/agents/v1/${digest(org)}/${digest(id)}.json`;
}
function decode(value: Buffer | null | undefined, org: string, id: string): Record {
  if (!value) return { organizationId: org, extensionId: id, state: 'available', version: 0, updatedAt: '', updatedBy: '' };
  const record = JSON.parse(value.toString()) as Record;
  if (record.organizationId !== org || record.extensionId !== id || !['available', 'on_break'].includes(record.state)
    || !Number.isSafeInteger(record.version) || record.version < 0) throw new Error('Invalid agent record');
  return record;
}
export function createAgentStore(storage = { readObjects, transactObject }, now = Date.now) {
  return {
    async read(org: string, ids: string[]): Promise<AgentPreference[]> {
      const rows = await storage.readObjects(ids.map(id => path(org, id)));
      return ids.map(id => {
        const { organizationId: _org, updatedBy: _actor, ...record } = decode(rows.get(path(org, id)), org, id);
        return record;
      });
    },
    async update(org: string, id: string, state: AgentPreference['state'], version: number, actor: string) {
      if (!['available', 'on_break'].includes(state) || !Number.isSafeInteger(version) || version < 0 || !actor) throw new Error('Invalid agent update');
      await storage.transactObject(path(org, id), body => {
        const current = decode(body, org, id);
        if (current.version !== version) throw new AgentConflict('Agent status changed. Refresh before saving.');
        return Buffer.from(JSON.stringify({ ...current, state, version: version + 1, updatedBy: actor, updatedAt: new Date(now()).toISOString() }));
      }, { access: 'private', contentType: 'application/json' });
    },
  };
}
export const agentStore = createAgentStore();
