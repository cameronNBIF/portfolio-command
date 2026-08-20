/**
 * The Exited view, and the disagreement it is built to show (F4, FR-29, ADR-036).
 *
 * TWO FACTS, TWO OWNERS, AND THEY DO NOT HAVE TO AGREE AT EVERY INSTANT. The
 * roster status is the VC team's, maintained in Affinity; the exit event is
 * Finance's, recorded here. Finance may book a write-off in March and the
 * roster may not change until someone updates Affinity in June. A platform-side
 * membership flag would have hidden that lag by making one of them win; ADR-036
 * keeps both and this module shows the gap.
 *
 * So the view is not one list. It is:
 *
 *   1. **Exited** — the roster says the company has left. The exit event may or
 *      may not be recorded yet, and a missing one is stated on the row rather
 *      than filled in with a plausible date.
 *   2. **Exit recorded, still on the roster** — Finance has booked the event
 *      and Affinity has not caught up. Not an error, and not something to
 *      correct silently: it is a reconciliation line, and F6 will read it.
 *
 * NOTHING HERE FILTERS THE PORTFOLIO. The ported Portfolio tab keeps its own
 * *active / include exited / exited only* control exactly as the prototype had
 * it (ADR-014); this is a surface for the exit as an EVENT, which the prototype
 * has no concept of at all.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_READ, type Principal, requireRole } from '../auth/principal.js';

/** One company on the Exited view. */
export interface ExitRow {
  companyId: string;
  companyName: string;
  /** Affinity's Status, verbatim. Null where the roster has not spoken (the fixture path). */
  rosterStatus: string | null;
  /** The ADR-036 derivation, from the same function every screen reads. */
  exited: boolean;
  /** Null until Finance records the event — which is a state, not a gap to fill in. */
  exitDate: string | null;
  exitType: string | null;
  note: string | null;
  recordedBy: string | null;
  /** DOLLARS, as at the date. */
  invested: string;
  fmv: string;
  realized: string;
  /** Was the position written off rather than sold — a fact from the transactions. */
  writtenOff: boolean;
  sector: string | null;
  health: string | null;
}

export interface ExitedView {
  asOfDate: string;
  /** The roster says these have left. */
  exited: ExitRow[];
  /**
   * Finance recorded an exit and the roster still calls them portfolio
   * companies. ADR-036 clause 2 in the data.
   */
  recordedNotOnRoster: ExitRow[];
  /** The vocabulary the entry form offers, from the CHECK the column carries. */
  exitTypes: string[];
}

/**
 * The five values `company_exit.exit_type` permits.
 *
 * READ FROM THE CONSTRAINT, not hardcoded beside it. FR-30 asks whether this
 * vocabulary is the one Finance reports on, and the honest answer has to come
 * from what the database will actually accept — the list has already moved once
 * (`Strategic acquisition` arrived with the fixture), and a second copy in
 * TypeScript would be the one that goes stale.
 */
async function exitTypes(db: Kysely<DB>): Promise<string[]> {
  const { rows } = await sql<{ v: string }>`
    select (regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g'))[1] as v
      from pg_constraint c
     where c.conname = 'company_exit_exit_type_check'
  `.execute(db);
  return rows.map((r) => r.v);
}

export async function readExitedView(
  db: Kysely<DB>,
  principal: Principal,
  asOfDate: string,
): Promise<ExitedView> {
  requireRole(principal, CAN_READ);

  interface Raw {
    company_id: string; company_name: string; roster_status: string | null; exited: boolean;
    exit_date: string | null; exit_type: string | null; note: string | null;
    recorded_by: string | null; invested: string; fmv: string; realized: string;
    written_off: boolean; sector: string | null; health: string | null;
    has_event: boolean;
  }

  const { rows } = await sql<Raw>`
    select cur.company_id,
           cur.name                          as company_name,
           st.roster_status,
           cur.exited,
           ce.exit_date::text                as exit_date,
           ce.exit_type,
           ce.note,
           u.display_name                    as recorded_by,
           coalesce(cur.invested, 0)::text   as invested,
           coalesce(cur.fmv, 0)::text        as fmv,
           coalesce(cur.realized, 0)::text   as realized,
           (wo.n > 0)                        as written_off,
           cur.sector,
           cur.health,
           (ce.company_id is not null)       as has_event
      from pc.company_current_asof(${asOfDate}::date) cur
      left join pc.company_exit ce on ce.company_id = cur.company_id
      left join pc.app_user u      on u.user_id     = ce.recorded_by
      left join lateral (
        select cst.roster_status
          from pc.company_state cst
         where cst.company_id = cur.company_id and cst.effective_to is null
         limit 1) st on true
      left join lateral (
        select count(*) as n
          from pc.v_transaction_live t
         where t.company_id = cur.company_id and t.txn_type = 'write_off') wo on true
     where cur.exited or ce.company_id is not null
     order by ce.exit_date desc nulls last, cur.name
  `.execute(db);

  const map = (r: Raw): ExitRow => ({
    companyId: r.company_id,
    companyName: r.company_name,
    rosterStatus: r.roster_status,
    exited: r.exited,
    exitDate: r.exit_date,
    exitType: r.exit_type,
    note: r.note,
    recordedBy: r.recorded_by,
    invested: r.invested,
    fmv: r.fmv,
    realized: r.realized,
    writtenOff: r.written_off,
    sector: r.sector,
    health: r.health,
  });

  return {
    asOfDate,
    exited: rows.filter((r) => r.exited).map(map),
    // Exactly the ADR-036 clause 2 state: the event exists and the roster
    // disagrees. Never merged into the list above, because they are different
    // statements about the company and only one of them decides membership.
    recordedNotOnRoster: rows.filter((r) => !r.exited && r.has_event).map(map),
    exitTypes: await exitTypes(db),
  };
}
