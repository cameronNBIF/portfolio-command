'use client';

/**
 * Policies: the rules the platform applies, in one place (F3, FR-21, ADR-035
 * clause 5).
 *
 * TWO SECTIONS, TWO ROLES, AND THAT IS WHY THE TAB EXISTS. *Portfolio alert
 * policies* belongs to the investment team (`CAN_EDIT_JUDGEMENT`); *Finance
 * policies* decides financial-statement treatment and belongs to Finance
 * (`CAN_SET_FINANCE_POLICY`). Putting a finance setting on the Alerts tab would
 * have put it behind the wrong gate, and putting it on the Finance entry tab
 * would have mixed a rule in with the rows it governs.
 *
 * THE SCHEDULE THE THRESHOLD DRIVES IS NOT HERE. The significant-influence
 * report and the ownership entry behind it live on the Finance tab, beside the
 * other entry surfaces: what is set here is a RULE, and that is the WORK the
 * rule produces. The two are read from separate endpoints and neither needs the
 * other on screen -- switching tabs remounts the schedule, so a threshold
 * changed here is read fresh the next time it is opened.
 *
 * THE ALERT POLICY CARD IS A MOVE, NOT A COPY. It is the A9 card, unchanged in
 * behaviour and still posting to `/api/v1/judgement`. Moving it improves the tab
 * it leaves: Alerts was deliberately built as the WORKING view — the feed, the
 * flags, the acknowledgements — and configuration sitting inside it was always
 * slightly the wrong shape.
 *
 * A TENTH TAB, ROLE-GATED, ON THE SAME ARGUMENT AS THE OTHER THREE ADDITIONS
 * (AppShell's note on `TABS`): the prototype has no configuration anywhere, so
 * this cannot be a port of anything and keeping it off the ported eight is what
 * protects the ADR-014 parity criterion.
 */
import { useState } from 'react';

import type { PortfolioExport } from '@portfolio-command/contract';

import { setAlertPolicy } from '../../lib/alerts-api';
import {
  addRetentionOption,
  fetchFinancePolicies,
  setRetentionOptionActive,
  setSignificantInfluenceThreshold,
} from '../../lib/policies-api';
import { apiMessage } from '../../lib/http';
import type { FinancePolicies } from '@portfolio-command/api';
import { useApp } from '../AppShell';
import { Field, FormGrid, Notice, useRowState } from '../entry';
import { Card, ConventionNote, Pill, ViewHeader } from '../ui';

/** Labels for the five alert metrics, in the order they are shown (A9). */
const METRICS = [
  { key: 'minRunwayMo', label: 'Minimum runway', unit: 'months', hint: 'The general floor. 12 is NBIF policy.' },
  { key: 'maxBurnMult', label: 'Maximum burn multiple', unit: 'x', hint: 'Quarterly net burn ÷ quarterly net new revenue.' },
  { key: 'minCashBalance', label: 'Minimum cash', unit: '$M', hint: 'An absolute floor, independent of self-reported runway.' },
  { key: 'maxRevenueDeclinePct', label: 'Maximum revenue decline', unit: '% QoQ', hint: 'Quarter over quarter, on the period actual.' },
  { key: 'minNrrPct', label: 'Minimum NRR', unit: '%', hint: 'Net revenue retention, where the company reports it.' },
] as const;

type MetricKey = (typeof METRICS)[number]['key'];

const CAN_EDIT_ALERTS = ['vc', 'admin'];
const CAN_SET_FINANCE = ['finance', 'admin'];

