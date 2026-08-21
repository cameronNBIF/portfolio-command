'use client';

/**
 * Exited: who has left the portfolio, and what we recorded when they did
 * (F4, FR-29, FR-28, FR-30, ADR-036).
 *
 * TWO GROUPS, BECAUSE THERE ARE TWO FACTS WITH TWO OWNERS. The roster status is
 * the VC team's, maintained in Affinity. The exit event is Finance's, recorded
 * here. They will usually agree, and ADR-036 clause 2 is explicit that they do
 * not have to agree at every instant: Finance may book a write-off in March
 * while Affinity is updated in June. A platform-side "exited" flag would have
 * hidden that by making one of them win. This screen shows it instead.
 *
 * THE SENTENCE THIS SCREEN HAS TO SAY OUT LOUD is that recording an exit does
 * not move a company between views. It is the first thing anyone will expect it
 * to do, and it is the one thing it deliberately does not: membership is
 * Affinity's, the sync is one-way, and an exited flag maintained in two places
 * would have the nightly sync silently winning the argument (ADR-032's lesson,
 * not re-learned).
 *
 * AN ADDITION, NOT A CHANGE TO THE PORTED EIGHT (ADR-014). The Portfolio tab
 * keeps its own *active / include exited / exited only* control exactly as the
 * prototype had it. What is here is the exit as an EVENT, which the prototype
 * has no concept of anywhere.
 */
import { useCallback, useState } from 'react';

import type { ExitedView, ExitRow } from '@portfolio-command/api';
import type { PortfolioExport } from '@portfolio-command/contract';

import { fetchExitedView, recordExit, removeExit } from '../../lib/exits-api';
import { money } from '../../lib/finance-api';
import { todayISO } from '../../lib/policies-api';
import { apiMessage } from '../../lib/http';
import { useApp } from '../AppShell';
import { Field, FormGrid, Notice, useRowState } from '../entry';
import { Card, ConventionNote, Kpi, KpiRow, Pill, ViewHeader } from '../ui';

const CAN_RECORD = ['finance', 'admin'];

