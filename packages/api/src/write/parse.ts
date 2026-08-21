/**
 * The primitives every request parser needs.
 *
 * `session.ts` is the precedent and the shape is deliberately the same: the
 * cross-cutting pieces live here, and anything about a particular endpoint stays
 * in the module that owns it, because those are the sentences the person filling
 * in the form reads.
 *
 * WHY THIS IS IN `packages/api` AND NOT IN THE ROUTE HANDLERS, which is where
 * all six parsers were written. Narrowing an unknown body to a typed mutation is
 * not HTTP work — it takes `unknown`, returns a domain type and raises
 * `ValidationError`. It is the input half of the same contract
 * `applyFinancialMutation` enforces the field half of, and the two were a
 * package apart. The cost was not theoretical:
 *
 *   - `apps/web` has no test runner, so the layer that turns untrusted JSON into
 *     a write was asserted nowhere. Every rule it carries — the three threshold
 *     states, null-versus-absent on a round link, "must not coalesce a null" on
 *     the influence threshold — was documented in a comment and guarded by
 *     nothing.
 *   - The envelope rule and the field rule could drift, which is the exact
 *     failure every one of those parsers has a comment warning about.
 *   - `judgement/route.ts` had grown a second `ValidationError` class of its own,
 *     which worked only because `handler.ts` matches by `name`.
 *
 * The parsers now sit beside the `apply*` function that consumes them, they are
 * exported from the package, and `packages/api/test/request-parsing.test.ts`
 * runs over them without a database.
 *
 * WHAT A PARSER DOES AND DOES NOT DO. It checks the envelope: that the body is
 * an object, that `op` or `kind` names something real, that an id is present
 * where one is needed and shaped like a row id. Every field rule belongs to the
 * write path, which owns it and raises the same error type. Two validators over
 * the same field is how the two drift apart, and the copy that drifts is the one
 * the user reads.
 */
import { ValidationError } from './errors.js';

/** A row id as it arrives over the wire: a bigint key, as text. */
const ROW_ID = /^\d+$/;

/** A date as the contract states them, and as `session.ts` validates them. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Narrows a parsed body to a keyed object.
 *
 * A `null` body is the shape a malformed JSON payload arrives as, because every
 * route reads the body through `jsonBody()`, which catches the parse failure
 * rather than letting a `SyntaxError` escape to a 500. So "not an object" and
 * "not JSON at all" reach the caller as the same 400, which is what both of them
 * are.
 */
export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Body must be an object.');
  }
  return body as Record<string, unknown>;
}

/** One of a fixed set of strings, named in the failure so the caller can fix it. */
export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  hint = '',
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`"${field}" must be one of: ${allowed.join(', ')}.${hint ? ` ${hint}` : ''}`);
  }
  return value as T;
}

/**
 * A row id, with the sentence naming what kind of row.
 *
 * Shape only. Whether the row exists is the write path's question, asked against
 * the database in the same transaction as the write, which is the only place it
 * can be asked without a race.
 */
export function rowId(value: unknown, what: string, onUpdate = false): string {
  if (typeof value !== 'string' || !ROW_ID.test(value)) {
    throw new ValidationError(
      onUpdate
        ? `"id" is required on an update and must be a ${what} id.`
        : `"id" is required and must be a ${what} id.`,
    );
  }
  return value;
}

/** A required non-empty string. */
export function requiredText(b: Record<string, unknown>, field: string): string {
  const v = b[field];
  if (typeof v !== 'string' || v === '') {
    throw new ValidationError(`"${field}" must be a non-empty string.`);
  }
  return v;
}

/**
 * An optional free-text field: anything that is not a string becomes null.
 *
 * Lenient on purpose, and only ever used for fields whose absence is legitimate
 * — a reason, a note, a change kind. A form that omits one means the same thing
 * as one that sends an empty one, and the write path is where a reason becomes
 * mandatory (`checkRestatement`) if the row turns out to fall in an issued
 * period.
 */
export function optionalText(b: Record<string, unknown>, field: string): string | null {
  return typeof b[field] === 'string' ? (b[field] as string) : null;
}

/** An object-valued field, with the sentence saying what it should hold. */
export function requiredObject(
  b: Record<string, unknown>,
  field: string,
  holds: string,
): Record<string, unknown> {
  const v = b[field];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ValidationError(`"${field}" must be an object holding ${holds}.`);
  }
  return v as Record<string, unknown>;
}

/**
 * Is this a date in the contract's format?
 *
 * A PREDICATE RATHER THAN A VALIDATOR, because the two callers that ask about a
 * query-string `asOf` have deliberately different sentences to raise — one names
 * the view being drawn, the other offers the alternative parameter — and a
 * shared throw would flatten both into a message that helps neither. What is
 * shared is the one thing worth sharing: the format.
 */
export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}
