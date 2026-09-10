import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { transactObject } from '../../shared/object-store.js';
import { readStoredObject } from '../../shared/stored-object-read.js';
import { requiredEnv } from '../../shared/http.js';
import { validOfficeTime, validTimeZone } from './office-hours.js';

export type PbxConfig = {
  version: number;
  company: { name: string; timezone: string; defaultCallerId: string; emergencyAddress: string; callingMode?: 'managed' | 'carrier' };
  activeOrganizationId: string;
  // Pins which organization owns the legacy Telnyx-tag-based settings that
  // predate multi-tenancy (see number-config.ts). Old records are pinned during
  // normalization, before any company reorder or update can change ownership.
  legacyPrimaryOrganizationId?: string;
  organizations: Array<{
    id: string; name: string; slug: string; extensionStart: number; extensionEnd: number;
    accountType: 'business' | 'individual'; ownerDisplayName: string; ownerEmail: string;
    internalCallingEnabled: boolean; status: 'active' | 'suspended';
  }>;
  numberAssignments: Record<string, {
    organizationId: string;
    label?: string;
    source?: 'owned' | 'verified' | 'carrier';
    carrierTrunkId?: string;
    carrierTrunkRevision?: number;
    carrierConnectionRevision?: number;
    inboundNumber?: string;
    disabled?: boolean;
    destinationType?: 'main' | 'extension' | 'ring_group' | 'queue' | 'ivr';
    destinationId?: string;
    messagingEnabled?: boolean;
  }>;
  businessVoiceConfigs: Record<string, {
    enabled: boolean; voicemailEnabled: boolean; voicemailDelaySeconds: number; voicemailGreeting: string;
    companyName: string; greeting: string; waitingMessage: string; departments: string[]; voice: string; backgroundImageUrl: string;
  }>;
  organizationSettings: Record<string, OrganizationPbxSettings>;
  userProfiles: Record<string, {
    outboundCallerId: string; did: string; twoFactorEnabled: boolean; noAnswerSeconds: number;
    forwardBusy: string; forwardNoAnswer: string; forwardUnavailable: string; simultaneousRing: string;
    voicemailEnabled: boolean; voicemailEmail: boolean; voicemailTranscription: boolean;
    schedule: string; permissions: { international: boolean; transfer: boolean; video: boolean; recording: boolean; reports: boolean };
  }>;
  departments: Array<{ id: string; name: string; managerExtension: string }>;
  outboundRules: Array<{ id: string; name: string; prefix: string; extensionRange: string; numberLength: string; department: string; routes: string[]; enabled: boolean }>;
  officeHours: { timezone: string; weekdays: Record<string, { enabled: boolean; start: string; end: string }>; holidays: Array<{ id: string; name: string; date: string; destination: string }> };
  callHandling: {
    ringGroups: Array<{ id: string; name: string; extension: string; strategy: string; members: string[]; timeout: number; fallback: string }>;
    queues: Array<{ id: string; name: string; extension: string; strategy: string; members: string[]; maxWait: number; fallback: string }>;
    ivrs: Array<{ id: string; name: string; extension: string; greeting: string; options: Record<string, string> }>;
  };
  ai: {
    enabled: boolean; assistantId: string; name: string; greeting: string; instructions: string; knowledge: string;
    voice: string; language: string; fallbackExtension: string; transferEnabled: boolean; summariesEnabled: boolean;
  };
  system: { recordingEnabled: boolean; retentionDays: number; emergencyCallingEnabled: boolean };
  platform: {
    controlPlane: 'vocivo'; voiceProvider: 'telnyx'; pstnProvider: 'telnyx' | 'go_telecom' | 'custom';
    sipDomain: 'sip.telnyx.com'; ttsProvider: 'vocivo' | 'telnyx'; carrierFallbackEnabled: boolean;
  };
  updatedAt: string;
};

export type OrganizationPbxSettings = Pick<PbxConfig, 'company' | 'departments' | 'outboundRules' | 'officeHours' | 'callHandling' | 'ai' | 'system'>;

const pathname = 'vocivo/pbx/config.bin';
const cacheTtlMs = 15_000;
let cachedConfig: { expiresAt: number; value: PbxConfig } | null = null;
let configRequest: Promise<PbxConfig> | null = null;

