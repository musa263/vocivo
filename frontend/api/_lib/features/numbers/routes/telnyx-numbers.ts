import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isPlatformOwnerSession, requireSession } from '../../auth/auth.js';
import { allowMobile, methodNotAllowed, publicError, writeAuthError, requiredEnv } from '../../../shared/http.js';
import { telnyx, telnyxPstnConnectionId } from '../../../shared/telnyx.js';
import { readPbxConfig } from '../../organizations/pbx-config-store.js';
import { sessionCanAccessNumber } from '../../organizations/tenancy.js';
import { sessionOrganizationId } from '../../organizations/tenancy.js';
import { carrierMode } from '../carrier-number-service.js';
import { assignedNumbersForOrganization } from '../phone-number-access.js';
import { carrierTrunks } from '../carrier-trunk-store.js';
import { dialingDefaults } from '../dialing-defaults.js';

type TelnyxNumber = {
  id: string;
  phone_number: string;
  country_iso_alpha2?: string;
  status?: string;
  connection_id?: string | null;
  connection_name?: string | null;
  messaging_profile_id?: string | null;
  tags?: string[];
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const session = await requireSession(req);
    const config = await readPbxConfig();
    // A superadmin works in one customer at a time, the same way every
    // /api/admin route resolves them. Reading the platform owner as "no
    // organization" made this list every customer's numbers mixed together in
    // the caller-ID picker, with no way to tell whose was whose.
    const organizationId = isPlatformOwnerSession(session) ? config.activeOrganizationId : sessionOrganizationId(session, config);
    res.setHeader('Cache-Control', 'private, no-store');
    if (organizationId && carrierMode(config, organizationId)) {
      const trunks = await carrierTrunks.list(organizationId);
      return res.status(200).json({ numbers: assignedNumbersForOrganization(config, organizationId, trunks), dialing: dialingDefaults(config, organizationId, session.extensionId, trunks) });
    }
    const connectionId = requiredEnv('TELNYX_CONNECTION_ID');
    const callControlApplicationId = requiredEnv('TELNYX_CALL_CONTROL_APP_ID');
    const pstnConnectionId = telnyxPstnConnectionId();
    const response = await telnyx('/phone_numbers?page[size]=250&filter[status]=active');
    const payload = await response.json() as { data?: TelnyxNumber[] };
    const numbers = (payload.data ?? []).filter((number) => !config.numberAssignments[number.phone_number]?.disabled && sessionCanAccessNumber(session, number.phone_number, config)).map((number) => ({
      id: number.id,
      phone_number: number.phone_number,
      label: config.numberAssignments[number.phone_number]?.label || number.connection_name || 'Vocivo number',
      country_code: number.country_iso_alpha2 || null,
      status: number.status || 'active',
      receives_calls: [connectionId, callControlApplicationId, pstnConnectionId].includes(number.connection_id || ''),
      messaging_enabled: Boolean(number.messaging_profile_id),
      source: 'owned',
    }));
    return res.status(200).json({ numbers, dialing: organizationId ? dialingDefaults(config, organizationId, session.extensionId) : null });
  } catch (error) {
    if (writeAuthError(res, error)) return;
    return res.status(500).json({ error: publicError(error) });
  }
}
