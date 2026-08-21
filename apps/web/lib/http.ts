'use client';

/**
 * The browser's one call to the v1 API.
 *
 * SIX COPIES OF THIS EXISTED, one per endpoint client, with identical bodies and
 * six `Error` subclasses that differed only in name. Each did the same three
 * things: send JSON, read the body back whether or not the request succeeded,
 * and raise the SERVER'S OWN SENTENCE rather than a generic failure. That last
 * part is the whole reason this layer is thin — the API's 400s are written for
 * the person reading them, and a "request failed" would throw that away at the
 * final step.
 *
 * Six copies of one behaviour is six places to change it. The one that matters
 * is already scheduled: `AUTH_MODE=entra` is built and works server-side
 * (`packages/api/src/auth/resolve.ts`), and nothing here sends an
 * `Authorization` header. The day MSAL sign-in lands, attaching the bearer token
 * is one edit to `call` rather than six edits and a hunt for the one that was
 * missed.
 *
 * WHAT DOES NOT LIVE HERE: anything about a particular endpoint. The URLs, the
 * query parameters and the request shapes stay in the `*-api.ts` module that
 * owns them, for the same reason the API package keeps field rules beside the
 * table they belong to.
 */

/**
 * A request the API refused, carrying the server's message verbatim.
 *
 * ONE CLASS RATHER THAN SIX, and the six it replaces were distinguishable only
 * by which file threw them — never by what a caller did about it. Every one of
 * the nineteen call sites ran the same expression: show the message if this is
 * ours, show a written fallback if it is not. `apiMessage` is that expression,
 * once.
 *
 * `status` and `payload` are carried because a caller occasionally needs more
 * than the sentence — see `DuplicateRoundWarning`, the one place that does.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly payload: Record<string, unknown> | null;

  constructor(message: string, status: number, payload: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * F6, FR-08. The save was refused because the round looks like a duplicate, and
 * it will go through as soon as the form says which kind of legitimate second
 * row it is.
 *
 * THE ONE GENUINE SPECIALISATION, and the reason `ApiError` carries a payload at
 * all. ADR-038 clause 4 is that this is a warning, never a hard block — and a
 * warning the interface cannot act on is a hard block wearing a softer message.
 * Carrying the colliding round is what lets the form name it and ask the one
 * question that clears it.
 *
 * Raised on any 409 that carries `duplicateOf`, which today is only
 * `/api/v1/rounds` — `DuplicateRoundError` is thrown from `write/rounds.ts` and
 * nowhere else. Recognising it here rather than in one endpoint client means a
 * second surface that captures a round gets the behaviour without re-deriving
 * it.
 */
export class DuplicateRoundWarning extends ApiError {
  readonly duplicateOf: { investmentRoundId: string; label: string; roundDate: string };

  constructor(
    message: string,
    duplicateOf: { investmentRoundId: string; label: string; roundDate: string },
  ) {
    super(message, 409, { duplicateOf });
    this.name = 'DuplicateRoundWarning';
    this.duplicateOf = duplicateOf;
  }
}

interface ErrorBody {
  error?: string;
  duplicateOf?: { investmentRoundId: string; label: string; roundDate: string };
}

/**
 * One request, one parsed body, one error type.
 *
 * The body is read on failure as well as success, deliberately: that is where
 * the API's own sentence is, and a client that only reads the body on 200 has to
 * invent a message for exactly the case where a real one exists.
 */
export async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => null)) as (ErrorBody & Record<string, unknown>) | null;

  if (!res.ok) {
    const message = body?.error ?? `Request failed (${res.status}).`;
    if (res.status === 409 && body?.duplicateOf) {
      throw new DuplicateRoundWarning(message, body.duplicateOf);
    }
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

/**
 * The server's sentence if this failure came from the API, the caller's written
 * fallback if it did not.
 *
 * THE GUARD IS THE POINT, not the convenience. An unexpected failure — a
 * `TypeError` from a bad render, a network stack message — carries text that was
 * never written for a user and can name internals. Every call site had this
 * expression spelled out; having it once means the guard cannot be forgotten on
 * the twentieth.
 *
 * The fallback is required rather than defaulted, because "Something went wrong"
 * is a worse sentence than whatever the surface can say about what it was
 * trying to do.
 */
export function apiMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}
