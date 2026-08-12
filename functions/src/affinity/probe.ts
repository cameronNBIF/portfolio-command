/**
 * A4 step 1 — read-only reconnaissance against Affinity API v2.
 *
 * Answers the questions A4 cannot be designed without, empirically rather than
 * from the documentation:
 *
 *   1. Does the key work against v2 at all, on this plan tier?
 *   2. What fields does list 328745 actually expose, and under which of the
 *      four v2 field types? (The v1 /fields payload omits relationship-
 *      intelligence and enriched fields entirely, which is why seven columns
 *      came back as errors in the earlier v1 mapping.)
 *   3. Do the Pipeline and Portfolio saved views exist as addressable ids?
 *   4. What is the full dropdown vocabulary per field, WITH rank -- the input
 *      ADR-009 requires for seeding ref_funnel_stage from metadata rather than
 *      from observed values?
 *   5. Is the CSV export's "Organization Id" the same namespace as the v2
 *      entity.id? (Open question in ADR-009 and BUILD-LOG.)
 *   6. Is /v2/field-value-changes account-wide and filterable, or per-entry?
 *   7. What does a nightly sync actually cost in API calls?
 *
 * Writes nothing to Affinity and nothing to the database. Usage:
 *
 *   npm run affinity:probe
 *   npm run affinity:probe -- --full            # paginate every entry, report fill rates
 *   npm run affinity:probe -- --csv <pipeline.csv> <portfolio.csv>
 *
 * The dump lands in functions/.probe/ (gitignored) because it contains the
 * real roster: CEO names, personal email addresses, deal stages.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

import {
  AffinityError,
  createAffinityClient,
  NBIF_MASTER_LIST_ID,
  type DropdownOption,
  type FieldMeta,
  type ListEntry,
  type ListMeta,
  type SavedView,
} from './client.js';

const ALL_FIELD_TYPES = ['enriched', 'global', 'list', 'relationship-intelligence'] as const;
const DROPDOWN_VALUE_TYPES = ['dropdown', 'dropdown-multi', 'ranked-dropdown', 'status-dropdown'];

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');
const OUT_DIR = path.resolve(REPO_ROOT, 'functions/.probe');

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const full = args.includes('--full');
const csvPaths = args.slice(args.indexOf('--csv') + 1).filter((a) => a.endsWith('.csv'));

config({ path: path.resolve(REPO_ROOT, '.env') });
config();

const apiKey = process.env.AFFINITY_API_KEY;
if (!apiKey) {
  console.error(
    'AFFINITY_API_KEY is not set. Copy .env.example to .env at the repo root and fill it in.\n' +
      'It must be a v2-capable key: Affinity Settings -> Manage Apps. A v1 key will 401 here.',
  );
  process.exit(1);
}

const af = createAffinityClient(apiKey);
const report: Record<string, unknown> = { probedAt: new Date().toISOString() };

// ---------------------------------------------------------------------------
// Minimal CSV reader. Only the header row and three columns are needed.
// ---------------------------------------------------------------------------

function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsv(file: string): { headers: string[]; rows: Record<string, string>[] } {
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvRow(lines[0]!);
  const rows = lines.slice(1).map((line) => {
    const cells = parseCsvRow(line);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])) as Record<string, string>;
  });
  return { headers, rows };
}

/** 'VC Lead (Email)' and 'VC Lead (Full Name)' are one Affinity field. */
function baseColumnName(header: string): string {
  return header.replace(/\s*\((Full Name|Email|Country|State|City|Address)\)$/i, '').trim();
}

function heading(n: number, title: string): void {
  console.log(`\n${'='.repeat(72)}\n${n}. ${title}\n${'='.repeat(72)}`);
}

// ---------------------------------------------------------------------------

