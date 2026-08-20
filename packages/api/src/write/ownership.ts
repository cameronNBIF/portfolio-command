/**
 * Ownership maintained between rounds (F3, FR-36, ADR-035).
 *
 * `company_ownership` has been written by exactly one thing since it existed:
 * the deal-close capture, as part of capturing a round. Q-15 established that
 * the changes that happen *between* rounds are real and routine -- an option
 * pool expansion, a round we did not participate in, a secondary -- and that
 * Finance enters them **ad hoc, as word of the event reaches them.** No
 * cadence, no reporting period, no batch. This module is the path that permits
 * that, and it exists as its own file for the reason `link-transactions.ts`
 * does: it writes one table, and the narrowness is the argument.
 *
 * WHY `CAN_CAPTURE_ROUND` AND NOT `CAN_WRITE_FINANCIAL`. The table is already
 * behind that gate -- ADR-012 assigns the shape of a round, ownership included,
 * to the deal lead holding the closing documents. Q-15's expectation is that
 * Finance enters these, and Finance already holds the capability; leaving the
 * deal lead able to record a cap-table change they hear about first costs
 * nothing and is how the platform learns of it soonest.
 *
 * TWO REASONS TRAVEL WITH ONE MUTATION AND THEY ARE NOT THE SAME REASON.
 * `changeReason` says what moved the cap table and is stored on the row for as
 * long as the row exists (ADR-035 clause 1). `reason` is the ADR-031
 * restatement explanation, required only when the change lands inside a period
 * already issued to the board, and it lives in the version store. Collapsing
 * them would mean either an ordinary adjustment demanding a restatement
 * sentence, or a restatement explained by "option pool".
 *
 * VERSION CAPTURE IS NOT HERE. It is the trigger from migration 0002, so a
 * percentage corrected by an UPDATE typed into psql is recorded identically to
 * one corrected through this file.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_CAPTURE_ROUND, type Principal, requireRole } from '../auth/principal.js';
import { recordAudit } from './audit.js';
import { ValidationError } from './errors.js';
import { checkRestatement, date, optional, setSessionContext, text } from './session.js';

export interface OwnershipAdjustmentInput {
  companyId: string;
  /** The date the cap table stood this way. Not the date it was typed in. */
  asOfDate: string;
  /** Percent as a plain number, matching the contract convention. "11.2" is 11.2%. */
  ownershipPct: string;
  proRataRights: boolean;
  fullyDiluted?: boolean;
  sourceDocument?: string | null;
  /**
   * ADR-035 clause 1. REQUIRED on this path.
   *
   * Not decoration: this table feeds MOIC, the waterfall and the
   * significant-influence flag that drives accounting treatment. A figure that
   * cannot say where it came from is one nobody can defend in front of the
   * person who signs the statements.
   */
  changeReason: string;
  /**
   * Optional, and it is the exception rather than the rule on this path -- a
   * change caused by a round we captured belongs on the deal-close form, which
   * sets this itself. Offered here for the case where the round was captured
   * first and the cap-table consequence arrived later.
   */
  investmentRoundId?: string | null;
}

export type OwnershipMutation = { reason?: string | null } & (
  | { op: 'set'; values: OwnershipAdjustmentInput }
  | { op: 'delete'; id: string }
  | { op: 'restore'; id: string }
);

export interface OwnershipWriteResult {
  id: string;
  /** True when the change moved a figure inside an already-issued period. */
  restated: boolean;
  /**
   * Whether an existing position at that date was restated rather than a new
   * one recorded. Echoed back so the form can say which of the two it did:
   * "recorded" and "corrected" are different events to the person who typed it.
   */
  replacedExisting: boolean;
}

/** Percent as a plain number, 0 to 100. The contract convention (ADR-001). */
function percent(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,16})?$/.test(value)) {
    throw new ValidationError(
      `"${field}" must be a percentage as a plain number — 11.2 means 11.2%, not 0.112. Got ${JSON.stringify(value)}.`,
    );
  }
  if (Number(value) > 100) {
    throw new ValidationError(`"${field}" is ${value}%, which is more than the whole company.`);
  }
  return value;
}

/**
 * Applies one ownership adjustment.
 *
 * One database transaction, so the row and the version record the trigger
 * writes land together or not at all. The session context is set first because
 * the trigger raises without it.
 */
export async function applyOwnershipMutation(
  db: Kysely<DB>,
  principal: Principal,
  mutation: OwnershipMutation,
): Promise<OwnershipWriteResult> {
  requireRole(principal, CAN_CAPTURE_ROUND);

  const reason = mutation.reason?.trim() || null;

  return db.transaction().execute(async (trx) => {
    await setSessionContext(trx, principal, reason);

    if (mutation.op === 'delete' || mutation.op === 'restore') {
      return softDelete(trx, principal, mutation.id, mutation.op, reason);
    }
    return writeAdjustment(trx, principal, mutation.values, reason);
  });
}

