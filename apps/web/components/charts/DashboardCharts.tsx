'use client';

/**
 * The dashboard's ten charts, ported from `drawDashboardCharts`
 * (vc-toolkit.html :731-805) from Chart.js to Recharts at visual parity
 * (ADR-014).
 *
 * Series, grouping, sort order, bin edges, stacking and colours are the
 * prototype's. Where Chart.js supplied a default that Recharts does not --
 * tooltip styling, tick colour, legend placement -- globals.css reproduces it
 * rather than the components each restating it.
 *
 * The grouping arithmetic here is chart shaping, not metric definition: it
 * decides which bar a company lands in, never what a board figure means. The
 * one exception is noted on `JCurveChart`.
 */
import type { Company, PortfolioExport } from '@portfolio-command/contract';
import { moic } from '@portfolio-command/metrics';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/** vc-toolkit.html :674. */
const PALETTE = [
  '#2563eb', '#0e7490', '#7c3aed', '#15803d', '#b45309',
  '#b91c1c', '#475569', '#be185d', '#4d7c0f', '#1e40af',
];

const AXIS = { fontSize: 11, fill: '#5b6878' };
const GRID = '#eaeef3';

/** `groupSum` (:730). */
function groupSum<T>(arr: T[], key: (x: T) => string, val: (x: T) => number): Record<string, number> {
  const g: Record<string, number> = {};
  for (const x of arr) {
    const k = key(x);
    g[k] = (g[k] ?? 0) + val(x);
  }
  return g;
}

function Box({ tall, children }: { tall?: boolean; children: React.ReactElement }) {
  return (
    <div className={tall ? 'chartbox tall' : 'chartbox'}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

const money = (v: number) => `${v.toFixed(1)}`;

/* ---------------- FMV vs cost by sector (:733-739) ---------------- */

export function FmvCostBySectorChart({ active }: { active: Company[] }) {
  const cost = groupSum(active, (c) => c.sector, (c) => c.invested);
  const fmv = groupSum(active, (c) => c.sector, (c) => c.fmv);
  const data = Object.keys(cost)
    .sort((a, b) => (fmv[b] ?? 0) - (fmv[a] ?? 0))
    .map((s) => ({ sector: s, Cost: cost[s] ?? 0, FMV: fmv[s] ?? 0 }));

  return (
    <Box tall>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="sector" tick={AXIS} interval={0} angle={-20} textAnchor="end" height={60} />
        <YAxis tick={AXIS} label={{ value: '$M', angle: -90, position: 'insideLeft', style: AXIS }} />
        <Tooltip formatter={money} />
        <Legend verticalAlign="top" height={28} />
        <Bar dataKey="Cost" fill="#9db3d4" />
        <Bar dataKey="FMV" fill="#2563eb" />
      </BarChart>
    </Box>
  );
}

/* ---------------- NAV vs cumulative cost (:740-747) ---------------- */

export function NavGrowthChart({ db }: { db: PortfolioExport }) {
  const data = (db.fund.navHistory ?? []).map((x) => ({ q: x.q, 'NAV (FMV)': x.nav, 'Cumulative cost': x.cost }));
  if (!data.length) return null;

  return (
    <Box>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="q" tick={AXIS} />
        <YAxis tick={AXIS} label={{ value: '$M', angle: -90, position: 'insideLeft', style: AXIS }} />
        <Tooltip formatter={money} />
        <Legend verticalAlign="top" height={28} />
        <Line type="monotone" dataKey="NAV (FMV)" stroke="#2563eb" strokeWidth={2} dot={{ r: 2 }} />
        <Line
          type="monotone"
          dataKey="Cumulative cost"
          stroke="#b45309"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          dot={false}
        />
      </LineChart>
    </Box>
  );
}

/* ---------------- Capital attracted by year (:748-758) ----------------
   Applies the SAME round-exclusion predicate as the leverage KPI, and caps NB
   capital at the round's third-party total with Math.min.

   NOTE: `fundMetrics.nbCapital` does NOT cap and does NOT exclude, so this
   chart and the "NB Co-Investment" tile above it disagree slightly. That
   disagreement is the prototype's and is reproduced deliberately
   (INHERITED-COERCIONS.md §2). */

export function CapitalAttractedChart({ db }: { db: PortfolioExport }) {
  const byYear: Record<string, { ours: number; nb: number; out: number }> = {};
  for (const c of db.companies) {
    for (const r of c.rounds) {
      if (!r.roundTotal || r.roundTotal < r.invested) continue;
      const y = r.date.slice(0, 4);
      byYear[y] ??= { ours: 0, nb: 0, out: 0 };
      const other = r.roundTotal - r.invested;
      const nb = Math.min(other, r.nbOther ?? 0);
      byYear[y].ours += r.invested;
      byYear[y].nb += nb;
      byYear[y].out += other - nb;
    }
  }
  const data = Object.keys(byYear)
    .sort()
    .map((y) => ({
      year: y,
      'Our capital': +byYear[y]!.ours.toFixed(1),
      'Other NB capital': +byYear[y]!.nb.toFixed(1),
      'Outside capital attracted': +byYear[y]!.out.toFixed(1),
    }));

  return (
    <Box>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="year" tick={AXIS} />
        <YAxis tick={AXIS} label={{ value: '$M per round year', angle: -90, position: 'insideLeft', style: AXIS }} />
        <Tooltip formatter={money} />
        <Legend verticalAlign="top" height={28} />
        <Bar dataKey="Our capital" stackId="a" fill="#16263f" />
        <Bar dataKey="Other NB capital" stackId="a" fill="#7c3aed" />
        <Bar dataKey="Outside capital attracted" stackId="a" fill="#0e7490" />
      </BarChart>
    </Box>
  );
}

/* ---------------- Sourcing channels (:759-763) ---------------- */

export function SourcingChart({ active }: { active: Company[] }) {
  const counts = groupSum(active, (c) => c.source || 'Unrecorded', () => 1);
  const data = Object.keys(counts)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))
    .map((k) => ({ source: k, count: counts[k] ?? 0 }));

  return (
    <Box>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 4 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS}
          allowDecimals={false}
          label={{ value: '# active companies', position: 'insideBottom', offset: -2, style: AXIS }}
        />
        <YAxis type="category" dataKey="source" tick={AXIS} width={130} />
        <Tooltip />
        <Bar dataKey="count" fill="#2563eb" />
      </BarChart>
    </Box>
  );
}

