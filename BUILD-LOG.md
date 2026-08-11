# Build Log — Portfolio Command

A running record of what was built, in what order, and what changed. Complements `docs/architecture-decisions.md`: **ADRs capture decisions with lasting consequence; this file captures what actually happened.**

Newest entries at the top. Update at the end of every working session — an entry with nothing under "Changed" or "Outstanding" is still worth writing, because the gaps are what future-you needs.

---

## Entry format

```
## YYYY-MM-DD · Phase ref · Short title

**Built**
- What now exists that did not before.

**Changed**
- Anything altered from the plan, the schema, or an earlier build. Say why.

**Decided**
- Judgement calls made in passing. If it has lasting consequence, also raise an ADR.

**Outstanding**
- What is blocked, deferred, or needs someone else.
```

Phase refs come from `docs/delivery-roadmap.md` — A0, A1, A2 and so on, suffixed for sub-tasks (A0.1, A0.2). Track B and C items use B and C refs.

---

## 2026-07-29 · A0.1 · Repository scaffold, local database, migrations, reference seed

**Built**
- npm workspaces monorepo (Node 22): `apps/web` (minimal Next.js 15 App Router scaffold, no UI — A2 ports the prototype), `packages/metrics` (empty, vitest wired — A1 fills it), `packages/db`, `functions/` (placeholder — Azure Functions runtime scaffold arrives at A4).
- `docker-compose.yml` at root: `postgres:17`, credentials from the gitignored `.env`; `.env.example` committed with placeholders only.
- Custom plain-SQL migration runner (`packages/db/src/migrate.ts`): sorted `NNNN_name.sql` files, one transaction each, sha-256 checksums in `public.schema_migrations`, advisory-locked, forward-only. Migration `0001_init.sql` is a **verbatim copy** of `docs/schema.sql`; `packages/db/test/migration-parity.test.ts` fails the build if they ever diverge. `docs/schema.sql` was not modified.
- Reference seed (`packages/db/src/seed.ts`), idempotent: ref_sector (9), ref_funnel_stage (8, Closed/Passed terminal), ref_source_channel (14, incl. the Propel/Apex/AVF/ONB/AllNB split) from `docs/affinity-vocabularies.csv`; ref_stage (6) and ref_instrument (5) from the prototype constants; ref_valuation_method (6). The CSV's health and nb_region sections are CHECK constraints, not tables, and are not seeded.
- Type generation from the live database: `db:types` runs kysely-codegen into `packages/db/src/generated/db.ts` (47 tables and views, committed so typecheck never needs a running database).
- Root scripts: `db:up`, `db:down`, `db:migrate`, `db:seed`, `db:types`, `lint`, `typecheck`, `test`.

**Verified** — full clean cycle (`docker compose down -v` → `db:up` → `db:migrate` → `db:seed`) run end to end:
- `docs/schema.sql` applies cleanly to a fresh database with **no changes required**. Nothing in it was wrong.
- `db:migrate` re-run is a no-op ("up to date"); `db:seed` re-run yields identical counts.
- Reference tables: sector 9, funnel stage 8 (Closed/Passed terminal), source channel 14, stage 6, instrument 5, valuation method 6. Casing normalised (Breakthru, Investor Connection); the Propel/Apex/AVF/ONB/AllNB row split into five channels as intended.
- `db:types` generates all 47 relations including every derived view (`v_synthetic_data_status`, `v_mandate_completeness`, `v_round_leverage`, `v_company_current`, …). `typecheck`, `lint` and the parity test all pass against it.

**Decided**
- Custom ~110-line migration runner over node-pg-migrate/dbmate — zero extra dependencies, wholly readable, nothing fighting hand-written SQL. Forward-only; a bad migration is corrected by the next one. (Approved this session.)
- ref_valuation_method seeded with the six methods the prototype produces: Last round, Revenue multiple, Calibrated last round, Scenario-weighted, Write-off, Realized. Free-text variants in the demo marks ("Revenue multiple, discounted") belong in the mark's rationale. (Approved this session.)
- Kysely + kysely-codegen as the typed query builder and type source — types come from introspecting the live DB, never hand-maintained; Kysely is the query builder A3 will use anyway. Not an ORM. Two properties worth keeping: `numeric` generates as **string**, not `number`, so money cannot silently become a float (ADR-008); and the schema's SQL `comment on` text carries through as JSDoc, putting the ADR rationale in the types themselves.
- `postgres:17` locally to match what a new Azure Flexible Server provisions; pin the exact minor at the A0 Azure step.
- eslint-config-next deferred to A2 (no React code yet); root typescript-eslint flat config covers everything for now.

**Outstanding**
- `npm audit` reports transitive high-severity findings, all in dev tooling (an old minimatch chain under eslint and kysely-codegen; postcss/sharp pinned by next). Nothing reachable in this scaffold; revisit when next/eslint publish patched pins.
- TODO carried in `seed.ts`: ref_funnel_stage must eventually be seeded from Affinity's Status dropdown-option metadata, not the CSV — ranks 2, 8, 9 and 11 exist unobserved (ADR-009).

