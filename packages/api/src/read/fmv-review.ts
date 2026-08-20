/**
 * The FMV review workspace (F2, FR-19, ADR-034).
 *
 * A SURFACE RATHER THAN A FORM, and the distinction is the whole requirement.
 * The mark entry screen shipped at A7 as a company picker and five empty
 * fields: to value a position, Finance opened it, then went and looked up what
 * the position was last marked at, then found what had been invested since,
 * then found which rounds had happened, then came back and typed a number.
 * FR-19 is the observation that the platform already holds every one of those
 * things -- *"eliminates the need to re-enter transaction data that is already
 * in the system"* -- and that the exercise should therefore be run FROM a
 * screen rather than beside one.
 *
 * NOTHING NEW IS CAPTURED TO MAKE THIS WORK. `valuation_mark` already carries
 * `effective_date`, `booked_at`, `method_label`, `prepared_by_label` and a
 * mandatory `rationale`; F1 made every cheque's round link legible; the ADR-031
 * version store holds the history behind each row. This module shows what is
 * there.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS PROPOSE. Q-2, Q-3 and Q-4 decide whether
 * new money raises FMV by the cheque or reprices the whole position, whether an
 * unpriced round can do anything at all, and whether a computed figure is final
 * without anybody clicking. Until those are answered the workspace shows
 * CONTEXT and lets a person decide -- the proposal panel is what the answers
 * buy. Everything here is a read, so none of it has to be revisited when they
 * arrive.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_READ, type Principal, requireRole } from '../auth/principal.js';

/** One row of the review cycle's checklist. */
export interface ReviewQueueRow {
  companyId: string;
  companyName: string;
  /** DOLLARS. The carrying value as at the cycle date — a mark, or cost. */
  currentFmv: string;
  /** DOLLARS. Cumulative investment, which is the floor a never-marked position sits at. */
  cost: string;
  /** Null where the company has never been marked and is held at cost (ADR-007). */
  lastMarkDate: string | null;
  lastMarkType: string | null;
  /**
   * True when this company already has a review mark AT the cycle date.
   *
   * This is what makes the exercise a checklist that gets cleared rather than
   * a set of forms that were or were not opened — which is the second
   * consequence FR-18 identified once "no change" became a positive entry
   * rather than an absence.
   */
  reviewedThisCycle: boolean;
  /** Cheques booked since the last mark. The reason a position may need looking at. */
  transactionsSince: number;
  roundsSince: number;
}

/**
 * The review cycle, as a list Finance can work down.
 *
 * ORDERED BY WHAT NEEDS ATTENTION, not alphabetically: unreviewed first, then
 * by how much has happened since the last mark. A checklist sorted by name is
 * one where the interesting rows are wherever they happen to fall.
 *
 * `asOfDate` is the CYCLE date — 31 January or 31 July (ADR-007) — and it is
 * required rather than defaulted to today for the ADR-021 reason: a default
 * would make the same screen show different work depending on when it was
 * opened.
 */
export async function readFmvReviewQueue(
  db: Kysely<DB>,
  principal: Principal,
  asOfDate: string,
): Promise<ReviewQueueRow[]> {
  requireRole(principal, CAN_READ);

  interface Raw {
    company_id: string; company_name: string; current_fmv: string; cost: string;
    last_mark_date: string | null; last_mark_type: string | null;
    reviewed_this_cycle: boolean; transactions_since: string; rounds_since: string;
  }

  const { rows } = await sql<Raw>`
    select c.company_id,
           c.name                                    as company_name,
           -- The same function every metric reads, rather than a second
           -- expression that means to agree with it.
           pc.company_fmv_asof(c.company_id, ${asOfDate}::date)::text as current_fmv,
           coalesce(cost.total, 0)::text             as cost,
           last.effective_date::text                 as last_mark_date,
           last.adjustment_type                      as last_mark_type,
           exists (select 1 from pc.valuation_mark r
                    where r.company_id = c.company_id
                      and r.effective_date = ${asOfDate}::date
                      and r.adjustment_type = 'review'
                      and r.status = 'final'
                      and r.deleted_at is null)      as reviewed_this_cycle,
           coalesce(since.txns, 0)::text             as transactions_since,
           coalesce(since.rounds, 0)::text           as rounds_since
      from pc.company c
      left join lateral (
        select coalesce(sum(t.amount_cad), 0) as total
          from pc.v_transaction_live t
         where t.company_id = c.company_id
           and t.txn_type in ('investment','follow_on')
           and t.txn_date <= ${asOfDate}::date) cost on true
      -- The mark the carrying value comes from, resolved with the SAME ordering
      -- as company_fmv_asof, tiebreak included. Two different orderings here
      -- would mean the screen names one mark as current while every metric
      -- reads another.
      left join lateral (
        select vm.effective_date, vm.adjustment_type
          from pc.valuation_mark vm
         where vm.company_id = c.company_id
           and vm.status = 'final'
           and vm.deleted_at is null
           and vm.effective_date <= ${asOfDate}::date
         order by vm.effective_date desc, vm.booked_at desc, vm.valuation_mark_id desc
         limit 1) last on true
      left join lateral (
        select count(*) filter (where kind = 'txn')   as txns,
               count(*) filter (where kind = 'round') as rounds
          from (
            select 'txn' as kind
              from pc.v_transaction_live t
             where t.company_id = c.company_id
               and t.txn_type in ('investment','follow_on')
               and t.txn_date <= ${asOfDate}::date
               and (last.effective_date is null or t.txn_date > last.effective_date)
            union all
            select 'round'
              from pc.investment_round r
             where r.company_id = c.company_id
               and r.deleted_at is null
               and r.round_date <= ${asOfDate}::date
               and (last.effective_date is null or r.round_date > last.effective_date)
          ) events) since on true
     order by reviewed_this_cycle,
              (coalesce(since.txns,0) + coalesce(since.rounds,0)) desc,
              last.effective_date nulls first,
              c.name
  `.execute(db);

  return rows.map((r) => ({
    companyId: r.company_id,
    companyName: r.company_name,
    currentFmv: r.current_fmv,
    cost: r.cost,
    lastMarkDate: r.last_mark_date,
    lastMarkType: r.last_mark_type,
    reviewedThisCycle: r.reviewed_this_cycle,
    transactionsSince: Number(r.transactions_since),
    roundsSince: Number(r.rounds_since),
  }));
}

