/**
 * Shared plumbing for the v1 route handlers.
 *
 * Route handlers stay thin on purpose: authentication, authorisation and error
 * translation live here, the work lives in `packages/api`, and what remains in
 * each `route.ts` is one call. The logic worth testing is then testable without
 * standing up a server.
 */
import { db, ForbiddenError, resolvePrincipal, UnauthorizedError, type Principal } from '@portfolio-command/api';

/** Errors carrying an HTTP status the client should actually see. */
function statusFor(err: unknown): { status: number; message: string } | null {
  if (err instanceof UnauthorizedError) return { status: 401, message: err.message };
  if (err instanceof ForbiddenError) return { status: 403, message: err.message };
  if (err instanceof Error && err.name === 'ValidationError') {
    return { status: 400, message: err.message };
  }
  return null;
}

/**
 * Resolves the caller, runs the handler, and maps failures to status codes.
 *
 * Unrecognised errors return a bare 500 and are logged server-side rather than
 * serialised to the client: an unexpected failure's message can carry a
 * connection string or a row of portfolio data, and neither belongs in a
 * browser.
 */
export async function withPrincipal(
  request: Request,
  handler: (principal: Principal) => Promise<unknown>,
): Promise<Response> {
  try {
    const principal = await resolvePrincipal(db(), request.headers);
    const body = await handler(principal);
    return Response.json(body);
  } catch (err) {
    const known = statusFor(err);
    if (known) {
      return Response.json({ error: known.message }, { status: known.status });
    }
    console.error('[api] unhandled error', err);
    return Response.json({ error: 'Internal error.' }, { status: 500 });
  }
}
