'use client';

/**
 * Transaction entry (A7, ADR-031), and the cheque-to-round link beside it (F1).
 *
 * `investmentRoundId` is carried but not edited by the row save;
 * `investmentVehicleId` is editable (A8).
 *
 * The API takes a COMPLETE row on an update rather than a patch, deliberately —
 * a patch cannot tell "leave this alone" from "clear this". The cost of that
 * choice is that a form which omits a column silently nulls it, and the first
 * amount edit made through this screen did exactly that to a transaction's link
 * to its round. So every column the update writes is round-tripped here, whether
 * or not the form draws an input for it.
 *
 * THE VEHICLE PICKER CLOSES AN A7 ITEM. It shipped read-only because
 * `ref_investment_vehicle` was not exposed through any endpoint, and ADR-030
 * makes the vehicle an attribute of the transaction that Finance should own.
 * A8's capture form needed the same list, so the reference route now exists and
 * this field can be what ADR-030 says it is.
 *
 * THE INSTRUMENT PICKER IS F0, and it sits beside the vehicle picker because it
 * is the same kind of fact about the same cheque. It is NOT the round's
 * instrument, though it usually matches — a round can be funded with a note
 * alongside equity, and a company can hold both an equity position and an
 * outstanding loan against it, which is the case Pat described when he said
 * investments and loans are tracked separately on the balance sheet. Blank
 * means unrecorded and is never filled in on the operator's behalf.
 *
 * THE ROUND PICKER IS ENABLED, AND F1 IS WHY (ADR-033). It shipped read-only
 * with a note pointing at the Deal Close tab, and that note was a dead end: the
 * Deal Close capture does not write this column either. Nothing did (finding
 * S-1); every link in the database was written by the A6 generator.
 *
 * IT SAVES SEPARATELY FROM THE REST OF THE FORM, and the seam is deliberate
 * rather than an accident of implementation. The link goes through
 * `link-transactions`, which is gated on `CAN_CAPTURE_ROUND` and writes the
 * foreign key and nothing else; every other field on this card is
 * `CAN_WRITE_FINANCIAL`. Folding the two into one Save would put the wider
 * permission over both and throw away the argument that lets a deal lead do
 * this at all. So: one card, two saves, and a heading that says which is which.
 *
 * ON A NEW TRANSACTION THE PICKER IS PART OF THE CREATE, because a row that
 * does not exist yet has nothing to reconcile against — the create writes every
 * other column of it already, and the person entering a cheque knows which
 * round it is for. The narrow mutation is for changing a link that exists.
 */
import { useCallback, useMemo, useState } from 'react';

import type { ReferenceData, RoundPage, TransactionPage } from '@portfolio-command/api';
import type { PortfolioExport } from '@portfolio-command/contract';

import {
  DIRECT_TXN_TYPES,
  ROUND_TXN_TYPES,
  TXN_TYPE_LABELS,
  fetchTransactions,
  money,
  mutate,
} from '../../../lib/finance-api';
import { apiMessage } from '../../../lib/http';
// ADR-030's vehicle list, served by the A8 reference route. F1 adds the round
// list the picker offers and the narrow mutation that writes the link.
import { fetchReference, fetchRounds, linkTransactions } from '../../../lib/rounds-api';
import {
  Field,
  FormGrid,
  Notice,
  ReasonField,
  RowFlags,
  useDraft,
  useRowState,
  type Draft,
  type DraftForm,
} from '../../entry';
import { Card, Kpi, KpiRow, Pill } from '../../ui';
import { RowActions } from './RowActions';

const EMPTY_TXN: Draft = {
  txnDate: '', txnType: 'investment', companyId: '', fundInvestmentId: '',
  amount: '', currency: 'CAD', fxRateToCad: '', sourceDocument: '', note: '',
  investmentRoundId: '', investmentVehicleId: '', vehicleName: '',
  instrumentId: '', instrumentName: '',
  roundLabel: '', roundDate: '', standaloneConfirmedAt: '', standaloneConfirmedByName: '',
  // What the database holds, kept beside what the picker shows. RoundLink
  // compares the two to decide whether there is anything to save; without a
  // stored value to compare against, the fallback made every change look like
  // no change and the Save button never enabled.
  storedRoundId: '',
};

