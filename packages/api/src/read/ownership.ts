/**
 * The significant-influence report, and the ownership history behind it
 * (F3, FR-21, FR-36, ADR-035).
 *
 * FR-21 asks for a threshold, a derived flag and a report. The flag is
 * `significant_influence_asof()` in migration 0010; this is the report, and its
 * shape is dictated by the one property the flag has that a simple yes/no does
 * not: **it is three-valued.**
 *
 * A COMPANY WITH NO OWNERSHIP FIGURE IS NOT BELOW THE THRESHOLD. It is a
 * company we cannot classify, and that is a different sentence with a different
 * consequence -- it is the one that goes missing from a schedule an auditor
 * expects to find it on. So the report carries every company we hold a position
 * in, `significantInfluence` is `null` rather than `false` where the answer is
 * unknown, and the screen groups the three states instead of filtering to the
 * interesting one.
 *
 * THE OWNERSHIP DATE TRAVELS WITH EVERY ROW, and that is not decoration either.
 * FR-21 depends on FR-36 because a flag derived from a three-year-old cap table
 * looks exactly as authoritative as one derived from last week's. The report
 * states how old each figure is and leaves the judgement to the reader; it does
 * not invent a staleness threshold nobody has set.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_READ, type Principal, requireRole } from '../auth/principal.js';

/** One company on the significant-influence schedule. */
export interface SignificantInfluenceRow {
  companyId: string;
  companyName: string;
  /**
   * true / false / null, straight from `significant_influence_asof`. NULL means
   * "not determined": no ownership figure, or no policy in force. Never
   * collapse it to false on the way to a screen.
   */
  significantInfluence: boolean | null;
  /** Percent as a plain number, as text. Null where nothing is recorded. */
  ownershipPct: string | null;
  /** The date that figure is as at -- NOT the date it was entered. */
  ownershipAsOfDate: string | null;
  ownershipId: string | null;
  fullyDiluted: boolean | null;
  proRataRights: boolean | null;
  /** ADR-035 clause 1. Null on a deal-close row, where the round is the reason. */
  changeReason: string | null;
  roundLabel: string | null;
  roundDate: string | null;
  enteredBy: string | null;
  isSynthetic: boolean;
  /** ADR-031. The row has been changed since it was entered. */
  edited: boolean;
  /** DOLLARS. Cumulative investment as at the date — how much this classification is about. */
  invested: string;
  /** DOLLARS. Carrying value as at the date, from the same function every metric reads. */
  fmv: string;
  /** F4 will make this a first-class state; today it is context on the row. */
  exited: boolean;
}

export interface SignificantInfluenceReport {
  asOfDate: string;
  /** The policy in force ON THAT DATE, which is not necessarily the current one. */
  threshold: string | null;
  policyEffectiveFrom: string | null;
  policySetBy: string | null;
  policyNote: string | null;
  rows: SignificantInfluenceRow[];
}

/**
 * The schedule, as at a date.
 *
 * `asOfDate` is required rather than defaulted to today, for the ADR-021 reason
 * that applies to every dated read in this codebase: a default would make the
 * same screen show different work depending on when it was opened, and this one
 * is reproducing a classification that may already have been reported.
 *
 * THE POPULATION IS EVERY COMPANY WE HAVE PUT MONEY INTO, plus any company
 * carrying an ownership figure without one -- not every company on the roster.
 * A pipeline company we never invested in has no cap-table position to
 * classify, and listing it would fill the "ownership not recorded" group with
 * rows nobody should act on, which is how a list of real gaps becomes wallpaper.
 */
