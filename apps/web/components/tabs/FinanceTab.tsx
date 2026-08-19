'use client';

/**
 * The Finance entry interfaces (A7).
 *
 * A NINTH TAB, where ADR-014 froze eight. That is not a violation of it: ADR-014
 * governs the one-to-one port of the prototype, and the prototype has no data
 * entry at all — every figure in it is a literal in a JavaScript object. Stage 3
 * of the roadmap adds production workflows the prototype never had, and this is
 * the first of them. The eight ported tabs are untouched.
 *
 * ROLE-GATED to `finance` and `admin`, matching CAN_WRITE_FINANCIAL. The VC team
 * owns judgement, Finance owns the money (ADR-005), and a tab that appears but
 * refuses every action is a worse experience than one that is not there.
 *
 * THE INTERFACE IS EDIT, DELETE AND RESTORE (ADR-031), not the Correct and
 * Reverse that ADR-018 specified. Reversal still exists in the schema for a
 * genuine clawback — a real economic event with its own date — but it is no
 * longer how a typing error is fixed. Every change here is captured by a
 * database trigger with the actor, the reason and the complete prior row.
 */
import { useCallback, useMemo, useState } from 'react';

import type {
  LpNavRow,
  ReferenceData,
  TransactionPage,
  ValuationMarkRow,
} from '@portfolio-command/api';
import type { PortfolioExport } from '@portfolio-command/contract';

import { useApp } from '../AppShell';
import { Card, Kpi, KpiRow, Pill, ViewHeader } from '../ui';
// The form scaffolding moved to `entry.tsx` at A8 so the Deal Close tab could
// share it. Unchanged from A7; only its address is different.
import {
  Field,
  FormGrid,
  Notice,
  ReasonField,
  RowFlags,
  useRowState,
  type Draft,
} from '../entry';
import {
  DIRECT_TXN_TYPES,
  FinanceApiError,
  TXN_TYPE_LABELS,
  fetchLpNav,
  fetchMarks,
  fetchTransactions,
  money,
  mutate,
  type FinancialTableName,
} from '../../lib/finance-api';
// ADR-030's vehicle list, served by the A8 reference route.
import { fetchReference } from '../../lib/rounds-api';

type Surface = 'transactions' | 'marks' | 'lp';

const SURFACES: { id: Surface; label: string }[] = [
  { id: 'transactions', label: 'Transactions' },
  { id: 'marks', label: 'Valuation Marks' },
  { id: 'lp', label: 'LP Activity' },
];

