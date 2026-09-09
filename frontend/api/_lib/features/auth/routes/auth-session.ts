import type { VercelRequest, VercelResponse } from '@vercel/node';
import { clearSessionCookies, requireSession } from '../auth.js';
import { allowMobile, methodNotAllowed, writeAuthError } from '../../../shared/http.js';
import { readPbxConfig } from '../../organizations/pbx-config-store.js';
import { effectiveEntitlements, readTenantSaasState } from '../../organizations/saas-store.js';
import { VOCIVO_PLATFORM_NAME, VOCIVO_SUPERADMIN_NAME } from '../../organizations/platform-identity.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  if (req.method === 'DELETE') {
    // Logout: clearing cookies needs no valid session and must always succeed.
    clearSessionCookies(res);
    return res.status(200).json({ success: true });
  }
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'DELETE']);
  try {
    const session = await requireSession(req);
    const isOwner = session.sub === 'vocivo-owner';
    const config = await readPbxConfig();
    const organization = session.organizationId ? config.organizations.find((item) => item.id === session.organizationId) : undefined;
    const access = organization ? effectiveEntitlements(await readTenantSaasState(organization.id, config), organization.id, organization.accountType) : undefined;
    return res.status(200).json({
      profile: {
        id: session.sub,
        email: session.email,
        full_name: isOwner ? process.env.APP_ADMIN_NAME || VOCIVO_SUPERADMIN_NAME : session.name || `Extension ${session.extension || ''}`,
        currency: 'USD',
        extension: organization?.accountType === 'business' ? session.extension : undefined,
        organization_id: session.organizationId,
        role: session.role,
        account_type: isOwner ? 'platform' : organization?.accountType || session.accountType || 'business',
        organization_name: isOwner ? VOCIVO_PLATFORM_NAME : organization?.name,
        organization_owner: isOwner ? VOCIVO_PLATFORM_NAME : organization?.ownerDisplayName,
        admin_only: Boolean(session.accountId && !session.extensionId) || isOwner,
        force_password_change: Boolean(session.forcePasswordChange),
        entitlements: access?.features,
        subscription: access ? { plan: access.plan.name, status: access.subscription.status, renews_at: access.subscription.renewsAt } : undefined,
      },
    });
  } catch (error) {
    // Only a real authentication failure is a sign-out. This used to answer 401
    // to anything that threw in here — a blob-store hiccup, or the deliberate
    // "owner session verification is temporarily unavailable" — and the web app
    // treats 401 as the user being signed out: it cleared the session and
    // unmounted the whole shell, including the element carrying live call
    // audio. A backend blip is a 503, which the app retries.
    if (writeAuthError(res, error)) return;
    return res.status(503).json({ error: 'Sign-in is temporarily unavailable. Please try again in a moment.' });
  }
}
