import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sipEdgeAuthorized } from '../../sip/sip-edge-auth.js';
import { readPbxConfig } from '../../organizations/pbx-config-store.js';
import { listExtensions } from '../../organizations/pbx.js';
import { tenantSnapshots } from '../telemetry.js';
import { telemetryStore } from '../telemetry-store.js';
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  try {
    if (!sipEdgeAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const [config, directory] = await Promise.all([readPbxConfig(), listExtensions()]);
    let snapshots;
    try { snapshots = tenantSnapshots(req.body, config.organizations.map(o => o.id), directory); }
    catch { return res.status(400).json({ error: 'Invalid telemetry snapshot' }); }
    for (const snapshot of snapshots) await telemetryStore.save(snapshot);
    return res.status(200).json({ received: true });
  } catch (error) { console.error('operations.telemetry.failed', { type: error instanceof Error ? error.name : 'unknown' }); return res.status(503).json({ error: 'Telemetry persistence unavailable' }); }
}
