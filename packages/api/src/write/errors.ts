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

/**
 * FR-08, ADR-038 clause 4. The save was refused because it looks like a
 * duplicate, and it will go through as soon as the caller says which kind of
 * legitimate second row it is.
 *
 * A SEPARATE CLASS, AND A SEPARATE STATUS, because the client has to be able to
 * tell this from an ordinary rejection. A 400 saying "that looks like a
 * duplicate" leaves the form with nothing to offer but the same button again;
 * a 409 carrying the colliding round lets it show WHICH round, and ask the one
 * question that clears it. A warning the interface cannot act on is a hard
 * block wearing a softer message, which is precisely what clause 4 refuses.
 *
 * Extends ValidationError so any handler that only knows about that still fails
 * safe with a client error rather than a 500.
 */
export class DuplicateRoundError extends ValidationError {
  readonly duplicateOf: { investmentRoundId: string; label: string; roundDate: string };

  constructor(
    message: string,
    duplicateOf: { investmentRoundId: string; label: string; roundDate: string },
  ) {
    super(message);
    this.name = 'DuplicateRoundError';
    this.duplicateOf = duplicateOf;
  }
}
