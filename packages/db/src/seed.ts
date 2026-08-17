/**
 * Reference-data seed. Idempotent: upserts on name, safe to re-run.
 *
 * Sources:
 * - ref_sector, ref_source_channel, affinity_status_map keys:
 *   docs/affinity-vocabularies-v2.json, a committed snapshot of Affinity's
 *   dropdown-option METADATA taken by `npm run affinity:vocab`. ADR-009 wants
 *   the vocabulary to come from the field configuration rather than from
 *   observed values, because options exist that no row has ever used -- four
 *   of Affinity's sixteen Status ranks were unobserved in the July exports and
 *   all four are real.
 * - ref_funnel_stage: Affinity's sixteen Status options WITH THEIR RANKS, from
 *   the same snapshot, plus four fixture-only names. ref_funnel_group is the
 *   prototype's board columns (vc-toolkit.html:206 plus "Passed") and
 *   Watchlist. See the notes on each below.
 * - ref_stage, ref_instrument: the prototype's constants
 *   (docs/reference/vc-toolkit.html STAGES / INSTRUMENTS, matching the
 *   comments in docs/schema.sql).
 * - ref_valuation_method: the six methods the prototype produces
 *   (decision recorded in BUILD-LOG.md, 2026-07-29).
 *
 * The snapshot is a file rather than a live call because `db:seed` must run
 * offline -- CI's database job has no Affinity key -- and must be
 * deterministic, or the idempotency assertion is checking nothing.
 *
 * docs/affinity-vocabularies.csv is NO LONGER READ HERE. It was the July
 * profiling of observed values and is superseded by the v2 snapshot; it
 * remains as a document for the health and nb_region mappings, which live as
 * CHECK constraints rather than reference tables.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv, requireDatabaseUrl } from './env.js';
import { fundIdentity } from './fund-identity.js';

// BEFORE any module-level process.env read below. See loadEnv's note.
loadEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.resolve(here, '../../../docs/affinity-vocabularies-v2.json');
const rosterPath = path.resolve(here, '../data/app_user.json');

interface VocabularySnapshot {
  generatedAt: string;
  listId: number;
  fields: Record<string, { fieldId: string; valueType: string; options: { id: number; text: string; rank?: number }[] }>;
}

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as VocabularySnapshot;

interface RosterUser {
  entra_object_id: string;
  display_name: string;
  email: string;
  role: string;
  is_active: boolean;
}
const roster = (JSON.parse(readFileSync(rosterPath, 'utf8')) as { users: RosterUser[] }).users;

function optionsFor(key: string): { id: number; text: string; rank?: number }[] {
  const field = snapshot.fields[key];
  if (!field) throw new Error(`affinity-vocabularies-v2.json has no "${key}" field. Re-run: npm run affinity:vocab`);
  return field.options;
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

/**
 * NBIF's three investment vehicles (ADR-030).
 *
 * The codes are what the team says and what the Affinity export's `Fund` column
 * carries. The long names are expanded here and nowhere else, so a screen never
 * has to decide what "SIF" stands for.
 *
 * NOT sourced from the Affinity vocabulary snapshot, because `Fund` is not in
 * Affinity's profiled field metadata at all -- see
 * packages/db/data/investment_vehicle.json.
 */
const INVESTMENT_VEHICLES = [
  { code: 'VCF', name: 'Venture Capital Fund', sortOrder: 1 },
  { code: 'SIF', name: 'Startup Investment Fund', sortOrder: 2 },
  { code: 'ACC', name: 'Accelerator Investments', sortOrder: 3 },
];

/**
 * The board's display bins. These are the prototype's columns (ADR-014) plus
 * Watchlist.
 *
 * Watchlist is the one addition and it is not cosmetic: it is the LARGEST
 * single bucket in Affinity at 114 of 347, and it appears in neither CSV
 * export, so it was invisible when the prototype was built. Terminal, because
 * watchlisted companies are parked rather than worked -- folding them into
 * Sourced would take "Active Deals" from ~84 to ~198.
 */
