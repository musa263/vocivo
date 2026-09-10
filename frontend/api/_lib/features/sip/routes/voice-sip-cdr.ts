import { sendIncomingCallWebPush } from '../../push/web-push-dispatcher.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { storeCallEvent } from '../../calling/call-event-store.js';
import { allowMobile, methodNotAllowed, publicError } from '../../../shared/http.js';
import { listExtensions } from '../../organizations/pbx.js';
import { kamailioCdrEvents, parseKamailioCdr, parseSipCdr, sipCdrEvents } from '../sip-cdr.js';
import { sipEdgeAuthorized } from '../sip-edge-auth.js';
import { verifyVoiceRouteToken } from '../../calling/voice-route-token.js';

/**
 * Call records from the SIP edge.
 *
 * FreeSWITCH (mod_json_cdr) posts one record per finished leg. It becomes the
 * tenant's call history and event log — what the carrier's webhooks provided
 * before inbound moved to Vocivo's own edge, and what was missing from
 * Reports, the Event log and the apps' Recents for every call since.
 *
 * Always 200 once the record has been read: a non-2xx makes FreeSWITCH retry
 * and then write the record to disk, which is right for an outage and wrong
 * for a record that simply belongs to nobody.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!sipEdgeAuthorized(req)) return res.status(401).json({ error: 'SIP edge authentication failed.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const relayed = parseKamailioCdr(body);
    const leg = relayed ? null : parseSipCdr(body);
    if (!relayed && !leg) return res.status(200).json({ recorded: false, reason: 'not_a_call_record' });
    const token = relayed ? (relayed.event === 'invite' ? relayed.routeToken : '') : leg?.routeToken || '';
    const route = token ? verifyVoiceRouteToken(token, { allowExpired: true }) : null;
    if (token && !route) return res.status(200).json({ recorded: false, reason: 'invalid_route' });
    const context = { extensions: await listExtensions(), route };
    const events = relayed ? kamailioCdrEvents(relayed, context) : sipCdrEvents(leg!, context);
    if (!events.length) {
      console.warn('vocivo sip cdr belongs to no tenant', JSON.stringify(relayed ? { callId: relayed.callId, event: relayed.event } : { uuid: leg!.uuid, flow: leg!.flow }));
      return res.status(200).json({ recorded: false, reason: 'no_tenant' });
    }
    for (const event of events) await storeCallEvent(event);
    if (relayed && ['answered','bye','cancel','failed'].includes(relayed.event)) {
      const organizations = [...new Set(events.map(event => event.organizationId))];
      await Promise.all(organizations.map(organizationId => sendIncomingCallWebPush({
        organizationId, extensionIds:context.extensions.filter(item => item.organizationId === organizationId).map(item => item.id), callId:relayed.callId, ended:true,
      })));
    }
    return res.status(200).json({ recorded: true, events: events.length });
  } catch (error) {
    // A malformed record is dropped, not retried forever.
    if (error instanceof SyntaxError) return res.status(200).json({ recorded: false, reason: 'unreadable' });
    return res.status(500).json({ error: publicError(error) });
  }
}
