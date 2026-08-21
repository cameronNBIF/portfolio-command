/**
 * The primitives every versioned-write module needs (ADR-031).
 *
 * Extracted at A8, when `rounds.ts` became the second module writing to a table
 * with the capture trigger on it. Both of them have to name an actor, both have
 * to decide whether a change restates an issued figure, and both validate money
 * and dates against the same rules. Two copies of the restatement test would be
 * two things to keep in step, and the copy that drifts is the one that lets a
 * board figure move unannounced.
 *
 * WHAT DOES NOT LIVE HERE: anything about a particular table. Field rules,
 * constraint restatements and per-table error wording stay in the module that
 * owns the table, because those are the sentences the person filling in the form
 * reads and they should be written for that form.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import type { Principal } from '../auth/principal.js';
import { ValidationError } from './errors.js';

/**
 * MONEY IS A STRING END TO END (ADR-008), IN DOLLARS, NOT `$M`.
 *
 * The reasoning is set out at the top of `financial.ts` and applies unchanged
 * here: these are internal entry APIs whose callers are forms a human types
 * into, and asking someone to express $5,000,000 as `5` invents the exact class
 * of error `units.ts` exists to prevent. The export contract is untouched — it
 * reads the same rows and converts on the way out as it always has.
 */
const MONEY = /^\d{1,15}(\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function money(value: unknown, field: string, allowZero = false): string {
  if (typeof value !== 'string' || !MONEY.test(value)) {
    throw new ValidationError(
      `"${field}" must be an amount in dollars with at most two decimal places, as text — for example "1250000.00". Got ${JSON.stringify(value)}.`,
    );
  }
  if (!allowZero && Number(value) === 0) {
    throw new ValidationError(`"${field}" must be greater than zero.`);
  }
  return value;
}

export function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`"${field}" must be a real date as YYYY-MM-DD. Got ${JSON.stringify(value)}.`);
  }
  return value;
}

export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`"${field}" is required.`);
  }
  return value.trim();
}

export const optional = <T>(value: T | null | undefined): T | null => value ?? null;

/** An optional money field: blank and absent both mean "not captured". */
export function optionalMoney(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  return money(value, field, true);
}

/**
 * Names the actor for the capture trigger, which raises without it.
 *
 * `set_config(..., true)` rather than `SET LOCAL`: the local form takes no bind
 * parameters, so it would mean interpolating a uuid into SQL text. Same
 * transaction-scoped effect, no string building.
 */
export async function setSessionContext(
  trx: Kysely<DB>,
  principal: Principal,
  reason: string | null,
  changeKind: ChangeKind | null = null,
): Promise<void> {
  await sql`select set_config('pc.actor_id', ${principal.userId}, true)`.execute(trx);
  await sql`select set_config('pc.change_reason', ${reason ?? ''}, true)`.execute(trx);
  await sql`select set_config('pc.change_kind', ${changeKind ?? ''}, true)`.execute(trx);
}

/**
 * ADR-038, FR-14. WHY a financial row changed, as distinct from what changed.
 *
 * `correction` — the stored figure was wrong.
 * `new-information` — the figure was right and something arrived late. Pat's
 *   case exactly: a grant that becomes known six months after the round is
 *   added to it, and the change log should not call that a data-correction
 *   error. The row's history was right; the label was wrong.
 * `initial-load` — a bulk historical import. A13's, and the fixture importer's.
 *
 * NULL IS A LEGITIMATE VALUE AND MEANS UNCLASSIFIED. Every version row written
 * before migration 0013 genuinely is, and a routine typo fix that nobody
 * classified is not a defect.
 */
export type ChangeKind = 'correction' | 'new-information' | 'initial-load';

export const CHANGE_KINDS: readonly ChangeKind[] = ['correction', 'new-information', 'initial-load'];

/** Narrows an unknown to a `ChangeKind`, or null. Rejects anything else. */
export function changeKind(value: unknown): ChangeKind | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !(CHANGE_KINDS as readonly string[]).includes(value)) {
    throw new ValidationError(
      `"changeKind" must be one of ${CHANGE_KINDS.join(', ')}, or omitted. Got ${JSON.stringify(value)}.`,
    );
  }
  return value as ChangeKind;
}

/**
 * ADR-031 clause 5. An edit inside an issued period is permitted and must be
 * explained.
 *
 * Every date the change touches is passed, not just the submitted one: moving a
 * row's effective date OUT of a frozen period restates that period just as
 * surely as changing its amount, and checking only the new date would miss it.
 *
 * Returns whether this change restates, so the caller can report it back rather
 * than the UI having to work it out a second time.
 */
export async function checkRestatement(
  trx: Kysely<DB>,
  dates: (string | null)[],
  reason: string | null,
  what: string,
): Promise<boolean> {
  /* The kind comes from the SESSION rather than from a parameter, and that is
     the whole reason five writers did not need a new argument. `setSessionContext`
     has already put it in `pc.change_kind` for this transaction — it has to, so
     the capture trigger can read it — which makes the GUC the transaction's one
     authority on the answer. Threading it separately would have created a second
     one, and the two would eventually disagree about the same write. */
  const { rows } = await sql<{ frozen: string | null; kind: string | null }>`
    select pc.latest_frozen_period_end()::text as frozen,
           pc.current_change_kind()            as kind
  `.execute(trx);
  const frozen = rows[0]?.frozen ?? null;
  const kind = (rows[0]?.kind ?? null) as ChangeKind | null;
  const restates = frozen !== null && dates.some((d) => d !== null && d <= frozen);

  /* ADR-038 clause 3. `new-information` is meaningful only where there is
     something to restate. Outside a frozen period the distinction between a
     correction and a late arrival is noise, and a value that can be picked
     anywhere is one people pick at random -- which would hollow out the exact
     signal FR-14 asked for.

     ENFORCED HERE because this is the one function that knows whether a change
     restates, and putting the rule anywhere else would mean computing that
     twice. The UI offers the option conditionally for the same reason; this is
     what makes it true for a caller that is not the UI. */
  if (kind === 'new-information' && !restates) {
    throw new ValidationError(
      `This ${what} does not fall inside a period already issued to the board, so there is ` +
        'nothing for late-arriving information to restate. Record it as an ordinary change — ' +
        '"new-information" exists to stop a late grant reading as a correction of a published ' +
        'figure, and outside a published period there is no such figure.',
    );
  }

  if (!restates) return false;

  if (!reason || reason.trim().length < 10) {
    throw new ValidationError(
      `This ${what} falls on or before ${frozen}, a period already issued to the board. ` +
        'Editing it restates a published figure, which is allowed but must be explained: ' +
        'give a restatement reason of at least ten characters.',
    );
  }
  return true;
}
