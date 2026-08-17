/**
 * Errors the write path raises that a caller should see the message of.
 *
 * Separate from both write modules because both raise it, and having
 * `financial.ts` import from `judgement.ts` to get an error class would imply a
 * relationship between them that ADR-018 spent an ADR establishing does not
 * exist.
 *
 * `handler.ts` maps this to HTTP 400 by `name`, not by `instanceof`, so the
 * route layer never has to import from the API package's internals.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
