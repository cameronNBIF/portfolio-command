/**
 * Health alerts.
 *
 * Ported verbatim from vc-toolkit.html :653-664 (ADR-013), then extended at A9
 * (ADR-032) with fund-level threshold inheritance, four more metrics, a
 * structural replacement for the display-text de-duplication, and time-boxed
 * acknowledgements.
 *
 * THE EXTENSION IS GATED ON DATA THE PROTOTYPE NEVER HAD, WHICH IS WHY THE
 * GOLDEN MASTER BARELY MOVED. Threshold inheritance needs `db.alertPolicy`;
 * cash, revenue-decline and NRR alerts need threshold fields and a `nrr`
 * reading that arrived at schemaVersion 3; acknowledgement filtering needs an
 * `asOf`. `docs/reference/demo.json` is schemaVersion 1 and frozen (ADR-022),
 * so it supplies none of them and every one of those paths is inert against it.
 *
 * ONE EXCEPTION, AND IT IS THE WHOLE RECORDED DELTA: `maxBurnMult` has been in
 * the contract since v1 and sits on 68 of the fixture's 70 companies. The
 * prototype stored it and never computed anything with it. Giving it a rule
 * adds FOUR alerts to the fixture -- C001, C002, C008, C009 -- and that is the
 * complete list. ADR-032 records it; the fixture was recaptured against that
 * diff and nothing else in it moved.
 */
import type {
  AlertAcknowledgement,
  Company,
  Kpi,
  PortfolioExport,
  Thresholds,
} from '@portfolio-command/contract';

import { activeCompanies } from './company.js';

export type Severity = 'red' | 'yellow';

/** Which metric a derived alert is about. Also the suffix of its `key`. */
export type MetricKey = 'runway' | 'burn-multiple' | 'cash-balance' | 'revenue-decline' | 'nrr';

/** Where an alert came from. `metric` is derived; the rest are authored. */
export type AlertSource = 'metric' | 'flag' | 'covenant' | 'gov-funding';

export interface HealthAlert {
  company: Company;
  sev: Severity;
  text: string;
  /**
   * Stable identity within a company, derived from the alert's SUBJECT and
   * never from its value -- `metric:runway` stays put across every Visible
   * refresh. This is what an acknowledgement keys on.
   */
  key: string;
  source: AlertSource;
  /** Present on derived alerts only. */
  metric?: MetricKey;
  /** The reading that breached, in the metric's own units. */
  value?: number;
  /** The threshold it breached. */
  threshold?: number;
  /**
   * Whether the threshold was the company's own or inherited from the fund
   * policy. The UI says which, because "who set 12 months" is the first
   * question anyone asks about an alert they disagree with.
   */
  thresholdFrom?: 'company' | 'policy';
  /**
   * Set when this alert is currently accepted. Only present on the output of
   * `allAlerts()`; `healthAlerts()` filters these out.
   */
  acknowledged?: AlertAcknowledgement;
}

export interface AlertOptions {
  /**
   * `YYYY-MM-DD`. Required for acknowledgements to be honoured at all -- the
   * metrics package has no clock (ADR-021), so without a date it cannot tell
   * an expired acknowledgement from a live one and declines to guess. Omitting
   * it yields every open alert, which is the pre-A9 behaviour.
   */
  asOf?: string;
}

/* ------------------------------------------------------------------ */
/* Threshold resolution                                                */
/* ------------------------------------------------------------------ */

interface Resolved {
  value: number;
  from: 'company' | 'policy';
}

/**
 * Resolves one threshold against the company then the fund.
 *
 * THREE STATES, AND CONFLATING TWO OF THEM IS HOW A PORTFOLIO-WIDE DEFAULT
 * BECOMES INESCAPABLE:
 *
 *   undefined  -- the company sets nothing. Inherit the policy.
 *   0          -- DISABLED, deliberately, by someone. Returns null and the
 *                 policy does NOT resurrect it. This is the inherited contract
 *                 meaning of `minRunwayMo: 0` and it is the only opt-out a
 *                 company has.
 *   n          -- the company's own number, which wins.
 *
 * A policy value of 0 or null means the fund sets no policy for that metric,
 * so nothing fires. There is no hardcoded fallback anywhere in this file: a
 * number nobody set must never put a company on a watchlist.
 */
