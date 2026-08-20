/**
 * F4 step 1 — the read-only probe ADR-036 clause 5 requires before any migration.
 *
 * **F4 does not begin with a migration. It begins with this.** The reason is a
 * blast radius rather than caution: if Affinity's Exited companies bring
 * organisations onto the roster that are not on it today, then the invested and
 * FMV **control totals move** — the same totals the A6 generator reconciles to
 * and the ones A13 is meant to tie to. That is a decision to take with the
 * numbers on the table, not a consequence to discover afterwards.
 *
 * The question exists at all because of how the field was profiled. The CSV
 * export showed Status as 80/80 rows with one distinct value, always
 * `Portfolio`, and it was mapped as unused on that basis — but the export was
 * of the **Portfolio saved view**, which filters on exactly that value. The
 * Exited view's companies were never in the extract. Absence of evidence,
 * looking like evidence of absence.
 *
 * WHAT THIS ANSWERS
 *
 *   1. The Status vocabulary **from field configuration**, not from observed
 *      values — ADR-009's own rule, because options exist that no visible row
 *      has ever used. `Exited` was one of them.
 *   2. Every list entry counted by Status, so "how many are Exited" is a
 *      measurement rather than an estimate.
 *   3. For each Exited entry: is this organisation **already on the roster**,
 *      and what are Affinity's own Total Investment Amount and FMV for it?
 *   4. The consequence, stated in dollars: what the control totals become if
 *      the Exited companies not already synced were brought in.
 *
 * WRITES NOTHING. The client is GET-only by construction (ADR-009), the
 * database connection is opened read-only, and the report lands in
 * `functions/.probe/` — gitignored, because it carries the real roster.
 *
 *   npm run affinity:exits
 *   npm run affinity:exits -- --json     # the report only, for piping
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg from 'pg';

import {
  createAffinityClient,
  NBIF_MASTER_LIST_ID,
  type DropdownOption,
  type FieldMeta,
  type FieldValue,
  type ListEntry,
} from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');
const OUT_DIR = path.resolve(REPO_ROOT, 'functions/.probe');

/** The same four the sync asks for, so what this sees is what the sync sees. */
const FIELD_TYPES = ['enriched', 'global', 'list', 'relationship-intelligence'] as const;

const jsonOnly = process.argv.slice(2).includes('--json');
const log = (...args: unknown[]) => {
  if (!jsonOnly) console.log(...args);
};

interface DropdownValue { dropdownOptionId: number | null; text: string }

function fieldValue<T>(entry: ListEntry, name: string): T | null {
  const f: FieldValue | undefined = (entry.entity.fields ?? []).find((x) => x.name === name);
  if (!f || f.value === null || f.value.data === null) return null;
  return f.value.data as T;
}

