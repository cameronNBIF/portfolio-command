'use client';

/**
 * The FMV review workspace (F2, FR-19, ADR-034).
 *
 * A SURFACE RATHER THAN A FORM, and that is the requirement rather than a
 * styling preference. The A7 mark screen was a company picker and five empty
 * fields: to value a position, Finance opened it, went and looked up what the
 * position was last marked at, found what had been invested since, found which
 * rounds had happened, came back, and typed a number. FR-19 is the observation
 * that the platform already holds every one of those things.
 *
 * IT IS ITS OWN FILE because the Finance tab was already the longest component
 * in the app, and this is a distinct piece of work with its own read path --
 * not a fourth variation on the row-editor pattern the other three surfaces
 * share.
 *
 * TWO PANES, AND THE LEFT ONE IS THE POINT. The queue is the cycle as a
 * checklist that gets cleared, which only became possible once FR-18 made
 * "reviewed, held" a positive entry at 100% rather than an absence. Before that
 * a review cycle was a set of forms that were or were not opened, and there was
 * no way to tell the difference from the outside.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS PROPOSE A FIGURE. Q-2, Q-3 and Q-4 decide
 * whether new money raises FMV by the cheque or reprices the whole position,
 * whether an unpriced round can do anything at all, and whether a computed
 * figure is final without anybody clicking. Until those are answered this shows
 * CONTEXT and a person decides. The proposal panel is what the answers buy.
 */
import { useCallback, useMemo, useState } from 'react';

import type { FmvReview, ReviewQueueRow, ValuationMarkRow } from '@portfolio-command/api';
import type { PortfolioExport } from '@portfolio-command/contract';

import { Card, Kpi, KpiRow, Pill } from '../ui';
import { Field, FormGrid, Notice, ReasonField, useRowState } from '../entry';
import {
  TXN_TYPE_LABELS,
  currentValuationCycle,
  fetchMarks,
  fetchReview,
  fetchReviewQueue,
  money,
  mutate,
  retentionSentence,
} from '../../lib/finance-api';
import { apiMessage } from '../../lib/http';

