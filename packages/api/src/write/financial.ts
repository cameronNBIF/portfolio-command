/**
 * The financial write path (ADR-031).
 *
 * This is the module ADR-018 said would never exist. It exists because the
 * requirement ADR-018 was protecting -- that a previously issued board report
 * stays reproducible -- is now met by the versioned store in migration 0002
 * rather than by refusing to let Finance edit anything. Read ADR-031 before
 * changing anything here.
 *
 * WHAT THIS MODULE IS AND IS NOT RESPONSIBLE FOR. Version capture is NOT here.
 * It is a database trigger, so an UPDATE typed into psql is recorded exactly
 * like one that came through this file. What lives here is the part a trigger
 * cannot do: naming the actor, deciding whether a change restates a published
 * figure, and rejecting input before it reaches a constraint. If you find
 * yourself adding history-keeping logic to this file, it belongs in the trigger
 * instead -- otherwise it can be bypassed, and then it is not a guarantee.
 *
 * THE COUNTERPART TO `judgement.ts`. That module's allow-list makes financial
 * tables unrepresentable; this one makes only financial tables representable.
 * The ADR-018 split between fact and judgement survives ADR-031 intact -- what
 * changed is the interface offered over the fact half, not the boundary.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_WRITE_FINANCIAL, type Principal, requireRole } from '../auth/principal.js';
import { ValidationError } from './errors.js';
import { checkRestatement, date, money, optional, setSessionContext, text } from './session.js';

/**
 * UNITS: THIS API SPEAKS DOLLARS, NOT $M.
 *
 * ADR-001 puts `$M` in the export contract and dollars in the database, and
 * `units.ts` is the single place that converts. Nothing here imports it, and
 * that is deliberate rather than an oversight.
 *
 * The $M convention exists because the prototype's JSON contract uses it. This
 * is not that contract -- it is a new internal entry API whose only caller is a
 * form the Director of Finance types into. Finance enters the amount on a
 * cheque. Asking them to express $5,000,000 as 5 in order to satisfy a
 * convention borrowed from a different interface would invent the exact class
 * of error `units.ts` warns about, on the one path where the figure has not yet
 * been checked against anything.
 *
 * So: dollars in, dollars stored, no conversion, no factor of 1e6 anywhere on
 * this path. The export contract is unaffected -- it reads the same rows and
 * converts on the way out as it always has.
 *
 * The validators, the actor GUC and the restatement test moved to `session.ts`
 * at A8, when `rounds.ts` became the second module writing to a trigger-backed
 * table. Same rules, one copy.
 */

export type FinancialTable =
  | 'transaction'
  | 'valuation_mark'
  | 'fund_investment_nav'
  | 'fund_distribution'
  // F5, ADR-037. The commitment stage of the LP three-stage model. It belongs
  // in this module rather than in one of its own -- the contrast is
  // `ownership.ts`, which is separate BECAUSE it sits behind a different gate.
  // A commitment is Finance's fact under CAN_WRITE_FINANCIAL like the other
  // four, so putting it here is what buys it edit, delete, restore and the
  // History panel without a line of new code for any of them.
  | 'fund_commitment';

/**
 * Per-table facts the generic operations need: the key to address a row by, the
 * date that decides whether a change is a restatement, and a name to put in an
 * error message. Delete and restore are then written once rather than four
 * times.
 */
const TABLES = {
  transaction: { key: 'transaction_id', date: 'txn_date', label: 'transaction' },
  valuation_mark: { key: 'valuation_mark_id', date: 'effective_date', label: 'valuation mark' },
  fund_investment_nav: { key: 'fund_investment_nav_id', date: 'as_of_date', label: 'LP NAV statement' },
  fund_distribution: { key: 'fund_distribution_id', date: 'distribution_date', label: 'fund distribution' },
  fund_commitment: { key: 'fund_commitment_id', date: 'as_of_date', label: 'capital commitment' },
} as const satisfies Record<FinancialTable, { key: string; date: string; label: string }>;

/**
 * FR-33, ADR-037 clause 4, Q-23. The LP three are NBIF's words, and they are
 * the STORED values rather than labels over older ones -- confirmed with Funke
 * before the rename, because the whole value of doing it now is doing it once.
 *
 * From the GP's side a drawdown is a capital call. From ours it is a draw
 * against a commitment we already made, and the platform speaks from our side.
 */
const TXN_TYPES = [
  'investment', 'follow_on', 'realization', 'write_off',
  'capital_drawdown', 'capital_distribution', 'fee',
] as const;
const DIRECT_TYPES = ['investment', 'follow_on', 'realization', 'write_off'] as const;

