'use client';

/**
 * LP activity — the three-stage model (F5, FR-32, ADR-037).
 *
 * Commitment, drawdown, distribution. Two of the three were always here and the
 * middle one is a transaction, so this surface holds the stage that was missing
 * (commitments) and the GP statements that value it, and points at the
 * Transactions surface for the movements themselves.
 *
 * COMMITMENTS COME FIRST because they come first: a drawdown is a draw against a
 * commitment already made, and the ledger reads top-down in the order the money
 * actually moves.
 */
import { useCallback, useState } from 'react';

import type { FundCommitmentRow, LpNavRow } from '@portfolio-command/api';
import type { PortfolioExport } from '@portfolio-command/contract';

import {
  fetchCommitments,
  fetchLpNav,
  money,
  mutate,
  type MutationResult,
} from '../../../lib/finance-api';
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

const EMPTY_NAV: Draft = {
  fundInvestmentId: '', asOfDate: '', nav: '', statementReceivedAt: '', sourceDocument: '',
};

const EMPTY_COMMITMENT: Draft = {
  fundInvestmentId: '', asOfDate: '', committed: '', changeReason: '', sourceDocument: '',
};

export function LpSurface({ db }: { db: PortfolioExport }) {
  /* One filter over both sections. They are two halves of one position's
     record, and a screen that made you set the fund twice would be a screen
     where the two halves can silently disagree about which fund you are
     looking at. */
  const [fundInvestmentId, setFundInvestmentId] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);

  return (
    <>
      <div className="fbar">
        <select value={fundInvestmentId} onChange={(e) => setFundInvestmentId(e.target.value)}>
          <option value="">All fund positions</option>
          {db.fundInvestments.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
          Show deleted
        </label>
      </div>

      <CommitmentsSection
        db={db}
        fundInvestmentId={fundInvestmentId}
        includeDeleted={includeDeleted}
      />
      <LpNavSection
        db={db}
        fundInvestmentId={fundInvestmentId}
        includeDeleted={includeDeleted}
      />
    </>
  );
}

/**
 * Committed Capital, as a dated ledger (F5, S-7, ADR-037).
 *
 * THE ONE THING THIS SCREEN HAS TO GET ACROSS: each row is the LEVEL in force
 * from its date, not the change. A raise from $500,000 to $750,000 is a row
 * reading $750,000. Every other reading of "adjustment" produces a ledger that
 * has to be added up, and ADR-037 clause 1 chose an absolute precisely so that
 * nobody ever has to.
 */
