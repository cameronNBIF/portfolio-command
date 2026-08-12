'use client';

/**
 * Deal Pipeline, ported from `renderPipeline` (vc-toolkit.html :1065-1095).
 *
 * Kanban columns with terminal `Passed` deals listed underneath rather than
 * given board space. Stage weights, tile order and copy are the prototype's
 * (ADR-014).
 *
 * The columns, their order and the "active" test come from the contract's
 * `funnelGroups` rather than from a hardcoded list, because a deal now carries
 * its EXACT Affinity status -- sixteen of them -- rather than one of the
 * prototype's seven bins. See lib/funnel.ts.
 */
import type { PortfolioExport } from '@portfolio-command/contract';
import { fmt } from '@portfolio-command/metrics';

import { funnelView } from '../../lib/funnel';
import { useEditable } from '../../lib/editable';
import { useApp } from '../AppShell';
import { Kpi, KpiRow, Pill, Progress, ViewHeader } from '../ui';

export function PipelineTab({ db, asOf }: { db: PortfolioExport; asOf: string }) {
  const { openDrawer } = useApp();
  const { pipeline: deals } = useEditable();

  const funnel = funnelView(db);
  const active = deals.filter((d) => !funnel.isTerminal(d.funnel));
  const offBoard = funnel.offBoard.map((g) => ({
    group: g,
    deals: deals.filter((d) => funnel.groupOf(d.funnel) === g.name),
  }));
  const passed = offBoard.find((o) => o.group.name === 'Passed')?.deals ?? [];

  /**
   * INHERITED: the prototype hardcoded the string "2026" here (:1069). The
   * port reads the year from `asOf` instead, so the figure does not silently
   * become wrong on 1 January. Identical output on this data.
   * (INHERITED-COERCIONS.md §9.)
   */
  const year = asOf.slice(0, 4);
  const closedStages = funnel.stagesIn('Closed');
  const closedYtd = deals.filter(
    (d) => closedStages.includes(d.funnel) && d.closedDate?.startsWith(year),
  ).length;
  const target = db.fund.annualPlatformTarget;

  const weighted = active.reduce((s, d) => s + (d.checkSize || 0) * funnel.weightOf(d.funnel), 0);
  const activeCheck = active.reduce((s, d) => s + (d.checkSize || 0), 0);

  return (
    <>
      <ViewHeader
        title="Deal Pipeline"
        sub="Top-of-funnel to close, tied to the annual platform target. Click a deal for gates and terms."
      />

      <KpiRow>
        <Kpi
          label={`${year} Platforms Closed`}
          value={`${closedYtd} / ${target}`}
          sub={
            <>
              Annual target
              <div style={{ marginTop: 6 }}>
                <Progress pct={target > 0 ? (closedYtd / target) * 100 : 0} />
              </div>
            </>
          }
        />
        <Kpi
          label="Active Deals"
          value={active.length}
          sub={`${deals.filter((d) => funnel.groupOf(d.funnel) === 'Term Sheet').length} at term sheet`}
        />
        <Kpi label="Active Check $" value={fmt.m(activeCheck)} sub="If all close" />
        <Kpi label="Probability-Weighted" value={fmt.m(weighted)} sub="Stage-weighted deployment" />
        <Kpi label="Passed YTD" value={passed.length} sub="Decision discipline" />
      </KpiRow>

      <div className="kanban">
        {funnel.columns.map((group) => {
          const ds = deals.filter((d) => funnel.groupOf(d.funnel) === group.name);
          return (
            <div className="kcol" key={group.name}>
              <h5>
                {group.name} <span>{ds.length}</span>
              </h5>
              {ds.map((d) => (
                <div className="kcard" key={d.id} onClick={() => openDrawer({ kind: 'deal', id: d.id })}>
                  <div className="n">{d.name}</div>
                  <div className="m">{d.sector}</div>
                  <div className="m">
                    {d.checkSize ? `${fmt.m(d.checkSize)} check` : ''}
                    {d.valuation ? ` @ ${fmt.m(d.valuation)} post` : ''}
                  </div>
                  <div className="m" style={{ marginTop: 4 }}>
                    <Pill tone="gray">{d.owner}</Pill>
                    {/* The exact status, since the column is now a group of
                        several and would otherwise hide where a deal sits. */}
                    {d.funnel !== group.name && <Pill tone="blue">{d.funnel}</Pill>}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="small" style={{ marginTop: 10 }}>
        Passed deals ({passed.length}):{' '}
        {passed.length === 0
          ? 'none'
          : passed.map((d, i) => (
              <span key={d.id}>
                {i > 0 && ', '}
                <a className="link" onClick={() => openDrawer({ kind: 'deal', id: d.id })}>
                  {d.name}
                </a>
              </span>
            ))}
      </div>
    </>
  );
}
