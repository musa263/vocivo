import { pbxConfigStorage, type PbxConfig } from '../organizations/pbx-config-store.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { readObject, transactObject, transactObjectGroup, type ObjectGroupMutation } from '../../shared/object-store.js';
import { tenantStorageKey } from '../../shared/tenant-storage.js';
import { requiredEnv } from '../../shared/http.js';

export type CarrierNumber = { inboundNumber: string; callerId: string; destinationType: 'unassigned' | 'main' | 'extension' | 'ring_group' | 'queue' | 'ivr'; destinationId: string };
export type CarrierTrunk = {
  id: string; organizationId: string; revision: number; status: 'draft';
  name: string; provider: string; accountReference: string; server: string; port: number;
  transport: 'UDP' | 'TCP' | 'TLS'; publicIp: string; hostingProvider: string;
  authentication: 'unconfirmed' | 'ip' | 'registration'; username: string;
  hasPassword?: boolean;
  connectionRevision?: number;
  mainNumber?: string; outboundProxy?: string; outboundProxyPort?: number;
  channelLimit?: number | null; inboundEnabled?: boolean | null; outboundEnabled?: boolean | null;
  numbers: CarrierNumber[]; notes: string; updatedAt: string;
};
type State = { version: 1; organizationId: string; trunks: CarrierTrunk[]; passwords?: Record<string, string> };
export class CarrierTrunkError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function text(value: unknown, field: string, max = 200, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || /[\r\n\0]/.test(value) || required && !value.trim()) throw new CarrierTrunkError(400, `Invalid ${field}.`);
  return value.trim();
}
function validHost(value: string) {
  return isIP(value) === 4 || /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(value);
}
function optionalDirection(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new CarrierTrunkError(400, 'Invalid call direction.');
  return value;
}
export function normalizeCarrierTrunk(input: Record<string, unknown>, organizationId: string): Omit<CarrierTrunk, 'revision' | 'updatedAt'> {
  const id = text(input.id, 'trunk ID', 36, true);
  if (!idPattern.test(id)) throw new CarrierTrunkError(400, 'Invalid trunk ID.');
  const server = text(input.server, 'SIP server', 253, true);
  if (!validHost(server)) throw new CarrierTrunkError(400, 'Enter an IPv4 address or hostname for the SIP server.');
  const publicIp = text(input.publicIp, 'public IP', 15, true);
  if (isIP(publicIp) !== 4) throw new CarrierTrunkError(400, 'Enter a valid public IPv4 address.');
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CarrierTrunkError(400, 'Invalid SIP port.');
  if (!['UDP', 'TCP', 'TLS'].includes(String(input.transport))) throw new CarrierTrunkError(400, 'Invalid SIP transport.');
  if (!['unconfirmed', 'ip', 'registration'].includes(String(input.authentication))) throw new CarrierTrunkError(400, 'Invalid authentication method.');
  if (!Array.isArray(input.numbers) || input.numbers.length > 100) throw new CarrierTrunkError(400, 'Enter up to 100 numbers.');
  const numbers: CarrierNumber[] = input.numbers.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new CarrierTrunkError(400, 'Invalid number entry.');
    const item = value as Record<string, unknown>;
    const inboundNumber = text(item.inboundNumber, 'inbound number', 16, true).replace(/^\+/, '');
    const callerId = text(item.callerId, 'outbound caller ID', 16, true).replace(/^\+/, '');
    if (!/^\d{5,15}$/.test(inboundNumber) || !/^[1-9]\d{6,14}$/.test(callerId)) throw new CarrierTrunkError(400, 'Use digits for inbound numbers and an international outbound caller ID.');
    const destinationType = String(item.destinationType || 'unassigned');
    if (!['unassigned', 'main', 'extension', 'ring_group', 'queue', 'ivr'].includes(destinationType)) throw new CarrierTrunkError(400, 'Invalid inbound destination type.');
    const destinationId = ['unassigned', 'main'].includes(destinationType) ? '' : text(item.destinationId, 'destination', 100, true);
    return { inboundNumber, callerId: `+${callerId}`, destinationType: destinationType as CarrierNumber['destinationType'], destinationId };
  });
  if (new Set(numbers.map(item => item.inboundNumber)).size !== numbers.length || new Set(numbers.map(item => item.callerId)).size !== numbers.length) throw new CarrierTrunkError(400, 'Each number must appear only once.');
  const mainNumber = text(input.mainNumber, 'main trunk number', 16).replace(/^\+/, '');
  if (mainNumber && !numbers.some(item => item.inboundNumber === mainNumber)) throw new CarrierTrunkError(400, 'The main trunk number must be in the DID list.');
  const outboundProxy = text(input.outboundProxy, 'outbound proxy', 253);
  if (outboundProxy && !validHost(outboundProxy)) throw new CarrierTrunkError(400, 'Enter an IPv4 address or hostname for the outbound proxy.');
  const outboundProxyPort = input.outboundProxyPort === undefined ? 5060 : Number(input.outboundProxyPort);
  if (!Number.isInteger(outboundProxyPort) || outboundProxyPort < 1 || outboundProxyPort > 65535) throw new CarrierTrunkError(400, 'Invalid outbound proxy port.');
  const channelLimit = input.channelLimit === undefined || input.channelLimit === null || input.channelLimit === '' ? null : Number(input.channelLimit);
  if (channelLimit !== null && (!Number.isInteger(channelLimit) || channelLimit < 1 || channelLimit > 10000)) throw new CarrierTrunkError(400, 'Enter a simultaneous call limit from 1 to 10000.');
  return { id, organizationId, status: 'draft', name: text(input.name, 'trunk name', 100, true), provider: text(input.provider, 'provider', 100, true), accountReference: text(input.accountReference, 'account reference', 100), server, port, transport: input.transport as CarrierTrunk['transport'], publicIp, hostingProvider: text(input.hostingProvider, 'hosting provider', 100), authentication: input.authentication as CarrierTrunk['authentication'], username: text(input.username, 'SIP username', 100), mainNumber, outboundProxy, outboundProxyPort, channelLimit, inboundEnabled: optionalDirection(input.inboundEnabled), outboundEnabled: optionalDirection(input.outboundEnabled), numbers, notes: text(input.notes, 'notes', 500) };
}

