'use client';

/**
 * Board / LP Report, ported from `renderReports` (vc-toolkit.html :1212-1296).
 *
 * This is the board-facing view, so per D-6 it labels periods FISCALLY -- the
 * calendar the board works to -- and says so. The same period appears under a
 * calendar label on the Portfolio KPI history, which is correct rather than
 * inconsistent, and is why both views state their convention.
 *
 * Under ADR-005 the board receives PDFs rather than accounts, so this screen
 * is the sole board-facing artefact. A11 replaces the browser print path with
 * Playwright-generated PDFs.
 */
import type { PortfolioExport } from '@portfolio-command/contract';
import {
  activeCompanies,
  count,
  diversityWithCoverage,
  fmt,
  fundMetrics,
  isEvergreen,
  lpMetrics,
  moic,
  fiTvpi,
  fiIrr,
  signedPct,
  unrealizedGain,
} from '@portfolio-command/metrics';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { CONVENTION_NOTE, fiscalQuarterLabel } from '../../lib/quarters';
import { useApp } from '../AppShell';
import { AlertRow, Card, Dot, Kpi, KpiRow, Pill, ViewHeader, moicClass } from '../ui';

const AXIS = { fontSize: 11, fill: '#5b6878' };
const GRID = '#eaeef3';

export function ReportsTab({ db, asOf }: { db: PortfolioExport; asOf: string }) {
  const { openCompany, toast } = useApp();

  const m = fundMetrics(db, { asOf });
  const fm = lpMetrics(db, { asOf });
  const act = activeCompanies(db.companies);
  const evergreen = isEvergreen(db);
  const diversity = diversityWithCoverage(db, {});
  const year = asOf.slice(0, 4);

  const watch = act.filter((c) => c.health !== 'green').sort((a, b) => (a.health === 'red' ? 0 : 1) - (b.health === 'red' ? 0 : 1));
  const movers = [...act].map((c) => ({ c, gl: unrealizedGain(c) })).sort((a, b) => b.gl - a.gl);
  const exitsYtd = db.companies.filter((c) => c.exited && (c.exitDate ?? '').startsWith(year));
  const newYtd = db.companies.filter((c) => !c.exited && c.rounds.some((r) => r.date.startsWith(year)));

  const vintages = [...new Set(db.companies.map((c) => c.vintage))].sort((a, b) => a - b);
  const navBridge = vintages.map((y) => {
    const g = db.companies.filter((c) => c.vintage === y);
    return {
      vintage: String(y),
      Cost: g.reduce((s, c) => s + c.invested, 0),
      'FMV + Realized': g.reduce((s, c) => s + c.fmv + c.realized, 0),
    };
  });

  const byYear: Record<string, number> = {};
  for (const c of db.companies) for (const r of c.rounds) byYear[r.date.slice(0, 4)] = (byYear[r.date.slice(0, 4)] ?? 0) + r.invested;
  const deployed = Object.keys(byYear)
    .sort()
    .map((y) => ({ year: y, deployed: +(byYear[y] ?? 0).toFixed(1) }));

  const execSummary = () => {
    const line2 = evergreen
      ? `TVPI ${fmt.x(m.tvpi)} / DPI ${fmt.x(m.dpi)} / RVPI ${fmt.x(m.rvpi)} since inception; gross IRR ${fmt.pct(m.grossIRR)} (net ~${fmt.pct(m.netIRR)} est.). Realized proceeds ${fmt.m(m.distributions)} recycled per policy (DPI reflects recycling, not shareholder distributions); dry powder ${fmt.m(m.dryPowder)} of ${fmt.m(db.fund.capitalBase)} capital base.`
      : `TVPI ${fmt.x(m.tvpi)} / DPI ${fmt.x(m.dpi)} / RVPI ${fmt.x(m.rvpi)}; gross IRR ${fmt.pct(m.grossIRR)} (net ~${fmt.pct(m.netIRR)} est.).`;
    const txt =
      `${db.fund.name} - Summary ${asOf} (${fiscalQuarterLabel(asOf)})\n` +
      `Invested ${fmt.m(m.invested)} across ${m.nActive} active companies; NAV ${fmt.m(m.fmv)}${evergreen ? '' : `; distributions ${fmt.m(m.distributions)}`}.\n` +
      `${line2}\n` +
      `Health: ${act.filter((c) => c.health === 'green').length} green / ${act.filter((c) => c.health === 'yellow').length} yellow / ${act.filter((c) => c.health === 'red').length} red. ` +
      `Platform pace: ${db.fund.ytdPlatformsClosed}/${db.fund.annualPlatformTarget} YTD.\n` +
      `${m.fmvYoY != null ? `FMV ${signedPct(m.fmvYoY)} YoY${m.organicYoY != null ? ` (${fmt.m(m.organicYoY)} organic)` : ''}. ` : ''}` +
      `${m.leverage != null ? `Leverage ${m.leverage.toFixed(1)}:1 (${fmt.m(m.nbCapital)} other NB capital, ${fmt.m(m.outsideCapital)} outside capital in our rounds). ` : ''}` +
      `${m.revenue ? `Portfolio revenue ${fmt.m(m.revenue)} for the quarter as reported${m.revQoQ != null ? ` (${signedPct(m.revQoQ)} same-store QoQ)` : ''}. ` : ''}` +
      `${m.fte ? `Jobs ${count(m.fteNB)} in NB of ${count(m.fte)}${m.fteAtEntry ? ` (+${count(m.fte - m.fteAtEntry)} since entry)` : ''}. ` : ''}` +
      `${diversity.womenCosPct != null ? `Women in C-suite at ${Math.round(diversity.womenCosPct)}% of the ${diversity.reported} companies reporting.` : ''}\n` +
      `Strategic fund investments (separate): ${fm.n} LP positions, ${fmt.m(fm.committed)} committed (${fmt.m(fm.unfunded)} unfunded), NAV ${fmt.m(fm.nav)}, TVPI ${fmt.x(fm.tvpi)}, pooled IRR ${fmt.pct(fm.irr)}.`;
    void navigator.clipboard.writeText(txt).then(() => toast('Exec summary copied'));
  };

  const exportCsv = () => {
    const rows: (string | number)[][] = [
      ['id', 'name', 'sector', 'stage', 'vintage', 'instrument', 'health', 'ownership_pct', 'invested_m', 'fmv_m', 'realized_m', 'moic', 'board_seat', 'next_meeting', 'pro_rata', 'reserves_allocated_m', 'reserves_deployed_m', 'risk_flags', 'exited'],
    ];
    for (const c of db.companies) {
      rows.push([c.id, c.name, c.sector, c.stage, c.vintage, c.instrument, c.health, c.ownershipPct, c.invested, c.fmv, c.realized, (moic(c) ?? 0).toFixed(2), c.board.seat, c.board.nextMeeting ?? '', c.proRata ? 'Y' : 'N', c.reservesAllocated ?? 0, c.reservesDeployed ?? 0, (c.riskFlags ?? []).join('; '), c.exited ? 'Y' : 'N']);
    }
    const csv = rows.map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'portfolio_export.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="reporthead">
        <b>{db.fund.name}</b> - Quarterly Portfolio Report - {fiscalQuarterLabel(asOf)} (as at {asOf}) - Confidential
      </div>
      <ViewHeader
        title="Board / LP Report"
        sub="Board-ready summary. Print / PDF preserves this layout; CSV export for the data appendix."
      />

      <div className="fbar noprint">
        <button className="btn sm" onClick={() => window.print()}>
          Print / PDF
        </button>
        <button className="btn sm ghost" onClick={exportCsv}>
          Export portfolio CSV
        </button>
        <button className="btn sm ghost" onClick={execSummary}>
          Copy exec summary
        </button>
        <span className="count">
          {fiscalQuarterLabel(asOf)} - marks as at {asOf}
        </span>
      </div>

      <KpiRow>
        {evergreen ? (
          <>
            <Kpi
              label="Capital Base"
              value={fmt.m(db.fund.capitalBase)}
              sub={`Net deployed ${fmt.m(m.netDeployed)} / dry powder ${fmt.m(m.dryPowder)}`}
            />
            <Kpi label="Invested" value={fmt.m(m.invested)} sub={`${m.nActive} active positions`} />
            <Kpi label="NAV (FMV)" value={fmt.m(m.fmv)} />
            <Kpi label="TVPI (SI)" value={fmt.x(m.tvpi)} />
            <Kpi label="DPI" value={fmt.x(m.dpi)} sub="Proceeds recycled, not distributed" />
            <Kpi label="RVPI" value={fmt.x(m.rvpi)} />
            <Kpi label="SI Gross / Net IRR" value={fmt.pct(m.grossIRR)} sub={`Net ~${fmt.pct(m.netIRR)} est.`} />
          </>
        ) : (
          <>
            <Kpi
              label="Committed"
              value={fmt.m(db.fund.committed)}
              sub={`Called ${fmt.m(db.fund.called)} (${fmt.pct0((db.fund.called / db.fund.committed) * 100)})`}
            />
            <Kpi label="Invested" value={fmt.m(m.invested)} sub={`${m.nActive} active positions`} />
            <Kpi label="NAV (FMV)" value={fmt.m(m.fmv)} />
            <Kpi label="TVPI" value={fmt.x(m.tvpi)} />
            <Kpi label="DPI" value={fmt.x(m.dpi)} />
            <Kpi label="RVPI" value={fmt.x(m.rvpi)} />
            <Kpi label="Gross / Net IRR" value={fmt.pct(m.grossIRR)} sub={`Net ~${fmt.pct(m.netIRR)} est.`} />
          </>
        )}
      </KpiRow>

      {evergreen && (
        <div className="hint" style={{ margin: '-6px 0 12px' }}>
          Evergreen note: realized proceeds recycle into the capital base per policy, so DPI reflects capital returned to
          the fund rather than distributed to shareholders and will read low relative to a distributing vehicle at the
          same performance. TVPI and IRR are since inception.
        </div>
      )}
      {/* D-6: the board-facing view states that it labels fiscally. */}
      <div className="hint" style={{ margin: '-6px 0 12px' }}>
        {CONVENTION_NOTE.fiscal}
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Card title="Quarter Highlights">
          <AlertRow>
            <Pill tone="green">NEW</Pill>
            <span>
              {newYtd.length} new investment{newYtd.length === 1 ? '' : 's'} closed YTD {year}:{' '}
              {newYtd.map((c) => c.name).join(', ') || '-'}
            </span>
          </AlertRow>
          <AlertRow>
            <Pill tone="blue">EXIT</Pill>
            <span>
              {exitsYtd.length} exit{exitsYtd.length === 1 ? '' : 's'} YTD: {exitsYtd.map((c) => c.name).join(', ') || 'none'}
            </span>
          </AlertRow>
          <AlertRow>
            <Pill tone="yellow">WATCH</Pill>
            <span>
              {watch.length} companies on watchlist ({watch.filter((c) => c.health === 'red').length} red)
            </span>
          </AlertRow>
          <AlertRow>
            <Pill tone="gray">PACE</Pill>
            <span>
              {db.fund.ytdPlatformsClosed} of {db.fund.annualPlatformTarget} annual platform target closed
            </span>
          </AlertRow>
          {evergreen && (
            <AlertRow>
              <Pill tone="teal">RECYCLE</Pill>
              <span>
                {fmt.m(m.distributions)} realized proceeds recycled to date; dry powder {fmt.m(m.dryPowder)}.{' '}
                {db.fund.distributionPolicy}
              </span>
            </AlertRow>
          )}
          {m.fmvYoY != null && (
            <AlertRow>
              <Pill tone={m.fmvYoY >= 0 ? 'green' : 'red'}>GROWTH</Pill>
              <span>
                FMV {signedPct(m.fmvYoY)} YoY
                {m.organicYoY != null && ` - ${fmt.m(m.organicYoY)} organic value creation net of new capital deployed`}
              </span>
            </AlertRow>
          )}
          {m.leverage != null && (
            <AlertRow>
              <Pill tone="purple">LEVERAGE</Pill>
              <span>
                {fmt.m(m.capitalAttracted)} of third-party capital invested alongside our{' '}
                {fmt.m(m.roundsTotal - m.capitalAttracted)} in rounds we joined - {m.leverage.toFixed(1)}:1 leverage on
                our dollars ({fmt.m(m.nbCapital)} from other NB investors, {fmt.m(m.outsideCapital)} from outside NB)
              </span>
            </AlertRow>
          )}
          {/* D-2: quarterly actual, not run-rate. */}
          <AlertRow>
            <Pill tone="blue">REVENUE</Pill>
            <span>
              Underlying portfolio revenue {fmt.m(m.revenue)} for the quarter as reported
              {m.revQoQ != null && ` - same-store QoQ ${signedPct(m.revQoQ)}`}
            </span>
          </AlertRow>
          {/* D-5: coverage stated; non-reporters excluded from the denominator. */}
          <AlertRow>
            <Pill tone="teal">IMPACT</Pill>
            <span>
              {count(m.fteNB)} jobs in NB of {count(m.fte)} total ({m.fte ? Math.round((m.fteNB / m.fte) * 100) : 0}%)
              {m.fteAtEntry ? `, +${count(m.fte - m.fteAtEntry)} since entry` : ''}; women in C-suite at{' '}
              {diversity.womenCosPct != null ? `${Math.round(diversity.womenCosPct)}%` : '-'} of the {diversity.reported}{' '}
              of {diversity.total} companies reporting ({diversity.womenExecs} of {diversity.cSuiteTotal} exec seats)
            </span>
          </AlertRow>
        </Card>

        <Card title="Watchlist (yellow / red)">
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {watch.length === 0 && <div className="small">None.</div>}
            {watch.slice(0, 12).map((c) => (
              <AlertRow key={c.id}>
                <Dot tone={c.health} />
                <a className="link" onClick={() => openCompany(c.id)}>
                  {c.name}
                </a>
                <span className="small">
                  {c.riskFlags[0] || 'Under review'} - {fmt.x(moic(c))} MOIC
                </span>
              </AlertRow>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 14 }}>
        <Card title="Top 5 Value Drivers">
          <MoverTable rows={movers.slice(0, 5)} tone="up" />
        </Card>
        <Card title="Bottom 5 Positions">
          <MoverTable rows={movers.slice(-5).reverse()} tone="down" />
        </Card>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 14 }}>
        <Card title="NAV Bridge by Vintage ($M)">
          <div className="chartbox">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={navBridge} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="vintage" tick={AXIS} />
                <YAxis tick={AXIS} />
                <Tooltip formatter={(v: number) => v.toFixed(1)} />
                <Legend verticalAlign="top" height={28} />
                <Bar dataKey="Cost" fill="#9db3d4" />
                <Bar dataKey="FMV + Realized" fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Capital Deployed by Year ($M)">
          <div className="chartbox">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={deployed} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="year" tick={AXIS} />
                <YAxis tick={AXIS} />
                <Tooltip formatter={(v: number) => v.toFixed(1)} />
                <Bar dataKey="deployed" name="Deployed" fill="#0e7490" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {db.fundInvestments.length > 0 && (
        <Card
          title="Strategic Fund Investments (LP positions - reported separately from direct portfolio)"
          style={{ marginTop: 14 }}
        >
          <table className="dt">
            <thead>
              <tr>
                <th>Fund</th>
                <th>Strategy</th>
                <th>Vintage</th>
                <th className="num">Committed</th>
                <th className="num">Called</th>
                <th className="num">Unfunded</th>
                <th className="num">NAV</th>
                <th className="num">Dist.</th>
                <th className="num">TVPI</th>
                <th className="num">IRR</th>
              </tr>
            </thead>
            <tbody>
              {[...db.fundInvestments]
                .sort((a, b) => a.vintage - b.vintage)
                .map((f) => (
                  <tr key={f.id}>
                    <td>
                      <b>{f.name}</b>
                    </td>
                    <td className="small">{f.strategy}</td>
                    <td className="small">{f.vintage}</td>
                    <td className="num">{f.committed.toFixed(1)}</td>
                    <td className="num">{f.called.toFixed(1)}</td>
                    <td className="num">{(f.committed - f.called).toFixed(1)}</td>
                    <td className="num">{f.nav.toFixed(1)}</td>
                    <td className="num">{f.distributions.toFixed(1)}</td>
                    <td className={`num ${moicClass(fiTvpi(f))}`}>{fmt.x(fiTvpi(f))}</td>
                    <td className="num">{fmt.pct(fiIrr(f, asOf))}</td>
                  </tr>
                ))}
              <tr style={{ borderTop: '2px solid var(--line)' }}>
                <td>
                  <b>Total ({fm.n} funds)</b>
                </td>
                <td />
                <td />
                <td className="num">
                  <b>{fm.committed.toFixed(1)}</b>
                </td>
                <td className="num">
                  <b>{fm.called.toFixed(1)}</b>
                </td>
                <td className="num">
                  <b>{fm.unfunded.toFixed(1)}</b>
                </td>
                <td className="num">
                  <b>{fm.nav.toFixed(1)}</b>
                </td>
                <td className="num">
                  <b>{fm.distributions.toFixed(1)}</b>
                </td>
                <td className="num">
                  <b>{fmt.x(fm.tvpi)}</b>
                </td>
                <td className="num">
                  <b>{fmt.pct(fm.irr)}</b>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="hint" style={{ marginTop: 6 }}>
            Strategic value to date: {fmt.m(fm.toDirect)} deployed into our direct portfolio via co-invest and
            syndication; {fm.coInvests} co-investments executed; {fm.referrals} pipeline referrals; women in GP
            leadership at {fm.womenGPs} of {fm.n} managers. The indirect sleeve exists to attract capital to the direct
            strategy. Multiples on called capital per LP convention.
          </div>
        </Card>
      )}

      {/* ADR-017: these are management figures, not filed numbers. */}
      <div className="hint" style={{ marginTop: 12 }}>
        Management information. Mandate figures here are an early read on what the quarterly provincial report will need
        to contain; they are not the filed numbers and the existing submission process is unchanged.
      </div>
    </>
  );
}

function MoverTable({ rows, tone }: { rows: { c: PortfolioExport['companies'][number]; gl: number }[]; tone: 'up' | 'down' }) {
  return (
    <table className="dt">
      <thead>
        <tr>
          <th>Company</th>
          <th className="num">Cost</th>
          <th className="num">FMV</th>
          <th className="num">Unrealized G/L</th>
          <th className="num">MOIC</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ c, gl }) => (
          <tr key={c.id}>
            <td>
              <b>{c.name}</b> <span className="small">{c.sector}</span>
            </td>
            <td className="num">{c.invested.toFixed(1)}</td>
            <td className="num">{c.fmv.toFixed(1)}</td>
            <td className={`num ${tone}`}>
              {tone === 'up' ? '+' : ''}
              {gl.toFixed(1)}
            </td>
            <td className="num">{fmt.x(moic(c))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
