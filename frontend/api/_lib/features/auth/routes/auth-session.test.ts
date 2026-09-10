import assert from 'node:assert/strict';
import test from 'node:test';
import { errors } from 'jose';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createAuthSessionHandler } from './auth-session.js';
import { defaultPbxConfig } from '../../organizations/pbx-config-store.js';
import type { VocivoSession } from '../auth.js';

async function invoke(failure: Error, stage: 'session' | 'config') {
  const headers: Record<string, unknown> = {};
  let status = 0, body: unknown;
  const res = { setHeader: (name: string, value: unknown) => { headers[name] = value; },
    status: (value: number) => { status = value; return res; }, json: (value: unknown) => { body = value; return res; } };
  const handler = createAuthSessionHandler({
    requireSession: async () => { if (stage === 'session') throw failure; return { sub: 'vocivo-owner', role: 'owner' } as VocivoSession; },
    readPbxConfig: async () => { if (stage === 'config') throw failure; return defaultPbxConfig(); },
    readTenantSaasState: async () => { throw new Error('Unexpected subscription read'); },
  });
  await handler({ method: 'GET', headers: {} } as VercelRequest, res as unknown as VercelResponse);
  return { status, body, headers };
}

test('revoked, expired and malformed sessions remain unauthorized', async () => {
  for (const error of [new Error('Unauthorized'), new errors.JWTExpired('expired', {}), new errors.JWSInvalid('malformed'), new errors.JWSSignatureVerificationFailed()]) {
    const result = await invoke(error, 'session');
    assert.equal(result.status, 401);
    assert.equal(result.headers['Set-Cookie'], undefined);
  }
});

test('session authority and tenant configuration outages return retryable 503 without clearing cookies', async () => {
  for (const stage of ['session', 'config'] as const) {
    const result = await invoke(new Error('database unavailable'), stage);
    assert.equal(result.status, 503);
    assert.equal(result.headers['Retry-After'], '5');
    assert.equal(result.headers['Set-Cookie'], undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /database unavailable/);
  }
});
