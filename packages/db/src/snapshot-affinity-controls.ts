/**
 * F0 · Freezes Affinity's pre-cutover control totals (ADR-039, FR-02, Q-17).
 *
 *   npm run snapshot:affinity-controls           take it, or fail saying why
 *   npm run snapshot:affinity-controls -- --dry  check the totals, write nothing
 *   npm run snapshot:affinity-controls -- --show print the stored snapshot
 *
 * WHY THIS EXISTS, in one paragraph, because the script is trivial and the
 * reason is not.
 *
 * `company.affinity_total_investment` and `company.affinity_fmv` do three jobs
 * at once. They are the A6 generator's reconciliation anchor -- the synthetic
 * spine is asserted against them per company, to the cent (ADR-030). They are
 * the agreed A13 control totals. And, per Q-17, they are the fields the
 * platform will OVERWRITE with its own calculated figure at cutover, after
 * which they become read-only in Affinity and the platform stops reading them.
 *
 * The third job destroys the other two. After the outbound write, reconciling
 * against those columns proves nothing: the platform would be checking its
 * arithmetic against its own output and would agree with itself perfectly while
 * being wrong. A13 has to tie to a copy taken before the write, and the only
 * safe moment to take that copy is one that has already passed by the time
 * anyone remembers to. So it is taken at F0, months ahead of the phase that
 * needs it.
 *
 * WHY IT IS A SCRIPT RATHER THAN PART OF MIGRATION 0006. Migrations run against
 * an empty database in CI and against a freshly created one in the test
 * harness, where there are no companies and nothing to freeze. Embedded there,
 * the populate step would either do nothing silently in those environments or
 * fail the build in them -- and neither is what "assert the totals reconcile to
 * the cent" is supposed to mean. The migration creates the table; this fills it,
 * once, against a database that actually holds the roster.
 *
 * WHY IT REFUSES RATHER THAN UPSERTS. A baseline that quietly restates itself
 * on a second run is not a baseline. If the figures have moved since the
 * snapshot was taken, that is a fact worth stopping over -- possibly a real
 * Affinity correction, possibly the sync having done something unexpected --
 * and the right response is a person looking at it, not a script overwriting
 * the anchor. The table's own unique index enforces the same thing one level
 * down, and migration 0006 puts an immutability trigger under both.
 */
import pg from 'pg';

import { loadEnv, requireDatabaseUrl } from './env.js';

loadEnv();

const DRY = process.argv.includes('--dry');
const SHOW = process.argv.includes('--show');

/**
 * The label for the snapshot A13 reconciles to. A second label is a legitimate
 * thing to want -- a re-take after F4 widens the roster, say -- and it must be
 * a new set of rows rather than an edit to these.
 */
const LABEL = 'pre-cutover baseline';

/**
 * THE AGREED CONTROL TOTALS, in dollars and to the cent.
 *
 * Not a sanity check on arithmetic -- these are the figures the VC team already
 * knows, that A6 reconciles the entire synthetic spine against per company
 * (ADR-030, BUILD-LOG 2026-08-14), and that Track B agreed with Finance as the
 * A13 targets. Hardcoded deliberately rather than read from the database it is
 * about to snapshot: a baseline that derives its own expected value from its
 * own input cannot detect that the input drifted, which is the one thing this
 * assertion is for.
 *
 * If these ever legitimately move -- F4's discovery step could widen the roster
 * and would be the first plausible cause -- change them here, in a commit that
 * says why, and take a new snapshot under a new label. Do not edit the stored
 * rows.
 */
const EXPECTED_TOTAL_INVESTMENT = '47216678.00';
const EXPECTED_FMV = '42030272.00';

/** The generator's principal, and the right author for a machine-taken baseline. */
const SYSTEM_USER = '00000000-0000-0000-0000-000000000001';

const client = new pg.Client({ connectionString: requireDatabaseUrl() });
await client.connect();

const fmt = (v: string | null) =>
  v === null ? '(none)' : `$${Number(v).toLocaleString('en-CA', { minimumFractionDigits: 2 })}`;

