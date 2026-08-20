'use client';

/**
 * The significant-influence schedule, and the ownership entry behind it
 * (F3, FR-21, FR-36, ADR-035).
 *
 * THREE GROUPS, NOT A FILTERED LIST, AND THAT IS THE REQUIREMENT. The flag is
 * three-valued: held, not held, and **not determined** — no ownership figure,
 * or no threshold in force. A screen that showed only the flagged companies
 * would be answering a different question from the one an auditor asks, and a
 * screen that folded "not determined" in with "below" would answer it wrongly.
 * The unclassifiable group is first, because it is the only one that is
 * actionable, and the action is on the same screen.
 *
 * THE AGE OF EVERY FIGURE IS ON ITS ROW. FR-21 depends on FR-36 because a flag
 * derived from a three-year-old cap table looks exactly as authoritative as one
 * derived from last week's. The age is stated as a fact; nothing here decides
 * what counts as too old, because nobody has set that.
 *
 * WHAT IS DELIBERATELY NOT HERE: the manual override for board-seat cases. Pat
 * acknowledged the grey areas — 10.2% and no board seat, or 8% with two — and
 * answering that is Q-7. Until it lands the note at the top says the flag is
 * derived from ownership alone, so nobody reads the schedule as more than it is.
 * The override is additive to a flag that already works.
 */
import { useCallback, useState } from 'react';

import type { OwnershipRow, SignificantInfluenceReport, SignificantInfluenceRow } from '@portfolio-command/api';

import {
  PoliciesApiError,
  ageInMonths,
  deleteOwnership,
  fetchOwnershipHistory,
  fetchSignificantInfluence,
  pct,
  recordOwnership,
  todayISO,
} from '../../lib/policies-api';
import { money } from '../../lib/finance-api';
import { useApp } from '../AppShell';
import { Field, FormGrid, Notice, ReasonField, RowFlags, useRowState } from '../entry';
import { Card, ConventionNote, Kpi, KpiRow, Pill } from '../ui';

const CAN_RECORD = ['vc', 'finance', 'admin'];

