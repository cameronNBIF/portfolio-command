'use client';

/**
 * The A9 drawer sections: health provenance, the risk-flag register, and this
 * company's alert thresholds (ADR-032).
 *
 * Split out of `CompanyDrawer` rather than inlined, because that file is a
 * PORT — its section order and content are the prototype's and ADR-014 freezes
 * them — and these three are new surface with forms in them. Keeping the new
 * work in its own file is what stops the ported drawer slowly becoming an
 * unported one.
 *
 * The prototype rendered risk flags as a row of coloured pills and offered no
 * way to add, change or remove one; every flag in it is a literal in a
 * JavaScript object. That display is preserved for anyone without edit rights.
 */
import { useState } from 'react';

import type { AlertPolicy, Company } from '@portfolio-command/contract';

import {
  clearRiskFlag,
  raiseRiskFlag,
  RISK_FLAG_CATEGORIES,
  setCompanyThresholds,
  type ThresholdInput,
} from '../../lib/alerts-api';
import { apiMessage } from '../../lib/http';
import { Field, FormGrid, Notice } from '../entry';
import { useApp } from '../AppShell';
import { DrawerSection, Kv, KvGrid, Pill } from '../ui';

/** Who may raise a flag or set a threshold. Mirrors CAN_EDIT_JUDGEMENT. */
const CAN_EDIT = ['vc', 'admin'];

function useMutation() {
  const { toast } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (what: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await what();
      toast(done);
      // Server-assembled document (page.tsx is force-dynamic), so a reload is
      // what recomputes the feed. An optimistic local edit would be a second
      // copy of the alert rules living in the browser.
      window.location.reload();
    } catch (err) {
      setError(apiMessage(err, 'Something went wrong.'));
      setBusy(false);
    }
  };

  return { error, setError, busy, run };
}

/* ================================================================== *
 * Health
 * ================================================================== */

/**
 * The rating, its Affinity grade, and who set it when.
 *
 * READ-ONLY, AND THAT IS THE DESIGN RATHER THAN AN OMISSION. Affinity is the
 * system of record for the Risk Assessment behind this (ADR-009), the sync runs
 * one way, and the VC team maintains the rating there. A second edit box here
 * would produce a rating that disagrees with itself across two systems, and the
 * next sync would silently win. The note on screen says so, because a
 * greyed-out field with no explanation reads as a missing feature.
 */
export function HealthSection({ company: c }: { company: Company }) {
  return (
    <DrawerSection title="Health">
      <KvGrid>
        <Kv
          label="RATING"
          value={
            <>
              <Pill tone={c.health as 'green'}>{(c.health || '-').toUpperCase()}</Pill>
              {c.riskGrade && <span className="small"> Grade {c.riskGrade}</span>}
            </>
          }
        />
        <Kv label="SET BY" value={c.healthSetBy || 'Not recorded'} />
        <Kv label="SET ON" value={c.healthSetAt || '-'} />
      </KvGrid>
      <div className="hint" style={{ marginTop: 6 }}>
        Maintained by the VC team in Affinity, on the Risk Assessment field, and synced here nightly.
        A / B / C map to green / yellow / red; ACC marks an accelerator investment and carries no grade.
        It is not editable in this platform.
      </div>
    </DrawerSection>
  );
}

/* ================================================================== *
 * Risk flags
 * ================================================================== */

