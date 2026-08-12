/**
 * CLI wrapper around the Affinity sync.
 *
 *   npm run affinity:sync            # read Affinity, upsert, commit
 *   npm run affinity:sync -- --dry   # read and map, report, then roll back
 *
 * Exits non-zero only on a genuine failure. Warnings are the expected output of
 * a real sync against a live CRM -- an unresolvable VC Lead, a sector nobody has
 * added to Affinity's dropdown, a deal that vanished overnight -- and naming
 * them is the deliverable, exactly as the ADR-001 importer treats reconciliation.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg from 'pg';

import { createAffinityClient } from './client.js';
import { backfillClosedDates, syncFieldHistory } from './history.js';
import { syncAffinity } from './sync.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');

config({ path: path.resolve(REPO_ROOT, '.env') });
config();

const dryRun = process.argv.includes('--dry');

const apiKey = process.env.AFFINITY_API_KEY;
if (!apiKey) {
  console.error('AFFINITY_API_KEY is not set. See .env.example.');
  process.exit(1);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env at the repo root.');
  process.exit(1);
}

const af = createAffinityClient(apiKey);
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  const result = await syncAffinity(client, af, { dryRun });

  console.log(`\n${dryRun ? 'DRY RUN (rolled back)' : 'Affinity sync'} — started ${result.startedAt}`);
  console.log(`  ${result.entriesRead} list entries in ${result.apiCalls} API call(s)\n`);

  const width = Math.max(...Object.keys(result.counts).map((k) => k.length), 1);
  for (const [table, n] of Object.entries(result.counts).sort()) {
    console.log(`  ${table.padEnd(width)}  ${String(n).padStart(5)}`);
  }

  if (result.warnings.length === 0) {
    console.log('\nno warnings.');
  } else {
    // Grouped by kind so a run with 60 unresolved sectors does not bury the one
    // deal that was skipped entirely.
    const byKind = new Map<string, typeof result.warnings>();
    for (const w of result.warnings) {
      if (!byKind.has(w.kind)) byKind.set(w.kind, []);
      byKind.get(w.kind)!.push(w);
    }
    console.log(`\n${result.warnings.length} warning(s):`);
    for (const [kind, group] of byKind) {
      console.log(`\n  --- ${kind} (${group.length}) ---`);
      for (const w of group.slice(0, 15)) {
        console.log(`  [${w.subject}] ${w.field}`);
        console.log(`      ${w.detail}`);
      }
      if (group.length > 15) console.log(`  ... and ${group.length - 15} more`);
    }
  }

  // The change-log mirror runs after the roster, so a deal referenced by a
  // transition already exists. It is skipped on a dry run: it commits per
  // field and has no rollback semantics to offer.
  if (dryRun) {
    console.log('\nchange-log mirror skipped on a dry run.');
  } else {
    const history = await syncFieldHistory(client, af);
    console.log(
      `\nchange log (${history.mode}${history.since ? ` since ${history.since}` : ''}): ` +
        `${history.fetched} fetched, ${history.stored} stored, ${history.skipped} skipped, ` +
        `${history.apiCalls} API call(s)`,
    );

    // Depends on the change log, so it runs after it.
    const closed = await backfillClosedDates(client);
    console.log(`closed dates derived from the change log: ${closed} deal(s) updated`);
  }
} finally {
  await client.end();
}
