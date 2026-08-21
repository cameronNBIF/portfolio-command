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
function statusFor(err: unknown): { status: number; message: string; extra?: unknown } | null {
  if (err instanceof UnauthorizedError) return { status: 401, message: err.message };
  if (err instanceof ForbiddenError) return { status: 403, message: err.message };
  /* F6, FR-08. A duplicate-round warning is 409 rather than 400, and it carries
     the round it collided with. The form cannot ask "is this a second tranche?"
     without being able to say WHICH round it resembles, and a bare 400 gives it
     no way to tell this apart from a malformed field. Matched by `name` like
     ValidationError, so the route layer keeps knowing nothing about the API
     package's internals. */
  if (err instanceof Error && err.name === 'DuplicateRoundError') {
    const { duplicateOf } = err as Error & { duplicateOf?: unknown };
    return { status: 409, message: err.message, extra: { duplicateOf } };
  }
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
      return Response.json(
        { error: known.message, ...(known.extra ?? {}) },
        { status: known.status },
      );
    }
    console.error('[api] unhandled error', err);
    return Response.json({ error: 'Internal error.' }, { status: 500 });
  }
}

/**
 * Reads a JSON body, turning a malformed one into `null` rather than a throw.
 *
 * EVERY POST GOES THROUGH THIS, and before it existed three of them did not.
 * `exits`, `ownership` and `policies` called `request.json()` bare, so a
 * malformed payload raised a `SyntaxError`, fell past `statusFor` and came back
 * as a 500 — while `financial`, `judgement` and `rounds`, which had the
 * `.catch(() => null)`, returned a 400. Same broken request, two answers,
 * depending on which endpoint it arrived at.
 *
 * `null` is what every parser is built to reject with "Body must be an object.",
 * so unparseable JSON and a body that is not an object end up as the same 400,
 * which is what both of them are.
 */
export async function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}