// A factory, not a shared constant: defaultPbxConfig() is called per request and
// callers may mutate the result, so the default week must never alias across calls.
function defaultWeekdays() {
  return Object.fromEntries(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => [day, { enabled: true, start: '00:00', end: '23:59' }]));
}

export function defaultPbxConfig(): PbxConfig {
  return {
    version: 2,
    company: { name: 'Company', timezone: 'Asia/Riyadh', defaultCallerId: '', emergencyAddress: '' },
    activeOrganizationId: 'primary',
    organizations: [{ id: 'primary', name: 'Company', slug: 'company', accountType: 'business', ownerDisplayName: 'Company owner', ownerEmail: '', extensionStart: 2000, extensionEnd: 2019, internalCallingEnabled: true, status: 'active' }],
    numberAssignments: {},
    businessVoiceConfigs: {},
    organizationSettings: {},
    userProfiles: {},
    departments: [{ id: 'general', name: 'General', managerExtension: '' }, { id: 'sales', name: 'Sales', managerExtension: '' }, { id: 'operations', name: 'Operations', managerExtension: '' }],
    outboundRules: [{ id: 'international', name: 'International calling', prefix: '+', extensionRange: '', numberLength: '', department: 'All', routes: ['Vocivo Managed'], enabled: true }],
    officeHours: { timezone: 'Asia/Riyadh', weekdays: defaultWeekdays(), holidays: [] },
    callHandling: { ringGroups: [], queues: [], ivrs: [] },
    ai: { enabled: false, assistantId: '', name: 'Company Receptionist', greeting: 'Welcome. How may I help you today?', instructions: 'You are a professional company receptionist. Answer questions using only the approved company information. Ask concise clarifying questions. If you cannot answer, offer to connect the caller to a colleague.', knowledge: '', voice: 'Telnyx.Bayan.Amanda', language: 'en', fallbackExtension: '2000', transferEnabled: true, summariesEnabled: true },
    system: { recordingEnabled: false, retentionDays: 30, emergencyCallingEnabled: false },
    platform: { controlPlane: 'vocivo', voiceProvider: 'telnyx', pstnProvider: 'telnyx', sipDomain: 'sip.telnyx.com', ttsProvider: 'vocivo', carrierFallbackEnabled: true },
    updatedAt: new Date().toISOString(),
  };
}

function legacyKey() { return createHash('sha256').update(requiredEnv('AUTH_SECRET')).digest(); }
// Domain-separated like the sibling stores; legacyKey() still decrypts configs
// written before this key existed, and every write re-encrypts with key().
function key() { return createHash('sha256').update(`${requiredEnv('AUTH_SECRET')}:pbx-config:v2`).digest(); }
function encrypt(value: PbxConfig) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}
function decryptWith(value: Buffer, secret: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')) as PbxConfig;
}
function decrypt(value: Buffer) {
  try {
    return decryptWith(value, key());
  } catch {
    return decryptWith(value, legacyKey());
  }
}

export function mergePbxConfig(stored?: Partial<PbxConfig>): PbxConfig {
  const base = defaultPbxConfig();
  if (!stored) return base;
  return {
    ...base, ...stored,
    legacyPrimaryOrganizationId: stored.legacyPrimaryOrganizationId || stored.organizations?.[0]?.id || base.organizations[0].id,
    company: { ...base.company, ...(stored.company || {}) },
    officeHours: { ...base.officeHours, ...(stored.officeHours || {}), weekdays: { ...base.officeHours.weekdays, ...(stored.officeHours?.weekdays || {}) } },
    callHandling: { ...base.callHandling, ...(stored.callHandling || {}) },
    ai: { ...base.ai, ...(stored.ai || {}) }, system: { ...base.system, ...(stored.system || {}) },
    platform: {
      ...base.platform,
      pstnProvider: stored.platform?.pstnProvider || base.platform.pstnProvider,
      ttsProvider: stored.platform?.ttsProvider || base.platform.ttsProvider,
      carrierFallbackEnabled: stored.platform?.carrierFallbackEnabled ?? base.platform.carrierFallbackEnabled,
    },
    organizations: stored.organizations?.length ? stored.organizations.map((organization) => ({
      ...organization,
      accountType: organization.accountType || 'business',
      ownerDisplayName: organization.ownerDisplayName || organization.name || 'Account owner',
      ownerEmail: organization.ownerEmail || '',
    })) : base.organizations,
    numberAssignments: stored.numberAssignments || {},
    businessVoiceConfigs: stored.businessVoiceConfigs || {},
    organizationSettings: Object.fromEntries(Object.entries(stored.organizationSettings || {}).map(([organizationId, settings]) => [organizationId, {
      company: { ...base.company, ...(settings.company || {}) },
      departments: settings.departments || base.departments,
      outboundRules: settings.outboundRules || base.outboundRules,
      officeHours: { ...base.officeHours, ...(settings.officeHours || {}), weekdays: { ...base.officeHours.weekdays, ...(settings.officeHours?.weekdays || {}) } },
      callHandling: { ...base.callHandling, ...(settings.callHandling || {}) },
      ai: { ...base.ai, ...(settings.ai || {}) },
      system: { ...base.system, ...(settings.system || {}) },
    }])),
    activeOrganizationId: stored.activeOrganizationId || base.activeOrganizationId,
    userProfiles: stored.userProfiles || {}, updatedAt: stored.updatedAt || base.updatedAt,
  };
}

