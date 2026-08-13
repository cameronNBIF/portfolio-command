/**
 * The Visible -> Portfolio Command KPI write path (A5).
 *
 * Reads every portfolio company's quarterly metric history from Visible and
 * upserts it into `company_kpi` as one row per company per calendar quarter.
 *
 * FIVE RULES GOVERN IT:
 *
 * 1. **One way, inbound (ADR-009, ADR-010).** Nothing is written back. Visible
 *    is the collection workflow and the system of record for what founders
 *    reported; the client exposes only GET, so this is a property of the code.
 *
 * 2. **Full refresh, not incremental.** Every run re-reads the whole history
 *    and re-derives every row. Visible lets a founder correct a past quarter,
 *    and an incremental sync keyed on "since last run" would never see it.
 *    Batched metric ids make this affordable -- roughly thirty calls.
 *
 * 3. **It never touches a `manual` row.** `source_system` distinguishes the
 *    Visible series from the hand-entered baselines ADR-010 requires for
 *    companies predating Visible adoption. Those are somebody's work.
 *
 * 4. **Affinity is the master list of companies (ADR-009, ADR-029).** A Visible
 *    profile with no Affinity company is not a problem to fix, it is the normal
 *    residue of a portfolio that changes: a company winds down, leaves Affinity,
 *    and its Visible profile outlives it. Its metrics are deliberately not
 *    stored. The reverse -- in Affinity, no Visible profile -- leaves the KPIs
 *    blank and is a prompt: either create a profile and start collecting, or
 *    accept that it is an old position nobody reports on any more.
 *
 * 5. **Diversity columns are not written at all.** `women_csuite` and
 *    `csuite_size` have no Visible metric behind them yet (action A-1). Writing
 *    NULL over them each night would silently erase a manual entry, and NULL
 *    must never be mistaken for zero (D-5).
 *
 * Money: Visible reports in dollars and `company_kpi` stores dollars. Nothing
 * here crosses the $M boundary -- that conversion happens once, in the API
 * layer (ADR-001).
 */
import type pg from 'pg';

import type { DataPoint, Metric, PortfolioCompanyProfile, VisibleClient } from './client.js';
import { MAX_PAGE_SIZE } from './client.js';
import {
  groupIntoQuarters,
  METRIC_MAP,
  metricKey,
  normalizeDomain,
  type KpiColumn,
  type KpiPeriodRow,
} from './map.js';

/** The system principal seeded by `packages/db/src/seed.ts`. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Metric ids per `/data_points` call. Twenty-five keeps the URL short and the
 * whole sync inside about thirty requests, well under 500 per five minutes.
 */
const METRIC_BATCH = 25;

/**
 * Columns this sync owns, with their SQL types. Everything else on the row is
 * left alone (rule 5).
 *
 * The types are here because change detection casts through them. Visible sends
 * more precision than the columns hold -- a net revenue retention of
 * 141.6666666666666 into numeric(8,2), a runway of 6.540814843 into the same --
 * so comparing the incoming string against the stored value in JavaScript makes
 * six rows differ forever, rewriting themselves and an audit_log entry every
 * night. Casting first asks the only question that matters: would storing this
 * change what is stored?
 */
const OWNED: readonly { column: KpiColumn; type: string }[] = [
  { column: 'revenue', type: 'numeric(18,2)' },
  { column: 'monthly_burn', type: 'numeric(18,2)' },
  { column: 'cash_balance', type: 'numeric(18,2)' },
  { column: 'runway_months', type: 'numeric(8,2)' },
  { column: 'fte', type: 'numeric(10,2)' },
  { column: 'fte_nb', type: 'numeric(10,2)' },
  { column: 'net_revenue_retention', type: 'numeric(8,2)' },
  { column: 'gross_margins', type: 'numeric(8,2)' },
];
const OWNED_COLUMNS: readonly KpiColumn[] = OWNED.map((o) => o.column);

export interface VisibleSyncWarning {
  kind: 'visible-only' | 'no-visible-profile' | 'data-quality' | 'manual-row';
  subject: string;
  field: string;
  detail: string;
}

export interface VisibleSyncResult {
  startedAt: string;
  profilesRead: number;
  companiesMatched: number;
  dataPointsRead: number;
  apiCalls: number;
  counts: Record<string, number>;
  warnings: VisibleSyncWarning[];
}

export interface VisibleSyncOptions {
  companyId: string;
  /** Read, map and report, then roll back. Used to rehearse against real data. */
  dryRun?: boolean;
}

