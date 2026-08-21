/**
 * The reconciliation surface (F6, FR-09, S-10).
 *
 * Eight checks that each ask the same shape of question: do two records of one
 * fact agree, and has somebody finished recording it? Every one of them was
 * previously either invisible or visible only inside the form that created it —
 * S-10's whole content is that `nb_other` and the NB co-investor sum can
 * disagree and *only the capture form shows it*.
 *
 * THE CHECKS ARE IN SQL, NOT HERE. `v_reconciliation` holds all eight, so
 * Finance's own ad-hoc query and this screen cannot drift apart. What lives in
 * this file is the part a view cannot hold: what each check is CALLED, what it
 * means in a sentence, and which screen fixes it.
 *
 * WHICH SCREEN FIXES IT IS THE POINT, NOT DECORATION. The roadmap's own
 * argument against this phase is that a reconciliation list nobody can act on
 * from itself becomes wallpaper — the same argument A9 made for time-boxed
 * acknowledgements. A row that names a problem and leaves the reader to find
 * the screen is a row that gets read once.
 *
 * NOT AN ALERT SURFACE. A9's alerts are about the portfolio — a company running
 * out of runway, a covenant breached. These are about the platform's own
 * records. Mixing them would mean triaging "Chinova has four months of cash"
 * next to "this cheque has no round", and the second would win by volume.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_READ, type Principal, requireRole } from '../auth/principal.js';

/**
 * The eight checks. The union is closed and the strings match
 * `v_reconciliation.check_kind` exactly — a value here that the view never
 * emits would be a check that permanently reads zero, which is worse than a
 * missing one because it looks like good news.
 */
export type ReconciliationCheck =
  | 'unlinked-cheque'
  | 'participated-no-cheque'
  | 'unclassified-round'
  | 'coinvestor-sum-mismatch'
  | 'round-total-below-cheque'
  | 'mark-basis-drift'
  | 'exit-status-mismatch'
  | 'lp-overdrawn';

/** Where a row is fixed. Consumed by the web layer to route the row's action. */
export type FixSurface =
  | 'finance-transactions'
  | 'finance-marks'
  | 'finance-lp'
  | 'deal-close'
  | 'exited'
  | 'affinity';

export interface CheckDefinition {
  kind: ReconciliationCheck;
  /** The column heading a person reads. */
  title: string;
  /** One sentence: what this check means, not how it is computed. */
  meaning: string;
  /** Which screen resolves it, or `affinity` where the fix is not in this platform. */
  fixSurface: FixSurface;
  /** What the action button says. */
  fixLabel: string;
  openItems: number;
}

export interface ReconciliationRow {
  checkKind: ReconciliationCheck;
  subjectTable: string;
  subjectId: string;
  companyId: string | null;
  companyName: string;
  subjectLabel: string;
  subjectDate: string | null;
  /** DOLLARS as text, or null where the check has no figures to compare. */
  figureA: string | null;
  figureALabel: string | null;
  figureB: string | null;
  figureBLabel: string | null;
  detail: string;
}

export interface ReconciliationReport {
  /** All eight, always, in a fixed order, zero-filled. */
  checks: CheckDefinition[];
  rows: ReconciliationRow[];
  totalOpen: number;
}

/**
 * The catalogue.
 *
 * ALL EIGHT ARE ALWAYS RETURNED, INCLUDING THE ZEROES, and that is the one
 * design decision in this file worth arguing. A surface that lists only what is
 * currently wrong cannot distinguish "this check found nothing" from "this
 * check is not running" — and the second is exactly what happens when a
 * predicate silently stops matching. Showing a zero is what makes the absence
 * of a problem into evidence rather than into silence.
 *
 * The order is deliberate: the two checks that mean a FACT IS MISSING come
 * first, then the four where two records DISAGREE, then the two that are a lag
 * between two systems rather than an error in either.
 */