async function writeAdjustment(
  trx: Kysely<DB>,
  principal: Principal,
  v: OwnershipAdjustmentInput,
  reason: string | null,
): Promise<OwnershipWriteResult> {
  const companyId = text(v.companyId, 'companyId');
  const asOfDate = date(v.asOfDate, 'asOfDate');
  const ownershipPct = percent(v.ownershipPct, 'ownershipPct');

  /* The sentence, not a checkbox. A blank box is refused here and permitted on
     the deal-close path, which is ADR-035 clause 1 made literal: there the
     round is the reason and the link says so. */
  const changeReason = v.changeReason?.trim() ?? '';
  if (changeReason.length < 3) {
    throw new ValidationError(
      'An ownership adjustment must say what caused it — an option pool expansion, a round we ' +
        'did not participate in, a secondary. This figure feeds MOIC, the waterfall and the ' +
        'significant-influence flag, and a number with no explanation is one nobody can defend later.',
    );
  }

  const { rows: company } = await sql<{ id: string }>`
    select company_id as id from pc.company where company_id = ${companyId}
  `.execute(trx);
  if (company.length === 0) throw new ValidationError(`No company ${companyId}.`);

  /* A named round must be this company's, and must be live. The same class of
     refusal F1 made on the cheque link, and for the same reason: there is no
     legitimate workflow on the other side of it. A cap-table position pointing
     at another company's round is not a figure anybody holds. */
  const roundId = v.investmentRoundId ?? null;
  if (roundId !== null) {
    const { rows } = await sql<{ company_id: string; deleted: boolean }>`
      select company_id, (deleted_at is not null) as deleted
        from pc.investment_round where investment_round_id = ${roundId}::bigint
    `.execute(trx);
    const round = rows[0];
    if (!round) throw new ValidationError(`No round with id ${roundId}.`);
    if (round.company_id !== companyId) {
      throw new ValidationError(
        `Round ${roundId} belongs to ${round.company_id}, not ${companyId}. An ownership position ` +
          'can only name a round of its own company.',
      );
    }
    if (round.deleted) {
      throw new ValidationError(`Round ${roundId} has been deleted, so it cannot be named as the cause.`);
    }
  }

  /* The row this write lands on, if there is one. Read before the upsert so the
     result can say which of the two things happened, and so a restatement is
     tested against the date already stored as well as the one submitted. They
     are the same date here -- the key is (company, date) -- but reading it is
     what proves the row exists rather than assuming the upsert's outcome. */
  const { rows: existing } = await sql<{ id: string; as_of_date: string; deleted: boolean }>`
    select company_ownership_id::text as id, as_of_date::text as as_of_date,
           (deleted_at is not null) as deleted
      from pc.company_ownership
     where company_id = ${companyId} and as_of_date = ${asOfDate}::date
  `.execute(trx);
  const prior = existing[0] ?? null;

  const restated = await checkRestatement(trx, [asOfDate], reason, 'ownership position');

  /* Upserted on (company_id, as_of_date), which the schema makes unique. Two
     entries at the same date are one restated fact, not two positions.

     `deleted_at` is explicitly cleared, exactly as the deal-close path does and
     for the reason recorded there: the unique index does not exclude
     soft-deleted rows, so without this an entry at a date whose row had been
     deleted would write its values into a row invisible to every read. */
  const { rows } = await sql<{ id: string }>`
    insert into pc.company_ownership
      (company_id, as_of_date, ownership_pct, pro_rata_rights, fully_diluted,
       source_document, entered_by, change_reason, investment_round_id)
    values (${companyId}, ${asOfDate}::date, ${ownershipPct}::numeric,
            ${v.proRataRights === true}, ${v.fullyDiluted !== false},
            ${optional(v.sourceDocument)}, ${principal.userId}::uuid,
            ${changeReason}, ${roundId === null ? null : sql`${roundId}::bigint`})
    on conflict (company_id, as_of_date) do update
       set ownership_pct       = excluded.ownership_pct,
           pro_rata_rights     = excluded.pro_rata_rights,
           fully_diluted       = excluded.fully_diluted,
           source_document     = excluded.source_document,
           change_reason       = excluded.change_reason,
           investment_round_id = excluded.investment_round_id,
           entered_by          = excluded.entered_by,
           deleted_at          = null,
           deleted_by          = null,
           deleted_reason      = null
    returning company_ownership_id::text as id
  `.execute(trx);

  const id = rows[0]!.id;

  await recordAudit(trx, principal, {
    table: 'company_ownership',
    recordId: id,
    action: prior ? 'update' : 'insert',
    before: prior,
    after: {
      company_id: companyId,
      as_of_date: asOfDate,
      ownership_pct: ownershipPct,
      change_reason: changeReason,
      investment_round_id: roundId,
    },
  });

  return { id, restated, replacedExisting: prior !== null && !prior.deleted };
}

async function softDelete(
  trx: Kysely<DB>,
  principal: Principal,
  id: string,
  op: 'delete' | 'restore',
  reason: string | null,
): Promise<OwnershipWriteResult> {
  if (op === 'delete' && !reason) {
    throw new ValidationError('Deleting an ownership position requires a reason.');
  }

  const { rows: found } = await sql<{ as_of_date: string }>`
    select as_of_date::text as as_of_date from pc.company_ownership
     where company_ownership_id = ${id}::bigint
  `.execute(trx);
  if (found.length === 0) throw new ValidationError(`No ownership position with id ${id}.`);

  const restated = await checkRestatement(trx, [found[0]!.as_of_date], reason, 'ownership position');

  const { rows } = await sql<{ id: string }>`
    update pc.company_ownership
       set deleted_at     = ${op === 'delete' ? sql`clock_timestamp()` : sql`null`},
           deleted_by     = ${op === 'delete' ? sql`${principal.userId}::uuid` : sql`null`},
           deleted_reason = ${op === 'delete' ? reason : null}
     where company_ownership_id = ${id}::bigint
       and deleted_at is ${op === 'delete' ? sql`null` : sql`not null`}
    returning company_ownership_id::text as id
  `.execute(trx);

  if (rows.length === 0) {
    throw new ValidationError(
      op === 'delete'
        ? 'That ownership position is already deleted.'
        : 'That ownership position is not deleted, so there is nothing to restore.',
    );
  }

  await recordAudit(trx, principal, {
    table: 'company_ownership',
    recordId: id,
    action: 'delete',
    before: null,
    after: { op, reason },
  });

  return { id, restated, replacedExisting: false };
}
