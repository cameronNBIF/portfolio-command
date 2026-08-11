'use client';

/**
 * Modeling, ported from `renderModeling` / `renderReservesTool` /
 * `renderScenarioTool` (vc-toolkit.html :1547-1689).
 *
 * Two sub-tabs. Reserves edits update the shared store; scenario inputs stay
 * in a sandbox and are discarded when the company changes, exactly as the
 * prototype's `MODEL.inp` did.
 *
 * The waterfall carries ADR-016's simplifications -- 1x non-participating
 * preference, pari passu stack, pool carved pre-money, no ratchets -- and the
 * on-screen statement of them. That caveat is what makes the tool honest about
 * being directional rather than legal-grade, and it must not be removed.
 */
import { useEffect, useState } from 'react';

import type { Company, PortfolioExport } from '@portfolio-command/contract';
import {
  activeCompanies,
  fmt,
  fundMetrics,
  isEvergreen,
  moic,
  runScenario,
  scenarioDefaults,
  suggestedReserve,
  type ScenarioInputs,
} from '@portfolio-command/metrics';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { useEditable } from '../../lib/editable';
import { useApp } from '../AppShell';
import { Card, Dot, Kpi, KpiRow, Pill, ViewHeader, moicClass } from '../ui';

const AXIS = { fontSize: 11, fill: '#5b6878' };
const GRID = '#eaeef3';

export function ModelingTab({ db, asOf }: { db: PortfolioExport; asOf: string }) {
  const [sub, setSub] = useState<'reserves' | 'scenario'>('reserves');

  return (
    <>
      <ViewHeader
        title="Modeling"
        sub="Follow-on reserve allocation and forward scenarios. Edits here update the in-memory store (reserves) or stay in the sandbox (scenarios)."
      />
      <div className="tabs2">
        <button className={sub === 'reserves' ? 'active' : undefined} onClick={() => setSub('reserves')}>
          Reserves &amp; Follow-On
        </button>
        <button className={sub === 'scenario' ? 'active' : undefined} onClick={() => setSub('scenario')}>
          Exit Waterfall &amp; Dilution
        </button>
      </div>
      {sub === 'reserves' ? <ReservesTool db={db} asOf={asOf} /> : <ScenarioTool db={db} />}
    </>
  );
}

/* ------------------------------ Reserves ------------------------------ */