try {
  // 1 -----------------------------------------------------------------------
  heading(1, 'Authentication and list identity');

  const lists = await af.collect<ListMeta>('/lists');
  const master = lists.find((l) => l.id === NBIF_MASTER_LIST_ID);
  console.log(`v2 reachable. ${lists.length} list(s) visible to this key.`);
  if (!master) {
    console.error(
      `\nList ${NBIF_MASTER_LIST_ID} (NBIF Master) is NOT visible to this key. Visible lists:`,
    );
    for (const l of lists) console.log(`  ${l.id}  ${l.name}`);
    process.exit(1);
  }
  console.log(`List ${master.id}: "${master.name}" (type ${master.type})`);
  report.list = master;
  report.allLists = lists.map((l) => ({ id: l.id, name: l.name, type: l.type }));

  // 2 -----------------------------------------------------------------------
  heading(2, 'Saved views — are Pipeline and Portfolio addressable?');

  const views = await af.collect<SavedView>(`/lists/${NBIF_MASTER_LIST_ID}/saved-views`);
  for (const v of views) console.log(`  ${String(v.id).padEnd(10)} ${v.name.padEnd(28)} ${v.type}`);
  report.savedViews = views;

  const missing = ['Pipeline', 'Portfolio'].filter(
    (n) => !views.some((v) => v.name.toLowerCase() === n.toLowerCase()),
  );
  if (missing.length) console.log(`\n  NOTE: no saved view named ${missing.join(' or ')}.`);

  // 3 -----------------------------------------------------------------------
  heading(3, 'Field metadata — the v2 replacement for the v1 /fields mapping');

  const fields = await af.collect<FieldMeta>(`/lists/${NBIF_MASTER_LIST_ID}/fields`);
  report.fields = fields;

  const byType = new Map<string, FieldMeta[]>();
  for (const f of fields) {
    const bucket = byType.get(f.type) ?? [];
    bucket.push(f);
    byType.set(f.type, bucket);
  }
  for (const type of ALL_FIELD_TYPES) {
    const group = (byType.get(type) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    console.log(`\n  --- ${type} (${group.length}) ---`);
    for (const f of group) {
      const src = f.enrichmentSource ? `  [${f.enrichmentSource}]` : '';
      console.log(`  ${f.id.padEnd(38)} ${f.name.padEnd(34)} ${f.valueType}${src}`);
    }
  }

  // 4 -----------------------------------------------------------------------
  heading(4, 'Dropdown vocabularies with rank (ADR-009: seed from metadata)');

  const dropdowns: Record<string, DropdownOption[]> = {};
  for (const f of fields.filter((x) => DROPDOWN_VALUE_TYPES.includes(x.valueType))) {
    try {
      const options = await af.collect<DropdownOption>(
        `/lists/${NBIF_MASTER_LIST_ID}/fields/${f.id}/dropdown-options`,
      );
      dropdowns[f.name] = options;
      console.log(`\n  ${f.name}  (${f.id}, ${f.valueType}, ${options.length} options)`);
      // rank is only carried by ranked-dropdown; plain dropdowns are unordered.
      const ranked = options.every((o) => typeof o.rank === 'number');
      for (const o of ranked ? [...options].sort((a, b) => a.rank - b.rank) : options) {
        const rank = ranked ? `rank ${String(o.rank).padStart(3)}` : '  unranked';
        console.log(`      ${rank}  id ${String(o.id).padEnd(10)} ${o.text}`);
      }
    } catch (err) {
      const why = err instanceof AffinityError ? `${err.status}` : String(err);
      console.log(`\n  ${f.name}  (${f.id}) — dropdown-options unavailable: ${why}`);
    }
  }
  report.dropdownOptions = dropdowns;

  // 5 -----------------------------------------------------------------------
  heading(5, full ? 'Every list entry, all field types' : 'Sample list entries, all field types');

  const callsBeforeEntries = af.calls;
  const entries = full
    ? await af.collect<ListEntry>(`/lists/${NBIF_MASTER_LIST_ID}/list-entries`, {
        fieldTypes: ALL_FIELD_TYPES,
        limit: 100,
      })
    : (
        await af.get<{ data: ListEntry[] }>(`/lists/${NBIF_MASTER_LIST_ID}/list-entries`, {
          fieldTypes: ALL_FIELD_TYPES,
          limit: 5,
        })
      ).data;
  const entryCalls = af.calls - callsBeforeEntries;

  console.log(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in ${entryCalls} call(s).`);
  report.entryCount = entries.length;
  report.entryCalls = entryCalls;
  report.sampleEntries = entries.slice(0, 3);

  if (entries[0]) {
    const e = entries[0];
    console.log(`\n  Sample — listEntry.id ${e.id}, entity.id ${e.entity.id}, "${e.entity.name}"`);
    console.log(`  entity.domain: ${e.entity.domain ?? '(none)'}\n`);
    for (const fv of e.entity.fields ?? []) {
      const rendered = fv.value === null ? 'null' : JSON.stringify(fv.value.data);
      console.log(`    ${fv.name.padEnd(32)} ${String(fv.value?.type ?? '-').padEnd(18)} ${rendered?.slice(0, 90)}`);
    }
  }

  if (full) {
    // Fill rate per field. Keyed on id, not name: five enriched names are
    // duplicated across the affinity-data and dealroom sources (Description,
    // Location, Industry, Year Founded, Number of Employees), and keying on
    // name silently merges the two counts into one wrong number.
    const filled = new Map<string, number>();
    const seenOnlyInEntries = new Map<string, string>();
    const knownIds = new Set(fields.map((f) => f.id));
    for (const e of entries) {
      for (const fv of e.entity.fields ?? []) {
        if (!knownIds.has(fv.id)) seenOnlyInEntries.set(fv.id, fv.name);
        const isEmpty = fv.value === null || fv.value.data === null ||
          (Array.isArray(fv.value.data) && fv.value.data.length === 0);
        if (!isEmpty) filled.set(fv.id, (filled.get(fv.id) ?? 0) + 1);
      }
    }
    console.log(`\n  --- fill rate over ${entries.length} entries ---`);
    const rates = [...fields, ...[...seenOnlyInEntries].map(([id, name]) => ({ id, name } as FieldMeta))]
      .map((f) => ({ name: f.name, id: f.id, n: filled.get(f.id) ?? 0 }))
      .sort((a, b) => b.n - a.n);
    for (const r of rates) {
      const pct = Math.round((r.n / entries.length) * 100);
      console.log(
        `  ${r.name.padEnd(34)} ${r.id.padEnd(38)} ${String(r.n).padStart(4)}/${entries.length}  ${String(pct).padStart(3)}%`,
      );
    }
    report.fillRates = rates;

    // Fields the entry payload carries but /fields does not enumerate.
    if (seenOnlyInEntries.size) {
      console.log('\n  --- present on entries but ABSENT from /lists/{id}/fields ---');
      for (const [id, name] of seenOnlyInEntries) console.log(`  ${id.padEnd(38)} ${name}`);
      report.fieldsMissingFromMetadata = [...seenOnlyInEntries].map(([id, name]) => ({ id, name }));
    }
  }

  // 6 -----------------------------------------------------------------------
  heading(6, 'field-value-changes — account-wide and filterable?');

  const statusField = fields.find((f) => f.name === 'Status' && f.type === 'list');
  try {
    const changes = await af.get<{ data: unknown[]; pagination: { nextUrl: string | null } }>(
      '/field-value-changes',
      { filter: statusField ? `field.id=${statusField.id}` : undefined, limit: 3 },
    );
    console.log(
      `Account-wide endpoint answered${statusField ? ` filtered to ${statusField.id}` : ''}: ` +
        `${changes.data.length} row(s), nextUrl ${changes.pagination?.nextUrl ? 'present' : 'null'}.`,
    );
    console.log(JSON.stringify(changes.data[0] ?? null, null, 2).slice(0, 1600));
    report.fieldValueChangeSample = changes.data.slice(0, 3);
  } catch (err) {
    console.log(`Account-wide /field-value-changes unavailable: ${String(err).slice(0, 300)}`);
    console.log('Fall back to the per-entry endpoint, which is what ADR-009 assumed.');
    report.fieldValueChangeError = String(err);
  }

  // 7 -----------------------------------------------------------------------
  if (csvPaths.length) {
    heading(7, 'CSV export reconciled against v2 field metadata');

    const csvHeaders = new Set<string>();
    const csvRows: Record<string, string>[] = [];
    for (const p of csvPaths) {
      const { headers, rows } = readCsv(p);
      headers.forEach((h) => csvHeaders.add(h));
      csvRows.push(...rows);
      console.log(`  read ${rows.length} rows from ${path.basename(p)}`);
    }

    const entityLevel = new Set(['Affinity Row ID', 'Organization Id', 'Organization ID', 'Name', 'Website']);
    const byName = new Map(fields.map((f) => [f.name.trim().toLowerCase(), f]));

    const mapping: Record<string, unknown> = {};
    console.log('');
    for (const header of [...csvHeaders].sort()) {
      if (!header.trim()) continue;
      if (entityLevel.has(header)) {
        mapping[header] = { resolution: 'entity-level', note: 'on the listEntry/entity object, not a field' };
        console.log(`  ${header.padEnd(38)} ENTITY   (listEntry.id / entity.id / entity.name / entity.domain)`);
        continue;
      }
      const match = byName.get(baseColumnName(header).toLowerCase());
      if (match) {
        mapping[header] = { id: match.id, type: match.type, valueType: match.valueType, enrichmentSource: match.enrichmentSource };
        console.log(`  ${header.padEnd(38)} ${match.id.padEnd(36)} ${match.type}/${match.valueType}`);
      } else {
        mapping[header] = { resolution: 'UNMATCHED' };
        console.log(`  ${header.padEnd(38)} *** UNMATCHED in v2 field metadata ***`);
      }
    }

    const csvBaseNames = new Set([...csvHeaders].map((h) => baseColumnName(h).toLowerCase()));
    const apiOnly = fields.filter((f) => !csvBaseNames.has(f.name.trim().toLowerCase()));
    console.log(`\n  --- exposed by v2 but absent from both CSV exports (${apiOnly.length}) ---`);
    for (const f of apiOnly.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))) {
      console.log(`  ${f.id.padEnd(38)} ${f.name.padEnd(34)} ${f.type}/${f.valueType}`);
    }
    report.csvMapping = mapping;
    report.apiOnlyFields = apiOnly;

    // The ADR-009 / BUILD-LOG open question, settled against live ids.
    console.log('\n  --- identifier namespace check ---');
    const orgIds = new Set(entries.map((e) => String(e.entity.id)));
    const rowIds = new Set(entries.map((e) => String(e.id)));
    const csvOrgIds = csvRows.map((r) => r['Organization Id'] ?? r['Organization ID'] ?? '').filter(Boolean);
    const csvRowIds = csvRows.map((r) => r['Affinity Row ID'] ?? '').filter(Boolean);
    const orgHits = csvOrgIds.filter((id) => orgIds.has(id)).length;
    const rowHits = csvRowIds.filter((id) => rowIds.has(id)).length;
    console.log(`  CSV "Organization Id"  matched entity.id      on ${orgHits}/${csvOrgIds.length} rows`);
    console.log(`  CSV "Affinity Row ID"  matched listEntry.id   on ${rowHits}/${csvRowIds.length} rows`);
    console.log(
      full
        ? '  (probe pulled every entry, so a low match rate is a real namespace difference)'
        : '  (probe pulled a sample only — run with --full before drawing a conclusion)',
    );
    report.namespaceCheck = { orgHits, orgTotal: csvOrgIds.length, rowHits, rowTotal: csvRowIds.length, full };
  }

  // -------------------------------------------------------------------------
  heading(8, 'API cost');
  console.log(`${af.calls} request(s) total. Affinity allows 900 per user per minute.`);
  console.log(
    `A nightly sync of the roster is ${Math.max(1, Math.ceil(entries.length / 100))} paginated call(s) ` +
      'for entries, plus one for field metadata.',
  );
  report.totalCalls = af.calls;

  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'affinity-v2-probe.json');
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\nFull dump: ${path.relative(process.cwd(), outFile)}`);
  console.log('Contains the real roster — gitignored, and not for sharing outside NBIF.');
} catch (err) {
  if (err instanceof AffinityError && err.status === 401) {
    console.error(
      '\n401 from Affinity. Either the key is wrong, or it is a v1 key, or this plan tier ' +
        'does not include v2 access (Track C: "Confirm Affinity v2 access on your plan tier").',
    );
  }
  throw err;
}
