'use client';

/**
 * Deal-close capture (A8, ADR-012).
 *
 * A TENTH TAB, and the same argument that justified the ninth: ADR-014 governs
 * the one-to-one port of the prototype, and the prototype has no data entry at
 * all. The eight ported tabs are untouched. Where the Finance tab records what
 * we paid, this one records the round we paid into — and ADR-012 is explicit
 * that the two have different authors.
 *
 * ROLE-GATED to `vc`, `finance` and `admin`, matching CAN_CAPTURE_ROUND. The
 * deal lead owns this at close; Finance keeps access because A13 loads
 * Finance's own historical rounds through the same path.
 *
 * THE FORM IS ONE FORM, NOT THREE, because ADR-012 says so and because the
 * failure mode of splitting it is silent: a round total saved without its
 * co-investors moves the leverage KPI and leaves the NB co-investment KPI
 * behind, and no screen would report the disagreement. One submit, one
 * transaction, three tables.
 *
 * WHY THIS SCREEN EXISTS AT ALL RATHER THAN JUST THE FORM. ADR-012's second
 * half is monitoring: "mandate metrics decay silently when the deal lead skips
 * a field at close." The dashboard tile says how much decay there is. This is
 * where you find out which rounds, and fix them.
 */
import { useCallback, useMemo, useState } from 'react';

import type {
  CompanyChequeRow,
  MandateCompleteness,
  ReferenceData,
  RoundPage,
  RoundRow,
} from '@portfolio-command/api';
import type { PortfolioExport } from '@portfolio-command/contract';

import { useApp } from '../AppShell';
import { Card, Kpi, KpiRow, Pill, ViewHeader } from '../ui';
import { Field, FormGrid, Notice, ReasonField, RowFlags, useRowState, type Draft } from '../entry';
import { money } from '../../lib/finance-api';
import {
  RoundsApiError,
  captureRound,
  fetchCompanyCheques,
  fetchCompleteness,
  fetchReference,
  fetchRounds,
  linkTransactions,
  pct,
} from '../../lib/rounds-api';

/** One co-investor line in the form. Kept as strings, like every other input. */
interface CoinvestorDraft {
  id: string | null;
  investorName: string;
  fundInvestmentId: string;
  isNbBased: boolean;
  amount: string;
}

const EMPTY_ROUND: Draft = {
  companyId: '', roundDate: '', label: '', instrumentId: '', investmentVehicleId: '',
  // ADR-033. Blank IS `unknown`, and the picker below says so rather than
  // leaving the reader to infer it from an empty select. Not defaulted to `yes`
  // on the theory that most rounds are ones we joined: the whole reason the
  // column has three states is that a guess and a fact must not look the same.
  nbifParticipated: '',
  roundTotal: '', nbOther: '', postMoney: '', ownershipAfterPct: '',
  leadInvestor: '', note: '', sourceDocument: '',
  ownershipAsOfDate: '', ownershipPct: '', proRataRights: '', fullyDiluted: 'yes',
};

interface Editing {
  id: string | null;
  draft: Draft;
  coinvestors: CoinvestorDraft[];
  reason: string;
}

