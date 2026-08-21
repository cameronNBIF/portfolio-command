'use client';

/**
 * The row-level actions, identical across every Finance surface.
 *
 * "Delete" rather than "Void", and no "Reverse": ADR-031 clause 6 and 7. A row
 * booked against the wrong company is deleted and re-entered, which is what the
 * operator would do in a spreadsheet and now does here. Reversal still exists in
 * the schema for a genuine clawback — a real economic event with its own date —
 * but it is no longer how a typing error is fixed.
 *
 * ONE COMPONENT OVER FOUR TABLES, which is why it takes the table name rather
 * than being written per surface: delete, restore and history are the same three
 * verbs over the same versioned store, and a copy per surface would be four
 * places for the wording of a deletion prompt to drift.
 */
import { apiMessage } from '../../../lib/http';
import { mutate, type FinancialTableName } from '../../../lib/finance-api';
import { useApp } from '../../AppShell';

export function RowActions({
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
      onChanged(apiMessage(e, 'Delete failed'));
    }
  };

  const restore = async () => {
    try {
      await mutate({ table, op: 'restore', id, reason: 'Restored from the Finance tab' });
      onChanged('Restored');
    } catch (e) {
      onChanged(apiMessage(e, 'Restore failed'));
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
