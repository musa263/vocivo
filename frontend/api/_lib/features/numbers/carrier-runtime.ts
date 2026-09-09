import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { carrierTrunks, CarrierTrunkError, type CarrierTrunk } from './carrier-trunk-store.js';
import { pbxForOrganization, type PbxConfig } from '../organizations/pbx-config-store.js';

/** Operator deployment records, never accepted from a company request body. */
export type CarrierDeployment = {
  organizationId: string; trunkId: string; revision: number; publicIp: string;
  gateway: string; inboundSources: string[];
  /** Optional operator deadline for a temporary deployment, in UTC. */
  expiresAt?: string;
};

/**
 * The platform carrier's own signalling addresses, when the operator has named
 * them in VOCIVO_PLATFORM_TRUNK_SOURCES.
 *
 * Optional on purpose: leaving it unset must not stop platform numbers from
 * ringing, because an edge that was deployed before this existed has no such
 * list. Unset, a platform number is still refused from every tenant trunk,
 * which is what closes the cross-tenant path; set, it is accepted only from the
 * addresses named here, which also shuts out anything else that reaches 5060.
 */
function platformTrunkSources() {
  return (process.env.VOCIVO_PLATFORM_TRUNK_SOURCES || '')
    .split(/[\s,]+/)
    .map(value => value.trim())
    .filter(value => isIP(value) === 4);
}

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

/**
 * The signalling addresses that belong to a tenant's own carrier, rather than
 * to the platform's.
 *
 * Kamailio admits every address in VOCIVO_TRUNK_SOURCES, and that list now
 * holds each tenant's BYOC carrier alongside the platform's, so "the edge let
 * this INVITE in" no longer means "this INVITE came from our carrier". Anything
 * a tenant deployment named is somebody's private trunk.
 */
function tenantCarrierSources(deployments: CarrierDeployment[]) {
  return new Set(deployments.filter(item => !deploymentExpired(item)).flatMap(item => item.inboundSources));
}

/**
 * Which of this platform's numbers the dialled digits mean, for a call arriving
 * from `sourceIp`.
 *
 * National DID aliases are considered only within the admitted carrier source.
 * A platform-assigned number used to be matched on the digits alone, which was
 * safe only while every trusted address belonged to the platform's own carrier.
 * It no longer does: one tenant's carrier could send an INVITE for another
 * tenant's platform DID and reach that company's staff, receptionist and
 * voicemail with a caller ID of its choosing. A number that is not served by a
 * tenant trunk is therefore refused from every tenant trunk, and — where the
 * platform's own signalling addresses have been configured — accepted only from
 * those.
 */
export function resolveInboundNumber(config: PbxConfig, supplied: string, sourceIp: string, deployments = carrierDeployments()) {
  const digits = supplied.replace(/^\+/, '');
  if (!/^\d{5,15}$/.test(digits)) return '';
  const fromTenantTrunk = tenantCarrierSources(deployments).has(sourceIp);
  const platformSources = platformTrunkSources();
  const matches = Object.entries(config.numberAssignments).filter(([did, assignment]) => {
    if (assignment.disabled || !assignment.organizationId) return false;
    if (assignment.source !== 'carrier') {
      if (fromTenantTrunk) return false;
      if (platformSources.length && !platformSources.includes(sourceIp)) return false;
      return did === `+${digits}`;
    }
    if (!assignment.destinationType || (did !== `+${digits}` && assignment.inboundNumber !== digits)) return false;
    return deployments.some(item => !deploymentExpired(item) && item.organizationId === assignment.organizationId && item.trunkId === assignment.carrierTrunkId
      && item.revision === (assignment.carrierConnectionRevision || assignment.carrierTrunkRevision) && item.inboundSources.includes(sourceIp));
  });
  return matches.length === 1 ? matches[0][0] : '';
}
