/**
 * A6's generator: writes the synthetic financial spine onto the REAL roster.
 *
 *   npm run db:generate            generate, reconcile, commit
 *   npm run db:generate -- --dry   generate, reconcile, roll back
 *
 * FIVE RULES, each stated here because each one is load-bearing.
 *
 * 1. **The control totals are the contract.** Every company's generated
 *    transactions sum to `company.affinity_total_investment` and its final mark
 *    equals `company.affinity_fmv`, exactly, to the cent. `reconcile()` checks
 *    every company after the write and ABORTS THE TRANSACTION if any row
 *    disagrees. A generator that silently produced a portfolio worth $41M
 *    against a real $42M would be worse than no generator.
 *
 * 2. **It reads its targets from the database, not from the spreadsheet.**
 *    Those two columns are synced nightly from Affinity by the A4 job, so a
 *    correction made in Affinity today is picked up by a regeneration tomorrow
 *    with no file to re-export. The workbooks seeded `data/investment_vehicle.json`
 *    and `data/lp_fund.json` once, and only because neither figure exists in
 *    Affinity's field metadata at all.
 *
 * 3. **It never touches real data.** `company`, `company_kpi`, `pipeline_deal`
 *    and everything else the Affinity and Visible syncs own are read-only here,
 *    with two deliberate exceptions that are genuinely ours to fill:
 *    `company.instrument_label` / `fte_at_entry` (ADR-027 stored facts) and
 *    `company_state.stage_id`, which no sync populates and which was NULL on all
 *    82 rows.
 *
 * 4. **It is idempotent and it deletes only its own rows.** Generated rows are
 *    identified by `is_synthetic` where that column exists and by authorship
 *    against the system principal where it does not, so an allocation a person
 *    edited through the judgement path survives a regeneration.
 *
 * 5. **Every financial row carries `is_synthetic` (ADR-020).** That is what
 *    drives `v_synthetic_data_status.contains_synthetic`, and with it the
 *    persistent banner on every screen and every PDF. A13 verifies it reads
 *    zero before go-live.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { loadEnv, requireDatabaseUrl } from '../env.js';
import { planCompany, toCents, toDollars, type CompanyFacts, type CompanyPlan } from './plan.js';
import { planLpPositions, type LpFactsInput } from './lp.js';
import { planDirt, NEAR_MISS_NAME, type Defect } from './dirt.js';
import { Rng } from './rng.js';

loadEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../../data');
const SYSTEM_USER = '00000000-0000-0000-0000-000000000001';
const DRY = process.argv.includes('--dry');

/**
 * The as-of date the whole dataset is built around.
 *
 * The final FMV exercise (ADR-007 puts the cutoffs at end of January and end of
 * July), and therefore the date `resolveAsOf` will derive from the data and the
 * date the control totals are asserted at. Affinity's figures were synced
 * 13 August 2026, so the July exercise is the one they represent.
 */
const AS_OF = '2026-07-31';

// --- inputs ---------------------------------------------------------------

interface VehicleFile {
  vehicles: { affinity_org_id: string; name: string; vehicle: string | null }[];
}
interface LpFile {
  controlTotals: { committed: number; called: number; remaining: number };
  funds: LpFactsInput[];
}

const vehicleFile = JSON.parse(
  readFileSync(path.join(dataDir, 'investment_vehicle.json'), 'utf8'),
) as VehicleFile;
const lpFile = JSON.parse(readFileSync(path.join(dataDir, 'lp_fund.json'), 'utf8')) as LpFile;

const vehicleByOrgId = new Map(
  vehicleFile.vehicles.map((v) => [v.affinity_org_id, v.vehicle]),
);

// --- helpers --------------------------------------------------------------

