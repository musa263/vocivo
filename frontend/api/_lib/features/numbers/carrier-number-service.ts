import { carrierTrunks, CarrierTrunkError, type CarrierTrunk } from './carrier-trunk-store.js';
import { legacyPrimaryOrganizationId, pbxForOrganization, savePbxConfig, type PbxConfig } from '../organizations/pbx-config-store.js';
import { listExtensions } from '../organizations/pbx.js';
import { carrierReadiness } from './carrier-runtime.js';

export function carrierMode(config: PbxConfig, organizationId: string) {
  return pbxForOrganization(config, organizationId).company.callingMode === 'carrier';
}

/** Published routing lives in PBX assignments, not in the carrier form snapshot. */
export function withLiveNumberRoutes(trunk: CarrierTrunk, config: PbxConfig): CarrierTrunk {
  return { ...trunk, numbers: trunk.numbers.map(number => {
    const assignment = config.numberAssignments[number.callerId];
    if (!assignment || assignment.organizationId !== trunk.organizationId || assignment.carrierTrunkId !== trunk.id) return number;
    return { ...number, destinationType: assignment.disabled ? 'unassigned' : assignment.destinationType || 'unassigned', destinationId: assignment.disabled ? '' : assignment.destinationId || '' };
  }) };
}

/** A saved provider form is inventory, never proof that its gateway is deployed. */
export function carrierNumberInventory(trunks: CarrierTrunk[]) {
  return trunks.flatMap(trunk => trunk.numbers.map(number => ({
    id: `carrier:${trunk.id}:${number.callerId}`,
    phone_number: number.callerId,
    inbound_number: number.inboundNumber,
    label: `${trunk.name}${trunk.mainNumber === number.inboundNumber ? ' main line' : ''}`,
    country_code: null,
    source: 'carrier' as const,
    carrier_trunk_id: trunk.id,
    carrier_trunk_revision: trunk.revision,
    status: carrierReadiness(trunk).status,
    receives_calls: carrierReadiness(trunk).status === 'ready' && trunk.inboundEnabled === true && number.destinationType !== 'unassigned',
    messaging_enabled: false,
    destination_type: number.destinationType,
    destination_id: number.destinationId,
  })));
}

/** Atomic ownership claims prevent two tenants from publishing the same DID. */
export function applyCarrierNumbers(config: PbxConfig, organizationId: string, trunk: CarrierTrunk) {
  if (trunk.organizationId !== organizationId || !config.organizations.some(item => item.id === organizationId && item.status === 'active')) {
    throw new CarrierTrunkError(403, 'This carrier trunk does not belong to the active company.');
  }
  const assignments = { ...config.numberAssignments };
  const selected = new Set(trunk.numbers.map(number => number.callerId));
  for (const [phoneNumber, assignment] of Object.entries(assignments)) {
    if (assignment.organizationId === organizationId && assignment.carrierTrunkId === trunk.id && !selected.has(phoneNumber)) {
      assignments[phoneNumber] = { ...assignment, disabled: true };
    }
  }
  for (const number of trunk.numbers) {
    const current = assignments[number.callerId];
    if (current && (current.organizationId !== organizationId || current.carrierTrunkId && current.carrierTrunkId !== trunk.id)) {
      throw new CarrierTrunkError(409, 'A DID is already assigned to another company or trunk.');
    }
    assignments[number.callerId] = {
      organizationId, source: 'carrier', carrierTrunkId: trunk.id,
      carrierTrunkRevision: trunk.revision, inboundNumber: number.inboundNumber,
      carrierConnectionRevision: trunk.connectionRevision || trunk.revision,
      label: `${trunk.name}${trunk.mainNumber === number.inboundNumber ? ' main line' : ''}`,
      disabled: false, messagingEnabled: false,
      ...(current ? { destinationType: current.destinationType, destinationId: current.destinationId } : number.destinationType === 'unassigned' ? {} : {
        destinationType: number.destinationType, destinationId: number.destinationId,
      }),
    };
  }
  const tenant = pbxForOrganization(config, organizationId);
  const main = trunk.numbers.find(number => number.inboundNumber === trunk.mainNumber);
  const existing = assignments[tenant.company.defaultCallerId];
  const company = { ...tenant.company, callingMode: 'carrier' as const,
    defaultCallerId: existing?.organizationId === organizationId && existing.source === 'carrier' && !existing.disabled
      ? tenant.company.defaultCallerId : main?.callerId || trunk.numbers[0]?.callerId || '' };
  return {
    numberAssignments: assignments,
    ...(legacyPrimaryOrganizationId(config) === organizationId ? { company } : {}),
    organizationSettings: { ...config.organizationSettings, [organizationId]: {
      company, departments: tenant.departments, outboundRules: tenant.outboundRules,
      officeHours: tenant.officeHours, callHandling: tenant.callHandling, ai: tenant.ai, system: tenant.system,
    } },
  };
}

