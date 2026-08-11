-- =====================================================================
-- Portfolio Command - Production Schema v1
-- Target: Azure Database for PostgreSQL Flexible Server (Canada Central)
--
-- Design rules (see architecture-decisions.md):
--   ADR-002  Transactions are the only stored financial facts.
--            Every portfolio scalar is DERIVED. Nothing that can be
--            computed from a transaction, round or mark is stored.
--   ADR-006  Reporting periods are stored as DATES. Labels (calendar
--            and fiscal) are derived, never keyed on.
--   ADR-008  Reporting currency is CAD. Currency and FX columns are
--            retained so a single USD position never forces a migration.
--   Money is stored in DOLLARS, not millions. The API divides by 1e6
--   on the way out so Daniel's $M JSON contract is unchanged.
-- =====================================================================

create schema if not exists pc;
set search_path = pc, public;

create extension if not exists "uuid-ossp";

-- =====================================================================
-- 1. REFERENCE DATA
-- Extensible lists live in tables so a new sector does not need a
-- migration. Small fixed sets use CHECK constraints instead.
-- =====================================================================

create table ref_sector (
  sector_id     serial primary key,
  name          text not null unique,
  is_active     boolean not null default true,
  sort_order    int not null default 0
);

create table ref_stage (
  stage_id      serial primary key,
  name          text not null unique,   -- Pre-Seed, Seed, Series A, Series B, Series C+, Growth
  sort_order    int not null
);

create table ref_instrument (
  instrument_id serial primary key,
  name          text not null unique    -- SAFE, Convertible Note, Debt-to-Note, Preferred Equity, Common Equity
);

create table ref_source_channel (
  source_channel_id serial primary key,
  name          text not null unique,   -- University spinout, Accelerator, Founder referral, ...
  is_active     boolean not null default true
);

create table ref_funnel_stage (
  funnel_stage_id serial primary key,
  name          text not null unique,   -- Sourced, Screening, Diligence, IC Review, Term Sheet, Closed, Passed
  sort_order    int not null,
  is_terminal   boolean not null default false
);

create table ref_valuation_method (
  valuation_method_id serial primary key,
  name          text not null unique,   -- Last round, Revenue multiple, Calibrated last round, ...
  is_active     boolean not null default true
);

-- Affinity status -> funnel stage mapping. Replaces the regex in the
-- MVP's importAffinityCsv() with an editable table (ADR-009).
create table affinity_status_map (
  affinity_status  text primary key,
  funnel_stage_id  int not null references ref_funnel_stage,
  updated_at       timestamptz not null default now()
);

-- =====================================================================
-- 2. IDENTITY AND ACCESS
-- Staff only. Board members consume PDF exports, not accounts (ADR-005).
-- =====================================================================

create table app_user (
  user_id          uuid primary key default uuid_generate_v4(),
  entra_object_id  text not null unique,
  display_name     text not null,
  email            text not null unique,
  role             text not null check (role in ('vc','finance','leadership','admin')),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);

comment on column app_user.role is
  'vc = investment team; finance = transactions and valuation marks; leadership = read-all; admin = config';

-- =====================================================================
-- 3. FUND
-- One row today. Table form so a second vehicle never forces a rewrite.
-- =====================================================================

create table fund (
  fund_id                  int primary key generated always as identity,
  name                     text not null,
  style                    text not null check (style in ('evergreen','closed-end')),
  reporting_currency       char(3) not null default 'CAD',
  inception_year           int not null,
  fiscal_year_start_month  int not null default 4
                             check (fiscal_year_start_month between 1 and 12),
  capital_base             numeric(18,2),      -- evergreen
  committed                numeric(18,2),      -- closed-end only
  called                   numeric(18,2),      -- closed-end only
  fee_drag_pct             numeric(6,3),
  distribution_policy      text,
  reserves_policy          text,
  annual_platform_target   int,
  annual_followon_budget   numeric(18,2),
  updated_at               timestamptz not null default now()
);

comment on column fund.fiscal_year_start_month is
  '4 = April. Drives every fiscal quarter label. Visible.vc reports on CALENDAR quarters; both labels are derived from period dates (ADR-006).';
comment on column fund.fee_drag_pct is
  'Net IRR = gross IRR minus this. An estimate. The "estimate" label must survive to the UI.';

-- =====================================================================
-- 4. COMPANY
-- Identity is slowly-changing; stage and health are dated history.
-- =====================================================================

create table company (
  company_id          text primary key,          -- Cnnn, preserved for export readability
  affinity_org_id     text unique,               -- entity resolution
  affinity_row_id     text,
  visible_company_id  text unique,               -- entity resolution
  name                text not null,
  legal_name          text,
  sector_id           int references ref_sector,
  sector_label        text,                      -- verbatim contract string (ADR-026)
  source_channel_id   int references ref_source_channel,
  source_label        text,                      -- verbatim contract string (ADR-026)
  ceo_name            text,
  hq_city             text,
  hq_region           text,                      -- province/state. Drives the NB mandate split.
  nb_region           text check (nb_region in ('NW','NE','SW','SE')),
  hq_country          text default 'CA',
  description         text,
  website             text,
  ceo_email           text,
  instrument_id       int references ref_instrument,  -- headline instrument (ADR-027)
  instrument_label    text,                      -- verbatim contract string (ADR-026)
  fte_at_entry        int,                       -- ADR-027
  cb_total_funding_usd numeric(18,2),            -- Crunchbase-derived. Cross-check only, never a leverage input.
  affinity_fmv        numeric(18,2),            -- REFERENCE ONLY. VC-team maintained. Never enters a calculation.
  affinity_total_investment numeric(18,2),      -- REFERENCE ONLY. Same.
  affinity_figures_as_of date,
  is_nb_based         boolean generated always as (hq_region = 'NB') stored,
  created_at          timestamptz not null default now(),
  created_by          uuid not null references app_user,
  synced_at           timestamptz                -- last Affinity sync
);