export function organizationSettingsFrom(config: PbxConfig): OrganizationPbxSettings {
  return {
    company: config.company,
    departments: config.departments,
    outboundRules: config.outboundRules,
    officeHours: config.officeHours,
    callHandling: config.callHandling,
    ai: config.ai,
    system: config.system,
  };
}

/**
 * Which organization the settings that predate multi-tenancy belong to.
 *
 * They live at the top level of the config rather than under
 * organizationSettings, so exactly one tenant may claim them. An administrator
 * pins the owner explicitly; without a pin the historical organizations[0]
 * assumption applies, which is what number-config.ts has always used.
 */
export function legacyPrimaryOrganizationId(config: PbxConfig) {
  const pinned = config.legacyPrimaryOrganizationId;
  if (pinned && !config.organizations.some((item) => item.id === pinned)) {
    throw new Error('Legacy PBX settings owner is missing. Restore its tenant mapping before continuing.');
  }
  return pinned || config.organizations[0]?.id || 'primary';
}

export function pbxForOrganization(config: PbxConfig, organizationId: string): PbxConfig {
  const settings = config.organizationSettings[organizationId];
  if (settings) return { ...config, ...settings, activeOrganizationId: organizationId };
  const organization = config.organizations.find((item) => item.id === organizationId);
  // Whose settings these are is a fact about the tenant, not about who is
  // looking. Keyed on activeOrganizationId, the legacy tenant's voice menu,
  // office hours and AI receptionist moved to whichever customer a superadmin
  // had most recently opened — and stayed there, because opening a customer
  // saves that choice. A customer could start answering calls with another
  // company's greeting because somebody at Vocivo had looked at their account.
  const ownsSharedConfig = organizationId === legacyPrimaryOrganizationId(config);
  if (ownsSharedConfig) return { ...config, activeOrganizationId: organizationId };
  const isolated = defaultPbxConfig();
  return {
    ...config,
    ...organizationSettingsFrom(isolated),
    company: { ...isolated.company, name: organization?.name || isolated.company.name },
    ai: { ...isolated.ai, enabled: false, assistantId: '' },
    callHandling: { ringGroups: [], queues: [], ivrs: [] },
    numberAssignments: Object.fromEntries(Object.entries(config.numberAssignments).filter(([, assignment]) => assignment.organizationId === organizationId)),
    activeOrganizationId: organizationId,
  };
}

function validateOrganizations(config: PbxConfig) {
  if (!config.organizations.length) throw new Error('At least one organization is required.');
  const ids = new Set<string>();
  for (const organization of config.organizations) {
    if (!organization.id || ids.has(organization.id)) throw new Error('Each organization must have a unique ID.');
    ids.add(organization.id);
    if (!organization.name.trim()) throw new Error('Organization name is required.');
    if (!['business', 'individual'].includes(organization.accountType)) throw new Error('Choose a valid account type.');
    if (organization.accountType === 'individual' && organization.internalCallingEnabled) throw new Error('Individual accounts cannot enable company extension calling.');
    if (!Number.isInteger(organization.extensionStart) || !Number.isInteger(organization.extensionEnd) || organization.extensionStart < 10 || organization.extensionEnd > 99999 || organization.extensionEnd < organization.extensionStart) throw new Error('Extension ranges must contain 2 to 5 digit numbers in ascending order.');
    if (organization.extensionEnd - organization.extensionStart + 1 > 10000) throw new Error('An organization extension range cannot exceed 10,000 slots.');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(organization.slug)) throw new Error('Organization slugs may contain lowercase letters, numbers, and single hyphens.');
  }
  if (!ids.has(config.activeOrganizationId)) throw new Error('The active organization is invalid.');
  for (const assignment of Object.values(config.numberAssignments)) {
    if (!ids.has(assignment.organizationId)) throw new Error('Every phone number must belong to an existing organization.');
  }
}