const FUNNEL_GROUPS: { name: string; isTerminal: boolean; showOnBoard: boolean }[] = [
  { name: 'Sourced', isTerminal: false, showOnBoard: true },
  { name: 'Screening', isTerminal: false, showOnBoard: true },
  { name: 'Diligence', isTerminal: false, showOnBoard: true },
  { name: 'IC Review', isTerminal: false, showOnBoard: true },
  { name: 'Term Sheet', isTerminal: false, showOnBoard: true },
  // Terminal but still a column: a closed deal is an outcome worth seeing.
  { name: 'Closed', isTerminal: true, showOnBoard: true },
  // Listed beneath the board, so dead and parked deals take no board space.
  { name: 'Passed', isTerminal: true, showOnBoard: false },
  { name: 'Watchlist', isTerminal: true, showOnBoard: false },
];

/**
 * Affinity's sixteen Status values ARE the funnel. They are the vocabulary the
 * investment team speaks, so the platform stores a deal's exact position
 * rather than a bin, and nothing is lost between the two systems (decision,
 * 12 Aug 2026). `sort_order` is Affinity's own rank, taken from the field
 * metadata snapshot rather than typed here.
 *
 * The grouping below is MONOTONIC in that rank -- a deal moving forward in
 * Affinity never moves backwards on the board. That is what rules out the
 * otherwise tempting Team Pitch -> IC Review: Team Pitch is rank 6, before
 * Diligence at 7, while IC Review sits after Diligence on the board, so a deal
 * would appear to regress on entering diligence.
 *
 * Note there is no Affinity Status of "Closed" in the live data at all -- deals
 * go Approved straight to Portfolio -- so the board's Closed column is fed by
 * Portfolio and Exited rather than by a status of the same name.
 */
const STATUS_TO_GROUP: Record<string, string> = {
  'New': 'Sourced',
  'Intake': 'Sourced',
  'Reached Out': 'Screening',
  'First Meeting': 'Screening',
  'Second Meeting': 'Screening',
  'Team Pitch': 'Screening',
  'Diligence': 'Diligence',
  'Conditional Approval': 'IC Review',
  'Approved': 'IC Review',
  'With Legal': 'Term Sheet',
  'Closed': 'Closed',
  'Portfolio': 'Closed',
  'Exited': 'Closed',
  'Did Not Agree to Terms': 'Passed',
  'Passed': 'Passed',
  'Watchlist': 'Watchlist',
};

/**
 * Four stage names exist ONLY in docs/reference/demo.json and have no Affinity
 * equivalent. They are seeded so the reference fixture keeps loading against a
 * NOT NULL funnel_stage_id while it is still the financial dataset, and they
 * are DELETED when A6 retires its pipeline section. Marked `prototype-fixture`
 * so that deletion is a one-line query rather than an archaeology exercise.
 *
 * The fixture's other three values -- Diligence, Closed, Passed -- are real
 * Affinity statuses and need no row of their own.
 */
const FIXTURE_ONLY_STAGES: { name: string; group: string }[] = [
  { name: 'Sourced', group: 'Sourced' },
  { name: 'Screening', group: 'Screening' },
  { name: 'IC Review', group: 'IC Review' },
  { name: 'Term Sheet', group: 'Term Sheet' },
];

/**
 * The fund row.
 *
 * `fund` is CONFIGURATION, not financial history: the vehicle's name, style,
 * inception year and fiscal calendar are facts about NBIF that no amount of
 * Finance data will supply. Seeding it is what lets the platform run on a real
 * Affinity roster before A6's financial spine exists -- without a fund row the
 * export contract has no valid document and every page throws.
 *
 * MOVED TO `fund-identity.ts` at A8.2, unchanged, because `fixture:purge` has to
 * restore exactly what this creates. The rationale for every field is there.
 */