type Publication = (config: PbxConfig, trunk: CarrierTrunk) => Partial<PbxConfig> | undefined;
type Storage = {
  transactObjectGroup?: (lockKey: string, paths: string[], update: (current: Map<string, { body: Buffer; etag: string }>) => ObjectGroupMutation<unknown> | Promise<ObjectGroupMutation<unknown>>) => Promise<unknown>;
  readObject: (path: string) => Promise<Buffer | null>;
  transactObject: (path: string, update: (body: Buffer | null) => Buffer | Promise<Buffer>, options: { access: 'private'; contentType: string }) => Promise<unknown>;
};
export function createCarrierTrunkStore(deps: Storage = { readObject, transactObject, transactObjectGroup }) {
  const path = (org: string) => `vocivo/carrier-trunks/v1/${tenantStorageKey(org)}.bin`;
  const key = () => createHash('sha256').update(`${requiredEnv('AUTH_SECRET')}:carrier-trunks:v1`).digest();
  const encrypt = (state: State) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  const decode = (body: Buffer | null, organizationId: string): State => {
    if (!body) return { version: 1, organizationId, trunks: [] };
    const cipher = createDecipheriv('aes-256-gcm', key(), body.subarray(0, 12));
    cipher.setAuthTag(body.subarray(12, 28));
    const state = JSON.parse(Buffer.concat([cipher.update(body.subarray(28)), cipher.final()]).toString()) as State;
    if (state.version !== 1 || state.organizationId !== organizationId || !Array.isArray(state.trunks) || state.trunks.some(item => item.organizationId !== organizationId || item.status !== 'draft' || !idPattern.test(item.id))) throw new Error('Invalid carrier trunk storage.');
    return state;
  };
  return {
    async list(organizationId: string) { return decode(await deps.readObject(path(organizationId)), organizationId).trunks; },
    async publish(organizationId: string, id: string, revision: number, publication: Publication) {
      if (!deps.transactObjectGroup) throw new Error('Atomic carrier publication unavailable.');
      const result = await deps.transactObjectGroup(path(organizationId), [path(organizationId), pbxConfigStorage.pathname], current => {
        const trunk = decode(current.get(path(organizationId))?.body || null, organizationId).trunks.find(item => item.id === id);
        if (!trunk || trunk.revision !== revision) throw new CarrierTrunkError(409, 'The trunk changed. Reload before selecting its numbers.');
        const pbx = pbxConfigStorage.read(current.get(pbxConfigStorage.pathname)?.body || null);
        const patch = publication(pbx, trunk);
        return { puts: patch ? [{ pathname: pbxConfigStorage.pathname, value: pbxConfigStorage.update(pbx, patch) }] : [], result: trunk };
      });
      pbxConfigStorage.invalidate();
      return result as CarrierTrunk;
    },
    /** Deployment tooling only. No HTTP company route exposes this value. */
    async provisioning(organizationId: string, id: string, revision: number) {
      const state = decode(await deps.readObject(path(organizationId)), organizationId);
      const trunk = state.trunks.find(item => item.id === id && item.revision === revision);
      if (!trunk) throw new CarrierTrunkError(409, 'The requested trunk revision is not current.');
      return { trunk, password: state.passwords?.[id] || '' };
    },
    async save(organizationId: string, input: Record<string, unknown>, publication?: Publication) {
      const draft = normalizeCarrierTrunk(input, organizationId);
      const password = input.password === undefined || input.password === '' ? undefined : input.password;
      if (password !== undefined && (typeof password !== 'string' || password.length > 256 || /[\r\n\0]|\$\{/.test(password))) throw new CarrierTrunkError(400, 'Invalid SIP password.');
      const expected = Number(input.revision);
      if (!Number.isInteger(expected) || expected < 0) throw new CarrierTrunkError(400, 'A configuration revision is required.');
      let saved: CarrierTrunk | undefined;
      const update = (body: Buffer | null) => {
        const state = decode(body, organizationId), current = state.trunks.find(item => item.id === draft.id);
        if ((current?.revision || 0) !== expected) {
          // Retrying the same create request is safe; another edit still conflicts.
          if (expected === 0 && current && JSON.stringify(normalizeCarrierTrunk(current, organizationId)) === JSON.stringify(draft)
            && (password === undefined || password === state.passwords?.[draft.id])) { saved = current; return encrypt(state); }
          throw new CarrierTrunkError(409, 'This trunk was changed in another tab. Reload before saving.');
        }
        if (!current && state.trunks.length >= 100) throw new CarrierTrunkError(400, 'This company already has 100 carrier trunks.');
        state.passwords ||= {};
        const oldPassword = state.passwords[draft.id];
        if (draft.authentication !== 'registration') delete state.passwords[draft.id];
        else if (password !== undefined) state.passwords[draft.id] = password;
        else if (current?.username !== draft.username) delete state.passwords[draft.id];
        const connection = (item: typeof draft) => JSON.stringify([item.server, item.port, item.transport, item.publicIp, item.authentication, item.username, item.outboundProxy, item.outboundProxyPort]);
        const sameConnection = current && connection(current) === connection(draft) && oldPassword === state.passwords[draft.id];
        saved = { ...draft, hasPassword: Boolean(state.passwords[draft.id]), connectionRevision: sameConnection ? current.connectionRevision || current.revision : expected + 1, revision: expected + 1, updatedAt: new Date().toISOString() };
        state.trunks = [...state.trunks.filter(item => item.id !== draft.id), saved];
        return encrypt(state);
      };
      if (publication) {
        if (!deps.transactObjectGroup) throw new Error('Atomic carrier publication unavailable.');
        await deps.transactObjectGroup(path(organizationId), [path(organizationId), pbxConfigStorage.pathname], current => {
          const value = update(current.get(path(organizationId))?.body || null);
          const pbx = pbxConfigStorage.read(current.get(pbxConfigStorage.pathname)?.body || null);
          const patch = publication(pbx, saved!);
          return { puts: [{ pathname: path(organizationId), value },
            ...(patch ? [{ pathname: pbxConfigStorage.pathname, value: pbxConfigStorage.update(pbx, patch) }] : [])], result: true };
        });
        pbxConfigStorage.invalidate();
      } else {
        await deps.transactObject(path(organizationId), update, { access: 'private', contentType: 'application/octet-stream' });
      }
      return saved!;
    },
  };
}
export const carrierTrunks = createCarrierTrunkStore();