export function PoliciesTab({ db }: { db: PortfolioExport }) {
  const { role, toast } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const seesAlerts = CAN_EDIT_ALERTS.includes(role);
  const seesFinance = CAN_SET_FINANCE.includes(role);

  const run = async (what: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await what();
      toast(done);
      // The alert policy arrives in the server-rendered export, so a reload is
      // what brings the changed row back. Board numbers are never served from a
      // cache and an optimistic local copy would be a second, divergent one.
      window.location.reload();
    } catch (err) {
      setError(apiMessage(err, 'Something went wrong.'));
      setBusy(false);
    }
  };

  return (
    <>
      <ViewHeader
        title="Policies"
        sub="The rules the platform applies — who may change each is who owns the decision it drives"
      />

      <Notice text={error} onDismiss={() => setError(null)} />

      {seesAlerts && (
        <>
          <h3 className="vsub" style={{ marginTop: 4 }}>Portfolio alert policies</h3>
          <AlertPolicyCard db={db} busy={busy} run={run} />
        </>
      )}

      {seesFinance && (
        <>
          <h3 className="vsub" style={{ marginTop: 18 }}>Finance policies</h3>
          <FinancePoliciesCard />
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The fund-wide alert policy (A9), moved here from the Alerts tab unchanged.
 *
 * THE ANSWER TO "WHERE DO WE SAY THE RUNWAY THRESHOLD IS TWELVE MONTHS". Before
 * A9 there was nowhere: thresholds existed per company and a company nobody had
 * configured was silently unwatched.
 *
 * An empty box means the fund sets no policy for that metric, and NOT zero. The
 * two are different everywhere in this phase and the placeholder says so.
 */
function AlertPolicyCard({
  db,
  busy,
  run,
}: {
  db: PortfolioExport;
  busy: boolean;
  run: (what: () => Promise<void>, done: string) => Promise<void>;
}) {
  const policy = db.alertPolicy;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<MetricKey, string>>(() => ({
    minRunwayMo: policy?.minRunwayMo?.toString() ?? '',
    maxBurnMult: policy?.maxBurnMult?.toString() ?? '',
    minCashBalance: policy?.minCashBalance?.toString() ?? '',
    maxRevenueDeclinePct: policy?.maxRevenueDeclinePct?.toString() ?? '',
    minNrrPct: policy?.minNrrPct?.toString() ?? '',
  }));
  const [note, setNote] = useState('');

  // An empty box is null — "no policy" — never 0. Collapsing the two here would
  // silently disable an alert the author meant to leave unset.
  const parse = (v: string): number | null => (v.trim() === '' ? null : Number(v));
  const invalid = METRICS.some(({ key }) => {
    const v = parse(draft[key]);
    return v !== null && (!Number.isFinite(v) || v < 0);
  });

  return (
    <Card
      title="Portfolio alert policy"
      headerExtra={
        policy ? (
          <Pill tone="gray">
            in force since {policy.effectiveFrom} - {policy.setBy}
          </Pill>
        ) : (
          <Pill tone="yellow">not set</Pill>
        )
      }
    >
      <ConventionNote>
        Applies to every company that has not set its own threshold. Changing it supersedes the current
        policy rather than overwriting it, so a board pack issued under the old one still reproduces.
        The alerts themselves are on the <b>Alerts</b> tab; this is only where the thresholds are set.
      </ConventionNote>

      {!editing && (
        <>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', margin: '6px 0 10px' }}>
            {METRICS.map(({ key, label, unit }) => {
              const v = policy?.[key] ?? null;
              return (
                <div key={key}>
                  <div className="small" style={{ fontWeight: 600 }}>{label}</div>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>
                    {v == null ? <span className="flat">not set</span> : `${v} ${unit}`}
                  </div>
                </div>
              );
            })}
          </div>
          {policy?.note && <div className="hint">{policy.note}</div>}
          <button className="btn small" onClick={() => setEditing(true)}>
            {policy ? 'Change policy' : 'Set policy'}
          </button>
        </>
      )}

      {editing && (
        <>
          <FormGrid>
            {METRICS.map(({ key, label, unit, hint }) => (
              <Field key={key} label={`${label} (${unit})`} hint={hint}>
                <input
                  inputMode="decimal"
                  value={draft[key]}
                  placeholder="no policy"
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                />
              </Field>
            ))}
            <Field label="Note" hint="Why this policy, or which board minute set it.">
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </FormGrid>
          <div className="hint" style={{ margin: '8px 0' }}>
            An empty box means no fund-wide policy for that metric — it is not the same as 0, which on a
            company record means the alert is switched off.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn primary small"
              disabled={busy || invalid}
              onClick={() =>
                run(
                  () =>
                    setAlertPolicy({
                      minRunwayMo: parse(draft.minRunwayMo),
                      maxBurnMult: parse(draft.maxBurnMult),
                      minCashBalance: parse(draft.minCashBalance),
                      maxRevenueDeclinePct: parse(draft.maxRevenueDeclinePct),
                      minNrrPct: parse(draft.minNrrPct),
                      note: note.trim() || null,
                    }),
                  'Alert policy updated.',
                )
              }
            >
              Save policy
            </button>
            <button className="btn small" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {invalid && <div className="hint down" style={{ marginTop: 6 }}>Thresholds must be non-negative numbers.</div>}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The finance policies: the significant-influence threshold, and the retention
 * options the FMV review offers.
 *
 * THE THRESHOLD IS DATED AND THE OPTION LIST IS NOT, which looks inconsistent
 * on one card and is not. A classification has to be reproducible as at a past
 * date, so the threshold supersedes and its history is shown. A mark stores the
 * factor it used, so a review written under an option later retired still
 * reconstructs from its own row — the list only decides what may be chosen next.
 */
function FinancePoliciesCard() {
  const { toast } = useApp();
  const { data, error, reload, notice, setNotice } = useRowState<FinancePolicies>(fetchFinancePolicies);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [addFactor, setAddFactor] = useState('');
  const [addLabel, setAddLabel] = useState('');

  const current = data?.current ?? null;
  const threshold = current?.significantInfluencePct ?? null;

  const run = async (what: () => Promise<{ applied: string }>) => {
    setBusy(true);
    setNotice(null);
    try {
      const { applied } = await what();
      toast(applied);
      setEditing(false);
      reload();
    } catch (err) {
      setNotice(apiMessage(err, 'Something went wrong.'));
    } finally {
      setBusy(false);
    }
  };

  const parsed = draft.trim() === '' ? null : Number(draft);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 100);

  return (
    <>
      <Notice text={notice} onDismiss={() => setNotice(null)} />

      <Card
        title="Significant-influence threshold"
        headerExtra={
          current ? (
            <Pill tone="gray">in force since {current.effectiveFrom} - {current.setBy}</Pill>
          ) : (
            <Pill tone="yellow">not set</Pill>
          )
        }
      >
        <ConventionNote>
          The ownership percentage at or <b>above</b> which we hold significant influence — inclusive, so a
          company at exactly the threshold is flagged. Changing it supersedes the current policy rather
          than overwriting it, so a classification reported under the old one still reproduces. Until a
          threshold is set the flag reads <b>not determined</b> for every company, which is deliberate:
          nobody has decided yet, and that is not the same as everybody being below it.
        </ConventionNote>

        {error && <div className="small" style={{ color: 'var(--red)' }}>{error}</div>}

        {!editing && (
          <>
            <div style={{ fontSize: 22, fontWeight: 700, margin: '6px 0' }}>
              {threshold === null ? <span className="flat">not set</span> : `${Number(threshold)}%`}
            </div>
            {current?.note && <div className="hint">{current.note}</div>}
            <button className="btn small" style={{ marginTop: 8 }} onClick={() => {
              setDraft(threshold === null ? '' : String(Number(threshold)));
              setNote('');
              setEditing(true);
            }}>
              {current ? 'Change threshold' : 'Set threshold'}
            </button>
          </>
        )}

        {editing && (
          <>
            <FormGrid>
              <Field label="Threshold (%)" hint="10 means 10%. Leave empty for no threshold in force.">
                <input
                  inputMode="decimal"
                  value={draft}
                  placeholder="no threshold"
                  onChange={(e) => setDraft(e.target.value)}
                />
              </Field>
              <Field label="Note" hint="The standard the threshold comes from, or the minute that set it.">
                <input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </FormGrid>
            <div className="hint" style={{ margin: '8px 0' }}>
              An empty box is <b>not</b> 0. Empty means no threshold is in force and every company reads
              “not determined”; 0 would flag every company we hold a figure for.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn primary small"
                disabled={busy || invalid}
                onClick={() => run(() => setSignificantInfluenceThreshold(parsed, note.trim() || null))}
              >
                Save threshold
              </button>
              <button className="btn small" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
            {invalid && <div className="hint down" style={{ marginTop: 6 }}>A threshold is a percentage between 0 and 100.</div>}
          </>
        )}

        {data && data.history.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <div className="small" style={{ fontWeight: 600 }}>Earlier policies</div>
            {data.history
              .filter((p) => p.effectiveTo !== null)
              .map((p) => (
                <div key={p.id} className="hint">
                  {p.significantInfluencePct === null ? 'none' : `${Number(p.significantInfluencePct)}%`} —{' '}
                  {p.effectiveFrom} to {p.effectiveTo}, {p.setBy}
                  {p.note ? ` · ${p.note}` : ''}
                </div>
              ))}
          </div>
        )}
      </Card>

      <Card title="FMV retention options" headerExtra={<Pill tone="gray">FR-18</Pill>}>
        <ConventionNote>
          What the semi-annual review offers. The number is <b>retained</b> value, not the size of the
          write-down: 0.75 carries the position at 75% of its previous FMV. Options are <b>retired</b>,
          never deleted — a factor already used is referenced by marks that must keep reconstructing
          exactly as they were issued.
        </ConventionNote>

        {(data?.retentionOptions ?? []).map((o) => (
          <div key={o.factor} className="alertrow" style={{ opacity: o.isActive ? 1 : 0.55 }}>
            <span className="mono">{Number(o.factor).toFixed(2)}</span>
            <span className="small" style={{ flex: 1 }}>{o.label}</span>
            {o.marksUsing > 0 && (
              <Pill tone="gray">{o.marksUsing === 1 ? '1 mark' : `${o.marksUsing} marks`}</Pill>
            )}
            {!o.isActive && <Pill tone="yellow">retired</Pill>}
            <button
              className="btn small"
              disabled={busy}
              onClick={() => run(() => setRetentionOptionActive(o.factor, !o.isActive))}
            >
              {o.isActive ? 'Retire' : 'Offer again'}
            </button>
          </div>
        ))}

        <FormGrid>
          <Field label="New factor" hint="The retained share as a decimal — 0.60 keeps 60%.">
            <input inputMode="decimal" value={addFactor} placeholder="0.60" onChange={(e) => setAddFactor(e.target.value)} />
          </Field>
          <Field label="Label" hint="The sentence the review screen shows. Say both halves of it.">
            <input
              value={addLabel}
              placeholder="Retain 60% of existing FMV — a 40% decrease"
              onChange={(e) => setAddLabel(e.target.value)}
            />
          </Field>
        </FormGrid>
        <button
          className="btn small"
          style={{ marginTop: 8 }}
          disabled={busy || !addFactor.trim() || !addLabel.trim()}
          onClick={() =>
            run(async () => {
              const applied = await addRetentionOption(addFactor.trim(), addLabel.trim());
              setAddFactor('');
              setAddLabel('');
              return applied;
            })
          }
        >
          Add option
        </button>
      </Card>
    </>
  );
}