export async function readSignificantInfluence(
  db: Kysely<DB>,
  principal: Principal,
  asOfDate: string,
): Promise<SignificantInfluenceReport> {
  requireRole(principal, CAN_READ);

  const { rows: policyRows } = await sql<{
    pct: string | null; effective_from: string; set_by_name: string; note: string | null;
  }>`
    select p.significant_influence_pct::text as pct,
           p.effective_from::text            as effective_from,
           u.display_name                    as set_by_name,
           p.note
      from pc.fund_accounting_policy p
      join pc.app_user u on u.user_id = p.set_by
     where p.effective_from <= ${asOfDate}::date
       and (p.effective_to is null or p.effective_to > ${asOfDate}::date)
     order by p.effective_from desc, p.fund_accounting_policy_id desc
     limit 1
  `.execute(db);
  const policy = policyRows[0] ?? null;

  interface Raw {
    company_id: string; company_name: string; significant_influence: boolean | null;
    ownership_pct: string | null; ownership_as_of: string | null; ownership_id: string | null;
    fully_diluted: boolean | null; pro_rata_rights: boolean | null; change_reason: string | null;
    round_label: string | null; round_date: string | null; entered_by: string | null;
    is_synthetic: boolean | null; edited: boolean | null;
    invested: string; fmv: string; exited: boolean;
  }

  const { rows } = await sql<Raw>`
    select c.company_id,
           c.name as company_name,
           -- The function, not a second expression that means to agree with it.
           -- A copy of the comparison here would be a second definition of
           -- significant influence, and the first disagreement between them is
           -- a company classified two ways in one board pack.
           pc.significant_influence_asof(c.company_id, ${asOfDate}::date) as significant_influence,
           own.ownership_pct::text          as ownership_pct,
           own.as_of_date::text             as ownership_as_of,
           own.company_ownership_id::text   as ownership_id,
           own.fully_diluted,
           own.pro_rata_rights,
           own.change_reason,
           r.label                          as round_label,
           r.round_date::text               as round_date,
           u.display_name                   as entered_by,
           own.is_synthetic,
           (own.row_updated_at > own.row_created_at) as edited,
           coalesce(inv.total, 0)::text     as invested,
           pc.company_fmv_asof(c.company_id, ${asOfDate}::date)::text as fmv,
           (ce.company_id is not null)      as exited
      from pc.company c
      left join lateral (
        -- The same row significant_influence_asof reads, resolved the same
        -- way: latest live position on or before the date.
        select co.*
          from pc.company_ownership co
         where co.company_id = c.company_id
           and co.as_of_date <= ${asOfDate}::date
           and co.deleted_at is null
         order by co.as_of_date desc, co.company_ownership_id desc
         limit 1) own on true
      left join pc.investment_round r on r.investment_round_id = own.investment_round_id
      left join pc.app_user u on u.user_id = own.entered_by
      left join pc.company_exit ce on ce.company_id = c.company_id
      left join lateral (
        select coalesce(sum(t.amount_cad), 0) as total
          from pc.v_transaction_live t
         where t.company_id = c.company_id
           and t.txn_type in ('investment','follow_on')
           and t.txn_date <= ${asOfDate}::date) inv on true
     where coalesce(inv.total, 0) > 0
        or own.company_ownership_id is not null
     -- Unclassifiable first, then the flagged, then everything else by size of
     -- holding. A schedule sorted by name is one where the rows that need
     -- attention are wherever they happen to fall.
     order by (pc.significant_influence_asof(c.company_id, ${asOfDate}::date) is null) desc,
              pc.significant_influence_asof(c.company_id, ${asOfDate}::date) desc nulls last,
              own.ownership_pct desc nulls last,
              c.name
  `.execute(db);

  return {
    asOfDate,
    threshold: policy?.pct ?? null,
    policyEffectiveFrom: policy?.effective_from ?? null,
    policySetBy: policy?.set_by_name ?? null,
    policyNote: policy?.note ?? null,
    rows: rows.map((r) => ({
      companyId: r.company_id,
      companyName: r.company_name,
      significantInfluence: r.significant_influence,
      ownershipPct: r.ownership_pct,
      ownershipAsOfDate: r.ownership_as_of,
      ownershipId: r.ownership_id,
      fullyDiluted: r.fully_diluted,
      proRataRights: r.pro_rata_rights,
      changeReason: r.change_reason,
      roundLabel: r.round_label,
      roundDate: r.round_date,
      enteredBy: r.entered_by,
      isSynthetic: r.is_synthetic === true,
      edited: r.edited === true,
      invested: r.invested,
      fmv: r.fmv,
      exited: r.exited,
    })),
  };
}

/** One dated cap-table position, as the entry surface shows it. */
export interface OwnershipRow {
  id: string;
  companyId: string;
  asOfDate: string;
  ownershipPct: string;
  fullyDiluted: boolean;
  proRataRights: boolean;
  changeReason: string | null;
  investmentRoundId: string | null;
  roundLabel: string | null;
  roundDate: string | null;
  sourceDocument: string | null;
  enteredBy: string | null;
  isSynthetic: boolean;
  edited: boolean;
  deleted: boolean;
  deletedReason: string | null;
}

/**
 * One company's ownership history, newest first.
 *
 * SOFT-DELETED ROWS ARE INCLUDED and flagged, not filtered. This is the surface
 * on which someone corrects a cap table, and a deleted position that vanishes
 * from the history is one they will re-enter -- and then find refused by the
 * unique index it is still occupying, with nothing on screen to explain why.
 */
export async function readOwnershipHistory(
  db: Kysely<DB>,
  principal: Principal,
  companyId: string,
): Promise<OwnershipRow[]> {
  requireRole(principal, CAN_READ);

  interface Raw {
    id: string; company_id: string; as_of_date: string; ownership_pct: string;
    fully_diluted: boolean; pro_rata_rights: boolean; change_reason: string | null;
    investment_round_id: string | null; round_label: string | null; round_date: string | null;
    source_document: string | null; entered_by: string | null; is_synthetic: boolean;
    edited: boolean; deleted: boolean; deleted_reason: string | null;
  }

  const { rows } = await sql<Raw>`
    select co.company_ownership_id::text as id,
           co.company_id,
           co.as_of_date::text           as as_of_date,
           co.ownership_pct::text        as ownership_pct,
           co.fully_diluted,
           co.pro_rata_rights,
           co.change_reason,
           co.investment_round_id::text  as investment_round_id,
           r.label                       as round_label,
           r.round_date::text            as round_date,
           co.source_document,
           u.display_name                as entered_by,
           co.is_synthetic,
           (co.row_updated_at > co.row_created_at) as edited,
           (co.deleted_at is not null)   as deleted,
           co.deleted_reason
      from pc.company_ownership co
      left join pc.investment_round r on r.investment_round_id = co.investment_round_id
      left join pc.app_user u on u.user_id = co.entered_by
     where co.company_id = ${companyId}
     order by co.as_of_date desc, co.company_ownership_id desc
  `.execute(db);

  return rows.map((r) => ({
    id: r.id,
    companyId: r.company_id,
    asOfDate: r.as_of_date,
    ownershipPct: r.ownership_pct,
    fullyDiluted: r.fully_diluted,
    proRataRights: r.pro_rata_rights,
    changeReason: r.change_reason,
    investmentRoundId: r.investment_round_id,
    roundLabel: r.round_label,
    roundDate: r.round_date,
    sourceDocument: r.source_document,
    enteredBy: r.entered_by,
    isSynthetic: r.is_synthetic,
    edited: r.edited,
    deleted: r.deleted,
    deletedReason: r.deleted_reason,
  }));
}
