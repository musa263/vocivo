import { assertCompanyAccountIdentity, isCompanyAccountRole } from './company-account.js';
import { readCurrentExtension } from '../organizations/extension-identity.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { requiredEnv } from '../../shared/http.js';
import { put } from '../../shared/object-store.js';
import { readStoredObject } from '../../shared/stored-object-read.js';
import { isExtensionSessionRevoked } from '../organizations/extension-session-store.js';
import { activeTenantAdmin, type TenantAdminAccount } from '../organizations/saas-store.js';
import { readPbxConfig } from '../organizations/pbx-config-store.js';

import { credentialVersion, assertCredentialVersion } from './credential-version.js';
import { readPasswordHash } from './owner-password.js';

const issuer = 'vocivo-vercel';
const audience = 'vocivo-mobile';

function key() {
  return new TextEncoder().encode(requiredEnv('AUTH_SECRET'));
}

export async function createSession(email: string) {
  return new SignJWT({ email, role: 'superadmin', accountType: 'platform', credentialVersion: credentialVersion(await readPasswordHash()) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('vocivo-owner')
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key());
}

export type VocivoSession = JWTPayload & {
  email?: string;
  name?: string;
  role?: 'owner' | 'admin' | 'superadmin' | 'company_owner' | 'company_admin' | 'manager' | 'user' | 'individual';
  accountType?: 'platform' | 'business' | 'individual';
  extensionId?: string;
  extension?: string;
  organizationId?: string;
  accountId?: string;
  forcePasswordChange?: boolean;
};

export async function createTenantAdminSession(account: TenantAdminAccount) {
  return new SignJWT({
    email: account.email,
    name: account.name,
    role: account.role,
    accountType: 'business',
    accountId: account.id,
    extensionId: account.extensionId,
    extension: account.extension,
    organizationId: account.organizationId,
    forcePasswordChange: account.forcePasswordChange,
    credentialVersion: credentialVersion(account.passwordHash),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`vocivo-account:${account.id}`)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(key());
}

export async function createExtensionSession(input: { id: string; email: string; name: string; role: 'company_owner' | 'company_admin' | 'manager' | 'user' | 'individual'; extension: string; organizationId: string; accountType: 'business' | 'individual' }) {
  return new SignJWT({ email: input.email, name: input.name, role: input.role, accountType: input.accountType, extensionId: input.id, extension: input.extension, organizationId: input.organizationId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`vocivo-extension:${input.id}`)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key());
}

export async function createEnrollmentToken(extensionId: string) {
  return new SignJWT({ purpose: 'extension-enrollment', extensionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('vocivo-enrollment')
    .setIssuer(issuer)
    .setAudience(audience)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key());
}

export async function verifyEnrollmentToken(token: string) {
  const { payload } = await jwtVerify(token, key(), { issuer, audience });
  if (payload.sub !== 'vocivo-enrollment' || payload.purpose !== 'extension-enrollment' || typeof payload.extensionId !== 'string' || typeof payload.jti !== 'string') throw new Error('Invalid enrollment code.');
  return { extensionId: payload.extensionId, jti: payload.jti };
}

const sessionCookieName = 'vocivo_session';
const csrfCookieName = 'vocivo_csrf';

function cookieValue(name: string, value: string, maxAgeSeconds: number, httpOnly: boolean) {
  const attributes = [`${name}=${value}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'SameSite=Strict', 'Secure'];
  if (httpOnly) attributes.push('HttpOnly');
  return attributes.join('; ');
}

// Web clients authenticate with an httpOnly session cookie (double-submit CSRF cookie
// alongside it); mobile clients keep sending the bearer token and are unaffected.
export function setSessionCookies(res: VercelResponse, token: string, maxAgeSeconds: number) {
  const csrf = randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', [cookieValue(sessionCookieName, token, maxAgeSeconds, true), cookieValue(csrfCookieName, csrf, maxAgeSeconds, false)]);
}

export function clearSessionCookies(res: VercelResponse) {
  res.setHeader('Set-Cookie', [cookieValue(sessionCookieName, '', 0, true), cookieValue(csrfCookieName, '', 0, false)]);
}

function assertCsrf(req: VercelRequest) {
  const method = String(req.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return;
  const headerValue = req.headers['x-vocivo-csrf'];
  const csrfHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const csrfCookie = req.cookies?.[csrfCookieName];
  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) throw new Error('Unauthorized');
}

function sessionTokenFrom(req: VercelRequest) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookieToken = req.cookies?.[sessionCookieName];
  if (typeof cookieToken === 'string' && cookieToken) {
    // Cookie-authenticated mutations must carry the double-submit CSRF header.
    assertCsrf(req);
    return cookieToken;
  }
  return undefined;
}

async function verifySessionToken(req: VercelRequest) {
  const token = sessionTokenFrom(req);
  if (!token) throw new Error('Unauthorized');
  const { payload } = await jwtVerify(token, key(), { issuer, audience });
  if (typeof payload.sub !== 'string' || payload.sub !== 'vocivo-owner' && !payload.sub.startsWith('vocivo-extension:') && !payload.sub.startsWith('vocivo-account:')) throw new Error('Unauthorized');
  return payload as JWTPayload & { sub: string };
}

function requestPath(req: VercelRequest) {
  return String(req.url || '').split('?')[0];
}

function allowsForcedPasswordChange(req: VercelRequest) {
  const path = requestPath(req);
  return path === '/api/auth/session' || path === '/api/auth/password';
}

const ownerInvalidationPath = 'vocivo/auth/owner-sessions-invalidated-at';
let ownerInvalidationCache: { checkedAt: number; invalidatedAtSeconds: number } | undefined;

export async function invalidateOwnerSessions() {
  await put(ownerInvalidationPath, new Date().toISOString(), { access: 'private', contentType: 'text/plain', allowOverwrite: true });
  ownerInvalidationCache = undefined;
}

async function ownerSessionsInvalidatedAtSeconds() {
  if (ownerInvalidationCache && Date.now() - ownerInvalidationCache.checkedAt < 15_000) return ownerInvalidationCache.invalidatedAtSeconds;
  try {
    const value = await readStoredObject(ownerInvalidationPath);
    const invalidatedAt = value ? Date.parse(value.toString('utf8').trim()) : Number.NaN;
    const invalidatedAtSeconds = Number.isFinite(invalidatedAt) ? Math.floor(invalidatedAt / 1000) : 0;
    ownerInvalidationCache = { checkedAt: Date.now(), invalidatedAtSeconds };
    return invalidatedAtSeconds;
  } catch (error) {
    console.error('Unable to read the owner session invalidation marker.', error);
    throw new Error('Owner session verification is temporarily unavailable.');
  }
}

async function assertOwnerSessionCurrent(payload: JWTPayload) {
  const invalidatedAtSeconds = await ownerSessionsInvalidatedAtSeconds();
  assertCredentialVersion(payload.credentialVersion, await readPasswordHash());
  if (invalidatedAtSeconds && (typeof payload.iat !== 'number' || payload.iat < invalidatedAtSeconds)) throw new Error('Unauthorized');
}

const sessionDependencies = { readPbxConfig, activeTenantAdmin, readCurrentExtension, isExtensionSessionRevoked };
export async function requireSession(req: VercelRequest, deps = sessionDependencies) {
  const payload = await verifySessionToken(req);
  const tenantSession = payload.sub.startsWith('vocivo-extension:') || payload.sub.startsWith('vocivo-account:');
  if (tenantSession) {
    if (typeof payload.organizationId !== 'string' || !payload.organizationId.trim()) throw new Error('Unauthorized');
    const config = await deps.readPbxConfig();
    const organization = config.organizations.find((organization) => organization.id === payload.organizationId && organization.status === 'active');
    if (!organization) throw new Error('Unauthorized');
    // Membership can change during a token's lifetime. A previous company role
    // must never survive a switch to an individual organization.
    payload.accountType = organization.accountType;
    if (organization.accountType === 'individual') {
      if (payload.sub.startsWith('vocivo-account:')) throw new Error('Unauthorized');
      payload.role = 'individual';
    }
  }
  if (payload.sub.startsWith('vocivo-extension:')) {
    if (typeof payload.extensionId !== 'string' || typeof payload.extension !== 'string' || typeof payload.iat !== 'number') throw new Error('Unauthorized');
    if (await deps.isExtensionSessionRevoked(payload.extensionId, payload.iat)) throw new Error('Unauthorized');
  }
  if (payload.sub.startsWith('vocivo-account:')) {
    if (typeof payload.accountId !== 'string' || typeof payload.organizationId !== 'string' || !isCompanyAccountRole(payload.role)) throw new Error('Unauthorized');
    const account = await deps.activeTenantAdmin(payload.accountId, payload.organizationId);
    if (!account) throw new Error('Unauthorized');
    assertCredentialVersion(payload.credentialVersion, account.passwordHash);
    assertCompanyAccountIdentity(account, account.extensionId ? await deps.readCurrentExtension(account.extensionId) : null);
    const session = {
      ...payload,
      email: account.email,
      name: account.name,
      role: account.role,
      extensionId: account.extensionId,
      extension: account.extension,
      organizationId: account.organizationId,
      forcePasswordChange: account.forcePasswordChange,
    } as VocivoSession;
    if (session.forcePasswordChange && !allowsForcedPasswordChange(req)) throw new Error('Password change required');
    return session;
  }
  if (payload.sub === 'vocivo-owner') await assertOwnerSessionCurrent(payload);
  return payload as VocivoSession;
}

export async function requireOwner(req: VercelRequest) {
  const payload = await verifySessionToken(req) as VocivoSession;
  if (payload.sub !== 'vocivo-owner' || !['owner', 'superadmin'].includes(payload.role || '')) throw new Error('Forbidden');
  await assertOwnerSessionCurrent(payload);
  return payload;
}

export async function requireAdmin(req: VercelRequest) {
  const session = await requireSession(req);
  return adminAccessForSession(session);
}

/**
 * Whether this session is Vocivo's own, rather than a customer's.
 *
 * One predicate, shared, because two of them drifted: the admin check accepted
 * the owner role and the entitlement check did not, so a session with that role
 * would be admitted as a platform administrator and then refused its
 * entitlements.
 */
export function isPlatformOwnerSession(session: VocivoSession) {
  return session.sub === 'vocivo-owner' && ['owner', 'superadmin'].includes(session.role || '');
}

export function adminAccessForSession(session: VocivoSession) {
  const superadmin = isPlatformOwnerSession(session);
  const companyAdmin = Boolean(session.organizationId && (session.extensionId || session.accountId) && ['company_owner', 'company_admin'].includes(session.role || ''));
  if (!superadmin && !companyAdmin) throw new Error('Forbidden');
  return { session, superadmin, organizationId: superadmin ? undefined : session.organizationId };
}
