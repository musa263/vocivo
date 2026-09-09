import { acquireTenantMutation } from '../../organizations/tenant-mutation.js';
import { pendingNumberPurchases, changePendingNumberPurchases } from '../purchase-reservations.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin } from '../../auth/auth.js';
import { allowMobile, methodNotAllowed, publicError, writeAuthError, requiredEnv } from '../../../shared/http.js';
import { nextNumberTags, tenantVisibleNumberTags } from '../number-config.js';
import { inboundConnectionId, telnyx, TelnyxApiError, telnyxPstnConnectionId } from '../../../shared/telnyx.js';
import { pbxForOrganization, readPbxConfig } from '../../organizations/pbx-config-store.js';
import { assignNumberToOrganization, removeNumberAssignment } from '../../organizations/tenancy.js';
import { getExtension } from '../../organizations/pbx.js';
import { requireFeature } from '../../organizations/saas-access.js';
import { invalidatePhoneNumberCache } from '../phone-number-access.js';
import { requestOrganizationId, writeTenantScopeError } from '../../organizations/request-organization.js';
import { carrierMode, carrierNumberInventory, withLiveNumberRoutes } from '../carrier-number-service.js';
import { carrierTrunks } from '../carrier-trunk-store.js';

function text(value: unknown, max: number) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }

function successfulOrderNumbers(order: Record<string, any> | undefined) {
  return (order?.phone_numbers || [])
    .filter((item: { phone_number?: string; status?: string }) => item?.phone_number && /^(success|complete|purchased)$/i.test(String(item.status || '')))
    .map((item: { phone_number: string }) => item.phone_number);
}

async function assignFulfilledNumbers(organizationId: string, phoneNumbers: string[], options: { failOnError?: boolean; limit?: number } = {}) {
  await Promise.all([...new Set(phoneNumbers)].map(async (phoneNumber) => {
    try {
      await assignNumberToOrganization(phoneNumber, organizationId, { source: 'owned', destinationType: 'main' }, { limit: options.limit });
      await changePendingNumberPurchases(organizationId, [], [phoneNumber]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.failOnError && message.includes('already belongs to another organization')) {
        console.warn('Vocivo skipped assigning a purchased number already owned by another organization', { organizationId, phoneNumber });
        return;
      }
      if (options.failOnError) throw error;
      console.warn('Vocivo delayed number assignment failed', { organizationId, phoneNumber, error: message });
    }
  }));
}