comment on column company.affinity_fmv is
  'REFERENCE ONLY, shown in the drawer as a VC-team-maintained figure. Finance''s valuation_mark is authoritative (ADR-007). Post-launch it becomes a reconciliation signal between the two systems.';
comment on column company.fte_at_entry is
  'ADR-027. Headcount at first investment. NOT derivable from company_kpi: the KPI series begins when Visible reporting begins, which for an old vintage is a decade after entry. On the reference dataset the series covers three quarters and every entry figure predates it.';
comment on column company.instrument_id is
  'ADR-027. The company''s headline instrument, which is NOT mechanically the first or last round''s: C009 in the reference dataset reads Debt-to-Note against a latest round of Preferred Equity. Stored because it is an independent fact, not a sum.';
comment on column company.sector_label is
  'ADR-026. The verbatim string the ADR-001 contract carries, which the API serialises. sector_id is the resolved reference key and is NULL where no exact match exists - the importer never invents a ref_sector row and never coerces to a nearest neighbour. Expected to be redundant once the roster is real and its vocabulary is Affinity''s (ADR-009).';

create index on company (sector_id);
create index on company (affinity_org_id);

-- Dated attribute history. Lets a board report state stage-at-entry and
-- health-as-at-the-reporting-date rather than only today's value.
create table company_state (
  company_state_id  bigint primary key generated always as identity,
  company_id        text not null references company on delete cascade,
  effective_from    date not null,
  effective_to      date,                        -- null = current
  stage_id          int references ref_stage,
  health            text check (health in ('green','yellow','red','acc')),
  risk_grade        text check (risk_grade in ('A','B','C','ACC')),
  lifecycle_status  text,                        -- Affinity Portfolio Status: Actively Fundraising, Winding Down, Exit Path, Closed
  set_by            uuid not null references app_user,
  set_at            timestamptz not null default now(),
  note              text
);

comment on column company_state.risk_grade is
  'From Affinity Risk Assessment. A / B / C map to the green / yellow / red health display; ACC marks an accelerator investment and carries no risk grade.';

create unique index company_state_current_uq
  on company_state (company_id) where effective_to is null;
create index on company_state (company_id, effective_from);

create table company_risk_flag (
  company_risk_flag_id bigint primary key generated always as identity,
  company_id     text not null references company on delete cascade,
  flag_text      text not null,
  raised_at      date not null default current_date,
  cleared_at     date,
  raised_by      uuid not null references app_user
);

create table company_threshold (
  company_id           text primary key references company on delete cascade,
  -- NULLABLE with no default, deliberately. The contract makes minRunwayMo
  -- optional and gives 0 the distinct meaning "alert disabled", so a default of
  -- 12 would invent a threshold for a company that has none and put it on the
  -- watchlist on the strength of a number nobody set.
  min_runway_months    int,
  max_burn_multiple    numeric(6,2),
  updated_by           uuid not null references app_user,
  updated_at           timestamptz not null default now()
);

create table company_exit (
  company_id   text primary key references company on delete cascade,
  exit_date    date not null,
  -- 'Strategic acquisition' added at A3: a genuine exit type the original
  -- list omitted, not a vocabulary collision (ADR-026).
  exit_type    text not null
                 check (exit_type in ('Acquisition','Strategic acquisition','IPO',
                                      'Secondary','Shutdown / write-off')),
  note         text,
  recorded_by  uuid not null references app_user
);

-- =====================================================================
-- 5. TRANSACTION REGISTRY
-- The single source of every dollar. Nothing else stores money movement.
-- Phase 1 front door: Excel bulk upload. Phase 2: in-app Finance form.
-- (ADR-011)
-- =====================================================================

create table investment_round (
  investment_round_id  bigint primary key generated always as identity,
  company_id           text not null references company on delete cascade,
  round_date           date not null,
  label                text not null,            -- Seed, Series A, ...
  instrument_id        int not null references ref_instrument,

  -- MANDATE FIELDS. Captured by the deal lead at close (ADR-012).
  -- NULL means "unknown" and is EXCLUDED from leverage, never imputed.
  is_synthetic         boolean not null default false,  -- ADR-020
  round_total          numeric(18,2),
  nb_other             numeric(18,2),

  post_money           numeric(18,2),            -- null for SAFE / convertible note
  -- Scale carries a full IEEE-754 double, not a claim about cap-table accuracy.
  -- ADR-001 requires the export to reproduce its input, and the contract's
  -- ownershipAfter is a computed float: the reference dataset holds values like
  -- 10.521185332909226. numeric(7,4) would round that to 10.5212 and the round
  -- trip would fail on four rows. Display formatting is the UI's business.
  ownership_after_pct  numeric(19,16),
  lead_investor        text,
  note                 text,
  source_document      text,                     -- SharePoint link to closing docs
  captured_by          uuid references app_user,
  captured_at          timestamptz,

  constraint round_total_gte_zero check (round_total is null or round_total >= 0),
  constraint nb_other_within_round check (
    nb_other is null or round_total is null or nb_other <= round_total)
);

create index on investment_round (company_id, round_date);

comment on column investment_round.round_total is
  'Full round size including all investors. DRIVES THE LEVERAGE MANDATE KPI. Exists in no upstream system - entered by the deal lead at close.';
comment on column investment_round.nb_other is
  'Capital from OTHER New Brunswick investors in this round, excluding ours. DRIVES THE NB CO-INVESTMENT MANDATE KPI.';

-- Who else was in the round. Lets capitalToDirect and coInvestsDone be
-- derived instead of hand-maintained on the LP position (ADR-002).
create table round_coinvestor (
  round_coinvestor_id bigint primary key generated always as identity,
  investment_round_id bigint not null references investment_round on delete cascade,
  investor_name       text not null,
  fund_investment_id  text,                      -- set when it is one of our LP positions
  is_nb_based         boolean not null default false,
  amount              numeric(18,2)
);