function validateCallHandling(config: PbxConfig) {
  const routeIds = new Set<string>();
  const routeExtensions = new Set<string>();
  const register = (item: { id: string; name: string; extension: string }) => {
    if (!item.id || routeIds.has(item.id)) throw new Error('Every call-handling route must have a unique ID.');
    if (!item.name?.trim()) throw new Error('Every call-handling route requires a name.');
    routeIds.add(item.id);
    if (item.extension) {
      if (!/^\d{2,5}$/.test(item.extension)) throw new Error('Call-handling extensions must contain 2 to 5 digits.');
      if (routeExtensions.has(item.extension)) throw new Error(`Call-handling extension ${item.extension} is already in use.`);
      routeExtensions.add(item.extension);
    }
  };
  for (const group of config.callHandling.ringGroups) {
    register(group);
    if (!Array.isArray(group.members) || !group.members.length) throw new Error(`Ring group ${group.name} needs at least one member.`);
    if (new Set(group.members).size !== group.members.length || group.members.length > 100) throw new Error(`Ring group ${group.name} has invalid members.`);
    if (!Number.isFinite(group.timeout) || group.timeout < 10 || group.timeout > 120) throw new Error(`Ring group ${group.name} timeout must be between 10 and 120 seconds.`);
  }
  for (const queue of config.callHandling.queues) {
    register(queue);
    if (!Array.isArray(queue.members) || !queue.members.length) throw new Error(`Queue ${queue.name} needs at least one member.`);
    if (new Set(queue.members).size !== queue.members.length || queue.members.length > 100) throw new Error(`Queue ${queue.name} has invalid members.`);
    if (!Number.isFinite(queue.maxWait) || queue.maxWait < 15 || queue.maxWait > 900) throw new Error(`Queue ${queue.name} wait time must be between 15 and 900 seconds.`);
  }
  for (const ivr of config.callHandling.ivrs) {
    register(ivr);
    if (!ivr.greeting?.trim()) throw new Error(`Voice menu ${ivr.name} requires a greeting.`);
    const entries = Object.entries(ivr.options || {}).filter(([, target]) => Boolean(target));
    if (!entries.length) throw new Error(`Voice menu ${ivr.name} needs at least one keypad destination.`);
    for (const [digit, target] of entries) {
      if (!/^\d$/.test(digit) || !/^(extension|ring_group|queue):[A-Za-z0-9._-]+$/.test(target)) throw new Error(`Voice menu ${ivr.name} contains an invalid keypad destination.`);
      const [type, id] = target.split(':', 2);
      if (type === 'ring_group' && !config.callHandling.ringGroups.some((item) => item.id === id)) throw new Error(`Voice menu ${ivr.name} points to a missing ring group.`);
      if (type === 'queue' && !config.callHandling.queues.some((item) => item.id === id)) throw new Error(`Voice menu ${ivr.name} points to a missing queue.`);
    }
  }
  for (const assignment of Object.values(config.numberAssignments)) {
    if (assignment.destinationType === 'ring_group' && !config.callHandling.ringGroups.some((item) => item.id === assignment.destinationId)) throw new Error('A phone number points to a missing ring group.');
    if (assignment.destinationType === 'queue' && !config.callHandling.queues.some((item) => item.id === assignment.destinationId)) throw new Error('A phone number points to a missing queue.');
    if (assignment.destinationType === 'ivr' && !config.callHandling.ivrs.some((item) => item.id === assignment.destinationId)) throw new Error('A phone number points to a missing voice menu.');
  }
}