function resolve(own: number | undefined | null, policy: number | null | undefined): Resolved | null {
  if (own != null) return own > 0 ? { value: own, from: 'company' } : null;
  if (policy != null && policy > 0) return { value: policy, from: 'policy' };
  return null;
}

/**
 * Severity for the metrics A9 added.
 *
 * NEW BEHAVIOUR, NOT INHERITED -- the prototype had exactly one severity rule
 * and it was runway's hardcoded `< 6` months, which is preserved untouched
 * below. A breach at least half again as bad as its threshold reads red;
 * anything else reads yellow. One rule across four metrics, so a reader who
 * learns it once can predict all of them.
 */
function breachSeverity(ratioWorse: number): Severity {
  return ratioWorse >= 1.5 ? 'red' : 'yellow';
}

/* ------------------------------------------------------------------ */
/* Suppression                                                         */
/* ------------------------------------------------------------------ */

/**
 * Which metric alert a risk flag stands in for, so the two do not both appear.
 *
 * TWO PATHS, ONE MEANING. With `riskFlagDetail` present (schemaVersion 3) the
 * answer comes from the flag's category, which declares it. Without it -- the
 * reference fixture -- it falls back to the inherited regex on display text.
 * The regex is the thing A9 exists to get out of the authoring path; it stays
 * here only to read data written before there was an alternative.
 */
function suppressedMetric(c: Company, index: number, text: string): MetricKey | null {
  const detail = c.riskFlagDetail?.[index];
  if (detail) {
    // The category vocabulary and MetricKey share their spelling by design.
    return (SUPPRESSING_CATEGORIES[detail.category] ?? null) as MetricKey | null;
  }
  return /Runway/i.test(text) ? 'runway' : null;
}

const SUPPRESSING_CATEGORIES: Record<string, MetricKey> = {
  runway: 'runway',
  burn: 'burn-multiple',
};

/* ------------------------------------------------------------------ */
/* Derived metric alerts                                               */
/* ------------------------------------------------------------------ */