export interface TransactionInput {
  txnDate: string;
  txnType: (typeof TXN_TYPES)[number];
  companyId?: string | null;
  fundInvestmentId?: string | null;
  investmentRoundId?: string | null;
  investmentVehicleId?: number | null;
  /**
   * F0. What this cheque bought — an instrument id, or null for unrecorded.
   *
   * NOT derived here from the linked round, even though migration 0006's
   * backfill did exactly that. A backfill is a one-time interpretation of rows
   * written before the column existed; this is a form, and a form that quietly
   * fills a field the operator left blank is how "unrecorded" stops meaning
   * anything. The two commonly differ in the cases Finance cares about — a
   * round funded with a note alongside equity, a company holding both an equity
   * position and a loan — which is the whole reason the column is on the
   * transaction rather than read off the round.
   */
  instrumentId?: number | null;
  /** DOLLARS, as typed. Always positive; direction is implied by `txnType`. */
  amount: string;
  currency?: string;
  fxRateToCad?: string | null;
  sourceDocument?: string | null;
  note?: string | null;
}

/**
 * The two adjustment types F2 builds a write path for (ADR-034).
 *
 * The other six -- `legacy`, `initial`, `transaction`, `round_reprice`,
 * `realization`, `write_off` -- are declared in the schema's vocabulary and
 * written by nothing. They are deliberately NOT in this union: a type the API
 * accepts but has no branch for would be a type that silently falls through to
 * whatever the last `else` happens to do.
 */
export type MarkAdjustmentType = 'review' | 'manual';

export interface ValuationMarkInput {
  companyId: string;
  effectiveDate: string;
  /**
   * ADR-034. What kind of mark this is. **Defaults to `manual`**, which is the
   * free-entry absolute path that existed before F2 and that clause 7 keeps on
   * purpose -- A13 loads fifteen years of absolute marks through it, and an
   * escape hatch that exists is better than one that gets improvised.
   */
  adjustmentType?: MarkAdjustmentType;
  /**
   * DOLLARS. Zero is legitimate -- it is how a write-off is marked.
   *
   * REQUIRED on `manual` and REFUSED on `review`, rather than ignored there.
   * On the review path the server computes it from the basis and the factor,
   * and ADR-034 clause 2 is explicit about why the client may not also supply
   * it: a computed figure the client can also send is one that will eventually
   * disagree with itself, and the disagreement surfaces as a board number.
   */
  fmv?: string;
  /**
   * Required on `review`. The RETAINED proportion as a factor -- "0.7500" means
   * the position is carried at 75% of its basis, a 25% impairment.
   *
   * Validated server-side against the ACTIVE rows of
   * `ref_fmv_retention_option`, not by the shape of a drop-down: the list is
   * editable through the Policies surface, so the question "is this a legal
   * choice" only has an answer at write time and only the server can ask it.
   */
  retentionFactor?: string;
  valuationMethodId?: number | null;
  methodLabel: string;
  /** Required by the schema and by the ADR-007 sign-off. Not a formality. */
  rationale: string;
  sourceDocument?: string | null;
}

export interface LpNavInput {
  fundInvestmentId: string;
  asOfDate: string;
  /** DOLLARS. */
  nav: string;
  statementReceivedAt?: string | null;
  sourceDocument?: string | null;
}

/**
 * F5, ADR-037. A commitment level, as at a date.
 *
 * THE LEVEL, NOT THE CHANGE. A raise from $500,000 to $750,000 is submitted as
 * `750000.00`. This is the same shape ADR-034 chose for the valuation ledger
 * and for the same reason -- an absolute can be read, a delta has to be
 * replayed -- and it is the one thing about this form worth saying out loud on
 * the screen, because "adjustment" invites the other reading.
 */
export interface FundCommitmentInput {
  fundInvestmentId: string;
  /** The date this level took effect. Not the date it is being keyed in. */
  asOfDate: string;
  /** DOLLARS. Zero is legitimate: a commitment can be released to nil. */
  committed: string;
  /**
   * ADR-035 clause 1, borrowed. REQUIRED on this path and null only on
   * migration 0012's backfill, which had no cause to name beyond itself.
   *
   * A second close, a side letter, an amended LPA. This figure is the
   * denominator of unfunded capital on a board-facing screen, and a number that
   * cannot say where it came from is one nobody can defend six months later.
   */
  changeReason: string;
  sourceDocument?: string | null;
}

export interface FundDistributionInput {
  fundId: number;
  distributionDate: string;
  /** DOLLARS. */
  amount: string;
  companyLabel: string;
  companyId?: string | null;
  note?: string | null;
}

/**
 * One mutation. `update` carries the complete row rather than a patch: the form
 * submits every field anyway, and a patch cannot distinguish "leave this alone"
 * from "clear this", which on a financial row is not a distinction to guess at.
 */