export function RiskFlagSection({ company: c }: { company: Company }) {
  const { role } = useApp();
  const { error, setError, busy, run } = useMutation();
  const [adding, setAdding] = useState(false);
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [severity, setSeverity] = useState<'' | 'red' | 'yellow'>('');
  const [clearing, setClearing] = useState<number | null>(null);
  const [reason, setReason] = useState('');

  const canEdit = CAN_EDIT.includes(role);
  const flags = c.riskFlags || [];
  const detail = c.riskFlagDetail;
  const picked = RISK_FLAG_CATEGORIES.find((x) => x.code === category);

  if (flags.length === 0 && !canEdit) return null;

  return (
    <DrawerSection title="Risk Flags">
      <Notice text={error} onDismiss={() => setError(null)} />

      {flags.length === 0 && <div className="small">No open flags.</div>}

      <div className="badgebar" style={{ flexWrap: 'wrap' }}>
        {flags.map((f, i) => {
          const d = detail?.[i];
          // The prototype coloured every flag by the COMPANY's health. A flag
          // raised with its own severity overrides that; one without keeps the
          // inherited rule exactly (ADR-013).
          const tone = (d?.severity ?? (c.health === 'red' ? 'red' : 'yellow')) as 'red' | 'yellow';
          return (
            <span key={d?.id ?? i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Pill tone={tone}>{f}</Pill>
              {d && canEdit && (
                <button
                  className="btn small"
                  disabled={busy}
                  title="Clear this flag"
                  onClick={() => {
                    setClearing(clearing === d.id ? null : d.id);
                    setReason('');
                  }}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>

      {/* Provenance, one line per flag. A flag with no author is a flag nobody
          can ask about six months later. */}
      {detail && detail.length > 0 && (
        <div className="hint" style={{ marginTop: 6 }}>
          {detail.map((d) => (
            <div key={d.id}>
              {d.categoryLabel} — raised {d.raisedAt} by {d.raisedBy}
              {RISK_FLAG_CATEGORIES.find((x) => x.code === d.category)?.suppresses &&
                ` — stands in for ${RISK_FLAG_CATEGORIES.find((x) => x.code === d.category)!.suppresses}`}
            </div>
          ))}
        </div>
      )}

      {clearing !== null && (
        <div style={{ marginTop: 8 }}>
          <Field label="Why is this flag being cleared?" hint="Required, and recorded against your name.">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Waiver signed 12 Aug" />
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="btn primary small"
              disabled={busy || !reason.trim()}
              onClick={() => run(() => clearRiskFlag(clearing, reason.trim()), 'Flag cleared.')}
            >
              Clear flag
            </button>
            <button className="btn small" disabled={busy} onClick={() => setClearing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {canEdit && !adding && clearing === null && (
        <button className="btn small" style={{ marginTop: 8 }} onClick={() => setAdding(true)}>
          Raise a flag
        </button>
      )}

      {canEdit && adding && (
        <div style={{ marginTop: 8 }}>
          <FormGrid>
            <Field label="Category" hint="Decides severity and which alert this stands in for.">
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setSeverity('');
                }}
              >
                <option value="">Choose…</option>
                {RISK_FLAG_CATEGORIES.map((x) => (
                  <option key={x.code} value={x.code}>
                    {x.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Note" hint="Optional. Shown after the category on every screen.">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="CFO resigned, search underway" />
            </Field>
            <Field label="Severity" hint="Leave as inherited to follow the company's health colour.">
              <select value={severity} onChange={(e) => setSeverity(e.target.value as '' | 'red' | 'yellow')}>
                <option value="">Inherited ({c.health === 'red' ? 'red' : 'yellow'})</option>
                <option value="red">Red</option>
                <option value="yellow">Yellow</option>
              </select>
            </Field>
          </FormGrid>

          {/* The thing the old regex hid. Someone choosing "Runway" should know
              before they save that it will REPLACE the runway alert rather than
              sit beside it. */}
          {picked?.suppresses && (
            <div className="hint" style={{ marginTop: 6 }}>
              A flag in this category stands in for {picked.suppresses} — while that alert is firing, this
              flag replaces it on the feed rather than appearing beside it.
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="btn primary small"
              disabled={busy || !category}
              onClick={() =>
                run(
                  () =>
                    raiseRiskFlag({
                      companyId: c.id,
                      category,
                      note: note.trim() || null,
                      severity: severity || null,
                    }),
                  'Flag raised.',
                )
              }
            >
              Raise flag
            </button>
            <button className="btn small" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </DrawerSection>
  );
}

/* ================================================================== *
 * Thresholds
 * ================================================================== */

const FIELDS = [
  { key: 'minRunwayMo', label: 'Minimum runway', unit: 'mo' },
  { key: 'maxBurnMult', label: 'Maximum burn multiple', unit: 'x' },
  { key: 'minCashBalance', label: 'Minimum cash', unit: '$M' },
  { key: 'maxRevenueDeclinePct', label: 'Max revenue decline', unit: '% QoQ' },
  { key: 'minNrrPct', label: 'Minimum NRR', unit: '%' },
] as const;

type FieldKey = (typeof FIELDS)[number]['key'];

/** The three states, resolved for display exactly as `packages/metrics` resolves them. */
function resolveDisplay(
  own: number | undefined,
  policy: number | null | undefined,
): { text: string; from: 'company' | 'policy' | 'off' | 'none' } {
  if (own != null) return own > 0 ? { text: String(own), from: 'company' } : { text: 'off', from: 'off' };
  if (policy != null && policy > 0) return { text: String(policy), from: 'policy' };
  return { text: '-', from: 'none' };
}

export function ThresholdSection({
  company: c,
  policy,
}: {
  company: Company;
  policy: AlertPolicy | null | undefined;
}) {
  const { role } = useApp();
  const { error, setError, busy, run } = useMutation();
  const [editing, setEditing] = useState(false);
  const t = c.thresholds ?? {};
  const [draft, setDraft] = useState<Record<FieldKey, string>>(() => ({
    minRunwayMo: t.minRunwayMo?.toString() ?? '',
    maxBurnMult: t.maxBurnMult?.toString() ?? '',
    minCashBalance: t.minCashBalance?.toString() ?? '',
    maxRevenueDeclinePct: t.maxRevenueDeclinePct?.toString() ?? '',
    minNrrPct: t.minNrrPct?.toString() ?? '',
  }));

  const canEdit = CAN_EDIT.includes(role);

  // An empty box means "inherit the fund policy" and sends null. `0` is a real
  // value meaning "switch this alert off" and must reach the API as 0, which is
  // why this is an explicit empty-string test and not a truthiness one.
  const parse = (v: string): number | null => (v.trim() === '' ? null : Number(v));
  const invalid = FIELDS.some(({ key }) => {
    const v = parse(draft[key]);
    return v !== null && (!Number.isFinite(v) || v < 0);
  });

  return (
    <DrawerSection title="Alert Thresholds">
      <Notice text={error} onDismiss={() => setError(null)} />

      {!editing && (
        <>
          <KvGrid>
            {FIELDS.map(({ key, label, unit }) => {
              const r = resolveDisplay(t[key], policy?.[key]);
              return (
                <Kv
                  key={key}
                  label={label.toUpperCase()}
                  value={
                    <>
                      {r.text === 'off' ? <span className="flat">Alert off</span> : r.text}
                      {r.text !== 'off' && r.text !== '-' && <span className="small"> {unit}</span>}{' '}
                      {r.from === 'policy' && <Pill tone="blue">policy</Pill>}
                      {r.from === 'company' && <Pill tone="gray">company</Pill>}
                    </>
                  }
                />
              );
            })}
          </KvGrid>
          <div className="hint" style={{ marginTop: 6 }}>
            <em>policy</em> means this company inherits the portfolio-wide setting. Setting a value here
            overrides it; setting 0 switches the alert off for this company and the policy does not
            override that.
          </div>
          {canEdit && (
            <button className="btn small" style={{ marginTop: 8 }} onClick={() => setEditing(true)}>
              Set thresholds
            </button>
          )}
        </>
      )}

      {editing && (
        <>
          <FormGrid>
            {FIELDS.map(({ key, label, unit }) => (
              <Field key={key} label={`${label} (${unit})`}>
                <input
                  inputMode="decimal"
                  value={draft[key]}
                  placeholder={
                    policy?.[key] != null ? `inherits ${policy[key]}` : 'no threshold'
                  }
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                />
              </Field>
            ))}
          </FormGrid>
          <div className="hint" style={{ margin: '8px 0' }}>
            Leave a box empty to inherit the portfolio policy. Enter 0 to switch that alert off for this
            company — the two are different, and 0 is the only way to opt out of a policy.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn primary small"
              disabled={busy || invalid}
              onClick={() => {
                const payload: ThresholdInput = {
                  minRunwayMo: parse(draft.minRunwayMo),
                  maxBurnMult: parse(draft.maxBurnMult),
                  minCashBalance: parse(draft.minCashBalance),
                  maxRevenueDeclinePct: parse(draft.maxRevenueDeclinePct),
                  minNrrPct: parse(draft.minNrrPct),
                };
                return run(() => setCompanyThresholds(c.id, payload), 'Thresholds updated.');
              }}
            >
              Save
            </button>
            <button className="btn small" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {invalid && <div className="hint down" style={{ marginTop: 6 }}>Thresholds must be non-negative numbers.</div>}
        </>
      )}
    </DrawerSection>
  );
}