function CommitmentsSection({
  db,
  fundInvestmentId,
  includeDeleted,
}: {
  db: PortfolioExport;
  fundInvestmentId: string;
  includeDeleted: boolean;
}) {
  const form = useDraft(EMPTY_COMMITMENT);

  const load = useCallback(
    () => fetchCommitments({
      ...(fundInvestmentId ? { fundInvestmentId } : {}),
      includeDeleted: String(includeDeleted),
    }),
    [fundInvestmentId, includeDeleted],
  );
  const { data, error, reload, notice, setNotice } = useRowState<{ rows: FundCommitmentRow[] }>(load);

  const editing = form.editing;

  const submit = async () => {
    if (!editing) return;
    form.setError(null);
    const d = editing.draft;
    try {
      const result = await mutate({
        table: 'fund_commitment',
        op: editing.id ? 'update' : 'create',
        ...(editing.id ? { id: editing.id } : {}),
        reason: editing.reason || null,
        values: {
          fundInvestmentId: d['fundInvestmentId'],
          asOfDate: d['asOfDate'],
          committed: d['committed'],
          changeReason: d['changeReason'],
          sourceDocument: d['sourceDocument'] || null,
        },
      });
      form.close();
      /* ADR-037 clause 5. The write SUCCEEDED. Said as a fact about the
         position rather than as an error about the entry, because it is one --
         and lowering a commitment below what has already been drawn is a
         legitimate thing to record. */
      setNotice(
        [
          result.restated ? 'Saved, and recorded as a restatement.' : 'Saved.',
          result.overdrawn
            ? `Note: ${overdrawnSentence(result.overdrawn, db)}`
            : '',
        ].filter(Boolean).join(' '),
      );
      reload();
    } catch (e) {
      form.setError(apiMessage(e, 'Save failed.'));
    }
  };

  return (
    <>
      <Notice text={notice} onDismiss={() => setNotice(null)} />

      <div className="hint" style={{ marginBottom: 10 }}>
        <b>Committed Capital.</b> Each row is the commitment <b>in force from its date</b>, not the
        change — a raise from $500,000 to $750,000 is a row reading $750,000. A commitment is
        adjustable, so an increase at a second close or under a side letter is a new dated row and
        the earlier level stays readable at its own date.
      </div>

      <div className="fbar">
        <button
          className="btn sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => form.create(fundInvestmentId ? { fundInvestmentId } : undefined)}
        >
          + New commitment level
        </button>
      </div>

      {editing && (
        <Card title={editing.id ? `Edit commitment #${editing.id}` : 'New commitment level'}>
          {form.error && (
            <div className="alertrow" style={{ marginBottom: 10, color: 'var(--red)' }}>{form.error}</div>
          )}
          <FormGrid>
            <Field label="Fund position">
              <select {...form.field('fundInvestmentId')}>
                <option value="">Select…</option>
                {db.fundInvestments.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </Field>
            <Field label="In force from" hint="The date this level took effect, not the date you are entering it.">
              <input type="date" {...form.field('asOfDate')} />
            </Field>
            <Field
              label="Committed Capital (CAD dollars)"
              hint="The whole commitment at this date, not the increase."
            >
              <input type="text" inputMode="decimal" {...form.field('committed')} />
            </Field>
            <Field
              label="What set this level"
              hint="The subscription, a second close, a side letter, an amended LPA. Required."
            >
              <input type="text" {...form.field('changeReason')} />
            </Field>
            <Field label="Source document">
              <input type="text" {...form.field('sourceDocument')} />
            </Field>
            <ReasonField value={editing.reason} onChange={form.setReason} />
          </FormGrid>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={submit}>{editing.id ? 'Save changes' : 'Add commitment'}</button>
            <button className="btn ghost" onClick={form.close}>Cancel</button>
          </div>
        </Card>
      )}

      <Card title="Committed Capital" noBody>
        {error && <div className="cbody" style={{ color: 'var(--red)' }}>{error}</div>}
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>In force from</th>
                <th>Fund</th>
                <th className="num">Committed Capital</th>
                <th>What set it</th>
                <th>Flags</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id} style={r.deletedAt ? { opacity: 0.55 } : undefined}>
                  <td className="mono">{r.asOfDate}</td>
                  <td>{r.fundName ?? r.fundInvestmentId}</td>
                  <td className="num mono">{money(r.committed)}</td>
                  <td className="small">{r.changeReason ?? '—'}</td>
                  <td>
                    {/* "Current" is the row `fund_committed_asof` would return
                        today. Shown because a superseded level and a
                        future-dated one look identical in a date column, and
                        only one of the three is the figure on the Funds tab. */}
                    {r.inForce && !r.deletedAt && <Pill tone="green">Current</Pill>}
                    <RowFlags edited={r.edited} deleted={!!r.deletedAt} synthetic={r.isSynthetic} />
                  </td>
                  <td>
                    <RowActions
                      table="fund_commitment"
                      id={r.id}
                      deleted={!!r.deletedAt}
                      onEdit={() => form.edit(r.id, {
                        fundInvestmentId: r.fundInvestmentId,
                        asOfDate: r.asOfDate,
                        committed: r.committed,
                        changeReason: r.changeReason ?? '',
                        sourceDocument: r.sourceDocument ?? '',
                      })}
                      onChanged={(m) => { setNotice(m); reload(); }}
                    />
                  </td>
                </tr>
              ))}
              {data?.rows.length === 0 && (
                <tr><td colSpan={6} className="hint">No commitments match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/**
 * ADR-037 clause 5, put into a sentence somebody can act on.
 *
 * Names the position, both figures and the gap, because "overdrawn" on its own
 * sends the reader back to the ledger to work out by how much — and the two
 * figures are what tells them whether it is a keying error or a side letter
 * nobody has entered yet.
 */
function overdrawnSentence(
  o: NonNullable<MutationResult['overdrawn']>,
  db: PortfolioExport,
): string {
  const name = db.fundInvestments.find((f) => f.id === o.fundInvestmentId)?.name ?? o.fundInvestmentId;
  if (o.committed === null) {
    return `${name} has ${money(o.drawn)} drawn against no commitment on record.`;
  }
  const over = (Number(o.drawn) - Number(o.committed)).toFixed(2);
  return (
    `${name} is now drawn beyond its commitment — ${money(o.drawn)} against ` +
    `${money(o.committed)}, over by ${money(over)}. Recorded as entered.`
  );
}

function LpNavSection({
  db,
  fundInvestmentId,
  includeDeleted,
}: {
  db: PortfolioExport;
  fundInvestmentId: string;
  includeDeleted: boolean;
}) {
  const form = useDraft(EMPTY_NAV);

  const load = useCallback(
    () => fetchLpNav({
      ...(fundInvestmentId ? { fundInvestmentId } : {}),
      includeDeleted: String(includeDeleted),
    }),
    [fundInvestmentId, includeDeleted],
  );
  const { data, error, reload, notice, setNotice } = useRowState<{ rows: LpNavRow[] }>(load);

  const editing = form.editing;

  const submit = async () => {
    if (!editing) return;
    form.setError(null);
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

      <div className="hint" style={{ marginBottom: 10, marginTop: 18 }}>
        GP capital-account statements. Capital drawdowns, capital distributions and fees are entered
        on the Transactions surface against a fund position; this is the NAV the GP reports, which
        typically lags a quarter — the gap between the as-at date and the receipt date is what makes
        that visible.
      </div>

      <div className="fbar">
        <button
          className="btn sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => form.create(fundInvestmentId ? { fundInvestmentId } : undefined)}
        >
          + New NAV statement
        </button>
      </div>

      {editing && (
        <Card title={editing.id ? `Edit NAV statement #${editing.id}` : 'New NAV statement'}>
          {form.error && (
            <div className="alertrow" style={{ marginBottom: 10, color: 'var(--red)' }}>{form.error}</div>
          )}
          <FormGrid>
            <Field label="Fund position">
              <select {...form.field('fundInvestmentId')}>
                <option value="">Select…</option>
                {db.fundInvestments.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </Field>
            <Field label="As at">
              <input type="date" {...form.field('asOfDate')} />
            </Field>
            <Field label="NAV (CAD dollars)">
              <input type="text" inputMode="decimal" {...form.field('nav')} />
            </Field>
            <Field label="Statement received" hint="When the GP's statement actually arrived.">
              <input type="date" {...form.field('statementReceivedAt')} />
            </Field>
            <Field label="Source document">
              <input type="text" {...form.field('sourceDocument')} />
            </Field>
            <ReasonField value={editing.reason} onChange={form.setReason} />
          </FormGrid>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={submit}>{editing.id ? 'Save changes' : 'Add statement'}</button>
            <button className="btn ghost" onClick={form.close}>Cancel</button>
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
                      onEdit={() => form.edit(r.id, {
                        fundInvestmentId: r.fundInvestmentId,
                        asOfDate: r.asOfDate,
                        nav: r.nav,
                        statementReceivedAt: r.statementReceivedAt ?? '',
                        sourceDocument: r.sourceDocument ?? '',
                      })}
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
