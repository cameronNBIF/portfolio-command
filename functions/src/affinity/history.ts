/**
 * The Affinity change-log mirror (A4).
 *
 * Affinity is system of record for stage history: `GET /v2/field-value-changes`
 * holds every Status transition with its changer and timestamp. This mirrors it
 * into `affinity_field_change`, which `v_deal_stage_history` reads to give
 * time-in-stage, funnel conversion and drop-off.
 *
 * ADR-009 justified the mirror on the grounds that the endpoint was per-list-
 * entry and a funnel chart would otherwise fan out to one call per deal. The
 * 2026-07-15 API added an ACCOUNT-WIDE endpoint with filters, so that reason no
 * longer holds — but the mirror does, for the reason that was always the real
 * one: this is query performance, and Affinity stays authoritative.
 *
 * FULL then INCREMENTAL. The first run pages the whole history; later runs
 * filter on `changedAt` past the newest row already stored. The primary key is
 * Affinity's OWN change id, so a re-run overlapping the boundary is idempotent
 * by construction rather than by careful bookkeeping.
 */
import type pg from 'pg';

import type { AffinityClient } from './client.js';
import { NBIF_MASTER_LIST_ID } from './client.js';


/**
 * Which fields to mirror. Status is what `v_deal_stage_history` reads and the
 * only one with a consumer today. Deliberately a short list: the endpoint is
 * account-wide, so an unfiltered backfill would pull every change to every
 * field on every entity in the workspace.
 */
export const MIRRORED_FIELDS = ['Status'] as const;

interface ChangeValue {
  referenceType?: string;
  dropdownOptionId?: number | null;
  text?: string | null;
  displayValue?: string | null;
  rank?: number | null;
  [key: string]: unknown;
}

interface FieldValueChange {
  id: number;
  field: { id: string; name: string; type: string; entityType?: string };
  entity: { id: number } | null;
  listEntry: { id: number; listId: number } | null;
  changer: { emailAddress?: string | null } | null;
  changedAt: string;
  actionType: string;
  type: string;
  value: ChangeValue | number | string | null;
}

export interface HistoryResult {
  mode: 'full' | 'incremental';
  since: string | null;
  fetched: number;
  stored: number;
  skipped: number;
  apiCalls: number;
}

/** v2 action types are open-ended; the column CHECK is not. */
const ACTION_TYPES = new Set(['add', 'update', 'delete']);

