/**
 * The ADR-001 document importer.
 *
 * Takes a `PortfolioExport` -- the frozen contract shape, which is also what
 * `docs/reference/demo.json` holds and what `GET /api/v1/export` emits -- and
 * loads it into the normalised schema. It is the inbound half of the round
 * trip; `src/read/` is the outbound half.
 *
 * FOUR RULES GOVERN IT, and each is load-bearing:
 *
 * 1. **Derived fields are advisory (ADR-001, D-1).** Where the document asserts
 *    a scalar the storage model derives -- `invested`, `fmv`, `called` -- the
 *    facts win and the assertion is reconciled against them. A disagreement is
 *    a named warning, never a silent overwrite and never a rejected file.
 *
 * 2. **Reference keys resolve on exact match only (ADR-026).** The verbatim
 *    string is always stored. A key is set only where the vocabulary genuinely
 *    contains that value. Nothing is coerced to a nearest neighbour and no
 *    reference row is invented.
 *
 * 3. **Money crosses the unit boundary exactly once**, in `units.ts`. Nothing
 *    here multiplies by 1e6.
 *
 * 4. **Every row is flagged synthetic and tagged with a batch (ADR-020,
 *    ADR-018).** The banner is driven by the flag, and the batch is what makes
 *    an imperfect load reversible wholesale.
 *
 * The import REPLACES the portfolio document, which is the semantic the
 * prototype's export/edit/re-import loop has always had. Finance's historical
 * backfill is a different path entirely -- staging templates and an incremental
 * pipeline, per ADR-019 -- and does not come through here.
 */
import type { PortfolioExport } from '@portfolio-command/contract';
import type pg from 'pg';

import { periodOf } from '../periods.js';
import { toDollars, toNumeric } from '../units.js';

/** The system principal seeded by `packages/db/src/seed.ts`. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * A reconciliation finding. Never fatal on its own -- the import succeeds and
 * the report is the deliverable, because a file that is 99% right and 1%
 * contradictory is still worth loading with the 1% named.
 */
export interface ImportWarning {
  kind: 'derived-mismatch' | 'unresolved-reference' | 'data-quality';
  subject: string;
  field: string;
  detail: string;
}

export interface ImportResult {
  batchId: string;
  asOf: string;
  counts: Record<string, number>;
  warnings: ImportWarning[];
}

/** Tables cleared before a load. Children follow by cascade. */
const ROOT_TABLES = [
  'audit_log',
  'fund_distribution',
  'fund_nav_snapshot',
  'memo',
  'pipeline_deal',
  'fund_investment',
  'company',
  'fund',
] as const;

/**
 * The reporting as-at date, derived from the data rather than the clock.
 *
 * The latest valuation mark is the anchor: NAV as at any date is the sum of
 * each company's most recent mark on or before it, so dating anything later
 * than the last mark values the portfolio at a date its marks do not cover.
 * The frontend derives it identically (ADR-021, ADR-007).
 */
export function asOfDate(doc: PortfolioExport): string {
  const dates = doc.companies.flatMap((c) => c.marks.map((m) => m.date));
  return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : '1970-01-01';
}