try {
  if (SHOW) {
    const { rows } = await client.query<{
      taken_at: string; taken_by: string; companies: string;
      total_investment: string | null; fmv: string | null;
    }>(
      `select min(s.taken_at)::text                as taken_at,
              min(u.display_name)                  as taken_by,
              count(*)::text                       as companies,
              sum(s.total_investment)::text        as total_investment,
              sum(s.fmv)::text                     as fmv
         from pc.affinity_control_snapshot s
         join pc.app_user u on u.user_id = s.taken_by
        where s.snapshot_label = $1`,
      [LABEL],
    );
    const r = rows[0]!;
    if (r.companies === '0') {
      console.log(`No snapshot stored under "${LABEL}".`);
    } else {
      console.log(`Snapshot "${LABEL}"`);
      console.log(`  taken            ${r.taken_at} by ${r.taken_by}`);
      console.log(`  companies        ${r.companies}`);
      console.log(`  total investment ${fmt(r.total_investment)}`);
      console.log(`  FMV              ${fmt(r.fmv)}`);
    }
    process.exit(0);
  }

  // --- refuse before doing any work if the baseline already exists ---------
  const { rows: existing } = await client.query<{ n: string }>(
    'select count(*)::text as n from pc.affinity_control_snapshot where snapshot_label = $1',
    [LABEL],
  );
  if (existing[0]!.n !== '0') {
    console.error(
      `A snapshot already exists under "${LABEL}" (${existing[0]!.n} rows). This table is ` +
        'write-once (ADR-039): it is the pre-cutover baseline A13 reconciles against, and a ' +
        'baseline that restates itself is not one.\n' +
        'Run with --show to see it. To take a different one, use a new label in a commit that ' +
        'says why.',
    );
    process.exit(1);
  }

  // --- what we are about to freeze ----------------------------------------
  const { rows: totals } = await client.query<{
    companies: string; with_investment: string; with_fmv: string;
    total_investment: string | null; fmv: string | null; as_of: string | null;
  }>(
    `select count(*)::text                                        as companies,
            count(affinity_total_investment)::text                as with_investment,
            count(affinity_fmv)::text                             as with_fmv,
            coalesce(sum(affinity_total_investment), 0)::text     as total_investment,
            coalesce(sum(affinity_fmv), 0)::text                  as fmv,
            max(affinity_figures_as_of)::text                     as as_of
       from pc.company`,
  );
  const t = totals[0]!;

  console.log(`Companies                 ${t.companies}`);
  console.log(`  carrying an investment  ${t.with_investment}`);
  console.log(`  carrying an FMV         ${t.with_fmv}`);
  console.log(`Affinity figures as of    ${t.as_of ?? '(unknown)'}`);
  console.log(`Total investment          ${fmt(t.total_investment)}`);
  console.log(`FMV                       ${fmt(t.fmv)}`);

  // --- the assertion, before anything is written ---------------------------
  //
  // Compared as strings against numeric(18,2) sums rather than as JavaScript
  // numbers. `47216678.00` is exactly representable and this particular
  // comparison would survive a float round trip, but the rule in this codebase
  // is that money never becomes a float on the way to a decision, and a control
  // total is the last place to make an exception (ADR-021).
  const problems: string[] = [];
  if (t.total_investment !== EXPECTED_TOTAL_INVESTMENT) {
    problems.push(
      `total investment is ${fmt(t.total_investment)}, expected ${fmt(EXPECTED_TOTAL_INVESTMENT)}`,
    );
  }
  if (t.fmv !== EXPECTED_FMV) {
    problems.push(`FMV is ${fmt(t.fmv)}, expected ${fmt(EXPECTED_FMV)}`);
  }
  if (problems.length > 0) {
    console.error(
      `\nRefusing to write. The roster no longer sums to the agreed control totals:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n\nThis is not necessarily an error -- a correction in Affinity moves these, and F4 ' +
        'could widen the roster deliberately. It is a fact that needs a person to look at it ' +
        'before the A13 baseline is frozen against it. If the new figures are right, update ' +
        'EXPECTED_TOTAL_INVESTMENT and EXPECTED_FMV in this file in a commit that says why.',
    );
    process.exit(1);
  }
  console.log('\nReconciles to the agreed control totals, to the cent.');

  if (DRY) {
    console.log('--dry: nothing written.');
    process.exit(0);
  }

  // --- freeze --------------------------------------------------------------
  await client.query('begin');
  const { rowCount } = await client.query(
    `insert into pc.affinity_control_snapshot
       (snapshot_label, taken_by, company_id, affinity_org_id, company_name,
        total_investment, fmv, note)
     select $1, $2::uuid, c.company_id, c.affinity_org_id, c.name,
            c.affinity_total_investment, c.affinity_fmv,
            'Frozen at F0 before any outbound write to Affinity (ADR-039). Affinity figures as of '
              || coalesce(c.affinity_figures_as_of::text, 'unknown') || '.'
       from pc.company c
      order by c.company_id`,
    [LABEL, SYSTEM_USER],
  );
  await client.query('commit');

  console.log(`Froze ${rowCount} companies under "${LABEL}". This table is now write-once.`);
} catch (err) {
  await client.query('rollback').catch(() => {});
  throw err;
} finally {
  await client.end();
}
