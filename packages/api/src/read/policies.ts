/**
 * What the Policies surface reads (F3, FR-21, ADR-035 clause 5).
 *
 * The alert policy is NOT here. It already reaches the browser through the
 * ADR-001 export as `alertPolicy`, which is what the card renders today and
 * what it will keep rendering after the card moves tabs -- a second read of the
 * same row in a different shape would be a second thing to keep in step for no
 * gain. What this module adds is everything the export has no field for,
 * because it is configuration rather than portfolio: the accounting policy with
 * its history, and the retention options with the retired ones visible.
 *
 * HISTORY IS PART OF THE READ, NOT AN EXTRA SCREEN. Both of these are
 * effective-dated or retirable precisely so that a past classification stays
 * reproducible, and a surface that shows only the current row makes that
 * property invisible to the person relying on it.
 */
import { type Kysely, sql } from 'kysely';

import { CAN_READ, type Principal, requireRole } from '../auth/principal.js';
import type { DB } from '@portfolio-command/db/generated';

export interface AccountingPolicyRow {
  id: string;
  /** Percent as a plain number, as text. Null means the row sets no threshold. */
  significantInfluencePct: string | null;
  effectiveFrom: string;
  /** Null on the row in force. */
  effectiveTo: string | null;
  setBy: string;
  setAt: string;
  note: string | null;
}

export interface RetentionOptionRow {
  factor: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
  /** How many marks were written with this factor. Retiring a used option is not a delete. */
  marksUsing: number;
}

export interface FinancePolicies {
  /** The row in force today, or null when nobody has set one (ADR-035 clause 3). */
  current: AccountingPolicyRow | null;
  /** Every row, newest first, including the one in force. */
  history: AccountingPolicyRow[];
  /** Active and retired alike; the screen distinguishes them. */
  retentionOptions: RetentionOptionRow[];
}

export async function readFinancePolicies(
  db: Kysely<DB>,
  principal: Principal,
): Promise<FinancePolicies> {
  requireRole(principal, CAN_READ);

  const [policies, options] = await Promise.all([
    sql<{
      id: string; pct: string | null; effective_from: string; effective_to: string | null;
      set_by: string; set_at: string; note: string | null;
    }>`
      select p.fund_accounting_policy_id::text as id,
             p.significant_influence_pct::text as pct,
             p.effective_from::text            as effective_from,
             p.effective_to::text              as effective_to,
             u.display_name                    as set_by,
             p.set_at::text                    as set_at,
             p.note
        from pc.fund_accounting_policy p
        join pc.app_user u on u.user_id = p.set_by
       order by p.effective_from desc, p.fund_accounting_policy_id desc
    `.execute(db),

    sql<{ factor: string; label: string; is_active: boolean; sort_order: number; marks_using: string }>`
      select o.factor::text as factor, o.label, o.is_active, o.sort_order,
             -- Counted over EVERY mark, deleted ones included: a retired option
             -- that once produced a figure still has to reconstruct, which is
             -- the reason these rows are retired rather than deleted.
             (select count(*) from pc.valuation_mark vm
               where vm.retention_factor = o.factor)::text as marks_using
        from pc.ref_fmv_retention_option o
       order by o.sort_order, o.fmv_retention_option_id
    `.execute(db),
  ]);

  const rows: AccountingPolicyRow[] = policies.rows.map((p) => ({
    id: p.id,
    significantInfluencePct: p.pct,
    effectiveFrom: p.effective_from,
    effectiveTo: p.effective_to,
    setBy: p.set_by,
    setAt: p.set_at,
    note: p.note,
  }));

  return {
    current: rows.find((r) => r.effectiveTo === null) ?? null,
    history: rows,
    retentionOptions: options.rows.map((o) => ({
      factor: o.factor,
      label: o.label,
      isActive: o.is_active,
      sortOrder: o.sort_order,
      marksUsing: Number(o.marks_using),
    })),
  };
}