function validateOfficeHours(config: PbxConfig) {
  if (!validTimeZone(config.officeHours.timezone)) throw new Error('Office hours contain an invalid timezone.');
  for (const [day, value] of Object.entries(config.officeHours.weekdays)) {
    if (!validOfficeTime(value.start) || !validOfficeTime(value.end)) throw new Error(`${day} contains an invalid office-hours time.`);
  }
  for (const holiday of config.officeHours.holidays) {
    if (!holiday.id || !holiday.name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(holiday.date)) throw new Error('Every holiday requires a name and valid date.');
    if (!['Main voicemail', 'Main line'].includes(holiday.destination)) throw new Error('Every holiday must route to the main line or main voicemail.');
  }
}

function validateUserProfiles(config: PbxConfig) {
  const forwardingTarget = /^(?:|voicemail|mainvoicemail|\d{2,5}|\+[1-9]\d{6,14})$/i;
  for (const profile of Object.values(config.userProfiles)) {
    if (!Number.isFinite(profile.noAnswerSeconds) || profile.noAnswerSeconds < 10 || profile.noAnswerSeconds > 120) throw new Error('Each user no-answer timeout must be between 10 and 120 seconds.');
    for (const target of [profile.simultaneousRing, profile.forwardBusy, profile.forwardNoAnswer, profile.forwardUnavailable]) {
      if (!forwardingTarget.test((target || '').replace(/[\s()-]/g, ''))) throw new Error('Call forwarding destinations must be voicemail, an extension, or a complete international number.');
    }
    if (!['Use office hours', 'Always available', 'Custom schedule'].includes(profile.schedule)) throw new Error('A user contains an invalid routing schedule.');
  }
}

export async function readPbxConfig(options: { fresh?: boolean } = {}) {
  if (!options.fresh && cachedConfig?.expiresAt && cachedConfig.expiresAt > Date.now()) return structuredClone(cachedConfig.value);
  configRequest ||= (async () => {
    const value = await readStoredObject(pathname);
    const config = mergePbxConfig(value ? decrypt(value) : defaultPbxConfig());
    cachedConfig = { expiresAt: Date.now() + cacheTtlMs, value: config };
    return config;
  })().finally(() => { configRequest = null; });
  return structuredClone(await configRequest);
}

function validatePbxConfig(next: PbxConfig) {
  validateOrganizations(next);
  for (const organization of next.organizations) {
    const tenant = pbxForOrganization(next, organization.id);
    tenant.numberAssignments = Object.fromEntries(Object.entries(next.numberAssignments).filter(([, assignment]) => assignment.organizationId === organization.id));
    validateCallHandling(tenant);
    validateOfficeHours(tenant);
  }
  validateUserProfiles(next);
}

export class PbxConfigConflictError extends Error {
  constructor() { super('PBX configuration changed. Reload it and try again.'); }
}

type PbxConfigUpdate = Partial<PbxConfig> | ((current: PbxConfig) => Partial<PbxConfig> | PbxConfig);

/** Storage contract for atomic multi-object updates (for example trunk + DIDs).
 * Callers must lock pathname with their other objects; every write is validated.
 */
export const pbxConfigStorage = {
  pathname,
  read: (stored: Buffer | null) => mergePbxConfig(stored ? decrypt(stored) : defaultPbxConfig()),
  update(current: PbxConfig, patch: Partial<PbxConfig>) {
    const next = mergePbxConfig({ ...current, ...patch, updatedAt: new Date().toISOString() });
    validatePbxConfig(next);
    return encrypt(next);
  },
  invalidate() { cachedConfig = null; },
};

export async function savePbxConfig(input: PbxConfigUpdate, options: { expectedUpdatedAt?: string } = {}): Promise<PbxConfig> {
  let next: PbxConfig | null = null;
  await transactObject(pathname, (stored) => {
    const current = mergePbxConfig(stored ? decrypt(stored) : defaultPbxConfig());
    if (options.expectedUpdatedAt && current.updatedAt !== options.expectedUpdatedAt) throw new PbxConfigConflictError();
    const update = typeof input === 'function' ? input(structuredClone(current)) : input;
    next = mergePbxConfig({ ...current, ...update, updatedAt: new Date().toISOString() });
    validatePbxConfig(next);
    return encrypt(next);
  }, { access: 'private', contentType: 'application/octet-stream' });
  if (!next) throw new Error('PBX configuration update did not complete.');
  cachedConfig = { expiresAt: Date.now() + cacheTtlMs, value: structuredClone(next) };
  return next;
}
