-- =====================================================================
-- 0005 · A9 — Alert policy, structured risk flags, and acknowledgements
--
-- A9 is three surfaces that all resolve to the same feed:
--
--   1. RISK FLAGS gain a controlled vocabulary. The table has existed
--      since 0001 and nothing has ever been able to write to it except
--      the fixture importer and the A6 generator.
--   2. ALERT THRESHOLDS gain a FUND-LEVEL DEFAULT, so "our runway
--      threshold is 12 months" is a thing the platform can be told once
--      rather than 82 times.
--   3. ALERTS gain a TIME-BOXED ACKNOWLEDGEMENT, so a breach that has
--      been seen and judged stops shouting until the judgement expires.
--
-- HEALTH IS DELIBERATELY ABSENT FROM THIS MIGRATION. Affinity is the
-- system of record for the risk grade that drives it (ADR-009), the VC
-- team maintains it there, and `company_state` has recorded a dated
-- history of every change since 0001. A9 surfaces that provenance on
-- screen; it does not add a way to edit health here, because a rating
-- editable in two systems is a rating that disagrees with itself.
--
-- TWO EXISTING COLUMNS CHANGE MEANING. Both are called out below where
-- they happen, because a nullable column quietly acquiring a fallback
-- is the kind of change that is invisible in a diff and very visible on
-- a watchlist.
-- =====================================================================

set search_path = pc, public;

-- ---------------------------------------------------------------------
-- 1. THE RISK FLAG VOCABULARY
--
-- WHY A REFERENCE TABLE RATHER THAN FREE TEXT, WHICH IS WHAT THE
-- PROTOTYPE HAD.
--
-- `healthAlerts()` de-duplicates a risk flag against the derived runway
-- alert BY REGEX ON THE FLAG'S DISPLAY TEXT -- !/Runway/i.test(f) --
-- so a company that is both below its runway threshold and carrying a
-- flag about it produces one alert rather than two. That is correct
-- behaviour and it is frozen by ADR-013. What it is not is safe in the
-- hands of someone typing a flag into a form: "Runway getting tight"
-- vanishes from the feed with nothing on screen saying it was
-- suppressed, and "Cash under 3 months" duplicates the alert it meant
-- to annotate. The prototype never had that problem because the flags
-- were authored by one person editing a JSON file.
--
-- `suppresses_metric` moves that decision off the display string and
-- onto the category, where it is declared once and visible. The regex
-- survives exactly once more, in the backfill at step 3, which is the
-- right place for it: a one-time interpretation of legacy text, not a
-- rule evaluated forever at read time.
-- ---------------------------------------------------------------------

create table ref_risk_flag_category (
  risk_flag_category_id serial primary key,
  -- Stable machine key. Display names are editable; this is not, because
  -- suppression and the golden-master tests key on it.
  code             text not null unique,
  name             text not null unique,
  -- Seeds the severity picker when a flag of this category is raised.
  -- It is a PRE-FILL, not an override: see company_risk_flag.severity.
  default_severity text not null default 'yellow' check (default_severity in ('red','yellow')),
  -- Which DERIVED metric alert a flag of this category stands in for.
  -- NULL = stands in for nothing and always appears in the feed.
  suppresses_metric text check (suppresses_metric in
                       ('runway','burn-multiple','cash-balance','revenue-decline','nrr')),
  is_active        boolean not null default true,
  sort_order       int not null default 0
);

comment on table ref_risk_flag_category is
  'A9. The controlled vocabulary behind the risk-flag surface. Replaces regex-on-display-text de-duplication with a declared relationship between a category and the derived metric alert it duplicates.';
comment on column ref_risk_flag_category.suppresses_metric is
  'Reproduces the inherited runway-regex behaviour structurally. Only the runway and burn categories carry a value; every other category always appears. Changing this row changes which alerts the feed shows, so it is reference data, not configuration.';