/* ---------------- MOIC histogram (:764-769) ---------------- */

const MOIC_BINS = ['<0.5x', '0.5-1x', '1-1.5x', '1.5-2x', '2-3x', '3x+'];
const MOIC_COLOURS = ['#b91c1c', '#e09a1a', '#94a3b8', '#60a5fa', '#2563eb', '#15803d'];

export function MoicDistributionChart({ active }: { active: Company[] }) {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const c of active) {
    const mo = moic(c);
    if (mo == null) continue;
    counts[mo < 0.5 ? 0 : mo < 1 ? 1 : mo < 1.5 ? 2 : mo < 2 ? 3 : mo < 3 ? 4 : 5]! += 1;
  }
  const data = MOIC_BINS.map((bin, i) => ({ bin, count: counts[i] ?? 0 }));

  return (
    <Box>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="bin" tick={AXIS} />
        <YAxis tick={AXIS} allowDecimals={false} label={{ value: '# companies', angle: -90, position: 'insideLeft', style: AXIS }} />
        <Tooltip />
        <Bar dataKey="count">
          {data.map((_, i) => (
            <Cell key={i} fill={MOIC_COLOURS[i]} />
          ))}
        </Bar>
      </BarChart>
    </Box>
  );
}

/* ---------------- Vintage performance (:770-774) ----------------
   Gross MOIC per vintage over ALL companies. Returns 0 rather than null for a
   vintage with no cost, so it plots a zero bar rather than a gap
   (INHERITED-COERCIONS.md §11). */

export function VintagePerformanceChart({ db }: { db: PortfolioExport }) {
  const years = [...new Set(db.companies.map((c) => c.vintage))].sort((a, b) => a - b);
  const data = years.map((y) => {
    const g = db.companies.filter((c) => c.vintage === y);
    const inv = g.reduce((s, c) => s + c.invested, 0);
    const val = g.reduce((s, c) => s + c.fmv + c.realized, 0);
    return { vintage: String(y), moic: inv > 0 ? val / inv : 0 };
  });

  return (
    <Box>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="vintage" tick={AXIS} />
        <YAxis tick={AXIS} label={{ value: 'MOIC (x)', angle: -90, position: 'insideLeft', style: AXIS }} />
        <Tooltip formatter={(v: number) => `${v.toFixed(2)}x`} />
        <Bar dataKey="moic" name="Gross MOIC">
          {data.map((d, i) => (
            <Cell key={i} fill={d.moic >= 1.5 ? '#15803d' : d.moic >= 1 ? '#2563eb' : '#b45309'} />
          ))}
        </Bar>
      </BarChart>
    </Box>
  );
}

