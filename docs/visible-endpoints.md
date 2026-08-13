# Visible.vc API — endpoint mechanics, as measured

Companion to `docs/affinity-v2-endpoints.md`. Everything here was verified
against the live NBIF account on **13 August 2026**, not taken from the
documentation. Where the two disagree, the measurement is recorded and the
documentation is noted as wrong.

Base URL: `https://api.visible.vc`. Auth: `Authorization: Bearer <token>`.
Rate limit: **500 requests per 5 minutes**, answered with `429`.

## Path style

Paths are **underscored** — `/data_points`, `/portfolio_company_profiles`. The
documentation navigation shows hyphenated names; the operation pages and the
live API use underscores.

## Pagination

Page-numbered, not cursor-based. There is no `nextUrl`. Every collection
response is `{ "<resource>": [...], "meta": { page, total, total_pages } }`, so a
client must know the envelope key to unwrap. `page_size` maxes at 100.

## Endpoints used

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /portfolio_company_profiles` | The portfolio roster | Requires `company_id` (the **fund's** id). Carries `website_url`, `currency`, `fiscal_year_end_month`. |
| `GET /metrics` | Metric definitions | Requires `company_id`. Each metric carries its own `portfolio_company_profile_id`, `frequency` and `unit`. |
| `GET /data_points` | The values | Requires `metric_id`. Supports `start_date`, `end_date`, `exclude_blank`, and **arrays of metric ids**. |
| `GET /portfolio_properties` | Property definitions | Reconnaissance only; the sync does not read property values. |

## Three findings that change how a client must be written

### 1. `metric_id` must be bracketed, or it silently returns one metric

`GET /data_points` accepts multiple metric ids, but only in Rails array form.
Measured with five ids:

| Encoding | Result |
|---|---|
| `metric_id[]=a&metric_id[]=b` | 49 points, 5 distinct metrics — **correct** |
| `metric_ids[]=a&metric_ids[]=b` | 49 points, 5 distinct metrics — also works |
| `metric_id=a&metric_id=b` | 12 points, **1** distinct metric — 200 OK, silently wrong |
| `metric_id=a,b` | 0 points |

The repeated bare form is the trap: a valid `200` carrying only the **last** id's
points. A sync built on it stores one company's history and drops the rest with
no error anywhere. This is also what makes a full historical pull affordable —
~97 calls rather than ~600.

### 2. `website_url` is on the profile, so there is no per-company fan-out

The earlier NBIF Visible→Affinity pipeline resolves a `Website` *portfolio
property* and then calls `/portfolio_property_values` once per company. The
profile object carries `website_url` directly, filled on **82 of 82**. That is
about eighty calls a night that never need to be made.

### 3. `frequency` has a fifth value the docs do not list

Documented: `daily`, `weekly`, `monthly`, `quarterly`. The live account also
returns **`annually`**, on 41 metrics including `Year End Revenue` and
`Total Payroll`.

## Data point semantics

- `date` is the **start** of the period the value covers. A Q2 2026 submission
  (April–June, due 5 August) arrives dated `2026-04-01`. All 4,449 values sit
  exactly on calendar quarter starts.
- `value` is a **string**, deliberately, for precision — and it is always
  float-formatted. A headcount of twelve arrives as `"12.0"`, which Postgres
  rejects for an `int` column.
- Visible **pre-creates a row for every period** whether or not the founder
  answered, with `value: null`. Without `exclude_blank=true` a sync stores
  thousands of empty rows and reports coverage that does not exist.
- Values exceed the schema's scale: a net revenue retention of
  `141.6666666666666` into `numeric(8,2)`. Change detection must compare what
  the database would *store*, not the incoming string, or those rows differ
  forever.

## Account shape, 13 August 2026

- **82 portfolio company profiles.** `website_url` filled on all 82, normalising
  to 82 distinct domains.
- **`currency`**: CAD on 76, unset on 6. No USD reporters, so nothing crosses a
  conversion boundary today — but the field exists and one USD company would be
  invisible in a CAD board total.
- **`fiscal_year_end_month`**: unset on all 82, so every date reads as calendar.
- **2,613 metric definitions across 148 distinct names.** Only eight map to
  `company_kpi`; see `docs/visible-metric-map.csv`.
- **4,449 answered data points** for the mapped metrics, spanning
  **2021-04-01 to 2026-04-01**.
- **The annual block is dead.** `Year End Revenue`, `Total Payroll`,
  `Total # Employees`, `Full-Time Employee Count` and six others are defined on
  all 82 companies, were answered by 41, and stopped in **2023**.
- **The funding series was never answered, because it has never been asked.**
  `ONB Funding`, `ACOA Funding`, `IRAP Funding`, `BDC Funding`, `SRED Funding`,
  `Angel Investment`, `Venture Capital Funding` — defined on all 82, zero values.
  These are the leverage and NB co-investment inputs, and the fields exist in
  Visible without being part of the quarterly request NBIF sends to portfolio
  companies. **Adding them is a later-stage opportunity** (confirmed 13 August
  2026), and it is the same trade as action A-1: the series can only start from
  the quarter the request changes.
- **The investment fields are empty for the same reason.** The portfolio
  properties `Total Invested`, `Fair Market Value`, `Ownership %`, `Shares
  Owned`, `Entry Pre Money Valuation` and `Investment Date` exist per fund and
  are not filled in. **Whether Visible should hold rounds, funds and transactions
  — that is, act as NBIF's transaction register — is an open organisational
  question, not a platform decision** (13 August 2026). Until it is answered,
  ADR-011 stands: the `transaction` table is the registry, and A6 generates the
  financial spine synthetically.
- **No diversity metric exists yet.** Nothing matches
  `/c-suite|women|gender|diversity/`. Action A-1 is still open, and every quarter
  it stays open is a permanent hole in the series.

## Cost

A full sync is **~97 requests**: 1 profiles page, 27 metric pages, and the
batched data point reads. Comfortably inside 500 per 5 minutes for a nightly
run — but repeated manual runs will hit the limit, and do: the client's backoff
was exercised for real during A5 and recovered at 2s, 4s, 8s, 16s.
