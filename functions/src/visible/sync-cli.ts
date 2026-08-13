/**
 * CLI wrapper around the Visible KPI sync.
 *
 *   npm run visible:sync            # read Visible, upsert, commit
 *   npm run visible:sync -- --dry   # read and map, report, then roll back
 *
 * Exits non-zero only on a genuine failure. Warnings are the expected output of
 * a sync against a live reporting platform -- a company that has not answered,
 * a domain the two systems spell differently, a headcount that breaks a
 * constraint -- and naming them is the deliverable.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg from 'pg';

import { createVisibleClient } from './client.js';
import { syncVisible } from './sync.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');

config({ path: path.resolve(REPO_ROOT, '.env') });
config();

const dryRun = process.argv.includes('--dry');

const token = process.env.VISIBLE_ACCESS_TOKEN;
const companyId = process.env.VISIBLE_COMPANY_ID;
if (!token || !companyId) {
  console.error('VISIBLE_ACCESS_TOKEN and VISIBLE_COMPANY_ID must both be set. See .env.example.');
  process.exit(1);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env at the repo root.');
  process.exit(1);
}

const vis = createVisibleClient(token);
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  const result = await syncVisible(client, vis, { companyId, dryRun });

  console.log(`\n${dryRun ? 'DRY RUN (rolled back)' : 'Visible KPI sync'} — started ${result.startedAt}`);
  console.log(
    `  ${result.profilesRead} Visible profile(s), ${result.companiesMatched} matched to the roster`,
  );
  console.log(`  ${result.dataPointsRead} data point(s) in ${result.apiCalls} API call(s)\n`);

  const width = Math.max(...Object.keys(result.counts).map((k) => k.length), 1);
  for (const [outcome, n] of Object.entries(result.counts).sort()) {
    console.log(`  ${outcome.padEnd(width)}  ${String(n).padStart(5)}`);
  }

  if (result.warnings.length === 0) {
    console.log('\nno warnings.');
  } else {
    const byKind = new Map<string, typeof result.warnings>();
    for (const w of result.warnings) {
      if (!byKind.has(w.kind)) byKind.set(w.kind, []);
      byKind.get(w.kind)!.push(w);
    }
    console.log(`\n${result.warnings.length} warning(s):`);
    for (const [kind, group] of byKind) {
      console.log(`\n  --- ${kind} (${group.length}) ---`);
      for (const w of group.slice(0, 20)) {
        console.log(`  [${w.subject}] ${w.field}`);
        console.log(`      ${w.detail}`);
      }
      if (group.length > 20) console.log(`  ... and ${group.length - 20} more`);
    }
  }
} finally {
  await client.end();
}
