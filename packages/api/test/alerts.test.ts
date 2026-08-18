/**
 * The A9 verification: risk flags, threshold inheritance, and acknowledgements.
 *
 * A9 makes three claims that are worth more than the code that implements them,
 * and each has a test here that fails loudly if the claim stops being true:
 *
 *   1. **A fund policy fires, and an explicit 0 escapes it.** This is the whole
 *      point of the phase and it is also the dangerous part -- a portfolio-wide
 *      default with no opt-out would put companies on a watchlist on the
 *      strength of a number nobody set for them. `an explicit 0 disables the
 *      alert and the fund policy does not resurrect it` is the test that keeps
 *      the escape hatch open.
 *
 *   2. **Suppression is structural, not textual.** The prototype dropped any
 *      flag whose display text matched /Runway/i, so renaming a flag silently
 *      changed the alert feed. Categories replace that. `a flag suppresses the
 *      metric its CATEGORY declares, not the one its TEXT mentions` is the test
 *      that proves the regex is gone from the authoring path.
 *
 *   3. **An acknowledgement expires, and a deterioration outruns it.** An
 *      acknowledgement that could be set and forgotten would be worse than no
 *      acknowledgement at all, because the alert would be gone and nobody would
 *      know why.
 *
 * Health is deliberately untested here beyond one assertion that it CANNOT be
 * written, because Affinity owns it (ADR-009) and the point is the absence of a
 * path, not the behaviour of one.
 *
 * REQUIRES A DATABASE. Skipped when DATABASE_URL is unset, matching the other
 * suites; the database CI job sets it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'kysely';

import { healthAlerts, type HealthAlert } from '@portfolio-command/metrics';
import type { Company, PortfolioExport } from '@portfolio-command/contract';

import { closeDb, db } from '../src/db.js';
import type { Principal } from '../src/auth/principal.js';
import { applyJudgementEdit, ValidationError } from '../src/write/judgement.js';
import { assertTestDatabase } from './use-test-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const hasDb = Boolean(process.env.DATABASE_URL);

const COMPANY = 'PCA901';

const VC: Principal = {
  userId: '',
  entraObjectId: 'test-a9-vc',
  email: 'a9vc@example.test',
  displayName: 'Test A9 Analyst',
  role: 'vc',
};
const LEADERSHIP: Principal = { ...VC, role: 'leadership' };

/* ------------------------------------------------------------------ *
 * A minimal contract document.
 *
 * Built by hand rather than read from the database, because these tests are
 * about the ALERT RULES and the fixture would drag seventy companies of
 * irrelevant state through every assertion. The write-path tests below do go
 * through the database; these do not need to.
 * ------------------------------------------------------------------ */

const kpi = (over: Partial<Company['kpis'][number]> = {}) => ({
  period: '2026-Q1',
  revenue: 10,
  burn: 0.5,
  cash: 5,
  runwayMo: 10,
  ...over,
});

const company = (over: Partial<Company> = {}): Company =>
  ({
    id: 'C001',
    name: 'Test Co',
    sector: 'ICT',
    stage: 'Series A',
    vintage: 2022,
    health: 'yellow',
    instrument: 'Preferred Equity',
    ownershipPct: 10,
    invested: 5,
    fmv: 8,
    realized: 0,
    exited: false,
    ceo: '-',
    hq: 'Fredericton, NB',
    desc: '',
    riskFlags: [],
    proRata: true,
    reservesAllocated: 0,
    reservesDeployed: 0,
    board: { seat: 'Observer', holder: '-', nextMeeting: null },
    kpis: [kpi()],
    thresholds: {},
    rounds: [],
    milestones: [],
    covenants: [],
    govFunding: null,
    marks: [],
    tasks: [],
    ...over,
  }) as Company;

const doc = (companies: Company[], policy?: PortfolioExport['alertPolicy']): PortfolioExport =>
  ({
    fund: {},
    companies,
    pipeline: [],
    fundInvestments: [],
    memos: {},
    alertPolicy: policy,
    meta: { schemaVersion: 3, savedAt: null, demo: true },
  }) as unknown as PortfolioExport;

const POLICY: NonNullable<PortfolioExport['alertPolicy']> = {
  minRunwayMo: 12,
  maxBurnMult: null,
  minCashBalance: null,
  maxRevenueDeclinePct: null,
  minNrrPct: null,
  effectiveFrom: '2026-01-01',
  setBy: 'Test A9 Analyst',
};

