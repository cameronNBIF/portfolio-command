'use client';

/**
 * Company detail drawer, ported from `openCompany` (vc-toolkit.html :878-948).
 *
 * Section order and content are the prototype's: position summary, risk flags,
 * KPI history, round history, reserves, governance, milestones, covenants,
 * government funding, mark history, open tasks (ADR-014).
 *
 * A9 ADDS THREE SECTIONS AND MOVES NONE. Health provenance and alert thresholds
 * sit either side of the risk flags, which is where a reader already looks for
 * why a company is on the watchlist; the ported order below them is untouched.
 * Their markup lives in `CompanyRiskSections` because it carries forms, and
 * this file is a port that should stay readable as one.
 */
import type { AlertPolicy, Company } from '@portfolio-command/contract';
import { fmt, moic } from '@portfolio-command/metrics';

import { CONVENTION_NOTE } from '../../lib/quarters';
import { DrawerBody, DrawerHeader, useApp } from '../AppShell';
import { DrawerSection, Kv, KvGrid, Pill, Progress, moicClass } from '../ui';
import { HealthSection, RiskFlagSection, ThresholdSection } from './CompanyRiskSections';

export function CompanyDrawer({
  company: c,
  policy,
}: {
  company: Company;
  /** The fund-wide alert policy, for showing which thresholds are inherited. */
  policy?: AlertPolicy | null;
}) {
  const { openMemoFor } = useApp();
  const mo = moic(c);
  const k = c.kpis && c.kpis[0];
  const reservesLeft = (c.reservesAllocated || 0) - (c.reservesDeployed || 0);

  return (
    <>
      <DrawerHeader>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 17, fontWeight: 700 }}>{c.name}</span>
          <Pill tone={c.health as 'green'}>{c.health.toUpperCase()}</Pill>
          {c.exited && (
            <Pill tone="gray">
              {c.exitType || 'Exited'} {c.exitDate || ''}
            </Pill>
          )}
        </div>
        <div className="small" style={{ marginTop: 3 }}>
          {c.sector} - {c.stage} - {c.hq} - CEO: {c.ceo}
        </div>
        {c.desc && (
          <div className="small" style={{ marginTop: 5, maxWidth: 640 }}>
            {c.desc}
          </div>
        )}
      </DrawerHeader>

      <DrawerBody>
        <DrawerSection>
          <KvGrid>
            <Kv label="INVESTED COST" value={fmt.m(c.invested)} />
            <Kv label="CURRENT FMV" value={fmt.m(c.fmv)} />
            <Kv label="REALIZED" value={fmt.m(c.realized)} />
            <Kv label="MOIC" value={fmt.x(mo)} valueClass={moicClass(mo)} />
            <Kv label="OWNERSHIP" value={c.exited ? '-' : fmt.pct(c.ownershipPct)} />
            <Kv label="INSTRUMENT" value={c.instrument} />
            <Kv label="PRO-RATA RIGHTS" value={c.proRata ? 'Yes' : 'No'} />
            <Kv label="VINTAGE" value={c.vintage} />
            <Kv label="SOURCED VIA" value={c.source || '-'} />
            <Kv
              label="JOBS (NB / TOTAL)"
              value={
                <>
                  {c.fte != null ? `${c.fteNB || 0} / ${c.fte}` : '-'}
                  {c.fteAtEntry ? <span className="small up"> +{c.fte - c.fteAtEntry}</span> : null}
                </>
              }
            />
            {/* D-5: "not reported" is shown as such, never as 0 of 0. */}
            <Kv
              label="WOMEN IN C-SUITE"
              value={c.cSuiteSize != null ? `${c.womenCSuite ?? 0} of ${c.cSuiteSize}` : 'Not reported'}
            />
          </KvGrid>
        </DrawerSection>

        <HealthSection company={c} />

        <RiskFlagSection company={c} />

        <ThresholdSection company={c} policy={policy} />

        {k && (
          <DrawerSection title={`KPIs (latest: ${k.period})`}>
            <table className="dt">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="num">Revenue $M</th>
                  <th className="num">Monthly Burn $M</th>
                  <th className="num">Cash $M</th>
                  <th className="num">Runway</th>
                </tr>
              </thead>
              <tbody>
                {c.kpis.map((x, i) => (
                  <tr key={i}>
                    <td>{x.period}</td>
                    <td className="num">{x.revenue.toFixed(1)}</td>
                    <td className="num">{x.burn < 0 ? <span className="up">CF+</span> : x.burn.toFixed(2)}</td>
                    <td className="num">{x.cash.toFixed(1)}</td>
                    <td className={`num ${x.runwayMo < (c.thresholds.minRunwayMo || 12) ? 'down' : ''}`}>
                      {x.runwayMo >= 99 ? '99+' : `${x.runwayMo} mo`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint" style={{ marginTop: 5 }}>
              Alert thresholds: min runway {c.thresholds.minRunwayMo || '-'} mo. Revenue is the period actual as
              reported, not annualised.
            </div>
            {/* D-6: every quarterly view states its convention. */}
            <div className="hint" style={{ marginTop: 4 }}>
              {CONVENTION_NOTE.calendar}
            </div>
          </DrawerSection>
        )}

        <DrawerSection title="Round History & Cap-Table Position">
          <table className="dt">
            <thead>
              <tr>
                <th>Date</th>
                <th>Round</th>
                <th>Instrument</th>
                <th className="num">Our $M</th>
                <th className="num">Round $M</th>
                <th className="num">Leverage</th>
                <th className="num">Post-Money</th>
                <th className="num">Own % After</th>
                <th>Lead</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {c.rounds.map((r, i) => (
                <tr key={i}>
                  <td>{r.date}</td>
                  <td>
                    <b>{r.label}</b>
                  </td>
                  <td className="small">{r.instrument}</td>
                  <td className="num">{r.invested.toFixed(1)}</td>
                  <td className="num">{r.roundTotal ? r.roundTotal.toFixed(1) : '-'}</td>
                  {/* INHERITED: the per-round figure carries no exclusion
                      predicate, so a round dropped from the fund leverage KPI
                      still shows a ratio here (INHERITED-COERCIONS.md §6). */}
                  <td className="num">
                    {r.roundTotal && r.invested > 0 ? `${((r.roundTotal - r.invested) / r.invested).toFixed(1)}:1` : '-'}
                  </td>
                  <td className="num">{r.postMoney ? fmt.m(r.postMoney) : '-'}</td>
                  <td className="num">{fmt.pct(r.ownershipAfter)}</td>
                  <td className="small">{r.lead}</td>
                  <td className="small">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DrawerSection>

        {!c.exited && (
          <DrawerSection title="Reserves & Follow-On">
            <KvGrid>
              <Kv label="ALLOCATED" value={fmt.m(c.reservesAllocated)} />
              <Kv label="DEPLOYED" value={fmt.m(c.reservesDeployed)} />
              <Kv label="REMAINING" value={fmt.m(reservesLeft)} valueClass={reservesLeft > 0 ? 'up' : undefined} />
            </KvGrid>
            <div style={{ marginTop: 8, maxWidth: 300 }}>
              <Progress pct={c.reservesAllocated > 0 ? (c.reservesDeployed / c.reservesAllocated) * 100 : 0} />
            </div>
          </DrawerSection>
        )}

        <DrawerSection title="Governance">
          <KvGrid>
            <Kv label="BOARD SEAT" value={c.board.seat} />
            <Kv label="HELD BY" value={c.board.holder} />
            <Kv label="NEXT MEETING" value={fmt.d(c.board.nextMeeting)} />
          </KvGrid>
        </DrawerSection>

        {(c.milestones || []).length > 0 && (
          <DrawerSection title="Milestones">
            {c.milestones.map((ms, i) => (
              <div className="alertrow" key={i}>
                <Pill tone={ms.status === 'on-track' ? 'green' : ms.status === 'at-risk' ? 'red' : 'gray'}>
                  {ms.status}
                </Pill>
                <span>{ms.title}</span>
                <span className="small">due {ms.due}</span>
              </div>
            ))}
          </DrawerSection>
        )}

        {(c.covenants || []).length > 0 && (
          <DrawerSection title="Covenants">
            {c.covenants.map((cv, i) => (
              <div className="alertrow" key={i}>
                <Pill tone={/breach/i.test(cv.status) ? 'red' : /watch/i.test(cv.status) ? 'yellow' : 'green'}>
                  {cv.status}
                </Pill>
                <span>{cv.text}</span>
              </div>
            ))}
          </DrawerSection>
        )}

        {c.govFunding && (
          <DrawerSection title="Government Funding">
            <KvGrid>
              <Kv label="PROGRAM" value={c.govFunding.program} />
              <Kv label="AMOUNT" value={fmt.m(c.govFunding.amount)} />
              <Kv label="STATUS" value={c.govFunding.status} />
            </KvGrid>
            <div className="small" style={{ marginTop: 6 }}>
              <b>Conditions:</b> {c.govFunding.conditions}
            </div>
          </DrawerSection>
        )}

        <DrawerSection title="Mark History (valuation audit trail)">
          <table className="dt">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">FMV $M</th>
                <th>Method</th>
                <th>Marked By</th>
                <th>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {c.marks.map((mk, i) => (
                <tr key={i}>
                  <td>{mk.date}</td>
                  <td className="num">
                    <b>{mk.fmv.toFixed(1)}</b>
                  </td>
                  <td className="small">{mk.method}</td>
                  <td className="small">{mk.by}</td>
                  <td className="small">{mk.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* ADR-007: the carry-forward rule is stated wherever FMV appears. */}
          <div className="hint" style={{ marginTop: 5 }}>
            Marks are set twice yearly, effective 31 January and 31 July, and carried forward between cycles. Two of
            every four quarters therefore show no revaluation.
          </div>
        </DrawerSection>

        {(c.tasks || []).length > 0 && (
          <DrawerSection title="Open Tasks">
            {c.tasks.map((t, i) => (
              <div className="alertrow" key={i}>
                <Pill tone={t.done ? 'green' : 'blue'}>{t.done ? 'done' : 'open'}</Pill>
                <span>{t.title}</span>
                <span className="small">due {t.due}</span>
              </div>
            ))}
          </DrawerSection>
        )}

        <div className="hint">
          <button className="btn ghost sm" onClick={() => openMemoFor(c.id)}>
            Open in Memo Builder
          </button>
        </div>
      </DrawerBody>
    </>
  );
}