create table transaction (
  transaction_id       bigint primary key generated always as identity,
  txn_date             date not null,            -- effective date
  booked_at            timestamptz not null default now(),
  txn_type             text not null check (txn_type in
                         ('investment','follow_on','realization','write_off',
                          'capital_call','distribution','fee')),
  company_id           text references company,
  fund_investment_id   text,
  investment_round_id  bigint references investment_round,
  amount               numeric(18,2) not null,   -- DOLLARS, not millions
  currency             char(3) not null default 'CAD',
  fx_rate_to_cad       numeric(18,8),            -- null when currency = CAD
  source_document      text,
  note                 text,
  entered_by           uuid not null references app_user,
  batch_id             uuid,                     -- groups an Excel bulk upload

  -- ADR-018: financial rows are append-only. An error is voided by a
  -- dated reversal referencing the original; the original is never edited.
  is_synthetic         boolean not null default false,  -- ADR-020
  voided_by_transaction_id bigint references transaction,
  voided_at            timestamptz,
  voided_reason        text,
  reverses_transaction_id  bigint references transaction,
  constraint txn_one_subject check (
    (company_id is not null and fund_investment_id is null) or
    (company_id is null and fund_investment_id is not null)),
  constraint txn_direct_types check (
    company_id is null or txn_type in
      ('investment','follow_on','realization','write_off')),
  constraint txn_lp_types check (
    fund_investment_id is null or txn_type in
      ('capital_call','distribution','fee')),
  constraint txn_fx_present check (
    currency = 'CAD' or fx_rate_to_cad is not null)
);

create index on transaction (company_id, txn_date);
create index on transaction (fund_investment_id, txn_date);
create index on transaction (txn_type, txn_date);

comment on table transaction is
  'THE registry. Replaces the MVP''s duplicated company.realized and fund.distributions[] with one authoritative table (ADR-002, Q4).';
comment on column transaction.amount is
  'Always positive. Direction is implied by txn_type. Capital calls are outflows, distributions are inflows.';

-- =====================================================================
-- 6. VALUATION
-- Semi-annual FMV exercise, cutoffs end of January and end of July.
-- Entry by the Director of Finance IS the sign-off (ADR-007, Q8).
-- =====================================================================

create table valuation_mark (
  valuation_mark_id   bigint primary key generated always as identity,
  company_id          text not null references company on delete cascade,
  effective_date      date not null,             -- the date the mark is "as at"
  booked_at           timestamptz not null default now(),
  fmv                 numeric(18,2) not null check (fmv >= 0),
  currency            char(3) not null default 'CAD',
  valuation_method_id int references ref_valuation_method,
  method_label        text not null,             -- verbatim contract string (ADR-026)
  rationale           text not null,             -- REQUIRED. The audit narrative.
  prepared_by         uuid references app_user,
  prepared_by_label   text not null,             -- verbatim contract string (ADR-026)
  is_synthetic        boolean not null default false,  -- ADR-020
  status              text not null default 'final'
                        check (status in ('draft','final','superseded')),
  supersedes_id       bigint references valuation_mark,
  source_document     text
);

create unique index valuation_mark_active_uq
  on valuation_mark (company_id, effective_date)
  where status = 'final';
create index on valuation_mark (company_id, effective_date desc);

comment on table valuation_mark is
  'Only source of company FMV. Between exercises the most recent final mark is carried forward; companies with no mark yet are held at cost (ADR-007).';
comment on column valuation_mark.rationale is
  'Not optional. This is what a board or auditor reads when they challenge a number.';
comment on column valuation_mark.method_label is
  'ADR-026. The verbatim method string the ADR-001 contract carries, which the API serialises. Marks routinely qualify a canonical method in free text - "Revenue multiple, discounted", "Last round + backlog coverage" - and that qualification is meaningful to whoever reads the mark. valuation_method_id resolves to ref_valuation_method only on an exact match and is NULL otherwise; it is what grouping and filtering use.';

-- =====================================================================
-- 7. COMPANY KPIs
-- From Visible.vc, quarterly, on CALENDAR quarters (Q2 2026 = Apr-Jun,
-- due 5 Aug). Jobs and diversity are part of this series, NOT company
-- scalars, so the mandate trend is available for any past period.
-- (ADR-006, ADR-010)
-- =====================================================================

create table company_kpi (
  company_kpi_id  bigint primary key generated always as identity,
  company_id      text not null references company on delete cascade,
  period_start    date not null,
  period_end      date not null,
  revenue         numeric(18,2),                 -- run-rate
  monthly_burn    numeric(18,2),                 -- negative = cash-flow positive
  cash_balance    numeric(18,2),
  runway_months   numeric(8,2),                  -- as reported, NOT cash/burn (ADR-027)
  fte             int,                           -- MANDATE: jobs
  fte_nb          int,                           -- MANDATE: NB jobs
  women_csuite    int,                           -- MANDATE: diversity
  csuite_size     int,
  source_system   text not null default 'visible'
                    check (source_system in ('visible','manual')),
  reported_at     timestamptz not null default now(),
  request_version text,                          -- which Visible request wording produced this

  constraint kpi_period_order check (period_end >= period_start),
  constraint kpi_fte_nb_within check (fte_nb is null or fte is null or fte_nb <= fte),
  constraint kpi_women_within  check (women_csuite is null or csuite_size is null
                                      or women_csuite <= csuite_size)
);

create unique index on company_kpi (company_id, period_end);
create index on company_kpi (period_end);

comment on column company_kpi.runway_months is
  'ADR-027. AS REPORTED by the company, not computed. cash_balance / monthly_burn reproduces it on 10 of 71 rows in the reference dataset - C004 reports 99 months against a computed 610 - because a founder nets expected inflows and a committed round against the burn, and the platform is not the system of submission (ADR-017). It drives the runway health alert, so a computed substitute would change which companies appear on the watchlist.';
comment on column company_kpi.request_version is
  'Definitions for FTE / NB FTE / C-suite live in the Visible request text. Stamping the version makes a definition change visible as a break in the series rather than a silent shift (Q6).';

