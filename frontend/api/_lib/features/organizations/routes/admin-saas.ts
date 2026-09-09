import { isCompanyAdministrator } from '../../auth/company-account.js';
import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin } from '../../auth/auth.js';
import { allowMobile, methodNotAllowed, publicError, writeAuthError } from '../../../shared/http.js';
import { listExtensions } from '../pbx.js';
import { defaultPbxConfig, organizationSettingsFrom, PbxConfigConflictError, readPbxConfig, savePbxConfig } from '../pbx-config-store.js';
import {
  createSubscription, effectiveEntitlements, featureCatalog, publicTenantAdmin,
  readPlatformSaasState, readTenantSaasState, removeAllTenantAdmins, removeTenantAdmin,
  saveSaasFeatureOverrides, saveSaasPlan, saveSaasSubscription, saveTenantAdmin,
  type FeatureKey, type SaasPlan, type SaasSubscription,
} from '../saas-store.js';
import { VOCIVO_PLATFORM_NAME } from '../platform-identity.js';

function text(value: unknown, max = 100) {
  return typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').trim().slice(0, max) : '';
}

function slug(value: unknown) {
  return text(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function responseFor(superadmin: boolean, organizationId?: string) {
  const config = await readPbxConfig();
  const state = superadmin
    ? await readPlatformSaasState(config)
    : await readTenantSaasState(organizationId || '', config);
  const extensions = await listExtensions(superadmin ? undefined : organizationId);
  const organizations = config.organizations
    .filter((organization) => superadmin || organization.id === organizationId)
    .map((organization) => {
      const access = effectiveEntitlements(state, organization.id, organization.accountType);
      const users = extensions.filter((extension) => extension.organizationId === organization.id);
      return {
        ...organization,
        subscription: access.subscription,
        plan: access.plan,
        entitlements: access.features,
        featureOverrides: state.featureOverrides[organization.id] || {},
        admins: state.tenantAdmins.filter((account) => account.organizationId === organization.id && isCompanyAdministrator(account.role)).map(publicTenantAdmin),
        usage: { seats: users.length, phoneNumbers: Object.values(config.numberAssignments).filter((assignment) => assignment.organizationId === organization.id).length },
      };
    });
  const active = organizations.filter((organization) => organization.subscription.status === 'active');
  const mrr = active.reduce((total, organization) => total + (organization.subscription.billingCycle === 'annual' ? organization.subscription.amount / 12 : organization.subscription.amount), 0);
  return {
    platform: superadmin ? {
      name: VOCIVO_PLATFORM_NAME,
      owner: VOCIVO_PLATFORM_NAME,
      accountType: 'platform',
      customers: organizations.length,
      activeSubscriptions: active.length,
      trials: organizations.filter((organization) => organization.subscription.status === 'trialing').length,
      attention: organizations.filter((organization) => ['past_due', 'suspended'].includes(organization.subscription.status)).length,
      seats: organizations.reduce((total, organization) => total + organization.usage.seats, 0),
      monthlyRecurringRevenue: Math.round(mrr * 100) / 100,
      currency: 'USD',
    } : undefined,
    featureCatalog,
    plans: state.plans,
    organizations,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  if (!['GET', 'PUT', 'DELETE'].includes(req.method || '')) return methodNotAllowed(res, ['GET', 'PUT', 'DELETE']);
  try {
    const access = await requireAdmin(req);
    if (req.method === 'GET') return res.status(200).json(await responseFor(access.superadmin, access.organizationId));
    if (!access.superadmin) return res.status(403).json({ error: 'Only a Vocivo superadmin can manage customer subscriptions and feature access.' });

    let config = await readPbxConfig();
    let state = await readPlatformSaasState(config);
    const action = text(req.body?.action, 40);
    // The verb has to agree with the action. Dispatching on the body alone
    // meant a DELETE carrying action "save_company" created a customer, so any
    // proxy rule, audit trail or log filter keyed on the method described
    // something other than what happened.
    if (action.startsWith('delete_') ? req.method !== 'DELETE' : req.method !== 'PUT') {
      return res.status(405).json({ error: `${action.startsWith('delete_') ? 'Deleting' : 'Saving'} uses ${action.startsWith('delete_') ? 'DELETE' : 'PUT'}.` });
    }

    if (action === 'save_company') {
      const input = req.body?.organization || {};
      const existing = config.organizations.find((organization) => organization.id === input.id);
      const id = existing?.id || text(input.id, 60) || randomUUID();
      const name = text(input.name, 100);
      const accountType: 'business' | 'individual' = input.accountType === 'individual' ? 'individual' : 'business';
      if (!name) return res.status(400).json({ error: 'Company name is required.' });
      const incomingAdmin = req.body?.admin || {};
      const existingAdmins = state.tenantAdmins.filter((account) => account.organizationId === id && isCompanyAdministrator(account.role));
      if (accountType === 'business' && !existingAdmins.length && !text(incomingAdmin.email, 160)) return res.status(400).json({ error: 'Business customers require a company owner or administrator.' });
      if (accountType === 'business' && text(incomingAdmin.email, 160)) {
        const email = text(incomingAdmin.email, 160).toLowerCase();
        const password = typeof incomingAdmin.password === 'string' ? incomingAdmin.password : '';
        if (!text(incomingAdmin.name, 80)) return res.status(400).json({ error: 'Administrator name is required.' });
        if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid administrator email.' });
        if (!incomingAdmin.id && (password.length < 10 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password))) return res.status(400).json({ error: 'Temporary password must have 10 characters, upper and lowercase letters, and a number.' });
        if (state.tenantAdmins.some((account) => account.email === email && account.id !== incomingAdmin.id)) return res.status(400).json({ error: 'This email already belongs to another customer administrator.' });
        const otherActiveAdmins = existingAdmins.filter((account) => account.id !== incomingAdmin.id && account.status === 'active');
        if (incomingAdmin.status === 'suspended' && !otherActiveAdmins.length) return res.status(400).json({ error: 'Business customers require at least one active company administrator.' });
      }
      const organization: typeof config.organizations[number] = {
        id,
        name,
        slug: slug(input.slug || name),
        accountType,
        ownerDisplayName: text(input.ownerDisplayName, 100) || name,
        ownerEmail: text(input.ownerEmail, 160).toLowerCase(),
        extensionStart: accountType === 'business' ? Number(input.extensionStart || existing?.extensionStart || 2000) : Number(input.extensionStart || existing?.extensionStart || 90000),
        extensionEnd: accountType === 'business' ? Number(input.extensionEnd || existing?.extensionEnd || 2019) : Number(input.extensionEnd || existing?.extensionEnd || 90000),
        internalCallingEnabled: accountType === 'business' && input.internalCallingEnabled !== false,
        status: input.status === 'suspended' ? 'suspended' as const : 'active' as const,
      };
      const newSettings = organizationSettingsFrom(defaultPbxConfig());
      newSettings.company = { ...newSettings.company, name, callingMode: 'carrier' };
      // Editing a customer must not move it: the order of this list is the
      // order the console shows, and it used to decide which tenant owned the
      // settings that predate multi-tenancy. An edit replaces the row in place.
      const organizations = existing
        ? config.organizations.map((item) => (item.id === id ? organization : item))
        : [...config.organizations, organization];
      config = await savePbxConfig({ organizations,
        ...(!existing ? { organizationSettings: { ...config.organizationSettings, [id]: newSettings } } : {}),
      }, { expectedUpdatedAt: config.updatedAt });
      state = await readPlatformSaasState(config);
      const planId = text(req.body?.subscription?.planId, 50) || (accountType === 'business' ? 'business' : 'starter');
      const subscription = createSubscription(id, planId, state, req.body?.subscription || {});
      await saveSaasSubscription(id, subscription, config);
      if (accountType === 'individual') await removeAllTenantAdmins(id, config);
      if (accountType === 'business' && incomingAdmin.email) await saveTenantAdmin({ ...incomingAdmin, organizationId: id }, config);
    } else if (action === 'save_subscription') {
      const organizationId = text(req.body?.organizationId, 60);
      if (!config.organizations.some((organization) => organization.id === organizationId)) return res.status(404).json({ error: 'Company not found.' });
      const subscription = createSubscription(organizationId, text(req.body?.subscription?.planId, 50), state, req.body?.subscription as Partial<SaasSubscription>);
      await saveSaasSubscription(organizationId, subscription, config);
    } else if (action === 'save_entitlements') {
      const organizationId = text(req.body?.organizationId, 60);
      if (!config.organizations.some((organization) => organization.id === organizationId)) return res.status(404).json({ error: 'Company not found.' });
      const overrides = Object.fromEntries(featureCatalog.filter((feature) => typeof req.body?.features?.[feature.id] === 'boolean').map((feature) => [feature.id, req.body.features[feature.id]])) as Partial<Record<FeatureKey, boolean>>;
      await saveSaasFeatureOverrides(organizationId, overrides, config);
    } else if (action === 'save_admin') {
      await saveTenantAdmin(req.body?.admin || {}, config);
    } else if (action === 'save_plan') {
      const input = req.body?.plan as Partial<SaasPlan>;
      const id = text(input?.id, 50) || slug(input?.name);
      if (!id || !text(input?.name, 80)) return res.status(400).json({ error: 'Plan name is required.' });
      const current = state.plans.find((plan) => plan.id === id);
      const plan = { ...current, ...input, id, name: text(input.name, 80) } as SaasPlan;
      await saveSaasPlan(plan, config);
    } else if (req.method === 'DELETE' && action === 'delete_admin') {
      const id = text(req.body?.id || req.query.id, 80);
      const account = state.tenantAdmins.find((item) => item.id === id);
      const organization = account ? config.organizations.find((item) => item.id === account.organizationId) : undefined;
      const remainingAdmins = account ? state.tenantAdmins.filter((item) => item.organizationId === account.organizationId && item.status === 'active' && isCompanyAdministrator(item.role) && item.id !== id) : [];
      if (account && organization?.accountType === 'business' && !remainingAdmins.length) return res.status(409).json({ error: 'Assign another company administrator before deleting this account.' });
      if (account) await removeTenantAdmin(id, account.organizationId, config);
    } else {
      return res.status(400).json({ error: 'Choose a valid SaaS administration action.' });
    }

    return res.status(200).json(await responseFor(true));
  } catch (error) {
    if (error instanceof PbxConfigConflictError) return res.status(409).json({ error: error.message });
    if (writeAuthError(res, error)) return;
    if (error instanceof Error && error.message === 'Forbidden') return res.status(403).json({ error: 'Administrator access is required.' });
    if (error instanceof Error && /required|valid|organization|company|subscription|plan|password|email|extension|range|account/i.test(error.message)) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: publicError(error) });
  }
}
