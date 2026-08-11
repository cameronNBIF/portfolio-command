/**
 * Authentication: a request -> a `Principal`, or nothing.
 *
 * This is the seam. Two providers sit behind one function so that swapping
 * them changes no endpoint, no guard and no audit code:
 *
 *   AUTH_MODE=entra  Validates the MSAL bearer token against the tenant's
 *                    JWKS, then resolves the `oid` claim to an app_user row.
 *   AUTH_MODE=dev    Trusts DEV_PRINCIPAL_EMAIL and resolves it the same way.
 *                    Local only, and it refuses to run in production.
 *
 * IN BOTH MODES THE ROLE COMES FROM THE DATABASE (see principal.ts). The token
 * is evidence of identity and nothing more, so a tenant misconfiguration cannot
 * hand anyone a permission.
 *
 * A user must exist in `app_user` and be active. There is no just-in-time
 * provisioning: a valid tenant token from someone nobody has granted access to
 * is a 401, because ADR-005 scopes this platform to named staff rather than to
 * everyone who can sign in to the organisation.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Kysely } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';

import { isRole, type Principal, UnauthorizedError } from './principal.js';

export type AuthMode = 'entra' | 'dev';

export function authMode(): AuthMode {
  const mode = process.env.AUTH_MODE ?? 'dev';
  if (mode !== 'entra' && mode !== 'dev') {
    throw new Error(`AUTH_MODE must be "entra" or "dev"; got ${JSON.stringify(mode)}.`);
  }
  if (mode === 'dev' && process.env.NODE_ENV === 'production') {
    // A dev-mode principal in production would be an unauthenticated platform
    // that looks authenticated, which is worse than one that is plainly open.
    throw new Error('AUTH_MODE=dev is refused when NODE_ENV=production.');
  }
  return mode;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function tenantJwks(tenantId: string) {
  jwks ??= createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
  );
  return jwks;
}

/** Reads the Entra object id from a validated bearer token. */
async function entraObjectIdFromToken(authorization: string | null): Promise<string> {
  const token = authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new UnauthorizedError('Missing bearer token.');

  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.ENTRA_CLIENT_ID;
  if (!tenantId || !clientId) {
    throw new Error('ENTRA_TENANT_ID and ENTRA_CLIENT_ID must be set when AUTH_MODE=entra.');
  }

  try {
    const { payload } = await jwtVerify(token, tenantJwks(tenantId), {
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience: clientId,
    });
    // `oid` is the immutable per-tenant object id. `sub` is per-application and
    // `email` is mutable, so neither is safe as the key a permission hangs on.
    const oid = payload['oid'];
    if (typeof oid !== 'string') throw new UnauthorizedError('Token carries no oid claim.');
    return oid;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError('Bearer token failed validation.');
  }
}

/**
 * Resolves the caller. Throws `UnauthorizedError` rather than returning null,
 * so a route that forgets to check gets an error instead of a silent anonymous
 * principal.
 */
export async function resolvePrincipal(
  db: Kysely<DB>,
  headers: { get(name: string): string | null },
): Promise<Principal> {
  const mode = authMode();

  let user;
  if (mode === 'entra') {
    const oid = await entraObjectIdFromToken(headers.get('authorization'));
    user = await db
      .selectFrom('app_user')
      .select(['user_id', 'entra_object_id', 'email', 'display_name', 'role', 'is_active'])
      .where('entra_object_id', '=', oid)
      .executeTakeFirst();
    if (!user) throw new UnauthorizedError('Authenticated, but no account is provisioned.');
  } else {
    const email = process.env.DEV_PRINCIPAL_EMAIL;
    if (!email) {
      throw new Error('AUTH_MODE=dev requires DEV_PRINCIPAL_EMAIL. See .env.example.');
    }
    user = await db
      .selectFrom('app_user')
      .select(['user_id', 'entra_object_id', 'email', 'display_name', 'role', 'is_active'])
      .where('email', '=', email)
      .executeTakeFirst();
    if (!user) throw new UnauthorizedError(`No app_user with email ${email}.`);
  }

  if (!user.is_active) throw new UnauthorizedError('Account is deactivated.');
  if (!isRole(user.role)) {
    // The CHECK constraint should make this impossible. If it ever happens,
    // failing closed is the only safe reading.
    throw new UnauthorizedError(`Account carries an unrecognised role ${JSON.stringify(user.role)}.`);
  }

  return {
    userId: user.user_id,
    entraObjectId: user.entra_object_id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
  };
}
