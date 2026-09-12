const workspacePaths = new Set([
  '/api/admin/pbx', '/api/admin/ai', '/api/admin/extensions', '/api/admin/overview',
  '/api/admin/events', '/api/admin/api-keys', '/api/admin/numbers', '/api/admin/trunks',
  '/api/admin/operations', '/api/admin/reports',
  '/api/admin/carrier-trunks', '/api/admin/number-routing', '/api/admin/background', '/api/voice/settings', '/api/telnyx/verified-numbers',
]);

// Each render captures its own workspace, including callbacks awaiting file
// reads or HTTP responses. Never consult a mutable global tenant at send time.
export function workspaceApi(request, organizationId, isCurrent = () => true) {
  return async (path, options) => {
    const url = new URL(path, 'https://vocivo.invalid');
    if (!workspacePaths.has(url.pathname)) return request(path, options);
    const assertCurrent = () => {
      if (!organizationId || !isCurrent()) throw new Error('The customer workspace changed. Reload before continuing.');
    };
    assertCurrent();
    url.searchParams.set('organizationId', organizationId);
    const result = await request(`${url.pathname}${url.search}`, options);
    assertCurrent();
    return result;
  };
}