export function FinanceTab({ db }: { db: PortfolioExport }) {
  const [surface, setSurface] = useState<Surface>('transactions');

  return (
    <>
      <ViewHeader
        title="Finance"
        sub="Transaction, valuation and LP entry. Every change is attributed and recorded."
      />
      <div className="fbar">
        {SURFACES.map((s) => (
          <button
            key={s.id}
            className={s.id === surface ? 'btn sm' : 'btn ghost sm'}
            onClick={() => setSurface(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {surface === 'transactions' && <TransactionsSurface db={db} />}
      {surface === 'marks' && <MarksSurface db={db} />}
      {surface === 'lp' && <LpSurface db={db} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces specific to this tab. The generic form scaffolding is in `entry.tsx`.
// ---------------------------------------------------------------------------

/**
 * The row-level actions, identical across all three surfaces.
 *
 * "Delete" rather than "Void", and no "Reverse": ADR-031 clause 6 and 7. A row
 * booked against the wrong company is deleted and re-entered, which is what the
 * operator would do in a spreadsheet and now does here.
 */
function RowActions({
  table, id, deleted, onEdit, onChanged,
}: {
  table: FinancialTableName;
  id: string;
  deleted: boolean;
  onEdit: () => void;
  onChanged: (message: string) => void;
}) {
  const { openDrawer } = useApp();

  const remove = async () => {
    const reason = window.prompt('Why is this row being deleted? This is recorded against your name.');
    if (!reason) return;
    try {
      await mutate({ table, op: 'delete', id, reason });
      onChanged('Deleted');
    } catch (e) {
      onChanged(e instanceof FinanceApiError ? e.message : 'Delete failed');
    }
  };

  const restore = async () => {
    try {
      await mutate({ table, op: 'restore', id, reason: 'Restored from the Finance tab' });
      onChanged('Restored');
    } catch (e) {
      onChanged(e instanceof FinanceApiError ? e.message : 'Restore failed');
    }
  };

  return (
    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
      {!deleted && (
        <button className="btn ghost sm" onClick={onEdit}>Edit</button>
      )}
      <button
        className="btn ghost sm"
        onClick={() => openDrawer({ kind: 'financial-history', table, id })}
      >
        History
      </button>
      {deleted ? (
        <button className="btn ghost sm" onClick={restore}>Restore</button>
      ) : (
        <button className="btn danger sm" onClick={remove}>Delete</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * `investmentRoundId` is carried but not edited; `investmentVehicleId` is now
 * editable (A8).
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
 * The round link stays read-only for now, and F1 is the phase that changes
 * that. The note below it is currently a dead end — it points at the Deal Close
 * tab, which does not write this column either. Nothing does (finding S-1);
 * every link in the database was written by the A6 generator.
 */
const EMPTY_TXN: Draft = {
  txnDate: '', txnType: 'investment', companyId: '', fundInvestmentId: '',
  amount: '', currency: 'CAD', fxRateToCad: '', sourceDocument: '', note: '',
  investmentRoundId: '', investmentVehicleId: '', vehicleName: '',
  instrumentId: '', instrumentName: '',
};

function TransactionsSurface({ db }: { db: PortfolioExport }) {
  const [companyId, setCompanyId] = useState('');
  const [txnType, setTxnType] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft; reason: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

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

  const submit = async () => {
    if (!editing) return;
    setFormError(null);
    const d = editing.draft;
    const isDirect = DIRECT_TXN_TYPES.includes(d['txnType'] ?? '');
    try {
      const result = await mutate({
        table: 'transaction',
        op: editing.id ? 'update' : 'create',
        ...(editing.id ? { id: editing.id } : {}),
        reason: editing.reason || null,
        values: {
          txnDate: d['txnDate'],
          txnType: d['txnType'],
          companyId: isDirect ? d['companyId'] || null : null,
          fundInvestmentId: isDirect ? null : d['fundInvestmentId'] || null,
          amount: d['amount'],
          currency: d['currency'] || 'CAD',
          fxRateToCad: d['fxRateToCad'] || null,
          sourceDocument: d['sourceDocument'] || null,
          note: d['note'] || null,
          // Preserved, not edited. See the note on EMPTY_TXN.
          investmentRoundId: d['investmentRoundId'] || null,
          investmentVehicleId: d['investmentVehicleId'] ? Number(d['investmentVehicleId']) : null,
          // Cleared alongside companyId when the type flips to LP activity, for
          // the same reason and against the same constraint: a capital call
          // bought no instrument.
          instrumentId: isDirect && d['instrumentId'] ? Number(d['instrumentId']) : null,
        },
      });
      setEditing(null);
      setNotice(
        result.restated
          ? 'Saved, and recorded as a restatement — this row falls inside a period already reported to the board.'
          : 'Saved.',
      );
      reload();
    } catch (e) {
      setFormError(e instanceof FinanceApiError ? e.message : 'Save failed.');
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
        <button
          className="btn sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => { setFormError(null); setEditing({ id: null, draft: { ...EMPTY_TXN }, reason: '' }); }}
        >
          + New transaction
        </button>
      </div>

      {editing && (
        <Card title={editing.id ? `Edit transaction #${editing.id}` : 'New transaction'}>
          {formError && (
            <div className="alertrow" style={{ marginBottom: 10, color: 'var(--red)' }}>{formError}</div>
          )}
          <FormGrid>
            <Field label="Date">
              <input
                type="date"
                value={editing.draft['txnDate'] ?? ''}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, txnDate: e.target.value } })}
              />
            </Field>
            <Field label="Type">
              <select
                value={editing.draft['txnType'] ?? ''}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, txnType: e.target.value } })}
              >
                {Object.entries(TXN_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            {isDirect ? (
              <Field label="Company">
                <select
                  value={editing.draft['companyId'] ?? ''}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, companyId: e.target.value } })}
                >
                  <option value="">Select…</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="Fund position" hint="Capital calls, distributions and fees belong to an LP position.">
                <select
                  value={editing.draft['fundInvestmentId'] ?? ''}
                  onChange={(e) =>
                    setEditing({ ...editing, draft: { ...editing.draft, fundInvestmentId: e.target.value } })}
                >
                  <option value="">Select…</option>
                  {db.fundInvestments.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Amount (CAD dollars)" hint="As on the cheque — 5000000.00, not 5.">
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={editing.draft['amount'] ?? ''}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, amount: e.target.value } })}
              />
            </Field>
            <Field label="Currency">
              <input
                type="text"
                value={editing.draft['currency'] ?? 'CAD'}
                onChange={(e) =>
                  setEditing({ ...editing, draft: { ...editing.draft, currency: e.target.value.toUpperCase() } })}
              />
            </Field>
            {(editing.draft['currency'] ?? 'CAD') !== 'CAD' && (
              <Field label="FX rate to CAD" hint="The rate at the transaction date, not today's (ADR-021).">
                <input
                  type="text"
                  inputMode="decimal"
                  value={editing.draft['fxRateToCad'] ?? ''}
                  onChange={(e) =>
                    setEditing({ ...editing, draft: { ...editing.draft, fxRateToCad: e.target.value } })}
                />
              </Field>
            )}
            <Field label="Source document" hint="Link to the closing docs or bank record.">
              <input
                type="text"
                value={editing.draft['sourceDocument'] ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, draft: { ...editing.draft, sourceDocument: e.target.value } })}
              />
            </Field>
            {/* ADR-030. Null is "unrecorded", never a default: two roster
                companies genuinely have no vehicle attribution, and a default
                would attribute $3.7M of real deployment to a guess. */}
            <Field
              label="Investment vehicle"
              hint="Which vehicle this dollar was deployed from. Leave blank if unrecorded."
            >
              <select
                value={editing.draft['investmentVehicleId'] ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    draft: { ...editing.draft, investmentVehicleId: e.target.value },
                  })}
              >
                <option value="">Not recorded</option>
                {(reference?.investmentVehicles ?? []).map((v) => (
                  <option key={v.id} value={String(v.id)}>{v.code} — {v.name}</option>
                ))}
              </select>
            </Field>
            {/* F0. Only on a direct cheque: an LP capital call or distribution
                has no instrument, and offering the picker there would invite an
                answer to a question that does not apply. */}
            {isDirect && (
              <Field
                label="Instrument"
                hint="What this cheque bought — not necessarily the round's instrument. Leave blank if unrecorded."
              >
                <select
                  value={editing.draft['instrumentId'] ?? ''}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      draft: { ...editing.draft, instrumentId: e.target.value },
                    })}
                >
                  <option value="">Not recorded</option>
                  {(reference?.instruments ?? []).map((i) => (
                    <option key={i.id} value={String(i.id)}>{i.name}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Note">
              <input
                type="text"
                value={editing.draft['note'] ?? ''}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, note: e.target.value } })}
              />
            </Field>
            <ReasonField
              value={editing.reason}
              onChange={(reason) => setEditing({ ...editing, reason })}
            />
          </FormGrid>

          {editing.id && editing.draft['investmentRoundId'] && (
            <div className="hint" style={{ marginTop: 10 }}>
              Linked to round <span className="mono">#{editing.draft['investmentRoundId']}</span>, which
              this edit preserves. Which round a cheque belongs to is a deal-capture decision rather
              than a Finance correction — it is set on the Deal Close tab.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={submit}>{editing.id ? 'Save changes' : 'Add transaction'}</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
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
                      onEdit={() => {
                        setFormError(null);
                        setEditing({
                          id: r.id,
                          reason: '',
                          draft: {
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
                            investmentVehicleId: r.investmentVehicleId ? String(r.investmentVehicleId) : '',
                            vehicleName: r.vehicleName ?? '',
                            instrumentId: r.instrumentId ? String(r.instrumentId) : '',
                            instrumentName: r.instrumentName ?? '',
                          },
                        });
                      }}
                      onChanged={(m) => { setNotice(m); reload(); }}
                    />
                  </td>
                </tr>
              ))}
              {data?.rows.length === 0 && (
                <tr><td colSpan={7} className="hint">No transactions match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Valuation marks
// ---------------------------------------------------------------------------

const EMPTY_MARK: Draft = {
  companyId: '', effectiveDate: '', fmv: '', methodLabel: '', rationale: '', sourceDocument: '',
};

function MarksSurface({ db }: { db: PortfolioExport }) {
  const [companyId, setCompanyId] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft; reason: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(
    () => fetchMarks({
      ...(companyId ? { companyId } : {}),
      includeDeleted: String(includeDeleted),
    }),
    [companyId, includeDeleted],
  );
  const { data, error, reload, notice, setNotice } = useRowState<{ rows: ValuationMarkRow[] }>(load);

  const companies = useMemo(
    () => [...db.companies].sort((a, b) => a.name.localeCompare(b.name)),
    [db.companies],
  );

  const submit = async () => {
    if (!editing) return;
    setFormError(null);
    const d = editing.draft;
    try {
      const result = await mutate({
        table: 'valuation_mark',
        op: editing.id ? 'update' : 'create',
        ...(editing.id ? { id: editing.id } : {}),
        reason: editing.reason || null,
        values: {
          companyId: d['companyId'],
          effectiveDate: d['effectiveDate'],
          fmv: d['fmv'],
          methodLabel: d['methodLabel'],
          rationale: d['rationale'],
          sourceDocument: d['sourceDocument'] || null,
        },
      });
      setEditing(null);
      setNotice(result.restated ? 'Saved, and recorded as a restatement.' : 'Saved.');
      reload();
    } catch (e) {
      setFormError(e instanceof FinanceApiError ? e.message : 'Save failed.');
    }
  };

  return (
    <>
      <Notice text={notice} onDismiss={() => setNotice(null)} />

      <div className="hint" style={{ marginBottom: 10 }}>
        Marks are effective 31 January and 31 July and are carried forward between exercises
        (ADR-007). Entering a mark <b>is</b> the sign-off — your name is recorded as the preparer.
      </div>

      <div className="fbar">
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">All companies</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
          Show deleted
        </label>
        <button
          className="btn sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => { setFormError(null); setEditing({ id: null, draft: { ...EMPTY_MARK }, reason: '' }); }}
        >
          + New mark
        </button>
      </div>

      {editing && (
        <Card title={editing.id ? `Edit mark #${editing.id}` : 'New valuation mark'}>
          {formError && (
            <div className="alertrow" style={{ marginBottom: 10, color: 'var(--red)' }}>{formError}</div>
          )}
          <FormGrid>
            <Field label="Company">
              <select
                value={editing.draft['companyId'] ?? ''}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, companyId: e.target.value } })}
              >
                <option value="">Select…</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Effective date" hint="The date the mark is 'as at'.">
              <input
                type="date"
                value={editing.draft['effectiveDate'] ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, draft: { ...editing.draft, effectiveDate: e.target.value } })}
              />
            </Field>
            <Field label="FMV (CAD dollars)" hint="Zero is valid — it is how a write-off is marked.">
              <input
                type="text"
                inputMode="decimal"
                value={editing.draft['fmv'] ?? ''}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, fmv: e.target.value } })}
              />
            </Field>
            <Field label="Method" hint="e.g. Last round price, Revenue multiple, DCF.">
              <input
                type="text"
                value={editing.draft['methodLabel'] ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, draft: { ...editing.draft, methodLabel: e.target.value } })}
              />
            </Field>
            <Field label="Source document">
              <input
                type="text"
                value={editing.draft['sourceDocument'] ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, draft: { ...editing.draft, sourceDocument: e.target.value } })}
              />
            </Field>
            <ReasonField value={editing.reason} onChange={(reason) => setEditing({ ...editing, reason })} />
          </FormGrid>
          <div style={{ marginTop: 12 }}>
            <Field
              label="Rationale"
              hint="Required. This is what a board member or auditor reads when they challenge the number."
            >
              <textarea
                rows={3}
                value={editing.draft['rationale'] ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, draft: { ...editing.draft, rationale: e.target.value } })}
              />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={submit}>{editing.id ? 'Save changes' : 'Add mark'}</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </Card>
      )}

      <Card title="Valuation marks" noBody>
        {error && <div className="cbody" style={{ color: 'var(--red)' }}>{error}</div>}
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>As at</th>
                <th>Company</th>
                <th className="num">FMV</th>
                <th>Method</th>
                <th>Prepared by</th>
                <th>Flags</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id} style={r.deletedAt ? { opacity: 0.55 } : undefined}>
                  <td className="mono">{r.effectiveDate}</td>
                  <td>
                    {r.companyName ?? r.companyId}
                    <div className="hint">{r.rationale}</div>
                  </td>
                  <td className="num mono">{money(r.fmv)}</td>
                  <td>{r.methodLabel}</td>
                  <td>{r.preparedByLabel}</td>
                  <td>
                    {r.status === 'superseded' && <Pill tone="gray">Superseded</Pill>}
                    <RowFlags edited={r.edited} deleted={!!r.deletedAt} synthetic={r.isSynthetic} />
                  </td>
                  <td>
                    <RowActions
                      table="valuation_mark"
                      id={r.id}
                      deleted={!!r.deletedAt}
                      onEdit={() => {
                        setFormError(null);
                        setEditing({
                          id: r.id,
                          reason: '',
                          draft: {
                            companyId: r.companyId,
                            effectiveDate: r.effectiveDate,
                            fmv: r.fmv,
                            methodLabel: r.methodLabel,
                            rationale: r.rationale,
                            sourceDocument: r.sourceDocument ?? '',
                          },
                        });
                      }}
                      onChanged={(m) => { setNotice(m); reload(); }}
                    />
                  </td>
                </tr>
              ))}
              {data?.rows.length === 0 && (
                <tr><td colSpan={7} className="hint">No marks match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// LP activity
// ---------------------------------------------------------------------------

const EMPTY_NAV: Draft = {
  fundInvestmentId: '', asOfDate: '', nav: '', statementReceivedAt: '', sourceDocument: '',
};

function LpSurface({ db }: { db: PortfolioExport }) {
  const [fundInvestmentId, setFundInvestmentId] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft; reason: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(
    () => fetchLpNav({
      ...(fundInvestmentId ? { fundInvestmentId } : {}),
      includeDeleted: String(includeDeleted),
    }),
    [fundInvestmentId, includeDeleted],
  );
  const { data, error, reload, notice, setNotice } = useRowState<{ rows: LpNavRow[] }>(load);

  const submit = async () => {
    if (!editing) return;
    setFormError(null);
    const d = editing.draft;
    try {
      const result = await mutate({
        table: 'fund_investment_nav',
        op: editing.id ? 'update' : 'create',
        ...(editing.id ? { id: editing.id } : {}),
        reason: editing.reason || null,
        values: {
          fundInvestmentId: d['fundInvestmentId'],
          asOfDate: d['asOfDate'],
          nav: d['nav'],
          statementReceivedAt: d['statementReceivedAt'] || null,
          sourceDocument: d['sourceDocument'] || null,
        },
      });
      setEditing(null);
      setNotice(result.restated ? 'Saved, and recorded as a restatement.' : 'Saved.');
      reload();
    } catch (e) {
      setFormError(e instanceof FinanceApiError ? e.message : 'Save failed.');
    }
  };

  return (
    <>
      <Notice text={notice} onDismiss={() => setNotice(null)} />

      <div className="hint" style={{ marginBottom: 10 }}>
        GP capital-account statements. Capital calls, distributions and fees are entered on the
        Transactions surface against a fund position; this is the NAV the GP reports, which
        typically lags a quarter — the gap between the as-at date and the receipt date is what
        makes that visible.
      </div>

      <div className="fbar">
        <select value={fundInvestmentId} onChange={(e) => setFundInvestmentId(e.target.value)}>
          <option value="">All fund positions</option>
          {db.fundInvestments.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
          Show deleted
        </label>
        <button
          className="btn sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => { setFormError(null); setEditing({ id: null, draft: { ...EMPTY_NAV }, reason: '' }); }}
        >
          + New NAV statement
        </button>
      </div>

      {editing && (
        <Card title={editing.id ? `Edit NAV statement #${editing.id}` : 'New NAV statement'}>
          {formError && (
            <div className="alertrow" style={{ marginBottom: 10, color: 'var(--red)' }}>{formError}</div>
          )}
          <FormGrid>
            <Field label="Fund position">
              <select
                value={editing.draft['fundInvestmentId'] ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, draft: { ...editing.draft, fundInvestmentId: e.target.value } })}
              >
                <option value="">Select…</option>
                {db.fundInvestments.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </Field>
            <Field label="As at">
              <input
                type="date"
                value={editing.draft['asOfDate'] ?? ''}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, asOfDate: e.target.value } })}
              />
            </Field>
            <Field label="NAV (CAD dollars)">
              <input
                type="text"
                inputMode="decimal"
                value={editing.draft['nav'] ?? ''}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, nav: e.target.value } })}
              />
            </Field>
            <Field label="Statement received" hint="When the GP's statement actually arrived.">
              <input
                type="date"
                value={editing.draft['statementReceivedAt'] ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, draft: { ...editing.draft, statementReceivedAt: e.target.value } })}
              />
            </Field>
            <Field label="Source document">
              <input
                type="text"
                value={editing.draft['sourceDocument'] ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, draft: { ...editing.draft, sourceDocument: e.target.value } })}
              />
            </Field>
            <ReasonField value={editing.reason} onChange={(reason) => setEditing({ ...editing, reason })} />
          </FormGrid>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={submit}>{editing.id ? 'Save changes' : 'Add statement'}</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </Card>
      )}

      <Card title="LP NAV statements" noBody>
        {error && <div className="cbody" style={{ color: 'var(--red)' }}>{error}</div>}
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>As at</th>
                <th>Fund</th>
                <th className="num">NAV</th>
                <th>Received</th>
                <th>Flags</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id} style={r.deletedAt ? { opacity: 0.55 } : undefined}>
                  <td className="mono">{r.asOfDate}</td>
                  <td>{r.fundName ?? r.fundInvestmentId}</td>
                  <td className="num mono">{money(r.nav)}</td>
                  <td className="mono">{r.statementReceivedAt ?? '—'}</td>
                  <td>
                    <RowFlags edited={r.edited} deleted={!!r.deletedAt} synthetic={r.isSynthetic} />
                  </td>
                  <td>
                    <RowActions
                      table="fund_investment_nav"
                      id={r.id}
                      deleted={!!r.deletedAt}
                      onEdit={() => {
                        setFormError(null);
                        setEditing({
                          id: r.id,
                          reason: '',
                          draft: {
                            fundInvestmentId: r.fundInvestmentId,
                            asOfDate: r.asOfDate,
                            nav: r.nav,
                            statementReceivedAt: r.statementReceivedAt ?? '',
                            sourceDocument: r.sourceDocument ?? '',
                          },
                        });
                      }}
                      onChanged={(m) => { setNotice(m); reload(); }}
                    />
                  </td>
                </tr>
              ))}
              {data?.rows.length === 0 && (
                <tr><td colSpan={6} className="hint">No NAV statements match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
