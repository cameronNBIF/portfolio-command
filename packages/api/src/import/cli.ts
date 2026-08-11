/**
 * CLI wrapper around the ADR-001 importer.
 *
 *   npm run import:fixture              # loads docs/reference/demo.json
 *   npm run import:fixture -- path.json # loads any contract-shaped document
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

const target = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FIXTURE;
const doc = JSON.parse(readFileSync(target, 'utf8')) as PortfolioExport;

const client = new pg.Client({ connectionString: requireDatabaseUrl() });
await client.connect();

try {
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