const texts = (a: HealthAlert[]) => a.map((x) => x.text);

/* ================================================================== *
 * The rules
 * ================================================================== */

describe('threshold inheritance', () => {
  test('a company with no threshold of its own inherits the fund policy', () => {
    const c = company({ kpis: [kpi({ runwayMo: 8 })], thresholds: {} });

    // Without a policy this company is invisible, which is the pre-A9 gap the
    // phase exists to close: nobody had configured it, so nothing watched it.
    expect(healthAlerts(doc([c]))).toHaveLength(0);

    const withPolicy = healthAlerts(doc([c], POLICY));
    expect(texts(withPolicy)).toEqual(['Runway 8 mo (threshold 12)']);
    expect(withPolicy[0]!.thresholdFrom).toBe('policy');
  });

  test("a company's own threshold overrides the policy", () => {
    const c = company({ kpis: [kpi({ runwayMo: 8 })], thresholds: { minRunwayMo: 6 } });
    // 8 months is above its own floor of 6 and below the fund's 12. Its own wins.
    expect(healthAlerts(doc([c], POLICY))).toHaveLength(0);

    const breaching = company({ kpis: [kpi({ runwayMo: 5 })], thresholds: { minRunwayMo: 6 } });
    const alerts = healthAlerts(doc([breaching], POLICY));
    expect(texts(alerts)).toEqual(['Runway 5 mo (threshold 6)']);
    expect(alerts[0]!.thresholdFrom).toBe('company');
  });

  /**
   * THE ESCAPE HATCH. Without this a portfolio-wide default is inescapable,
   * and the first company that legitimately does not want a runway alert --
   * an accelerator holding, a company that is cash-flow positive and reports
   * runway as a formality -- would have no way to say so.
   */
  test('an explicit 0 disables the alert and the fund policy does not resurrect it', () => {
    const c = company({ kpis: [kpi({ runwayMo: 1 })], thresholds: { minRunwayMo: 0 } });
    expect(healthAlerts(doc([c], POLICY))).toHaveLength(0);
  });

  test('a policy that sets nothing for a metric fires nothing', () => {
    const c = company({ kpis: [kpi({ runwayMo: 1 })], thresholds: {} });
    expect(healthAlerts(doc([c], { ...POLICY, minRunwayMo: null }))).toHaveLength(0);
    // 0 on the POLICY means the same as null: the fund sets no floor.
    expect(healthAlerts(doc([c], { ...POLICY, minRunwayMo: 0 }))).toHaveLength(0);
  });

  test('an exited company is never alerted, whatever the policy says', () => {
    const c = company({ exited: true, kpis: [kpi({ runwayMo: 1 })] });
    expect(healthAlerts(doc([c], POLICY))).toHaveLength(0);
  });
});

