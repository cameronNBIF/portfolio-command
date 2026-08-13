/**
 * Visible.vc REST API client. GET only, by construction.
 *
 * ADR-010 makes Visible the system of record for company-reported KPIs and
 * ADR-009's one-way rule applies here too: the platform never writes to it.
 * Visible's API *does* expose writes -- `PUT /data_points`, `POST /metrics`,
 * `PUT /portfolio_property_values` -- so this module exposing no method
 * parameter is doing real work. A stray upsert here would edit what founders
 * reported, which is the one thing this integration must never do.
 *
 * Three differences from the Affinity v2 client worth knowing:
 *
 *   1. **Pagination is page-numbered, not cursor-based.** There is no nextUrl;
 *      the response carries `meta.total_pages` and the caller counts.
 *   2. **The payload is enveloped under a key named after the resource** --
 *      `{ "metrics": [...], "meta": {...} }` -- so `collect` needs to be told
 *      which key to unwrap.
 *   3. **Values arrive as strings** ("for precision", per the API docs). They
 *      stay strings all the way to Postgres numeric. See map.ts.
 *
 * Rate limit: 500 requests per 5 minutes, answered with 429. The sync's job is
 * to stay far under that by batching rather than by sleeping -- see the note on
 * `metric_id` below.
 */

const BASE_URL = 'https://api.visible.vc';

/**
 * Path style is UNDERSCORED (`/data_points`, not `/data-points`). The docs
 * navigation shows hyphens, the operation pages show underscores, and the
 * underscored form is what the NBIF Visible->Affinity pipeline has been running
 * against in production since it was written. Proven beats documented.
 */
const MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 2_000;

/** Documented maximum. Fewer pages means fewer calls against the 500/5min budget. */
export const MAX_PAGE_SIZE = 100;

export interface PageMeta {
  total?: number;
  total_pages?: number;
  page?: number;
}

export type VisibleQueryInit = Record<string, string | number | boolean | readonly string[] | undefined>;

export class VisibleError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`Visible ${status} on ${url}\n${body.slice(0, 500)}`);
    this.name = 'VisibleError';
  }
}

export interface VisibleClient {
  /** One request. `path` is relative to the base URL. */
  get<T>(path: string, query?: VisibleQueryInit): Promise<T>;
  /**
   * Pages to exhaustion and concatenates `body[key]` from every page.
   * `key` is the envelope name -- 'metrics', 'data_points', and so on.
   */
  collect<T>(path: string, key: string, query?: VisibleQueryInit): Promise<T[]>;
  /** HTTP requests issued so far. The sync's API budget, measured not guessed. */
  readonly calls: number;
}

/**
 * Array values are encoded RAILS-STYLE, with brackets: ?metric_id[]=a&metric_id[]=b.
 *
 * This is not cosmetic, and it is not what the Affinity client does — Affinity
 * wants the repeated bare form. Measured against the live API on 13 Aug 2026
 * with five metric ids:
 *
 *   metric_id[]=a&metric_id[]=b   49 points, 5 distinct metrics   <- correct
 *   metric_ids[]=a&metric_ids[]=b 49 points, 5 distinct metrics   <- also works
 *   metric_id=a&metric_id=b       12 points, 1 distinct metric    <- SILENTLY WRONG
 *   metric_id=a,b                  0 points
 *
 * The repeated bare form is the dangerous one: it returns a valid 200 carrying
 * only the LAST id's points, so a sync built on it would quietly store one
 * company's history and drop the other 81 with no error anywhere.
 *
 * Getting this right is what makes a full historical pull affordable — roughly
 * twenty calls rather than five hundred, against a 500-per-5-minute budget.
 */
function buildUrl(path: string, query: VisibleQueryInit = {}): string {
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(`${key}[]`, String(v));
    } else {
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

export function createVisibleClient(token: string): VisibleClient {
  let calls = 0;

  async function request<T>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      calls++;
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });

      if (res.ok) return (await res.json()) as T;

      const body = await res.text().catch(() => '');
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt >= MAX_RETRIES) throw new VisibleError(res.status, url, body);

      // The window is five minutes wide, so a 429 warrants a longer wait than
      // Affinity's per-minute limit does. Retry-After is honoured when sent.
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1_000
          : BACKOFF_BASE_MS * 2 ** attempt;
      console.warn(`  ${res.status} from Visible, retrying in ${Math.round(waitMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  return {
    get: <T>(path: string, query?: VisibleQueryInit) => request<T>(buildUrl(path, query)),

    async collect<T>(path: string, key: string, query?: VisibleQueryInit): Promise<T[]> {
      const out: T[] = [];
      let page = 1;
      for (;;) {
        const body = await request<Record<string, unknown>>(buildUrl(path, { ...query, page }));
        const rows = body[key];
        if (!Array.isArray(rows)) {
          throw new Error(
            `Visible ${path} did not return an array under "${key}". ` +
              `Keys present: ${Object.keys(body).join(', ')}`,
          );
        }
        out.push(...(rows as T[]));

        const meta = (body.meta ?? {}) as PageMeta;
        const totalPages = Number(meta.total_pages ?? 1);
        // A missing or nonsensical total_pages must terminate rather than loop
        // forever; an empty page is the backstop when the envelope surprises us.
        if (!Number.isFinite(totalPages) || page >= totalPages || rows.length === 0) break;
        page++;
      }
      return out;
    },

    get calls() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------------------
// Response shapes, as far as the sync needs them.
// ---------------------------------------------------------------------------

/**
 * Reporting cadence declared on the metric itself.
 *
 * The API documentation lists four values -- daily, weekly, monthly, quarterly.
 * The live account also returns **annually**, on 41 metrics including "Year End
 * Revenue" and "Total Payroll". Taken from the data, not the docs.
 */
export type MetricFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually';

export interface Metric {
  id: string;
  name: string;
  /** daily | weekly | monthly | quarterly. Decides how a data point's date becomes a period. */
  frequency: MetricFrequency | null;
  /** 'number', 'percent', or an ISO 4217 currency code. CAD and USD are NOT interchangeable. */
  unit: string | null;
  portfolio_company_profile_id: string | null;
  company_id: string;
  created_at: string | null;
}

export interface DataPoint {
  id: string;
  /** ISO 8601. The START of the period the value covers, not the end. */
  date: string;
  /** A STRING, deliberately: the API sends it that way for precision, and it
   *  reaches Postgres numeric without ever being a JavaScript float (ADR-008). */
  value: string | null;
  metric_id: string;
  source?: { source_type?: string; label?: string; visible_url?: string } | null;
}

export interface PortfolioCompanyProfile {
  id: string;
  name: string;
  /** The join key to Affinity, and it is on the profile itself -- no per-company
   *  property-value call needed. */
  website_url: string | null;
  /** ISO 4217. Not assumed to be CAD. */
  currency: string | null;
  /** 1-12. Context for reading a fiscal-period data point's date. */
  fiscal_year_end_month: number | null;
  primary_contact_id: string | null;
  company_id: string;
  created_at: string | null;
}

export interface PortfolioProperty {
  id: string;
  name: string;
  property_type?: string | null;
}

export interface PortfolioPropertyValue {
  id: string;
  value: string | number | string[] | null;
  portfolio_property_id: string;
  portfolio_company_profile_id: string;
  portfolio_property_option_id?: string | null;
  portfolio_property_option_ids?: string[] | null;
}