insert into ref_risk_flag_category (code, name, default_severity, suppresses_metric, sort_order) values
  ('runway',                 'Runway',                  'red',    'runway',        10),
  ('burn',                   'Burn / cost base',        'yellow', 'burn-multiple', 20),
  ('covenant',               'Covenant',                'red',    null,            30),
  ('financing',              'Financing risk',          'yellow', null,            40),
  ('revenue',                'Revenue / plan',          'yellow', null,            50),
  ('customer-concentration', 'Customer concentration',  'yellow', null,            60),
  ('key-person',             'Key person',              'red',    null,            70),
  ('team',                   'Team / hiring',           'yellow', null,            80),
  ('market',                 'Market / competition',    'yellow', null,            90),
  ('product',                'Product / technical',     'yellow', null,           100),
  ('governance',             'Governance',              'yellow', null,           110),
  ('legal-regulatory',       'Legal / regulatory',      'yellow', null,           120),
  ('gov-funding',            'Government funding',      'yellow', null,           130),
  ('other',                  'Other',                   'yellow', null,           999);

-- ---------------------------------------------------------------------
-- 2. company_risk_flag GAINS STRUCTURE, KEEPING ITS DISPLAY STRING
--
-- `flag_text` STAYS, and stays NOT NULL. It is what the ADR-001 contract
-- serialises into companies[].riskFlags[], and the contract is frozen.
-- This is exactly the ADR-026 pattern already used for sectors: the
-- verbatim contract string is preserved in `sector_label` while
-- `sector_id` carries the resolved reference key. Same shape, same
-- reason -- the resolved key is for logic, the string is for the
-- contract, and the importer never invents one from the other.
--
-- `severity` IS NULLABLE AND NULL MEANS THE INHERITED RULE. The
-- prototype gives every flag the severity of its COMPANY's health
-- (red when the company is red, yellow otherwise), which is frozen
-- behaviour. A null here reproduces that verbatim. A value here
-- overrides it, which is new behaviour available only to flags raised
-- through the A9 form.
-- ---------------------------------------------------------------------

alter table pc.company_risk_flag
  add column risk_flag_category_id int references pc.ref_risk_flag_category,
  add column severity       text check (severity in ('red','yellow')),
  add column note           text,
  add column cleared_by     uuid references pc.app_user,
  add column cleared_reason text;

comment on column pc.company_risk_flag.flag_text is
  'ADR-001 display string, emitted verbatim into companies[].riskFlags[]. Composed by the write path as "<category> - <note>" for flags raised in-platform, and preserved as authored for rows the fixture importer loaded. Never re-derived from the category on read: ADR-026, same reason as company.sector_label.';
comment on column pc.company_risk_flag.severity is
  'NULL = inherit the company health colour, which is the frozen prototype rule (ADR-013). A value overrides it. Nullable rather than defaulted so the inherited path stays the default path.';
comment on column pc.company_risk_flag.cleared_reason is
  'Why the flag was lowered. Required by the write path when cleared_at is set: a flag that disappears without a reason is indistinguishable from one raised by mistake, and the board pack shows both.';

-- ---------------------------------------------------------------------
-- 3. BACKFILL: the regex runs once, here, and then never again
--
-- Fifteen distinct strings in the reference fixture, plus whatever the
-- A6 generator has written. Anything unmatched lands on 'other', which
-- is honest -- inventing a category for a string nobody wrote against a
-- vocabulary would be worse than admitting we do not know.
--
-- ORDER MATTERS, and it was wrong the first time this was written.
--
-- 'runway' is tested first because it is the one that carries
-- suppression: "Runway below policy" must not be claimed by the burn or
-- revenue patterns, both of which could plausibly match it.
--
-- 'team' NOW PRECEDES 'revenue'. It did not on the first pass, and
-- "Hiring plan behind schedule" -- three rows in the reference fixture,
-- three more in the generated set -- was claimed by the revenue pattern
-- on the word "plan". It is a hiring problem, and a hiring problem
-- filed under revenue is a category nobody will trust after they spot
-- one. Measured against the real table, not reasoned about.
--
-- The short tokens carry word boundaries. Without them 'doe' matches
-- "does" and 'board' matches "onboarding", which is the failure mode
-- this whole table exists to remove, reintroduced in the backfill.
-- ---------------------------------------------------------------------

