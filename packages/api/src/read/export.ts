/**
 * The read path: database rows -> the ADR-001 export contract.
 *
 * This is the outbound half of the round trip and the component ADR-021 names
 * as A3's single deliverable of record. It is also the one place in the system
 * that can produce a perfectly well-typed document holding wrong numbers, which
 * is why `test/round-trip.test.ts` exists and why it compares against
 * `demo.json` rather than against this module's own output.
 *
 * FOUR PROPERTIES IT MUST HOLD:
 *
 * 1. **Money crosses the unit boundary exactly once**, via `units.ts`. No
 *    literal 1e6 appears below.
 * 2. **Rounds are delivered UNFILTERED BY THE LEVERAGE PREDICATE** (ADR-021,
 *    ADR-023). A round with a missing or invalid `roundTotal` still appears.
 *    That exclusion is the frozen definition and belongs to `packages/metrics`,
 *    which cannot apply it to rows this layer has already dropped. Rounds that
 *    are not ours at all -- soft-deleted, or ones we did not participate in --
 *    are a different question and are excluded here. See the round query.
 * 3. **Array order is load-bearing and runs opposite ways** (INHERITED-
 *    COERCIONS.md §3): `kpis` and `marks` newest-first, `rounds` oldest-first.
 *    Metrics read `kpis[0]` as the current period and `rounds[0]` as the
 *    initial cheque, so an ORDER BY here is a board number there.
 * 4. **Optional fields keep the contract's exact presence semantics.** Some are
 *    absent when unset (`exitDate`, `closedDate`, `thresholds.minRunwayMo`) and
 *    others are explicitly null (`govFunding`, `postMoney`, `termSheet`,
 *    `board.nextMeeting`). The two are not interchangeable: `undefined`
 *    disappears under JSON.stringify and `null` does not.
 *
 * Queries are one-per-table and grouped in memory rather than issued per
 * company. At 70 companies an N+1 read would still be fast enough and still be
 * the wrong shape to leave behind.
 */
import type {
  AlertAcknowledgement,
  Company,
  FundInvestment,
  Kpi,
  PipelineDeal,
  PortfolioExport,
  RiskFlagDetail,
  Round,
  ValuationMark,
} from '@portfolio-command/contract';
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';

import { toCalendarLabel } from '../periods.js';
import { toMillions, toNumber } from '../units.js';

/** Groups rows by a key, preserving the SQL ORDER BY within each group. */
function groupBy<T, K extends string>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/**
 * Adds a key only when the value is not null.
 *
 * The contract distinguishes "absent" from "null" and the distinction survives
 * into the JSON, so this is not tidying -- it is the difference between
 * reproducing the document and merely resembling it.
 */
function withOptional<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | null | undefined,
): T & Partial<Record<K, V>> {
  if (value !== null && value !== undefined) (target as Record<string, unknown>)[key] = value;
  return target as T & Partial<Record<K, V>>;
}

/** `numeric` and `date` both arrive as strings; dates need no conversion, only narrowing. */
const asDate = (d: Date | string | null): string | null =>
  d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

/**
 * The reporting as-at date, derived from the data rather than the clock.
 *
 * The latest final valuation mark is the anchor, for the reason ADR-007 gives:
 * NAV as at any date is the sum of each company's most recent mark on or
 * before it, so dating a report later than the last mark values the portfolio
 * at a date its marks do not cover. It is also the date the board-facing views
 * must stamp, which makes the report header and the IRR terminal cashflow one
 * fact rather than two that can silently disagree.
 */
