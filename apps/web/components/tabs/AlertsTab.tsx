'use client';

/**
 * Alerts: the watchlist and the risk-flag register (A9, ADR-032).
 *
 * THE ALERT POLICY CARD LEFT AT F3, to the Policies tab. That is a move rather
 * than a copy, and it improves this tab: it was deliberately built as the
 * WORKING view -- the feed, the flags, the acknowledgements -- and the card that
 * configured the thresholds was always slightly the wrong shape sitting inside
 * it. Where a threshold came from is still shown on every alert, which is the
 * part that belongs here.
 *
 * A NINTH TAB, ROLE-GATED, FOR THE REASON A7 AND A8 ADDED THEIRS. The prototype
 * has no alert configuration anywhere — the thresholds are literals in a
 * JavaScript object and there is no way to answer an alert at all — so this
 * cannot be a port of anything and has to be new surface. Keeping it off the
 * ported eight is what protects the ADR-014 parity criterion, exactly as the
 * note on `TABS` in `AppShell` explains for Deal Close and Finance.
 *
 * THE DASHBOARD KEEPS ITS OWN FEED and is unchanged in shape: fourteen rows,
 * red first, straight from `healthAlerts`. That is the board-facing view and it
 * stays a port. This tab is the working view behind it — every alert rather
 * than the top slice, with the threshold that produced each one, where that
 * threshold came from, and the means to answer it.
 *
 * WHAT IS NOT HERE: any way to change a company's health. Affinity is the
 * system of record for the risk grade behind it (ADR-009), the sync is one-way,
 * and the VC team maintains it there. The drawer shows the rating with its
 * author and date; there is deliberately no edit box anywhere in this phase.
 */
import { useMemo, useState } from 'react';

import type { PortfolioExport } from '@portfolio-command/contract';
import { allAlerts, type HealthAlert } from '@portfolio-command/metrics';

import { acknowledgeAlert, AlertsApiError, revokeAcknowledgement } from '../../lib/alerts-api';
import { Field, FormGrid, Notice } from '../entry';
import { useApp } from '../AppShell';
import { Card, ConventionNote, Dot, Pill, ViewHeader } from '../ui';

export function AlertsTab({ db, asOf }: { db: PortfolioExport; asOf: string }) {
  const { openCompany, toast } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every alert, acknowledged ones included, so the acknowledged can be shown
  // greyed rather than hidden. The dashboard calls healthAlerts(), which is the
  // same list with the acknowledged filtered out.
  const alerts = useMemo(() => allAlerts(db, { asOf }), [db, asOf]);
  const open = alerts.filter((a) => !a.acknowledged);
  const accepted = alerts.filter((a) => a.acknowledged);

  const run = async (what: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await what();
      toast(done);
      // The document is assembled server-side (page.tsx is force-dynamic), so a
      // reload is what brings the recomputed feed back. Board numbers are never
      // served from a cache and an optimistic local edit would be a second,
      // divergent copy of the alert rules.
      window.location.reload();
    } catch (err) {
      setError(err instanceof AlertsApiError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  return (
    <>
      <ViewHeader
        title="Alerts & Watchlist"
        sub={`${open.length} open - ${open.filter((a) => a.sev === 'red').length} critical - ${accepted.length} acknowledged - as of ${asOf}`}
      />

      <Notice text={error} onDismiss={() => setError(null)} />

      <Card
        title="Open alerts"
        headerExtra={<Pill tone="red">{open.filter((a) => a.sev === 'red').length} critical</Pill>}
      >
        <ConventionNote>
          Thresholds marked <em>policy</em> are inherited from the fund-wide setting, which is on the{' '}
          <b>Policies</b> tab. A company can override one on its own record, or set it to 0 to opt out
          of the alert entirely.
        </ConventionNote>
        {open.length === 0 && <div className="small">No open alerts.</div>}
        {open.map((a) => (
          <AlertLine key={`${a.company.id}-${a.key}`} alert={a} busy={busy} onOpen={openCompany} run={run} />
        ))}
      </Card>

      {accepted.length > 0 && (
        <Card title="Acknowledged">
          <ConventionNote>
            Still true, and still counted on the company record — removed from the feed until the date
            passes, the reading worsens materially, or someone revokes it.
          </ConventionNote>
          {accepted.map((a) => (
            <AlertLine key={`${a.company.id}-${a.key}`} alert={a} busy={busy} onOpen={openCompany} run={run} />
          ))}
        </Card>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

function AlertLine({
  alert: a,
  busy,
  onOpen,
  run,
}: {
  alert: HealthAlert;
  busy: boolean;
  onOpen: (id: string) => void;
  run: (what: () => Promise<void>, done: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');

  const ack = a.acknowledged;

  return (
    <div className="alertrow" style={{ flexWrap: 'wrap', opacity: ack ? 0.62 : 1 }}>
      <Dot tone={a.sev} />
      <a className="link" onClick={() => onOpen(a.company.id)}>
        {a.company.name}
      </a>
      <span className="small">{a.text}</span>

      {/* Where the threshold came from. "Who set 12 months" is the first thing
          anyone asks about an alert they disagree with, and before A9 the
          platform had no answer. */}
      {a.thresholdFrom && (
        <Pill tone={a.thresholdFrom === 'policy' ? 'blue' : 'gray'}>
          {a.thresholdFrom === 'policy' ? 'policy' : 'company'}
        </Pill>
      )}
      {a.source === 'flag' && <Pill tone="gray">flag</Pill>}

      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        {ack ? (
          <>
            <span className="hint">
              {ack.reason} — until {ack.untilDate}, {ack.by}
            </span>
            <button
              className="btn small"
              disabled={busy}
              onClick={() => run(() => revokeAcknowledgement(a.company.id, a.key), 'Acknowledgement revoked.')}
            >
              Revoke
            </button>
          </>
        ) : (
          <button className="btn small" disabled={busy} onClick={() => setOpen((v) => !v)}>
            {open ? 'Cancel' : 'Acknowledge'}
          </button>
        )}
      </span>

      {open && !ack && (
        <div style={{ flexBasis: '100%', marginTop: 8 }}>
          <FormGrid>
            <Field label="Reason" hint="Recorded against your name and shown on the alert.">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Bridge closing, board aware"
              />
            </Field>
            <Field label="Revisit on" hint="The alert returns on this date by itself.">
              <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
            </Field>
          </FormGrid>
          <div className="hint" style={{ marginTop: 6 }}>
            {a.value != null
              ? `Recorded at the current reading. It returns early if the figure moves materially past it.`
              : `Held until the date, or until someone revokes it.`}
          </div>
          <button
            className="btn primary small"
            style={{ marginTop: 8 }}
            disabled={busy || !reason.trim() || !until}
            onClick={() =>
              run(
                () =>
                  acknowledgeAlert({
                    companyId: a.company.id,
                    alertKey: a.key,
                    reason: reason.trim(),
                    untilDate: until,
                    // Null for alerts with no numeric subject — a flag, a
                    // covenant — which simply hold until the date.
                    value: a.value ?? null,
                  }),
                'Alert acknowledged.',
              )
            }
          >
            Acknowledge
          </button>
        </div>
      )}
    </div>
  );
}
