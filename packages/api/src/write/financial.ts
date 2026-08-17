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
  | 'fund_distribution';

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
  fund_distribution: { key: 'fund_distribution_id', date: 'distribution_date', label: 'LP distribution' },
} as const satisfies Record<FinancialTable, { key: string; date: string; label: string }>;

const TXN_TYPES = [
  'investment', 'follow_on', 'realization', 'write_off',
  'capital_call', 'distribution', 'fee',
] as const;
const DIRECT_TYPES = ['investment', 'follow_on', 'realization', 'write_off'] as const;

export interface TransactionInput {
  txnDate: string;
  txnType: (typeof TXN_TYPES)[number];
  companyId?: string | null;
  fundInvestmentId?: string | null;
  investmentRoundId?: string | null;
  investmentVehicleId?: number | null;
  /** DOLLARS, as typed. Always positive; direction is implied by `txnType`. */
  amount: string;
  currency?: string;
  fxRateToCad?: string | null;
  sourceDocument?: string | null;
  note?: string | null;
}

export interface ValuationMarkInput {
  companyId: string;
  effectiveDate: string;
  /** DOLLARS. Zero is legitimate -- it is how a write-off is marked. */
  fmv: string;
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
  | { table: FinancialTable; op: 'delete'; id: string }
  | { table: FinancialTable; op: 'restore'; id: string }
);

export interface FinancialWriteResult {
  id: string;
  /** True when the change moved a figure inside an already-issued period. */
  restated: boolean;
}

// --- validation -------------------------------------------------------------
// The primitives are in `session.ts`. What stays here is table-specific: the
// messages below are read by the Director of Finance in a form, not by a
// developer in a stack trace, so they say what to do rather than which
// constraint failed.

/**
 * The four `transaction` check constraints, restated in TypeScript.
 *
 * Postgres enforces these regardless; catching them here is about the message.
 * "txn_direct_types" tells a developer what happened. "A capital call belongs to
 * a fund position, not a company" tells Finance what to fix.
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
    }
  });
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
    amount,
    currency,
    fx_rate_to_cad: optional(v.fxRateToCad),
    source_document: optional(v.sourceDocument),
    note: optional(v.note),
  };

  if (m.op === 'create') {
    const row = await trx
      .insertInto('transaction')
      // `entered_by` records who first keyed the row and is never rewritten by
      // an edit; who changed it afterwards is the version log's job.
      .values({ ...cols, entered_by: principal.userId } as never)
      .returning('transaction_id')
      .executeTakeFirstOrThrow();
    return { id: String(row.transaction_id), restated };
  }

  const row = await trx
    .updateTable('transaction')
    .set(cols as never)
    .where('transaction_id', '=', BigInt(m.id) as never)
    .returning('transaction_id')
    .executeTakeFirst();
  if (!row) throw new ValidationError(`No transaction with id ${m.id}.`);
  return { id: String(row.transaction_id), restated };
}

async function writeValuationMark(
  trx: Kysely<DB>,
  principal: Principal,
  m: Extract<FinancialMutation, { table: 'valuation_mark'; op: 'create' | 'update' }>,
  reason: string | null,
): Promise<FinancialWriteResult> {
  const v = m.values;
  const effectiveDate = date(v.effectiveDate, 'effectiveDate');
  // Zero is allowed: a mark of nil is how a write-off is recorded (ADR-007).
  const fmv = money(v.fmv, 'fmv', true);
  const rationale = text(v.rationale, 'rationale');
  const methodLabel = text(v.methodLabel, 'methodLabel');
  const companyId = text(v.companyId, 'companyId');

  const dates: (string | null)[] = [effectiveDate];
  if (m.op === 'update') dates.push(await existingDate(trx, 'valuation_mark', m.id));
  const restated = await checkRestatement(trx, dates, reason, 'valuation mark');

  // The schema allows one final mark per company per date. Caught here so the
  // message names the clash rather than the index.
  const { rows: clash } = await sql<{ id: string }>`
    select valuation_mark_id::text as id
      from pc.valuation_mark
     where company_id = ${companyId} and effective_date = ${effectiveDate}::date
       and status = 'final' and deleted_at is null
       and (${m.op === 'update' ? m.id : null}::bigint is null
            or valuation_mark_id <> ${m.op === 'update' ? m.id : null}::bigint)
  `.execute(trx);
  if (clash.length > 0) {
    throw new ValidationError(
      `${companyId} already has a final mark at ${effectiveDate}. Edit that mark rather than adding a second one.`,
    );
  }

  const cols = {
    company_id: companyId,
    effective_date: effectiveDate,
    fmv,
    valuation_method_id: optional(v.valuationMethodId),
    method_label: methodLabel,
    rationale,
    source_document: optional(v.sourceDocument),
  };

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
    return { id: String(row.valuation_mark_id), restated };
  }

  const row = await trx
    .updateTable('valuation_mark')
    .set(cols as never)
    .where('valuation_mark_id', '=', BigInt(m.id) as never)
    .returning('valuation_mark_id')
    .executeTakeFirst();
  if (!row) throw new ValidationError(`No valuation mark with id ${m.id}.`);
  return { id: String(row.valuation_mark_id), restated };
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
  const restated = await checkRestatement(trx, dates, reason, 'LP distribution');

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
  if (!row) throw new ValidationError(`No LP distribution with id ${m.id}.`);
  return { id: String(row.fund_distribution_id), restated };
}