function metricAlerts(c: Company, t: Thresholds, policy: PortfolioExport['alertPolicy']): HealthAlert[] {
  const out: HealthAlert[] = [];
  const k: Kpi | undefined = c.kpis && c.kpis[0];
  const prev: Kpi | undefined = c.kpis && c.kpis[1];
  if (!k) return out;

  const push = (a: Omit<HealthAlert, 'company' | 'source' | 'key'> & { metric: MetricKey }) =>
    out.push({ ...a, company: c, source: 'metric', key: `metric:${a.metric}` });

  /* Runway. INHERITED VERBATIM, including the two things that look like bugs
     and are frozen: the threshold is tested for TRUTHINESS (so 0 disables
     rather than firing on everything), and the red band is a hardcoded 6
     months rather than a fraction of the threshold. Only the resolution of
     WHICH threshold applies is new. */
  const runway = resolve(t.minRunwayMo, policy?.minRunwayMo);
  if (runway && k.runwayMo < runway.value) {
    push({
      metric: 'runway',
      sev: k.runwayMo < 6 ? 'red' : 'yellow',
      text: `Runway ${k.runwayMo} mo (threshold ${runway.value})`,
      value: k.runwayMo,
      threshold: runway.value,
      thresholdFrom: runway.from,
    });
  }

  /* Burn multiple: quarterly net burn over quarterly net new revenue
     (ADR-032). Needs two periods.

     THE GUARD IS THE DEFINITION, not defensive coding. A company with flat or
     falling revenue has no meaningful burn multiple -- the denominator goes to
     zero and the ratio to infinity, which would put every struggling company
     at the top of the feed with a meaningless number. That company is caught
     by the revenue-decline alert, which is the one that actually describes it.
     A cash-flow-positive company (negative burn) has no burn to divide. */
  const burn = resolve(t.maxBurnMult, policy?.maxBurnMult);
  if (burn && prev) {
    const netBurn = k.burn * 3;
    const netNew = k.revenue - prev.revenue;
    if (netBurn > 0 && netNew > 0) {
      const multiple = netBurn / netNew;
      if (multiple > burn.value) {
        push({
          metric: 'burn-multiple',
          sev: breachSeverity(multiple / burn.value),
          text: `Burn multiple ${multiple.toFixed(1)}x (threshold ${burn.value}x)`,
          value: +multiple.toFixed(2),
          threshold: burn.value,
          thresholdFrom: burn.from,
        });
      }
    }
  }

  /* Cash floor, $M. An absolute check on the same risk runway describes, and
     deliberately independent of it: runway is AS REPORTED by the founder
     (ADR-027) and nets in expected inflows, so a company can report comfortable
     runway on a cash balance that is not comfortable at all. */
  const cash = resolve(t.minCashBalance, policy?.minCashBalance);
  if (cash && k.cash < cash.value) {
    push({
      metric: 'cash-balance',
      sev: breachSeverity(cash.value / Math.max(k.cash, 0.01)),
      text: `Cash $${k.cash.toFixed(1)}M (floor $${cash.value.toFixed(1)}M)`,
      value: k.cash,
      threshold: cash.value,
      thresholdFrom: cash.from,
    });
  }

  /* Revenue decline, quarter over quarter (ADR-032). Revenue is the period
     actual, not a run-rate (D-2), so this compares like with like. A company
     with no prior quarter cannot decline. */
  const decline = resolve(t.maxRevenueDeclinePct, policy?.maxRevenueDeclinePct);
  if (decline && prev && prev.revenue > 0) {
    const dropPct = ((prev.revenue - k.revenue) / prev.revenue) * 100;
    if (dropPct > decline.value) {
      push({
        metric: 'revenue-decline',
        sev: breachSeverity(dropPct / decline.value),
        text: `Revenue -${dropPct.toFixed(0)}% QoQ (threshold -${decline.value}%)`,
        value: +dropPct.toFixed(1),
        threshold: decline.value,
        thresholdFrom: decline.from,
      });
    }
  }

  /* Net revenue retention. Absent from the contract until schemaVersion 3, so
     this never evaluates against the reference fixture. */
  const nrr = resolve(t.minNrrPct, policy?.minNrrPct);
  if (nrr && k.nrr != null && k.nrr < nrr.value) {
    push({
      metric: 'nrr',
      sev: breachSeverity(nrr.value / Math.max(k.nrr, 1)),
      text: `NRR ${k.nrr.toFixed(0)}% (threshold ${nrr.value}%)`,
      value: k.nrr,
      threshold: nrr.value,
      thresholdFrom: nrr.from,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* The feed                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every open alert across the active portfolio, red first, INCLUDING those
 * currently acknowledged -- which carry `acknowledged` so a caller can show
 * them greyed rather than hidden.
 *
 * Four sources, in the inherited emission order: derived metric breaches, risk
 * flags, covenants in breach or on watch, and government funding with
 * conditions pending. That order matters. The final sort is TWO-VALUED -- red
 * against everything else -- and leans on `Array.prototype.sort` stability for
 * every other tie, which the language has guaranteed since ES2019. It is
 * deterministic, but it must not be replaced with a sort that orders ties
 * differently: the dashboard shows a top slice, and reordering ties changes
 * what a director sees. The fixture freezes the full sequence.
 */
export function allAlerts(db: PortfolioExport, opts: AlertOptions = {}): HealthAlert[] {
  const out: HealthAlert[] = [];
  const policy = db.alertPolicy;

  activeCompanies(db.companies).forEach((c) => {
    const t = c.thresholds ?? {};
    const metrics = metricAlerts(c, t, policy);
    out.push(...metrics);
    const firedMetrics = new Set(metrics.map((m) => m.metric));

    (c.riskFlags || []).forEach((f, i) => {
      /* SUPPRESSION IS CONDITIONAL AT A9, AND WAS UNCONDITIONAL BEFORE IT.
         The prototype dropped any flag matching /Runway/i whether or not a
         runway alert had fired, so a runway flag on a company comfortably
         above its threshold was invisible everywhere. That is exactly the
         hazard the controlled vocabulary exists to remove, and making the
         suppression conditional costs nothing against the fixture: all 20
         runway flags there sit on companies that also breach, so there are
         no orphans and the output is unchanged. Measured, not assumed. */
      const stands = suppressedMetric(c, i, f);
      if (stands && firedMetrics.has(stands)) return;

      const detail = c.riskFlagDetail?.[i];
      out.push({
        company: c,
        // INHERITED: a flag with no severity of its own takes its COMPANY's
        // health colour. Flags raised through the A9 form may override it.
        sev: detail?.severity ?? (c.health === 'red' ? 'red' : 'yellow'),
        text: f,
        key: detail ? `flag:${detail.id}` : `flag:${f}`,
        source: 'flag',
      });
    });

    (c.covenants || []).forEach((cv, i) => {
      if (/breach|watch/i.test(cv.status)) {
        out.push({
          company: c,
          sev: /breach/i.test(cv.status) ? 'red' : 'yellow',
          text: `Covenant: ${cv.text} (${cv.status})`,
          key: `covenant:${i}`,
          source: 'covenant',
        });
      }
    });

    if (c.govFunding && /pending|risk/i.test(c.govFunding.status)) {
      out.push({
        company: c,
        sev: 'yellow',
        text: `Gov funding: ${c.govFunding.program} - ${c.govFunding.status}`,
        key: 'gov-funding',
        source: 'gov-funding',
      });
    }
  });

  if (opts.asOf) attachAcknowledgements(out, opts.asOf);

  return out.sort((a, b) => (a.sev === 'red' ? 0 : 1) - (b.sev === 'red' ? 0 : 1));
}

/**
 * Marks alerts covered by a live acknowledgement.
 *
 * An acknowledgement lapses three ways, and the third is the one that makes it
 * safe to have at all:
 *
 *   1. `untilDate` passes.
 *   2. Someone revokes it -- it is simply absent from the export by then.
 *   3. THE READING MOVES MATERIALLY PAST WHERE IT WAS SIGNED OFF. Knowing
 *      about four months of runway is not consent to ignore two. Ten percent
 *      worse than the acknowledged value re-fires it, which is loose enough to
 *      absorb ordinary quarter-to-quarter movement and tight enough that a
 *      real deterioration is never sitting silently behind a note.
 *
 * Direction matters: for runway and cash a FALL is worse; for the burn
 * multiple and revenue decline a RISE is. The alert's own units decide.
 */
const WORSE_BY = 0.1;
const HIGHER_IS_WORSE = new Set<MetricKey>(['burn-multiple', 'revenue-decline']);

function attachAcknowledgements(alerts: HealthAlert[], asOf: string): void {
  for (const a of alerts) {
    const ack = a.company.acknowledgements?.find((x) => x.alertKey === a.key);
    if (!ack || ack.untilDate < asOf) continue;

    if (ack.value != null && a.value != null) {
      const worse = HIGHER_IS_WORSE.has(a.metric as MetricKey)
        ? a.value > ack.value * (1 + WORSE_BY)
        : a.value < ack.value * (1 - WORSE_BY);
      if (worse) continue;
    }
    a.acknowledged = ack;
  }
}

/**
 * The ACTIVE feed: open alerts that nobody has accepted.
 *
 * This is the function every screen calls and the one the golden master
 * asserts. With no `asOf` it does no acknowledgement filtering at all, which
 * is the pre-A9 behaviour and what keeps the frozen fixture producing frozen
 * figures.
 */
export function healthAlerts(db: PortfolioExport, opts: AlertOptions = {}): HealthAlert[] {
  return allAlerts(db, opts).filter((a) => !a.acknowledged);
}
