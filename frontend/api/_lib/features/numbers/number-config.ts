import { requiredEnv } from '../../shared/http.js';
import { inboundConnectionId, telnyx } from '../../shared/telnyx.js';
import { legacyPrimaryOrganizationId, readPbxConfig, savePbxConfig, type PbxConfig } from '../organizations/pbx-config-store.js';
import { numberOrganizationId } from '../organizations/tenancy.js';

export type BusinessVoiceConfig = {
  enabled: boolean;
  voicemailEnabled: boolean;
  voicemailDelaySeconds: number;
  voicemailGreeting: string;
  companyName: string;
  greeting: string;
  waitingMessage: string;
  departments: string[];
  voice: string;
  backgroundImageUrl: string;
};

const configPrefix = 'vocfg_';
const passwordPrefix = 'vopwd_';
const defaults: BusinessVoiceConfig = {
  enabled: false,
  voicemailEnabled: false,
  voicemailDelaySeconds: 25,
  voicemailGreeting: 'We are unable to answer your call. Please leave a message after the tone.',
  // No company's name ships in the platform. Both are filled in from the
  // tenant's own organization name by `withCompanyIdentity` on the way out, so
  // an unconfigured tenant greets callers as themselves and never as whichever
  // company Vocivo happened to serve first.
  companyName: '',
  greeting: '',
  waitingMessage: 'Thank you for waiting. A member of our team will be with you shortly.',
  departments: ['Sales', 'Operations'],
  voice: 'AWS.Polly.Joanna-Neural',
  backgroundImageUrl: '',
};

type NumberResource = { tags?: string[] };

/**
 * A tag Vocivo keeps on a carrier number for its own use.
 *
 * The business voice configuration that predates multi-tenancy is stored in
 * `vocfg_` tags, and the platform owner's password hash used to be stored in a
 * `vopwd_` one. Neither is the tenant's to read or to write: the numbers screen
 * showed every tag on a number the tenant owns and saved back whatever it was
 * given, so a company administrator could read the owner's password hash and
 * replace it with a hash of their own choosing.
 */
export function isInternalNumberTag(tag: unknown) {
  return typeof tag === 'string' && (tag.startsWith(configPrefix) || tag.startsWith(passwordPrefix));
}

/** The tags a tenant may see on their own number. */
export function tenantVisibleNumberTags(tags: unknown) {
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string' && !isInternalNumberTag(tag)) : [];
}

/**
 * The tag list to save: the tenant's own tags as they asked for them, with
 * Vocivo's kept exactly as they were. A request cannot add one, change one, or
 * drop one by leaving it out.
 */
export function nextNumberTags(existing: unknown, requested: unknown) {
  const keep = Array.isArray(existing) ? existing.filter(isInternalNumberTag) as string[] : [];
  const asked = Array.isArray(requested)
    ? requested.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim().slice(0, 50)).filter((tag) => tag && !isInternalNumberTag(tag))
    : [];
  return [...keep, ...[...new Set(asked)].slice(0, 20)];
}

async function readTags() {
  const response = await telnyx(`/phone_numbers/${requiredEnv('TELNYX_PHONE_NUMBER_ID')}`);
  const payload = await response.json() as { data?: NumberResource };
  return payload.data?.tags ?? [];
}

async function writeTags(tags: string[]) {
  await telnyx(`/phone_numbers/${requiredEnv('TELNYX_PHONE_NUMBER_ID')}`, {
    method: 'PATCH',
    body: JSON.stringify({ tags }),
  });
}