-- =====================================================================
-- 8. OWNERSHIP AND RESERVES
-- =====================================================================

create table company_ownership (
  company_ownership_id bigint primary key generated always as identity,
  company_id       text not null references company on delete cascade,
  as_of_date       date not null,
  -- Scale matches investment_round.ownership_after_pct; see the note there.
  ownership_pct    numeric(19,16) not null check (ownership_pct between 0 and 100),
  pro_rata_rights  boolean not null default false,
  is_synthetic     boolean not null default false,  -- ADR-020
  fully_diluted    boolean not null default true,
  source_document  text,                         -- link to the SharePoint cap table version used
  entered_by       uuid not null references app_user
);

create unique index on company_ownership (company_id, as_of_date);

comment on table company_ownership is
  'Dated ownership so MOIC and the waterfall are as-of correct. The SharePoint XLSX remains the source document; this table is the structured system of record (ADR-012).';

create table reserve_allocation (
  reserve_allocation_id bigint primary key generated always as identity,
  company_id     text not null references company on delete cascade,
  allocated      numeric(18,2) not null,
  deployed       numeric(18,2) not null default 0,  -- ADR-027
  policy_basis   text,                            -- e.g. "0.8x initial check, green + pro-rata"
  effective_from date not null default current_date,
  set_by         uuid not null references app_user,
  set_at         timestamptz not null default now()
);

create index on reserve_allocation (company_id, effective_from desc);

comment on column reserve_allocation.deployed is
  'ADR-027. How much of the allocated reserve has been drawn. NOT the sum of follow-on rounds, and the difference is not rounding: C001 in the reference dataset reads 1.5 against a 3.5 follow-on, C004 reads 6.0 against 8.0. A follow-on can be funded from a new allocation rather than the reserve, and a reserve can be released without being deployed. Reserve accounting is a decision the investment team records, not an arithmetic consequence of the transactions.';

-- =====================================================================
-- 9. GOVERNANCE AND MONITORING
-- =====================================================================

create table board_seat (
  board_seat_id     bigint primary key generated always as identity,
  company_id        text not null references company on delete cascade,
  seat_type         text not null check (seat_type in ('Director','Observer','None')),
  holder_user_id    uuid references app_user,
  holder_name       text,                        -- for holders who are not app users
  next_meeting_date date,
  effective_from    date not null default current_date,
  effective_to      date
);

create table company_milestone (
  company_milestone_id bigint primary key generated always as identity,
  company_id  text not null references company on delete cascade,
  title       text not null,
  due_date    date,
  status      text not null check (status in ('on-track','at-risk','pending','met','missed')),
  updated_by  uuid not null references app_user,
  updated_at  timestamptz not null default now()
);

create table company_covenant (
  company_covenant_id bigint primary key generated always as identity,
  company_id     text not null references company on delete cascade,
  covenant_text  text not null,
  -- status stays a three-value vocabulary; the narrative that arrives with it
  -- in the contract ("watch - 1.9x in Q1") lives in status_detail (ADR-026).
  status         text not null check (status in ('compliant','watch','breach')),
  status_detail  text,                            -- verbatim contract string
  source_document text,
  updated_by     uuid not null references app_user,
  updated_at     timestamptz not null default now()
);

create table company_gov_funding (
  company_gov_funding_id bigint primary key generated always as identity,
  company_id    text not null references company on delete cascade,
  program_name  text not null,
  amount        numeric(18,2),
  conditions    text,
  status        text not null check (status in ('active','conditions pending','at risk','closed')),
  updated_by    uuid not null references app_user,
  updated_at    timestamptz not null default now()
);

create table company_task (
  company_task_id bigint primary key generated always as identity,
  company_id  text not null references company on delete cascade,
  title       text not null,
  due_date    date,
  is_done     boolean not null default false,
  assigned_to uuid references app_user,
  created_by  uuid not null references app_user,
  created_at  timestamptz not null default now()
);

-- =====================================================================
-- 10. LP POSITIONS (strategic fund investments)
-- Never blended with the direct portfolio. LP multiples are on called
-- capital; direct MOIC is on invested cost.
-- =====================================================================

create table fund_investment (
  fund_investment_id text primary key,           -- Fnnn
  name               text not null,
  manager_name       text not null,
  strategy           text,
  vintage_year       int,
  committed          numeric(18,2) not null,
  currency           char(3) not null default 'CAD',
  co_invest_rights   boolean not null default false,
  women_senior_gp    boolean,
  -- CARRIED, not derived, and only until deal-close capture exists (ADR-027).
  -- v_lp_capital_to_direct derives all three from round_coinvestor, which is
  -- populated by the ADR-012 capture form at A8. Legacy positions predate that
  -- form and the ADR-001 contract carries no co-investor detail to reconstruct
  -- it from, so an imported value is the only value there is.
  co_invests_done    int,
  referrals          int,
  capital_to_direct  numeric(18,2),
  next_call_est      date,
  agm_date           date,
  ir_contact         text,
  rationale          text,
  source_document    text,                       -- LPA / subscription agreement
  created_by         uuid not null references app_user
);

alter table transaction
  add constraint transaction_fund_investment_fk
  foreign key (fund_investment_id) references fund_investment;

alter table round_coinvestor
  add constraint round_coinvestor_fund_fk
  foreign key (fund_investment_id) references fund_investment;

-- GP capital account statements. Dated, because GP NAV lags a quarter.
create table fund_investment_nav (
  fund_investment_nav_id bigint primary key generated always as identity,
  fund_investment_id     text not null references fund_investment on delete cascade,
  as_of_date             date not null,
  nav                    numeric(18,2) not null,
  is_synthetic           boolean not null default false,  -- ADR-020
  statement_received_at  date,
  source_document        text,
  entered_by             uuid not null references app_user
);

create unique index on fund_investment_nav (fund_investment_id, as_of_date);

comment on column fund_investment_nav.statement_received_at is
  'Tracking the gap between as_of_date and receipt makes LP NAV staleness explicit on the Funds tab.';