export type FinancialMutation = { reason?: string | null } & (
  | { table: 'transaction'; op: 'create'; values: TransactionInput }
  | { table: 'transaction'; op: 'update'; id: string; values: TransactionInput }
  | { table: 'valuation_mark'; op: 'create'; values: ValuationMarkInput }
  | { table: 'valuation_mark'; op: 'update'; id: string; values: ValuationMarkInput }
  | { table: 'fund_investment_nav'; op: 'create'; values: LpNavInput }
  | { table: 'fund_investment_nav'; op: 'update'; id: string; values: LpNavInput }
  | { table: 'fund_distribution'; op: 'create'; values: FundDistributionInput }
  | { table: 'fund_distribution'; op: 'update'; id: string; values: FundDistributionInput }
  | { table: 'fund_commitment'; op: 'create'; values: FundCommitmentInput }
  | { table: 'fund_commitment'; op: 'update'; id: string; values: FundCommitmentInput }
  | { table: FinancialTable; op: 'delete'; id: string }
  | { table: FinancialTable; op: 'restore'; id: string }
);

export interface FinancialWriteResult {
  id: string;
  /** True when the change moved a figure inside an already-issued period. */
  restated: boolean;
  /**
   * ADR-034. On a review, what the server actually computed and stored, echoed
   * back so the screen reports the figure that landed rather than the one it
   * predicted. The two agree; showing the stored one is what makes that
   * checkable rather than assumed.
   */
  mark?: {
    fmv: string;
    basisFmv: string;
    /** Null when the basis was cost rather than an earlier mark (ADR-007). */
    basisMarkId: string | null;
    retentionFactor: string;
  };
  /**
   * ADR-037 clause 5. Set when the write leaves an LP position drawn beyond the
   * commitment in force.
   *
   * A WARNING ON A SUCCESSFUL WRITE, never a refusal, and the distinction is
   * the whole clause. It is a real state of real data -- a recallable
   * distribution redrawn, a late amendment, a GP notice keyed before the side
   * letter arrives -- and the same principle the codebase already applies to a
   * round total below our own cheque: pushing somebody into fudging a figure to
   * get past a form is worse than the figure being wrong and visible.
   *
   * Absent means either not overdrawn or not an LP row. It never means refused.
   */
  overdrawn?: {
    fundInvestmentId: string;
    /** DOLLARS, or null when no commitment is on record for this position. */
    committed: string | null;
    /** DOLLARS drawn to date, after this write. */
    drawn: string;
  };
}

// --- validation -------------------------------------------------------------
// The primitives are in `session.ts`. What stays here is table-specific: the
// messages below are read by the Director of Finance in a form, not by a
// developer in a stack trace, so they say what to do rather than which
// constraint failed.

/**
 * The five `transaction` check constraints, restated in TypeScript.
 *
 * Postgres enforces these regardless; catching them here is about the message.
 * "txn_direct_types" tells a developer what happened. "A capital drawdown
 * belongs to a fund position, not a company" tells Finance what to fix.
 */
function validateTransaction(v: TransactionInput): void {
  if (!(TXN_TYPES as readonly string[]).includes(v.txnType)) {
    throw new ValidationError(`"txnType" must be one of ${TXN_TYPES.join(', ')}.`);
  }
  const isDirect = (DIRECT_TYPES as readonly string[]).includes(v.txnType);
  const hasCompany = !!v.companyId;
  const hasFund = !!v.fundInvestmentId;

  if (hasCompany === hasFund) {
    throw new ValidationError(
      'A transaction belongs to exactly one subject: set either "companyId" or "fundInvestmentId", not both and not neither.',
    );
  }
  if (isDirect && !hasCompany) {
    throw new ValidationError(`A ${v.txnType.replace('_', ' ')} is a direct investment and needs a "companyId".`);
  }
  if (!isDirect && !hasFund) {
    throw new ValidationError(
      `A ${v.txnType.replace('_', ' ')} belongs to a fund position, not a company; set "fundInvestmentId".`,
    );
  }
  const currency = v.currency ?? 'CAD';
  if (currency !== 'CAD' && !v.fxRateToCad) {
    throw new ValidationError(
      `A transaction in ${currency} needs "fxRateToCad" — the rate at the transaction date, not today's (ADR-021).`,
    );
  }
  if (currency === 'CAD' && v.fxRateToCad) {
    throw new ValidationError('"fxRateToCad" must be empty for a CAD transaction.');
  }
  if (v.instrumentId && !hasCompany) {
    throw new ValidationError(
      `A ${v.txnType.replace('_', ' ')} is LP activity and did not buy an instrument; leave "instrumentId" empty.`,
    );
  }
}

/** The stored effective date of an existing row, or null if there is no such row. */
async function existingDate(
  trx: Kysely<DB>,
  table: FinancialTable,
  id: string,
): Promise<string | null> {
  const meta = TABLES[table];
  const { rows } = await sql<{ d: string | null }>`
    select ${sql.ref(meta.date)}::text as d
      from ${sql.table(`pc.${table}`)}
     where ${sql.ref(meta.key)} = ${id}::bigint
  `.execute(trx);
  if (rows.length === 0) throw new ValidationError(`No ${meta.label} with id ${id}.`);
  return rows[0]?.d ?? null;
}

// --- the entry point --------------------------------------------------------

/**
 * Applies one financial mutation.
 *
 * Everything happens in one transaction so the row change, its version record
 * and the restatement flag land together or not at all. The version record is
 * written by the trigger inside this same transaction, which is why the session
 * context has to be set first.
 */
