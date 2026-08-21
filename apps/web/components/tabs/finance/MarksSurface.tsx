'use client';

/**
 * The valuation mark register (A7, ADR-007, ADR-031).
 *
 * EVERY MARK, HOWEVER IT WAS PRODUCED — which is what makes this the register
 * rather than the review. Entry here is free-entry: historical backfill and the
 * exceptions that do not fit a retention factor (ADR-034 clause 7). The
 * semi-annual exercise runs on the FMV Review surface, which computes the figure
 * from the previous value instead of asking for an absolute.
 *
 * Entering a mark IS the sign-off (ADR-007). There is no second approval step,
 * and the preparer's name on the row is the record of who stood behind it.
 */
import { useCallback, useMemo, useState } from 'react';

import type { ValuationMarkRow } from '@portfolio-command/api';
import type { PortfolioExport } from '@portfolio-command/contract';

import { fetchMarks, money, mutate, retentionSentence } from '../../../lib/finance-api';
import { apiMessage } from '../../../lib/http';
import {
  Field,
  FormGrid,
  Notice,
  ReasonField,
  RowFlags,
  useDraft,
  useRowState,
  type Draft,
} from '../../entry';
import { Card, Pill } from '../../ui';
import { RowActions } from './RowActions';

const EMPTY_MARK: Draft = {
  companyId: '', effectiveDate: '', fmv: '', methodLabel: '', rationale: '', sourceDocument: '',
};

export function MarksSurface({ db }: { db: PortfolioExport }) {
  const [companyId, setCompanyId] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const form = useDraft(EMPTY_MARK);

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

  const editing = form.editing;

  const submit = async () => {
    if (!editing) return;
    form.setError(null);
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
      form.close();
      setNotice(result.restated ? 'Saved, and recorded as a restatement.' : 'Saved.');
      reload();
    } catch (e) {
      form.setError(apiMessage(e, 'Save failed.'));
    }
  };

  return (
    <>
      <Notice text={notice} onDismiss={() => setNotice(null)} />

      <div className="hint" style={{ marginBottom: 10 }}>
        The register: every mark, however it was produced. Marks are effective 31 January and 31
        July and are carried forward between exercises (ADR-007). Entering a mark <b>is</b> the
        sign-off — your name is recorded as the preparer.
        {' '}
        <b>The semi-annual exercise is run on the FMV Review tab</b>, which computes the figure from
        the previous value rather than asking for an absolute. Entry here is free-entry: historical
        backfill and the exceptions that do not fit a retention factor (ADR-034 clause 7).
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
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => form.create()}>
          + New mark
        </button>
      </div>

      {editing && (
        <Card title={editing.id ? `Edit mark #${editing.id}` : 'New valuation mark'}>
          {form.error && (
            <div className="alertrow" style={{ marginBottom: 10, color: 'var(--red)' }}>{form.error}</div>
          )}
          <FormGrid>
            <Field label="Company">
              <select {...form.field('companyId')}>
                <option value="">Select…</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Effective date" hint="The date the mark is 'as at'.">
              <input type="date" {...form.field('effectiveDate')} />
            </Field>
            <Field label="FMV (CAD dollars)" hint="Zero is valid — it is how a write-off is marked.">
              <input type="text" inputMode="decimal" {...form.field('fmv')} />
            </Field>
            <Field label="Method" hint="e.g. Last round price, Revenue multiple, DCF.">
              <input type="text" {...form.field('methodLabel')} />
            </Field>
            <Field label="Source document">
              <input type="text" {...form.field('sourceDocument')} />
            </Field>
            <ReasonField value={editing.reason} onChange={form.setReason} />
          </FormGrid>
          <div style={{ marginTop: 12 }}>
            <Field
              label="Rationale"
              hint="Required. This is what a board member or auditor reads when they challenge the number."
            >
              <textarea rows={3} {...form.field('rationale')} />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={submit}>{editing.id ? 'Save changes' : 'Add mark'}</button>
            <button className="btn ghost" onClick={form.close}>Cancel</button>
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
                <th>Adjustment</th>
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
                  {/* F2, ADR-034. What produced the figure. `legacy` on
                      everything written before the ledger existed, which is
                      most of this table and honestly so. */}
                  <td className="small">
                    {r.adjustmentType === 'review' && r.retentionFactor ? (
                      <>
                        {retentionSentence(r.retentionFactor)}
                        <div className="hint">on {money(r.basisFmv)}</div>
                        {/* Clause 3, surfaced. The basis is stored rather than
                            looked up so a later correction upstream becomes
                            visible here instead of silently invalidating this
                            row's arithmetic. Reported, never repaired — F6 owns
                            the reconciliation. */}
                        {r.basisFmvNow && r.basisFmvNow !== r.basisFmv && (
                          <Pill tone="red">Basis since corrected</Pill>
                        )}
                      </>
                    ) : (
                      <span className="hint">{r.adjustmentType}</span>
                    )}
                  </td>
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
                      onEdit={() => form.edit(r.id, {
                        companyId: r.companyId,
                        effectiveDate: r.effectiveDate,
                        fmv: r.fmv,
                        methodLabel: r.methodLabel,
                        rationale: r.rationale,
                        sourceDocument: r.sourceDocument ?? '',
                      })}
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