-- =====================================================================
-- 11. PIPELINE (mirrored one-way from Affinity)
-- =====================================================================

create table pipeline_deal (
  deal_id                 text primary key,      -- Pnnn display id
  affinity_opportunity_id text unique,
  name                    text not null,
  sector_id               int references ref_sector,
  sector_label            text,                  -- verbatim contract string (ADR-026)
  funnel_stage_id         int references ref_funnel_stage,
  funnel_label            text,                  -- verbatim contract string (ADR-026)
  source_channel_id       int references ref_source_channel,
  source_label            text,                  -- verbatim contract string (ADR-026)
  owner_label             text,                  -- verbatim contract string (ADR-026)
  referred_by_fund_id     text references fund_investment,   -- LP referral scorecard
  check_size              numeric(18,2),
  valuation               numeric(18,2),
  currency                char(3) not null default 'CAD',
  vc_lead_user_id         uuid references app_user,
  vc_secondary_user_id    uuid references app_user,
  next_step               text,
  date_added              date,
  closed_date             date,
  converted_company_id    text references company,
  affinity_row_id         text,
  stage_changed_date      date,
  last_email_date         date,
  last_meeting_date       date,
  synced_at               timestamptz not null default now()
);

create index on pipeline_deal (funnel_stage_id);

-- Affinity's Owners field is person-multi and ACCUMULATES: observed three
-- consecutive adds with no deletes on a single deal. The platform mirrors
-- the full list rather than picking one (decision, 29 Jul 2026).
create table pipeline_deal_owner (
  pipeline_deal_owner_id bigint primary key generated always as identity,
  deal_id      text not null references pipeline_deal on delete cascade,
  user_id      uuid references app_user,
  owner_email  text not null,
  owner_name   text,
  added_at     timestamptz,                      -- from the Affinity change log
  synced_at    timestamptz not null default now()
);

create unique index on pipeline_deal_owner (deal_id, owner_email);

comment on table pipeline_deal_owner is
  'Owners governs the pipeline stages; VC Lead governs the portfolio stages. Ownership commonly changes hands at diligence, when a lead and a secondary are assigned. Display in added_at order.';

comment on column pipeline_deal.converted_company_id is
  'Links a closed deal to the portfolio company it became, so the funnel can be measured end to end.';

comment on column pipeline_deal.funnel_stage_id is
  'NULLABLE at A3 only, and deliberately (ADR-026). ref_funnel_stage holds Affinity''s vocabulary; the reference fixture carries the prototype''s, and the two overlap on four values of seven - Screening, IC Review and Term Sheet have no exact Affinity equivalent. Rather than invent reference rows or coerce IC Review to Team Pitch, the key is left NULL and funnel_label carries the verbatim string. RESTORE NOT NULL at A4, when the pipeline is real and every stage resolves.';
comment on column pipeline_deal.owner_label is
  'ADR-026. The contract carries owner as a single free-text string, including "-" for unowned. vc_lead_user_id resolves it to an app_user where the name matches one; pipeline_deal_owner holds the full multi-owner list that Affinity actually governs (ADR-009).';

create table deal_gate (
  deal_gate_id bigint primary key generated always as identity,
  deal_id      text not null references pipeline_deal on delete cascade,
  gate_name    text not null,
  sort_order   int not null,
  status       text not null default 'pending'
                 check (status in ('pending','in-progress','passed','failed')),
  changed_by   uuid references app_user,
  changed_at   timestamptz
);

create unique index on deal_gate (deal_id, gate_name);

create table term_sheet (
  term_sheet_id     bigint primary key generated always as identity,
  deal_id           text not null references pipeline_deal on delete cascade,
  security          text,
  pre_money         numeric(18,2),
  post_money        numeric(18,2),
  investment        numeric(18,2),
  ownership_pct     numeric(7,4),
  liquidation_pref  text,
  anti_dilution     text,
  board_composition text,
  pro_rata_terms    text,
  dividends         text,
  option_pool       text,
  founder_vesting   text,
  issued_date       date,
  source_document   text
);

-- =====================================================================
-- 12. MEMOS
-- Many memos per subject, versioned. The MVP allowed only one.
-- =====================================================================

create table memo (
  memo_id      bigint primary key generated always as identity,
  subject_type text not null check (subject_type in ('company','deal')),
  subject_id   text not null,
  title        text not null,
  version      int not null default 1,
  status       text not null default 'draft'
                 check (status in ('draft','circulated','final')),
  decision     text check (decision in ('invest','pass','hold')),
  ic_date      date,
  author_id    uuid not null references app_user,
  created_at   timestamptz not null default now(),
  finalised_at timestamptz
);

create index on memo (subject_type, subject_id);

create table memo_section (
  memo_section_id bigint primary key generated always as identity,
  memo_id       bigint not null references memo on delete cascade,
  section_key   text not null check (section_key in
                  ('exec','thesis','market','team','topgrading','product',
                   'traction','terms','captable','risks','returns','reco')),
  body          text,
  is_autofilled boolean not null default false,
  sort_order    int not null
);

create unique index on memo_section (memo_id, section_key);

-- =====================================================================
-- 13. REPORTING SNAPSHOTS
-- Board numbers are frozen on issue so a re-run never restates history.
-- =====================================================================

create table fund_nav_snapshot (
  fund_nav_snapshot_id bigint primary key generated always as identity,
  fund_id         int not null references fund,
  period_end      date not null,
  nav             numeric(18,2) not null,
  cumulative_cost numeric(18,2) not null,
  computed_at     timestamptz not null default now(),
  frozen_at       timestamptz,                   -- set when the board report is issued
  frozen_by       uuid references app_user
);

create unique index on fund_nav_snapshot (fund_id, period_end);

comment on table fund_nav_snapshot is
  'Replaces the MVP''s manual fund.navHistory[]. Computed from marks and transactions, then frozen. Once frozen the row is never recomputed.';