export async function resolveAsOf(db: Kysely<DB>): Promise<string> {
  const rows = await sql<{ as_of: Date | string | null; any_marks: boolean }>`
    select max(effective_date) filter (where status = 'final') as as_of,
           count(*) > 0                                        as any_marks
      from valuation_mark
  `.execute(db);
  const row = rows.rows[0];
  const value = row?.as_of ?? null;
  if (value !== null) return asDate(value)!;

  /**
   * No marks AT ALL: the financial spine does not exist yet.
   *
   * This is the state between A4 and A6 -- a real Affinity roster with no
   * transactions, rounds or marks attached. The clock is used, and that is
   * safe here for the precise reason it is unsafe elsewhere: the objection in
   * ADR-021 is that "today" makes a number DRIFT between two runs on identical
   * data. With no marks there are no cashflows and no NAV, so every metric is
   * zero or null whatever date is chosen. Nothing can drift.
   *
   * The moment a single mark exists the date comes from the data again.
   */
  if (row && !row.any_marks) {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Marks exist but none is final. NOT the empty-portfolio case -- this is a
   * real data problem (an import that loaded only drafts) and falling back to
   * the clock would hide it behind a plausible-looking report.
   */
  throw new Error(
    'Valuation marks exist but none is final, so there is no as-at date to report on. ' +
      'Finalise a mark, or check what the last import loaded.',
  );
}

export interface ExportOptions {
  /**
   * The reporting as-at date, `YYYY-MM-DD`. Required, never defaulted: a
   * default would silently reintroduce "today", which is the failure mode
   * ADR-021 removed. It reaches `company_fmv_asof` and nothing else -- see the
   * note on `company_current_asof` in schema.sql for why the other columns are
   * deliberately undated.
   */
  asOf: string;
}

export async function buildExport(db: Kysely<DB>, { asOf }: ExportOptions): Promise<PortfolioExport> {
  const q = <T>(query: ReturnType<typeof sql<T>>) => query.execute(db).then((r) => r.rows);

  const [
    fundRows,
    navRows,
    distRows,
    companyRows,
    detailRows,
    flagRows,
    thresholdRows,
    roundRows,
    kpiRows,
    markRows,
    reserveRows,
    boardRows,
    milestoneRows,
    covenantRows,
    govRows,
    taskRows,
    lpRows,
    cashflowRows,
    dealRows,
    gateRows,
    termRows,
    memoRows,
    funnelGroupRows,
    syntheticRows,
    policyRows,
    healthRows,
    ackRows,
  ] = await Promise.all([
    q<{
      fund_id: number; name: string; style: string; reporting_currency: string;
      inception_year: number; capital_base: string | null; committed: string | null;
      called: string | null; fee_drag_pct: string | null; distribution_policy: string | null;
      reserves_policy: string | null; annual_platform_target: number | null;
      annual_followon_budget: string | null;
    }>(sql`select * from fund order by fund_id limit 1`),

    q<{ period_end: Date | string; nav: string; cumulative_cost: string }>(
      sql`select period_end, nav, cumulative_cost from fund_nav_snapshot order by period_end`,
    ),

    q<{ distribution_date: Date | string; amount: string; company_label: string; note: string | null }>(
      sql`select distribution_date, amount, company_label, note
            from fund_distribution order by distribution_date, fund_distribution_id`,
    ),

    q<{
      company_id: string; name: string; sector_label: string | null; stage: string | null;
      health: string | null; hq_city: string | null; hq_region: string | null;
      source_label: string | null; invested: string; vintage_year: number | null;
      fmv: string; realized: string; exited: boolean; exit_date: Date | string | null;
      exit_type: string | null; ownership_pct: string | null; pro_rata_rights: boolean | null;
    }>(sql`select * from company_current_asof(${asOf}::date) order by company_id`),

    q<{
      company_id: string; instrument_label: string | null; fte_at_entry: number | null;
      ceo_name: string | null; description: string | null;
    }>(sql`select company_id, instrument_label, fte_at_entry, ceo_name, description
             from company order by company_id`),

    // ORDER IS THE JOIN between `riskFlags` and `riskFlagDetail`: the contract
    // pairs them by position, so both arrays are built from this one result in
    // this one order. Do not sort either of them downstream.
    q<{
      company_risk_flag_id: string; company_id: string; flag_text: string;
      category: string; category_label: string; note: string | null;
      severity: string | null; raised_at: Date | string; raised_by_name: string;
    }>(
      sql`select f.company_risk_flag_id, f.company_id, f.flag_text,
                 c.code as category, c.name as category_label,
                 f.note, f.severity, f.raised_at, u.display_name as raised_by_name
            from company_risk_flag f
            join ref_risk_flag_category c
              on c.risk_flag_category_id = f.risk_flag_category_id
            join app_user u on u.user_id = f.raised_by
           where f.cleared_at is null
           order by f.company_id, f.company_risk_flag_id`,
    ),

    q<{
      company_id: string; min_runway_months: number | null; max_burn_multiple: string | null;
      min_cash_balance: string | null; max_revenue_decline_pct: string | null;
      min_nrr_pct: string | null;
    }>(
      sql`select company_id, min_runway_months, max_burn_multiple, min_cash_balance,
                 max_revenue_decline_pct, min_nrr_pct
            from company_threshold`,
    ),

    // Rounds carry OUR cheque, summed from the live transactions tied to each
    // round. Unfiltered by design -- see property 2 above.
    //
    // "Unfiltered" means BY THE LEVERAGE PREDICATE, not by existence. A round
    // with a missing or impossible total still ships, because ADR-021 puts that
    // exclusion in packages/metrics; a SOFT-DELETED round is a row someone
    // withdrew and must not. The distinction only became reachable at A8, when
    // the ADR-012 capture form gave rounds a write path that can set
    // deleted_at -- migration 0002 added the column and left every reader of
    // this table, including this query, unaware of it.
    //
    // F1 ADDS THE SECOND MEMBER OF THAT SECOND CATEGORY, and it is the one
    // place in Track F where a predicate had to go somewhere ADR-033 did not
    // name. The ADR puts the participation guard in `v_round_leverage`. That
    // view is marked CONVENIENCE ONLY (ADR-021) and NOTHING IN THE API READS
    // IT: the published leverage KPI is `fundMetrics` in packages/metrics,
    // computed from this document, and its predicate is
    // `roundTotal && roundTotal >= invested`. A round we sat out arrives here
    // with `invested` of 0, passes that test, and adds its whole total to
    // `capitalAttracted` with nothing in the denominator to match -- so the
    // ratio goes UP because we did LESS. The Capital Attracted chart has the
    // same shape. The guard as written would have gone into the one place that
    // cannot trip.
    //
    // WHY THE PREDICATE IS HERE AND NOT IN packages/metrics. The contract is
    // frozen (ADR-001) and carries no participation field, so metrics cannot
    // see the distinction at all; and it does not need to, because this
    // contract's own definition of the type settles it -- `Round` is
    // documented as "one financing round we participated in". A round we did
    // not participate in was never in scope for this array. Excluding it is
    // this layer reading the contract correctly, not a change to it, and it is
    // the same category as the soft-delete above: not ours to report.
    //
    // `<> 'no'` AND NOT `= 'yes'`. `unknown` still ships, on ADR-033's own
    // reasoning: only an explicit statement that we sat a round out removes it,
    // and a round nobody has classified must not quietly leave the numerator.
    //
    // NO NUMBER MOVES ON THE DAY THIS LANDS -- every round backfills to `yes`
    // -- which is exactly why it goes in now. The F1 suite asserts it against a
    // round built for the purpose, because the first real one will arrive
    // months from now with nobody watching.
    q<{
      company_id: string; round_date: Date | string; label: string; instrument: string | null;
      invested: string; post_money: string | null; ownership_after_pct: string | null;
      lead_investor: string | null; note: string | null; round_total: string | null;
      nb_other: string | null;
    }>(sql`
      select r.company_id, r.round_date, r.label, i.name as instrument,
             coalesce(t.ours, 0) as invested, r.post_money, r.ownership_after_pct,
             r.lead_investor, r.note, r.round_total, r.nb_other
        from investment_round r
        left join ref_instrument i on i.instrument_id = r.instrument_id
        left join lateral (
          -- amount_cad, not amount: a round can carry a non-CAD tranche, and
          -- summing the booked figure would understate our cheque by the
          -- spread. Same correction as v_company_invested (ADR-030).
          select sum(amount_cad) as ours from v_transaction_live
           where investment_round_id = r.investment_round_id
             and txn_type in ('investment','follow_on')) t on true
       where r.deleted_at is null
         and r.nbif_participated <> 'no'
       order by r.company_id, r.round_date, r.investment_round_id`),

    // Newest first: metrics read kpis[0] as the current period.
    q<{
      company_id: string; period_end: Date | string; revenue: string | null;
      monthly_burn: string | null; cash_balance: string | null; runway_months: string | null;
      // fte and fte_nb are `numeric` since A5 -- a full-time EQUIVALENT is
      // fractional by definition -- so pg hands them back as strings like every
      // other numeric (ADR-008) and they need toNumber, not a bare `?? 0`.
      fte: string | null; fte_nb: string | null; women_csuite: number | null;
      csuite_size: number | null;
      net_revenue_retention: string | null;
    }>(sql`select company_id, period_end, revenue, monthly_burn, cash_balance, runway_months,
                  fte, fte_nb, women_csuite, csuite_size, net_revenue_retention
             from company_kpi order by company_id, period_end desc`),

    q<{
      company_id: string; effective_date: Date | string; fmv: string; method_label: string;
      prepared_by_label: string; rationale: string;
    }>(sql`select company_id, effective_date, fmv, method_label, prepared_by_label, rationale
             from valuation_mark where status = 'final'
            order by company_id, effective_date desc, valuation_mark_id desc`),

    q<{ company_id: string; allocated: string; deployed: string }>(
      sql`select distinct on (company_id) company_id, allocated, deployed
            from reserve_allocation order by company_id, effective_from desc, reserve_allocation_id desc`,
    ),

    q<{ company_id: string; seat_type: string; holder_name: string | null; next_meeting_date: Date | string | null }>(
      sql`select distinct on (company_id) company_id, seat_type, holder_name, next_meeting_date
            from board_seat where effective_to is null
           order by company_id, effective_from desc, board_seat_id desc`,
    ),

    q<{ company_id: string; title: string; due_date: Date | string | null; status: string }>(
      sql`select company_id, title, due_date, status from company_milestone
           order by company_id, company_milestone_id`,
    ),

    q<{ company_id: string; covenant_text: string; status_detail: string | null; status: string }>(
      sql`select company_id, covenant_text, status_detail, status from company_covenant
           order by company_id, company_covenant_id`,
    ),

    q<{ company_id: string; program_name: string; amount: string | null; conditions: string | null; status: string }>(
      sql`select distinct on (company_id) company_id, program_name, amount, conditions, status
            from company_gov_funding order by company_id, company_gov_funding_id`,
    ),

    q<{ company_id: string; title: string; due_date: Date | string | null; is_done: boolean }>(
      sql`select company_id, title, due_date, is_done from company_task
           order by company_id, company_task_id`,
    ),

    q<{
      fund_investment_id: string; name: string; manager_name: string; strategy: string | null;
      vintage_year: number | null; committed: string; called: string; distributions: string;
      nav: string; co_invest_rights: boolean; co_invests_done: number | null;
      referrals: number | null; capital_to_direct: string | null; women_senior_gp: boolean | null;
      next_call_est: Date | string | null; agm_date: Date | string | null;
      ir_contact: string | null; rationale: string | null;
    }>(sql`
      select fi.fund_investment_id, fi.name, fi.manager_name, fi.strategy, fi.vintage_year,
             fi.committed, lp.called, lp.distributions, lp.nav,
             fi.co_invest_rights, fi.co_invests_done, fi.referrals, fi.capital_to_direct,
             fi.women_senior_gp, fi.next_call_est, fi.agm_date, fi.ir_contact, fi.rationale
        from fund_investment fi
        join v_lp_position_current lp on lp.fund_investment_id = fi.fund_investment_id
       order by fi.fund_investment_id`),

    q<{ fund_investment_id: string; txn_date: Date | string; amount: string; txn_type: string }>(
      sql`select fund_investment_id, txn_date, amount, txn_type from v_transaction_live
           where fund_investment_id is not null order by fund_investment_id, txn_date, transaction_id`,
    ),

    q<{
      deal_id: string; name: string; sector_label: string | null; funnel_label: string | null;
      source_label: string | null; check_size: string | null; valuation: string | null;
      owner_label: string | null; next_step: string | null; date_added: Date | string | null;
      closed_date: Date | string | null;
    }>(sql`select deal_id, name, sector_label, funnel_label, source_label, check_size, valuation,
                  owner_label, next_step, date_added, closed_date
             from pipeline_deal order by deal_id`),

    q<{ deal_id: string; gate_name: string; status: string }>(
      sql`select deal_id, gate_name, status from deal_gate order by deal_id, sort_order`,
    ),

    q<{
      deal_id: string; security: string | null; pre_money: string | null; post_money: string | null;
      investment: string | null; ownership_pct: string | null; liquidation_pref: string | null;
      anti_dilution: string | null; board_composition: string | null; pro_rata_terms: string | null;
      dividends: string | null; option_pool: string | null; founder_vesting: string | null;
    }>(sql`select * from term_sheet order by deal_id, term_sheet_id`),

    q<{ subject_id: string; section_key: string; body: string | null }>(
      sql`select m.subject_id, s.section_key, s.body
            from memo m join memo_section s on s.memo_id = m.memo_id
           order by m.subject_id, s.sort_order`,
    ),

    // The board's columns, and which funnel stages render in each. Reference
    // data, emitted once at the document root rather than repeated on every
    // deal -- and emitted at all so the frontend stops hardcoding a column list
    // that an admin can change with a row edit (ADR-009, ADR-014).
    //
    // Stage membership deliberately includes the `prototype-fixture` rows, so a
    // reference-fixture deal at "Sourced" groups alongside a real one at "New"
    // for as long as both datasets coexist. Those rows disappear at A6.
    q<{ name: string; is_terminal: boolean; show_on_board: boolean; stages: string[] }>(sql`
      select g.name,
             g.is_terminal,
             g.show_on_board,
             coalesce(
               array_agg(s.name order by s.sort_order, s.name)
                 filter (where s.name is not null),
               '{}'
             ) as stages
        from ref_funnel_group g
        left join ref_funnel_stage s on s.funnel_group_id = g.funnel_group_id
       group by g.funnel_group_id, g.name, g.is_terminal, g.show_on_board, g.sort_order
       order by g.sort_order`),

    q<{ contains_synthetic: boolean }>(sql`select contains_synthetic from v_synthetic_data_status`),

    // The alert policy AS AT `asOf`, not the one in force today. An export is
    // how a board pack is produced, ADR-031 exists so an issued pack stays
    // reproducible, and a watchlist reprinted against this quarter's policy
    // would show companies that were never on last quarter's. This is the
    // reason fund_alert_policy is effective-dated at all, so it would be a
    // waste to then read it through v_fund_alert_policy_current.
    q<{
      min_runway_months: number | null; max_burn_multiple: string | null;
      min_cash_balance: string | null; max_revenue_decline_pct: string | null;
      min_nrr_pct: string | null; effective_from: Date | string;
      set_by_name: string; note: string | null;
    }>(
      sql`select p.min_runway_months, p.max_burn_multiple, p.min_cash_balance,
                 p.max_revenue_decline_pct, p.min_nrr_pct, p.effective_from,
                 u.display_name as set_by_name, p.note
            from fund_alert_policy p
            join app_user u on u.user_id = p.set_by
           where p.effective_from <= ${asOf}::date
             and (p.effective_to is null or p.effective_to > ${asOf}::date)
           order by p.effective_from desc, p.fund_alert_policy_id desc
           limit 1`,
    ),

    /* Health PROVENANCE, as at the reporting date.
       `company_current_asof` already supplies the health colour itself; this
       supplies the row that set it, so a screen can say "B Grade, from the
       Affinity sync, 14 Feb 2026" rather than presenting a rating with no
       author. `distinct on` takes the state row in force at asOf, matching how
       the colour beside it was resolved. */
    q<{
      company_id: string; risk_grade: string | null;
      set_at: Date | string; set_by_name: string;
    }>(
      sql`select distinct on (cs.company_id)
                 cs.company_id, cs.risk_grade, cs.set_at, u.display_name as set_by_name
            from company_state cs
            join app_user u on u.user_id = cs.set_by
           where cs.effective_from <= ${asOf}::date
           order by cs.company_id, cs.effective_from desc, cs.company_state_id desc`,
    ),

    // Live acknowledgements only. An expired one is not filtered here -- the
    // metrics package compares `until_date` against its own asOf and is the
    // single place that decides (ADR-021) -- but a REVOKED one is gone for
    // good and has no business in the contract.
    q<{
      company_id: string; alert_key: string; reason: string;
      until_date: Date | string; acknowledged_value: string | null;
      acknowledged_by_name: string; acknowledged_at: Date | string;
    }>(
      sql`select a.company_id, a.alert_key, a.reason, a.until_date,
                 a.acknowledged_value, u.display_name as acknowledged_by_name,
                 a.acknowledged_at
            from alert_acknowledgement a
            join app_user u on u.user_id = a.acknowledged_by
           where a.revoked_at is null
           order by a.company_id, a.alert_acknowledgement_id`,
    ),
  ]);

  const fundRow = fundRows[0];
  if (!fundRow) throw new Error('No fund row. Run the reference seed and an import first.');

  const flags = groupBy(flagRows, (r) => r.company_id);
  const acks = groupBy(ackRows, (r) => r.company_id);
  const healthState = new Map(healthRows.map((r) => [r.company_id, r]));
  const rounds = groupBy(roundRows, (r) => r.company_id);
  const kpis = groupBy(kpiRows, (r) => r.company_id);
  const marks = groupBy(markRows, (r) => r.company_id);
  const milestones = groupBy(milestoneRows, (r) => r.company_id);
  const covenants = groupBy(covenantRows, (r) => r.company_id);
  const tasks = groupBy(taskRows, (r) => r.company_id);
  const cashflows = groupBy(cashflowRows, (r) => r.fund_investment_id);
  const gates = groupBy(gateRows, (r) => r.deal_id);
  const details = new Map(detailRows.map((r) => [r.company_id, r]));
  const thresholds = new Map(thresholdRows.map((r) => [r.company_id, r]));
  const reserves = new Map(reserveRows.map((r) => [r.company_id, r]));
  const boards = new Map(boardRows.map((r) => [r.company_id, r]));
  const gov = new Map(govRows.map((r) => [r.company_id, r]));
  const terms = new Map(termRows.map((r) => [r.deal_id, r]));

  const companies: Company[] = companyRows.map((c) => {
    const detail = details.get(c.company_id);
    const threshold = thresholds.get(c.company_id);
    const reserve = reserves.get(c.company_id);
    const board = boards.get(c.company_id);
    const govRow = gov.get(c.company_id);
    // Jobs and diversity are stored on the KPI series (ADR-010) and surface in
    // the contract as company scalars. The current period is the source.
    const latestKpi = kpis.get(c.company_id)?.[0];

    const company = {
      id: c.company_id,
      name: c.name,
      sector: c.sector_label ?? '',
      stage: c.stage ?? '',
      vintage: c.vintage_year ?? 0,
      health: c.health ?? '',
      instrument: detail?.instrument_label ?? '',
      ownershipPct: toNumber(c.ownership_pct) ?? 0,
      invested: toMillions(c.invested),
      fmv: toMillions(c.fmv),
      realized: toMillions(c.realized),
      exited: c.exited,
    } as Company;

    // Absent, not null, when the company has not exited.
    withOptional(company, 'exitDate', asDate(c.exit_date));
    withOptional(company, 'exitType', c.exit_type);

    // Health provenance. Absent where a company has no state row at all, which
    // is a company nobody has ever graded -- distinct from one graded ACC.
    const state = healthState.get(c.company_id);
    withOptional(company, 'riskGrade', state?.risk_grade);
    withOptional(company, 'healthSetBy', state?.set_by_name);
    withOptional(company, 'healthSetAt', asDate(state?.set_at ?? null));

    Object.assign(company, {
      ceo: detail?.ceo_name ?? '',
      hq: [c.hq_city, c.hq_region].filter(Boolean).join(', '),
      desc: detail?.description ?? '',
      // TWO ARRAYS FROM ONE ORDERED RESULT. The contract pairs them by index
      // (ADR-026: verbatim string for the contract, resolved key for logic),
      // so they are mapped from the same list in the same pass. Splitting the
      // source of either one is how they come to disagree.
      riskFlags: (flags.get(c.company_id) ?? []).map((f) => f.flag_text),
      riskFlagDetail: (flags.get(c.company_id) ?? []).map(
        (f): RiskFlagDetail => ({
          id: Number(f.company_risk_flag_id),
          category: f.category,
          categoryLabel: f.category_label,
          note: f.note,
          severity: (f.severity as 'red' | 'yellow' | null) ?? null,
          raisedAt: asDate(f.raised_at)!,
          raisedBy: f.raised_by_name,
        }),
      ),
      acknowledgements: (acks.get(c.company_id) ?? []).map(
        (a): AlertAcknowledgement => ({
          alertKey: a.alert_key,
          reason: a.reason,
          untilDate: asDate(a.until_date)!,
          // $M like every other money field. `null` for the metrics with no
          // numeric subject, and for cash -- which IS money -- the conversion
          // has to happen here, in the one place that does it (ADR-001).
          value: a.alert_key === 'metric:cash-balance'
            ? toMillions(a.acknowledged_value)
            : toNumber(a.acknowledged_value),
          by: a.acknowledged_by_name,
          at: asDate(a.acknowledged_at)!,
        }),
      ),
      proRata: c.pro_rata_rights ?? false,
      reservesAllocated: reserve ? toMillions(reserve.allocated) : 0,
      reservesDeployed: reserve ? toMillions(reserve.deployed) : 0,
      board: {
        seat: board?.seat_type ?? 'None',
        holder: board?.holder_name ?? '-',
        nextMeeting: asDate(board?.next_meeting_date ?? null),
      },
      kpis: (kpis.get(c.company_id) ?? []).map(
        (k): Kpi => ({
          period: toCalendarLabel(asDate(k.period_end)!),
          revenue: toMillions(k.revenue) ?? 0,
          burn: toMillions(k.monthly_burn) ?? 0,
          cash: toMillions(k.cash_balance) ?? 0,
          runwayMo: toNumber(k.runway_months) ?? 0,
          nrr: toNumber(k.net_revenue_retention),
        }),
      ),
      // ABSENT, NOT NULL, and the difference decides a watchlist: absent means
      // "inherit the fund policy", 0 means "disabled, deliberately". A null
      // here would collapse the two (see Thresholds in the contract).
      thresholds: (() => {
        const t = {};
        withOptional(t, 'minRunwayMo', threshold?.min_runway_months);
        withOptional(t, 'maxBurnMult', toNumber(threshold?.max_burn_multiple ?? null));
        withOptional(t, 'minCashBalance', toMillions(threshold?.min_cash_balance ?? null));
        withOptional(t, 'maxRevenueDeclinePct', toNumber(threshold?.max_revenue_decline_pct ?? null));
        withOptional(t, 'minNrrPct', toNumber(threshold?.min_nrr_pct ?? null));
        return t;
      })(),
      rounds: (rounds.get(c.company_id) ?? []).map((r): Round => ({
        date: asDate(r.round_date)!,
        label: r.label,
        instrument: r.instrument ?? '',
        invested: toMillions(r.invested),
        postMoney: toMillions(r.post_money),
        ownershipAfter: toNumber(r.ownership_after_pct) ?? 0,
        lead: r.lead_investor ?? '',
        note: r.note ?? '',
        roundTotal: toMillions(r.round_total),
        nbOther: toMillions(r.nb_other),
      })),
      milestones: (milestones.get(c.company_id) ?? []).map((m) => ({
        title: m.title,
        due: asDate(m.due_date) ?? '',
        status: m.status,
      })),
      covenants: (covenants.get(c.company_id) ?? []).map((v) => ({
        text: v.covenant_text,
        status: v.status_detail ?? v.status,
      })),
      govFunding: govRow
        ? {
            program: govRow.program_name,
            amount: toMillions(govRow.amount) ?? 0,
            conditions: govRow.conditions ?? '',
            status: govRow.status,
          }
        : null,
      marks: (marks.get(c.company_id) ?? []).map((m): ValuationMark => ({
        date: asDate(m.effective_date)!,
        fmv: toMillions(m.fmv),
        method: m.method_label,
        by: m.prepared_by_label,
        rationale: m.rationale,
      })),
      tasks: (tasks.get(c.company_id) ?? []).map((t) => ({
        title: t.title,
        due: asDate(t.due_date) ?? '',
        done: t.is_done,
      })),
      fteAtEntry: detail?.fte_at_entry ?? 0,
      // Two different absences, and they are not the same absence.
      //
      // No KPI row at all -- every exited company here -- means the company
      // never reported, and the contract carries 0. A KPI row that exists with
      // a NULL diversity field means the company reported and left it blank,
      // and that must stay null: rendering it as zero is precisely the error
      // D-5 exists to prevent ("0% of companies have women in the C-suite"
      // when the truth is "not asked").
      fte: toNumber(latestKpi?.fte ?? null) ?? 0,
      fteNB: toNumber(latestKpi?.fte_nb ?? null) ?? 0,
      womenCSuite: latestKpi === undefined ? 0 : latestKpi.women_csuite,
      cSuiteSize: latestKpi === undefined ? 0 : latestKpi.csuite_size,
      source: c.source_label ?? '',
    });

    return company;
  });

  const pipeline: PipelineDeal[] = dealRows.map((d) => {
    const t = terms.get(d.deal_id);
    const deal = {
      id: d.deal_id,
      name: d.name,
      sector: d.sector_label ?? '',
      funnel: d.funnel_label ?? '',
      source: d.source_label ?? '',
      checkSize: toMillions(d.check_size) ?? 0,
      // Null, not zero: an unvalued deal is one nobody has priced yet, and a
      // $0 valuation would be a claim rather than a gap. Two deals in the
      // reference dataset are in that state.
      valuation: toMillions(d.valuation) as number,
      owner: d.owner_label ?? '-',
      nextStep: d.next_step ?? '',
      added: asDate(d.date_added) ?? '',
    } as PipelineDeal;

    withOptional(deal, 'closedDate', asDate(d.closed_date));

    Object.assign(deal, {
      gates: (gates.get(d.deal_id) ?? []).map((g) => ({ name: g.gate_name, status: g.status })),
      termSheet: t
        ? {
            security: t.security ?? '',
            preMoney: toMillions(t.pre_money) ?? 0,
            postMoney: toMillions(t.post_money) ?? 0,
            investment: toMillions(t.investment) ?? 0,
            ownership: toNumber(t.ownership_pct) ?? 0,
            liquidation: t.liquidation_pref ?? '',
            antiDilution: t.anti_dilution ?? '',
            board: t.board_composition ?? '',
            proRata: t.pro_rata_terms ?? '',
            dividends: t.dividends ?? '',
            optionPool: t.option_pool ?? '',
            founderVesting: t.founder_vesting ?? '',
          }
        : null,
    });
    return deal;
  });

  const fundInvestments: FundInvestment[] = lpRows.map((f) => ({
    id: f.fund_investment_id,
    name: f.name,
    manager: f.manager_name,
    strategy: f.strategy ?? '',
    vintage: f.vintage_year ?? 0,
    committed: toMillions(f.committed),
    called: toMillions(f.called),
    distributions: toMillions(f.distributions),
    nav: toMillions(f.nav),
    coInvestRights: f.co_invest_rights,
    coInvestsDone: f.co_invests_done ?? 0,
    referrals: f.referrals ?? 0,
    capitalToDirect: toMillions(f.capital_to_direct) ?? 0,
    womenSeniorGP: f.women_senior_gp ?? false,
    nextCallEst: asDate(f.next_call_est),
    agm: asDate(f.agm_date),
    contact: f.ir_contact ?? '',
    rationale: f.rationale ?? '',
    cashflows: (cashflows.get(f.fund_investment_id) ?? []).map((cf) => ({
      date: asDate(cf.txn_date)!,
      // Direction is implied by txn_type in storage and by sign in the
      // contract: a call is negative, a distribution positive.
      amount: (cf.txn_type === 'capital_call' ? -1 : 1) * toMillions(cf.amount),
    })),
  }));

  const memos: Record<string, Record<string, string>> = {};
  for (const m of memoRows) {
    (memos[m.subject_id] ??= {})[m.section_key] = m.body ?? '';
  }

  // Derived, not stored (ADR-002). The year comes from the as-at date rather
  // than the clock, so a re-run reproduces itself and the figure does not
  // silently reset on 1 January.
  const asOfYear = asOf.slice(0, 4);
  const ytdPlatformsClosed = dealRows.filter(
    (d) => d.funnel_label === 'Closed' && (asDate(d.closed_date) ?? '').startsWith(asOfYear),
  ).length;

  return {
    fund: {
      name: fundRow.name,
      currency: fundRow.reporting_currency,
      vintage: fundRow.inception_year,
      style: fundRow.style as 'evergreen' | 'closed-end',
      capitalBase: toMillions(fundRow.capital_base) ?? 0,
      committed: toMillions(fundRow.committed) ?? 0,
      called: toMillions(fundRow.called) ?? 0,
      distributionPolicy: fundRow.distribution_policy ?? '',
      feeDragPct: toNumber(fundRow.fee_drag_pct) ?? 0,
      navHistory: navRows.map((n) => ({
        q: toCalendarLabel(asDate(n.period_end)!),
        nav: toMillions(n.nav),
        cost: toMillions(n.cumulative_cost),
      })),
      annualPlatformTarget: fundRow.annual_platform_target ?? 0,
      annualFollowOnBudget: toMillions(fundRow.annual_followon_budget) ?? 0,
      ytdPlatformsClosed,
      reservesPolicy: fundRow.reserves_policy ?? '',
      distributions: distRows.map((d) => ({
        date: asDate(d.distribution_date)!,
        amount: toMillions(d.amount),
        company: d.company_label,
        note: d.note ?? '',
      })),
    },
    companies,
    pipeline,
    fundInvestments,
    memos,
    funnelGroups: funnelGroupRows.map((g) => ({
      name: g.name,
      isTerminal: g.is_terminal,
      showOnBoard: g.show_on_board,
      stages: g.stages,
    })),
    // Null when no policy has ever been set, which is the state a fresh
    // database is in and is NOT the same as a policy of zeroes. A consumer
    // that finds this absent reads per-company thresholds alone.
    alertPolicy: policyRows[0]
      ? {
          minRunwayMo: policyRows[0].min_runway_months,
          maxBurnMult: toNumber(policyRows[0].max_burn_multiple),
          minCashBalance: toMillions(policyRows[0].min_cash_balance),
          maxRevenueDeclinePct: toNumber(policyRows[0].max_revenue_decline_pct),
          minNrrPct: toNumber(policyRows[0].min_nrr_pct),
          effectiveFrom: asDate(policyRows[0].effective_from)!,
          setBy: policyRows[0].set_by_name,
          note: policyRows[0].note,
        }
      : null,
    meta: {
      // 3, not 2: alertPolicy, three more Thresholds fields, riskFlagDetail,
      // acknowledgements and Kpi.nrr (A9, ADR-032). The reference fixture
      // stays at 1 -- it is the prototype's own boot state and re-exporting it
      // would invalidate every golden-master fixture (ADR-022) -- so the two
      // legitimately differ, and every addition since 1 is optional precisely
      // so that they can.
      schemaVersion: 3,
      // The prototype's localStorage save stamp. The platform generates an
      // export on demand and has nothing to report here; A11's board PDF
      // carries its own as-at date, which is the stamp that matters (ADR-007).
      savedAt: null,
      demo: syntheticRows[0]?.contains_synthetic ?? false,
    },
  };
}
