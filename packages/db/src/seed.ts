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

/**
 * The system principal.
 *
 * Every financial and mandate table carries `entered_by` / `created_by` NOT NULL
 * against app_user, so nothing loads until one exists. Automated writers -- the
 * ADR-001 importer, and the Affinity and Visible syncs at A4/A5 -- attribute to
 * this row rather than borrowing a person's identity, which keeps `audit_log`
 * honest about what a machine did versus what someone decided.
 *
 * The id is a fixed literal, not uuid_generate_v4(), so an import is
 * reproducible and a seeded database is byte-comparable with another one.
 *
 * `entra_object_id` is a sentinel: no Entra principal backs this row and none
 * should. The email is deliberately non-routable so it can never be mistaken
 * for a mailbox or resolve against the tenant (ADR-005 issues accounts to staff
 * only).
 */
const SYSTEM_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  entraObjectId: 'system:portfolio-command',
  displayName: 'Portfolio Command (system)',
  email: 'system@portfolio-command.invalid',
  role: 'admin',
} as const;

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

  await client.query(
    `insert into app_user (user_id, entra_object_id, display_name, email, role)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update
       set display_name = excluded.display_name,
           email        = excluded.email,
           role         = excluded.role,
           is_active    = true`,
    [
      SYSTEM_USER.id,
      SYSTEM_USER.entraObjectId,
      SYSTEM_USER.displayName,
      SYSTEM_USER.email,
      SYSTEM_USER.role,
    ],
  );

  // Optional local development principal. AUTH_MODE=dev resolves
  // DEV_PRINCIPAL_EMAIL against app_user, and a developer needs a row that is
  // NOT the system principal -- an automated writer and a person must stay
  // distinguishable in audit_log. Set DEV_ADMIN_EMAIL in .env to create one.
  // Nobody's address is committed here, and unset means no row.
  const devAdminEmail = process.env.DEV_ADMIN_EMAIL;
  if (devAdminEmail) {
    await client.query(
      `insert into app_user (entra_object_id, display_name, email, role)
       values ($1, $2, $3, 'admin')
       on conflict (email) do update set is_active = true, role = 'admin'`,
      [`dev:${devAdminEmail}`, devAdminEmail, devAdminEmail],
    );
  }

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
    select 'app_user' as t, count(*) from pc.app_user
    union all select 'ref_sector', count(*) from pc.ref_sector
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