export async function applyFinancialMutation(
  db: Kysely<DB>,
  principal: Principal,
  mutation: FinancialMutation,
): Promise<FinancialWriteResult> {
  requireRole(principal, CAN_WRITE_FINANCIAL);

  if (!(mutation.table in TABLES)) {
    throw new ValidationError(
      `"table" must be one of ${Object.keys(TABLES).join(', ')}. ` +
        'Judgement records — health, flags, milestones, memos, gates — are edited through /api/v1/judgement instead.',
    );
  }

  const reason = mutation.reason?.trim() || null;

  return db.transaction().execute(async (trx) => {
    await setSessionContext(trx, principal, reason);

    switch (mutation.op) {
      case 'delete':
      case 'restore':
        return softDelete(trx, principal, mutation.table, mutation.id, mutation.op, reason);
      case 'create':
      case 'update':
        break;
    }

    switch (mutation.table) {
      case 'transaction':
        return writeTransaction(trx, principal, mutation, reason);
      case 'valuation_mark':
        return writeValuationMark(trx, principal, mutation, reason);
      case 'fund_investment_nav':
        return writeLpNav(trx, principal, mutation, reason);
      case 'fund_distribution':
        return writeFundDistribution(trx, principal, mutation, reason);
      case 'fund_commitment':
        return writeFundCommitment(trx, principal, mutation, reason);
    }
  });
}

/**
 * ADR-037 clause 5. Is this position drawn beyond the commitment in force?
 *
 * Asked AFTER the write and inside the same transaction, so it reports the
 * state the caller has just created rather than the one they were about to.
 * `current_date` on both halves, matching `v_lp_position_current` exactly --
 * a warning that disagreed with the screen it sends somebody to would be
 * worse than no warning.
 *
 * No commitment on record is reported rather than swallowed: drawing against a
 * position nobody has recorded a commitment for is a gap worth seeing, and it
 * is precisely the state the backfill guaranteed does not exist today.
 */
async function checkOverdraw(
  trx: Kysely<DB>,
  fundInvestmentId: string,
): Promise<FinancialWriteResult['overdrawn']> {
  const { rows } = await sql<{ committed: string | null; drawn: string }>`
    select pc.fund_committed_asof(${fundInvestmentId}, current_date)::text as committed,
           coalesce((select sum(t.amount_cad) from pc.v_transaction_live t
                      where t.fund_investment_id = ${fundInvestmentId}
                        and t.txn_type = 'capital_drawdown'), 0)::text     as drawn
  `.execute(trx);

  const row = rows[0];
  if (!row) return undefined;
  if (row.committed !== null && Number(row.drawn) <= Number(row.committed)) return undefined;
  return { fundInvestmentId, committed: row.committed, drawn: row.drawn };
}

/**
 * A commitment level, as at a date (F5, ADR-037 clause 1).
 *
 * UPSERTED ON (position, date), which the schema makes unique. Two entries at
 * one date are one restated fact, not two commitments -- the same reading F3
 * took of an ownership position, and `deleted_at` is cleared for the same
 * reason recorded there: the index does not exclude soft-deleted rows, so
 * without it an entry at a deleted row's date would write into a row invisible
 * to every read.
 *
 * `op: 'update'` addresses a row by id and can therefore MOVE its date, which
 * is why both dates go to `checkRestatement` -- correcting a commitment from 31
 * March to 30 April touches two periods, and only one of them is submitted.
 */
