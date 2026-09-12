import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readObjects, transactObject } from '../../shared/object-store.js';
import { requiredEnv } from '../../shared/http.js';
export type LiveCall = { id: string; direction: 'inbound' | 'outbound' | 'internal'; state: 'ringing' | 'active' | 'waiting'; extensionIds: string[]; queueId: string; startedAt: string };
export type Telemetry = { organizationId: string; observedAt: string; registrations: Array<{ extensionId: string; contacts: number; expiresAt: string }>; calls: LiveCall[] };
export const telemetryFreshMs = 45_000;
const path = (org: string) => {
  if (!org) throw new Error('Telemetry tenant required');
  return `vocivo/operations/v1/${createHash('sha256').update(org).digest('hex')}.bin`;
};
const key = () => createHash('sha256').update(`${requiredEnv('AUTH_SECRET')}:operations`).digest();
function encode(value: Telemetry) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
function decode(value: Buffer, org: string): Telemetry {
  const cipher = createDecipheriv('aes-256-gcm', key(), value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28));
  const record = JSON.parse(Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString());
  if (record.organizationId !== org) throw new Error('Telemetry tenant mismatch');
  return record;
}
export function telemetryFresh(value: Telemetry | null, now = Date.now()) {
  const at = value ? Date.parse(value.observedAt) : NaN;
  return Number.isFinite(at) && at <= now + 5000 && now - at < telemetryFreshMs;
}
export const telemetryStore = {
  async read(org: string) { const body = (await readObjects([path(org)])).get(path(org)); return body ? decode(body, org) : null; },
  async save(value: Telemetry) {
    await transactObject(path(value.organizationId), body => {
      const previous = body ? decode(body, value.organizationId) : null;
      if (previous && Date.parse(previous.observedAt) >= Date.parse(value.observedAt)) return body!;
      return encode(value);
    }, { access: 'private', contentType: 'application/octet-stream' });
  },
};