const money = (n: number | null): string =>
  n === null ? '—' : `$${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface ExitedEntry {
  affinityOrgId: string;
  affinityRowId: string;
  name: string;
  domain: string | null;
  status: string;
  /** Affinity's own figures. REFERENCE ONLY — they never enter a calculation (ADR-009). */
  affinityTotalInvestment: number | null;
  affinityFmv: number | null;
  /** Resolved against the local roster by Affinity organisation id. */
  onRoster: boolean;
  companyId: string | null;
  /** What the platform itself holds, where the company is already synced. */
  storedTotalInvestment: string | null;
  storedFmv: string | null;
  /** ADR-036's other half: has Finance already recorded an exit event? */
  hasExitEvent: boolean;
  lifecycleStatus: string | null;
}

async function main(): Promise<void> {
  config({ path: path.resolve(REPO_ROOT, '.env') });
  config();

  const apiKey = process.env.AFFINITY_API_KEY;
  if (!apiKey) {
    console.error('AFFINITY_API_KEY is not set. See .env.example.');
    process.exit(1);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set — the roster comparison needs it. See .env.example.');
    process.exit(1);
  }

  const af = createAffinityClient(apiKey);

  /* READ-ONLY, and enforced by the session rather than by intention: this
     script exists to inform a decision, and a probe that could write is a probe
     someone has to read carefully before running. */
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query('set session characteristics as transaction read only');
  await db.query('set search_path = pc, public');

  /* The membership rule from `affinity_status_map`, which is where ADR-036 put
     it -- not from a constant in this file. A probe that annotated the
     vocabulary from its own copy of the rule would agree with itself and prove
     nothing about what the sync will do tonight. */
  const { rows: statusRules } = await db.query<{
    affinity_status: string; is_portfolio_member: boolean; is_exited: boolean;
  }>('select affinity_status, is_portfolio_member, is_exited from affinity_status_map');
  const rule = new Map(statusRules.map((r) => [r.affinity_status, r]));

  // --- 1. the vocabulary, from field configuration ------------------------
  const fields = await af.collect<FieldMeta>(`/lists/${NBIF_MASTER_LIST_ID}/fields`);
  const statusField = fields.find((f) => f.name === 'Status');
  if (!statusField) {
    console.error(`No "Status" field on list ${NBIF_MASTER_LIST_ID}. Nothing here is answerable.`);
    process.exit(1);
  }
  const options = await af.collect<DropdownOption>(
    `/lists/${NBIF_MASTER_LIST_ID}/fields/${statusField.id}/dropdown-options`,
  );

  log(`\nStatus — ${statusField.id}, ${statusField.valueType}, ${options.length} options in configuration`);
  for (const o of [...options].sort((a, b) => a.rank - b.rank)) {
    const r = rule.get(o.text);
    const member = r?.is_exited
      ? '  ← portfolio membership, and EXITED'
      : r?.is_portfolio_member
        ? '  ← counted as portfolio membership'
        : '';
    log(`  ${String(o.rank).padStart(2)}  ${o.text}${member}`);
  }

  // --- 2. every entry, counted by Status ----------------------------------
  const entries = await af.collect<ListEntry>(`/lists/${NBIF_MASTER_LIST_ID}/list-entries`, {
    fieldTypes: FIELD_TYPES,
    limit: 100,
  });

  const byStatus = new Map<string, number>();
  for (const e of entries) {
    const status = fieldValue<DropdownValue>(e, 'Status')?.text ?? '(no status)';
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }

  log(`\n${entries.length} list entries by Status`);
  for (const [status, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    log(`  ${String(n).padStart(4)}  ${status}`);
  }

  // --- 3. the Exited entries, against the roster --------------------------
  // Which status means exited is the table's answer too, for the reason given
  // where `rule` is loaded: a probe carrying its own copy would agree with
  // itself rather than with the sync.
  const exited = entries.filter((e) => {
    const status = fieldValue<DropdownValue>(e, 'Status')?.text ?? null;
    return status !== null && rule.get(status)?.is_exited === true;
  });

  const rows: ExitedEntry[] = [];
  for (const e of exited) {
    const orgId = String(e.entity.id);
    const { rows: found } = await db.query<{
      company_id: string;
      total_investment: string | null;
      fmv: string | null;
      has_exit: boolean;
      lifecycle_status: string | null;
    }>(
      `select c.company_id,
              c.affinity_total_investment::text as total_investment,
              c.affinity_fmv::text              as fmv,
              (ce.company_id is not null)       as has_exit,
              cs.lifecycle_status
         from company c
         left join company_exit ce on ce.company_id = c.company_id
         left join company_state cs
                on cs.company_id = c.company_id and cs.effective_to is null
        where c.affinity_org_id = $1`,
      [orgId],
    );
    const hit = found[0] ?? null;

    rows.push({
      affinityOrgId: orgId,
      affinityRowId: String(e.id),
      name: e.entity.name.trim(),
      domain: e.entity.domain,
      status: fieldValue<DropdownValue>(e, 'Status')?.text ?? '',
      affinityTotalInvestment: fieldValue<number>(e, 'Total Investment Amount'),
      affinityFmv: fieldValue<number>(e, 'FMV'),
      onRoster: hit !== null,
      companyId: hit?.company_id ?? null,
      storedTotalInvestment: hit?.total_investment ?? null,
      storedFmv: hit?.fmv ?? null,
      hasExitEvent: hit?.has_exit ?? false,
      lifecycleStatus: hit?.lifecycle_status ?? null,
    });
  }

  // --- 4. the consequence, in dollars -------------------------------------
  const { rows: totals } = await db.query<{ companies: string; invested: string; fmv: string }>(
    `select count(*)::text                                as companies,
            coalesce(sum(affinity_total_investment),0)::text as invested,
            coalesce(sum(affinity_fmv),0)::text             as fmv
       from company`,
  );
  const { rows: frozen } = await db.query<{ label: string; companies: string; invested: string; fmv: string }>(
    `select snapshot_label as label, count(*)::text as companies,
            coalesce(sum(total_investment),0)::text as invested,
            coalesce(sum(fmv),0)::text             as fmv
       from affinity_control_snapshot group by snapshot_label`,
  );

  const newcomers = rows.filter((r) => !r.onRoster);
  const wouldAddInvested = newcomers.reduce((a, r) => a + (r.affinityTotalInvestment ?? 0), 0);
  const wouldAddFmv = newcomers.reduce((a, r) => a + (r.affinityFmv ?? 0), 0);

  log(`\n${rows.length} entries carry Status "Exited"`);
  for (const r of rows) {
    log(
      `  ${r.onRoster ? '✓ on roster' : '✗ NOT on roster'}  ${r.companyId ?? '—'}  ${r.name}` +
        `\n      Affinity: invested ${money(r.affinityTotalInvestment)}, FMV ${money(r.affinityFmv)}` +
        `${r.onRoster ? `\n      platform: exit event ${r.hasExitEvent ? 'recorded' : 'NOT recorded'}, lifecycle ${r.lifecycleStatus ?? '—'}` : ''}`,
    );
  }

  log(`\nroster today: ${totals[0]!.companies} companies, invested ${money(Number(totals[0]!.invested))}, FMV ${money(Number(totals[0]!.fmv))}`);
  for (const f of frozen) {
    log(`  frozen "${f.label}": ${f.companies} companies, invested ${money(Number(f.invested))}, FMV ${money(Number(f.fmv))}`);
  }

  if (newcomers.length === 0) {
    log(
      `\nTHE GATE IS CLEAR. Every Exited company is already on the roster, so the control totals\n` +
        `do not move and F4 is a presentation and derivation change rather than a data change.`,
    );
  } else {
    log(
      `\nSTOP. ${newcomers.length} Exited ${newcomers.length === 1 ? 'company is' : 'companies are'} NOT on the roster.\n` +
        `Bringing them in would move the control totals by invested ${money(wouldAddInvested)} and FMV ${money(wouldAddFmv)}.\n` +
        `That is the same total A6 reconciles to and A13 must tie to. Decide before writing a migration.`,
    );
  }

  const report = {
    probedAt: new Date().toISOString(),
    listId: NBIF_MASTER_LIST_ID,
    statusField: { id: statusField.id, valueType: statusField.valueType },
    statusOptions: [...options].sort((a, b) => a.rank - b.rank).map((o) => ({ rank: o.rank, text: o.text })),
    membershipStatuses: statusRules.filter((r) => r.is_portfolio_member).map((r) => r.affinity_status),
    exitedStatuses: statusRules.filter((r) => r.is_exited).map((r) => r.affinity_status),
    entriesByStatus: Object.fromEntries([...byStatus].sort((a, b) => b[1] - a[1])),
    entryCount: entries.length,
    exited: rows,
    rosterToday: totals[0],
    frozenSnapshots: frozen,
    gate: {
      exitedNotOnRoster: newcomers.length,
      wouldAddInvested,
      wouldAddFmv,
      clear: newcomers.length === 0,
    },
    apiCalls: af.calls,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'exit-probe.json');
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  await db.end();

  if (jsonOnly) console.log(JSON.stringify(report, null, 2));
  else console.log(`\nwrote ${path.relative(process.cwd(), out)} in ${af.calls} API calls\n`);
}

await main();