async function writeFundCommitment(
  trx: Kysely<DB>,
  principal: Principal,
  m: Extract<FinancialMutation, { table: 'fund_commitment'; op: 'create' | 'update' }>,
  reason: string | null,
): Promise<FinancialWriteResult> {
  const v = m.values;
  const fundInvestmentId = text(v.fundInvestmentId, 'fundInvestmentId');
  const asOfDate = date(v.asOfDate, 'asOfDate');
  // Zero allowed: a commitment released to nil is a decision somebody took, and
  // it is not the same fact as no row at all.
  const committed = money(v.committed, 'committed', true);

  const changeReason = v.changeReason?.trim() ?? '';
  if (changeReason.length < 3) {
    throw new ValidationError(
      'A commitment must say what set it — the subscription, a second close, a side letter, an ' +
        'amended LPA. This figure is the denominator of unfunded capital on a board-facing screen, ' +
        'and a number with no explanation is one nobody can defend later.',
    );
  }

  const { rows: position } = await sql<{ id: string }>`
    select fund_investment_id as id from pc.fund_investment
     where fund_investment_id = ${fundInvestmentId}
  `.execute(trx);
  if (position.length === 0) throw new ValidationError(`No fund position ${fundInvestmentId}.`);

  const dates: (string | null)[] = [asOfDate];
  if (m.op === 'update') dates.push(await existingDate(trx, 'fund_commitment', m.id));
  const restated = await checkRestatement(trx, dates, reason, 'capital commitment');

  let id: string;
  if (m.op === 'create') {
    const { rows } = await sql<{ id: string }>`
      insert into pc.fund_commitment
        (fund_investment_id, as_of_date, committed, change_reason, source_document, entered_by)
      values (${fundInvestmentId}, ${asOfDate}::date, ${committed}::numeric,
              ${changeReason}, ${optional(v.sourceDocument)}, ${principal.userId}::uuid)
      on conflict (fund_investment_id, as_of_date) do update
         set committed       = excluded.committed,
             change_reason   = excluded.change_reason,
             source_document = excluded.source_document,
             entered_by      = excluded.entered_by,
             deleted_at      = null,
             deleted_by      = null,
             deleted_reason  = null
      returning fund_commitment_id::text as id
    `.execute(trx);
    id = rows[0]!.id;
  } else {
    const { rows } = await sql<{ id: string }>`
      update pc.fund_commitment
         set fund_investment_id = ${fundInvestmentId},
             as_of_date         = ${asOfDate}::date,
             committed          = ${committed}::numeric,
             change_reason      = ${changeReason},
             source_document    = ${optional(v.sourceDocument)}
       where fund_commitment_id = ${m.id}::bigint
      returning fund_commitment_id::text as id
    `.execute(trx);
    if (rows.length === 0) throw new ValidationError(`No capital commitment with id ${m.id}.`);
    id = rows[0]!.id;
  }

  const overdrawn = await checkOverdraw(trx, fundInvestmentId);
  return { id, restated, ...(overdrawn ? { overdrawn } : {}) };
}

/**
 * Soft delete and its inverse, for all four tables.
 *
 * ADR-031 clause 6. The row leaves every view and every total and stays
 * retrievable. A reason is required on delete regardless of period -- unlike an
 * edit, where the field values themselves record what changed, a deletion's
 * entire content is the fact that someone removed it.
 */
async function softDelete(
  trx: Kysely<DB>,
  principal: Principal,
  table: FinancialTable,
  id: string,
  op: 'delete' | 'restore',
  reason: string | null,
): Promise<FinancialWriteResult> {
  const meta = TABLES[table];
  if (op === 'delete' && !reason) {
    throw new ValidationError(`Deleting a ${meta.label} requires a reason.`);
  }

  const when = await existingDate(trx, table, id);
  const restated = await checkRestatement(trx, [when], reason, meta.label);

  const { rows } = await sql<{ id: string }>`
    update ${sql.table(`pc.${table}`)}
       set deleted_at     = ${op === 'delete' ? sql`clock_timestamp()` : sql`null`},
           deleted_by     = ${op === 'delete' ? sql`${principal.userId}::uuid` : sql`null`},
           deleted_reason = ${op === 'delete' ? reason : null}
     where ${sql.ref(meta.key)} = ${id}::bigint
       and deleted_at is ${op === 'delete' ? sql`null` : sql`not null`}
    returning ${sql.ref(meta.key)}::text as id
  `.execute(trx);

  if (rows.length === 0) {
    throw new ValidationError(
      op === 'delete'
        ? `That ${meta.label} is already deleted.`
        : `That ${meta.label} is not deleted, so there is nothing to restore.`,
    );
  }
  return { id, restated };
}

async function writeTransaction(
  trx: Kysely<DB>,
  principal: Principal,
  m: Extract<FinancialMutation, { table: 'transaction'; op: 'create' | 'update' }>,
  reason: string | null,
): Promise<FinancialWriteResult> {
  const v = m.values;
  validateTransaction(v);
  const txnDate = date(v.txnDate, 'txnDate');
  const amount = money(v.amount, 'amount');
  const currency = v.currency ?? 'CAD';

  const dates: (string | null)[] = [txnDate];
  if (m.op === 'update') dates.push(await existingDate(trx, 'transaction', m.id));
  const restated = await checkRestatement(trx, dates, reason, 'transaction');

  const cols = {
    txn_date: txnDate,
    txn_type: v.txnType,
    company_id: optional(v.companyId),
    fund_investment_id: optional(v.fundInvestmentId),
    investment_round_id: v.investmentRoundId ? BigInt(v.investmentRoundId) : null,
    investment_vehicle_id: optional(v.investmentVehicleId),
    instrument_id: optional(v.instrumentId),
    amount,
    currency,
    fx_rate_to_cad: optional(v.fxRateToCad),
    source_document: optional(v.sourceDocument),
    note: optional(v.note),
  };

  let id: string;
  if (m.op === 'create') {
    const row = await trx
      .insertInto('transaction')
      // `entered_by` records who first keyed the row and is never rewritten by
      // an edit; who changed it afterwards is the version log's job.
      .values({ ...cols, entered_by: principal.userId } as never)
      .returning('transaction_id')
      .executeTakeFirstOrThrow();
    id = String(row.transaction_id);
  } else {
    const row = await trx
      .updateTable('transaction')
      .set(cols as never)
      .where('transaction_id', '=', BigInt(m.id) as never)
      .returning('transaction_id')
      .executeTakeFirst();
    if (!row) throw new ValidationError(`No transaction with id ${m.id}.`);
    id = String(row.transaction_id);
  }

  /* ADR-037 clause 5. Checked on every LP row rather than only on a drawdown,
     because an edit that retypes a fee AS a drawdown is exactly the write that
     can tip a position over and it does not arrive typed as one. Reported, not
     refused: the clause is explicit that this is a real state of real data. */
  if (v.fundInvestmentId) {
    const overdrawn = await checkOverdraw(trx, v.fundInvestmentId);
    if (overdrawn) return { id, restated, overdrawn };
  }
  return { id, restated };
}