type AvailableNumber = {
  phone_number: string;
  phone_number_type?: string;
  locality?: string;
  region_information?: Array<{ region_type?: string; region_name?: string }>;
  cost_information?: { upfront_cost?: string; monthly_cost?: string; currency?: string };
  features?: Array<{ name?: string }>;
  reservable?: boolean;
  best_effort?: boolean;
  quickship?: boolean;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method || '')) return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
  let release: (() => Promise<boolean>) | undefined;
  try {
    const access = await requireAdmin(req);
    let config = await readPbxConfig();
    const subscriptionAccess = await requireFeature(access.session, 'phoneNumbers', config);
    const activeOrganizationId = requestOrganizationId(req, access.session, config);
    if (req.method !== 'GET') {
      release = await acquireTenantMutation(activeOrganizationId);
      config = await readPbxConfig({fresh:true});
    }
    const ownCarrier = carrierMode(config, activeOrganizationId);
    if (ownCarrier && (req.method === 'POST' || req.method === 'GET' && req.query.mode === 'search')) {
      return res.status(409).json({ error: 'This company uses its own SIP trunks. Add the numbers supplied by your carrier in SIP trunks.' });
    }
    if (req.method === 'GET' && ownCarrier) {
      const trunks = await carrierTrunks.list(activeOrganizationId);
      return res.status(200).json({ callingMode: 'carrier',
        numbers: carrierNumberInventory(trunks.map(trunk => withLiveNumberRoutes(trunk, config))).map(item => ({ id: item.id, phoneNumber: item.phone_number,
          source: 'carrier', status: item.status, provider: trunks.find(trunk => trunk.id === item.carrier_trunk_id)?.provider,
          assignment: { organizationId: activeOrganizationId, destinationType: item.destination_type, destinationId: item.destination_id } })),
        legacyNumbers: Object.entries(config.numberAssignments)
          .filter(([, item]) => item.organizationId === activeOrganizationId && !item.disabled && item.source !== 'carrier')
          .map(([phoneNumber]) => ({ id: `assigned:${phoneNumber}`, phoneNumber })),
        orders: [], messagingProfiles: [],
      });
    }
    if (req.method === 'GET' && req.query.mode === 'search') {
      const country = text(req.query.country, 2).toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) return res.status(400).json({ error: 'Choose a two-letter country code.' });
      const query = new URLSearchParams({ 'filter[country_code]': country, 'page[size]': '30' });
      const areaCode = text(req.query.areaCode, 8).replace(/\D/g, '');
      const locality = text(req.query.locality, 80);
      const type = text(req.query.type, 30);
      const features = text(req.query.features, 50);
      if (areaCode) query.set('filter[national_destination_code]', areaCode);
      if (locality) query.set('filter[locality]', locality);
      if (['local', 'toll-free', 'mobile', 'national', 'shared-cost'].includes(type)) query.set('filter[phone_number_type]', type);
      if (features) query.set('filter[features]', features);
      const response = await telnyx(`/available_phone_numbers?${query}`);
      const payload = await response.json() as { data?: AvailableNumber[]; meta?: Record<string, unknown> };
      return res.status(200).json({
        numbers: (payload.data ?? []).map((item) => ({
          phoneNumber: item.phone_number,
          type: item.phone_number_type || type || 'local',
          locality: item.locality || item.region_information?.find((region) => region.region_type === 'locality')?.region_name || '',
          upfrontCost: item.cost_information?.upfront_cost || '0.00',
          monthlyCost: item.cost_information?.monthly_cost || '0.00',
          currency: item.cost_information?.currency || 'USD',
          features: (item.features ?? []).map((feature) => feature.name).filter(Boolean),
          quickship: Boolean(item.quickship),
        })),
        meta: payload.meta ?? {},
      });
    }
    if (req.method === 'GET') {
      const [numbersResponse, ordersResponse, profilesResponse] = await Promise.all([
        telnyx('/phone_numbers?page[size]=250&filter[status]=active'),
        telnyx('/number_orders?page[size]=20'),
        telnyx('/messaging_profiles?page[size]=250'),
      ]);
      const numbersPayload = await numbersResponse.json() as { data?: Array<Record<string, any>> };
      const ordersPayload = await ordersResponse.json() as { data?: Array<Record<string, any>> };
      const profilesPayload = await profilesResponse.json() as { data?: Array<Record<string, any>> };
      const orderPrefix = `Vocivo ${activeOrganizationId} `;
      await assignFulfilledNumbers(activeOrganizationId, (ordersPayload.data ?? [])
        .filter((item) => String(item.customer_reference || '').startsWith(orderPrefix))
        .flatMap((item) => successfulOrderNumbers(item)));
      const assignedConfig = await readPbxConfig();
      const visibleNumbers = (numbersPayload.data ?? []).filter((item) => assignedConfig.numberAssignments[item.phone_number]?.organizationId === activeOrganizationId && !assignedConfig.numberAssignments[item.phone_number]?.disabled);
      const visibleProfileIds = new Set(visibleNumbers.map((item) => String(item.messaging_profile_id || '')).filter(Boolean));
      const visibleProfiles = access.superadmin ? profilesPayload.data ?? [] : (profilesPayload.data ?? []).filter((item) => visibleProfileIds.has(String(item.id || '')));
      return res.status(200).json({
        callingMode: 'managed',
        numbers: visibleNumbers.map((item) => ({ id: item.id, phoneNumber: item.phone_number, status: item.status, country: item.country_iso_alpha2, ...(access.superadmin ? { connectionId: item.connection_id, connectionName: item.connection_name } : {}), messagingProfileId: item.messaging_profile_id, tags: tenantVisibleNumberTags(item.tags), purchasedAt: item.purchased_at, assignment: assignedConfig.numberAssignments[item.phone_number] || { organizationId: activeOrganizationId, destinationType: 'main' } })),
        orders: (ordersPayload.data ?? []).filter((item) => String(item.customer_reference || '').startsWith(orderPrefix)).map((item) => ({ id: item.id, status: item.status || (item.requirements_met ? 'complete' : 'requirements pending'), count: item.phone_numbers_count, createdAt: item.created_at, customerReference: item.customer_reference, requirementsMet: item.requirements_met })),
        messagingProfiles: visibleProfiles.map((item) => ({ id: item.id, name: item.name || item.id, ...(access.superadmin ? { webhookUrl: item.webhook_url || '', webhookFailoverUrl: item.webhook_failover_url || '' } : {}) })),
      });
    }
    if (req.method === 'POST') {
      if (req.body?.confirmPurchase !== true) return res.status(400).json({ error: 'Explicit purchase confirmation is required.' });
      const phoneNumbers = Array.isArray(req.body?.phoneNumbers) ? req.body.phoneNumbers.map((value: unknown) => text(value, 24)).filter((value: string) => /^\+[1-9]\d{6,14}$/.test(value)).slice(0, 10) : [];
      if (!phoneNumbers.length) return res.status(400).json({ error: 'Choose at least one valid phone number.' });
      if (subscriptionAccess.superadmin === false) {
        const assigned = new Set([...Object.entries(config.numberAssignments).filter(([,assignment]) => assignment.organizationId === activeOrganizationId).map(([number]) => number), ...await pendingNumberPurchases(activeOrganizationId)]).size;
        if (assigned + phoneNumbers.length > subscriptionAccess.plan.limits.phoneNumbers) return res.status(409).json({ error: `Your ${subscriptionAccess.plan.name} plan includes ${subscriptionAccess.plan.limits.phoneNumbers} phone numbers.` });
      }
      const pending = await pendingNumberPurchases(activeOrganizationId);
      if (phoneNumbers.some((number: string) => pending.includes(number))) return res.status(409).json({error:'A purchase for this number is already awaiting confirmation.'});
      await changePendingNumberPurchases(activeOrganizationId, phoneNumbers);
      const response = await telnyx('/number_orders', {
        method: 'POST',
        body: JSON.stringify({
          phone_numbers: phoneNumbers.map((phone_number: string) => ({ phone_number })),
          connection_id: access.superadmin ? text(req.body?.connectionId, 80) || inboundConnectionId() || telnyxPstnConnectionId() : inboundConnectionId() || telnyxPstnConnectionId(),
          customer_reference: access.superadmin ? text(req.body?.customerReference, 100) || `Vocivo ${activeOrganizationId} ${new Date().toISOString()}` : `Vocivo ${activeOrganizationId} ${new Date().toISOString()}`,
        }),
      }).catch(async error => {
        if (error instanceof TelnyxApiError && error.status >= 400 && error.status < 500 && error.status !== 408) await changePendingNumberPurchases(activeOrganizationId, [], phoneNumbers);
        throw error;
      });
      const payload = await response.json() as { data?: Record<string, any> };
      await assignFulfilledNumbers(activeOrganizationId, successfulOrderNumbers(payload.data), {
        failOnError: true,
        ...(subscriptionAccess.superadmin === false ? { limit: subscriptionAccess.plan.limits.phoneNumbers } : {}),
      });
      await changePendingNumberPurchases(activeOrganizationId, [], successfulOrderNumbers(payload.data));
      invalidatePhoneNumberCache('owned');
      return res.status(201).json({ order: payload.data });
    }
    if (req.method === 'DELETE') {
      if (req.body?.confirmRelease !== true) return res.status(400).json({ error: 'Explicit number release confirmation is required.' });
      const id = text(req.body?.id, 80);
      const phoneNumber = text(req.body?.phoneNumber, 24);
      if (!id || !/^\+[1-9]\d{6,14}$/.test(phoneNumber)) return res.status(400).json({ error: 'Phone number ID and E.164 number are required.' });
      if (id === requiredEnv('TELNYX_PHONE_NUMBER_ID')) return res.status(409).json({ error: 'This is the primary Vocivo service number. Assign a replacement before releasing it.' });
      if (config.numberAssignments[phoneNumber]?.organizationId !== activeOrganizationId) return res.status(404).json({ error: 'Phone number not found in the selected customer workspace.' });
      const currentResponse = await telnyx(`/phone_numbers/${encodeURIComponent(id)}`);
      const currentPayload = await currentResponse.json() as { data?: { phone_number?: string; deletion_lock_enabled?: boolean } };
      if (currentPayload.data?.phone_number !== phoneNumber) return res.status(409).json({ error: 'The number no longer matches this inventory record. Refresh and try again.' });
      if (currentPayload.data?.deletion_lock_enabled) return res.status(409).json({ error: 'Telnyx deletion lock is enabled for this number. Disable the lock before releasing it.' });
      const response = await telnyx(`/phone_numbers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const payload = response.status === 204 ? {} : await response.json() as { data?: Record<string, unknown> };
      await removeNumberAssignment(phoneNumber);
      await changePendingNumberPurchases(activeOrganizationId, [], [phoneNumber]);
      invalidatePhoneNumberCache('owned');
      return res.status(200).json({ number: payload.data, released: true });
    }
    const id = text(req.body?.id, 80);
    if (!id) return res.status(400).json({ error: 'Phone number ID is required.' });
    const ownedResponse = await telnyx(`/phone_numbers/${encodeURIComponent(id)}`);
    const owned = await ownedResponse.json() as { data?: { phone_number?: string; tags?: string[] } };
    const ownedNumber = text(owned.data?.phone_number, 24);
    if (!ownedNumber || config.numberAssignments[ownedNumber]?.organizationId !== activeOrganizationId) return res.status(404).json({ error: 'Phone number not found in the selected customer workspace.' });
    const body: Record<string, unknown> = {};
    if (!access.superadmin && (req.body?.assignToVocivo === true || req.body?.connectionId !== undefined)) return res.status(403).json({ error: 'Only the Vocivo superadmin can change carrier connections.' });
    // "Assign to Vocivo" means the connection that delivers inbound to Vocivo
    // today — the SIP edge once it answers inbound. Pointing at the Call
    // Control application here used to undo the cut-over on every Save route.
    if (access.superadmin && req.body?.assignToVocivo === true) {
      const inbound = inboundConnectionId();
      if (inbound) body.connection_id = inbound;
    }
    else if (access.superadmin && req.body?.connectionId !== undefined) body.connection_id = text(req.body.connectionId, 80) || null;
    if (req.body?.messagingProfileId !== undefined) {
      const requestedProfileId = text(req.body.messagingProfileId, 80);
      if (!access.superadmin && requestedProfileId) {
        const inventoryResponse = await telnyx('/phone_numbers?page[size]=250&filter[status]=active');
        const inventoryPayload = await inventoryResponse.json() as { data?: Array<{ phone_number?: string; messaging_profile_id?: string }> };
        const allowed = new Set((inventoryPayload.data ?? [])
          .filter((item) => item.phone_number && config.numberAssignments[item.phone_number]?.organizationId === activeOrganizationId)
          .map((item) => item.messaging_profile_id || '').filter(Boolean));
        if (!allowed.has(requestedProfileId)) return res.status(403).json({ error: 'This messaging profile is not assigned to your company.' });
      }
      body.messaging_profile_id = requestedProfileId || null;
    }
    // Vocivo's own tags are carried across untouched. Saved as sent, this
    // screen let a company administrator drop the tag holding the platform
    // owner's password hash — or write a new one, and choose that password.
    if (Array.isArray(req.body?.tags)) body.tags = nextNumberTags(owned.data?.tags, req.body.tags);
    const requestedOrganizationId = text(req.body?.organizationId, 50);
    const organizationId = access.superadmin ? requestedOrganizationId || activeOrganizationId : activeOrganizationId;
    if (organizationId && !config.organizations.some((item) => item.id === organizationId && item.status === 'active')) return res.status(400).json({ error: 'Choose an active organization.' });
    const destinationType = ['main', 'extension', 'ring_group', 'queue', 'ivr'].includes(req.body?.destinationType) ? req.body.destinationType as 'main' | 'extension' | 'ring_group' | 'queue' | 'ivr' : 'main';
    const destinationId = text(req.body?.destinationId, 80);
    if (organizationId && destinationType !== 'main' && !destinationId) return res.status(400).json({ error: 'Choose an inbound destination.' });
    if (organizationId && destinationType === 'extension') {
      const extension = await getExtension(destinationId, organizationId).catch(() => null);
      if (!extension || extension.status !== 'active' || extension.organizationId !== organizationId) return res.status(400).json({ error: 'Choose an active extension in this organization.' });
    }
    if (organizationId && ['ring_group', 'queue', 'ivr'].includes(destinationType)) {
      const organizationPbx = pbxForOrganization(config, organizationId);
      const collection = destinationType === 'ring_group' ? organizationPbx.callHandling.ringGroups : destinationType === 'queue' ? organizationPbx.callHandling.queues : organizationPbx.callHandling.ivrs;
      if (!collection.some((item) => item.id === destinationId)) return res.status(400).json({ error: 'Choose a configured inbound destination.' });
    }
    const response = await telnyx(`/phone_numbers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    const payload = await response.json() as { data?: Record<string, unknown> };
    const phoneNumber = text((payload.data as { phone_number?: unknown } | undefined)?.phone_number, 24);
    if (phoneNumber && organizationId) {
      await assignNumberToOrganization(phoneNumber, organizationId, {
        source: 'owned',
        destinationType,
        destinationId: destinationId || undefined,
        messagingEnabled: req.body?.messagingProfileId !== undefined
          ? Boolean(text(req.body.messagingProfileId, 80))
          : config.numberAssignments[phoneNumber]?.messagingEnabled,
      });
    }
    invalidatePhoneNumberCache('owned');
    return res.status(200).json({ number: payload.data });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Tenant mutation in progress')) return res.status(409).json({error:error.message});
    if (writeTenantScopeError(res, error)) return;
    if (writeAuthError(res, error)) return;
    if (error instanceof Error && /Feature not enabled|Subscription inactive|Organization inactive/i.test(error.message)) return res.status(403).json({ error: 'Phone-number management is not enabled for this company.' });
    if (error instanceof Error && error.message === 'Forbidden') return res.status(403).json({ error: 'Owner access is required.' });
    return res.status(500).json({ error: publicError(error) });
  } finally { if (release) await release().catch(() => console.error('Tenant mutation lease release failed')); }
}
