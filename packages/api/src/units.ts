/**
 * The unit boundary.
 *
 * ADR-001 puts the dollars/$M conversion in the API layer "in exactly one
 * place"; ADR-021 names that place as A3's adapter. This module IS that place,
 * in both directions. Nothing else in the repository multiplies or divides by
 * 1e6 -- if you find yourself typing the literal, import from here instead.
 *
 * The stakes are unusually high for four lines of arithmetic: a dropped
 * conversion multiplies every figure on every board screen by a million while
 * leaving every field name, type and test signature identical. The contract
 * snapshot test asserts units explicitly for that reason (ADR-022).
 *
 * WHY STRINGS. Postgres `numeric` arrives and departs as a string through
 * Kysely, deliberately, so money cannot silently become a float (ADR-008,
 * A0.1). This module preserves that: it converts at the edge and never lets a
 * float represent stored dollars. `toDollars` returns a string because that is
 * what goes into the insert.
 */

/** Scale factor. Named so the literal appears once in the codebase. */
const DOLLARS_PER_MILLION = 1e6;

/**
 * Contract `$M` -> database dollars, as a `numeric`-ready string.
 *
 * Rounded to cents to match `numeric(18,2)`. The rounding is not cosmetic:
 * `2.9 * 1e6` is `2900000.0000000005` in IEEE-754, and handing that to
 * Postgres relies on its rounding rather than stating ours.
 */
export function toDollars(millions: number): string;
export function toDollars(millions: number | null | undefined): string | null;
export function toDollars(millions: number | null | undefined): string | null {
  if (millions === null || millions === undefined) return null;
  return (Math.round(millions * DOLLARS_PER_MILLION * 100) / 100).toFixed(2);
}

/**
 * Database dollars -> contract `$M`.
 *
 * Accepts the string Kysely yields for `numeric`, and the number pg yields for
 * an `int` or a computed aggregate, so callers do not have to know which of the
 * two a given column produced.
 */
export function toMillions(dollars: string | number): number;
export function toMillions(dollars: string | number | null | undefined): number | null;
export function toMillions(dollars: string | number | null | undefined): number | null {
  if (dollars === null || dollars === undefined) return null;
  return Number(dollars) / DOLLARS_PER_MILLION;
}

/**
 * A `numeric` column that is NOT money and must survive the round trip
 * unrounded -- ownership percentages, which the contract carries as computed
 * floats to full double precision (`10.521185332909226`).
 *
 * Separate from `toMillions` so that neither can be reached for by accident:
 * one of them scales and one of them does not, and the two failure modes look
 * nothing alike on screen.
 */
export function toNumber(value: string | number): number;
export function toNumber(value: string | number | null | undefined): number | null;
export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** Plain number -> `numeric`-ready string, unscaled. The inverse of `toNumber`. */
export function toNumeric(value: number): string;
export function toNumeric(value: number | null | undefined): string | null;
export function toNumeric(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}
