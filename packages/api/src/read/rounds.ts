/**
 * The read path behind the Deal Close tab and the dashboard's mandate tile
 * (ADR-012, A8).
 *
 * Two surfaces, one module, because they are two views of the same question.
 * The dashboard asks "how much of the portfolio can the leverage figure
 * actually see"; the tab asks "which rounds are the gap". A single number
 * nobody can act on is a decoration, and a chasing list with no headline never
 * gets looked at.
 *
 * DELIBERATELY OUTSIDE THE ADR-001 CONTRACT, on the A5 `kpi-coverage`
 * precedent. Coverage is a statement ABOUT the portfolio data rather than part
 * of it, the export shape is frozen, and adding a field to `PortfolioExport` to
 * carry a diagnostic would break the snapshot test for something Daniel's
 * export/re-import loop has no use for.
 *
 * It also cannot be derived from the exported document. The contract carries no
 * co-investor detail at all, and its `roundTotal` is `number | null | undefined`
 * with the three collapsing at the JSON boundary -- so "no round total" and
 * "round total of nothing" are not distinguishable there. They are here.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_READ, type Principal, requireRole } from '../auth/principal.js';

export interface CoinvestorRow {
  id: string;
  investorName: string;
  fundInvestmentId: string | null;
  /** The LP position's name where the FK resolved, so a link is visible as one. */
  fundName: string | null;
  isNbBased: boolean;
  /** DOLLARS. Null means the name is captured and the figure is not (ADR-015). */
  amount: string | null;
  isSynthetic: boolean;
  deletedAt: string | null;
  edited: boolean;
}

/** One of our cheques, as the round sees it. */
export interface RoundChequeRow {
  id: string;
  txnDate: string;
  txnType: string;
  /** DOLLARS, as booked. */
  amount: string;
  currency: string;
  /** DOLLARS, converted. What `ourInvested` actually sums. */
  amountCad: string;
  isSynthetic: boolean;
}

export interface RoundRow {
  id: string;
  companyId: string;
  companyName: string | null;
  roundDate: string;
  label: string;
  instrumentId: number | null;
  instrument: string | null;
  investmentVehicleId: number | null;
  vehicleName: string | null;

  /** DOLLARS, all of them. Null means not captured, never zero. */
  roundTotal: string | null;
  nbOther: string | null;
  postMoney: string | null;
  ownershipAfterPct: string | null;
  leadInvestor: string | null;
  note: string | null;
  sourceDocument: string | null;

  /** Our own cheque, summed from the live transactions tied to this round, in CAD. */
  ourInvested: string;

  /**
   * ADR-033. Whether we put money into this round.
   *
   * READ ALONGSIDE `ourInvested`, NEVER INSTEAD OF IT. The pair is the whole
   * point of F1: `ourInvested` of $0 against `yes` is a cheque that is missing
   * or unlinked and wants chasing, against `no` is a round we correctly sat
   * out, and against `unknown` is a question nobody has answered. Before this
   * column all three read $0 and looked identical (finding S-2).
   */
  nbifParticipated: 'yes' | 'no' | 'unknown';

  /**
   * The live cheques attached to this round, oldest first.
   *
   * Carried on the round rather than fetched per-row by the form, for the same
   * reason the co-investors are: one query means the cheque list can never be
   * read at a different instant from the `ourInvested` figure it has to add up
   * to. A screen showing a total and a list that disagree is worse than one
   * showing neither.
   */
  cheques: RoundChequeRow[];

  /** Set when a deal lead has been through the capture form for this round. */
  capturedAt: string | null;
  capturedByName: string | null;

  coinvestors: CoinvestorRow[];
  /**
   * The sum of `amount` over NB-flagged co-investors. Reported BESIDE `nbOther`
   * rather than instead of it: the mandate KPI sums `nbOther`, and these are two
   * separate captures that can legitimately disagree -- co-investor amounts are
   * often partial (ADR-015), and `nbOther` may include investors nobody listed
   * by name. The tab shows both so a deal lead can see the disagreement; nothing
   * reconciles them silently.
   */
  coinvestorNbTotal: string | null;

  /**
   * ADR-012's exclusion rule, made visible. A round whose total is below our own
   * cheque is dropped from leverage rather than imputed or corrected, and this
   * is the flag that lets a screen say so rather than showing a ratio the fund
   * figure does not use.
   */
  excludedFromLeverage: boolean;