const money = (n: number) =>
  `$${(n / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const client = new pg.Client({ connectionString: requireDatabaseUrl() });
await client.connect();
// SESSION level, not `set local`: the report runs after the commit, and a
// `set local` would have expired with the transaction that set it.
await client.query('set search_path = pc, public');

// ADR-031. The version-capture trigger raises unless the session names an
// actor, so the generator names itself. Session level for the same reason as
// the search_path above, and it must be set before the clear-down below
// issues its first DELETE.
//
// This is also the value the trigger's one exemption keys on: a DELETE of a
// synthetic row by THIS user is not versioned, because regenerating the demo
// dataset is not a financial edit and would otherwise write thousands of
// version rows per run. Nothing else is exempt -- see migration 0002.
await client.query(`set pc.actor_id = '${SYSTEM_USER}'`);

const counts: Record<string, number> = {};
const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
const cleared: Record<string, number> = {};
const notes: string[] = [];
const skipped: string[] = [];
let defects: Defect[] = [];
let summary: Summary | null = null;

/**
 * `ref_risk_flag_category` by code, for `writeMonitoring`.
 *
 * At module scope because that function is top-level and takes no lookup maps,
 * matching how `vehicleByOrgId` above is shared. Populated inside the
 * transaction with the other reference lookups.
 */
let riskFlagCategories = new Map<string, number>();

try {
  await client.query('begin');

  // --- reference lookups -------------------------------------------------
  const lookup = async (table: string, key: string, nameCol = 'name') => {
    const { rows } = await client.query<{ id: number; name: string }>(
      `select ${key} as id, ${nameCol} as name from ${table}`,
    );
    return new Map(rows.map((r) => [r.name, r.id]));
  };
  const instruments = await lookup('ref_instrument', 'instrument_id');
  const stages = await lookup('ref_stage', 'stage_id');
  const methods = await lookup('ref_valuation_method', 'valuation_method_id');
  const vehicles = await lookup('ref_investment_vehicle', 'investment_vehicle_id', 'code');
  riskFlagCategories = await lookup('ref_risk_flag_category', 'risk_flag_category_id', 'code');

  if (vehicles.size === 0) {
    throw new Error('ref_investment_vehicle is empty. Run `npm run db:seed` first.');
  }
  if (riskFlagCategories.size === 0) {
    throw new Error('ref_risk_flag_category is empty. Run `npm run db:seed` first.');
  }

  // --- read the real facts ------------------------------------------------
  const { rows: companyRows } = await client.query<{
    company_id: string;
    affinity_org_id: string | null;
    name: string;
    year_founded: number | null;
    affinity_total_investment: string | null;
    affinity_fmv: string | null;
    risk_grade: string | null;
    lifecycle_status: string | null;
    first_kpi_year: number | null;
  }>(`
    select c.company_id, c.affinity_org_id, c.name, c.year_founded,
           c.affinity_total_investment, c.affinity_fmv,
           cs.risk_grade, cs.lifecycle_status,
           k.first_kpi_year
      from company c
      left join company_state cs
             on cs.company_id = c.company_id and cs.effective_to is null
      left join lateral (
             select extract(year from min(period_end))::int as first_kpi_year
               from company_kpi where company_id = c.company_id) k on true
     order by c.company_id`);

  if (companyRows.length === 0) {
    throw new Error('No companies on the roster. Run `npm run affinity:sync` first.');
  }

  const facts: CompanyFacts[] = [];
  for (const r of companyRows) {
    if (r.affinity_total_investment === null) {
      skipped.push(`${r.company_id} ${r.name} — no Total Investment Amount in Affinity`);
      continue;
    }
    facts.push({
      companyId: r.company_id,
      name: r.name,
      yearFounded: r.year_founded,
      investedCents: toCents(r.affinity_total_investment),
      fmvCents: toCents(r.affinity_fmv ?? 0),
      riskGrade: r.risk_grade,
      lifecycleStatus: r.lifecycle_status,
      vehicle: r.affinity_org_id ? (vehicleByOrgId.get(r.affinity_org_id) ?? null) : null,
      firstKpiYear: r.first_kpi_year,
    });
  }

  const noVehicle = facts.filter((f) => f.vehicle === null);
  if (noVehicle.length) {
    notes.push(
      `${noVehicle.length} companies have no vehicle attribution and are written with a NULL ` +
        `investment_vehicle_id, never a default: ${noVehicle.map((f) => f.name).join(', ')}. ` +
        `They are absent from the Status-filtered export the Fund column came from.`,
    );
  }

  // --- plan ---------------------------------------------------------------
  // The LP roster is known before the companies are planned, so a round can
  // name a fund we are genuinely an LP in and the FK resolves on exact match.
  const lpFundNames = lpFile.funds.map((f) => f.name).filter((n) => n !== 'Accelerators');

  const plans = new Map<string, CompanyPlan>();
  for (const f of facts) plans.set(f.companyId, planCompany(f, lpFundNames));

  const namesById = new Map(facts.map((f) => [f.companyId, f.name]));
  const dirt = planDirt(plans, namesById);
  defects = dirt.defects;
  const lpPlans = planLpPositions(lpFile.funds);

  // --- clear previously generated rows ------------------------------------
  // Scoped, never a blanket truncate: `is_synthetic` where the column exists,
  // authorship against the system principal where it does not, so a human edit
  // through the judgement path survives a regeneration.
  const clear = async (sql: string, label: string) => {
    const r = await client.query(sql);
    if (r.rowCount) cleared[label] = r.rowCount;
  };
  await clear(`delete from transaction where is_synthetic`, 'transaction');
  await clear(`delete from valuation_mark where is_synthetic`, 'valuation_mark');
  await clear(`delete from investment_round where is_synthetic`, 'investment_round');
  await clear(`delete from company_ownership where is_synthetic`, 'company_ownership');
  await clear(`delete from fund_investment_nav where is_synthetic`, 'fund_investment_nav');
  await clear(`delete from reserve_allocation where set_by = '${SYSTEM_USER}'`, 'reserve_allocation');
  await clear(`delete from company_exit where recorded_by = '${SYSTEM_USER}'`, 'company_exit');
  await clear(`delete from company_threshold where updated_by = '${SYSTEM_USER}'`, 'company_threshold');
  await clear(`delete from company_risk_flag where raised_by = '${SYSTEM_USER}'`, 'company_risk_flag');
  await clear(`delete from company_milestone where updated_by = '${SYSTEM_USER}'`, 'company_milestone');
  await clear(`delete from company_gov_funding where updated_by = '${SYSTEM_USER}'`, 'company_gov_funding');
  await clear(`delete from board_seat`, 'board_seat');
  await clear(`delete from fund_investment`, 'fund_investment');
  // Never clears a FROZEN snapshot: once a board report has been issued the
  // numbers in it are history and a regeneration must not restate them.
  await clear(`delete from fund_nav_snapshot where frozen_at is null`, 'fund_nav_snapshot');

  // --- write the direct portfolio ----------------------------------------
  const roundIdByKey = new Map<string, number>();

  for (const f of facts) {
    const plan = plans.get(f.companyId)!;
    const vehicleId = plan.rounds[0]?.vehicle ? (vehicles.get(plan.rounds[0].vehicle) ?? null) : null;

    for (const r of plan.rounds) {
      // The deliberate impossible round: whole round smaller than our cheque.
      const roundTotal =
        dirt.roundTotalBelowCheque.has(f.companyId) && r.index === plan.rounds.length - 1
          ? Math.round(r.chequeCents * 0.7)
          : r.roundTotalCents;

      // ADR-033. Resolved AT INSERT rather than by a pass afterwards, and both
      // halves of that matter.
      //
      // At insert, because the evidence is already in the plan: every planned
      // round that has a cheque has a PlannedTransaction carrying its index, so
      // the same rule migration 0008's backfill applied to rows in the database
      // applies here to rows about to be written. Nothing is assumed.
      //
      // Not by a pass afterwards, because an UPDATE is NOT exempt from the
      // version trigger even for synthetic rows (migration 0002 is explicit
      // that only INSERT and DELETE are). A closing sweep would write a version
      // row per round on every `npm run db:generate` and would set
      // `row_updated_at`, making the whole synthetic spine display an "edited"
      // pill it has not earned.
      //
      // Without this the F1 backfill would be silently undone by the next
      // `db:generate`, which deletes and reinserts the entire spine -- the same
      // trap F0 hit with `instrument_id`, and an exit criterion that holds only
      // until someone runs `db:reset` is not one.
      const participated = plan.transactions.some((t) => t.roundIndex === r.index)
        ? 'yes'
        : 'unknown';

      const { rows } = await client.query<{ investment_round_id: string }>(
        `insert into investment_round
           (company_id, round_date, label, instrument_id, investment_vehicle_id,
            is_synthetic, round_total, nb_other, post_money, ownership_after_pct,
            lead_investor, note, captured_by, captured_at, nbif_participated)
         values ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11,$12, now(), $13)
         returning investment_round_id`,
        [
          f.companyId,
          r.date,
          r.label,
          instruments.get(r.instrument) ?? instruments.get('Preferred Equity')!,
          vehicleId,
          roundTotal === null ? null : toDollars(roundTotal),
          r.nbOtherCents === null || roundTotal === null
            ? null
            : toDollars(Math.min(r.nbOtherCents, roundTotal)),
          r.postMoneyCents === null ? null : toDollars(r.postMoneyCents),
          r.ownershipAfterPct.toFixed(10),
          r.lead,
          r.note || null,
          SYSTEM_USER,
          participated,
        ],
      );
      const roundId = Number(rows[0]!.investment_round_id);
      roundIdByKey.set(`${f.companyId}:${r.index}`, roundId);
      bump('investment_round');

      for (const co of r.coinvestors) {
        await client.query(
          `insert into round_coinvestor (investment_round_id, investor_name, is_nb_based, amount, is_synthetic)
           values ($1,$2,$3,$4,true)`,
          [roundId, co.name, co.isNb, co.amountCents === null ? null : toDollars(co.amountCents)],
        );
        bump('round_coinvestor');
      }

      // The near-miss name: one character away from an LP position we hold, so
      // exact-match resolution (ADR-026) correctly refuses to link it.
      if (dirt.nearMissCoinvestor.has(f.companyId) && r.index === 0) {
        await client.query(
          `insert into round_coinvestor (investment_round_id, investor_name, is_nb_based, amount, is_synthetic)
           values ($1,$2,true,$3,true)`,
          [roundId, NEAR_MISS_NAME, toDollars(25_000_00)],
        );
        bump('round_coinvestor');
      }
    }

    // --- transactions ---
    const usdTarget = dirt.usdTranche.has(f.companyId) ? plan.rounds.length - 1 : -1;
    for (const t of plan.transactions) {
      const roundId =
        t.roundIndex === null ? null : (roundIdByKey.get(`${f.companyId}:${t.roundIndex}`) ?? null);
      const txnVehicle = t.vehicle ? (vehicles.get(t.vehicle) ?? null) : null;

      if (t.roundIndex === usdTarget && t.type !== 'write_off') {
        // Split into a USD tranche plus a CAD remainder. 1.35 times a whole
        // number of dollars is exact to the cent, so `amount * fx_rate_to_cad`
        // reconciles without a rounding allowance.
        const rate = 1.35;
        const usdDollars = Math.floor(t.amountCents / 100 / rate);
        const cadFromUsd = Math.round(usdDollars * rate * 100);
        const remainder = t.amountCents - cadFromUsd;

        await insertTxn(t.date, t.type, usdDollars * 100, 'USD', rate, f.companyId, roundId, txnVehicle,
          'USD tranche, settled at the closing rate.');
        bump('transaction');
        if (remainder > 0) {
          await insertTxn(t.date, t.type, remainder, 'CAD', null, f.companyId, roundId, txnVehicle,
            'CAD balance of the same tranche.');
          bump('transaction');
        }
        continue;
      }

      await insertTxn(t.date, t.type, t.amountCents, 'CAD', null, f.companyId, roundId, txnVehicle, t.note);
      bump('transaction');
    }

    // --- the duplicate cheque, and the reversal that voids it ---
    // The pre-ADR-031 correction shape. Today Finance would soft-delete this;
    // the reversal path stays exercised because historical data still uses it.
    const dup = dirt.duplicates.find((d) => d.companyId === f.companyId);
    if (dup) {
      const t = plan.transactions[dup.transactionIndex]!;
      const roundId =
        t.roundIndex === null ? null : (roundIdByKey.get(`${f.companyId}:${t.roundIndex}`) ?? null);
      const txnVehicle = t.vehicle ? (vehicles.get(t.vehicle) ?? null) : null;

      const dupId = await insertTxn(t.date, t.type, t.amountCents, 'CAD', null, f.companyId, roundId,
        txnVehicle, 'DUPLICATE — the same cheque booked twice from the bank file.');
      const revId = await insertTxn(t.date, t.type, t.amountCents, 'CAD', null, f.companyId, roundId,
        txnVehicle, 'Reversal of a duplicated cheque.', dupId);
      await client.query(
        `update transaction
            set voided_by_transaction_id = $1, voided_at = now(),
                voided_reason = 'Duplicate of an earlier booking; reversed. Pre-ADR-031 correction shape.'
          where transaction_id = $2`,
        [revId, dupId],
      );
      bump('transaction', 2);
    }

    // --- marks ---
    for (const m of plan.marks) {
      await insertMark(f.companyId, m.date, m.fmvCents, m.method, m.preparedByLabel, m.rationale,
        'final', methods);
      bump('valuation_mark');
    }

    if (dirt.markBeforeInvestment.has(f.companyId)) {
      // Eighteen months before the first cheque. Nothing forbids it, and
      // company_fmv_asof will return it for an as-of date in that window.
      const first = new Date(`${plan.rounds[0]!.date}T00:00:00Z`);
      first.setUTCMonth(first.getUTCMonth() - 18);
      await insertMark(f.companyId, first.toISOString().slice(0, 10), Math.round(plan.rounds[0]!.chequeCents * 0.9),
        'Last round', 'Director of Finance',
        'Mark carried over from a predecessor holding. Effective date precedes our first cheque.',
        'final', methods);
      bump('valuation_mark');
    }

    if (dirt.supersededMark.has(f.companyId) && plan.marks.length > 1) {
      const m = plan.marks[plan.marks.length - 2]!;
      const { rows } = await client.query<{ valuation_mark_id: string }>(
        `select valuation_mark_id from valuation_mark
          where company_id = $1 and effective_date = $2 and status = 'final'`,
        [f.companyId, m.date],
      );
      if (rows[0]) {
        await client.query(
          `insert into valuation_mark
             (company_id, effective_date, fmv, method_label, rationale, prepared_by_label,
              is_synthetic, status, supersedes_id)
           values ($1,$2,$3,$4,$5,$6,true,'superseded',$7)`,
          [
            f.companyId,
            m.date,
            toDollars(Math.round(m.fmvCents * 1.18)),
            'Last round',
            'Superseded. Original exercise used a stale cap table; corrected on review.',
            'Finance Analyst',
            Number(rows[0].valuation_mark_id),
          ],
        );
        bump('valuation_mark');
      }
    }

    // --- ownership, reserves, exit ---
    for (const o of plan.ownership) {
      await client.query(
        `insert into company_ownership
           (company_id, as_of_date, ownership_pct, pro_rata_rights, is_synthetic, entered_by)
         values ($1,$2,$3,$4,true,$5)
         on conflict (company_id, as_of_date) do nothing`,
        [f.companyId, o.date, o.pct.toFixed(10), o.proRata, SYSTEM_USER],
      );
      bump('company_ownership');
    }

    if (plan.reserve) {
      await client.query(
        `insert into reserve_allocation (company_id, allocated, deployed, policy_basis, effective_from, set_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          f.companyId,
          toDollars(plan.reserve.allocatedCents),
          toDollars(plan.reserve.deployedCents),
          plan.reserve.basis,
          AS_OF,
          SYSTEM_USER,
        ],
      );
      bump('reserve_allocation');
    }

    if (plan.exit) {
      await client.query(
        `insert into company_exit (company_id, exit_date, exit_type, note, recorded_by)
         values ($1,$2,$3,$4,$5)`,
        [f.companyId, plan.exit.date, plan.exit.type, plan.exit.note, SYSTEM_USER],
      );
      bump('company_exit');
    }

    if (plan.thresholds) {
      await client.query(
        `insert into company_threshold (company_id, min_runway_months, max_burn_multiple, updated_by)
         values ($1,$2,$3,$4)`,
        [f.companyId, plan.thresholds.minRunwayMo, plan.thresholds.maxBurnMult?.toFixed(2), SYSTEM_USER],
      );
      bump('company_threshold');
    }

    // --- ADR-027 stored facts, and the stage nothing else populates ---
    await client.query(
      `update company
          set instrument_id = $2, instrument_label = $3, fte_at_entry = $4
        where company_id = $1`,
      [
        f.companyId,
        instruments.get(plan.headlineInstrument) ?? null,
        plan.headlineInstrument,
        plan.fteAtEntry,
      ],
    );
    await client.query(
      `update company_state set stage_id = $2 where company_id = $1 and effective_to is null`,
      [f.companyId, stages.get(plan.stage) ?? null],
    );

    await writeMonitoring(f, plan);
  }

  // --- the cross-company round reference ---------------------------------
  // Repoints an EXISTING transaction rather than adding one, so the company's
  // control total is untouched and only the round-level attribution is wrong --
  // which is the defect, and which the export adapter's per-round `invested`
  // sum picks up.
  for (const id of dirt.crossCompanyRound) {
    const donor = [...roundIdByKey.entries()].find(([k]) => !k.startsWith(`${id}:`));
    if (!donor) continue;
    await client.query(
      `update transaction set investment_round_id = $2,
              note = 'Booked against the wrong round on import. Company attribution is correct.'
        where transaction_id = (
          select transaction_id from transaction
           where company_id = $1 and txn_type in ('investment','follow_on')
             and voided_at is null and reverses_transaction_id is null
           order by txn_date desc limit 1)`,
      [id, donor[1]],
    );
  }

  // --- fund NAV history ---------------------------------------------------
  //
  // COMPUTED, not invented: `fund_nav_snapshot` is defined as NAV and
  // cumulative cost derived from the marks and transactions and then frozen on
  // issue, so the generator derives it the same way rather than drawing a
  // curve. Quarterly from the first cheque to the last completed quarter.
  //
  // `frozen_at` stays NULL. Nothing has been issued to a board, and a snapshot
  // that claims to be frozen is a claim that a report went out.
  //
  // Without these rows `fund.navHistory` is empty, which reads on screen as an
  // FMV growth KPI of "-" and an empty trajectory chart -- the two dashboard
  // tiles that are about change over time rather than position today.
  await client.query(
    `insert into fund_nav_snapshot (fund_id, period_end, nav, cumulative_cost)
     select f.fund_id,
            q.period_end,
            (select coalesce(sum(company_fmv_asof(c.company_id, q.period_end)), 0) from company c),
            (select coalesce(sum(t.amount_cad), 0) from v_transaction_live t
              where t.company_id is not null
                and t.txn_type in ('investment','follow_on')
                and t.txn_date <= q.period_end)
       from fund f,
            lateral (
              select (d + interval '3 month' - interval '1 day')::date as period_end
                from generate_series(
                       date_trunc('quarter',
                         (select min(txn_date) from v_transaction_live where company_id is not null)),
                       date_trunc('quarter', $1::date) - interval '3 month',
                       interval '3 month') d
            ) q
      on conflict (fund_id, period_end) do update
        set nav = excluded.nav, cumulative_cost = excluded.cumulative_cost, computed_at = now()`,
    [AS_OF],
  );
  const navCount = await client.query(`select count(*)::int as n from fund_nav_snapshot`);
  bump('fund_nav_snapshot', (navCount.rows[0] as { n: number }).n);

  // --- LP positions -------------------------------------------------------
  for (const lp of lpPlans) {
    await client.query(
      `insert into fund_investment
         (fund_investment_id, name, manager_name, strategy, vintage_year, committed, currency,
          co_invest_rights, women_senior_gp, next_call_est, agm_date, ir_contact, rationale, created_by)
       values ($1,$2,$3,$4,$5,$6,'CAD',$7,null,$8,$9,$10,$11,$12)`,
      [
        lp.fundInvestmentId, lp.name, lp.managerName, lp.strategy, lp.vintageYear,
        toDollars(lp.committedCents), lp.coInvestRights, lp.nextCallEst, lp.agmDate,
        lp.irContact, lp.rationale, SYSTEM_USER,
      ],
    );
    bump('fund_investment');

    for (const c of lp.calls) {
      await client.query(
        `insert into transaction
           (txn_date, txn_type, fund_investment_id, amount, currency, note, entered_by, is_synthetic)
         values ($1,'capital_call',$2,$3,'CAD',$4,$5,true)`,
        [c.date, lp.fundInvestmentId, toDollars(c.amountCents), c.note, SYSTEM_USER],
      );
      bump('transaction');
    }

    for (const n of lp.navs) {
      await client.query(
        `insert into fund_investment_nav
           (fund_investment_id, as_of_date, nav, is_synthetic, statement_received_at, entered_by)
         values ($1,$2,$3,true,$4,$5)`,
        [lp.fundInvestmentId, n.date, toDollars(n.navCents), n.receivedAt, SYSTEM_USER],
      );
      bump('fund_investment_nav');
    }
  }

  // --- link co-investors to the LP positions we actually hold -------------
  // Now that fund_investment exists, an exact name match resolves the FK and
  // v_lp_capital_to_direct has something real to aggregate. Exact match ONLY
  // (ADR-026) -- which is exactly why the near-miss row stays NULL.
  const linked = await client.query(
    `update round_coinvestor rc
        set fund_investment_id = fi.fund_investment_id
       from fund_investment fi
      where rc.investor_name = fi.name and rc.fund_investment_id is null`,
  );
  if (linked.rowCount) bump('round_coinvestor linked', linked.rowCount);

  /**
   * The three CARRIED mandate fields (ADR-027).
   *
   * `capital_to_direct`, `co_invests_done` and `referrals` are stored on the LP
   * position rather than derived, because legacy positions predate the ADR-012
   * capture form and an imported value is the only value there is. A8 replaces
   * this with `v_lp_capital_to_direct` reading live capture data.
   *
   * Here they are set from the co-investor rows the generator itself just
   * wrote, so the stored figure and the derivable one agree. Without it the
   * Funds tab reads "CAPITAL TO DIRECT $0.0M / 0 co-invests" while sixty-two
   * co-investments sit in the table underneath it, which is a mandate KPI
   * reporting zero against data that contradicts it.
   */
  const carried = await client.query(
    `update fund_investment fi
        set capital_to_direct = d.amount,
            co_invests_done   = d.deals,
            referrals         = greatest(0, d.deals - (d.deals / 3))
       from (select rc.fund_investment_id,
                    sum(rc.amount)                as amount,
                    count(distinct r.company_id)  as deals
               from round_coinvestor rc
               join investment_round r using (investment_round_id)
              where rc.fund_investment_id is not null
              group by 1) d
      where d.fund_investment_id = fi.fund_investment_id`,
  );
  if (carried.rowCount) bump('lp mandate fields set', carried.rowCount);

  // --- reconcile ----------------------------------------------------------
  const failures = await reconcile();

  // Captured INSIDE the transaction, so `--dry` reports what it would have
  // produced rather than what is still on disk from the last committed run.
  summary = await summarise();

  if (failures.length) {
    console.error(`\n  !! RECONCILIATION FAILED on ${failures.length} companies. Rolling back.\n`);
    for (const f of failures.slice(0, 20)) console.error(`     ${f}`);
    await client.query('rollback');
    process.exitCode = 1;
  } else if (DRY) {
    await client.query('rollback');
  } else {
    await client.query('commit');
  }

  await report(failures.length === 0);
} catch (err) {
  await client.query('rollback').catch(() => undefined);
  throw err;
} finally {
  await client.end();
}