export async function syncVisible(
  client: pg.Client,
  vis: VisibleClient,
  { companyId, dryRun = false }: VisibleSyncOptions,
): Promise<VisibleSyncResult> {
  const startedAt = new Date().toISOString();
  const warnings: VisibleSyncWarning[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  await client.query('set search_path = pc, public');
  const callsBefore = vis.calls;

  // --- 1. Visible's portfolio, keyed by normalised domain -------------------
  const profiles = await vis.collect<PortfolioCompanyProfile>(
    '/portfolio_company_profiles',
    'portfolio_company_profiles',
    { company_id: companyId, page_size: MAX_PAGE_SIZE },
  );

  const profileByDomain = new Map<string, PortfolioCompanyProfile>();
  for (const p of profiles) {
    const domain = normalizeDomain(p.website_url);
    if (domain) profileByDomain.set(domain, p);
  }

  // --- 2. The platform roster, keyed the same way ---------------------------
  const { rows: roster } = await client.query<{ company_id: string; name: string; website: string | null }>(
    'select company_id, name, website from company order by company_id',
  );
  const companyByDomain = new Map<string, { company_id: string; name: string }>();
  for (const r of roster) {
    const domain = normalizeDomain(r.website);
    if (domain) companyByDomain.set(domain, r);
  }

  /**
   * The join is EXACT on normalised domain and nothing else (ADR-029). No fuzzy
   * fallback: 'a.com' must never match 'ba.com', and a near-miss that attached
   * one company's revenue to another's board line would be invisible.
   *
   * The two directions mean different things and are reported differently.
   */
  const companyIdByProfile = new Map<string, string>();
  for (const [domain, profile] of profileByDomain) {
    const hit = companyByDomain.get(domain);
    if (hit) companyIdByProfile.set(profile.id, hit.company_id);
    else {
      // Expected residue, not a defect. Affinity is the master list, so a
      // profile with no company behind it is a position NBIF has exited or
      // written off whose Visible profile was never archived. Storing its
      // metrics would put a company on the platform that exists nowhere else.
      warnings.push({
        kind: 'visible-only',
        subject: `${profile.name} (${domain})`,
        field: 'website',
        detail:
          'In Visible, not in Affinity. Affinity is the master company list, so these metrics ' +
          'are deliberately not stored. Archive the Visible profile, or restore the company in ' +
          'Affinity if it was removed in error.',
      });
    }
  }
  for (const [domain, row] of companyByDomain) {
    if (!profileByDomain.has(domain)) {
      // A prompt rather than a fault: KPIs stay blank, and blank is honest.
      warnings.push({
        kind: 'no-visible-profile',
        subject: `${row.name} (${row.company_id}, ${domain})`,
        field: 'website',
        detail:
          'In Affinity, no Visible profile on this domain. KPIs stay blank. Either create a ' +
          'Visible profile to start collecting, or it is an old position nobody reports on.',
      });
    }
  }

  // --- 3. Metric definitions, one pass over the fund ------------------------
  const metrics = await vis.collect<Metric>('/metrics', 'metrics', {
    company_id: companyId,
    page_size: MAX_PAGE_SIZE,
  });

  // Only metrics that map to a column AND belong to a company we can place.
  const wanted = metrics.filter(
    (m) =>
      METRIC_MAP[metricKey(m.name)] !== undefined &&
      m.portfolio_company_profile_id !== null &&
      companyIdByProfile.has(m.portfolio_company_profile_id),
  );
  const metricsById = new Map(metrics.map((m) => [m.id, m]));

  // --- 4. Data points, batched --------------------------------------------
  const points: DataPoint[] = [];
  for (let i = 0; i < wanted.length; i += METRIC_BATCH) {
    const ids = wanted.slice(i, i + METRIC_BATCH).map((m) => m.id);
    points.push(
      ...(await vis.collect<DataPoint>('/data_points', 'data_points', {
        metric_id: ids,
        page_size: MAX_PAGE_SIZE,
        // Visible pre-creates a row for every period whether or not the founder
        // answered. Without this the sync would store thousands of empty rows
        // and report coverage that does not exist.
        exclude_blank: true,
      })),
    );
  }

  // --- 5. Fold to one row per company per quarter --------------------------
  const pointsByCompany = new Map<string, DataPoint[]>();
  for (const point of points) {
    const metric = metricsById.get(point.metric_id);
    const profileId = metric?.portfolio_company_profile_id;
    if (!profileId) continue;
    const platformId = companyIdByProfile.get(profileId);
    if (!platformId) continue;
    if (!pointsByCompany.has(platformId)) pointsByCompany.set(platformId, []);
    pointsByCompany.get(platformId)!.push(point);
  }

  await client.query('begin');
  try {
    await client.query('set local search_path = pc, public');

    for (const [platformCompanyId, companyPoints] of [...pointsByCompany.entries()].sort()) {
      const { rows, problems } = groupIntoQuarters(companyPoints, metricsById);
      for (const problem of problems) {
        warnings.push({
          kind: 'data-quality',
          subject: platformCompanyId,
          field: problem.metricName,
          detail: `${problem.sourceDate}: ${problem.detail}`,
        });
      }

      for (const row of rows) {
        const outcome = await upsertKpi(client, platformCompanyId, row, warnings);
        if (outcome) bump(outcome);
      }
    }

    if (dryRun) await client.query('rollback');
    else await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }

  return {
    startedAt,
    profilesRead: profiles.length,
    companiesMatched: companyIdByProfile.size,
    dataPointsRead: points.length,
    apiCalls: vis.calls - callsBefore,
    counts,
    warnings,
  };
}

// ---------------------------------------------------------------------------

type Outcome = 'inserted' | 'updated' | 'unchanged' | 'skipped-manual';

/**
 * Writes one quarter for one company, and writes NOTHING when nothing changed.
 *
 * The change test is not an optimisation. A full refresh runs every night over
 * five years of history, so an unconditional write would put ~4,400 rows through
 * `audit_log` daily and bury the one quarter a founder actually restated.
 */
async function upsertKpi(
  client: pg.Client,
  companyId: string,
  row: KpiPeriodRow,
  warnings: VisibleSyncWarning[],
): Promise<Outcome | null> {
  const values = new Map<KpiColumn, string | null>();
  for (const column of OWNED_COLUMNS) values.set(column, null);
  for (const cell of row.cells) values.set(cell.column, cell.value);

  /**
   * `kpi_fte_nb_within` refuses fte_nb > fte, and founder-entered headcount does
   * occasionally break it. Dropping the whole quarter over one field would lose
   * revenue, cash and burn as well, so the offending field is dropped and named
   * instead. Neither number is more trustworthy than the other, so neither is
   * silently adjusted to fit.
   */
  const fte = values.get('fte');
  const fteNb = values.get('fte_nb');
  if (fte !== null && fteNb !== null && fte !== undefined && fteNb !== undefined) {
    if (Number(fteNb) > Number(fte)) {
      values.set('fte_nb', null);
      warnings.push({
        kind: 'data-quality',
        subject: companyId,
        field: 'fte_nb',
        detail:
          `${row.periodEnd}: NB FTE ${fteNb} exceeds total FTE ${fte}, which the schema refuses. ` +
          'NB FTE dropped for this quarter; the rest of the row is stored.',
      });
    }
  }

  const { rows: existing } = await client.query<Record<string, string | number | null>>(
    `select company_kpi_id, source_system, request_version,
            ${OWNED_COLUMNS.join(', ')}
       from company_kpi where company_id = $1 and period_end = $2`,
    [companyId, row.periodEnd],
  );
  const current = existing[0];

  if (current && current.source_system === 'manual') {
    warnings.push({
      kind: 'manual-row',
      subject: companyId,
      field: row.periodEnd,
      detail: 'A manual row exists for this quarter; Visible data was not written over it (rule 3).',
    });
    return 'skipped-manual';
  }

  if (!current) {
    await client.query(
      `insert into company_kpi (company_id, period_start, period_end,
                                ${OWNED_COLUMNS.join(', ')},
                                source_system, request_version)
       values ($1,$2,$3,${OWNED.map((o, i) => `$${i + 4}::${o.type}`).join(',')},'visible',$${OWNED.length + 4})`,
      [
        companyId,
        row.periodStart,
        row.periodEnd,
        ...OWNED_COLUMNS.map((c) => values.get(c) ?? null),
        row.requestVersion,
      ],
    );
    await audit(client, companyId, row.periodEnd, 'insert', null, values, row.requestVersion);
    return 'inserted';
  }

  /**
   * The WHERE clause is the change test, and it runs in Postgres against the
   * cast values. `is distinct from` treats NULL as a value, so a field that
   * stops being reported registers as a change rather than being invisible.
   * rowCount of 0 means the write would have been a no-op.
   */
  const distinctness = OWNED.map((o, i) => `${o.column} is distinct from $${i + 3}::${o.type}`)
    .concat(`request_version is distinct from $${OWNED.length + 4}`)
    .join(' or ');

  const result = await client.query(
    `update company_kpi
        set ${OWNED.map((o, i) => `${o.column} = $${i + 3}::${o.type}`).join(', ')},
            period_start = $${OWNED.length + 3},
            request_version = $${OWNED.length + 4}
      where company_id = $1 and period_end = $2 and (${distinctness})`,
    [
      companyId,
      row.periodEnd,
      ...OWNED_COLUMNS.map((c) => values.get(c) ?? null),
      row.periodStart,
      row.requestVersion,
    ],
  );
  if (result.rowCount === 0) return 'unchanged';

  await audit(
    client,
    companyId,
    row.periodEnd,
    'update',
    Object.fromEntries(OWNED_COLUMNS.map((c) => [c, current[c]])),
    values,
    row.requestVersion,
  );
  return 'updated';
}

/**
 * `fte` and `fte_nb` are mandate fields, so every change to them is auditable
 * (CLAUDE.md). The record id is `company_id:period_end` because `company_kpi`
 * has a surrogate key that says nothing to a reader.
 */
async function audit(
  client: pg.Client,
  companyId: string,
  periodEnd: string,
  action: 'insert' | 'update',
  oldValue: Record<string, unknown> | null,
  values: Map<KpiColumn, string | null>,
  requestVersion: string,
): Promise<void> {
  await client.query(
    `insert into audit_log (table_name, record_id, action, old_value, new_value, changed_by)
     values ('company_kpi', $1, $2, $3, $4, $5)`,
    [
      `${companyId}:${periodEnd}`,
      action,
      oldValue === null ? null : JSON.stringify(oldValue),
      JSON.stringify({ ...Object.fromEntries(values), request_version: requestVersion }),
      SYSTEM_USER_ID,
    ],
  );
}
