'use client';

/**
 * Reconciliation: everywhere two records of one fact disagree, or one is
 * unfinished (F6, FR-08, FR-09, FR-14, S-10).
 *
 * THE FAILURE MODE THIS SCREEN IS DESIGNED AGAINST IS ITS OWN. The roadmap says
 * it in as many words: a reconciliation list that cannot be acted on from
 * itself becomes wallpaper. So every row carries the two figures that disagree
 * and a button that goes to the screen that fixes it — the same argument A9
 * made for time-boxed acknowledgements, applied here.
 *
 * ALL EIGHT CHECKS ARE ALWAYS SHOWN, INCLUDING THE ZEROES. A surface that lists
 * only what is wrong cannot tell "this check found nothing" from "this check
 * stopped running", and the second is what happens when a predicate quietly
 * stops matching. A zero is evidence; an absence is not.
 *
 * NOT ALERTS. A9's tab is about the portfolio — runway, covenants, a company in
 * trouble. This is about the platform's own records. Triaging "four months of
 * cash left" next to "this cheque has no round" would let the second win by
 * volume, and neither would get read.
 *
 * NO "RESOLVE" BUTTON, deliberately. Nothing is fixed here; the row goes away
 * when the underlying fact is corrected on the screen that owns it. A
 * mark-as-resolved that does not change the data is how a reconciliation list
 * starts lying, and it is the one affordance that would make this screen worse
 * the more it was used.
 */
import { useCallback, useState } from 'react';

import type { CheckDefinition, ReconciliationReport, ReconciliationRow } from '@portfolio-command/api';

import { useApp } from '../AppShell';
import { Notice, useRowState } from '../entry';
import { money, TXN_TYPE_LABELS } from '../../lib/finance-api';
import { fetchReconciliation } from '../../lib/reconciliation-api';
import { Card, Kpi, KpiRow, Pill, ViewHeader } from '../ui';

/** Where each check's fix lives, as a tab the nav can switch to. */
const SURFACE_TAB: Record<CheckDefinition['fixSurface'], string | null> = {
  'finance-transactions': 'finance',
  'finance-marks': 'finance',
  'finance-lp': 'finance',
  'deal-close': 'dealclose',
  exited: 'exited',
  // Not a tab: the roster is Affinity's and the sync is one-way inbound
  // (ADR-009). Saying so is more useful than a button that goes nowhere.
  affinity: null,
};

