import assert from 'node:assert/strict';
import { defaultPbxConfig } from '../api/_lib/features/organizations/pbx-config-store.ts';
import { defaultPlans, featureCatalog } from '../api/_lib/features/organizations/saas-store.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.VOCIVO_TEST_ORIGIN || 'http://127.0.0.1:5183';
const config = defaultPbxConfig();
const plans = defaultPlans();
const org = config.organizations[0].id;
const organization = { ...config.organizations[0], name: 'QA Company', admins: [], plan: plans[0], usage: { seats: 3 },
  subscription: { status: 'active', planId: plans[0].id }, entitlements: Object.fromEntries(featureCatalog.map(f => [f.id, true])) };
const now = new Date().toISOString();
const agents = ['Available', 'On Call', 'On Break'].map((name, index) => ({ id: `agent-${index}`, name: `Colleague ${index + 1}`, extension: `200${index}`, enabled: true,
  state: ['available', 'on_call', 'on_break'][index], registration: index === 2 ? 'inactive' : 'active', contacts: index === 2 ? 0 : 1,
  preference: { state: index === 2 ? 'on_break' : 'available', version: 0 } }));
const records = [{ id: 'call-1', startedAt: now, direction: 'internal', from: 'Colleague 1 · Extension 2000', to: 'Colleague 2 · Extension 2001', status: 'answered', durationSeconds: 30, hangupCause: 'NORMAL_CLEARING', cost: null }];
const reports = { calls: records, timezone: 'UTC', complete: true, wallet: { available: true, rows: [{ currency: 'USD', direction: 'credit', type: 'top_up', entries: 1, amountMinor: '2500' }] },
  analytics: { total: 1, answered: 1, incomplete: 0, durationSeconds: 30, billing: { unpricedCalls: 1 }, directions: { inbound: 0, outbound: 0, internal: 1 },
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, calls: hour === 10 ? 1 : 0 })), topExtensions: [{ id: 'agent-0', name: 'Colleague 1', extension: '2000', calls: 1, answered: 1, seconds: 30 }] } };
const data = { '/api/admin/pbx': { config }, '/api/admin/saas': { platform: { name: 'Vocivo Communications' }, organizations: [organization], plans, featureCatalog },
  '/api/admin/extensions': { extensions: [] }, '/api/admin/numbers': { numbers: [], orders: [], messagingProfiles: [] }, '/api/admin/events': { events: [] }, '/api/admin/api-keys': { keys: [] } };
const browser = await chromium.launch({ headless: true });
try {
  for (const role of ['company_admin', 'superadmin']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; let stale = false; let mutations = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.pathname === '/api/admin/operations' || url.pathname === '/api/admin/reports') assert.equal(url.searchParams.get('organizationId'), org);
      if (url.pathname === '/api/admin/operations') {
        if (request.method() === 'PATCH') { mutations++; assert.equal(request.postDataJSON().state, 'on_break'); return route.fulfill({ json: { saved: true } }); }
        return route.fulfill({ json: { organizationId: org, fresh: !stale, observedAt: now, agents: agents.map(a => stale ? { ...a, registration: 'unknown', contacts: null } : a),
          counters: stale ? null : { activeRegistrations: 2, inactiveRegistrations: 1, inbound: 1, outbound: 0, internal: 0 },
          calls: stale ? [] : [{ id: 'active', direction: 'inbound', state: 'active', extensionIds: ['agent-1'], queueId: 'queue-1', startedAt: now }],
          queues: [{ id: 'queue-1', name: 'Support', extension: '2200', waiting: stale ? null : 1, onCall: stale ? null : 1, available: stale ? null : 1, onBreak: 1 }] } });
      }
      return route.fulfill({ json: url.pathname === '/api/admin/reports' ? reports : data[url.pathname] || {} });
    });
    await page.route('**/__operations-qa', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
      import React from '/node_modules/.vite/deps/react.js'; import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import RefreshRuntime from '/@react-refresh'; import '/src/styles/global.css';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
      const {default: AdminConsole}=await import('/src/features/admin/AdminConsole.jsx');
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AdminConsole,{profile:{role:${JSON.stringify(role)},organizationId:${JSON.stringify(org)}}}));
    </script></body></html>` }));
    await page.goto(`${origin}/__operations-qa`);
    const nav = page.locator('.admin-console > aside');
    await nav.getByRole('button', { name: 'Live operations', exact: true }).click();
    await page.getByText('Colleague 1', { exact: true }).waitFor();
    assert.equal(await page.locator('.ops-state.on_call').innerText(), 'On Call');
    await page.getByRole('combobox', { name: 'Queue availability for Colleague 1' }).selectOption('on_break');
    await page.waitForFunction(() => !document.querySelector('select[disabled]'));
    assert.equal(mutations, 1);
    await page.getByRole('tab', { name: 'Queues', exact: true }).click(); await page.getByText('Support', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Live calls', exact: true }).click(); await page.getByText('Colleague 2', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Agents & registrations' }).click();
    await page.screenshot({ path: `/tmp/vocivo-${role}-operations.png`, fullPage: true });
    stale = true; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText(/Live telemetry is unavailable or stale/).waitFor();
    assert.equal(await page.locator('.ops-metrics strong').first().innerText(), '—');
    await nav.getByRole('button', { name: 'Reports', exact: true }).click();
    await page.getByText('Colleague 1 · Extension 2000', { exact: true }).waitFor();
    await page.getByRole('searchbox', { name: 'Search call records' }).fill('missing');
    await page.getByText('No matching calls', { exact: true }).waitFor();
    await page.getByRole('searchbox', { name: 'Search call records' }).fill('');
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export CSV' }).click();
    assert.equal((await download).suggestedFilename(), 'vocivo-call-records.csv');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `/tmp/vocivo-${role}-reports-${width}.png`, fullPage: true });
      const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(layout.scroll <= layout.width + 1, `page overflow at ${width}: ${layout.scroll}`);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${role}: operations, scoped mutation, stale state, reports, CSV, desktop/mobile layout`);
    await page.close();
  }
} finally { await browser.close(); }
