'use client';

/**
 * Portfolio, ported from `renderPortfolio` / `pfFiltered` /
 * `renderPortfolioTable` (vc-toolkit.html :811-875).
 *
 * Filter set, column order, sort behaviour, pill placement and colour
 * conventions are the prototype's (ADR-014). Filter state was a module-level
 * `PF` object there; here it is component state, which is the same thing with
 * a re-render attached.
 */
import { useMemo, useState } from 'react';

import type { Company, PortfolioExport } from '@portfolio-command/contract';
import { fmt, moic, totalGainLoss } from '@portfolio-command/metrics';

import { INSTRUMENTS, optionsFrom, SECTORS, STAGES } from '../../lib/constants';
import { useApp } from '../AppShell';
import { Card, Dot, Pill, ViewHeader, moicClass } from '../ui';

type SortKey = 'name' | 'sector' | 'stage' | 'vintage' | 'instrument' | 'ownershipPct' | 'invested' | 'fmv' | 'moic' | 'gl' | 'revenue' | 'runway' | 'health';
type ShowFilter = 'active' | 'all' | 'exited';

/** Column list and header labels, in the prototype's order (:859). */
const COLUMNS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: 'name', label: 'Company' },
  { key: 'sector', label: 'Sector' },
  { key: 'stage', label: 'Stage' },
  { key: 'vintage', label: 'Vintage' },
  { key: 'instrument', label: 'Instrument' },
  { key: 'ownershipPct', label: 'Own %', num: true },
  { key: 'invested', label: 'Cost $M', num: true },
  { key: 'fmv', label: 'FMV $M', num: true },
  { key: 'moic', label: 'MOIC', num: true },
  { key: 'gl', label: 'G/L $M', num: true },
  { key: 'revenue', label: 'Rev $M', num: true },
  { key: 'runway', label: 'Runway', num: true },
  { key: 'health', label: 'Health' },
];

