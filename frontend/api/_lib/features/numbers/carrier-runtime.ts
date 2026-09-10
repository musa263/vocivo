import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { carrierTrunks, CarrierTrunkError, type CarrierTrunk } from './carrier-trunk-store.js';
import { pbxForOrganization, type PbxConfig } from '../organizations/pbx-config-store.js';

/** Operator deployment records, never accepted from a company request body. */
export type CarrierDeployment = {
  organizationId: string; trunkId: string; revision: number; publicIp: string;
  gateway: string; inboundSources: string[];
  /** Optional operator deadline for a temporary deployment, in UTC. */
  expiresAt?: string;
};

const validDeadline = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const deploymentExpired = (item: CarrierDeployment) => item.expiresAt !== undefined
  && (!validDeadline(item.expiresAt) || Date.parse(item.expiresAt) <= Date.now());

export function carrierGateway(trunk: Pick<CarrierTrunk, 'organizationId' | 'id' | 'revision' | 'connectionRevision'>) {
  return `byoc_${createHash('sha256').update(JSON.stringify([trunk.organizationId, trunk.id, trunk.connectionRevision || trunk.revision])).digest('hex').slice(0, 32)}`;
}

export function carrierDeployments(raw = process.env.VOCIVO_CARRIER_DEPLOYMENTS || '[]'): CarrierDeployment[] {
  const entries: CarrierDeployment[] = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.some(item => !item || typeof item.organizationId !== 'string' || !item.organizationId
    || typeof item.trunkId !== 'string' || !Number.isSafeInteger(item.revision) || item.revision < 1
    || isIP(item.publicIp) !== 4 || !Array.isArray(item.inboundSources) || item.inboundSources.some(ip => isIP(ip) !== 4)
    || item.expiresAt !== undefined && !validDeadline(item.expiresAt)
    || item.gateway !== carrierGateway({ organizationId: item.organizationId, id: item.trunkId, revision: item.revision }))) {
    throw new Error('Invalid carrier deployment configuration.');
  }
  if (new Set(entries.map(item => `${item.organizationId}:${item.trunkId}`)).size !== entries.length) throw new Error('Ambiguous carrier deployment configuration.');
  return entries;
}

export function carrierReadiness(trunk: CarrierTrunk, deployments = carrierDeployments()) {
  const deployment = deployments.find(item => item.organizationId === trunk.organizationId && item.trunkId === trunk.id);
  if (trunk.authentication === 'unconfirmed') return { status: 'pending_activation', reason: 'Confirm the carrier authentication method.' };
  if (trunk.authentication === 'registration' && (!trunk.username || !trunk.hasPassword)) return { status: 'pending_activation', reason: 'Add the SIP username and password supplied by your carrier.' };
  if (!deployment) return { status: 'pending_activation', reason: `The PBX connection for ${trunk.publicIp} has not been deployed. Your carrier must allow calls from that address.` };
  if (deploymentExpired(deployment)) return { status: 'pending_activation', reason: 'The temporary carrier test has ended. Deploy the permanent PBX connection before calling.' };
  if (deployment.revision !== (trunk.connectionRevision || trunk.revision) || deployment.publicIp !== trunk.publicIp) return { status: 'pending_activation', reason: 'The saved connection has changed. Apply this revision to the SIP edge before calling.' };
  return { status: 'ready', reason: deployment.inboundSources.length
    ? 'PBX connection configured. Verify inbound and outbound calls with two-way audio.'
    : 'Outbound PBX connection configured. Inbound calling has not been deployed. Verify outbound calls with two-way audio.', deployment };
}

export async function resolveCarrierOutbound(config: PbxConfig, organizationId: string, callerId: string, trunks?: CarrierTrunk[], deployments = carrierDeployments()) {
  const assignment = config.numberAssignments[callerId];
  if (!assignment || assignment.organizationId !== organizationId || assignment.disabled) throw new CarrierTrunkError(403, 'Caller ID is not assigned to this company.');
  if (assignment.source !== 'carrier') {
    if (pbxForOrganization(config, organizationId).company.callingMode === 'carrier') throw new CarrierTrunkError(409, 'Choose a number from your company SIP trunk.');
    return null;
  }
  const trunk = (trunks || await carrierTrunks.list(organizationId)).find(item => item.id === assignment.carrierTrunkId && item.organizationId === organizationId);
  if (!trunk || assignment.carrierTrunkRevision !== trunk.revision || !trunk.numbers.some(item => item.callerId === callerId)) throw new CarrierTrunkError(409, 'Apply the current trunk numbers before calling.');
  const readiness = carrierReadiness(trunk, deployments);
  if (!readiness.deployment) throw new CarrierTrunkError(409, readiness.reason);
  if (trunk.outboundEnabled !== true) throw new CarrierTrunkError(409, 'Outbound calling is disabled on this SIP trunk.');
  if (!trunk.channelLimit) throw new CarrierTrunkError(409, 'Set the simultaneous call limit supplied by your carrier.');
  return { trunkId: trunk.id, revision: trunk.revision, gateway: readiness.deployment.gateway, channelLimit: trunk.channelLimit };
}

/** Managed provider sources are separate from tenant BYOC deployment sources. */
export function managedCarrierSourceAllowed(sourceIp: string, raw = process.env.VOCIVO_MANAGED_TRUNK_SOURCES || '') {
  if (isIP(sourceIp) !== 4) return false;
  const allowed = new BlockList();
  for (const source of raw.split(/[\s,]+/).filter(Boolean)) {
    const [address, prefix, extra] = source.split('/');
    if (isIP(address) !== 4 || extra !== undefined || prefix !== undefined && !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix)) {
      throw new Error('Invalid managed carrier source configuration.');
    }
    if (prefix === undefined) allowed.addAddress(address, 'ipv4');
    else allowed.addSubnet(address, Number(prefix), 'ipv4');
  }
  return allowed.check(sourceIp, 'ipv4');
}

/** National DID aliases are considered only within the admitted carrier source. */
export function resolveInboundNumber(config: PbxConfig, supplied: string, sourceIp: string, deployments = carrierDeployments()) {
  const digits = supplied.replace(/^\+/, '');
  if (!/^\d{5,15}$/.test(digits)) return '';
  const matches = Object.entries(config.numberAssignments).filter(([did, assignment]) => {
    if (assignment.disabled || !assignment.organizationId) return false;
    if (assignment.source !== 'carrier') return assignment.source !== 'verified' && did === `+${digits}` && managedCarrierSourceAllowed(sourceIp);
    if (!assignment.destinationType || (did !== `+${digits}` && assignment.inboundNumber !== digits)) return false;
    return deployments.some(item => !deploymentExpired(item) && item.organizationId === assignment.organizationId && item.trunkId === assignment.carrierTrunkId
      && item.revision === (assignment.carrierConnectionRevision || assignment.carrierTrunkRevision) && item.inboundSources.includes(sourceIp));
  });
  return matches.length === 1 ? matches[0][0] : '';
}
