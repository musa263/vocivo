import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin } from '../../auth/auth.js';
import { allowMobile, writeAuthError } from '../../../shared/http.js';
import { readPbxConfig } from '../../organizations/pbx-config-store.js';
import { requestOrganizationId, writeTenantScopeError } from '../../organizations/request-organization.js';
import { requireFeature } from '../../organizations/saas-access.js';
import { listExtensions } from '../../organizations/pbx.js';
import { listReportingEvents } from '../../calling/call-event-store.js';
import { readWalletReport } from '../../billing/wallet-store.js';
import { reportCalls, analyzeCalls } from '../call-report.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET required' });
  try {
    const { session } = await requireAdmin(req);
    const config = await readPbxConfig(); const org = requestOrganizationId(req, session, config);
    await requireFeature(session, 'analytics', config);
    const from = typeof req.query.from === 'string' ? Date.parse(req.query.from) : NaN;
    const to = typeof req.query.to === 'string' ? Date.parse(req.query.to) : NaN;
    const timezone = typeof req.query.timezone === 'string' ? req.query.timezone : 'UTC';
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 31 * 86400_000 || to > Date.now() + 86400_000) return res.status(400).json({ error: 'Choose a date range of up to 31 days' });
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { return res.status(400).json({ error: 'Invalid timezone' }); }
    const [records, directory, wallet] = await Promise.all([listReportingEvents(org, from), listExtensions(org),
      readWalletReport(org, new Date(from).toISOString(), new Date(to).toISOString()).then(rows => ({ available: true, rows })).catch(error => {
        console.error('operations.billing.unavailable', { type: error instanceof Error ? error.name : 'unknown' }); return { available: false, rows: [] };
      })]);
    const calls = reportCalls(records.events, org, directory, from, to);
    return res.status(200).json({ organizationId: org, from: new Date(from).toISOString(), to: new Date(to).toISOString(), timezone,
      complete: records.complete, generatedAt: new Date().toISOString(), calls, analytics: analyzeCalls(calls, timezone, directory), wallet });
  } catch (error) {
    if (writeTenantScopeError(res, error) || writeAuthError(res, error)) return;
    if (error instanceof Error && /Feature not enabled|Subscription inactive|Organization inactive/.test(error.message)) return res.status(403).json({ error: 'Analytics is not enabled' });
    console.error('operations.reporting.failed', { type: error instanceof Error ? error.name : 'unknown' });
    return res.status(503).json({ error: 'Call reporting is unavailable. Please retry.' });
  }
}