export function PortfolioTab({ db }: { db: PortfolioExport }) {
  const { openCompany } = useApp();

  const [q, setQ] = useState('');
  const [show, setShow] = useState<ShowFilter>('active');
  const [sector, setSector] = useState('');
  const [stage, setStage] = useState('');
  const [health, setHealth] = useState('');
  const [instrument, setInstrument] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('fmv');
  const [sortDir, setSortDir] = useState(-1);

  /** `pfFiltered` (:832-853). */
  const rows = useMemo(() => {
    let cs = db.companies.filter((c) => (show === 'all' ? true : show === 'exited' ? c.exited : !c.exited));

    const needle = q.trim().toLowerCase();
    if (needle) {
      cs = cs.filter((c) => `${c.name} ${c.ceo} ${c.hq} ${c.sector}`.toLowerCase().includes(needle));
    }
    if (sector) cs = cs.filter((c) => c.sector === sector);
    if (stage) cs = cs.filter((c) => c.stage === stage);
    if (health) cs = cs.filter((c) => c.health === health);
    if (instrument) cs = cs.filter((c) => c.instrument === instrument);

    const value = (c: Company): string | number => {
      if (sortKey === 'moic') return moic(c) ?? -1;
      if (sortKey === 'gl') return totalGainLoss(c);
      // INHERITED: a company with no KPI sorts as 999 months of runway, so it
      // lands with the healthiest rather than the most urgent.
      if (sortKey === 'runway') return c.kpis[0]?.runwayMo ?? 999;
      if (sortKey === 'revenue') return c.kpis[0]?.revenue ?? -1;
      return c[sortKey] as string | number;
    };

    return [...cs].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (typeof av === 'string') return sortDir * av.localeCompare(bv as string);
      return sortDir * ((av || 0) - ((bv as number) || 0));
    });
  }, [db.companies, q, show, sector, stage, health, instrument, sortKey, sortDir]);

  /** Clicking the active column flips direction; a new column starts descending (:854). */
  const sortBy = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => d * -1);
    else {
      setSortKey(key);
      setSortDir(-1);
    }
  };

  const totalCost = rows.reduce((s, c) => s + c.invested, 0);
  const totalFmv = rows.reduce((s, c) => s + c.fmv, 0);

  return (
    <>
      <ViewHeader
        title="Portfolio"
        sub="Click any company for full detail: rounds, cap-table position, reserves, covenants, marks."
      />

      {/* Filter options are derived from the roster, so a real Affinity
          portfolio is not offered the prototype's sector list. See optionsFrom. */}
      <div className="fbar">
        <input type="text" placeholder="Search name / CEO / HQ..." value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={show} onChange={(e) => setShow(e.target.value as ShowFilter)}>
          <option value="active">Active only</option>
          <option value="all">Include exited</option>
          <option value="exited">Exited only</option>
        </select>
        <select value={sector} onChange={(e) => setSector(e.target.value)}>
          <option value="">All sectors</option>
          {optionsFrom(db.companies.map((c) => c.sector), SECTORS).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">All stages</option>
          {optionsFrom(db.companies.map((c) => c.stage), STAGES).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={health} onChange={(e) => setHealth(e.target.value)}>
          <option value="">All health</option>
          <option value="green">Green</option>
          <option value="yellow">Yellow</option>
          <option value="red">Red</option>
        </select>
        <select value={instrument} onChange={(e) => setInstrument(e.target.value)}>
          <option value="">All instruments</option>
          {optionsFrom(db.companies.map((c) => c.instrument), INSTRUMENTS).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className="count">
          {rows.length} companies - cost {fmt.m(totalCost)} - FMV {fmt.m(totalFmv)}
        </span>
      </div>

      <Card noBody>
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th key={col.key} className={col.num ? 'num' : undefined} onClick={() => sortBy(col.key)}>
                    {col.label} {sortKey === col.key && <span className="arrow">{sortDir < 0 ? '▼' : '▲'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const mo = moic(c);
                const gl = totalGainLoss(c);
                const k = c.kpis && c.kpis[0];
                return (
                  <tr key={c.id} className="click" onClick={() => openCompany(c.id)}>
                    <td>
                      <b>{c.name}</b>
                      {c.board.seat !== 'None' && <> <Pill tone="blue">{c.board.seat === 'Director' ? 'Board' : 'Obs'}</Pill></>}
                      {c.govFunding && <> <Pill tone="teal">Gov</Pill></>}
                      {c.exited && <> <Pill tone="gray">Exited</Pill></>}
                    </td>
                    <td className="small">{c.sector}</td>
                    <td className="small">{c.stage}</td>
                    <td className="small">{c.vintage}</td>
                    <td className="small">{c.instrument}</td>
                    <td className="num">{c.exited ? '-' : fmt.pct(c.ownershipPct)}</td>
                    <td className="num">{c.invested.toFixed(1)}</td>
                    <td className="num">{c.fmv.toFixed(1)}</td>
                    <td className={`num ${moicClass(mo)}`}>
                      <b>{fmt.x(mo)}</b>
                    </td>
                    <td className={`num ${gl >= 0 ? 'up' : 'down'}`}>
                      {gl >= 0 ? '+' : ''}
                      {gl.toFixed(1)}
                    </td>
                    <td className="num">{k ? k.revenue.toFixed(1) : '-'}</td>
                    <td className={`num ${k && k.runwayMo < 12 ? 'down' : ''}`}>
                      {k ? (k.runwayMo >= 99 ? '99+' : `${k.runwayMo} mo`) : '-'}
                    </td>
                    <td>
                      <Dot tone={c.health} />
                      {(c.riskFlags || []).length > 0 && (
                        <span className="small">
                          {c.riskFlags.length} flag{c.riskFlags.length > 1 ? 's' : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {/* D-2: the Rev column is the period actual as reported, not annualised. */}
      <div className="hint" style={{ marginTop: 8 }}>
        Rev is the latest quarter&apos;s actual revenue as reported through Visible, not a run-rate. MOIC is on invested
        cost; G/L includes realizations.
      </div>
    </>
  );
}
