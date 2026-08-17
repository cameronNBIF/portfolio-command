'use client';

/**
 * The History panel: everything that has ever happened to one financial row.
 *
 * ADR-031 promised Finance an Edit button and the operator a verbose,
 * attributable trail. This is the trail, on screen, rather than a table only
 * the admin knows how to query — the question "who changed this and what did it
 * say before" is asked far more often by the person looking at the number than
 * by the person holding the database password.
 *
 * It reuses the existing drawer rather than introducing a modal, so the
 * interaction Finance already knows from the company and deal drawers is the
 * one they get here (ADR-014's spirit, on a surface the prototype never had).
 *
 * The entries come from `financial_row_version`, which is written by a database
 * trigger — so this panel shows edits made through the API and edits made
 * through psql alike. There is no such thing as a change that happened but is
 * not here.
 */
import { useEffect, useState } from 'react';

import type { ChangeLogEntry } from '@portfolio-command/api';

import { DrawerBody, DrawerHeader } from '../AppShell';
import { Pill, type PillTone } from '../ui';
import { fetchHistory } from '../../lib/finance-api';

const ACTION_TONE: Record<string, PillTone> = {
  create: 'blue',
  update: 'yellow',
  delete: 'red',
  restore: 'green',
};

const ACTION_LABEL: Record<string, string> = {
  create: 'Entered',
  update: 'Edited',
  delete: 'Deleted',
  restore: 'Restored',
};

/**
 * Columns nobody is asking about when they open a history panel. The diff is
 * computed server-side over the whole row; this is presentation trimming, and
 * the underlying record keeps everything.
 */
const HIDDEN_FIELDS = new Set([
  'deleted_at', 'deleted_by', 'deleted_reason', 'is_synthetic',
  'batch_id', 'entered_by', 'prepared_by',
]);

/** `txn_date` reads as a column name; "Date" reads as a field. */
function fieldLabel(field: string): string {
  return field
    .replace(/_id$/, '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function value(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

export function FinancialHistoryDrawer({ table, id }: { table: string; id: string }) {
  const [entries, setEntries] = useState<ChangeLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEntries(null);
    setError(null);
    fetchHistory(table, id)
      .then((r) => live && setEntries(r.entries))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [table, id]);

  return (
    <>
      <DrawerHeader>
        <h3 style={{ margin: 0 }}>Change history</h3>
        <div className="small mono">
          {table} #{id}
        </div>
      </DrawerHeader>
      <DrawerBody>
        {error && <div className="hint" style={{ color: 'var(--red)' }}>{error}</div>}
        {!entries && !error && <div className="hint">Loading…</div>}

        {entries?.length === 0 && (
          <div className="hint">
            No recorded changes. Rows loaded before the versioning migration carry no entry
            for their creation; every change from that point on is here.
          </div>
        )}

        {entries?.map((e) => (
          <div className="dsec" key={e.id}>
            <h4 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Pill tone={ACTION_TONE[e.action] ?? 'gray'}>{ACTION_LABEL[e.action] ?? e.action}</Pill>
              <span style={{ fontWeight: 600 }}>{e.changedByName}</span>
              <span className="small" style={{ fontWeight: 400 }}>
                {new Date(e.changedAt).toLocaleString('en-CA')}
              </span>
              {e.isRestatement && (
                <Pill tone="purple">Restatement</Pill>
              )}
            </h4>

            {e.reason && (
              <div className="small" style={{ marginBottom: 8 }}>
                <b>Reason:</b> {e.reason}
              </div>
            )}

            {e.action === 'create' ? (
              <div className="hint">Row entered. Values as first keyed are recorded.</div>
            ) : e.changes.filter((c) => !HIDDEN_FIELDS.has(c.field)).length === 0 ? (
              <div className="hint">
                {e.action === 'delete'
                  ? 'Row removed from all views and totals. Still recoverable.'
                  : e.action === 'restore'
                    ? 'Row returned to all views and totals.'
                    : 'No content fields changed.'}
              </div>
            ) : (
              <table className="dt">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Was</th>
                    <th>Became</th>
                  </tr>
                </thead>
                <tbody>
                  {e.changes
                    .filter((c) => !HIDDEN_FIELDS.has(c.field))
                    .map((c) => (
                      <tr key={c.field}>
                        <td>{fieldLabel(c.field)}</td>
                        <td className="mono" style={{ color: 'var(--red)' }}>{value(c.from)}</td>
                        <td className="mono" style={{ color: 'var(--green)' }}>{value(c.to)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </DrawerBody>
    </>
  );
}