function ReservesTool({ db, asOf }: { db: PortfolioExport; asOf: string }) {
  const { openCompany } = useApp();
  const { reserveOverrides, setReserve } = useEditable();

  const allocated = (c: Company) => reserveOverrides[c.id] ?? c.reservesAllocated ?? 0;

  const act = [...activeCompanies(db.companies)].sort((a, b) => b.invested - a.invested);
  const tAlloc = act.reduce((s, c) => s + allocated(c), 0);
  const tDep = act.reduce((s, c) => s + (c.reservesDeployed || 0), 0);
  const tSug = act.reduce((s, c) => s + suggestedReserve(c), 0);
  const dry = fundMetrics(db, { asOf }).dryPowder;

  return (
    <>
      <KpiRow>
        <Kpi
          label="Allocated Reserves"
          value={fmt.m(tAlloc)}
          sub={`across ${act.filter((c) => allocated(c) > 0).length} companies`}
        />
        <Kpi label="Deployed" value={fmt.m(tDep)} sub={`Remaining ${fmt.m(tAlloc - tDep)}`} />
        <Kpi
          label="Policy-Suggested"
          value={fmt.m(tSug)}
          sub={`${tAlloc > tSug ? 'Over' : 'Under'}-allocated by ${fmt.m(Math.abs(tAlloc - tSug))}`}
        />
        <Kpi
          label={isEvergreen(db) ? 'Dry Powder' : 'Uncalled Capital'}
          value={fmt.m(dry)}
          sub={isEvergreen(db) ? 'Capital base less net deployed' : 'Committed less called'}
        />
        <Kpi label="Annual Follow-On Budget" value={fmt.m(db.fund.annualFollowOnBudget)} sub="per plan" />
      </KpiRow>

      <Card title="Allocation by Company" headerExtra={<span className="hint">{db.fund.reservesPolicy}</span>} noBody>
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Company</th>
                <th>Health</th>
                <th>Pro-Rata</th>
                <th className="num">Initial Check</th>
                <th className="num">Total Cost</th>
                <th className="num">MOIC</th>
                <th className="num">Suggested $M</th>
                <th className="num">Allocated $M</th>
                <th className="num">Deployed</th>
                <th className="num">Remaining</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {act.map((c) => {
                const sug = suggestedReserve(c);
                const alloc = allocated(c);
                const remaining = alloc - (c.reservesDeployed || 0);
                // Flags an allocation that has drifted from policy by more than a rounding step.
                const off = Math.abs(alloc - sug) > 0.05;
                const mo = moic(c);
                return (
                  <tr key={c.id}>
                    <td>
                      <a className="link" onClick={() => openCompany(c.id)}>
                        <b>{c.name}</b>
                      </a>
                    </td>
                    <td>
                      <Dot tone={c.health} />
                    </td>
                    <td>{c.proRata ? <Pill tone="green">Yes</Pill> : <Pill tone="gray">No</Pill>}</td>
                    <td className="num">{(c.rounds[0]?.invested ?? c.invested).toFixed(1)}</td>
                    <td className="num">{c.invested.toFixed(1)}</td>
                    <td className={`num ${moicClass(mo)}`}>{fmt.x(mo)}</td>
                    <td className={`num ${off ? 'down' : ''}`}>{sug.toFixed(1)}</td>
                    <td className="num">
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        value={alloc.toFixed(1)}
                        style={{
                          width: 70,
                          textAlign: 'right',
                          border: '1px solid var(--line)',
                          borderRadius: 5,
                          padding: '3px 5px',
                        }}
                        onChange={(e) => setReserve(c.id, parseFloat(e.target.value))}
                      />
                    </td>
                    <td className="num">{(c.reservesDeployed || 0).toFixed(1)}</td>
                    <td className={`num ${remaining > 0 ? 'up' : ''}`}>{remaining.toFixed(1)}</td>
                    <td>
                      <button className="btn sm ghost" onClick={() => setReserve(c.id, sug)}>
                        Use suggested
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="hint" style={{ marginTop: 8 }}>
        Edits update the in-memory store immediately (totals above recalculate) and are held for this session. Suggested
        = 0.8x initial check (green) / 0.5x (yellow), pro-rata holders only, red excluded.
      </div>
    </>
  );
}

/* ------------------------------ Scenario ------------------------------ */

function ScenarioTool({ db }: { db: PortfolioExport }) {
  const act = activeCompanies(db.companies)
    .filter((c) => c.ownershipPct > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const [cid, setCid] = useState<string>(() => act[0]?.id ?? '');
  const company = act.find((c) => c.id === cid) ?? act[0];

  const [inputs, setInputs] = useState<ScenarioInputs | null>(null);

  // Inputs reset when the company changes, as `MODEL.inp._cid` did (:1642).
  useEffect(() => {
    setInputs(company ? scenarioDefaults(company) : null);
  }, [company]);

  if (!company) return <div className="small">No active companies.</div>;
  if (!inputs) return null;

  const s = inputs;
  const r = runScenario(company, s);
  const set = (key: keyof ScenarioInputs, value: number | boolean | null) =>
    setInputs((prev) => (prev ? { ...prev, [key]: value } : prev));

  const field = (label: string, key: keyof ScenarioInputs, step = 1) => (
    <div className="item">
      <div className="l">{label}</div>
      <input
        type="number"
        step={step}
        value={(s[key] as number | null) ?? ''}
        style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 5, padding: '4px 6px', marginTop: 2 }}
        onChange={(e) => set(key, parseFloat(e.target.value) || 0)}
      />
    </div>
  );

  // Proceeds curve: 41 points to 1.25x the bull case (:1680-1682).
  const maxE = Math.max(s.bull * 1.25, 10);
  const curve = Array.from({ length: 41 }, (_, i) => {
    const E = (maxE * i) / 40;
    return {
      ev: Math.round(E),
      'Our proceeds': +r.proceedsAt(E).toFixed(1),
      'Our cost (breakeven)': +r.investedTotal.toFixed(1),
    };
  });

  return (
    <>
      <div className="fbar">
        <select value={cid} onChange={(e) => setCid(e.target.value)}>
          {act.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button className="btn sm ghost" onClick={() => setInputs(scenarioDefaults(company))}>
          Reset inputs
        </button>
        <span className="count">
          Current: {fmt.pct(company.ownershipPct)} ownership - {fmt.m(company.invested)} cost - marked{' '}
          {fmt.m(company.fmv)} (implied EV {fmt.m(company.fmv / (company.ownershipPct / 100))})
        </span>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '320px 1fr' }}>
        <Card title="Assumptions">
          <div className="dsec">
            <h4>Next Round</h4>
            <div className="kv" style={{ gridTemplateColumns: '1fr 1fr' }}>
              {field('Raise $M', 'raise')}
              {field('Pre-money $M', 'pre')}
              {field('Pool expansion %', 'pool', 0.5)}
              <div className="item">
                <div className="l">PARTICIPATE (PRO-RATA)</div>
                <select
                  style={{ width: '100%', marginTop: 2, border: '1px solid var(--line)', borderRadius: 5, padding: 4 }}
                  value={s.participate ? 'y' : 'n'}
                  onChange={(e) => set('participate', e.target.value === 'y')}
                >
                  <option value="y">Yes</option>
                  <option value="n">No</option>
                </select>
              </div>
              {s.participate && field('Override our $M (blank = pro-rata)', 'partAmt', 0.1)}
            </div>
          </div>
          <div className="dsec">
            <h4>Exit</h4>
            <div className="kv" style={{ gridTemplateColumns: '1fr 1fr' }}>
              {field('Bear exit $M', 'bear')}
              {field('Base exit $M', 'base')}
              {field('Bull exit $M', 'bull')}
              {field('Years to exit', 'yrs', 0.5)}
              {field('Pref stack today $M', 'totalPref')}
            </div>
          </div>
          {/* ADR-016: the simplifications are stated on screen, deliberately. */}
          <div className="hint">
            Simplifications: 1x non-participating preference, pari passu stack, pool carved pre-money, no anti-dilution
            ratchets. Waterfall = greater of preference or as-converted at exit. Directional only — not a legal-grade
            proceeds calculation.
          </div>
        </Card>

        <div>
          <KpiRow>
            <Kpi
              label="Ownership After Round"
              value={fmt.pct(r.ownAfter)}
              sub={`from ${fmt.pct(company.ownershipPct)} (${r.partAmt > 0 ? `+${fmt.m(r.partAmt)} follow-on` : 'no participation'})`}
            />
            <Kpi
              label="Post-Money"
              value={fmt.m(r.post)}
              sub={`New money ${fmt.pct(r.newInvPct)} + pool ${fmt.pct(r.poolPct)}`}
            />
            <Kpi label="Total Cost After" value={fmt.m(r.investedTotal)} sub={`Our 1x pref = ${fmt.m(r.ourPref)}`} />
            <Kpi label="Pref Stack After" value={fmt.m(r.totalPref)} sub="All preferred, pari passu" />
          </KpiRow>

          <Card title="Scenario Outcomes">
            <table className="dt">
              <thead>
                <tr>
                  <th>Case</th>
                  <th className="num">Exit EV $M</th>
                  <th className="num">Our Proceeds $M</th>
                  <th className="num">MOIC</th>
                  <th className="num">IRR ({s.yrs}y)</th>
                </tr>
              </thead>
              <tbody>
                {r.cases.map(([name, x]) => (
                  <tr key={name}>
                    <td>
                      <b>{name}</b>
                    </td>
                    <td className="num">{x.E.toFixed(0)}</td>
                    <td className="num">{x.p.toFixed(1)}</td>
                    <td className={`num ${moicClass(x.mo)}`}>
                      <b>{fmt.x(x.mo)}</b>
                    </td>
                    <td className="num">{x.irr != null ? fmt.pct(x.irr) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Proceeds vs. Exit Value" style={{ marginTop: 14 }}>
            <div className="chartbox">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={curve} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis
                    dataKey="ev"
                    tick={AXIS}
                    interval={4}
                    label={{ value: 'Exit enterprise value ($M)', position: 'insideBottom', offset: -2, style: AXIS }}
                  />
                  <YAxis tick={AXIS} label={{ value: '$M', angle: -90, position: 'insideLeft', style: AXIS }} />
                  <Tooltip formatter={(v: number) => v.toFixed(1)} />
                  <Legend verticalAlign="top" height={28} />
                  <Line
                    type="monotone"
                    dataKey="Our proceeds"
                    stroke="#2563eb"
                    strokeWidth={2}
                    dot={false}
                    fill="rgba(37,99,235,.07)"
                  />
                  <Line
                    type="monotone"
                    dataKey="Our cost (breakeven)"
                    stroke="#b45309"
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
