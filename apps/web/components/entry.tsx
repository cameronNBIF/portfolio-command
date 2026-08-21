'use client';

/**
 * The scaffolding the data-entry tabs share.
 *
 * Extracted from `FinanceTab` at A8, when the Deal Close tab became the second
 * screen built on it. These pieces were written for A7 and are unchanged; what
 * moved is where they live, so the two entry surfaces cannot drift into looking
 * like two different products.
 *
 * NOTHING HERE KNOWS ABOUT A TABLE OR AN ENDPOINT. Anything that does — the row
 * actions, the drafts, the submit calls — stays in the tab that owns it, because
 * that is where the wording has to match what the person is filling in.
 *
 * These tabs are additions to the ported eight, not changes to them (ADR-014):
 * the prototype has no data entry at all, every figure in it being a literal in
 * a JavaScript object.
 */
import { useEffect, useState } from 'react';

import { Pill } from './ui';

/** A form's working values. Everything is a string because every input is. */
export type Draft = Record<string, string>;

export function Field({
  label, children, hint,
}: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="field" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span className="small" style={{ fontWeight: 600 }}>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function FormGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
      {children}
    </div>
  );
}

/**
 * The reason box, shown on every edit form.
 *
 * Optional in general and mandatory for a restatement, which the API decides
 * rather than this form — the frozen period boundary lives in the database and
 * a copy of it here would be a copy that goes stale. So the field is always
 * offered, and if the server comes back asking for one, its sentence explains
 * why in terms of the actual period.
 */
export function ReasonField({
  value,
  onChange,
  kind,
  onKindChange,
}: {
  value: string;
  onChange: (v: string) => void;
  /** F6, ADR-038 clause 3. Omit both to render the reason alone, as before. */
  kind?: string;
  onKindChange?: (v: string) => void;
}) {
  return (
    <>
      <Field
        label="Reason for this change"
        hint="Recorded against your name. Required when the row falls inside a period already reported to the board."
      >
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
      {onKindChange && (
        /**
         * ADR-038 clause 3, FR-14. WHY it changed, as distinct from what.
         *
         * THE POINT IS THE SECOND OPTION. A grant that becomes known six months
         * after the round is added to that round, and under ADR-031 as built
         * that edit was recorded as a restatement of a board figure — which
         * reads as an accusation of an error nobody made. The row's history was
         * right; the label was wrong.
         *
         * OFFERED ALWAYS, ENFORCED SERVER-SIDE. Whether a row falls inside a
         * frozen period is the database's fact and a copy of that boundary here
         * would be a copy that goes stale — the same reasoning the reason field
         * above already carries. Pick "information arrived late" outside a
         * published period and the server explains why there is nothing to
         * restate, in terms of the actual period.
         */
        <Field
          label="Why"
          hint="Blank leaves it unclassified, which is honest. “Information arrived late” applies only inside a period already reported."
        >
          <select value={kind ?? ''} onChange={(e) => onKindChange(e.target.value)}>
            <option value="">Not classified</option>
            <option value="correction">Correction — the stored figure was wrong</option>
            <option value="new-information">Information arrived late — the figure was right</option>
            <option value="initial-load">Initial load — bulk historical import</option>
          </select>
        </Field>
      )}
    </>
  );
}

export function useRowState<T>(load: () => Promise<T>): {
  data: T | null; error: string | null; reload: () => void; notice: string | null;
  setNotice: (s: string | null) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    load()
      .then((d) => live && (setData(d), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
    // `load` is rebuilt by the caller when its filters change, which is the
    // signal to refetch; `tick` is the explicit "something was written" signal.
  }, [load, tick]);

  return { data, error, notice, setNotice, reload: () => setTick((t) => t + 1) };
}

export function Notice({ text, onDismiss }: { text: string | null; onDismiss: () => void }) {
  if (!text) return null;
  return (
    <div className="alertrow" style={{ marginBottom: 10 }}>
      <span style={{ flex: 1 }}>{text}</span>
      <button className="btn ghost sm" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

/** The marker on a row that has been changed since it was entered. */
export function RowFlags({
  edited, deleted, synthetic,
}: { edited: boolean; deleted: boolean; synthetic: boolean }) {
  return (
    <>
      {deleted && <Pill tone="red">Deleted</Pill>}
      {edited && !deleted && <Pill tone="yellow">Edited</Pill>}
      {synthetic && <Pill tone="gray">Synthetic</Pill>}
    </>
  );
}