/**
 * The carrying value a review is applied to, and the mark it came from.
 *
 * THIS IS `company_fmv_asof` RESTATED IN TYPESCRIPT, and the duplication is
 * deliberate rather than an oversight: the function returns a number and this
 * needs the mark's IDENTITY as well, because `basis_mark_id` is half of what
 * ADR-034 clause 3 stores. The ordering below is the function's, term for term
 * -- INCLUDING the `valuation_mark_id desc` tiebreak migration 0009 added -- so
 * that the basis a review records and the FMV every metric reads can never be
 * two different marks.
 *
 * THE COST FALLBACK IS NOT AN EDGE CASE. ADR-007 holds a company with no mark
 * at cost, so cost IS its carrying value, and the first review of a company
 * between its first cheque and its first formal mark is an ordinary thing to
 * run. It returns a basis with no basis row, which the schema permits
 * explicitly.
 *
 * `p_as_of` is the NEW mark's effective date, not today: a review dated 31
 * January is applied to what the position was worth on 31 January, and running
 * the exercise in March must not silently pick up a February mark.
 */
async function resolveBasis(
  trx: Kysely<DB>,
  companyId: string,
  effectiveDate: string,
  excludeMarkId: string | null,
): Promise<{ basisMarkId: string | null; basisFmv: string }> {
  const { rows } = await sql<{ id: string; fmv: string }>`
    select vm.valuation_mark_id::text as id, vm.fmv::text as fmv
      from pc.valuation_mark vm
     where vm.company_id = ${companyId}
       and vm.status = 'final'
       and vm.deleted_at is null
       and vm.effective_date <= ${effectiveDate}::date
       and (${excludeMarkId}::bigint is null or vm.valuation_mark_id <> ${excludeMarkId}::bigint)
     order by vm.effective_date desc, vm.booked_at desc, vm.valuation_mark_id desc
     limit 1
  `.execute(trx);

  if (rows.length > 0) {
    return { basisMarkId: rows[0]!.id, basisFmv: rows[0]!.fmv };
  }

  const { rows: cost } = await sql<{ cost: string }>`
    select coalesce(sum(t.amount_cad), 0)::numeric(18,2)::text as cost
      from pc.v_transaction_live t
     where t.company_id = ${companyId}
       and t.txn_type in ('investment','follow_on')
       and t.txn_date <= ${effectiveDate}::date
  `.execute(trx);

  return { basisMarkId: null, basisFmv: cost[0]?.cost ?? '0.00' };
}

/**
 * The retention factor, checked against the list as it stands right now.
 *
 * AGAINST THE ACTIVE ROWS, NOT A CONSTANT. `ref_fmv_retention_option` is a
 * table precisely so Finance can add or retire an option without a migration
 * (ADR-034 clause 4), which means a hardcoded list here would be wrong the
 * first time they use that ability -- and wrong in the direction that refuses
 * a choice the platform itself offered.
 *
 * Marks already written under a since-retired factor are untouched: there is no
 * foreign key, and reconstructing an issued board pack must not depend on the
 * option list still containing what it contained then.
 */
async function validateRetentionFactor(trx: Kysely<DB>, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !/^\d(\.\d{1,4})?$/.test(value)) {
    throw new ValidationError(
      '"retentionFactor" must be the retained proportion as a decimal factor — "0.75" means the position is carried at 75% of its previous value, a 25% impairment. Got ' +
        `${JSON.stringify(value)}.`,
    );
  }

  const { rows } = await sql<{ factor: string; label: string }>`
    select factor::text as factor, label
      from pc.ref_fmv_retention_option
     where is_active
     order by sort_order, fmv_retention_option_id
  `.execute(trx);

  const match = rows.find((r) => Number(r.factor) === Number(value));
  if (!match) {
    throw new ValidationError(
      `"${value}" is not one of the retention options Finance has approved. ` +
        `The active list is: ${rows.map((r) => r.factor).join(', ')}. ` +
        'Options are maintained on the Policies surface, not in code.',
    );
  }
  // Normalised to the stored scale so the row matches the reference row it was
  // chosen from, rather than carrying whatever precision the client sent.
  return match.factor;
}