async function writeNumber(body: Record<string, unknown>) {
  await telnyx(`/phone_numbers/${requiredEnv('TELNYX_PHONE_NUMBER_ID')}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function bounded(value: unknown, fallback: string, max: number) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

function voicemailDelay(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(60, Math.max(15, Math.round(parsed))) : defaults.voicemailDelaySeconds;
}

function departments(value: unknown, legacyOne?: unknown, legacyTwo?: unknown) {
  const source = Array.isArray(value) ? value : [legacyOne, legacyTwo];
  const normalized = source.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim().slice(0, 40)).slice(0, 5);
  return normalized.length >= 1 ? normalized : defaults.departments;
}

/**
 * The legacy configuration is a carrier round trip, and the inbound dialplan
 * asks for it at every routing step of every call — so a slow carrier API was
 * dead air on the line and an unreachable one was a call that failed to route
 * at all. Held briefly in the instance that fetched it, and held on to if the
 * carrier stops answering: a stale greeting is better than no dialplan.
 */
let cachedTaggedConfig: { expiresAt: number; value: BusinessVoiceConfig } | null = null;
const taggedConfigTtlMs = 60_000;

async function readTaggedBusinessVoiceConfig(): Promise<BusinessVoiceConfig> {
  if (cachedTaggedConfig && cachedTaggedConfig.expiresAt > Date.now()) return cachedTaggedConfig.value;
  try {
    const value = await readTaggedBusinessVoiceConfigFromCarrier();
    cachedTaggedConfig = { expiresAt: Date.now() + taggedConfigTtlMs, value };
    return value;
  } catch (error) {
    console.error('Could not read the legacy business voice configuration from the carrier.', error);
    return cachedTaggedConfig?.value || defaults;
  }
}

async function readTaggedBusinessVoiceConfigFromCarrier(): Promise<BusinessVoiceConfig> {
  const tags = await readTags();
  const current = tags.filter((tag) => tag.startsWith(configPrefix));
  const chunks = current.map((tag) => tag.slice(configPrefix.length).match(/^(\d+)_(.+)$/)).filter((match): match is RegExpMatchArray => Boolean(match)).sort((a, b) => Number(a[1]) - Number(b[1])).map((match) => match[2]);
  if (!chunks.length) return defaults;
  try {
    const stored = JSON.parse(Buffer.from(chunks.join(''), 'base64url').toString('utf8')) as Partial<BusinessVoiceConfig>;
    return {
      enabled: Boolean(stored.enabled),
      voicemailEnabled: Boolean(stored.voicemailEnabled),
      voicemailDelaySeconds: voicemailDelay(stored.voicemailDelaySeconds),
      voicemailGreeting: bounded(stored.voicemailGreeting, defaults.voicemailGreeting, 500),
      companyName: bounded(stored.companyName, defaults.companyName, 80),
      greeting: bounded(stored.greeting, defaults.greeting, 500),
      waitingMessage: bounded(stored.waitingMessage, defaults.waitingMessage, 500),
      departments: departments(stored.departments, (stored as Partial<BusinessVoiceConfig> & { departmentOne?: string }).departmentOne, (stored as Partial<BusinessVoiceConfig> & { departmentTwo?: string }).departmentTwo),
      voice: bounded(stored.voice, defaults.voice, 100),
      backgroundImageUrl: typeof stored.backgroundImageUrl === 'string' && /^https:\/\//.test(stored.backgroundImageUrl) ? stored.backgroundImageUrl.slice(0, 500) : '',
    };
  } catch {
    return defaults;
  }
}

// The Telnyx-tag-based legacy config belongs to exactly one organization, and
// to the same one the rest of the legacy settings belong to.
const resolveLegacyPrimaryOrganizationId = legacyPrimaryOrganizationId;

/**
 * Fills in the company name and greeting a tenant never set.
 *
 * The stored configuration may legitimately be silent about both — a carrier
 * tag that predates the field, a customer who never opened the voice screen, a
 * carrier read that failed. The answer is the tenant's own organization name,
 * never a name compiled into the platform, and a caller to a company that has
 * not named itself hears a greeting with no company in it at all.
 */
function withCompanyIdentity(config: BusinessVoiceConfig, organizationName: string): BusinessVoiceConfig {
  const companyName = config.companyName.trim() || (organizationName || '').trim();
  const greeting = config.greeting.trim() || (companyName ? `Welcome to ${companyName}.` : 'Thank you for calling.');
  return { ...config, companyName, greeting };
}

export async function readBusinessVoiceConfig(organizationId = 'primary'): Promise<BusinessVoiceConfig> {
  const pbx = await readPbxConfig();
  const organizationName = pbx.organizations.find((item) => item.id === organizationId)?.name || '';
  if (pbx.businessVoiceConfigs[organizationId]) return withCompanyIdentity({ ...defaults, ...pbx.businessVoiceConfigs[organizationId] }, organizationName);
  if (organizationId === resolveLegacyPrimaryOrganizationId(pbx)) return withCompanyIdentity(await readTaggedBusinessVoiceConfig(), organizationName);
  return withCompanyIdentity(defaults, organizationName);
}

export async function saveBusinessVoiceConfig(input: Partial<BusinessVoiceConfig>, organizationId = 'primary') {
  const config: BusinessVoiceConfig = {
    enabled: Boolean(input.enabled),
    voicemailEnabled: Boolean(input.voicemailEnabled),
    voicemailDelaySeconds: voicemailDelay(input.voicemailDelaySeconds),
    voicemailGreeting: bounded(input.voicemailGreeting, defaults.voicemailGreeting, 500),
    companyName: bounded(input.companyName, defaults.companyName, 80),
    greeting: bounded(input.greeting, defaults.greeting, 500),
    waitingMessage: bounded(input.waitingMessage, defaults.waitingMessage, 500),
    departments: departments(input.departments),
    voice: bounded(input.voice, defaults.voice, 100),
    backgroundImageUrl: typeof input.backgroundImageUrl === 'string' && /^https:\/\//.test(input.backgroundImageUrl) ? input.backgroundImageUrl.slice(0, 500) : '',
  };
  cachedTaggedConfig = null;
  const pbx = await savePbxConfig((current) => ({ businessVoiceConfigs: { ...current.businessVoiceConfigs, [organizationId]: config } }));
  const numbers: Array<{ id: string; phone_number: string; connection_id?: string | null }> = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await telnyx(`/phone_numbers?page[size]=250&filter[status]=active&page[number]=${page}`);
    const payload = await response.json() as { data?: Array<{ id: string; phone_number: string; connection_id?: string | null }>; meta?: { total_pages?: number } };
    numbers.push(...(payload.data ?? []));
    if (!payload.data?.length || page >= (payload.meta?.total_pages || 1)) break;
  }
  // The tenant's numbers are kept on the connection that delivers inbound to
  // Vocivo. That is the SIP edge when it answers inbound; before this check,
  // every save here moved them back onto the Call Control application.
  const inboundConnection = inboundConnectionId();
  if (inboundConnection) {
    await Promise.all(numbers
      .filter((item) => numberOrganizationId(item.phone_number, pbx) === organizationId && item.connection_id !== inboundConnection)
      .map((item) => telnyx(`/phone_numbers/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ connection_id: inboundConnection }) })));
  }
  return config;
}
