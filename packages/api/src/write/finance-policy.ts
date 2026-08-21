/**
 * The finance policies (F3, FR-21, ADR-035 clauses 2, 3 and 5).
 *
 * Two things Finance sets rather than enters: the significant-influence
 * threshold, and the list of retention factors the FMV review offers. Neither
 * is a financial row and neither is a judgement record, which is why this is
 * its own module behind its own gate rather than another `kind` on
 * `applyJudgementEdit` -- that path is `CAN_EDIT_JUDGEMENT`, which is the VC
 * team, and a finance policy set by the investment team is the wrong signature
 * on a decision that drives financial-statement treatment.
 *
 * SUPERSEDE, NEVER UPDATE. The threshold is effective-dated for the same reason
 * `fund_alert_policy` is: a prior period's classification has to stay
 * reproducible, and a policy that silently rewrote itself would reclassify a
 * company inside a board pack that was issued before the change. Setting a
 * threshold closes the current row and opens a new one.
 *
 * THE RETENTION OPTIONS ARE THE EXCEPTION AND ARE NOT DATED. A mark stores the
 * factor it used (ADR-034), so a review written under an option later retired
 * still reconstructs from its own row; the list only decides what may be
 * chosen NEXT. That is why options are retired rather than deleted, and why
 * `is_active` is enough where the threshold needed a period.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_SET_FINANCE_POLICY, type Principal, requireRole } from '../auth/principal.js';
import { recordAudit } from './audit.js';
import { ValidationError } from './errors.js';
import { asObject, oneOf, optionalText } from './parse.js';

export type FinancePolicyEdit =
  | {
      kind: 'accounting-policy';
      /**
       * Percent as a plain number: 10 means 10%. NULL means no threshold is
       * set, and NULL is not 0 -- a threshold of 0 would flag every company we
       * hold a figure for, while no threshold makes the flag NULL and says so.
       */
      significantInfluencePct: number | null;
      note?: string | null;
    }
  | { kind: 'retention-option-add'; factor: string; label: string; sortOrder?: number | null }
  | { kind: 'retention-option-active'; factor: string; isActive: boolean };

export interface FinancePolicyResult {
  /** What the change did, in the words the screen reports back. */
  applied: string;
}

// --- the request envelope ---------------------------------------------------

const KINDS = ['accounting-policy', 'retention-option-add', 'retention-option-active'] as const;

/**
 * Narrows an unknown request body to a `FinancePolicyEdit`.
 *
 * Shallow, as everywhere else on v1: the envelope here, the field rules in
 * `applyFinancePolicyEdit` below.
 *
 * ONE THING THIS MUST NOT DO IS COALESCE A NULL. `significantInfluencePct: null`
 * is "no threshold in force", which makes the derived flag NULL for every
 * company; `0` would flag every company we hold a figure for. A `?? 0` here
 * would turn the first into the second, silently, on the one screen where the
 * difference is the requirement — which is why `request-parsing.test.ts` states
 * it as an assertion rather than leaving it to this paragraph.
 */
export function parseFinancePolicyEdit(body: unknown): FinancePolicyEdit {
  const b = asObject(body);

  const kind = oneOf(b['kind'], KINDS, 'kind');

  if (kind === 'accounting-policy') {
    const pct = b['significantInfluencePct'];
    if (pct !== null && typeof pct !== 'number') {
      throw new ValidationError(
        '"significantInfluencePct" must be a number — 10 means 10% — or null for no threshold in force.',
      );
    }
    return { kind, significantInfluencePct: pct, note: optionalText(b, 'note') };
  }

  const factor = b['factor'];
  if (typeof factor !== 'string' || factor === '') {
    throw new ValidationError('"factor" is required — the retained share as a decimal, such as "0.60".');
  }

  if (kind === 'retention-option-add') {
    const label = b['label'];
    if (typeof label !== 'string') throw new ValidationError('"label" is required.');
    const sortOrder = b['sortOrder'];
    return { kind, factor, label, sortOrder: typeof sortOrder === 'number' ? sortOrder : null };
  }

  const isActive = b['isActive'];
  if (typeof isActive !== 'boolean') {
    throw new ValidationError('"isActive" must be true to offer this option or false to retire it.');
  }
  return { kind: 'retention-option-active', factor, isActive };
}

