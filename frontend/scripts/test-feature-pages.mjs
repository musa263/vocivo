import assert from 'node:assert/strict';
import { defaultPbxConfig } from '../api/_lib/features/organizations/pbx-config-store.ts';
import { defaultPlans, featureCatalog } from '../api/_lib/features/organizations/saas-store.ts';

// UI regression check for module extraction; every API request is intercepted.
// Run with node --import tsx and the Playwright setup from CONTRIBUTING.md.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.VOCIVO_TEST_ORIGIN || 'http://127.0.0.1:5183';
const config = defaultPbxConfig();
const plans = defaultPlans();
const organization = {
  ...config.organizations[0], name: 'QA Company', admins: [],
  plan: plans[0], usage: { seats: 1 }, subscription: { status: 'active', planId: plans[0].id },
  entitlements: Object.fromEntries(featureCatalog.map(item => [item.id, true])),
};
const data = {
  '/api/admin/pbx': { config },
  '/api/admin/saas': { platform: { name: 'Vocivo Communications' }, organizations: [organization], plans, featureCatalog },
  '/api/admin/extensions': { extensions: [] },
  '/api/admin/numbers': { numbers: [], orders: [], messagingProfiles: [] },
  '/api/admin/number-routing': { numbers: [], targets: [], users: [], version: 'fixture' },
  '/api/admin/carrier-trunks': { trunks: [], version: 'fixture' },
  '/api/admin/voices': { voices: [], provider: { healthy: false } },
  '/api/voice/settings': { config: { enabled: false, departments: [], voice: '', companyName: 'QA Company' } },
  '/api/admin/api-keys': { keys: [] },
  '/api/admin/events': { events: [] },
  '/api/admin/operations': { fresh: false, observedAt: null, source: 'sip-edge', agents: [], calls: [], queues: [], counters: null },
  '/api/admin/reports': { calls: [], timezone: 'UTC', complete: true, wallet: { available: true, rows: [] }, analytics: {
    total: 0, answered: 0, incomplete: 0, durationSeconds: 0, hours: [], directions: { inbound: 0, outbound: 0, internal: 0 }, topExtensions: [], billing: { unpricedCalls: 0 },
  } },
};
const browser = await chromium.launch({ headless: true });
try {
  for (const role of ['superadmin', 'company_admin']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.route('**/api/**', route => route.fulfill({ json: data[new URL(route.request().url()).pathname] || {} }));
    await page.route('**/__admin-qa', route => route.fulfill({ contentType: 'text/html', body: `
      <!doctype html><html><head><title>Vocivo admin feature QA</title></head><body><div id="root"></div>
      <script type="module">
        import React from '/node_modules/.vite/deps/react.js';
        import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
        import RefreshRuntime from '/@react-refresh';
        import '/src/styles/global.css';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        const {default: AdminConsole} = await import('/src/features/admin/AdminConsole.jsx');
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AdminConsole,{profile:{role:${JSON.stringify(role)}}}));
      </script></body></html>` }));
    await page.goto(`${origin}/__admin-qa`, { waitUntil: 'domcontentloaded' });
    const nav = page.locator('.admin-console > aside .nav-group button');
    await nav.first().waitFor().catch(async error => {
      console.error(await page.locator('body').innerText());
      throw error;
    });
    const labels = await nav.allTextContents();
    for (const label of labels) {
      await page.locator('.admin-console > aside').getByRole('button', { name: label, exact: true }).click();
      await page.locator('.admin-console > main .page').waitFor();
      assert.deepEqual(errors, [], `${role}: ${label}`);
      console.log(`PASS: ${role} / ${label}`);
    }
    await page.locator('.admin-console > aside').getByRole('button', { name: 'Users', exact: true }).click();
    await page.getByRole('button', { name: /Add user/ }).click();
    await page.locator('.user-editor').waitFor();
    assert.deepEqual(errors, [], `${role}: user editor`);
    await page.screenshot({ path: `/tmp/vocivo-${role}-feature-layout.png` });
    await page.close();
  }
} finally {
  await browser.close();
}
