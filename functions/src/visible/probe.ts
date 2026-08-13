/**
 * A5 step 1 — read-only reconnaissance against the Visible.vc API.
 *
 * Answers the questions A5 cannot be designed without, empirically rather than
 * from the documentation or from what the old pipeline happens to do:
 *
 *   1. Does the token work, and what is the portfolio's real size in Visible?
 *   2. Is `website_url` on the profile itself, and filled? The existing NBIF
 *      pipeline resolves a 'Website' portfolio property with one extra call per
 *      company; if the profile carries it, ~80 calls a night disappear.
 *   3. What currency is each company reporting in? Revenue and cash land in a
 *      numeric(18,2) dollars column, and a USD figure summed into a CAD board
 *      total is wrong in a way nothing downstream would catch.
 *   4. What is the REAL metric inventory -- every distinct name, its declared
 *      frequency and unit, and how many companies report it? This is the input
 *      to the metric map, exactly as the dropdown dump was for Affinity.
 *   5. Have the two diversity metrics landed yet (action A-1)?
 *   6. Does `GET /data_points` genuinely accept `metric_id` as an ARRAY? That
 *      single answer decides whether a full historical pull is two dozen calls
 *      or six hundred against a 500-per-5-minute budget.
 *   7. Are the dates really quarter starts, and how far back does the history
 *      go? `company_kpi` is a quarterly series keyed on period_end.
 *   8. Does the website join to the A4 roster actually land? (--match)
 *
 * Writes NOTHING to Visible and NOTHING to the database. Usage:
 *
 *   npm run visible:probe
 *   npm run visible:probe -- --full     # every data point for every mapped metric
 *   npm run visible:probe -- --match    # reconcile domains against the A4 roster
 *
 * The dump lands in functions/.probe/ (gitignored) because it is the real
 * portfolio: company names, revenue, cash balances, headcount.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

import {
  createVisibleClient,
  MAX_PAGE_SIZE,
  VisibleError,
  type DataPoint,
  type Metric,
  type PortfolioCompanyProfile,
  type PortfolioProperty,
} from './client.js';
import { DIVERSITY_CANDIDATES, METRIC_MAP, metricKey, isQuarterStart, normalizeDomain } from './map.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');
const OUT_DIR = path.resolve(REPO_ROOT, 'functions/.probe');

const args = process.argv.slice(2);
const full = args.includes('--full');
const match = args.includes('--match');

config({ path: path.resolve(REPO_ROOT, '.env') });
config();

const token = process.env.VISIBLE_ACCESS_TOKEN;
const companyId = process.env.VISIBLE_COMPANY_ID;
if (!token || !companyId) {
  console.error(
    'VISIBLE_ACCESS_TOKEN and VISIBLE_COMPANY_ID must both be set.\n' +
      'Copy .env.example to .env at the repo root and fill them in.\n' +
      'VISIBLE_COMPANY_ID is the FUND id, not a portfolio company id.',
  );
  process.exit(1);
}

const vis = createVisibleClient(token);
const report: Record<string, unknown> = { probedAt: new Date().toISOString() };

function heading(text: string): void {
  console.log(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`);
}

/** Counts by value, printed most-common first. */
function tally(values: readonly (string | number | null)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) {
    const key = v === null || v === undefined || v === '' ? '(none)' : String(v);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function printTally(counts: Record<string, number>, indent = '  '): void {
  const width = Math.max(...Object.keys(counts).map((k) => k.length), 1);
  for (const [key, n] of Object.entries(counts)) {
    console.log(`${indent}${key.padEnd(width)}  ${String(n).padStart(5)}`);
  }
}

// ---------------------------------------------------------------------------

try {
  // -------------------------------------------------------------------------
  // 1. Portfolio company profiles — identity, the join key, currency, fiscal year
  // -------------------------------------------------------------------------
  heading('1. Portfolio company profiles');

  const profiles = await vis.collect<PortfolioCompanyProfile>(
    '/portfolio_company_profiles',
    'portfolio_company_profiles',
    { company_id: companyId, page_size: MAX_PAGE_SIZE },
  );
  console.log(`${profiles.length} profile(s) in ${vis.calls} call(s).`);

  const domains = new Map<string, PortfolioCompanyProfile>();
  const unparseable: string[] = [];
  for (const p of profiles) {
    const domain = normalizeDomain(p.website_url);
    if (domain) {
      if (domains.has(domain)) {
        console.log(`  ! duplicate domain ${domain}: "${domains.get(domain)!.name}" and "${p.name}"`);
      }
      domains.set(domain, p);
    } else if (p.website_url) {
      unparseable.push(`${p.name}: ${JSON.stringify(p.website_url)}`);
    }
  }

  const withWebsite = profiles.filter((p) => p.website_url).length;
  console.log(
    `\nwebsite_url present on ${withWebsite}/${profiles.length} ` +
      `(${((withWebsite / Math.max(profiles.length, 1)) * 100).toFixed(0)}%), ` +
      `${domains.size} normalise to a distinct domain.`,
  );
  if (unparseable.length > 0) {
    console.log(`  ${unparseable.length} website(s) present but not parseable as a domain:`);
    for (const u of unparseable.slice(0, 10)) console.log(`    ${u}`);
  }

  console.log('\ncurrency (ISO 4217) — anything but CAD needs a conversion decision:');
  printTally(tally(profiles.map((p) => p.currency)));

  console.log('\nfiscal_year_end_month — 12 means calendar; anything else dates points fiscally:');
  printTally(tally(profiles.map((p) => p.fiscal_year_end_month)));

  report.profiles = {
    count: profiles.length,
    withWebsite,
    distinctDomains: domains.size,
    unparseable,
    currency: tally(profiles.map((p) => p.currency)),
    fiscalYearEndMonth: tally(profiles.map((p) => p.fiscal_year_end_month)),
  };

  // -------------------------------------------------------------------------
  // 2. Metric inventory — the input to the metric map
  // -------------------------------------------------------------------------
  heading('2. Metric inventory');

  // No portfolio_company_profile_id filter: one pass over the fund's metrics
  // returns every company's, each already tagged with its profile id. The old
  // pipeline filters per company, which is ~80 sequential paginated fetches.
  const callsBeforeMetrics = vis.calls;
  const metrics = await vis.collect<Metric>('/metrics', 'metrics', {
    company_id: companyId,
    page_size: MAX_PAGE_SIZE,
  });
  console.log(
    `${metrics.length} metric definition(s) across the fund in ${vis.calls - callsBeforeMetrics} call(s), ` +
      'unfiltered — one pass, not one per company.',
  );

  interface NameStat {
    name: string;
    metrics: number;
    companies: Set<string>;
    frequencies: Set<string>;
    units: Set<string>;
    mappedTo: string | null;
  }
  const byName = new Map<string, NameStat>();
  for (const m of metrics) {
    const key = metricKey(m.name);
    const stat = byName.get(key) ?? {
      name: m.name.trim(),
      metrics: 0,
      companies: new Set<string>(),
      frequencies: new Set<string>(),
      units: new Set<string>(),
      mappedTo: METRIC_MAP[key]?.column ?? null,
    };
    stat.metrics++;
    if (m.portfolio_company_profile_id) stat.companies.add(m.portfolio_company_profile_id);
    stat.frequencies.add(m.frequency ?? '(none)');
    stat.units.add(m.unit ?? '(none)');
    byName.set(key, stat);
  }

  const ranked = [...byName.values()].sort((a, b) => b.companies.size - a.companies.size);
  console.log('\nname | companies | frequency | unit | -> company_kpi column');
  for (const s of ranked) {
    console.log(
      `  ${s.name.padEnd(34)} ${String(s.companies.size).padStart(4)}  ` +
        `${[...s.frequencies].join('/').padEnd(10)} ${[...s.units].join('/').padEnd(8)} ` +
        `${s.mappedTo ? `-> ${s.mappedTo}` : '   (unmapped)'}`,
    );
  }

  const expected = Object.keys(METRIC_MAP);
  const missing = expected.filter((k) => !byName.has(k));
  if (missing.length > 0) {
    console.log(`\n! ${missing.length} EXPECTED metric name(s) not found in Visible:`);
    for (const k of missing) console.log(`    "${k}" -> ${METRIC_MAP[k]!.column}`);
    console.log('  The map is keyed on the name. A rename in Visible silently empties a column.');
  } else {
    console.log('\nAll expected metric names are present.');
  }

  // -------------------------------------------------------------------------
  // 3. Diversity — has action A-1 landed?
  // -------------------------------------------------------------------------
  heading('3. Diversity metrics (action A-1)');

  const DIVERSITY_PATTERN = /c.?suite|women|female|gender|divers/i;
  const diversityHits = ranked.filter(
    (s) => DIVERSITY_PATTERN.test(s.name) || DIVERSITY_CANDIDATES[metricKey(s.name)],
  );
  if (diversityHits.length === 0) {
    console.log(
      'Nothing matching /c-suite|women|gender|diversity/ exists yet.\n' +
        'women_csuite and csuite_size stay NULL, and NULL must never render as zero (D-5).\n' +
        'Every quarter the request goes out unchanged is a permanent hole in the series.',
    );
  } else {
    console.log('Candidate diversity metrics found — the series can begin:');
    for (const s of diversityHits) {
      console.log(
        `  "${s.name}" — ${s.companies.size} companies, ${[...s.frequencies].join('/')}, ` +
          `${[...s.units].join('/')} ` +
          `${DIVERSITY_CANDIDATES[metricKey(s.name)] ? `(maps to ${DIVERSITY_CANDIDATES[metricKey(s.name)]})` : '(NOT in DIVERSITY_CANDIDATES — add it)'}`,
      );
    }
  }
  report.diversity = diversityHits.map((s) => ({ name: s.name, companies: s.companies.size }));

  report.metrics = {
    definitions: metrics.length,
    distinctNames: byName.size,
    missingExpected: missing,
    names: ranked.map((s) => ({
      name: s.name,
      companies: s.companies.size,
      frequencies: [...s.frequencies],
      units: [...s.units],
      mappedTo: s.mappedTo,
    })),
  };

  // -------------------------------------------------------------------------
  // 4. Does metric_id batching work? The whole API budget rests on this.
  // -------------------------------------------------------------------------
  heading('4. Data point batching');

  const mapped = metrics.filter((m) => METRIC_MAP[metricKey(m.name)]);
  console.log(`${mapped.length} metric definition(s) map to a company_kpi column.`);

  let batchingWorks = false;
  const batchIds = mapped.slice(0, 10).map((m) => m.id);
  if (batchIds.length >= 2) {
    try {
      const probe = await vis.get<{ data_points: DataPoint[]; meta?: unknown }>('/data_points', {
        metric_id: batchIds,
        page_size: MAX_PAGE_SIZE,
        exclude_blank: true,
      });
      const distinct = new Set(probe.data_points.map((d) => d.metric_id));
      batchingWorks = distinct.size > 1;
      console.log(
        `Asked for ${batchIds.length} metric ids in one call; ` +
          `got ${probe.data_points.length} point(s) spanning ${distinct.size} distinct metric id(s).`,
      );
      console.log(
        batchingWorks
          ? '  CONFIRMED: metric_id batches. A full history is tens of calls, not hundreds.'
          : '  NOT batched — only one metric came back. The sync must fan out one call per metric,' +
              '\n  which at this volume needs pacing against the 500-per-5-minute limit.',
      );
    } catch (err) {
      console.log(`  Batch attempt failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  report.batching = { works: batchingWorks, attemptedIds: batchIds.length };

  // -------------------------------------------------------------------------
  // 5. Data point shape, cadence and history depth
  // -------------------------------------------------------------------------
  heading('5. Data points — cadence, history depth, sign conventions');

  const sample = full ? mapped : mapped.slice(0, Math.min(mapped.length, 40));
  console.log(
    full
      ? `Pulling every data point for all ${sample.length} mapped metric(s).`
      : `Sampling ${sample.length} of ${mapped.length} mapped metric(s). Use --full for everything.`,
  );

  const metricsById = new Map(metrics.map((m) => [m.id, m]));
  const points: DataPoint[] = [];
  const callsBeforePoints = vis.calls;
  const BATCH = batchingWorks ? 25 : 1;
  for (let i = 0; i < sample.length; i += BATCH) {
    const ids = sample.slice(i, i + BATCH).map((m) => m.id);
    const page = await vis.collect<DataPoint>('/data_points', 'data_points', {
      metric_id: ids,
      page_size: MAX_PAGE_SIZE,
      exclude_blank: true,
    });
    points.push(...page);
  }
  console.log(
    `${points.length} data point(s) in ${vis.calls - callsBeforePoints} call(s).`,
  );

  if (points.length > 0) {
    const dates = points.map((p) => p.date).sort();
    console.log(`\nhistory spans ${dates[0]} .. ${dates[dates.length - 1]}`);

    const onBoundary = points.filter((p) => isQuarterStart(p.date)).length;
    console.log(
      `dates on a calendar quarter start: ${onBoundary}/${points.length} ` +
        `(${((onBoundary / points.length) * 100).toFixed(0)}%)`,
    );
    console.log('\ndate day-of-month — a quarterly series should be entirely "01":');
    printTally(tally(points.map((p) => p.date.slice(8, 10))));

    console.log('\ndate month — a quarterly series should be 01/04/07/10 only:');
    printTally(tally(points.map((p) => p.date.slice(5, 7))));

    // Per mapped column: coverage, and for burn the sign, which decides whether
    // the schema's "negative = cash-flow positive" convention survives contact.
    console.log('\nper column: points, distinct periods, value range');
    const byColumn = new Map<string, DataPoint[]>();
    for (const p of points) {
      const m = metricsById.get(p.metric_id);
      const spec = m ? METRIC_MAP[metricKey(m.name)] : undefined;
      if (!spec) continue;
      if (!byColumn.has(spec.column)) byColumn.set(spec.column, []);
      byColumn.get(spec.column)!.push(p);
    }
    for (const [column, pts] of [...byColumn.entries()].sort()) {
      const numbers = pts.map((p) => Number(p.value)).filter((n) => Number.isFinite(n));
      const negatives = numbers.filter((n) => n < 0).length;
      const periods = new Set(pts.map((p) => p.date.slice(0, 7)));
      console.log(
        `  ${column.padEnd(14)} ${String(pts.length).padStart(5)} pts  ` +
          `${String(periods.size).padStart(3)} periods  ` +
          `min ${Math.min(...numbers).toLocaleString('en-CA')}  ` +
          `max ${Math.max(...numbers).toLocaleString('en-CA')}  ` +
          `${negatives} negative`,
      );
    }

    console.log('\nfirst 5 raw points, so the value type is seen rather than assumed:');
    for (const p of points.slice(0, 5)) {
      const m = metricsById.get(p.metric_id);
      console.log(`  ${p.date}  ${JSON.stringify(p.value)} (${typeof p.value})  ${m?.name ?? '?'}`);
    }

    report.dataPoints = {
      count: points.length,
      earliest: dates[0],
      latest: dates[dates.length - 1],
      onQuarterBoundary: onBoundary,
      dayOfMonth: tally(points.map((p) => p.date.slice(8, 10))),
      month: tally(points.map((p) => p.date.slice(5, 7))),
    };
  }

  // -------------------------------------------------------------------------
  // 5b. Unmapped metrics that are defined on the whole portfolio
  // -------------------------------------------------------------------------
  heading('5b. Unmapped metrics — defined everywhere, but are they FILLED?');

  // A metric defined on all 82 companies is part of the standing request. That
  // says nothing about whether founders answer it, and the difference decides
  // whether a column is worth adding. Three names in particular collide --
  // "Monthly Net Burn Rate", "Monthly Burn Rate" and "Net Burn Rate" all exist
  // on all 82 -- and only the fill rate can say which one the request actually
  // drives.
  const candidates = ranked.filter((s) => s.mappedTo === null && s.companies.size >= 40);
  console.log(`${candidates.length} unmapped metric name(s) defined on 40+ companies.\n`);

  const candidateReport: Record<string, unknown>[] = [];
  for (const stat of candidates) {
    const ids = metrics
      .filter((m) => metricKey(m.name) === metricKey(stat.name) && m.portfolio_company_profile_id)
      .map((m) => m.id);
    const filled: DataPoint[] = [];
    for (let i = 0; i < ids.length; i += 25) {
      filled.push(
        ...(await vis.collect<DataPoint>('/data_points', 'data_points', {
          metric_id: ids.slice(i, i + 25),
          page_size: MAX_PAGE_SIZE,
          exclude_blank: true,
        })),
      );
    }
    const reporting = new Set(
      filled.map((p) => metricsById.get(p.metric_id)?.portfolio_company_profile_id ?? ''),
    );
    reporting.delete('');
    const dates = filled.map((p) => p.date).sort();
    const samples = filled.slice(0, 4).map((p) => p.value);

    console.log(
      `  ${stat.name.padEnd(34)} ${String(filled.length).padStart(5)} values from ` +
        `${String(reporting.size).padStart(3)}/${stat.companies.size} companies  ` +
        `${dates.length > 0 ? `${dates[0]}..${dates[dates.length - 1]}` : '(never answered)'}` +
        `${samples.length > 0 ? `  e.g. ${samples.map((s) => JSON.stringify(s)).join(', ')}` : ''}`,
    );
    candidateReport.push({
      name: stat.name,
      frequencies: [...stat.frequencies],
      units: [...stat.units],
      definedOn: stat.companies.size,
      values: filled.length,
      reportingCompanies: reporting.size,
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
      samples,
    });
  }
  report.unmappedCandidates = candidateReport;

  // -------------------------------------------------------------------------
  // 6. Portfolio properties — what else Visible holds
  // -------------------------------------------------------------------------
  heading('6. Portfolio properties');

  try {
    const properties = await vis.collect<PortfolioProperty>(
      '/portfolio_properties',
      'portfolio_properties',
      { company_id: companyId },
    );
    console.log(`${properties.length} portfolio propert(ies):`);
    for (const p of properties) console.log(`  ${p.name}${p.property_type ? ` (${p.property_type})` : ''}`);
    console.log(
      '\nNote: the old pipeline resolves "Website" here and then calls\n' +
        '/portfolio_property_values once per company. website_url on the profile\n' +
        'makes that unnecessary — see section 1 for whether it is actually filled.',
    );
    report.portfolioProperties = properties.map((p) => p.name);
  } catch (err) {
    console.log(`Could not list portfolio properties: ${err instanceof Error ? err.message : err}`);
  }

  // -------------------------------------------------------------------------
  // 7. The join to the A4 roster
  // -------------------------------------------------------------------------
  if (match) {
    heading('7. Domain reconciliation against the A4 roster');
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.log('DATABASE_URL is not set; skipping. (--match needs the local database.)');
    } else {
      const pg = (await import('pg')).default;
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query('set search_path = pc, public');
        const { rows } = await client.query<{ company_id: string; name: string; website: string | null }>(
          'select company_id, name, website from company order by company_id',
        );
        const platformByDomain = new Map<string, { company_id: string; name: string }>();
        const noWebsite: string[] = [];
        for (const r of rows) {
          const d = normalizeDomain(r.website);
          if (d) platformByDomain.set(d, r);
          else noWebsite.push(`${r.company_id} ${r.name}`);
        }

        const matched: string[] = [];
        const visibleOnly: string[] = [];
        for (const [domain, profile] of domains) {
          const hit = platformByDomain.get(domain);
          if (hit) matched.push(`${hit.company_id}  ${domain.padEnd(30)} ${profile.name}`);
          else visibleOnly.push(`${domain.padEnd(30)} ${profile.name}`);
        }
        const platformOnly = [...platformByDomain.entries()]
          .filter(([d]) => !domains.has(d))
          .map(([d, r]) => `${r.company_id}  ${d.padEnd(30)} ${r.name}`);

        console.log(
          `${matched.length} of ${domains.size} Visible domains match a platform company ` +
            `(roster: ${rows.length}, ${noWebsite.length} with no website).`,
        );
        console.log(`\n  ${visibleOnly.length} in Visible with no platform company:`);
        for (const v of visibleOnly) console.log(`    ${v}`);
        console.log(`\n  ${platformOnly.length} platform companies with no Visible profile:`);
        for (const p of platformOnly.slice(0, 30)) console.log(`    ${p}`);
        if (platformOnly.length > 30) console.log(`    ... and ${platformOnly.length - 30} more`);

        report.reconciliation = {
          rosterSize: rows.length,
          rosterWithoutWebsite: noWebsite,
          matched: matched.length,
          visibleOnly,
          platformOnly,
        };
      } finally {
        await client.end();
      }
    }
  } else {
    console.log('\n(run with --match to reconcile Visible domains against the A4 roster)');
  }

  // -------------------------------------------------------------------------
  heading('API budget');
  console.log(
    `${vis.calls} request(s) this run. The limit is 500 per 5 minutes.\n` +
      `A nightly sync reads profiles + metrics + points; this probe is a fair upper bound.`,
  );
  report.apiCalls = vis.calls;

  mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'visible-probe.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nreport written to ${path.relative(REPO_ROOT, out)} (gitignored — it is real portfolio data)`);
} catch (err) {
  if (err instanceof VisibleError) {
    console.error(`\n${err.message}`);
    if (err.status === 401 || err.status === 403) {
      console.error(
        '\n401/403 — check VISIBLE_ACCESS_TOKEN, and that VISIBLE_COMPANY_ID is the FUND id.',
      );
    }
    process.exit(1);
  }
  throw err;
}