/** Rounds to the contract's working precision so float noise is not reported as a mismatch. */
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export async function importContract(
  client: pg.Client,
  doc: PortfolioExport,
): Promise<ImportResult> {
  const warnings: ImportWarning[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  const asOf = asOfDate(doc);
  const { rows: batchRows } = await client.query<{ batch_id: string }>(
    'select gen_random_uuid() as batch_id',
  );
  const batchId = batchRows[0]!.batch_id;

  // --- reference vocabularies, for exact-match resolution only (ADR-026) ---
  const lookup = async (table: string, key: string) => {
    const { rows } = await client.query<{ id: number; name: string }>(
      `select ${key} as id, name from ${table}`,
    );
    return new Map(rows.map((r) => [r.name, r.id]));
  };
  const sectors = await lookup('ref_sector', 'sector_id');
  const stages = await lookup('ref_stage', 'stage_id');
  const instruments = await lookup('ref_instrument', 'instrument_id');
  const channels = await lookup('ref_source_channel', 'source_channel_id');
  const funnels = await lookup('ref_funnel_stage', 'funnel_stage_id');
  const methods = await lookup('ref_valuation_method', 'valuation_method_id');

  const unresolved = new Map<string, Set<string>>();
  const resolve = (map: Map<string, number>, label: string | null | undefined, what: string) => {
    if (label === null || label === undefined || label === '') return null;
    const id = map.get(label);
    if (id === undefined) {
      if (!unresolved.has(what)) unresolved.set(what, new Set());
      unresolved.get(what)!.add(label);
      return null;
    }
    return id;
  };

  for (const table of ROOT_TABLES) {
    await client.query(`truncate table ${table} restart identity cascade`);
  }

  // ================= FUND =================
  // `currency` is carried verbatim for the round trip. The contract holds no
  // per-transaction currency, so transactions store the schema default (CAD)
  // and `txn_fx_present` is satisfied without asserting an exchange rate
  // nobody supplied. Flagged rather than resolved silently (ADR-008).
  if (doc.fund.currency !== 'CAD') {
    warnings.push({
      kind: 'data-quality',
      subject: 'fund',
      field: 'currency',
      detail:
        `Fund reports in ${doc.fund.currency}, but the contract carries no per-transaction ` +
        'currency. Transactions are stored as CAD with no FX rate asserted.',
    });
  }

  const { rows: fundRows } = await client.query<{ fund_id: number }>(
    `insert into fund (name, style, reporting_currency, inception_year, capital_base,
                       committed, called, fee_drag_pct, distribution_policy, reserves_policy,
                       annual_platform_target, annual_followon_budget)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning fund_id`,
    [
      doc.fund.name,
      doc.fund.style,
      doc.fund.currency,
      doc.fund.vintage,
      toDollars(doc.fund.capitalBase),
      toDollars(doc.fund.committed),
      toDollars(doc.fund.called),
      doc.fund.feeDragPct,
      doc.fund.distributionPolicy,
      doc.fund.reservesPolicy,
      doc.fund.annualPlatformTarget,
      toDollars(doc.fund.annualFollowOnBudget),
    ],
  );
  const fundId = fundRows[0]!.fund_id;
  bump('fund');

  for (const p of doc.fund.navHistory) {
    await client.query(
      `insert into fund_nav_snapshot (fund_id, period_end, nav, cumulative_cost)
       values ($1,$2,$3,$4)`,
      [fundId, periodOf(p.q).periodEnd, toDollars(p.nav), toDollars(p.cost)],
    );
    bump('fund_nav_snapshot');
  }

  // ================= COMPANIES =================
  for (const c of doc.companies) {
    const [hqCity = null, hqRegion = null] = c.hq.split(',').map((s) => s.trim());
    const firstRound = c.rounds[0];

    await client.query(
      `insert into company (company_id, name, sector_id, sector_label, source_channel_id,
                            source_label, instrument_id, instrument_label, fte_at_entry,
                            ceo_name, hq_city, hq_region, description, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        c.id,
        c.name,
        resolve(sectors, c.sector, 'ref_sector'),
        c.sector,
        resolve(channels, c.source, 'ref_source_channel'),
        c.source,
        resolve(instruments, c.instrument, 'ref_instrument'),
        c.instrument,
        c.fteAtEntry,
        c.ceo,
        hqCity,
        hqRegion,
        c.desc,
        SYSTEM_USER_ID,
      ],
    );
    bump('company');

    await client.query(
      `insert into company_state (company_id, effective_from, stage_id, health, set_by)
       values ($1,$2,$3,$4,$5)`,
      [
        c.id,
        firstRound?.date ?? `${c.vintage}-01-01`,
        resolve(stages, c.stage, 'ref_stage'),
        c.health,
        SYSTEM_USER_ID,
      ],
    );

    for (const flag of c.riskFlags) {
      await client.query(
        `insert into company_risk_flag (company_id, flag_text, raised_by) values ($1,$2,$3)`,
        [c.id, flag, SYSTEM_USER_ID],
      );
      bump('company_risk_flag');
    }

    await client.query(
      `insert into company_threshold (company_id, min_runway_months, max_burn_multiple, updated_by)
       values ($1,$2,$3,$4)`,
      [c.id, c.thresholds.minRunwayMo ?? null, c.thresholds.maxBurnMult ?? null, SYSTEM_USER_ID],
    );

    if (c.exited) {
      if (!c.exitDate) {
        warnings.push({
          kind: 'data-quality',
          subject: c.id,
          field: 'exitDate',
          detail: 'Company is flagged exited but carries no exit date.',
        });
      } else {
        await client.query(
          `insert into company_exit (company_id, exit_date, exit_type, recorded_by)
           values ($1,$2,$3,$4)`,
          [c.id, c.exitDate, c.exitType ?? 'Acquisition', SYSTEM_USER_ID],
        );
        bump('company_exit');
      }
    }

    // --- rounds and the transactions behind them (ADR-002) ---
    let roundInvestedTotal = 0;
    for (const [i, r] of c.rounds.entries()) {
      const { rows } = await client.query<{ investment_round_id: string }>(
        `insert into investment_round (company_id, round_date, label, instrument_id,
                                       is_synthetic, round_total, nb_other, post_money,
                                       ownership_after_pct, lead_investor, note, captured_by,
                                       captured_at)
         values ($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11,now()) returning investment_round_id`,
        [
          c.id,
          r.date,
          r.label,
          instruments.get(r.instrument) ?? null,
          toDollars(r.roundTotal),
          toDollars(r.nbOther),
          toDollars(r.postMoney),
          toNumeric(r.ownershipAfter),
          r.lead,
          r.note,
          SYSTEM_USER_ID,
        ],
      );
      const roundId = rows[0]!.investment_round_id;
      bump('investment_round');
      roundInvestedTotal += r.invested;

      await client.query(
        `insert into transaction (txn_date, txn_type, company_id, investment_round_id, amount,
                                  is_synthetic, entered_by, batch_id, note)
         values ($1,$2,$3,$4,$5,true,$6,$7,$8)`,
        [
          r.date,
          i === 0 ? 'investment' : 'follow_on',
          c.id,
          roundId,
          toDollars(r.invested),
          SYSTEM_USER_ID,
          batchId,
          `${r.label} cheque`,
        ],
      );
      bump('transaction');
    }

    // D-1: the facts win, the assertion is reconciled against them.
    if (!near(roundInvestedTotal, c.invested)) {
      warnings.push({
        kind: 'derived-mismatch',
        subject: c.id,
        field: 'invested',
        detail:
          `Document asserts $${c.invested}M; the round cheques behind it sum to ` +
          `$${roundInvestedTotal}M. The transactions are used.`,
      });
    }
    if (c.rounds.length > 0) {
      const vintage = Number(c.rounds[0]!.date.slice(0, 4));
      if (vintage !== c.vintage) {
        warnings.push({
          kind: 'derived-mismatch',
          subject: c.id,
          field: 'vintage',
          detail: `Document asserts ${c.vintage}; first round is dated ${c.rounds[0]!.date}.`,
        });
      }
    }

    // --- realizations ---
    // The contract carries `realized` as a scalar with no date of its own, so
    // the date comes from the exit, or from the fund-level distribution naming
    // this company. Write-offs get no transaction: the exit record carries the
    // event and a zero-amount row would only add noise.
    if (c.realized > 0) {
      const dist = doc.fund.distributions.find((d) => d.company === c.name);
      const date = c.exitDate ?? dist?.date ?? c.rounds.at(-1)?.date ?? asOf;
      if (!c.exitDate && !dist) {
        warnings.push({
          kind: 'data-quality',
          subject: c.id,
          field: 'realized',
          detail:
            `Realized $${c.realized}M with no exit date and no matching fund distribution; ` +
            `dated to the last round (${date}).`,
        });
      }
      await client.query(
        `insert into transaction (txn_date, txn_type, company_id, amount, is_synthetic,
                                  entered_by, batch_id, note)
         values ($1,'realization',$2,$3,true,$4,$5,$6)`,
        [date, c.id, toDollars(c.realized), SYSTEM_USER_ID, batchId, 'Realization proceeds'],
      );
      bump('transaction');
    }

    // --- valuation marks ---
    const seenMarkDates = new Set<string>();
    for (const m of c.marks) {
      // The active-mark unique index permits one final mark per date. A repeat
      // is a supersession, not a duplicate to drop.
      const duplicate = seenMarkDates.has(m.date);
      if (duplicate) {
        warnings.push({
          kind: 'data-quality',
          subject: c.id,
          field: 'marks',
          detail: `More than one mark effective ${m.date}; the later one is stored as final and the earlier superseded.`,
        });
        await client.query(
          `update valuation_mark set status = 'superseded'
            where company_id = $1 and effective_date = $2 and status = 'final'`,
          [c.id, m.date],
        );
      }
      seenMarkDates.add(m.date);
      await client.query(
        `insert into valuation_mark (company_id, effective_date, fmv, valuation_method_id,
                                     method_label, rationale, prepared_by_label, is_synthetic,
                                     status)
         values ($1,$2,$3,$4,$5,$6,$7,true,'final')`,
        [
          c.id,
          m.date,
          toDollars(m.fmv),
          resolve(methods, m.method, 'ref_valuation_method'),
          m.method,
          m.rationale,
          m.by,
        ],
      );
      bump('valuation_mark');
    }

    const latestMark = c.marks.reduce<typeof c.marks[number] | null>(
      (a, m) => (a === null || m.date > a.date ? m : a),
      null,
    );
    if (latestMark && !near(latestMark.fmv, c.fmv)) {
      warnings.push({
        kind: 'derived-mismatch',
        subject: c.id,
        field: 'fmv',
        detail:
          `Document asserts $${c.fmv}M; the latest mark (${latestMark.date}) is ` +
          `$${latestMark.fmv}M. The mark is used.`,
      });
    }

    // --- KPIs ---
    for (const k of c.kpis) {
      const { periodStart, periodEnd } = periodOf(k.period);
      await client.query(
        `insert into company_kpi (company_id, period_start, period_end, revenue, monthly_burn,
                                  cash_balance, runway_months, fte, fte_nb, women_csuite,
                                  csuite_size, source_system)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'visible')`,
        [
          c.id,
          periodStart,
          periodEnd,
          toDollars(k.revenue),
          toDollars(k.burn),
          toDollars(k.cash),
          toNumeric(k.runwayMo),
          c.fte,
          c.fteNB,
          c.womenCSuite ?? null,
          c.cSuiteSize ?? null,
        ],
      );
      bump('company_kpi');
    }

    await client.query(
      `insert into company_ownership (company_id, as_of_date, ownership_pct, pro_rata_rights,
                                      is_synthetic, entered_by)
       values ($1,$2,$3,$4,true,$5)`,
      [c.id, asOf, toNumeric(c.ownershipPct), c.proRata, SYSTEM_USER_ID],
    );

    await client.query(
      `insert into reserve_allocation (company_id, allocated, deployed, effective_from, set_by)
       values ($1,$2,$3,$4,$5)`,
      [c.id, toDollars(c.reservesAllocated), toDollars(c.reservesDeployed), asOf, SYSTEM_USER_ID],
    );

    await client.query(
      `insert into board_seat (company_id, seat_type, holder_name, next_meeting_date, effective_from)
       values ($1,$2,$3,$4,$5)`,
      [c.id, c.board.seat, c.board.holder, c.board.nextMeeting ?? null, asOf],
    );

    for (const m of c.milestones) {
      await client.query(
        `insert into company_milestone (company_id, title, due_date, status, updated_by)
         values ($1,$2,$3,$4,$5)`,
        [c.id, m.title, m.due || null, m.status, SYSTEM_USER_ID],
      );
      bump('company_milestone');
    }

    for (const v of c.covenants) {
      // Status is a three-value vocabulary; the narrative rides in status_detail
      // ("watch - 1.9x in Q1"). Prefix match only -- nothing is guessed at.
      const head = v.status.toLowerCase();
      const status = head.startsWith('compliant')
        ? 'compliant'
        : head.startsWith('watch')
          ? 'watch'
          : head.startsWith('breach')
            ? 'breach'
            : null;
      if (status === null) {
        warnings.push({
          kind: 'unresolved-reference',
          subject: c.id,
          field: 'covenants.status',
          detail: `"${v.status}" does not begin with compliant, watch or breach; stored as watch with the original text preserved.`,
        });
      }
      await client.query(
        `insert into company_covenant (company_id, covenant_text, status, status_detail, updated_by)
         values ($1,$2,$3,$4,$5)`,
        [c.id, v.text, status ?? 'watch', v.status, SYSTEM_USER_ID],
      );
      bump('company_covenant');
    }

    if (c.govFunding) {
      await client.query(
        `insert into company_gov_funding (company_id, program_name, amount, conditions, status, updated_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          c.id,
          c.govFunding.program,
          toDollars(c.govFunding.amount),
          c.govFunding.conditions,
          c.govFunding.status,
          SYSTEM_USER_ID,
        ],
      );
      bump('company_gov_funding');
    }

    for (const t of c.tasks) {
      await client.query(
        `insert into company_task (company_id, title, due_date, is_done, created_by)
         values ($1,$2,$3,$4,$5)`,
        [c.id, t.title, t.due || null, t.done, SYSTEM_USER_ID],
      );
      bump('company_task');
    }
  }

  // ================= FUND-LEVEL DISTRIBUTIONS =================
  // ADR-025: a stored series, deliberately NOT derived from the realization
  // transactions above. Loaded after the companies so the optional resolution
  // has a roster to resolve against.
  const companyByName = new Map(doc.companies.map((c) => [c.name, c.id]));
  for (const d of doc.fund.distributions) {
    const resolvedId = companyByName.get(d.company) ?? null;
    if (resolvedId === null) {
      warnings.push({
        kind: 'unresolved-reference',
        subject: `fund.distributions[${d.date}]`,
        field: 'company',
        detail:
          `"${d.company}" matches no company in the roster. Legitimate for an aggregate ` +
          'row or a realization predating the roster; the label is stored verbatim (ADR-025).',
      });
    }
    await client.query(
      `insert into fund_distribution (fund_id, distribution_date, amount, company_label,
                                      company_id, note, is_synthetic, entered_by, batch_id)
       values ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
      [fundId, d.date, toDollars(d.amount), d.company, resolvedId, d.note, SYSTEM_USER_ID, batchId],
    );
    bump('fund_distribution');
  }

  // ================= LP POSITIONS =================
  for (const f of doc.fundInvestments) {
    await client.query(
      `insert into fund_investment (fund_investment_id, name, manager_name, strategy, vintage_year,
                                    committed, co_invest_rights, women_senior_gp, co_invests_done,
                                    referrals, capital_to_direct, next_call_est, agm_date,
                                    ir_contact, rationale, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        f.id,
        f.name,
        f.manager,
        f.strategy,
        f.vintage,
        toDollars(f.committed),
        f.coInvestRights,
        f.womenSeniorGP,
        f.coInvestsDone,
        f.referrals,
        toDollars(f.capitalToDirect),
        f.nextCallEst ?? null,
        f.agm ?? null,
        f.contact,
        f.rationale,
        SYSTEM_USER_ID,
      ],
    );
    bump('fund_investment');

    await client.query(
      `insert into fund_investment_nav (fund_investment_id, as_of_date, nav, is_synthetic, entered_by)
       values ($1,$2,$3,true,$4)`,
      [f.id, asOf, toDollars(f.nav), SYSTEM_USER_ID],
    );

    let called = 0;
    let distributed = 0;
    for (const cf of f.cashflows) {
      const isCall = cf.amount < 0;
      if (isCall) called += -cf.amount;
      else distributed += cf.amount;
      await client.query(
        `insert into transaction (txn_date, txn_type, fund_investment_id, amount, is_synthetic,
                                  entered_by, batch_id)
         values ($1,$2,$3,$4,true,$5,$6)`,
        [
          cf.date,
          isCall ? 'capital_call' : 'distribution',
          f.id,
          toDollars(Math.abs(cf.amount)),
          SYSTEM_USER_ID,
          batchId,
        ],
      );
      bump('transaction');
    }

    if (!near(called, f.called)) {
      warnings.push({
        kind: 'derived-mismatch',
        subject: f.id,
        field: 'called',
        detail: `Document asserts $${f.called}M; capital calls sum to $${called}M. The cashflows are used.`,
      });
    }
    if (!near(distributed, f.distributions)) {
      warnings.push({
        kind: 'derived-mismatch',
        subject: f.id,
        field: 'distributions',
        detail: `Document asserts $${f.distributions}M; distributions sum to $${distributed}M. The cashflows are used.`,
      });
    }
  }

  // ================= PIPELINE =================
  for (const d of doc.pipeline) {
    await client.query(
      `insert into pipeline_deal (deal_id, name, sector_id, sector_label, funnel_stage_id,
                                  funnel_label, source_channel_id, source_label, owner_label,
                                  check_size, valuation, next_step, date_added, closed_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        d.id,
        d.name,
        resolve(sectors, d.sector, 'ref_sector'),
        d.sector,
        resolve(funnels, d.funnel, 'ref_funnel_stage'),
        d.funnel,
        resolve(channels, d.source, 'ref_source_channel'),
        d.source,
        d.owner,
        toDollars(d.checkSize),
        toDollars(d.valuation),
        d.nextStep,
        d.added || null,
        d.closedDate ?? null,
      ],
    );
    bump('pipeline_deal');

    for (const [i, g] of d.gates.entries()) {
      await client.query(
        `insert into deal_gate (deal_id, gate_name, sort_order, status) values ($1,$2,$3,$4)`,
        [d.id, g.name, i + 1, g.status],
      );
      bump('deal_gate');
    }

    if (d.termSheet) {
      const t = d.termSheet;
      await client.query(
        `insert into term_sheet (deal_id, security, pre_money, post_money, investment,
                                 ownership_pct, liquidation_pref, anti_dilution, board_composition,
                                 pro_rata_terms, dividends, option_pool, founder_vesting)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          d.id,
          t.security,
          toDollars(t.preMoney),
          toDollars(t.postMoney),
          toDollars(t.investment),
          toNumeric(t.ownership),
          t.liquidation,
          t.antiDilution,
          t.board,
          t.proRata,
          t.dividends,
          t.optionPool,
          t.founderVesting,
        ],
      );
      bump('term_sheet');
    }
  }

  // ================= MEMOS =================
  for (const [subjectId, sections] of Object.entries(doc.memos)) {
    const subjectType = doc.companies.some((c) => c.id === subjectId) ? 'company' : 'deal';
    const { rows } = await client.query<{ memo_id: string }>(
      `insert into memo (subject_type, subject_id, title, author_id) values ($1,$2,$3,$4)
       returning memo_id`,
      [subjectType, subjectId, `IC memo — ${subjectId}`, SYSTEM_USER_ID],
    );
    const memoId = rows[0]!.memo_id;
    bump('memo');
    for (const [i, [key, body]] of Object.entries(sections).entries()) {
      await client.query(
        `insert into memo_section (memo_id, section_key, body, sort_order) values ($1,$2,$3,$4)`,
        [memoId, key, body, i + 1],
      );
      bump('memo_section');
    }
  }

  for (const [what, values] of unresolved) {
    warnings.push({
      kind: 'unresolved-reference',
      subject: what,
      field: 'name',
      detail:
        `${values.size} value(s) matched no row and were left unresolved, stored verbatim ` +
        `(ADR-026): ${[...values].sort().join(', ')}`,
    });
  }

  await client.query(
    `insert into audit_log (table_name, record_id, action, new_value, changed_by)
     values ('__import__', $1, 'insert', $2, $3)`,
    [
      batchId,
      JSON.stringify({ asOf, counts, warningCount: warnings.length, schemaVersion: doc.meta.schemaVersion }),
      SYSTEM_USER_ID,
    ],
  );

  return { batchId, asOf, counts, warnings };
}