export function ExitedTab({ db }: { db: PortfolioExport }) {
  const { role, openCompany, toast } = useApp();
  const [asOf, setAsOf] = useState(todayISO);
  const [entryFor, setEntryFor] = useState<string | null>(null);

  const load = useCallback(() => fetchExitedView(asOf), [asOf]);
  const { data, error, reload, notice, setNotice } = useRowState<ExitedView>(load);

  const mayRecord = CAN_RECORD.includes(role);
  const exited = data?.exited ?? [];
  const mismatched = data?.recordedNotOnRoster ?? [];

  const realized = exited.reduce((a, r) => a + Number(r.realized), 0);
  const invested = exited.reduce((a, r) => a + Number(r.invested), 0);
  const unrecorded = exited.filter((r) => r.exitDate === null).length;

  const table = (rows: ExitRow[], showRoster: boolean) => (
    <div className="tblwrap">
      <table className="dt">
        <thead>
          <tr>
            <th>Company</th>
            {showRoster && <th>Roster</th>}
            <th>Exit date</th>
            <th>Type</th>
            <th className="num">Invested</th>
            <th className="num">Realized</th>
            <th>Recorded by</th>
            {mayRecord && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.companyId}>
              <td>
                <a className="link" onClick={() => openCompany(r.companyId)}>{r.companyName}</a>
                {r.writtenOff && <> <Pill tone="gray">written off</Pill></>}
              </td>
              {showRoster && (
                <td className="small">
                  {r.rosterStatus ?? <span className="flat">not synced</span>}
                </td>
              )}
              <td className="small">
                {r.exitDate ?? <Pill tone="yellow">no exit event recorded</Pill>}
              </td>
              <td className="small">{r.exitType ?? '—'}</td>
              <td className="num">{money(r.invested)}</td>
              <td className="num">{money(r.realized)}</td>
              <td className="small">{r.recordedBy ?? '—'}</td>
              {mayRecord && (
                <td>
                  <button className="btn small" onClick={() => setEntryFor(r.companyId)}>
                    {r.exitDate === null ? 'Record' : 'Edit'}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <ViewHeader
        title="Exited"
        sub={`${exited.length} companies off the roster - as at ${asOf}`}
      />

      <Notice text={notice} onDismiss={() => setNotice(null)} />

      <ConventionNote>
        Membership follows <b>Affinity&rsquo;s Status field</b>, which the VC team maintains and the
        nightly sync reads. Recording an exit here records the <b>economic event</b> — it does not
        move a company between the Portfolio and Exited views, and it is not meant to. A company
        winding down with a zero FMV is still a portfolio company until Affinity says otherwise.
      </ConventionNote>

      <KpiRow>
        <Kpi label="Exited" value={String(exited.length)} sub={`As at ${asOf}`} />
        <Kpi label="Invested In Exits" value={money(String(invested))} sub="Cumulative cost" />
        <Kpi label="Realized" value={money(String(realized))} sub="Proceeds recorded against them" />
        <Kpi
          label="Exit Event Missing"
          valueClass={unrecorded > 0 ? 'down' : undefined}
          value={String(unrecorded)}
          sub="Off the roster, nothing recorded"
        />
      </KpiRow>

      <div className="fbar">
        <Field label="As at" hint="Invested, FMV and realized are read at this date.">
          <input type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); setEntryFor(null); }} />
        </Field>
      </div>

      {error && <div className="card"><div className="cbody" style={{ color: 'var(--red)' }}>{error}</div></div>}

      {entryFor && data && (
        <ExitEntry
          companyId={entryFor}
          companyName={
            db.companies.find((c) => c.id === entryFor)?.name ??
            [...exited, ...mismatched].find((r) => r.companyId === entryFor)?.companyName ??
            entryFor
          }
          existing={[...exited, ...mismatched].find((r) => r.companyId === entryFor) ?? null}
          exitTypes={data.exitTypes}
          onClose={() => setEntryFor(null)}
          onSaved={(m) => { setNotice(m); toast('Exit event saved.'); setEntryFor(null); reload(); }}
        />
      )}

      <Card title="Off the roster" headerExtra={<Pill tone="purple">{exited.length}</Pill>} noBody>
        <div className="cbody" style={{ paddingBottom: 0 }}>
          <ConventionNote>
            Affinity&rsquo;s Status reads <span className="mono">Exited</span>. A row with no exit event
            is not an error — it is Finance&rsquo;s half of the record, not yet written.
          </ConventionNote>
        </div>
        {exited.length === 0 ? <div className="cbody small">None.</div> : table(exited, false)}
      </Card>

      {mismatched.length > 0 && (
        <Card
          title="Exit recorded, still on the roster"
          headerExtra={<Pill tone="yellow">{mismatched.length}</Pill>}
          noBody
        >
          <div className="cbody" style={{ paddingBottom: 0 }}>
            <ConventionNote>
              Finance has recorded the event and Affinity still calls these portfolio companies.
              Expected for a period — the write-off is booked before someone updates the roster —
              and worth clearing once the sale or wind-up is final. Changing it is a change in
              <b> Affinity</b>, not here.
            </ConventionNote>
          </div>
          {table(mismatched, true)}
        </Card>
      )}

      {mayRecord && !entryFor && (
        <Card title="Record an exit">
          <ConventionNote>
            For a company on neither list — a position realized or written off before Affinity has
            been updated. The company stays in the Portfolio view until its roster status changes.
          </ConventionNote>
          <Field label="Company" hint="Any company on the roster.">
            <select value="" onChange={(e) => e.target.value && setEntryFor(e.target.value)}>
              <option value="">Choose a company…</option>
              {[...db.companies]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>
          </Field>
        </Card>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

function ExitEntry({
  companyId,
  companyName,
  existing,
  exitTypes,
  onClose,
  onSaved,
}: {
  companyId: string;
  companyName: string;
  existing: ExitRow | null;
  exitTypes: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [exitDate, setExitDate] = useState(existing?.exitDate ?? todayISO());
  const [exitType, setExitType] = useState(existing?.exitType ?? exitTypes[0] ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (what: () => Promise<{ stillOnRoster: boolean; replacedExisting: boolean }>, verb: string) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await what();
      onSaved(
        `${verb} for ${companyName}.` +
          (result.stillOnRoster
            ? ' Affinity still lists this company as a portfolio company, so it stays in the Portfolio view until the roster changes.'
            : ''),
      );
    } catch (err) {
      setFailure(apiMessage(err, 'Something went wrong.'));
      setBusy(false);
    }
  };

  return (
    <Card
      title={`Exit event — ${companyName}`}
      headerExtra={<button className="btn ghost sm" onClick={onClose}>Close ✕</button>}
    >
      <ConventionNote>
        The economic event: we realized, or wrote off, this position on this date. <b>It does not
        move the company between views</b> — that follows Affinity&rsquo;s roster status, which the VC
        team maintains.
      </ConventionNote>

      {failure && <div className="small" style={{ color: 'var(--red)' }}>{failure}</div>}

      <FormGrid>
        <Field label="Exit date" hint="When the position closed, not when this was typed in.">
          <input type="date" value={exitDate} onChange={(e) => setExitDate(e.target.value)} />
        </Field>
        <Field label="Type" hint="How the position ended. The list is the one the database holds.">
          <select value={exitType} onChange={(e) => setExitType(e.target.value)}>
            {exitTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Reason / note" hint="FR-30: the reason for departure, for board reporting.">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </FormGrid>

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          className="btn primary small"
          disabled={busy || !exitDate || !exitType}
          onClick={() =>
            run(
              () => recordExit({ companyId, exitDate, exitType, note: note.trim() || null }),
              existing?.exitDate ? 'Exit event updated' : 'Exit event recorded',
            )
          }
        >
          Save exit event
        </button>
        {existing?.exitDate && (
          <button
            className="btn small"
            disabled={busy}
            onClick={() => {
              const why = window.prompt('Why is this exit event being removed? Recorded against your name.');
              if (!why?.trim()) return;
              void run(() => removeExit(companyId, why.trim()), 'Exit event removed');
            }}
          >
            Remove
          </button>
        )}
      </div>
    </Card>
  );
}