const CHECKS: Omit<CheckDefinition, 'openItems'>[] = [
  {
    kind: 'unlinked-cheque',
    title: 'Cheque with no round',
    meaning:
      'Money we put in that is attached to no round, and that nobody has confirmed belongs to none. ' +
      'A bridge or a secondary legitimately has no round — confirming it says so and clears it from here.',
    fixSurface: 'finance-transactions',
    fixLabel: 'Link or confirm',
  },
  {
    kind: 'participated-no-cheque',
    title: 'Round with no cheque',
    meaning:
      'The round says we participated and no live investment or follow-on is linked to it. ' +
      'Either the cheque is not booked yet, or it is booked and nobody linked it.',
    fixSurface: 'deal-close',
    fixLabel: 'Open round',
  },
  {
    kind: 'unclassified-round',
    title: 'Awaiting classification',
    meaning:
      'Cheques in this round carry no instrument or no vehicle, so they cannot be split into ' +
      'balance-sheet buckets or attributed to a fund.',
    fixSurface: 'finance-transactions',
    fixLabel: 'Classify',
  },
  {
    kind: 'coinvestor-sum-mismatch',
    title: 'NB capital disagrees',
    meaning:
      'The NB co-investment KPI reads `nb_other`; the co-investor rows sum to something else. ' +
      'Two separate captures of one figure, and only the capture form has ever shown the gap.',
    fixSurface: 'deal-close',
    fixLabel: 'Reconcile',
  },
  {
    kind: 'round-total-below-cheque',
    title: 'Round smaller than our cheque',
    meaning:
      'An impossible round: the total is less than what we put into it. Accepted at capture on ' +
      'purpose, and excluded from leverage — this is the list of what was accepted.',
    fixSurface: 'deal-close',
    fixLabel: 'Open round',
  },
  {
    kind: 'mark-basis-drift',
    title: 'Mark built on a corrected basis',
    meaning:
      'This valuation was computed from an earlier mark that has since been changed, so the ' +
      'figure it was derived from no longer exists. Storing the basis is what makes this visible.',
    fixSurface: 'finance-marks',
    fixLabel: 'Review mark',
  },
  {
    kind: 'exit-status-mismatch',
    title: 'Exit status disagrees',
    meaning:
      'Affinity’s roster and the recorded exit event do not agree. Expected for a period — the ' +
      'VC team owns the roster and Finance owns the event — but not indefinitely.',
    fixSurface: 'exited',
    fixLabel: 'Open Exited',
  },
  {
    kind: 'lp-overdrawn',
    title: 'LP drawn beyond commitment',
    meaning:
      'Drawdowns on this position exceed the commitment in force. Recorded rather than refused, ' +
      'because it is a real state — a redrawn distribution, or a side letter nobody has keyed yet.',
    fixSurface: 'finance-lp',
    fixLabel: 'Open position',
  },
];

/**
 * The whole surface in one read.
 *
 * ONE QUERY FOR THE ROWS AND ONE FOR THE COUNTS, rather than nine. The counts
 * are not `rows.length` grouped in memory because the row list is capped —
 * a portfolio mid-backfill can legitimately have hundreds of unlinked cheques,
 * and a screen that silently truncates while its own summary agrees with the
 * truncation is a screen that reports progress it has not made.
 *
 * `CAN_READ`, not the Finance gate. Half of these are the VC team's to fix and
 * putting the list behind `CAN_WRITE_FINANCIAL` would hide the deal leads' own
 * queue from them — the same reason F4's Exited view became a tab rather than a
 * Finance surface.
 */
export async function readReconciliation(
  db: Kysely<DB>,
  principal: Principal,
  filters: { check?: string | null; limit?: number } = {},
): Promise<ReconciliationReport> {
  requireRole(principal, CAN_READ);

  const check = filters.check && filters.check !== 'all' ? filters.check : null;
  const limit = Math.min(Math.max(filters.limit ?? 500, 1), 2000);

  const [rowsResult, countsResult] = await Promise.all([
    sql<{
      check_kind: string; subject_table: string; subject_id: string;
      company_id: string | null; company_name: string; subject_label: string;
      subject_date: string | null; figure_a: string | null; figure_a_label: string | null;
      figure_b: string | null; figure_b_label: string | null; detail: string;
    }>`
      select check_kind, subject_table, subject_id, company_id, company_name,
             subject_label, subject_date::text as subject_date,
             figure_a::text as figure_a, figure_a_label,
             figure_b::text as figure_b, figure_b_label, detail
        from pc.v_reconciliation
       where (${check}::text is null or check_kind = ${check})
       order by check_kind, company_name, subject_date nulls last, subject_id
       limit ${limit}
    `.execute(db),
    sql<{ check_kind: string; open_items: string }>`
      select check_kind, open_items::text as open_items from pc.v_reconciliation_summary
    `.execute(db),
  ]);

  const counts = new Map(countsResult.rows.map((r) => [r.check_kind, Number(r.open_items)]));

  const checks: CheckDefinition[] = CHECKS.map((c) => ({
    ...c,
    openItems: counts.get(c.kind) ?? 0,
  }));

  /* A count the catalogue has no entry for. Reported rather than dropped: it
     means the view grew a check nobody added here, and silently ignoring it
     would make the summary disagree with the rows underneath it. */
  for (const [kind, open] of counts) {
    if (!checks.some((c) => c.kind === kind)) {
      checks.push({
        kind: kind as ReconciliationCheck,
        title: kind,
        meaning:
          'This check exists in v_reconciliation but not in the read path’s catalogue. ' +
          'Somebody added it to the view without describing it here.',
        fixSurface: 'deal-close',
        fixLabel: 'Open',
        openItems: open,
      });
    }
  }

  return {
    checks,
    rows: rowsResult.rows.map((r) => ({
      checkKind: r.check_kind as ReconciliationCheck,
      subjectTable: r.subject_table,
      subjectId: r.subject_id,
      companyId: r.company_id,
      companyName: r.company_name,
      subjectLabel: r.subject_label,
      subjectDate: r.subject_date,
      figureA: r.figure_a,
      figureALabel: r.figure_a_label,
      figureB: r.figure_b,
      figureBLabel: r.figure_b_label,
      detail: r.detail,
    })),
    totalOpen: [...counts.values()].reduce((a, b) => a + b, 0),
  };
}
