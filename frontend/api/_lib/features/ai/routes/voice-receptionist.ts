import type { VercelRequest, VercelResponse } from '@vercel/node';
import { storeCallEvent } from '../../calling/call-event-store.js';
import { afterResponse, allowMobile, methodNotAllowed, publicError } from '../../../shared/http.js';
import { listExtensions } from '../../organizations/pbx.js';
import { pbxForOrganization, readPbxConfig } from '../../organizations/pbx-config-store.js';
import { parseConversation, receptionistFor } from '../receptionist.js';
import { seedTenantKnowledge } from '../company-knowledge/seed-tenant-knowledge.js';
import { sipEdgeAuthorized } from '../../sip/sip-edge-auth.js';

/**
 * The SIP edge's two questions about Vocivo's own receptionist.
 *
 * GET  — which receptionist answers for the number that was dialled.
 * POST — what happened on a call that has just ended.
 *
 * Only the edge may ask, over the same shared secret Kamailio already uses.
 * Nothing here reaches a carrier: the conversation happened on Vocivo's own
 * droplet, in Vocivo's own speech engines.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  try {
    if (!sipEdgeAuthorized(req)) return res.status(401).json({ error: 'SIP edge authentication failed.', enabled: false });

    if (req.method === 'GET') {
      const number = typeof req.query.number === 'string' ? req.query.number : '';
      const config = await readPbxConfig();
      const profile = await receptionistFor({
        number,
        config,
        tenantFor: (organizationId) => pbxForOrganization(config, organizationId),
        extensionsFor: (organizationId) => listExtensions(organizationId),
        seedKnowledge: (organizationId) => seedTenantKnowledge(config, organizationId),
      });
      // 404 rather than an empty profile: the edge releases the call, which is
      // the honest outcome for a number no receptionist answers.
      if (!profile) return res.status(404).json({ enabled: false });
      return res.status(200).json(profile);
    }

    const conversation = parseConversation(req.body);
    if (!conversation) return res.status(400).json({ error: 'A conversation needs a callId.' });
    console.log('vocivo receptionist call', JSON.stringify({
      callId: conversation.callId,
      outcome: conversation.outcome,
      transferredTo: conversation.transferredTo,
      seconds: conversation.seconds,
    }));
    // Into the tenant's event log, beside the call's own records: the
    // transcript is what the tenant sees of a conversation their receptionist
    // had. The call id is the FreeSWITCH leg, so it lands in the same session.
    const config = await readPbxConfig();
    const organizationId = config.numberAssignments[conversation.number]?.organizationId || '';
    if (organizationId) {
      afterResponse('receptionist conversation record', storeCallEvent({
        id: `${conversation.callId}:receptionist`,
        name: `receptionist.${conversation.outcome}`,
        type: 'webhook',
        event_timestamp: new Date().toISOString(),
        call_session_id: conversation.callId,
        call_leg_id: conversation.callId,
        direction: 'incoming',
        from: conversation.caller,
        to: conversation.number,
        organizationId,
        flow: 'receptionist',
        destinationExtension: conversation.transferredTo || undefined,
        note: conversation.note,
        transcript: conversation.transcript,
      }));
    }
    return res.status(202).json({ recorded: Boolean(organizationId) });
  } catch (error) {
    return res.status(500).json({ error: publicError(error), enabled: false });
  }
}
