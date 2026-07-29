/**
 * Reference-data seed. Idempotent: upserts on name, safe to re-run.
 *
 * Sources:
 * - ref_sector, ref_funnel_stage, ref_source_channel: docs/affinity-vocabularies.csv
 *   (the profiled Affinity vocabularies, "Proposed Target Value" column).
 * - ref_stage, ref_instrument: the prototype's constants
 *   (docs/reference/vc-toolkit.html STAGES / INSTRUMENTS, matching the
 *   comments in docs/schema.sql).
 * - ref_valuation_method: the six methods the prototype produces
 *   (decision recorded in BUILD-LOG.md, 2026-07-29).
 *
 * The CSV's `health` and `nb_region` sections are NOT seeded - those live as
 * CHECK constraints on company_state and company, not reference tables.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { requireDatabaseUrl } from './env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const csvPath = path.resolve(here, '../../../docs/affinity-vocabularies.csv');

// --- minimal RFC 4180 CSV parser (handles quoted fields, embedded commas
// --- and doubled quotes, e.g. `"C Grade ""At Risk"""`)
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // ignore blank lines
    if (row.length > 1 || (row[0] ?? '') !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

interface VocabRow {
  table: string;
  affinityValue: string;
  target: string;
  notes: string;
}

function readVocabulary(): VocabRow[] {
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  rows.shift(); // header: Reference Table,Affinity Value,Count,Proposed Target Value,Notes
  const out: VocabRow[] = [];
  let currentTable = '';
  for (const r of rows) {
    const [table = '', affinityValue = '', , target = '', notes = ''] = r;
    if (table !== '') currentTable = table;
    out.push({ table: currentTable, affinityValue, target, notes });
  }
  return out;
}

/**
 * Resolves the seedable names for one reference table.
 * - `(as listed)` expands the slash-separated Affinity value into one row each
 *   (Propel / Apex / AVF / ONB / AllNB).
 * - Other parenthesised targets are annotations, not values, and are skipped.
 *   That includes the `Network; Personal Outreach` multi-value row - both
 *   values already exist as their own rows here, but the Affinity SYNC loader
 *   (phase A4) must split Source of Deal on ';' when it encounters such rows.
 */
function targetsFor(vocab: VocabRow[], table: string): { name: string; notes: string }[] {
  const out: { name: string; notes: string }[] = [];
  for (const row of vocab.filter((r) => r.table === table)) {
    if (row.target === '(as listed)') {
      for (const name of row.affinityValue.split('/').map((s) => s.trim()).filter(Boolean)) {
        out.push({ name, notes: row.notes });
      }
    } else if (row.target.startsWith('(') || row.target === '') {
      continue;
    } else {
      out.push({ name: row.target, notes: row.notes });
    }
  }
  return out;
}

// --- fixed vocabularies (prototype constants, vc-toolkit.html:204-205)
const STAGES = ['Pre-Seed', 'Seed', 'Series A', 'Series B', 'Series C+', 'Growth'];
const INSTRUMENTS = ['SAFE', 'Convertible Note', 'Debt-to-Note', 'Preferred Equity', 'Common Equity'];
const VALUATION_METHODS = [
  'Last round',
  'Revenue multiple',
  'Calibrated last round',
  'Scenario-weighted',
  'Write-off',
  'Realized',
];

const vocab = readVocabulary();
const sectors = targetsFor(vocab, 'ref_sector');
const sourceChannels = targetsFor(vocab, 'ref_source_channel');

// TODO(A4 · Affinity sync): ref_funnel_stage must eventually be seeded from
// Affinity's Status field dropdown-option METADATA, not from this CSV of
// observed values - ranks 2, 8, 9 and 11 exist in the field configuration but
// were never observed in the data, so they are missing here (ADR-009;
// BUILD-LOG 2026-07-29 outstanding item). Sort order below is the CSV row
// order, which matches the "Sort N" annotations in its Notes column.
const funnelStages = targetsFor(vocab, 'ref_funnel_stage').map((s, i) => ({
  ...s,
  sortOrder: i + 1,
  isTerminal: /terminal/i.test(s.notes),
}));

const client = new pg.Client({ connectionString: requireDatabaseUrl() });
await client.connect();

try {
  await client.query('begin');
  await client.query('set local search_path = pc, public');

  for (const [i, s] of sectors.entries()) {
    await client.query(
      `insert into ref_sector (name, sort_order) values ($1, $2)
       on conflict (name) do update set sort_order = excluded.sort_order, is_active = true`,
      [s.name, i + 1],
    );
  }

  for (const f of funnelStages) {
    await client.query(
      `insert into ref_funnel_stage (name, sort_order, is_terminal) values ($1, $2, $3)
       on conflict (name) do update set sort_order = excluded.sort_order, is_terminal = excluded.is_terminal`,
      [f.name, f.sortOrder, f.isTerminal],
    );
  }

  for (const c of sourceChannels) {
    await client.query(
      `insert into ref_source_channel (name) values ($1)
       on conflict (name) do update set is_active = true`,
      [c.name],
    );
  }

  for (const [i, name] of STAGES.entries()) {
    await client.query(
      `insert into ref_stage (name, sort_order) values ($1, $2)
       on conflict (name) do update set sort_order = excluded.sort_order`,
      [name, i + 1],
    );
  }

  for (const name of INSTRUMENTS) {
    await client.query(`insert into ref_instrument (name) values ($1) on conflict (name) do nothing`, [name]);
  }

  for (const name of VALUATION_METHODS) {
    await client.query(
      `insert into ref_valuation_method (name) values ($1)
       on conflict (name) do update set is_active = true`,
      [name],
    );
  }

  await client.query('commit');

  const counts = await client.query(`
    select 'ref_sector' as t, count(*) from pc.ref_sector
    union all select 'ref_funnel_stage', count(*) from pc.ref_funnel_stage
    union all select 'ref_source_channel', count(*) from pc.ref_source_channel
    union all select 'ref_stage', count(*) from pc.ref_stage
    union all select 'ref_instrument', count(*) from pc.ref_instrument
    union all select 'ref_valuation_method', count(*) from pc.ref_valuation_method`);
  for (const r of counts.rows) console.log(`${String(r.t).padEnd(22)} ${r.count} rows`);
} catch (err) {
  await client.query('rollback').catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