export async function syncFieldHistory(
  client: pg.Client,
  af: AffinityClient,
  { listId = NBIF_MASTER_LIST_ID }: { listId?: number } = {},
): Promise<HistoryResult> {
  await client.query('set search_path = pc, public');

  const callsBefore = af.calls;

  // Resolve the field ids to mirror from the vocabulary the seed already used,
  // rather than hardcoding `field-5470690` here and having two places to change.
  const { rows: fieldRows } = await client.query<{ field_id: string; field_name: string }>(
    `select distinct field_id, field_name from affinity_field_change where field_name = any($1::text[])`,
    [MIRRORED_FIELDS as unknown as string[]],
  );
  const knownIds = new Map(fieldRows.map((r) => [r.field_name, r.field_id]));

  const { rows: watermarkRows } = await client.query<{ since: string | null }>(
    `select to_char(max(changed_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as since
       from affinity_field_change where field_name = any($1::text[])`,
    [MIRRORED_FIELDS as unknown as string[]],
  );
  const since = watermarkRows[0]?.since ?? null;
  const mode: HistoryResult['mode'] = since === null ? 'full' : 'incremental';

  let fetched = 0;
  let stored = 0;
  let skipped = 0;

  for (const fieldName of MIRRORED_FIELDS) {
    // On a first run there is nothing in the mirror to resolve the id from, so
    // discover it from the list's field metadata.
    let fieldId = knownIds.get(fieldName);
    if (!fieldId) {
      const fields = await af.collect<{ id: string; name: string }>(`/lists/${listId}/fields`);
      fieldId = fields.find((f) => f.name === fieldName)?.id;
      if (!fieldId) throw new Error(`Field "${fieldName}" not found on list ${listId}.`);
    }

    // ONE filter string, conditions joined by `&`. Repeating the parameter is
    // how fieldTypes works on the list endpoints but NOT how this one works --
    // it answers 400 "value at /filter is not a string". `&` binds tighter
    // than `|`, so no parentheses are needed here.
    //
    // The watermark uses `>`, so the newest stored row is not re-read; the
    // primary key is Affinity's own change id and would absorb an overlap in
    // any case.
    const filter = [`field.id=${fieldId}`, ...(since ? [`changedAt>${since}`] : [])].join(' & ');

    const changes = await af.collect<FieldValueChange>('/field-value-changes', {
      filter,
      limit: 100,
    });
    fetched += changes.length;

    await client.query('begin');
    try {
      await client.query('set local search_path = pc, public');
      for (const change of changes) {
        // Account-wide endpoint: a change to the same global field on another
        // list is not ours to mirror.
        if (!change.listEntry || change.listEntry.listId !== listId) {
          skipped++;
          continue;
        }
        if (!ACTION_TYPES.has(change.actionType)) {
          skipped++;
          continue;
        }

        const v = (typeof change.value === 'object' && change.value !== null ? change.value : null) as
          | ChangeValue
          | null;

        // A dropdown option removed from the field config still appears in
        // history as referenceType `deleted-entity` with NO dropdownOptionId.
        // Store displayValue and do not fail on the missing id (ADR-009).
        const valueText = v?.text ?? v?.displayValue ?? (typeof change.value === 'string' ? change.value : null);
        const valueNumber = typeof change.value === 'number' ? change.value : null;

        await client.query(
          `insert into affinity_field_change (affinity_field_change_id, list_id, list_entry_id,
                                              entity_id, field_id, field_name, action_type,
                                              value_type, dropdown_option_id, value_text,
                                              value_rank, value_number, value_json,
                                              changed_at, changer_email)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           on conflict (affinity_field_change_id) do nothing`,
          [
            change.id,
            change.listEntry.listId,
            change.listEntry.id,
            change.entity?.id ?? 0,
            change.field.id,
            change.field.name,
            change.actionType,
            change.type,
            v?.dropdownOptionId ?? null,
            valueText,
            v?.rank ?? null,
            valueNumber,
            v ? JSON.stringify(v) : null,
            change.changedAt,
            change.changer?.emailAddress ?? null,
          ],
        );
        stored++;
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    }
  }

  return { mode, since, fetched, stored, skipped, apiCalls: af.calls - callsBefore };
}

/**
 * Derives `pipeline_deal.closed_date` from the mirrored Status history.
 *
 * Affinity has no close-date field, but the transition INTO Portfolio is in the
 * change log. The trap is that most of that history is an artefact of when the
 * CRM was populated rather than when a deal closed: on 2025-12-01 the list was
 * bulk-loaded, and 76 of 82 portfolio companies were created and moved to
 * Portfolio the same day. Introhive did not close in December 2025 -- it was
 * entered in December 2025.
 *
 * So a close date is only credible where the transition happened AFTER the
 * entry existed. Same-day means migrated, not closed, and those keep a NULL
 * that the real answer fills at A6/B4 from Finance's first transaction.
 *
 * That guard is why "Platforms Closed YTD" reads six rather than eighty-two.
 * Storing the result rather than deriving it at read time follows how the rest
 * of the sync treats Affinity-derived facts; nothing here is computed from a
 * transaction, round or mark, so ADR-002 is not in play.
 */
export async function backfillClosedDates(client: pg.Client): Promise<number> {
  await client.query('set search_path = pc, public');
  const { rowCount } = await client.query(
    `update pipeline_deal d
        set closed_date = x.closed
       from (
         select c.list_entry_id,
                (min(c.changed_at) at time zone 'America/Los_Angeles')::date as closed
           from affinity_field_change c
          where c.field_name = 'Status'
            and c.value_text in ('Portfolio', 'Exited', 'Closed')
          group by c.list_entry_id
       ) x
      where d.affinity_row_id = x.list_entry_id::text
        and d.date_added is not null
        and x.closed > d.date_added
        and d.closed_date is distinct from x.closed`,
  );
  return rowCount ?? 0;
}
