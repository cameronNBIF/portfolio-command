'use client';

/**
 * Fund Dashboard, ported from `renderDashboard` (vc-toolkit.html :682-729).
 *
 * Tile order, labels, sub-lines, colour conventions and chart layout are the
 * prototype's (ADR-014). Both sanctioned content exceptions live on this
 * screen and are marked below: D-2 (revenue labelled quarterly, not run-rate)
 * and D-5 (diversity shows coverage instead of counting non-reporters as zero).
 *
 * Every figure comes from `packages/metrics`. Nothing is computed here
 * (ADR-003).
 */
import type { MandateCompleteness } from '@portfolio-command/api';
import type { PortfolioExport } from '@portfolio-command/contract';
import {
  activeCompanies,
  count,
  diversityWithCoverage,
  fmt,
  fundMetrics,
  healthAlerts,
  isEvergreen,
  hasCapitalBasis,
  signedPct,
} from '@portfolio-command/metrics';

import {
  AllocationDonut,
  CapitalAttractedChart,
  FmvCostBySectorChart,
  JCurveChart,
  MoicDistributionChart,
  NavGrowthChart,
  SourcingChart,
  TopBottomChart,
  VintagePerformanceChart,
} from '../charts/DashboardCharts';
import { useApp } from '../AppShell';
import { AlertRow, Card, Dot, Kpi, KpiRow, Pill, ViewHeader } from '../ui';