---

## 2026-07-29 · Pre-development · Architecture and data design complete

**Built**
- Nothing in code yet. This entry records the design phase so the log starts from a known state.

**Decided** — the full set is in `docs/architecture-decisions.md`; the ones that shape day-to-day work:
- ADR-001 · The prototype's JSON schema is the frozen API and export contract; the storage model underneath is normalised.
- ADR-002 · Transactions are the only stored financial facts. Eighteen prototype fields are derived and must not be stored.
- ADR-003 · TypeScript end to end, reversing an earlier recommendation of a Python metrics service. Rationale: solo maintainer, non-development MSP for coverage.
- ADR-006 · Reporting periods stored as dates; fiscal and calendar quarter labels both derived. Fiscal year starts 1 April; Visible reports on calendar quarters.
- ADR-007 · Valuation marks effective 31 January and 31 July, carried forward between cycles. Two of four quarters show no revaluation, labelled on screen.
- ADR-011 · The platform is the transaction registry. Excel bulk upload first, in-app Finance forms second, same table.
- ADR-013 · Metric definitions frozen at the prototype's implementations, guarded by golden-master tests.
- ADR-014 · Frontend ports one-to-one. Two sanctioned content exceptions.
- ADR-018 · Financial rows append-only; corrections are reversals or supersessions.
- ADR-019 · Finance data lands in staging templates in their own terms, not production schema.
- ADR-020 · Development runs on synthetic financial data calibrated to Affinity's real figures. Real history is a cutover event.

**Outstanding**
- **A-8 · Request a 5–10 company real sample from Finance.** Highest-leverage open item. Validates that the schema fits how Finance actually holds data, before everything is built on the assumption.
- **A-7 · Confirm Affinity v2 and Visible.vc API access on current plan tiers.**
- **A-1 · Add women in C-suite and C-suite size to the Visible quarterly request.** The series begins only from the quarter the request changes.
- **Verify the identifier namespace.** The CSV export's `Organization Id` (224–313 million) and the v2 API's `entity.id` (1,783,269) were observed in different ranges. Confirm before using either as a crosswalk key; `website` is the intended join.
- Start capturing round totals and NB co-investors on paper for deals closing before the capture form exists.

---

## 2026-07-29 · Data source confirmation · Affinity live data profiled

**Built**
- `docs/affinity-field-mapping.csv` — field-by-field mapping for both list views, with fill rates, transforms and controlled vocabularies ready to seed the reference tables.

**Changed**
- **Corrected an error.** An earlier reading treated Affinity's Pipeline and Portfolio as two separate lists that lose history at the boundary, and proposed a `pipeline_stage_history` table to reconstruct it by nightly snapshotting. They are two saved *views* of one list (`listId 328745`) filtered by Status. The table was removed.
- Replaced it with `affinity_field_change`, a local mirror of Affinity's own change log. Affinity remains system of record; the mirror exists because the endpoint is per-list-entry and a funnel chart would otherwise fan out to one API call per deal.
- Added `company.nb_region` (NW/NE/SW/SE) — a mandate reporting dimension the prototype lacked.
- Replaced `company_state.affinity_risk_grade` with `risk_grade` constrained to A/B/C/ACC, and extended `health` with `acc`.
- Added `company.affinity_fmv` and `company.affinity_total_investment` as reference-only columns.
- Added `pipeline_deal_owner` — Affinity's Owners field is person-multi and accumulates; the platform mirrors the full list rather than picking one.

**Decided**
- Sector taxonomy is Affinity's eight provincial priority sectors plus Other, unchanged. No invented sectors to absorb the Other population.
- Risk Assessment drives health. A/B/C map to green/yellow/red; ACC carries no risk colour.
- Accelerator investments are **included** in fund-wide MOIC, leverage and FMV growth, with a dashboard toggle keyed on the ACC tag. Metric functions take an `includeAccelerator` option so the toggle changes an argument rather than forking the definition.
- Owners governs pipeline stages, VC Lead governs portfolio stages. Ownership commonly changes hands at diligence.
- Source of Deal carries through verbatim; case-folding applied for chart grouping only.
- Affinity's FMV and Total Investment Amount are reference-only and never enter a calculation. The synthetic generator is calibrated to them so company-level figures land in a plausible range.

**Outstanding**
- Seed `ref_funnel_stage` from the Status field's dropdown-option metadata, not from observed values — ranks 2, 8, 9 and 11 exist unobserved.
- Handle `referenceType: deleted-entity` in the sync: store `displayValue`, tolerate the absent `dropdownOptionId`.
- Affinity date-only fields arrive at US Pacific midnight in UTC. Pin the timezone on extraction.
- Two VC Lead records in the export carry non-`nbif.ca` addresses and will not resolve against Entra. Fix in Affinity.