async function writeValuationMark(
  trx: Kysely<DB>,
  principal: Principal,
  m: Extract<FinancialMutation, { table: 'valuation_mark'; op: 'create' | 'update' }>,
  reason: string | null,
): Promise<FinancialWriteResult> {
  const v = m.values;
  const effectiveDate = date(v.effectiveDate, 'effectiveDate');
  const rationale = text(v.rationale, 'rationale');
  const methodLabel = text(v.methodLabel, 'methodLabel');
  const companyId = text(v.companyId, 'companyId');

  /**
   * ADR-034 clause 7. Absent means `manual`, the free-entry absolute path that
   * existed before F2 -- so every existing caller, the fixture importer and
   * A13's backfill included, keeps working without naming a type.
   */
  const adjustmentType: MarkAdjustmentType = v.adjustmentType ?? 'manual';
  if (adjustmentType !== 'review' && adjustmentType !== 'manual') {
    throw new ValidationError(
      `"adjustmentType" must be "review" or "manual". The other values in the schema's vocabulary — initial, transaction, round_reprice, realization, write_off — are declared for later phases and no write path produces them yet.`,
    );
  }
  const isReview = adjustmentType === 'review';

  const dates: (string | null)[] = [effectiveDate];
  if (m.op === 'update') dates.push(await existingDate(trx, 'valuation_mark', m.id));
  const restated = await checkRestatement(trx, dates, reason, 'valuation mark');

  /**
   * Migration 0009 constrains ONE REVIEW per company per date; everything else
   * may repeat, because two cheques on one day are two facts (S-3). Caught here
   * so the message names the clash rather than the index.
   *
   * The predicate matches the index term for term, `adjustment_type` and
   * `deleted_at` included. When the two disagree the user gets a constraint
   * error they cannot act on -- which is exactly what the pre-F2 pair did,
   * since the old index did not exclude soft-deleted rows and this check did.
   */
  if (isReview) {
    const { rows: clash } = await sql<{ id: string }>`
      select valuation_mark_id::text as id
        from pc.valuation_mark
       where company_id = ${companyId} and effective_date = ${effectiveDate}::date
         and status = 'final' and adjustment_type = 'review' and deleted_at is null
         and (${m.op === 'update' ? m.id : null}::bigint is null
              or valuation_mark_id <> ${m.op === 'update' ? m.id : null}::bigint)
    `.execute(trx);
    if (clash.length > 0) {
      throw new ValidationError(
        `${companyId} has already been reviewed at ${effectiveDate}. Edit that review rather than adding a second one — a review is the semi-annual exercise, and it happens once per company per cycle.`,
      );
    }
  }

  /**
   * THE REVIEW PATH. The server resolves the basis, stores it, and computes the
   * result; the client supplies the factor and nothing else about the figure.
   *
   * `fmv` IS REFUSED RATHER THAN IGNORED (ADR-034 clause 2). Silently
   * discarding it would let a client believe it had set a figure that the
   * server overwrote, and the disagreement would surface much later as a board
   * number nobody could account for. Refusing makes the contract legible at the
   * point of the mistake.
   */
  let fmv: string;
  let basisMarkId: string | null = null;
  let basisFmv: string | null = null;
  let retentionFactor: string | null = null;

  if (isReview) {
    if (v.fmv !== undefined && v.fmv !== null && v.fmv !== '') {
      throw new ValidationError(
        'A review computes its own FMV from the previous value and the retention factor, so "fmv" must not be sent with it. Use adjustmentType "manual" to enter an absolute figure directly.',
      );
    }
    retentionFactor = await validateRetentionFactor(trx, v.retentionFactor);

    const basis = await resolveBasis(
      trx,
      companyId,
      effectiveDate,
      m.op === 'update' ? m.id : null,
    );
    basisMarkId = basis.basisMarkId;
    basisFmv = basis.basisFmv;

    /**
     * The arithmetic, in `numeric` rather than in JavaScript.
     *
     * ADR-008 keeps money as strings end to end precisely so it never becomes a
     * double, and `basis x factor` is the one place in this module that has to
     * multiply two of them. Doing it in Postgres keeps the value exact and
     * rounds it the same way every other stored figure is rounded; doing it
     * here would put a float in the middle of the only computed board number in
     * the schema.
     */
    const { rows: computed } = await sql<{ fmv: string }>`
      select round(${basisFmv}::numeric * ${retentionFactor}::numeric, 2)::text as fmv
    `.execute(trx);
    fmv = computed[0]!.fmv;
  } else {
    if (v.retentionFactor !== undefined && v.retentionFactor !== null && v.retentionFactor !== '') {
      throw new ValidationError(
        'A retention factor only means something on a review, where it is applied to the previous value. Set "adjustmentType" to "review", or leave the factor out.',
      );
    }
    // Zero is allowed: a mark of nil is how a write-off is recorded (ADR-007).
    fmv = money(v.fmv, 'fmv', true);
  }

  const cols = {
    company_id: companyId,
    effective_date: effectiveDate,
    fmv,
    adjustment_type: adjustmentType,
    basis_mark_id: basisMarkId === null ? null : BigInt(basisMarkId),
    basis_fmv: basisFmv,
    retention_factor: retentionFactor,
    valuation_method_id: optional(v.valuationMethodId),
    method_label: methodLabel,
    rationale,
    source_document: optional(v.sourceDocument),
  };

  // Echoed back only on a review, because it is only there that the stored
  // figure is one the caller did not send and therefore cannot assume.
  const mark = isReview
    ? { fmv, basisFmv: basisFmv!, basisMarkId, retentionFactor: retentionFactor! }
    : undefined;

  if (m.op === 'create') {
    const row = await trx
      .insertInto('valuation_mark')
      // ADR-007: entry by the Director of Finance IS the sign-off, so the
      // preparer is the caller and is not a free-text field they can set.
      .values({
        ...cols,
        prepared_by: principal.userId,
        prepared_by_label: principal.displayName,
      } as never)
      .returning('valuation_mark_id')
      .executeTakeFirstOrThrow();
    return { id: String(row.valuation_mark_id), restated, ...(mark ? { mark } : {}) };
  }

  const row = await trx
    .updateTable('valuation_mark')
    .set(cols as never)
    .where('valuation_mark_id', '=', BigInt(m.id) as never)
    .returning('valuation_mark_id')
    .executeTakeFirst();
  if (!row) throw new ValidationError(`No valuation mark with id ${m.id}.`);
  return { id: String(row.valuation_mark_id), restated, ...(mark ? { mark } : {}) };
}