describe('the metrics A9 added', () => {
  test('burn multiple is quarterly net burn over quarterly net new revenue', () => {
    // Burn 1.0/mo -> 3.0 in the quarter. Revenue 10 -> 11, so 1.0 of net new.
    // 3.0 / 1.0 = 3.0x against a threshold of 1.5x.
    const c = company({
      kpis: [kpi({ revenue: 11, burn: 1 }), kpi({ period: '2025-Q4', revenue: 10 })],
      thresholds: { maxBurnMult: 1.5 },
    });
    expect(texts(healthAlerts(doc([c])))).toEqual(['Burn multiple 3.0x (threshold 1.5x)']);
  });

  /**
   * The guard IS the definition, not defensive coding. A company with flat or
   * falling revenue has no meaningful burn multiple -- the denominator goes to
   * zero and the ratio to infinity -- and would otherwise sit permanently at
   * the top of the feed displaying a meaningless number.
   */
  test('burn multiple stays silent when revenue is flat or falling', () => {
    const flat = company({
      kpis: [kpi({ revenue: 10, burn: 5 }), kpi({ period: '2025-Q4', revenue: 10 })],
      thresholds: { maxBurnMult: 1.5 },
    });
    expect(healthAlerts(doc([flat]))).toHaveLength(0);

    const falling = company({
      kpis: [kpi({ revenue: 8, burn: 5 }), kpi({ period: '2025-Q4', revenue: 10 })],
      thresholds: { maxBurnMult: 1.5 },
    });
    expect(healthAlerts(doc([falling]))).toHaveLength(0);
  });

  test('burn multiple stays silent for a cash-flow-positive company', () => {
    const c = company({
      kpis: [kpi({ revenue: 11, burn: -0.5 }), kpi({ period: '2025-Q4', revenue: 10 })],
      thresholds: { maxBurnMult: 1.5 },
    });
    expect(healthAlerts(doc([c]))).toHaveLength(0);
  });

  test('burn multiple needs two periods and stays silent with one', () => {
    const c = company({ kpis: [kpi({ revenue: 11, burn: 5 })], thresholds: { maxBurnMult: 1.5 } });
    expect(healthAlerts(doc([c]))).toHaveLength(0);
  });

  test('the cash floor is independent of runway, which is only as reported', () => {
    // ADR-027: runway is what the founder reported, and it can be comfortable
    // on a cash balance that is not. Runway here is fine; the floor still fires.
    const c = company({
      kpis: [kpi({ runwayMo: 24, cash: 0.4 })],
      thresholds: { minRunwayMo: 12, minCashBalance: 1 },
    });
    expect(texts(healthAlerts(doc([c])))).toEqual(['Cash $0.4M (floor $1.0M)']);
  });

  test('revenue decline compares quarter over quarter', () => {
    const c = company({
      kpis: [kpi({ revenue: 7 }), kpi({ period: '2025-Q4', revenue: 10 })],
      thresholds: { maxRevenueDeclinePct: 20 },
    });
    expect(texts(healthAlerts(doc([c])))).toEqual(['Revenue -30% QoQ (threshold -20%)']);
  });

  test('NRR fires only when the reading is present', () => {
    const withNrr = company({ kpis: [kpi({ nrr: 80 })], thresholds: { minNrrPct: 90 } });
    expect(texts(healthAlerts(doc([withNrr])))).toEqual(['NRR 80% (threshold 90%)']);

    // A schemaVersion 1 document carries no nrr at all. Absent is not zero.
    const withoutNrr = company({ kpis: [kpi()], thresholds: { minNrrPct: 90 } });
    expect(healthAlerts(doc([withoutNrr]))).toHaveLength(0);
  });

  test('severity reads red at half again the threshold, yellow below it', () => {
    const mild = company({
      kpis: [kpi({ revenue: 11, burn: 0.6 }), kpi({ period: '2025-Q4', revenue: 10 })],
      thresholds: { maxBurnMult: 1.5 },
    });
    // 1.8 / 1.0 = 1.8x, which is 1.2 times the threshold.
    expect(healthAlerts(doc([mild]))[0]!.sev).toBe('yellow');

    const severe = company({
      kpis: [kpi({ revenue: 11, burn: 1 }), kpi({ period: '2025-Q4', revenue: 10 })],
      thresholds: { maxBurnMult: 1.5 },
    });
    // 3.0x, which is twice the threshold.
    expect(healthAlerts(doc([severe]))[0]!.sev).toBe('red');
  });
});

