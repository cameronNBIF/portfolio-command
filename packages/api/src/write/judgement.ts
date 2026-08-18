/**
 * The write path, and the ADR-018 line drawn in code.
 *
 * ADR-018 splits the data in two and gives each half a different interface:
 *
 *   JUDGEMENT records -- health, risk flags, milestones, covenants, reserves,
 *   board seats, memos, diligence gates -- are freely editable in place, with
 *   `audit_log` capturing before and after. That is what this module does.
 *
 *   FINANCIAL records -- transactions, valuation marks, LP cashflows -- are
 *   append-only. A mistake is voided by a dated reversal or superseded by a new
 *   mark; no original row is ever mutated, and there is no grace period. The UI
 *   offers Correct and Reverse, not Edit.
 *
 * NOTHING IN THIS FILE CAN REACH A FINANCIAL TABLE, and that is enforced rather
 * than intended: `EDITABLE` is an exhaustive allow-list, every handler is
 * keyed by it, and `applyJudgementEdit` rejects anything not in it before it
 * touches the database. A3 exposes the three fields A2's `editable.tsx`
 * already drives -- gates, reserves and memos. A9, A10 and A12 add to the list;
 * the shape does not change.
 *
 * A2 built this surface as local React state so the interaction could be ported
 * before the API existed. This replaces the storage behind it, not the shape in
 * front of it.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_EDIT_JUDGEMENT, type Principal, requireRole } from '../auth/principal.js';
import { toDollars } from '../units.js';
import { recordAudit } from './audit.js';
import { ValidationError } from './errors.js';

/**
 * A judgement edit. The discriminated union is the allow-list: a financial
 * table is not merely disallowed here, it is unrepresentable.
 */
export type JudgementEdit =
  | { kind: 'deal-gate'; dealId: string; gateName: string; status: string }
  | { kind: 'reserve-allocation'; companyId: string; allocated: number }
  | { kind: 'memo-section'; subjectId: string; sectionKey: string; body: string }
  /* --- A9 (ADR-032) --- */
  | {
      kind: 'risk-flag-raise';
      companyId: string;
      /** `ref_risk_flag_category.code`. */
      category: string;
      note?: string | null;
      /** Omit to inherit the company's health colour, which is the frozen rule. */
      severity?: 'red' | 'yellow' | null;
    }
  | { kind: 'risk-flag-clear'; flagId: number; reason: string }
  | {
      kind: 'company-threshold';
      companyId: string;
      /**
       * `null` clears the threshold, so the company inherits the fund policy.
       * `0` disables the alert outright. Omitting a key leaves it untouched.
       * All three are different and the surface must be able to express each.
       */
      thresholds: {
        minRunwayMo?: number | null;
        maxBurnMult?: number | null;
        /** $M. */
        minCashBalance?: number | null;
        maxRevenueDeclinePct?: number | null;
        minNrrPct?: number | null;
      };
    }
  | {
      kind: 'alert-policy';
      minRunwayMo: number | null;
      maxBurnMult: number | null;
      /** $M. */
      minCashBalance: number | null;
      maxRevenueDeclinePct: number | null;
      minNrrPct: number | null;
      note?: string | null;
    }
  | {
      kind: 'alert-acknowledge';
      companyId: string;
      /** Matches `HealthAlert.key`. */
      alertKey: string;
      reason: string;
      /** `YYYY-MM-DD`. */
      untilDate: string;
      /** The reading as it stood, in the alert's own units. `$M` for cash. */
      value?: number | null;
    }
  | { kind: 'alert-revoke'; companyId: string; alertKey: string };

const GATE_STATUSES = ['pending', 'in-progress', 'passed', 'failed'] as const;

const MEMO_SECTIONS = [
  'exec', 'thesis', 'market', 'team', 'topgrading', 'product',
  'traction', 'terms', 'captable', 'risks', 'returns', 'reco',
] as const;

// Re-exported from its original home here so existing importers are unaffected.
export { ValidationError } from './errors.js';

/**
 * Applies one judgement edit and audits it.
 *
 * Runs inside a transaction so the row change and its audit entry land
 * together. An audited change that did not happen, or a change nobody recorded,
 * are both worse than a failed request.
 */