update pc.company_risk_flag f
   set risk_flag_category_id = c.risk_flag_category_id
  from pc.ref_risk_flag_category c
 where c.code = case
   when f.flag_text ~* 'runway|cash (bal|under|below)'         then 'runway'
   when f.flag_text ~* 'covenant'                              then 'covenant'
   when f.flag_text ~* 'burn|margin|cost base'                 then 'burn'
   when f.flag_text ~* 'down.?round|financing|bridge|dilution' then 'financing'
   when f.flag_text ~* 'concentration|customer|\ydod\y|\ydoe\y' then 'customer-concentration'
   when f.flag_text ~* 'key.?person|\yceo\y|founder|departure' then 'key-person'
   when f.flag_text ~* 'hiring|\yteam\y|scaling|process maturity' then 'team'
   when f.flag_text ~* 'revenue|pipeline|plan|milestone|slip'  then 'revenue'
   when f.flag_text ~* 'competit|market'                       then 'market'
   when f.flag_text ~* 'clinical|technical|product'            then 'product'
   when f.flag_text ~* 'governance|\yboard\y'                  then 'governance'
   when f.flag_text ~* 'legal|regulat|complian'                then 'legal-regulatory'
   else 'other'
 end
   and f.risk_flag_category_id is null;

alter table pc.company_risk_flag
  alter column risk_flag_category_id set not null;

create index on pc.company_risk_flag (company_id) where cleared_at is null;
create index on pc.company_risk_flag (risk_flag_category_id);

-- ---------------------------------------------------------------------
-- 4. FUND-LEVEL ALERT POLICY
--
-- The answer to "where do we say the runway threshold is 12 months".
--
-- EFFECTIVE-DATED, for the same reason company_state is. A watchlist
-- appears in the board pack, ADR-031 exists so an issued board pack
-- stays reproducible, and a policy that silently rewrote itself would
-- put a company on last quarter's watchlist that was never on it. The
-- policy that applied on a date is recoverable from this table alone.
--
-- ONE ROW PER FUND PER PERIOD. An `effective_to is null` row is the
-- current one, enforced by a partial unique index exactly as
-- company_state does it.
-- ---------------------------------------------------------------------

create table fund_alert_policy (
  fund_alert_policy_id    bigint primary key generated always as identity,
  fund_id                 int not null references pc.fund on delete cascade,
  effective_from          date not null default current_date,
  effective_to            date,

  -- Every column is NULLABLE, and NULL means "this fund sets no policy
  -- for this metric" -- NOT zero, and not a hardcoded fallback. There is
  -- no default here for the same reason company_threshold has none: a
  -- number nobody set must never put a company on the watchlist.
  min_runway_months       int           check (min_runway_months >= 0),
  max_burn_multiple       numeric(6,2)  check (max_burn_multiple >= 0),
  min_cash_balance        numeric(18,2) check (min_cash_balance >= 0),
  max_revenue_decline_pct numeric(6,2)  check (max_revenue_decline_pct >= 0),
  min_nrr_pct             numeric(6,2)  check (min_nrr_pct >= 0),

  set_by                  uuid not null references pc.app_user,
  set_at                  timestamptz not null default now(),
  note                    text,

  constraint fund_alert_policy_period check (effective_to is null or effective_to >= effective_from)
);

create unique index fund_alert_policy_current_uq
  on fund_alert_policy (fund_id) where effective_to is null;
create index on fund_alert_policy (fund_id, effective_from);

comment on table fund_alert_policy is
  'A9. Portfolio-wide alert thresholds, inherited by any company that has not set its own. Effective-dated so a watchlist printed in a board pack can be reproduced against the policy that was in force, not the one in force today.';
comment on column fund_alert_policy.min_runway_months is
  'The general runway floor - 12 months, in NBIF stated policy. A company with company_threshold.min_runway_months set overrides it; a company with an explicit 0 disables the alert entirely and the policy does NOT resurrect it (ADR-013: 0 means disabled, and that meaning is inherited).';

-- ---------------------------------------------------------------------
-- 5. company_threshold GAINS THE OTHER THREE METRICS
--
-- SEMANTIC CHANGE, STATED PLAINLY: `min_runway_months` and
-- `max_burn_multiple` were NULL-means-no-alert. From this migration
-- they are NULL-means-INHERIT-THE-FUND-POLICY. Until a policy row
-- exists the two are indistinguishable, which is why this migration
-- inserts no policy row -- the behaviour change lands when someone
-- sets a policy on the admin screen, deliberately, and not as a
-- side effect of running a migration.
--
-- ZERO STILL MEANS DISABLED, at both levels. That is the inherited
-- meaning from the contract (a thresholds.minRunwayMo of 0 disables the
-- alert) and it is the only way a company can opt OUT of a fund policy.
-- Without it, a portfolio-wide default would be unescapable.
-- ---------------------------------------------------------------------

