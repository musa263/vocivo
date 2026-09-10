import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin } from '../../auth/auth.js';
import { allowMobile, methodNotAllowed, publicError, writeAuthError } from '../../../shared/http.js';
import { pbxForOrganization, readPbxConfig } from '../../organizations/pbx-config-store.js';
import { requestOrganizationId, writeTenantScopeError } from '../../organizations/request-organization.js';
import { requireFeature } from '../../organizations/saas-access.js';
import { listExtensions } from '../../organizations/pbx.js';
import { carrierTrunks, CarrierTrunkError, normalizeCarrierTrunk } from '../carrier-trunk-store.js';
import { removeCompanyNumber, useCarrierNumbers, withLiveNumberRoutes, publishCarrierNumbers } from '../carrier-number-service.js';
import { carrierReadiness } from '../carrier-runtime.js';

export function createCarrierTrunksHandler(deps = { requireAdmin, readPbxConfig, requireFeature, listExtensions, store: carrierTrunks }, numberOps = { removeCompanyNumber, useCarrierNumbers }) {
  return async (req: VercelRequest, res: VercelResponse) => {
    if (allowMobile(req, res)) return;
    if (!['GET', 'PUT', 'PATCH'].includes(req.method || '')) return methodNotAllowed(res, ['GET', 'PUT', 'PATCH']);
    try {
      const access = await deps.requireAdmin(req), config = await deps.readPbxConfig();
      const organizationId = requestOrganizationId(req, access.session, config);
      if (!config.organizations.some(item => item.id === organizationId && item.status === 'active')) return res.status(403).json({ error: 'Organization inactive.' });
      await deps.requireFeature({ ...access.session, organizationId }, 'sipTrunks', config);
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET') return res.status(200).json({ trunks: (await deps.store.list(organizationId)).map(trunk => {
        const { status, reason } = carrierReadiness(trunk);
        return { ...withLiveNumberRoutes(trunk, config), connectionStatus: status, connectionMessage: reason };
      }), callingMode: pbxForOrganization(config, organizationId).company.callingMode || 'managed' });
      if (req.body?.organizationId && req.body.organizationId !== organizationId) throw new CarrierTrunkError(409, 'This trunk belongs to another workspace.');
      if (req.method === 'PATCH') {
        const subscription = await deps.requireFeature({ ...access.session, organizationId }, 'phoneNumbers', config);
        if (req.body?.action === 'use-carrier-numbers') {
          const trunk = await numberOps.useCarrierNumbers(organizationId, String(req.body.id || ''), Number(req.body.revision),
            subscription.superadmin ? 10000 : subscription.plan!.limits.phoneNumbers);
          return res.status(200).json({ trunk, callingMode: 'carrier' });
        }
        if (req.body?.action === 'remove-company-number') {
          await numberOps.removeCompanyNumber(organizationId, String(req.body.phoneNumber || ''));
          return res.status(200).json({ removed: true });
        }
        throw new CarrierTrunkError(400, 'Choose a supported carrier-number action.');
      }
      const draft = normalizeCarrierTrunk(req.body || {}, organizationId);
      for (const number of draft.numbers) {
        const live = config.numberAssignments[number.callerId];
        if (live?.organizationId === organizationId && live.carrierTrunkId === draft.id
          && (number.destinationType !== (live.disabled ? 'unassigned' : live.destinationType || 'unassigned') || number.destinationId !== (live.disabled ? '' : live.destinationId || ''))) {
          throw new CarrierTrunkError(409, 'Routing changed. Manage published destinations in Phone numbers or Users, then reload this trunk.');
        }
      }
      const pbx = pbxForOrganization(config, organizationId);
      const extensions = draft.numbers.some(item => item.destinationType === 'extension') ? await deps.listExtensions(organizationId) : [];
      for (const number of draft.numbers) {
        const targets = number.destinationType === 'extension' ? extensions
          : number.destinationType === 'ring_group' ? pbx.callHandling.ringGroups
          : number.destinationType === 'queue' ? pbx.callHandling.queues
          : number.destinationType === 'ivr' ? pbx.callHandling.ivrs : null;
        if (targets && !targets.some(item => item.id === number.destinationId)) throw new CarrierTrunkError(400, 'Choose a destination from this company.');
      }
      const published = Object.values(config.numberAssignments).some(item => item.organizationId === organizationId && item.carrierTrunkId === draft.id && !item.disabled);
      const subscription = published ? await deps.requireFeature({ ...access.session, organizationId }, 'phoneNumbers', config) : null;
      const limit = subscription ? subscription.superadmin ? 10000 : subscription.plan!.limits.phoneNumbers : undefined;
      const trunk = await deps.store.save(organizationId, { ...draft, password: req.body.password, revision: req.body.revision }, (current, saved) => {
        const live = Object.values(current.numberAssignments).some(item => item.organizationId === organizationId && item.carrierTrunkId === saved.id && !item.disabled);
        if (!live) return undefined;
        if (limit === undefined) throw new CarrierTrunkError(409, 'Publication changed. Reload this trunk before saving.');
        return publishCarrierNumbers(current, organizationId, saved, limit);
      });
      const { status, reason } = carrierReadiness(trunk);
      return res.status(200).json({ trunk: { ...withLiveNumberRoutes(trunk, await deps.readPbxConfig()), connectionStatus: status, connectionMessage: reason } });
    } catch (error) {
      if (writeTenantScopeError(res, error) || writeAuthError(res, error)) return;
      if (error instanceof CarrierTrunkError) return res.status(error.status).json({ error: error.message });
      if (error instanceof Error && /Feature not enabled|Subscription inactive|Organization inactive/.test(error.message)) return res.status(403).json({ error: 'SIP trunk management is not enabled for this company.' });
      return res.status(500).json({ error: publicError(error) });
    }
  };
}
export default createCarrierTrunksHandler();