// --- writers ---------------------------------------------------------------

async function insertTxn(
  date: string,
  type: string,
  amountCents: number,
  currency: string,
  fx: number | null,
  companyId: string,
  roundId: number | null,
  vehicleId: number | null,
  note: string | null,
  reverses?: number,
): Promise<number> {
  // `instrument_id` is resolved in the INSERT rather than passed in, and it is
  // the same rule migration 0006's backfill applied: the instrument of the
  // round this cheque is linked to, where a link exists, and NULL otherwise.
  //
  // It is here rather than as a tenth argument because it is a derivation, not
  // a decision the plan makes -- and because without it the F0 backfill would
  // be silently undone by the next `npm run db:generate`, which deletes and
  // reinserts the whole synthetic spine. An exit criterion that holds until
  // someone runs `db:reset` is not one.
  const { rows } = await client.query<{ transaction_id: string }>(
    `insert into transaction
       (txn_date, txn_type, company_id, investment_round_id, investment_vehicle_id,
        amount, currency, fx_rate_to_cad, note, entered_by, is_synthetic, reverses_transaction_id,
        instrument_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,
             (select r.instrument_id from investment_round r
               where r.investment_round_id = $4))
     returning transaction_id`,
    [date, type, companyId, roundId, vehicleId, toDollars(amountCents), currency,
      fx === null ? null : fx.toFixed(8), note, SYSTEM_USER, reverses ?? null],
  );
  return Number(rows[0]!.transaction_id);
}

