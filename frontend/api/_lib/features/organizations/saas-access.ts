import { isPlatformOwnerSession, type VocivoSession } from '../auth/auth.js';
import { readPbxConfig, type PbxConfig } from './pbx-config-store.js';
import { effectiveEntitlements, readTenantSaasState, type FeatureKey } from './saas-store.js';

type PlatformAccess = { superadmin: true };
type TenantAccess = ReturnType<typeof effectiveEntitlements> & {
  superadmin: false;
  organization: PbxConfig['organizations'][number];
};
export type SessionAccess = PlatformAccess | TenantAccess;

export async function accessForSession(session: VocivoSession, config?: PbxConfig): Promise<SessionAccess> {
  // The same test requireAdmin uses. These two disagreed — one accepted owner
  // and superadmin, this one only superadmin — so a session carrying the owner
  // role would pass as a platform administrator there and fall through to
  // accessForOrganization('') here, answering the platform owner with
  // "not enabled for this company". Unreachable only because createSession
  // hardcodes the role, which is precisely how it would survive to bite later.
  if (isPlatformOwnerSession(session)) return { superadmin: true as const };
  const pbx = config || await readPbxConfig();
  return accessForOrganization(session.organizationId || '', pbx);
}

export async function accessForOrganization(organizationId: string, config?: PbxConfig): Promise<TenantAccess> {
  const pbx = config || await readPbxConfig();
  const organization = pbx.organizations.find((item) => item.id === organizationId);
  if (!organization || organization.status !== 'active') throw new Error('Organization inactive');
  const access = effectiveEntitlements(await readTenantSaasState(organization.id, pbx), organization.id, organization.accountType);
  if (!access.serviceActive) throw new Error('Subscription inactive');
  return { superadmin: false as const, organization, ...access };
}

export async function requireFeature(session: VocivoSession, feature: FeatureKey, config?: PbxConfig) {
  const access = await accessForSession(session, config);
  if (access.superadmin === false && !access.features[feature]) throw new Error('Feature not enabled');
  return access;
}