export function detachCompanyNumber(
  config: PbxConfig,
  organizationId: string,
  phoneNumber: string,
  extensionIds: string[] = [],
  options: { carrierOnly?: boolean } = {},
) {
  const current = config.numberAssignments[phoneNumber];
  if (!current || current.organizationId !== organizationId) throw new CarrierTrunkError(404, 'Phone number not found in this company.');
  // Which screen is asking, stated rather than guessed from the number itself.
  // The carrier trunk screen removes DIDs a company brought with its own
  // carrier; it used to check ownership and nothing else, so a company on
  // managed calling could send that request for their main Vocivo number and
  // take their own main line off the air. The phone numbers screen may retire
  // either kind, which is why the restriction belongs to the caller.
  if (options.carrierOnly && current.source !== 'carrier') {
    throw new CarrierTrunkError(409, 'This number was provided by Vocivo. Remove it from the phone numbers screen instead.');
  }
  // Retain a tombstone so historical order reconciliation cannot reattach it.
  const numberAssignments = { ...config.numberAssignments, [phoneNumber]: { ...current, disabled: true } };
  const tenant = pbxForOrganization(config, organizationId);
  const company = { ...tenant.company, defaultCallerId: tenant.company.defaultCallerId === phoneNumber ? '' : tenant.company.defaultCallerId };
  const userProfiles = { ...config.userProfiles };
  for (const id of extensionIds) {
    const profile = userProfiles[id];
    if (profile) userProfiles[id] = { ...profile,
      outboundCallerId: profile.outboundCallerId === phoneNumber ? '' : profile.outboundCallerId,
      did: profile.did === phoneNumber ? '' : profile.did };
  }
  return { numberAssignments, userProfiles,
    ...(legacyPrimaryOrganizationId(config) === organizationId ? { company } : {}),
    organizationSettings: { ...config.organizationSettings, [organizationId]: {
      company, departments: tenant.departments, outboundRules: tenant.outboundRules,
      officeHours: tenant.officeHours, callHandling: tenant.callHandling, ai: tenant.ai, system: tenant.system,
    } },
  };
}

export async function useCarrierNumbers(organizationId: string, id: string, revision: number, limit = 10000) {
  const trunk = (await carrierTrunks.list(organizationId)).find(item => item.id === id);
  if (!trunk) throw new CarrierTrunkError(404, 'Carrier trunk not found.');
  if (trunk.revision !== revision) throw new CarrierTrunkError(409, 'The trunk changed. Reload before selecting its numbers.');
  if (!trunk.numbers.length) throw new CarrierTrunkError(400, 'Add the carrier DID numbers first.');
  await savePbxConfig(current => {
    const patch = applyCarrierNumbers(current, organizationId, trunk);
    const count = Object.values(patch.numberAssignments).filter(item => item.organizationId === organizationId && !item.disabled && item.source === 'carrier').length;
    if (count > limit) throw new CarrierTrunkError(409, `This company plan allows ${limit} phone numbers.`);
    return patch;
  });
  return trunk;
}

export async function removeCompanyNumber(organizationId: string, phoneNumber: string) {
  if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber)) throw new CarrierTrunkError(400, 'A complete international phone number is required.');
  const extensionIds = (await listExtensions(organizationId)).map(item => item.id);
  await savePbxConfig(current => detachCompanyNumber(current, organizationId, phoneNumber, extensionIds, { carrierOnly: true }));
}