async function writeLpNav(
  trx: Kysely<DB>,
  principal: Principal,
  m: Extract<FinancialMutation, { table: 'fund_investment_nav'; op: 'create' | 'update' }>,
  reason: string | null,
): Promise<FinancialWriteResult> {
  const v = m.values;
  const asOfDate = date(v.asOfDate, 'asOfDate');
  const nav = money(v.nav, 'nav', true);
  const fundInvestmentId = text(v.fundInvestmentId, 'fundInvestmentId');

  const dates: (string | null)[] = [asOfDate];
  if (m.op === 'update') dates.push(await existingDate(trx, 'fund_investment_nav', m.id));
  const restated = await checkRestatement(trx, dates, reason, 'LP NAV statement');

  const cols = {
    fund_investment_id: fundInvestmentId,
    as_of_date: asOfDate,
    nav,
    statement_received_at: v.statementReceivedAt
      ? date(v.statementReceivedAt, 'statementReceivedAt')
      : null,
    source_document: optional(v.sourceDocument),
  };

  if (m.op === 'create') {
    const row = await trx
      .insertInto('fund_investment_nav')
      .values({ ...cols, entered_by: principal.userId } as never)
      .returning('fund_investment_nav_id')
      .executeTakeFirstOrThrow();
    return { id: String(row.fund_investment_nav_id), restated };
  }

  const row = await trx
    .updateTable('fund_investment_nav')
    .set(cols as never)
    .where('fund_investment_nav_id', '=', BigInt(m.id) as never)
    .returning('fund_investment_nav_id')
    .executeTakeFirst();
  if (!row) throw new ValidationError(`No LP NAV statement with id ${m.id}.`);
  return { id: String(row.fund_investment_nav_id), restated };
}

async function writeFundDistribution(
  trx: Kysely<DB>,
  principal: Principal,
  m: Extract<FinancialMutation, { table: 'fund_distribution'; op: 'create' | 'update' }>,
  reason: string | null,
): Promise<FinancialWriteResult> {
  const v = m.values;
  const distributionDate = date(v.distributionDate, 'distributionDate');
  const amount = money(v.amount, 'amount');
  // Verbatim, per ADR-026: this string may name a company the platform does not
  // hold, and that is a legitimate state for a historical fund-level
  // realization rather than an import error.
  const companyLabel = text(v.companyLabel, 'companyLabel');

  const dates: (string | null)[] = [distributionDate];
  if (m.op === 'update') dates.push(await existingDate(trx, 'fund_distribution', m.id));
  const restated = await checkRestatement(trx, dates, reason, 'fund distribution');

  const cols = {
    fund_id: v.fundId,
    distribution_date: distributionDate,
    amount,
    company_label: companyLabel,
    company_id: optional(v.companyId),
    note: optional(v.note),
  };

  if (m.op === 'create') {
    const row = await trx
      .insertInto('fund_distribution')
      .values({ ...cols, entered_by: principal.userId } as never)
      .returning('fund_distribution_id')
      .executeTakeFirstOrThrow();
    return { id: String(row.fund_distribution_id), restated };
  }

  const row = await trx
    .updateTable('fund_distribution')
    .set(cols as never)
    .where('fund_distribution_id', '=', BigInt(m.id) as never)
    .returning('fund_distribution_id')
    .executeTakeFirst();
  if (!row) throw new ValidationError(`No fund distribution with id ${m.id}.`);
  return { id: String(row.fund_distribution_id), restated };
}
