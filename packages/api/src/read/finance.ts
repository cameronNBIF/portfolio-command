/**
 * The read path behind the Finance tab (A7).
 *
 * Three things the entry interfaces need and the ADR-001 export does not: the
 * financial tables as editable rows rather than as contract aggregates, running
 * totals that agree with what is on screen, and the change history for one row.
 *
 * SEPARATE FROM `export.ts` ON PURPOSE. That module builds the frozen contract
 * and must keep building exactly that. This one serves a working screen whose
 * shape will change as Finance uses it, and the two should not be able to drag
 * each other around. In particular the totals here are net of soft-deleted rows
 * and stated in DOLLARS, matching `write/financial.ts` and the database rather
 * than the contract's `$M`.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_READ, type Principal, requireRole } from '../auth/principal.js';
import { ValidationError } from '../write/errors.js';

/**
 * The tables a history request may name, and the key each is addressed by.
 *
 * `table` arrives from a query string and is interpolated as an identifier, so
 * it is checked against this map before it reaches `sql.table`. Kysely quotes
 * identifiers, which makes injection hard rather than impossible; an allow-list
 * makes it absent.
 */
const HISTORY_TABLES: Record<string, string> = {
  transaction: 'transaction_id',
  valuation_mark: 'valuation_mark_id',
  fund_investment_nav: 'fund_investment_nav_id',
  fund_distribution: 'fund_distribution_id',
  investment_round: 'investment_round_id',
  company_ownership: 'company_ownership_id',
  // Joined the versioned set in migration 0003, when the ADR-012 capture form
  // gave it a write path. Listed here so the History panel serves a corrected
  // co-investor amount the same way it serves a corrected cheque.
  round_coinvestor: 'round_coinvestor_id',
};

export interface TransactionRow {
  id: string;
  txnDate: string;
  txnType: string;
  companyId: string | null;
  companyName: string | null;
  fundInvestmentId: string | null;
  fundName: string | null;
  amount: string;
  currency: string;
  fxRateToCad: string | null;
  amountCad: string;
  investmentRoundId: string | null;
  /**
   * F1. The round's own label and date, so the picker and the table can name
   * the round rather than showing a bare id.
   *
   * The A7 screen printed "Linked to round #142", which is an id the user has
   * no way to resolve without opening another tab. Both null when the cheque is
   * unattached.
   */
  roundLabel: string | null;
  roundDate: string | null;
  /**
   * ADR-033 clause 4. Set when someone confirmed this cheque correctly has no
   * round, as opposed to nobody having looked at it yet.
   *
   * Null against a null `investmentRoundId` is the state F6's unlinked-cheque
   * check counts; a timestamp there is what lets that count reach zero.
   */
  standaloneConfirmedAt: string | null;
  standaloneConfirmedByName: string | null;
  investmentVehicleId: number | null;
  vehicleName: string | null;
  /**
   * F0. What this cheque bought, as distinct from what the round was
   * denominated in. Null is "unrecorded", never a default — the ADR-030
   * precedent, and the same reading as `investmentVehicleId` above.
   */
  instrumentId: number | null;
  instrumentName: string | null;
  sourceDocument: string | null;
  note: string | null;
  isSynthetic: boolean;
  /** Set means soft-deleted: out of every total, still on screen if asked for. */
  deletedAt: string | null;
  deletedReason: string | null;
  /** True once the row has been edited at least once since it was entered. */
  edited: boolean;
  enteredByName: string | null;
  rowCreatedAt: string;
  rowUpdatedAt: string;
}

