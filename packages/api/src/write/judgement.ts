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

/**
 * A judgement edit. The discriminated union is the allow-list: a financial
 * table is not merely disallowed here, it is unrepresentable.
 */
export type JudgementEdit =
  | { kind: 'deal-gate'; dealId: string; gateName: string; status: string }
  | { kind: 'reserve-allocation'; companyId: string; allocated: number }
  | { kind: 'memo-section'; subjectId: string; sectionKey: string; body: string };

const GATE_STATUSES = ['pending', 'in-progress', 'passed', 'failed'] as const;

const MEMO_SECTIONS = [
  'exec', 'thesis', 'market', 'team', 'topgrading', 'product',
  'traction', 'terms', 'captable', 'risks', 'returns', 'reco',
] as const;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

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
    }
  });
}