/** A cheque, as the review needs to see it. */
export interface ReviewTransaction {
  id: string;
  txnDate: string;
  txnType: string;
  amountCad: string;
  /** F1. Which round this funded, where it has been reconciled to one. */
  roundLabel: string | null;
  roundDate: string | null;
  note: string | null;
}

/** A round, as the review needs to see it. */
export interface ReviewRound {
  id: string;
  roundDate: string;
  label: string;
  instrument: string | null;
  roundTotal: string | null;
  /**
   * Null on a SAFE or convertible note **by design**, and that is the fact this
   * screen most needs to show plainly.
   *
   * Repricing off a round needs post-money and ownership. Pat identified
   * unpriced instruments as a large share of NBIF's activity, *"particularly
   * for early-stage companies where a share price cannot yet be established"* —
   * so for those rounds there is no arithmetic available to anybody, automation
   * included. A reviewer seeing the gap can apply judgement; a reviewer shown a
   * confident number cannot.
   */
  postMoney: string | null;
  ownershipAfterPct: string | null;
  /** ADR-033. `no` means the round moved the cap table without our money in it. */
  nbifParticipated: string;
  /** DOLLARS. Our own cheque into this round. */
  ourInvested: string;
}

/** The provenance of the figure currently on the books. */
export interface CurrentValuation {
  /** DOLLARS. What every metric reads for this company as at the date. */
  fmv: string;
  /**
   * Null when no mark applies and the position is held at cost (ADR-007).
   * The distinction matters on screen: cost is a fallback, not a valuation
   * anybody signed.
   */
  markId: string | null;
  effectiveDate: string | null;
  bookedAt: string | null;
  methodLabel: string | null;
  rationale: string | null;
  preparedByLabel: string | null;
  adjustmentType: string | null;
  retentionFactor: string | null;
  basisFmv: string | null;
}

export interface FmvReview {
  companyId: string;
  companyName: string;
  /** The cycle date the review is being run at. */
  asOfDate: string;
  current: CurrentValuation;
  /** DOLLARS. Cumulative investment as at the date. */
  cost: string;
  /** Everything booked since the last mark — the case for changing the number. */
  transactionsSince: ReviewTransaction[];
  roundsSince: ReviewRound[];
  /** The active options, so the control offers exactly what Finance approved. */
  retentionOptions: { factor: string; label: string }[];
}

/**
 * Everything a reviewer would otherwise look up, for one company.
 *
 * The mark history is NOT here: it is `readValuationMarks({ companyId })`, which
 * already returns exactly that with the adjustment detail F2 added, and a second
 * query returning the same rows in a different shape is a second thing to keep
 * in step.
 */
