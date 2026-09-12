import type { VercelRequest, VercelResponse } from '@vercel/node';
import background from '../_lib/features/platform/routes/admin-background.js';
import extensions from '../_lib/features/organizations/routes/admin-extensions.js';
import overview from '../_lib/features/organizations/routes/admin-overview.js';
import carrierTrunks from '../_lib/features/numbers/routes/admin-carrier-trunks.js';
import trunks from '../_lib/features/numbers/routes/admin-trunks.js';
import enrollments from '../_lib/features/enrollment/routes/admin-enrollments.js';
import pbx from '../_lib/features/organizations/routes/admin-pbx.js';
import ai from '../_lib/features/ai/routes/admin-ai.js';
import events from '../_lib/features/platform/routes/admin-events.js';
import numbers from '../_lib/features/numbers/routes/admin-numbers.js';
import numberRouting from '../_lib/features/numbers/routes/admin-number-routing.js';
import voices from '../_lib/features/ai/routes/admin-voices.js';
import apiKeys from '../_lib/features/platform/routes/admin-api-keys.js';
import saas from '../_lib/features/organizations/routes/admin-saas.js';
import wallets from '../_lib/features/billing/routes/admin-wallets.js';
import operations from '../_lib/features/operations/routes/admin-operations.js';
import reports from '../_lib/features/operations/routes/admin-reports.js';

const routes = { operations, reports, background, extensions, overview, trunks, enrollments, pbx, ai, events, numbers, voices, saas, wallets, 'api-keys': apiKeys, 'carrier-trunks': carrierTrunks, 'number-routing': numberRouting } as const;

export default function handler(req: VercelRequest, res: VercelResponse) {
  const resource = Array.isArray(req.query.resource) ? req.query.resource[0] : req.query.resource;
  // Own keys only, or 'toString' resolves an inherited function that never answers.
  const route = resource && Object.prototype.hasOwnProperty.call(routes, resource) ? routes[resource as keyof typeof routes] : undefined;
  return route ? route(req, res) : res.status(404).json({ error: 'Not found' });
}
