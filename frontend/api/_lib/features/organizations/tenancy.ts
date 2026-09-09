import type { VocivoSession } from '../auth/auth.js';
import { readPbxConfig, savePbxConfig, type PbxConfig } from './pbx-config-store.js';

/** A plan's phone-number allowance was already full when the assignment committed. */
export class NumberLimitReachedError extends Error {
  constructor(public readonly limit: number) {
    super(`This plan includes ${limit} phone numbers.`);
    this.name = 'NumberLimitReachedError';
  }
}

export function normalizeE164(value: unknown) {
  return typeof value === 'string' ? value.replace(/[\s()-]/g, '') : '';
}

export function sessionOrganizationId(session: VocivoSession, config: PbxConfig) {
  const organizationId = session.organizationId?.trim();
  if (!organizationId || !config.organizations.some((organization) => organization.id === organizationId && organization.status === 'active')) {
    throw new Error('Unauthorized');
  }
  return organizationId;
}

export function numberOrganizationId(phoneNumber: string, config: PbxConfig) {
  const assignment = config.numberAssignments[normalizeE164(phoneNumber)];
  return assignment && !assignment.disabled ? assignment.organizationId : '';
}

export function sessionCanAccessNumber(session: VocivoSession, phoneNumber: string, config: PbxConfig) {
  return session.sub === 'vocivo-owner' || numberOrganizationId(phoneNumber, config) === sessionOrganizationId(session, config);
}

export function organizationForInboundNumber(phoneNumber: string, config: PbxConfig) {
  const assigned = numberOrganizationId(phoneNumber, config);
  return assigned && config.organizations.some((organization) => organization.id === assigned && organization.status === 'active') ? assigned : '';
}

export async function organizationForNumber(phoneNumber: string) {
  const config = await readPbxConfig();
  return organizationForInboundNumber(phoneNumber, config);
}

export function numberAssignmentConflict(current: { organizationId?: string } | undefined, organizationId: string) {
  return Boolean(current?.organizationId && current.organizationId !== organizationId);
}

export async function assignNumberToOrganization(
  phoneNumber: string,
  organizationId: string,
  patch: Omit<PbxConfig['numberAssignments'][string], 'organizationId'> = {},
  options: { limit?: number } = {},
) {
  const normalized = normalizeE164(phoneNumber);
  await savePbxConfig((config) => {
    if (!config.organizations.some((item) => item.id === organizationId)) throw new Error('Organization not found.');
    const current = config.numberAssignments[normalized];
    if (numberAssignmentConflict(current, organizationId)) throw new Error('This number already belongs to another organization.');
    // Counted here rather than before the carrier order, because a check made
    // against a configuration read minutes earlier is not a limit: two requests
    // that each saw an empty account both passed it, and a two-number plan
    // bought four, at a recurring monthly cost. Inside the compare-and-swap the
    // count is the committed one, which is what the carrier trunk path already
    // does when it selects its numbers.
    if (options.limit !== undefined && !current?.organizationId) {
      const held = Object.values(config.numberAssignments).filter((item) => item.organizationId === organizationId && !item.disabled).length;
      if (held >= options.limit) throw new NumberLimitReachedError(options.limit);
    }
    // Assigning a number is what un-retires it. Detaching one leaves a
    // tombstone so historical order reconciliation cannot quietly reattach it,
    // but the flag lived in `current` and no patch ever carried it, so it
    // survived every later assignment: the number stayed invisible in listings,
    // outbound with it was refused, inbound was quarantined, and no other
    // tenant could claim it either. A deliberate re-assignment clears it.
    return { numberAssignments: { ...config.numberAssignments, [normalized]: { ...current, ...patch, disabled: false, organizationId } } };
  });
}

export async function removeNumberAssignment(phoneNumber: string) {
  const normalized = normalizeE164(phoneNumber);
  await savePbxConfig((config) => {
    const numberAssignments = { ...config.numberAssignments };
    delete numberAssignments[normalized];
    return { numberAssignments };
  });
}
