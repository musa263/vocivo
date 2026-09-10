import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticatePlatformKey, type PlatformScope } from '../platform-key-store.js';
import { allowMobile, methodNotAllowed, publicError, requiredEnv } from '../../../shared/http.js';
import { findExtension, listExtensions } from '../../organizations/pbx.js';
import { callAction, dialCall } from '../../calling/voice-control.js';
import { telnyx, telnyxPstnConnectionId } from '../../../shared/telnyx.js';
import { assertCallerIdForOrganization } from '../../numbers/phone-number-access.js';
import { assertOrganizationMayCall, CallNotPermittedError } from '../../organizations/organization-call-access.js';
import { accessForOrganization } from '../../organizations/saas-access.js';
import { readPbxConfig } from '../../organizations/pbx-config-store.js';
import { organizationExtensionSipUri } from '../../calling/internal-sip.js';
import { assignNumberToOrganization, numberOrganizationId } from '../../organizations/tenancy.js';
import { decodeVoiceState } from '../../calling/voice-control.js';
import { get, storageHealth } from '../../../shared/object-store.js';
import { voiceEdge } from '../../calling/voice-provider.js';
import { carrierMode } from '../../numbers/carrier-number-service.js';
import { assignedNumbersForOrganization } from '../../numbers/phone-number-access.js';
import { carrierTrunks, CarrierTrunkError } from '../../numbers/carrier-trunk-store.js';

const e164 = /^\+[1-9]\d{6,14}$/;
const publicStoragePrefixes = ['vocivo/profile-photos/', 'vocivo/branding/'];
function text(value: unknown, max: number) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function organizationFromCarrierRecord(item: Record<string, any>) {
  return decodeVoiceState(item.client_state || item.payload?.client_state)?.organizationId;
}

