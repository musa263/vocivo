import { officeHoursDecision } from '../organizations/office-hours.js';
import { listExtensions, listExtensionSipUsernames, type ExtensionUser } from '../organizations/pbx.js';
import { pbxForOrganization, type PbxConfig } from '../organizations/pbx-config-store.js';
import { sipInboundEnabled } from '../calling/voice-provider.js';
import { normalizeE164 } from '../organizations/tenancy.js';

/**
 * What the SIP edge should do with a call arriving on one of Vocivo's numbers.
 *
 * FreeSWITCH's `vocivo-inbound-did` extension asks this endpoint once per call
 * and branches on `action`. Keeping the decision here rather than in dialplan
 * regexes is the point: office hours, the AI receptionist and the tenant's
 * routing all live in the API already, and the switch stays an executor.
 */

export type SipInboundAction = 'closed' | 'ai' | 'queue' | 'bridge';

export type SipInboundLookup = {
  enabled: boolean;
  reason?: string;
  organizationId?: string;
  /** SIP usernames that could answer, kept for callers that predate `action`. */
  usernames: string[];
  bridge: string;
  action?: SipInboundAction;
  /** Spoken to the caller before the action, when there is something to say. */
  prompt?: string;
  /** How long to ring before giving up, for `queue` and `bridge`. */
  timeoutSec?: number;
};

const ringSeconds = 30;

/**
 * The directory lookups, injectable so the routing decision can be tested
 * without a database — the decision is the part with the judgement in it.
 */
export type SipInboundDirectory = {
  extensionsFor(organizationId: string): Promise<ExtensionUser[]>;
  usernamesForDestination(destinationId: string): Promise<string[]>;
};

const liveDirectory: SipInboundDirectory = {
  extensionsFor: (organizationId) => listExtensions(organizationId),
  usernamesForDestination: (destinationId) => listExtensionSipUsernames(destinationId),
};

export async function lookupSipInbound(
  to: string,
  config: PbxConfig,
  now = new Date(),
  directoryLookup: SipInboundDirectory = liveDirectory,
): Promise<SipInboundLookup> {
  if (!sipInboundEnabled()) {
    // Inbound is still delivered by the carrier's Call Control app. Answering
    // anything here would race that webhook for the same call.
    return { enabled: false, reason: 'call_control', usernames: [], bridge: '' };
  }
  const did = normalizeE164(to);
  const assignment = config.numberAssignments[did];
  if (!assignment?.organizationId || assignment.disabled || assignment.source === 'carrier') {
    // BYOC requires the source-bound XML dialplan. The legacy fallback cannot
    // authenticate the carrier or implement an individually assigned route.
    return { enabled: false, reason: 'unassigned', usernames: [], bridge: '' };
  }

  const organizationId = assignment.organizationId;
  const tenant = pbxForOrganization(config, organizationId);
  const directory = await directoryLookup.extensionsFor(organizationId);

  // The fallback may narrow routing, never broaden it. Complex destinations
  // need the full XML plan to preserve member, schedule and fallback semantics.
  if (['ring_group', 'queue', 'ivr'].includes(assignment.destinationType || '')) {
    return { enabled: false, reason: 'requires_dialplan', organizationId, usernames: [], bridge: '' };
  }
  const active = directory.filter((item) => item.organizationId === organizationId && item.status === 'active' && item.sipUsername);
  const targets = assignment.destinationType === 'extension'
    ? active.filter((item) => item.id === assignment.destinationId)
    : active;
  const usernames = targets.map((item) => item.sipUsername);
  const unique = [...new Set(usernames.filter(Boolean))];
  const bridge = unique.map((username) => `sofia/external/${username}@127.0.0.1:5060`).join(',');

  // Vocivo's own receptionist answers at any hour — after closing it says so
  // and takes a message. The edge hands the call to the receptionist service,
  // which transfers back into this same dialplan when the caller asks for a
  // person — so a receptionist can never reach somewhere a colleague could not.
  if (tenant.ai?.enabled && assignment.destinationType !== 'extension') {
    return { enabled: true, organizationId, usernames: unique, bridge, action: 'ai' };
  }

  // Closed before ringing anyone: a business that is shut should not ring a
  // colleague's phone at midnight because a number points at their extension.
  if (!officeHoursDecision(tenant.officeHours, now).open) {
    return {
      enabled: true,
      organizationId,
      usernames: unique,
      bridge,
      action: 'closed',
      prompt: closedPrompt(tenant),
    };
  }

  if (!unique.length) {
    return { enabled: false, reason: 'no_contacts', organizationId, usernames: [], bridge: '' };
  }

  const grouped = assignment.destinationType === 'ring_group' || assignment.destinationType === 'queue';
  return {
    enabled: true,
    organizationId,
    usernames: unique,
    bridge,
    action: grouped ? 'queue' : 'bridge',
    prompt: grouped ? waitingPrompt(tenant) : undefined,
    timeoutSec: ringSeconds,
  };
}

function closedPrompt(tenant: PbxConfig) {
  const name = tenant.company?.name?.trim();
  return name
    ? `Thank you for calling ${name}. We are closed right now. Please call back during business hours.`
    : 'Thank you for calling. We are closed right now. Please call back during business hours.';
}

function waitingPrompt(tenant: PbxConfig) {
  const name = tenant.company?.name?.trim();
  return name ? `Thank you for calling ${name}. Connecting you now.` : 'Thank you for calling. Connecting you now.';
}