const FUND = fundIdentity();

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

  /**
   * NBIF staff (packages/db/data/app_user.json).
   *
   * IDENTITY is re-asserted every seed -- a corrected spelling or a changed
   * address propagates. AUTHORISATION is not: `role` and `is_active` apply when
   * the row is CREATED and are never overwritten. That is ADR-005's position,
   * and the A3 decision that "changing someone's role is a database update
   * rather than a tenant change"; a seed that re-asserted role would silently
   * revert an operator's change on the next run.
   *
   * display_name is load-bearing beyond display: the A4 Affinity sync resolves
   * deal leads and owners on it (Affinity merges Person entities, so their
   * email addresses are not reliably the @nbif.ca ones).
   */
  for (const u of roster) {
    await client.query(
      `insert into app_user (entra_object_id, display_name, email, role, is_active)
       values ($1,$2,$3,$4,$5)
       on conflict (email) do update set
         entra_object_id = excluded.entra_object_id,
         display_name    = excluded.display_name`,
      [u.entra_object_id, u.display_name, u.email, u.role, u.is_active],
    );
  }

  // Optional local development principal. AUTH_MODE=dev resolves
  // DEV_PRINCIPAL_EMAIL against app_user, and a developer needs a row that is
  // NOT the system principal -- an automated writer and a person must stay
  // distinguishable in audit_log.
  //
  // Only creates a row when the address is NOT already in the roster. It used
  // to force role='admin' on conflict, which would have quietly promoted a
  // roster member to admin just because a developer had set DEV_ADMIN_EMAIL to
  // their own address -- and it wrote display_name = the email, which would
  // have broken the sync's name resolution for that person.
  const devAdminEmail = process.env.DEV_ADMIN_EMAIL;
  if (devAdminEmail && !roster.some((u) => u.email.toLowerCase() === devAdminEmail.toLowerCase())) {
    await client.query(
      `insert into app_user (entra_object_id, display_name, email, role)
       values ($1, $2, $3, 'admin')
       on conflict (email) do update set is_active = true`,
      [`dev:${devAdminEmail}`, devAdminEmail, devAdminEmail],
    );
  }

  // Affinity's Priority Sector, verbatim. THE taxonomy the mandate is framed
  // in; no sectors are invented to absorb the Other population (ADR-009).
  for (const [i, o] of optionsFor('prioritySector').entries()) {
    await client.query(
      `insert into ref_sector (name, sort_order) values ($1, $2)
       on conflict (name) do update set sort_order = excluded.sort_order, is_active = true`,
      [o.text, i + 1],
    );
  }

  for (const [i, g] of FUNNEL_GROUPS.entries()) {
    await client.query(
      `insert into ref_funnel_group (name, sort_order, is_terminal, show_on_board) values ($1, $2, $3, $4)
       on conflict (name) do update
         set sort_order    = excluded.sort_order,
             is_terminal   = excluded.is_terminal,
             show_on_board = excluded.show_on_board`,
      [g.name, i + 1, g.isTerminal, g.showOnBoard],
    );
  }

  // Every Affinity Status option must have a group, or the sync silently drops
  // deals. Checked BEFORE writing anything, so a new Affinity status fails the
  // seed loudly rather than being discovered at 2am by the nightly run.
  const ungrouped = optionsFor('status')
    .map((o) => o.text)
    .filter((t) => !(t in STATUS_TO_GROUP));
  if (ungrouped.length) {
    throw new Error(
      `Affinity Status options with no display group: ${ungrouped.join(', ')}.\n` +
        'Add them to STATUS_TO_GROUP in this file, or re-bin them in ref_funnel_stage after seeding.',
    );
  }

  // sort_order is Affinity's own rank, from the metadata snapshot.
  for (const o of optionsFor('status')) {
    await client.query(
      `insert into ref_funnel_stage (name, funnel_group_id, sort_order, source)
       select $1, funnel_group_id, $3, 'affinity' from ref_funnel_group where name = $2
       on conflict (name) do update
         set funnel_group_id = excluded.funnel_group_id,
             sort_order      = excluded.sort_order,
             source          = excluded.source`,
      [o.text, STATUS_TO_GROUP[o.text], o.rank ?? 0],
    );
  }

  for (const s of FIXTURE_ONLY_STAGES) {
    await client.query(
      `insert into ref_funnel_stage (name, funnel_group_id, sort_order, source)
       select $1, funnel_group_id, 0, 'prototype-fixture' from ref_funnel_group where name = $2
       on conflict (name) do nothing`,
      [s.name, s.group],
    );
  }

  // Affinity's Source of Deal, verbatim. It currently carries five options for
  // one channel (Porfolio Intro / Portfolio company / Portfolio Company /
  // Portfolio Company Introduction / Portfolio Introduction); those are being
  // merged in Affinity, which is system of record, rather than mapped around
  // here (decision, 12 Aug 2026). Re-run `npm run affinity:vocab` and re-seed
  // once that lands.
  for (const o of optionsFor('sourceOfDeal')) {
    await client.query(
      `insert into ref_source_channel (name) values ($1)
       on conflict (name) do update set is_active = true`,
      [o.text],
    );
  }

  // affinity_status_map is now an identity mapping, and still earns its place.
  // ADR-009 requires the Affinity-status-to-stage resolution to be a table
  // rather than code so that a change is a row edit; what that buys once the
  // vocabularies agree is a place to route a RENAMED or newly-added status
  // onto an existing stage without a deploy. The sync resolves through here,
  // never by matching text against ref_funnel_stage directly.
  for (const o of optionsFor('status')) {
    await client.query(
      `insert into affinity_status_map (affinity_status, funnel_stage_id)
       select $1, funnel_stage_id from ref_funnel_stage where name = $1
       on conflict (affinity_status) do update
         set funnel_stage_id = excluded.funnel_stage_id, updated_at = now()`,
      [o.text],
    );
  }

  // Created once and then left alone: an operator editing the fund's identity
  // in the application must not have it reverted by the next seed. Only the
  // fiscal calendar and style are re-asserted, because both are architectural
  // (ADR-006, and "confirmed evergreen" in docs/field-inventory.csv).
  await client.query(
    `insert into fund (name, style, reporting_currency, inception_year,
                       fiscal_year_start_month, annual_platform_target)
     select $1, $2, $3, coalesce($4::int, extract(year from current_date)::int), $5, $6
      where not exists (select 1 from fund)`,
    [
      FUND.name,
      FUND.style,
      FUND.currency,
      FUND.inceptionYear,
      FUND.fiscalYearStartMonth,
      FUND.annualPlatformTarget,
    ],
  );

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

  for (const v of INVESTMENT_VEHICLES) {
    await client.query(
      `insert into ref_investment_vehicle (code, name, sort_order) values ($1, $2, $3)
       on conflict (code) do update
         set name = excluded.name, sort_order = excluded.sort_order, is_active = true`,
      [v.code, v.name, v.sortOrder],
    );
  }

  await client.query('commit');

  const counts = await client.query(`
    select 'app_user' as t, count(*) from pc.app_user
    union all select 'ref_sector', count(*) from pc.ref_sector
    union all select 'ref_funnel_group', count(*) from pc.ref_funnel_group
    union all select 'ref_funnel_stage', count(*) from pc.ref_funnel_stage
    union all select 'affinity_status_map', count(*) from pc.affinity_status_map
    union all select 'ref_source_channel', count(*) from pc.ref_source_channel
    union all select 'ref_stage', count(*) from pc.ref_stage
    union all select 'ref_instrument', count(*) from pc.ref_instrument
    union all select 'ref_valuation_method', count(*) from pc.ref_valuation_method
    union all select 'ref_investment_vehicle', count(*) from pc.ref_investment_vehicle`);
  for (const r of counts.rows) console.log(`${String(r.t).padEnd(22)} ${r.count} rows`);
  console.log(`\nvocabulary snapshot taken ${snapshot.generatedAt}`);

  const { rows: fundRows } = await client.query<{ name: string; inception_year: number }>(
    'select name, inception_year from pc.fund order by fund_id limit 1',
  );
  const fund = fundRows[0];
  const provisional: string[] = [];
  if (!process.env.FUND_NAME) provisional.push('FUND_NAME');
  if (!process.env.FUND_INCEPTION_YEAR) provisional.push('FUND_INCEPTION_YEAR');
  if (fund && provisional.length) {
    console.log(
      `\n  !! FUND IDENTITY IS PROVISIONAL: "${fund.name}", inception ${fund.inception_year}.\n` +
        `     Set ${provisional.join(' and ')} in .env and update the row. These render on\n` +
        '     board-facing screens; the seed will not overwrite an existing fund row.',
    );
  }
} catch (err) {
  await client.query('rollback').catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