export function ReconciliationTab() {
  const { setTab, openCompany, role } = useApp();
  const [check, setCheck] = useState<string>('all');

  const load = useCallback(() => fetchReconciliation(check), [check]);
  const { data, error, notice, setNotice } = useRowState<ReconciliationReport>(load);

  const checks = data?.checks ?? [];
  const rows = data?.rows ?? [];
  const clean = checks.filter((c) => c.openItems === 0).length;

  return (
    <>
      <ViewHeader
        title="Reconciliation"
        sub="Where two records of the same fact disagree, or one is unfinished. Nothing is fixed here — each row links to the screen that owns it, and it leaves this list when the underlying figure is corrected."
      />

      <Notice text={notice} onDismiss={() => setNotice(null)} />

      <KpiRow>
        <Kpi
          label="Open Items"
          value={String(data?.totalOpen ?? 0)}
          sub={`Across ${checks.length - clean} of ${checks.length} checks`}
        />
        <Kpi label="Checks Clean" value={`${clean} / ${checks.length}`} sub="Zero is a result, not a gap" />
      </KpiRow>

      {/* The catalogue. Every check, its count, and what it means — because a
          row reading "NB capital disagrees" is only actionable to somebody who
          already knows which two captures those are. */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', marginBottom: 14 }}>
        {checks.map((c) => (
          <Card key={c.kind}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{c.title}</span>
              <span style={{ marginLeft: 'auto' }}>
                {c.openItems === 0 ? (
                  <Pill tone="green">Clear</Pill>
                ) : (
                  <Pill tone="yellow">{c.openItems}</Pill>
                )}
              </span>
            </div>
            <div className="small" style={{ marginTop: 6, lineHeight: 1.45 }}>{c.meaning}</div>
            <div style={{ marginTop: 8 }}>
              <button
                className="btn ghost sm"
                disabled={c.openItems === 0}
                onClick={() => setCheck(c.kind)}
              >
                {c.openItems === 0 ? 'Nothing to show' : `Show ${c.openItems}`}
              </button>
            </div>
          </Card>
        ))}
      </div>

      <div className="fbar">
        <select value={check} onChange={(e) => setCheck(e.target.value)}>
          <option value="all">All checks</option>
          {checks.map((c) => (
            <option key={c.kind} value={c.kind}>
              {c.title} ({c.openItems})
            </option>
          ))}
        </select>
        <span className="small" style={{ marginLeft: 'auto' }}>
          {rows.length} row{rows.length === 1 ? '' : 's'} shown
        </span>
      </div>

      <Card noBody>
        {error && <div className="cbody" style={{ color: 'var(--red)' }}>{error}</div>}
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Check</th>
                <th>Company</th>
                <th>Subject</th>
                <th>Date</th>
                <th className="num">Figures that disagree</th>
                <th>What it means</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const def = checks.find((c) => c.kind === r.checkKind);
                return (
                  <tr key={`${r.checkKind}:${r.subjectTable}:${r.subjectId}`}>
                    <td className="small">{def?.title ?? r.checkKind}</td>
                    <td>
                      {r.companyId ? (
                        <a className="link" onClick={() => openCompany(r.companyId!)}>
                          {r.companyName}
                        </a>
                      ) : (
                        r.companyName
                      )}
                    </td>
                    <td className="small">{subjectOf(r)}</td>
                    <td className="mono small">{r.subjectDate ?? '—'}</td>
                    <td className="num small">{figures(r)}</td>
                    <td className="small">{r.detail}</td>
                    <td>
                      {def && SURFACE_TAB[def.fixSurface] ? (
                        <button
                          className="btn ghost sm"
                          onClick={() => setTab(SURFACE_TAB[def.fixSurface] as never)}
                        >
                          {def.fixLabel}
                        </button>
                      ) : (
                        <span className="small">In Affinity</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && !error && (
                <tr>
                  <td colSpan={7} className="hint">
                    {check === 'all'
                      ? 'Nothing to reconcile. Every check is clear.'
                      : 'This check is clear.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="hint" style={{ marginTop: 8 }}>
        Read by everyone; fixed by whoever owns the record. Cheques and valuations are Finance’s,
        rounds and co-investors are the deal lead’s (ADR-012), and the roster is Affinity’s — which
        is why the exit-status rows have no button here.
        {role === 'leadership' && ' Leadership reads this list and does not edit it.'}
      </div>
    </>
  );
}

/**
 * What the row is about, in the reader's words rather than the column's.
 *
 * The view returns a raw `txn_type` for a cheque on purpose — `TXN_TYPE_LABELS`
 * is the one place those words live (F5 renamed the stored values so it can
 * be), and a SQL copy of that map would be a second thing to keep in step.
 */
function subjectOf(r: ReconciliationRow): string {
  if (r.subjectTable === 'transaction') return TXN_TYPE_LABELS[r.subjectLabel] ?? r.subjectLabel;
  return r.subjectLabel;
}

/** The two figures, or the one, or neither — whichever the check actually has. */
function figures(r: ReconciliationRow): string {
  if (r.figureA === null && r.figureB === null) return '—';
  if (r.figureB === null) return `${r.figureALabel}: ${money(r.figureA)}`;
  // Counts, not money, on the classification check: "3 cheques / 2 unclassified"
  // would read as dollars in a currency-formatted column.
  if (r.checkKind === 'unclassified-round') {
    return `${r.figureB} of ${r.figureA} cheques unclassified`;
  }
  return `${money(r.figureA)} vs ${money(r.figureB)}`;
}