export function DashboardTab({
  db,
  asOf,
  mandate,
}: {
  db: PortfolioExport;
  asOf: string;
  mandate: MandateCompleteness;
}) {
  const { openCompany } = useApp();

  const m = fundMetrics(db, { asOf });
  const alerts = healthAlerts(db);
  const active = activeCompanies(db.companies);
  const evergreen = isEvergreen(db);
  const diversity = diversityWithCoverage(db, {});

  const green = active.filter((c) => c.health === 'green').length;
  const yellow = active.filter((c) => c.health === 'yellow').length;
  const red = active.filter((c) => c.health === 'red').length;

  return (
    <>
      <ViewHeader title="Fund Dashboard" sub={`${db.fund.name} - marks as of ${asOf} - all figures $M ${db.fund.currency}`} />

      <KpiRow>
        <Kpi label="Invested Cost" value={fmt.m(m.invested)} sub={`${m.nActive} active / ${m.nExited} exited`} />
        <Kpi
          label="Current FMV"
          value={fmt.m(m.fmv)}
          sub={`Unrealized ${m.unrealizedGL >= 0 ? '+' : ''}${fmt.m(m.unrealizedGL)}`}
        />
        <Kpi
          label={evergreen ? 'Realized Proceeds' : 'Distributions'}
          value={fmt.m(m.distributions)}
          sub={
            evergreen
              ? `Recycled - dry powder ${hasCapitalBasis(db) ? fmt.m(m.dryPowder) : '- (capital base not set)'}`
              : 'Realized to date'
          }
        />
        <Kpi
          label={`TVPI${evergreen ? ' (SI)' : ''}`}
          value={fmt.x(m.tvpi)}
          sub={`DPI ${fmt.x(m.dpi)} / RVPI ${fmt.x(m.rvpi)}${evergreen ? ' - DPI recycled' : ''}`}
        />
        <Kpi
          label={evergreen ? 'SI Gross IRR' : 'Gross IRR'}
          value={fmt.pct(m.grossIRR)}
          sub={`Net ~${fmt.pct(m.netIRR)} (est.)`}
        />
        <Kpi
          label="Health"
          value={
            <>
              <Dot tone="green" />
              {green} <Dot tone="yellow" />
              {yellow} <Dot tone="red" />
              {red}
            </>
          }
          sub={`${alerts.length} open alerts`}
        />
      </KpiRow>

      <div className="vsub" style={{ margin: '2px 0 8px', fontWeight: 700, color: 'var(--slate)' }}>
        MANDATE &amp; IMPACT
      </div>

      <KpiRow>
        <Kpi
          label="FMV Growth"
          valueClass={(m.fmvYoY ?? 0) >= 0 ? 'up' : 'down'}
          value={m.fmvYoY != null ? signedPct(m.fmvYoY) : '-'}
          sub={
            <>
              YoY
              {m.fmvQoQ != null && ` - QoQ ${signedPct(m.fmvQoQ)}`}
              {m.organicYoY != null && ` - organic +${fmt.m(m.organicYoY)}`}
            </>
          }
        />
        {/* ADR-012: the coverage qualifier sits on the number it qualifies.
            Leverage EXCLUDES a round with no total rather than imputing one, so
            the ratio is computed over whatever share of the portfolio has been
            captured — and without saying which share, a reader has no way to
            tell a well-supported 5.9:1 from a thinly-supported one. The full
            picture, including the taper by vintage, is at the foot of this tab. */}
        <Kpi
          label="Leverage"
          value={m.leverage != null ? `${m.leverage.toFixed(1)} : 1` : '-'}
          sub={
            <>
              {fmt.m(m.capitalAttracted)} third-party $ in our rounds
              <br />
              <span className="hint">
                {mandate.pctLeverageCoverage != null
                  ? `From ${mandate.roundsTotal - mandate.missingRoundTotal} of ${mandate.roundsTotal} rounds (${mandate.pctLeverageCoverage}% captured)`
                  : 'No rounds recorded'}
              </span>
            </>
          }
        />
        <Kpi
          label="NB Co-Investment"
          value={fmt.m(m.nbCapital)}
          sub={`NB $ beside ours - outside $ ${fmt.m(m.outsideCapital)}`}
        />
        {/* D-2: the prototype labelled this "Run-rate". Visible supplies the
            past quarter's actual, so the label changes and the arithmetic does
            not (ADR-013, ADR-014). The figure is roughly a quarter of what the
            same tile showed under the run-rate label. */}
        <Kpi
          label="Portfolio Revenue"
          value={fmt.m(m.revenue)}
          sub={
            <>
              Quarterly, as reported
              {m.revQoQ != null && ` - same-store QoQ ${signedPct(m.revQoQ)}`}
            </>
          }
        />
        <Kpi
          label="Jobs (NB / Total)"
          value={`${m.fteNB ? count(m.fteNB) : '-'} / ${m.fte ? count(m.fte) : '-'}`}
          sub={
            <>
              {m.fte ? `${Math.round((m.fteNB / m.fte) * 100)}% in NB` : ''}
              {m.fteAtEntry ? ` - +${count(m.fte - m.fteAtEntry)} since entry` : ''}
            </>
          }
        />
        {/* D-5: non-reporters are excluded from the denominator and coverage is
            shown alongside. NULL never renders as zero -- reporting "0% of
            companies have women in the C-suite" when the truth is "not asked"
            is a materially worse error than reporting nothing (ADR-010). */}
        <Kpi
          label="Women in C-Suite"
          value={diversity.womenCosPct != null ? `${Math.round(diversity.womenCosPct)}%` : '-'}
          sub={
            <>
              {diversity.womenCos} of {diversity.reported} reporting - {diversity.womenExecs}/{diversity.cSuiteTotal} exec
              seats
              <br />
              <span className="hint">
                Reported by {diversity.reported} of {diversity.total} companies
              </span>
            </>
          }
        />
      </KpiRow>

      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
        <Card title="FMV vs. Cost by Sector">
          <FmvCostBySectorChart active={active} />
        </Card>
        <Card
          title="Alerts & Risk Flags"
          headerExtra={<Pill tone="red">{alerts.filter((a) => a.sev === 'red').length} critical</Pill>}
          bodyClassName="cbody"
          style={{ overflow: 'hidden' }}
        >
          <div style={{ maxHeight: 316, overflowY: 'auto' }}>
            {alerts.length === 0 && <div className="small">No open alerts.</div>}
            {alerts.slice(0, 14).map((a, i) => (
              <AlertRow key={`${a.company.id}-${i}`}>
                <Dot tone={a.sev} />
                <a className="link" onClick={() => openCompany(a.company.id)}>
                  {a.company.name}
                </a>
                <span className="small">{a.text}</span>
              </AlertRow>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', marginTop: 14 }}>
        <Card title="FMV Growth Trajectory (quarterly NAV vs. cost)">
          <NavGrowthChart db={db} />
        </Card>
        <Card title="Capital Attracted by Year (ours / NB / outside)">
          <CapitalAttractedChart db={db} />
        </Card>
        <Card title="Sourcing: Where We Find Companies">
          <SourcingChart active={active} />
        </Card>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', marginTop: 14 }}>
        <Card title="MOIC Distribution (active)">
          <MoicDistributionChart active={active} />
        </Card>
        <Card title="Vintage Year Performance">
          <VintagePerformanceChart db={db} />
        </Card>
        <Card title={evergreen ? 'Value Creation Over Time (net deployment + NAV)' : 'J-Curve (net cumulative + NAV)'}>
          <JCurveChart db={db} asOf={asOf} totalFmv={m.fmv} totalInvested={m.invested} isEvergreen={evergreen} />
        </Card>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 2fr', marginTop: 14 }}>
        <Card title="Allocation by Sector (FMV)">
          <AllocationDonut active={active} by="sector" />
        </Card>
        <Card title="Allocation by Stage (FMV)">
          <AllocationDonut active={active} by="stage" />
        </Card>
        <Card title="Top / Bottom Positions by Unrealized G/L">
          <TopBottomChart active={active} />
        </Card>
      </div>

      <MandateCapture mandate={mandate} />
    </>
  );
}

/**
 * ADR-012's monitoring half, on the screen the ADR names.
 *
 * PLACED LAST, DELIBERATELY. It is an addition to a ported screen, not a change
 * to one: every element above it sits exactly where the prototype puts it
 * (ADR-014), and putting this at the foot is what keeps that true. The figure
 * that has to be seen — how much of the portfolio the leverage ratio can
 * actually see — is on the Leverage tile itself, at the top, where the number it
 * qualifies is.
 *
 * THE TAPER IS THE POINT, not the headline percentage. ADR-015 is explicit that
 * coverage for older vintages is unrecoverable by any process and "must be
 * reported honestly rather than imputed", and O-6 records that some portfolio
 * histories run fifteen years or more. A single blended figure would average an
 * un-fixable 2011 gap together with a 2026 one somebody could close this
 * afternoon, and hide which is which.
 *
 * Read from `v_mandate_completeness`, NOT from the export document. The contract
 * carries no co-investor detail at all, and its `roundTotal` collapses "not
 * captured" and "captured as nothing" at the JSON boundary — the same reason
 * v_kpi_coverage exists (A5).
 */
function MandateCapture({ mandate }: { mandate: MandateCompleteness }) {
  if (mandate.roundsTotal === 0) return null;

  // Newest first: the years a deal lead can still do something about are the
  // ones worth reading first.
  const years = [...mandate.byYear].reverse();
  const covered = mandate.roundsTotal - mandate.missingRoundTotal;

  return (
    <div style={{ marginTop: 14 }}>
      <Card
        title="Mandate Capture Coverage"
        headerExtra={
          <Pill tone={(mandate.pctLeverageCoverage ?? 0) >= 90 ? 'green' : 'yellow'}>
            {mandate.pctLeverageCoverage ?? 0}% of rounds carry a total
          </Pill>
        }
      >
        <KpiRow>
          <Kpi
            label="Rounds With A Total"
            value={`${covered} / ${mandate.roundsTotal}`}
            sub="Everything else is excluded from leverage, never imputed"
          />
          <Kpi
            label="Missing NB Co-Investment"
            valueClass={mandate.missingNbOther > 0 ? 'down' : undefined}
            value={String(mandate.missingNbOther)}
            sub="Each one understates the NB mandate KPI"
          />
          <Kpi
            label="Missing Ownership"
            value={String(mandate.missingOwnership)}
            sub="Feeds MOIC and the waterfall"
          />
        </KpiRow>

        <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', marginTop: 12, height: 64 }}>
          {years.map((y) => {
            const p = y.pctLeverageCoverage ?? 0;
            return (
              <div
                key={y.year}
                title={`${y.year}: ${y.withRoundTotal} of ${y.roundsTotal} rounds carry a total`}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
              >
                <div
                  style={{
                    height: `${Math.max(p, 2)}%`,
                    // The same three-band convention as every health dot on this
                    // screen, so a reader does not have to learn a second one.
                    background: p >= 90 ? 'var(--green)' : p >= 70 ? 'var(--yellow)' : 'var(--red)',
                    borderRadius: '2px 2px 0 0',
                  }}
                />
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 3, marginTop: 3 }}>
          {years.map((y) => (
            <div key={y.year} className="hint" style={{ flex: 1, textAlign: 'center', fontSize: 9 }}>
              {String(y.year).slice(2)}
            </div>
          ))}
        </div>

        <div className="hint" style={{ marginTop: 8 }}>
          Round total, NB co-investment and ownership exist in no upstream system — not Affinity, not
          Visible, not Finance&rsquo;s spreadsheets. They are entered once, by the deal lead, at close
          (ADR-012), which is why this decays quietly if nobody watches it. Coverage tapers toward older
          vintages because early round detail is unrecoverable rather than un-entered (ADR-015); the
          recent years are the ones that can still be fixed, on the Deal Close tab.
        </div>
      </Card>
    </div>
  );
}