export async function readFmvReview(
  db: Kysely<DB>,
  principal: Principal,
  companyId: string,
  asOfDate: string,
): Promise<FmvReview> {
  requireRole(principal, CAN_READ);

  const { rows: header } = await sql<{
    company_id: string; company_name: string; fmv: string; cost: string;
    mark_id: string | null; effective_date: string | null; booked_at: string | null;
    method_label: string | null; rationale: string | null; prepared_by_label: string | null;
    adjustment_type: string | null; retention_factor: string | null; basis_fmv: string | null;
  }>`
    select c.company_id,
           c.name as company_name,
           pc.company_fmv_asof(c.company_id, ${asOfDate}::date)::text as fmv,
           coalesce(cost.total, 0)::text as cost,
           last.valuation_mark_id::text  as mark_id,
           last.effective_date::text     as effective_date,
           last.booked_at::text          as booked_at,
           last.method_label,
           last.rationale,
           last.prepared_by_label,
           last.adjustment_type,
           last.retention_factor::text   as retention_factor,
           last.basis_fmv::text          as basis_fmv
      from pc.company c
      left join lateral (
        select coalesce(sum(t.amount_cad), 0) as total
          from pc.v_transaction_live t
         where t.company_id = c.company_id
           and t.txn_type in ('investment','follow_on')
           and t.txn_date <= ${asOfDate}::date) cost on true
      left join lateral (
        select vm.*
          from pc.valuation_mark vm
         where vm.company_id = c.company_id
           and vm.status = 'final'
           and vm.deleted_at is null
           and vm.effective_date <= ${asOfDate}::date
         order by vm.effective_date desc, vm.booked_at desc, vm.valuation_mark_id desc
         limit 1) last on true
     where c.company_id = ${companyId}
  `.execute(db);

  const h = header[0];
  if (!h) throw new Error(`No company with id ${companyId}.`);

  // "Since the last mark" means since its EFFECTIVE date, not since it was
  // booked. A mark as at 31 January entered in March values the position as it
  // stood in January, so a February cheque is activity the mark did not see
  // even though it was entered before the mark was.
  const since = h.effective_date;

  const [txns, rounds, options] = await Promise.all([
    sql<{
      id: string; txn_date: string; txn_type: string; amount_cad: string;
      round_label: string | null; round_date: string | null; note: string | null;
    }>`
      select t.transaction_id::text as id, t.txn_date::text as txn_date, t.txn_type,
             t.amount_cad::text as amount_cad,
             r.label as round_label, r.round_date::text as round_date, t.note
        from pc.v_transaction_live t
        left join pc.investment_round r on r.investment_round_id = t.investment_round_id
       where t.company_id = ${companyId}
         and t.txn_type in ('investment','follow_on','realization','write_off')
         and t.txn_date <= ${asOfDate}::date
         and (${since}::date is null or t.txn_date > ${since}::date)
       order by t.txn_date, t.transaction_id
    `.execute(db),

    sql<{
      id: string; round_date: string; label: string; instrument: string | null;
      round_total: string | null; post_money: string | null;
      ownership_after_pct: string | null; nbif_participated: string; our_invested: string;
    }>`
      select r.investment_round_id::text as id, r.round_date::text as round_date, r.label,
             i.name as instrument, r.round_total::text as round_total,
             r.post_money::text as post_money,
             r.ownership_after_pct::text as ownership_after_pct,
             r.nbif_participated,
             coalesce(ours.total, 0)::text as our_invested
        from pc.investment_round r
        left join pc.ref_instrument i on i.instrument_id = r.instrument_id
        left join lateral (
          select sum(t.amount_cad) as total
            from pc.v_transaction_live t
           where t.investment_round_id = r.investment_round_id
             and t.txn_type in ('investment','follow_on')) ours on true
       where r.company_id = ${companyId}
         and r.deleted_at is null
         and r.round_date <= ${asOfDate}::date
         and (${since}::date is null or r.round_date > ${since}::date)
       order by r.round_date, r.investment_round_id
    `.execute(db),

    sql<{ factor: string; label: string }>`
      select factor::text as factor, label
        from pc.ref_fmv_retention_option
       where is_active
       order by sort_order, fmv_retention_option_id
    `.execute(db),
  ]);

  return {
    companyId: h.company_id,
    companyName: h.company_name,
    asOfDate,
    cost: h.cost,
    current: {
      fmv: h.fmv,
      markId: h.mark_id,
      effectiveDate: h.effective_date,
      bookedAt: h.booked_at,
      methodLabel: h.method_label,
      rationale: h.rationale,
      preparedByLabel: h.prepared_by_label,
      adjustmentType: h.adjustment_type,
      retentionFactor: h.retention_factor,
      basisFmv: h.basis_fmv,
    },
    transactionsSince: txns.rows.map((t) => ({
      id: t.id,
      txnDate: t.txn_date,
      txnType: t.txn_type,
      amountCad: t.amount_cad,
      roundLabel: t.round_label,
      roundDate: t.round_date,
      note: t.note,
    })),
    roundsSince: rounds.rows.map((r) => ({
      id: r.id,
      roundDate: r.round_date,
      label: r.label,
      instrument: r.instrument,
      roundTotal: r.round_total,
      postMoney: r.post_money,
      ownershipAfterPct: r.ownership_after_pct,
      nbifParticipated: r.nbif_participated,
      ourInvested: r.our_invested,
    })),
    retentionOptions: options.rows.map((o) => ({ factor: o.factor, label: o.label })),
  };
}