export async function applyFinancePolicyEdit(
  db: Kysely<DB>,
  principal: Principal,
  edit: FinancePolicyEdit,
): Promise<FinancePolicyResult> {
  requireRole(principal, CAN_SET_FINANCE_POLICY);

  return db.transaction().execute(async (trx) => {
    switch (edit.kind) {
      case 'accounting-policy':
        return setAccountingPolicy(trx, principal, edit);
      case 'retention-option-add':
        return addRetentionOption(trx, principal, edit);
      case 'retention-option-active':
        return setRetentionOptionActive(trx, principal, edit);
      default: {
        const exhaustive: never = edit;
        throw new ValidationError(`Unknown policy edit ${JSON.stringify(exhaustive)}.`);
      }
    }
  });
}

async function setAccountingPolicy(
  trx: Kysely<DB>,
  principal: Principal,
  edit: Extract<FinancePolicyEdit, { kind: 'accounting-policy' }>,
): Promise<FinancePolicyResult> {
  const pct = edit.significantInfluencePct;
  if (pct !== null) {
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new ValidationError(
        `The significant-influence threshold must be a percentage between 0 and 100 — 10 means 10%. Got ${JSON.stringify(pct)}.`,
      );
    }
  }

  const { rows: current } = await sql<{
    id: string; pct: string | null; effective_from: string; note: string | null;
  }>`
    select fund_accounting_policy_id::text  as id,
           significant_influence_pct::text  as pct,
           effective_from::text             as effective_from,
           note
      from pc.fund_accounting_policy where effective_to is null
  `.execute(trx);
  const before = current[0] ?? null;

  /* SUPERSEDED, NOT UPDATED -- and closed as at today, which is the same choice
     `fund_alert_policy` made. A policy takes effect when someone sets it; a
     back-dated threshold would silently reclassify companies in periods that
     have already been reported, which is the exact thing the dating prevents. */
  if (before) {
    await sql`
      update pc.fund_accounting_policy
         set effective_to = current_date
       where fund_accounting_policy_id = ${before.id}::bigint
    `.execute(trx);
  }

  const { rows } = await sql<{ id: string }>`
    insert into pc.fund_accounting_policy (significant_influence_pct, set_by, note)
    values (${pct === null ? null : sql`${String(pct)}::numeric`},
            ${principal.userId}::uuid,
            ${edit.note?.trim() || null})
    returning fund_accounting_policy_id::text as id
  `.execute(trx);

  await recordAudit(trx, principal, {
    table: 'fund_accounting_policy',
    recordId: rows[0]!.id,
    action: 'insert',
    before,
    after: { significant_influence_pct: pct, note: edit.note?.trim() || null },
  });

  return {
    applied:
      pct === null
        ? 'No significant-influence threshold is in force. The flag reads “not determined” for every company.'
        : `Significant influence is held at ${pct}% or above, from today.`,
  };
}

/** The factor as the column holds it: retained value, four decimal places. */
function factor(value: unknown): string {
  if (typeof value !== 'string' || !/^\d(\.\d{1,4})?$/.test(value)) {
    throw new ValidationError(
      `A retention factor is the RETAINED share as a decimal — "0.75" means the position is carried at 75% of its previous FMV. Got ${JSON.stringify(value)}.`,
    );
  }
  const n = Number(value);
  if (n > 1) {
    throw new ValidationError(
      `"${value}" is more than 1. A retention factor cannot mark a position UP: 1.00 holds the figure and 0.25 takes three quarters off.`,
    );
  }
  /* THE ZERO CASE, AND IT IS NOT AN OVERSIGHT HERE. `ref_fmv_retention_option`
     carries `check (factor > 0 ...)` from migration 0009, so a 0% option cannot
     be inserted through this path or any other. F2's note that Q-19's 0% option
     became "a one-row insert rather than a migration" holds for every factor in
     (0, 1] and not for 0 itself. Saying so here is better than a constraint
     violation reaching the screen as a database error nobody can act on. */
  if (n === 0) {
    throw new ValidationError(
      'A 0% option cannot be added here: the column requires a factor above zero, and writing a ' +
        'position to nil is the wind-down path (FR-28) rather than an impairment. That is Q-19, ' +
        'and answering it yes needs a one-line migration.',
    );
  }
  return value;
}

