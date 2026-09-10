import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin } from '../../auth/auth.js';
import { allowMobile, methodNotAllowed, publicError, writeAuthError } from '../../../shared/http.js';
import { readBusinessVoiceConfig } from '../../numbers/number-config.js';
import { listExtensions } from '../pbx.js';
import { telnyx, telnyxCredentialConnectionPath } from '../../../shared/telnyx.js';
import { carrierMode, carrierNumberInventory, withLiveNumberRoutes } from '../../numbers/carrier-number-service.js';
import { carrierTrunks } from '../../numbers/carrier-trunk-store.js';
import { voiceEdge, sipDomain } from '../../calling/voice-provider.js';
import { apnsConfig, fcmConfig } from '../../push/mobile-push.js';
import { readPbxConfig } from '../pbx-config-store.js';
import { requestOrganizationId, writeTenantScopeError } from '../request-organization.js';

async function data(path: string) {
  const response = await telnyx(path);
  return (await response.json() as { data?: unknown }).data;
}

export function createOverviewHandler(deps = { requireAdmin, readPbxConfig, listExtensions, readBusinessVoiceConfig, data, listTrunks: carrierTrunks.list.bind(carrierTrunks), voiceEdge, sipDomain, apnsConfig, fcmConfig }) {
return async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const access = await deps.requireAdmin(req);
    const config = await deps.readPbxConfig();
    const organizationId = requestOrganizationId(req, access.session, config);
    const edge = deps.voiceEdge(config);
    const ownCarrier = carrierMode(config, organizationId);
    const managed = access.superadmin && edge !== 'sip';
    const [balance, numbers, connection, extensions, business] = await Promise.all([
      managed ? deps.data('/balance') as Promise<{ balance?: string; currency?: string }> : Promise.resolve(null),
      ownCarrier ? deps.listTrunks(organizationId).then(trunks => carrierNumberInventory(trunks.map(trunk => withLiveNumberRoutes(trunk, config))))
        : deps.data('/phone_numbers?page[size]=250&filter[status]=active') as Promise<Array<{ id: string; phone_number: string; status?: string }>>,
      managed ? deps.data(telnyxCredentialConnectionPath()) as Promise<{ active?: boolean; registration_status?: string; connection_name?: string; ios_push_credential_id?: string | null; android_push_credential_id?: string | null; record_type?: string }> : Promise.resolve(null),
      deps.listExtensions(organizationId),
      deps.readBusinessVoiceConfig(organizationId),
    ]);
    const visibleNumbers = (Array.isArray(numbers) ? numbers : []).filter(item => {
      const assignment = config.numberAssignments[item.phone_number];
      return assignment?.organizationId === organizationId && !assignment.disabled;
    });
    const iosPush = edge === 'sip' ? Boolean(deps.apnsConfig()) : Boolean(connection?.ios_push_credential_id);
    const androidPush = edge === 'sip' ? Boolean(deps.fcmConfig()) : Boolean(connection?.android_push_credential_id);
    return res.status(200).json({
      metrics: {
        balance: balance?.balance !== undefined ? Number(balance.balance) : null,
        currency: balance?.currency || null,
        phoneNumbers: visibleNumbers.length,
        extensions: extensions.length,
        activeExtensions: extensions.filter((item) => item.status === 'active').length,
      },
      phoneNumbers: visibleNumbers.map(({ id, phone_number, status }) => ({ id, phone_number, status })),
      connection: access.superadmin ? {
        name: edge === 'sip' ? 'Vocivo SIP' : connection?.connection_name || 'Managed WebRTC',
        provider: edge,
        sipDomain: edge === 'sip' ? deps.sipDomain() : 'sip.telnyx.com',
        active: edge === 'sip' ? null : Boolean(connection?.active),
        registrationStatus: edge === 'sip' ? 'Configured; live edge health is not measured here' : connection?.registration_status || 'Unknown',
        iosPushConfigured: iosPush,
        androidPushConfigured: androidPush,
        pushConfigured: iosPush && androidPush,
      } : null,
      business,
    });
  } catch (error) {
    if (writeTenantScopeError(res, error)) return;
    if (writeAuthError(res, error)) return;
    return res.status(500).json({ error: publicError(error) });
  }
};
}

export default createOverviewHandler();