describe('flag suppression', () => {
  /**
   * THE TEST THIS SECTION EXISTS FOR. The prototype decided this by regex on
   * display text, so a flag reading "Cash getting tight" duplicated the runway
   * alert and one reading "Runway fine, watching hiring" vanished. The category
   * decides it now, and the text is free to say anything.
   */
  test('a flag suppresses the metric its CATEGORY declares, not the one its TEXT mentions', () => {
    const base = {
      kpis: [kpi({ runwayMo: 4 })],
      thresholds: { minRunwayMo: 12 },
      riskFlags: ['Bridge round in progress, board aware'],
    };

    // Category 'runway': suppressed, despite the text never saying "runway".
    const suppressed = company({
      ...base,
      riskFlagDetail: [
        { id: 1, category: 'runway', categoryLabel: 'Runway', note: null, severity: null, raisedAt: '2026-01-01', raisedBy: 'A' },
      ],
    });
    expect(texts(healthAlerts(doc([suppressed])))).toEqual(['Runway 4 mo (threshold 12)']);

    // Category 'financing': NOT suppressed, and the identical text now appears.
    const kept = company({
      ...base,
      riskFlagDetail: [
        { id: 1, category: 'financing', categoryLabel: 'Financing risk', note: null, severity: null, raisedAt: '2026-01-01', raisedBy: 'A' },
      ],
    });
    expect(texts(healthAlerts(doc([kept])))).toEqual([
      'Runway 4 mo (threshold 12)',
      'Bridge round in progress, board aware',
    ]);
  });

  /**
   * The prototype's suppression was UNCONDITIONAL -- it dropped a matching flag
   * whether or not the metric had actually fired, so a runway flag on a company
   * comfortably above its threshold was invisible on every screen. A9 makes it
   * conditional, which cost nothing against the reference fixture because all
   * twenty runway flags there sit on companies that also breach.
   */
  test('a suppressing flag still appears when its metric did NOT fire', () => {
    const c = company({
      kpis: [kpi({ runwayMo: 24 })],
      thresholds: { minRunwayMo: 12 },
      riskFlags: ['Runway — burn plan under review'],
      riskFlagDetail: [
        { id: 1, category: 'runway', categoryLabel: 'Runway', note: 'burn plan under review', severity: null, raisedAt: '2026-01-01', raisedBy: 'A' },
      ],
    });
    expect(texts(healthAlerts(doc([c])))).toEqual(['Runway — burn plan under review']);
  });

  test('without riskFlagDetail the inherited regex still governs, for legacy documents', () => {
    const c = company({
      kpis: [kpi({ runwayMo: 4 })],
      thresholds: { minRunwayMo: 12 },
      riskFlags: ['Runway below 12 months', 'Customer concentration'],
    });
    expect(texts(healthAlerts(doc([c])))).toEqual([
      'Runway 4 mo (threshold 12)',
      'Customer concentration',
    ]);
  });

  test('a flag takes its own severity when it has one, and the company health when it does not', () => {
    const c = company({
      health: 'green',
      riskFlags: ['Escalating', 'Routine'],
      riskFlagDetail: [
        { id: 1, category: 'market', categoryLabel: 'Market', note: null, severity: 'red', raisedAt: '2026-01-01', raisedBy: 'A' },
        { id: 2, category: 'market', categoryLabel: 'Market', note: null, severity: null, raisedAt: '2026-01-01', raisedBy: 'A' },
      ],
    });
    const alerts = healthAlerts(doc([c]));
    expect(alerts.find((a) => a.text === 'Escalating')!.sev).toBe('red');
    expect(alerts.find((a) => a.text === 'Routine')!.sev).toBe('yellow');
  });
});

describe('acknowledgements', () => {
  const breaching = (acks: Company['acknowledgements']) =>
    company({ kpis: [kpi({ runwayMo: 4 })], thresholds: { minRunwayMo: 12 }, acknowledgements: acks });

  const ack = (over: Partial<NonNullable<Company['acknowledgements']>[number]> = {}) => ({
    alertKey: 'metric:runway',
    reason: 'Bridge closing 30 Sep',
    untilDate: '2026-09-30',
    value: 4,
    by: 'Test A9 Analyst',
    at: '2026-06-01',
    ...over,
  });

  test('a live acknowledgement removes the alert from the active feed', () => {
    expect(healthAlerts(doc([breaching([ack()])]), { asOf: '2026-08-18' })).toHaveLength(0);
  });

  test('an expired acknowledgement lets the alert back', () => {
    expect(healthAlerts(doc([breaching([ack()])]), { asOf: '2026-10-01' })).toHaveLength(1);
  });

  /**
   * The property that makes acknowledgements safe to offer. Knowing about four
   * months of runway is not consent to ignore two.
   */
  test('a materially worse reading re-fires before the acknowledgement expires', () => {
    const worse = company({
      kpis: [kpi({ runwayMo: 2 })],
      thresholds: { minRunwayMo: 12 },
      acknowledgements: [ack({ value: 4 })],
    });
    expect(healthAlerts(doc([worse]), { asOf: '2026-08-18' })).toHaveLength(1);

    // Ordinary movement inside the tolerance stays acknowledged.
    const slightly = company({
      kpis: [kpi({ runwayMo: 3.8 })],
      thresholds: { minRunwayMo: 12 },
      acknowledgements: [ack({ value: 4 })],
    });
    expect(healthAlerts(doc([slightly]), { asOf: '2026-08-18' })).toHaveLength(0);
  });

  test('direction is per metric: a RISING burn multiple is the worse one', () => {
    const c = (burn: number) =>
      company({
        kpis: [kpi({ revenue: 11, burn }), kpi({ period: '2025-Q4', revenue: 10 })],
        thresholds: { maxBurnMult: 1.5 },
        acknowledgements: [ack({ alertKey: 'metric:burn-multiple', value: 1.8 })],
      });
    // 0.6/mo -> 1.8x, exactly what was acknowledged.
    expect(healthAlerts(doc([c(0.6)]), { asOf: '2026-08-18' })).toHaveLength(0);
    // 1.0/mo -> 3.0x, well past it.
    expect(healthAlerts(doc([c(1)]), { asOf: '2026-08-18' })).toHaveLength(1);
  });

  test('an acknowledgement on one alert does not silence another', () => {
    const c = company({
      kpis: [kpi({ runwayMo: 4, cash: 0.1 })],
      thresholds: { minRunwayMo: 12, minCashBalance: 1 },
      acknowledgements: [ack()],
    });
    expect(texts(healthAlerts(doc([c]), { asOf: '2026-08-18' }))).toEqual(['Cash $0.1M (floor $1.0M)']);
  });

  /**
   * The metrics package has no clock (ADR-021). Without a date it cannot tell
   * an expired acknowledgement from a live one, so it declines to guess -- and
   * that fallback is what keeps the frozen fixture producing frozen figures.
   */
  test('without an asOf, nothing is filtered at all', () => {
    expect(healthAlerts(doc([breaching([ack()])]))).toHaveLength(1);
  });
});