export function DealCloseTab({ db }: { db: PortfolioExport }) {
  const { openDrawer } = useApp();

  const [companyId, setCompanyId] = useState('');
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(
    () => fetchRounds({
      ...(companyId ? { companyId } : {}),
      ...(incompleteOnly ? { incompleteOnly: 'true' } : {}),
      includeDeleted: String(includeDeleted),
      limit: '300',
    }),
    [companyId, incompleteOnly, includeDeleted],
  );
  const { data, error, reload, notice, setNotice } = useRowState<RoundPage>(load);

  // The reference lists never change during a session, so they are loaded once
  // and the fetch is not keyed on any filter.
  const loadReference = useCallback(() => fetchReference(), []);
  const { data: reference } = useRowState<ReferenceData>(loadReference);

  // Reloaded on the same tick as the table so the headline agrees with the rows
  // beneath it. A coverage figure a save has already invalidated is worse than
  // no coverage figure.
  const loadCoverage = useCallback(() => fetchCompleteness(), []);
  const { data: coverage, reload: reloadCoverage } = useRowState<MandateCompleteness>(loadCoverage);

  const companies = useMemo(
    () => [...db.companies].sort((a, b) => a.name.localeCompare(b.name)),
    [db.companies],
  );

  const openFor = (r: RoundRow | null) => {
    setFormError(null);
    if (!r) {
      setEditing({ id: null, draft: { ...EMPTY_ROUND }, coinvestors: [], reason: '' });
      return;
    }
    setEditing({
      id: r.id,
      reason: '',
      // Every column the update writes is round-tripped, whether or not the form
      // draws an input for it. The API takes a complete row rather than a patch,
      // and A7 learned the hard way what a form that omits a column does to one.
      draft: {
        companyId: r.companyId,
        roundDate: r.roundDate,
        label: r.label,
        instrumentId: r.instrumentId ? String(r.instrumentId) : '',
        investmentVehicleId: r.investmentVehicleId ? String(r.investmentVehicleId) : '',
        nbifParticipated: r.nbifParticipated,
        roundTotal: r.roundTotal ?? '',
        nbOther: r.nbOther ?? '',
        postMoney: r.postMoney ?? '',
        ownershipAfterPct: r.ownershipAfterPct ?? '',
        leadInvestor: r.leadInvestor ?? '',
        note: r.note ?? '',
        sourceDocument: r.sourceDocument ?? '',
        // The cap-table block is left blank on an edit rather than prefilled
        // from the round. company_ownership is a DATED position, keyed on
        // (company, as-of date); prefilling would invite an accidental
        // re-assertion of an old figure at a new date every time someone opened
        // a round to fix a typo.
        ownershipAsOfDate: '', ownershipPct: '', proRataRights: '', fullyDiluted: 'yes',
      },
      coinvestors: r.coinvestors.map((c) => ({
        id: c.id,
        investorName: c.investorName,
        fundInvestmentId: c.fundInvestmentId ?? '',
        isNbBased: c.isNbBased,
        amount: c.amount ?? '',
      })),
    });
  };

  const submit = async () => {
    if (!editing) return;
    setFormError(null);
    const d = editing.draft;
    try {
      const result = await captureRound({
        op: editing.id ? 'update' : 'create',
        ...(editing.id ? { id: editing.id } : {}),
        reason: editing.reason || null,
        values: {
          companyId: d['companyId'],
          roundDate: d['roundDate'],
          label: d['label'],
          instrumentId: d['instrumentId'] ? Number(d['instrumentId']) : null,
          investmentVehicleId: d['investmentVehicleId'] ? Number(d['investmentVehicleId']) : null,
          // Blank goes to the server as blank and lands as `unknown` there. The
          // form does not translate it, so there is one place that decides what
          // an unanswered question means.
          nbifParticipated: d['nbifParticipated'] || null,
          roundTotal: d['roundTotal'] || null,
          nbOther: d['nbOther'] || null,
          postMoney: d['postMoney'] || null,
          ownershipAfterPct: d['ownershipAfterPct'] || null,
          leadInvestor: d['leadInvestor'] || null,
          note: d['note'] || null,
          sourceDocument: d['sourceDocument'] || null,
          coinvestors: editing.coinvestors
            .filter((c) => c.investorName.trim() !== '')
            .map((c) => ({
              id: c.id,
              investorName: c.investorName,
              fundInvestmentId: c.fundInvestmentId || null,
              isNbBased: c.isNbBased,
              amount: c.amount || null,
            })),
          // Sent only when a date and a percentage are both present. A cap-table
          // position with no date is not a position.
          ownership:
            d['ownershipAsOfDate'] && d['ownershipPct']
              ? {
                  asOfDate: d['ownershipAsOfDate'],
                  ownershipPct: d['ownershipPct'],
                  proRataRights: d['proRataRights'] === 'yes',
                  fullyDiluted: d['fullyDiluted'] !== 'no',
                  sourceDocument: d['sourceDocument'] || null,
                }
              : null,
        },
      });
      setEditing(null);
      const co = result.coinvestors;
      const coSummary =
        co.created + co.updated + co.removed > 0
          ? ` Co-investors: ${co.created} added, ${co.updated} updated, ${co.removed} removed.`
          : '';
      setNotice(
        (result.restated
          ? 'Saved, and recorded as a restatement — this round falls inside a period already reported to the board.'
          : 'Saved.') +
          coSummary +
          (result.ownershipWritten ? ' Cap-table position recorded.' : ''),
      );
      reload();
      reloadCoverage();
    } catch (e) {
      setFormError(e instanceof RoundsApiError ? e.message : 'Save failed.');
    }
  };

  const rowAction = async (op: 'delete' | 'restore', id: string) => {
    let reason: string | null = 'Restored from the Deal Close tab';
    if (op === 'delete') {
      reason = window.prompt('Why is this round being deleted? This is recorded against your name.');
      if (!reason) return;
    }
    try {
      await captureRound({ op, id, reason });
      setNotice(op === 'delete' ? 'Deleted' : 'Restored');
      reload();
      reloadCoverage();
    } catch (e) {
      setNotice(e instanceof RoundsApiError ? e.message : `${op} failed`);
    }
  };

  return (
    <>
      <ViewHeader
        title="Deal Close"
        sub="Round total, co-investors, ownership and pro-rata rights — captured at close by the deal lead (ADR-012). These fields exist in no upstream system; the leverage and NB co-investment mandate KPIs are built entirely from them."
      />

      <Notice text={notice} onDismiss={() => setNotice(null)} />

      {/*
        The headline the dashboard tile also shows, repeated here because this is
        the screen where it can be acted on. `pctLeverageCoverage` is ADR-012's
        named measure: the share of rounds the leverage figure can see at all.
      */}
      <KpiRow>
        <Kpi
          label="Leverage Coverage"
          value={coverage?.pctLeverageCoverage != null ? `${coverage.pctLeverageCoverage}%` : '—'}
          sub={
            coverage
              ? `${coverage.roundsTotal - coverage.missingRoundTotal} of ${coverage.roundsTotal} rounds carry a total`
              : ''
          }
        />
        <Kpi
          label="Missing Round Total"
          valueClass={coverage && coverage.missingRoundTotal > 0 ? 'down' : undefined}
          value={coverage ? String(coverage.missingRoundTotal) : '—'}
          sub="Excluded from leverage, never imputed"
        />
        <Kpi
          label="Missing NB Co-Investment"
          value={coverage ? String(coverage.missingNbOther) : '—'}
          sub="Understates the NB mandate KPI"
        />
        <Kpi
          label="Missing Ownership"
          value={coverage ? String(coverage.missingOwnership) : '—'}
          sub="Feeds MOIC and the waterfall"
        />
        <Kpi
          label="Rounds"
          value={data ? String(data.total) : '—'}
          sub="Matching the filter"
        />
      </KpiRow>

      <div className="fbar">
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">All companies</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <input
            type="checkbox"
            checked={incompleteOnly}
            onChange={(e) => setIncompleteOnly(e.target.checked)}
          />
          Needs capture only
        </label>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          Show deleted
        </label>
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => openFor(null)}>
          + New round
        </button>
      </div>

      {editing && (
        <CaptureForm
          editing={editing}
          setEditing={setEditing}
          companies={companies}
          fundInvestments={db.fundInvestments}
          reference={reference}
          formError={formError}
          onSubmit={submit}
          onCancel={() => setEditing(null)}
          onLinked={(m) => { setNotice(m); reload(); }}
        />
      )}

      <Card title="Rounds" noBody>
        {error && <div className="cbody" style={{ color: 'var(--red)' }}>{error}</div>}
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Date</th>
                <th>Company</th>
                <th>Round</th>
                <th className="num">Our $</th>
                <th className="num">Round Total</th>
                <th className="num">NB Other</th>
                <th className="num">Own % After</th>
                <th>Co-Investors</th>
                <th>Flags</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id} style={r.deletedAt ? { opacity: 0.55 } : undefined}>
                  <td className="mono">{r.roundDate}</td>
                  <td>{r.companyName ?? r.companyId}</td>
                  <td>
                    <b>{r.label}</b>
                    <div className="hint">
                      {r.instrument ?? 'no instrument'}
                      {r.vehicleName ? ` · ${r.vehicleName}` : ''}
                    </div>
                  </td>
                  <td className="num mono">{money(r.ourInvested)}</td>
                  {/* A missing mandate field reads as missing, never as zero.
                      This is the D-5 discipline: an uncaptured round total and a
                      round total of nothing are different facts, and only one of
                      them is a chasing target. */}
                  <td className="num mono">
                    {r.roundTotal ? money(r.roundTotal) : <span className="down">not captured</span>}
                  </td>
                  <td className="num mono">
                    {r.nbOther ? money(r.nbOther) : <span className="hint">not captured</span>}
                  </td>
                  <td className="num mono">
                    {r.ownershipAfterPct ? pct(r.ownershipAfterPct) : <span className="hint">—</span>}
                  </td>
                  <td className="small">
                    {r.coinvestors.length === 0 ? (
                      <span className="hint">none listed</span>
                    ) : (
                      <>
                        {r.coinvestors.length}
                        {r.coinvestors.some((c) => c.isNbBased) && (
                          <span className="hint">
                            {' '}
                            ({r.coinvestors.filter((c) => c.isNbBased).length} NB
                            {r.coinvestorNbTotal ? ` ${money(r.coinvestorNbTotal)}` : ''})
                          </span>
                        )}
                        {r.coinvestors.some((c) => c.fundInvestmentId) && (
                          <div className="hint">
                            {r.coinvestors.filter((c) => c.fundInvestmentId).length} of our LP positions
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <RowFlags edited={r.edited} deleted={!!r.deletedAt} synthetic={r.isSynthetic} />
                    {/* ADR-012's exclusion rule, said out loud. The fund leverage
                        figure drops this round; the company drawer's per-round
                        ratio does not (INHERITED-COERCIONS §6), and a screen that
                        shows both should say which is which. */}
                    {r.excludedFromLeverage && <Pill tone="red">Total below our cheque</Pill>}
                    {!r.capturedAt && <Pill tone="yellow">Never captured</Pill>}
                    {/* F1. The three cases that used to read as one $0. Only
                        the third is a chasing target; the first is correct and
                        the second is a question nobody has answered. */}
                    {r.nbifParticipated === 'no' && <Pill tone="gray">We sat this one out</Pill>}
                    {r.nbifParticipated === 'unknown' && Number(r.ourInvested) === 0 && (
                      <Pill tone="yellow">Participation unknown</Pill>
                    )}
                    {r.nbifParticipated === 'yes' && Number(r.ourInvested) === 0 && (
                      <Pill tone="red">Cheque missing</Pill>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                      {!r.deletedAt && (
                        <button className="btn ghost sm" onClick={() => openFor(r)}>Edit</button>
                      )}
                      <button
                        className="btn ghost sm"
                        onClick={() =>
                          openDrawer({ kind: 'financial-history', table: 'investment_round', id: r.id })}
                      >
                        History
                      </button>
                      {r.deletedAt ? (
                        <button className="btn ghost sm" onClick={() => rowAction('restore', r.id)}>
                          Restore
                        </button>
                      ) : (
                        <button className="btn danger sm" onClick={() => rowAction('delete', r.id)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {data?.rows.length === 0 && (
                <tr><td colSpan={10} className="hint">No rounds match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// The capture form — ADR-012's "single deal-close form"
// ---------------------------------------------------------------------------

function CaptureForm({
  editing, setEditing, companies, fundInvestments, reference, formError, onSubmit, onCancel,
  onLinked,
}: {
  editing: Editing;
  setEditing: (e: Editing) => void;
  companies: PortfolioExport['companies'];
  fundInvestments: PortfolioExport['fundInvestments'];
  reference: ReferenceData | null;
  formError: string | null;
  onSubmit: () => void;
  onCancel: () => void;
  onLinked: (message: string) => void;
}) {
  const d = editing.draft;
  const set = (k: string, v: string) => setEditing({ ...editing, draft: { ...d, [k]: v } });

  const setCoinvestor = (i: number, patch: Partial<CoinvestorDraft>) =>
    setEditing({
      ...editing,
      coinvestors: editing.coinvestors.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    });

  /**
   * ADR-026 exact-name resolution, offered to the user rather than applied
   * behind them.
   *
   * The Affinity and A6 paths link a co-investor to an LP position on an EXACT
   * name match and leave the FK null otherwise — which is why the A6 dataset
   * seeds "Concrete Venture" against "Concrete Ventures" and correctly fails to
   * link it. Doing the same thing here means the deal lead gets the link for
   * free when the name is right, and the near-miss stays visible as a null
   * rather than being fuzzy-matched into a wrong mandate figure.
   */
  const suggestLink = (name: string): string => {
    const match = fundInvestments.find(
      (f) => f.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    return match ? match.id : '';
  };

  const addCoinvestor = () =>
    setEditing({
      ...editing,
      coinvestors: [
        ...editing.coinvestors,
        { id: null, investorName: '', fundInvestmentId: '', isNbBased: false, amount: '' },
      ],
    });

  const removeCoinvestor = (i: number) =>
    setEditing({ ...editing, coinvestors: editing.coinvestors.filter((_, j) => j !== i) });

  const nbSum = editing.coinvestors
    .filter((c) => c.isNbBased && c.amount)
    .reduce((a, c) => a + Number(c.amount), 0);

  return (
    <Card title={editing.id ? `Edit round #${editing.id}` : 'Capture a round'}>
      {formError && (
        <div className="alertrow" style={{ marginBottom: 10, color: 'var(--red)' }}>{formError}</div>
      )}

      <FormGrid>
        <Field label="Company">
          <select value={d['companyId'] ?? ''} onChange={(e) => set('companyId', e.target.value)}>
            <option value="">Select…</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Round date">
          <input type="date" value={d['roundDate'] ?? ''} onChange={(e) => set('roundDate', e.target.value)} />
        </Field>
        <Field label="Round" hint="Seed, Series A, Bridge — whatever the closing documents call it.">
          <input type="text" value={d['label'] ?? ''} onChange={(e) => set('label', e.target.value)} />
        </Field>
        <Field label="Instrument">
          <select value={d['instrumentId'] ?? ''} onChange={(e) => set('instrumentId', e.target.value)}>
            <option value="">Select…</option>
            {(reference?.instruments ?? []).map((i) => (
              <option key={i.id} value={String(i.id)}>{i.name}</option>
            ))}
          </select>
        </Field>
        {/* ADR-030. Null is "unrecorded", never a default — two roster companies
            genuinely have no vehicle attribution and a guess would invent one. */}
        <Field label="Investment vehicle" hint="Which vehicle our participation came from. Leave blank if unrecorded.">
          <select
            value={d['investmentVehicleId'] ?? ''}
            onChange={(e) => set('investmentVehicleId', e.target.value)}
          >
            <option value="">Not recorded</option>
            {(reference?.investmentVehicles ?? []).map((v) => (
              <option key={v.id} value={String(v.id)}>{v.code} — {v.name}</option>
            ))}
          </select>
        </Field>
        {/* ADR-033. The round is an event in the COMPANY'S life, not ours — a
            Series B happens whether or not we write a cheque. This is the field
            that makes "a round with no transaction" legible: legitimate when we
            sat it out, a data error when we did not. `no` takes the round out
            of the leverage figure, because a round we did not join contributes
            capital attracted with no cost of ours to match it. */}
        <Field
          label="Did NBIF participate?"
          hint="A round we sat out still moves ownership and FMV, so it still belongs here. Leave it unanswered if you do not know — unknown is a real answer and is not counted as no."
        >
          <select
            value={d['nbifParticipated'] ?? ''}
            onChange={(e) => set('nbifParticipated', e.target.value)}
          >
            <option value="">Unknown — not established</option>
            <option value="yes">Yes — we invested in this round</option>
            <option value="no">No — we did not participate</option>
          </select>
        </Field>
        <Field
          label="Round total (CAD dollars)"
          hint="The WHOLE round, every investor, including our cheque. Drives the leverage KPI. Leave blank if unknown — a blank is excluded, a guess is not."
        >
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={d['roundTotal'] ?? ''}
            onChange={(e) => set('roundTotal', e.target.value)}
          />
        </Field>
        <Field
          label="NB co-investment (CAD dollars)"
          hint="Capital from OTHER New Brunswick investors in this round, excluding ours. Drives the NB mandate KPI."
        >
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={d['nbOther'] ?? ''}
            onChange={(e) => set('nbOther', e.target.value)}
          />
        </Field>
        <Field label="Post-money (CAD dollars)" hint="Blank on a convertible note, and legitimately so.">
          <input
            type="text"
            inputMode="decimal"
            value={d['postMoney'] ?? ''}
            onChange={(e) => set('postMoney', e.target.value)}
          />
        </Field>
        <Field label="Ownership after (%)" hint="11.2 means 11.2%, not 0.112.">
          <input
            type="text"
            inputMode="decimal"
            value={d['ownershipAfterPct'] ?? ''}
            onChange={(e) => set('ownershipAfterPct', e.target.value)}
          />
        </Field>
        <Field label="Lead investor">
          <input type="text" value={d['leadInvestor'] ?? ''} onChange={(e) => set('leadInvestor', e.target.value)} />
        </Field>
        <Field label="Source document" hint="The SharePoint link to the closing documents. It stays the source of record.">
          <input
            type="text"
            value={d['sourceDocument'] ?? ''}
            onChange={(e) => set('sourceDocument', e.target.value)}
          />
        </Field>
        <Field label="Note">
          <input type="text" value={d['note'] ?? ''} onChange={(e) => set('note', e.target.value)} />
        </Field>
      </FormGrid>

      {/* --- co-investors ------------------------------------------------- */}
      <div className="vsub" style={{ margin: '16px 0 6px', fontWeight: 700, color: 'var(--slate)' }}>
        CO-INVESTORS
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        Recorded one by one rather than as a total, so capital-to-direct and co-invests-done are derived
        rather than hand-maintained on the LP position (ADR-002). An amount is optional — a name with no
        figure is more than nothing, and older rounds often have exactly that.
      </div>

      <div className="tblwrap">
        <table className="dt">
          <thead>
            <tr>
              <th>Investor</th>
              <th>One of our LP positions</th>
              <th>NB-based</th>
              <th className="num">Amount (CAD)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {editing.coinvestors.map((c, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="text"
                    style={{ width: '100%' }}
                    value={c.investorName}
                    onChange={(e) => {
                      const investorName = e.target.value;
                      // Only ever fills a blank link; never overwrites a choice
                      // the user has already made.
                      const suggested = c.fundInvestmentId || suggestLink(investorName);
                      setCoinvestor(i, { investorName, fundInvestmentId: suggested });
                    }}
                  />
                </td>
                <td>
                  <select
                    style={{ width: '100%' }}
                    value={c.fundInvestmentId}
                    onChange={(e) => setCoinvestor(i, { fundInvestmentId: e.target.value })}
                  >
                    <option value="">Not one of ours</option>
                    {fundInvestments.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={c.isNbBased}
                    onChange={(e) => setCoinvestor(i, { isNbBased: e.target.checked })}
                  />
                </td>
                <td className="num">
                  <input
                    type="text"
                    inputMode="decimal"
                    style={{ width: '100%', textAlign: 'right' }}
                    value={c.amount}
                    onChange={(e) => setCoinvestor(i, { amount: e.target.value })}
                  />
                </td>
                <td>
                  <button className="btn ghost sm" onClick={() => removeCoinvestor(i)}>Remove</button>
                </td>
              </tr>
            ))}
            {editing.coinvestors.length === 0 && (
              <tr><td colSpan={5} className="hint">No co-investors listed for this round.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="btn ghost sm" onClick={addCoinvestor}>+ Add co-investor</button>
        {/*
          The two NB figures are shown side by side and never reconciled for the
          user. The mandate KPI sums `nb_other`; these lines are a separate
          capture that is often partial. A screen that quietly made them agree
          would be choosing which of two facts to destroy.
        */}
        {nbSum > 0 && d['nbOther'] && Math.abs(nbSum - Number(d['nbOther'])) > 0.5 && (
          <span className="hint">
            NB co-investors listed here total {money(String(nbSum))}, against{' '}
            {money(d['nbOther'])} in the NB co-investment field. Both are kept — the mandate KPI
            uses the field, and named amounts are often only part of the round.
          </span>
        )}
      </div>

      {/* --- cheques in this round (ADR-033, F1) -------------------------- */}
      <RoundCheques editing={editing} onLinked={onLinked} />

      {/* --- cap-table position ------------------------------------------- */}
      <div className="vsub" style={{ margin: '16px 0 6px', fontWeight: 700, color: 'var(--slate)' }}>
        CAP-TABLE POSITION AFTER THIS ROUND
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        Optional, and dated. Leave it blank if the cap table has not been restated yet — a guess typed
        into a mandate field is worse than a gap. Recorded against the date, so MOIC and the waterfall
        stay as-of correct (ADR-012).
      </div>
      <FormGrid>
        <Field label="As at">
          <input
            type="date"
            value={d['ownershipAsOfDate'] ?? ''}
            onChange={(e) => set('ownershipAsOfDate', e.target.value)}
          />
        </Field>
        <Field label="Ownership (%)">
          <input
            type="text"
            inputMode="decimal"
            value={d['ownershipPct'] ?? ''}
            onChange={(e) => set('ownershipPct', e.target.value)}
          />
        </Field>
        <Field label="Pro-rata rights">
          <select value={d['proRataRights'] ?? ''} onChange={(e) => set('proRataRights', e.target.value)}>
            <option value="">No</option>
            <option value="yes">Yes</option>
          </select>
        </Field>
        <Field label="Fully diluted">
          <select value={d['fullyDiluted'] ?? 'yes'} onChange={(e) => set('fullyDiluted', e.target.value)}>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
        <ReasonField value={editing.reason} onChange={(reason) => setEditing({ ...editing, reason })} />
      </FormGrid>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={onSubmit}>
          {editing.id ? 'Save changes' : 'Capture round'}
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cheques in this round — ADR-033's second surface
// ---------------------------------------------------------------------------

/**
 * The cheque-to-round link, from the deal lead's side.
 *
 * WHY IT IS HERE AS WELL AS ON THE FINANCE TAB. ADR-033 clause 5 says the link
 * is writable from both surfaces through one mutation, and the reason is that
 * the two people who know the answer sit on opposite sides of the ADR-005 role
 * split. Finance books the wire and knows the amount; the deal lead holds the
 * closing documents and knows which round it funded. Before F1 neither could
 * record it: the Finance tab drew the field read-only and pointed here, and this
 * tab did not write `transaction` at all (finding S-1).
 *
 * `vc` REACHES THIS SCREEN AND NOT THE FINANCE TAB, which is the practical form
 * of the same point. This section is the only place a deal lead can attach their
 * own cheque, and it works because `link-transactions` moves a foreign key and
 * nothing else.
 *
 * IT SHOWS CHEQUES ALREADY ON ANOTHER ROUND, deliberately. Moving one from the
 * wrong round to the right one is the more common correction — every link in the
 * database was written by a generator, and the A6 dataset seeds one booked
 * against another company's round on purpose. A list of only unattached cheques
 * would make the wrong-round case the one thing this screen cannot fix.
 *
 * ONLY ONCE THE ROUND EXISTS. There is nothing to attach a cheque to until the
 * capture has been saved, and a control that silently queued the link until then
 * would be a second, invisible write path.
 */
function RoundCheques({
  editing, onLinked,
}: {
  editing: Editing;
  onLinked: (message: string) => void;
}) {
  const roundId = editing.id;
  const companyId = editing.draft['companyId'] ?? '';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () => (companyId ? fetchCompanyCheques(companyId) : Promise.resolve({ rows: [] })),
    [companyId],
  );
  const { data, reload } = useRowState<{ rows: CompanyChequeRow[] }>(load);

  const apply = async (transactionId: string, target: string | null, verb: string) => {
    setError(null);
    setBusy(transactionId);
    try {
      const result = await linkTransactions({
        transactionIds: [transactionId],
        investmentRoundId: target,
        reason: editing.reason || null,
      });
      reload();
      onLinked(
        `${verb}.` +
          (result.participationSetToYes ? ' This round now records that we participated.' : '') +
          (result.restated
            ? ' Recorded as a restatement: it falls inside a period already reported to the board.'
            : ''),
      );
    } catch (e) {
      setError(e instanceof RoundsApiError ? e.message : 'Could not change the round link.');
    } finally {
      setBusy(null);
    }
  };

  const rows = data?.rows ?? [];
  const mine = rows.filter((r) => r.investmentRoundId === roundId);
  const others = rows.filter((r) => r.investmentRoundId !== roundId);

  return (
    <>
      <div className="vsub" style={{ margin: '16px 0 6px', fontWeight: 700, color: 'var(--slate)' }}>
        CHEQUES IN THIS ROUND
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        Our own money in this round, summed from the transactions Finance has booked. Attaching a
        cheque here is a reconciliation, not a change to Finance&rsquo;s figures — it moves the link
        and nothing else, and it is recorded against your name (ADR-033).
      </div>

      {!roundId && (
        <div className="hint" style={{ marginBottom: 8 }}>
          Save the round first. There is nothing to attach a cheque to until it exists.
        </div>
      )}
      {error && (
        <div className="alertrow" style={{ marginBottom: 8, color: 'var(--red)' }}>{error}</div>
      )}

      {roundId && (
        <div className="tblwrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Amount</th>
                <th>Currently</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mine.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.txnDate}</td>
                  <td className="num mono">
                    {money(c.amountCad)}
                    {c.currency !== 'CAD' && <span className="hint"> {c.currency}</span>}
                  </td>
                  <td className="small">In this round</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn ghost sm"
                      disabled={busy === c.id}
                      onClick={() => apply(c.id, null, 'Detached, and recorded as standalone')}
                    >
                      Detach
                    </button>
                  </td>
                </tr>
              ))}
              {others.map((c) => (
                <tr key={c.id} style={{ opacity: 0.75 }}>
                  <td className="mono">{c.txnDate}</td>
                  <td className="num mono">
                    {money(c.amountCad)}
                    {c.currency !== 'CAD' && <span className="hint"> {c.currency}</span>}
                  </td>
                  {/* Three states, said plainly. Only the last is a chasing
                      target, and before F1 all three read as an absence. */}
                  <td className="small">
                    {c.roundLabel ? (
                      <>
                        {c.roundLabel} <span className="hint">({c.roundDate})</span>
                      </>
                    ) : c.standaloneConfirmedAt ? (
                      <span className="hint">
                        Standalone
                        {c.standaloneConfirmedByName ? ` · ${c.standaloneConfirmedByName}` : ''}
                      </span>
                    ) : (
                      <Pill tone="yellow">Not linked</Pill>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn ghost sm"
                      disabled={busy === c.id}
                      onClick={() =>
                        apply(
                          c.id,
                          roundId,
                          c.roundLabel
                            ? `Moved from ${c.roundLabel} to this round`
                            : 'Attached to this round',
                        )}
                    >
                      {c.roundLabel ? 'Move here' : 'Attach'}
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="hint">
                    Finance has booked no cheques against this company yet. A round can be captured
                    before the wire clears — the two records have different authors on different
                    clocks, and neither waits for the other (ADR-033).
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
