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
import { useEffect, useState, type ChangeEvent } from 'react';

import { Pill } from './ui';

/** A form's working values. Everything is a string because every input is. */
export type Draft = Record<string, string>;

/**
 * One editable row's working state: which row, what is in the fields, and why
 * it is being changed.
 *
 * EXTRACTED BECAUSE THE SAME NINE LINES WERE WRITTEN FIVE TIMES, and the
 * expression that reads one field back into the draft was written thirty-two:
 *
 *   onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, x: e.target.value } })}
 *
 * Two spreads, three references to `editing`, and the field name buried at the
 * end. It is not hard to write, it is hard to READ -- and it is easy to get
 * subtly wrong in a way that typechecks: spread the draft into the wrong level
 * and every other field is silently dropped on the next keystroke.
 *
 * `DealCloseTab` had already reached the same conclusion privately, with a local
 * `const set = (k, v) => ...` inside one component. This is that idea, in the
 * file the entry surfaces already share.
 *
 * IT KEEPS THE FORM ERROR TOO, and that is not scope creep. Every place that
 * opened a form called `setFormError(null)` immediately before it, without
 * exception, because a stale rejection sitting above a freshly opened form reads
 * as a rejection of the form you are looking at. Two calls that must always
 * happen together are better as one that cannot be half-done.
 *
 * WHAT IT DOES NOT DO is know about a table, an endpoint or a field name.
 * `submit` stays in the surface that owns the row, because that is where the
 * mapping from draft keys to the API's shape belongs and where the wording of a
 * failure has to match the form the reader is looking at.
 *
 * `DealCloseTab` does not use this: its editing state carries a co-investor
 * LIST alongside the draft, and generalising the hook to hold arbitrary extra
 * state would make it a worse fit for the five surfaces that do.
 */
export interface DraftForm {
  /** Null when no form is open. `id` is null on a create. */
  editing: { id: string | null; draft: Draft; reason: string; kind: string } | null;
  /** The rejection shown above the form. Cleared whenever a form is opened. */
  error: string | null;
  setError: (message: string | null) => void;
  /** Open a blank form. `seed` pre-fills fields the surrounding filter implies. */
  create: (seed?: Draft) => void;
  /** Open the form over an existing row. */
  edit: (id: string, draft: Draft) => void;
  close: () => void;
  /** Set one field. */
  set: (field: string, value: string) => void;
  /** Set several fields at once, for a save that writes back what the server did. */
  patch: (fields: Draft) => void;
  setReason: (value: string) => void;
  /** ADR-038, FR-14: why it changed, as distinct from what changed. */
  setKind: (value: string) => void;
  /**
   * `value` and `onChange` for one field, ready to spread onto an input, a
   * select or a textarea.
   *
   * `transform` is for the one field that needs it — currency, upper-cased as
   * it is typed. Passing it here keeps the transform beside the field rather
   * than inside a hand-written handler that also has to remember the spreads.
   */
  field: (name: string, transform?: (raw: string) => string) => {
    value: string;
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
  };
}

export function useDraft(empty: Draft): DraftForm {
  const [editing, setEditing] = useState<DraftForm['editing']>(null);
  const [error, setError] = useState<string | null>(null);

  // Functional updates throughout: a handler that reads `editing` from the
  // render closure is correct today only because no surface sets two fields in
  // one event. That is a property of the callers rather than of this hook, and
  // it should not be one this hook depends on.
  const set = (field: string, value: string) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, [field]: value } } : e));

  return {
    editing,
    error,
    setError,
    create: (seed?: Draft) => {
      setError(null);
      setEditing({ id: null, draft: { ...empty, ...(seed ?? {}) }, reason: '', kind: '' });
    },
    edit: (id: string, draft: Draft) => {
      setError(null);
      setEditing({ id, draft, reason: '', kind: '' });
    },
    close: () => setEditing(null),
    set,
    patch: (fields: Draft) =>
      setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...fields } } : e)),
    setReason: (value: string) => setEditing((e) => (e ? { ...e, reason: value } : e)),
    setKind: (value: string) => setEditing((e) => (e ? { ...e, kind: value } : e)),
    field: (name: string, transform?: (raw: string) => string) => ({
      value: editing?.draft[name] ?? '',
      onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        set(name, transform ? transform(e.target.value) : e.target.value),
    }),
  };
}

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