/* ---------------- J-curve (:775-795) ----------------
   A MODELLED chart series, not a metric -- `navApprox` interpolates NAV from
   the fraction of capital deployed and a six-year ramp. It stayed out of
   packages/metrics for that reason (INHERITED-COERCIONS.md §12).

   Two substitutions, both required and neither visual on this data:
     - `new Date()` becomes `asOf`, so the series ends at the reporting date
       rather than wherever the clock happens to be (ADR-021);
     - the hardcoded `new Date(2019,0,1)` start becomes `fund.vintage`, which
       IS 2019 here. Reading inception from the fund rather than from a literal
       means a different fund does not silently plot from the wrong year. */

export function JCurveChart({ db, asOf, totalFmv, totalInvested, isEvergreen }: {
  db: PortfolioExport;
  asOf: string;
  totalFmv: number;
  totalInvested: number;
  isEvergreen: boolean;
}) {
  const flows: { t: number; amt: number }[] = [];
  for (const c of db.companies) for (const r of c.rounds) flows.push({ t: new Date(r.date).getTime(), amt: -r.invested });
  for (const d of db.fund.distributions) flows.push({ t: new Date(d.date).getTime(), amt: d.amount });
  flows.sort((a, b) => a.t - b.t);

  const start = new Date(Date.UTC(db.fund.vintage, 0, 1));
  const end = new Date(asOf);
  const quarters: Date[] = [];
  for (const d = new Date(start); d <= end; d.setUTCMonth(d.getUTCMonth() + 3)) quarters.push(new Date(d));

  const data = quarters.map((q) => {
    const t = q.getTime();
    const cum = flows.filter((f) => f.t <= t).reduce((s, f) => s + f.amt, 0);
    const investedSoFar = flows.filter((f) => f.t <= t && f.amt < 0).reduce((s, f) => s - f.amt, 0);
    const elapsedYrs = (t - start.getTime()) / (365.25 * 24 * 3600 * 1000);
    const ratio = totalFmv / Math.max(totalInvested, 1);
    const navApprox = investedSoFar * Math.min(ratio, 1 + (ratio - 1) * Math.min(elapsedYrs / 6, 1));
    return {
      label: `${q.getUTCFullYear()}-Q${Math.floor(q.getUTCMonth() / 3) + 1}`,
      net: cum,
      tv: cum + navApprox,
    };
  });

  const netLabel = isEvergreen ? 'Net deployment (cost less realizations)' : 'Net cash flow';

  return (
    <Box>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} interval={Math.max(0, Math.floor(data.length / 8) - 1)} />
        <YAxis tick={AXIS} label={{ value: '$M', angle: -90, position: 'insideLeft', style: AXIS }} />
        <Tooltip formatter={money} />
        <Legend verticalAlign="top" height={28} />
        <Line type="monotone" dataKey="net" name={netLabel} stroke="#b45309" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="tv" name="Net CF + NAV (est.)" stroke="#2563eb" strokeWidth={2} dot={false} />
      </LineChart>
    </Box>
  );
}

/* ---------------- Allocation doughnuts (:796-799) ---------------- */

export function AllocationDonut({ active, by }: { active: Company[]; by: 'sector' | 'stage' }) {
  const g = groupSum(active, (c) => c[by], (c) => c.fmv);
  const data = Object.keys(g)
    .sort((a, b) => (g[b] ?? 0) - (g[a] ?? 0))
    .map((k) => ({ name: k, value: g[k] ?? 0 }));

  return (
    <Box>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="88%" paddingAngle={0} stroke="#fff" strokeWidth={1}>
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip formatter={money} />
        <Legend layout="vertical" align="right" verticalAlign="middle" iconSize={10} />
      </PieChart>
    </Box>
  );
}

/* ---------------- Top / bottom by unrealized G/L (:800-804) ----------------
   Top 6 and bottom 4. INHERITED: the two slices overlap if fewer than ten
   active companies exist (INHERITED-COERCIONS.md §12). */

export function TopBottomChart({ active }: { active: Company[] }) {
  const ranked = [...active].sort((a, b) => b.fmv - b.invested - (a.fmv - a.invested));
  const picked = [...ranked.slice(0, 6), ...ranked.slice(-4)];
  const data = picked.map((c) => ({ name: c.name, gl: +(c.fmv - c.invested).toFixed(1), positive: c.fmv >= c.invested }));

  return (
    <Box>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 4 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS}
          label={{ value: 'Unrealized G/L ($M)', position: 'insideBottom', offset: -2, style: AXIS }}
        />
        <YAxis type="category" dataKey="name" tick={AXIS} width={130} />
        <Tooltip formatter={money} />
        <Bar dataKey="gl" name="Unrealized G/L">
          {data.map((d, i) => (
            <Cell key={i} fill={d.positive ? '#15803d' : '#b91c1c'} />
          ))}
        </Bar>
      </BarChart>
    </Box>
  );
}