export async function applyJudgementEdit(
  db: Kysely<DB>,
  principal: Principal,
  edit: JudgementEdit,
): Promise<void> {
  requireRole(principal, CAN_EDIT_JUDGEMENT);

  await db.transaction().execute(async (trx) => {
    switch (edit.kind) {
      case 'deal-gate': {
        if (!(GATE_STATUSES as readonly string[]).includes(edit.status)) {
          throw new ValidationError(
            `Gate status must be one of ${GATE_STATUSES.join(', ')}; got ${JSON.stringify(edit.status)}.`,
          );
        }
        const before = await trx
          .selectFrom('deal_gate')
          .select(['status'])
          .where('deal_id', '=', edit.dealId)
          .where('gate_name', '=', edit.gateName)
          .executeTakeFirst();
        if (!before) {
          throw new ValidationError(`No gate "${edit.gateName}" on deal ${edit.dealId}.`);
        }
        await trx
          .updateTable('deal_gate')
          .set({ status: edit.status, changed_by: principal.userId, changed_at: new Date() })
          .where('deal_id', '=', edit.dealId)
          .where('gate_name', '=', edit.gateName)
          .execute();
        await recordAudit(trx, principal, {
          table: 'deal_gate',
          recordId: `${edit.dealId}/${edit.gateName}`,
          action: 'update',
          before,
          after: { status: edit.status },
        });
        return;
      }

      case 'reserve-allocation': {
        if (!Number.isFinite(edit.allocated) || edit.allocated < 0) {
          throw new ValidationError('Reserve allocation must be a non-negative number of $M.');
        }
        const before = await trx
          .selectFrom('reserve_allocation')
          .select(['allocated', 'deployed'])
          .where('company_id', '=', edit.companyId)
          .orderBy('effective_from', 'desc')
          .orderBy('reserve_allocation_id', 'desc')
          .executeTakeFirst();
        if (!before) throw new ValidationError(`No reserve allocation for ${edit.companyId}.`);

        // A new dated row rather than an update. Reserve policy is a decision
        // with a date, and the reserves tool at A12 wants the history -- this
        // is a judgement record kept append-style by preference, not by the
        // ADR-018 obligation that binds financial rows.
        await trx
          .insertInto('reserve_allocation')
          .values({
            company_id: edit.companyId,
            allocated: toDollars(edit.allocated),
            deployed: before.deployed,
            policy_basis: 'Manual override',
            effective_from: sql`current_date`,
            set_by: principal.userId,
          })
          .execute();
        await recordAudit(trx, principal, {
          table: 'reserve_allocation',
          recordId: edit.companyId,
          action: 'insert',
          before,
          after: { allocated: toDollars(edit.allocated), deployed: before.deployed },
        });
        return;
      }

      case 'memo-section': {
        if (!(MEMO_SECTIONS as readonly string[]).includes(edit.sectionKey)) {
          throw new ValidationError(`Unknown memo section ${JSON.stringify(edit.sectionKey)}.`);
        }
        const subjectType = await trx
          .selectFrom('company')
          .select(['company_id'])
          .where('company_id', '=', edit.subjectId)
          .executeTakeFirst();

        let memo = await trx
          .selectFrom('memo')
          .select(['memo_id'])
          .where('subject_id', '=', edit.subjectId)
          .orderBy('memo_id', 'desc')
          .executeTakeFirst();

        if (!memo) {
          memo = await trx
            .insertInto('memo')
            .values({
              subject_type: subjectType ? 'company' : 'deal',
              subject_id: edit.subjectId,
              title: `IC memo — ${edit.subjectId}`,
              author_id: principal.userId,
            })
            .returning('memo_id')
            .executeTakeFirstOrThrow();
        }

        const before = await trx
          .selectFrom('memo_section')
          .select(['body'])
          .where('memo_id', '=', memo.memo_id)
          .where('section_key', '=', edit.sectionKey)
          .executeTakeFirst();

        await sql`
          insert into memo_section (memo_id, section_key, body, sort_order)
          values (${memo.memo_id}, ${edit.sectionKey}, ${edit.body},
                  ${MEMO_SECTIONS.indexOf(edit.sectionKey as (typeof MEMO_SECTIONS)[number]) + 1})
          on conflict (memo_id, section_key) do update set body = excluded.body
        `.execute(trx);

        await recordAudit(trx, principal, {
          table: 'memo_section',
          recordId: `${edit.subjectId}/${edit.sectionKey}`,
          action: before ? 'update' : 'insert',
          before,
          after: { body: edit.body },
        });
        return;
      }

      /* ============================ A9 ============================ */

      case 'risk-flag-raise': {
        /* THE CATEGORY IS RESOLVED, NEVER INVENTED (ADR-026). An unknown code
           is a rejected request, not a new vocabulary row: the categories
           decide which derived alert a flag suppresses, so a category created
           by a typo would be a category that suppresses nothing and looks like
           it should. */
        const category = await trx
          .selectFrom('ref_risk_flag_category')
          .select(['risk_flag_category_id', 'name'])
          .where('code', '=', edit.category)
          .where('is_active', '=', true)
          .executeTakeFirst();
        if (!category) {
          throw new ValidationError(
            `Unknown risk flag category ${JSON.stringify(edit.category)}. ` +
              'Categories are reference data; add a row to ref_risk_flag_category rather than a new string here.',
          );
        }

        const company = await trx
          .selectFrom('company')
          .select(['company_id'])
          .where('company_id', '=', edit.companyId)
          .executeTakeFirst();
        if (!company) throw new ValidationError(`No company ${edit.companyId}.`);

        const note = edit.note?.trim() || null;
        /* The ADR-001 display string, composed once and stored. It is what the
           contract serialises and what a board pack prints, so it is a stored
           fact from the moment it is written -- not something re-derived from
           the category on every read, which would silently rewrite the text on
           a flag raised two years ago the first time someone renamed a
           category. Same reason company.sector_label exists (ADR-026). */
        const flagText = note ? `${category.name} — ${note}` : category.name;

        const inserted = await trx
          .insertInto('company_risk_flag')
          .values({
            company_id: edit.companyId,
            flag_text: flagText,
            note,
            severity: edit.severity ?? null,
            risk_flag_category_id: category.risk_flag_category_id,
            raised_by: principal.userId,
          })
          .returning('company_risk_flag_id')
          .executeTakeFirstOrThrow();

        await recordAudit(trx, principal, {
          table: 'company_risk_flag',
          recordId: String(inserted.company_risk_flag_id),
          action: 'insert',
          before: null,
          after: { company_id: edit.companyId, flag_text: flagText, category: edit.category },
        });
        return;
      }

      case 'risk-flag-clear': {
        /* A REASON IS REQUIRED, and it is required here rather than only in the
           UI. A flag that disappears without one is indistinguishable from a
           flag raised by mistake, and both appear the same way in a board pack
           six months later. */
        if (!edit.reason?.trim()) {
          throw new ValidationError('Clearing a risk flag requires a reason.');
        }
        const before = await trx
          .selectFrom('company_risk_flag')
          .select(['company_id', 'flag_text', 'cleared_at'])
          .where('company_risk_flag_id', '=', String(edit.flagId))
          .executeTakeFirst();
        if (!before) throw new ValidationError(`No risk flag ${edit.flagId}.`);
        if (before.cleared_at) {
          throw new ValidationError(`Risk flag ${edit.flagId} was already cleared.`);
        }

        await trx
          .updateTable('company_risk_flag')
          .set({
            cleared_at: sql`current_date`,
            cleared_by: principal.userId,
            cleared_reason: edit.reason.trim(),
          })
          .where('company_risk_flag_id', '=', String(edit.flagId))
          .execute();

        await recordAudit(trx, principal, {
          table: 'company_risk_flag',
          recordId: String(edit.flagId),
          action: 'update',
          before,
          after: { cleared_reason: edit.reason.trim() },
        });
        return;
      }

      case 'company-threshold': {
        const t = edit.thresholds;
        assertThreshold('minRunwayMo', t.minRunwayMo);
        assertThreshold('maxBurnMult', t.maxBurnMult);
        assertThreshold('minCashBalance', t.minCashBalance);
        assertThreshold('maxRevenueDeclinePct', t.maxRevenueDeclinePct);
        assertThreshold('minNrrPct', t.minNrrPct);

        const before = await trx
          .selectFrom('company_threshold')
          .selectAll()
          .where('company_id', '=', edit.companyId)
          .executeTakeFirst();

        /* Only the keys the caller supplied are touched. `undefined` means
           "leave alone" and `null` means "clear, and inherit the policy" --
           conflating them would make it impossible to edit one threshold
           without restating the other four. */
        const set = {
          ...(t.minRunwayMo !== undefined ? { min_runway_months: t.minRunwayMo } : {}),
          ...(t.maxBurnMult !== undefined ? { max_burn_multiple: asNumeric(t.maxBurnMult) } : {}),
          ...(t.minCashBalance !== undefined
            ? { min_cash_balance: t.minCashBalance === null ? null : toDollars(t.minCashBalance) }
            : {}),
          ...(t.maxRevenueDeclinePct !== undefined
            ? { max_revenue_decline_pct: asNumeric(t.maxRevenueDeclinePct) }
            : {}),
          ...(t.minNrrPct !== undefined ? { min_nrr_pct: asNumeric(t.minNrrPct) } : {}),
        };
        if (Object.keys(set).length === 0) {
          throw new ValidationError('No thresholds supplied.');
        }

        if (before) {
          await trx
            .updateTable('company_threshold')
            .set({ ...set, updated_by: principal.userId, updated_at: new Date() })
            .where('company_id', '=', edit.companyId)
            .execute();
        } else {
          await trx
            .insertInto('company_threshold')
            .values({ company_id: edit.companyId, ...set, updated_by: principal.userId })
            .execute();
        }

        await recordAudit(trx, principal, {
          table: 'company_threshold',
          recordId: edit.companyId,
          action: before ? 'update' : 'insert',
          before: before ?? null,
          after: set,
        });
        return;
      }

      case 'alert-policy': {
        assertThreshold('minRunwayMo', edit.minRunwayMo);
        assertThreshold('maxBurnMult', edit.maxBurnMult);
        assertThreshold('minCashBalance', edit.minCashBalance);
        assertThreshold('maxRevenueDeclinePct', edit.maxRevenueDeclinePct);
        assertThreshold('minNrrPct', edit.minNrrPct);

        const fund = await trx
          .selectFrom('fund')
          .select(['fund_id'])
          .orderBy('fund_id')
          .executeTakeFirst();
        if (!fund) throw new ValidationError('No fund row to attach a policy to.');

        const before = await trx
          .selectFrom('fund_alert_policy')
          .selectAll()
          .where('fund_id', '=', fund.fund_id)
          .where('effective_to', 'is', null)
          .executeTakeFirst();

        /* SUPERSEDED, NOT UPDATED. The current row is closed and a new one
           opened, because the point of the effective dating is that a board
           pack issued last quarter can still be reproduced against the policy
           that was in force when it was issued. An in-place update would
           rewrite history that a reader is entitled to. */
        if (before) {
          await trx
            .updateTable('fund_alert_policy')
            .set({ effective_to: sql`current_date` })
            .where('fund_alert_policy_id', '=', before.fund_alert_policy_id)
            .execute();
        }

        const values = {
          fund_id: fund.fund_id,
          min_runway_months: edit.minRunwayMo,
          max_burn_multiple: asNumeric(edit.maxBurnMult),
          min_cash_balance: edit.minCashBalance === null ? null : toDollars(edit.minCashBalance),
          max_revenue_decline_pct: asNumeric(edit.maxRevenueDeclinePct),
          min_nrr_pct: asNumeric(edit.minNrrPct),
          set_by: principal.userId,
          note: edit.note?.trim() || null,
        };
        await trx.insertInto('fund_alert_policy').values(values).execute();

        await recordAudit(trx, principal, {
          table: 'fund_alert_policy',
          recordId: String(fund.fund_id),
          action: 'insert',
          before: before ?? null,
          after: values,
        });
        return;
      }

      case 'alert-acknowledge': {
        if (!edit.reason?.trim()) {
          throw new ValidationError('Acknowledging an alert requires a reason.');
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(edit.untilDate)) {
          throw new ValidationError(`untilDate must be YYYY-MM-DD; got ${JSON.stringify(edit.untilDate)}.`);
        }

        const company = await trx
          .selectFrom('company')
          .select(['company_id'])
          .where('company_id', '=', edit.companyId)
          .executeTakeFirst();
        if (!company) throw new ValidationError(`No company ${edit.companyId}.`);

        /* A live acknowledgement on the same alert is REVOKED rather than
           overwritten, so the sequence of judgements survives. "Who waved this
           through, and when, and what did they say the second time" is a
           question a board asks after the fact, and an UPDATE answers only the
           last third of it. The partial unique index requires this anyway --
           it permits exactly one live row per alert. */
        const previous = await trx
          .selectFrom('alert_acknowledgement')
          .select(['alert_acknowledgement_id'])
          .where('company_id', '=', edit.companyId)
          .where('alert_key', '=', edit.alertKey)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (previous) {
          await trx
            .updateTable('alert_acknowledgement')
            .set({ revoked_at: new Date(), revoked_by: principal.userId })
            .where('alert_acknowledgement_id', '=', previous.alert_acknowledgement_id)
            .execute();
        }

        const values = {
          company_id: edit.companyId,
          alert_key: edit.alertKey,
          reason: edit.reason.trim(),
          until_date: edit.untilDate,
          // $M crosses to dollars for the one money-valued alert, and only
          // there (ADR-001). Runway is months, the burn multiple a ratio, and
          // the other two percentages -- none crosses a unit boundary.
          acknowledged_value:
            edit.value == null
              ? null
              : edit.alertKey === 'metric:cash-balance'
                ? toDollars(edit.value)
                : asNumeric(edit.value),
          acknowledged_by: principal.userId,
        };
        await trx.insertInto('alert_acknowledgement').values(values).execute();

        await recordAudit(trx, principal, {
          table: 'alert_acknowledgement',
          recordId: `${edit.companyId}/${edit.alertKey}`,
          action: 'insert',
          before: previous ? { superseded: previous.alert_acknowledgement_id } : null,
          after: values,
        });
        return;
      }

      case 'alert-revoke': {
        const before = await trx
          .selectFrom('alert_acknowledgement')
          .select(['alert_acknowledgement_id', 'reason', 'until_date'])
          .where('company_id', '=', edit.companyId)
          .where('alert_key', '=', edit.alertKey)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (!before) {
          throw new ValidationError(
            `No live acknowledgement on ${edit.alertKey} for ${edit.companyId}.`,
          );
        }

        await trx
          .updateTable('alert_acknowledgement')
          .set({ revoked_at: new Date(), revoked_by: principal.userId })
          .where('alert_acknowledgement_id', '=', before.alert_acknowledgement_id)
          .execute();

        await recordAudit(trx, principal, {
          table: 'alert_acknowledgement',
          recordId: `${edit.companyId}/${edit.alertKey}`,
          action: 'update',
          before,
          after: { revoked: true },
        });
        return;
      }
    }
  });
}

/**
 * A threshold is a non-negative number, `null`, or absent — and 0 is a
 * legitimate value meaning "disabled", not a missing one.
 *
 * `Number.isFinite` rather than a truthiness test, for exactly that reason: `0`
 * is falsy and is the one value that must survive. It is the only way a company
 * opts out of a portfolio-wide policy.
 */
function assertThreshold(field: string, v: number | null | undefined): void {
  if (v === null || v === undefined) return;
  if (!Number.isFinite(v) || v < 0) {
    throw new ValidationError(`${field} must be a non-negative number, or null to inherit; got ${JSON.stringify(v)}.`);
  }
}

/** `numeric` columns take strings; null passes through. */
const asNumeric = (v: number | null | undefined): string | null =>
  v === null || v === undefined ? null : String(v);
