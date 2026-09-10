import { resolveInboundNumber } from '../../numbers/carrier-runtime.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { allowMobile, methodNotAllowed, publicError } from '../../../shared/http.js';
import { readPbxConfig } from '../../organizations/pbx-config-store.js';
import { sipEdgeAuthorized } from '../sip-edge-auth.js';
import { lookupSipInbound } from '../sip-inbound.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    if (!sipEdgeAuthorized(req)) return res.status(401).json({ error: 'SIP edge authentication failed.', enabled: false });
    const to = typeof req.body?.to === 'string' ? req.body.to : '';
    const config = await readPbxConfig();
    const sourceIp = typeof req.body?.carrierSourceIp === 'string' ? req.body.carrierSourceIp : '';
    const resolved = resolveInboundNumber(config, to, sourceIp);
    const lookup = await lookupSipInbound(resolved, config);
    return res.status(200).json(lookup);
  } catch (error) {
    return res.status(500).json({ error: publicError(error), enabled: false, usernames: [], bridge: '' });
  }
}