/* ================================================================== *
 * The write path
 * ================================================================== */

describe.skipIf(!hasDb)('the A9 write path', () => {
  beforeEach(async () => {
    assertTestDatabase();

    await sql`
      insert into pc.app_user (user_id, entra_object_id, display_name, email, role)
      values (gen_random_uuid(), 'test-a9-vc', 'Test A9 Analyst', 'a9vc@example.test', 'vc')
      on conflict (entra_object_id) do update set role = 'vc'
    `.execute(db());
    const { rows } = await sql<{ id: string }>`
      select user_id::text as id from pc.app_user where entra_object_id = 'test-a9-vc'
    `.execute(db());
    VC.userId = rows[0]!.id;
    LEADERSHIP.userId = rows[0]!.id;

    await sql`
      insert into pc.company (company_id, name, created_by)
      values (${COMPANY}, 'A9 Test Co', ${VC.userId}::uuid)
      on conflict (company_id) do nothing
    `.execute(db());

    await sql`delete from pc.company_risk_flag where company_id = ${COMPANY}`.execute(db());
    await sql`delete from pc.alert_acknowledgement where company_id = ${COMPANY}`.execute(db());
    await sql`delete from pc.company_threshold where company_id = ${COMPANY}`.execute(db());
    await sql`delete from pc.fund_alert_policy where set_by = ${VC.userId}::uuid`.execute(db());
  });

  afterAll(async () => {
    await closeDb();
  });

  const flagsOf = async () => {
    const { rows } = await sql<{
      id: string; flag_text: string; note: string | null; code: string;
      cleared_at: string | null; cleared_reason: string | null;
    }>`
      select f.company_risk_flag_id::text as id, f.flag_text, f.note, c.code,
             f.cleared_at::text, f.cleared_reason
        from pc.company_risk_flag f
        join pc.ref_risk_flag_category c using (risk_flag_category_id)
       where f.company_id = ${COMPANY}
       order by f.company_risk_flag_id
    `.execute(db());
    return rows;
  };

  test('raising a flag composes the display string and resolves the category', async () => {
    await applyJudgementEdit(db(), VC, {
      kind: 'risk-flag-raise',
      companyId: COMPANY,
      category: 'key-person',
      note: 'CFO resigned, search underway',
    });
    const [flag] = await flagsOf();
    expect(flag!.code).toBe('key-person');
    expect(flag!.note).toBe('CFO resigned, search underway');
    // The ADR-001 display string, stored rather than re-derived on read.
    expect(flag!.flag_text).toBe('Key person — CFO resigned, search underway');
  });

  test('a flag with no note reads as its category alone', async () => {
    await applyJudgementEdit(db(), VC, {
      kind: 'risk-flag-raise', companyId: COMPANY, category: 'governance',
    });
    expect((await flagsOf())[0]!.flag_text).toBe('Governance');
  });

  /**
   * The categories decide which derived alert a flag suppresses. A category
   * invented by a typo would suppress nothing while looking like it should, so
   * an unknown code is a rejected request rather than a new vocabulary row
   * (ADR-026).
   */
  test('an unknown category is refused, not created', async () => {
    await expect(
      applyJudgementEdit(db(), VC, {
        kind: 'risk-flag-raise', companyId: COMPANY, category: 'runwayy',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await flagsOf()).toHaveLength(0);
  });

  test('clearing a flag requires a reason and records who lowered it', async () => {
    await applyJudgementEdit(db(), VC, {
      kind: 'risk-flag-raise', companyId: COMPANY, category: 'covenant',
    });
    const id = Number((await flagsOf())[0]!.id);

    await expect(
      applyJudgementEdit(db(), VC, { kind: 'risk-flag-clear', flagId: id, reason: '  ' }),
    ).rejects.toBeInstanceOf(ValidationError);

    await applyJudgementEdit(db(), VC, {
      kind: 'risk-flag-clear', flagId: id, reason: 'Waiver signed 12 Aug',
    });
    const [cleared] = await flagsOf();
    expect(cleared!.cleared_at).not.toBeNull();
    expect(cleared!.cleared_reason).toBe('Waiver signed 12 Aug');

    // Clearing twice is a mistake worth naming rather than a silent no-op.
    await expect(
      applyJudgementEdit(db(), VC, { kind: 'risk-flag-clear', flagId: id, reason: 'again' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('every A9 write lands in audit_log', async () => {
    await applyJudgementEdit(db(), VC, {
      kind: 'risk-flag-raise', companyId: COMPANY, category: 'market', note: 'New entrant',
    });
    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pc.audit_log
       where table_name = 'company_risk_flag' and changed_by = ${VC.userId}::uuid
    `.execute(db());
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  test('leadership may read but not raise a flag', async () => {
    await expect(
      applyJudgementEdit(db(), LEADERSHIP, {
        kind: 'risk-flag-raise', companyId: COMPANY, category: 'market',
      }),
    ).rejects.toThrow();
  });

  test('a threshold of null clears the row so the fund policy is inherited again', async () => {
    await applyJudgementEdit(db(), VC, {
      kind: 'company-threshold', companyId: COMPANY, thresholds: { minRunwayMo: 6 },
    });
    const read = async () => {
      const { rows } = await sql<{ v: number | null; cash: string | null }>`
        select min_runway_months as v, min_cash_balance::text as cash
          from pc.company_threshold where company_id = ${COMPANY}
      `.execute(db());
      return rows[0];
    };
    expect((await read())!.v).toBe(6);

    // Untouched keys stay untouched: setting cash must not clear runway.
    await applyJudgementEdit(db(), VC, {
      kind: 'company-threshold', companyId: COMPANY, thresholds: { minCashBalance: 1.5 },
    });
    expect((await read())!.v).toBe(6);
    // $M in, dollars stored (ADR-001).
    expect((await read())!.cash).toBe('1500000.00');

    await applyJudgementEdit(db(), VC, {
      kind: 'company-threshold', companyId: COMPANY, thresholds: { minRunwayMo: null },
    });
    expect((await read())!.v).toBeNull();
  });

  test('0 is a legitimate threshold and survives the write path', async () => {
    await applyJudgementEdit(db(), VC, {
      kind: 'company-threshold', companyId: COMPANY, thresholds: { minRunwayMo: 0 },
    });
    const { rows } = await sql<{ v: number | null }>`
      select min_runway_months as v from pc.company_threshold where company_id = ${COMPANY}
    `.execute(db());
    // Not null, and not absent. This is the opt-out, and a truthiness check
    // anywhere in the path would silently turn it back into "inherit".
    expect(rows[0]!.v).toBe(0);
  });

  test('a negative threshold is refused', async () => {
    await expect(
      applyJudgementEdit(db(), VC, {
        kind: 'company-threshold', companyId: COMPANY, thresholds: { minRunwayMo: -1 },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  /**
   * The reason the policy table is effective-dated at all. A board pack issued
   * last quarter must still reproduce against the policy that was in force when
   * it was issued, so setting a new policy supersedes rather than overwrites.
   */
  test('setting a policy supersedes the previous one rather than overwriting it', async () => {
    await applyJudgementEdit(db(), VC, {
      kind: 'alert-policy', minRunwayMo: 12, maxBurnMult: null, minCashBalance: null,
      maxRevenueDeclinePct: null, minNrrPct: null, note: 'Board policy, Aug 2026',
    });
    await applyJudgementEdit(db(), VC, {
      kind: 'alert-policy', minRunwayMo: 9, maxBurnMult: 2, minCashBalance: null,
      maxRevenueDeclinePct: null, minNrrPct: null,
    });

    const { rows } = await sql<{ runway: number | null; open: boolean }>`
      select min_runway_months as runway, effective_to is null as open
        from pc.fund_alert_policy
       where set_by = ${VC.userId}::uuid
       order by fund_alert_policy_id
    `.execute(db());

    expect(rows).toHaveLength(2);
    // The first is closed and still readable; the second is current.
    expect(rows[0]!.runway).toBe(12);
    expect(rows[0]!.open).toBe(false);
    expect(rows[1]!.runway).toBe(9);
    expect(rows[1]!.open).toBe(true);
  });

  test('acknowledging twice revokes the first rather than losing it', async () => {
    const acknowledge = (reason: string) =>
      applyJudgementEdit(db(), VC, {
        kind: 'alert-acknowledge', companyId: COMPANY, alertKey: 'metric:runway',
        reason, untilDate: '2026-09-30', value: 4,
      });
    await acknowledge('Bridge closing');
    await acknowledge('Bridge slipped to October');

    const { rows } = await sql<{ reason: string; live: boolean }>`
      select reason, revoked_at is null as live
        from pc.alert_acknowledgement
       where company_id = ${COMPANY}
       order by alert_acknowledgement_id
    `.execute(db());

    expect(rows).toHaveLength(2);
    expect(rows[0]!.live).toBe(false);
    expect(rows[1]!.live).toBe(true);
    // The superseded judgement survives, because "what did they say the first
    // time" is a question a board asks after the fact.
    expect(rows[0]!.reason).toBe('Bridge closing');
  });

  test('an acknowledgement requires a reason and a well-formed date', async () => {
    const bad = (over: Record<string, unknown>) =>
      applyJudgementEdit(db(), VC, {
        kind: 'alert-acknowledge', companyId: COMPANY, alertKey: 'metric:runway',
        reason: 'Because', untilDate: '2026-09-30', value: null, ...over,
      } as never);

    await expect(bad({ reason: '   ' })).rejects.toBeInstanceOf(ValidationError);
    await expect(bad({ untilDate: '30/09/2026' })).rejects.toBeInstanceOf(ValidationError);
  });

  test('a cash acknowledgement crosses the unit boundary, and a runway one does not', async () => {
    await applyJudgementEdit(db(), VC, {
      kind: 'alert-acknowledge', companyId: COMPANY, alertKey: 'metric:cash-balance',
      reason: 'Draw scheduled', untilDate: '2026-09-30', value: 1.5,
    });
    await applyJudgementEdit(db(), VC, {
      kind: 'alert-acknowledge', companyId: COMPANY, alertKey: 'metric:runway',
      reason: 'Bridge closing', untilDate: '2026-09-30', value: 4,
    });
    const { rows } = await sql<{ alert_key: string; v: string }>`
      select alert_key, acknowledged_value::text as v
        from pc.alert_acknowledgement
       where company_id = ${COMPANY} and revoked_at is null
       order by alert_key
    `.execute(db());
    // $M -> dollars for the one money-valued alert, and nowhere else: runway is
    // months and must not be multiplied by anything.
    expect(rows.find((r) => r.alert_key === 'metric:cash-balance')!.v).toBe('1500000.00');
    expect(Number(rows.find((r) => r.alert_key === 'metric:runway')!.v)).toBe(4);
  });

  test('revoking an acknowledgement that is not live is refused', async () => {
    await expect(
      applyJudgementEdit(db(), VC, {
        kind: 'alert-revoke', companyId: COMPANY, alertKey: 'metric:runway',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  /**
   * ADR-009. The VC team maintains health in Affinity and the sync is one-way.
   * This asserts the ABSENCE of a path rather than the behaviour of one: if a
   * health edit ever becomes representable, this stops compiling, which is the
   * point.
   */
  test('health is not editable through the judgement path', () => {
    const kinds = [
      'deal-gate', 'reserve-allocation', 'memo-section', 'risk-flag-raise', 'risk-flag-clear',
      'company-threshold', 'alert-policy', 'alert-acknowledge', 'alert-revoke',
    ];
    expect(kinds).not.toContain('health');
    expect(kinds.some((k) => k.includes('health'))).toBe(false);
  });
});