export function SignificantInfluenceSurface({ policyVersion = 0 }: { policyVersion?: number }) {
  const { role, openCompany } = useApp();
  const [date, setDate] = useState(todayISO);
  const [editing, setEditing] = useState<SignificantInfluenceRow | null>(null);

  /* `policyVersion` is a dependency rather than decoration: the threshold is set
     on a card above this one, and a schedule that kept showing the old
     classification until someone reloaded would be the screen contradicting the
     policy it sits under. */
  const load = useCallback(() => fetchSignificantInfluence(date), [date, policyVersion]);
  const { data, error, reload, notice, setNotice } = useRowState<SignificantInfluenceReport>(load);

  const rows = data?.rows ?? [];
  const held = rows.filter((r) => r.significantInfluence === true);
  const below = rows.filter((r) => r.significantInfluence === false);
  const undetermined = rows.filter((r) => r.significantInfluence === null);
  const mayRecord = CAN_RECORD.includes(role);

  const group = (
    title: string,
    list: SignificantInfluenceRow[],
    tone: 'purple' | 'gray' | 'yellow',
    blurb: string,
  ) => (
    <Card
      title={title}
      headerExtra={<Pill tone={tone}>{list.length}</Pill>}
      noBody
    >
      <div className="cbody" style={{ paddingBottom: 0 }}>
        <ConventionNote>{blurb}</ConventionNote>
      </div>
      {list.length === 0 ? (
        <div className="cbody small">None.</div>
      ) : (
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Company</th>
                <th className="num">Ownership</th>
                <th>As at</th>
                <th className="num">Invested</th>
                <th className="num">FMV</th>
                <th>Why it changed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const age = ageInMonths(r.ownershipAsOfDate, date);
                return (
                  <tr key={r.companyId}>
                    <td>
                      <a className="link" onClick={() => openCompany(r.companyId)}>{r.companyName}</a>
                      {r.exited && <> <Pill tone="gray">exited</Pill></>}
                      <RowFlags edited={r.edited} deleted={false} synthetic={r.isSynthetic} />
                    </td>
                    <td className="num">
                      {r.ownershipPct === null ? <span className="flat">not recorded</span> : pct(r.ownershipPct)}
                      {r.fullyDiluted === false && <> <Pill tone="gray">issued</Pill></>}
                    </td>
                    <td className="small">
                      {r.ownershipAsOfDate ?? '—'}
                      {age !== null && (
                        <span className="hint"> {age <= 0 ? 'current' : `${age} mo old`}</span>
                      )}
                    </td>
                    <td className="num">{money(r.invested)}</td>
                    <td className="num">{money(r.fmv)}</td>
                    <td className="small">
                      {r.changeReason ?? (r.roundLabel ? `${r.roundLabel} (${r.roundDate})` : <span className="flat">—</span>)}
                    </td>
                    <td>
                      {mayRecord && (
                        <button className="btn small" onClick={() => setEditing(r)}>
                          {r.ownershipPct === null ? 'Record' : 'Adjust'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );

  return (
    <>
      <Notice text={notice} onDismiss={() => setNotice(null)} />

      <ConventionNote>
        Derived from recorded ownership alone, at or above the threshold, <b>inclusive</b> — a company at
        exactly the threshold is flagged. Board seats are a known grey area and are not yet part of the
        flag (Q-7); the manual override is additive and will not change what is here.
      </ConventionNote>

      <KpiRow>
        <Kpi
          label="Threshold"
          value={data?.threshold == null ? '—' : `${Number(data.threshold)}%`}
          sub={
            data?.threshold == null
              ? 'Not set — every company reads “not determined”'
              : `In force since ${data.policyEffectiveFrom} · ${data.policySetBy}`
          }
        />
        <Kpi label="Significant Influence" value={String(held.length)} sub={`As at ${date}`} />
        <Kpi label="Below Threshold" value={String(below.length)} sub="Ownership recorded" />
        <Kpi
          label="Not Determined"
          valueClass={undetermined.length > 0 ? 'down' : undefined}
          value={String(undetermined.length)}
          sub="No figure, or no policy"
        />
      </KpiRow>

      <div className="fbar">
        <Field label="As at" hint="The classification is reproduced against the policy in force on this date.">
          <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setEditing(null); }} />
        </Field>
      </div>

      {error && <div className="card"><div className="cbody" style={{ color: 'var(--red)' }}>{error}</div></div>}

      {editing && (
        <OwnershipEntry
          row={editing}
          asOf={date}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setNotice(m); setEditing(null); reload(); }}
        />
      )}

      {/* THE HEADING NAMES THE CAUSE, because null has two of them and they call
          for different actions. With no threshold in force every company is
          undetermined and none of them is missing a figure -- heading that group
          "ownership not recorded" would send Finance chasing 82 cap tables that
          are already recorded, when what is missing is one policy. */}
      {group(
        data?.threshold == null ? 'Not determined — no threshold in force' : 'Ownership not recorded',
        undetermined,
        'yellow',
        data?.threshold == null
          ? 'No threshold is in force, so nothing can be classified — including the companies whose ownership IS recorded. Set one under Finance policies above.'
          : 'We hold no ownership figure for these companies as at this date. They are NOT below the threshold — they are companies nobody has told the platform about, and that is why they are listed rather than quietly absent.',
      )}
      {group(
        'Significant influence',
        held,
        'purple',
        'At or above the threshold on the date, from the latest ownership figure recorded on or before it.',
      )}
      {group(
        'Below the threshold',
        below,
        'gray',
        'Ownership recorded and below the threshold. A recorded answer, not an absent one.',
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Recording one dated position, with the company's history beside it.
 *
 * TWO REASON BOXES, AND THEY ARE NOT THE SAME REASON. *What changed* is stored
 * on the row and is required — an adjustment that cannot say what caused it is
 * a number nobody can defend six months later, and this figure feeds MOIC, the
 * waterfall and the flag above. *Reason for this change* is the ADR-031
 * restatement explanation, required only when the date falls inside a period
 * already issued to the board, which the server decides rather than this form.
 *
 * THE HISTORY IS SHOWN, DELETED ROWS INCLUDED. A position at a date that has
 * been deleted still occupies that date, and re-entering it restores the row
 * rather than creating a second one; a history that hid it would leave the
 * operator unable to see why.
 */
function OwnershipEntry({
  row,
  asOf,
  onClose,
  onSaved,
}: {
  row: SignificantInfluenceRow;
  asOf: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const load = useCallback(() => fetchOwnershipHistory(row.companyId), [row.companyId]);
  const { data, error, reload } = useRowState<{ rows: OwnershipRow[] }>(load);

  const [asOfDate, setAsOfDate] = useState(asOf);
  const [ownershipPct, setOwnershipPct] = useState(
    row.ownershipPct === null ? '' : String(Number(row.ownershipPct)),
  );
  const [fullyDiluted, setFullyDiluted] = useState(row.fullyDiluted !== false);
  const [proRata, setProRata] = useState(row.proRataRights === true);
  const [changeReason, setChangeReason] = useState('');
  const [sourceDocument, setSourceDocument] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await recordOwnership(
        {
          companyId: row.companyId,
          asOfDate,
          ownershipPct: ownershipPct.trim(),
          proRataRights: proRata,
          fullyDiluted,
          sourceDocument: sourceDocument.trim() || null,
          changeReason: changeReason.trim(),
        },
        reason.trim() || null,
      );
      onSaved(
        `${result.replacedExisting ? 'Corrected' : 'Recorded'} ${row.companyName} at ${ownershipPct}% as at ${asOfDate}.` +
          (result.restated ? ' This restates a period already issued to the board.' : ''),
      );
    } catch (err) {
      setFailure(err instanceof PoliciesApiError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const why = window.prompt('Why is this position being removed? Recorded against your name.');
    if (!why?.trim()) return;
    setBusy(true);
    setFailure(null);
    try {
      await deleteOwnership(id, why.trim());
      reload();
    } catch (err) {
      setFailure(err instanceof PoliciesApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={`Ownership — ${row.companyName}`}
      headerExtra={<button className="btn ghost sm" onClick={onClose}>Close ✕</button>}
    >
      <ConventionNote>
        The cap table moves between rounds too — an option pool expansion, a round we did not
        participate in, a secondary. Record those here, dated to when they happened rather than to
        today. A change caused by a round we captured belongs on the <b>Deal Close</b> tab, which
        records the round as the cause.
      </ConventionNote>

      {failure && <div className="small" style={{ color: 'var(--red)' }}>{failure}</div>}

      <FormGrid>
        <Field label="As at" hint="The date the cap table stood this way.">
          <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
        </Field>
        <Field label="Ownership (%)" hint="11.2 means 11.2%.">
          <input inputMode="decimal" value={ownershipPct} onChange={(e) => setOwnershipPct(e.target.value)} />
        </Field>
        <Field label="What changed" hint="Required. An adjustment with no explanation is one nobody can defend later.">
          <input
            value={changeReason}
            placeholder="Option pool expanded by 8%"
            onChange={(e) => setChangeReason(e.target.value)}
          />
        </Field>
        <Field label="Source document" hint="The SharePoint link to the cap table this came from.">
          <input value={sourceDocument} onChange={(e) => setSourceDocument(e.target.value)} />
        </Field>
        <Field label="Basis" hint="Fully diluted is the platform default and what the mandate figures assume.">
          <select value={fullyDiluted ? 'fd' : 'issued'} onChange={(e) => setFullyDiluted(e.target.value === 'fd')}>
            <option value="fd">Fully diluted</option>
            <option value="issued">Issued shares</option>
          </select>
        </Field>
        <Field label="Pro-rata rights" hint="Whether we hold the right to maintain this position.">
          <select value={proRata ? 'y' : 'n'} onChange={(e) => setProRata(e.target.value === 'y')}>
            <option value="y">Held</option>
            <option value="n">Not held</option>
          </select>
        </Field>
        <ReasonField value={reason} onChange={setReason} />
      </FormGrid>

      <button
        className="btn primary small"
        style={{ marginTop: 8 }}
        disabled={busy || !ownershipPct.trim() || !changeReason.trim() || !asOfDate}
        onClick={save}
      >
        Save position
      </button>

      <div style={{ marginTop: 14 }}>
        <div className="small" style={{ fontWeight: 600 }}>Recorded history</div>
        {error && <div className="small" style={{ color: 'var(--red)' }}>{error}</div>}
        {(data?.rows ?? []).length === 0 && <div className="hint">Nothing recorded for this company.</div>}
        {(data?.rows ?? []).map((h) => (
          <div key={h.id} className="alertrow" style={{ opacity: h.deleted ? 0.55 : 1 }}>
            <span className="mono">{pct(h.ownershipPct)}</span>
            <span className="small">as at {h.asOfDate}</span>
            <span className="small" style={{ flex: 1 }}>
              {h.changeReason ?? (h.roundLabel ? `${h.roundLabel} (${h.roundDate})` : '—')}
            </span>
            {h.enteredBy && <span className="hint">{h.enteredBy}</span>}
            <RowFlags edited={h.edited} deleted={h.deleted} synthetic={h.isSynthetic} />
            {!h.deleted && (
              <button className="btn small" disabled={busy} onClick={() => remove(h.id)}>
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