-- ---------------------------------------------------------------------
-- FUND-LEVEL DISTRIBUTIONS (ADR-025)
--
-- A STATED EXCEPTION TO ADR-002, with a stated end date. ADR-002 makes
-- `transaction` the only store of money movement and names this exact
-- duplication as the thing it resolves: fund.distributions[] drives fund
-- TVPI/DPI while company.realized drives company MOIC, and the two can
-- disagree. On the reference dataset they disagree by $5.5M.
--
-- Deriving this series from realization transactions moves five board
-- numbers that ADR-013 freezes (TVPI 2.08x->2.10x, DPI 0.16x->0.18x, gross
-- IRR 19.0%->19.1%, net IRR 16.7%->16.8%, dry powder $146.7M->$152.2M).
-- A3 keeps them frozen so that any number moving during the fixture-to-API
-- swap is an adapter bug rather than an intended change. The correction is
-- deferred to A6/A13, on real data, with the VC team lead's sign-off and a
-- golden-master recapture. See ADR-025.
--
-- Deliberately a separate table rather than a nullable-subject transaction
-- row: an exception that is greppable is an exception that gets removed.
-- It is also the only place a realization from a company that predates the
-- roster can live, which historical backfill will need regardless (ADR-015).
create table fund_distribution (
  fund_distribution_id bigint primary key generated always as identity,
  fund_id           int not null references fund,
  distribution_date date not null,
  amount            numeric(18,2) not null,      -- DOLLARS, not millions
  company_label     text not null,               -- verbatim; may name no company we hold
  company_id        text references company,     -- resolved on exact name match only (ADR-026)
  note              text,
  is_synthetic      boolean not null default false,  -- ADR-020
  entered_by        uuid not null references app_user,
  batch_id          uuid                         -- reversible wholesale (ADR-018)
);

create index on fund_distribution (fund_id, distribution_date);

comment on column fund_distribution.company_label is
  'The contract''s distributions[].company, verbatim. On the reference dataset two of four rows resolve to no company: "Generated exits" is an aggregate, and "Solvine" does not match the roster''s "Solvine (exited)". Both are legitimate states for historical fund-level realizations, not import errors.';

-- =====================================================================
-- 14. AUDIT
-- Every write to a financial or mandate field.
-- =====================================================================

create table audit_log (
  audit_log_id bigint primary key generated always as identity,
  table_name   text not null,
  record_id    text not null,
  action       text not null check (action in ('insert','update','delete')),
  old_value    jsonb,
  new_value    jsonb,
  changed_by   uuid not null references app_user,
  changed_at   timestamptz not null default now()
);

create index on audit_log (table_name, record_id, changed_at desc);

-- =====================================================================
-- 15. PERIOD LABELLING
-- Visible reports on calendar quarters (Q2 2026 = Apr-Jun, due 5 Aug).
-- The board reports on a fiscal year starting 1 April.
-- Both labels are derived from dates. Neither is stored. (ADR-006)
-- =====================================================================

create or replace function calendar_quarter_label(d date)
returns text language sql immutable as $$
  select to_char(d,'YYYY') || '-Q' || to_char(d,'Q');
$$;

create or replace function fiscal_quarter_label(d date, fy_start_month int default 4)
returns text language sql immutable as $$
  select 'FY'
      || (extract(year from d)::int
          - case when extract(month from d)::int < fy_start_month then 1 else 0 end)::text
      || '-'
      || right((extract(year from d)::int
          - case when extract(month from d)::int < fy_start_month then 1 else 0 end
          + 1)::text, 2)
      || ' Q'
      || (floor(((extract(month from d)::int - fy_start_month + 12) % 12) / 3) + 1)::text;
$$;

comment on function fiscal_quarter_label is
  'FY starts 1 April. 2026-04-15 -> FY2026-27 Q1. The same period is 2026-Q2 on the calendar convention Visible uses.';

-- =====================================================================
-- 16. DERIVED VIEWS
-- These replace the stored scalars in the MVP. The API serialises from
-- here, so the exported JSON is identical while the numbers can no
-- longer silently disagree with the transactions behind them.
-- =====================================================================

-- NOTE: every view below reads LIVE rows only. Voided originals and their
-- reversals both carry voided_at / reverses_transaction_id and are excluded,
-- so totals are net of corrections while the history remains intact (ADR-018).
create or replace view v_transaction_live as
select * from transaction
where voided_at is null and reverses_transaction_id is null;

create or replace view v_company_invested as
select c.company_id,
       coalesce(sum(t.amount) filter (where t.txn_type in ('investment','follow_on')), 0) as invested,
       min(t.txn_date) filter (where t.txn_type = 'investment')                            as first_investment_date
from company c
left join v_transaction_live t on t.company_id = c.company_id
group by c.company_id;

create or replace view v_company_realized as
select c.company_id,
       coalesce(sum(t.amount) filter (where t.txn_type = 'realization'), 0) as realized
from company c
left join v_transaction_live t on t.company_id = c.company_id
group by c.company_id;

-- FMV as at a date: most recent final mark on or before that date.
-- Companies with no mark yet are held at cost (ADR-007).
create or replace function company_fmv_asof(p_company_id text, p_as_of date)
returns numeric language sql stable as $$
  select coalesce(
    (select vm.fmv
       from valuation_mark vm
      where vm.company_id = p_company_id
        and vm.status = 'final'
        and vm.effective_date <= p_as_of
      order by vm.effective_date desc, vm.booked_at desc
      limit 1),
    (select coalesce(sum(t.amount), 0)
       from v_transaction_live t
      where t.company_id = p_company_id
        and t.txn_type in ('investment','follow_on')
        and t.txn_date <= p_as_of)
  );
$$;

