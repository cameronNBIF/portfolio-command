'use client';

/**
 * Strategic Fund Investments, ported from `renderFunds`
 * (vc-toolkit.html :977-1024).
 *
 * These LP positions are NEVER blended with the direct portfolio and are
 * excluded from the Dashboard's fund metrics. Multiples here are on CALLED
 * capital per standard LP convention; direct MOIC is on invested cost. The
 * hint at the foot of the table says so, and it must stay.
 *
 * THE THIRD SANCTIONED ADR-014 CONTENT EXCEPTION (F5, FR-33). The prototype's
 * column headings read Committed / Called / Capital call; NBIF's words for the
 * three LP stages are **Committed Capital, Capital Drawdown and Capital
 * Distribution**, confirmed with Funke at Q-23. Layout, ordering, colour and
 * behaviour are untouched -- this is the same one-to-one port with four words
 * changed, and the alternative was a platform whose Finance screens and board
 * screens name the same event differently. Recorded in ADR-014 and ADR-037.
 */
import type { PortfolioExport } from '@portfolio-command/contract';
import { fiDpi, fiIrr, fiTvpi, fmt, lpMetrics } from '@portfolio-command/metrics';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useApp } from '../AppShell';
import { Card, Kpi, KpiRow, Pill, ViewHeader, moicClass } from '../ui';

const PALETTE = ['#2563eb', '#0e7490', '#7c3aed', '#15803d', '#b45309', '#b91c1c', '#475569', '#be185d'];
const AXIS = { fontSize: 11, fill: '#5b6878' };
const GRID = '#eaeef3';

export function FundsTab({ db, asOf }: { db: PortfolioExport; asOf: string }) {
  const { openDrawer } = useApp();

  const positions = [...(db.fundInvestments ?? [])].sort((a, b) => a.vintage - b.vintage);
  const fm = lpMetrics(db, { asOf });

  const vintages = [...new Set(positions.map((f) => f.vintage))].sort((a, b) => a - b);
  const pacing = vintages.map((y) => ({
    vintage: String(y),
    Drawn: positions.filter((f) => f.vintage === y).reduce((s, f) => s + f.called, 0),
    Unfunded: positions.filter((f) => f.vintage === y).reduce((s, f) => s + f.committed - f.called, 0),
  }));

  const byStrategy: Record<string, number> = {};
  for (const f of positions) byStrategy[f.strategy] = (byStrategy[f.strategy] ?? 0) + f.nav;
  const strategyData = Object.keys(byStrategy)
    .sort((a, b) => (byStrategy[b] ?? 0) - (byStrategy[a] ?? 0))
    .map((k) => ({ name: k, value: byStrategy[k] ?? 0 }));

  return (
    <>
      <ViewHeader
        title="Strategic Fund Investments"
        sub="LP positions - tracked separately from the direct portfolio (excluded from direct-fund metrics on the Dashboard). This sleeve exists to attract capital and co-investors to the direct strategy; Capital to Direct measures that. Click a position for cashflows and strategic value."
      />

      <KpiRow>
        <Kpi label="Committed Capital" value={fmt.m(fm.committed)} sub={`${fm.n} funds`} />
        <Kpi label="Drawn" value={fmt.m(fm.called)} sub={`Unfunded ${fmt.m(fm.unfunded)}`} />
        <Kpi label="NAV" value={fmt.m(fm.nav)} sub={`Distributions ${fmt.m(fm.distributions)}`} />
        <Kpi label="TVPI" value={fmt.x(fm.tvpi)} sub={`DPI ${fmt.x(fm.dpi)} / RVPI ${fmt.x(fm.rvpi)}`} />
        <Kpi label="Net IRR" value={fmt.pct(fm.irr)} sub="Pooled, since inception" />
        <Kpi
          label="Capital to Direct"
          value={fmt.m(fm.toDirect)}
          sub={`${fm.coInvests} co-invests / ${fm.referrals} referrals`}
        />
        <Kpi
          label="Women in GP Leadership"
          value={`${fm.womenGPs} / ${fm.n}`}
          sub="Positions with women senior partners"
        />
      </KpiRow>

      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', marginBottom: 14 }}>
        <Card title="Commitment Pacing by Vintage (staggered)">
          <div className="chartbox">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pacing} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="vintage" tick={AXIS} />
                <YAxis tick={AXIS} label={{ value: '$M committed', angle: -90, position: 'insideLeft', style: AXIS }} />
                <Tooltip formatter={(v: number) => v.toFixed(1)} />
                <Legend verticalAlign="top" height={28} />
                <Bar dataKey="Drawn" stackId="a" fill="#2563eb" />
                <Bar dataKey="Unfunded" stackId="a" fill="#9db3d4" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="NAV by Strategy">
          <div className="chartbox">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={strategyData} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="88%" stroke="#fff" strokeWidth={1}>
                  {strategyData.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => v.toFixed(1)} />
                <Legend layout="vertical" align="right" verticalAlign="middle" iconSize={10} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card noBody>
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Fund</th>
                <th>Strategy</th>
                <th>Vintage</th>
                <th className="num">Committed Capital</th>
                <th className="num">Drawn</th>
                <th className="num">Unfunded</th>
                <th className="num">NAV</th>
                <th className="num">Dist.</th>
                <th className="num">TVPI</th>
                <th className="num">DPI</th>
                <th className="num">IRR</th>
                <th className="num">To Direct</th>
                <th>Co-Invest</th>
                <th>Next Drawdown (est.)</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((f) => {
                const tvpi = fiTvpi(f);
                return (
                  <tr key={f.id} className="click" onClick={() => openDrawer({ kind: 'lp', id: f.id })}>
                    <td>
                      <b>{f.name}</b>
                      <div className="small">{f.manager}</div>
                    </td>
                    <td className="small">{f.strategy}</td>
                    <td className="small">{f.vintage}</td>
                    <td className="num">{f.committed.toFixed(1)}</td>
                    <td className="num">{f.called.toFixed(1)}</td>
                    <td className={`num ${f.committed - f.called > 0.05 ? '' : 'flat'}`}>
                      {(f.committed - f.called).toFixed(1)}
                    </td>
                    <td className="num">{f.nav.toFixed(1)}</td>
                    <td className="num">{f.distributions.toFixed(1)}</td>
                    <td className={`num ${moicClass(tvpi)}`}>
                      <b>{fmt.x(tvpi)}</b>
                    </td>
                    <td className="num">{fmt.x(fiDpi(f))}</td>
                    <td className="num">{fmt.pct(fiIrr(f, asOf))}</td>
                    <td className={`num ${f.capitalToDirect > 0 ? 'up' : 'flat'}`}>{(f.capitalToDirect || 0).toFixed(1)}</td>
                    <td>{f.coInvestRights ? <Pill tone="green">Rights</Pill> : <Pill tone="gray">No</Pill>}</td>
                    <td className="small">{fmt.d(f.nextCallEst)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="hint" style={{ marginTop: 8 }}>
        Fund-position TVPI/DPI are on drawn capital (standard LP convention), unlike direct-portfolio MOIC on invested
        cost. Pooled IRR from all drawdown and distribution cashflows plus current NAV, as at {asOf}.
      </div>
    </>
  );
}
