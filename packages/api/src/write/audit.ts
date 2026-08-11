/**
 * The audit trail.
 *
 * CLAUDE.md: "Every write to a financial or mandate field goes through
 * audit_log." This is that one place, and it takes the before value as well as
 * the after -- a log that records only what a field became cannot answer the
 * question anyone actually asks, which is what it used to be.
 *
 * `changed_by` is a real `app_user`, resolved by the same lookup that granted
 * the permission (auth/principal.ts), so "who was allowed" and "who did it"
 * cannot drift apart.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import type { Principal } from '../auth/principal.js';

export interface AuditEntry {
  table: string;
  recordId: string;
  action: 'insert' | 'update' | 'delete';
  before?: unknown;
  after?: unknown;
}

export async function recordAudit(
  db: Kysely<DB>,
  principal: Principal,
  entry: AuditEntry,
): Promise<void> {
  await sql`
    insert into audit_log (table_name, record_id, action, old_value, new_value, changed_by)
    values (
      ${entry.table},
      ${entry.recordId},
      ${entry.action},
      ${entry.before === undefined ? null : JSON.stringify(entry.before)}::jsonb,
      ${entry.after === undefined ? null : JSON.stringify(entry.after)}::jsonb,
      ${principal.userId}::uuid
    )
  `.execute(db);
}