-- ADR-023: this function assembles FACTS ONLY. It sums, filters to live rows,
-- picks the latest row by date and joins. It computes no metric.
--
-- A `moic` column lived here until A1 and has been removed: it divided one
-- aggregate by another, which is the definition of a metric under ADR-023.
-- MOIC is owned by packages/metrics and computed nowhere else (ADR-021).
--
-- A3 resolved the `current_date` TODO that stood here: the read path now takes
-- an explicit as-of date, so a board report re-run reproduces itself and the
-- date is the same fact the ADR-007 reporting-lag stamp shows on screen.
--
-- THE PARAMETER REACHES EXACTLY ONE COLUMN, AND THAT IS DELIBERATE. `fmv` is
-- genuinely as-at-a-date: NAV as at any date is the sum of each company's most
-- recent mark on or before it. The others are not, and dating them would
-- silently change frozen definitions (ADR-013):
--
--   * `invested` and `realized` sum every live transaction regardless of date.
--     The prototype's scalars carry no date semantics at all. On the reference
--     dataset two exits are dated AFTER the pinned as-of - Nimbus Grid 2029,
--     Quorum Capital OS 2027 - so filtering realizations by date would erase
--     $13.4M of realized proceeds and move company MOIC and fund realized.
--   * `exited` is the existence of a company_exit row, not a comparison of its
--     date against the as-of, for the same reason.
--
-- If a genuinely as-at-a-date `invested` is ever wanted, it is a NEW function
-- with a new name, not a predicate added here.
create or replace function company_current_asof(p_as_of date)
returns table (
  company_id text, name text, sector text, sector_label text, stage text,
  health text, hq_city text, hq_region text, is_nb_based boolean,
  source_channel text, source_label text, invested numeric,
  first_investment_date date, vintage_year int, fmv numeric, realized numeric,
  exited boolean, exit_date date, exit_type text,
  ownership_pct numeric, pro_rata_rights boolean
) language sql stable as $$
select c.company_id,
       c.name,
       s.name                                    as sector,
       c.sector_label,
       cs.stage,
       cs.health,
       c.hq_city, c.hq_region, c.is_nb_based,
       sc.name                                   as source_channel,
       c.source_label,
       inv.invested,
       inv.first_investment_date,
       extract(year from inv.first_investment_date)::int as vintage_year,
       company_fmv_asof(c.company_id, p_as_of)           as fmv,
       rz.realized,
       (ce.company_id is not null)               as exited,
       ce.exit_date, ce.exit_type,
       own.ownership_pct, own.pro_rata_rights
from company c
left join v_company_invested inv on inv.company_id = c.company_id
left join v_company_realized rz  on rz.company_id  = c.company_id
left join company_exit ce        on ce.company_id  = c.company_id
left join ref_sector s           on s.sector_id    = c.sector_id
left join ref_source_channel sc  on sc.source_channel_id = c.source_channel_id
left join lateral (
    select cst.health, rs.name as stage
      from company_state cst
      left join ref_stage rs on rs.stage_id = cst.stage_id
     where cst.company_id = c.company_id and cst.effective_to is null
     limit 1) cs on true
left join lateral (
    select co.ownership_pct, co.pro_rata_rights
      from company_ownership co
     where co.company_id = c.company_id
     order by co.as_of_date desc limit 1) own on true;
$$;

-- CONVENIENCE ONLY. Finance's ad-hoc queries want "as at today" without
-- passing a date. The API NEVER reads this view: it calls
-- company_current_asof() with the same explicit date it hands the metrics
-- package as `asOf` (ADR-021), so a re-run reproduces itself.
create or replace view v_company_current as
  select * from company_current_asof(current_date);

-- Leverage: third-party capital per our dollar. Rounds with a missing or
-- invalid round_total are EXCLUDED, never imputed. Preserved exactly from
-- Daniel's implementation (ADR-013).
--
-- CONVENIENCE ONLY (ADR-023). Nothing here is serialised into the ADR-001
-- contract and nothing here is read by the API. The `where` clause below IS
-- the leverage definition, so the contract must deliver rounds UNFILTERED and
-- let packages/metrics apply the predicate itself (ADR-021). Retained for
-- Finance's ad-hoc reconciliation queries; a candidate for removal once those
-- move to the API. Note that `least(...)` caps nb_capital at the round's
-- third-party capital, which matches the prototype's dashboard chart but NOT
-- its fundMetrics(); the metrics package reproduces fundMetrics (ADR-013).
create or replace view v_round_leverage as
select r.investment_round_id,
       r.company_id,
       r.round_date,
       ours.our_invested,
       r.round_total,
       r.nb_other,
       (r.round_total - ours.our_invested)                              as capital_attracted,
       least(coalesce(r.nb_other,0), r.round_total - ours.our_invested)  as nb_capital,
       greatest(r.round_total - ours.our_invested
                - least(coalesce(r.nb_other,0), r.round_total - ours.our_invested), 0)
                                                                        as outside_capital
from investment_round r
join lateral (
    select coalesce(sum(t.amount),0) as our_invested
      from v_transaction_live t
     where t.investment_round_id = r.investment_round_id
       and t.txn_type in ('investment','follow_on')) ours on true
where r.round_total is not null
  and r.round_total >= ours.our_invested;

-- CONVENIENCE ONLY (ADR-023). `tvpi` and `dpi` below are ratios and therefore
-- metrics; they are never serialised into the ADR-001 contract and never read
-- by the API, which takes `called`, `distributions` and `nav` from here and
-- computes the multiples in packages/metrics (fiTvpi / fiDpi, ADR-021).
-- Retained for Finance's ad-hoc reconciliation queries. Anyone pointing Power
-- BI or a spreadsheet at these two columns gets a figure the platform itself
-- does not use. Removal requires `drop view ... cascade` and a recreate --
-- `create or replace view` cannot drop a column.
create or replace view v_lp_position_current as
select fi.fund_investment_id,
       fi.name, fi.manager_name, fi.strategy, fi.vintage_year,
       fi.committed,
       coalesce(calls.called, 0)                       as called,
       fi.committed - coalesce(calls.called, 0)        as unfunded,
       coalesce(dists.distributions, 0)                as distributions,
       coalesce(nav.nav, 0)                            as nav,
       nav.as_of_date                                  as nav_as_of,
       case when coalesce(calls.called,0) > 0
            then (coalesce(nav.nav,0) + coalesce(dists.distributions,0)) / calls.called
       end                                             as tvpi,
       case when coalesce(calls.called,0) > 0
            then coalesce(dists.distributions,0) / calls.called
       end                                             as dpi