alter table company_threshold
  add column min_cash_balance        numeric(18,2) check (min_cash_balance >= 0),
  add column max_revenue_decline_pct numeric(6,2)  check (max_revenue_decline_pct >= 0),
  add column min_nrr_pct             numeric(6,2)  check (min_nrr_pct >= 0);

comment on column company_threshold.min_runway_months is
  'A9 CHANGED THIS. Was: NULL = no alert for this company. Now: NULL = inherit fund_alert_policy. An explicit 0 disables the alert and overrides the fund policy; that is the only opt-out, and it is the inherited contract meaning (ADR-013).';

-- ---------------------------------------------------------------------
-- 6. ALERT ACKNOWLEDGEMENTS
--
-- An alert feed that cannot be answered becomes wallpaper. A company
-- knowingly at four months of runway during a bridge sits red at the top
-- of the dashboard for a quarter, everyone learns to scroll past it, and
-- the one alert that mattered is scrolled past with it.
--
-- TIME-BOXED, NOT DISMISSED. `until_date` is mandatory: an
-- acknowledgement is a judgement with an expiry ("bridge closes 30
-- Sep"), never a delete. It returns to the feed on its own.
--
-- `acknowledged_value` IS THE RE-FIRE TRIP WIRE. An acknowledgement
-- covers a situation as it stood, not the metric forever. If the figure
-- moves materially the wrong way the alert comes back before its date,
-- because "I know about the 4-month runway" is not consent to ignore a
-- 2-month runway. NULL for alerts with no numeric subject (a risk flag,
-- a covenant), which simply hold until the date.
--
-- WHAT IS NOT STORED: the alert itself. A breach is a function of a KPI
-- row and a threshold and is recomputed every time (ADR-002). This table
-- stores only the human judgement about one, keyed by `alert_key` --
-- which is derived from the alert's SUBJECT, never from its value, so a
-- routine Visible refresh does not orphan an acknowledgement.
-- ---------------------------------------------------------------------

create table alert_acknowledgement (
  alert_acknowledgement_id bigint primary key generated always as identity,
  company_id       text not null references pc.company on delete cascade,
  -- Stable within a company: 'metric:runway', 'flag:1234', 'covenant:2',
  -- 'gov-funding'. Keyed on the subject so a re-reported value keeps the
  -- same key.
  alert_key        text not null,
  reason           text not null check (length(btrim(reason)) > 0),
  until_date       date not null,
  -- The metric value at the moment of acknowledgement. The feed re-fires
  -- early if the current value is materially worse than this.
  acknowledged_value numeric(18,2),
  acknowledged_by  uuid not null references pc.app_user,
  acknowledged_at  timestamptz not null default now(),
  revoked_by       uuid references pc.app_user,
  revoked_at       timestamptz,

  constraint ack_revocation_complete
    check ((revoked_at is null) = (revoked_by is null))
);

-- One LIVE acknowledgement per alert. History is kept: revoked and
-- expired rows stay, because "who waved this through, and when" is a
-- question a board asks after the fact.
create unique index alert_acknowledgement_live_uq
  on alert_acknowledgement (company_id, alert_key) where revoked_at is null;
create index on alert_acknowledgement (company_id) where revoked_at is null;

comment on table alert_acknowledgement is
  'A9. A time-boxed, reasoned judgement that an open alert is understood and accepted. Never deletes the alert - the breach is still derived and still visible on the company - it removes it from the ACTIVE feed until until_date passes, the value worsens past acknowledged_value, or someone revokes it.';
comment on column alert_acknowledgement.alert_key is
  'Derived from the alert subject, never its value. "metric:runway" stays stable across every Visible refresh, so an acknowledgement survives the nightly sync that would otherwise silently expire it.';

-- ---------------------------------------------------------------------
-- 7. CURRENT-POLICY VIEW
--
-- Every reader wants the row in force today, and the `effective_to is
-- null` predicate is the kind of thing that gets forgotten in exactly
-- one of five call sites.
-- ---------------------------------------------------------------------

create view v_fund_alert_policy_current as
  select p.*, u.display_name as set_by_name
    from fund_alert_policy p
    join app_user u on u.user_id = p.set_by
   where p.effective_to is null;

comment on view v_fund_alert_policy_current is
  'A9. The alert policy in force now. Readers reconstructing a past board pack must query fund_alert_policy directly with a date, not this view.';
