/**
 * The exit event (F4, S-4, FR-28, FR-30, ADR-036).
 *
 * `company_exit` has existed since migration 0001 with a five-value vocabulary
 * and correct metric treatment, and **nothing has ever been able to write to
 * it** except the A6 generator — finding S-4. This is that write path.
 *
 * WHAT IT DOES NOT DO IS MOVE THE COMPANY BETWEEN VIEWS, and that is the single
 * most important sentence in this module. Membership follows Affinity's roster
 * status (ADR-036); recording an exit here records the ECONOMIC EVENT — we
 * realized, or wrote off, this position on this date for this reason. The two
 * are allowed to disagree for a period, and the Exited view shows it when they
 * do. The screen says so on its face, because the first person to use the form
 * will otherwise expect the company to disappear from the portfolio.
 *
 * FINANCE'S GATE, NOT THE DEAL LEAD'S. `CAN_WRITE_FINANCIAL`, for the reason
 * ADR-005 splits everything else: the exit is a financial event and Finance
 * owns it. The VC team owns the roster — in Affinity, where the sync reads it.
 *
 * NOT A VERSIONED TABLE. `company_exit` is not one of the seven the migration
 * 0002 trigger covers, so history here is `audit_log` rather than
 * `financial_row_version`. That is a deliberate limit rather than an oversight:
 * one row per company, no money on it, and the transactions that carry the
 * money are versioned already.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_WRITE_FINANCIAL, type Principal, requireRole } from '../auth/principal.js';
import { recordAudit } from './audit.js';
import { ValidationError } from './errors.js';
import { date, optional, text } from './session.js';

export interface ExitEventInput {
  companyId: string;
  /** The date the position was realized or written off. Not the date it was typed in. */
  exitDate: string;
  /** One of `company_exit.exit_type`'s values, which the read path serves from the constraint. */
  exitType: string;
  /** FR-30: the reason for departure, for reporting. */
  note?: string | null;
}

export type ExitMutation =
  | { op: 'record'; values: ExitEventInput }
  | { op: 'remove'; companyId: string; reason: string };

export interface ExitWriteResult {
  companyId: string;
  /** True when this replaced an event that was already recorded. */
  replacedExisting: boolean;
  /**
   * ADR-036 clause 2, echoed back so the form can say it rather than the user
   * discovering it: the roster still calls this a portfolio company, and
   * recording the event has not changed that.
   */
  stillOnRoster: boolean;
}

export async function applyExitMutation(
  db: Kysely<DB>,
  principal: Principal,
  mutation: ExitMutation,
): Promise<ExitWriteResult> {
  requireRole(principal, CAN_WRITE_FINANCIAL);

  return db.transaction().execute(async (trx) => {
    if (mutation.op === 'remove') return removeExit(trx, principal, mutation);
    return recordExit(trx, principal, mutation.values);
  });
}

async function recordExit(
  trx: Kysely<DB>,
  principal: Principal,
  v: ExitEventInput,
): Promise<ExitWriteResult> {
  const companyId = text(v.companyId, 'companyId');
  const exitDate = date(v.exitDate, 'exitDate');
  const exitType = text(v.exitType, 'exitType');

  const { rows: company } = await sql<{ id: string; roster_status: string | null; exited: boolean }>`
    select c.company_id as id,
           st.roster_status,
           coalesce(cur.exited, false) as exited
      from pc.company c
      left join lateral (
        select cst.roster_status from pc.company_state cst
         where cst.company_id = c.company_id and cst.effective_to is null limit 1) st on true
      left join lateral (
        select x.exited from pc.company_current_asof(current_date) x
         where x.company_id = c.company_id) cur on true
     where c.company_id = ${companyId}
  `.execute(trx);
  if (company.length === 0) throw new ValidationError(`No company ${companyId}.`);

  /* Validated against the CHECK's own vocabulary rather than a list kept here.
     FR-30 leaves open whether this is the vocabulary Finance reports on, and
     the answer will be a migration adding or renaming a value -- at which point
     a copy in TypeScript would be the thing that refuses it. */
  const { rows: allowed } = await sql<{ v: string }>`
    select (regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g'))[1] as v
      from pg_constraint c where c.conname = 'company_exit_exit_type_check'
  `.execute(trx);
  const vocabulary = allowed.map((r) => r.v);
  if (!vocabulary.includes(exitType)) {
    throw new ValidationError(
      `"${exitType}" is not one of the recorded exit types: ${vocabulary.join(', ')}.`,
    );
  }

  const { rows: before } = await sql<{ exit_date: string; exit_type: string; note: string | null }>`
    select exit_date::text as exit_date, exit_type, note
      from pc.company_exit where company_id = ${companyId}
  `.execute(trx);

  /* Upserted on the company, which is the primary key: a company exits once,
     and a second entry is a correction of the first rather than a second exit.
     If a position is ever sold in tranches, that is transactions, not a second
     `company_exit` row. */
  await sql`
    insert into pc.company_exit (company_id, exit_date, exit_type, note, recorded_by)
    values (${companyId}, ${exitDate}::date, ${exitType}, ${optional(v.note?.trim() || null)},
            ${principal.userId}::uuid)
    on conflict (company_id) do update
       set exit_date   = excluded.exit_date,
           exit_type   = excluded.exit_type,
           note        = excluded.note,
           recorded_by = excluded.recorded_by
  `.execute(trx);

  await recordAudit(trx, principal, {
    table: 'company_exit',
    recordId: companyId,
    action: before.length > 0 ? 'update' : 'insert',
    before: before[0] ?? null,
    after: { exit_date: exitDate, exit_type: exitType, note: v.note?.trim() || null },
  });

  return {
    companyId,
    replacedExisting: before.length > 0,
    stillOnRoster: company[0]!.exited === false,
  };
}

async function removeExit(
  trx: Kysely<DB>,
  principal: Principal,
  mutation: Extract<ExitMutation, { op: 'remove' }>,
): Promise<ExitWriteResult> {
  const companyId = text(mutation.companyId, 'companyId');
  const reason = mutation.reason?.trim() ?? '';
  if (reason.length < 3) {
    /* An exit that disappears without a reason is indistinguishable from one
       that was never recorded, and the board pack shows both. The same rule
       `company_risk_flag.cleared_reason` states for a lowered flag. */
    throw new ValidationError('Removing an exit event requires a reason.');
  }

  const { rows } = await sql<{ exit_date: string; exit_type: string; note: string | null }>`
    delete from pc.company_exit where company_id = ${companyId}
    returning exit_date::text as exit_date, exit_type, note
  `.execute(trx);
  if (rows.length === 0) throw new ValidationError(`No exit event recorded for ${companyId}.`);

  await recordAudit(trx, principal, {
    table: 'company_exit',
    recordId: companyId,
    action: 'delete',
    before: rows[0],
    after: { reason },
  });

  return { companyId, replacedExisting: false, stillOnRoster: true };
}