export interface TransactionFilters {
  companyId?: string | null;
  fundInvestmentId?: string | null;
  txnType?: string | null;
  from?: string | null;
  to?: string | null;
  /** Default false. Deleted rows stay out of the way until asked for. */
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface TransactionPage {
  rows: TransactionRow[];
  /** Rows matching the filter, ignoring paging. */
  total: number;
  /**
   * Running totals over the WHOLE filtered set, not the current page, and
   * always net of deleted rows even when deleted rows are being displayed.
   * Dollars.
   */
  totals: { invested: string; realized: string; net: string };
}

/**
 * The transaction table, filtered and paged.
 *
 * Reads the base table rather than `v_transaction_live`, because Finance needs
 * to see and act on rows the live view exists to hide — a voided row, a
 * reversing row, a deleted row. The aggregates below re-apply the live
 * predicate themselves so the totals still agree with every other screen.
 */
export async function readTransactions(
  db: Kysely<DB>,
  principal: Principal,
  filters: TransactionFilters = {},
): Promise<TransactionPage> {
  requireRole(principal, CAN_READ);

  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  // One predicate, built once and used by the page query, the count and the
  // totals, so the three can never describe different sets.
  const where = sql`
    (${filters.companyId ?? null}::text is null or t.company_id = ${filters.companyId ?? null})
    and (${filters.fundInvestmentId ?? null}::text is null or t.fund_investment_id = ${filters.fundInvestmentId ?? null})
    and (${filters.txnType ?? null}::text is null or t.txn_type = ${filters.txnType ?? null})
    and (${filters.from ?? null}::date is null or t.txn_date >= ${filters.from ?? null}::date)
    and (${filters.to ?? null}::date is null or t.txn_date <= ${filters.to ?? null}::date)
    and (${filters.includeDeleted ?? false}::boolean or t.deleted_at is null)
  `;

  // Every column is cast to text in the query so `numeric` never becomes a
  // float on the way through, which is the same reason `units.ts` works in
  // strings. The booleans are cast too, so the shape is uniform.
  interface Raw {
    id: string; txn_date: string; txn_type: string;
    company_id: string | null; company_name: string | null;
    fund_investment_id: string | null; fund_name: string | null;
    amount: string; currency: string; fx_rate_to_cad: string | null; amount_cad: string;
    investment_round_id: string | null; round_label: string | null; round_date: string | null;
    standalone_confirmed_at: string | null; standalone_confirmed_by_name: string | null;
    investment_vehicle_id: string | null;
    vehicle_name: string | null; instrument_id: string | null; instrument_name: string | null;
    source_document: string | null; note: string | null;
    is_synthetic: string; deleted_at: string | null; deleted_reason: string | null;
    entered_by_name: string | null; row_created_at: string; row_updated_at: string;
    edited: string;
  }

  const { rows } = await sql<Raw>`
    select t.transaction_id::text            as id,
           t.txn_date::text                  as txn_date,
           t.txn_type,
           t.company_id,
           c.name                            as company_name,
           t.fund_investment_id,
           fi.name                           as fund_name,
           t.amount::text                    as amount,
           t.currency,
           t.fx_rate_to_cad::text            as fx_rate_to_cad,
           (t.amount * coalesce(t.fx_rate_to_cad, 1))::text as amount_cad,
           t.investment_round_id::text       as investment_round_id,
           r.label                           as round_label,
           r.round_date::text                as round_date,
           t.standalone_confirmed_at::text   as standalone_confirmed_at,
           sb.display_name                   as standalone_confirmed_by_name,
           t.investment_vehicle_id::text     as investment_vehicle_id,
           iv.name                           as vehicle_name,
           t.instrument_id::text             as instrument_id,
           ri.name                           as instrument_name,
           t.source_document,
           t.note,
           t.is_synthetic::text              as is_synthetic,
           t.deleted_at::text                as deleted_at,
           t.deleted_reason,
           u.display_name                    as entered_by_name,
           t.row_created_at::text            as row_created_at,
           t.row_updated_at::text            as row_updated_at,
           (t.row_updated_at > t.row_created_at)::text as edited
      from pc.transaction t
      left join pc.company c   on c.company_id = t.company_id
      left join pc.fund_investment fi on fi.fund_investment_id = t.fund_investment_id
      left join pc.ref_investment_vehicle iv on iv.investment_vehicle_id = t.investment_vehicle_id
      left join pc.ref_instrument ri on ri.instrument_id = t.instrument_id
      left join pc.app_user u  on u.user_id = t.entered_by
      left join pc.investment_round r on r.investment_round_id = t.investment_round_id
      left join pc.app_user sb on sb.user_id = t.standalone_confirmed_by
     where ${where}
     order by t.txn_date desc, t.transaction_id desc
     limit ${limit} offset ${offset}
  `.execute(db);

  const { rows: agg } = await sql<{
    total: string; invested: string; realized: string; net: string;
  }>`
    select count(*)::text as total,
           coalesce(sum(t.amount * coalesce(t.fx_rate_to_cad,1))
             filter (where t.txn_type in ('investment','follow_on')
                       and t.deleted_at is null
                       and t.voided_at is null
                       and t.reverses_transaction_id is null), 0)::text as invested,
           coalesce(sum(t.amount * coalesce(t.fx_rate_to_cad,1))
             filter (where t.txn_type = 'realization'
                       and t.deleted_at is null
                       and t.voided_at is null
                       and t.reverses_transaction_id is null), 0)::text as realized,
           coalesce(sum(t.amount * coalesce(t.fx_rate_to_cad,1))
             filter (where t.txn_type in ('investment','follow_on','realization')
                       and t.deleted_at is null
                       and t.voided_at is null
                       and t.reverses_transaction_id is null), 0)::text as net
      from pc.transaction t
     where ${where}
  `.execute(db);

  const a = agg[0] ?? { total: '0', invested: '0', realized: '0', net: '0' };

  return {
    rows: rows.map((r) => ({
      id: r.id,
      txnDate: r.txn_date,
      txnType: r.txn_type,
      companyId: r.company_id,
      companyName: r.company_name,
      fundInvestmentId: r.fund_investment_id,
      fundName: r.fund_name,
      amount: r.amount,
      currency: r.currency,
      fxRateToCad: r.fx_rate_to_cad,
      amountCad: r.amount_cad,
      investmentRoundId: r.investment_round_id,
      roundLabel: r.round_label,
      roundDate: r.round_date,
      standaloneConfirmedAt: r.standalone_confirmed_at,
      standaloneConfirmedByName: r.standalone_confirmed_by_name,
      investmentVehicleId: r.investment_vehicle_id ? Number(r.investment_vehicle_id) : null,
      vehicleName: r.vehicle_name,
      instrumentId: r.instrument_id ? Number(r.instrument_id) : null,
      instrumentName: r.instrument_name,
      sourceDocument: r.source_document,
      note: r.note,
      isSynthetic: r.is_synthetic === 'true',
      deletedAt: r.deleted_at,
      deletedReason: r.deleted_reason,
      edited: r.edited === 'true',
      enteredByName: r.entered_by_name,
      rowCreatedAt: r.row_created_at,
      rowUpdatedAt: r.row_updated_at,
    })),
    total: Number(a.total),
    totals: { invested: a.invested, realized: a.realized, net: a.net },
  };
}

export interface ValuationMarkRow {
  id: string;
  companyId: string;
  companyName: string | null;
  effectiveDate: string;
  /** When Finance completed entry, as distinct from what the mark is "as at". */
  bookedAt: string;
  fmv: string;
  methodLabel: string;
  rationale: string;
  status: string;
  preparedByLabel: string;
  sourceDocument: string | null;
  /**
   * F2, ADR-034. What produced this mark. `legacy` on everything written before
   * the ledger existed, which is most of the table and honestly so.
   */
  adjustmentType: string;
  /** The RETAINED proportion on a review — "0.7500" is a 25% impairment. */
  retentionFactor: string | null;
  /** What the factor was applied to. Present on reviews, null elsewhere. */
  basisFmv: string | null;
  /** Null on a review run against cost, which ADR-007 makes a real basis. */
  basisMarkId: string | null;
  /**
   * ADR-034 clause 3, made visible. The basis mark's FMV **as it stands now**,
   * against the copy taken when this mark was written.
   *
   * These disagreeing means an earlier mark was corrected after this one was
   * derived from it, so this mark's arithmetic no longer reproduces. It is
   * reported rather than repaired: F6 owns the reconciliation, and silently
   * re-deriving would destroy the evidence that anything happened.
   */
  basisFmvNow: string | null;
  isSynthetic: boolean;
  deletedAt: string | null;
  deletedReason: string | null;
  edited: boolean;
}

/**
 * The valuation-mark table (ADR-007: entry by the Director of Finance IS the
 * sign-off, so this screen is the sign-off record).
 *
 * Superseded marks are included alongside final ones. ADR-031 retained the
 * supersession chain for genuine re-valuations, and a mark that was replaced
 * because the company was re-valued is a different event from one that was
 * edited because a digit was wrong — Finance needs to see both and tell them
 * apart.
 */
export async function readValuationMarks(
  db: Kysely<DB>,
  principal: Principal,
  filters: { companyId?: string | null; includeDeleted?: boolean; limit?: number } = {},
): Promise<ValuationMarkRow[]> {
  requireRole(principal, CAN_READ);

  const { rows } = await sql<{
    id: string; company_id: string; company_name: string | null; effective_date: string;
    booked_at: string; fmv: string; method_label: string; rationale: string; status: string;
    prepared_by_label: string; source_document: string | null; is_synthetic: string;
    adjustment_type: string; retention_factor: string | null; basis_fmv: string | null;
    basis_mark_id: string | null; basis_fmv_now: string | null;
    deleted_at: string | null; deleted_reason: string | null; edited: string;
  }>`
    select vm.valuation_mark_id::text as id, vm.company_id, c.name as company_name,
           vm.effective_date::text as effective_date, vm.booked_at::text as booked_at,
           vm.fmv::text as fmv,
           vm.method_label, vm.rationale, vm.status, vm.prepared_by_label,
           vm.source_document, vm.is_synthetic::text as is_synthetic,
           vm.adjustment_type,
           vm.retention_factor::text as retention_factor,
           vm.basis_fmv::text as basis_fmv,
           vm.basis_mark_id::text as basis_mark_id,
           basis.fmv::text as basis_fmv_now,
           vm.deleted_at::text as deleted_at, vm.deleted_reason,
           (vm.row_updated_at > vm.row_created_at)::text as edited
      from pc.valuation_mark vm
      left join pc.company c on c.company_id = vm.company_id
      -- The basis mark AS IT STANDS NOW, so a later correction to it becomes
      -- visible here rather than silently invalidating this row's arithmetic.
      left join pc.valuation_mark basis on basis.valuation_mark_id = vm.basis_mark_id
     where (${filters.companyId ?? null}::text is null or vm.company_id = ${filters.companyId ?? null})
       and (${filters.includeDeleted ?? false}::boolean or vm.deleted_at is null)
     order by vm.effective_date desc, vm.valuation_mark_id desc
     limit ${Math.min(Math.max(filters.limit ?? 200, 1), 500)}
  `.execute(db);

  return rows.map((r) => ({
    id: r.id,
    companyId: r.company_id,
    companyName: r.company_name,
    effectiveDate: r.effective_date,
    bookedAt: r.booked_at,
    fmv: r.fmv,
    methodLabel: r.method_label,
    rationale: r.rationale,
    status: r.status,
    preparedByLabel: r.prepared_by_label,
    sourceDocument: r.source_document,
    adjustmentType: r.adjustment_type,
    retentionFactor: r.retention_factor,
    basisFmv: r.basis_fmv,
    basisMarkId: r.basis_mark_id,
    basisFmvNow: r.basis_fmv_now,
    isSynthetic: r.is_synthetic === 'true',
    deletedAt: r.deleted_at,
    deletedReason: r.deleted_reason,
    edited: r.edited === 'true',
  }));
}

export interface LpNavRow {
  id: string;
  fundInvestmentId: string;
  fundName: string | null;
  asOfDate: string;
  nav: string;
  statementReceivedAt: string | null;
  sourceDocument: string | null;
  isSynthetic: boolean;
  deletedAt: string | null;
  deletedReason: string | null;
  edited: boolean;
}

/**
 * LP capital-account NAV statements.
 *
 * `statement_received_at` is carried because the gap between it and
 * `as_of_date` is what makes LP NAV staleness visible on the Funds tab — GP NAV
 * lags a quarter and the platform should say so rather than imply currency.
 */
export async function readLpNav(
  db: Kysely<DB>,
  principal: Principal,
  filters: { fundInvestmentId?: string | null; includeDeleted?: boolean; limit?: number } = {},
): Promise<LpNavRow[]> {
  requireRole(principal, CAN_READ);

  const { rows } = await sql<{
    id: string; fund_investment_id: string; fund_name: string | null; as_of_date: string;
    nav: string; statement_received_at: string | null; source_document: string | null;
    is_synthetic: string; deleted_at: string | null; deleted_reason: string | null; edited: string;
  }>`
    select n.fund_investment_nav_id::text as id, n.fund_investment_id, fi.name as fund_name,
           n.as_of_date::text as as_of_date, n.nav::text as nav,
           n.statement_received_at::text as statement_received_at, n.source_document,
           n.is_synthetic::text as is_synthetic, n.deleted_at::text as deleted_at,
           n.deleted_reason, (n.row_updated_at > n.row_created_at)::text as edited
      from pc.fund_investment_nav n
      left join pc.fund_investment fi on fi.fund_investment_id = n.fund_investment_id
     where (${filters.fundInvestmentId ?? null}::text is null
            or n.fund_investment_id = ${filters.fundInvestmentId ?? null})
       and (${filters.includeDeleted ?? false}::boolean or n.deleted_at is null)
     order by n.as_of_date desc, n.fund_investment_nav_id desc
     limit ${Math.min(Math.max(filters.limit ?? 200, 1), 500)}
  `.execute(db);

  return rows.map((r) => ({
    id: r.id,
    fundInvestmentId: r.fund_investment_id,
    fundName: r.fund_name,
    asOfDate: r.as_of_date,
    nav: r.nav,
    statementReceivedAt: r.statement_received_at,
    sourceDocument: r.source_document,
    isSynthetic: r.is_synthetic === 'true',
    deletedAt: r.deleted_at,
    deletedReason: r.deleted_reason,
    edited: r.edited === 'true',
  }));
}

export interface ChangeLogEntry {
  id: string;
  table: string;
  recordId: string;
  changedAt: string;
  action: 'create' | 'update' | 'delete' | 'restore';
  changedByName: string;
  changedByEmail: string;
  reason: string | null;
  isRestatement: boolean;
  /**
   * The row image this entry carries. See the view's comment on which.
   *
   * FOR DISPLAY ONLY, NEVER FOR ARITHMETIC. `to_jsonb` maps a `numeric` column
   * to a JSON number, and `JSON.parse` then makes it a double — so money here
   * has left the string discipline the rest of this package keeps (ADR-008).
   * The stored jsonb itself is exact, and the reconstruction that reproduces a
   * board figure is `transaction_asof()`, which is pure SQL and never passes
   * through this shape. If you need to compute on a past value, reconstruct it;
   * do not add up row images.
   */
  rowImage: Record<string, unknown>;
  /**
   * Field-by-field difference against the NEXT image forward in time, computed
   * here rather than stored. Empty for a creation.
   */
  changes: { field: string; from: unknown; to: unknown }[];
}

/**
 * Fields that are storage bookkeeping rather than content. Diffing on these
 * would bury the one changed amount under four timestamps that change on every
 * edit by definition.
 */
const NOT_CONTENT = new Set([
  'row_created_at', 'row_updated_at', 'booked_at', 'computed_at',
]);

/**
 * The change history for one financial row, oldest first.
 *
 * The stored images are point-in-time snapshots; what a reader wants is the
 * diff. Computing it here rather than storing it keeps the version table honest
 * — a stored diff would go stale the moment a column was added — and the
 * arithmetic is trivial at this row count.
 *
 * The last stored image is compared against the row's CURRENT state, which is
 * what makes the most recent edit legible: without it the newest entry would
 * show what the row used to be and nothing about what it became.
 */
export async function readRowHistory(
  db: Kysely<DB>,
  principal: Principal,
  table: string,
  recordId: string,
): Promise<ChangeLogEntry[]> {
  requireRole(principal, CAN_READ);

  const keyColumn = HISTORY_TABLES[table];
  if (!keyColumn) {
    throw new ValidationError(
      `"${table}" is not a versioned financial table. One of: ${Object.keys(HISTORY_TABLES).join(', ')}.`,
    );
  }
  if (!/^\d+$/.test(recordId)) {
    throw new ValidationError(`"recordId" must be a row id. Got ${JSON.stringify(recordId)}.`);
  }

  const { rows } = await sql<{
    id: string; table_name: string; record_id: string; changed_at: string;
    action: string; changed_by_name: string; changed_by_email: string;
    change_reason: string | null; is_restatement: boolean; row_image: Record<string, unknown>;
  }>`
    select financial_row_version_id::text as id,
           table_name, record_id, changed_at::text as changed_at, action,
           changed_by_name, changed_by_email, change_reason, is_restatement, row_image
      from pc.v_financial_change_log
     where table_name = ${table} and record_id = ${recordId}
     order by changed_at asc, financial_row_version_id asc
  `.execute(db);

  if (rows.length === 0) return [];

  // The row as it stands now, so the newest entry has something to diff against.
  const { rows: currentRows } = await sql<{ img: Record<string, unknown> }>`
    select to_jsonb(t) as img from ${sql.table(`pc.${table}`)} t
     where ${sql.ref(keyColumn)} = ${recordId}::bigint
  `.execute(db);
  const current = currentRows[0]?.img ?? null;

  return rows.map((r, i) => {
    // A creation records the values as entered; there is nothing before it to
    // compare against, and inventing an empty "from" would read as a change.
    const next = i + 1 < rows.length ? rows[i + 1]!.row_image : current;
    const changes =
      r.action === 'create' || next === null ? [] : diff(r.row_image, next);
    return {
      id: r.id,
      table: r.table_name,
      recordId: r.record_id,
      changedAt: r.changed_at,
      action: r.action as ChangeLogEntry['action'],
      changedByName: r.changed_by_name,
      changedByEmail: r.changed_by_email,
      reason: r.change_reason,
      isRestatement: r.is_restatement,
      rowImage: r.row_image,
      changes,
    };
  });
}

function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { field: string; from: unknown; to: unknown }[] {
  const out: { field: string; from: unknown; to: unknown }[] = [];
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (NOT_CONTENT.has(field)) continue;
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    // String comparison: these come out of jsonb, so a numeric is already text
    // and `5000000.00` never has to survive a float round trip to be compared.
    if (String(from) !== String(to)) out.push({ field, from, to });
  }
  return out;
}

/**
 * Every restatement, newest first: the figures that moved after the board saw
 * them (ADR-031 clause 5). This is the list the clause promises exists.
 */
export async function readRestatements(
  db: Kysely<DB>,
  principal: Principal,
  limit = 200,
): Promise<ChangeLogEntry[]> {
  requireRole(principal, CAN_READ);

  const { rows } = await sql<{
    id: string; table_name: string; record_id: string; changed_at: string;
    action: string; changed_by_name: string; changed_by_email: string;
    change_reason: string | null; row_image: Record<string, unknown>;
  }>`
    select financial_row_version_id::text as id,
           table_name, record_id, changed_at::text as changed_at, action,
           changed_by_name, changed_by_email, change_reason, row_image
      from pc.v_restatement_log
     limit ${Math.min(Math.max(limit, 1), 1000)}
  `.execute(db);

  return rows.map((r) => ({
    id: r.id,
    table: r.table_name,
    recordId: r.record_id,
    changedAt: r.changed_at,
    action: r.action as ChangeLogEntry['action'],
    changedByName: r.changed_by_name,
    changedByEmail: r.changed_by_email,
    reason: r.change_reason,
    isRestatement: true,
    rowImage: r.row_image,
    changes: [],
  }));
}