export function FmvReviewSurface({ db }: { db: PortfolioExport }) {
  const [asOf, setAsOf] = useState(() => currentValuationCycle());
  const [selected, setSelected] = useState<string | null>(null);
  const [outstandingOnly, setOutstandingOnly] = useState(true);

  const loadQueue = useCallback(() => fetchReviewQueue(asOf), [asOf]);
  const { data: queue, error, reload, notice, setNotice } =
    useRowState<{ rows: ReviewQueueRow[] }>(loadQueue);

  const rows = queue?.rows ?? [];
  const reviewed = rows.filter((r) => r.reviewedThisCycle).length;
  const shown = outstandingOnly ? rows.filter((r) => !r.reviewedThisCycle) : rows;

  // The carrying value of everything the cycle covers. Summed from the same
  // figure each row shows, so the headline cannot disagree with the list.
  const portfolioFmv = rows.reduce((a, r) => a + Number(r.currentFmv), 0);

  return (
    <>
      <Notice text={notice} onDismiss={() => setNotice(null)} />

      <div className="hint" style={{ marginBottom: 10 }}>
        The semi-annual exercise, run from a screen rather than beside one. Marks are effective
        31 January and 31 July and are carried forward between cycles (ADR-007). A review records
        what the position is worth <b>relative to its previous value</b> — the platform computes the
        figure from that, so no arithmetic is done by hand and nothing already in the system is
        retyped. Entering a review <b>is</b> the sign-off.
      </div>

      <KpiRow>
        <Kpi
          label="Reviewed This Cycle"
          value={rows.length ? `${reviewed} / ${rows.length}` : '—'}
          sub={`As at ${asOf}`}
        />
        <Kpi
          label="Outstanding"
          valueClass={rows.length - reviewed > 0 ? 'down' : undefined}
          value={rows.length ? String(rows.length - reviewed) : '—'}
          sub="Held at their previous value until reviewed"
        />
        <Kpi label="Portfolio FMV" value={money(String(portfolioFmv))} sub="Carrying value at the cycle date" />
      </KpiRow>

      <div className="fbar">
        <Field label="Cycle date">
          <input type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); setSelected(null); }} />
        </Field>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 5, alignSelf: 'flex-end' }}>
          <input
            type="checkbox"
            checked={outstandingOnly}
            onChange={(e) => setOutstandingOnly(e.target.checked)}
          />
          Outstanding only
        </label>
      </div>

      {selected && (
        <ReviewWorkspace
          companyId={selected}
          asOf={asOf}
          onClose={() => setSelected(null)}
          onSaved={(m) => { setNotice(m); setSelected(null); reload(); }}
        />
      )}

      <Card title="Review cycle" noBody>
        {error && <div className="cbody" style={{ color: 'var(--red)' }}>{error}</div>}
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Company</th>
                <th className="num">Carrying value</th>
                <th className="num">Cost</th>
                <th>Last mark</th>
                <th>Since then</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.companyId}>
                  <td>{r.companyName}</td>
                  <td className="num mono">{money(r.currentFmv)}</td>
                  <td className="num mono">{money(r.cost)}</td>
                  <td className="small">
                    {r.lastMarkDate ? (
                      <>
                        <span className="mono">{r.lastMarkDate}</span>
                        <div className="hint">{r.lastMarkType}</div>
                      </>
                    ) : (
                      // ADR-007's fallback, said out loud. Cost is a carrying
                      // value, not a valuation anybody signed, and a reviewer
                      // should know which of the two they are looking at.
                      <span className="hint">Never marked — held at cost</span>
                    )}
                  </td>
                  <td className="small">
                    {r.transactionsSince + r.roundsSince === 0 ? (
                      <span className="hint">Nothing</span>
                    ) : (
                      <>
                        {r.transactionsSince > 0 && `${r.transactionsSince} cheque${r.transactionsSince > 1 ? 's' : ''}`}
                        {r.transactionsSince > 0 && r.roundsSince > 0 && ', '}
                        {r.roundsSince > 0 && `${r.roundsSince} round${r.roundsSince > 1 ? 's' : ''}`}
                      </>
                    )}
                  </td>
                  <td>
                    {r.reviewedThisCycle
                      ? <Pill tone="green">Reviewed</Pill>
                      : <Pill tone="yellow">Outstanding</Pill>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn ghost sm" onClick={() => setSelected(r.companyId)}>
                      {r.reviewedThisCycle ? 'Open' : 'Review'}
                    </button>
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="hint">
                    {rows.length === 0
                      ? 'No companies to review at this date.'
                      : 'Every company has been reviewed at this cycle date.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="hint" style={{ marginTop: 10 }}>
        {db.companies.length} companies in the portfolio. Upward adjustments happen only through
        transaction events, so a position impaired at one cycle stays impaired until a new round or
        investment reprices it — a deliberate conservative policy, stated here because it is the kind
        of rule that surprises someone two years later (D-3).
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// One company's review
// ---------------------------------------------------------------------------

function ReviewWorkspace({
  companyId, asOf, onClose, onSaved,
}: {
  companyId: string;
  asOf: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const load = useCallback(() => fetchReview(companyId, asOf), [companyId, asOf]);
  const { data, error } = useRowState<FmvReview>(load);

  const loadMarks = useCallback(
    () => fetchMarks({ companyId, includeDeleted: 'false' }),
    [companyId],
  );
  const { data: history } = useRowState<{ rows: ValuationMarkRow[] }>(loadMarks);

  const [factor, setFactor] = useState('');
  const [methodLabel, setMethodLabel] = useState('');
  const [rationale, setRationale] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * The resulting figure, shown before saving.
   *
   * A PREVIEW, NOT THE VALUE THAT GETS STORED. The server computes and stores
   * its own from the basis it resolves, and refuses one sent by the client
   * (ADR-034 clause 2) — so this is deliberately allowed to be a float in the
   * browser, where it is a label. If the two ever disagree, the notice after
   * saving reports the stored figure, which is what makes the disagreement
   * visible rather than theoretical.
   */
  const preview = useMemo(() => {
    if (!data || !factor) return null;
    return (Number(data.current.fmv) * Number(factor)).toFixed(2);
  }, [data, factor]);

  const chosen = data?.retentionOptions.find((o) => o.factor === factor);

  const submit = async () => {
    if (!data) return;
    setFormError(null);
    setSaving(true);
    try {
      const result = await mutate({
        table: 'valuation_mark',
        op: 'create',
        reason: reason || null,
        values: {
          companyId,
          effectiveDate: asOf,
          adjustmentType: 'review',
          retentionFactor: factor,
          methodLabel,
          rationale,
        },
      });
      // The STORED figure, not the preview. Reporting back what the server
      // actually wrote is what makes "computed, never typed" checkable from the
      // screen rather than taken on trust.
      onSaved(
        `${data.companyName} reviewed at ${asOf}: carried at ${money(result.mark?.fmv ?? null)}` +
          (result.restated
            ? '. Recorded as a restatement — this cycle has already been reported to the board.'
            : '.'),
      );
    } catch (e) {
      setFormError(apiMessage(e, 'Could not save the review.'));
      setSaving(false);
    }
  };

  if (error) {
    return (
      <Card title="FMV review">
        <div style={{ color: 'var(--red)' }}>{error}</div>
      </Card>
    );
  }
  if (!data) return <Card title="FMV review"><div className="hint">Loading…</div></Card>;

  const c = data.current;
  const heldAtCost = c.markId === null;

  return (
    <Card title={`FMV review — ${data.companyName}, as at ${asOf}`}>
      {formError && (
        <div className="alertrow" style={{ marginBottom: 10, color: 'var(--red)' }}>{formError}</div>
      )}

      {/* --- what it is carried at now, and on whose authority ------------- */}
      <div className="vsub" style={{ fontWeight: 700, color: 'var(--slate)', marginBottom: 6 }}>
        CARRIED AT
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ fontSize: 24, fontWeight: 700 }} className="mono">{money(c.fmv)}</div>
        <div className="small">
          {heldAtCost ? (
            <>
              <Pill tone="yellow">Held at cost</Pill>{' '}
              Never formally marked, so the carrying value is cumulative investment (ADR-007).
              A review still applies — it is measured against this figure.
            </>
          ) : (
            <>
              Marked <span className="mono">{c.effectiveDate}</span>, booked{' '}
              <span className="mono">{c.bookedAt?.slice(0, 10)}</span>, by {c.preparedByLabel}
              {c.adjustmentType === 'review' && c.retentionFactor && (
                <> · {retentionSentence(c.retentionFactor)} of {money(c.basisFmv)}</>
              )}
              <div className="hint">{c.methodLabel} — {c.rationale}</div>
            </>
          )}
        </div>
      </div>
      <div className="hint" style={{ marginTop: 4 }}>
        Cost to date {money(data.cost)}.
      </div>

      {/* --- what has happened since -------------------------------------- */}
      <div className="vsub" style={{ margin: '16px 0 6px', fontWeight: 700, color: 'var(--slate)' }}>
        SINCE THAT MARK
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        Everything booked after the mark&rsquo;s <b>effective</b> date, not after it was entered — a
        mark as at 31 January values the position as it stood in January, so a February cheque is
        activity it did not see.
      </div>

      {data.transactionsSince.length === 0 && data.roundsSince.length === 0 ? (
        <div className="hint">Nothing has been booked since the last mark.</div>
      ) : (
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Date</th>
                <th>What</th>
                <th className="num">Amount</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.transactionsSince.map((t) => (
                <tr key={`t${t.id}`}>
                  <td className="mono">{t.txnDate}</td>
                  <td>{TXN_TYPE_LABELS[t.txnType] ?? t.txnType}</td>
                  <td className="num mono">{money(t.amountCad)}</td>
                  <td className="small">
                    {/* F1's payoff on this screen: the cheque names the round it
                        funded, which is one of the lookups FR-19 is about
                        removing. */}
                    {t.roundLabel
                      ? <>{t.roundLabel} <span className="hint">({t.roundDate})</span></>
                      : <span className="hint">No round</span>}
                    {t.note && <div className="hint">{t.note}</div>}
                  </td>
                </tr>
              ))}
              {data.roundsSince.map((r) => (
                <tr key={`r${r.id}`}>
                  <td className="mono">{r.roundDate}</td>
                  <td>
                    Round — {r.label}
                    <div className="hint">{r.instrument}</div>
                  </td>
                  <td className="num mono">
                    {r.roundTotal ? money(r.roundTotal) : <span className="hint">not captured</span>}
                  </td>
                  <td className="small">
                    {r.nbifParticipated === 'no' ? (
                      <Pill tone="gray">We did not participate</Pill>
                    ) : (
                      <>Our cheque {money(r.ourInvested)}</>
                    )}
                    <div className="hint">
                      {/* The fact this screen most needs to state plainly. No
                          post-money means there is no arithmetic available to
                          anybody — a reviewer who can see the gap applies
                          judgement; one shown a confident number cannot. */}
                      {r.postMoney
                        ? `Post-money ${money(r.postMoney)}${r.ownershipAfterPct ? ` · ${Number(r.ownershipAfterPct).toFixed(2)}% after` : ''}`
                        : 'Unpriced — no post-money, so the round cannot be translated into a valuation'}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- the history, with reasoning ---------------------------------- */}
      <div className="vsub" style={{ margin: '16px 0 6px', fontWeight: 700, color: 'var(--slate)' }}>
        MARK HISTORY
      </div>
      <div className="tblwrap">
        <table className="dt">
          <thead>
            <tr>
              <th>As at</th>
              <th className="num">FMV</th>
              <th>Adjustment</th>
              <th>Prepared by</th>
              <th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            {(history?.rows ?? []).map((m) => (
              <tr key={m.id} style={m.status === 'superseded' ? { opacity: 0.55 } : undefined}>
                <td className="mono">{m.effectiveDate}</td>
                <td className="num mono">{money(m.fmv)}</td>
                <td className="small">
                  {m.adjustmentType === 'review' && m.retentionFactor ? (
                    <>
                      {retentionSentence(m.retentionFactor)}
                      <div className="hint">on {money(m.basisFmv)}</div>
                      {/* ADR-034 clause 3, surfaced. The basis is stored rather
                          than looked up precisely so this becomes visible
                          instead of silently invalidating the arithmetic. */}
                      {m.basisFmvNow && m.basisFmvNow !== m.basisFmv && (
                        <Pill tone="red">Basis since corrected to {money(m.basisFmvNow)}</Pill>
                      )}
                    </>
                  ) : (
                    <span className="hint">{m.adjustmentType}</span>
                  )}
                </td>
                <td className="small">{m.preparedByLabel}</td>
                <td className="small">{m.rationale}</td>
              </tr>
            ))}
            {(history?.rows ?? []).length === 0 && (
              <tr><td colSpan={5} className="hint">No marks yet for this company.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* --- the control -------------------------------------------------- */}
      <div className="vsub" style={{ margin: '16px 0 6px', fontWeight: 700, color: 'var(--slate)' }}>
        RECORD THE REVIEW
      </div>
      <FormGrid>
        <Field
          label="Retention"
          hint="What the position is worth relative to its current carrying value. The platform computes the figure."
        >
          <select
            value={factor}
            onChange={(e) => {
              setFactor(e.target.value);
              const opt = data.retentionOptions.find((o) => o.factor === e.target.value);
              // Pre-filled, not generated. `method_label` is the verbatim string
              // the ADR-001 contract carries (ADR-026), so the server does not
              // invent it — but nobody should have to type the same sentence
              // eighty times a cycle either.
              if (opt && !methodLabel) setMethodLabel(`Semi-annual review — ${retentionSentence(opt.factor).toLowerCase()}`);
            }}
          >
            <option value="">Select…</option>
            {data.retentionOptions.map((o) => (
              <option key={o.factor} value={o.factor}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Method" hint="The verbatim string the export and the board pack carry.">
          <input type="text" value={methodLabel} onChange={(e) => setMethodLabel(e.target.value)} />
        </Field>
        <ReasonField value={reason} onChange={setReason} />
      </FormGrid>

      {factor && (
        <div className="alertrow" style={{ marginTop: 10, gap: 8 }}>
          <span>
            <b>{chosen?.label}</b> — carried at{' '}
            <b className="mono">{money(preview)}</b>, from {money(c.fmv)}.
            {factor === '1.0000' && ' Nothing moves; the entry records that it was looked at.'}
          </span>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Field
          label="Rationale"
          hint="Required. This is what a board member or auditor reads when they challenge the number."
        >
          <textarea rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </Field>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn" disabled={!factor || !rationale || !methodLabel || saving} onClick={submit}>
          {saving ? 'Saving…' : 'Record review'}
        </button>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </Card>
  );
}