async function addRetentionOption(
  trx: Kysely<DB>,
  principal: Principal,
  edit: Extract<FinancePolicyEdit, { kind: 'retention-option-add' }>,
): Promise<FinancePolicyResult> {
  const f = factor(edit.factor);
  const label = edit.label?.trim() ?? '';
  if (label.length < 3) {
    throw new ValidationError(
      'A retention option needs the sentence the review screen will show — "Retain 60% of existing ' +
        'FMV — a 40% decrease". FR-18 needed a ruling on which half of that sentence the number ' +
        'means, so the label carries both.',
    );
  }

  /* A factor already on the list is not added twice under a second label: two
     rows offering the same arithmetic under different words is a choice with no
     meaning, which is what the unique index on `factor` already says. Caught
     here so the message names the existing row rather than the constraint. */
  const { rows: existing } = await sql<{ label: string; is_active: boolean }>`
    select label, is_active from pc.ref_fmv_retention_option where factor = ${f}::numeric
  `.execute(trx);
  if (existing[0]) {
    throw new ValidationError(
      existing[0].is_active
        ? `${f} is already offered, as “${existing[0].label}”.`
        : `${f} exists as “${existing[0].label}” and is retired. Reinstate it rather than adding a second row.`,
    );
  }

  const { rows } = await sql<{ id: string }>`
    insert into pc.ref_fmv_retention_option (factor, label, sort_order)
    values (${f}::numeric, ${label},
            -- Sorted where it was asked for, or at the end of the list. The
            -- column is NOT NULL with a default of 0, and every seeded row
            -- carries a real rank, so falling back on the default would put a
            -- new option first -- above "retain 100%" -- which is not what
            -- "add an option" means.
            coalesce(${edit.sortOrder ?? null}::int,
                     (select coalesce(max(sort_order), 0) + 10 from pc.ref_fmv_retention_option)))
    returning fmv_retention_option_id::text as id
  `.execute(trx);

  await recordAudit(trx, principal, {
    table: 'ref_fmv_retention_option',
    recordId: rows[0]!.id,
    action: 'insert',
    before: null,
    after: { factor: f, label, sort_order: edit.sortOrder ?? null },
  });

  return { applied: `Added “${label}”. It is offered on the next review.` };
}

async function setRetentionOptionActive(
  trx: Kysely<DB>,
  principal: Principal,
  edit: Extract<FinancePolicyEdit, { kind: 'retention-option-active' }>,
): Promise<FinancePolicyResult> {
  const f = factor(edit.factor);

  /* RETIRED, NEVER DELETED, which is what migration 0009 says about this table
     and why `is_active` exists at all. A factor that has been used is
     referenced by marks that must keep reconstructing, and F6 reads the active
     set to check that a stored factor was legal when it was written -- a
     deleted row would make that check unanswerable. */
  const { rows } = await sql<{ id: string; label: string }>`
    update pc.ref_fmv_retention_option
       set is_active = ${edit.isActive}
     where factor = ${f}::numeric
    returning fmv_retention_option_id::text as id, label
  `.execute(trx);

  const row = rows[0];
  if (!row) throw new ValidationError(`No retention option with factor ${f}.`);

  await recordAudit(trx, principal, {
    table: 'ref_fmv_retention_option',
    recordId: row.id,
    action: 'update',
    before: { factor: f, is_active: !edit.isActive },
    after: { factor: f, is_active: edit.isActive },
  });

  return {
    applied: edit.isActive
      ? `“${row.label}” is offered again.`
      : `“${row.label}” is retired. Marks already written with it are untouched and still reconstruct.`,
  };
}
