# CLAUDE.md — Portfolio Command

Read this first. It is the standing brief for every session in this repository.

## What this is

A portfolio management platform for NBIF: direct investments and strategic LP positions, with dashboard, portfolio monitoring, pipeline, reserves and exit modelling, IC memos, board reporting, and economic-development mandate KPIs (leverage, FMV growth, NB jobs, NB co-investment, diversity).

It is a production rebuild of a working single-file prototype (`docs/reference/vc-toolkit.html`). The prototype's product decisions and metric definitions are **settled and validated**. The engineering is being replaced; the definitions are not.

Maintained by one developer, who is also the organisation's internal IT. Emergency coverage comes from an external MSP that is not a development shop. **Optimise for a stack one person can hold in their head and another can restart at 9pm.**

## Non-negotiables

These are settled architecture decisions. Do not work around them; if one seems wrong, stop and raise it rather than routing past it.

1. **The JSON export contract is frozen** (ADR-001). `GET /api/v1/export` emits the shape documented in the prototype's Data tab, field for field. A snapshot test guards it. Money is `$M` in the contract and **dollars in the database** — the API layer converts in exactly one place.
2. **Derived values are never stored** (ADR-002, as amended by ADR-027). `invested`, `fmv`, `realized`, `exited`, `vintage`, `called`, `distributions` and seven others are computed from transactions, rounds and marks. If you find yourself adding a column that duplicates a sum, stop. **Four fields left that list at A3** — `reservesDeployed`, `runwayMo`, `fteAtEntry` and `company.instrument` — because measurement showed they are independent facts with no derivation, not sums. That is the only sanctioned exit, and it took evidence.
3. **Metric definitions are frozen at the prototype's implementations** (ADR-013). Golden-master fixtures in `packages/metrics` assert this. A failing golden-master test means you changed a board number — fix the code, never the fixture, unless a decision in `docs/architecture-decisions.md` says otherwise.
4. **The frontend ports one-to-one** (ADR-014). Same layout, terminology, colour conventions, drawer behaviour, eight tabs. "Looks identical to the prototype" is the acceptance criterion. Two sanctioned exceptions: revenue is labelled quarterly rather than run-rate, and the diversity tile shows coverage instead of treating unreported as zero.
5. **Financial rows are append-only** (ADR-018). Transactions, valuation marks and LP cashflows are corrected by reversal or supersession, never edited in place. The UI offers **Correct** and **Reverse**, not Edit. Judgement fields — health, flags, milestones, memos, gates — are freely editable with an audit trail.
6. **Synthetic data is flagged and announced** (ADR-020). Every generated financial row carries `is_synthetic`. While `v_synthetic_data_status.contains_synthetic` is true, a persistent banner appears on every screen and every PDF export. Never suppress it.
7. **Affinity and Visible sync one way, inbound only** (ADR-009, ADR-010). The platform never writes to either.
8. **No secrets in code.** Azure Key Vault, environment variables locally. Never commit a connection string, API key or token.

## Where things are

| Path | Contents |
|---|---|
| `docs/architecture-decisions.md` | 20 ADRs plus the decision log. **The authority for any "why is it like this" question.** |
| `docs/delivery-roadmap.md` | Phased build sequence, effort, exit criteria, risks |
| `docs/schema.sql` | Postgres DDL: tables, views, period-labelling functions |
| `docs/field-inventory.csv` | All 148 prototype fields → source system → target table and column |
| `docs/affinity-field-mapping.csv` | Affinity field → target column, transforms, controlled vocabularies |
| `docs/reference/vc-toolkit.html` | The prototype. Source of truth for UI and metric behaviour. |
| `docs/reference/demo.json` | Exported seed fixture — the frontend builds against this before the API exists |
| `BUILD-LOG.md` | What was built, in what order, and what changed. **Update it every session.** |
| `apps/web/` | Next.js + TypeScript + Recharts. Route handlers under `app/api/v1/`. |
| `packages/contract/` | The ADR-001 export contract as TypeScript types. No runtime code, no dependencies. |
| `packages/metrics/` | Pure metric functions and golden-master fixtures. No React, no database, no I/O. |
| `packages/api/` | The read path, the write path, auth, and the `$M`/dollars boundary. Knows nothing about HTTP. |
| `packages/db/` | SQL migrations, seed scripts, generated types |
| `functions/` | Azure Functions for the Affinity and Visible syncs |

## Stack

TypeScript end to end, deliberately (ADR-003) — one language keeps the whole system inside one person's working memory.

- **Next.js + TypeScript**, Azure App Service
- **PostgreSQL** — Azure Database for PostgreSQL Flexible Server, Canada Central. Docker locally.
- **Plain SQL migrations.** `schema.sql` is the starting point. The schema uses views, generated columns and lateral joins; do not introduce an ORM that fights hand-written SQL.
- **Typed queries with types generated from the live database**, not hand-maintained.
- **Entra ID via MSAL.** Four roles: `vc`, `finance`, `leadership`, `admin`. Staff only — board members receive PDFs, not accounts.
- **Recharts** for charts, replacing the prototype's Chart.js at visual parity.
- **Playwright** for board PDF generation, replacing the prototype's print stylesheet.

## Conventions

- Money: `numeric(18,2)` in dollars. Never floats, never millions, never in a URL.
- Dates: `date` for effective dates, `timestamptz` for events. Reporting periods store `period_start`/`period_end`; quarter labels are **derived**, never stored or keyed on.
- Two quarter conventions coexist deliberately: **fiscal** (year starts 1 April) on Reports and board-facing views, **calendar** on the Portfolio KPI history because that is what Visible reports. Every quarterly view states which it is using.
- Metrics are never computed in a React component. Import from `packages/metrics`.
- Every write to a financial or mandate field goes through `audit_log`.
- Affinity dates arrive as UTC timestamps anchored to US Pacific midnight. Pin the timezone when extracting a date.

## Working style

- Small commits, each one a single reviewable change.
- Tests alongside the code, not after. The metrics package especially.
- When a task turns out to need a decision that is not in the ADRs, **stop and ask** rather than picking one silently. Record the answer in `BUILD-LOG.md`; if it has lasting consequence, it belongs in `docs/architecture-decisions.md` as a new ADR.
- Update `BUILD-LOG.md` at the end of every session: what was built, what changed, what is now blocked or outstanding.