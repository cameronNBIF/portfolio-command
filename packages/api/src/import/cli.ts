/**
 * CLI wrapper around the ADR-001 importer.
 *
 *   npm run import:fixture              # loads docs/reference/demo.json
 *   npm run import:fixture -- path.json # loads any contract-shaped document
 *   npm run import:fixture -- --force   # load even over real synced data
 *
 * THIS COMMAND DESTROYS THE TARGET DATABASE BEFORE IT LOADS. `importContract`
 * truncates eight root tables with `cascade`, which is correct for what it
 * asserts -- that the contract reproduces itself out of an empty schema -- and
 * catastrophic when the target is the database someone is working in.
 *
 * A6 built `<database>_test` isolation after the round-trip TEST wiped the
 * development roster twice. That fixed the test path and left this one, which
 * issues the identical truncate against `DATABASE_URL` itself. It wiped the dev
 * database twice more during A8 before anyone worked out what was doing it --
 * the command reads as "load some demo data", and nothing about its name, its
 * output or its previous docstring suggested it would take the real roster,
 * five years of Visible history and the whole synthetic financial spine with it.
 *
 * So it now looks before it fires. The guard is not a confirmation prompt: this
 * runs unattended in CI, and a prompt is either skipped there or answered by
 * habit here. It is a positive check for data the fixture CANNOT put back, and
 * it names what it found.
 *
 * Exits non-zero only on a genuine failure. Reconciliation warnings are the
 * expected output of a real import (ADR-001, D-1) and do not fail the run --
 * the whole point is that the file loads and the discrepancies get named.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import type { PortfolioExport } from '@portfolio-command/contract';
import { requireDatabaseUrl } from '@portfolio-command/db/env';

import { importContract } from './import-contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.resolve(here, '../../../../docs/reference/demo.json');

const args = process.argv.slice(2);
const force = args.includes('--force');
const fileArg = args.find((a) => !a.startsWith('--'));

const target = fileArg ? path.resolve(fileArg) : DEFAULT_FIXTURE;
const doc = JSON.parse(readFileSync(target, 'utf8')) as PortfolioExport;

/**
 * ONE TRIGGER: has anything ever synced into this database from Affinity?
 *
 * `company.affinity_org_id` is the only exact discriminator available, and the
 * exactness is the whole point. The obvious richer checks are all wrong, and
 * each was tried and rejected against the real database:
 *
 *   - "the database is not empty" fires on a previous fixture load, which is
 *     the common and entirely safe case. A guard that cries wolf on the normal
 *     path gets routed around with --force out of habit, which is worse than no
 *     guard at all.
 *   - `company_kpi.source_system = 'visible'` fires on fixture data too: the
 *     column defaults to 'visible' and the importer does not override it.
 *   - `transaction.is_synthetic` likewise -- the fixture IS synthetic data and
 *     sets the flag, exactly as ADR-020 requires.
 *
 * The importer never writes `affinity_org_id` and the sync always does, so a
 * non-zero count means one thing only: the real roster is in here. Everything
 * else at risk -- Visible history, the generated financial spine, captured
 * rounds -- arrives downstream of that roster, so the single signal covers them
 * and they are reported rather than probed for.
 */
const connectionString = requireDatabaseUrl();
const dbName = new URL(connectionString).pathname.replace(/^\//, '');

// Said out loud, always, before anything is touched. This command truncates
// eight root tables, and "which database did that just run against" turned out
// to be the single hardest question to answer when it ran against the wrong one.
console.log(`target database: ${dbName}`);

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await client.query('set search_path = pc, public');

  const { rows: probe } = await client.query<{
    synced: number; kpis: number; txns: number; rounds: number;
  }>(`select (select count(*) from pc.company where affinity_org_id is not null)::int as synced,
             (select count(*) from pc.company_kpi)::int                              as kpis,
             (select count(*) from pc.transaction)::int                              as txns,
             (select count(*) from pc.investment_round)::int                         as rounds`);
  const p = probe[0]!;

  if (p.synced > 0) {
    const db = new URL(requireDatabaseUrl()).pathname.replace(/^\//, '');
    const lines = [
      `${String(p.synced).padStart(6)}  companies synced from Affinity`,
      `${String(p.kpis).padStart(6)}  quarterly KPI rows`,
      `${String(p.txns).padStart(6)}  transactions`,
      `${String(p.rounds).padStart(6)}  investment rounds`,
    ];

    if (!force) {
      console.error(`\nRefusing to import: "${db}" holds the real roster.\n`);
      for (const l of lines) console.error(`  ${l}`);
      console.error(
        '\nLoading a fixture truncates every root table first, so all of that would be lost.',
      );
      console.error('\nIf you meant to do it:');
      console.error('  npm run db:reset                     rebuild everything from scratch');
      console.error('  npm run import:fixture -- --force    overwrite, then re-sync by hand\n');
      console.error('If a fixture is already loaded BESIDE this roster and you want it gone:');
      console.error('  npm run fixture:purge -- --dry       show what would be removed');
      console.error('  npm run fixture:purge                remove it, leaving the roster\n');
      process.exit(1);
    }

    console.warn(`\n--force given. Overwriting the real roster in "${db}":\n`);
    for (const l of lines) console.warn(`  ${l}`);
    console.warn('\nRestore with: npm run db:reset\n');
  }

  await client.query('begin');
  await client.query('set local search_path = pc, public');

  const result = await importContract(client, doc);

  await client.query('commit');

  console.log(`\nimported ${path.relative(process.cwd(), target)}`);
  console.log(`  batch    ${result.batchId}`);
  console.log(`  as at    ${result.asOf}\n`);

  const width = Math.max(...Object.keys(result.counts).map((k) => k.length));
  for (const [table, n] of Object.entries(result.counts).sort()) {
    console.log(`  ${table.padEnd(width)}  ${String(n).padStart(5)}`);
  }

  if (result.warnings.length === 0) {
    console.log('\nno reconciliation warnings.');
  } else {
    console.log(`\n${result.warnings.length} reconciliation warning(s):\n`);
    for (const w of result.warnings) {
      console.log(`  [${w.kind}] ${w.subject}.${w.field}`);
      console.log(`      ${w.detail}`);
    }
  }
} catch (err) {
  await client.query('rollback').catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