from fund_investment fi
left join lateral (
    select sum(t.amount) as called from v_transaction_live t
     where t.fund_investment_id = fi.fund_investment_id
       and t.txn_type = 'capital_call') calls on true
left join lateral (
    select sum(t.amount) as distributions from v_transaction_live t
     where t.fund_investment_id = fi.fund_investment_id
       and t.txn_type = 'distribution') dists on true
left join lateral (
    select n.nav, n.as_of_date from fund_investment_nav n
     where n.fund_investment_id = fi.fund_investment_id
     order by n.as_of_date desc limit 1) nav on true;

-- Mandate KPI: capital this LP position and its network put into our
-- direct portfolio. Derived from round co-investor tags rather than
-- hand-entered as it was in the MVP.
create or replace view v_lp_capital_to_direct as
select rc.fund_investment_id,
       sum(rc.amount) as capital_to_direct,
       count(distinct r.company_id) as companies_touched
from round_coinvestor rc
join investment_round r on r.investment_round_id = rc.investment_round_id
where rc.fund_investment_id is not null
group by rc.fund_investment_id;

-- Data-quality monitor. Mandate metrics decay silently when the deal
-- lead skips a field at close; this makes the decay visible (ADR-012).
create or replace view v_mandate_completeness as
select count(*)                                                as rounds_total,
       count(*) filter (where round_total is null)             as missing_round_total,
       count(*) filter (where nb_other is null)                as missing_nb_other,
       count(*) filter (where ownership_after_pct is null)     as missing_ownership,
       round(100.0 * count(*) filter (where round_total is not null)
             / nullif(count(*),0), 1)                          as pct_leverage_coverage
from investment_round;

-- =====================================================================
-- 17. SYNTHETIC DATA GUARD (ADR-020)
-- Development proceeds on generated financial data while Finance
-- assembles the real history. Every synthetic row is flagged, so an
-- environment can state loudly what it is holding and a cutover can
-- remove it with certainty rather than with hope.
-- =====================================================================

create or replace view v_synthetic_data_status as
select
  (select count(*) from transaction        where is_synthetic) as synthetic_transactions,
  (select count(*) from valuation_mark     where is_synthetic) as synthetic_marks,
  (select count(*) from investment_round   where is_synthetic) as synthetic_rounds,
  (select count(*) from fund_investment_nav where is_synthetic) as synthetic_lp_navs,
  (select count(*) from company_ownership  where is_synthetic) as synthetic_ownership,
  (select count(*) from fund_distribution  where is_synthetic) as synthetic_fund_distributions,
  (select count(*) from transaction        where is_synthetic) > 0
    or (select count(*) from valuation_mark where is_synthetic) > 0
    or (select count(*) from fund_distribution where is_synthetic) > 0
                                                              as contains_synthetic;

comment on view v_synthetic_data_status is
  'Read at application start. If contains_synthetic is true the UI must display a persistent synthetic-data banner on every screen and stamp every PDF export. A production environment reading true is a deployment error, not a warning.';

-- =====================================================================
-- 18. AFFINITY CHANGE LOG MIRROR
-- Affinity's v2 field-value-changes endpoint already holds the full
-- audit trail: every Status transition, who made it and when. Affinity
-- is system of record; this table is a LOCAL MIRROR, not a derivation.
--
-- It exists because the endpoint is per-list-entry: rendering a funnel
-- chart over 156 entries would otherwise mean 156 API calls. Sync once
-- for full history, then incrementally, and query locally.
-- =====================================================================

create table affinity_field_change (
  affinity_field_change_id bigint primary key,   -- the API's own change id
  list_id           bigint not null,
  list_entry_id     bigint not null,             -- matches the export's "Affinity Row ID"
  entity_id         bigint not null,             -- v2 entity id; see note below
  field_id          text not null,
  field_name        text not null,
  action_type       text not null check (action_type in ('add','update','delete')),
  value_type        text not null,               -- ranked-dropdown | datetime | number | person-multi | company-multi
  dropdown_option_id bigint,                     -- NULL when the option has since been deleted
  value_text        text,                        -- 'text' for live options, 'displayValue' for deleted ones
  value_rank        int,
  value_number      numeric(18,2),
  value_datetime    timestamptz,
  value_json        jsonb,                       -- person-multi / company-multi payloads
  changed_at        timestamptz not null,
  changer_email     text,
  synced_at         timestamptz not null default now()
);

create index on affinity_field_change (list_entry_id, changed_at);
create index on affinity_field_change (field_name, changed_at);
create index on affinity_field_change (entity_id);

comment on column affinity_field_change.dropdown_option_id is
  'NULL when the API returns referenceType = deleted-entity - a dropdown option removed from the field config that historical records still reference. The sync must store displayValue and must not fail on the missing id.';
comment on column affinity_field_change.entity_id is
  'The v2 API entity id. NOT verified to share a namespace with the CSV export column "Organization Id" - the observed magnitudes differ by two orders. Confirm before using either as a crosswalk key; website is the safer join.';

-- Current and historical stage, derived from the mirror rather than stored twice.
create or replace view v_deal_stage_history as
select list_entry_id,
       entity_id,
       value_text                                             as stage,
       value_rank                                             as stage_rank,
       changed_at                                             as entered_at,
       lead(changed_at) over (partition by list_entry_id
                              order by changed_at)            as left_at,
       changer_email                                          as changed_by
from affinity_field_change
where field_name = 'Status'
  and action_type in ('add','update');

comment on view v_deal_stage_history is
  'Time-in-stage, funnel conversion and drop-off all derive from here. One row per Status transition; left_at is null for the current stage.';