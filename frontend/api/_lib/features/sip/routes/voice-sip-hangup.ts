import type { VercelRequest, VercelResponse } from '@vercel/node';
import { allowMobile, methodNotAllowed, publicError } from '../../../shared/http.js';
import { sipEdgeAuthorized } from '../sip-edge-auth.js';
import { isVoiceRouteId } from '../../calling/voice-route-id.js';
import { readVoiceRoute, updateVoiceRoute } from '../../calling/voice-route-store.js';

/**
 * The end of an outbound PSTN call on the SIP edge.
 *
 * FreeSWITCH's hangup hook (services/sip/freeswitch/sip-hangup.sh) posts
 * `{routeId, eventId, durationSeconds}` here for every outbound leg it
 * placed. Until this handler existed the request 404ed and was discarded, so
 * the reserved route stayed at `connected` until its two-hour expiry —
 * /api/voice/status went on telling the app the call was live — and the
 * billable seconds were lost.
 *
 * The route's `revision` is bumped and a `connectedAt` is kept if one was
 * recorded, so redelivery from the durable SIP outbox is harmless.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!sipEdgeAuthorized(req)) return res.status(401).json({ error: 'SIP edge authentication failed.' });
  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Record<string, unknown> | null;
    const routeId = body?.routeId;
    if (!isVoiceRouteId(routeId)) return res.status(400).json({ error: 'routeId is required.' });
    const seconds = Math.max(0, Math.floor(Number(body?.durationSeconds) || 0));
    const eventId = typeof body?.eventId === 'string' ? body.eventId.slice(0, 80) : 'hangup';
    const current = await readVoiceRoute(routeId);
    if (!current) return res.status(200).json({ recorded: false, reason: 'unknown_route' });
    if (current.phase === 'ended' || current.phase === 'failed') return res.status(200).json({ recorded: false, reason: 'already_terminal', phase: current.phase });
    const phase = seconds > 0 || current.phase === 'connected' ? 'ended' : 'failed';
    const updated = await updateVoiceRoute(routeId, {
      phase,
      failureCause: phase === 'ended' ? `normal_clearing:${eventId}` : `no_answer:${eventId}`,
      ...(seconds > 0 && !current.connectedAt ? { connectedAt: new Date(Date.now() - seconds * 1000).toISOString() } : {}),
    });
    return res.status(200).json({ recorded: Boolean(updated), phase, durationSeconds: seconds });
  } catch (error) {
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'The hangup record could not be read.' });
    return res.status(500).json({ error: publicError(error) });
  }
}
