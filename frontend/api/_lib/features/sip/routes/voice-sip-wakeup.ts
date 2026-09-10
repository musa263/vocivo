import type { VercelRequest, VercelResponse } from '@vercel/node';
import { afterResponse, allowMobile, methodNotAllowed, publicError } from '../../../shared/http.js';
import { listExtensions } from '../../organizations/pbx.js';
import { wakeMobileDevices } from '../../push/mobile-push-dispatcher.js';
import { sipEdgeAuthorized } from '../sip-edge-auth.js';
import { sendIncomingCallWebPush } from '../../push/web-push-dispatcher.js';

/**
 * How long the handset rings when the edge does not say.
 *
 * The edge normally sends `ringUntil`, the absolute second at which the
 * caller's transaction gives up, and that is the number to obey: counting 45
 * seconds from the moment this push is dispatched always lands later than the
 * caller's own deadline, because the push happens after the INVITE. The handset
 * used to keep ringing past the point where the caller had already been
 * released, and a call answered in that trailing window opened on the handset
 * with nobody there — a caller who "cannot hear".
 */
const WAKE_TTL_SECONDS = 45;

/** Seconds of ringing left, from an edge deadline, kept inside something sane. */
function ringSecondsFrom(ringUntil: unknown, now = Date.now()) {
  if (typeof ringUntil !== 'number' || !Number.isFinite(ringUntil)) return WAKE_TTL_SECONDS;
  const remaining = Math.round(ringUntil - now / 1000);
  // Below a few seconds there is no call worth ringing for: the caller is about
  // to be given up on, and waking a phone to show a notification that cannot be
  // answered in time is worse than not waking it.
  return Math.max(0, Math.min(WAKE_TTL_SECONDS, remaining));
}

function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function createSipWakeupHandler(deps = { listExtensions, wakeMobileDevices, sendIncomingCallWebPush, afterResponse }) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    if (allowMobile(req, res)) return;
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    try {
      if (!sipEdgeAuthorized(req)) return res.status(401).json({ error: 'SIP edge authentication failed.' });
      const username = text(req.body?.username, 80);
      const callId = text(req.body?.callId, 120);
      const callerName = text(req.body?.callerName, 80);
      const callerNumber = text(req.body?.from, 40);
      if (!username) return res.status(400).json({ error: 'A SIP username is required.' });
      if (!callId) return res.status(400).json({ error: 'A call ID is required.' });
      const ringSeconds = ringSecondsFrom(req.body?.ringUntil);
      // The caller has already given up, or is about to. Waking the phone now
      // only produces a notification nobody can answer in time.
      if (ringSeconds <= 0) return res.status(200).json({ woken: false, reason: 'the caller is no longer waiting' });
      const dispatch = async () => {
        const directory = await deps.listExtensions();
        const matches = directory.filter((item) => item.status === 'active' && item.sipUsername === username);
        const organizationIds = [...new Set(matches.map((item) => item.organizationId))];
        const deliveries = await Promise.allSettled([
          ...organizationIds.map((organizationId) => deps.sendIncomingCallWebPush({
            organizationId,
            extensionIds: matches.filter((item) => item.organizationId === organizationId).map((item) => item.id),
            callerName,
            callId,
          })),
          deps.wakeMobileDevices({
            targets: matches.map((item) => ({ organizationId: item.organizationId, extensionId: item.id })),
            call: {
              callId,
              sipUsername: username,
              callerName: callerName || undefined,
              callerNumber: callerNumber || undefined,
              ttlSeconds: ringSeconds,
            },
          }),
        ]);
        for (const delivery of deliveries) {
          if (delivery.status === 'rejected') throw delivery.reason;
        }
      };
      // Release Kamailio before directory lookup or push-provider round trips.
      deps.afterResponse('SIP incoming wakeup', dispatch());
      return res.status(200).json({ ok: true, uuid: callId, queued: true });
    } catch (error) {
      return res.status(500).json({ error: publicError(error) });
    }
  };
}

export default createSipWakeupHandler();