export function TransactionsSurface({ db }: { db: PortfolioExport }) {
  const [companyId, setCompanyId] = useState('');
  const [txnType, setTxnType] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const form = useDraft(EMPTY_TXN);

  const load = useCallback(
    () => fetchTransactions({
      ...(companyId ? { companyId } : {}),
      ...(txnType ? { txnType } : {}),
      includeDeleted: String(includeDeleted),
      limit: '250',
    }),
    [companyId, txnType, includeDeleted],
  );
  const { data, error, reload, notice, setNotice } = useRowState<TransactionPage>(load);

  // Loaded once; the reference lists do not change during a session.
  const loadReference = useCallback(() => fetchReference(), []);
  const { data: reference } = useRowState<ReferenceData>(loadReference);

  const companies = useMemo(
    () => [...db.companies].sort((a, b) => a.name.localeCompare(b.name)),
    [db.companies],
  );

  const editing = form.editing;

  const submit = async () => {
    if (!editing) return;
    form.setError(null);
    const d = editing.draft;
    const isDirectRow = DIRECT_TXN_TYPES.includes(d['txnType'] ?? '');
    try {
      const result = await mutate({
        table: 'transaction',
        op: editing.id ? 'update' : 'create',
        ...(editing.id ? { id: editing.id } : {}),
        reason: editing.reason || null,
        changeKind: editing.kind || null,
        values: {
          txnDate: d['txnDate'],
          txnType: d['txnType'],
          companyId: isDirectRow ? d['companyId'] || null : null,
          fundInvestmentId: isDirectRow ? null : d['fundInvestmentId'] || null,
          amount: d['amount'],
          currency: d['currency'] || 'CAD',
          fxRateToCad: d['fxRateToCad'] || null,
          sourceDocument: d['sourceDocument'] || null,
          note: d['note'] || null,
          // On a create this is the picker's value; on an update it is the
          // stored link being round-tripped so the complete-row write does not
          // null it, and the picker's own Save is what changes it. Either way
          // the draft is the single source, which is why RoundLink writes back
          // into it after a successful link (ADR-033).
          investmentRoundId: d['investmentRoundId'] || null,
          investmentVehicleId: d['investmentVehicleId'] ? Number(d['investmentVehicleId']) : null,
          // Cleared alongside companyId when the type flips to LP activity, for
          // the same reason and against the same constraint: a drawdown
          // bought no instrument.
          instrumentId: isDirectRow && d['instrumentId'] ? Number(d['instrumentId']) : null,
        },
      });
      form.close();
      setNotice(
        result.restated
          ? 'Saved, and recorded as a restatement — this row falls inside a period already reported to the board.'
          : 'Saved.',
      );
      reload();
    } catch (e) {
      form.setError(apiMessage(e, 'Save failed.'));
    }
  };

  const isDirect = DIRECT_TXN_TYPES.includes(editing?.draft['txnType'] ?? 'investment');

  return (
    <>
      <Notice text={notice} onDismiss={() => setNotice(null)} />

      <KpiRow>
        <Kpi label="Invested" value={money(data?.totals.invested)} sub="Net of deletions" />
        <Kpi label="Realized" value={money(data?.totals.realized)} sub="Net of deletions" />
        <Kpi label="Rows" value={data ? String(data.total) : '—'} sub="Matching the filter" />
      </KpiRow>

      <div className="fbar">
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">All companies</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={txnType} onChange={(e) => setTxnType(e.target.value)}>
          <option value="">All types</option>
          {Object.entries(TXN_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          Show deleted
        </label>
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => form.create()}>
          + New transaction
        </button>
      </div>

      {editing && (
        <Card title={editing.id ? `Edit transaction #${editing.id}` : 'New transaction'}>
          {form.error && (
            <div className="alertrow" style={{ marginBottom: 10, color: 'var(--red)' }}>{form.error}</div>
          )}
          <FormGrid>
            <Field label="Date">
              <input type="date" {...form.field('txnDate')} />
            </Field>
            <Field label="Type">
              <select {...form.field('txnType')}>
                {Object.entries(TXN_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            {isDirect ? (
              <Field label="Company">
                <select {...form.field('companyId')}>
                  <option value="">Select…</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="Fund position" hint="Capital drawdowns, capital distributions and fees belong to an LP position.">
                <select {...form.field('fundInvestmentId')}>
                  <option value="">Select…</option>
                  {db.fundInvestments.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Amount (CAD dollars)" hint="As on the cheque — 5000000.00, not 5.">
              <input type="text" inputMode="decimal" placeholder="0.00" {...form.field('amount')} />
            </Field>
            <Field label="Currency">
              <input type="text" {...form.field('currency', (v) => v.toUpperCase())} />
            </Field>
            {(editing.draft['currency'] ?? 'CAD') !== 'CAD' && (
              <Field label="FX rate to CAD" hint="The rate at the transaction date, not today's (ADR-021).">
                <input type="text" inputMode="decimal" {...form.field('fxRateToCad')} />
              </Field>
            )}
            <Field label="Source document" hint="Link to the closing docs or bank record.">
              <input type="text" {...form.field('sourceDocument')} />
            </Field>
            {/* ADR-030. Null is "unrecorded", never a default: two roster
                companies genuinely have no vehicle attribution, and a default
                would attribute $3.7M of real deployment to a guess. */}
            <Field
              label="Investment vehicle"
              hint="Which vehicle this dollar was deployed from. Leave blank if unrecorded."
            >
              <select {...form.field('investmentVehicleId')}>
                <option value="">Not recorded</option>
                {(reference?.investmentVehicles ?? []).map((v) => (
                  <option key={v.id} value={String(v.id)}>{v.code} — {v.name}</option>
                ))}
              </select>
            </Field>
            {/* F0. Only on a direct cheque: an LP drawdown or distribution
                has no instrument, and offering the picker there would invite an
                answer to a question that does not apply. */}
            {isDirect && (
              <Field
                label="Instrument"
                hint="What this cheque bought — not necessarily the round's instrument. Leave blank if unrecorded."
              >
                <select {...form.field('instrumentId')}>
                  <option value="">Not recorded</option>
                  {(reference?.instruments ?? []).map((i) => (
                    <option key={i.id} value={String(i.id)}>{i.name}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Note">
              <input type="text" {...form.field('note')} />
            </Field>
            <ReasonField
              value={editing.reason}
              onChange={form.setReason}
              kind={editing.kind}
              onKindChange={form.setKind}
            />
          </FormGrid>

          {isDirect && editing.draft['companyId'] && (
            <RoundLink form={form} onSaved={(m) => { setNotice(m); reload(); }} />
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={submit}>{editing.id ? 'Save changes' : 'Add transaction'}</button>
            <button className="btn ghost" onClick={form.close}>Cancel</button>
          </div>
        </Card>
      )}

      <Card title="Transactions" noBody>
        {error && <div className="cbody" style={{ color: 'var(--red)' }}>{error}</div>}
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Subject</th>
                <th>Round</th>
                <th className="num">Amount</th>
                <th className="num">CAD</th>
                <th>Flags</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id} style={r.deletedAt ? { opacity: 0.55 } : undefined}>
                  <td className="mono">{r.txnDate}</td>
                  <td>{TXN_TYPE_LABELS[r.txnType] ?? r.txnType}</td>
                  <td>
                    {r.companyName ?? r.fundName ?? '—'}
                    {r.deletedReason && <div className="hint">Deleted: {r.deletedReason}</div>}
                  </td>
                  {/* F1. The three states that used to look identical, said
                      out loud: attached, deliberately standalone, and nobody
                      has looked. Only the third is a chasing target, and it is
                      the one F6 counts. */}
                  <td className="small">
                    {r.roundLabel ? (
                      <>
                        {r.roundLabel}
                        <div className="hint mono">{r.roundDate}</div>
                      </>
                    ) : !ROUND_TXN_TYPES.includes(r.txnType) ? (
                      // A write-off, a realization or an LP cashflow does not
                      // fund a round, so it is never missing one. See
                      // ROUND_TXN_TYPES.
                      <span className="hint">—</span>
                    ) : r.standaloneConfirmedAt ? (
                      <span className="hint">
                        Standalone
                        {r.standaloneConfirmedByName ? ` · ${r.standaloneConfirmedByName}` : ''}
                      </span>
                    ) : (
                      <Pill tone="yellow">Not linked</Pill>
                    )}
                  </td>
                  <td className="num mono">
                    {money(r.amount)}
                    {r.currency !== 'CAD' && <span className="hint"> {r.currency}</span>}
                  </td>
                  <td className="num mono">{money(r.amountCad)}</td>
                  <td>
                    <RowFlags edited={r.edited} deleted={!!r.deletedAt} synthetic={r.isSynthetic} />
                  </td>
                  <td>
                    <RowActions
                      table="transaction"
                      id={r.id}
                      deleted={!!r.deletedAt}
                      onEdit={() => form.edit(r.id, {
                        txnDate: r.txnDate,
                        txnType: r.txnType,
                        companyId: r.companyId ?? '',
                        fundInvestmentId: r.fundInvestmentId ?? '',
                        amount: r.amount,
                        currency: r.currency,
                        fxRateToCad: r.fxRateToCad ?? '',
                        sourceDocument: r.sourceDocument ?? '',
                        note: r.note ?? '',
                        investmentRoundId: r.investmentRoundId ?? '',
                        storedRoundId: r.investmentRoundId ?? '',
                        roundLabel: r.roundLabel ?? '',
                        roundDate: r.roundDate ?? '',
                        standaloneConfirmedAt: r.standaloneConfirmedAt ?? '',
                        standaloneConfirmedByName: r.standaloneConfirmedByName ?? '',
                        investmentVehicleId: r.investmentVehicleId ? String(r.investmentVehicleId) : '',
                        vehicleName: r.vehicleName ?? '',
                        instrumentId: r.instrumentId ? String(r.instrumentId) : '',
                        instrumentName: r.instrumentName ?? '',
                      })}
                      onChanged={(m) => { setNotice(m); reload(); }}
                    />
                  </td>
                </tr>
              ))}
              {data?.rows.length === 0 && (
                <tr><td colSpan={8} className="hint">No transactions match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/**
 * The cheque-to-round link, on the Finance surface (ADR-033, F1).
 *
 * ITS OWN SAVE BUTTON, INSIDE SOMEBODY ELSE'S FORM, and the oddness is the
 * point. Everything else on this card is `CAN_WRITE_FINANCIAL`; this one control
 * is `CAN_CAPTURE_ROUND`, because ADR-033 holds that attaching a cheque to a
 * round is reconciliation rather than restatement. One Save over both would put
 * the wider permission over the narrower operation and dissolve the distinction
 * the whole phase rests on. So the seam stays visible: a heading, a picker, and
 * a button that says what it writes.
 *
 * It also means a link change is not lost if the row save fails validation, and
 * a row save is not lost if the link is refused — which is the practical half of
 * the same argument.
 *
 * ON A NEW TRANSACTION there is no row to reconcile yet, so the picker just
 * edits the draft and the create writes it along with every other column. The
 * button appears only once the row exists.
 */
function RoundLink({ form, onSaved }: { form: DraftForm; onSaved: (message: string) => void }) {
  const editing = form.editing;
  const companyId = editing?.draft['companyId'] ?? '';
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Rebuilt when the company changes, which is what tells useRowState to
  // refetch. A cheque can only join a round of its own company, so the list
  // offered must follow the company picker above it.
  const load = useCallback(
    () => fetchRounds({ companyId, limit: '200' }),
    [companyId],
  );
  const { data: rounds } = useRowState<RoundPage>(load);

  // `storedRoundId` is what the database holds; `investmentRoundId` is what the
  // picker shows. They are separate fields rather than one, because the row save
  // round-trips the second and the link save writes the first — collapsing them
  // would mean the Save button could not tell a change from a reload.
  const selected = editing?.draft['investmentRoundId'] ?? '';
  const stored = editing?.draft['storedRoundId'] ?? '';
  const rowId = editing?.id ?? null;
  const dirty = rowId !== null && selected !== stored;

  const save = async () => {
    if (!rowId) return;
    setError(null);
    setSaving(true);
    try {
      const result = await linkTransactions({
        transactionIds: [rowId],
        investmentRoundId: selected || null,
        reason: editing?.reason || null,
      });
      // The draft is the single source the row save round-trips from, so it has
      // to learn what just happened — otherwise a later "Save changes" would
      // write the stale link straight back over this one.
      const round = rounds?.rows.find((r) => r.id === selected);
      form.patch({
        investmentRoundId: selected,
        storedRoundId: selected,
        roundLabel: round?.label ?? '',
        roundDate: round?.roundDate ?? '',
        standaloneConfirmedAt: selected ? '' : new Date().toISOString(),
      });
      onSaved(
        (result.linked > 0
          ? 'Cheque attached to the round.'
          : 'Recorded as standalone — this cheque correctly belongs to no round.') +
          (result.participationSetToYes
            ? ' The round now records that we participated.'
            : '') +
          (result.restated
            ? ' Recorded as a restatement: this falls inside a period already reported to the board.'
            : ''),
      );
    } catch (e) {
      setError(apiMessage(e, 'Could not change the round link.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="vsub" style={{ fontWeight: 700, color: 'var(--slate)', marginBottom: 6 }}>
        ROUND LINK
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        Which financing round this cheque funded. Saved on its own, because it is a reconciliation
        rather than a change to the figures — the deal lead who closed the round can make it too
        (ADR-033). <b>No round — standalone</b> is a positive statement, not a blank: it records that
        somebody checked, which is what keeps the reconciliation screen able to reach zero.
      </div>

      {error && (
        <div className="alertrow" style={{ marginBottom: 8, color: 'var(--red)' }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px' }}>
          <Field label="Round">
            <select {...form.field('investmentRoundId')}>
              <option value="">No round — standalone</option>
              {(rounds?.rows ?? [])
                .filter((r) => !r.deletedAt)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.roundDate} · {r.label}
                    {r.nbifParticipated === 'no' ? ' (we did not participate)' : ''}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        {rowId && (
          <button className="btn" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save round link'}
          </button>
        )}
      </div>

      {!rowId && (
        <div className="hint" style={{ marginTop: 6 }}>
          Saved with the transaction below — there is nothing to reconcile until the row exists.
        </div>
      )}
      {rowId && !selected && editing?.draft['standaloneConfirmedAt'] && (
        <div className="hint" style={{ marginTop: 6 }}>
          Confirmed standalone
          {editing.draft['standaloneConfirmedByName']
            ? ` by ${editing.draft['standaloneConfirmedByName']}`
            : ''}
          .
        </div>
      )}
      {rowId && !selected && !editing?.draft['standaloneConfirmedAt'] && (
        <div className="hint" style={{ marginTop: 6 }}>
          Not linked, and nobody has confirmed that it should not be. Save this control to say
          either way.
        </div>
      )}
    </div>
  );
}