async function insertMark(
  companyId: string,
  date: string,
  fmvCents: number,
  method: string,
  by: string,
  rationale: string,
  status: string,
  methods: Map<string, number>,
) {
  await client.query(
    `insert into valuation_mark
       (company_id, effective_date, fmv, valuation_method_id, method_label, rationale,
        prepared_by_label, is_synthetic, status)
     values ($1,$2,$3,$4,$5,$6,$7,true,$8)
     on conflict do nothing`,
    [companyId, date, toDollars(fmvCents), methods.get(method) ?? null, method, rationale, by, status],
  );
}

/**
 * Monitoring and governance rows.
 *
 * Not financial, so they are drawn from a SEPARATE seeded stream (salt 7):
 * adding a milestone must not reshuffle a company's cheque history. Risk flags
 * key off the real Affinity risk grade, so the flags a company carries match
 * the health the roster actually reports.
 */
async function writeMonitoring(f: CompanyFacts, plan: CompanyPlan) {
  const rng = new Rng(f.companyId, 7);

  /**
   * The flag pool, each entry carrying its ADR-032 category.
   *
   * THE CATEGORY IS EXPLICIT, NOT CLASSIFIED. `classify_risk_flag_category` in
   * migration 0005 exists to map LEGACY free text onto the vocabulary, and its
   * own comment names its two callers -- that migration's backfill, and the
   * ADR-001 fixture importer, which loads schemaVersion 1 documents whose flags
   * have no category. The A9 form does not use it, because a person raising a
   * flag picks the category. The generator is in the form's position rather
   * than the migration's: it is authoring these rows, not interpreting rows
   * somebody else wrote, and it knows what each one means.
   *
   * The practical difference is what happens to a flag string added here later.
   * Through the classifier, an unmatched string falls silently to `other` and
   * the demo data quietly degrades. Written out, it is a missing key -- caught
   * by the compiler, or by the throw below.
   *
   * (Checked against the classifier as it stands: all nine of these resolve to
   * exactly the codes given here, so this changes no existing demo row.)
   */
  const FLAGS_BY_GRADE: Record<string, { text: string; category: string }[]> = {
    C: [
      { text: 'Runway below policy', category: 'runway' },
      { text: 'Key-person dependency', category: 'key-person' },
      { text: 'Missed revenue plan two quarters running', category: 'revenue' },
      { text: 'Down round risk at next financing', category: 'financing' },
      { text: 'Covenant headroom thin', category: 'covenant' },
    ],
    B: [
      { text: 'Concentration in top customer', category: 'customer-concentration' },
      { text: 'Hiring plan behind schedule', category: 'team' },
      { text: 'Slower pipeline conversion', category: 'revenue' },
    ],
    A: [{ text: 'Scaling ahead of process maturity', category: 'team' }],
    ACC: [],
  };
  const pool = FLAGS_BY_GRADE[f.riskGrade ?? 'B'] ?? FLAGS_BY_GRADE.B!;
  const flagCount = f.riskGrade === 'C' ? rng.int(1, 3) : rng.chance(0.45) ? 1 : 0;
  const used = new Set<string>();
  for (let i = 0; i < flagCount && pool.length; i++) {
    const flag = rng.pick(pool);
    if (used.has(flag.text)) continue;
    used.add(flag.text);
    const categoryId = riskFlagCategories.get(flag.category);
    if (categoryId === undefined) {
      throw new Error(
        `Risk flag "${flag.text}" names category "${flag.category}", which is not in ` +
          'ref_risk_flag_category. Add it to the vocabulary in a migration, or correct the code here.',
      );
    }
    await client.query(
      `insert into company_risk_flag (company_id, flag_text, risk_flag_category_id, raised_at, raised_by)
       values ($1,$2,$3,$4,$5)`,
      [f.companyId, flag.text, categoryId, AS_OF, SYSTEM_USER],
    );
    bump('company_risk_flag');
  }

  if (!plan.exit && rng.chance(0.55)) {
    await client.query(
      `insert into board_seat (company_id, seat_type, holder_name, next_meeting_date, effective_from)
       values ($1,$2,$3,$4,$5)`,
      [
        f.companyId,
        // An accelerator cheque does not buy a board seat; it buys observer
        // rights at most, and often nothing.
        plan.rounds[0]!.vehicle === 'ACC' ? 'Observer' : rng.pick(['Director', 'Observer', 'Observer']),
        'NBIF representative',
        `2026-${rng.pick(['09', '10', '11'])}-${rng.pick(['08', '15', '23'])}`,
        plan.rounds[0]!.date,
      ],
    );
    bump('board_seat');
  }

  if (!plan.exit && rng.chance(0.6)) {
    const titles = ['Close Series A extension', 'Reach $1M ARR', 'First US enterprise customer',
      'CE mark / regulatory clearance', 'Hire VP Sales', 'Cash-flow positive'];
    for (let i = 0; i < rng.int(1, 3); i++) {
      await client.query(
        `insert into company_milestone (company_id, title, due_date, status, updated_by)
         values ($1,$2,$3,$4,$5)`,
        [
          f.companyId,
          rng.pick(titles),
          `2026-${rng.pick(['09', '12'])}-30`,
          rng.pick(['on-track', 'at-risk', 'pending']),
          SYSTEM_USER,
        ],
      );
      bump('company_milestone');
    }
  }

  // Government funding: a real feature of the New Brunswick cap table, and the
  // input A9's conditions alert reads.
  if (rng.chance(0.4)) {
    await client.query(
      `insert into company_gov_funding (company_id, program_name, amount, conditions, status, updated_by)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        f.companyId,
        rng.pick(['ACOA AIF', 'NRC IRAP', 'ONB Payroll Rebate', 'SR&ED', 'ACOA BDP']),
        toDollars(Math.round(plan.rounds[0]!.chequeCents * rng.between(0.3, 1.8))),
        rng.pick(['Job creation targets attached', 'Repayable on revenue milestones',
          'NB employment maintained for 3 years', 'Matching private capital required']),
        rng.pick(['active', 'active', 'conditions pending', 'at risk']),
        SYSTEM_USER,
      ],
    );
    bump('company_gov_funding');
  }
}

// --- reconciliation --------------------------------------------------------

/**
 * The assertion the whole phase rests on, run against the DATABASE rather than
 * against the plan objects -- so it catches a bad cast, a lost row, a currency
 * that never got converted and a constraint that silently dropped something,
 * none of which a check over the in-memory plan would see.
 */
async function reconcile(): Promise<string[]> {
  const { rows } = await client.query<{
    company_id: string; name: string;
    target_invested: string; actual_invested: string;
    target_fmv: string; actual_fmv: string;
  }>(
    `select c.company_id, c.name,
            c.affinity_total_investment                      as target_invested,
            round(i.invested, 2)                             as actual_invested,
            c.affinity_fmv                                   as target_fmv,
            round(company_fmv_asof(c.company_id, $1::date),2) as actual_fmv
       from company c
       join v_company_invested i on i.company_id = c.company_id
      where c.affinity_total_investment is not null
        and (round(i.invested,2) is distinct from round(c.affinity_total_investment,2)
          or round(company_fmv_asof(c.company_id,$1::date),2)
               is distinct from round(coalesce(c.affinity_fmv,0),2))
      order by c.company_id`,
    [AS_OF],
  );

  return rows.map(
    (r) =>
      `${r.company_id} ${r.name}: invested ${r.actual_invested} vs ${r.target_invested}, ` +
      `fmv ${r.actual_fmv} vs ${r.target_fmv}`,
  );
}

// --- summary ---------------------------------------------------------------

interface Summary {
  totals: { invested: string; fmv: string; n: string };
  target: { invested: string; fmv: string };
  lp: { committed: string; called: string };
  exercises: { finding: string; n: string }[];
}

/** Everything the report shows about the data, read while it is still in scope. */
async function summarise(): Promise<Summary> {
  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    (await client.query<T>(sql, params)).rows;

  const [totals] = await q<Summary['totals']>(
    `select round(sum(i.invested),2)::text as invested,
            round(sum(company_fmv_asof(c.company_id,$1::date)),2)::text as fmv,
            count(*)::text as n
       from company c join v_company_invested i on i.company_id = c.company_id
      where c.affinity_total_investment is not null`,
    [AS_OF],
  );
  const [target] = await q<Summary['target']>(
    `select sum(affinity_total_investment)::text as invested,
            sum(affinity_fmv)::text as fmv from company`,
  );
  const [lp] = await q<Summary['lp']>(
    `select coalesce(sum(committed),0)::text as committed,
            coalesce(sum(called),0)::text as called from v_lp_position_current`,
  );
  const exercises = await q<{ finding: string; n: string }>(`
    select 'companies with no KPI history' as finding, count(*)::text as n
      from company c where not exists (select 1 from company_kpi k where k.company_id = c.company_id)
    union all
    select 'rounds with no captured total', count(*)::text
      from investment_round where round_total is null
    union all
    select 'rounds excluded from leverage', count(*)::text
      from investment_round r where r.round_total is not null
       and not exists (select 1 from v_round_leverage l
                        where l.investment_round_id = r.investment_round_id)
    union all
    select 'marks with an unresolved method', count(*)::text
      from valuation_mark where valuation_method_id is null
    union all
    select 'co-investors resolving to an LP position', count(*)::text
      from round_coinvestor where fund_investment_id is not null
    union all
    select 'transactions booked outside CAD', count(*)::text
      from transaction where currency <> 'CAD'
    union all
    select 'voided or reversing transactions', count(*)::text
      from transaction where voided_at is not null or reverses_transaction_id is not null
    union all
    select 'transactions on another company''s round', count(*)::text
      from transaction t join investment_round r using (investment_round_id)
     where t.company_id is distinct from r.company_id
    union all
    select 'LP positions never called', count(*)::text
      from v_lp_position_current where called = 0`);

  return { totals: totals!, target: target!, lp: lp!, exercises };
}

// --- report ----------------------------------------------------------------

async function report(ok: boolean) {
  console.log(`\n${DRY ? 'DRY RUN — rolled back' : ok ? 'COMMITTED' : 'ROLLED BACK'}\n`);

  console.log('rows written');
  for (const [k, v] of Object.entries(counts).sort()) {
    console.log(`  ${k.padEnd(26)} ${String(v).padStart(6)}`);
  }
  if (Object.keys(cleared).length) {
    console.log('\nrows cleared first');
    for (const [k, v] of Object.entries(cleared).sort()) {
      console.log(`  ${k.padEnd(26)} ${String(v).padStart(6)}`);
    }
  }

  if (summary) {
    const { totals, target, lp } = summary;
    console.log('\ncontrol totals — direct portfolio');
    console.log(`  companies                  ${totals.n}`);
    console.log(`  invested   generated       ${money(toCents(totals.invested))}`);
    console.log(`             Affinity        ${money(toCents(target.invested))}`);
    console.log(`  FMV        generated       ${money(toCents(totals.fmv))}`);
    console.log(`             Affinity        ${money(toCents(target.fmv))}`);

    console.log('\ncontrol totals — LP positions');
    console.log(`  committed  generated       ${money(toCents(lp.committed))}`);
    console.log(`             workbook        ${money(lpFile.controlTotals.committed * 100)}`);
    console.log(`  called     generated       ${money(toCents(lp.called))}`);
    console.log(`             workbook        ${money(lpFile.controlTotals.called * 100)}`);
  }

  if (defects.length) {
    console.log('\ndeliberate defects (ADR-020) — every one is intentional');
    for (const d of defects) {
      console.log(`  · ${d.kind}`);
      console.log(`      on ${d.subject}`);
      console.log(`      ${d.detail}`);
    }
  }

  if (summary) {
    console.log('\nwhat the dataset now exercises');
    for (const r of summary.exercises) console.log(`  ${r.finding.padEnd(42)} ${r.n.padStart(5)}`);
  }

  if (notes.length) {
    console.log('\nnotes');
    for (const n of notes) console.log(`  - ${n}`);
  }
  if (skipped.length) {
    console.log('\nskipped');
    for (const s of skipped) console.log(`  - ${s}`);
  }
}
