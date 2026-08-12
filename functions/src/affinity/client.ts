/**
 * Affinity REST API v2 client. GET only, by construction.
 *
 * ADR-009 makes the sync one-way and inbound: the platform never writes to
 * Affinity. This module exposes no way to issue anything but a GET, so that
 * property belongs to the code rather than to someone's memory.
 *
 * Auth is a bearer API key. The v1 API used HTTP basic with an empty username
 * and integer field ids; v1 and v2 keys are not interchangeable and neither
 * are the field ids (see docs/affinity-v2-endpoints.md).
 */

const BASE_URL = 'https://api.affinity.co/v2';

/** The NBIF Master list. One list, not two: Pipeline and Portfolio are saved
 *  views of it filtered by Status (ADR-009). */
export const NBIF_MASTER_LIST_ID = 328745;

/**
 * Affinity halts requests at 900 per user per minute and answers 429. Nothing
 * this sync does comes close, but a shared key and a retry storm could, so the
 * backoff is here from the start rather than added after the first incident.
 */
const MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 1_000;

export interface Paginated<T> {
  data: T[];
  pagination: { prevUrl: string | null; nextUrl: string | null };
}

export type QueryInit = Record<string, string | number | readonly string[] | undefined>;

export class AffinityError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`Affinity ${status} on ${url}\n${body.slice(0, 500)}`);
    this.name = 'AffinityError';
  }
}

export interface AffinityClient {
  /** One request. `path` is relative to /v2, or an absolute api.affinity.co URL. */
  get<T>(path: string, query?: QueryInit): Promise<T>;
  /** Follows pagination.nextUrl to exhaustion and concatenates every page. */
  collect<T>(path: string, query?: QueryInit): Promise<T[]>;
  /** HTTP requests issued so far. The sync's API budget, measured not guessed. */
  readonly calls: number;
}

/**
 * Array values become repeated query parameters, which is what v2 wants:
 * ?fieldTypes=list&fieldTypes=enriched, not ?fieldTypes=list,enriched.
 */
function buildUrl(path: string, query: QueryInit = {}): string {
  const url = path.startsWith('https://') ? new URL(path) : new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

export function createAffinityClient(apiKey: string): AffinityClient {
  let calls = 0;

  async function request<T>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      calls++;
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });

      if (res.ok) return (await res.json()) as T;

      const body = await res.text().catch(() => '');
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt >= MAX_RETRIES) throw new AffinityError(res.status, url, body);

      // Retry-After is seconds when Affinity sends it; otherwise back off.
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : BACKOFF_BASE_MS * 2 ** attempt;
      console.warn(`  ${res.status} from Affinity, retrying in ${Math.round(waitMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  return {
    get: <T>(path: string, query?: QueryInit) => request<T>(buildUrl(path, query)),

    async collect<T>(path: string, query?: QueryInit): Promise<T[]> {
      const out: T[] = [];
      let url: string | null = buildUrl(path, query);
      while (url) {
        const page: Paginated<T> = await request<Paginated<T>>(url);
        out.push(...page.data);
        // nextUrl already carries the cursor and every original parameter.
        url = page.pagination?.nextUrl ?? null;
      }
      return out;
    },

    get calls() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------------------
// v2 response shapes, as far as the sync needs them.
// ---------------------------------------------------------------------------

export type FieldType = 'enriched' | 'global' | 'list' | 'relationship-intelligence';

export interface FieldMeta {
  id: string;                  // 'field-5470690' | 'affinity-data-location' | 'last-email-date'
  name: string;
  type: FieldType;
  valueType: string;           // dropdown | ranked-dropdown | person | location | number | ...
  enrichmentSource: string | null;
  createdAt: string | null;
}

export interface DropdownOption {
  type: string;                // dropdown | ranked-dropdown | status-dropdown
  id: number;
  text: string;
  rank: number;
  color?: string | null;
}

export interface FieldValue {
  id: string;
  name: string;
  type: FieldType;
  enrichmentSource: string | null;
  value: { type: string; data: unknown } | null;
}

export interface ListEntry {
  id: number;                  // the export's "Affinity Row ID"
  type: 'company' | 'person' | 'opportunity';
  listId: number;
  createdAt: string;
  creatorId: number | null;
  entity: {
    id: number;                // the export's "Organization Id"
    name: string;
    domain: string | null;
    domains: string[];
    isGlobal: boolean;
    fields?: FieldValue[];
  };
}

export interface SavedView {
  id: number;
  name: string;
  type: string;                // sheet | board | dashboard | chart
  createdAt: string | null;
}

export interface ListMeta {
  id: number;
  name: string;
  type: string;
  isPublic: boolean;
  creatorId: number | null;
}