function scopeFor(resource: string, method: string): PlatformScope | null {
  if (resource === 'health') return 'calls:read';
  if (resource === 'extensions' && method === 'GET') return 'extensions:read';
  if (resource === 'calls' && method === 'GET') return 'calls:read';
  if (resource === 'calls' && ['POST', 'PATCH'].includes(method)) return 'calls:write';
  if (resource === 'numbers' && method === 'GET') return 'numbers:read';
  if (resource === 'numbers' && method === 'POST') return 'numbers:write';
  if (resource === 'events' && method === 'GET') return 'events:read';
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const resource = Array.isArray(req.query.resource) ? req.query.resource[0] : req.query.resource || '';
  const method = req.method || '';
  if (resource === 'storage') {
    if (allowMobile(req, res)) return;
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    try {
      const pathname = typeof req.query.path === 'string' ? req.query.path : '';
      if (!publicStoragePrefixes.some((prefix) => pathname.startsWith(prefix))) return res.status(404).end();
      const object = await get(pathname, { access: 'public' });
      if (!object?.stream) return res.status(404).end();
      const body = Buffer.from(await new Response(object.stream).arrayBuffer());
      res.setHeader('Content-Type', object.blob.contentType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${pathname.split('/').pop()?.replace(/[^A-Za-z0-9._-]/g, '') || 'download'}"`);
      return res.status(200).send(body);
    } catch (error) {
      return res.status(500).json({ error: publicError(error) });
    }
  }
  if (resource === 'health') {
    if (allowMobile(req, res)) return;
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    try {
      const deep = req.query.deep === '1';
      const storage = deep ? await storageHealth() : { provider: 'postgres', status: 'unchecked' };
      res.setHeader('Cache-Control', deep ? 'no-store' : 'public, s-maxage=5, stale-while-revalidate=30');
      return res.status(200).json({ ok: true, service: 'vocivo-api', status: 'operational', storage, controlPlane: 'vocivo', mediaPlane: voiceEdge() === 'sip' ? 'vocivo-sip' : 'telnyx', telephonyStatus: 'unchecked', pstnProvider: voiceEdge() === 'sip' ? 'tenant-configured' : 'telnyx', revision: process.env.VOCIVO_RELEASE_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null, time: new Date().toISOString() });
    } catch (error) {
      console.error('Vocivo health check failed', error);
      return res.status(503).json({ ok: false, service: 'vocivo-api', status: 'unavailable', time: new Date().toISOString() });
    }
  }
  const scope = scopeFor(resource, method);
  if (!scope) return methodNotAllowed(res, ['GET', 'POST', 'PATCH']);
  try {
    const apiKey = await authenticatePlatformKey(req, scope);
    res.setHeader('Cache-Control', 'no-store');
    if (resource === 'extensions') return res.status(200).json({ data: await listExtensions(apiKey.organizationId) });
    if (resource === 'calls' && method === 'GET') {
      const response = await telnyx(`/connections/${requiredEnv('TELNYX_CALL_CONTROL_APP_ID')}/active_calls?page[size]=100`);
      const payload = await response.json() as { data?: Array<Record<string, any>> };
      return res.status(200).json({ ...payload, data: (payload.data ?? []).filter((item) => organizationFromCarrierRecord(item) === apiKey.organizationId) });
    }
    if (resource === 'calls' && method === 'POST') {
      const requested = text(req.body?.to, 200);
      const internal = /^\d{2,5}$/.test(requested) ? await findExtension(requested, apiKey.organizationId) : null;
      const to = internal ? organizationExtensionSipUri(await readPbxConfig(), apiKey.organizationId, internal.sipUsername) : requested;
      if (!internal && !e164.test(to)) return res.status(400).json({ error: 'Destination must be an organization extension or E.164 number.' });
      const from = text(req.body?.from, 24);
      if (!from || !e164.test(from)) return res.status(400).json({ error: 'An explicit caller ID in E.164 format is required.' });
      await assertCallerIdForOrganization(from, apiKey.organizationId);
      // Everything the apps are held to. A key used to skip all of it.
      await assertOrganizationMayCall(apiKey.organizationId, {
        flow: internal ? 'internal' : 'outbound',
        destination: internal ? to : requested,
        callerId: from,
      });
      const result = await dialCall({ to, from, fromDisplayName: text(req.body?.displayName, 80) || 'Vocivo API', state: { flow: 'api_outbound', organizationId: apiKey.organizationId }, commandId: text(req.body?.commandId, 80) || crypto.randomUUID(), timeoutSeconds: Number(req.body?.timeoutSeconds) || 45 });
      return res.status(201).json({ data: { ...result.data, destination: requested, internal: Boolean(internal) } });
    }
    if (resource === 'calls' && method === 'PATCH') {
      const callControlId = text(req.body?.callControlId, 500);
      const action = text(req.body?.action, 30);
      const actions: Record<string, { endpoint: string; body: Record<string, unknown> }> = {
        hangup: { endpoint: 'hangup', body: {} },
        hold: { endpoint: 'hold', body: {} },
        resume: { endpoint: 'unhold', body: {} },
        mute: { endpoint: 'mute', body: {} },
        unmute: { endpoint: 'unmute', body: {} },
        transfer: { endpoint: 'transfer', body: { to: text(req.body?.to, 200) } },
        play: { endpoint: 'playback_start', body: { audio_url: text(req.body?.audioUrl, 500) } },
      };
      if (!callControlId || !actions[action]) return res.status(400).json({ error: 'Call control ID and supported action are required.' });
      const activeResponse = await telnyx(`/connections/${requiredEnv('TELNYX_CALL_CONTROL_APP_ID')}/active_calls?page[size]=100`);
      const activePayload = await activeResponse.json() as { data?: Array<Record<string, any>> };
      const ownedCall = (activePayload.data ?? []).find((item) => (item.call_control_id === callControlId || item.id === callControlId) && organizationFromCarrierRecord(item) === apiKey.organizationId);
      if (!ownedCall) return res.status(404).json({ error: 'Call not found for this organization.' });
      await callAction(callControlId, actions[action].endpoint, { ...actions[action].body, command_id: text(req.body?.commandId, 80) || crypto.randomUUID() });
      return res.status(200).json({ data: { callControlId, action, accepted: true } });
    }
    if (resource === 'numbers' && method === 'GET') {
      const config = await readPbxConfig();
      if (carrierMode(config, apiKey.organizationId)) return res.status(200).json({ data: assignedNumbersForOrganization(config, apiKey.organizationId, await carrierTrunks.list(apiKey.organizationId)) });
      const country = text(req.query.country, 2).toUpperCase();
      const path = country
        ? `/available_phone_numbers?filter[country_code]=${encodeURIComponent(country)}&page[size]=30`
        : '/phone_numbers?page[size]=250&filter[status]=active';
      const response = await telnyx(path);
      const payload = await response.json() as { data?: Array<Record<string, any>> };
      if (country) return res.status(200).json(payload);
      return res.status(200).json({ ...payload, data: (payload.data ?? []).filter((item) => numberOrganizationId(item.phone_number || '', config) === apiKey.organizationId) });
    }
    if (resource === 'numbers' && method === 'POST') {
      if (req.body?.confirmPurchase !== true) return res.status(400).json({ error: 'Explicit purchase confirmation is required.' });
      const numbers = Array.isArray(req.body?.phoneNumbers) ? req.body.phoneNumbers.map((item: unknown) => text(item, 24)).filter((item: string) => e164.test(item)).slice(0, 10) : [];
      if (!numbers.length) return res.status(400).json({ error: 'At least one valid phone number is required.' });
      // The numbers screen holds a company to the numbers its plan includes.
      // Buying through a key was a way around that, and every number bought is
      // a monthly charge to Vocivo.
      const purchaseConfig = await readPbxConfig();
      if (carrierMode(purchaseConfig, apiKey.organizationId)) return res.status(409).json({ error: 'This company brings its own carrier numbers. Add them in company SIP trunks.' });
      const access = await accessForOrganization(apiKey.organizationId, purchaseConfig).catch(() => null);
      if (!access) return res.status(403).json({ error: 'This company is not active.' });
      const held = Object.values(purchaseConfig.numberAssignments).filter((assignment) => assignment.organizationId === apiKey.organizationId).length;
      if (held + numbers.length > access.plan.limits.phoneNumbers) {
        return res.status(409).json({ error: `Your ${access.plan.name} plan includes ${access.plan.limits.phoneNumbers} phone numbers.` });
      }
      const response = await telnyx('/number_orders', { method: 'POST', body: JSON.stringify({ phone_numbers: numbers.map((phone_number: string) => ({ phone_number })), connection_id: telnyxPstnConnectionId(), customer_reference: text(req.body?.customerReference, 100) || `Vocivo API ${apiKey.id}` }) });
      const payload = await response.json();
      await Promise.all(numbers.map((phoneNumber: string) => assignNumberToOrganization(phoneNumber, apiKey.organizationId, { source: 'owned', destinationType: 'main' })));
      return res.status(201).json(payload);
    }
    if (resource === 'events') {
      const query = new URLSearchParams({ 'page[size]': '100' });
      const callLegId = text(req.query.callLegId, 500); if (callLegId) query.set('filter[call_leg_id]', callLegId);
      const response = await telnyx(`/call_events?${query}`);
      const payload = await response.json() as { data?: Array<Record<string, any>> };
      return res.status(200).json({ ...payload, data: (payload.data ?? []).filter((item) => organizationFromCarrierRecord(item) === apiKey.organizationId) });
    }
    return res.status(404).json({ error: 'Not found' });
  } catch (error) {
    if (error instanceof CarrierTrunkError) return res.status(error.status).json({ error: error.message });
    if (error instanceof Error && error.message === 'Unauthorized') return res.status(401).json({ error: 'Invalid API key or scope.' });
    if (error instanceof CallNotPermittedError) return res.status(error.status).json({ error: error.message });
    if (error instanceof Error && /Caller ID|owned|verified/i.test(error.message)) return res.status(403).json({ error: error.message });
    return res.status(500).json({ error: publicError(error) });
  }
}