  isSynthetic: boolean;
  deletedAt: string | null;
  deletedReason: string | null;
  edited: boolean;
  rowCreatedAt: string;
  rowUpdatedAt: string;
}

export interface RoundFilters {
  companyId?: string | null;
  from?: string | null;
  to?: string | null;
  /** True narrows to rounds missing at least one of the three mandate fields. */
  incompleteOnly?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface RoundPage {
  rows: RoundRow[];
  /** Rounds matching the filter, ignoring paging. */
  total: number;
}

/**
 * The rounds table, filtered and paged, with each round's co-investors attached.
 *
 * Co-investors arrive as aggregated jsonb in the same query rather than as a
 * second round trip per round. At this row count either would do; one query
 * means the set can never be read at a different instant from the round it
 * belongs to.
 */
export async function readRounds(
  db: Kysely<DB>,
  principal: Principal,
  filters: RoundFilters = {},
): Promise<RoundPage> {
  requireRole(principal, CAN_READ);

  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  // One predicate, built once and used by both the page query and the count, so
  // the two can never describe different sets.
  const where = sql`
    (${filters.companyId ?? null}::text is null or r.company_id = ${filters.companyId ?? null})
    and (${filters.from ?? null}::date is null or r.round_date >= ${filters.from ?? null}::date)
    and (${filters.to ?? null}::date is null or r.round_date <= ${filters.to ?? null}::date)
    and (${filters.includeDeleted ?? false}::boolean or r.deleted_at is null)
    and (not ${filters.incompleteOnly ?? false}::boolean
         or r.round_total is null or r.nb_other is null or r.ownership_after_pct is null)
  `;

  interface Raw {
    id: string; company_id: string; company_name: string | null; round_date: string;
    label: string; instrument_id: string | null; instrument: string | null;
    investment_vehicle_id: string | null; vehicle_name: string | null;
    round_total: string | null; nb_other: string | null; post_money: string | null;
    ownership_after_pct: string | null; lead_investor: string | null; note: string | null;
    source_document: string | null; our_invested: string; captured_at: string | null;
    nbif_participated: string; cheques: ChequeRaw[] | null;
    captured_by_name: string | null; coinvestors: CoinvestorRaw[] | null;
    coinvestor_nb_total: string | null; is_synthetic: string; deleted_at: string | null;
    deleted_reason: string | null; edited: string; row_created_at: string; row_updated_at: string;
  }
  interface ChequeRaw {
    id: string; txn_date: string; txn_type: string; amount: string;
    currency: string; amount_cad: string; is_synthetic: boolean;
  }
  interface CoinvestorRaw {
    id: string; investor_name: string; fund_investment_id: string | null;
    fund_name: string | null; is_nb_based: boolean; amount: string | null;
    is_synthetic: boolean; deleted_at: string | null; edited: boolean;
  }

  const { rows } = await sql<Raw>`
    select r.investment_round_id::text        as id,
           r.company_id,
           c.name                             as company_name,
           r.round_date::text                 as round_date,
           r.label,
           r.instrument_id::text              as instrument_id,
           i.name                             as instrument,
           r.investment_vehicle_id::text      as investment_vehicle_id,
           iv.name                            as vehicle_name,
           r.round_total::text                as round_total,
           r.nb_other::text                   as nb_other,
           r.post_money::text                 as post_money,
           r.ownership_after_pct::text        as ownership_after_pct,
           r.lead_investor,
           r.note,
           r.source_document,
           coalesce(ours.our_invested, 0)::text as our_invested,
           r.nbif_participated,
           coalesce(ours.cheques, '[]'::jsonb) as cheques,
           r.captured_at::text                as captured_at,
           cu.display_name                    as captured_by_name,
           co.coinvestors,
           co.nb_total::text                  as coinvestor_nb_total,
           r.is_synthetic::text               as is_synthetic,
           r.deleted_at::text                 as deleted_at,
           r.deleted_reason,
           (r.row_updated_at > r.row_created_at)::text as edited,
           r.row_created_at::text             as row_created_at,
           r.row_updated_at::text             as row_updated_at
      from pc.investment_round r
      left join pc.company c on c.company_id = r.company_id
      left join pc.ref_instrument i on i.instrument_id = r.instrument_id
      left join pc.ref_investment_vehicle iv on iv.investment_vehicle_id = r.investment_vehicle_id
      left join pc.app_user cu on cu.user_id = r.captured_by
      left join lateral (
        -- amount_cad, not amount: a round can carry a non-CAD tranche, and
        -- summing the booked figure would understate our cheque by the spread.
        -- Same correction as v_company_invested and the export adapter.
        --
        -- F1 widens this lateral to return the cheques as well as their sum,
        -- FROM THE SAME SCAN AND THE SAME PREDICATE. A second lateral would
        -- have been a second copy of the txn_type filter, and the day those two
        -- copies drift is the day a round shows a list that does not add up to
        -- the total printed beside it.
        --
        -- Realizations and write-offs are deliberately outside both. They can
        -- carry a round link and they are not our cost in the round; including
        -- them here would make the list disagree with our_invested instead.
        select sum(t.amount_cad) as our_invested,
               jsonb_agg(jsonb_build_object(
                 'id',           t.transaction_id::text,
                 'txn_date',     t.txn_date::text,
                 'txn_type',     t.txn_type,
                 'amount',       t.amount::text,
                 'currency',     t.currency,
                 'amount_cad',   t.amount_cad::text,
                 'is_synthetic', t.is_synthetic)
                 order by t.txn_date, t.transaction_id) as cheques
          from pc.v_transaction_live t
         where t.investment_round_id = r.investment_round_id
           and t.txn_type in ('investment','follow_on')) ours on true
      left join lateral (
        select jsonb_agg(jsonb_build_object(
                 'id',                 rc.round_coinvestor_id::text,
                 'investor_name',      rc.investor_name,
                 'fund_investment_id', rc.fund_investment_id,
                 'fund_name',          fi.name,
                 'is_nb_based',        rc.is_nb_based,
                 'amount',             rc.amount::text,
                 'is_synthetic',       rc.is_synthetic,
                 'deleted_at',         rc.deleted_at::text,
                 'edited',             rc.row_updated_at > rc.row_created_at)
                 order by rc.is_nb_based desc, rc.investor_name) as coinvestors,
               sum(rc.amount) filter (where rc.is_nb_based)      as nb_total
          from pc.round_coinvestor rc
          left join pc.fund_investment fi on fi.fund_investment_id = rc.fund_investment_id
         where rc.investment_round_id = r.investment_round_id
           -- Deleted co-investors stay out of the panel and out of the NB sum.
           -- Their history is reachable through round_coinvestor_asof() and the
           -- change log, which is where a removed row belongs.
           and rc.deleted_at is null) co on true
     where ${where}
     order by r.round_date desc, r.investment_round_id desc
     limit ${limit} offset ${offset}
  `.execute(db);

  const { rows: countRows } = await sql<{ n: string }>`
    select count(*)::text as n from pc.investment_round r where ${where}
  `.execute(db);

  return {
    total: Number(countRows[0]?.n ?? '0'),
    rows: rows.map((r) => {
      const ourInvested = r.our_invested;
      return {
        id: r.id,
        companyId: r.company_id,
        companyName: r.company_name,
        roundDate: r.round_date,
        label: r.label,
        instrumentId: r.instrument_id ? Number(r.instrument_id) : null,
        instrument: r.instrument,
        investmentVehicleId: r.investment_vehicle_id ? Number(r.investment_vehicle_id) : null,
        vehicleName: r.vehicle_name,
        roundTotal: r.round_total,
        nbOther: r.nb_other,
        postMoney: r.post_money,
        ownershipAfterPct: r.ownership_after_pct,
        leadInvestor: r.lead_investor,
        note: r.note,
        sourceDocument: r.source_document,
        ourInvested,
        nbifParticipated: r.nbif_participated as 'yes' | 'no' | 'unknown',
        cheques: (r.cheques ?? []).map((t) => ({
          id: t.id,
          txnDate: t.txn_date,
          txnType: t.txn_type,
          amount: t.amount,
          currency: t.currency,
          amountCad: t.amount_cad,
          isSynthetic: t.is_synthetic,
        })),
        capturedAt: r.captured_at,
        capturedByName: r.captured_by_name,
        coinvestors: (r.coinvestors ?? []).map((c) => ({
          id: c.id,
          investorName: c.investor_name,
          fundInvestmentId: c.fund_investment_id,
          fundName: c.fund_name,
          isNbBased: c.is_nb_based,
          amount: c.amount,
          isSynthetic: c.is_synthetic,
          deletedAt: c.deleted_at,
          edited: c.edited,
        })),
        coinvestorNbTotal: r.coinvestor_nb_total,
        // Mirrors v_round_leverage's predicate exactly, including its treatment
        // of a null total as "not excluded, just absent" -- an uncaptured round
        // is a gap in coverage, which is a different thing from an impossible
        // round and is counted separately.
        excludedFromLeverage:
          r.round_total !== null && Number(r.round_total) < Number(ourInvested),
        isSynthetic: r.is_synthetic === 'true',
        deletedAt: r.deleted_at,
        deletedReason: r.deleted_reason,
        edited: r.edited === 'true',
        rowCreatedAt: r.row_created_at,
        rowUpdatedAt: r.row_updated_at,
      };
    }),
  };
}

/**
 * Every direct cheque a company has, with the round each is attached to.
 *
 * F1, and it exists for one screen interaction: the Deal Close form's *cheques
 * in this round* section has to offer the cheques that COULD be attached, not
 * only the ones already are. That set is "this company's direct transactions",
 * and there is nowhere else to get it -- `readRounds` sees only cheques that are
 * already linked, which is precisely the set the unlinked ones are missing from.
 *
 * WHY IT RETURNS LINKED CHEQUES TOO, rather than only the loose ones. Moving a
 * cheque from the wrong round to the right one is the same reconciliation as
 * attaching a loose one, and it is the more common correction -- finding S-1
 * left every link in the database written by a generator, and the A6 dataset
 * seeds one deliberately booked against another company's round. A picker that
 * only ever showed unattached cheques would make the wrong-round case the one
 * thing this screen cannot fix.
 *
 * DELETED AND VOIDED ROWS ARE OUT. A cheque that is not in `ourInvested` cannot
 * change a round's `ourInvested` by moving, so offering it would be offering an
 * action with no effect.
 */
export interface CompanyChequeRow {
  id: string;
  txnDate: string;
  txnType: string;
  amount: string;
  currency: string;
  amountCad: string;
  /** Null means unattached — see `standaloneConfirmedAt` for whether that was deliberate. */
  investmentRoundId: string | null;
  roundLabel: string | null;
  roundDate: string | null;
  /** ADR-033 clause 4. Set when someone confirmed this cheque correctly has no round. */
  standaloneConfirmedAt: string | null;
  standaloneConfirmedByName: string | null;
  isSynthetic: boolean;
}

export async function readCompanyCheques(
  db: Kysely<DB>,
  principal: Principal,
  companyId: string,
): Promise<CompanyChequeRow[]> {
  requireRole(principal, CAN_READ);

  interface Raw {
    id: string; txn_date: string; txn_type: string; amount: string; currency: string;
    amount_cad: string; investment_round_id: string | null; round_label: string | null;
    round_date: string | null; standalone_confirmed_at: string | null;
    standalone_confirmed_by_name: string | null; is_synthetic: boolean;
  }

  const { rows } = await sql<Raw>`
    select t.transaction_id::text      as id,
           t.txn_date::text            as txn_date,
           t.txn_type,
           t.amount::text              as amount,
           t.currency,
           t.amount_cad::text          as amount_cad,
           t.investment_round_id::text as investment_round_id,
           r.label                     as round_label,
           r.round_date::text          as round_date,
           x.standalone_confirmed_at::text as standalone_confirmed_at,
           u.display_name              as standalone_confirmed_by_name,
           t.is_synthetic
      from pc.v_transaction_live t
      -- v_transaction_live is deliberately NOT widened by migration 0008 (0002's
      -- standing rule: a later migration must not silently widen a view the
      -- ADR-001 export reads from), so the two confirmation columns are joined
      -- back from the base table rather than selected from the view.
      -- NOTE: no backticks anywhere inside this template literal.
      join pc.transaction x on x.transaction_id = t.transaction_id
      left join pc.investment_round r on r.investment_round_id = t.investment_round_id
      left join pc.app_user u on u.user_id = x.standalone_confirmed_by
     where t.company_id = ${companyId}
       and t.txn_type in ('investment','follow_on')
     order by t.txn_date, t.transaction_id
  `.execute(db);

  return rows.map((r) => ({
    id: r.id,
    txnDate: r.txn_date,
    txnType: r.txn_type,
    amount: r.amount,
    currency: r.currency,
    amountCad: r.amount_cad,
    investmentRoundId: r.investment_round_id,
    roundLabel: r.round_label,
    roundDate: r.round_date,
    standaloneConfirmedAt: r.standalone_confirmed_at,
    standaloneConfirmedByName: r.standalone_confirmed_by_name,
    isSynthetic: r.is_synthetic,
  }));
}

/**
 * ADR-012's monitoring half: how much of the portfolio the leverage figure can
 * see, and how that tapers with age.
 */
export interface MandateCompleteness {
  roundsTotal: number;
  missingRoundTotal: number;
  missingNbOther: number;
  missingOwnership: number;
  /** Share of rounds carrying a round total. The headline ADR-012 names. */
  pctLeverageCoverage: number | null;
  roundsCaptured: number;
  roundsSynthetic: number;
  /**
   * Per round year, oldest first. ADR-015 requires the taper toward older
   * vintages be reported rather than smoothed; a single blended percentage
   * hides exactly the thing that ADR says must stay visible.
   */
  byYear: {
    year: number;
    roundsTotal: number;
    withRoundTotal: number;
    withNbOther: number;
    withOwnership: number;
    captured: number;
    pctLeverageCoverage: number | null;
  }[];
}

export async function readMandateCompleteness(db: Kysely<DB>): Promise<MandateCompleteness> {
  const [headline, byYear] = await Promise.all([
    sql<{
      rounds_total: string; missing_round_total: string; missing_nb_other: string;
      missing_ownership: string; pct_leverage_coverage: string | null;
      rounds_captured: string; rounds_synthetic: string;
    }>`select * from pc.v_mandate_completeness`.execute(db),
    sql<{
      round_year: number; rounds_total: string; with_round_total: string;
      with_nb_other: string; with_ownership: string; captured: string;
      pct_leverage_coverage: string | null;
    }>`select * from pc.v_mandate_completeness_by_year`.execute(db),
  ]);

  // `count()` returns bigint, which pg hands back as a string; `round()` on
  // numeric likewise. Neither is money, so a float is safe here -- these are
  // percentages and counts for display, and nothing downstream sums them.
  const n = (v: string | null | undefined) => Number(v ?? 0);
  const pct = (v: string | null) => (v === null ? null : Number(v));

  const h = headline.rows[0];

  return {
    roundsTotal: n(h?.rounds_total),
    missingRoundTotal: n(h?.missing_round_total),
    missingNbOther: n(h?.missing_nb_other),
    missingOwnership: n(h?.missing_ownership),
    pctLeverageCoverage: pct(h?.pct_leverage_coverage ?? null),
    roundsCaptured: n(h?.rounds_captured),
    roundsSynthetic: n(h?.rounds_synthetic),
    byYear: byYear.rows.map((r) => ({
      year: Number(r.round_year),
      roundsTotal: n(r.rounds_total),
      withRoundTotal: n(r.with_round_total),
      withNbOther: n(r.with_nb_other),
      withOwnership: n(r.with_ownership),
      captured: n(r.captured),
      pctLeverageCoverage: pct(r.pct_leverage_coverage),
    })),
  };
}

/**
 * The reference lists the capture form needs to offer as pickers.
 *
 * This closes an A7 item rather than inventing a new one: the transaction form
 * shipped with no investment-vehicle picker because "the reference list is not
 * exposed through any endpoint yet", and ADR-030 makes the vehicle an attribute
 * of the transaction that Finance should own. It is here rather than in a
 * reference module of its own because these three lists exist to be drawn as
 * dropdowns beside a round, and a table with two rows does not earn a package.
 *
 * NOT SERVED FROM `apps/web/lib/constants.ts`, which still hardcodes the
 * prototype's instrument vocabulary. That file's own header says these move
 * behind the API, and a form needs the reference IDs, which a string list
 * cannot supply.
 */
export interface ReferenceData {
  instruments: { id: number; name: string }[];
  /** `code` is the short form the export's Fund column uses — VCF, SIF, ACC. */
  investmentVehicles: { id: number; code: string; name: string }[];
}

export async function readReferenceData(
  db: Kysely<DB>,
  principal: Principal,
): Promise<ReferenceData> {
  requireRole(principal, CAN_READ);

  const [instruments, vehicles] = await Promise.all([
    sql<{ id: number; name: string }>`
      select instrument_id as id, name from pc.ref_instrument order by instrument_id
    `.execute(db),
    sql<{ id: number; code: string; name: string }>`
      select investment_vehicle_id as id, code, name
        from pc.ref_investment_vehicle
       where is_active
       order by sort_order, investment_vehicle_id
    `.execute(db),
  ]);

  return {
    instruments: instruments.rows.map((r) => ({ id: Number(r.id), name: r.name })),
    investmentVehicles: vehicles.rows.map((r) => ({
      id: Number(r.id),
      code: r.code,
      name: r.name,
    })),
  };
}
