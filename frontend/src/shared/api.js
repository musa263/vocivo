const SESSION_KEY = 'vocivo.session';

export function getStoredSession() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
    if (session && Object.prototype.hasOwnProperty.call(session, 'token')) {
      // Keep account metadata so App can validate the existing httpOnly cookie.
      // Never reuse the legacy bearer to authorize a request.
      const { token, ...metadata } = session;
      localStorage.setItem(SESSION_KEY, JSON.stringify(metadata));
      return metadata;
    }
    return session;
  } catch { return null; }
}

export function storeSession(session) {
  // The auth token now lives in an httpOnly cookie set by the server; persist
  // everything except the token so an XSS can no longer read a usable credential.
  const { token, ...rest } = session || {};
  localStorage.setItem(SESSION_KEY, JSON.stringify(rest));
}
export function clearSession() { localStorage.removeItem(SESSION_KEY); }

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)vocivo_csrf=([^;]+)/);
  return match ? match[1] : '';
}

export async function api(path, options = {}) {
  const { auth = true, body, headers, ...fetchOptions } = options;
  const session = getStoredSession();
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  // Bringing the phone up is the one POST that is safe to repeat: a credential
  // request that timed out on a cold function was surfaced as "signal is
  // aborted without reason" and the phone never registered.
  const phoneSetup = path === '/api/voice/sip-credentials' || path === '/api/voice/config';
  const authPath = path.startsWith('/api/auth/');
  const retryable = method === 'GET' || phoneSetup || ['/api/auth/login', '/api/auth/enroll'].includes(path);
  const attempts = path.startsWith('/api/voice/status') ? 1 : phoneSetup || ['/api/auth/login', '/api/auth/enroll'].includes(path) ? 3 : retryable ? 2 : 1;
  const timeoutMs = path.startsWith('/api/voice/status') ? 5000 : phoneSetup ? 20000 : 10000;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(auth && session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
          ...(csrfToken() ? { 'X-Vocivo-Csrf': csrfToken() } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => ({}));
      // A cold function or a gateway hiccup is worth another attempt. Being
      // rate limited on the way in is not: three tries per click spent what the
      // limiter was still willing to allow and brought the lockout on faster.
      const temporary = [500, 502, 503, 504].includes(response.status) || (response.status === 429 && !authPath);
      if (!response.ok && retryable && temporary && attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      if (!response.ok) {
        const requestError = new Error(payload.error || 'The request could not be completed.');
        requestError.status = response.status;
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
          const seconds = Number(retryAfter);
          requestError.retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
        }
        throw requestError;
      }
      return payload;
    } catch (error) {
      // The browser's own wording for a timed-out fetch is "signal is aborted
      // without reason"; nobody should have to read that.
      if (error instanceof Error && error.name === 'AbortError') {
        error = new Error('The server took too long to answer. Check your connection and try again.');
        error.name = 'AbortError';
      }
      lastError = error;
      if (!retryable || attempt === attempts - 1 || (error instanceof Error && !['AbortError', 'TypeError'].includes(error.name))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('The request could not be completed.');
}

export async function apiAudio(path) {
  const session = getStoredSession();
  const response = await fetch(path, { headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {} });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'The voice preview could not be generated.');
  }
  return URL.createObjectURL(await response.blob());
}
